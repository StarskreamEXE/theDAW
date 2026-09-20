"""Unit tests for backend.modules.lyria.sidecar, backend.modules.lyria.router,
and the Lyria provider status block in backend.modules.storage.router (T07 /
batch 12, plus the T07 audit follow-up).

Covers:
  * INT-001 -- a bare TCP listener on the sidecar's port must not be adopted
    as "our sidecar" without an identity check against Lyria's own
    `/api/settings/status` response shape.
  * INT-003 -- `ensure_running()` must not hold `_state_lock` while running
    `npm install`, so `stop()`/`probe()` are never blocked behind it.
  * INT-004 -- the storage router's Lyria provider status must treat a
    confirmed-listening sidecar as "ready" even when static prerequisite
    checks (key/deps/etc.) currently report issues.
  * Audit item 1 -- stop() called while ensure_running() is mid-install or
    mid-Popen must prevent that spawn from completing, or it orphans a Node
    process holding the port.
  * Audit item 2 -- the identity check must ignore HTTP_PROXY/system proxy
    settings; our own loopback sidecar must never be routed through a proxy.
  * Audit item 3 -- `_ensure_deps` (called both by ensure_running() and by
    the Install button's `_install_worker`) must serialize its node_modules
    check + `npm install` call so two callers never install concurrently.
  * Audit item 4 -- the router's /url, /status, /start routes must offload
    their blocking sidecar calls via `asyncio.to_thread`.
  * Audit item 5 -- an adopted listener that isn't our own spawned process
    must not be reported as "mock"/"live"; its cost mode is unknown.
  * Audit item 6 -- a "ready" (listening) sidecar in live mode with no key
    configured must still surface the key warning in its summary.
  * Audit item 7 -- concurrent ensure_running() callers must install once and
    spawn once.

Re-audit follow-up (round 2):
  * Item 1 -- router.py's /stop, POST /key, and /url's owns_process() call
    must also be offloaded via asyncio.to_thread (stop() can taskkill+wait
    for ~10s worst case).
  * Item 2 -- the identity check must not raise for a non-HTTP listener (an
    SSH-style banner raises http.client.HTTPException, not OSError/URLError).
  * Item 3 -- a stop() during the readiness wait must abort immediately, not
    be silently ignored until the 90s deadline.
  * Item 5 -- ensure_running() must wait for an in-progress stop() to finish
    tearing down the previous process before probing/adopting.
  * Item 6 -- the network identity probe must run OUTSIDE _state_lock.
  * Item 8 -- concurrency tests use a Barrier for determinism and assert
    real lock contention, not just call counts.

No real npm/node process is spawned -- `_ensure_deps` and `subprocess.Popen`
are monkeypatched. A throwaway `http.server` (or raw TCP listener, for the
non-HTTP-banner case) stands in for "something listening on the port" to
exercise the identity check without the real Lyria checkout.
"""

from __future__ import annotations

import asyncio
import http.server
import json
import socket
import threading
import time
from contextlib import contextmanager
from typing import Iterator

import pytest

from backend.modules.lyria import sidecar


@pytest.fixture(autouse=True)
def _reset_sidecar_module_state():
    """The sidecar tracks its child process/URL/stop-request in module
    globals, which persist across tests in the same process. Reset them
    around every test so one test's fake spawned process can't leak into the
    next test's "is anything running" checks."""
    sidecar._proc = None
    sidecar._resolved_url = None
    sidecar._stop_requested = False
    sidecar._stopping.clear()
    yield
    sidecar._proc = None
    sidecar._resolved_url = None
    sidecar._stop_requested = False
    sidecar._stopping.clear()


# ---------------------------------------------------------------------------
# Throwaway HTTP servers used to fake "something is listening on the port"
# ---------------------------------------------------------------------------


class _LyriaLikeHandler(http.server.BaseHTTPRequestHandler):
    """Answers /api/settings/status exactly like the real Lyria server does."""

    def log_message(self, *args: object) -> None:  # noqa: D102 - silence test logs
        pass

    def do_GET(self) -> None:  # noqa: N802 - stdlib method name
        if self.path == "/api/settings/status":
            body = json.dumps(
                {
                    "geminiServerKey": False,
                    "openRouterServerKey": False,
                    "defaultProvider": "gemini",
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


class _UnrelatedHandler(http.server.BaseHTTPRequestHandler):
    """Some other dev server that happens to be listening on the port."""

    def log_message(self, *args: object) -> None:  # noqa: D102
        pass

    def do_GET(self) -> None:  # noqa: N802
        body = b"<html>not lyria</html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def _run_server(
    handler: type[http.server.BaseHTTPRequestHandler],
) -> Iterator[int]:
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)


