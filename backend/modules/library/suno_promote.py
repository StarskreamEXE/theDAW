"""Promote a staged Suno catalog into the real library, in resumable batches.

``suno_stage`` puts the whole cache into its own SQLite catalog without
touching anything the user owns. This module is the other half: it moves that
catalog into theDAW's library so the songs appear in the app — *without*
copying a byte of audio, without a second entry for a song that was imported
before, without overwriting anything the user has edited, and restartable at
any point, because ~200,000 songs is long enough that "start again" is not an
acceptable answer to a closed laptop.

Field mapping — staged asset (the SELECTED revision, see below) to library
entry ``metadata.json`` / ``entries`` row:

====================== ================================ =======================
staged                 library metadata key             notes
====================== ================================ =======================
``external_id``        entry id (folder name),          the provider id itself
                       ``provider_id``, ``suno_id``     when it is filesystem
                                                        safe -- which is what
                                                        makes an entry written
                                                        by the OLD importer
                                                        (``scripts/ingest_suno_cache.py``,
                                                        folder = song id) get
                                                        UPDATED instead of
                                                        duplicated
``title``              ``title``                        empty title becomes
                                                        ``<namespace>_<first 8
                                                        of the id>``; the song
                                                        is never dropped
``created_at``         ``created_at``, ``timestamp``     unknown stays ``""``;
                                                        never invented
``duration``           ``duration``                     ABSENT when unknown --
                                                        never ``0``
``prompt`` / ``style`` ``prompt`` (falls back to style),
                       ``style``
``lyrics``             ``lyrics``
``tags``               ``tags``                         plus ``suno`` and
                                                        ``sunoid:<id>``, the
                                                        markers the old
                                                        importer wrote
``model_name``         ``model``                        defaults to the
                                                        namespace
--                     ``source``                       always ``'suno'``
``selected_content_hash`` ``suno_revision``             what "has this song
                                                        changed?" is answered
                                                        with on the next run
raw record             ``suno_raw`` (+ ``metadata`` /   sanitized exactly as it
                       ``inferred`` when present)       was staged: no tokens,
                                                        no signed query strings
``image_urls``         ``image_urls``, ``cdn_image_url``
verified local audio   ``source_path``                  REFERENCE IN PLACE: the
                                                        file is never read,
                                                        copied or moved
``audio_url``          ``cdn_audio_url``                only when there is no
                                                        verified local file
====================== ================================ =======================

A song with neither a verified local file nor a remote url is **not** promoted:
it is counted as ``deferred_no_media``, named in the report, and left in
staging so a later run -- one that can see the media root -- picks it up.

**Selected revision.** The stager keeps every observed version of a song and
treats the first observation as the selected view (its ``staged_assets``
columns). This module promotes that view, and records its content hash on the
entry. A staged asset whose selected hash differs from the hash on the entry is
an update; an equal hash is skipped as ``unchanged`` without touching the disk.

**Never clobbering the user.** On an update only provider-owned fields move.
``favorite``, ``rating``, ``notes`` are carried over verbatim; tags are the
union of the provider's and the user's; the title is kept when the user renamed
it -- detected conservatively, by comparing the entry's title against the
titles of *every staged revision* of the song (plus the placeholder), and
treating anything else as a rename. Where the previous promotion's provider
snapshot is recoverable (``suno_raw``), lyrics the user edited are kept too;
for an entry the old importer wrote there is no snapshot, so anything already
there wins.

**Resumable and idempotent.** Every processed asset gets a receipt in the
staging database (``promotions``: asset id, revision hash, entry id, outcome).
The two databases cannot share a transaction, so the receipt is written
strictly after the library batch it describes, and a resumed run reconciles:
an asset with no receipt whose entry already carries the same revision hash was
written by the interrupted run and is recorded as ``unchanged`` rather than
created twice. A second full run therefore reports ``created=0, updated=0``.

**Shape, because 200,000.** Assets are walked by primary key in pages, each
page becomes ONE ``upsert_entries_bulk`` transaction (one ``library_revision``
bump), and per entry the filesystem sees a ``mkdir`` and a single
``metadata.json`` write -- no cover extraction, no audio probing, no ``stat``
of the referenced file, no background job. The library record is built
directly rather than round-tripped through ``_record_from_metadata``, which
would ``stat`` the referenced audio and the cover for every one of the 200,000.
``metadata.json`` is written compactly (no indent): the raw provider record is
kilobytes per song, and pretty-printing all of it costs both CPU and about a
fifth of the bytes on disk.

**Safety rails.** ``dry_run`` opens the staging database read-only and writes
nothing anywhere. A real run takes a consistent copy of the library database
through the SQLite backup API into ``<library root>/backups/`` first (skipped
when the library is empty), and refuses to start when the library's drive does
not have room for the estimate, which is measured from a sample of the staged
records rather than guessed. Every folder written is proved to be inside the
library root, the staging root is refused if it sits inside the library, and
nothing in the source cache or the media root is opened at all.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Optional, Sequence, Union

from . import suno_stage
from .db import _MAX_SQL_PARAMS
from .store import (
    LibraryRecord,
    LibraryStore,
    _audio_url_for,
    _db_payload,
    _read_metadata,
)

log = logging.getLogger(__name__)

#: Assets per library transaction. Matches the folder importer's default.
DEFAULT_BATCH_SIZE = 1000

#: How many deferred songs the report names. The rest stay in staging and are
#: one SQL query away; a 200,000-row list in a JSON response helps nobody.
MAX_DEFERRED_LISTED = 200

#: How many failures the report carries, for the same reason.
MAX_ERRORS = 50

BACKUP_DIRNAME = "backups"
BACKUP_PREFIX = "pre-suno-import-"

#: Where the promoted revision hash lives on the entry.
REVISION_KEY = "suno_revision"
RAW_KEY = "suno_raw"

#: Free-space estimate inputs. The per-entry cost is *measured* from a sample of
#: the staged records (see :func:`estimate_promotion_bytes`); these only turn
#: that measurement into a number of bytes on a real filesystem.
SAMPLE_ASSETS = 64
ALLOCATION_UNIT = 4096
#: The same JSON also lands in ``entries.metadata_json``, gets indexed by fts5
#: and by ``tag_index``/``prompt_corpus``, and SQLite keeps free pages around.
DB_GROWTH_FACTOR = 1.8
FREE_SPACE_MARGIN = 1.10

#: A provider id usable verbatim as a directory name AND as a URL path segment:
#: lower case only (so two ids can never collide on a case-insensitive
#: filesystem), no separators, no ``~``.
_VERBATIM_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")

#: Names Windows refuses whatever the extension.
_RESERVED_NAMES = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{n}" for n in range(1, 10)}
    | {f"lpt{n}" for n in range(1, 10)}
)

#: Separates the namespace slug from the minted digest. Deliberately outside
#: ``_VERBATIM_ID_RE``, so a verbatim id can never be mistaken for a minted one
#: and the two id spaces cannot collide.
_MINT_SEPARATOR = "~"

_PROVIDER_TAG_PREFIX = "sunoid:"

#: Columns of one staged asset, without the kilobytes of ``raw_json`` -- which
#: is fetched only for the assets that turn out to need writing.
_ASSET_FIELDS: tuple[str, ...] = (
    "id",
    "namespace",
    "external_id",
    "title",
    "created_at",
    "duration",
    "lyrics",
    "prompt",
    "style",
    "tags_json",
    "model_name",
    "audio_url",
    "image_urls_json",
    "status",
    "selected_content_hash",
)
_ASSET_COLUMNS = ", ".join(_ASSET_FIELDS)
_ASSET_COLUMNS_A = ", ".join(f"a.{name}" for name in _ASSET_FIELDS)

_AUDIO_MIME_FALLBACK = "audio/mpeg"


class PromotionRefused(RuntimeError):
    """The promotion will not start: bad paths, wrong database, no room."""


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------


def entry_id_for(namespace: str, external_id: str) -> str:
    """The library entry id for one staged song. Deterministic, never empty.

    The provider id itself when it is safe as a directory name and a URL path
    segment -- which is the whole point: ``scripts/ingest_suno_cache.py`` named
    its folders after the song id, so every entry the user already has is found
    and updated rather than duplicated. Anything else (a path separator, an
    upper-case letter that a case-insensitive filesystem would fold into
    another id, a Windows device name, something far too long) gets a minted id
    instead. The minted form carries ``~``, which the verbatim form can never
    contain, so no two provider ids can ever land on the same entry id.
    """
    candidate = external_id or ""
    if (
        _VERBATIM_ID_RE.fullmatch(candidate)
        and ".." not in candidate
        and not candidate.endswith(".")
        and candidate.split(".", 1)[0] not in _RESERVED_NAMES
    ):
        return candidate
    slug = re.sub(r"[^a-z0-9]", "", (namespace or "").lower())[:16] or "x"
    digest = uuid.uuid5(
        uuid.NAMESPACE_URL, json.dumps([namespace, external_id], ensure_ascii=False)
    ).hex
    return f"{slug}{_MINT_SEPARATOR}{digest}"


def placeholder_title(namespace: str, external_id: str) -> str:
    """A readable stand-in for a song with no title. Carries the short id, so
    two untitled songs are still told apart in a list. Matches what the old
    importer wrote, so promoting over its entries is not read as a rename."""
    return f"{namespace or 'suno'}_{external_id[:8]}"


# ---------------------------------------------------------------------------
# Progress and report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PromotionProgress:
    """Counters handed to ``on_batch`` after every committed batch."""

    seen: int
    created: int
    updated: int
    unchanged: int
    deferred_no_media: int
    failed: int
    elapsed_seconds: float
    total: Optional[int] = None

    @property
    def records_per_second(self) -> float:
        return self.seen / self.elapsed_seconds if self.elapsed_seconds > 0 else 0.0

    @property
    def eta_seconds(self) -> Optional[float]:
        rate = self.records_per_second
        if self.total is None or rate <= 0:
            return None
        return max(0.0, (self.total - self.seen) / rate)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["records_per_second"] = self.records_per_second
        payload["eta_seconds"] = self.eta_seconds
        return payload


@dataclass
class PromotionReport:
    """What one promotion pass did. ``to_dict`` is what the API returns."""

    stage_root: str
    library_root: str
    status: str = "complete"
    dry_run: bool = False
    batch_size: int = DEFAULT_BATCH_SIZE
    total_staged: int = 0
    seen: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    deferred_no_media: int = 0
    failed: int = 0
    deferred: list[dict[str, str]] = field(default_factory=list)
    deferred_truncated: bool = False
    errors: list[str] = field(default_factory=list)
    lineage_edges: int = 0
    lineage_unresolved: int = 0
    backup_path: Optional[str] = None
    free_bytes: int = 0
    estimated_bytes: int = 0
    elapsed_seconds: float = 0.0

    @property
    def complete(self) -> bool:
        return self.status == "complete"

    def note_failure(self, message: str) -> None:
        self.failed += 1
        if len(self.errors) < MAX_ERRORS:
            self.errors.append(message)

    def note_deferred(self, asset_id: str, external_id: str, title: str) -> None:
        self.deferred_no_media += 1
        if len(self.deferred) < MAX_DEFERRED_LISTED:
            self.deferred.append(
                {"asset_id": asset_id, "external_id": external_id, "title": title}
            )
        else:
            self.deferred_truncated = True

    def progress(self, started: float, total: Optional[int]) -> PromotionProgress:
        return PromotionProgress(
            seen=self.seen,
            created=self.created,
            updated=self.updated,
            unchanged=self.unchanged,
            deferred_no_media=self.deferred_no_media,
            failed=self.failed,
            elapsed_seconds=max(0.0, time.perf_counter() - started),
            total=total,
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# One staged asset
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StagedAsset:
    """One row of ``staged_assets``, typed. ``raw`` is attached later."""

    id: str
    namespace: str
    external_id: str
    title: str
    created_at: Optional[str]
    duration: Optional[float]
    lyrics: Optional[str]
    prompt: Optional[str]
    style: Optional[str]
    tags: tuple[str, ...]
    model_name: Optional[str]
    audio_url: Optional[str]
    image_urls: tuple[tuple[str, str], ...]
    status: Optional[str]
    content_hash: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "StagedAsset":
        return cls(
            id=str(row["id"]),
            namespace=str(row["namespace"]),
            external_id=str(row["external_id"]),
            title=str(row["title"] or ""),
            created_at=row["created_at"],
            duration=row["duration"],
            lyrics=row["lyrics"],
            prompt=row["prompt"],
            style=row["style"],
            tags=tuple(_json_list(row["tags_json"])),
            model_name=row["model_name"],
            audio_url=row["audio_url"],
            image_urls=tuple(_json_mapping(row["image_urls_json"]).items()),
            status=row["status"],
            content_hash=str(row["selected_content_hash"]),
        )


def _json_list(raw: Any) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [str(item) for item in value] if isinstance(value, list) else []


def _json_mapping(raw: Any) -> dict[str, str]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items() if isinstance(v, str)}


def _unique(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def provider_tags(asset: StagedAsset) -> list[str]:
    """The tags the provider owns, including the markers the old importer wrote
    (``suno`` and ``sunoid:<id>``) so an entry promoted today is filterable the
    same way as one imported a year ago."""
    return _unique(
        [
            asset.namespace,
            f"{_PROVIDER_TAG_PREFIX}{asset.external_id}",
            *asset.tags,
        ]
    )


# ---------------------------------------------------------------------------
# Mapping one asset to one entry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class UserEdits:
    """What an existing entry keeps through an update."""

    title: Optional[str] = None
    favorite: bool = False
    rating: Optional[str] = None
    notes: str = ""
    tags: tuple[str, ...] = ()
    lyrics: Optional[str] = None
    chimera_sources: tuple[str, ...] = ()
    #: The title the PREVIOUS promotion wrote, recovered from the raw record it
    #: stored. An entry still carrying it was never renamed by hand, however
    #: far the provider's title has moved since.
    provider_title: Optional[str] = None


def _previous_provider_view(
    old_meta: dict[str, Any], namespace: str
) -> Optional[suno_stage.StagedRecord]:
    """What the LAST promotion wrote for this entry, re-derived from the raw
    record it stored. ``None`` for an entry this module has never written --
    one from the old importer -- where nothing can be attributed and the value
    already on the entry therefore wins."""
    raw = old_meta.get(RAW_KEY)
    if not isinstance(raw, dict):
        return None
    try:
        return suno_stage.normalize_record(raw, namespace)
    except ValueError:
        return None


def user_edits_from(
    old_meta: dict[str, Any],
    summary: Optional[dict[str, Any]],
    *,
    namespace: str,
) -> UserEdits:
    """Read the user-owned state off an entry that is about to be rewritten.

    ``old_meta`` is the entry's own ``metadata.json`` -- the documented source
    of truth -- and ``summary`` the DB row, used when the file could not be
    read.
    """
    source: dict[str, Any] = dict(summary or {})
    source.update({k: v for k, v in old_meta.items() if v is not None})
    previous = _previous_provider_view(old_meta, namespace)
    lyrics = old_meta.get("lyrics")
    if previous is not None and lyrics == (previous.lyrics or ""):
        lyrics = None  # untouched since we wrote it: the provider owns it again
    rating = source.get("rating")
    return UserEdits(
        title=str(source["title"]) if source.get("title") else None,
        favorite=bool(source.get("favorite")),
        rating=rating if rating in ("like", "dislike") else None,
        notes=str(source.get("notes") or ""),
        tags=tuple(
            str(tag) for tag in (old_meta.get("tags") or []) if isinstance(tag, str)
        ),
        lyrics=str(lyrics) if isinstance(lyrics, str) and lyrics else None,
        chimera_sources=tuple(
            str(item)
            for item in (old_meta.get("chimera_sources") or [])
            if isinstance(item, str)
        ),
        provider_title=(previous.title or None) if previous is not None else None,
    )


def resolved_title(
    asset: StagedAsset, edits: Optional[UserEdits], other_titles: Sequence[str]
) -> str:
    """The title the entry ends up with.

    The provider's, unless the user renamed it. "Renamed" is decided
    conservatively: the entry's current title has to differ from the selected
    staged title, from every OTHER staged revision's title, from the title the
    previous promotion wrote, and from the placeholder, before it is treated as
    the user's. The previous-promotion title matters on its own -- a song
    re-staged from a newer cache may have no revision left that carries the
    title the library is still showing, and that is not a rename.
    """
    staged = asset.title or placeholder_title(asset.namespace, asset.external_id)
    if edits is None or not edits.title:
        return staged
    known = {
        asset.title,
        staged,
        placeholder_title(asset.namespace, asset.external_id),
        edits.provider_title,
        "",
        *other_titles,
    }
    return staged if edits.title in known else edits.title


def build_metadata(
    asset: StagedAsset,
    raw: dict[str, Any],
    *,
    entry_id: str,
    audio_path: Optional[str],
    audio_bytes: Optional[int],
    edits: Optional[UserEdits],
    other_titles: Sequence[str] = (),
) -> dict[str, Any]:
    """The ``metadata.json`` for one promoted song. See the module docstring."""
    title = resolved_title(asset, edits, other_titles)
    tags = provider_tags(asset)
    if edits is not None:
        tags = _unique([*tags, *edits.tags])
    lyrics = asset.lyrics or ""
    if edits is not None and edits.lyrics is not None:
        lyrics = edits.lyrics
    created = asset.created_at or ""
    filename = Path(audio_path).name if audio_path else f"{asset.external_id}.mp3"
    meta: dict[str, Any] = {
        "id": entry_id,
        "title": title,
        "prompt": asset.prompt or asset.style or "",
        "negative_prompt": "",
        "model": asset.model_name or asset.namespace,
        "steps": 0,
        "cfg": 0.0,
        "seed": 0,
        "mime_type": _mime_for(filename),
        "audio_filename": filename,
        "favorite": bool(edits.favorite) if edits else False,
        "rating": edits.rating if edits else None,
        "tags": tags,
        "notes": edits.notes if edits else "",
        "source": "suno",
        "timestamp": created,
        "created_at": created,
        "lyrics": lyrics,
        "style": asset.style or "",
        "chimera_sources": list(edits.chimera_sources) if edits else [],
        "provider": asset.namespace,
        "provider_id": asset.external_id,
        REVISION_KEY: asset.content_hash,
        RAW_KEY: raw,
    }
    if asset.namespace == "suno":
        meta["suno_id"] = asset.external_id
    # Unknown stays unknown: an absent key, never a zero anyone could mistake
    # for a measurement.
    if asset.duration is not None:
        meta["duration"] = float(asset.duration)
    if audio_path:
        meta["source_path"] = audio_path
        if audio_bytes:
            meta["file_size_bytes"] = int(audio_bytes)
    elif asset.audio_url:
        meta["cdn_audio_url"] = asset.audio_url
    if asset.image_urls:
        images = dict(asset.image_urls)
        meta["image_urls"] = images
        meta["cdn_image_url"] = next(iter(images.values()))
    if asset.status:
        meta["status"] = asset.status
    for key in ("metadata", "inferred"):
        if isinstance(raw.get(key), dict):
            meta[key] = raw[key]
    return meta


def _mime_for(filename: str) -> str:
    from .store import AUDIO_MIME_BY_EXT

    return AUDIO_MIME_BY_EXT.get(Path(filename).suffix.lower(), _AUDIO_MIME_FALLBACK)


def build_record(meta: dict[str, Any], api_prefix: str) -> LibraryRecord:
    """The :class:`LibraryRecord` for a promoted entry, built straight from the
    metadata we just wrote.

    Deliberately NOT ``_record_from_metadata``: that resolves the audio file
    and looks for a cover on disk, which is two ``stat`` calls per song and
    would read the user's referenced audio directory 200,000 times for
    information this function already has.
    """
    entry_id = str(meta["id"])
    return LibraryRecord(
        id=entry_id,
        title=str(meta["title"]),
        prompt=str(meta.get("prompt") or ""),
        negative_prompt="",
        model=str(meta.get("model") or ""),
        duration=float(meta.get("duration") or 0.0),
        steps=0,
        cfg=0.0,
        seed=0,
        audio_url=_audio_url_for(api_prefix, entry_id),
        audio_filename=str(meta.get("audio_filename") or ""),
        mime_type=str(meta.get("mime_type") or _AUDIO_MIME_FALLBACK),
        file_size_bytes=int(meta.get("file_size_bytes") or 0),
        timestamp=str(meta.get("timestamp") or ""),
        favorite=bool(meta.get("favorite")),
        rating=meta.get("rating")
        if meta.get("rating") in ("like", "dislike")
        else None,
        tags=list(meta.get("tags") or []),
        notes=str(meta.get("notes") or ""),
        source="suno",
        chimera_sources=list(meta.get("chimera_sources") or []),
        lyrics=str(meta.get("lyrics") or ""),
        spectrogram_paths={},
        kind="audio",
        cover_url=None,
    )


# ---------------------------------------------------------------------------
# Filesystem
# ---------------------------------------------------------------------------


def _entry_dir(root: Path, root_normcase: str, entry_id: str) -> Path:
    """The folder for ``entry_id``, proved to be inside the library root.

    ``entry_id_for`` already guarantees a name with no separator, so
    ``root_normcase`` rejects the obviously-wrong case with a cheap string
    comparison first -- but the string is never the authority: ``entry_id``
    also arrives from a staging database this process did not necessarily
    create, or names a folder the OLD importer left on disk, and either one
    can already be a symlink whose target is nowhere near the library. Only
    the RESOLVED path decides containment, checked immediately before every
    write reaches it.
    """
    if (
        not entry_id
        or entry_id in (".", "..")
        or "/" in entry_id
        or "\\" in entry_id
        or os.sep in entry_id
        or (os.altsep and os.altsep in entry_id)
        or ":" in entry_id
    ):
        raise PromotionRefused(f"refusing to write an entry named {entry_id!r}")
    target = root / entry_id
    if not os.path.normcase(str(target)).startswith(root_normcase + os.sep):
        raise PromotionRefused(f"{target} is outside the library root {root}")
    resolved = target.resolve()
    if root not in resolved.parents:
        raise PromotionRefused(f"{target} is outside the library root {root}")
    return target


def _write_entry(entry_dir: Path, meta: dict[str, Any], *, replace: bool) -> None:
    """Create the entry folder and write its ``metadata.json``.

    ``replace`` writes through a temporary file, so an entry that already
    exists is never left truncated by a crash. A brand-new entry has nothing to
    lose and is written directly, which is two syscalls fewer per song.

    Without ``replace`` the file is opened EXCLUSIVELY, and a
    ``FileExistsError`` is the caller's signal that what it believed to be a
    new entry already exists on disk -- a folder the old importer wrote that
    was never indexed, say. Getting that from the open the writer was doing
    anyway is what lets this path skip a ``stat`` per song and still never
    overwrite somebody's edits.
    """
    try:
        os.mkdir(entry_dir)
    except FileExistsError:
        pass
    text = json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
    target = entry_dir / "metadata.json"
    if not replace:
        # O_EXCL, so an entry already on disk raises FileExistsError here
        # instead of being silently overwritten.
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        try:
            os.write(fd, text.encode("utf-8"))
        finally:
            os.close(fd)
        return
    tmp = entry_dir / "metadata.json.tmp"
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(target)


def _existing_metadata(entry_dir: Path) -> tuple[Optional[dict[str, Any]], bool]:
    """The entry's own ``metadata.json``, with a parse failure told apart from
    "no file yet". ``_read_metadata`` already collapses both to ``None`` --
    exactly right for a normal read, wrong for an update, where the two must
    be handled differently: nothing to merge over, versus something already
    there that an update must never destroy.

    Returns ``(metadata, unreadable)``. ``unreadable`` is true only when a
    file is present but could not be parsed as a JSON object.
    """
    if not (entry_dir / "metadata.json").is_file():
        return None, False
    parsed = _read_metadata(entry_dir)
    if not isinstance(parsed, dict):
        return None, True
    return parsed, False


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------


def estimate_promotion_bytes(
    connection: sqlite3.Connection, pending: int, *, namespace_hint: str = "suno"
) -> tuple[int, int]:
    """``(bytes per entry, total bytes)`` for ``pending`` songs still to promote.

    The per-entry figure is *measured*, not assumed: a sample of the staged
    records is mapped exactly as the real pass would map it and the resulting
    ``metadata.json`` is serialized. Filesystem slack is charged at one
    allocation unit for the file and one for the directory, and the same JSON
    is charged again (times :data:`DB_GROWTH_FACTOR`) for the row, the search
    index and SQLite's free pages.
    """
    del namespace_hint  # the sample carries its own namespace
    if pending <= 0:
        return 0, 0
    sizes: list[int] = []
    rows = connection.execute(
        f"SELECT {_ASSET_COLUMNS_A}, r.raw_json AS raw_json FROM staged_assets a"
        " JOIN asset_revisions r ON r.asset_id = a.id"
        " AND r.content_hash = a.selected_content_hash"
        " ORDER BY a.id LIMIT ?",
        (int(SAMPLE_ASSETS),),
    )
    for row in rows:
        asset = StagedAsset.from_row(row)
        try:
            raw = json.loads(row["raw_json"])
        except (TypeError, ValueError):
            raw = {}
        meta = build_metadata(
            asset,
            raw if isinstance(raw, dict) else {},
            entry_id=entry_id_for(asset.namespace, asset.external_id),
            audio_path=None,
            audio_bytes=None,
            edits=None,
        )
        sizes.append(
            len(json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode())
        )
    if not sizes:
        return 0, 0
    per_entry_json = sum(sizes) / len(sizes)
    on_disk = (
        math.ceil(per_entry_json / ALLOCATION_UNIT) * ALLOCATION_UNIT + ALLOCATION_UNIT
    )
    per_entry = int(on_disk + per_entry_json * DB_GROWTH_FACTOR)
    return per_entry, int(per_entry * pending * FREE_SPACE_MARGIN)


def backup_library_db(store: LibraryStore) -> Optional[Path]:
    """Copy the library database into ``<root>/backups/`` before the first write.

    Uses SQLite's own backup API against a second connection to the same file,
    so the copy is a consistent snapshot of the committed state rather than a
    file copy that could catch a half-written page. Returns ``None`` when there
    is nothing to protect -- an empty library.
    """
    if store.db is None or store.db.count_entries() == 0:
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = store.root / BACKUP_DIRNAME
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{BACKUP_PREFIX}{stamp}.sqlite3"
    source = sqlite3.connect(store.db.path)
    try:
        destination = sqlite3.connect(target)
        try:
            source.backup(destination)
        finally:
            destination.close()
    finally:
        source.close()
    log.info("library.suno_promote: backed the library database up to %s", target)
    return target


# ---------------------------------------------------------------------------
# The pass
# ---------------------------------------------------------------------------


def _page(connection: sqlite3.Connection, cursor: str, size: int) -> list[StagedAsset]:
    rows = connection.execute(
        f"SELECT {_ASSET_COLUMNS} FROM staged_assets WHERE id > ? ORDER BY id LIMIT ?",
        (cursor, int(size)),
    ).fetchall()
    return [StagedAsset.from_row(row) for row in rows]


def _raw_records(
    connection: sqlite3.Connection, wanted: Sequence[tuple[str, str]]
) -> dict[str, dict[str, Any]]:
    """``asset id -> sanitized raw record`` for the selected revisions asked for."""
    out: dict[str, dict[str, Any]] = {}
    for start in range(0, len(wanted), 450):
        chunk = wanted[start : start + 450]
        marks = ",".join("(?,?)" for _ in chunk)
        params: list[str] = []
        for asset_id, digest in chunk:
            params.extend((asset_id, digest))
        for row in connection.execute(
            "SELECT asset_id, raw_json FROM asset_revisions"
            f" WHERE (asset_id, content_hash) IN (VALUES {marks})",
            params,
        ):
            try:
                value = json.loads(row["raw_json"])
            except (TypeError, ValueError):
                continue
            if isinstance(value, dict):
                out[str(row["asset_id"])] = value
    return out


def _verified_audio(
    connection: sqlite3.Connection, asset_ids: Sequence[str]
) -> dict[str, tuple[str, Optional[int]]]:
    """``asset id -> (path, bytes)`` for assets with a verified local audio file."""
    out: dict[str, tuple[str, Optional[int]]] = {}
    for start in range(0, len(asset_ids), 900):
        chunk = asset_ids[start : start + 900]
        marks = ",".join("?" * len(chunk))
        for row in connection.execute(
            "SELECT asset_id, path, bytes FROM staged_media"
            f" WHERE kind='audio' AND state='verified' AND asset_id IN ({marks})",
            list(chunk),
        ):
            out.setdefault(str(row["asset_id"]), (str(row["path"]), row["bytes"]))
    return out


def _other_revision_titles(
    connection: sqlite3.Connection, asset_ids: Sequence[str]
) -> dict[str, list[str]]:
    """Every staged revision's title, per asset. Only ever asked for the few
    entries whose library title already disagrees with the selected one."""
    out: dict[str, list[str]] = {}
    if not asset_ids:
        return out
    for start in range(0, len(asset_ids), 900):
        chunk = asset_ids[start : start + 900]
        marks = ",".join("?" * len(chunk))
        for row in connection.execute(
            f"SELECT asset_id, raw_json FROM asset_revisions WHERE asset_id IN ({marks})",
            list(chunk),
        ):
            try:
                value = json.loads(row["raw_json"])
            except (TypeError, ValueError):
                continue
            if isinstance(value, dict) and isinstance(value.get("title"), str):
                out.setdefault(str(row["asset_id"]), []).append(value["title"])
    return out


def _stage_summary_counts(connection: sqlite3.Connection) -> dict[str, Any]:
    """Counts a promotion (or the UI before one) wants from a staging database."""

    def scalar(sql: str) -> int:
        return int(connection.execute(sql).fetchone()[0])

    availability = {
        str(row[0]): int(row[1])
        for row in connection.execute(
            "SELECT availability, COUNT(*) FROM staged_assets GROUP BY availability"
        )
    }
    promotable = availability.get("local-verified", 0) + availability.get(
        "remote-only", 0
    )
    return {
        "distinct_identities": scalar("SELECT COUNT(*) FROM staged_assets"),
        "revisions": scalar("SELECT COUNT(*) FROM asset_revisions"),
        "same_title_different_id": scalar(
            "SELECT COALESCE(SUM(size),0) FROM (SELECT COUNT(*) AS size FROM"
            " staged_assets WHERE title <> '' GROUP BY namespace, title"
            " HAVING COUNT(*) > 1)"
        ),
        "media_local_verified": availability.get("local-verified", 0),
        "media_local_unverified": availability.get("local-unverified", 0),
        "media_remote_only": availability.get("remote-only", 0),
        "media_missing": availability.get("missing", 0),
        "media_rejected": scalar("SELECT COUNT(*) FROM media_rejections"),
        "quarantined": scalar("SELECT COUNT(*) FROM quarantine"),
        "unresolved_lineage": scalar(
            "SELECT COUNT(*) FROM lineage_edges e LEFT JOIN staged_assets a"
            " ON a.namespace = e.namespace AND a.external_id = e.parent_external_id"
            " WHERE a.id IS NULL"
        ),
        "lineage_edges": scalar("SELECT COUNT(*) FROM lineage_edges"),
        "promotable": promotable,
        "already_promoted": _promoted_count(connection),
    }


def _promoted_count(connection: sqlite3.Connection) -> int:
    try:
        return int(connection.execute("SELECT COUNT(*) FROM promotions").fetchone()[0])
    except sqlite3.OperationalError:
        return 0


def stage_report(stage_root: Path) -> dict[str, Any]:
    """Read-only summary of a staging database, for the import wizard."""
    root = Path(stage_root)
    try:
        connection = suno_stage.open_promotion_db(root, read_only=True)
    except suno_stage.StagingDatabaseError as exc:
        raise PromotionRefused(str(exc)) from exc
    try:
        payload = _stage_summary_counts(connection)
    finally:
        connection.close()
    payload["stage_root"] = str(root)
    payload["database"] = str(suno_stage.stage_db_path(root))
    return payload


#: Matches ``LibraryStore.__init__``'s own default (``store.py``). Not
#: importable as a constant from there; kept as one literal, here, so a dry
#: run's read-only reader looks at the exact same file a real run would open.
_LIBRARY_DB_FILENAME = "library.db"
_LIBRARY_DEFAULT_API_PREFIX = "/api/library"


#: Raised for a ``library.db`` an old schema cannot answer a read-only
#: query with (missing column/table this codebase's version expects) --
#: only a real, writable open runs the migration that would fix it. Item 5.
_SCHEMA_REFUSAL = "{path} needs a real open to migrate first: {exc}"

#: A ``sqlite3.OperationalError`` message fragment meaning "this file has no
#: schema yet, not that it's broken" -- a missing table (never migrated) or
#: an empty/0-byte file (which SQLite's ``immutable=1`` reads as a valid,
#: empty database with no ``entries`` table at all). Follow-up item 4: a
#: real, writable ``LibraryDB`` would treat either the same way -- as a
#: fresh database to initialize on first write -- not as something broken.
_EMPTY_DB_MESSAGES = ("no such table",)


def _is_unc_root(path: Path) -> bool:
    """UNC roots (``\\\\server\\share\\...``) are refused for a dry run's
    read-only open (follow-up item 1): checked before any filesystem access
    at all, so the refusal is the same whether or not a ``library.db``
    exists there, and a possibly slow/unreachable network stat is never
    attempted for a path being refused either way."""
    return path.resolve().drive.startswith("\\\\")


class _ReadOnlyEntrySummaries:
    """Read-only stand-in for ``LibraryDB.entries_summary_for`` (L1).

    Opens ``library.db`` through :func:`suno_stage.read_only_sqlite_uri` --
    the same guarantee :func:`suno_stage.open_promotion_db` already gives the
    staging side of a dry run -- so a ``--dry-run`` promotion can never
    create, migrate, or otherwise write to the real library's database, and
    never leaves fresh ``-wal``/``-shm`` sidecars behind either.

    The query mirrors ``LibraryDB.entries_summary_for`` exactly -- it is the
    only entry point ``promote_stage`` reads through during a dry run -- but
    is not the same class, so opening it never runs a schema migration or an
    auto-reindex against the live database file.

    Item 4: a missing OR empty ``library.db`` does not mean the library is
    empty -- a real, writable ``LibraryStore`` auto-reindexes from disk in
    exactly that situation (``store.py``'s own ``__init__``). Falling back to
    "everything is new" here would make a dry run's counts lie whenever
    someone deleted ``library.db`` (or it was never created) but the entry
    folders are still on disk. ``entries_summary_for`` mirrors that read,
    straight off each entry's ``metadata.json``, without writing anything.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = root / _LIBRARY_DB_FILENAME
        self._connection: Optional[sqlite3.Connection] = None
        self._disk_fallback = True
        #: Follow-up item 2: whether this open used ``immutable=1`` (no
        #: ``-wal`` sidecar existed yet). Only then can a writer showing up
        #: mid-dry-run matter -- see :meth:`refuse_if_changed_since_open`.
        self._opened_immutable = False
        #: Follow-up item 4: set when ``library.db`` exists but has no
        #: schema yet (0 bytes, or truly never migrated) -- reported,
        #: not refused.
        self.empty_reason: Optional[str] = None
        # Follow-up item 1: the UNC check runs before ANY filesystem access,
        # so a UNC root refuses the same way whether or not a library.db
        # exists there yet, and a possibly slow/unreachable network stat is
        # never attempted for a path being refused either way.
        if _is_unc_root(root):
            raise PromotionRefused(
                f"UNC path not supported for a read-only open: {root}"
            )
        if not self.path.is_file():
            return
        try:
            uri = suno_stage.read_only_sqlite_uri(self.path)
        except ValueError as exc:
            raise PromotionRefused(str(exc)) from exc
        self._opened_immutable = "immutable=1" in uri
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        try:
            count = int(
                connection.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
            )
        except sqlite3.OperationalError as exc:
            connection.close()
            if any(fragment in str(exc).lower() for fragment in _EMPTY_DB_MESSAGES):
                self.empty_reason = (
                    f"{self.path.name} is empty; a real run will create it"
                )
                return
            raise PromotionRefused(
                _SCHEMA_REFUSAL.format(path=self.path, exc=exc)
            ) from exc
        except sqlite3.DatabaseError as exc:
            # sqlite3.DatabaseError (NOT a sqlite3.OperationalError) is what
            # an actually corrupt file -- garbage bytes, not simply empty --
            # raises. Not covered by follow-up item 4 (that is specifically
            # the 0-byte/never-migrated case, caught above): refuse rather
            # than silently treat corruption as "everything is new".
            connection.close()
            raise PromotionRefused(
                _SCHEMA_REFUSAL.format(path=self.path, exc=exc)
            ) from exc
        self._connection = connection
        self._disk_fallback = count == 0

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()

    def refuse_if_changed_since_open(self) -> None:
        """Follow-up item 2: an ``immutable=1`` read assumes the file will
        not change out from under it -- never true (it only ever helps a
        dry run avoid leaving sidecars), but never harmful to the live
        database either. If a writer showed up mid-dry-run, though, an
        immutable reader could have read torn pages: if a ``-wal`` sidecar
        exists now where none did when this reader opened, the counts this
        run collected cannot be trusted. Called once, at the very end of a
        dry run.
        """
        if not self._opened_immutable:
            return
        wal_sidecar = self.path.with_name(self.path.name + "-wal")
        if wal_sidecar.is_file():
            raise PromotionRefused("library changed during the dry run; run it again")

    def count_entries(self) -> int:
        if self._connection is None:
            return 0
        return int(
            self._connection.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        )

    def entries_summary_for(
        self,
        entry_ids: Sequence[str],
        *,
        json_keys: Sequence[str] = (),
    ) -> dict[str, dict[str, Any]]:
        ids = [str(entry_id) for entry_id in entry_ids]
        if not ids:
            return {}
        if self._disk_fallback:
            return self._disk_summary_for(ids, json_keys)
        assert self._connection is not None
        paths = [str(key) for key in json_keys]
        projection = "".join(
            f", CASE WHEN json_valid(metadata_json)"
            f" THEN json_extract(metadata_json, ?) END AS j{index}"
            for index in range(len(paths))
        )
        out: dict[str, dict[str, Any]] = {}
        cur = self._connection.cursor()
        try:
            for start in range(0, len(ids), _MAX_SQL_PARAMS - len(paths)):
                chunk = ids[start : start + (_MAX_SQL_PARAMS - len(paths))]
                marks = ", ".join("?" * len(chunk))
                rows = cur.execute(
                    f"SELECT id, title, favorite, rating, notes, source,"
                    f" timestamp{projection} FROM entries WHERE id IN ({marks})",
                    [*paths, *chunk],
                ).fetchall()
                for row in rows:
                    summary = {
                        "id": str(row["id"]),
                        "title": row["title"],
                        "favorite": bool(row["favorite"]),
                        "rating": row["rating"],
                        "notes": row["notes"],
                        "source": row["source"],
                        "timestamp": row["timestamp"],
                    }
                    for index, key in enumerate(paths):
                        summary[key] = row[f"j{index}"]
                    out[summary["id"]] = summary
        except sqlite3.OperationalError as exc:
            raise PromotionRefused(
                _SCHEMA_REFUSAL.format(path=self.path, exc=exc)
            ) from exc
        finally:
            cur.close()
        return out

    def _disk_summary_for(
        self, ids: Sequence[str], json_keys: Sequence[str]
    ) -> dict[str, dict[str, Any]]:
        """Item 4's fallback: read each entry's ``metadata.json`` straight off
        disk, mirroring what ``LibraryStore.reindex()`` would put in the DB,
        without writing anything. Every caller only ever asks for simple
        top-level keys (``"$.suno_revision"``); a compound path just resolves
        to ``None``, same as the SQL projection does for a key the row does
        not have."""
        out: dict[str, dict[str, Any]] = {}
        for entry_id in ids:
            meta = _read_metadata(self.root / entry_id)
            if meta is None:
                continue
            summary: dict[str, Any] = {
                "id": entry_id,
                "title": meta.get("title"),
                "favorite": bool(meta.get("favorite", False)),
                "rating": meta.get("rating"),
                "notes": meta.get("notes"),
                "source": meta.get("source"),
                "timestamp": meta.get("timestamp"),
            }
            for key in json_keys:
                path = str(key)
                summary[path] = meta.get(path[2:]) if path.startswith("$.") else None
            out[entry_id] = summary
        return out


class ReadOnlyLibraryTarget:
    """Everything ``promote_stage`` reads from ``store`` during a dry run.

    Stands in for :class:`~backend.modules.library.store.LibraryStore`
    without ever instantiating it: constructing a real ``LibraryStore``
    unconditionally ``mkdir``s the library root and, on an empty database,
    auto-reindexes -- both writes a ``--dry-run`` must not perform against a
    library it may not even be pointed at correctly yet. See L1.
    """

    def __init__(
        self, root: Path, *, api_prefix: str = _LIBRARY_DEFAULT_API_PREFIX
    ) -> None:
        self.root = root
        self.api_prefix = api_prefix
        self.db = _ReadOnlyEntrySummaries(root)

    def close(self) -> None:
        self.db.close()


#: What ``promote_stage`` and its helpers accept for ``store``: a real,
#: writable target for a live run, or the read-only stand-in a dry run opens.
PromotionTarget = Union[LibraryStore, ReadOnlyLibraryTarget]


def open_promotion_target(
    root: Path, *, dry_run: bool, api_prefix: str = _LIBRARY_DEFAULT_API_PREFIX
) -> PromotionTarget:
    """Open the library ``promote_stage`` writes into (or, for a dry run,
    only reads from).

    ``dry_run=True`` returns a :class:`ReadOnlyLibraryTarget`: ``library.db``
    is opened ``mode=ro`` and the library folder is never created. Anything
    else returns a real, writable :class:`LibraryStore`.
    """
    if dry_run:
        return ReadOnlyLibraryTarget(Path(root), api_prefix=api_prefix)
    return LibraryStore(Path(root))


def _existing_ancestor(path: Path) -> Path:
    """The nearest of ``path`` or one of its parents that already exists.

    ``shutil.disk_usage`` needs a real path; a dry run's target may not have
    one yet (see :class:`ReadOnlyLibraryTarget`, L1), and creating it just to
    measure free space would defeat the point.
    """
    current = path
    while not current.exists():
        parent = current.parent
        if parent == current:  # reached a filesystem root; give up climbing
            break
        current = parent
    return current


def _validate_roots(stage_root: Path, store: PromotionTarget) -> tuple[Path, Path, str]:
    if store.db is None:
        raise PromotionRefused("promotion needs the library DB")
    root = store.root.resolve()
    root_normcase = os.path.normcase(str(root))
    try:
        stage = Path(stage_root).resolve()
    except OSError as exc:
        raise PromotionRefused(f"unusable stage root {stage_root!r}: {exc}") from exc
    if os.path.normcase(str(stage)).startswith(root_normcase + os.sep) or stage == root:
        raise PromotionRefused(
            f"stage root {stage} sits inside the library root {root}; "
            "stage onto a different drive or folder"
        )
    if not suno_stage.stage_db_path(stage).is_file():
        raise PromotionRefused(
            f"no Suno staging database at {suno_stage.stage_db_path(stage)}"
        )
    return stage, root, root_normcase


def promote_stage(
    stage_root: Path,
    store: PromotionTarget,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    dry_run: bool = False,
    on_batch: Optional[Callable[[PromotionProgress], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    backup: bool = True,
) -> PromotionReport:
    """Promote everything staged under ``stage_root`` into ``store``.

    Returns a reconciled :class:`PromotionReport`. Raises
    :class:`PromotionRefused` before writing anything when the paths or the
    free space do not allow the run. Cancellation through ``should_stop`` is
    honoured BETWEEN batches, so the transaction in flight always commits and
    the run is resumable from its receipts.
    """
    if int(batch_size) < 1:
        raise ValueError(f"batch_size must be >= 1, got {batch_size!r}")
    started = time.perf_counter()
    stage, root, root_normcase = _validate_roots(stage_root, store)
    report = PromotionReport(
        stage_root=str(stage),
        library_root=str(root),
        dry_run=bool(dry_run),
        batch_size=int(batch_size),
    )
    if isinstance(store, ReadOnlyLibraryTarget) and store.db.empty_reason:
        # Follow-up item 4: reported, not refused -- a real run treats this
        # the same as any other fresh database.
        report.errors.append(store.db.empty_reason)
    try:
        connection = suno_stage.open_promotion_db(stage, read_only=dry_run)
    except suno_stage.StagingDatabaseError as exc:
        raise PromotionRefused(str(exc)) from exc

    try:
        report.total_staged = int(
            connection.execute("SELECT COUNT(*) FROM staged_assets").fetchone()[0]
        )
        pending = max(0, report.total_staged - _promoted_count(connection))
        _per_entry, report.estimated_bytes = estimate_promotion_bytes(
            connection, pending
        )
        # L1: a dry run against a library that does not exist yet must not
        # create it just to measure free space; walk up to whatever ancestor
        # is actually on disk (real runs always find ``root`` itself here,
        # since a writable LibraryStore already created it).
        try:
            report.free_bytes = int(shutil.disk_usage(_existing_ancestor(root)).free)
        except OSError as exc:
            # Item 6: a drive that does not exist at all (``Q:\lib``) has no
            # existing ancestor to climb to; refuse cleanly instead of
            # crashing inside shutil.
            raise PromotionRefused(
                f"cannot measure free space at {root}: {exc}"
            ) from exc
        if report.estimated_bytes > report.free_bytes:
            message = (
                f"{root} has {report.free_bytes:,} bytes free; promoting "
                f"{pending:,} songs needs about {report.estimated_bytes:,}. "
                "Free space, or move the library to a bigger drive "
                "(theDAW_GENERATIONS_DIR)."
            )
            if not dry_run:
                raise PromotionRefused(message)
            report.errors.append(message)

        if not dry_run and backup:
            taken = backup_library_db(store)
            report.backup_path = str(taken) if taken is not None else None

        # L2: asset ids this run resolves to a non-deferred outcome, tracked
        # separately from the staging ``promotions`` table because a dry run
        # never writes a receipt there. Without it, the lineage pass below
        # would call every parent staged (and promotable) in THIS SAME run
        # "unresolved" just because no earlier run had promoted it yet.
        run_resolved: set[str] = set()

        _promote_assets(
            connection,
            store,
            report,
            root=root,
            root_normcase=root_normcase,
            started=started,
            on_batch=on_batch,
            should_stop=should_stop,
            run_resolved=run_resolved,
        )
        if report.status == "complete":
            _promote_lineage(connection, store, report, run_resolved=run_resolved)
    finally:
        connection.close()
        report.elapsed_seconds = max(0.0, time.perf_counter() - started)
    if dry_run and isinstance(store, ReadOnlyLibraryTarget):
        # Follow-up item 2: only meaningful now, at the very end -- checked
        # once, after every read this run did, so a writer that appeared
        # and vanished mid-run (or is still mid-transaction) is still
        # caught by the -wal sidecar it leaves behind either way.
        store.db.refuse_if_changed_since_open()
    return report


def _promote_assets(
    connection: sqlite3.Connection,
    store: PromotionTarget,
    report: PromotionReport,
    *,
    root: Path,
    root_normcase: str,
    started: float,
    on_batch: Optional[Callable[[PromotionProgress], None]],
    should_stop: Optional[Callable[[], bool]],
    run_resolved: set[str],
) -> None:
    api_prefix = store.api_prefix
    cursor = ""
    while True:
        if should_stop is not None and should_stop():
            report.status = "cancelled"
            return
        page = _page(connection, cursor, report.batch_size)
        if not page:
            return
        cursor = page[-1].id
        _promote_page(
            connection,
            store,
            report,
            page,
            root=root,
            root_normcase=root_normcase,
            api_prefix=api_prefix,
            run_resolved=run_resolved,
        )
        if on_batch is not None:
            on_batch(report.progress(started, report.total_staged))


def _promote_page(
    connection: sqlite3.Connection,
    store: PromotionTarget,
    report: PromotionReport,
    page: list[StagedAsset],
    *,
    root: Path,
    root_normcase: str,
    api_prefix: str,
    run_resolved: set[str],
) -> None:
    report.seen += len(page)
    asset_ids = [asset.id for asset in page]
    receipts = suno_stage.promotion_receipts(connection, asset_ids)

    todo: list[StagedAsset] = []
    for asset in page:
        receipt = receipts.get(asset.id)
        if receipt is not None and receipt[0] == asset.content_hash:
            # Already promoted by this or an earlier run. Counted under its
            # recorded outcome, except that "created" becomes "unchanged":
            # nothing was created NOW, and a second full run must say so.
            if receipt[1] == "deferred_no_media":
                report.note_deferred(asset.id, asset.external_id, asset.title)
            else:
                report.unchanged += 1
            continue
        todo.append(asset)
    if not todo:
        return

    audio = _verified_audio(connection, [asset.id for asset in todo])
    entry_ids = {
        asset.id: entry_id_for(asset.namespace, asset.external_id) for asset in todo
    }
    summaries = store.db.entries_summary_for(
        list(entry_ids.values()), json_keys=[f"$.{REVISION_KEY}"]
    )
    revision_key = f"$.{REVISION_KEY}"

    creates: list[StagedAsset] = []
    updates: list[StagedAsset] = []
    receipts_out: list[tuple[str, str, str, str]] = []
    for asset in todo:
        entry_id = entry_ids[asset.id]
        if asset.id not in audio and not asset.audio_url:
            report.note_deferred(asset.id, asset.external_id, asset.title)
            receipts_out.append(
                (asset.id, asset.content_hash, entry_id, "deferred_no_media")
            )
            continue
        summary = summaries.get(entry_id)
        if summary is None:
            creates.append(asset)
        elif summary.get(revision_key) == asset.content_hash:
            # The entry already carries this exact revision. Either nothing
            # changed upstream, or an interrupted run wrote the entry and died
            # before its receipt -- the reconcile the module docstring promises.
            report.unchanged += 1
            receipts_out.append((asset.id, asset.content_hash, entry_id, "unchanged"))
        else:
            updates.append(asset)

    raw = _raw_records(
        connection, [(asset.id, asset.content_hash) for asset in creates + updates]
    )
    other_titles = _other_revision_titles(
        connection,
        [
            asset.id
            for asset in updates
            if (summaries.get(entry_ids[asset.id]) or {}).get("title")
            not in (asset.title, "", None)
        ],
    )

    payloads: list[dict[str, Any]] = []
    for asset, is_update in [(a, False) for a in creates] + [
        (a, True) for a in updates
    ]:
        entry_id = entry_ids[asset.id]
        record = raw.get(asset.id)
        if record is None:
            report.note_failure(
                f"{asset.external_id}: staged revision {asset.content_hash[:12]} "
                "is missing its raw record"
            )
            continue
        try:
            entry_dir = _entry_dir(root, root_normcase, entry_id)
            found = audio.get(asset.id)

            def render(edits: Optional[UserEdits]) -> dict[str, Any]:
                return build_metadata(
                    asset,
                    record,
                    entry_id=entry_id,
                    audio_path=found[0] if found else None,
                    audio_bytes=found[1] if found else None,
                    edits=edits,
                    other_titles=other_titles.get(asset.id, ()),
                )

            def merged_update(old_meta: dict[str, Any]) -> dict[str, Any]:
                """Everything the entry already has, with only the
                provider-owned keys ``build_metadata`` produces refreshed.
                A staged value ``build_metadata`` could not resolve this run
                -- an unknown duration, no local audio found -- is simply
                absent from its dict, so the merge leaves whatever the entry
                already carries for that key exactly as it was."""
                edits = user_edits_from(
                    old_meta, summaries.get(entry_id), namespace=asset.namespace
                )
                return {**old_meta, **render(edits)}

            if is_update:
                old_meta, unreadable = _existing_metadata(entry_dir)
                if unreadable:
                    report.note_failure(
                        f"{asset.external_id}: existing metadata.json at "
                        f"{entry_dir} is not valid JSON; left untouched"
                    )
                    continue
                meta = merged_update(old_meta or {})
            else:
                meta = render(None)
            if not report.dry_run:
                try:
                    _write_entry(entry_dir, meta, replace=is_update)
                except FileExistsError:
                    # There IS an entry here, it just had no row -- the old
                    # importer wrote folders straight to disk. Re-render it as
                    # the update it is rather than overwrite the user's copy.
                    # Re-resolved, not reused: an unindexed folder left by the
                    # old importer is exactly the kind of thing that could
                    # already be a symlink.
                    entry_dir = _entry_dir(root, root_normcase, entry_id)
                    old_meta, unreadable = _existing_metadata(entry_dir)
                    if unreadable:
                        report.note_failure(
                            f"{asset.external_id}: existing metadata.json at "
                            f"{entry_dir} is not valid JSON; left untouched"
                        )
                        continue
                    is_update = True
                    meta = merged_update(old_meta or {})
                    _write_entry(entry_dir, meta, replace=True)
        except (PromotionRefused, OSError) as exc:
            report.note_failure(f"{asset.external_id}: {exc}")
            continue
        payloads.append(_db_payload(build_record(meta, api_prefix), meta))
        if is_update:
            report.updated += 1
            receipts_out.append((asset.id, asset.content_hash, entry_id, "updated"))
        else:
            report.created += 1
            receipts_out.append((asset.id, asset.content_hash, entry_id, "created"))

    # L2: every id this page resolves to something other than "no media" is
    # promotable, whether or not the receipt below actually gets written --
    # a dry run needs the lineage pass to see it too.
    run_resolved.update(
        asset_id
        for asset_id, _content_hash, _entry_id, outcome in receipts_out
        if outcome != "deferred_no_media"
    )

    if report.dry_run:
        return
    if payloads:
        # ONE transaction, one library_revision bump, for the whole page.
        store.db.upsert_entries_bulk(payloads, batch=len(payloads))
    # Strictly after the library write it describes; see the module docstring
    # for how a crash in between is reconciled.
    suno_stage.record_promotions(connection, receipts_out)


# ---------------------------------------------------------------------------
# Lineage, second pass
# ---------------------------------------------------------------------------


def _promote_lineage(
    connection: sqlite3.Connection,
    store: PromotionTarget,
    report: PromotionReport,
    *,
    run_resolved: set[str],
    page_size: int = 2000,
) -> None:
    """Turn staged lineage hints into typed relations, once every entry exists.

    A second pass rather than an inline one, because a child is very often
    staged before its parent. A parent that was promoted becomes a real edge to
    its entry id; a parent that was not -- it was deferred, quarantined, or
    simply never in this cache -- becomes an edge to the external label
    ``<namespace>:<provider id>``, which the relations table and the lineage
    view both already understand. The edge is KEPT either way: dropping it
    would lose the only record that the song was derived from something.

    ``INSERT OR IGNORE`` against ``UNIQUE(from_id, to_id, kind)`` is what makes
    a re-run add nothing. No traversal happens here, so a cycle in the staged
    hints is simply two edges.
    """
    seen_rows = 0
    cursor: tuple[str, str, str, str] = ("", "", "", "")
    while True:
        rows = connection.execute(
            "SELECT namespace, child_external_id, parent_external_id, relation,"
            " evidence_path FROM lineage_edges"
            " WHERE (child_external_id, parent_external_id, relation, evidence_path)"
            " > (?,?,?,?)"
            " ORDER BY child_external_id, parent_external_id, relation, evidence_path"
            " LIMIT ?",
            (*cursor, int(page_size)),
        ).fetchall()
        if not rows:
            return
        cursor = (
            str(rows[-1]["child_external_id"]),
            str(rows[-1]["parent_external_id"]),
            str(rows[-1]["relation"]),
            str(rows[-1]["evidence_path"]),
        )
        seen_rows += len(rows)

        parents = {
            (str(row["namespace"]), str(row["parent_external_id"])) for row in rows
        }
        promoted = _promoted_parents(connection, sorted(parents), run_resolved)
        edges: list[tuple[str, str, str]] = []
        for row in rows:
            namespace = str(row["namespace"])
            child = str(row["child_external_id"])
            parent = str(row["parent_external_id"])
            if (namespace, parent) in promoted:
                to_id = entry_id_for(namespace, parent)
            else:
                to_id = f"{namespace}:{parent}"
                report.lineage_unresolved += 1
            edges.append((entry_id_for(namespace, child), to_id, str(row["relation"])))
        deduped = list(dict.fromkeys(edges))
        report.lineage_edges += len(deduped)
        if not report.dry_run:
            store.db.add_relations_bulk(deduped)


def _promoted_parents(
    connection: sqlite3.Connection,
    parents: Sequence[tuple[str, str]],
    run_resolved: set[str],
) -> set[tuple[str, str]]:
    """Which of these ``(namespace, provider id)`` parents are in the library.

    ``promotions`` is the authority rather than ``staged_assets``: a parent
    that is staged but was deferred for having no media has no entry to point
    at, and its child's edge has to stay an external label.

    L2: ``promotions`` alone is not the whole story during a dry run, which
    never writes a receipt there. ``run_resolved`` (built while THIS run
    processed its asset pages) fills that gap so a parent staged and
    resolved earlier in the very same run is not reported unresolved just
    because nothing was persisted for it.
    """
    found: set[tuple[str, str]] = set()
    if not parents:
        return found
    asset_ids = {
        suno_stage.asset_id(namespace, external): (namespace, external)
        for namespace, external in parents
    }
    for candidate_id, pair in asset_ids.items():
        if candidate_id in run_resolved:
            found.add(pair)
    keys = list(asset_ids)
    try:
        for start in range(0, len(keys), 900):
            chunk = keys[start : start + 900]
            marks = ",".join("?" * len(chunk))
            for row in connection.execute(
                f"SELECT asset_id FROM promotions WHERE outcome <> 'deferred_no_media'"
                f" AND asset_id IN ({marks})",
                chunk,
            ):
                found.add(asset_ids[str(row[0])])
    except sqlite3.OperationalError as exc:
        # Item 3: only an actually missing ``promotions`` table (nothing has
        # ever been promoted for real against this stage) is not an error --
        # anything else ("database is locked", a corrupt index, ...) must not
        # be swallowed into "this parent is unresolved", which would silently
        # turn a real edge into a permanent external-label one. ``found`` may
        # already hold this run's own matches from ``run_resolved`` above;
        # keep them rather than discarding on the benign path.
        if "no such table" not in str(exc).lower():
            raise
    return found


# ---------------------------------------------------------------------------
# Jobs (shown on the shared /import-jobs routes)
# ---------------------------------------------------------------------------


class SunoJob:
    """A staging or promotion run on the background queue.

    Shaped like ``store.ImportJob`` -- same statuses, same lock discipline,
    same "cancel is honoured between batches" promise -- so the existing
    ``GET``/``DELETE /import-jobs/{id}`` routes can drive it. It carries the
    extra fields these two runs have (``kind``, the promotion counters, and the
    final report) and omits the folder one, which means nothing here.
    """

    def __init__(self, job_id: str, kind: str, detail: dict[str, Any]) -> None:
        self.id = job_id
        self.kind = kind
        self.detail = dict(detail)
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self.status = "queued"
        self.seen = 0
        self.created = 0
        self.updated = 0
        self.unchanged = 0
        self.deferred = 0
        self.failed = 0
        self.total: Optional[int] = None
        self.rate: Optional[float] = None
        self.eta_seconds: Optional[float] = None
        self.errors: list[str] = []
        self.report: Optional[dict[str, Any]] = None
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None

    # -- lifecycle ---------------------------------------------------------

    def cancel(self) -> None:
        self._cancel.set()
        with self._lock:
            if self.status == "queued":
                self.status = "cancelled"
                self.finished_at = time.time()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    @property
    def finished(self) -> bool:
        with self._lock:
            return self.status in ("done", "failed", "cancelled")

    def begin(self) -> None:
        with self._lock:
            self.status = "running"
            self.started_at = time.time()

    def finish(self, status: str, *, error: Optional[str] = None) -> None:
        with self._lock:
            self.status = status
            self.finished_at = time.time()
            if error and len(self.errors) < MAX_ERRORS:
                self.errors.append(error)

    # -- progress ----------------------------------------------------------

    def note_promotion(self, progress: PromotionProgress) -> None:
        with self._lock:
            self.seen = progress.seen
            self.created = progress.created
            self.updated = progress.updated
            self.unchanged = progress.unchanged
            self.deferred = progress.deferred_no_media
            self.failed = progress.failed
            self.total = progress.total
            self.rate = progress.records_per_second
            self.eta_seconds = progress.eta_seconds

    def note_stage(self, progress: "suno_stage.StageProgress") -> None:
        with self._lock:
            self.seen = progress.seen
            self.created = progress.accepted
            self.unchanged = progress.duplicate
            self.failed = progress.quarantined
            self.total = progress.total
            self.rate = progress.records_per_second
            self.eta_seconds = progress.eta_seconds

    def set_report(self, payload: dict[str, Any]) -> None:
        with self._lock:
            self.report = payload

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.id,
                "kind": self.kind,
                "detail": dict(self.detail),
                "status": self.status,
                "seen": self.seen,
                "created": self.created,
                "updated": self.updated,
                "unchanged": self.unchanged,
                "skipped": self.unchanged,
                "deferred": self.deferred,
                "failed": self.failed,
                "total": self.total,
                "rate": self.rate,
                "eta_seconds": self.eta_seconds,
                "errors": list(self.errors),
                "report": self.report,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }


def run_stage_job(
    job: SunoJob,
    *,
    cache_path: Path,
    stage_root: Path,
    media_root: Optional[Path],
    namespace: str = "suno",
) -> SunoJob:
    """Stage one cache file to completion. Never raises: the job records it."""
    if job.cancelled:
        job.finish("cancelled")
        return job
    job.begin()
    try:
        report = suno_stage.stage_cache(
            Path(cache_path),
            Path(stage_root),
            namespace=namespace,
            media_root=Path(media_root) if media_root else None,
            on_commit=job.note_stage,
            should_stop=lambda: job.cancelled,
        )
        job.set_report(report.to_dict())
        job.finish("cancelled" if report.interrupted else "done")
    except Exception as exc:  # noqa: BLE001 - a job reports, it does not raise
        log.warning("library.suno_promote: stage job %s failed: %s", job.id, exc)
        job.finish("failed", error=repr(exc))
    return job


def run_promote_job(
    job: SunoJob,
    store: LibraryStore,
    *,
    stage_root: Path,
    dry_run: bool = False,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> SunoJob:
    """Promote one staged catalog to completion. Never raises."""
    if job.cancelled:
        job.finish("cancelled")
        return job
    job.begin()
    target: Optional[PromotionTarget] = None
    try:
        # Item 8: the caller (the shared app-wide store from get_store())
        # always hands us a real, writable LibraryStore -- it is live and
        # shared, used for everything else the app does, and never closed
        # here. A dry run must still never read through ITS connection
        # either: swap in a read-only target against the same root, exactly
        # like the CLI's own dry run does, and leave ``store`` untouched.
        # Constructing it can itself refuse (a UNC root, an old schema);
        # that belongs in this same try so the job reports it, not raises.
        target = (
            open_promotion_target(store.root, dry_run=True, api_prefix=store.api_prefix)
            if dry_run
            else store
        )
        report = promote_stage(
            Path(stage_root),
            target,
            batch_size=batch_size,
            dry_run=dry_run,
            on_batch=job.note_promotion,
            should_stop=lambda: job.cancelled,
        )
        job.set_report(report.to_dict())
        job.note_promotion(
            PromotionProgress(
                seen=report.seen,
                created=report.created,
                updated=report.updated,
                unchanged=report.unchanged,
                deferred_no_media=report.deferred_no_media,
                failed=report.failed,
                elapsed_seconds=report.elapsed_seconds,
                total=report.total_staged,
            )
        )
        job.finish("done" if report.complete else "cancelled")
    except PromotionRefused as exc:
        job.finish("failed", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - a job reports, it does not raise
        log.warning("library.suno_promote: promote job %s failed: %s", job.id, exc)
        job.finish("failed", error=repr(exc))
    finally:
        if dry_run and isinstance(target, ReadOnlyLibraryTarget):
            target.close()
    return job


def default_stage_root() -> Path:
    """Where a staging catalog lands when the caller names no other place.

    Under the app data directory, which is correct but not necessarily fast:
    staging 200,000 songs was measured at 1.7 minutes on an NVMe drive and 16
    minutes on a spinning disk, so the UI should offer the user a faster drive.
    """
    from backend.lib import paths

    return paths.data_path("suno-stage")


def iter_deferred(stage_root: Path) -> Iterator[dict[str, str]]:
    """Every song a promotion deferred for having no media, from the receipts."""
    connection = suno_stage.open_promotion_db(Path(stage_root), read_only=True)
    try:
        for row in connection.execute(
            "SELECT p.asset_id, a.external_id, a.title FROM promotions p"
            " JOIN staged_assets a ON a.id = p.asset_id"
            " WHERE p.outcome = 'deferred_no_media' ORDER BY a.external_id"
        ):
            yield {
                "asset_id": str(row[0]),
                "external_id": str(row[1]),
                "title": str(row[2] or ""),
            }
    finally:
        connection.close()
