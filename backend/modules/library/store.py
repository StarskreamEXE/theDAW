"""Filesystem-backed library store.

Layout under the library root (default: `<project>/data/generations/`,
overridable via `theDAW_GENERATIONS_DIR`):

    <library_root>/
        <entry_id>/
            metadata.json     # entry record (see ENTRY_FIELDS below)
            <audio_filename>  # the audio file
            [spectrogram_*.png ...]   # optional, written by the generate flow

For generate outputs `entry_id = "{job_id}_{index:02d}"`. For imports we
mint a UUID. The `metadata.json` is the source of truth — any user-mutable
field (favorite, rating, tags, notes, lyrics) is merged in there.

This module is intentionally storage-only: it does NOT depend on FastAPI
so it can be reused by an eventual `S3Provider` / `DriveProvider` that
swaps the filesystem operations for cloud APIs.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Optional

from .db import (
    DEFAULT_DELETE_BATCH,
    DEFAULT_SORT,
    EntryFilters,
    LibraryDB,
    derived_provider_wire,
)
from .provider import curated_fields, detect_provider, provider_wire_fields
from backend.lib import paths

log = logging.getLogger(__name__)

#: How many failures one bulk import reports back. The list is for a human
#: reading a progress panel, not a log; a folder of 200,000 files with a bad
#: drive would otherwise return 200,000 strings.
MAX_IMPORT_ERRORS = 50

#: Ceiling on how many new/changed entries a single :meth:`LibraryStore.reindex`
#: call may enqueue for background analysis. Above this, NONE are enqueued --
#: the user's rule is never to mass re-analyze, and a lost or empty DB next to
#: an existing 200,000-entry library would otherwise queue the whole thing the
#: moment analysis is enabled once. This is also :meth:`reindex`'s default
#: ``max_enqueue``, so a bare, uncapped call cannot happen by accident; the
#: `/reindex` route imports this constant rather than defining its own.
MAX_REINDEX_ANALYSIS_ENQUEUE = 500


# Fields a frontend client is allowed to modify on an entry. Everything
# else in metadata.json is owned by the backend (filenames, paths,
# timestamps, the generation params we recorded at save time).
# `chimera_sources` is included because the backend doesn't know about
# the user-facing Chimera stack labels at generation time — the frontend
# PATCHes them after the mashup runs.
# `lyrics` is the plain (untimed) lyrics text: the user's own words, edited
# from the Details / SING surfaces. The lyrics module mirrors the text of
# `<entry>/lyrics.json` into it on every save, so it never diverges from
# the timed document. Suno imports already carry it via `_flatten_suno_meta`.
# `notation_artist` / `notation_title` are the DETAILS identity form's manual
# overrides for the notation engine's artist/title guess (see
# frontend/src/components/layout/DetailsView.tsx, `saveIdentity`) — the notation
# routes (T08) and identity resolver (T09) read these off metadata.json.
USER_MUTABLE_FIELDS: frozenset[str] = frozenset(
    {
        "favorite",
        "rating",
        "tags",
        "notes",
        "title",
        "chimera_sources",
        "lyrics",
        "notation_artist",
        "notation_title",
    }
)


@dataclass
class LibraryRecord:
    """Public-facing entry record. Mirrors the frontend `LibraryEntry` interface
    minus the inline `audioBlob` — clients fetch the audio via the
    `audio_url` field instead."""

    id: str
    title: str
    prompt: str
    negative_prompt: str
    model: str
    duration: float
    steps: int
    cfg: float
    seed: int
    audio_url: str
    audio_filename: str
    mime_type: str
    file_size_bytes: int
    timestamp: str
    favorite: bool
    rating: Optional[str]
    tags: list[str]
    notes: str
    source: str
    chimera_sources: list[str] = field(default_factory=list)
    # Plain lyrics text (see USER_MUTABLE_FIELDS). '' when the entry has none.
    lyrics: str = ""
    # Optional pointers to extra artifacts on disk.
    spectrogram_paths: dict[str, Optional[str]] = field(default_factory=dict)
    # Media (video / image) entries. 'audio' keeps the original contract;
    # 'video' / 'image' carry a stream URL, a poster thumbnail, pixel
    # dimensions, and an alpha flag (overlay-capable when True).
    kind: str = "audio"
    media_url: Optional[str] = None
    thumb_url: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    has_alpha: bool = False
    # Album/track artwork for an audio entry, extracted from the file's
    # embedded picture at import. None when the track has none, so the UI
    # can draw its placeholder without probing the route for a 404.
    cover_url: Optional[str] = None
    # Where the track came from -- Suno, Bandcamp, a DAW nobody recognises --
    # as decided by `provider.py` from what the file itself carried. All four
    # are None for a track whose origin nothing says, which is the normal case
    # for the user's own renders. `source` is a DIFFERENT axis and is
    # unchanged: it stays generate / studio / import.
    provider: Optional[str] = None
    provider_label: Optional[str] = None
    provider_is_ai: Optional[bool] = None
    provider_id: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "prompt": self.prompt,
            "negative_prompt": self.negative_prompt,
            "model": self.model,
            "duration": self.duration,
            "steps": self.steps,
            "cfg": self.cfg,
            "seed": self.seed,
            "audio_url": self.audio_url,
            "audio_filename": self.audio_filename,
            "mime_type": self.mime_type,
            "file_size_bytes": self.file_size_bytes,
            "timestamp": self.timestamp,
            "favorite": self.favorite,
            "rating": self.rating,
            "tags": list(self.tags),
            "notes": self.notes,
            "source": self.source,
            "chimera_sources": list(self.chimera_sources),
            "lyrics": self.lyrics,
            "spectrogram_paths": dict(self.spectrogram_paths),
            "kind": self.kind,
            "media_url": self.media_url,
            "thumb_url": self.thumb_url,
            "width": self.width,
            "height": self.height,
            "has_alpha": self.has_alpha,
            "cover_url": self.cover_url,
            "provider": self.provider,
            "provider_label": self.provider_label,
            "provider_is_ai": self.provider_is_ai,
            "provider_id": self.provider_id,
        }


def default_library_root() -> Path:
    """Resolve the library root path. ``theDAW_GENERATIONS_DIR`` wins;
    otherwise it lives alongside the existing generate artifacts, under the
    writable data root (which is NOT the install directory when that is
    read-only — see backend.lib.paths)."""
    return paths.library_root()


def _audio_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/audio/{entry_id}"


def _media_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/media/{entry_id}"


def _thumb_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/media/{entry_id}/thumb"


# Normalised cover art for an audio entry. One fixed name, chosen by us: the
# filename and MIME string embedded next to the picture are attacker-supplied
# and never reach the filesystem.
COVER_FILENAME = "cover.jpg"


def _cover_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/audio/{entry_id}/cover"


def _cover_url_if_present(
    entry_dir: Path, api_prefix: str, entry_id: str
) -> Optional[str]:
    """The cover URL when the entry has artwork on disk, else None — one stat,
    mirroring how the media poster is surfaced.

    The URL carries the cover's mtime, so refreshing an entry's art produces a
    NEW url. Without it a re-read would write different bytes behind an
    unchanged ``src`` and every browser on screen would keep showing the old
    picture out of its cache.
    """
    try:
        stamp = int((entry_dir / COVER_FILENAME).stat().st_mtime * 1000)
    except OSError:
        return None
    return f"{_cover_url_for(api_prefix, entry_id)}?v={stamp}"


def extract_cover_for(entry_dir: Path, audio_path: Path) -> bool:
    """Pull the front cover out of ``audio_path`` into ``entry_dir``.

    Best-effort by design: a track with no picture is the normal case, and a
    corrupt or absurd one must never fail an import. Returns True only when a
    normalised cover was written.
    """
    from .tags import extract_embedded_cover, write_cover_image

    data = extract_embedded_cover(audio_path)
    if not data:
        return False
    return write_cover_image(data, entry_dir / COVER_FILENAME)


_MEDIA_EXTS = {
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".m4v",
    ".avi",
    ".ogv",
    ".png",
    ".webp",
    ".gif",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".avif",
    ".apng",
}


def _resolve_media_file(entry_dir: Path, meta: dict[str, Any]) -> Optional[Path]:
    """Resolve a video/image file for a media entry: the declared name
    first, then the first recognized media file in the directory (our own
    derived images — the poster thumbnail and the cover art — are skipped)."""
    declared = meta.get("media_filename") or meta.get("filename")
    if declared:
        candidate = entry_dir / declared
        if candidate.is_file():
            return candidate
    for path in sorted(entry_dir.iterdir()):
        if path.name in ("thumb.jpg", COVER_FILENAME):
            continue
        if path.is_file() and path.suffix.lower() in _MEDIA_EXTS:
            return path
    return None


def _metadata_path(entry_dir: Path) -> Path:
    return entry_dir / "metadata.json"


def _is_entry_dir(path: Path) -> bool:
    """Whether ``path`` is an entry directory: exists, is a directory, holds a
    metadata.json. Answers False rather than raising for a name the filesystem
    will not take. ``Path.is_dir`` swallows ENOENT and friends but not
    ENAMETOOLONG, so a 4 KB id straight off the wire used to stat() its way to
    a 500 on Linux — Windows refuses the name quietly, which is why it only
    ever showed on CI. An id the disk cannot hold is not an entry.
    """
    try:
        return path.is_dir() and _metadata_path(path).is_file()
    except (OSError, ValueError):
        return False


def _read_metadata(entry_dir: Path) -> Optional[dict[str, Any]]:
    p = _metadata_path(entry_dir)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("library.store: failed to read %s: %s", p, e)
        return None


def _write_metadata(entry_dir: Path, payload: dict[str, Any]) -> None:
    p = _metadata_path(entry_dir)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(p)


# One table, because these two drifted apart: the folder importer accepted ten
# extensions while the entry resolver accepted seventeen, so a .caf or a
# 64-bit .w64 added by hand resolved fine and was invisible to folder import.
# Keyed with the dot, the way Path.suffix reports it.
AUDIO_MIME_BY_EXT: dict[str, str] = {
    ".wav": "audio/wav",
    ".wave": "audio/wav",
    ".w64": "audio/x-wav",  # Sony Wave64 — the >4GB WAV a long float session reaches for
    ".rf64": "audio/x-wav",  # RF64, the BWF-compatible answer to the same limit
    ".bwf": "audio/wav",  # Broadcast Wave: WAV plus a bext chunk
    ".caf": "audio/x-caf",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".aifc": "audio/aiff",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wma": "audio/x-ms-wma",
}

#: Every container the library will take. Derived, so it cannot fall behind
#: the mime table the way the folder importer's own copy did.
AUDIO_EXTS = frozenset(AUDIO_MIME_BY_EXT)


def _resolve_audio_file(entry_dir: Path, meta: dict[str, Any]) -> Optional[Path]:
    """Resolve the audio file for an entry. Try the metadata-declared name
    first, then any first audio file in the entry directory."""
    # Reference-in-place entry (folder -> playlist): the audio lives OUTSIDE the
    # library at source_path and is never copied in. Resolve straight to it so
    # serving, analysis, and listing all read the original file.
    source_path = meta.get("source_path")
    if source_path:
        ref = Path(source_path)
        if ref.is_file():
            return ref
    declared = meta.get("filename") or meta.get("audio_filename")
    if declared:
        candidate = entry_dir / declared
        if candidate.is_file():
            return candidate
    for path in entry_dir.iterdir():
        if path.is_file() and path.suffix.lower() in AUDIO_EXTS:
            return path
    return None


# ---- Provider labeling ------------------------------------------------------
#
# `provider.py` decides WHAT a track's provider is. The two helpers below are
# the only places the library acts on that answer, so an entry labeled at
# import and the same entry labeled while being read can never disagree.
#
# Neither one opens a file or reads another row. :func:`_apply_provider_labels`
# runs once per imported entry, over tags its caller has already read;
# :func:`_provider_wire` runs per entry on the read path, over the metadata
# that entry already carries. That is what makes labeling the existing library
# free: no backfill pass, no re-analysis, nothing re-read from disk.

#: Curated embedded fields that fill one of the entry's OWN fields when the
#: caller left it empty.
_CURATED_ENTRY_FIELDS: tuple[str, ...] = (
    "prompt",
    "negative_prompt",
    "model",
    "lyrics",
)

#: Curated embedded fields stored beside the entry under their own name.
#: `created_at`, `bpm` and `key` are deliberately absent: `created_at` is what
#: the timestamp fallback in :func:`_record_from_metadata` reads, and bpm/key
#: belong to the analysis row, which MEASURES them from the audio rather than
#: taking the file's word for it. Both remain readable in `embedded_tags`.
_CURATED_EXTRA_FIELDS: tuple[str, ...] = (
    "provider_id",
    "style",
    "model_version",
    "artist",
    "parent_id",
    "is_instrumental",
)


def _is_unset(value: Any) -> bool:
    """Whether a metadata field is absent rather than answered. ``False`` is an
    answer (an explicitly non-instrumental track), so only None and the empty
    string count as unset."""
    return value is None or value == ""


def _apply_provider_labels(
    record_meta: dict[str, Any],
    embedded: Mapping[str, Any],
    meta_in: Mapping[str, Any],
) -> None:
    """Label one entry being built from a file, in place.

    ``record_meta`` is the ``metadata.json`` about to be written, ``embedded``
    whatever the tag reader returned for the file, and ``meta_in`` the caller's
    own metadata, which wins over anything the file claims about itself.

    An empty ``embedded`` is still worth a call: the legacy markers a
    pre-existing entry carries (``source`` of "suno", a ``suno_id``, a ``suno``
    tag) live in ``record_meta``. When nothing identifies the track, NOTHING is
    written -- an unlabeled entry keeps the metadata it always had.

    Shared by every import path, so a track uploaded through ``import_blob``
    and the same track registered in place come out labeled identically.
    """
    info = detect_provider(embedded, record_meta)
    if info is None:
        return
    record_meta.update(provider_wire_fields(info))

    curated = curated_fields(embedded, info)
    for name in _CURATED_ENTRY_FIELDS:
        # The caller's explicit value wins; otherwise the curated value wins
        # over the raw frame the generic `_pick` fallback found, because the
        # curated table knows which of a provider's frames actually holds it.
        if _is_unset(curated.get(name)) or not _is_unset(meta_in.get(name)):
            continue
        record_meta[name] = curated[name]
    for name in _CURATED_EXTRA_FIELDS:
        if not _is_unset(record_meta.get(name)) or _is_unset(curated.get(name)):
            continue
        record_meta[name] = curated[name]

    # The provider is a tag too, so the existing tag filter and the search
    # index find these tracks without a new mechanism. Compared case-folded:
    # a user who already tagged the track "Suno" does not get a second one.
    tags = list(record_meta.get("tags") or [])
    if info.provider not in {str(tag).strip().lower() for tag in tags}:
        record_meta["tags"] = [*tags, info.provider]


def _provider_wire(
    meta: Mapping[str, Any], *, source: str = "", model: str = ""
) -> dict[str, Any]:
    """The four provider wire fields for one entry, from its stored row.

    Derivation only -- no file is opened, no second row is read -- so every one
    of the ~200,000 entries already in the library is labeled as it is read,
    with no migration and no backfill.

    Two steps, in the order :data:`~.db.PROVIDER_SQL` compares against, so an
    entry's label is always the slug the list filter files it under:

    1. a stored ``provider``, or the legacy Suno markers, via
       :func:`~.provider.detect_provider` -- which also knows the track's own
       provider id;
    2. failing that, :func:`~.db.infer_provider` over ``model`` / ``source``,
       the rule the catalogue has always shown these tracks under.

    ``source`` and ``model`` are the ``entries`` columns, used when
    ``metadata.json`` carries none of its own -- the column is the truth for a
    row rebuilt from the DB.
    """
    row_source = str(meta.get("source") or source or "")
    if source and not meta.get("source"):
        meta = {**meta, "source": source}
    info = detect_provider({}, meta)
    if info is not None:
        return provider_wire_fields(info)
    return derived_provider_wire(
        str(meta.get("model") or model or ""), row_source, meta.get("suno_id")
    )


def _flatten_suno_meta(meta: dict[str, Any]) -> dict[str, Any]:
    """Suno API-compatible format normalization: if metadata came from a Suno
    External API cache (has an "inferred" dict), flatten inferred fields to
    top-level so downstream field reads work. No-op on normal theDAW metadata
    (no "inferred" key exists). Shallow-copies before mutating so the caller's
    dict keeps DB fidelity."""
    inferred = meta.get("inferred")
    if not isinstance(inferred, dict):
        return meta
    meta = dict(meta)
    for k, v in inferred.items():
        if meta.get(k) is None:
            meta[k] = v

    # Pull nested Suno API metadata.metadata fields up to top-level.
    # Only runs when "inferred" was present (Suno format marker).
    api_meta = meta.get("metadata")
    if isinstance(api_meta, dict):
        if api_meta.get("lyrics") and not meta.get("lyrics"):
            meta["lyrics"] = api_meta["lyrics"]
        if api_meta.get("style") and not meta.get("style"):
            meta["style"] = api_meta["style"]
        if api_meta.get("description") and not meta.get("prompt"):
            meta["prompt"] = api_meta["description"]
    return meta


def _record_from_metadata(
    entry_dir: Path,
    meta: dict[str, Any],
    api_prefix: str,
) -> Optional[LibraryRecord]:
    """Build a LibraryRecord from a metadata.json payload. Returns None if
    the directory has no resolvable audio file AND no CDN URL fallback."""
    meta = _flatten_suno_meta(meta)

    entry_id = entry_dir.name

    # Media (video / image) entries take a separate path: they resolve a
    # media file (not audio), carry a poster thumbnail + dimensions, and
    # stream from /media/<id> rather than /audio/<id>.
    kind = str(meta.get("kind") or "audio")
    if kind in ("video", "image"):
        return _media_record_from_metadata(entry_dir, meta, api_prefix, kind)

    audio_file = _resolve_audio_file(entry_dir, meta)

    # CHANGED: allow CDN-only entries (no local audio file) when a
    # cdn_audio_url is present in metadata — used by Suno cache import.
    if audio_file is None and not meta.get("cdn_audio_url"):
        return None

    size = 0
    audio_fname = ""
    if audio_file is not None:
        try:
            size = audio_file.stat().st_size
        except OSError:
            size = 0
        audio_fname = audio_file.name
    else:
        audio_fname = meta.get("audio_filename") or f"{entry_id}.mp3"

    timestamp = meta.get("timestamp")
    if not timestamp:
        # Fall back to created_at ISO string (Suno cache format).
        created_at_str = meta.get("created_at")
        if isinstance(created_at_str, str) and created_at_str:
            timestamp = created_at_str
        else:
            # Fall back to saved_at unix seconds → ISO.
            saved_at = meta.get("saved_at")
            if isinstance(saved_at, (int, float)):
                timestamp = (
                    time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(saved_at)) + "Z"
                )
            elif audio_file is not None:
                try:
                    timestamp = (
                        time.strftime(
                            "%Y-%m-%dT%H:%M:%S", time.gmtime(audio_file.stat().st_mtime)
                        )
                        + "Z"
                    )
                except OSError:
                    timestamp = ""
            else:
                timestamp = ""

    # Older metadata used `model_name` and `cfg_scale`; the new convention is
    # `model` and `cfg`. Read both so the library list works for entries
    # written before this refactor.
    model = meta.get("model") or meta.get("model_name") or ""
    cfg_val = meta.get("cfg")
    if cfg_val is None:
        cfg_val = meta.get("cfg_scale", 0.0)

    return LibraryRecord(
        id=entry_id,
        title=str(meta.get("title") or meta.get("filename") or audio_fname),
        prompt=str(meta.get("prompt") or ""),
        negative_prompt=str(meta.get("negative_prompt") or ""),
        model=str(model),
        duration=float(meta.get("duration") or 0.0),
        steps=int(meta.get("steps") or 0),
        cfg=float(cfg_val or 0.0),
        seed=int(meta.get("seed") or 0),
        audio_url=_audio_url_for(api_prefix, entry_id),
        audio_filename=audio_fname,
        mime_type=str(meta.get("mime_type") or "audio/mpeg"),
        file_size_bytes=size,
        timestamp=timestamp,
        favorite=bool(meta.get("favorite", False)),
        rating=meta.get("rating")
        if meta.get("rating") in ("like", "dislike")
        else None,
        tags=list(meta.get("tags") or []),
        notes=str(meta.get("notes") or ""),
        source=str(meta.get("source") or "generate"),
        chimera_sources=list(meta.get("chimera_sources") or []),
        lyrics=str(meta.get("lyrics") or ""),
        spectrogram_paths=dict(meta.get("spectrogram_paths") or {}),
        cover_url=_cover_url_if_present(entry_dir, api_prefix, entry_id),
        **_provider_wire(meta),
    )


def _media_record_from_metadata(
    entry_dir: Path,
    meta: dict[str, Any],
    api_prefix: str,
    kind: str,
) -> Optional[LibraryRecord]:
    """Build a LibraryRecord for a video/image entry. Returns None when no
    media file resolves on disk."""
    entry_id = entry_dir.name
    media_file = _resolve_media_file(entry_dir, meta)
    if media_file is None:
        return None

    try:
        size = media_file.stat().st_size
    except OSError:
        size = 0

    timestamp = meta.get("timestamp")
    if not timestamp:
        saved_at = meta.get("saved_at")
        if isinstance(saved_at, (int, float)):
            timestamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(saved_at)) + "Z"
        else:
            timestamp = ""

    has_thumb = (entry_dir / "thumb.jpg").is_file()
    # audio_url points at the media stream too, so generic consumers that
    # read audio_url never hit an empty/broken URL for a media entry.
    media_url = _media_url_for(api_prefix, entry_id)

    return LibraryRecord(
        id=entry_id,
        title=str(meta.get("title") or media_file.name),
        prompt=str(meta.get("prompt") or ""),
        negative_prompt=str(meta.get("negative_prompt") or ""),
        model=str(meta.get("model") or "import"),
        duration=float(meta.get("duration") or 0.0),
        steps=0,
        cfg=0.0,
        seed=0,
        audio_url=media_url,
        audio_filename=media_file.name,
        mime_type=str(meta.get("mime_type") or ""),
        file_size_bytes=size,
        timestamp=timestamp,
        favorite=bool(meta.get("favorite", False)),
        rating=None,
        tags=list(meta.get("tags") or []),
        notes=str(meta.get("notes") or ""),
        source=str(meta.get("source") or "import"),
        chimera_sources=[],
        lyrics=str(meta.get("lyrics") or ""),
        spectrogram_paths={},
        kind=kind,
        media_url=media_url,
        thumb_url=_thumb_url_for(api_prefix, entry_id) if has_thumb else None,
        width=_int_or_none(meta.get("width")),
        height=_int_or_none(meta.get("height")),
        has_alpha=bool(meta.get("has_alpha", False)),
        **_provider_wire(meta),
    )


def _int_or_none(v: Any) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _record_from_db_row(
    row: dict[str, Any], entry_dir: Path, api_prefix: str
) -> LibraryRecord:
    """Build a record from ONE ``entries`` row plus its directory.

    The shared core of :meth:`LibraryStore.list_entries_fast` (whole table) and
    :meth:`LibraryStore.list_entries_page` (one page), so a paged list can
    never disagree with the unpaged one about what an entry looks like. Only
    the fields with no column -- tags, lyrics, mime, media dimensions -- come
    out of ``metadata_json``.
    """
    entry_id = str(row["id"])
    kind = str(row.get("kind") or "audio")
    try:
        meta = json.loads(row.get("metadata_json") or "{}")
    except (TypeError, json.JSONDecodeError):
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    meta = _flatten_suno_meta(meta)
    is_media = kind in ("video", "image")
    if is_media:
        media_url: Optional[str] = _media_url_for(api_prefix, entry_id)
        audio_url = media_url
        thumb_url = (
            _thumb_url_for(api_prefix, entry_id)
            if (entry_dir / "thumb.jpg").is_file()
            else None
        )
        cover_url: Optional[str] = None
    else:
        media_url = None
        audio_url = _audio_url_for(api_prefix, entry_id)
        thumb_url = None
        cover_url = _cover_url_if_present(entry_dir, api_prefix, entry_id)
    # mime_type must come from metadata, not the DB mime column:
    # upsert_entry coerces an empty mime to 'audio/wav', which would
    # break the walk's '' default for media and 'audio/mpeg' for audio.
    mime_default = "" if is_media else "audio/mpeg"
    return LibraryRecord(
        id=entry_id,
        title=str(row.get("title") or ""),
        prompt=str(row.get("prompt") or ""),
        negative_prompt=str(row.get("negative_prompt") or ""),
        model=str(row.get("model") or ""),
        duration=float(row.get("duration_sec") or 0.0),
        steps=int(row.get("steps") or 0),
        cfg=float(row.get("cfg") or 0.0),
        seed=int(row.get("seed") or 0),
        audio_url=audio_url,
        audio_filename=str(row.get("audio_filename") or ""),
        mime_type=str(meta.get("mime_type") or mime_default),
        file_size_bytes=int(row.get("file_size_bytes") or 0),
        timestamp=str(row.get("timestamp") or ""),
        favorite=bool(row.get("favorite")),
        rating=None if is_media else row.get("rating"),
        tags=list(meta.get("tags") or []),
        notes=str(row.get("notes") or ""),
        source=str(row.get("source") or "generate"),
        chimera_sources=[] if is_media else list(meta.get("chimera_sources") or []),
        lyrics=str(meta.get("lyrics") or ""),
        spectrogram_paths={} if is_media else dict(meta.get("spectrogram_paths") or {}),
        kind=kind,
        media_url=media_url,
        thumb_url=thumb_url,
        width=_int_or_none(meta.get("width")) if is_media else None,
        height=_int_or_none(meta.get("height")) if is_media else None,
        has_alpha=bool(meta.get("has_alpha", False)) if is_media else False,
        cover_url=cover_url,
        # The row's columns are the truth here: `source` is what a legacy Suno
        # entry was marked with and `model` is what the derivation reads.
        # metadata.json usually repeats both, but need not.
        **_provider_wire(
            meta,
            source=str(row.get("source") or ""),
            model=str(row.get("model") or ""),
        ),
    )


def _db_payload(record: LibraryRecord, meta: dict[str, Any]) -> dict[str, Any]:
    """The flattened payload ``LibraryDB.upsert_entry`` takes for one record.
    Shared by the single-record sync and the bulk import so a row written in
    bulk is indistinguishable from one written on its own."""
    return {
        "id": record.id,
        "kind": record.kind,
        "title": record.title,
        "prompt": record.prompt,
        "negative_prompt": record.negative_prompt,
        "model": record.model,
        "duration": record.duration,
        "steps": record.steps,
        "cfg": record.cfg,
        "seed": record.seed,
        "mime_type": record.mime_type,
        "audio_filename": record.audio_filename,
        "file_size_bytes": record.file_size_bytes,
        "source": record.source,
        "favorite": record.favorite,
        "rating": record.rating,
        "notes": record.notes,
        "timestamp": record.timestamp,
        "tags": list(record.tags),
        "metadata_json": meta,
    }


def _chimera_edges(entry_id: str, meta: dict[str, Any]) -> list[tuple[str, str, str]]:
    """``chimera_sources`` as directed lineage edges."""
    sources = meta.get("chimera_sources") or []
    if not isinstance(sources, list):
        return []
    return [(str(label), entry_id, "chimera_source_of") for label in sources if label]


def _reference_metadata(
    src: Path,
    entry_id: str,
    meta_in: dict[str, Any],
    *,
    embedded: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """The ``metadata.json`` for a reference-in-place entry. Shared by
    :meth:`LibraryStore.register_reference` and the bulk importer.

    ``embedded`` is the file's tags when the caller has already read them.
    The bulk importer passes none by default and MUST keep doing so: reading
    tags means opening every one of 200,000 source files, which is the same
    reason it leaves ``extract_covers`` off. Labeling still runs without them,
    from the markers ``meta_in`` carries.
    """
    # Unreachable from folder import, which filters on AUDIO_EXTS — but this
    # is public, so an unknown container gets the honest generic answer
    # rather than being labelled an MP3.
    mime = AUDIO_MIME_BY_EXT.get(src.suffix.lower(), "application/octet-stream")
    meta: dict[str, Any] = {
        "id": entry_id,
        "source_path": str(src.resolve()),
        "filename": src.name,
        "audio_filename": src.name,
        "mime_type": mime,
        "title": meta_in.get("title") or src.stem,
        "prompt": "",
        "negative_prompt": "",
        "model": "reference",
        "duration": 0.0,
        "steps": 0,
        "cfg": 0.0,
        "seed": 0,
        "favorite": False,
        "rating": None,
        "tags": list(meta_in.get("tags", [])),
        "notes": meta_in.get("notes", ""),
        "source": meta_in.get("source", "folder"),
        "chimera_sources": [],
        "saved_at": time.time(),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if embedded:
        meta["embedded_tags"] = dict(embedded)
    _apply_provider_labels(meta, embedded or {}, meta_in)
    return meta


@dataclass
class BulkDeleteResult:
    """What one batched delete did.

    ``deleted`` counts entries that are fully gone -- rows AND, where there was
    one, the library folder. ``failed`` holds ``{"id", "error"}`` for every id
    that is not, in the order they were asked for, so
    ``deleted + len(failed) == len(requested unique ids)`` always holds and a
    caller that truncates the list can still say how many it hid.
    """

    deleted: int = 0
    failed: list[dict[str, str]] = field(default_factory=list)


def _contains(root_normcase: str, candidate: Path) -> bool:
    """Whether ``candidate`` resolves to something strictly inside the library
    root.

    The guard on every ``rmtree`` this module performs in bulk. Entry ids come
    off the wire and :meth:`LibraryStore._dir_for` simply joins them onto the
    root, so an id carrying ``..`` names a directory outside the library that
    exists and holds a ``metadata.json`` -- the user's own music folder, say.
    Resolving first (which collapses ``..`` AND follows a symlink planted in
    the library) and comparing case-normalised prefixes is what makes the
    answer about the real target rather than the spelling. The root itself is
    not "inside" itself: deleting it is never what was asked for.
    """
    try:
        target = os.path.normcase(str(candidate.resolve()))
    except OSError:
        return False
    return target.startswith(root_normcase + os.sep)


@dataclass
class BulkImportResult:
    """What one batched reference-import pass did.

    ``skipped`` is files already registered (a re-run over the same folder),
    ``failed`` files that could not be registered at all. ``errors`` is capped
    at :data:`MAX_IMPORT_ERRORS` while ``failed`` keeps counting."""

    created: list[LibraryRecord] = field(default_factory=list)
    skipped: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    def note_failure(self, message: str) -> None:
        self.failed += 1
        if len(self.errors) < MAX_IMPORT_ERRORS:
            self.errors.append(message)


class ImportJob:
    """A folder import running off the request thread.

    Mutated by the worker and read by whatever polls ``GET
    /import-jobs/{id}``, so every read and write of the counters goes through
    one lock and :meth:`snapshot` hands back a consistent picture rather than
    a half-updated one. Cancellation is an ``Event``: the worker checks it
    BETWEEN batches, so a cancel never tears a transaction in half -- the
    batch in flight finishes and is kept."""

    def __init__(self, job_id: str, folder: str, *, recursive: bool = True) -> None:
        self.id = job_id
        self.folder = folder
        self.recursive = bool(recursive)
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self.status = "queued"
        self.seen = 0
        self.created = 0
        self.skipped = 0
        self.failed = 0
        self.errors: list[str] = []
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None

    def cancel(self) -> None:
        """Ask the job to stop.

        A job still QUEUED has no worker to notice the flag -- the background
        consumer may be minutes away from picking it up -- so it is settled
        here and :meth:`LibraryStore.run_import_job` short-circuits when it
        eventually runs. A RUNNING job keeps its status until the worker
        reaches the next batch boundary, so the reported status is never ahead
        of what actually stopped."""
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

    def set_seen(self, seen: int) -> None:
        with self._lock:
            self.seen = int(seen)

    def merge(self, result: BulkImportResult) -> None:
        with self._lock:
            self.created += len(result.created)
            self.skipped += result.skipped
            self.failed += result.failed
            for message in result.errors:
                if len(self.errors) < MAX_IMPORT_ERRORS:
                    self.errors.append(message)

    def finish(self, status: str, *, error: Optional[str] = None) -> None:
        with self._lock:
            self.status = status
            self.finished_at = time.time()
            if error and len(self.errors) < MAX_IMPORT_ERRORS:
                self.errors.append(error)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.id,
                "folder": self.folder,
                "status": self.status,
                "seen": self.seen,
                "created": self.created,
                "skipped": self.skipped,
                "failed": self.failed,
                "errors": list(self.errors),
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }


class ImportJobRegistry:
    """In-process register of import jobs, newest last.

    Deliberately not persisted: a job is a view onto work that only exists
    while the process does, and the library itself (metadata.json + the DB) is
    what survives a restart. Bounded so a long-lived server that imports a
    folder a day does not accumulate handles forever."""

    def __init__(self, max_jobs: int = 50) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, ImportJob] = {}
        self._max_jobs = int(max_jobs)

    def create(self, *, folder: str, recursive: bool = True) -> ImportJob:
        job = ImportJob(uuid.uuid4().hex, folder, recursive=recursive)
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
        return job

    def register(self, job: Any) -> Any:
        """Adopt an already-built job so it shows up on the import-job routes.

        :meth:`create` mints an :class:`ImportJob`, which is a folder import.
        The Suno stage/promote jobs are a different shape but the same
        lifecycle, and the user should be able to poll and cancel them at the
        one place every other import lives. Anything with ``id``, ``finished``,
        ``cancel()`` and ``snapshot()`` fits here -- that is the whole contract
        the routes and :meth:`_prune` use.
        """
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
        return job

    def get(self, job_id: str) -> Optional[ImportJob]:
        with self._lock:
            return self._jobs.get(job_id)

    def _prune(self) -> None:
        if len(self._jobs) <= self._max_jobs:
            return
        for job_id, job in list(self._jobs.items()):
            if len(self._jobs) <= self._max_jobs:
                break
            if job.finished:
                self._jobs.pop(job_id, None)


_import_jobs = ImportJobRegistry()


def get_import_jobs() -> ImportJobRegistry:
    return _import_jobs


class LibraryStore:
    """Filesystem-backed library with an attached SQLite query layer.

    Filesystem (``<root>/<entry_id>/metadata.json`` + audio) remains the
    durable source of truth. SQLite at ``<root>/library.db`` (overridable
    via ``db_path``) is a write-through query accelerator + the home for
    analysis / stems / midi / relations tables that have no filesystem
    representation.

    On init we open the DB, run schema migrations, and — if the DB is
    empty but filesystem entries exist — auto-``reindex()`` so the query
    layer is immediately useful without a manual step. Setting
    ``db_path=False`` disables the DB entirely (only for unit tests that
    pre-date the DB; the default tests run with the DB in tmp_path)."""

    def __init__(
        self,
        root: Path,
        api_prefix: str = "/api/library",
        db_path: Optional[Path] | bool = None,
    ) -> None:
        self.root = root
        self.api_prefix = api_prefix
        self.root.mkdir(parents=True, exist_ok=True)

        if db_path is False:
            self.db: Optional[LibraryDB] = None
        else:
            resolved_db_path = (
                db_path if isinstance(db_path, Path) else self.root / "library.db"
            )
            self.db = LibraryDB(resolved_db_path)
            # Auto-reindex on a fresh DB so the query layer is hot. This runs
            # any time the DB is empty -- first boot, but also a lost,
            # deleted, or rebuilt DB file next to a library that already has
            # 200,000 entries on disk. With no stored rows every entry looks
            # "new", so this must never enqueue analysis: that would queue
            # the entire library the instant the app opens, not just what
            # actually changed. reindex()'s own default is now False for
            # exactly this reason (a bare call must never enqueue); passed
            # explicitly here anyway so this call stays correct even if that
            # default ever changes. A user wanting analysis on a manual
            # reindex opts in via POST /reindex?analyze=true.
            if self.db.count_entries() == 0:
                self.reindex(enqueue_analysis=False)

        #: Entry ids whose missing cover art has already been looked for, so a
        #: track that simply has none costs one tag read per process rather
        #: than one per request. See :meth:`get_cover_path`.
        self._cover_attempts: set[str] = set()

    # ---- Read ---------------------------------------------------------------

    def _iter_disk_entries(
        self, kinds: Optional[Iterable[str]] = None
    ) -> Iterator[tuple[LibraryRecord, dict[str, Any], Path]]:
        """Walk the filesystem yielding ``(record, metadata, entry_dir)``.

        The single place the on-disk layout is interpreted. Yielding the parsed
        metadata alongside the record is what lets :meth:`reindex` read each
        ``metadata.json`` ONCE -- it used to walk with ``list_entries`` and
        then read every file a second time to get the same dict back.
        """
        if not self.root.is_dir():
            return
        kind_set = set(kinds) if kinds is not None else None
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            # Generate flow has been writing data/generations/<job_id>/<index>/
            # i.e. nested two levels. Walk down one if we see no metadata.json
            # at the top.
            direct_meta = _read_metadata(child)
            if direct_meta is not None:
                record = _record_from_metadata(child, direct_meta, self.api_prefix)
                if record is not None and (kind_set is None or record.kind in kind_set):
                    yield record, direct_meta, child
                continue
            for inner in sorted(child.iterdir()):
                if not inner.is_dir():
                    continue
                meta = _read_metadata(inner)
                if meta is None:
                    continue
                # Synthesize entry_id from the nested structure so listing
                # is stable across reads.
                entry_id = f"{child.name}_{inner.name}"
                # Build a record but force the id we synthesized.
                record = _record_from_metadata(inner, meta, self.api_prefix)
                if record is None:
                    continue
                if kind_set is not None and record.kind not in kind_set:
                    continue
                record.id = entry_id
                if record.kind == "audio":
                    record.audio_url = _audio_url_for(self.api_prefix, entry_id)
                    if record.cover_url:
                        record.cover_url = _cover_url_if_present(
                            inner, self.api_prefix, entry_id
                        )
                else:
                    record.media_url = _media_url_for(self.api_prefix, entry_id)
                    record.audio_url = record.media_url
                yield record, meta, inner

    def list_entries(
        self, kinds: Optional[Iterable[str]] = None
    ) -> list[LibraryRecord]:
        """List entries, optionally restricted to a set of ``kind`` values
        ('audio' | 'video' | 'image'). ``kinds=None`` returns every kind
        (used by reindex); callers that want the historical audio-only
        behavior pass ``kinds={'audio'}``."""
        return [record for record, _meta, _dir in self._iter_disk_entries(kinds)]

    def list_entries_fast(
        self, kinds: Optional[Iterable[str]] = None
    ) -> list[LibraryRecord]:
        """DB-backed sibling of :meth:`list_entries` for the hot ``/entries``
        endpoint: ONE ``entries`` SELECT plus one directory stat per row,
        instead of reading and JSON-parsing every ``metadata.json`` off disk.
        Falls back to the filesystem walk when the DB is disabled. Sizes and
        timestamps come from the DB snapshot, so a file changed behind the
        store's back stays stale until :meth:`reindex`."""
        if self.db is None:
            return self.list_entries(kinds)
        kind_set = set(kinds) if kinds is not None else None
        out: list[LibraryRecord] = []
        for row in self.db.list_entries():
            entry_id = str(row["id"])
            kind = str(row.get("kind") or "audio")
            if kind_set is not None and kind not in kind_set:
                continue
            # The walk hides entries whose folder was deleted by hand;
            # _dir_for preserves that with a stat instead of a metadata read
            # (it also resolves the nested "<job_id>/<index>" generate layout
            # that a plain root/<id> check would miss).
            entry_dir = self._dir_for(entry_id)
            if entry_dir is None:
                continue
            out.append(_record_from_db_row(row, entry_dir, self.api_prefix))
        # The walk emits entries in sorted(root.iterdir()) order; sorting by
        # id mirrors that (entry ids are the directory names).
        out.sort(key=lambda r: r.id)
        return out

    def list_entries_page(
        self,
        filters: EntryFilters,
        *,
        sort: str = DEFAULT_SORT,
        limit: int = 200,
        offset: int = 0,
    ) -> list[LibraryRecord]:
        """Records for ONE page, in the order SQL returned them.

        The filtering, searching, sorting and slicing all happen in the
        database; the only per-row work here is the directory stat that
        resolves cover art, and it runs at most ``limit`` times instead of once
        per entry in the library.

        An entry whose folder was deleted by hand is omitted, exactly as
        :meth:`list_entries_fast` omits it — so a page can be shorter than
        ``limit`` while the caller's ``total`` still counts the row. Catching
        that in the count would mean the per-row filesystem access this whole
        path exists to avoid.
        """
        if self.db is None:
            raise RuntimeError("paged listing needs the library DB")
        out: list[LibraryRecord] = []
        for row in self.db.list_entries_page(
            filters, sort=sort, limit=limit, offset=offset
        ):
            entry_dir = self._dir_for(str(row["id"]))
            if entry_dir is None:
                continue
            out.append(_record_from_db_row(row, entry_dir, self.api_prefix))
        return out

    def get_entry(self, entry_id: str) -> Optional[LibraryRecord]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir)
        if meta is None:
            return None
        record = _record_from_metadata(entry_dir, meta, self.api_prefix)
        if record is None:
            return None
        # The nested "<job>/<index>" layout resolves against the inner dir, so
        # every per-entry URL is re-stamped with the id callers actually use.
        record.id = entry_id
        if record.kind in ("video", "image"):
            # A media entry streams from /media/<id>. This used to rewrite
            # audio_url to the audio route unconditionally, so the single-entry
            # read disagreed with both list paths, which set audio_url ==
            # media_url. (The old URL did resolve — /audio/<id> falls back to
            # the declared filename and happily serves the mp4 — so this is a
            # consistency fix, not a 404 fix.)
            record.media_url = _media_url_for(self.api_prefix, entry_id)
            record.audio_url = record.media_url
            if record.thumb_url:
                record.thumb_url = _thumb_url_for(self.api_prefix, entry_id)
        else:
            record.audio_url = _audio_url_for(self.api_prefix, entry_id)
            if record.cover_url:
                record.cover_url = _cover_url_if_present(
                    entry_dir, self.api_prefix, entry_id
                )
        return record

    def get_audio_path(self, entry_id: str) -> Optional[Path]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        return _resolve_audio_file(entry_dir, meta)

    def get_media_path(self, entry_id: str) -> Optional[Path]:
        """Resolve the video/image file for a media entry (None for audio
        entries or unknown ids)."""
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        if str(meta.get("kind") or "audio") not in ("video", "image"):
            return None
        return _resolve_media_file(entry_dir, meta)

    def get_thumb_path(self, entry_id: str) -> Optional[Path]:
        """Resolve the poster thumbnail for a media entry, if one exists."""
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        thumb = entry_dir / "thumb.jpg"
        return thumb if thumb.is_file() else None

    def get_cover_path(
        self, entry_id: str, *, extract_missing: bool = False
    ) -> Optional[Path]:
        """Resolve the cover art for an entry, if the track had any.

        A bulk folder import skips cover extraction — reading tags off 200,000
        files up front is most of the import. With ``extract_missing`` the
        serving route pays that cost lazily instead: the FIRST request for an
        entry with no cover on disk reads its embedded art and writes it.
        Guarded per process, so a track that simply has no picture costs one
        tag read, not one per request.
        """
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        cover = entry_dir / COVER_FILENAME
        if cover.is_file():
            return cover
        if not extract_missing or entry_id in self._cover_attempts:
            return None
        self._cover_attempts.add(entry_id)
        meta = _read_metadata(entry_dir) or {}
        if str(meta.get("kind") or "audio") != "audio":
            return None
        audio_path = _resolve_audio_file(entry_dir, meta)
        if audio_path is None or not extract_cover_for(entry_dir, audio_path):
            return None
        return cover if cover.is_file() else None

    # ---- Write --------------------------------------------------------------

    def update_entry(
        self, entry_id: str, patch: dict[str, Any]
    ) -> Optional[LibraryRecord]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir)
        if meta is None:
            return None
        for key in USER_MUTABLE_FIELDS:
            if key not in patch:
                continue
            meta[key] = patch[key]
        # Sanitize types we expose.
        if "favorite" in meta:
            meta["favorite"] = bool(meta["favorite"])
        if "tags" in meta:
            meta["tags"] = [str(t) for t in (meta["tags"] or [])]
        if "notes" in meta:
            meta["notes"] = str(meta["notes"] or "")
        if "lyrics" in meta:
            meta["lyrics"] = str(meta["lyrics"] or "")
        if "notation_artist" in meta:
            meta["notation_artist"] = str(meta["notation_artist"] or "")
        if "notation_title" in meta:
            meta["notation_title"] = str(meta["notation_title"] or "")
        if "chimera_sources" in meta:
            raw = meta["chimera_sources"] or []
            if not isinstance(raw, list):
                raw = []
            meta["chimera_sources"] = [str(s) for s in raw]
        if meta.get("rating") not in ("like", "dislike", None):
            meta["rating"] = None
        _write_metadata(entry_dir, meta)
        record = self.get_entry(entry_id)
        if record is not None:
            self._sync_record_to_db(record, meta)
        # Favoriting a track gives it the full treatment — stems, MIDI, and a
        # score — so a starred track is always fully analyzed and notated. Each
        # job is idempotent (skipped if the artifact exists) and runs on the
        # idle-gated, serialized background queue (stems -> midi -> score).
        if bool(patch.get("favorite")):
            _maybe_enqueue_stems(self, entry_id, source="favorite", force=True)
            _maybe_enqueue_lyrics(self, entry_id, source="favorite", force=True)
            _maybe_enqueue_midi(self, entry_id, source="favorite", force=True)
            _maybe_enqueue_score(self, entry_id, source="favorite", force=True)
        return record

    def delete_entry(self, entry_id: str) -> bool:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return False
        try:
            shutil.rmtree(entry_dir)
        except OSError as e:
            log.warning("library.store: failed to delete %s: %s", entry_dir, e)
            return False
        if self.db is not None:
            self.db.delete_entry(entry_id)
        return True

    def delete_entries_bulk(
        self, entry_ids: Iterable[str], *, batch: int = DEFAULT_DELETE_BATCH
    ) -> BulkDeleteResult:
        """Delete many entries. One DB transaction per batch, filesystem after.

        ``batch`` is how many entries share a transaction; the DB layer caps it
        at the SQL parameter ceiling, so a larger value simply commits more
        often rather than failing.

        Removes exactly what :meth:`delete_entry` removes, per entry: the
        entry's own folder under the library root, plus its rows. In
        particular, for a REFERENCE-IN-PLACE entry -- one registered from the
        user's own music folder, whose ``source_path`` points outside the
        library -- the folder holds only ``metadata.json`` and any extracted
        cover, so the user's audio file is never a candidate for removal. There
        is no code path here that reads ``source_path``, by design.

        Three rules make this safe to point at 200,000 rows:

        * **Containment.** Every directory is resolved and proved to be inside
          the library root before anything is removed (:func:`_contains`). An
          id that escapes is refused outright -- its rows are left alone too,
          so the entry stays visible instead of half-deleted.
        * **Order.** The rows are committed first, the folder goes after. A
          crash between the two leaves an orphan folder, which is harmless and
          re-importable; the other order would leave a row pointing at audio
          that no longer exists.
        * **Isolation.** A failure is recorded against its id and the rest of
          the request continues. Nothing aborts the batch.

        A row whose folder was deleted by hand is still cleared: those rows are
        skipped by the listing but counted in its ``total``, so leaving them
        would mean "Clear all" never finishes. An id with neither a row nor a
        folder is reported as a failure -- there was nothing to delete.
        """
        ordered = list(dict.fromkeys(str(entry_id) for entry_id in entry_ids))
        result = BulkDeleteResult()
        if not ordered:
            return result

        known = self.db.existing_entry_ids(ordered) if self.db is not None else set()
        root_normcase = os.path.normcase(str(self.root.resolve()))

        # Classify first, so a refused id never reaches a DELETE.
        targets: list[tuple[str, Optional[Path]]] = []
        for entry_id in ordered:
            entry_dir = self._dir_for(entry_id)
            if entry_dir is not None and not _contains(root_normcase, entry_dir):
                log.warning(
                    "library.store: refusing bulk delete of %r: %s is outside %s",
                    entry_id,
                    entry_dir,
                    self.root,
                )
                result.failed.append(
                    {
                        "id": entry_id,
                        "error": "resolved path is outside the library root",
                    }
                )
                continue
            if entry_dir is None and entry_id not in known:
                result.failed.append({"id": entry_id, "error": "no such library entry"})
                continue
            targets.append((entry_id, entry_dir))

        size = max(1, int(batch))
        for start in range(0, len(targets), size):
            chunk = targets[start : start + size]
            if self.db is not None:
                # One transaction, one revision bump, for this whole chunk.
                self.db.delete_entries_bulk(
                    [entry_id for entry_id, _ in chunk], batch=len(chunk)
                )
            for entry_id, entry_dir in chunk:
                if entry_dir is None:
                    result.deleted += 1
                    continue
                try:
                    shutil.rmtree(entry_dir)
                except OSError as e:
                    log.warning(
                        "library.store: deleted row %r but failed to remove %s: %s",
                        entry_id,
                        entry_dir,
                        e,
                    )
                    result.failed.append(
                        {"id": entry_id, "error": f"could not remove folder: {e}"}
                    )
                    continue
                result.deleted += 1
        return result

    def import_blob(
        self,
        audio_bytes: bytes,
        filename: str,
        mime_type: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> LibraryRecord:
        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix.lower() or ".wav"
        safe_name = Path(filename).stem[:80] or "import"
        target_name = f"{safe_name}{suffix}"
        target_path = entry_dir / target_name
        target_path.write_bytes(audio_bytes)

        # Read any embedded metadata (e.g., ID3 TXXX:prompt from an
        # AI-generated MP3) and merge with caller-supplied metadata.
        # Caller wins for explicit fields; embedded fills the gaps.
        from .tags import extract_embedded_tags

        embedded = extract_embedded_tags(target_path)
        # Same frames, the other half of what they carry: the front cover.
        # Written before the record is built so the first response already
        # says the entry has artwork.
        extract_cover_for(entry_dir, target_path)
        meta_in = dict(metadata or {})

        def _pick(field: str, embedded_keys: list[str], default: Any) -> Any:
            if field in meta_in and meta_in[field] not in (None, ""):
                return meta_in[field]
            for ek in embedded_keys:
                if ek in embedded and embedded[ek]:
                    return embedded[ek]
            return default

        title_default = embedded.get("title") or target_name
        record_meta: dict[str, Any] = {
            "id": entry_id,
            "filename": target_name,
            "audio_filename": target_name,
            "mime_type": mime_type,
            "title": _pick("title", ["title"], title_default),
            "prompt": _pick("prompt", ["prompt"], ""),
            "negative_prompt": _pick("negative_prompt", ["negative_prompt"], ""),
            # Read like every other field the caller may supply: without this
            # key an uploader's own lyrics were dropped on the floor, and the
            # curated ones a provider file carries had nothing to fill.
            "lyrics": _pick("lyrics", ["lyrics"], ""),
            "model": _pick("model", ["model", "generator"], "import"),
            "duration": meta_in.get("duration", 0.0),
            "steps": meta_in.get("steps", 0),
            "cfg": meta_in.get("cfg", 0.0),
            "seed": meta_in.get("seed", 0),
            "favorite": False,
            "rating": None,
            "tags": list(meta_in.get("tags", [])),
            "notes": meta_in.get("notes", ""),
            "source": meta_in.get("source", "import"),
            "chimera_sources": list(meta_in.get("chimera_sources", [])),
            "saved_at": time.time(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "embedded_tags": embedded,
        }
        # Who made this, and the fields of the file that describe the SONG.
        # `source` above is untouched: an import stays an import.
        _apply_provider_labels(record_meta, embedded, meta_in)
        _write_metadata(entry_dir, record_meta)
        record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
        assert record is not None, "freshly imported entry must resolve"
        record.id = entry_id
        record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        self._sync_record_to_db(record, record_meta)
        # Opt-in: enqueue background analysis / stems / midi if the
        # user has those toggles on (defaults are all OFF).
        # Serial idle queue, in this order: stems first (everything after
        # wants the vocal / the parts), lyrics next (the song is singable
        # sooner than it is notated), then MIDI and the sheet.
        _maybe_enqueue_analysis(self, entry_id, source="import")
        _maybe_enqueue_stems(self, entry_id, source="import")
        _maybe_enqueue_lyrics(self, entry_id, source="import")
        _maybe_enqueue_midi(self, entry_id, source="import")
        _maybe_enqueue_score(self, entry_id, source="import")
        _maybe_enqueue_shards(self, entry_id, source="import")
        return record

    def register_reference(
        self,
        source_path: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Optional[LibraryRecord]:
        """Register an on-disk audio file as a library entry WITHOUT copying it
        (reference-in-place). Only a small metadata.json is written into the
        library; the audio is served / analysed straight from ``source_path``.
        Used by the folder -> playlist feature. Returns None when the path is
        not a file.

        The file's own tags are read here, the way they are for an upload: this
        path already opens the file for its cover art, so a track registered in
        place is identified and curated exactly like one copied in. The BULK
        sibling below does neither, by design."""
        from .tags import extract_embedded_tags

        src = Path(source_path)
        if not src.is_file():
            return None
        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        record_meta = _reference_metadata(
            src,
            entry_id,
            dict(metadata or {}),
            embedded=extract_embedded_tags(src),
        )
        # The audio stays where it is, but its artwork is copied in: the cover
        # has to live under the library root for the route to serve it. A
        # folder import runs this per file — a track with no picture costs a
        # tag read, and one with a picture pays the normalise it needs.
        extract_cover_for(entry_dir, src)
        _write_metadata(entry_dir, record_meta)
        record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
        if record is None:
            return None
        record.id = entry_id
        record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        self._sync_record_to_db(record, record_meta)
        # Reference tracks still benefit from BG analysis (BPM/key for mixing);
        # it reads get_audio_path, which now resolves to the external file.
        _maybe_enqueue_analysis(self, entry_id, source="import")
        return record

    def register_references_bulk(
        self,
        paths: Iterable[Any],
        *,
        defer_jobs: bool = True,
        extract_covers: bool = False,
        source: str = "folder",
        batch: int = 1000,
        known_source_paths: Optional[set[str]] = None,
    ) -> BulkImportResult:
        """Register many on-disk files as reference-in-place entries.

        The batched sibling of :meth:`register_reference`, for the folder
        import that has to survive ~200,000 files. Three things are different,
        and all three are why the per-file version cannot be used at that size:

        * DB writes go through ``upsert_entries_bulk``, so ``batch`` files
          share ONE transaction and one ``library_revision`` bump instead of
          one each.
        * ``extract_covers`` is off: reading embedded artwork means opening and
          parsing every source file. :meth:`get_cover_path` picks it up lazily
          when a cover is actually asked for. It gates the file's TAGS for the
          same reason -- with it off, an entry is labeled from what the caller
          says about it and from nothing else, and a provider that only the
          file knows about is picked up later, at read time, from the tags the
          analysis pass stores. Nothing here re-reads 200,000 files.
        * ``defer_jobs`` is on: 200,000 queued analysis jobs would saturate the
          serial background queue for days. The user runs analysis when they
          want it.

        Already-registered files (matched on the resolved ``source_path``) are
        skipped, which makes a re-run over the same folder a no-op and makes a
        cancelled import resumable. ``known_source_paths``, when given, is both
        read AND extended with what this call registers, so a caller looping
        over batches pays for the lookup scan once.
        """
        from .tags import extract_embedded_tags

        if self.db is None:
            raise RuntimeError("bulk import needs the library DB")
        result = BulkImportResult()
        known = (
            known_source_paths
            if known_source_paths is not None
            else self.db.registered_source_paths()
        )
        buffered: list[tuple[LibraryRecord, dict[str, Any]]] = []

        def flush() -> None:
            if not buffered:
                return
            self.db.upsert_entries_bulk(
                [_db_payload(record, meta) for record, meta in buffered],
                batch=len(buffered),
            )
            for record, _meta in buffered:
                result.created.append(record)
                if not defer_jobs:
                    _maybe_enqueue_analysis(self, record.id, source="import")
            buffered.clear()

        for raw in paths:
            src = Path(raw)
            try:
                if not src.is_file():
                    result.note_failure(f"not a file: {src}")
                    continue
                resolved = str(src.resolve())
                if resolved in known:
                    result.skipped += 1
                    continue
                entry_id = uuid.uuid4().hex
                entry_dir = self.root / entry_id
                entry_dir.mkdir(parents=True, exist_ok=True)
                record_meta = _reference_metadata(
                    src,
                    entry_id,
                    {"source": source},
                    embedded=extract_embedded_tags(src) if extract_covers else None,
                )
                if extract_covers:
                    extract_cover_for(entry_dir, src)
                _write_metadata(entry_dir, record_meta)
                record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
                if record is None:
                    result.note_failure(f"unreadable after registering: {src}")
                    continue
                record.id = entry_id
                record.audio_url = _audio_url_for(self.api_prefix, entry_id)
                buffered.append((record, record_meta))
                known.add(resolved)
            except OSError as e:
                result.note_failure(f"{src}: {e}")
                continue
            if len(buffered) >= batch:
                flush()
        flush()
        return result

    def run_import_job(self, job: ImportJob, *, batch: int = 1000) -> ImportJob:
        """Run one folder import to completion, synchronously.

        Called from a worker thread (see the router's ``?async=1`` path), which
        is why it takes no event loop and never raises: every outcome is
        recorded on ``job``. Cancellation is honoured BETWEEN batches, so the
        transaction in flight always commits — a cancelled import leaves a
        consistent, resumable library rather than a partial batch.
        """
        if job.cancelled:
            job.finish("cancelled")
            return job
        job.begin()
        try:
            root = Path(job.folder)
            if not root.is_dir():
                job.finish("failed", error=f"not a folder: {job.folder}")
                return job
            walk = root.rglob("*") if job.recursive else root.iterdir()
            files = sorted(
                (p for p in walk if p.is_file() and p.suffix.lower() in AUDIO_EXTS),
                key=lambda p: str(p).lower(),
            )
            job.set_seen(len(files))
            known = self.db.registered_source_paths() if self.db is not None else set()
            for start in range(0, len(files), batch):
                if job.cancelled:
                    job.finish("cancelled")
                    return job
                job.merge(
                    self.register_references_bulk(
                        [str(p) for p in files[start : start + batch]],
                        batch=batch,
                        known_source_paths=known,
                    )
                )
            job.finish("cancelled" if job.cancelled else "done")
        except Exception as e:  # noqa: BLE001 - a job records its failure, never raises
            log.warning("library.store: import job %s failed: %s", job.id, e)
            job.finish("failed", error=repr(e))
        return job

    def import_media(
        self,
        media_bytes: bytes,
        filename: str,
        mime_type: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> LibraryRecord:
        """Import a video or image as a library entry (kind='video'|'image').

        Stores the original file untouched, probes it for dimensions /
        duration / alpha, and renders a poster thumbnail. None of the
        audio analysis/stems/midi pipelines run for media. Raises
        ValueError for an unrecognized media extension.
        """
        from . import media as media_probe

        kind = media_probe.classify_ext(filename)
        if kind is None:
            raise ValueError(
                f"unrecognized media type for {filename!r} "
                "(expected a video or image file)"
            )

        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix.lower()
        safe_name = Path(filename).stem[:80] or "media"
        target_name = f"{safe_name}{suffix}"
        target_path = entry_dir / target_name
        target_path.write_bytes(media_bytes)

        probe = media_probe.probe_media(target_path, kind)
        thumb_path = entry_dir / "thumb.jpg"
        media_probe.make_thumbnail(target_path, kind, thumb_path)

        meta_in = dict(metadata or {})
        record_meta: dict[str, Any] = {
            "id": entry_id,
            "kind": kind,
            "filename": target_name,
            "media_filename": target_name,
            "mime_type": mime_type or "",
            "title": meta_in.get("title") or safe_name,
            "prompt": meta_in.get("prompt", ""),
            "negative_prompt": "",
            "model": meta_in.get("model", "import"),
            "duration": probe.get("duration") or 0.0,
            "favorite": False,
            "rating": None,
            "tags": list(meta_in.get("tags", [])),
            "notes": meta_in.get("notes", ""),
            "source": meta_in.get("source", "import"),
            "width": probe.get("width"),
            "height": probe.get("height"),
            "has_alpha": bool(probe.get("has_alpha")),
            "saved_at": time.time(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _write_metadata(entry_dir, record_meta)
        record = _media_record_from_metadata(
            entry_dir, record_meta, self.api_prefix, kind
        )
        assert record is not None, "freshly imported media must resolve"
        self._sync_record_to_db(record, record_meta)
        return record

    # ---- Cover art ----------------------------------------------------------

    def attach_cover(
        self, entry_id: str, image_bytes: Optional[bytes] = None
    ) -> Optional[str]:
        """Attach or refresh one entry's cover art, replacing any existing one.

        With ``image_bytes`` the caller's picture is normalised and written;
        without, the entry's audio file is re-read for an embedded front cover.
        Returns the cover URL on success, None when the entry is unknown, is
        not an audio entry, has no audio to read, or carries nothing usable as
        artwork.

        Audio only, deliberately: a video/image entry posters itself from
        ``thumb.jpg`` and every read path reports ``cover_url`` as None for it,
        so writing art here would leave bytes on disk that nothing can ever
        show.
        """
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        if str(meta.get("kind") or "audio") != "audio":
            return None
        if image_bytes is not None:
            from .tags import write_cover_image

            written = write_cover_image(image_bytes, entry_dir / COVER_FILENAME)
        else:
            audio_path = self.get_audio_path(entry_id)
            if audio_path is None:
                return None
            written = extract_cover_for(entry_dir, audio_path)
        if not written:
            return None
        return _cover_url_if_present(entry_dir, self.api_prefix, entry_id)

    def backfill_covers(
        self, *, overwrite: bool = False, limit: Optional[int] = None
    ) -> dict[str, int]:
        """Re-read embedded artwork for audio entries that predate cover art.

        Idempotent: entries that already have a cover are skipped unless
        ``overwrite``. Returns per-outcome counts so the caller can report
        what a maintenance pass actually did.
        """
        counts = {"scanned": 0, "written": 0, "skipped": 0, "no_cover": 0}
        for record in self.list_entries_fast(kinds={"audio"}):
            if limit is not None and counts["scanned"] >= limit:
                break
            entry_dir = self._dir_for(record.id)
            if entry_dir is None:
                continue
            counts["scanned"] += 1
            if not overwrite and (entry_dir / COVER_FILENAME).is_file():
                counts["skipped"] += 1
                continue
            audio_path = self.get_audio_path(record.id)
            if audio_path is None or not extract_cover_for(entry_dir, audio_path):
                counts["no_cover"] += 1
                continue
            counts["written"] += 1
        return counts

    # ---- DB sync / reindex --------------------------------------------------

    def _sync_record_to_db(
        self,
        record: LibraryRecord,
        meta: dict[str, Any],
    ) -> None:
        if self.db is None:
            return
        try:
            self.db.upsert_entry(_db_payload(record, meta))
        except Exception as e:
            log.warning("library.store: db upsert failed for %s: %s", record.id, e)

        # Chimera sources → directed lineage edges.
        for from_id, to_id, kind in _chimera_edges(record.id, meta):
            try:
                self.db.add_relation(from_id=from_id, to_id=to_id, kind=kind)
            except Exception as e:
                log.debug(
                    "library.store: relation insert failed for %s→%s: %s",
                    from_id,
                    to_id,
                    e,
                )

    def reindex(
        self,
        *,
        batch: int = 1000,
        enqueue_analysis: bool = False,
        max_enqueue: Optional[int] = MAX_REINDEX_ANALYSIS_ENQUEUE,
        report: Optional[dict[str, Any]] = None,
    ) -> int:
        """Walk the filesystem and upsert every entry into the DB.
        Returns the number of entries indexed. Idempotent.

        One ``metadata.json`` read per entry (the walk hands its parsed dict
        straight through) and one transaction per ``batch``. It used to read
        every file twice and commit once per entry, which on a 200,000-entry
        library is 400,000 reads and 200,000 fsyncs.

        ``enqueue_analysis`` defaults to ``False``: a bare ``reindex()`` call
        must never enqueue anything. A caller opts IN explicitly. When it is
        ``True``, new or changed entries (by
        :meth:`LibraryDB.new_or_changed_entry_ids`) are enqueued for
        background analysis the same way import does (LIB-002) -- still
        gated by the ``analysis.auto_on_import`` setting inside
        :func:`_maybe_enqueue_analysis`, so opting in is still a no-op unless
        the user also enabled that setting. An unchanged entry is never
        re-enqueued, so re-running reindex over a stable library queues
        nothing. Enqueuing happens only AFTER every batch has been upserted
        (not per-batch), so it can be capped atomically across the whole
        call.

        ``max_enqueue`` (default :data:`MAX_REINDEX_ANALYSIS_ENQUEUE`) caps
        how many new/changed entries may be enqueued in one call: if MORE
        than that many changed, NONE are enqueued -- a mass re-analysis is
        exactly what the "never mass re-analyze" rule forbids, so this fails
        closed rather than queueing a partial batch. Pass ``max_enqueue=None``
        to disable the cap entirely. Ids are stopped from accumulating in
        memory once the running total exceeds the cap (the outcome is
        already decided at that point), though the exact count is still
        tracked for the report.

        ``report``, when given, is filled in place with ``{'changed': int,
        'enqueued': int, 'analysis_skipped': int}`` -- ``enqueued`` counts
        only jobs :func:`_maybe_enqueue_analysis` actually handed to the
        background queue, not every id it was offered -- so a caller
        (``POST /api/library/reindex``) can report what happened without
        changing this method's ``int`` return value, which existing callers
        rely on.
        """
        if self.db is None:
            return 0
        count = 0
        next_log = 5000
        payloads: list[dict[str, Any]] = []
        edges: list[tuple[str, str, str]] = []
        all_changed_ids: list[str] = []
        changed_count = 0

        def flush() -> None:
            nonlocal payloads, changed_count
            if not payloads:
                return
            if enqueue_analysis:
                batch_changed = self.db.new_or_changed_entry_ids(payloads)
                changed_count += len(batch_changed)
                if max_enqueue is None or changed_count <= max_enqueue:
                    all_changed_ids.extend(batch_changed)
                # else: already over the cap -- the whole run will be
                # skipped, so stop growing the list; changed_count keeps
                # counting for an accurate report.
            self.db.upsert_entries_bulk(payloads, batch=len(payloads))
            payloads = []

        for record, meta, _entry_dir in self._iter_disk_entries():
            payloads.append(_db_payload(record, meta))
            edges.extend(_chimera_edges(record.id, meta))
            count += 1
            if len(payloads) >= batch:
                flush()
            if count >= next_log:
                log.info("library.store: reindexed %d entries", count)
                next_log += 5000
        flush()
        self.db.add_relations_bulk(edges)

        enqueued = 0
        skipped = 0
        if enqueue_analysis and changed_count:
            if max_enqueue is not None and changed_count > max_enqueue:
                skipped = changed_count
            else:
                for entry_id in all_changed_ids:
                    if _maybe_enqueue_analysis(self, entry_id, source="import"):
                        enqueued += 1
        if report is not None:
            report["changed"] = changed_count
            report["enqueued"] = enqueued
            report["analysis_skipped"] = skipped
        return count

    # ---- Helpers ------------------------------------------------------------

    def _dir_for(self, entry_id: str) -> Optional[Path]:
        # Direct (import or single-level generate) layout.
        direct = self.root / entry_id
        if _is_entry_dir(direct):
            return direct
        # Nested generate layout: "<job_id>_<index>" maps to "<job_id>/<index>".
        if "_" in entry_id:
            job_id, _, index = entry_id.rpartition("_")
            nested = self.root / job_id / index
            if _is_entry_dir(nested):
                return nested
        return None

    def all_ids(self) -> Iterable[str]:
        for record in self.list_entries():
            yield record.id


def _maybe_enqueue_analysis(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
) -> bool:
    """If feature settings have ``analysis.auto_on_<source>`` enabled,
    queue a background analysis job. Failures here never block the
    import / generate flow — analysis is opt-in enrichment.

    ``source`` is either ``"import"`` or ``"generate"``. Returns ``True``
    only when a job was actually handed to the background queue -- callers
    that report a count (e.g. ``reindex()``'s ``analysis_enqueued``) must
    count real enqueues, not attempts skipped by the settings gate, a
    missing audio file, or a queue failure.
    """
    if store.db is None:
        return False
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return False

    try:
        settings = get_settings_store().get_section("analysis")
    except Exception:
        return False

    key = f"auto_on_{source}"
    if not settings.get(key, False):
        return False

    audio_path = store.get_audio_path(entry_id)
    if audio_path is None:
        return False
    entry_dir = store._dir_for(entry_id)
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    async def _run() -> None:
        import asyncio

        from backend.modules.analysis.engine import analyze_and_persist

        # Off the loop, like every other job here. The queue's consumer awaits
        # job.fn directly, so a coroutine that does its CPU work inline stalls
        # the whole event loop — not just analysis, every request behind it.
        # analyze_and_persist runs librosa.pyin, whose numba Viterbi pass holds
        # the GIL for its entire run: 6-18 s per track, and every row re-runs
        # when ANALYSIS_VERSION changes.
        await asyncio.to_thread(
            analyze_and_persist,
            store.db,  # type: ignore[arg-type]  # checked above
            entry_id,
            audio_path,
            metadata_path=metadata_path,
            settings=settings,
        )

    try:
        get_background_queue().enqueue(f"analysis:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue analysis for %s: %s", entry_id, e)
        return False
    return True


def _maybe_enqueue_stems(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If feature settings have ``stems.auto_on_<source>`` enabled, queue
    a background stem-separation job. Heavy work — relies on the
    integration-package sidecar. ``force`` bypasses the settings gate (used
    when favoriting a track), but the job is still skipped when the entry
    already has stems."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    try:
        settings = get_settings_store().get_section("stems")
    except Exception:
        settings = {}

    key = f"auto_on_{source}"
    if not force and not settings.get(key, False):
        return

    # Idempotent: never re-separate an entry that already has stems.
    try:
        if store.db.list_stems(entry_id):
            return
    except Exception:
        pass

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)
    if audio_path is None or entry_dir is None:
        return

    stem_count = int(settings.get("default_count") or 4)

    async def _run() -> None:
        from backend.core import pipeline

        # Device and quality come from the settings inside; a separation the
        # user started meanwhile (SING's ALIGN, a manual run) is joined.
        await pipeline.ensure_stems(entry_id, stems=stem_count)

    try:
        get_background_queue().enqueue(f"stems:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue stems for %s: %s", entry_id, e)


def _maybe_enqueue_shards(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If ``shards.auto_on_<source>`` is on, queue the Shard Index cut for the
    entry (docs/design/loom.md). Last in the chain so it sees stems when the
    user has those on too; otherwise it shards the mix and is re-cut later."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return
    try:
        settings = get_settings_store().get_section("shards")
    except Exception:
        settings = {}
    if not force and not settings.get(f"auto_on_{source}", False):
        return
    try:
        if store.db.list_shards(entry_id):
            return
    except Exception:
        pass

    async def _run() -> None:
        from backend.core import pipeline

        await pipeline.ensure_shards(entry_id)

    try:
        get_background_queue().enqueue(f"shards:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue shards for %s: %s", entry_id, e)


def _maybe_enqueue_midi(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If feature settings have ``midi.auto_on_<source>`` enabled, queue
    a background MIDI-conversion job. Reads ``midi.from_stems`` to
    decide whether to also convert each stem. ``force`` bypasses the settings
    gate (used when favoriting), but the job is still skipped when the entry
    already has MIDI."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    try:
        settings = get_settings_store().get_section("midi")
    except Exception:
        settings = {}

    key = f"auto_on_{source}"
    if not force and not settings.get(key, False):
        return

    # Idempotent: never re-transcribe an entry that already has MIDI.
    try:
        if store.db.list_midis(entry_id):
            return
    except Exception:
        pass

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)
    if audio_path is None or entry_dir is None:
        return

    from_stems_flag = bool(settings.get("from_stems", True))

    async def _run() -> None:
        from backend.core import pipeline

        # Off the event loop (the coordinator threads it), on the GPU lane,
        # after any stem separation in flight, and never twice for one entry.
        await pipeline.ensure_midi(entry_id, from_stems=from_stems_flag)

    try:
        get_background_queue().enqueue(f"midi:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue midi for %s: %s", entry_id, e)


def _maybe_enqueue_lyrics(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If ``lyrics.auto_on_<source>`` is on and the entry has lyric text
    (a Suno import, an embedded tag, the notes), queue an ALIGN so the song
    is ready to sing along to without a click: whisper times the user's own
    words against the vocal stem. With ``lyrics.auto_transcribe`` on, an
    entry with no text is transcribed instead. Skipped when a timed
    document exists, or whisper is not installed. ``force`` bypasses the
    settings gate (favoriting)."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return
    try:
        settings = get_settings_store().get_section("lyrics")
    except Exception:
        settings = {}
    if not force and not settings.get(f"auto_on_{source}", False):
        return
    record = store.get_entry(entry_id)
    has_text = bool(str(getattr(record, "lyrics", "") or "").strip())
    if not has_text and not settings.get("auto_transcribe", False):
        return

    async def _run() -> None:
        from backend.core import pipeline

        await pipeline.ensure_lyrics(entry_id)

    try:
        get_background_queue().enqueue(f"lyrics:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue lyrics for %s: %s", entry_id, e)


def _generate_score_for_entry(
    store: "LibraryStore", entry_id: str, entry_dir: Path
) -> None:
    """Generate a MusicXML sheet from the entry's first MIDI, stamped with the
    song title. No-op if the entry already has a sheet or has no MIDI. Runs in
    a worker thread (music21 parse is CPU-bound)."""
    if store.db is None:
        return
    try:
        from backend.modules.notation.engine import (
            midi_to_musicxml,
            register_existing_midis,
        )
    except Exception:
        return
    try:
        register_existing_midis(store.db, entry_id)
        if store.db.list_notation_artifacts(entry_id, kind="musicxml"):
            return  # already scored
        target = None
        for midi in store.db.list_midis(entry_id):
            path = midi.get("midi_path") or ""
            if path and Path(path).is_file():
                target = midi
                break
        if target is None:
            return  # nothing to score
        record = store.get_entry(entry_id)
        title = str(getattr(record, "title", "") or "")
        midi_id = str(target.get("id") or "")
        output = entry_dir / "notation" / f"{midi_id}.musicxml"
        midi_to_musicxml(
            store.db,
            entry_id=entry_id,
            midi_path=Path(target["midi_path"]),
            output_path=output,
            source_ref=midi_id,
            artifact_id=f"{midi_id}__musicxml",
            title=title,
        )
    except Exception as e:  # noqa: BLE001 - best-effort background work
        log.debug("library.store: auto-score failed for %s: %s", entry_id, e)


def _maybe_enqueue_score(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """Queue a background job that turns the entry's MIDI into a titled sheet.
    Auto-score defaults ON (sheets are cheap music21 work and the job only acts
    when a MIDI already exists and no sheet does). ``force`` bypasses the
    settings gate (used when favoriting). Enqueued AFTER any MIDI job so the
    serial idle queue runs MIDI first, then this finds its output."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    if not force:
        try:
            settings = get_settings_store().get_section("notation")
        except Exception:
            settings = {}
        if not settings.get(f"auto_on_{source}", True):
            return

    entry_dir = store._dir_for(entry_id)
    if entry_dir is None:
        return

    async def _run() -> None:
        import asyncio

        await asyncio.to_thread(_generate_score_for_entry, store, entry_id, entry_dir)

    try:
        get_background_queue().enqueue(f"score:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue score for %s: %s", entry_id, e)