@contextmanager
def _run_raw_banner_listener(
    banner: bytes = b"SSH-2.0-OpenSSH_9.6\r\n",
) -> Iterator[int]:
    """A raw TCP listener that sends a non-HTTP banner on connect, like SSH.
    http.client raises http.client.HTTPException (BadStatusLine) parsing
    this as an HTTP response -- a different exception hierarchy than
    OSError/URLError."""
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.bind(("127.0.0.1", 0))
    server_sock.listen(5)
    server_sock.settimeout(0.2)
    port = server_sock.getsockname()[1]
    stop_flag = threading.Event()

    def _serve() -> None:
        while not stop_flag.is_set():
            try:
                conn, _addr = server_sock.accept()
            except socket.timeout:
                continue
            try:
                conn.sendall(banner)
            except OSError:
                pass
            finally:
                conn.close()

    thread = threading.Thread(target=_serve, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        stop_flag.set()
        thread.join(timeout=5.0)
        server_sock.close()


# ---------------------------------------------------------------------------
# INT-001 -- identity check
# ---------------------------------------------------------------------------


def test_is_lyria_server_true_for_matching_settings_status():
    with _run_server(_LyriaLikeHandler) as port:
        assert sidecar._is_lyria_server(port) is True


def test_is_lyria_server_false_for_unrelated_listener():
    with _run_server(_UnrelatedHandler) as port:
        assert sidecar._is_lyria_server(port) is False


def test_is_lyria_server_false_when_nothing_listening():
    # Port 1 is a privileged, essentially-never-bound port on every platform.
    assert sidecar._is_lyria_server(1) is False


# ---------------------------------------------------------------------------
# Re-audit item 2 -- identity check must not raise for a non-HTTP listener
# ---------------------------------------------------------------------------


def test_is_lyria_server_false_for_non_http_banner_listener():
    """An SSH-style banner (or any non-HTTP protocol) makes http.client raise
    http.client.HTTPException parsing it as an HTTP response -- a different
    exception hierarchy than OSError/URLError. Uncaught, that would propagate
    out of probe()/ensure_running() as an unhandled 500 instead of the
    intended "port in use" 503."""
    with _run_raw_banner_listener() as port:
        assert sidecar._is_lyria_server(port) is False


def test_probe_does_not_raise_for_non_http_banner_listener(monkeypatch):
    with _run_raw_banner_listener() as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        out = sidecar.probe()  # must not raise
        assert out["listening"] is False
        assert any("already in use" in issue for issue in out["issues"])


def test_ensure_running_raises_runtimeerror_not_httpexception_for_banner_listener(
    monkeypatch,
):
    with _run_raw_banner_listener() as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        with pytest.raises(RuntimeError, match="already in use"):
            sidecar.ensure_running(wait_for_ready=False)


def test_probe_reports_not_listening_when_port_held_by_unrelated_process(
    monkeypatch,
):
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        out = sidecar.probe()
        assert out["listening"] is False
        assert any("already in use" in issue for issue in out["issues"])


def test_probe_reports_listening_when_identity_confirmed(monkeypatch):
    with _run_server(_LyriaLikeHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        out = sidecar.probe()
        assert out["listening"] is True
        assert not any("already in use" in issue for issue in out["issues"])


def test_ensure_running_raises_instead_of_adopting_unrelated_listener(monkeypatch):
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        with pytest.raises(RuntimeError, match="already in use"):
            sidecar.ensure_running(wait_for_ready=False)


def test_ensure_running_adopts_confirmed_lyria_listener(monkeypatch):
    with _run_server(_LyriaLikeHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        url = sidecar.ensure_running(wait_for_ready=False)
        assert url == f"http://127.0.0.1:{port}"


# ---------------------------------------------------------------------------
# INT-003 -- npm install must not hold _state_lock
# ---------------------------------------------------------------------------


def test_ensure_deps_does_not_block_stop_or_probe(monkeypatch, tmp_path):
    """While the (fake, slow) npm install runs, stop() and probe() -- which
    only need _state_lock -- must return promptly instead of queueing behind
    the install. Before the INT-003 fix, ensure_running() held _state_lock
    for the entire `_ensure_deps` call, so stop() would block for the full
    install duration."""
    project = tmp_path / "lyria-project"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")

    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")  # never actually listening

    install_started = threading.Event()
    release_install = threading.Event()

    def _slow_ensure_deps(cfg: sidecar.LyriaConfig) -> None:
        install_started.set()
        release_install.wait(timeout=5.0)

    def _fake_popen(*args: object, **kwargs: object):
        raise FileNotFoundError("no real npm in this test")

    monkeypatch.setattr(sidecar, "_ensure_deps", _slow_ensure_deps)
    monkeypatch.setattr(sidecar.subprocess, "Popen", _fake_popen)

    # Force port 0 to never "listen" for the duration of this test.
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )

    result: dict = {}

    def _run_ensure_running() -> None:
        try:
            sidecar.ensure_running(wait_for_ready=False)
        except Exception as exc:  # noqa: BLE001 - captured for the assertion below
            result["error"] = exc

    thread = threading.Thread(target=_run_ensure_running, daemon=True)
    thread.start()
    try:
        assert install_started.wait(timeout=5.0), "install never started"

        start = time.monotonic()
        with sidecar._state_lock:
            pass  # acquiring it proves it isn't held by the in-progress install
        elapsed = time.monotonic() - start
        assert elapsed < 1.0, (
            f"_state_lock was held for {elapsed:.2f}s -- npm install is still "
            "blocking it (INT-003 regression)"
        )

        # probe() must also return promptly (it takes _state_lock nowhere
        # directly, but this proves the module isn't deadlocked either way).
        out = sidecar.probe()
        assert isinstance(out, dict)
    finally:
        release_install.set()
        thread.join(timeout=5.0)
        assert not thread.is_alive()


# ---------------------------------------------------------------------------
# INT-004 -- storage router "ready" must honour a confirmed-listening sidecar
# ---------------------------------------------------------------------------


def test_lyria_provider_status_ready_when_listening_despite_issues(monkeypatch):
    from backend.modules.storage import router

    def _fake_probe():
        return {
            "project_path": "/fake/lyria",
            "issues": [
                "GEMINI_API_KEY is not set: live mode cannot generate without it."
            ],
            "missing": ["key"],
            "install": {},
            "gemini_key": False,
            "gemini_key_source": "none",
            "listening": True,
            # We spawned this process ourselves -- its cost mode IS what
            # theDAW's own LYRIA_MOCK setting says.
            "process_alive": True,
            "repo": sidecar.LYRIA_REPO,
            "repo_url": sidecar.LYRIA_REPO_URL,
            "git": True,
            "node": True,
            "npm": True,
            "installable": True,
        }

    monkeypatch.setattr(sidecar, "probe", _fake_probe)
    monkeypatch.setattr(sidecar, "is_mock", lambda: True)

    status = router._lyria_provider_status()
    assert status["state"] == "ready"
    assert status["active"] is True
    assert status["lyria"]["listening"] is True
    assert "Mock mode" in status["summary"]


def test_lyria_provider_status_not_ready_when_not_listening_and_issues(monkeypatch):
    from backend.modules.storage import router

    def _fake_probe():
        return {
            "project_path": "/fake/lyria",
            "issues": [
                "GEMINI_API_KEY is not set: live mode cannot generate without it."
            ],
            "missing": ["key"],
            "install": {},
            "gemini_key": False,
            "gemini_key_source": "none",
            "listening": False,
            "repo": sidecar.LYRIA_REPO,
            "repo_url": sidecar.LYRIA_REPO_URL,
            "git": True,
            "node": True,
            "npm": True,
            "installable": True,
        }

    monkeypatch.setattr(sidecar, "probe", _fake_probe)
    monkeypatch.setattr(sidecar, "is_mock", lambda: True)

    status = router._lyria_provider_status()
    assert status["state"] == "needs_setup"
    assert status["active"] is False


# ---------------------------------------------------------------------------
# Audit item 1 -- stop() mid-install/mid-spawn must not orphan a process
# ---------------------------------------------------------------------------


def test_stop_mid_install_prevents_orphan_process(monkeypatch, tmp_path):
    """stop() called while ensure_running() is still inside `_ensure_deps`
    (before _proc exists) must prevent the pending spawn from ever calling
    Popen -- otherwise stop()'s "_proc is None" early return has nothing to
    kill, and the install completes into an orphaned Node process moments
    later with nothing left tracking it."""
    project = tmp_path / "lyria-project-stop"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )

    install_started = threading.Event()
    release_install = threading.Event()
    popen_called = threading.Event()

    def _slow_ensure_deps(cfg: sidecar.LyriaConfig) -> None:
        install_started.set()
        release_install.wait(timeout=5.0)

    def _fake_popen(*args: object, **kwargs: object):
        popen_called.set()
        raise RuntimeError("Popen must not run once stop() fired mid-install")

    monkeypatch.setattr(sidecar, "_ensure_deps", _slow_ensure_deps)
    monkeypatch.setattr(sidecar.subprocess, "Popen", _fake_popen)

    result: dict = {}

    def _run() -> None:
        try:
            sidecar.ensure_running(wait_for_ready=False)
        except Exception as exc:  # noqa: BLE001 - captured for the assertion below
            result["error"] = exc

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    try:
        assert install_started.wait(timeout=5.0), "install never started"

        # Nothing is running yet, so stop() has nothing to physically kill --
        # but it must still flag the in-flight spawn to abort.
        assert sidecar.stop() is False

        release_install.set()
        thread.join(timeout=5.0)
        assert not thread.is_alive()
    finally:
        release_install.set()

    assert not popen_called.is_set(), (
        "ensure_running() called Popen after stop() was requested mid-install "
        "-- this orphans a Node process (item 1 regression)"
    )
    assert isinstance(result.get("error"), RuntimeError)
    assert str(result["error"]) == "stopped"
    assert sidecar._proc is None


def test_ensure_running_terminates_process_spawned_during_a_stop_race(
    monkeypatch, tmp_path
):
    """Covers the narrower window: stop() arrives during the Popen() call
    itself, after _ensure_deps already returned. The freshly-spawned process
    must be terminated immediately rather than handed off to module state."""
    project = tmp_path / "lyria-project-stop-race"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )
    monkeypatch.setattr(sidecar, "_ensure_deps", lambda cfg: None)

    terminated: dict = {}

    class _FakeProc:
        pid = 999999

        def poll(self) -> None:
            return None

    def _terminate_stub(proc: object) -> None:
        terminated["proc"] = proc

    def _fake_popen(*args: object, **kwargs: object) -> _FakeProc:
        # Simulate stop() racing in exactly during Popen() -- the only way to
        # deterministically hit this window in a unit test.
        sidecar._stop_requested = True
        return _FakeProc()

    monkeypatch.setattr(sidecar.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(sidecar, "_terminate_proc", _terminate_stub)

    with pytest.raises(RuntimeError, match="stopped"):
        sidecar.ensure_running(wait_for_ready=False)

    assert isinstance(terminated.get("proc"), _FakeProc)
    assert sidecar._proc is None
    # The flag is consumed (read-and-cleared) by the check that caught it.
    assert sidecar._stop_requested is False


# ---------------------------------------------------------------------------
# Audit item 2 -- identity check must ignore HTTP_PROXY
# ---------------------------------------------------------------------------


def test_is_lyria_server_ignores_http_proxy_env(monkeypatch):
    with _run_server(_LyriaLikeHandler) as port:
        # Point the proxy at a closed loopback port. If _is_lyria_server
        # honoured it (plain urllib.request.urlopen does, by default), the
        # identity check would fail even though the real server answers
        # directly at 127.0.0.1:<port>.
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1/")
        monkeypatch.setenv("http_proxy", "http://127.0.0.1:1/")
        assert sidecar._is_lyria_server(port) is True


# ---------------------------------------------------------------------------
# Re-audit item 3 -- stop() during the readiness wait must abort immediately
# ---------------------------------------------------------------------------


def test_stop_during_readiness_wait_aborts_immediately(monkeypatch, tmp_path):
    """Before the fix, a stop() that arrives while ensure_running() is
    polling for the port to open was silently ignored until the (here,
    shortened) readiness deadline, which then raised a misleading
    "npm-install or server startup hang" message for what was actually a
    deliberate stop."""
    project = tmp_path / "lyria-project-wait-stop"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(sidecar, "_ensure_deps", lambda cfg: None)
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )
    monkeypatch.setattr(sidecar, "PORT_READY_TIMEOUT_SEC", 5.0)
    monkeypatch.setattr(sidecar, "PORT_POLL_INTERVAL_SEC", 0.05)
    monkeypatch.setattr(sidecar, "_terminate_proc", lambda proc: None)

    class _FakeProc:
        pid = 424242

        def poll(self) -> None:
            return None  # never exits on its own

    monkeypatch.setattr(sidecar.subprocess, "Popen", lambda *a, **k: _FakeProc())

    result: dict = {}

    def _run() -> None:
        try:
            sidecar.ensure_running(wait_for_ready=True)
        except Exception as exc:  # noqa: BLE001 - captured for the assertion below
            result["error"] = exc

    thread = threading.Thread(target=_run, daemon=True)
    start = time.monotonic()
    thread.start()
    # Poll for _proc to actually be assigned (round-4 item 5) instead of a
    # blind sleep -- a fixed sleep is inherently racy: too short and stop()
    # fires before _proc exists (testing a different code path entirely),
    # too long and it pads every run.
    poll_deadline = time.monotonic() + 5.0
    while sidecar._proc is None and time.monotonic() < poll_deadline:
        time.sleep(0.01)
    assert sidecar._proc is not None, "ensure_running() never assigned _proc"
    sidecar.stop()
    thread.join(timeout=5.0)
    elapsed = time.monotonic() - start

    assert not thread.is_alive()
    assert elapsed < 2.0, (
        f"ensure_running() took {elapsed:.2f}s -- a stop() during the "
        "readiness wait wasn't honoured promptly (item 3 regression)"
    )
    assert isinstance(result.get("error"), RuntimeError)
    assert str(result["error"]) == "stopped"


