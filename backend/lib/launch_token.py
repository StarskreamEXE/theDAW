"""The per-launch token the desktop shell shares with the backend it starts.

The Electron main process makes a random token at startup and hands it to the
backend it spawns in ``THEDAW_LAUNCH_TOKEN``. Only main-process requests send it
back, in the ``X-TheDAW-Launch-Token`` header; the renderer and preload never
see it. A request carrying it therefore came from the desktop shell that
started this backend, and a route can trust what that request says.
"""

from __future__ import annotations

import hmac
import os

from fastapi import Request

__all__ = ["ENV_VAR", "HEADER", "header_matches"]

ENV_VAR = "THEDAW_LAUNCH_TOKEN"
HEADER = "X-TheDAW-Launch-Token"


def header_matches(request: Request) -> bool:
    """True only when this backend was given a launch token and the request's
    ``X-TheDAW-Launch-Token`` header equals it.

    The environment is read on every call, so a test that sets or clears the
    variable takes effect at once."""
    expected = os.environ.get(ENV_VAR, "")
    if not expected:
        return False
    given = request.headers.get(HEADER, "")
    if not given:
        return False
    return hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))
