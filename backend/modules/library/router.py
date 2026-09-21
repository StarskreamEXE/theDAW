"""FastAPI router for the disk-backed library.

Endpoints (prefix from module.json → `/api/library`):

    GET    /summary            category counts + the DB revision they came from
    GET    /entries            list entries (?kind=audio|video|image|media|all);
                               with ?limit= it is paged + searchable (see below)
    GET    /entries/ids        every matching id, for select-all / shift-range
    GET    /entries/facets     value counts per field, for the filter dropdowns
    POST   /entries/bulk-delete  delete many entries by id, or by filter
    GET    /entries/{id}       single entry record
    GET    /audio/{id}         stream the audio file
    GET    /audio/{id}/cover   cover art for an audio entry
    POST   /audio/{id}/cover   attach/refresh one entry's cover art
    GET    /media/{id}         stream a video/image entry (Range-capable)
    GET    /media/{id}/thumb   poster thumbnail for a media entry
    PATCH  /entries/{id}       update user-mutable fields
    DELETE /entries/{id}       remove the entry (audio + metadata)
    POST   /import             accept an audio upload, return new entry
    POST   /import-media       accept a video/image upload, return new entry
    POST   /import-folder      add a folder reference-in-place (?async=1 → a job)
    GET    /import-jobs/{id}   progress of an async folder import
    DELETE /import-jobs/{id}   cancel one after the batch in flight
    POST   /covers/backfill    re-read embedded art for entries with none
    POST   /reindex            re-sync the SQLite mirror from the filesystem

The audio stream uses FileResponse so range requests work (essential for
the player to scrub) and there's no in-memory copy of large files.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import re
import tempfile
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from .bundle import build_bundle_bytes
from .db import DEFAULT_SORT, FACET_FIELDS, SORTS, EntryFilters
from .store import (
    AUDIO_EXTS,
    MAX_REINDEX_ANALYSIS_ENQUEUE,
    ImportJob,
    LibraryStore,
    _read_metadata,
    default_library_root,
    get_import_jobs,
)
from .tags import MAX_EMBEDDED_COVER_BYTES
from backend.lib import known_paths, paths
from backend.lib.cross_site import refuse_cross_site

log = logging.getLogger(__name__)

#: Page size ceiling. 500 rows is already more than any screen shows; the cap
#: is what stops a client from asking for the 200,000-row response this whole
#: endpoint exists to replace.
MAX_PAGE_LIMIT = 500

#: Page size when a caller asks for a filtered/searched list without saying how
#: many rows it wants.
DEFAULT_PAGE_LIMIT = 200

#: Ceiling on ``GET /entries/ids``. Select-all over more than this is refused
#: (413) rather than answered with a list the client cannot hold.
MAX_SELECTABLE_IDS = 50_000

#: Ceiling on the ``ids`` form of ``POST /entries/bulk-delete``. Above this the
#: caller has to say what it wants with a filter instead of naming every row,
#: which is also what lets the server re-count before it deletes anything.
MAX_BULK_DELETE_IDS = 5_000

#: How many per-id failures one bulk-delete response carries. The rest are
#: implied by ``deleted + failures == total_matched``.
MAX_BULK_DELETE_ERRORS = 50

#: A paged row carries at most this much lyric text; the rest is only on the
#: single-entry read. A page of 500 songs with full lyrics is megabytes of
#: text nothing on screen displays.
LYRICS_PREVIEW_CHARS = 280

#: How many created entries the SYNCHRONOUS folder import echoes back. The
#: full count is always reported as ``created_total``.
MAX_SYNC_IMPORT_ENTRIES = 200

# MAX_REINDEX_ANALYSIS_ENQUEUE (the cap for POST /reindex?analyze=true) lives
# in store.py -- it is also reindex()'s own default max_enqueue, so a bare
# reindex() call is capped the same way even without going through this
# route. Imported above, not redefined here.


_store: Optional[LibraryStore] = None


def get_store() -> LibraryStore:
    global _store
    if _store is None:
        _store = LibraryStore(default_library_root())
    return _store


router = APIRouter()


def _attach_play_counts(
    store: LibraryStore,
    entries: list[dict[str, Any]],
    *,
    ids: Optional[list[str]] = None,
) -> None:
    """Merge the persistent play_count / last_played_at from the DB into entry
    dicts. The DB column is the source for these; entries with no DB row read 0.
    The frontend sorts on play_count, so it ships with every entry payload.

    ``ids`` restricts the lookup to one page (:meth:`LibraryDB.play_counts_for`).
    Without it, every entry is enriched (:meth:`LibraryDB.all_play_counts`) --
    both read only ``id, play_count, last_played_at`` (LIB-004): the unpaged
    path used to call :meth:`LibraryDB.list_entries` (``SELECT *``), reading
    every column of every row -- including ``metadata_json`` -- just to
    attach two numbers, which is ruinous once the library has 200,000 rows."""
    if store.db is None:
        for e in entries:
            e.setdefault("play_count", 0)
            e.setdefault("last_played_at", None)
        return
    if ids is None:
        rows: dict[str, Any] = store.db.all_play_counts()
    else:
        rows = store.db.play_counts_for(ids)
    for e in entries:
        row = rows.get(e["id"]) or {}
        e["play_count"] = int(row.get("play_count") or 0)
        e["last_played_at"] = row.get("last_played_at")


# Scalar analysis columns that are safe to expose on the entry verbatim. The
# `*_json` columns (embedded_tags_json / ffprobe_json / semantic_tags_json) are
# parsed separately below so the frontend never receives raw JSON strings.
_ANALYSIS_SCALAR_KEYS = (
    "bpm",
    "key",
    "key_confidence",
    "scale",
    "pitch_mean_hz",
    "pitch_std_hz",
    "loudness_lufs",
    "rms_db",
    "bars_estimated",
    "genre",
    "genre_confidence",
    "prompt_guess",
    "prompt_confidence",
    "analyzed_at",
)

# Selected file-technical keys pulled out of the ffprobe `_summary` blob so the
# inspector can show them as plain rows (sample rate, codec, …) without dumping
# the whole ffprobe payload.
_FFPROBE_SUMMARY_KEYS = (
    "sample_rate",
    "channels",
    "bit_depth",
    "bit_depth_is_float",
    "sample_fmt",
    "codec",
    "container",
    "duration_sec",
)


def _loose_json(text: Optional[str]) -> Any:
    """Tolerant JSON parse for the stored `*_json` analysis columns. Returns the
    decoded value for objects/arrays, or ``None`` for empty/invalid input — so a
    malformed column degrades to "absent" instead of raising mid-request."""
    if not text:
        return None
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, (dict, list)) else None


# WHY THIS ENRICHMENT EXISTS:
# The frontend was built to read ``entry.analysis`` (the Catalogue inspector's
# ANALYSIS section + library search by bpm/key/genre) and ``entry.embedded_tags``
# (the EMBEDDED TAGS section), but the entry payload never carried them — so
# those sections rendered empty and the stored analytics were effectively
# invisible. The two helpers below light them up. Both are additive + defensive:
# an entry with no analysis row is left exactly as-is.


def _analysis_payload(row: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Turn one stored analysis row into the ``(analysis, embedded_tags)`` pair
    the frontend consumes.

    ``analysis`` is a FLAT scalar dict with NULL columns dropped (so the UI only
    shows real data); ``embedded_tags`` is the parsed ID3/Vorbis/iTunes dict
    (empty when the file carried none). The stored ``*_json`` columns are parsed
    here so callers never receive raw JSON strings.
    """
    analysis: dict[str, Any] = {
        k: row[k] for k in _ANALYSIS_SCALAR_KEYS if row.get(k) is not None
    }
    semantic = _loose_json(row.get("semantic_tags_json"))
    if semantic:
        analysis["semantic_tags"] = semantic
    # File technicals live inside the ffprobe summary blob; surface a few.
    summary = _loose_json(row.get("ffprobe_json")) or {}
    summary = summary.get("_summary") if isinstance(summary, dict) else None
    if isinstance(summary, dict):
        for k in _FFPROBE_SUMMARY_KEYS:
            if summary.get(k) is not None:
                analysis.setdefault(k, summary[k])
    embedded = _loose_json(row.get("embedded_tags_json"))
    if not (isinstance(embedded, dict) and embedded):
        embedded = {}
    return analysis, embedded