# ---------------------------------------------------------------------------
# Re-audit item 5 -- ensure_running() must wait for an in-progress stop()
# ---------------------------------------------------------------------------


def test_ensure_running_waits_for_stop_to_finish_before_adopting(monkeypatch):
    """While stop() is mid-teardown (_stopping set), a concurrent
    ensure_running() must not immediately adopt whatever still answers on
    the port -- it could be the dying server that stop() is killing right
    now."""
    release_terminate = threading.Event()
    terminate_started = threading.Event()

    class _FakeProc:
        pid = 777

        def poll(self) -> None:
            return None

    def _slow_terminate(proc: object) -> None:
        terminate_started.set()
        release_terminate.wait(timeout=5.0)

    monkeypatch.setattr(sidecar, "_terminate_proc", _slow_terminate)
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": True
    )
    monkeypatch.setattr(sidecar, "_is_lyria_server", lambda port: True)

    sidecar._proc = _FakeProc()

    stop_thread = threading.Thread(target=sidecar.stop, daemon=True)
    stop_thread.start()
    assert terminate_started.wait(timeout=5.0)
    assert sidecar._stopping.is_set()

    result: dict = {}

    def _run() -> None:
        result["url"] = sidecar.ensure_running(wait_for_ready=False)

    ensure_thread = threading.Thread(target=_run, daemon=True)
    ensure_thread.start()

    # ensure_running() must still be blocked in _wait_while_stopping, not
    # already returned with an adopted (and about-to-die) URL. Poll for a
    # bounded window instead of a bare sleep-then-assert-elapsed: a fixed
    # `time.sleep(N)` followed by `elapsed >= N` is flaky by construction --
    # sleep() is a minimum, not exact, and on Windows can measure back as
    # microseconds under N (observed: 0.29699999999s < 0.3s), so the
    # assertion itself flakes independently of the behavior under test. The
    # state we actually care about -- "still blocked, _stopping still set"
    # -- is asserted directly below instead of inferred from wall-clock time.
    still_blocked_deadline = time.monotonic() + 2.0
    while (
        ensure_thread.is_alive()
        and sidecar._stopping.is_set()
        and time.monotonic() < still_blocked_deadline
    ):
        time.sleep(0.01)
    assert sidecar._stopping.is_set(), (
        "test setup broke: stop() finished tearing down before the poll "
        "window elapsed -- increase still_blocked_deadline or check "
        "release_terminate wasn't set early"
    )
    assert ensure_thread.is_alive(), (
        "ensure_running() returned while stop() was still mid-teardown -- it "
        "adopted a server that is being killed right now (item 5 regression)"
    )

    release_terminate.set()
    stop_thread.join(timeout=5.0)
    ensure_thread.join(timeout=5.0)

    assert not ensure_thread.is_alive()
    assert "url" in result


