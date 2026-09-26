"""FastAPI router for the analysis module.

Endpoints (prefix from module.json → ``/api/analysis``):

    GET  /              health / capability report
    GET  /{id}          fetch the analysis row for an entry
    POST /{id}/run      run analysis synchronously and return the
                        result. Foreground call; bumps the idle
                        manager so background workers don't compete.
                        ``?profile=dj`` runs the deck-only subset.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Query

from backend.modules.library.router import get_store as get_library_store

from .engine import (
    ANALYSIS_VERSION,
    PROFILE_DJ,
    PROFILE_FULL,
    analyze_and_persist,
)
from .ffprobe import has_ffprobe
from .prompt import generate_prompt

log = logging.getLogger(__name__)


router = APIRouter()


#: How many analyses this process will run at once, for the whole process.
#:
#: ``run_analysis`` is a sync ``def``, so FastAPI hands it to the threadpool
#: (40 workers by default) and N simultaneous requests used to start N librosa
#: decodes: N full-file float arrays resident at once, N cores of FFT, and --
#: because every analysis also takes the library DB's single write lock three
#: times and the entry's metadata lock once -- N threads queueing on those two
#: mutexes. That is how one DJ tab activation turned a 12-second analysis into
#: a 20-second one and kept the backend pegged: the extra time was not work,
#: it was waiting.
#:
#: Two, not one: one decode can be running while another analysis is inside
#: ffprobe or blocked on a lock, so a pair keeps a core busy without letting
#: the decodes pile up. Deliberately a constant rather than a setting -- it is
#: a property of the work (a decode is hundreds of MB and one core), not a
#: preference -- and deliberately process-wide rather than per-client, which
#: is the only scope that actually bounds anything.
MAX_CONCURRENT_ANALYSES = 2

_analysis_slots = threading.BoundedSemaphore(MAX_CONCURRENT_ANALYSES)


class _InFlight:
    """One running analysis, and the place its result is published.

    Followers wait on ``done`` and read ``payload``/``error``; they hold no
    semaphore slot while waiting, which is what keeps single-flight from
    deadlocking against the concurrency cap (a waiter can never be the thing
    the leader is waiting for).
    """

    __slots__ = ("done", "payload", "error")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.payload: Optional[dict] = None
        self.error: Optional[BaseException] = None


_inflight_lock = threading.Lock()
#: (entry_id, profile) -> the run currently computing it.
#:
#: Keyed on the profile as well as the id on purpose: joining a ``dj`` run
#: would hand a full-profile caller a payload with no pitch and no LUFS, which
#: is a wrong answer, not a shared one. Two profiles of one entry at the same
#: instant is rare, both results are correct, and the semaphore still bounds
#: the total work.
_inflight: dict[tuple[str, str], _InFlight] = {}


def _single_flight(key: tuple[str, str], work: Callable[[], dict]) -> dict:
    """Run ``work`` under the concurrency cap, once per ``key``.

    A second request for a key already running does not start a second
    analysis: it waits for the first and returns (a copy of) its result, or
    re-raises its exception. Before this, a deck load and the browser sweep
    racing on the same track decoded that track twice.
    """
    with _inflight_lock:
        run = _inflight.get(key)
        leader = run is None
        if run is None:
            run = _InFlight()
            _inflight[key] = run

    if not leader:
        run.done.wait()
        if run.error is not None:
            raise run.error
        # A copy per follower: nobody mutates a payload another caller holds.
        return dict(run.payload or {})

    try:
        with _analysis_slots:
            payload = work()
        run.payload = payload
        return payload
    except BaseException as e:
        run.error = e
        raise
    finally:
        # Drop the entry BEFORE waking anyone: a request arriving after this
        # point must be able to start a fresh run rather than latch onto a
        # finished one.
        with _inflight_lock:
            _inflight.pop(key, None)
        run.done.set()


@router.get("")
@router.get("/")
def get_capabilities() -> dict:
    return {
        "ok": True,
        "ffprobe": has_ffprobe(),
        "engines": ["aubio (tempo)", "librosa (key/pitch/bars/rms)"],
        "prompt_inference": "deterministic",
        "semantic_tags": True,
        "ml_enrichers": [],
    }


def _analysis_from_row(row: dict) -> dict:
    """Reconstruct the fields the prompt generator needs from a stored
    analysis row, pulling duration/channels out of the ffprobe summary."""
    try:
        summary = (json.loads(row.get("ffprobe_json") or "{}") or {}).get("_summary")
    except (TypeError, ValueError):
        summary = None
    summary = summary or {}
    return {
        "bpm": row.get("bpm"),
        "key": row.get("key"),
        "scale": row.get("scale"),
        "key_confidence": row.get("key_confidence"),
        "rms_db": row.get("rms_db"),
        "loudness_lufs": row.get("loudness_lufs"),
        "pitch_mean_hz": row.get("pitch_mean_hz"),
        "pitch_std_hz": row.get("pitch_std_hz"),
        "genre": row.get("genre"),
        "duration_sec": summary.get("duration_sec"),
        "channels": summary.get("channels"),
    }


@router.get("/{entry_id}/prompt")
def get_prompt(entry_id: str) -> dict:
    """Generate a Stable Audio-style prompt and semantic tags from an entry's
    analysis. Regenerated from the stored analysis each call, so entries
    analyzed before this feature still get a prompt."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    row = store.db.get_analysis(entry_id)
    if row is None:
        raise HTTPException(404, f"entry {entry_id!r} has no analysis yet")

    try:
        embedded = json.loads(row.get("embedded_tags_json") or "{}")
    except (TypeError, ValueError):
        embedded = {}
    title = str(getattr(store.get_entry(entry_id), "title", "") or "")
    result = generate_prompt(
        _analysis_from_row(row),
        embedded_tags=embedded if isinstance(embedded, dict) else {},
        title=title,
    )
    return {"entry_id": entry_id, **result}