def _apply_analysis(entry: dict[str, Any], row: Optional[dict[str, Any]]) -> None:
    """Merge one analysis ``row`` onto one ``entry`` dict in place. No-op when
    ``row`` is ``None`` (entry not analyzed) or yields nothing renderable."""
    if not row:
        return
    analysis, embedded = _analysis_payload(row)
    if analysis:
        entry["analysis"] = analysis
    if embedded:
        entry["embedded_tags"] = embedded


def _attach_analysis(
    store: LibraryStore,
    entries: list[dict[str, Any]],
    *,
    ids: Optional[list[str]] = None,
) -> None:
    """Bulk-enrich a LIST of entries with their analysis. ONE query for the
    whole list (no N+1), then an in-memory join by id. ``ids`` narrows that
    query to the page, instead of loading every analyzed entry in the
    library."""
    if store.db is None:
        return
    rows = (
        store.db.get_all_analysis() if ids is None else store.db.get_analysis_for(ids)
    )
    if not rows:
        return
    for e in entries:
        _apply_analysis(e, rows.get(e["id"]))


def _trim_lyrics(entry: dict[str, Any]) -> None:
    """Replace a long ``lyrics`` field with a preview, in place.

    A paged row is for a list: it needs enough text to show a snippet, not the
    whole song. The full text stays on ``GET /entries/{id}``. Short lyrics are
    left exactly as they are, so a row is only ever reshaped when there is
    something to save."""
    lyrics = entry.get("lyrics") or ""
    if len(lyrics) <= LYRICS_PREVIEW_CHARS:
        return
    entry.pop("lyrics", None)
    entry["lyrics_preview"] = lyrics[:LYRICS_PREVIEW_CHARS]
    entry["has_lyrics"] = True


def _attach_analysis_one(store: LibraryStore, entry: dict[str, Any]) -> None:
    """Enrich a SINGLE entry via a targeted ``get_analysis(id)`` lookup — so a
    single-entry GET never loads the entire analysis table (which the bulk
    helper would). Used by the per-id endpoint that inspectors hit on select."""
    if store.db is None:
        return
    _apply_analysis(entry, store.db.get_analysis(entry["id"]))


_KIND_FILTERS: dict[str, Optional[set[str]]] = {
    "audio": {"audio"},
    "video": {"video"},
    "image": {"image"},
    "media": {"video", "image"},
    "all": None,
}


def _entry_filters(
    kind: str,
    q: Optional[str],
    favorite: Optional[bool],
    source: Optional[str],
) -> EntryFilters:
    kinds = _KIND_FILTERS[kind]
    return EntryFilters(
        kinds=frozenset(kinds) if kinds is not None else None,
        favorite=favorite,
        source=source,
        q=q,
    )


def _validate_listing(kind: str, sort: Optional[str], offset: int) -> None:
    if kind not in _KIND_FILTERS:
        raise HTTPException(
            400, f"kind must be one of {sorted(_KIND_FILTERS)}, got {kind!r}"
        )
    if sort is not None and sort not in SORTS:
        raise HTTPException(400, f"sort must be one of {list(SORTS)}, got {sort!r}")
    if offset < 0:
        raise HTTPException(400, f"offset must be >= 0, got {offset}")


@router.get("/entries")
def list_entries(
    kind: str = "audio",
    limit: Optional[int] = None,
    offset: int = 0,
    q: Optional[str] = None,
    sort: Optional[str] = None,
    favorite: Optional[bool] = None,
    source: Optional[str] = None,
) -> dict[str, Any]:
    """The library list, in two shapes.

    With NONE of ``limit`` / ``offset`` / ``q`` / ``sort`` / ``favorite`` /
    ``source`` this is byte-for-byte the endpoint it has always been: every
    entry of the requested kind, plus ``count`` / ``root`` / ``kind``. Callers
    that predate paging keep working unchanged.

    With any of them it is paged: filtering, searching and sorting happen in
    SQL, records are built for the page only, and the response adds ``total``
    (rows matching the filters), ``offset``, ``limit`` and ``revision`` (the
    library revision the page was read at, so a client can drop a stale
    response). Long ``lyrics`` are replaced by ``lyrics_preview`` +
    ``has_lyrics``; the full text stays on ``GET /entries/{id}``.
    """
    # Default 'audio' preserves the historical behavior: the tracks/stems/
    # midi library never sees video/image entries. The VIDEO tab requests
    # ?kind=media (video + image); ?kind=all returns everything.
    _validate_listing(kind, sort, offset)
    if limit is not None and not (1 <= limit <= MAX_PAGE_LIMIT):
        raise HTTPException(400, f"limit must be 1..{MAX_PAGE_LIMIT}, got {limit}")
    store = get_store()

    paged = any(v is not None for v in (limit, q, sort, favorite, source)) or offset > 0
    if not paged:
        entries = [
            r.to_dict() for r in store.list_entries_fast(kinds=_KIND_FILTERS[kind])
        ]
        _attach_play_counts(store, entries)
        _attach_analysis(store, entries)
        return {
            "entries": entries,
            "count": len(entries),
            "root": str(store.root),
            "kind": kind,
        }

    if store.db is None:
        raise HTTPException(503, "library DB not available")
    page_limit = limit if limit is not None else DEFAULT_PAGE_LIMIT
    filters = _entry_filters(kind, q, favorite, source)
    entries = [
        r.to_dict()
        for r in store.list_entries_page(
            filters, sort=sort or DEFAULT_SORT, limit=page_limit, offset=offset
        )
    ]
    ids = [str(e["id"]) for e in entries]
    _attach_play_counts(store, entries, ids=ids)
    _attach_analysis(store, entries, ids=ids)
    for entry in entries:
        _trim_lyrics(entry)
    return {
        "entries": entries,
        "count": len(entries),
        "total": store.db.count_entries_filtered(filters),
        "offset": offset,
        "limit": page_limit,
        "revision": store.db.library_revision(),
        "kind": kind,
    }