# ---------------------------------------------------------------------------
# Round-4 item 1 -- a `confirmed` result racing a stop() must be rejected
# ---------------------------------------------------------------------------


def test_probe_adoption_guarded_rejects_confirmation_racing_a_stop(monkeypatch):
    """Reproduces the exact race: stop() fires between the identity probe
    (inside _probe_adoption) and the guard's decision to trust its
    `confirmed` result. The first confirmation must be rejected because
    _stopping is set by the time the guard checks it; only once stop()
    finishes (_stopping clears) does the guard re-probe -- and by then the
    port has actually stopped listening (the dying server has exited)."""
    port_calls: list[int] = []
    identity_calls: list[int] = []

    def _fake_port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
        port_calls.append(1)
        # Only the first probe still finds the (about to die) server
        # listening; by the second probe (after _wait_while_stopping
        # releases) it has actually exited.
        return len(port_calls) == 1

    def _fake_is_lyria_server(port: int) -> bool:
        identity_calls.append(1)
        # Simulate stop() landing exactly after this probe answered True but
        # before the guard's _stopping re-check.
        sidecar._stopping.set()
        return True

    monkeypatch.setattr(sidecar, "_port_is_listening", _fake_port_is_listening)
    monkeypatch.setattr(sidecar, "_is_lyria_server", _fake_is_lyria_server)

    def _clear_stopping_shortly() -> None:
        time.sleep(0.1)
        sidecar._stopping.clear()

    threading.Thread(target=_clear_stopping_shortly, daemon=True).start()

    cfg = sidecar.resolve_config()
    confirmed, collision = sidecar._probe_adoption_guarded(cfg)

    assert identity_calls == [1], "the racing confirmation must not be re-trusted"
    assert len(port_calls) == 2, "the guard must re-probe after the race is caught"
    assert confirmed is False
    assert collision is False


