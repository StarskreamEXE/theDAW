from __future__ import annotations

from importlib import import_module

import pytest


def _port_config():
    return import_module("backend.modules.questmidi.port_config")


def test_default_ports_keep_host_and_quest_device_isolated(monkeypatch) -> None:
    monkeypatch.delenv("theDAW_QUESTMIDI_PORT", raising=False)
    monkeypatch.delenv("theDAW_QUESTMIDI_DEVICE_PORT", raising=False)

    port_config = _port_config()

    assert port_config.host_port() == 8766
    assert port_config.device_port() == 8765


def test_host_port_override_is_independent(monkeypatch) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", "18766")
    monkeypatch.delenv("theDAW_QUESTMIDI_DEVICE_PORT", raising=False)

    port_config = _port_config()

    assert port_config.host_port() == 18766
    assert port_config.device_port() == 8765


def test_device_port_override_is_independent(monkeypatch) -> None:
    monkeypatch.delenv("theDAW_QUESTMIDI_PORT", raising=False)
    monkeypatch.setenv("theDAW_QUESTMIDI_DEVICE_PORT", "18765")

    port_config = _port_config()

    assert port_config.host_port() == 8766
    assert port_config.device_port() == 18765


@pytest.mark.parametrize("invalid_value", ["", "not-a-port", "0", "-1", "65536"])
def test_invalid_host_port_falls_back_to_default(
    monkeypatch, invalid_value: str
) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", invalid_value)

    assert _port_config().host_port() == 8766


@pytest.mark.parametrize("invalid_value", ["", "not-a-port", "0", "-1", "65536"])
def test_invalid_device_port_falls_back_to_default(
    monkeypatch, invalid_value: str
) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_DEVICE_PORT", invalid_value)

    assert _port_config().device_port() == 8765
