"""GET /api/underfit/runs and POST /api/underfit/runs/{id}/kill reach the
Underfit dashboard for the footer's UNDERFIT key.

A stub dashboard answers the two dashboard routes the proxy calls, the way
underfit/dashboard/server.py does: its runs list, a kill that succeeds, a kill
it refuses, and no dashboard at all.
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

    def do_GET(self):  # noqa: N802 - http.server's name
        if self.path == "/api/runs":
            self._send(200, type(self).runs)
        else:
            self._send(404, {"error": "no route"})

    def do_POST(self):  # noqa: N802
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
