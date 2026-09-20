"""Plugin path policy for the live-VST entry points.

The live-VST routes accept a plugin path from the browser — untrusted input.
Today any ``.vst3`` path is passed straight to the native host; this module is
the single choke point a route calls before that happens (wiring it into
router.py / live_host.py is a separate ticket). It only validates shape and
containment: no filesystem writes, no plugin loading.

A path is accepted only when it is a local, non-empty ``.vst3`` file or bundle
directory that resolves inside one of ``allowed_roots()`` — the same
directories the scanner itself would offer in the UI. Network and device
paths are rejected from the raw text alone, before anything touches the
filesystem, the same way ``backend.lib.known_paths`` already refuses them.
"""

from __future__ import annotations

import os
from pathlib import Path

from backend.lib.known_paths import is_remote_or_device_path
from backend.modules.vst.scanner import _default_vst3_dirs


class PluginPathError(Exception):
    """A browser-supplied plugin path failed policy.

    ``status`` is the HTTP status a route should answer with; ``message`` is
    safe to send to the client verbatim (it never repeats the input path or
    names an allowed root).
    """

    status: int
    message: str

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def allowed_roots() -> list[Path]:
    """The VST3 directories a plugin path is allowed to resolve inside.

    Delegates to the scanner's own directory resolver so this policy can
    never drift from the directories the app actually scans and offers in
    the UI.
    """
    return [root.resolve(strict=False) for root in _default_vst3_dirs()]


def root_contains(root: Path, resolved: Path) -> bool:
    """Whether ``resolved`` sits inside ``root``, case-insensitively on
    Windows (an install under ``C:\\Program Files`` must match regardless of
    how either side happens to be cased).

    Public: this is the one containment predicate for a resolved path against
    a single allowed root, used both by ``check_plugin_path`` below and by
    ``router._validated_scan_directory`` (which checks a scan directory
    against every root in ``allowed_roots()`` rather than a plugin file
    against a single ``.vst3`` root) — a second, router-local copy of the
    same check would drift from this one.
    """
    return Path(os.path.normcase(str(resolved))).is_relative_to(
        Path(os.path.normcase(str(root)))
    )


def check_plugin_path(raw: str) -> Path:
    """Validate a browser-supplied plugin path and return its resolved form.

    Raises ``PluginPathError``:
      * 400 - the input is empty, is a network/device path (decided from the
        text alone, before any filesystem access), cannot be resolved, or
        does not end in ``.vst3`` (case-insensitive);
      * 403 - the resolved path is outside every directory in
        ``allowed_roots()``.
    """
    if not raw or not raw.strip():
        raise PluginPathError(400, "Plugin path is required.")

    if is_remote_or_device_path(raw):
        raise PluginPathError(400, "Network or device paths are not allowed.")

    try:
        resolved = Path(raw).resolve(strict=False)
    except (OSError, ValueError) as e:
        raise PluginPathError(400, "Plugin path could not be resolved.") from e

    if resolved.suffix.lower() != ".vst3":
        raise PluginPathError(400, "Plugin path must be a .vst3 file or bundle.")

    roots = allowed_roots()
    if not any(root_contains(root, resolved) for root in roots):
        count = len(roots)
        noun = "directory" if count == 1 else "directories"
        raise PluginPathError(
            403,
            f"Plugin path is not inside any of the {count} allowed VST3 {noun}.",
        )

    return resolved