def test_ensure_running_does_not_adopt_dying_server_racing_a_stop(
    monkeypatch, tmp_path
):
    """End-to-end version of the race above: ensure_running() itself must
    not return the URL of a server that answered the identity probe right as
    stop() started tearing it down -- it must fall through to spawning its
    own process instead."""
    project = tmp_path / "lyria-project-race-stop"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(sidecar, "_ensure_deps", lambda cfg: None)

    port_calls: list[int] = []
    identity_calls: list[int] = []

    def _fake_port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
        port_calls.append(1)
        return len(port_calls) == 1

    def _fake_is_lyria_server(port: int) -> bool:
        identity_calls.append(1)
        sidecar._stopping.set()
        return True

    monkeypatch.setattr(sidecar, "_port_is_listening", _fake_port_is_listening)
    monkeypatch.setattr(sidecar, "_is_lyria_server", _fake_is_lyria_server)

    def _clear_stopping_shortly() -> None:
        time.sleep(0.1)
        sidecar._stopping.clear()

    threading.Thread(target=_clear_stopping_shortly, daemon=True).start()

    class _FakeProc:
        pid = 55555

        def poll(self) -> None:
            return None

    monkeypatch.setattr(sidecar.subprocess, "Popen", lambda *a, **k: _FakeProc())

    url = sidecar.ensure_running(wait_for_ready=False)

    assert identity_calls == [1], "must not have trusted the racing confirmation"
    assert url == "http://127.0.0.1:0"
    assert sidecar._proc is not None, "must have gone on to spawn its own process"


