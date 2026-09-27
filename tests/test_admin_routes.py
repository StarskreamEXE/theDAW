"""POST /api/admin/shutdown and /api/admin/restart.

The bug these cover: both ended the process with ``os._exit`` straight after
stopping the sidecars, so the app's shutdown handlers -- the background queue,
the assistant's ``claude`` children, the live VST hosts saving their plugin
state -- never ran. ``backend/ports.py`` said they did, and ``--free`` makes
this call on every launch.

``os._exit`` and the sidecar teardown are replaced by recorders in every test
here; each test waits for the recorded exit before it returns, so the exit
thread never outlives the patch.
"""

from __future__ import annotations

import asyncio
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import admin_routes

REPO_ROOT = Path(__file__).resolve().parent.parent


def _app(events: list, handlers=None) -> FastAPI:
    """An app wired the way backend/server.py wires the real one: the lifespan
    publishes its shutdown coroutine on app.state for the admin routes."""

    async def record_handlers() -> None:
        events.append("handlers")

    @asynccontextmanager
    async def lifespan(app_: FastAPI):
        app_.state.run_shutdown_handlers = handlers or record_handlers
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(admin_routes.router)
    return app


@pytest.fixture
def exits(monkeypatch: pytest.MonkeyPatch):
    events: list = []
    exited = threading.Event()

    def fake_exit(code: int) -> None:
        events.append(("exit", code))
        exited.set()

    monkeypatch.setattr(os, "_exit", fake_exit)
    import backend.core.teardown as teardown

    monkeypatch.setattr(
        teardown, "stop_all_sidecars", lambda: events.append("sidecars")
    )
    return events, exited


@pytest.mark.parametrize(
    "headers",
    [
        {},  # backend.ports --free and the desktop shell: no browser headers
        {"Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-site"},  # the UI
    ],
)
def test_shutdown_runs_the_apps_shutdown_handlers_before_the_process_exits(
    exits, headers: dict
):
    events, exited = exits
    with TestClient(_app(events)) as client:
        response = client.post("/api/admin/shutdown", headers=headers)
        assert response.status_code == 200
        assert exited.wait(10), "the process never exited"
    first_exit = events.index(("exit", 0))
    assert "handlers" in events[:first_exit], f"exit came first: {events}"


def test_restart_runs_them_too_and_exits_with_the_respawn_code(
    exits, monkeypatch: pytest.MonkeyPatch
):
    """A restart that skips them orphans every claude child and drops the live
    plugins' unsaved state, exactly as a shutdown would."""
    monkeypatch.setenv(admin_routes.SUPERVISOR_ENV_FLAG, "1")
    events, exited = exits
    with TestClient(_app(events)) as client:
        assert client.post("/api/admin/restart").status_code == 200
        assert exited.wait(10), "the process never exited"
    first_exit = events.index(("exit", admin_routes.RESTART_EXIT_CODE))
    assert "handlers" in events[:first_exit]


def test_hung_handlers_cannot_keep_the_process_alive(
    exits, monkeypatch: pytest.MonkeyPatch
):
    """The handlers get a budget. Past it the process exits anyway, and the
    sidecars are still stopped so none is left holding its port."""
    monkeypatch.setattr(admin_routes, "SHUTDOWN_HANDLER_BUDGET_SEC", 0.3)
    events, exited = exits

    async def hang() -> None:
        await asyncio.sleep(30)

    with TestClient(_app(events, handlers=hang)) as client:
        assert client.post("/api/admin/shutdown").status_code == 200
        assert exited.wait(10), "a hung handler kept the process alive"
    assert events == ["sidecars", ("exit", 0)]


def test_an_app_without_a_lifespan_still_stops_its_sidecars(exits):
    events, exited = exits
    app = FastAPI()
    app.include_router(admin_routes.router)
    with TestClient(app) as client:
        assert client.post("/api/admin/shutdown").status_code == 200
        assert exited.wait(10)
    assert events == ["sidecars", ("exit", 0)]


@pytest.mark.parametrize("route", ["/api/admin/shutdown", "/api/admin/restart"])
def test_a_page_outside_thedaw_cannot_stop_the_backend(
    exits, monkeypatch: pytest.MonkeyPatch, route: str
):
    """A plain POST needs no CORS preflight, so any site the user had open
    could stop theDAW with one fetch(). The browser labels that request as
    cross-site and page script cannot change the label."""
    monkeypatch.setenv(admin_routes.SUPERVISOR_ENV_FLAG, "1")
    events, exited = exits
    with TestClient(_app(events)) as client:
        response = client.post(
            route,
            headers={"Origin": "https://example.com", "Sec-Fetch-Site": "cross-site"},
        )
        assert response.status_code == 403
        # Longer than the exit thread's delay: nothing was scheduled at all.
        assert not exited.wait(1.5), f"a foreign page stopped the backend: {events}"
    assert events == []


def test_the_real_lifespan_publishes_its_shutdown_handlers():
    """backend/server.py is what the routes read the handlers from; importing it
    here would start every module, so its lifespan is read as source."""
    source = (REPO_ROOT / "backend" / "server.py").read_text(encoding="utf-8")
    body = source[source.index("async def _lifespan") : source.index("app = FastAPI(")]
    register = body.index("setattr(app_.state, SHUTDOWN_HANDLERS_STATE, _on_shutdown)")
    assert register < body.index("\n    yield\n")
    assert admin_routes.SHUTDOWN_HANDLERS_STATE == "run_shutdown_handlers"
