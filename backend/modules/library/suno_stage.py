"""Loss-free staging of a Suno/Harvester cache into a separate SQLite catalog.

This is the *staging* half of the full-cache import. It never writes to the
production library (``data/generations`` + ``library.sqlite3``) and never
touches the source cache: promotion through ``LibraryStore`` is a later step
that reads this catalog.

What "loss-free" means here, and how it differs from ``scripts/ingest_suno_cache.py``:

* **Identity is ``(namespace, provider song id)``** — never the title. Ten songs
  called "Neon Rain" are ten records. Titles are only ever *reported* on.
* **Every observed version survives.** A second record for the same id with
  different content becomes a new revision candidate (keyed by the SHA-256 of
  its canonical JSON); an exact repeat is counted as a duplicate and not
  re-stored. Nothing is overwritten, so the selected view of an asset is its
  first observation and the promotion pass can pick any policy it likes.
* **Unknown stays unknown.** A duration we cannot read is ``NULL``, never
  ``0.0``; an unparseable ``created_at`` is ``NULL``. The sanitized raw record
  is kept next to the normalized columns, so nothing is thrown away.
* **Nothing is dropped on error.** A malformed row goes to ``quarantine`` with
  its reason and the import carries on. A song whose audio has not finished (or
  never existed) is staged with an availability state.
* **Lineage is kept as evidence, not as truth.** Explicit parent hints become
  typed edges carrying the field they came from. A parent that never appears in
  the cache stays an unresolved edge; the child is never dropped.

Media follows plan decision D2 — *reference in place*. With ``--media-root`` a
local file is matched only by provider id (a filename that is the id, or that
contains the id) or by an explicit root-relative manifest path; never by title.
Paths are checked for containment (no ``..``, no absolute path, no symlink
escape) and an unsafe path is refused and recorded, which never costs the song.
No source file is read for content, copied, or modified. Copy-into-managed-
storage is a separate, opt-in mode that is not implemented here.

Streaming and restartability: JSONL/NDJSON streams on the standard library, one
line at a time. A ``{"songs": [...]}`` or top-level-array JSON needs ``ijson``,
which is deliberately *not* a project dependency — the big-JSON path raises with
the exact command to add it rather than installing anything at runtime, and when
ijson *is* present the fastest of its backends is chosen explicitly and named in
the report. Records are committed in bounded batches with the checkpoint in the
same transaction, so an interrupted run resumes from the last committed record
and a finished run is a no-op when re-run.

Built for the size the real archive is — ~200,000 songs in one multi-gigabyte
file — which is why the following are load-bearing rather than micro-tuning
(``scripts/bench_suno_stage.py`` generates a synthetic cache of that shape and
measures all of it; it never reads real data):

* nothing is accumulated per record. Memory is flat in the number of songs:
  the source streams, the batch is bounded, the media index is the only thing
  that scales with input and it holds one string per file, not a ``Path``.
* the staging database is opened for bulk load (see ``PRAGMAS``), and the
  indexes only the final report needs are built at the end rather than
  maintained across every insert.
* the common case — a song id never seen before — costs two SQL statements.
* ``sanitize`` is the per-record hot spot, because it walks every value of
  every record, so it tests exact types in frequency order and leaves a URL
  that provably holds no credentials untouched instead of re-encoding it.

Progress and interruption: ``on_commit`` receives a :class:`StageProgress` after
every committed batch, and ``should_stop`` is polled there, so a Ctrl+C finishes
the batch in flight and leaves a checkpoint instead of discarding the work.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import logging
import math
import os
import re
import sqlite3
import stat as stat_module
import time
import uuid
from collections.abc import Mapping, Sequence
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterator, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

log = logging.getLogger(__name__)

DB_FILENAME = "suno_stage.sqlite3"
STAGING_KIND = "suno-cache-staging"
SCHEMA_VERSION = "1"
DEFAULT_BATCH_SIZE = 500
DEFAULT_JSON_PREFIX = "songs.item"

#: ijson backends fastest first. The C extension is an order of magnitude ahead
#: of the pure-Python fallback, and which one you get depends on how ijson was
#: built, so the chosen one is named in the run report rather than assumed.
IJSON_BACKENDS: tuple[str, ...] = ("yajl2_c", "yajl2_cffi", "yajl2", "yajl", "python")
IJSON_MISSING_MESSAGE = (
    "Streaming {name} needs the optional 'ijson' package. Either export the "
    "cache as JSONL (one record per line, no dependency) or run `uv add ijson` "
    "first; this importer never installs packages."
)

AUDIO_SUFFIXES = frozenset(
    {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aiff", ".aif"}
)
ARTWORK_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"})

# Recognizable authentication material. Defense in depth, not a claim to catch
# every possible secret: the archive itself stays private and unchanged.
SECRET_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "cookies",
        "set_cookie",
        "access_token",
        "refresh_token",
        "id_token",
        "api_key",
        "apikey",
        "password",
        "secret",
        "session_token",
        "session",
        "jwt",
        "bearer",
    }
)
SECRET_QUERY_KEYS = SECRET_KEYS | {
    "token",
    "signature",
    "x-amz-signature",
    "x-amz-security-token",
    "x-amz-credential",
    "key-pair-id",
    "policy",
    "sig",
}
REDACTED = "[REDACTED]"

# A Suno clip id is a UUID; a filename that embeds one is an id match.
_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE
)

# Explicit derivation hints. Ancestry chains are evidence, not direct parentage;
# artist/persona/voice references are not audio derivations and are not edges.
METADATA_RELATIONS: tuple[tuple[str, str], ...] = (
    ("cover_audio_id", "cover_of"),
    ("cover_clip_id", "cover_of"),
    ("continue_clip_id", "extension_of"),
    ("extend_clip_id", "extension_of"),
    ("stem_from_id", "stem_of"),
    ("stem_of", "stem_of"),
    ("edited_clip_id", "edit_of"),
    ("upsample_clip_id", "upsample_of"),
    ("overpainting_clip_id", "overpaint_of"),
    ("underpainting_clip_id", "underpaint_of"),
    ("speed_clip_id", "speed_change_of"),
)
MASHUP_FIELD = "mashup_clip_ids"

IMAGE_FIELDS = ("image_url", "image_large_url", "video_cover_url", "preview_url")
MANIFEST_MEDIA_FIELDS: tuple[tuple[str, str], ...] = (
    ("local_audio_path", "audio"),
    ("local_artwork_path", "artwork"),
)

SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS stage_meta(
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_runs(
 id TEXT PRIMARY KEY,
 source_path TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,
 namespace TEXT NOT NULL,
 status TEXT NOT NULL,
 checkpoint INTEGER NOT NULL DEFAULT 0,
 seen INTEGER NOT NULL DEFAULT 0,
 accepted INTEGER NOT NULL DEFAULT 0,
 duplicate INTEGER NOT NULL DEFAULT 0,
 quarantined INTEGER NOT NULL DEFAULT 0,
 started_at TEXT NOT NULL,
 error TEXT);
CREATE TABLE IF NOT EXISTS staged_assets(
 id TEXT PRIMARY KEY,
 namespace TEXT NOT NULL,
 external_id TEXT NOT NULL,
 title TEXT NOT NULL,
 created_at TEXT,
 duration REAL,
 lyrics TEXT,
 prompt TEXT,
 style TEXT,
 tags_json TEXT NOT NULL,
 model_name TEXT,
 audio_url TEXT,
 image_urls_json TEXT NOT NULL,
 status TEXT,
 availability TEXT NOT NULL,
 selected_content_hash TEXT NOT NULL,
 revision_count INTEGER NOT NULL DEFAULT 0,
 first_seen_run TEXT NOT NULL,
 UNIQUE(namespace, external_id));
CREATE TABLE IF NOT EXISTS asset_revisions(
 asset_id TEXT NOT NULL REFERENCES staged_assets(id),
 content_hash TEXT NOT NULL,
 revision INTEGER NOT NULL,
 raw_json TEXT NOT NULL,
 observed_run TEXT NOT NULL,
 observed_ordinal INTEGER NOT NULL,
 PRIMARY KEY(asset_id, content_hash));
CREATE TABLE IF NOT EXISTS lineage_edges(
 namespace TEXT NOT NULL,
 child_external_id TEXT NOT NULL,
 parent_external_id TEXT NOT NULL,
 relation TEXT NOT NULL,
 evidence_path TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 PRIMARY KEY(namespace, child_external_id, parent_external_id, relation,
             evidence_path));
CREATE TABLE IF NOT EXISTS staged_media(
 asset_id TEXT NOT NULL REFERENCES staged_assets(id),
 kind TEXT NOT NULL,
 path TEXT NOT NULL,
 state TEXT NOT NULL,
 matched_by TEXT NOT NULL,
 bytes INTEGER,
 PRIMARY KEY(asset_id, kind, path));
CREATE TABLE IF NOT EXISTS media_rejections(
 asset_id TEXT NOT NULL,
 field TEXT NOT NULL,
 value TEXT NOT NULL,
 reason TEXT NOT NULL,
 PRIMARY KEY(asset_id, field, value));
CREATE TABLE IF NOT EXISTS quarantine(
 run_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 reason TEXT NOT NULL,
 raw TEXT NOT NULL,
 PRIMARY KEY(run_id, ordinal));
"""

