"""The web launcher never needs another program's port.

The launchers stop only theDAW's own stale listeners (``backend.ports
--free``). Whatever is still on 5173 after that belongs to someone else -- on
the machine this was written for, another project's Vite -- and the web UI
must come up beside it on a free port rather than die on Vite's strictPort or
send the browser to the other program.
"""

from __future__ import annotations

import pytest

from backend import _devstack, ports


def _busy(*held: int):
    """An ``is_port_free`` that reports exactly ``held`` as taken."""
    taken = set(held)
    return lambda port, host="0.0.0.0": port not in taken


@pytest.fixture(autouse=True)
def _restore_frontend_port():
    yield
    _devstack._use_frontend_port(ports.FRONTEND_PORT)


@pytest.fixture(autouse=True)
def _empty_listening_table(monkeypatch):
    """No real listener answers for these tests: what is busy is whatever the
    test's own ``is_port_free`` says. A test that cares about the table
    re-stubs ``holders`` in its own body."""
    monkeypatch.setattr(_devstack.ports, "holders", lambda wanted: [])


def test_the_preferred_port_when_nobody_holds_it(monkeypatch):
    monkeypatch.setattr(_devstack.ports, "is_port_free", _busy())
    assert _devstack._choose_frontend_port() == ports.FRONTEND_PORT


def test_the_next_free_port_when_another_program_holds_the_preferred_one(monkeypatch):
    monkeypatch.setattr(_devstack.ports, "is_port_free", _busy(ports.FRONTEND_PORT))
    assert _devstack._choose_frontend_port() == ports.FRONTEND_PORT + 1


def test_the_search_skips_the_ports_theDAW_reserves_for_itself(monkeypatch):
    # Everything from 5173 up to just below the first reserved sidecar port is
    # taken, and the sidecar ports themselves look free: they must still be
    # skipped, because theDAW's own VJ/Sway servers will want them.
    reserved = sorted(p for p in ports.ALL_PORTS if p > ports.FRONTEND_PORT)
    first = reserved[0]
    monkeypatch.setattr(
        _devstack.ports,
        "is_port_free",
        _busy(*range(ports.FRONTEND_PORT, first)),
    )
    chosen = _devstack._choose_frontend_port()
    assert chosen not in ports.ALL_PORTS
    assert chosen > first


def test_a_full_range_falls_back_to_the_preferred_port(monkeypatch):
    """Nothing free in the range: Vite's own strictPort error is the honest
    report, so the preferred port is returned rather than a made-up one."""
    monkeypatch.setattr(
        _devstack.ports, "is_port_free", lambda port, host="0.0.0.0": False
    )
    assert _devstack._choose_frontend_port() == ports.FRONTEND_PORT


def test_the_preferred_port_keeps_the_dev_script():
    assert _devstack._frontend_command(ports.FRONTEND_PORT) == "npm run dev"


def test_another_port_runs_vite_with_that_port_only():
    cmd = _devstack._frontend_command(5174)
    assert "--port=5174" in cmd
    # Not appended to the dev script, which already carries --port=5173.
    assert "npm run dev" not in cmd
    assert "5173" not in cmd


def test_the_browser_and_readiness_probe_follow_the_chosen_port():
    _devstack._use_frontend_port(5176)
    assert _devstack._frontend_port == 5176
    assert _devstack.FRONTEND_URL == "http://localhost:5176"


def test_the_backend_child_is_told_which_port_the_web_ui_took(monkeypatch):
    """The backend advertises the web UI's address to other devices
    (GET /api/network/lan), so it has to learn the port the launcher actually
    chose -- otherwise a phone is sent to whatever program holds 5173."""
    import io

    class _Proc:
        pid = 4242

        def __init__(self) -> None:
            self.stdout = io.StringIO("")

        def poll(self):
            return None

        def wait(self) -> int:
            return 0

    spawns: list[dict] = []

    def record(cmd, cwd=None, env=None):
        spawns.append(dict(env or {}))
        return _Proc()

    monkeypatch.setattr(_devstack, "_spawn", record)
    monkeypatch.setattr(_devstack, "_emit", lambda tag, line: None)
    _devstack._use_frontend_port(5179)
    _devstack._shutdown.clear()
    try:
        _devstack._run_backend([])
    finally:
        _devstack._shutdown.clear()

    assert spawns, "the backend was never spawned"
    assert spawns[0].get("theDAW_FRONTEND_PORT") == "5179"


def test_the_port_note_names_the_holder_without_telling_anyone_to_close_it(
    monkeypatch, capsys
):
    """The line says the other program is LEFT RUNNING, so it must not also
    tell the user to close it -- describe_occupant's sentence does."""
    holder = ports.Holder(
        port=ports.FRONTEND_PORT,
        pid=9191,
        name="node.exe",
        cmdline="node vite",
        ours=False,
    )
    monkeypatch.setattr(_devstack.ports, "holders", lambda wanted: [holder])
    line = _devstack._frontend_port_note(5174)
    assert "node.exe" in line
    assert "9191" in line
    assert "Close it" not in line
    assert "5174" in line


def test_an_unreadable_process_table_still_produces_a_note(monkeypatch):
    monkeypatch.setattr(_devstack.ports, "holders", lambda wanted: [])
    line = _devstack._frontend_port_note(5174)
    assert "another program" in line
    assert "Close it" not in line


def test_the_candidate_search_enumerates_the_listening_table_once(monkeypatch):
    """holders() walks every TCP connection on the machine. The search walks it
    ONCE for the whole candidate range; candidates the table already rejects
    never reach a probe at all."""
    calls: list[list[int]] = []

    def counting_holders(wanted):
        wanted = list(wanted)
        calls.append(wanted)
        return [
            ports.Holder(port=p, pid=1, name="other", cmdline="other", ours=False)
            for p in wanted
            if p < ports.FRONTEND_PORT + 3
        ]

    monkeypatch.setattr(_devstack.ports, "holders", counting_holders)
    monkeypatch.setattr(
        _devstack.ports, "is_port_free", lambda port, host="0.0.0.0": True
    )
    chosen = _devstack._choose_frontend_port()
    assert chosen == ports.FRONTEND_PORT + 3
    assert len(calls) == 1, f"holders() was called {len(calls)} times"