@router.get("/entries/ids")
def list_entry_ids(
    kind: str = "audio",
    q: Optional[str] = None,
    sort: Optional[str] = None,
    favorite: Optional[bool] = None,
    source: Optional[str] = None,
) -> dict[str, Any]:
    """Every id matching the filters, in the same order the paged list uses.

    This is what select-all and shift-click ranges need: the client holds the
    ids, not the rows. Declared BEFORE ``/entries/{entry_id}`` so the literal
    path is not swallowed by the id parameter. Refuses (413) above
    ``MAX_SELECTABLE_IDS`` rather than streaming an unbounded list.
    """
    _validate_listing(kind, sort, 0)
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    filters = _entry_filters(kind, q, favorite, source)
    # One row past the cap comes back when there are more, so no second COUNT
    # is needed to tell "at the limit" from "over it".
    ids = store.db.list_entry_ids(
        filters, MAX_SELECTABLE_IDS, sort=sort or DEFAULT_SORT
    )
    if len(ids) > MAX_SELECTABLE_IDS:
        raise HTTPException(
            413,
            f"more than {MAX_SELECTABLE_IDS} entries match; narrow the filters "
            "or the search before selecting them all",
        )
    return {"ids": ids, "total": len(ids)}


@router.get("/entries/facets")
def entry_facets(
    fields: str,
    kind: str = "audio",
    q: Optional[str] = None,
    favorite: Optional[bool] = None,
    source: Optional[str] = None,
) -> dict[str, Any]:
    """Value counts for the filter dropdowns, over the WHOLE filtered library.

    ``fields`` is required and comma-separated; every value must be one of
    :data:`~backend.modules.library.db.FACET_FIELDS` (``model``, ``provider``,
    ``source``, ``kind``). Repeats are answered once, in the order first asked
    for. The remaining parameters are the paged list's filters and mean exactly
    the same thing here, so a dropdown can never offer a value the list would
    not show.

    Each field comes back as ``[{"value", "count"}]`` sorted by count
    descending then value ascending (the "unset" bucket last), capped at
    :data:`~backend.modules.library.db.MAX_FACET_VALUES`. ``revision`` is the
    library revision the counts were read at, so a client can drop a stale
    response -- the same field the paged list carries.

    Declared BEFORE ``/entries/{entry_id}`` so the literal path is not
    swallowed by the id parameter.
    """
    _validate_listing(kind, None, 0)
    requested = [part.strip() for part in fields.split(",") if part.strip()]
    if not requested:
        raise HTTPException(
            400, f"fields must name at least one of {list(FACET_FIELDS)}"
        )
    unknown = [name for name in requested if name not in FACET_FIELDS]
    if unknown:
        raise HTTPException(
            400, f"fields must be among {list(FACET_FIELDS)}, got {unknown}"
        )
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    filters = _entry_filters(kind, q, favorite, source)
    return {
        "facets": store.db.facet_counts(filters, requested),
        "revision": store.db.library_revision(),
    }


class BulkDeleteFilter(BaseModel):
    """The subset of the listing filters a bulk delete may target. ``kind``
    absent means EVERY kind -- an absent filter field never narrows, which is
    what makes ``{}`` mean "the whole library" and why it needs the ``all``
    guard."""

    q: Optional[str] = None
    kind: Optional[str] = None
    favorite: Optional[bool] = None
    source: Optional[str] = None


class BulkDeleteRequest(BaseModel):
    ids: Optional[list[str]] = None
    filter: Optional[BulkDeleteFilter] = None
    confirm_total: Optional[int] = None
    all: bool = False


@router.post("/entries/bulk-delete")
def bulk_delete_entries(req: BulkDeleteRequest) -> Any:
    """Delete many entries in one request. Two forms, exactly one per call.

    ``{"ids": [...]}`` deletes those entries, at most
    :data:`MAX_BULK_DELETE_IDS` of them.

    ``{"filter": {...}, "confirm_total": n}`` deletes everything the filter
    matches -- but the SERVER re-counts first, and if the count is not ``n`` it
    answers 409 with the count it saw and deletes NOTHING. That is the whole
    point of the form: the client is confirming a number it showed the user, so
    a library that changed underneath it must not be cleared on the strength of
    a stale one. An empty filter would match the whole library and is refused
    unless ``"all": true`` is sent alongside.

    Answers ``{deleted, failed, total_matched, revision}``. ``failed`` carries
    at most :data:`MAX_BULK_DELETE_ERRORS` entries, and
    ``deleted + (every failure) == total_matched`` always, so a client can tell
    how many failures were elided.

    Declared BEFORE ``/entries/{entry_id}`` so the literal path is not swallowed
    by the id parameter.
    """
    if (req.ids is None) == (req.filter is None):
        raise HTTPException(400, "send exactly one of 'ids' or 'filter'")
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")

    if req.ids is not None:
        if len(req.ids) > MAX_BULK_DELETE_IDS:
            raise HTTPException(
                400,
                f"at most {MAX_BULK_DELETE_IDS} ids per request, got {len(req.ids)}; "
                "use the filter form to clear more than that",
            )
        ids = list(dict.fromkeys(str(entry_id) for entry_id in req.ids))
        total_matched = len(ids)
    else:
        spec = req.filter
        assert spec is not None  # the exactly-one check above guarantees it
        if req.confirm_total is None:
            raise HTTPException(400, "'confirm_total' is required with 'filter'")
        if spec.kind is not None and spec.kind not in _KIND_FILTERS:
            raise HTTPException(
                400, f"kind must be one of {sorted(_KIND_FILTERS)}, got {spec.kind!r}"
            )
        narrows = (spec.q, spec.kind, spec.favorite, spec.source) != (
            None,
            None,
            None,
            None,
        )
        if not narrows and not req.all:
            raise HTTPException(
                400,
                "an empty filter matches the whole library; resend with "
                '"all": true to confirm that is what you mean',
            )
        filters = _entry_filters(spec.kind or "all", spec.q, spec.favorite, spec.source)
        # Read the matching ids FIRST, capped at what the client confirmed.
        # ``list_entry_ids`` answers at most ``confirm_total + 1`` of them, so
        # a length equal to ``confirm_total`` can only mean the library still
        # has exactly that many matches -- no second COUNT needed. Comparing
        # lengths with no trimming is what makes the deleted set exactly the
        # confirmed set: the previous code counted first, THEN re-read ids
        # newest-first and trimmed to the count, so a row written in that gap
        # landed at the front of the newest-first list and got deleted instead
        # of the oldest row the client actually confirmed.
        ids = store.db.list_entry_ids(filters, req.confirm_total)
        if len(ids) != req.confirm_total:
            # NOTHING has been deleted at this point, and nothing will be.
            # ``list_entry_ids`` saturates at ``confirm_total + 1``, so its
            # length is not the true count once the library has drifted by
            # more than one row -- only the refusal path pays for an exact
            # COUNT, so the total the client is told to re-confirm against
            # is real, not a capped stand-in for it.
            total_matched = store.db.count_entries_filtered(filters)
            return JSONResponse(
                status_code=409,
                content={
                    "detail": (
                        f"the library changed: {total_matched} entries match, not "
                        f"{req.confirm_total}. Re-read the count and try again."
                    ),
                    "total_matched": total_matched,
                },
            )
        total_matched = len(ids)

    result = store.delete_entries_bulk(ids)
    return {
        "deleted": result.deleted,
        "failed": result.failed[:MAX_BULK_DELETE_ERRORS],
        "total_matched": total_matched,
        "revision": store.db.library_revision(),
    }