STAGE_TABLES = frozenset(
    {
        "stage_meta",
        "import_runs",
        "staged_assets",
        "asset_revisions",
        "lineage_edges",
        "staged_media",
        "media_rejections",
        "quarantine",
    }
)

# Indexes nothing needs *during* a bulk load. Building them once at the end of
# the run instead of maintaining them across 200k inserts is worth several
# minutes on a spinning disk, and a run interrupted before they exist simply
# builds them on the next pass.
REPORT_INDEXES = """
CREATE INDEX IF NOT EXISTS staged_assets_title
 ON staged_assets(namespace, title);
CREATE INDEX IF NOT EXISTS lineage_parent
 ON lineage_edges(namespace, parent_external_id);
"""

# Pragmas for a *staging* database. ``synchronous=NORMAL`` under WAL is safe
# here for a reason that is worth stating: every record is keyed by the hash of
# its own content, so replaying a batch is a no-op. If the OS dies mid-run,
# SQLite rolls back to the last durable commit — checkpoint and rows together,
# because they share a transaction — and ``--resume`` re-reads from there.
# ``synchronous=OFF`` was measured too: 11% faster on an SSD, but it trades a
# recoverable rollback for a possibly corrupt file, and a corrupt staging
# database costs the whole multi-hour import rather than one batch.
#: Page size for a *new* staging database. A staged record carries kilobytes of
#: raw JSON, which does not fit a 4 KiB page and spills into overflow chains;
#: 8 KiB pages hold the row outright. Measured on the synthetic corpus
#: (``scripts/bench_suno_stage.py``), 50k records on a spinning disk: 4096 gave
#: 323 rec/s and a 0.52 GB file, 8192 gave 539 rec/s and a 0.67 GB file. The
#: bigger file is the cheaper one — avoiding the overflow chain is worth more
#: than the slack it costs.
PAGE_SIZE = 8192

PRAGMAS = (
    # Connection-scoped, not stored in the file, so it has to be set on every
    # open — including the resume that finds the schema already there.
    "PRAGMA foreign_keys=ON",
    "PRAGMA journal_mode=WAL",
    "PRAGMA synchronous=NORMAL",
    "PRAGMA temp_store=MEMORY",
    # 64 MiB of page cache: bounded, and independent of how many records arrive.
    # Raising it to 256 MiB was measured at +0.7% throughput for 3x the resident
    # memory, so this stays small enough to be unremarkable next to the app.
    "PRAGMA cache_size=-65536",
    # Checkpoint every ~32 MiB of WAL instead of every 4 MiB.
    "PRAGMA wal_autocheckpoint=4000",
)


class StagingDatabaseError(RuntimeError):
    """The target database is not (or is no longer) a Suno staging database."""


class IncompleteRunError(RuntimeError):
    """A previous run of this source stopped part-way and ``resume`` is off."""


class MediaPathError(ValueError):
    """A media path escapes the approved media root, or is not root-relative."""


# ---------------------------------------------------------------------------
# Sanitizing and canonical JSON
# ---------------------------------------------------------------------------


#: Memo for :func:`_is_secret_key`. A cache has on the order of a hundred
#: distinct field names repeated across every record, so this turns ~10 million
#: ``lower()``/``replace()`` pairs into ~100. Bounded so a pathological cache
#: that uses per-record keys cannot grow it without limit.
_SECRET_KEY_MEMO: dict[str, bool] = {}
_SECRET_KEY_MEMO_LIMIT = 4096

