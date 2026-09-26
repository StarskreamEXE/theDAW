"""Orchestrate the analysis steps for a single library entry.

Read settings to decide what to run, run each step (ffprobe, tempo,
key, pitch, bars, rms), then write results to:

  - SQLite ``analysis`` table (one row per entry)
  - metadata.json next to the audio file (durable backup)
  - Update the entry's ``analysis_status`` field on the entries row

This module is callable from sync code; the BackgroundQueue wraps it in
an async shim. We deliberately avoid asyncio inside the engine so it can
also be invoked directly from a manual ``/run`` endpoint.

Analysis is a BACKGROUND writer of an entry's ``metadata.json``, so it
routinely overlaps a user editing the same entry in the UI. That file is the
library's source of truth, which is why :func:`persist_analysis` does its
read-modify-write under the library store's metadata lock and writes through
the store's own atomic writer rather than keeping a second, unsynchronized
copy of that logic here. See :func:`_metadata_guard`.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from backend.modules.library import store as library_store
from backend.modules.library.db import LibraryDB

from .bars import estimate_bars, estimate_loudness_lufs, estimate_rms_db
from .ffprobe import probe_file
from .key import detect_key
from .pitch import detect_pitch_stats

log = logging.getLogger(__name__)

#: Set once this process has written an entry's ``metadata.json`` with no
#: store to lock against (see :func:`_metadata_guard`). One debug line per
#: process, not one per analysis: on a library this size that would be tens
#: of thousands of identical lines.
_logged_unguarded_write = False


# Bump when the analysis pipeline changes in a way that should re-run already-
# analyzed tracks. v2: tempo now falls back to librosa so MP3s actually get a
# BPM (v1 rows persisted bpm=null because aubio can't open MP3). v3: rows now
# record whether the samples are float, which bit_depth alone never said — 32
# means pcm_s32le and pcm_f32le equally. The GET endpoint reports
# version<ANALYSIS_VERSION rows as 'pending' so they re-run.
#
# loudness_lufs is now actually computed (pyloudnorm) instead of always
# persisting null (LIB-003), but this deliberately did NOT bump the version:
# with ~200k library rows, a bump marks every row stale and re-decodes/
# re-analyzes the whole library on idle for one new field. New analyses, and
# any row re-analyzed for its own reasons, get loudness; nothing mass-requeues.
ANALYSIS_VERSION = 3

#: Analysis profiles.
#:
#: ``"full"`` runs every step and is what a catalogue / enrichment pass wants.
#:
#: ``"dj"`` runs ONLY what a DJ deck reads off a track — ffprobe, one shared
#: librosa decode, tempo + beats (and the detector's confidence), key, RMS —
#: and skips the two most expensive steps, neither of which the DJ tab shows:
#:
#:   * ``librosa.pyin`` pitch statistics: 6.5 s of an 11.4 s step budget on a
#:     3–4 minute MP3, i.e. more than half the analysis, for a number no deck
#:     reads.
#:   * integrated loudness: a SECOND full decode at the file's native rate and
#:     channel count, on top of the shared 22.05 kHz mono one (1.6 s).
#:
#: LUFS is deliberately NOT recomputed from the shared mono decode instead of
#: being skipped: BS.1770 weights channels, and a mono sum reads up to ~9.5 dB
#: low on wide stereo (see :func:`~backend.modules.analysis.bars.estimate_loudness_lufs`).
#: Cheap and exact are mutually exclusive here, so a ``dj`` run leaves the
#: field alone for a full run to fill rather than writing a wrong number into
#: a column other code trusts.
PROFILE_FULL = "full"
PROFILE_DJ = "dj"

#: Key stamped into the persisted ffprobe blob by a partial run, so a later
#: enrichment pass can find rows that still need the expensive steps. A full
#: run rewrites that blob wholesale and the key disappears with it, which is
#: what makes "the full run overwrites" true; a row with no key at all is a
#: full row, matching every row written before profiles existed.
PROFILE_MARKER_KEY = "_analysis_profile"

#: The persisted fields a ``dj`` run does not measure. ``upsert_analysis``
#: writes the WHOLE row, so a partial payload would null these out on an
#: entry that already had them — see :func:`_carry_forward_partial`.
_PARTIAL_PROFILE_FIELDS = (
    "pitch_mean_hz",
    "pitch_std_hz",
    "loudness_lufs",
    "prompt_guess",
    "prompt_confidence",
)


def analyze_audio(
    audio_path: Path,
    *,
    include_key: bool = True,
    include_pitch: bool = True,
    include_genre: bool = False,
    include_prompt: bool = True,
    profile: str = PROFILE_FULL,
) -> dict[str, Any]:
    """Pure analysis call — runs the configured steps, returns a flat
    dict. Idempotent; doesn't touch any persistence.

    ``profile`` selects WHICH steps run; see :data:`PROFILE_DJ`. It overrides
    ``include_pitch`` / ``include_prompt`` rather than being overridden by
    them, so a caller cannot ask for the DJ profile and still pay for pyin."""
    p = Path(audio_path)
    if not p.is_file():
        return {"error": "audio not found"}

    dj = profile == PROFILE_DJ
    if dj:
        # Both are pure cost for a deck: pyin dominates the step budget, and
        # the prompt generator would build a weaker prompt out of the fields
        # this profile deliberately does not measure and persist it over a
        # better one. /api/analysis/{id}/prompt regenerates prompts from the
        # stored row on read, so skipping it here costs no surface anything.
        include_pitch = False
        include_prompt = False

    out: dict[str, Any] = {
        "version": ANALYSIS_VERSION,
        "analyzed_at": time.time(),
        "profile": profile,
    }

    # ffprobe summary (sample rate, bit depth, codec, duration, ...)
    probe = probe_file(p)
    if dj:
        probe[PROFILE_MARKER_KEY] = PROFILE_DJ
    out["ffprobe"] = probe
    summary = probe.get("_summary") or {}
    out["sample_rate"] = summary.get("sample_rate")
    out["channels"] = summary.get("channels")
    out["bit_depth"] = summary.get("bit_depth")
    out["bit_depth_is_float"] = summary.get("bit_depth_is_float")
    out["codec"] = summary.get("codec")
    out["container"] = summary.get("container")
    duration_sec = summary.get("duration_sec")
    if duration_sec is not None:
        out["duration_sec"] = float(duration_sec)

    # Decode ONCE for the librosa-backed steps. Tempo fallback, RMS, key,
    # and pitch all historically called librosa.load(path, sr=22050,
    # mono=True) verbatim, so one shared decode replaces up to four
    # full-file decodes per analysis. On failure each helper falls back to
    # its own load and keeps its own error logging.
    try:
        import librosa

        y_sr: Optional[tuple] = librosa.load(str(p), sr=22050, mono=True)
    except Exception:
        y_sr = None

    # Tempo + beats (reuse chimera detector — it's the single source of
    # truth for BPM in this codebase).
    try:
        from backend.modules.chimera.detect import detect_tempo_and_beats

        tempo = detect_tempo_and_beats(p, y_sr=y_sr)
        out["bpm"] = tempo["bpm"]
        out["beats"] = list(tempo["beats"])
        # The detector has always computed this (aubio averages its per-hop
        # confidence; the librosa path derives one from beat-interval
        # spread) and it was thrown away here. A DJ needs it: a 0.1
        # confidence BPM is a number to show greyed out, not to beatmatch on.
        conf = tempo.get("confidence")
        out["bpm_confidence"] = float(conf) if isinstance(conf, (int, float)) else None
    except Exception as e:
        log.info("analysis.engine: tempo failed for %s: %s", p.name, e)
        out["bpm"] = None
        out["beats"] = []
        out["bpm_confidence"] = None

    out["bars_estimated"] = estimate_bars(out.get("beats") or [])
    out["rms_db"] = estimate_rms_db(p, y_sr=y_sr)
    # Native decode inside estimate_loudness_lufs — NOT the shared y_sr mono
    # decode the steps above use (see estimate_loudness_lufs' docstring), so
    # the dj profile skips it outright rather than paying a second decode.
    out["loudness_lufs"] = None if dj else estimate_loudness_lufs(p)

    if include_key:
        out.update(detect_key(p, y_sr=y_sr))
    if include_pitch:
        out.update(detect_pitch_stats(p, y_sr=y_sr))
    if include_genre:
        # Reserved — see plan §4.1. Heavy HF dep; skipping for now.
        out["genre"] = None
        out["genre_confidence"] = None

    if include_prompt:
        # Deterministic semantic tags + a Stable Audio-style prompt from the
        # numbers above. Cheap and pure; ML genre/mood enrichers (when added)
        # fold in via the ``genre`` field and embedded tags at persist time.
        from .prompt import generate_prompt

        generated = generate_prompt(out)
        out["prompt_guess"] = generated["prompt_guess"]
        out["prompt_confidence"] = generated["prompt_confidence"]
        out["semantic_tags"] = generated["semantic_tags"]

    return out


def _is_within(child: Path, parent: Path) -> bool:
    """Whether ``child`` lies under ``parent``.

    Case-insensitively on Windows, where the same directory reaches us as
    ``C:\\Users\\...`` from one caller and ``c:\\users\\...`` from another.
    Same idiom as ``backend/modules/candidates/store.py``'s ``_is_within``.
    """
    try:
        target = os.path.normcase(str(child.resolve()))
        root = os.path.normcase(str(parent.resolve()))
    except OSError:
        return False
    return target.startswith(root + os.sep)


def _store_guarding(
    metadata_path: Path, store: Optional[library_store.LibraryStore]
) -> Optional[library_store.LibraryStore]:
    """The :class:`~backend.modules.library.store.LibraryStore` that owns
    ``metadata_path``, or None when this process has none.

    A caller that hands us its store is preferred; otherwise we look for the
    app's singleton. It is looked up, never BUILT: constructing a
    ``LibraryStore`` opens the library database and auto-reindexes when that
    database is empty, which on this library means walking 200,000 entries --
    absurd for a writer that only needs a mutex, and it would point at the
    real library from a test or a CLI. So a process that has not already
    built one (a script, a unit test with its own root) simply gets None.

    Either way the store has to actually own the file: its lock only
    serializes writers holding THAT object, so a store rooted somewhere else
    would be a mutex nobody else takes -- the appearance of safety.
    """
    if store is not None and _is_within(metadata_path, Path(store.root)):
        return store
    try:
        from backend.modules.library import router as library_router
    except ImportError:  # pragma: no cover - the library module is always there
        return None
    # The module-level singleton `get_store()` memoizes. Read directly so an
    # absent one stays absent (see above); `get_store()` would create it.
    existing = getattr(library_router, "_store", None)
    if existing is not None and _is_within(metadata_path, Path(existing.root)):
        return existing
    return None


def _metadata_guard(
    metadata_path: Path, store: Optional[library_store.LibraryStore]
) -> contextlib.AbstractContextManager[Any]:
    """The mutex that serializes writes to one entry's ``metadata.json``.

    ``LibraryStore._meta_lock`` when this process has the store that owns the
    file -- the same lock ``update_entry`` takes, which is the whole point:
    analysis runs in the background while the user rates, tags and edits
    lyrics on the very entry being analyzed, and two unsynchronized
    read-modify-writes of one JSON document lose whichever edit was read
    first. On disk, permanently: ``reindex()`` rebuilds the database FROM
    these files, so it would copy the loss rather than repair it.

    Otherwise a null guard. The write itself is still atomic and still uses
    a unique temp file, so an unguarded write can corrupt nothing; what it
    cannot do is stop a concurrent writer's edit from being overwritten.
    """
    owner = _store_guarding(metadata_path, store)
    if owner is not None:
        return owner._meta_lock  # noqa: SLF001 — the documented shared lock
    global _logged_unguarded_write
    if not _logged_unguarded_write:
        _logged_unguarded_write = True
        log.warning(
            "analysis.engine: no library store owns %s — writing it atomically "
            "but unlocked (no store in this process)",
            metadata_path,
        )
    return contextlib.nullcontext()


def _read_entry_metadata(metadata_path: Path) -> Optional[dict[str, Any]]:
    """One entry's ``metadata.json`` as a dict, or None when it is unusable.

    None means DAMAGED -- missing, unreadable, not JSON, or JSON that is not
    an object -- and the caller must then leave the file ALONE. Writing over
    it would replace an entry's whole record (title, tags, rating, notes,
    lyrics, prompt) with a document holding nothing but the analysis we just
    computed, which is worse than the damage and is not repairable from the
    database. Same policy as
    :meth:`~backend.modules.library.store.LibraryStore.record_detected_providers`.

    Called INSIDE :func:`_metadata_guard`'s critical section; a read taken
    before the lock is exactly the stale copy the lock exists to prevent.
    """
    try:
        loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning(
            "analysis.engine: %s is unreadable (%s) — leaving it untouched",
            metadata_path,
            e,
        )
        return None
    if not isinstance(loaded, dict):
        log.warning(
            "analysis.engine: %s does not hold a JSON object — leaving it untouched",
            metadata_path,
        )
        return None
    return loaded


def persist_analysis(
    db: LibraryDB,
    entry_id: str,
    payload: dict[str, Any],
    *,
    metadata_path: Optional[Path] = None,
    embedded_tags: Optional[dict[str, Any]] = None,
    store: Optional[library_store.LibraryStore] = None,
) -> None:
    """Write analysis payload to SQLite + (optionally) the per-entry
    metadata.json so the data is portable even if the DB is wiped.

    ``metadata_path`` is an entry's own ``metadata.json``; the entry
    directory it is written back through is its parent.

    ``store`` is the library store that owns that entry, when the caller has
    one — it supplies the lock the file's other writers take. Omitted, the
    app's existing singleton is used if it owns the file; see
    :func:`_metadata_guard` for what happens when neither is available.

    The analysis itself is mirrored to the database by ``upsert_analysis``
    into the ``analysis`` table, which is what every reader of an analysis
    uses (``library/router.py`` builds ``entry["analysis"]`` from that row).
    ``$.analysis`` inside the ``entries.metadata_json`` column is read by
    nothing — no SQL, no Python, no frontend — so this deliberately does not
    mirror the metadata document into that column: it is a durable backup of
    the analysis for a wiped database, not a second source of truth.
    """
    db_payload = {
        "bpm": payload.get("bpm"),
        "bpm_confidence": payload.get("bpm_confidence"),
        "beats": payload.get("beats") or [],
        "key": payload.get("key"),
        "key_confidence": payload.get("confidence")
        if "confidence" in payload and "key" in payload
        else payload.get("key_confidence"),
        "scale": payload.get("scale"),
        "pitch_mean_hz": payload.get("pitch_mean_hz"),
        "pitch_std_hz": payload.get("pitch_std_hz"),
        "loudness_lufs": payload.get("loudness_lufs"),
        "rms_db": payload.get("rms_db"),
        "bars_estimated": payload.get("bars_estimated"),
        "genre": payload.get("genre"),
        "genre_confidence": payload.get("genre_confidence"),
        "prompt_guess": payload.get("prompt_guess"),
        "prompt_confidence": payload.get("prompt_confidence"),
        "semantic_tags": payload.get("semantic_tags") or [],
        "embedded_tags": embedded_tags or {},
        "ffprobe": payload.get("ffprobe") or {},
        "version": payload.get("version") or ANALYSIS_VERSION,
    }
    db.upsert_analysis(entry_id, db_payload)

    if metadata_path is not None and metadata_path.is_file():
        # One writer at a time per entry, across the WHOLE read-modify-write,
        # and the read taken inside it — the store's writers hold this same
        # lock over the same span.
        with _metadata_guard(metadata_path, store):
            meta = _read_entry_metadata(metadata_path)
            if meta is not None:
                meta["analysis"] = {
                    k: v for k, v in payload.items() if k != "ffprobe" and k != "beats"
                }
                meta["analysis"]["beats_count"] = len(payload.get("beats") or [])
                try:
                    # The store's writer, not a second copy of it: a unique
                    # temp file in the entry's own directory, atomically
                    # renamed into place, removed if anything fails. The
                    # fixed ``metadata.json.tmp`` this used to write was
                    # shared with every other writer of the same entry —
                    # their bytes mixed in that one file and the mixture was
                    # renamed over the real document.
                    library_store._write_metadata(metadata_path.parent, meta)  # noqa: SLF001
                except OSError as e:
                    log.warning(
                        "analysis.engine: failed to write metadata.json for %s: %s",
                        entry_id,
                        e,
                    )


def analyze_and_persist(
    db: LibraryDB,
    entry_id: str,
    audio_path: Path,
    *,
    metadata_path: Optional[Path] = None,
    settings: Optional[dict[str, Any]] = None,
    store: Optional[library_store.LibraryStore] = None,
    profile: str = PROFILE_FULL,
) -> dict[str, Any]:
    """End-to-end: run analysis, persist to DB + metadata.json, update
    the entry's ``analysis_status`` to 'complete'.

    ``profile`` selects which steps run (see :data:`PROFILE_DJ`). A partial
    profile still persists, and still marks the entry 'complete' -- what it
    computed IS complete and correct -- but it never erases what it did not
    compute; see :func:`_carry_forward_partial`.

    ``store`` is passed straight to :func:`persist_analysis`, which needs it
    to take the same metadata lock the store's own writers take.

    Returns the full analysis payload (useful for the manual /run
    endpoint to echo back to the caller)."""
    settings = settings or {}
    include_key = bool(settings.get("include_key", True))
    include_genre = bool(settings.get("include_genre", False))

    # Some library rows are derived/variant entries (e.g. "<id>_00") that are
    # listed but have no row in `entries`; persisting analysis for them violates
    # the analysis→entries foreign key. Detect that up front so we still COMPUTE
    # + return the analysis (the UI gets BPM/key) but skip the DB write instead
    # of raising a 500.
    entry_exists = db.get_entry(entry_id) is not None

    # Mark running so the UI can show a chip. No revision bump: 'running' is
    # a chip that lasts seconds, and every bump of ``library_revision`` makes
    # each connected client refetch the entry list. Bumping here made that
    # TWICE per analysis (once for 'running', once for 'complete') -- across a
    # library-wide sweep, one wasted full list refetch per track.
    if entry_exists:
        _set_status(db, entry_id, "running", bump_revision=False)
    try:
        payload = analyze_audio(
            audio_path,
            include_key=include_key,
            include_pitch=True,
            include_genre=include_genre,
            profile=profile,
        )
        if not entry_exists:
            log.info(
                "analysis.engine: %s has no entries row (derived/variant?) — "
                "computed analysis but not persisting",
                entry_id,
            )
            return payload
        # Pull embedded tags from metadata.json if present so we
        # persist them alongside analysis (keeps everything in one
        # place for downstream lineage / dataset export).
        embedded: dict[str, Any] = {}
        if metadata_path and metadata_path.is_file():
            try:
                m = json.loads(metadata_path.read_text(encoding="utf-8"))
                if isinstance(m.get("embedded_tags"), dict):
                    embedded = m["embedded_tags"]
            except (OSError, json.JSONDecodeError):
                pass

        # Fold any embedded tags into a richer prompt than the analysis-only
        # baseline computed in analyze_audio.
        if embedded:
            from .prompt import generate_prompt

            entry_row = db.get_entry(entry_id) or {}
            regenerated = generate_prompt(
                payload,
                embedded_tags=embedded,
                title=str(entry_row.get("title") or ""),
            )
            payload["prompt_guess"] = regenerated["prompt_guess"]
            payload["prompt_confidence"] = regenerated["prompt_confidence"]
            payload["semantic_tags"] = regenerated["semantic_tags"]

        if profile != PROFILE_FULL:
            _carry_forward_partial(db, entry_id, payload)

        persist_analysis(
            db,
            entry_id,
            payload,
            metadata_path=metadata_path,
            embedded_tags=embedded,
            store=store,
        )
        _set_status(db, entry_id, "complete")
        return payload
    except Exception as e:
        log.warning("analysis.engine: failed for %s: %s", entry_id, e)
        _set_status(db, entry_id, "failed")
        raise


def _carry_forward_partial(
    db: LibraryDB, entry_id: str, payload: dict[str, Any]
) -> None:
    """Keep what a partial profile did not measure.

    INVARIANT: a partial (``dj``) analysis never erases a field a previous
    full analysis measured.

    ``upsert_analysis`` writes the WHOLE row, so persisting a dj payload
    verbatim would null out ``pitch_mean_hz``, ``pitch_std_hz`` and
    ``loudness_lufs`` -- and blank the prompt -- on an entry that already had
    them: a 4-second run destroying the result of a 12-second one, with no
    way back but re-decoding the file. Those fields are read off the existing
    row and put back into the payload BEFORE it is persisted.

    Only fields the partial run left as ``None`` are restored, so everything
    it did measure (bpm, beats, key, rms, ffprobe, and the profile marker)
    still wins -- a dj re-run of an old row is still an update, not a no-op.
    """
    try:
        prior = db.get_analysis(entry_id)
    except Exception as e:  # pragma: no cover - a broken DB fails at persist
        log.debug("analysis.engine: no prior row for %s: %s", entry_id, e)
        return
    if not prior:
        return
    for field in _PARTIAL_PROFILE_FIELDS:
        if payload.get(field) is None and prior.get(field) is not None:
            payload[field] = prior[field]
    if not payload.get("semantic_tags"):
        # Stored as a JSON string; the payload carries a list.
        try:
            tags = json.loads(prior.get("semantic_tags_json") or "[]")
        except (TypeError, ValueError):
            tags = []
        if isinstance(tags, list) and tags:
            payload["semantic_tags"] = tags


def _set_status(
    db: LibraryDB, entry_id: str, status: str, *, bump_revision: bool = True
) -> None:
    try:
        # Lightweight UPDATE: we don't go through upsert_entry because
        # we don't want to rewrite every column.
        with db._txn(bump_revision=bump_revision) as cur:  # noqa: SLF001
            cur.execute(
                "UPDATE entries SET analysis_status = ?, updated_at = ? WHERE id = ?",
                (status, time.time(), entry_id),
            )
    except Exception as e:
        log.debug(
            "analysis.engine: status update failed for %s -> %s: %s",
            entry_id,
            status,
            e,
        )