# ---------------------------------------------------------------------------
# Round-4 item 3 -- an identity-check failure on OUR OWN live process is
# "not ready yet", not a port collision
# ---------------------------------------------------------------------------


def test_ensure_running_treats_own_child_warmup_as_not_ready(monkeypatch):
    """A slow fake child WE ALREADY OWN (as if spawned by an earlier
    ensure_running() call that returned before readiness): the port is bound
    (TCP accepts) before the identity endpoint is actually answering
    correctly yet, as can happen while Vite/Express finish startup. Because
    owns_process() is True, a failed identity check on this fresh call's
    adoption probe must NOT raise a "port already in use by another process"
    collision -- it must fall straight through to the readiness wait
    (proc_alive is already True, so no re-spawn is attempted either) and
    succeed once the child finishes starting up."""
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(sidecar, "PORT_READY_TIMEOUT_SEC", 5.0)
    monkeypatch.setattr(sidecar, "PORT_POLL_INTERVAL_SEC", 0.05)

    class _FakeProc:
        pid = 909090

        def poll(self) -> None:
            return None

    sidecar._proc = _FakeProc()  # as if spawned by an earlier call

    # The port is "listening" (TCP-wise) the whole time, but the identity
    # endpoint only starts answering correctly after a short simulated
    # warm-up.
    warmup_deadline = time.monotonic() + 0.3
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": True
    )
    monkeypatch.setattr(
        sidecar,
        "_is_lyria_server",
        lambda port: time.monotonic() >= warmup_deadline,
    )

    url = sidecar.ensure_running(wait_for_ready=True)

    assert url == "http://127.0.0.1:0"


def test_probe_does_not_report_collision_for_own_child_warming_up(
    monkeypatch, tmp_path
):
    """Same scenario via probe(): while we own a live child that hasn't
    finished starting up yet, probe() must not report the port-collision
    issue against our own process."""
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")

    class _FakeProc:
        pid = 909091

        def poll(self) -> None:
            return None

    sidecar._proc = _FakeProc()

    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": True
    )
    monkeypatch.setattr(sidecar, "_is_lyria_server", lambda port: False)

    out = sidecar.probe()

    assert out["listening"] is False
    assert not any("already in use" in issue for issue in out["issues"])


# ---------------------------------------------------------------------------
# Re-audit item 6 -- the network identity probe must run OUTSIDE _state_lock
# ---------------------------------------------------------------------------


def test_probe_adoption_runs_outside_state_lock(monkeypatch):
    probe_started = threading.Event()
    release_probe = threading.Event()

    def _slow_is_lyria_server(port: int) -> bool:
        probe_started.set()
        release_probe.wait(timeout=5.0)
        return True

    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": True
    )
    monkeypatch.setattr(sidecar, "_is_lyria_server", _slow_is_lyria_server)
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")

    result: dict = {}

    def _run() -> None:
        result["url"] = sidecar.ensure_running(wait_for_ready=False)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    try:
        assert probe_started.wait(timeout=5.0)
        start = time.monotonic()
        with sidecar._state_lock:
            pass  # must acquire immediately -- proves the probe holds no lock
        elapsed = time.monotonic() - start
        assert elapsed < 0.5, (
            f"_state_lock was held for {elapsed:.2f}s while the network "
            "identity probe was still running (item 6 regression)"
        )
    finally:
        release_probe.set()
        thread.join(timeout=5.0)


# ---------------------------------------------------------------------------
# Audit item 3 -- _ensure_deps must serialize against concurrent callers
# ---------------------------------------------------------------------------