_URL_SCHEMES = ("https://", "http://")


def _is_secret_key(key: str) -> bool:
    """Whether a mapping key names authentication material."""
    cached = _SECRET_KEY_MEMO.get(key)
    if cached is not None:
        return cached
    verdict = key.lower().replace("-", "_") in SECRET_KEYS
    if len(_SECRET_KEY_MEMO) < _SECRET_KEY_MEMO_LIMIT:
        _SECRET_KEY_MEMO[key] = verdict
    return verdict


def _sanitize_url(value: str) -> str:
    """Strip userinfo and signed-query credentials from an http(s) URL.

    A URL that provably carries none of them is returned *verbatim* rather than
    re-encoded: the archive is meant to survive unchanged, and a needless
    ``urlencode`` round-trip is both a rewrite and the single most expensive
    thing this module used to do per record.

    The fast path only applies when there is no userinfo (``@``), no fragment
    (which the slow path drops), and either no query at all or a query that is
    free of percent-escapes *and* of every credential key name. Requiring the
    absence of ``%`` is what makes the substring test airtight: ``parse_qsl``
    unquotes key names, so ``%74oken=...`` is a token — but only escaping can
    hide a key name from a plain substring search.
    """
    if "@" in value or "#" in value:
        return _rewrite_url(value)
    start = value.find("?")
    if start < 0:
        return value
    query = value[start + 1 :]
    if "%" not in query:
        lowered = query.lower()
        if not any(key in lowered for key in SECRET_QUERY_KEYS):
            return value
    return _rewrite_url(value)


def _rewrite_url(value: str) -> str:
    parts = urlsplit(value)
    query = [
        (key, REDACTED if key.lower() in SECRET_QUERY_KEYS else item)
        for key, item in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit(
        (
            parts.scheme,
            parts.netloc.rsplit("@", 1)[-1],
            parts.path,
            urlencode(query),
            "",
        )
    )


def _sanitize_mapping(value: Mapping[Any, Any]) -> dict[str, Any]:
    """Sanitize a mapping. Keys are coerced to text, as canonical JSON needs."""
    cleaned: dict[str, Any] = {}
    for key, item in value.items():
        name = key if type(key) is str else str(key)
        cleaned[name] = REDACTED if _is_secret_key(name) else sanitize(item)
    return cleaned


def sanitize(value: Any) -> Any:
    """Return ``value`` with recognizable authentication material removed.

    Mapping keys that name a credential are redacted whole; signed-URL query
    credentials and URL userinfo are stripped while the rest of the URL (a
    catalog hint, not a credential) is kept. Everything else is preserved, so
    unknown provider metadata still round-trips.

    The exact-type tests come first and in frequency order because this runs
    over every value of every record: a 200k-song cache walks tens of millions
    of nodes, and ``isinstance`` against an abstract base class is several times
    the cost of ``type(value) is str``. The abstract checks are still there
    underneath, so a provider object that is a ``Mapping`` without being a
    ``dict`` is treated exactly as before.
    """
    kind = type(value)
    if kind is str:
        return _sanitize_url(value) if value.startswith(_URL_SCHEMES) else value
    if kind is dict:
        return _sanitize_mapping(value)
    if kind is list:
        return [sanitize(item) for item in value]
    if kind is int or kind is float or kind is bool or value is None:
        return value
    if isinstance(value, Mapping):
        return _sanitize_mapping(value)
    if isinstance(value, (list, tuple)):
        return [sanitize(item) for item in value]
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, str) and value.startswith(_URL_SCHEMES):
        return _sanitize_url(value)
    return value


def canonical_json(value: Any) -> str:
    """Stable JSON for hashing and storage. Unicode is kept as Unicode."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def content_hash(raw_json: str) -> str:
    return hashlib.sha256(raw_json.encode("utf-8")).hexdigest()


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def asset_id(namespace: str, external_id: str) -> str:
    """Stable id for ``(namespace, provider song id)``. Titles never take part."""
    return str(
        uuid.uuid5(
            uuid.NAMESPACE_URL, json.dumps([namespace, external_id], ensure_ascii=False)
        )
    )


# ---------------------------------------------------------------------------
# Normalizing one record
# ---------------------------------------------------------------------------


def _optional_text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value != "" else None


def _first_text(*values: Any) -> Optional[str]:
    for value in values:
        text = _optional_text(value)
        if text is not None:
            return text
    return None


def _positive_seconds(value: Any) -> Optional[float]:
    """A finite, strictly positive duration in seconds, or ``None`` if unknown.

    ``0`` is treated as unknown on purpose: it is the poisoned value the old
    importer wrote for every entry, and a zero-length song does not exist.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(number) or number <= 0:
        return None
    return number


