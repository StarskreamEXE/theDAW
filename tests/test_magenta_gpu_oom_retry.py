"""A Magenta load that ran out of GPU memory retries, and says what was true.

The engine died with ``RESOURCE_EXHAUSTED: Out of memory while trying to
allocate 96.00MiB`` while the card showed 1.3 of 11 GiB in use, and the app
answered "something else was on the card ... wait for it to finish". Nothing was
on the card. JAX sizes its memory arena once, when it imports, from whatever is
free at that instant; a card busy for that one moment leaves the engine short
for the life of the process, and no amount of waiting changes it.

So: the load retries once with the allocator that grows on demand, and every
message about the card is written from a measurement of the card.
"""

from __future__ import annotations

import asyncio

import pytest

import backend.modules.magenta.router as router

OOM = (
    "JaxRuntimeError: RESOURCE_EXHAUSTED: Out of memory while trying to "
    "allocate 96.00MiB. [tf-allocator-allocation-error='']"
)


# ── the message ─────────────────────────────────────────────────────────────


def test_a_roomy_card_is_not_told_to_wait_for_another_job():
    """The failure the user hit: 10 GiB free, and the old text sent them away."""
    fix = router._classify_engine_error({"error": OOM}, free_gb=9.7)["fix"]

    assert "9.7 GiB free" in fix
    assert "not a shortage" in fix
    assert "Restart engine" in fix
    assert "wait" not in fix.lower(), "there is nothing to wait for"
    assert "stem separation" not in fix, "do not name jobs that are not running"


def test_a_full_card_names_what_could_be_on_it():
    fix = router._classify_engine_error({"error": OOM}, free_gb=0.4)["fix"]

    assert "0.4 GiB was free" in fix
    assert "Something else is on the card" in fix
    assert "stem separation" in fix


def test_an_unmeasurable_card_claims_nothing_about_free_memory():
    """No nvidia-smi: say what happened, invent no figure."""
    fix = router._classify_engine_error({"error": OOM}, free_gb=None)["fix"]

    assert "GiB" not in fix.split("Something else")[0]
    assert "Something else is on the card" in fix


def test_the_growing_allocator_running_out_is_a_real_shortage():
    """It already took memory as it needed it, so the card is the limit."""
    fix = router._classify_engine_error(
        {"error": OOM, "allocator": "grow"}, free_gb=2.1
    )["fix"]

    assert "does not have room" in fix
    assert "2.1 GiB was free" in fix
    assert "smaller model" in fix
    assert "not a shortage" not in fix


def test_every_oom_is_classified_as_one():
    for err in (OOM, "out of memory", "OOM killed", "RESOURCE_EXHAUSTED"):
        assert (
            router._classify_engine_error({"error": err}, 5.0)["error_kind"]
            == "gpu_oom"
        )


def test_other_failures_are_untouched():
    assert (
        router._classify_engine_error({"error": "checkpoint not found"}, 9.0)[
            "error_kind"
        ]
        == "checkpoint_missing"
    )
    assert router._classify_engine_error({}, 9.0) == {}


# ── the retry ───────────────────────────────────────────────────────────────


class _Sidecar:
    """A stub engine: it reports `states` in order, one per health() call."""

    def __init__(self, states):
        self.states = list(states)
        self.starts: list[bool] = []
        self.stops = 0
        self.last: dict = {}

    async def health(self):
        self.last = self.states.pop(0) if self.states else self.last
        return self.last

    def setup_state(self, refresh: bool = False):
        return {"ready": True}

    def engine_state(self, h, _setup):
        if h.get("error"):
            return "error"
        return "running" if h.get("available") else "starting"

    def start_engine(self, grow: bool = False):
        self.starts.append(grow)
        return {"spawned": True}

    def stop_engine(self):
        self.stops += 1
        return True

    def gpu_free_gb(self):
        return 9.7


@pytest.fixture
def bring_up(monkeypatch):
    """_bring_up_sidecar with the GPU lane, sleeping and SA3 offload stubbed."""

    class _Lane:
        async def __aenter__(self):
            return None

        async def __aexit__(self, *_):
            return False

    from backend.core import pipeline

    monkeypatch.setattr(pipeline, "gpu", lambda _who: _Lane())
    # Bind the real sleep first: a lambda that reads asyncio.sleep at call time
    # would find the patched one and recurse.
    real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, "sleep", lambda _s: real_sleep(0))
    return router._bring_up_sidecar


def test_an_oom_load_restarts_with_the_growing_allocator(bring_up, monkeypatch):
    engine = _Sidecar(
        [
            {},  # the early-exit probe: not available
            {},  # the same, inside the lock — so the spawn path runs
            {"error": OOM, "allocator": "preallocate"},  # dies under preallocation
            {"available": True, "allocator": "grow"},  # loads once it can grow
        ]
    )
    monkeypatch.setattr(router, "sidecar", engine)

    asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False, True], "the first spawn, then one asking to grow"
    assert engine.stops == 2


def test_the_retry_happens_once(bring_up, monkeypatch):
    """Failing again under `grow` is the card, not the arena: report, do not loop."""
    engine = _Sidecar(
        [
            {},
            {},
            {"error": OOM, "allocator": "preallocate"},
            {"error": OOM, "allocator": "grow"},
        ]
    )
    monkeypatch.setattr(router, "sidecar", engine)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False, True], "it did not keep restarting"
    assert "does not have room" in str(raised.value)


def test_a_load_that_is_not_an_oom_never_retries(bring_up, monkeypatch):
    engine = _Sidecar(
        [
            {},
            {},
            {"error": "checkpoint not found"},
        ]
    )
    monkeypatch.setattr(router, "sidecar", engine)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False], "the first spawn, and nothing after it"
    assert "download it under Models" in str(raised.value)


def test_a_load_that_just_works_starts_nothing_twice(bring_up, monkeypatch):
    engine = _Sidecar(
        [
            {},
            {},
            {"available": True},
        ]
    )
    monkeypatch.setattr(router, "sidecar", engine)

    asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False], "spawned once, under the fast allocator"
    assert engine.stops == 1
