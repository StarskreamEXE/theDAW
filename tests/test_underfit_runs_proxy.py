"""The four /api/underfit/runs routes reach the Underfit dashboard for the
footer's TRAIN key: the runs list, a run's settings, a start, and a kill.

A stub dashboard answers the dashboard routes the proxy calls, the way
underfit/dashboard/server.py does — including its habit of answering 200 with
{"error": ...} rather than a status code.
"""

from __future__ import annotations

import http.server
import json
import socket
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import backend.modules.underfit.router as underfit_router
from backend.modules.underfit import sidecar


class _Dashboard(http.server.BaseHTTPRequestHandler):
    runs: list = []
    kills: list = []
    kill_reply: tuple = (200, {"ok": True, "status": "killed"})
    clone_paths: list = []
    clone_reply: tuple = (200, {"base_model": "sa3-medium", "dataset_id": "ds1"})
    new_bodies: list = []
    new_reply: tuple = (200, {"ok": True, "id": "r2"})

    def do_GET(self):  # noqa: N802 - http.server's name
        if self.path == "/api/runs":
            self._send(200, type(self).runs)
        elif self.path.startswith("/api/clone_settings"):
            type(self).clone_paths.append(self.path)
            self._send(*type(self).clone_reply)
        else:
            self._send(404, {"error": "no route"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        if self.path == "/api/runs/new":
            type(self).new_bodies.append(json.loads(raw or b"{}"))
            self._send(*type(self).new_reply)
            return
        type(self).kills.append(self.path)
        self._send(*type(self).kill_reply)

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def _config(port: int) -> sidecar.UnderfitConfig:
    here = Path(".")
    return sidecar.UnderfitConfig(
        project_path=here, port=port, python_path=here, server_script=here
    )


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(underfit_router.router, prefix="/api/underfit")
    return TestClient(app)


@pytest.fixture
def dashboard(monkeypatch):
    _Dashboard.runs = []
    _Dashboard.kills = []
    _Dashboard.kill_reply = (200, {"ok": True, "status": "killed"})
    _Dashboard.clone_paths = []
    _Dashboard.clone_reply = (200, {"base_model": "sa3-medium", "dataset_id": "ds1"})
    _Dashboard.new_bodies = []
    _Dashboard.new_reply = (200, {"ok": True, "id": "r2"})
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Dashboard)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(
        sidecar, "resolve_config", lambda: _config(httpd.server_address[1])
    )
    yield _Dashboard
    httpd.shutdown()
    httpd.server_close()


def test_runs_come_back_with_the_fields_the_key_reads(client, dashboard):
    dashboard.runs = [
        {
            "id": "r1",
            "display_name": "vox",
            "status": "training",
            "created_at": "2026-09-13",
            "max_steps": 900,
            "pid": 4242,
            "gpu": 0,
        },
        {"display_name": "no id"},
    ]

    reply = client.get("/api/underfit/runs")

    assert reply.status_code == 200
    assert reply.json() == {
        "reachable": True,
        "runs": [
            {
                "id": "r1",
                "display_name": "vox",
                "status": "training",
                "created_at": "2026-09-13",
                "max_steps": 900,
                "gpu": 0,
            }
        ],
    }


def test_kill_reaches_the_dashboard_with_the_id_escaped(client, dashboard):
    reply = client.post("/api/underfit/runs/run%20one%3F/kill")

    assert reply.status_code == 200
    assert reply.json() == {"ok": True, "status": "killed"}
    assert dashboard.kills == ["/api/runs/run%20one%3F/kill"]


def test_a_refused_kill_carries_the_dashboards_message(client, dashboard):
    dashboard.kill_reply = (400, {"error": "cannot stop run in state 'killed'"})

    reply = client.post("/api/underfit/runs/r1/kill")

    assert reply.status_code == 400
    assert reply.json() == {"detail": "cannot stop run in state 'killed'"}


def test_no_dashboard(client, monkeypatch):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setattr(sidecar, "resolve_config", lambda: _config(port))

    runs = client.get("/api/underfit/runs")
    kill = client.post("/api/underfit/runs/r1/kill")

    assert runs.status_code == 200
    assert runs.json()["reachable"] is False
    assert runs.json()["runs"] == []
    assert kill.status_code == 503


def test_a_runs_settings_come_back_for_a_repeat(client, dashboard):
    dashboard.clone_reply = (
        200,
        {"base_model": "sa3-medium", "dataset_id": "ds1", "rank": 32, "lr": 0.0001},
    )

    reply = client.get("/api/underfit/runs/run%20one%3F/config")

    assert reply.status_code == 200
    assert reply.json()["rank"] == 32
    assert dashboard.clone_paths == ["/api/clone_settings?run_id=run%20one%3F"]


def test_settings_for_a_run_the_dashboard_cannot_read_are_a_404(client, dashboard):
    """The dashboard answers 200 with an error body; the app must not start on it."""
    dashboard.clone_reply = (200, {"error": "run not found"})

    reply = client.get("/api/underfit/runs/gone/config")

    assert reply.status_code == 404
    assert reply.json() == {"detail": "run not found"}


def test_a_start_passes_the_whole_body_through(client, dashboard):
    body = {"name": "vox 2", "gpu": 1, "base_model": "sa3-medium", "rank": 32}

    reply = client.post("/api/underfit/runs/new", json=body)

    assert reply.status_code == 200
    assert reply.json() == {"ok": True, "id": "r2"}
    assert dashboard.new_bodies == [body]


def test_a_refused_start_carries_the_dashboards_message(client, dashboard):
    dashboard.new_reply = (409, {"error": "A run with name 'vox-2' already exists"})

    reply = client.post("/api/underfit/runs/new", json={"name": "vox 2", "gpu": 0})

    assert reply.status_code == 409
    assert reply.json() == {"detail": "A run with name 'vox-2' already exists"}


def test_a_start_the_dashboard_refuses_with_a_200_error_body_is_a_400(
    client, dashboard
):
    dashboard.new_reply = (200, {"error": "gpu is required"})

    reply = client.post("/api/underfit/runs/new", json={"name": "vox 2"})

    assert reply.status_code == 400
    assert reply.json() == {"detail": "gpu is required"}
