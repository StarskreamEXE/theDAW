from __future__ import annotations

import os

DEFAULT_HOST_PORT = 8766
DEFAULT_DEVICE_PORT = 8765


def _env_port(name: str, default: int) -> int:
    try:
        port = int(os.getenv(name, ""))
    except ValueError:
        return default
    return port if 1 <= port <= 65535 else default


def host_port() -> int:
    return _env_port("theDAW_QUESTMIDI_PORT", DEFAULT_HOST_PORT)


def device_port() -> int:
    return _env_port("theDAW_QUESTMIDI_DEVICE_PORT", DEFAULT_DEVICE_PORT)