@router.get("/entries/{entry_id}")
def get_entry(entry_id: str) -> dict[str, Any]:
    store = get_store()
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    data = record.to_dict()
    _attach_play_counts(store, [data])
    _attach_analysis_one(store, data)
    return data


@router.get("/entries/{entry_id}/path")
def get_entry_audio_path(entry_id: str) -> dict[str, Any]:
    """The absolute path of an entry's audio file on this machine.

    The footer's track menu reads it for Show in folder and Copy file path. A
    reference-in-place import resolves to the file where the user keeps it."""
    store = get_store()
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    audio_path = store.get_audio_path(entry_id)
    if audio_path is None or not audio_path.is_file():
        raise HTTPException(404, f"Entry {entry_id!r} has no audio file on disk")
    return {"id": entry_id, "path": str(audio_path.resolve())}


# Containers Chromium's media stack has no demuxer for. An <audio> pointed at
# one fails with DEMUXER_ERROR_COULD_NOT_OPEN and the UI reports "no supported
# sources" — verified on Chrome 152, where canPlayType('audio/aiff') is "".
# AIFF is the one that bites here (a whole DJ performance-set library is .aiff),
# but the rule is the check, not the list.
_BROWSER_UNPLAYABLE_SUFFIXES = frozenset({".aiff", ".aif", ".aifc", ".wma", ".ape"})
# Remuxed copies live beside the entry, in their own folder so they can never be
# mistaken for the source and never match AUDIO_EXTS scans of the entry dir.
_PLAYABLE_CACHE_DIRNAME = "_playable"


def _playable_audio(audio_path: Path, entry_dir: Optional[Path]) -> tuple[Path, str]:
    """``(path, media_type)`` the browser can actually open.

    libsndfile reads AIFF natively, so the fix is a remux to WAV — both are
    PCM, so only the header and the byte order change. Nothing is re-encoded
    and no bit depth is lost; the source's own subtype is carried over.

    Cached next to the entry, so a file costs this once rather than once per
    play, and re-done if the source is ever replaced. Any failure falls back
    to serving the original: a file the browser refuses is no worse than one
    that 500s, and the log says which happened.
    """
    guessed = mimetypes.guess_type(str(audio_path))[0] or "audio/wav"
    if audio_path.suffix.lower() not in _BROWSER_UNPLAYABLE_SUFFIXES:
        return audio_path, guessed

    cache_dir = (entry_dir or audio_path.parent) / _PLAYABLE_CACHE_DIRNAME
    cached = cache_dir / f"{audio_path.stem}.wav"
    try:
        if cached.is_file() and cached.stat().st_mtime >= audio_path.stat().st_mtime:
            return cached, "audio/wav"
    except OSError:
        pass

    try:
        import soundfile as sf

        from backend.lib.audio_io import load_audio_array, save_audio

        # Keep 24-bit masters 24-bit; only bump 8/16-bit sources to PCM_16.
        try:
            src_subtype = str(sf.info(str(audio_path)).subtype or "")
        except Exception:  # noqa: BLE001 — the read below is the real gate
            src_subtype = ""
        subtype = (
            "PCM_24"
            if any(w in src_subtype for w in ("24", "32", "FLOAT"))
            else "PCM_16"
        )

        data, sr = load_audio_array(audio_path)
        cache_dir.mkdir(parents=True, exist_ok=True)
        # Write to a sibling then rename: a half-written file is never served.
        staging = cached.with_suffix(".wav.part")
        save_audio(staging, data, sr, format="wav", subtype=subtype)
        staging.replace(cached)
        log.info(
            "library: remuxed %s -> %s (%s) for browser playback",
            audio_path.name,
            cached.name,
            subtype,
        )
        return cached, "audio/wav"
    except Exception as exc:  # noqa: BLE001 — fall back to the original, never 500
        log.warning(
            "library: could not remux %s for playback (%s); serving original",
            audio_path.name,
            exc,
        )
        return audio_path, guessed


