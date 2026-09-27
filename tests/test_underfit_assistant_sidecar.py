"""The UNDERFIT assistant backend starts with the app, and the orb can start it.

The orb in the Underfit dashboard posts to underfit/assistant-backend on
:5473, and nothing launched that server. backend/modules/underfit/
assistant_sidecar.py now starts it at backend startup (next to the dashboard),
stops it with every other sidecar, and serves its status and a Start route.

A stand-in for the server (a small node script where tsx's cli.mjs would be)
answers /api/health and /api/shutdown the way server.ts does, so the real
spawn, the readiness wait, the status and the stop all run.
"""

from __future__ import annotations

import http.server
import json
import shutil
import socket
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.underfit import assistant_sidecar
from backend.modules.underfit import router as underfit_router
from backend.modules.underfit import sidecar as dashboard_sidecar

NODE = shutil.which("node") or shutil.which("node.exe")

# Where tsx's CLI sits: node runs it with "server.ts". This stand-in records
# the environment it was given and serves the two routes theDAW calls.
FAKE_SERVER = r"""
const http = require("http");
const fs = require("fs");
const path = require("path");
const port = Number(process.env.UNDERFIT_ASSISTANT_PORT);
fs.writeFileSync(path.join(process.cwd(), "spawned-env.json"), JSON.stringify({
  argv: process.argv.slice(2),
  UNDERFIT_ROOT: process.env.UNDERFIT_ROOT,
  UNDERFIT_MCP_PATH: process.env.UNDERFIT_MCP_PATH,
  UNDERFIT_DASHBOARD_PORT: process.env.UNDERFIT_DASHBOARD_PORT,
  FOUNDRY_ALLOWED_ORIGINS: process.env.FOUNDRY_ALLOWED_ORIGINS,
}));
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ app: "underfit-assistant", status: "ok" }));
  } else if (req.url === "/api/shutdown" && req.method === "POST") {
    fs.writeFileSync(path.join(process.cwd(), "shutdown-requested"), "1");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => server.close(() => process.exit(0)), 50);
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
});
server.listen(port, "127.0.0.1");
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def underfit_tree(tmp_path, monkeypatch):
    """An underfit checkout with an installed assistant-backend, in tmp_path."""
    root = tmp_path / "underfit"
    backend = root / "assistant-backend"
    cli = backend / "node_modules" / "tsx" / "dist" / "cli.mjs"
    cli.parent.mkdir(parents=True)
    (backend / "server.ts").write_text("// the real server.ts\n", encoding="utf-8")
    # .mjs is ESM; the stand-in uses require, so run it through a CJS file.
    (cli.parent / "fake.cjs").write_text(FAKE_SERVER, encoding="utf-8")
    cli.write_text(
        'import { createRequire } from "module";\n'
        "createRequire(import.meta.url)('./fake.cjs');\n",
        encoding="utf-8",
    )
    port = _free_port()
    dash_port = _free_port()
    monkeypatch.setenv("theDAW_UNDERFIT_PROJECT", str(root))
    monkeypatch.setenv("theDAW_UNDERFIT_PORT", str(dash_port))
    monkeypatch.setenv("theDAW_UNDERFIT_ASSISTANT_PORT", str(port))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(assistant_sidecar, "_proc", None)
    monkeypatch.setattr(assistant_sidecar, "_last_error", None)
    yield {"root": root, "backend": backend, "port": port, "dash_port": dash_port}
    assistant_sidecar.stop()


@pytest.mark.skipif(NODE is None, reason="node is not on PATH")
def test_start_waits_for_the_server_passes_its_paths_and_stop_asks_it_to_shut_down(
    underfit_tree,
):
    port = underfit_tree["port"]
    assert assistant_sidecar.probe()["running"] is False

    url = assistant_sidecar.ensure_running()

    assert url == f"http://localhost:{port}"
    status = assistant_sidecar.probe()
    assert status["running"] is True
    assert status["spawned_here"] is True
    assert status["error"] is None
    env = json.loads((underfit_tree["backend"] / "spawned-env.json").read_text())
    assert env["argv"] == ["server.ts"], "node runs tsx's CLI on server.ts directly"
    assert env["UNDERFIT_ROOT"] == str(underfit_tree["root"])
    assert env["UNDERFIT_MCP_PATH"] == str(underfit_tree["root"] / "mcp-server.cjs")
    assert env["UNDERFIT_DASHBOARD_PORT"] == str(underfit_tree["dash_port"])
    assert f"http://localhost:{underfit_tree['dash_port']}" in env[
        "FOUNDRY_ALLOWED_ORIGINS"
    ].split(",")
    # A second start reuses the running server.
    assert assistant_sidecar.ensure_running() == url

    assert assistant_sidecar.stop() is True
    assert (underfit_tree["backend"] / "shutdown-requested").exists()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and assistant_sidecar.probe()["running"]:
        time.sleep(0.1)
    assert assistant_sidecar.probe()["running"] is False
    assert assistant_sidecar.stop() is False, "nothing of ours is left to stop"


class _NotTheAssistant(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"app":"vst-foundry","status":"ok"}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_a_foreign_server_on_the_port_is_reported_and_never_stopped(underfit_tree):
    server = http.server.HTTPServer(
        ("127.0.0.1", underfit_tree["port"]), _NotTheAssistant
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(RuntimeError, match="not the UNDERFIT assistant"):
            assistant_sidecar.ensure_running()
        status = assistant_sidecar.probe()
        assert status["running"] is False
        assert "not the UNDERFIT assistant" in status["error"]
        assert assistant_sidecar.stop() is False
    finally:
        server.shutdown()
        server.server_close()


def test_missing_packages_without_npm_says_so_and_spawns_nothing(
    underfit_tree, monkeypatch
):
    shutil.rmtree(underfit_tree["backend"] / "node_modules")
    monkeypatch.setattr(assistant_sidecar, "_resolve_npm", lambda: None)
    status = assistant_sidecar.probe()
    assert status["installed"] is False
    assert any("npm was not found" in issue for issue in status["issues"])
    with pytest.raises(RuntimeError, match="npm was not found"):
        assistant_sidecar.ensure_running()
    assert assistant_sidecar._proc is None


def _join(prefix: str, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    for t in threading.enumerate():
        if t.name.startswith(prefix):
            t.join(max(0.0, deadline - time.monotonic()))


def test_backend_startup_starts_the_dashboard_and_the_assistant(monkeypatch):
    started: list[str] = []
    monkeypatch.delenv("theDAW_UNDERFIT_NO_AUTO_SPAWN", raising=False)
    monkeypatch.delenv("theDAW_UNDERFIT_ASSISTANT_NO_AUTO_SPAWN", raising=False)
    monkeypatch.setattr(underfit_router.updater, "check", lambda force=False: {})
    monkeypatch.setattr(
        dashboard_sidecar, "ensure_running", lambda **_: started.append("dashboard")
    )
    monkeypatch.setattr(
        assistant_sidecar, "ensure_running", lambda **_: started.append("assistant")
    )
    underfit_router.startup_underfit()
    _join("underfit-")
    assert sorted(started) == ["assistant", "dashboard"]

    started.clear()
    monkeypatch.setenv("theDAW_UNDERFIT_ASSISTANT_NO_AUTO_SPAWN", "1")
    underfit_router.startup_underfit()
    _join("underfit-")
    assert started == ["dashboard"]


def test_teardown_stops_the_assistant():
    from backend.core import teardown

    source = Path(teardown.__file__).read_text(encoding="utf-8")
    assert '("backend.modules.underfit.assistant_sidecar", "stop", False)' in source


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(underfit_router.router, prefix="/api/underfit")
    return TestClient(app)


def test_status_route_reports_the_probe(client, monkeypatch):
    monkeypatch.setattr(
        assistant_sidecar, "probe", lambda: {"running": False, "error": "boom"}
    )
    assert client.get("/api/underfit/assistant/status").json() == {
        "running": False,
        "error": "boom",
    }


def test_start_route_serves_the_dashboard_page_and_refuses_a_foreign_page(
    client, monkeypatch
):
    calls: list[bool] = []

    def fake_start(**_):
        calls.append(True)
        return "http://localhost:5473"

    monkeypatch.setattr(assistant_sidecar, "ensure_running", fake_start)
    refused = client.post(
        "/api/underfit/assistant/start",
        headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    )
    assert refused.status_code == 403
    assert calls == []

    ok = client.post(
        "/api/underfit/assistant/start",
        headers={"Origin": "http://localhost:8791", "Sec-Fetch-Site": "same-site"},
    )
    assert ok.status_code == 200
    assert ok.json() == {"ok": True, "url": "http://localhost:5473"}

    def failing(**_):
        raise RuntimeError("npm install exited 1")

    monkeypatch.setattr(assistant_sidecar, "ensure_running", failing)
    failed = client.post(
        "/api/underfit/assistant/start", headers={"Origin": "http://localhost:8791"}
    )
    assert failed.status_code == 503
    assert failed.json()["detail"] == "npm install exited 1"
