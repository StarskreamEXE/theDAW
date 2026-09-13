"""Refuse requests that a web page outside theDAW started.

CORS is open on this server and it binds 0.0.0.0, so any page the user has open
can send requests to it. Routes that open a native dialog on this machine, list
the paths theDAW remembers, or serve and write files depend on
``refuse_cross_site`` so only theDAW's own UI and native callers reach them.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

# The origin rules the Gemini proxy already enforces: loopback, private-range
# and app:// origins are this machine's UI; anything else is a foreign page.
from backend.modules.genaiproxy.access import is_local_origin

__all__ = ["refuse_cross_site"]


def refuse_cross_site(request: Request) -> None:
    """403 for a call started by a web page outside theDAW.

    A browser labels its requests with ``Sec-Fetch-Site``, ``Origin`` or
    ``Referer``, and page script cannot change those. A native caller, such as
    the desktop shell recording a finished download, sends none of them and
    passes."""
    headers = request.headers
    if not (
        headers.get("sec-fetch-site") or headers.get("origin") or headers.get("referer")
    ):
        return
    if not is_local_origin(request):
        raise HTTPException(403, "This request came from a page outside theDAW.")
