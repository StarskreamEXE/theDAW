"""The Quest MIDI bridge leaves the headset with a program that already serves it.

A headset has one ``adb reverse`` mapping per port, so ``adb reverse tcp:8765
tcp:<ours>`` takes the headset from whatever program had it: the standalone
Node bridge that relays into loopMIDI, another theDAW, anything listening on
8765 here. The bridge used to run that on every start and re-attach. Now it
runs only while nobody else serves the headset's port, or after the user's
Take over, and status() names the program in the way.

Each test replays a real ordering against real sockets: the other program is a
separate process listening on a real port, so the bridge finds it the way it
finds one in the field (backend.ports.holders). adb is a fake headset with the
one reverse table every adb client on the PC shares. A test "dials" the
headset's port through that table and checks which process the MIDI reached.
No real adb runs, so a plugged-in headset is never touched.
"""

from __future__ import annotations

import asyncio
import queue
import socket
import subprocess
import sys
import threading
from typing import Awaitable, Callable, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.questmidi import bridge
from backend.modules.questmidi import router as questmidi_router

_PORT_ENV = (
    "theDAW_QUESTMIDI_PORT",
    "theDAW_QUESTMIDI_DEVICE_PORT",
    "theDAW_QUESTMIDI_HOST_PORT",
)
NOTE_ON = [0x90, 0x40, 0x7F]
FRAME = bytes([len(NOTE_ON), *NOTE_ON])


def _free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
    finally:
        probe.close()


class FakeHeadset:
    """A USB headset as adb sees it: one reverse table shared by every adb
    client on the PC. Stands in for ``bridge._adb``."""

    def __init__(self) -> None:
        self.reverse: dict[int, int] = {}
        self.calls: list[tuple[str, ...]] = []
        self.plugged = True

    def adb(self, *args: str) -> Optional[str]:
        self.calls.append(args)
        if not self.plugged:
            return None  # "error: no devices/emulators found"
        if args == ("reverse", "--list"):
            return "".join(
                f"UsbFfs tcp:{device} tcp:{host}\n"
                for device, host in self.reverse.items()
            )
        if len(args) == 3 and args[0] == "reverse":
            self.reverse[int(args[1][4:])] = int(args[2][4:])
            return ""
        return None

    def midi_reversals(self, device_port: int) -> list[tuple[str, ...]]:
        """Every ``adb reverse`` this bridge ran for the headset's MIDI port."""
        want = f"tcp:{device_port}"
        return [c for c in self.calls if len(c) == 3 and c[1] == want]

    def unplug_and_replug(self) -> None:
        """adb drops every mapping when the cable is pulled."""
        self.reverse.clear()

    async def send_note(self, device_port: int) -> None:
        """The headset app sends one note-on to its own ``device_port``."""
        _reader, writer = await asyncio.open_connection(
            "127.0.0.1", self.reverse[device_port]
        )
        writer.write(FRAME)
        await writer.drain()
        await asyncio.sleep(0.2)
        writer.close()
        await writer.wait_closed()


_OTHER_BRIDGE = r"""
import os, socket, sys, threading
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.bind(("0.0.0.0", int(sys.argv[1])))
server.listen()
print(server.getsockname()[1], os.getpid(), flush=True)

def serve():
    while True:
        conn, _peer = server.accept()
        data = conn.recv(64)
        print("got " + data.hex(), flush=True)
        conn.close()

threading.Thread(target=serve, daemon=True).start()
sys.stdin.read()  # exits when the test closes stdin
"""


class OtherBridge:
    """Another program that serves the headset: a separate process listening
    on all interfaces, the way the standalone Node bridge does."""

    def __init__(self, port: int = 0, *extra_args: str) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-c", _OTHER_BRIDGE, str(port), *extra_args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        self._lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        port_text, pid_text = self._lines.get(timeout=20).split()
        self.port = int(port_text)
        # The process that owns the socket reports its own pid: on Windows a
        # venv's python.exe can be a launcher whose child does the work.
        self.pid = int(pid_text)

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._lines.put(line.strip())

    def received(self, timeout: float = 5.0) -> Optional[str]:
        try:
            return self._lines.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)


@pytest.fixture
def headset(monkeypatch: pytest.MonkeyPatch) -> FakeHeadset:
    """A fresh bridge state, a fake headset in place of adb, and ports that
    cannot collide with a theDAW running on this machine."""
    fake = FakeHeadset()
    monkeypatch.setattr(bridge, "_s", bridge._State())
    monkeypatch.setattr(bridge, "_adb", fake.adb)
    monkeypatch.setattr(bridge, "_adb_path", lambda: "adb")
    for name in _PORT_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("theDAW_QUESTMIDI_HOST_PORT", str(_free_port()))
    monkeypatch.setenv("theDAW_PORT", str(_free_port()))
    return fake


