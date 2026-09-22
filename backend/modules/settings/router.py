"""FastAPI router for app-wide feature settings.

Endpoints (prefix from module.json → ``/api/settings``):

    GET   /            full settings payload
    PATCH /            partial update; returns the merged payload

The PATCH body is a partial nested object: only the sections / keys you
want to change need to be present. Unknown sections / keys are dropped,
not rejected, so the frontend never gets a 400 for sending a slightly
newer or older shape than the backend knows about.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Request

from backend.lib.cross_site import require_loopback_or_launch_token

from .store import SettingsStore, default_settings_path

log = logging.getLogger(__name__)


_store: Optional[SettingsStore] = None


def get_store() -> SettingsStore:
    global _store
    if _store is None:
        _store = SettingsStore(default_settings_path())
    return _store


router = APIRouter()


#: Keys whose value is a list of FOLDERS ON THIS MACHINE. Setting one points a
#: background walker (the media-root index, the model scan) at a directory of
#: the caller's choosing, so they are held to the strict tier even though the
#: rest of this route is a feature-toggle panel the phone companion uses.
_FOLDER_LIST_KEYS = (("library", "media_roots"), ("models", "extra_folders"))


def _caller_may_see_folders(request: Request) -> bool:
    """The PATCH guard as a question rather than an answer.

    Expressed by catching the guard's own refusal so there is exactly ONE
    statement of the rule: a second predicate spelling out "loopback or launch
    token" here would be a second place to keep in step with
    ``backend/lib/cross_site.py``.
    """
    try:
        require_loopback_or_launch_token(request)
    except HTTPException:
        return False
    return True


def _redacted_for(request: Request, settings: dict[str, Any]) -> dict[str, Any]:
    """``settings`` with the folder lists emptied for a caller that may not set
    them, each marked ``<key>_redacted``.

    Applied to EVERY answer this router gives, not only the GET: a PATCH
    replies with the whole document, so a caller refused the write could
    otherwise read the lists back by toggling something harmless. The payload
    from the store is already a deep copy, so this edits nobody's state.
    """
    if _caller_may_see_folders(request):
        return settings
    for section, key in _FOLDER_LIST_KEYS:
        values = settings.get(section)
        if isinstance(values, dict) and isinstance(values.get(key), list):
            values[key] = []
            values[f"{key}_redacted"] = True
    return settings


def _folder_lists_touched(payload: dict[str, Any]) -> bool:
    return any(
        isinstance(payload.get(section), dict) and key in payload[section]
        for section, key in _FOLDER_LIST_KEYS
    )


@router.get("")
@router.get("/")
def get_settings(request: Request) -> dict[str, Any]:
    """The full settings payload, minus the folder lists for a caller that is
    not allowed to SET them. Naming every media root and model folder on this
    machine is reconnaissance for anyone on the LAN, and a panel that cannot
    write them has no use for their contents."""
    return _redacted_for(request, get_store().get_all())


@router.patch("")
@router.patch("/")
def patch_settings(
    request: Request, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return _redacted_for(request, get_store().get_all())
    if _folder_lists_touched(payload):
        # 403 unless this machine's own UI or the desktop shell is asking.
        require_loopback_or_launch_token(request)
        media_roots = payload.get("library")
        if isinstance(media_roots, dict) and "media_roots" in media_roots:
            from backend.modules.library.media_roots import validate_roots

            value = media_roots["media_roots"]
            if not isinstance(value, list):
                raise HTTPException(400, "media_roots must be a list of folders")
            try:
                # Normalised here so what is stored is what will be walked:
                # one canonical spelling each, no root nested in another.
                media_roots["media_roots"] = validate_roots(value)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
    return _redacted_for(request, get_store().patch(payload))
