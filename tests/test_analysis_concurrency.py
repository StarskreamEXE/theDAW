"""DJ-1: the analysis endpoint's concurrency cap and single-flight.

These drive the real module-level primitives in
``backend.modules.analysis.router`` with real threads, because both defects
they fix only exist under concurrency: N simultaneous ``/run`` requests used
to start N librosa decodes (the endpoint is a sync ``def``, so FastAPI puts
each on its own threadpool worker), and a deck load racing the browser sweep
on the same track decoded that track twice.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.analysis import engine as analysis_engine
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
            results.append(analysis_engine._single_flight(("e1", "dj"), work))  # noqa: SLF001
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
    assert analysis_engine._inflight == {}  # noqa: SLF001


def test_single_flight_never_exceeds_the_concurrency_cap():
    """Both halves of the cap, without a wall-clock race.

    The old version proved "more than one at a time" by holding each slot for
    0.25 s and hoping two threads overlapped inside that window. That is a
    timing bet, not a proof. Here the FIRST worker in refuses to leave until it
    has SEEN a second worker enter: if the cap ever serialised to one, the
    first worker waits forever and the test fails on that wait rather than on
    a lucky sample.
    """
    cap = analysis_engine.MAX_CONCURRENT_ANALYSES
    assert cap >= 2, "this test is meaningless with a cap of one"
    lock = threading.Lock()
    live = 0
    peak = 0
    second_in = threading.Event()
    overlapped = threading.Event()
    errors: list[str] = []

    def work() -> dict:
        nonlocal live, peak
        with lock:
            live += 1
            peak = max(peak, live)
            rank = live
        if rank == 1:
            # Hold the first slot until somebody else is demonstrably inside.
            if second_in.wait(10.0):
                overlapped.set()
            else:
                errors.append(
                    "no second analysis ever entered: the cap serialised to one"
                )
        else:
            second_in.set()
        with lock:
            live -= 1
        return {}

    threads = [
        threading.Thread(
            target=lambda i=i: analysis_engine._single_flight((f"e{i}", "dj"), work)  # noqa: SLF001
        )
        for i in range(cap * 4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30.0)

    assert not errors, errors
    assert overlapped.is_set(), "the cap must not serialise everything down to one"
    assert peak <= cap, f"{peak} analyses ran at once with a cap of {cap}"
    assert analysis_engine._inflight == {}  # noqa: SLF001


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
            analysis_engine._single_flight(("boom", "full"), work)  # noqa: SLF001
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
    assert analysis_engine._inflight == {}  # noqa: SLF001
    assert analysis_engine._single_flight(("boom", "full"), lambda: {"ok": True}) == {
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


class _StubDbStore(_StubStore):
    """A stub store whose ``db`` is whatever the test hands it."""

    def __init__(self, db: Any, audio_path: Path | None = None) -> None:
        super().__init__(audio_path or Path("ignored.wav"))
        self.db = db


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


# ---------------------------------------------------------------------------
# DJ-1R: the cap belongs to the ENGINE, not the endpoint, and the GET reports
# which profile wrote the row.
# ---------------------------------------------------------------------------


class _NoRowsDB:
    """A database with no ``entries`` rows.

    ``analyze_and_persist`` computes and RETURNS the analysis for an entry that
    has no row (derived/variant ids) without persisting anything, so this stub
    exercises the whole wrapper — cap, single-flight, profile — with no schema.
    """

    def __init__(self) -> None:
        self.get_entry_calls = 0

    def get_entry(self, entry_id: str):
        self.get_entry_calls += 1
        return None


def test_the_store_path_and_the_endpoint_share_one_run(tmp_path, monkeypatch):
    """The cap and single-flight were on the ENDPOINT, so the library store's
    background pass (``asyncio.to_thread(analyze_and_persist, ...)``) walked
    straight past both: a background sweep and a deck load could decode the
    same file at the same moment. Both paths enter through
    ``analyze_and_persist``, so that is where the gate has to be."""
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF....WAVEfmt ")
    db = _NoRowsDB()
    store = _StubDbStore(db, audio)
    monkeypatch.setattr(analysis_router, "get_library_store", lambda: store)
    app = FastAPI()
    app.include_router(analysis_router.router, prefix="/api/analysis")
    run_client = TestClient(app)

    calls: list[str] = []
    entered = threading.Event()
    release = threading.Event()

    def fake_analyze(audio_path, **kwargs):
        calls.append(kwargs.get("profile"))
        entered.set()
        assert release.wait(10.0)
        return {"bpm": 128.0, "profile": kwargs.get("profile")}

    monkeypatch.setattr(analysis_engine, "analyze_audio", fake_analyze)

    # Leader: the endpoint.
    posted: list[int] = []

    def via_endpoint() -> None:
        posted.append(
            run_client.post("/api/analysis/shared/run?profile=dj").status_code
        )

    leader = threading.Thread(target=via_endpoint)
    leader.start()
    assert entered.wait(10.0), "the endpoint never reached the analysis"

    # Follower: the store's background path, same entry and profile.
    key = ("shared", "dj")
    follower_result: list[dict] = []

    def via_store() -> None:
        follower_result.append(
            analysis_engine.analyze_and_persist(db, "shared", audio, profile="dj")
        )

    follower = threading.Thread(target=via_store)
    follower.start()
    # Deterministic: wait until the follower is parked on the leader's run.
    run = analysis_engine._inflight.get(key)  # noqa: SLF001
    assert run is not None
    deadline = time.monotonic() + 10.0
    while run.followers < 1 and time.monotonic() < deadline:
        time.sleep(0.005)
    assert run.followers == 1, "the second caller started its own analysis"

    release.set()
    leader.join(15.0)
    follower.join(15.0)

    assert calls == ["dj"], f"the file was analysed {len(calls)} times, not once"
    assert posted == [200]
    assert follower_result[0]["bpm"] == 128.0
    assert analysis_engine._inflight == {}  # noqa: SLF001


def test_get_analysis_reports_the_profile_that_wrote_the_row(monkeypatch):
    """Without this the DJ tab's cheap row is indistinguishable from a full
    one, and the panels that show pitch/LUFS render a partial row as complete."""

    class _RowDB:
        def __init__(self, row):
            self._row = row

        def get_analysis(self, entry_id: str):
            return dict(self._row)

    def client_for(row):
        store = _StubDbStore(_RowDB(row))
        monkeypatch.setattr(analysis_router, "get_library_store", lambda: store)
        app = FastAPI()
        app.include_router(analysis_router.router, prefix="/api/analysis")
        return TestClient(app)

    base = {"entry_id": "x", "bpm": 128.0, "version": analysis_router.ANALYSIS_VERSION}

    dj = client_for(
        {**base, "ffprobe_json": json.dumps({analysis_engine.PROFILE_MARKER_KEY: "dj"})}
    ).get("/api/analysis/x")
    assert dj.status_code == 200, dj.text
    assert dj.json()["profile"] == "dj"

    full = client_for({**base, "ffprobe_json": json.dumps({"_summary": {}})}).get(
        "/api/analysis/x"
    )
    assert full.json()["profile"] == "full"

    # Nothing analysed yet: the pending payload says so, and claims no profile.
    class _EmptyDB:
        def get_analysis(self, entry_id: str):
            return None

    monkeypatch.setattr(
        analysis_router, "get_library_store", lambda: _StubDbStore(_EmptyDB())
    )
    app = FastAPI()
    app.include_router(analysis_router.router, prefix="/api/analysis")
    pending = TestClient(app).get("/api/analysis/x").json()
    assert pending["status"] == "pending"
    assert "profile" not in pending
