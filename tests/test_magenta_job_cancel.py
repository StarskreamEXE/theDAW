"""POST /api/magenta/jobs/{id}/cancel ends a Magenta generate job.

Each test replays the order a real job produces: the job brings the engine up,
sends the take to the engine and saves what comes back. The cancel arrives
during the bring-up, while the engine renders the take, with an engine that
predates its cancel route, or just as the take comes back. The job must end as
"cancelled", save nothing, and leave no cancel state behind.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import backend.modules.magenta.router as router
from backend.modules.magenta import sidecar

WAIT = 5.0


@pytest.fixture
def mag(monkeypatch):
    """A private job table and every save recorded instead of reaching the library."""
    jobs: dict[str, dict] = {}
    monkeypatch.setattr(router, "MAGENTA_JOBS", jobs)
    monkeypatch.setattr(router, "_CANCEL_EVENTS", {})
    saved: list[str] = []
    monkeypatch.setattr(
        router,
        "_save_magenta_to_library",
        lambda job_id, _wav, **_kw: saved.append(job_id),
    )
    calls: dict = {"generate": [], "cancel": []}

    async def engine_up(timeout=240.0, on_state=None):
        return None

    monkeypatch.setattr(router, "_bring_up_sidecar", engine_up)
    return jobs, saved, calls


def _queue(jobs: dict, job_id: str) -> None:
    jobs[job_id] = {
        "id": job_id,
        "kind": "magenta-generate",
        "model_name": "magenta-small",
        "conditioning": "text",
        "status": "queued",
        "progress": {"step": 0, "steps": 1},
        "engine_state": "running",
        "result": None,
        "error": None,
    }


def _run(job_id: str) -> asyncio.Future:
    return asyncio.ensure_future(
        router._run_generate(
            job_id,
            prompt="warm pads",
            duration=30.0,
            temperature=1.3,
            top_k=40,
            cfg_musiccoca=3.0,
            cfg_notes=1.0,
            cfg_drums=1.0,
            drums=-1,
            chunk_frames=25,
            notes=None,
            seed=1,
            extend=False,
            styles=None,
            audio_bytes=None,
            audio_mime="audio/wav",
        )
    )


def test_cancel_during_bring_up_ends_the_job_and_lets_the_bring_up_finish(
    mag, monkeypatch
):
    jobs, saved, calls = mag
    finished: list[bool] = []

    async def scenario():
        starting, finish = asyncio.Event(), asyncio.Event()

        async def slow_bring_up(timeout=240.0, on_state=None):
            on_state("starting", "starting the Magenta engine")
            starting.set()
            await finish.wait()
            on_state("running", "generating")
            finished.append(True)

        async def generate(**kw):
            calls["generate"].append(kw)
            return b"RIFF", {}

        monkeypatch.setattr(router, "_bring_up_sidecar", slow_bring_up)
        monkeypatch.setattr(sidecar, "generate", generate)
        _queue(jobs, "boot")
        task = _run("boot")
        await asyncio.wait_for(starting.wait(), WAIT)
        summary = await router.cancel_job("boot")
        await asyncio.wait_for(task, WAIT)
        status_when_the_job_ended = jobs["boot"]["status"]
        finish.set()
        for _ in range(100):
            if finished:
                break
            await asyncio.sleep(0.01)
        return summary, status_when_the_job_ended

    summary, status = asyncio.run(scenario())

    assert summary["cancel_requested"] is True
    assert status == "cancelled", "the job ended while the engine was still starting"
    assert finished == [True], "the bring-up ran on to the end"
    assert jobs["boot"]["engine_state"] == "starting", (
        "the late bring-up wrote nothing to the cancelled job"
    )
    assert calls["generate"] == []
    assert saved == []
    assert router._CANCEL_EVENTS == {}


def test_cancel_mid_take_stops_the_engine_and_saves_nothing(mag, monkeypatch):
    jobs, saved, calls = mag

    async def scenario():
        rendering, engine_cancel = asyncio.Event(), asyncio.Event()

        async def generate(**kw):
            calls["generate"].append(kw)
            rendering.set()
            await engine_cancel.wait()  # the engine checks between chunks
            raise sidecar.GenerationCancelled(kw["request_id"])

        async def cancel(request_id):
            calls["cancel"].append(request_id)
            engine_cancel.set()
            return True

        monkeypatch.setattr(sidecar, "generate", generate)
        monkeypatch.setattr(sidecar, "cancel", cancel)
        _queue(jobs, "take")
        task = _run("take")
        await asyncio.wait_for(rendering.wait(), WAIT)
        await router.cancel_job("take")
        await asyncio.wait_for(task, WAIT)

    asyncio.run(scenario())

    assert calls["generate"][0]["request_id"] == "take", (
        "the take is named for the cancel"
    )
    assert calls["cancel"] == ["take"]
    assert jobs["take"]["status"] == "cancelled"
    assert jobs["take"]["saved_takes"] == 0
    assert jobs["take"]["result"] is None
    assert saved == []
    assert router._CANCEL_EVENTS == {}


def test_an_engine_without_a_cancel_route_has_its_request_dropped(mag, monkeypatch):
    jobs, saved, calls = mag
    dropped: list[bool] = []

    async def scenario():
        rendering = asyncio.Event()

        async def generate(**kw):
            calls["generate"].append(kw)
            rendering.set()
            try:
                await asyncio.Event().wait()  # renders the whole take, deaf to cancels
            except asyncio.CancelledError:
                dropped.append(True)
                raise

        async def cancel(request_id):
            calls["cancel"].append(request_id)
            return False  # 404 from an engine that predates /cancel

        monkeypatch.setattr(sidecar, "generate", generate)
        monkeypatch.setattr(sidecar, "cancel", cancel)
        _queue(jobs, "deaf")
        task = _run("deaf")
        await asyncio.wait_for(rendering.wait(), WAIT)
        await router.cancel_job("deaf")
        await asyncio.wait_for(task, WAIT)

    asyncio.run(scenario())

    assert calls["cancel"] == ["deaf"]
    assert dropped == [True], "the request was dropped at once"
    assert jobs["deaf"]["status"] == "cancelled"
    assert saved == []


def test_cancel_as_the_take_comes_back_saves_nothing(mag, monkeypatch):
    jobs, saved, calls = mag

    async def scenario():
        async def generate(**kw):
            calls["generate"].append(kw)
            await router.cancel_job("late")  # the cancel lands as the engine answers
            return b"RIFF....WAVE", {"X-RTF": "2.0"}

        monkeypatch.setattr(sidecar, "generate", generate)
        _queue(jobs, "late")
        await asyncio.wait_for(_run("late"), WAIT)

    asyncio.run(scenario())

    assert jobs["late"]["status"] == "cancelled"
    assert jobs["late"]["result"] is None
    assert saved == [], "the take that came back was not saved"


def test_a_job_nobody_cancels_saves_and_completes(mag, monkeypatch):
    jobs, saved, calls = mag

    async def scenario():
        async def generate(**kw):
            calls["generate"].append(kw)
            return b"RIFF....WAVE", {"X-RTF": "2.0"}

        monkeypatch.setattr(sidecar, "generate", generate)
        _queue(jobs, "plain")
        await asyncio.wait_for(_run("plain"), WAIT)

    asyncio.run(scenario())

    assert jobs["plain"]["status"] == "completed"
    assert saved == ["plain"]
    assert "cancel_requested" not in jobs["plain"]
    assert router._CANCEL_EVENTS == {}


def test_the_cancel_route_over_http(mag):
    jobs, _saved, _calls = mag
    _queue(jobs, "q")
    jobs["fin"] = {
        "id": "fin",
        "status": "completed",
        "result": {"item": {"audio_base64": "AAAA"}},
    }
    app = FastAPI()
    app.include_router(router.router, prefix="/api/magenta")
    client = TestClient(app)

    queued = client.post("/api/magenta/jobs/q/cancel")
    finished = client.post("/api/magenta/jobs/fin/cancel")
    missing = client.post("/api/magenta/jobs/nope/cancel")

    assert queued.status_code == 200
    assert queued.json()["cancel_requested"] is True
    assert "result" not in queued.json()
    assert router._CANCEL_EVENTS["q"].is_set()
    assert finished.json() == {"id": "fin", "status": "completed"}
    assert "cancel_requested" not in jobs["fin"]
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Job not found"}