def normalized_timestamp(value: Any) -> Optional[str]:
    """ISO-8601 UTC for a parseable timestamp, else ``None`` (never a guess)."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat()


def _tags(raw: Mapping[str, Any], meta: Mapping[str, Any]) -> list[str]:
    for candidate in (raw.get("tags"), meta.get("tags"), raw.get("display_tags")):
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, str) and item]
    return []


def relationship_hints(
    raw: Mapping[str, Any],
) -> Iterator[tuple[str, str, str]]:
    """Yield ``(parent external id, relation, evidence path)`` for explicit hints.

    Only fields that state a derivation are read. Nothing is inferred from
    titles, styles, personas or timing.
    """
    meta = raw.get("metadata") if isinstance(raw.get("metadata"), Mapping) else {}
    for field, relation in METADATA_RELATIONS:
        for holder, prefix in ((meta, "metadata."), (raw, "")):
            parent = holder.get(field)
            if isinstance(parent, str) and parent.strip():
                yield parent.strip(), relation, f"{prefix}{field}"
    for holder, prefix in ((meta, "metadata."), (raw, "")):
        parents = holder.get(MASHUP_FIELD)
        if isinstance(parents, list):
            for index, parent in enumerate(parents):
                if isinstance(parent, str) and parent.strip():
                    yield (
                        parent.strip(),
                        "mashup_source",
                        f"{prefix}{MASHUP_FIELD}[{index}]",
                    )
    ancestry = raw.get("ancestry") if isinstance(raw.get("ancestry"), Mapping) else {}
    parent = ancestry.get("parent_id")
    if isinstance(parent, str) and parent.strip():
        yield parent.strip(), "derived_from", "ancestry.parent_id"
    parents = ancestry.get("parent_ids")
    if isinstance(parents, list):
        for index, value in enumerate(parents):
            parent = value if isinstance(value, str) else None
            if isinstance(value, Mapping):
                candidate = value.get("parent_id") or value.get("clip_id")
                parent = candidate if isinstance(candidate, str) else None
            if parent and parent.strip():
                yield (
                    parent.strip(),
                    "derived_from",
                    f"ancestry.parent_ids[{index}]",
                )


@dataclass(frozen=True)
class StagedRecord:
    """One cache record, sanitized and normalized. ``raw`` keeps everything."""

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
    raw: Mapping[str, Any]
    raw_json: str
    content_hash: str
    edges: tuple[tuple[str, str, str], ...]
    #: ``tags``/``image_urls`` as the canonical JSON the columns store. Built
    #: once here so a bulk load never re-serializes the same values per record.
    tags_json: str
    image_urls_json: str


def normalize_record(raw: Any, namespace: str = "suno") -> StagedRecord:
    """Sanitize and normalize one cache record.

    Raises ``ValueError`` when the record cannot be identified — those rows are
    quarantined by the caller, never silently dropped.
    """
    if not isinstance(raw, Mapping):
        raise ValueError("Record is not a JSON object")
    clean = sanitize(dict(raw))
    external = clean.get("id")
    if not isinstance(external, str) or not external.strip():
        raise ValueError("Record has no stable provider id; title matching is refused")
    external_id = external.strip()
    meta = clean.get("metadata") if isinstance(clean.get("metadata"), Mapping) else {}
    raw_json = canonical_json(clean)
    images = tuple(
        (field, clean[field])
        for field in IMAGE_FIELDS
        if isinstance(clean.get(field), str) and clean[field]
    )
    edges = tuple(
        (parent, relation, evidence)
        for parent, relation, evidence in relationship_hints(clean)
        if parent != external_id
    )
    tags = tuple(_tags(clean, meta))
    return StagedRecord(
        id=asset_id(namespace, external_id),
        namespace=namespace,
        external_id=external_id,
        title=clean["title"] if isinstance(clean.get("title"), str) else "",
        created_at=normalized_timestamp(clean.get("created_at")),
        duration=_positive_seconds(
            meta.get("duration")
            if meta.get("duration") is not None
            else clean.get("duration", clean.get("duration_seconds"))
        ),
        lyrics=_first_text(
            meta.get("lyrics"), clean.get("lyrics"), clean.get("lyrics_prompt")
        ),
        prompt=_first_text(
            meta.get("description"), meta.get("prompt"), clean.get("prompt")
        ),
        style=_first_text(meta.get("style"), clean.get("style")),
        tags=tags,
        model_name=_first_text(
            clean.get("model_name"),
            clean.get("model"),
            meta.get("model_name"),
            meta.get("model"),
        ),
        audio_url=_optional_text(clean.get("audio_url")),
        image_urls=images,
        status=_optional_text(clean.get("status")),
        raw=clean,
        raw_json=raw_json,
        content_hash=content_hash(raw_json),
        edges=edges,
        tags_json=canonical_json(list(tags)),
        image_urls_json=canonical_json(dict(images)),
    )


# ---------------------------------------------------------------------------
# Media: reference in place (plan decision D2)
# ---------------------------------------------------------------------------


def resolve_media_path(root: Path, relative: str) -> Path:
    """Resolve a root-relative media path inside ``root``.

    The path may legitimately not exist yet (the caller records that as
    ``local-unverified``). Absolute paths, drive-relative paths, ``..`` segments
    and symlink escapes are refused with ``MediaPathError`` — a refused path
    never costs the song, only the media reference.
    """
    if not isinstance(relative, str) or not relative.strip():
        raise MediaPathError("Media path must be a non-empty root-relative string")
    candidate = Path(relative)
    if candidate.is_absolute() or candidate.drive or ".." in candidate.parts:
        raise MediaPathError(
            f"Only root-relative paths without '..' accepted: {relative}"
        )
    base = root.resolve()
    resolved = (base / candidate).resolve()
    if not resolved.is_relative_to(base):
        raise MediaPathError(f"Media path escapes the media root: {relative}")
    return resolved


def _verified(path: Path) -> tuple[bool, Optional[int]]:
    """``(is a usable local file, size in bytes)``. Nothing is opened for read.

    One ``stat`` answers both questions; the regular-file test reads the mode
    that call already returned instead of paying for a second syscall.
    """
    try:
        info = os.stat(path)
    except OSError:
        return False, None
    if not stat_module.S_ISREG(info.st_mode):
        return False, None
    return info.st_size > 0, info.st_size


class MediaIndex:
    """Provider-id → local file index over one approved media root.

    Built in a single walk so a 180k-song import stays linear. Keys are provider
    ids only: a filename that *is* an id, or that embeds a UUID-shaped id.
    Titles are never keys, so two songs sharing a title can never cross-match.

    Paths are held as plain strings and only turned back into ``Path`` objects
    for the few records that actually match, and ``resolve()`` — a syscall per
    file — is paid only for entries the directory listing already says are
    symlinks. Over a 200k-file root that is the difference between a few hundred
    megabytes of ``Path`` objects and a few tens of megabytes of strings.
    Traversal order is still directory-sorted then name-sorted, so which file
    wins a key collision does not depend on the filesystem's iteration order.
    """

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self._audio: dict[str, str] = {}
        self._artwork: dict[str, str] = {}
        self._build()

    def __len__(self) -> int:
        """Indexed keys, audio and artwork together (memory/coverage sanity)."""
        return len(self._audio) + len(self._artwork)

    def _build(self) -> None:
        root_text = str(self.root)
        pending = [root_text]
        while pending:
            directory = pending.pop()
            try:
                with os.scandir(directory) as entries:
                    listing = sorted(entries, key=lambda entry: entry.name)
            except OSError:
                continue
            subdirectories: list[str] = []
            for entry in listing:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        subdirectories.append(entry.path)
                        continue
                    self._add(entry)
                except OSError:
                    continue
            # Reversed, because the stack pops from the end: the shallowest
            # directory is still visited before its sorted children.
            pending.extend(reversed(subdirectories))

    def _add(self, entry: os.DirEntry[str]) -> None:
        name = entry.name
        dot = name.rfind(".")
        if dot <= 0:
            return
        suffix = name[dot:].lower()
        if suffix in AUDIO_SUFFIXES:
            table = self._audio
        elif suffix in ARTWORK_SUFFIXES:
            table = self._artwork
        else:
            return
        target = entry.path
        if entry.is_symlink():
            if entry.is_dir():
                return
            try:
                target = str(Path(target).resolve())
            except OSError:
                return
            if not Path(target).is_relative_to(self.root):
                log.warning("Skipping media symlink escaping the root: %s", entry.path)
                return
        stem = name[:dot].lower()
        table.setdefault(stem, target)
        for match in _UUID_RE.finditer(stem):
            table.setdefault(match.group(0), target)

    def audio_for(self, external_id: str) -> Optional[Path]:
        found = self._audio.get(external_id.lower())
        return None if found is None else Path(found)

    def artwork_for(self, external_id: str) -> Optional[Path]:
        found = self._artwork.get(external_id.lower())
        return None if found is None else Path(found)


@dataclass(frozen=True)
class MediaReference:
    kind: str
    path: Path
    state: str
    matched_by: str
    size: Optional[int]


def _media_for(
    record: StagedRecord,
    media_root: Optional[Path],
    index: Optional[MediaIndex],
) -> tuple[list[MediaReference], list[tuple[str, str, str]]]:
    """Resolve local media for one record. Returns ``(references, rejections)``.

    Nothing is copied, opened for read, or modified: only ``stat`` is used.
    """
    if media_root is None or index is None:
        return [], []
    references: list[MediaReference] = []
    rejections: list[tuple[str, str, str]] = []
    claimed: set[str] = set()
    for field, kind in MANIFEST_MEDIA_FIELDS:
        declared = record.raw.get(field)
        if declared is None:
            continue
        try:
            path = resolve_media_path(media_root, declared)
        except MediaPathError as exc:
            rejections.append((field, str(declared), str(exc)))
            continue
        ok, size = _verified(path)
        references.append(
            MediaReference(
                kind, path, "verified" if ok else "unverified", "manifest", size
            )
        )
        claimed.add(kind)
    for kind, found in (
        ("audio", index.audio_for(record.external_id)),
        ("artwork", index.artwork_for(record.external_id)),
    ):
        if kind in claimed or found is None:
            continue
        ok, size = _verified(found)
        if ok:
            references.append(MediaReference(kind, found, "verified", "id-match", size))
    return references, rejections


def _availability(record: StagedRecord, references: list[MediaReference]) -> str:
    audio = [reference for reference in references if reference.kind == "audio"]
    if any(reference.state == "verified" for reference in audio):
        return "local-verified"
    if audio:
        return "local-unverified"
    return "remote-only" if record.audio_url else "missing"


# ---------------------------------------------------------------------------
# Streaming the source
# ---------------------------------------------------------------------------


def is_jsonl(path: Path) -> bool:
    return path.suffix.lower() in {".jsonl", ".ndjson"}


def load_ijson() -> tuple[Any, str]:
    """Return ``(module, backend name)`` for the fastest available ijson.

    ijson ships several parsers behind one API and the one you get from a plain
    ``import ijson`` depends on how it was built; the C backend is roughly an
    order of magnitude faster than the pure-Python one on a multi-gigabyte
    cache, so the choice is made explicitly here and named in the run report.
    Nothing is installed: when ijson is absent the caller is told the command.
    ijson's own ``IJSON_BACKEND`` environment variable still wins, so someone
    who pinned a backend on purpose is not quietly overruled.
    """
    if importlib.util.find_spec("ijson") is None:
        raise RuntimeError(IJSON_MISSING_MESSAGE.format(name="a non-JSONL cache"))
    pinned = os.environ.get("IJSON_BACKEND", "").strip()
    for name in (pinned, *IJSON_BACKENDS) if pinned else IJSON_BACKENDS:
        try:
            module = importlib.import_module(f"ijson.backends.{name}")
        except ImportError:
            continue
        return module, name
    module = importlib.import_module("ijson")
    return module, str(getattr(module, "backend", "unknown"))


def parser_name(path: Path) -> str:
    """How ``path`` will be streamed, for the run report. Never raises."""
    if is_jsonl(path):
        return "jsonl"
    try:
        _module, backend = load_ijson()
    except RuntimeError:
        return "ijson:unavailable"
    return f"ijson:{backend}"


def iter_records(
    path: Path, json_prefix: str = DEFAULT_JSON_PREFIX
) -> Iterator[tuple[int, Any]]:
    """Yield ``(ordinal, record)`` without ever holding the corpus in memory.

    JSONL/NDJSON is standard library only; ordinals count source lines so a
    checkpoint stays exact across blank lines. A big ``{"songs": [...]}`` JSON
    needs ``ijson``, which this project does not depend on — rather than
    installing anything, the caller is told the exact command to run.
    """
    if is_jsonl(path):
        with path.open("r", encoding="utf-8-sig") as handle:
            for ordinal, line in enumerate(handle, 1):
                if line.strip():
                    yield ordinal, line.rstrip("\n")
        return
    try:
        ijson, _backend = load_ijson()
    except RuntimeError as exc:
        raise RuntimeError(IJSON_MISSING_MESSAGE.format(name=path.name)) from exc
    with path.open("rb") as handle:
        for ordinal, value in enumerate(
            ijson.items(handle, json_prefix, use_float=True), 1
        ):
            yield ordinal, value


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StageProgress:
    """Live counters handed to ``on_commit`` after every committed batch.

    The same numbers the CLI prints, so the future import wizard can render a
    progress bar without re-deriving anything. ``total`` is only set when the
    caller already knows how many records the source holds — counting them
    would mean a second full read of a multi-gigabyte file — and ``eta_seconds``
    is ``None`` whenever it is not known, never a guess.
    """

    ordinal: int
    seen: int
    accepted: int
    duplicate: int
    quarantined: int
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


@dataclass(frozen=True)
class StageReport:
    """Result of one staging run.

    ``seen``/``accepted``/``duplicate``/``quarantined`` describe *this run* over
    *this source* and must reconcile. Every other count describes the staging
    database as a whole, which is what a promotion pass needs to look at.

    Deliberately free of timings: two runs over the same source must produce
    equal reports, which is how "re-running a finished import changes nothing"
    is asserted. Wall-clock numbers belong to the caller.
    """

    run_id: str
    database: str
    status: str
    parser: str
    seen: int
    accepted: int
    duplicate: int
    quarantined: int
    distinct_identities: int
    same_title_different_id: int
    revisions: int
    media_local_verified: int
    media_local_unverified: int
    media_remote_only: int
    media_missing: int
    media_rejected: int
    unresolved_lineage: int

    @property
    def reconciles(self) -> bool:
        return self.seen == self.accepted + self.duplicate + self.quarantined

    @property
    def interrupted(self) -> bool:
        """The run stopped at a batch boundary and can be resumed as-is."""
        return self.status == "interrupted"

    @property
    def complete(self) -> bool:
        return self.status == "complete"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Staging database
# ---------------------------------------------------------------------------


def stage_db_path(stage_root: Path) -> Path:
    """The staging database for ``stage_root``. Never the production library."""
    return Path(stage_root) / DB_FILENAME


def _open_stage_db(database: Path) -> sqlite3.Connection:
    database.parent.mkdir(parents=True, exist_ok=True)
    fresh = not database.exists() or database.stat().st_size == 0
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        if fresh:
            # Only settable before the first page is written.
            connection.execute(f"PRAGMA page_size={int(PAGE_SIZE)}")
        for pragma in PRAGMAS:
            connection.execute(pragma)
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if tables and "stage_meta" not in tables:
            raise StagingDatabaseError(
                f"{database} exists and is not a Suno staging database "
                f"(tables: {sorted(tables)[:5]}). Choose a fresh --stage-root."
            )
        if tables:
            marker = connection.execute(
                "SELECT value FROM stage_meta WHERE key='staging_kind'"
            ).fetchone()
            if marker is None or marker[0] != STAGING_KIND:
                raise StagingDatabaseError(
                    f"{database} carries no {STAGING_KIND!r} marker; refusing to write."
                )
        if not STAGE_TABLES <= tables:
            connection.executescript(SCHEMA)
            connection.executemany(
                "INSERT OR IGNORE INTO stage_meta(key,value) VALUES(?,?)",
                (("staging_kind", STAGING_KIND), ("schema_version", SCHEMA_VERSION)),
            )
            connection.commit()
    except Exception:
        connection.close()
        raise
    return connection


def _summary(
    connection: sqlite3.Connection, run: sqlite3.Row, database: Path, parser: str
) -> StageReport:
    # The reporting indexes are built here, once, rather than maintained across
    # every insert of a bulk load (see REPORT_INDEXES).
    connection.executescript(REPORT_INDEXES)

    def scalar(sql: str) -> int:
        return int(connection.execute(sql).fetchone()[0])

    availability = {
        row[0]: int(row[1])
        for row in connection.execute(
            "SELECT availability, COUNT(*) FROM staged_assets GROUP BY availability"
        )
    }
    return StageReport(
        run_id=run["id"],
        database=str(database),
        status=str(run["status"]),
        parser=parser,
        seen=int(run["seen"]),
        accepted=int(run["accepted"]),
        duplicate=int(run["duplicate"]),
        quarantined=int(run["quarantined"]),
        distinct_identities=scalar("SELECT COUNT(*) FROM staged_assets"),
        # One grouped pass over the title index. The correlated EXISTS this
        # replaces asked the same question once per row: identical answer (a row
        # has a same-title twin exactly when its (namespace, title) group holds
        # more than one row), 200k index probes cheaper.
        same_title_different_id=scalar(
            "SELECT COALESCE(SUM(size),0) FROM (SELECT COUNT(*) AS size FROM"
            " staged_assets WHERE title <> '' GROUP BY namespace, title"
            " HAVING COUNT(*) > 1)"
        ),
        revisions=scalar("SELECT COUNT(*) FROM asset_revisions"),
        media_local_verified=availability.get("local-verified", 0),
        media_local_unverified=availability.get("local-unverified", 0),
        media_remote_only=availability.get("remote-only", 0),
        media_missing=availability.get("missing", 0),
        media_rejected=scalar("SELECT COUNT(*) FROM media_rejections"),
        unresolved_lineage=scalar(
            "SELECT COUNT(*) FROM lineage_edges e LEFT JOIN staged_assets a"
            " ON a.namespace = e.namespace AND a.external_id = e.parent_external_id"
            " WHERE a.id IS NULL"
        ),
    )


def _store(
    connection: sqlite3.Connection,
    record: StagedRecord,
    run_id: str,
    ordinal: int,
    media_root: Optional[Path],
    index: Optional[MediaIndex],
) -> bool:
    """Store one record. Returns ``True`` when it was new content.

    The asset row is the *first* observation and is never overwritten; later
    content for the same id is kept as an additional revision candidate.

    Four SQL statements became two for the overwhelmingly common case (an id
    never seen before), which over 200k records is several hundred thousand
    fewer round trips:

    * ``INSERT OR IGNORE`` into ``staged_assets`` both asks "is this id known?"
      and inserts it, and ``rowcount`` says which happened. The id is derived
      from ``(namespace, external_id)``, so the primary key and the uniqueness
      constraint can only ever fire together, and the media rows are still
      written only for the first observation.
    * the revision number is computed inside the revision insert instead of by
      reading ``revision_count`` back first, and ``revision_count`` is only
      written again when a *second* version of an id turns up.
    """
    references, rejections = _media_for(record, media_root, index)
    inserted = connection.execute(
        "INSERT OR IGNORE INTO staged_assets"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            record.id,
            record.namespace,
            record.external_id,
            record.title,
            record.created_at,
            record.duration,
            record.lyrics,
            record.prompt,
            record.style,
            record.tags_json,
            record.model_name,
            record.audio_url,
            record.image_urls_json,
            record.status,
            _availability(record, references),
            record.content_hash,
            1,
            run_id,
        ),
    ).rowcount
    if inserted:
        if references:
            connection.executemany(
                "INSERT OR IGNORE INTO staged_media VALUES(?,?,?,?,?,?)",
                [
                    (
                        record.id,
                        reference.kind,
                        str(reference.path),
                        reference.state,
                        reference.matched_by,
                        reference.size,
                    )
                    for reference in references
                ],
            )
        if rejections:
            connection.executemany(
                "INSERT OR IGNORE INTO media_rejections VALUES(?,?,?,?)",
                [
                    (record.id, field, value, reason)
                    for field, value, reason in rejections
                ],
            )
        connection.execute(
            "INSERT INTO asset_revisions VALUES(?,?,?,?,?,?)",
            (record.id, record.content_hash, 1, record.raw_json, run_id, ordinal),
        )
    else:
        stored = connection.execute(
            "INSERT OR IGNORE INTO asset_revisions VALUES(?,?,(SELECT"
            " COALESCE(MAX(revision),0)+1 FROM asset_revisions WHERE asset_id=?),"
            "?,?,?)",
            (
                record.id,
                record.content_hash,
                record.id,
                record.raw_json,
                run_id,
                ordinal,
            ),
        ).rowcount
        if not stored:
            return False
        connection.execute(
            "UPDATE staged_assets SET revision_count=revision_count+1 WHERE id=?",
            (record.id,),
        )
    if record.edges:
        connection.executemany(
            "INSERT OR IGNORE INTO lineage_edges VALUES(?,?,?,?,?,?)",
            [
                (
                    record.namespace,
                    record.external_id,
                    parent,
                    relation,
                    evidence,
                    record.content_hash,
                )
                for parent, relation, evidence in record.edges
            ],
        )
    return True


def stage_cache(
    source: Path,
    stage_root: Path,
    *,
    namespace: str = "suno",
    media_root: Optional[Path] = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    json_prefix: str = DEFAULT_JSON_PREFIX,
    resume: bool = True,
    on_commit: Optional[Callable[[StageProgress], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    total_records: Optional[int] = None,
) -> StageReport:
    """Stage one cache file into ``stage_root`` and return a reconciled report.

    ``source`` is only ever read. ``media_root``, when given, is only ever
    ``stat``-ed. Re-running a finished import is a no-op that returns the same
    report; an interrupted import continues from its last committed record.

    ``on_commit`` receives a :class:`StageProgress` after every committed batch:
    the same counters the CLI prints and the import wizard will draw.

    ``should_stop`` is polled once per committed batch. Returning ``True``
    finishes that batch — it is already committed — and returns a report whose
    ``status`` is ``"interrupted"``, leaving a checkpoint ``resume`` continues
    from. A ``KeyboardInterrupt`` raised *inside* a batch is caught as well: the
    part-built batch is rolled back so the database can never hold an asset
    without its revision, and the checkpoint stays at the last committed record.

    ``total_records`` is only used to offer an ETA; nothing counts the source
    for you, because that would mean reading a multi-gigabyte file twice.
    """
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")
    source = Path(source).resolve(strict=True)
    database = stage_db_path(stage_root).resolve()
    if source == database:
        raise ValueError("The staging database cannot be the source cache file")
    index = MediaIndex(Path(media_root)) if media_root is not None else None
    root = Path(media_root).resolve() if media_root is not None else None
    parser = parser_name(source)

    initial = source.stat()
    fingerprint = digest_file(source)
    run_id = hashlib.sha256(
        f"{namespace}:{fingerprint}:{json_prefix}".encode("utf-8")
    ).hexdigest()

    with closing(_open_stage_db(database)) as connection:
        connection.execute(
            "INSERT OR IGNORE INTO import_runs(id,source_path,source_sha256,namespace,"
            "status,started_at) VALUES(?,?,?,?,?,?)",
            (
                run_id,
                str(source),
                fingerprint,
                namespace,
                "staging",
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        connection.commit()
        run = connection.execute(
            "SELECT * FROM import_runs WHERE id=?", (run_id,)
        ).fetchone()
        if run["status"] == "complete":
            return _summary(connection, run, database, parser)
        checkpoint = int(run["checkpoint"])
        if checkpoint > 0 and not resume:
            raise IncompleteRunError(
                f"Run {run_id[:12]} stopped at record {checkpoint} "
                f"({run['status']}). Re-run with --resume to continue it."
            )
        counts = {
            "seen": int(run["seen"]),
            "accepted": int(run["accepted"]),
            "duplicate": int(run["duplicate"]),
            "quarantined": int(run["quarantined"]),
        }
        connection.execute(
            "UPDATE import_runs SET status='staging', error=NULL WHERE id=?", (run_id,)
        )
        connection.commit()

        # The counters and ordinal as of the last COMMIT. A rolled-back batch
        # has to take the in-memory counters back with it, or a resumed run
        # would double-count the records the rollback threw away.
        committed = dict(counts)
        committed_ordinal = checkpoint
        started = time.monotonic()

        def persist(ordinal: int, status: Optional[str] = None) -> None:
            nonlocal committed_ordinal
            connection.execute(
                "UPDATE import_runs SET checkpoint=?, seen=?, accepted=?, duplicate=?,"
                " quarantined=?, status=COALESCE(?, status) WHERE id=?",
                (
                    ordinal,
                    counts["seen"],
                    counts["accepted"],
                    counts["duplicate"],
                    counts["quarantined"],
                    status,
                    run_id,
                ),
            )
            connection.commit()
            committed.update(counts)
            committed_ordinal = ordinal

        def announce(ordinal: int) -> None:
            if on_commit is None:
                return
            on_commit(
                StageProgress(
                    ordinal=ordinal,
                    seen=counts["seen"],
                    accepted=counts["accepted"],
                    duplicate=counts["duplicate"],
                    quarantined=counts["quarantined"],
                    elapsed_seconds=time.monotonic() - started,
                    total=total_records,
                )
            )

        pending = 0
        last_ordinal = checkpoint
        stopped = False
        try:
            for ordinal, value in iter_records(source, json_prefix):
                if ordinal <= checkpoint:
                    continue
                last_ordinal = ordinal
                counts["seen"] += 1
                try:
                    parsed = json.loads(value) if isinstance(value, str) else value
                    record = normalize_record(parsed, namespace)
                except (ValueError, TypeError, OverflowError) as exc:
                    connection.execute(
                        "INSERT OR REPLACE INTO quarantine VALUES(?,?,?,?)",
                        (
                            run_id,
                            ordinal,
                            f"{type(exc).__name__}: {exc}",
                            value
                            if isinstance(value, str)
                            else canonical_json(sanitize(value)),
                        ),
                    )
                    counts["quarantined"] += 1
                else:
                    if _store(connection, record, run_id, ordinal, root, index):
                        counts["accepted"] += 1
                    else:
                        counts["duplicate"] += 1
                pending += 1
                if pending >= batch_size:
                    persist(ordinal)
                    pending = 0
                    announce(ordinal)
                    if should_stop is not None and should_stop():
                        stopped = True
                        break
            if stopped:
                persist(committed_ordinal, "interrupted")
            else:
                final = source.stat()
                if (initial.st_size, initial.st_mtime_ns) != (
                    final.st_size,
                    final.st_mtime_ns,
                ):
                    raise RuntimeError(
                        "The source cache changed while it was being staged. Stage a "
                        "frozen snapshot instead."
                    )
                if last_ordinal == 0:
                    raise RuntimeError(
                        f"No records found in {source.name}. For a non-JSONL cache "
                        f"check --json-prefix (currently {json_prefix!r}); an empty "
                        "import is never marked complete."
                    )
                persist(last_ordinal, "complete")
                if pending:
                    announce(last_ordinal)
        except KeyboardInterrupt:
            # Ctrl+C inside a batch: throw away the half-built batch rather than
            # commit an asset whose revision row never made it, then record a
            # checkpoint at the last record that *is* durable.
            connection.rollback()
            counts.update(committed)
            persist(committed_ordinal, "interrupted")
            log.warning(
                "Interrupted at record %s; re-run with resume to continue.",
                committed_ordinal,
            )
        except Exception as exc:
            connection.rollback()
            connection.execute(
                "UPDATE import_runs SET status='failed', error=? WHERE id=?",
                (str(exc), run_id),
            )
            connection.commit()
            raise
        run = connection.execute(
            "SELECT * FROM import_runs WHERE id=?", (run_id,)
        ).fetchone()
        return _summary(connection, run, database, parser)


# ---------------------------------------------------------------------------
# Promotion receipts (read and written by ``suno_promote``)
# ---------------------------------------------------------------------------
#
# A promotion writes the library (a different SQLite file plus the entry
# folders) and then records, here, what it did with each staged asset. The two
# stores cannot share a transaction, so the receipt is written strictly AFTER
# the library batch it describes and the promoter reconciles on resume: an
# asset with no receipt whose library entry already carries the same revision
# hash was written by the interrupted run, and is recorded as such instead of
# being created a second time.
#
# The table lives here because this module owns the staging schema; it is
# additive and no staging-time code path reads or writes it.

PROMOTIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS promotions(
 asset_id TEXT PRIMARY KEY,
 content_hash TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 outcome TEXT NOT NULL,
 at TEXT NOT NULL);
"""