@router.get("/{entry_id}")
def get_analysis(entry_id: str) -> dict:
    """Return the analysis row for an entry, or an empty payload with
    ``status='pending'`` when nothing has analyzed it yet. We return 200
    (not 404) for the empty case because the frontend Details panel
    polls this on every entry select — a 404 here floods the browser
    Network tab with red errors for entries that simply haven't been
    analyzed yet, which is a normal state, not a failure."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    row = store.db.get_analysis(entry_id)
    if row is None:
        return {"entry_id": entry_id, "status": "pending"}
    # A row from an older analyzer version is reported as 'pending' so the
    # frontend re-runs it (Mixxx-style: re-analyze when the analyzer changes).
    # This is how stale bpm=null rows — written before the librosa tempo
    # fallback — heal themselves instead of looking permanently analyzed.
    if int(row.get("version") or 0) < ANALYSIS_VERSION:
        return {"entry_id": entry_id, "status": "pending"}
    return row


@router.post("/{entry_id}/run")
def run_analysis(
    entry_id: str,
    profile: str = Query(
        PROFILE_FULL,
        description=(
            "'full' runs every step; 'dj' runs only what a deck reads "
            "(ffprobe, one decode, tempo+beats+confidence, key, rms) and "
            "leaves pitch and LUFS for a later full run."
        ),
    ),
) -> dict:
    if profile not in (PROFILE_FULL, PROFILE_DJ):
        raise HTTPException(
            422, f"unknown analysis profile {profile!r} (expected 'full' or 'dj')"
        )
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    audio_path = store.get_audio_path(entry_id)
    if audio_path is None or not Path(audio_path).is_file():
        raise HTTPException(404, f"audio for entry {entry_id!r} not on disk")

    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 — internal but stable
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    # Hold the idle gate while we run so background workers don't
    # compete (manual /run is treated as foreground activity).
    try:
        from backend.core.idle import get_idle_manager

        get_idle_manager().bump_activity(tag="analysis-manual")
    except Exception:
        pass

    def _work() -> dict[str, Any]:
        return analyze_and_persist(
            store.db,
            entry_id,
            Path(audio_path),
            metadata_path=metadata_path,
            # The store whose metadata lock the entry's other writers take:
            # this runs on FastAPI's threadpool alongside user edits of the
            # same entry, and metadata.json is the source of truth.
            store=store,
            profile=profile,
        )

    try:
        return _single_flight((entry_id, profile), _work)
    finally:
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("analysis-manual")
        except Exception:
            pass
