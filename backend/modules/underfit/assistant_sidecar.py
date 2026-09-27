"""Run the UNDERFIT assistant backend (underfit/assistant-backend) as a sidecar.

The assistant orb bundled into the Underfit dashboard (frontend
src/views/underfit/UnderfitAssistantOrb.tsx, built into
underfit/dashboard/assistant/underfit-orb.js) talks to its own Node/Express
server on :5473 (``server.ts``). Nothing started that server, so the orb's
every request failed. This module starts it next to the dashboard at backend
startup (router.startup_underfit), stops it with every other sidecar
(core/teardown.py), and gives the orb a status and a Start action through
/api/underfit/assistant/status and /api/underfit/assistant/start.

The server runs as ``node node_modules/tsx/dist/cli.mjs server.ts``: node
itself is the child, so ``stop()`` terminates the server and not an npm or
cmd.exe wrapper that would leave node running. ``node_modules`` is installed
with ``npm install`` the first time it is missing, from the checked-in
package-lock.json, the same way the Foundry sidecar installs its own.

Only a process THIS backend spawned is ever stopped: an assistant already
answering on the port (started by hand, or by another backend) is reused and
left alone.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Optional

from backend.lib import paths
from backend.lib.launch_token import child_env

from . import sidecar as dashboard_sidecar

log = logging.getLogger(__name__)

DEFAULT_PORT = 5473
#: The server is 4,700 lines of TypeScript that tsx compiles on start.
PORT_READY_TIMEOUT_SEC = 60.0
PORT_POLL_INTERVAL_SEC = 0.5
#: What ``GET /api/health`` names itself (server.ts).
HEALTH_APP_ID = "underfit-assistant"


@dataclass(frozen=True)
class AssistantConfig:
    project_path: Path
    port: int
    underfit_root: Path
    dashboard_port: int


_state_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None
#: The last start failure, shown by /status until a start succeeds.
_last_error: Optional[str] = None


def log_path() -> Path:
    """Where the server's output goes. Resolved per call so a test that points
    theDAW_DATA_DIR elsewhere is honoured."""
    return paths.data_path("logs", "underfit-assistant.log")


def _log_tail(n: int = 30) -> str:
    try:
        with open(log_path(), "rb") as fh:
            lines = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-n:])


def resolve_config() -> AssistantConfig:
    dash = dashboard_sidecar.resolve_config()
    project_env = os.getenv("theDAW_UNDERFIT_ASSISTANT_PROJECT")
    project_path = (
        Path(project_env).expanduser().resolve()
        if project_env
        else dash.project_path / "assistant-backend"
    )
    port_env = os.getenv("theDAW_UNDERFIT_ASSISTANT_PORT")
    try:
        port = int(port_env) if port_env else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    return AssistantConfig(
        project_path=project_path,
        port=port,
        underfit_root=dash.project_path,
        dashboard_port=dash.port,
    )


def _resolve_node() -> Optional[str]:
    """THEDAW_NODE, else node on PATH (the packaged app puts its bundled node
    first on PATH)."""
    explicit = os.getenv("THEDAW_NODE")
    if explicit:
        return explicit
    return shutil.which("node") or shutil.which("node.exe")


def _resolve_npm() -> Optional[str]:
    return shutil.which("npm.cmd") or shutil.which("npm")


def _tsx_cli(cfg: AssistantConfig) -> Path:
    return cfg.project_path / "node_modules" / "tsx" / "dist" / "cli.mjs"


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def _is_assistant_server(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=1.0
        ) as response:
            body = json.loads(response.read(2048).decode("utf-8", "replace"))
    except (OSError, urllib.error.URLError, ValueError):
        return False
    return isinstance(body, dict) and body.get("app") == HEALTH_APP_ID


def probe() -> dict:
    """Non-spawning status for /api/underfit/assistant/status."""
    cfg = resolve_config()
    issues: list[str] = []
    if not (cfg.project_path / "server.ts").is_file():
        issues.append(f"no assistant server at {cfg.project_path / 'server.ts'}")
    if not _resolve_node():
        issues.append("Node.js was not found on PATH, so the assistant cannot run.")
    elif not _tsx_cli(cfg).is_file() and not _resolve_npm():
        issues.append(
            "The assistant's packages are not installed and npm was not found on "
            "PATH to install them."
        )
    running = _is_assistant_server(cfg.port)
    alive = _proc is not None and _proc.poll() is None
    return {
        "port": cfg.port,
        "url": f"http://localhost:{cfg.port}",
        "running": running,
        "starting": alive and not running,
        "spawned_here": alive,
        "installed": _tsx_cli(cfg).is_file(),
        "issues": issues,
        "error": None if running else _last_error,
        "log_path": str(log_path()),
    }


def _child_env(cfg: AssistantConfig) -> dict[str, str]:
    env = child_env()
    env["UNDERFIT_ASSISTANT_PORT"] = str(cfg.port)
    env["UNDERFIT_ROOT"] = str(cfg.underfit_root)
    env["UNDERFIT_MCP_PATH"] = str(cfg.underfit_root / "mcp-server.cjs")
    env["UNDERFIT_DASHBOARD_PORT"] = str(cfg.dashboard_port)
    # The orb is served by the dashboard; server.ts already allows :8791, and
    # this adds the dashboard's real port when theDAW_UNDERFIT_PORT moved it.
    origins = [
        f"http://localhost:{cfg.dashboard_port}",
        f"http://127.0.0.1:{cfg.dashboard_port}",
    ]
    existing = env.get("FOUNDRY_ALLOWED_ORIGINS", "")
    env["FOUNDRY_ALLOWED_ORIGINS"] = ",".join(filter(None, [existing, *origins]))
    return env


def _install(cfg: AssistantConfig) -> None:
    npm = _resolve_npm()
    if not npm:
        raise RuntimeError(
            "The assistant's packages are not installed and npm was not found on PATH."
        )
    log.info("underfit.assistant: node_modules missing, running npm install")
    target = log_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "ab") as fh:
        try:
            rc = subprocess.call(
                [npm, "install"],
                cwd=str(cfg.project_path),
                stdout=fh,
                stderr=fh,
                shell=False,
                env=child_env(),
            )
        except OSError as e:
            raise RuntimeError(f"npm install could not run: {e}") from e
    if rc != 0 or not _tsx_cli(cfg).is_file():
        raise RuntimeError(
            f"npm install in {cfg.project_path} exited {rc}."
            f"\n--- {target.name} (tail) ---\n{_log_tail()}"
        )


def ensure_running(*, wait_for_ready: bool = True) -> str:
    """Start the assistant server unless one already answers; return its URL."""
    global _proc, _last_error
    with _state_lock:
        cfg = resolve_config()
        url = f"http://localhost:{cfg.port}"
        try:
            if _is_assistant_server(cfg.port):
                _last_error = None
                return url
            if _port_is_listening(cfg.port):
                raise RuntimeError(
                    f"Port {cfg.port} is in use by something that is not the "
                    "UNDERFIT assistant."
                )
            if _proc is None or _proc.poll() is not None:
                if not (cfg.project_path / "server.ts").is_file():
                    raise RuntimeError(
                        f"No assistant server at {cfg.project_path / 'server.ts'}."
                    )
                node = _resolve_node()
                if not node:
                    raise RuntimeError(
                        "Node.js was not found on PATH, so the assistant cannot run."
                    )
                if not _tsx_cli(cfg).is_file():
                    _install(cfg)
                target = log_path()
                target.parent.mkdir(parents=True, exist_ok=True)
                cmd = [node, str(_tsx_cli(cfg)), "server.ts"]
                log.info(
                    "underfit.assistant: spawning %s (cwd=%s, port=%s)",
                    " ".join(cmd),
                    cfg.project_path,
                    cfg.port,
                )
                creationflags = (
                    subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
                )
                with open(target, "ab") as fh:
                    try:
                        _proc = subprocess.Popen(
                            cmd,
                            cwd=str(cfg.project_path),
                            env=_child_env(cfg),
                            stdout=fh,
                            stderr=fh,
                            creationflags=creationflags,
                            shell=False,
                        )
                    except OSError as e:
                        raise RuntimeError(
                            f"Failed to launch the UNDERFIT assistant: {e}"
                        ) from e
            if not wait_for_ready:
                return url
            deadline = time.monotonic() + PORT_READY_TIMEOUT_SEC
            while time.monotonic() < deadline:
                if _is_assistant_server(cfg.port):
                    log.info("underfit.assistant: ready at %s", url)
                    _last_error = None
                    return url
                if _proc is not None and _proc.poll() is not None:
                    raise RuntimeError(
                        "The UNDERFIT assistant exited before it answered "
                        f"(rc={_proc.returncode})."
                        f"\n--- {log_path().name} (tail) ---\n{_log_tail()}"
                    )
                time.sleep(PORT_POLL_INTERVAL_SEC)
            raise RuntimeError(
                f"The UNDERFIT assistant did not answer on port {cfg.port} within "
                f"{int(PORT_READY_TIMEOUT_SEC)}s. See {log_path()}."
            )
        except RuntimeError as e:
            _last_error = str(e)
            raise


def _request_shutdown(port: int) -> bool:
    """Ask the server to shut down; it stops its Claude CLI children first."""
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/shutdown",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=2.0) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


def stop() -> bool:
    """Stop the server THIS process spawned. A foreign one is left running.

    The server is asked to shut down first (POST /api/shutdown), which ends
    the Claude CLI sessions it started; ``terminate()`` alone kills node on
    Windows without letting it stop them."""
    global _proc
    with _state_lock:
        if _proc is None:
            return False
        proc, _proc = _proc, None
        if proc.poll() is not None:
            return False
        if _request_shutdown(resolve_config().port):
            try:
                proc.wait(timeout=12.0)
                return True
            except subprocess.TimeoutExpired:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5.0)
        return True


def _atexit_stop() -> None:
    """Stop our server when the backend exits normally. Never raises."""
    try:
        stop()
    except (OSError, RuntimeError, subprocess.SubprocessError) as e:
        log.debug("underfit.assistant: stop at exit failed: %s", e)


atexit.register(_atexit_stop)