@router.get("/audio/{entry_id}")
async def stream_audio(entry_id: str) -> Response:
    # CHANGED: support CDN-backed entries — if no local file exists but
    # metadata has a cdn_audio_url, proxy the audio from Suno CDN on demand.
    store = get_store()
    audio_path = store.get_audio_path(entry_id)
    if audio_path is not None and audio_path.is_file():
        # Decoding a long AIFF is seconds of blocking work; off the event loop
        # it goes, or every other request on the server stalls behind it.
        served, media_type = await asyncio.to_thread(
            _playable_audio, audio_path, store._dir_for(entry_id)
        )
        return FileResponse(
            path=str(served),
            media_type=media_type,
            filename=served.name,
        )
    # No local file — check for a CDN URL in metadata.
    # CHANGED: on first CDN fetch, persist the MP3 locally so subsequent
    # plays/sends are instant (no re-download). The entry becomes a
    # normal local file after this one-time lazy download.
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    if entry_dir is not None:
        meta = _read_metadata(entry_dir)
        cdn_url = (meta or {}).get("cdn_audio_url")
        if cdn_url:
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.get(cdn_url)
                    resp.raise_for_status()
                audio_bytes = resp.content
                # Cache to disk so future requests skip CDN.
                local_name = (meta or {}).get("audio_filename") or f"{entry_id}.mp3"
                local_path = entry_dir / local_name
                try:
                    local_path.write_bytes(audio_bytes)
                    log.info("library: cached CDN audio to %s", local_path)
                except OSError as write_err:
                    log.warning("library: failed to cache CDN audio: %s", write_err)
                return Response(
                    content=audio_bytes,
                    media_type="audio/mpeg",
                    headers={"X-Audio-Source": "cdn-proxy"},
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("library: CDN proxy failed for %s: %s", entry_id, exc)
    raise HTTPException(404, f"Audio for entry {entry_id!r} not found")


@router.get("/audio/{entry_id}/cover")
def stream_audio_cover(entry_id: str) -> FileResponse:
    """Serve the cover art for an audio entry (JPEG). Same shape as the media
    poster route: the store normalises everything to one file, so there is no
    content negotiation and a missing cover is a plain 404.

    A bulk-imported entry has no cover on disk (extraction is skipped to keep
    a 200,000-file import from reading every file's tags). ``extract_missing``
    makes the first request for one look, once per entry per process; a track
    that carries no picture still answers 404."""
    store = get_store()
    cover_path = store.get_cover_path(entry_id, extract_missing=True)
    if cover_path is None or not cover_path.is_file():
        raise HTTPException(404, f"Cover for entry {entry_id!r} not found")
    return FileResponse(path=str(cover_path), media_type="image/jpeg")


@router.post("/audio/{entry_id}/cover")
async def set_audio_cover(
    entry_id: str,
    file: Optional[UploadFile] = File(None),
) -> dict[str, Any]:
    """Attach or refresh an entry's cover art.

    With an uploaded image, that picture becomes the cover; with no upload,
    the entry's audio file is re-read for its embedded front cover. Both go
    through the same normalisation, so an entry can never end up holding a
    30MB PNG. 404 when the entry is unknown, 422 when nothing usable came
    back (no embedded picture, or an image we refused).
    """
    store = get_store()
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    # Audio only. A video/image entry has its own poster route and every list
    # path reports its cover_url as None, so accepting one here would write
    # art no surface can ever show and answer 200 for it.
    if entry.kind != "audio":
        raise HTTPException(404, f"Entry {entry_id!r} is not an audio entry")

    image_bytes: Optional[bytes] = None
    if file is not None:
        # Bounded read: an oversized upload is rejected without ever being
        # held in memory in full.
        image_bytes = await file.read(MAX_EMBEDDED_COVER_BYTES + 1)
        if not image_bytes:
            raise HTTPException(400, "empty image")
        if len(image_bytes) > MAX_EMBEDDED_COVER_BYTES:
            raise HTTPException(413, f"image exceeds {MAX_EMBEDDED_COVER_BYTES} bytes")

    cover_url = store.attach_cover(entry_id, image_bytes)
    if cover_url is None:
        raise HTTPException(
            422,
            "uploaded image could not be used as cover art"
            if file is not None
            else f"Entry {entry_id!r} has no embedded cover art",
        )
    return {
        "id": entry_id,
        "cover_url": cover_url,
        "source": "upload" if file is not None else "embedded",
    }


class CoverBackfillRequest(BaseModel):
    """``overwrite`` re-reads entries that already have art (use after a
    re-tag); ``limit`` caps how many entries one pass touches."""

    overwrite: bool = False
    limit: Optional[int] = None


@router.post("/covers/backfill")
def backfill_covers(
    req: CoverBackfillRequest = Body(default=CoverBackfillRequest()),
) -> dict[str, Any]:
    """Give already-imported audio entries the cover art their files carry.

    Entries imported before covers existed have none on disk; this walks them
    and extracts what is embedded. Idempotent, so it is safe to re-run."""
    limit = req.limit
    if limit is not None and limit < 1:
        raise HTTPException(400, "limit must be >= 1")
    return get_store().backfill_covers(overwrite=req.overwrite, limit=limit)


@router.get("/stems/{stem_id}/audio")
def stream_stem_audio(stem_id: str) -> FileResponse:
    """Serve the actual WAV bytes for one separated stem so the frontend
    can fetch it as a Blob and feed it into the editor / init / inpaint
    targets (the library audio endpoint only knows about parent tracks,
    not their stem children)."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    stem = store.db.get_stem(stem_id)
    if stem is None:
        raise HTTPException(404, f"stem {stem_id!r} not found")
    path = Path(stem.get("audio_path") or "")
    if not path.is_file():
        raise HTTPException(404, f"stem file missing on disk: {path}")
    mime, _ = mimetypes.guess_type(str(path))
    return FileResponse(
        path=str(path),
        media_type=mime or "audio/wav",
        filename=path.name,
    )


@router.patch("/stems/{stem_id}")
def update_stem(stem_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Mutate a stem row. Currently only ``favorite`` is user-mutable so
    stems behave like first-class library items."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if "favorite" in patch:
        ok = store.db.set_stem_favorite(stem_id, bool(patch["favorite"]))
        if not ok:
            raise HTTPException(404, f"stem {stem_id!r} not found")
    row = store.db.get_stem(stem_id)
    if row is None:
        raise HTTPException(404, f"stem {stem_id!r} not found")
    return dict(row)


@router.delete("/stems/{stem_id}")
def delete_stem(stem_id: str) -> dict[str, Any]:
    """Delete one separated stem (its WAV on disk + its DB row), leaving the
    parent track and sibling stems untouched."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    row = store.db.get_stem(stem_id)
    if row is None:
        raise HTTPException(404, f"stem {stem_id!r} not found")
    audio_path = Path(row.get("audio_path") or "")
    if audio_path.is_file():
        try:
            audio_path.unlink()
        except OSError as e:
            log.warning("library: failed to delete stem file %s: %s", audio_path, e)
    store.db.delete_stem(stem_id)
    return {"deleted": stem_id}


@router.get("/media/{entry_id}")
def stream_media(entry_id: str) -> FileResponse:
    """Stream a video/image library entry. FileResponse honors Range
    requests, which video scrubbing needs."""
    store = get_store()
    media_path = store.get_media_path(entry_id)
    if media_path is None or not media_path.is_file():
        raise HTTPException(404, f"Media for entry {entry_id!r} not found")
    mime, _ = mimetypes.guess_type(str(media_path))
    return FileResponse(
        path=str(media_path),
        media_type=mime or "application/octet-stream",
        filename=media_path.name,
    )


@router.get("/media/{entry_id}/thumb")
def stream_media_thumb(entry_id: str) -> FileResponse:
    """Serve the poster thumbnail for a media entry (JPEG)."""
    store = get_store()
    thumb_path = store.get_thumb_path(entry_id)
    if thumb_path is None or not thumb_path.is_file():
        raise HTTPException(404, f"Thumbnail for entry {entry_id!r} not found")
    return FileResponse(path=str(thumb_path), media_type="image/jpeg")


@router.post("/import-media")
async def import_media(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    """Import a video or image (kind='video'|'image'). Stores the original
    untouched, probes dimensions / duration / alpha, renders a poster."""
    try:
        meta_dict = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"metadata must be JSON: {e}")
    if not isinstance(meta_dict, dict):
        raise HTTPException(400, "metadata must be a JSON object")

    media_bytes = await file.read()
    if not media_bytes:
        raise HTTPException(400, "empty file")

    try:
        record = get_store().import_media(
            media_bytes=media_bytes,
            filename=file.filename or "import.bin",
            mime_type=file.content_type or "",
            metadata=meta_dict,
        )
    except ValueError as e:
        raise HTTPException(415, str(e))
    return record.to_dict()


class ImportFolderRequest(BaseModel):
    path: Optional[str] = None
    recursive: bool = True


def _enqueue_import_job(store: LibraryStore, job: ImportJob) -> None:
    """Hand one import job to the project's background queue.

    The queue's consumer awaits ``job.fn`` on the event loop, so the work goes
    through ``asyncio.to_thread`` -- the same shape every other library
    background job uses. The queue is idle-gated and single-consumer: a large
    import waits for the app to go quiet and, while it runs, nothing else
    heavy starts. That is the right ordering for a mass import, but it does
    mean the job may not begin the instant it is queued.
    """

    async def _run() -> None:
        import asyncio

        await asyncio.to_thread(store.run_import_job, job)

    try:
        from backend.core.background_workers import get_background_queue

        get_background_queue().enqueue(f"library-import:{job.id}", _run)
    except Exception as e:  # noqa: BLE001 - the job must report, not raise
        log.warning("library: failed to queue import job %s: %s", job.id, e)
        job.finish("failed", error=f"could not start the import: {e!r}")


@router.get("/import-jobs/{job_id}")
def get_import_job(job_id: str) -> dict[str, Any]:
    """Progress of one async folder import. Jobs live in this process only:
    an unknown id is a 404, including after a restart."""
    job = get_import_jobs().get(job_id)
    if job is None:
        raise HTTPException(404, f"import job {job_id!r} not found")
    return job.snapshot()


@router.delete("/import-jobs/{job_id}")
def cancel_import_job(job_id: str) -> dict[str, Any]:
    """Ask an import to stop. A running job stops after the batch in flight
    commits, so the library is left consistent and the import is resumable --
    re-running it skips everything already registered."""
    job = get_import_jobs().get(job_id)
    if job is None:
        raise HTTPException(404, f"import job {job_id!r} not found")
    job.cancel()
    return job.snapshot()


@router.post("/import-folder", dependencies=[Depends(refuse_cross_site)])
def import_folder(
    req: ImportFolderRequest = Body(default=ImportFolderRequest()),
    run_async: bool = Query(False, alias="async"),
) -> dict[str, Any]:
    """Add a local folder of audio as a playlist, REFERENCE-IN-PLACE: each file
    becomes a library entry that points at the on-disk file (no copy), so it
    plays / analyses like any track. With no ``path``, opens a native folder
    picker in the last music folder added. Returns the created entries; the
    caller builds the setlist.

    With ``?async=1`` the folder is validated here and the scan + registration
    move to a background job: the response is ``{job_id, status_url}`` and the
    caller polls. That is the only form that works for a folder of ~200,000
    songs -- the synchronous one holds a request open for the whole import and
    is capped at ``MAX_SYNC_IMPORT_ENTRIES`` echoed entries.
    """
    folder = req.path
    if not folder:
        from backend.core import folder_dialog

        try:
            folder = folder_dialog.pick_folder(
                title="Choose a music folder to add as a playlist",
                initial=known_paths.last_folder("library-folder"),
            )
        except folder_dialog.PickerError as e:
            raise HTTPException(e.status_code, str(e)) from e
    if not folder:
        return {"cancelled": True, "folder": None, "entries": []}
    root = Path(folder)
    if not root.is_dir():
        raise HTTPException(400, f"not a folder: {folder!r}")
    # Picked or typed, the folder is where the next picker opens.
    known_paths.record(root, "library-folder", source="library-folder")
    store = get_store()

    if run_async:
        job = get_import_jobs().create(folder=str(root), recursive=req.recursive)
        _enqueue_import_job(store, job)
        return {
            "job_id": job.id,
            "status_url": f"{store.api_prefix}/import-jobs/{job.id}",
        }

    paths = root.rglob("*") if req.recursive else root.iterdir()
    files = sorted(
        (p for p in paths if p.is_file() and p.suffix.lower() in AUDIO_EXTS),
        key=lambda p: str(p).lower(),
    )
    entries: list[dict[str, Any]] = []
    created_total = 0
    for f in files:
        rec = store.register_reference(str(f), {"source": "folder"})
        if rec is None:
            continue
        created_total += 1
        # Every entry is created; only the echo is bounded. A 200,000-file
        # folder would otherwise serialize the whole library into one response.
        if len(entries) < MAX_SYNC_IMPORT_ENTRIES:
            entries.append(rec.to_dict())
    return {
        "cancelled": False,
        "folder": str(root),
        "name": root.name,
        "entries": entries,
        "created_total": created_total,
    }


# ---------------------------------------------------------------------------
# Suno full-cache import: stage, then promote
# ---------------------------------------------------------------------------
#
# Two long jobs, both driven through the SAME ``/import-jobs/{id}`` routes as a
# folder import, because from the user's side they are the same thing: a huge
# import you start, watch, and may want to stop. Registered above the
# ``/{entry_id}/...`` routes so ``/suno/stage-report`` is never read as an
# entry id.


_PERF_SETS_DIRNAME = "performance-sets"


def _perf_sets_root() -> Path:
    """`<data>/performance-sets/` — where external set builders
    (Z-AutoDJ) drop prepared sets: one folder per set containing the audio
    files plus a `performance.json` timeline."""
    return paths.data_path(_PERF_SETS_DIRNAME)


def _load_perf_set(store: LibraryStore, set_dir: Path) -> Optional[dict[str, Any]]:
    """Turn one `<set_dir>/performance.json` into a frontend Setlist dict.

    Audio files are registered reference-in-place as library entries so the
    DJ decks + analysis pipeline treat them like any other track. A sidecar
    `.thedaw-import.json` in the set folder maps filename -> entryId so
    repeated calls reuse entries instead of duplicating them."""
    perf_path = set_dir / "performance.json"
    try:
        perf = json.loads(perf_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("performance set %s unreadable: %s", set_dir.name, e)
        return None
    tracks = perf.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        log.warning("performance set %s has no tracks", set_dir.name)
        return None

    sidecar_path = set_dir / ".thedaw-import.json"
    try:
        sidecar: dict[str, Any] = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        sidecar = {}
    if not isinstance(sidecar, dict):
        sidecar = {}
    sidecar_dirty = False

    resolved_set_dir = set_dir.resolve()
    entries: list[dict[str, Any]] = []
    for t in tracks:
        if not isinstance(t, dict):
            continue
        fname = t.get("file")
        if not isinstance(fname, str) or not fname:
            continue
        if (
            fname.startswith(("/", "\\"))
            or re.match(r"^[A-Za-z]:[\\/]", fname)
            or ".." in fname
        ):
            log.warning(
                "performance set %s: rejecting unsafe file %r", set_dir.name, fname
            )
            continue
        audio_path = (set_dir / fname).resolve()
        try:
            audio_path.relative_to(resolved_set_dir)
        except ValueError:
            log.warning(
                "performance set %s: file escapes set dir %r", set_dir.name, fname
            )
            continue
        if not audio_path.is_file():
            log.warning("performance set %s: missing audio %r", set_dir.name, fname)
            continue
        entry_id = sidecar.get(fname)
        if not (isinstance(entry_id, str) and store.get_entry(entry_id) is not None):
            rec = store.register_reference(
                str(audio_path),
                {
                    "source": "performance-set",
                    "title": t.get("title") or audio_path.stem,
                },
            )
            if rec is None:
                continue
            entry_id = rec.id
            sidecar[fname] = entry_id
            sidecar_dirty = True
        perf_block: dict[str, Any] = {}
        for src_key, dst_key in (
            ("cue_in_s", "cueIn"),
            ("mix_out_s", "mixOut"),
            ("transition_s", "transitionSec"),
        ):
            v = t.get(src_key)
            if isinstance(v, (int, float)) and v >= 0:
                perf_block[dst_key] = float(v)
        entry: dict[str, Any] = {
            "entryId": entry_id,
            "label": t.get("title") or audio_path.stem,
            "kind": "audio",
        }
        if perf_block:
            entry["perf"] = perf_block
        entries.append(entry)

    if sidecar_dirty:
        try:
            sidecar_path.write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
        except OSError as e:
            log.warning("performance set %s: sidecar write failed: %s", set_dir.name, e)

    if not entries:
        return None
    name = perf.get("name") if isinstance(perf.get("name"), str) else set_dir.name
    # Deterministic id including a content hash: a rebuilt set (new timeline)
    # gets a NEW id, so the frontend's merge-by-id import picks it up instead
    # of keeping a stale copy. Old copies stay in localStorage (harmless).
    digest = hashlib.sha1(
        json.dumps([e for e in entries], sort_keys=True).encode("utf-8")
    ).hexdigest()[:8]
    slug = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-") or "set"
    mtime_ms = int(perf_path.stat().st_mtime * 1000)
    return {
        "id": f"zad-{slug}-{digest}",
        "name": str(name),
        "entries": entries,
        "createdAt": mtime_ms,
        "updatedAt": mtime_ms,
        "notes": "Imported performance set (Z-AutoDJ)",
    }


@router.get("/setlists")
def list_bundled_setlists() -> dict[str, Any]:
    """Bundled/prepared setlists for the DJ tab. Scans
    `data/performance-sets/<Set>/performance.json` folders (dropped there by
    Z-AutoDJ or by hand) and returns them in the frontend Setlist shape.
    The frontend calls this on startup and merges by id (setlistStore
    `importBundled`); an empty list is a valid, cheap response."""
    root = _perf_sets_root()
    if not root.is_dir():
        return {"setlists": []}
    store = get_store()
    setlists: list[dict[str, Any]] = []
    for set_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if not (set_dir / "performance.json").is_file():
            continue
        loaded = _load_perf_set(store, set_dir)
        if loaded is not None:
            setlists.append(loaded)
    return {"setlists": setlists}


@router.post("/reindex")
def reindex_library(analyze: bool = False) -> dict[str, Any]:
    """Walk the on-disk library and upsert every entry into the SQLite mirror.
    Heals entries added to data/generations outside the API (dropped in by
    hand, synced from another machine, ...). store.reindex() is idempotent,
    so repeated calls are safe.

    ``analyze`` (query param, default ``false``) opts in to enqueuing
    background analysis for new/changed entries (LIB-002); the default is a
    heal-only pass that never analyzes, because a lost or empty DB next to an
    existing 200,000-entry library would otherwise make EVERY entry look
    "new" and mass re-analyze the whole thing -- the user's hard rule is
    never to do that. Even with ``analyze=true``, more than
    :data:`MAX_REINDEX_ANALYSIS_ENQUEUE` new/changed entries in one call
    enqueues none and reports ``analysis_skipped`` instead, rather than
    flooding the analysis worker."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    report: dict[str, Any] = {}
    reindexed = store.reindex(
        enqueue_analysis=analyze,
        max_enqueue=MAX_REINDEX_ANALYSIS_ENQUEUE,
        report=report,
    )
    if report.get("analysis_skipped"):
        return {
            "reindexed": reindexed,
            "analysis_skipped": report["analysis_skipped"],
            "reason": "too many entries to queue at once",
        }
    return {"reindexed": reindexed, "analysis_enqueued": report.get("enqueued", 0)}


@router.patch("/entries/{entry_id}")
def update_entry(entry_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    record = get_store().update_entry(entry_id, patch)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    return record.to_dict()


@router.post("/entries/{entry_id}/play")
def register_play(entry_id: str) -> dict[str, Any]:
    """Increment the persistent play counter. The player calls this when a
    track starts. Survives restarts (SQLite), and metadata edits / re-analysis
    leave it intact (upsert_entry never writes play_count)."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    new_count = store.db.increment_play_count(entry_id)
    if new_count is None:
        # On disk but missing a DB row (added out-of-band): sync, then retry.
        record = store.get_entry(entry_id)
        if record is None:
            raise HTTPException(404, f"Entry {entry_id!r} not found")
        entry_dir = store._dir_for(entry_id)  # noqa: SLF001
        meta = _read_metadata(entry_dir) if entry_dir is not None else None
        store._sync_record_to_db(record, meta or {})  # noqa: SLF001
        new_count = store.db.increment_play_count(entry_id) or 1
    return {"id": entry_id, "play_count": new_count}


class SuggestRequest(BaseModel):
    target_duration_sec: float = 1800.0
    bpm_min: Optional[float] = None
    bpm_max: Optional[float] = None
    harmonic: bool = True
    flow: str = "steady"
    genre: Optional[str] = None
    query: Optional[str] = None
    seed_id: Optional[str] = None
    max_tracks: int = 60


@router.post("/suggest-playlist")
def suggest_playlist_endpoint(req: SuggestRequest = Body(...)) -> dict[str, Any]:
    """Build an analysis-driven playlist (harmonic + bpm-flow sequencing) that
    fits the requested time budget. Needs the DB, where analysis lives."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    from .suggester import suggest_playlist

    return suggest_playlist(
        store.db,
        target_duration_sec=req.target_duration_sec,
        bpm_min=req.bpm_min,
        bpm_max=req.bpm_max,
        harmonic=req.harmonic,
        flow=req.flow,
        genre=req.genre,
        query=req.query,
        seed_id=req.seed_id,
        max_tracks=req.max_tracks,
    )


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: str) -> dict[str, Any]:
    ok = get_store().delete_entry(entry_id)
    if not ok:
        raise HTTPException(
            404, f"Entry {entry_id!r} not found or could not be deleted"
        )
    return {"deleted": entry_id}


@router.get("/summary")
def library_summary() -> dict[str, Any]:
    """Category counts for the library tab strip, plus the DB revision they
    were read at. Declared before the ``/{entry_id}/...`` routes so a literal
    path can never be swallowed by the entry-id parameter."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    return store.db.library_counts()


@router.get("/{entry_id}/bundle")
def download_bundle(entry_id: str) -> Response:
    store = get_store()
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analysis: Optional[dict[str, Any]] = None
    stems: list[dict[str, Any]] = []
    midis: list[dict[str, Any]] = []
    scores: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    if store.db is not None:
        analysis = store.db.get_analysis(entry_id)
        stems = store.db.list_stems(entry_id)
        midis = store.db.list_midis(entry_id)
        # Recover scores that exist on disk but lost their DB row, otherwise a
        # bundle silently ships without notation the entry demonstrably has.
        if entry_dir is not None:
            try:
                from backend.modules.notation.engine import register_on_disk_artifacts

                register_on_disk_artifacts(store.db, entry_dir, entry_id)
            except Exception as exc:  # noqa: BLE001 - recovery is best-effort
                log.debug("bundle: artifact recovery skipped for %s: %s", entry_id, exc)
        # Notation artifacts minus raw midi (already bundled under midi/).
        scores = [
            a
            for a in store.db.list_notation_artifacts(entry_id)
            if a.get("kind") != "midi"
        ]
        # Edges where entry is either parent or child.
        edges = store.db.list_relations(from_id=entry_id) + store.db.list_relations(
            to_id=entry_id
        )

    # Engrave a printable PDF for every sheet and tab in the bundle. Imported
    # here rather than at module scope so the library router keeps loading even
    # if the notation module is disabled or its deps are missing.
    pdf_renderer = None
    unity_package: Optional[Path] = None
    try:
        from backend.modules.notation.pdf_render import (
            available,
            render_musicxml_pdf,
            unity_package_dir,
        )

        if available()["ok"]:
            pdf_renderer = render_musicxml_pdf
        else:
            log.info("bundle: PDF engraving unavailable, shipping sources only")
        unity_package = unity_package_dir()
    except Exception as exc:  # noqa: BLE001 - a bundle must never fail over extras
        log.info("bundle: notation extras unavailable (%s)", exc)

    # The Unity flying-notation chart, written to a scratch file for the zip. It
    # is derived from the first sheet rather than stored, so it always matches
    # the notation actually in the bundle.
    with tempfile.TemporaryDirectory() as staging:
        unity_chart: Optional[Path] = None
        sheet = next(
            (
                Path(s["path"])
                for s in scores
                if str(s.get("kind")) == "musicxml"
                and Path(s.get("path") or "").is_file()
            ),
            None,
        )
        if sheet is not None:
            try:
                from backend.modules.notation.engine import artist_name, clean_title
                from backend.modules.notation.exporters.notechart import write_notechart

                candidate = Path(staging) / f"{sheet.stem}.notechart.json"
                result = write_notechart(
                    sheet,
                    candidate,
                    title=clean_title(record.title or ""),
                    artist=artist_name(),
                    entry_id=entry_id,
                )
                if result.get("ok") and candidate.is_file():
                    unity_chart = candidate
                else:
                    log.info("bundle: note chart skipped (%s)", result.get("error"))
            except Exception as exc:  # noqa: BLE001 - a bundle must never fail over extras
                log.info("bundle: note chart unavailable (%s)", exc)

        data = build_bundle_bytes(
            entry_id=entry_id,
            record=record.to_dict(),
            audio_path=audio_path,
            metadata_path=metadata_path,
            analysis=analysis,
            stems=stems,
            midis=midis,
            scores=scores,
            lineage_edges=edges,
            pdf_renderer=pdf_renderer,
            unity_chart=unity_chart,
            unity_package_dir=unity_package,
        )

    safe_title = "".join(
        c if c.isalnum() or c in "-_." else "_" for c in (record.title or "entry")
    )[:60]
    filename = f"{safe_title}_{entry_id[:8]}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{entry_id}/lineage")
def get_lineage(entry_id: str, depth: int = 3) -> dict[str, Any]:
    """Return nodes + edges within ``depth`` hops of ``entry_id``.

    BFS over the ``relations`` table in both directions (parents AND
    children). Cheap because edges are indexed both ways."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    depth = max(0, min(int(depth), 10))
    seen_ids: set[str] = {entry_id}
    edges: list[dict[str, Any]] = []
    frontier: list[str] = [entry_id]
    for _ in range(depth):
        next_frontier: list[str] = []
        for node_id in frontier:
            outgoing = store.db.list_relations(from_id=node_id)
            incoming = store.db.list_relations(to_id=node_id)
            for e in outgoing + incoming:
                edges.append(e)
                for nb in (e["from_id"], e["to_id"]):
                    if nb not in seen_ids:
                        seen_ids.add(nb)
                        next_frontier.append(nb)
        frontier = next_frontier
        if not frontier:
            break

    # Materialize node payloads for everything we touched.
    nodes: list[dict[str, Any]] = []
    for node_id in seen_ids:
        node_row = store.db.get_entry(node_id)
        if node_row is not None:
            nodes.append(
                {
                    "id": node_id,
                    "kind": "entry",
                    "title": node_row.get("title"),
                    "source": node_row.get("source"),
                    "duration_sec": node_row.get("duration_sec"),
                }
            )
        else:
            # Stem / midi / external label — keep it in the graph
            # without a full row so the visualization can show it as
            # a placeholder.
            nodes.append({"id": node_id, "kind": "external"})

    # Dedup edges by (from, to, kind).
    seen_edges = set()
    deduped_edges: list[dict[str, Any]] = []
    for e in edges:
        key = (e["from_id"], e["to_id"], e["kind"])
        if key in seen_edges:
            continue
        seen_edges.add(key)
        deduped_edges.append(e)

    return {"root": entry_id, "nodes": nodes, "edges": deduped_edges}


@router.get("/_all/stems")
def list_all_stems() -> dict[str, Any]:
    """Return every stem across every entry, joined to the parent
    entry's title for grouping in the UI."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out = store.db.list_all_stems()
    return {"stems": out, "count": len(out)}


@router.get("/_all/midi")
def list_all_midi() -> dict[str, Any]:
    """Return every MIDI file across every entry, joined to the parent
    entry's title."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out = store.db.list_all_midis()
    return {"midis": out, "count": len(out)}


@router.get("/_all/scores")
def list_all_scores() -> dict[str, Any]:
    """Return every notation/score artifact across every entry, joined to the
    parent entry's title. Excludes raw ``midi`` artifacts (those live in the
    MIDI tab); keeps sheets, tabs, arrangements, and exports."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out = [
        art
        for art in store.db.list_all_notation_artifacts()
        if art.get("kind") != "midi"
    ]
    return {"scores": out, "count": len(out)}


