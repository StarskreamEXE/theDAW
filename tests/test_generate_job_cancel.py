"""POST /api/jobs/{id}/cancel ends a Stable Audio generate job on the backend.

Each test replays the order a real run produces: the job starts, the sampler
reports its steps through the callback from the executor thread, and the cancel
arrives between two steps, while the job waits for the generation lock, or
while a take decodes. The job must end as "cancelled", write nothing after the
checkpoint that saw the cancel, and give the idle gate back.
"""

from __future__ import annotations

import asyncio
import threading

import pytest
import torch
from fastapi import HTTPException
from fastapi.testclient import TestClient

import backend.modules.library.router as library_router
import backend.server as server
from backend.core.idle import get_idle_manager, idle_hold

WAIT = 5.0


class _FakePipeline:
    """Stands in for StableAudioPipeline.generate: runs `steps` sampler steps and
    reports each through the callback, the way inference/sampling.py does, then
    returns a decoded take. `on_step(i)` runs before step i's callback and
    `after_sampling()` runs after the last one (the decode)."""

    def __init__(self, steps=8, on_step=None, after_sampling=None):
        self.model_config = {"sample_rate": 44100}
        self.steps = steps
        self.on_step = on_step
        self.after_sampling = after_sampling
        self.steps_run = 0

    def generate(self, callback=None, **_kwargs):
        for i in range(self.steps):
            if self.on_step:
                self.on_step(i)
            self.steps_run = i + 1
            if callback:
                callback({"i": i})
        if self.after_sampling:
            self.after_sampling()
        return torch.zeros(1, 2, 4410)


@pytest.fixture
def jobs(monkeypatch, tmp_path):
    """A private job table, a fresh generation lock on each test's own loop, and
    every write the job would make recorded instead of reaching the disk."""
    table: dict[str, dict] = {}
    monkeypatch.setattr(server, "JOBS", table)
    monkeypatch.setattr(server, "_JOB_CANCEL_EVENTS", {})
    monkeypatch.setattr(server, "_generation_job_lock", asyncio.Lock())
    saved: list[str] = []

    def record_save(**kwargs):
        saved.append(kwargs["audio_filename"])
        return {}

    class _NoLibrary:
        db = None

        def get_entry(self, _entry_id):
            return None

    monkeypatch.setattr(server, "_save_generation_artifacts_sync", record_save)
    monkeypatch.setattr(server, "_generate_spectrograms", lambda *_a: {})
    monkeypatch.setattr(server, "_get_generation_artifacts_root", lambda: tmp_path)
    monkeypatch.setattr(library_router, "get_store", lambda: _NoLibrary())
    mgr = get_idle_manager()
    for tag in list(mgr.active_tags()):
        mgr.release(tag)
    yield table, saved
    for tag in list(mgr.active_tags()):
        mgr.release(tag)


def _queue(table: dict, job_id: str) -> None:
    table[job_id] = {
        "id": job_id,
        "kind": "generate",
        "status": "queued",
        "progress": {"step": 0, "steps": 8},
    }


def _start(job_id: str, pipe: _FakePipeline, batch_size: int = 1) -> asyncio.Task:
    """What POST /api/generate-jobs does once the job exists: take the idle hold
    and hand it to the job task."""
    with idle_hold("generate") as hold:
        task = asyncio.create_task(
            server._run_generate_job(
                job_id,
                pipe,
                {"prompt": "a test tone", "seed": 7},
                batch_size,
                "wav",
                "16",
                "verbose",
                "",
                [],
                [],
                None,
            )
        )
        hold.hand_off()
    return task


async def _in_thread(event: threading.Event) -> None:
    assert await asyncio.get_running_loop().run_in_executor(None, event.wait, WAIT)


def test_cancel_stops_the_sampler_at_its_next_step(jobs):
    table, saved = jobs
    reached, resume = threading.Event(), threading.Event()

    def on_step(i):
        if i == 3:
            reached.set()
            resume.wait(WAIT)

    pipe = _FakePipeline(on_step=on_step)
    _queue(table, "step")

    async def scenario():
        task = _start("step", pipe)
        await _in_thread(reached)
        summary = await server.cancel_job("step")
        resume.set()
        await asyncio.wait_for(task, WAIT)
        return summary

    summary = asyncio.run(scenario())

    assert summary["status"] == "running"
    assert summary["cancel_requested"] is True
    assert "result" not in summary
    assert table["step"]["status"] == "cancelled"
    assert pipe.steps_run == 4, "the step in hand finished; no step after it ran"
    assert table["step"]["saved_takes"] == 0
    assert saved == []
    assert get_idle_manager().active_tags() == []


def test_cancel_while_waiting_for_the_gpu_ends_the_job_at_once(jobs):
    table, saved = jobs
    pipe = _FakePipeline()
    _queue(table, "queued")

    async def scenario():
        lock = server._generation_job_lock
        await lock.acquire()  # the job ahead holds the GPU, and keeps it
        task = _start("queued", pipe)
        await asyncio.sleep(0.05)  # the job is waiting for the lock
        summary = await server.cancel_job("queued")
        # Ends while the job ahead still holds the lock: nobody waits for it.
        await asyncio.wait_for(task, WAIT)
        seen = {
            "status": table["queued"]["status"],
            "lock_held": lock.locked(),
            "idle_tags": list(get_idle_manager().active_tags()),
        }
        lock.release()
        # The lock is still usable by the next job: the cancelled waiter took
        # nothing with it.
        await asyncio.wait_for(lock.acquire(), WAIT)
        lock.release()
        return summary, seen

    summary, seen = asyncio.run(scenario())

    assert summary["cancel_requested"] is True
    assert seen == {"status": "cancelled", "lock_held": True, "idle_tags": []}
    assert pipe.steps_run == 0
    assert saved == []
    assert server._JOB_CANCEL_EVENTS == {}