@pytest.fixture
def other_bridge():
    started: list[OtherBridge] = []

    def start(port: int = 0, *extra_args: str) -> OtherBridge:
        other = OtherBridge(port, *extra_args)
        started.append(other)
        return other

    yield start
    for other in started:
        other.close()


def _headset_dials(monkeypatch: pytest.MonkeyPatch, port: int) -> None:
    """Point the headset at ``port`` by theDAW_QUESTMIDI_DEVICE_PORT.
    test_a_setup_made_for_main_still_reaches_thedaw covers theDAW_QUESTMIDI_PORT."""
    monkeypatch.setenv("theDAW_QUESTMIDI_DEVICE_PORT", str(port))


async def _eventually(check: Callable[[], bool], timeout: float = 5.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if check():
            return True
        await asyncio.sleep(0.05)
    return check()


def _listen_to_bridge() -> tuple[
    list[list[int]], Callable[[list[int]], Awaitable[None]]
]:
    """A browser client of the bridge: what it receives, and its send hook."""
    got: list[list[int]] = []

    async def send(msg: list[int]) -> None:
        got.append(msg)

    return got, send


def test_the_headset_stays_with_a_bridge_that_already_serves_it(
    headset, other_bridge, monkeypatch
):
    """Sequence: the standalone bridge is on 8765 and has mapped the headset to
    itself, 1:1; then theDAW starts. theDAW must not reverse the headset."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port  # the other bridge's own adb reverse

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            status = bridge.status()
            assert status["started"] is True
            assert headset.midi_reversals(device_port) == [], (
                "theDAW reversed the headset away from the program serving it"
            )
            assert headset.reverse[device_port] == device_port
            assert status["adb_reverse_ok"] is False
            assert status["took_over"] is False
            holder = status["headset_holder"]
            assert holder is not None
            assert holder["pid"] == other.pid
            assert holder["port"] == device_port
            assert holder["mapped"] is True
            assert holder["thedaw"] is False
            assert holder["name"]

            # The headset's MIDI still reaches the program that serves it.
            await headset.send_note(device_port)
            assert other.received() == "got " + FRAME.hex()
            assert bridge.status()["quest_connected"] is False
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_a_program_on_the_headset_port_keeps_it_before_the_headset_is_mapped(
    headset, other_bridge, monkeypatch
):
    """Sequence: the headset is plugged in with no mapping yet, and a program
    listens on the headset's port number here, where a 1:1 bridge maps it."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            assert headset.midi_reversals(device_port) == []
            holder = bridge.status()["headset_holder"]
            assert holder is not None
            assert holder["pid"] == other.pid
            assert holder["mapped"] is False
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_take_over_moves_the_headset_and_survives_a_replug(
    headset, other_bridge, monkeypatch
):
    """Sequence: the other bridge serves the headset; theDAW starts and leaves
    it; the user presses Take over; the cable is pulled and plugged back in;
    the re-attach moves the headset to theDAW again without asking."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port
    got, send = _listen_to_bridge()

    async def scenario() -> None:
        await bridge.ensure_started()
        bridge.add_client(send)
        try:
            assert bridge.status()["headset_holder"] is not None
            host_port = bridge.status()["host_port"]

            status = await bridge.take_over()
            assert headset.reverse[device_port] == host_port
            assert status["headset_holder"] is None
            assert status["took_over"] is True
            assert status["adb_reverse_ok"] is True

            await headset.send_note(device_port)
            assert await _eventually(lambda: got == [NOTE_ON]), got
            assert other.received(timeout=0.5) is None

            headset.unplug_and_replug()
            await bridge.refresh_headset_holder()
            assert bridge.status()["headset_holder"] is None, (
                "the user's settled choice was reported as a new holder"
            )
            assert await bridge.reattach_adb() is True
            assert headset.reverse[device_port] == host_port
        finally:
            bridge.remove_client(send)
            await bridge.stop()

    asyncio.run(scenario())


def test_a_program_that_takes_the_headset_later_keeps_it(
    headset, other_bridge, monkeypatch
):
    """Sequence: theDAW starts with nobody else around and maps the headset;
    later the standalone bridge starts and maps the headset to itself; then a
    re-attach runs (re-plug recovery). theDAW must not take the headset back."""
    device_port = _free_port()
    _headset_dials(monkeypatch, device_port)

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            host_port = bridge.status()["host_port"]
            assert headset.reverse[device_port] == host_port
            assert bridge.status()["adb_reverse_ok"] is True

            other = other_bridge()
            headset.reverse[device_port] = other.port  # its own adb reverse

            await bridge.refresh_headset_holder()
            holder = bridge.status()["headset_holder"]
            assert holder is not None and holder["pid"] == other.pid
            assert holder["port"] == other.port and holder["mapped"] is True
            assert bridge.status()["adb_reverse_ok"] is False

            reversals_before = len(headset.midi_reversals(device_port))
            assert await bridge.reattach_adb() is False
            assert len(headset.midi_reversals(device_port)) == reversals_before
            assert headset.reverse[device_port] == other.port

            await headset.send_note(device_port)
            assert other.received() == "got " + FRAME.hex()

            await bridge.take_over()
            assert headset.reverse[device_port] == host_port
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_a_second_program_is_asked_about_anew(headset, other_bridge, monkeypatch):
    """Sequence: the user takes the headset from one program; a different
    program then maps it to itself; a re-attach leaves it with that one."""
    first = other_bridge()
    device_port = first.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            await bridge.take_over()
            second = other_bridge()
            headset.reverse[device_port] = second.port
            assert await bridge.reattach_adb() is False
            assert headset.reverse[device_port] == second.port
            assert bridge.status()["headset_holder"]["pid"] == second.pid
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_another_thedaw_keeps_the_headset_until_take_over(
    headset, other_bridge, monkeypatch
):
    """Sequence: another theDAW backend already listens on the host port and
    has mapped the headset to itself; this backend starts, then the user
    presses Take over in this backend's Settings."""
    device_port = _free_port()
    _headset_dials(monkeypatch, device_port)
    # "backend.run" on its command line is what marks a process as theDAW.
    other = other_bridge(0, "backend.run")
    monkeypatch.setenv("theDAW_QUESTMIDI_HOST_PORT", str(other.port))
    headset.reverse[device_port] = other.port

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            status = bridge.status()
            assert status["started"] is True and status["port_in_use"] is True
            assert headset.midi_reversals(device_port) == []
            holder = status["headset_holder"]
            assert holder is not None and holder["thedaw"] is True
            assert holder["pid"] == other.pid

            status = await bridge.take_over()
            assert status["port_in_use"] is False
            assert status["host_port"] not in (None, other.port)
            assert headset.reverse[device_port] == status["host_port"]
            assert status["headset_holder"] is None
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_a_setup_made_for_main_still_reaches_thedaw(headset, monkeypatch):
    """Sequence: a setup written for main sets theDAW_QUESTMIDI_PORT to the port
    its headset app dials; this build starts. The headset must reach theDAW on
    that port, with the listener here on its own port."""
    device_port = _free_port()
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", str(device_port))
    got, send = _listen_to_bridge()

    async def scenario() -> None:
        await bridge.ensure_started()
        bridge.add_client(send)
        try:
            status = bridge.status()
            assert status["port"] == device_port
            assert status["device_port"] == device_port
            assert headset.reverse[device_port] == status["host_port"]
            await headset.send_note(device_port)
            assert await _eventually(lambda: got == [NOTE_ON]), got
        finally:
            bridge.remove_client(send)
            await bridge.stop()

    asyncio.run(scenario())


def _first_frame(ws, timeout: float = 10.0) -> dict:
    """The WebSocket's first frame; a failure, never a hang, when none comes."""
    frames: list[dict] = []
    reader = threading.Thread(target=lambda: frames.append(ws.receive_json()))
    reader.daemon = True
    reader.start()
    reader.join(timeout)
    assert frames, "the WebSocket sent no status frame"
    return frames[0]


@pytest.fixture
def client(headset):
    app = FastAPI()
    app.include_router(questmidi_router.router, prefix="/api/questmidi")
    with TestClient(app, client=("127.0.0.1", 50000)) as test_client:
        yield test_client
        test_client.post("/api/questmidi/stop")


def test_take_over_over_http_needs_theDAW_own_ui(
    headset, other_bridge, client, monkeypatch
):
    """Sequence through the routes: the WebSocket opens and reports the holder,
    a page outside theDAW tries Take over and is refused, then theDAW's own UI
    takes over."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port

    with client.websocket_connect("/api/questmidi/ws") as ws:
        frame = _first_frame(ws)
    assert frame["type"] == "status"
    assert frame["headset_holder"]["pid"] == other.pid
    assert headset.midi_reversals(device_port) == []

    refused = client.post(
        "/api/questmidi/takeover", headers={"Origin": "https://evil.example"}
    )
    assert refused.status_code == 403
    assert headset.reverse[device_port] == device_port

    status = client.get("/api/questmidi/status").json()
    assert status["headset_holder"]["pid"] == other.pid

    taken = client.post(
        "/api/questmidi/takeover", headers={"Origin": "http://localhost:5173"}
    )
    assert taken.status_code == 200
    body = taken.json()
    assert body["headset_holder"] is None
    assert body["took_over"] is True
    assert headset.reverse[device_port] == body["host_port"]


def test_a_lan_caller_cannot_move_the_headset(headset, other_bridge, monkeypatch):
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port
    app = FastAPI()
    app.include_router(questmidi_router.router, prefix="/api/questmidi")
    with TestClient(app, client=("10.20.30.40", 50000)) as lan:
        for route in ("takeover", "reattach", "start", "stop"):
            assert lan.post(f"/api/questmidi/{route}").status_code == 403, route
    assert headset.midi_reversals(device_port) == []
    assert headset.reverse[device_port] == device_port
