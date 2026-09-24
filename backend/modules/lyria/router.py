"""HTTP surface for the Lyria 3 Pro sidecar.

Mirrors backend/modules/vj/router.py: the frontend asks GET /url, which blocks
server-side until the child is listening, and the view retries while that
happens. Warm-up is request-driven (there is no FastAPI startup hook) so the
Node process only starts when someone actually opens the Lyria panel.

This module deliberately does NOT proxy Lyria's own API. The embedded iframe
loads directly from the sidecar's origin, so its relative /api/* fetches
resolve against its own server. That is what lets Lyria's frontend stay
byte-for-byte as-is: no CORS, no base URL, no client rewrite.

Setup lives here too, so Settings can fix a missing Lyria without naming a
git command:

    POST /install          clone StarskreamEXE/lyria-3-pro into the expected
                           folder (needs git) and run its npm install, in the
                           background; output goes to the sidecar log
    GET  /install/status   poll the install
    GET  /key              is a GEMINI_API_KEY known, and from where
    POST /key {key}        append a Gemini key theDAW hands the sidecar
    DELETE /key            forget the stored Gemini keys
    GET  /keys             per-provider COUNTS and sources (never values)
    POST /keys {provider,key}     append a key for that provider
    DELETE /keys {provider,index} forget the stored key at that position
    POST /keys/provider {provider}  gemini | openrouter | "" for auto

The /key trio is the original single-Gemini surface, kept working: POST now
appends rather than replaces, because the embedded app tries the keys in order
and skips a rejected one, so a second key is a fallback and not a correction.

Every route that changes keys stops a running sidecar, so the next open hands
the child the new environment -- the child reads its keys from the environment
at spawn, not per request.

No response body here ever carries key material.

INT-002 adds two routes at the bottom of this file that DO reach into the
sidecar -- over its loopback origin only, and for its own generation listing:

    POST /import-new       register new sidecar generations as library entries
    GET  /imports          seen-map counts (which generations are already in)
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading

from fastapi import APIRouter, Body, HTTPException

from . import importer, sidecar

log = logging.getLogger(__name__)

router = APIRouter(tags=["lyria"])

_auto_spawn_lock = threading.Lock()
_auto_spawn_started = False


def _maybe_auto_spawn() -> None:
    """Kick a one-time background readiness thread.

    Fires on the first read endpoint rather than at import: spawning a Node
    process for a panel the user may never open wastes memory. The work runs
    on a daemon thread so a first-run npm install never blocks the request.
    """
    global _auto_spawn_started
    if os.environ.get("theDAW_LYRIA_NO_AUTO_SPAWN"):
        return
    # Nothing to warm until the checkout exists; the install route is the
    # path that creates it, and a warm-up would only log the same complaint.
    if not sidecar.project_present():
        return
    with _auto_spawn_lock:
        if _auto_spawn_started:
            return
        _auto_spawn_started = True

    def _warm() -> None:
        try:
            sidecar.ensure_running()
        except Exception as e:  # noqa: BLE001 - warm-up is best-effort
            log.warning("lyria.router: warm-up failed: %s", e)

    threading.Thread(target=_warm, daemon=True, name="lyria-warm").start()


@router.get("/url")
async def url() -> dict:
    """Return the URL the Lyria app is served on, spawning it if needed.

    Blocks until the child is listening (up to the sidecar's readiness
    deadline), so the frontend can treat a 200 as "safe to mount the iframe".
    503 on failure, with the sidecar's diagnostic as the detail.
    """
    _maybe_auto_spawn()
    try:
        # ensure_running() can block for up to the sidecar's readiness
        # deadline (installs included) -- run it off the event loop so it
        # doesn't stall every other request this worker is handling.
        live = await asyncio.to_thread(sidecar.ensure_running)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    cfg = sidecar.resolve_config()
    lan_ip = sidecar.detect_lan_ip()
    # Only claim a cost mode (mock/live) for a process WE spawned -- theDAW
    # controls that process's environment (LYRIA_MOCK). An adopted listener
    # someone launched manually may be running with a different, unknown
    # cost mode, so claiming "mock" for it would be a straight-up lie (item 5).
    # owns_process() takes _state_lock, which can be held by a concurrent
    # ensure_running()/stop() for a while -- off the loop like the rest.
    owns = await asyncio.to_thread(sidecar.owns_process)
    mode = ("mock" if cfg.mock else "live") if owns else "external"
    return {
        "url": live,
        "mode": mode,
        "mock": cfg.mock if owns else None,
        "external": not owns,
        "port": cfg.port,
        "mobile_url": f"http://{lan_ip}:{cfg.port}" if lan_ip else None,
        "lan_ip": lan_ip,
    }


@router.get("/status")
async def status() -> dict:
    """Non-spawning diagnostics, plus a warm kick so opening Settings starts
    the child in the background."""
    _maybe_auto_spawn()
    # probe() now includes an HTTP identity call (_is_lyria_server) on top of
    # the TCP check, so it can block for up to that request's timeout --
    # keep it off the event loop like the other sidecar calls in this file.
    info = await asyncio.to_thread(sidecar.probe)
    info["ok"] = not info["issues"] and info["listening"]
    return info


@router.post("/start")
async def start() -> dict:
    """Foreground spawn. Used by the view's Retry button."""
    try:
        live = await asyncio.to_thread(sidecar.ensure_running)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"ok": True, "url": live}


