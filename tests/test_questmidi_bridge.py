from __future__ import annotations

import asyncio

from backend.modules.questmidi import bridge


def test_bridge_delegates_host_and_device_port_policy(monkeypatch) -> None:
    monkeypatch.setattr(bridge.port_config, "host_port", lambda: 18766)
    monkeypatch.setattr(bridge.port_config, "device_port", lambda: 18765)

    assert bridge._port() == 18766
    assert bridge._device_port() == 18765


def test_adb_maps_device_port_to_distinct_host_port(monkeypatch) -> None:
    calls: list[tuple[int, int]] = []

    monkeypatch.setattr(
        bridge,
        "_run_adb_reverse",
        lambda device_port, host_port: calls.append((device_port, host_port)) or True,
    )
    monkeypatch.setattr(bridge, "_port", lambda: 8766)
    monkeypatch.setattr(bridge, "_device_port", lambda: 8765)
    monkeypatch.setattr(bridge, "_http_port", lambda: 8600)

    assert asyncio.run(bridge.reattach_adb()) is True
    assert calls == [(8765, 8766), (8600, 8600)]
    assert bridge.status()["device_port"] == 8765