#: Outcomes a receipt can carry. A failure is deliberately NOT one of them:
#: an asset that could not be promoted stays unreceipted so the next run
#: retries it.
PROMOTION_OUTCOMES = frozenset({"created", "updated", "unchanged", "deferred_no_media"})


def ensure_promotions(connection: sqlite3.Connection) -> None:
    """Create the receipt table if it is not there yet."""
    connection.executescript(PROMOTIONS_SCHEMA)
    connection.commit()


def open_promotion_db(
    stage_root: Path, *, read_only: bool = False
) -> sqlite3.Connection:
    """Open ``stage_root``'s staging database for a promotion pass.

    ``read_only=True`` opens the file through a ``mode=ro`` URI, so a dry run
    cannot write the staging database even by accident, and a missing
    ``promotions`` table is left missing rather than created.
    """
    database = stage_db_path(stage_root)
    if read_only:
        if not database.is_file():
            raise StagingDatabaseError(f"No staging database at {database}")
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            marker = connection.execute(
                "SELECT value FROM stage_meta WHERE key='staging_kind'"
            ).fetchone()
        except sqlite3.Error as exc:
            connection.close()
            raise StagingDatabaseError(
                f"{database} is not readable as a staging database: {exc}"
            ) from exc
        if marker is None or marker[0] != STAGING_KIND:
            connection.close()
            raise StagingDatabaseError(
                f"{database} carries no {STAGING_KIND!r} marker; refusing to read it as one."
            )
        return connection
    if not database.is_file():
        raise StagingDatabaseError(f"No staging database at {database}")
    connection = _open_stage_db(database)
    try:
        ensure_promotions(connection)
    except Exception:
        connection.close()
        raise
    return connection