@router.post("/stop")
async def stop() -> dict:
    # stop() can taskkill+wait(5)+kill+wait(5) -- up to ~10s -- off the loop.
    stopped = await asyncio.to_thread(sidecar.stop)
    return {"ok": True, "stopped": stopped}


# ── setup: clone + npm install, from a button ────────────────────────────────


@router.post("/install")
async def install() -> dict:
    """Clone the Lyria project into the folder the sidecar expects and run its
    npm install, in the background. Returns the install state right away;
    poll GET /install/status. 409 when a prerequisite is missing (git for the
    clone, Node.js for npm), naming it."""
    try:
        return sidecar.start_install()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.get("/install/status")
async def install_status() -> dict:
    return sidecar.install_status()


# ── GEMINI_API_KEY the sidecar is handed ─────────────────────────────────────


@router.get("/key")
async def key_status() -> dict:
    key, source = sidecar.gemini_key()
    return {
        "configured": bool(key),
        "source": source,
        "prefix": (key[:6] + "…") if key else None,
        "mock": sidecar.is_mock(),
    }


@router.post("/key")
async def set_key(key: str = Body(..., embed=True)) -> dict:
    """Append a Gemini key. A running sidecar is stopped so the next open hands
    it the new environment (the child reads GEMINI_API_KEY at spawn)."""
    value = (key or "").strip()
    if len(value) < 8:
        raise HTTPException(
            status_code=400, detail="That does not look like an API key."
        )
    sidecar.set_gemini_key(value)
    # stop() can taskkill+wait(5)+kill+wait(5) -- up to ~10s -- off the loop.
    restarted = await asyncio.to_thread(sidecar.stop)
    key_value, source = sidecar.gemini_key()
    return {
        "ok": True,
        "configured": bool(key_value),
        "source": source,
        "prefix": (key_value[:6] + "…") if key_value else None,
        "restarted": restarted,
    }


@router.delete("/key")
async def clear_key() -> dict:
    removed = sidecar.clear_gemini_key()
    key, source = sidecar.gemini_key()
    return {"ok": True, "removed": removed, "configured": bool(key), "source": source}


# ── per-provider ordered key lists ───────────────────────────────────────────
#
# The embedded app takes an ordered list per provider and skips a rejected key
# (its server/keys.ts), so theDAW stores lists, not single keys. These routes
# report COUNTS and SOURCES only: a list UI has no use for the values, and a
# response body is the easiest place to leak one.


def _bad_provider(e: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(e))


async def _stopped_summary() -> dict:
    """Stop a running sidecar (so the next open gets the new environment) and
    return the fresh key summary. Same contract as POST /key."""
    # stop() can taskkill+wait(5)+kill+wait(5) -- up to ~10s -- off the loop.
    restarted = await asyncio.to_thread(sidecar.stop)
    summary = await asyncio.to_thread(sidecar.key_summary)
    return {"ok": True, "restarted": restarted, **summary}


@router.get("/keys")
async def keys_status() -> dict:
    """Per-provider counts and sources. Never key values."""
    return await asyncio.to_thread(sidecar.key_summary)


@router.post("/keys")
async def add_provider_key(
    provider: str = Body(..., embed=True), key: str = Body(..., embed=True)
) -> dict:
    """Append a key to one provider's ordered list."""
    value = (key or "").strip()
    if len(value) < 8:
        raise HTTPException(
            status_code=400, detail="That does not look like an API key."
        )
    try:
        await asyncio.to_thread(sidecar.add_key, provider, value)
    except ValueError as e:
        raise _bad_provider(e) from e
    return await _stopped_summary()


@router.delete("/keys")
async def remove_provider_key(
    provider: str = Body(..., embed=True), index: int = Body(..., embed=True)
) -> dict:
    """Forget the stored key at ``index``. Positions index the STORED list
    only -- keys that come from the environment or the assistant's pool are
    not theDAW's to remove, and are removed where they were set."""
    try:
        removed = await asyncio.to_thread(sidecar.remove_key, provider, index)
    except ValueError as e:
        raise _bad_provider(e) from e
    if not removed:
        raise HTTPException(
            status_code=404, detail=f"No stored key at position {index}."
        )
    return await _stopped_summary()


@router.post("/keys/provider")
async def set_key_provider(provider: str | None = Body(None, embed=True)) -> dict:
    """Set the provider the child should default to. An empty value clears the
    preference, which hands the choice back to the keys (and then to the
    child's own default when both providers are available)."""
    try:
        await asyncio.to_thread(sidecar.set_provider_preference, provider)
    except ValueError as e:
        raise _bad_provider(e) from e
    return await _stopped_summary()


# ── INT-002: the sidecar's generations, as first-class library entries ───────
#
# The embedded app keeps its own library; these two routes are what makes a
# track generated in the panel a theDAW entry (catalog, lineage, EDIT, stems,
# export). The work itself lives in importer.py -- see its module docstring for
# the loopback-only download rule and the seen map.


@router.post("/import-new")
async def import_new(include_mock: bool = Body(False, embed=True)) -> dict:
    """Import every sidecar generation the library does not have yet.

    Body is optional; ``{"include_mock": true}`` opts in to the locally
    synthesized mock audio the sidecar produces in its default cost-safe mode.
    Never raises for a stopped sidecar -- that answers with a ``reason``.
    """
    return await importer.sync_generations(include_mock=bool(include_mock))


@router.get("/imports")
async def imports() -> dict:
    """Counts and ids from the seen map. Never audio, never a prompt."""
    # Reads a file off disk -- off the loop, consistent with the rest here.
    return await asyncio.to_thread(importer.imports_summary)
