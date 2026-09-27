"""FastAPI router for the Quest MIDI bridge module.

Endpoints (prefix /api/questmidi):
    GET  /status   listener + adb + connection state, and who holds the headset
    POST /start    start the listener and (re)run adb reverse
    POST /stop     stop the listener
    POST /reattach re-run adb reverse only (after re-plugging the headset)
    POST /takeover move the headset onto theDAW from the program serving it
    WS   /ws       browser relay: receives Quest MIDI, sends return MIDI

The POST routes re-route or stop the headset, so they refuse a page outside
theDAW and a LAN caller that is neither paired nor the desktop shell. The
headset itself reaches the API through ``adb reverse`` and arrives as loopback.

The WebSocket is the live path the frontend keeps open. It opens with one
{"type":"status", ...} frame (the same fields as GET /status) and sends
another whenever that status changes, the holder being re-read every few
seconds; inbound Quest MIDI arrives as {"type":"midi","data":[...]}, which the
browser publishes to midiBus. The browser sends {"data":[...]} to push return
MIDI back to the headset.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
)

from . import bridge

log = logging.getLogger(__name__)

router = APIRouter(tags=["questmidi"])

_GUARDED = [
    Depends(refuse_cross_site),
    Depends(require_loopback_launch_or_pairing_token),
]


@router.get("/status")
async def get_status() -> dict:
    await bridge.refresh_headset_holder()
    return bridge.status()


@router.post("/start", dependencies=_GUARDED)
async def start() -> dict:
    await bridge.ensure_started()
    await bridge.reattach_adb()
    return bridge.status()


@router.post("/stop", dependencies=_GUARDED)
async def stop() -> dict:
    await bridge.stop()
    return bridge.status()


@router.post("/reattach", dependencies=_GUARDED)
async def reattach() -> dict:
    """Re-run adb reverse without restarting the listener (re-plug recovery).
    Leaves the headset with another program that serves its port."""
    ok = await bridge.reattach_adb()
    return {"adb_reverse_ok": ok, **bridge.status()}


@router.post("/takeover", dependencies=_GUARDED)
async def takeover() -> dict:
    """The user's Take over: map the headset onto theDAW although another
    program serves its port."""
    return await bridge.take_over()


@router.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    # Make sure the TCP listener + adb tunnel are up the moment a browser attaches.
    await bridge.ensure_started()
    await bridge.refresh_headset_holder()

    async def send(msg: list[int]) -> None:
        await websocket.send_json({"type": "midi", "data": msg})

    async def send_status(snapshot: dict) -> None:
        await websocket.send_json({"type": "status", **snapshot})

    bridge.add_client(send)
    try:
        first = bridge.status()
        await send_status(first)
        bridge.add_status_client(send_status, first)
        while True:
            data = await websocket.receive_json()
            payload = data.get("data") if isinstance(data, dict) else None
            if payload:
                bridge.send_to_quest(payload)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # client went away mid-message
        log.debug("questmidi: ws error: %s", e)
    finally:
        bridge.remove_status_client(send_status)
        bridge.remove_client(send)