@router.get("/_graph/all")
def get_full_graph() -> dict[str, Any]:
    """Return EVERY entry + relation in the library, PLUS virtual nodes
    for stems / midis / external source-labels referenced in edges but
    not present in the entries table. Without those virtual nodes the
    genealogy view sees chimera-children as orphans (their from_id is a
    file-name string, not an entry id) and the layered layout collapses
    to one row. Cheap up to a few thousand entries; if it grows large
    we'll paginate later."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    raw_entries = store.db.list_entries()
    raw_edges = store.db.list_relations()

    entries_by_id: dict[str, dict[str, Any]] = {r["id"]: r for r in raw_entries}
    nodes: list[dict[str, Any]] = [
        {
            "id": r["id"],
            "kind": "entry",
            "title": r.get("title"),
            "source": r.get("source"),
            "duration_sec": r.get("duration_sec"),
            "model": r.get("model"),
            # The genealogy/3D-graph header can highlight most-played nodes.
            "play_count": int(r.get("play_count") or 0),
        }
        for r in raw_entries
    ]
    seen_ids = set(entries_by_id.keys())

    # Look up stems + midis once so we can label virtual nodes nicely.
    all_stems: dict[str, dict[str, Any]] = {
        s["id"]: s for s in store.db.list_all_stems()
    }
    all_midis: dict[str, dict[str, Any]] = {
        m["id"]: m for m in store.db.list_all_midis()
    }

    for edge in raw_edges:
        for ref in (edge["from_id"], edge["to_id"]):
            if ref in seen_ids:
                continue
            seen_ids.add(ref)
            if ref in all_stems:
                stem = all_stems[ref]
                nodes.append(
                    {
                        "id": ref,
                        "kind": "stem",
                        "title": stem.get("stem_name") or ref,
                        "source": "stem",
                        "model": stem.get("model"),
                    }
                )
            elif ref in all_midis:
                midi = all_midis[ref]
                nodes.append(
                    {
                        "id": ref,
                        "kind": "midi",
                        "title": Path(midi.get("midi_path") or ref).stem,
                        "source": "midi",
                        "model": midi.get("engine"),
                    }
                )
            else:
                # Chimera source-label or external reference.
                nodes.append(
                    {
                        "id": ref,
                        "kind": "external",
                        "title": ref,
                        "source": "external",
                    }
                )

    return {"nodes": nodes, "edges": raw_edges, "count": len(nodes)}


@router.post("/import")
async def import_entry(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    try:
        meta_dict = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"metadata must be JSON: {e}")
    if not isinstance(meta_dict, dict):
        raise HTTPException(400, "metadata must be a JSON object")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "empty file")

    record = get_store().import_blob(
        audio_bytes=audio_bytes,
        filename=file.filename or "import.wav",
        mime_type=file.content_type or "audio/wav",
        metadata=meta_dict,
    )
    return record.to_dict()


# Optional local extension. ``suno_routes`` (bulk provider-cache ingestion) is
# not part of the repository; when the module is absent the library simply has
# no such routes. Included last so everything it borrows from this module
# already exists.
try:
    from . import suno_routes as _suno_routes
except ImportError:
    _suno_routes = None
else:
    router.include_router(_suno_routes.router)
