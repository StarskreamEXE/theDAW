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
