"""The Quest MIDI bridge never shares its port number with another program.

Windows lets ``127.0.0.1:P`` be bound while another program holds ``0.0.0.0:P``
and then routes every loopback connection to the more specific bind. The bridge
once took 127.0.0.1:8765 that way, under a server already listening on 8765 on
all interfaces: that server's localhost clients reached the bridge's raw TCP
listener instead and saw their own server as dead.
"""

from __future__ import annotations

import asyncio
import socket

from backend.modules.questmidi import bridge


def test_bridge_moves_aside_when_another_program_serves_its_port(monkeypatch):
    foreign = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    foreign.bind(("0.0.0.0", 0))
    foreign.listen()
    foreign.settimeout(5)
    port = foreign.getsockname()[1]
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", str(port))
    monkeypatch.setattr(bridge, "_adb_path", lambda: None)  # no headset in a test run

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            status = bridge.status()
            assert status["started"] is True
            assert status["port"] == port, "the headset still dials the configured port"
            assert status["host_port"] not in (None, port), (
                "listening beside the other program"
            )

            # The bridge answers on its own port...
            _reader, writer = await asyncio.open_connection(
                "127.0.0.1", status["host_port"]
            )
            writer.close()
            await writer.wait_closed()

            # ...and a localhost client of the OTHER program still reaches that program.
            loop = asyncio.get_running_loop()
            accepted = loop.run_in_executor(None, foreign.accept)
            _reader, writer = await asyncio.open_connection("127.0.0.1", port)
            conn, _peer = await asyncio.wait_for(accepted, timeout=5)
            conn.close()
            writer.close()
            await writer.wait_closed()
            assert bridge.status()["quest_connected"] is False
        finally:
            await bridge.stop()

    try:
        asyncio.run(scenario())
    finally:
        foreign.close()


def test_bridge_keeps_its_own_port_when_it_is_free(monkeypatch):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", str(port))
    monkeypatch.setattr(bridge, "_adb_path", lambda: None)

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            assert bridge.status()["host_port"] == port
        finally:
            await bridge.stop()

    asyncio.run(scenario())