def test_a_job_behind_a_cancelled_waiter_still_gets_the_gpu(jobs):
    table, saved = jobs
    _queue(table, "gone")
    _queue(table, "next")
    gone, nxt = _FakePipeline(), _FakePipeline()

    async def scenario():
        lock = server._generation_job_lock
        await lock.acquire()
        first = _start("gone", gone)
        second = _start("next", nxt)
        await asyncio.sleep(0.05)  # both wait, "gone" first
        await server.cancel_job("gone")
        await asyncio.wait_for(first, WAIT)
        lock.release()
        await asyncio.wait_for(second, WAIT)

    asyncio.run(scenario())

    assert table["gone"]["status"] == "cancelled"
    assert table["next"]["status"] == "completed"
    assert (gone.steps_run, nxt.steps_run) == (0, 8)
    assert len(saved) == 1


def test_cancel_while_the_take_decodes_writes_nothing(jobs):
    table, saved = jobs
    decoding, resume = threading.Event(), threading.Event()

    def after_sampling():
        decoding.set()
        resume.wait(WAIT)

    pipe = _FakePipeline(after_sampling=after_sampling)
    _queue(table, "decode")

    async def scenario():
        task = _start("decode", pipe)
        await _in_thread(decoding)
        await server.cancel_job("decode")
        resume.set()
        await asyncio.wait_for(task, WAIT)

    asyncio.run(scenario())

    assert pipe.steps_run == 8
    assert table["decode"]["status"] == "cancelled"
    assert saved == [], "the decoded take was not written"
    assert get_idle_manager().active_tags() == []


def test_cancel_between_batch_takes_keeps_the_finished_take(jobs):
    table, saved = jobs
    second_take, resume = threading.Event(), threading.Event()
    calls = {"n": 0}

    def on_step(i):
        if i == 0:
            calls["n"] += 1
            if calls["n"] == 2:
                second_take.set()
                resume.wait(WAIT)

    pipe = _FakePipeline(on_step=on_step)
    _queue(table, "batch")

    async def scenario():
        task = _start("batch", pipe, batch_size=3)
        await _in_thread(second_take)
        await server.cancel_job("batch")
        resume.set()
        await asyncio.wait_for(task, WAIT)

    asyncio.run(scenario())

    assert table["batch"]["status"] == "cancelled"
    assert len(saved) == 1, "the first take finished before the cancel and stays"
    assert table["batch"]["saved_takes"] == 1
    assert calls["n"] == 2, "the third take never started"


def test_a_job_nobody_cancels_completes(jobs):
    table, saved = jobs
    pipe = _FakePipeline()
    _queue(table, "plain")

    async def scenario():
        await asyncio.wait_for(_start("plain", pipe), WAIT)

    asyncio.run(scenario())

    assert table["plain"]["status"] == "completed"
    assert pipe.steps_run == 8
    assert len(saved) == 1
    assert "cancel_requested" not in table["plain"]
    assert get_idle_manager().active_tags() == []


def test_cancel_leaves_a_finished_job_as_it_is(jobs):
    table, _saved = jobs
    table["done"] = {
        "id": "done",
        "status": "completed",
        "result": {"batch": False, "item": {"audio_base64": "AAAA"}},
    }

    summary = asyncio.run(server.cancel_job("done"))

    assert summary["status"] == "completed"
    assert "result" not in summary
    assert "cancel_requested" not in table["done"]


def test_cancel_of_an_unknown_job_is_404(jobs):
    with pytest.raises(HTTPException) as err:
        asyncio.run(server.cancel_job("missing"))
    assert err.value.status_code == 404


def test_the_cancel_route_over_http(jobs):
    """The route as the app calls it: POST, the summary back, the route's own
    404 detail (the app tells it apart from a backend that lacks the route)."""
    table, _saved = jobs
    _queue(table, "http")
    table["http"]["result"] = None
    table["fin"] = {"id": "fin", "status": "completed", "result": {"item": {}}}
    client = TestClient(server.app)

    queued = client.post("/api/jobs/http/cancel")
    finished = client.post("/api/jobs/fin/cancel")
    missing = client.post("/api/jobs/nope/cancel")

    assert queued.status_code == 200
    assert queued.json()["cancel_requested"] is True
    assert "result" not in queued.json()
    assert server._JOB_CANCEL_EVENTS["http"].is_set()
    assert finished.status_code == 200
    assert finished.json() == {"id": "fin", "status": "completed"}
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Job not found"}


def test_cancelled_jobs_are_pruned_like_finished_ones(jobs, monkeypatch):
    table, _saved = jobs
    monkeypatch.setattr(server, "_JOBS_MAX", 2)
    table["a"] = {"id": "a", "status": "cancelled"}
    table["b"] = {"id": "b", "status": "running"}
    table["c"] = {"id": "c", "status": "queued"}

    server._prune_jobs()

    assert list(table) == ["b", "c"]
