"""DJ-1: the analysis endpoint's concurrency cap and single-flight.

These drive the real module-level primitives in
``backend.modules.analysis.router`` with real threads, because both defects
they fix only exist under concurrency: N simultaneous ``/run`` requests used
to start N librosa decodes (the endpoint is a sync ``def``, so FastAPI puts
each on its own threadpool worker), and a deck load racing the browser sweep
on the same track decoded that track twice.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.analysis import router as analysis_router
from backend.modules.library import router as library_router
from backend.modules.library import store as library_store


def test_single_flight_runs_one_analysis_for_concurrent_callers():
    calls: list[int] = []
    started = threading.Event()
    release = threading.Event()

    def work() -> dict:
        calls.append(1)
        started.set()
        assert release.wait(5.0)
        return {"bpm": 128.0}

    results: list[dict] = []
    errors: list[BaseException] = []

    def caller() -> None:
        try:
            results.append(analysis_router._single_flight(("e1", "dj"), work))  # noqa: SLF001
        except BaseException as e:  # pragma: no cover - failure path
            errors.append(e)

    leader = threading.Thread(target=caller)
    leader.start()
    assert started.wait(5.0), "leader never entered the work function"
    followers = [threading.Thread(target=caller) for _ in range(5)]
    for t in followers:
        t.start()
    # Followers must be parked on the leader, not running their own analysis.
    release.set()
    for t in [leader, *followers]:
        t.join(10.0)

    assert not errors
    assert sum(calls) == 1, "a second /run for a running id started a second analysis"
    assert len(results) == 6
    assert all(r == {"bpm": 128.0} for r in results)
    # Each caller gets its own dict, so one caller cannot mutate another's.
    assert len({id(r) for r in results}) == 6
    assert analysis_router._inflight == {}  # noqa: SLF001


def test_single_flight_never_exceeds_the_concurrency_cap():
    cap = analysis_router.MAX_CONCURRENT_ANALYSES
    lock = threading.Lock()
    live = 0
    peak = 0
    gate = threading.Event()

    def work() -> dict:
        nonlocal live, peak
        with lock:
            live += 1
            peak = max(peak, live)
        # Hold the slot long enough that every other thread has had its turn
        # to try to enter; without the semaphore all of them would be inside.
        gate.wait(0.25)
        with lock:
            live -= 1
        return {}

    threads = [
        threading.Thread(
            target=lambda i=i: analysis_router._single_flight((f"e{i}", "dj"), work)  # noqa: SLF001
        )
        for i in range(cap * 4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30.0)

    assert peak <= cap, f"{peak} analyses ran at once with a cap of {cap}"
    assert peak > 1, "the cap must not serialise everything down to one"
    assert analysis_router._inflight == {}  # noqa: SLF001


def test_single_flight_reraises_the_leaders_error_to_followers():
    started = threading.Event()
    release = threading.Event()

    def work() -> dict:
        started.set()
        assert release.wait(5.0)
        raise RuntimeError("decode exploded")

    seen: list[BaseException] = []

    def caller() -> None:
        try:
            analysis_router._single_flight(("boom", "full"), work)  # noqa: SLF001
        except BaseException as e:
            seen.append(e)

    leader = threading.Thread(target=caller)
    leader.start()
    assert started.wait(5.0)
    follower = threading.Thread(target=caller)
    follower.start()
    release.set()
    leader.join(10.0)
    follower.join(10.0)

    assert len(seen) == 2
    assert all(isinstance(e, RuntimeError) for e in seen)
    # A failed run must not be remembered: the next request retries.
    assert analysis_router._inflight == {}  # noqa: SLF001
    assert analysis_router._single_flight(("boom", "full"), lambda: {"ok": True}) == {
        "ok": True
    }


class _StubStore:
    """The narrow slice of LibraryStore the /run endpoint touches."""

    def __init__(self, audio_path: Path) -> None:
        self.db = object()
        self._audio = audio_path

    def get_entry(self, entry_id: str):
        return {"id": entry_id}

    def get_audio_path(self, entry_id: str):
        return self._audio

    def _dir_for(self, entry_id: str):
        return self._audio.parent


@pytest.fixture
def run_client(tmp_path: Path, monkeypatch):
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF....WAVEfmt ")
    monkeypatch.setattr(analysis_router, "get_library_store", lambda: _StubStore(audio))

    # Tripwire: the stub above is the ONLY store these tests may reach. If any
    # path here falls back to the real resolver, the user's actual library is
    # one call away from being opened (and analysed) -- so that call fails
    # loudly instead of succeeding quietly. Patched in both modules because
    # the router imports the name directly.
    def _explode(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError(
            "default_library_root() was consulted: something is about to open "
            "the user's real library"
        )

    monkeypatch.setattr(library_store, "default_library_root", _explode)
    monkeypatch.setattr(library_router, "default_library_root", _explode, raising=False)

    app = FastAPI()
    app.include_router(analysis_router.router, prefix="/api/analysis")
    return TestClient(app)


def test_run_endpoint_passes_the_dj_profile_through(run_client, monkeypatch):
    seen: dict = {}

    def fake(db, entry_id, audio_path, **kwargs):
        seen.update(kwargs)
        seen["entry_id"] = entry_id
        return {"bpm": 120.0, "profile": kwargs.get("profile")}

    monkeypatch.setattr(analysis_router, "analyze_and_persist", fake)
    r = run_client.post("/api/analysis/abc/run?profile=dj")
    assert r.status_code == 200, r.text
    assert r.json()["profile"] == "dj"
    assert seen["profile"] == "dj"


def test_run_endpoint_defaults_to_the_full_profile(run_client, monkeypatch):
    seen: dict = {}

    def fake(db, entry_id, audio_path, **kwargs):
        seen.update(kwargs)
        return {"bpm": 120.0}

    monkeypatch.setattr(analysis_router, "analyze_and_persist", fake)
    assert run_client.post("/api/analysis/abc/run").status_code == 200
    assert seen["profile"] == "full"


def test_run_endpoint_rejects_an_unknown_profile(run_client, monkeypatch):
    def fake(*a, **k):  # pragma: no cover - must never be reached
        raise AssertionError("analysis ran for an unknown profile")

    monkeypatch.setattr(analysis_router, "analyze_and_persist", fake)
    r = run_client.post("/api/analysis/abc/run?profile=everything")
    assert r.status_code == 422
    assert "everything" in r.text