def promotion_receipts(
    connection: sqlite3.Connection, asset_ids: Sequence[str]
) -> dict[str, tuple[str, str]]:
    """``asset id -> (revision content hash, outcome)`` for the ids that have one.

    Tolerates a missing table, which is what a dry run against a never-promoted
    staging database sees.
    """
    if not asset_ids:
        return {}
    found: dict[str, tuple[str, str]] = {}
    try:
        for start in range(0, len(asset_ids), _RECEIPT_QUERY_CHUNK):
            chunk = asset_ids[start : start + _RECEIPT_QUERY_CHUNK]
            marks = ",".join("?" * len(chunk))
            for row in connection.execute(
                f"SELECT asset_id, content_hash, outcome FROM promotions"
                f" WHERE asset_id IN ({marks})",
                list(chunk),
            ):
                found[str(row[0])] = (str(row[1]), str(row[2]))
    except sqlite3.OperationalError:
        return {}
    return found


def record_promotions(
    connection: sqlite3.Connection, rows: Sequence[tuple[str, str, str, str]]
) -> None:
    """Commit receipts for one promoted batch: ``(asset id, hash, entry id, outcome)``."""
    if not rows:
        return
    stamped = datetime.now(timezone.utc).isoformat()
    connection.executemany(
        "INSERT INTO promotions(asset_id,content_hash,entry_id,outcome,at)"
        " VALUES(?,?,?,?,?)"
        " ON CONFLICT(asset_id) DO UPDATE SET content_hash=excluded.content_hash,"
        " entry_id=excluded.entry_id, outcome=excluded.outcome, at=excluded.at",
        [
            (asset_id, digest, entry_id, outcome, stamped)
            for asset_id, digest, entry_id, outcome in rows
        ],
    )
    connection.commit()


#: SQLite's default parameter ceiling is 999; stay well inside it.
_RECEIPT_QUERY_CHUNK = 900