def test_ensure_deps_serializes_concurrent_direct_calls(monkeypatch, tmp_path):
    """Simulates the Install button's `_install_worker` racing a second,
    independent `_ensure_deps` call (as ensure_running()'s spawn path would
    make) for the same project directory. Before the fix, neither caller
    took a lock around the node_modules check + npm install, so both could
    see node_modules missing and both run `npm install` concurrently."""
    project = tmp_path / "lyria-project-race"
    project.mkdir()
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))

    install_calls: list[list[str]] = []
    call_lock = threading.Lock()
    first_call_started = threading.Event()
    release_first_call = threading.Event()
    node_modules = project / "node_modules"
    lock_held_during_install = threading.Event()

    def _fake_subprocess_call(cmd: list[str], **kwargs: object) -> int:
        with call_lock:
            install_calls.append(cmd)
            is_first = len(install_calls) == 1
        if is_first:
            # Real contention proof (item 8): _spawn_lock must actually be
            # engaged right now, not just "no one happened to race in".
            if sidecar._spawn_lock.locked():
                lock_held_during_install.set()
            first_call_started.set()
            release_first_call.wait(timeout=5.0)
        node_modules.mkdir(exist_ok=True)
        return 0

    monkeypatch.setattr(sidecar.subprocess, "call", _fake_subprocess_call)

    cfg = sidecar.resolve_config()
    results: list[str] = []
    start_barrier = threading.Barrier(2, timeout=5.0)

    def _run() -> None:
        start_barrier.wait()
        sidecar._ensure_deps(cfg)
        results.append("done")

    t1 = threading.Thread(target=_run, daemon=True)
    t2 = threading.Thread(target=_run, daemon=True)
    # Both threads pass the barrier at (as close as possible to) the same
    # instant, so which one wins _spawn_lock is genuine contention rather
    # than one thread simply being started well before the other.
    t1.start()
    t2.start()
    assert first_call_started.wait(timeout=5.0)
    assert lock_held_during_install.is_set(), (
        "no real _spawn_lock contention was observed"
    )

    # The second thread must be blocked on _spawn_lock here -- node_modules
    # doesn't exist yet, so without the lock it would ALSO invoke
    # subprocess.call concurrently.
    time.sleep(0.3)
    with call_lock:
        assert len(install_calls) == 1, (
            f"expected exactly 1 npm install call while the first is still "
            f"running, got {len(install_calls)} (item 3 regression)"
        )

    release_first_call.set()
    t1.join(timeout=5.0)
    t2.join(timeout=5.0)

    assert results == ["done", "done"]
    with call_lock:
        # t2 must see node_modules now exists (created by t1) and return
        # without calling npm install again.
        assert len(install_calls) == 1


# ---------------------------------------------------------------------------
# Audit item 4 -- lyria/router.py routes must offload to a thread
# ---------------------------------------------------------------------------


def _fake_config() -> sidecar.LyriaConfig:
    return sidecar.LyriaConfig(
        project_path=sidecar.DEFAULT_PROJECT_PATH,
        port=5188,
        npm_path="npm",
        mock=True,
    )


def test_url_route_offloads_ensure_running_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "ensure_running", lambda **k: "http://127.0.0.1:5188")
    monkeypatch.setattr(sidecar, "resolve_config", _fake_config)
    monkeypatch.setattr(sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(sidecar, "owns_process", lambda: True)

    result = asyncio.run(lyria_router.url())

    assert sidecar.ensure_running in calls
    assert result["url"] == "http://127.0.0.1:5188"


def test_status_route_offloads_probe_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "probe", lambda: {"issues": [], "listening": True})

    result = asyncio.run(lyria_router.status())

    assert sidecar.probe in calls
    assert result["ok"] is True


def test_start_route_offloads_ensure_running_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(sidecar, "ensure_running", lambda **k: "http://127.0.0.1:5188")

    result = asyncio.run(lyria_router.start())

    assert sidecar.ensure_running in calls
    assert result == {"ok": True, "url": "http://127.0.0.1:5188"}


# ---------------------------------------------------------------------------
# Re-audit item 1 -- /stop, POST /key, and /url's owns_process() must also
# offload to a thread (stop() can taskkill+wait for ~10s worst case)
# ---------------------------------------------------------------------------


def test_stop_route_offloads_sidecar_stop_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(sidecar, "stop", lambda: True)

    result = asyncio.run(lyria_router.stop())

    assert sidecar.stop in calls
    assert result == {"ok": True, "stopped": True}


def test_key_post_route_offloads_sidecar_stop_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(sidecar, "set_gemini_key", lambda key: None)
    monkeypatch.setattr(sidecar, "stop", lambda: True)
    monkeypatch.setattr(sidecar, "gemini_key", lambda: ("sk-abc123", "file"))

    result = asyncio.run(lyria_router.set_key(key="sk-abc123456"))

    assert sidecar.stop in calls
    assert result["restarted"] is True


