"""The Magenta engine (sidecars/magenta/server.py) stops a take on POST /cancel.

The engine renders a take as a loop of generate() calls on a worker thread, so
its event loop is free to take the cancel. Each test replays that order with a
stand-in model: the cancel arrives between two chunks (without notes and with
notes), before the take starts, or while the take waits for the engine. The
take must answer 409 cancelled, render no chunk after the cancel, leave the
extend state as it was and give the engine back.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import threading
import types
from pathlib import Path

import numpy as np
import pytest

SERVER = Path(__file__).resolve().parents[1] / "sidecars" / "magenta" / "server.py"
WAIT = 5.0


class _FakeModel:
    """Stands in for MagentaRT2: generate() returns `frames` rows of silence and
    threads a counter through the state; `on_chunk(n)` runs as chunk n starts."""

    def __init__(self, on_chunk=None):
        self.chunks = 0
        self.embeds = 0
        self.on_chunk = on_chunk

    def embed_style(self, _text, use_mapper=True, seed=0):
        self.embeds += 1
        return np.zeros(4, dtype=np.float32)

    def generate(self, frames, state=None, **_kw):
        self.chunks += 1
        if self.on_chunk:
            self.on_chunk(self.chunks)
        return types.SimpleNamespace(samples=np.zeros((frames, 2), dtype=np.float32)), (
            state or 0
        ) + 1


@pytest.fixture
def engine(monkeypatch):
    # The module sets XLA / TF variables with setdefault; pin them so the test
    # process gets its own values back afterwards.
    monkeypatch.setenv("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    monkeypatch.setenv("TF_CPP_MIN_LOG_LEVEL", "2")
    spec = importlib.util.spec_from_file_location(
        "thedaw_magenta_engine_under_test", SERVER
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def ready(model):
        mod.ENGINE.mrt = model
        mod.ENGINE.ready = True
        mod.ENGINE.sample_rate = 48000
        return model

    mod.ready = ready
    return mod


def _form(
    request_id: str, duration: float = 30.0, notes: str = "", chunk_frames: int = 25
) -> dict:
    return dict(
        prompt="warm pads",
        duration=duration,
        temperature=1.3,
        top_k=40,
        cfg_musiccoca=3.0,
        cfg_notes=1.0,
        cfg_drums=1.0,
        drums=-1,
        chunk_frames=chunk_frames,
        notes=notes,
        seed=0,
        extend=False,
        styles="",
        audio=None,
        request_id=request_id,
    )


async def _in_thread(event: threading.Event) -> None:
    assert await asyncio.get_running_loop().run_in_executor(None, event.wait, WAIT)


def _cancel_at_chunk(engine, form: dict, at: int):
    reached, resume = threading.Event(), threading.Event()

    def on_chunk(n):
        if n == at:
            reached.set()
            resume.wait(WAIT)

    model = engine.ready(_FakeModel(on_chunk))

    async def scenario():
        take = asyncio.ensure_future(engine.generate(**form))
        await _in_thread(reached)
        answer = await engine.cancel(request_id=form["request_id"])
        resume.set()
        return answer, await asyncio.wait_for(take, WAIT)

    answer, reply = asyncio.run(scenario())
    return model, answer, reply


def test_a_cancel_between_chunks_stops_the_take(engine):
    # 30 s with no notes is three 250-frame chunks; the cancel lands in the second.
    model, answer, reply = _cancel_at_chunk(engine, _form("r1"), at=2)

    assert answer == {"ok": True, "busy": True}
    assert reply.status_code == 409
    assert json.loads(reply.body) == {"error": "cancelled", "cancelled": True}
    assert model.chunks == 2, "the chunk in hand finished; no chunk after it ran"
    assert engine.ENGINE._gen is None, "the extend state kept the piece as it was"
    assert not engine.ENGINE.lock.locked()


def test_a_cancel_between_note_chunks_stops_the_take(engine):
    notes = json.dumps([{"pitch": 60, "start": 0.0, "end": 2.0}])
    # 3 s with notes is three 25-frame chunks; the cancel lands in the first.
    model, _answer, reply = _cancel_at_chunk(
        engine, _form("r2", duration=3.0, notes=notes), at=1
    )

    assert reply.status_code == 409
    assert model.chunks == 1
    assert not engine.ENGINE.lock.locked()


def test_a_cancel_that_arrives_first_means_the_take_never_starts(engine):
    model = engine.ready(_FakeModel())

    async def scenario():
        await engine.cancel(request_id="early")
        return await engine.generate(**_form("early"))

    reply = asyncio.run(scenario())

    assert reply.status_code == 409
    assert (model.chunks, model.embeds) == (0, 0)


def test_a_cancel_while_the_take_waits_for_the_engine(engine):
    model = engine.ready(_FakeModel())

    async def scenario():
        engine.ENGINE.lock.acquire()  # another take holds the engine
        try:
            take = asyncio.ensure_future(engine.generate(**_form("queued")))
            await asyncio.sleep(0.1)
            await engine.cancel(request_id="queued")
            return await asyncio.wait_for(take, WAIT)
        finally:
            engine.ENGINE.lock.release()

    reply = asyncio.run(scenario())

    assert reply.status_code == 409, (
        "answered while the other take still held the engine"
    )
    assert model.chunks == 0


def test_a_take_nobody_cancels_renders_whole(engine):
    model = engine.ready(_FakeModel())

    async def scenario():
        await engine.cancel(request_id="someone-else")
        return await engine.generate(**_form("mine"))

    reply = asyncio.run(scenario())

    assert reply.status_code == 200
    assert reply.media_type == "audio/wav"
    assert model.chunks == 3
    assert engine.ENGINE._gen is not None
    assert not engine.ENGINE.lock.locked()