def test_url_route_offloads_owns_process_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "ensure_running", lambda **k: "http://127.0.0.1:5188")
    monkeypatch.setattr(sidecar, "resolve_config", _fake_config)
    monkeypatch.setattr(sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(sidecar, "owns_process", lambda: True)

    result = asyncio.run(lyria_router.url())

    assert sidecar.owns_process in calls
    assert result["mode"] == "mock"


# ---------------------------------------------------------------------------
# Audit item 5 -- an adopted-but-not-owned listener must not claim mock/live
# ---------------------------------------------------------------------------


def test_url_route_reports_external_when_not_owned(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    async def _identity_to_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _identity_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "ensure_running", lambda **k: "http://127.0.0.1:5188")
    monkeypatch.setattr(sidecar, "resolve_config", _fake_config)
    monkeypatch.setattr(sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(sidecar, "owns_process", lambda: False)

    result = asyncio.run(lyria_router.url())

    assert result["mode"] == "external"
    assert result["mock"] is None
    assert result["external"] is True


def test_url_route_reports_mock_mode_when_owned(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    async def _identity_to_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _identity_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "ensure_running", lambda **k: "http://127.0.0.1:5188")
    monkeypatch.setattr(sidecar, "resolve_config", _fake_config)
    monkeypatch.setattr(sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(sidecar, "owns_process", lambda: True)

    result = asyncio.run(lyria_router.url())

    assert result["mode"] == "mock"
    assert result["mock"] is True
    assert result["external"] is False


def test_owns_process_false_for_adopted_listener(monkeypatch):
    with _run_server(_LyriaLikeHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        # No _proc handle -- ensure_running() would adopt this listener
        # (INT-001), but the module never spawned it.
        assert sidecar.owns_process() is False


def test_lyria_provider_status_external_process_does_not_claim_mock(monkeypatch):
    from backend.modules.storage import router

    def _fake_probe():
        return {
            "project_path": "/fake/lyria",
            "issues": [],
            "missing": [],
            "install": {},
            "gemini_key": True,
            "gemini_key_source": "env",
            "listening": True,
            "process_alive": False,  # confirmed listening, but NOT our _proc
            "repo": sidecar.LYRIA_REPO,
            "repo_url": sidecar.LYRIA_REPO_URL,
            "git": True,
            "node": True,
            "npm": True,
            "installable": True,
        }

    monkeypatch.setattr(sidecar, "probe", _fake_probe)
    monkeypatch.setattr(sidecar, "is_mock", lambda: True)

    status = router._lyria_provider_status()
    assert status["state"] == "ready"
    assert "Mock mode" not in status["summary"]
    assert "Live mode" not in status["summary"]
    assert "unknown" in status["summary"].lower()
    assert status["lyria"]["external"] is True
    assert "external" in status["models"][0]["reason"].lower()


# ---------------------------------------------------------------------------
# Audit item 6 -- ready + live mode + no key must still warn in the summary
# ---------------------------------------------------------------------------


def test_lyria_provider_status_warns_missing_key_in_live_mode_when_ready(
    monkeypatch,
):
    from backend.modules.storage import router

    def _fake_probe():
        return {
            "project_path": "/fake/lyria",
            "issues": [],
            "missing": ["key"],
            "install": {},
            "gemini_key": False,
            "gemini_key_source": "none",
            "listening": True,
            "process_alive": True,
            "repo": sidecar.LYRIA_REPO,
            "repo_url": sidecar.LYRIA_REPO_URL,
            "git": True,
            "node": True,
            "npm": True,
            "installable": True,
        }

    monkeypatch.setattr(sidecar, "probe", _fake_probe)
    monkeypatch.setattr(sidecar, "is_mock", lambda: False)  # live mode

    status = router._lyria_provider_status()
    assert status["state"] == "ready"
    assert "Live mode" in status["summary"]
    assert "GEMINI_API_KEY is not set" in status["summary"]


# ---------------------------------------------------------------------------
# Audit item 7 -- concurrent ensure_running() installs once, spawns once
# ---------------------------------------------------------------------------


def test_concurrent_ensure_running_installs_once_and_spawns_once(monkeypatch, tmp_path):
    project = tmp_path / "lyria-project-concurrent"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )

    ensure_deps_calls: list[int] = []
    popen_calls: list[int] = []
    call_lock = threading.Lock()
    lock_held_during_install = threading.Event()

    def _fake_ensure_deps(cfg: sidecar.LyriaConfig) -> None:
        with call_lock:
            ensure_deps_calls.append(1)
        # Real contention proof (item 8): _run_lock must actually be engaged
        # right now -- not just "the other threads happened not to race in".
        if sidecar._run_lock.locked():
            lock_held_during_install.set()
        # Give other threads a chance to race in while this "install" runs.
        time.sleep(0.2)

    class _FakeProc:
        pid = 12345

        def poll(self) -> None:
            return None

    def _fake_popen(*args: object, **kwargs: object) -> _FakeProc:
        with call_lock:
            popen_calls.append(1)
        return _FakeProc()

    monkeypatch.setattr(sidecar, "_ensure_deps", _fake_ensure_deps)
    monkeypatch.setattr(sidecar.subprocess, "Popen", _fake_popen)

    n = 3
    start_barrier = threading.Barrier(n, timeout=5.0)
    results: list[object] = []
    results_lock = threading.Lock()

    def _run() -> None:
        # All callers reach ensure_running() at (as close as possible to)
        # the same instant, so "only one install, one spawn" reflects real
        # contention on _run_lock/_spawn_lock rather than lucky timing.
        start_barrier.wait()
        try:
            url = sidecar.ensure_running(wait_for_ready=False)
        except Exception as exc:  # noqa: BLE001 - captured for the assertion below
            url = exc
        with results_lock:
            results.append(url)

    threads = [threading.Thread(target=_run, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5.0)

    assert len(ensure_deps_calls) == 1, (
        f"expected exactly 1 _ensure_deps call, got {len(ensure_deps_calls)}"
    )
    assert len(popen_calls) == 1, (
        f"expected exactly 1 Popen call, got {len(popen_calls)}"
    )
    assert lock_held_during_install.is_set(), (
        "no real _run_lock contention was observed"
    )
    assert results == ["http://127.0.0.1:0"] * n
