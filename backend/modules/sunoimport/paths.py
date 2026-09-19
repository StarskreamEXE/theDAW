"""Pure path validation for the Suno cache -> theDAW library import wizard.

This module owns exactly one concern: where the Suno import staging folder
lives, and whether caller-supplied cache file paths and a media root are
usable - all WITHOUT ever writing to a cache path or a media root, and
WITHOUT leaking a full filesystem path into a message a user or the frontend
could display. Every error message is built from ``safe_name`` so it only
ever names a file or folder, never a path.

Read-only by contract:

* Cache paths are opened ``"rb"`` and closed immediately - a readability
  probe, never a write.
* Media roots are only ``is_dir()``-checked - never created.
* The stage root itself IS created (``ensure_stage_root``), but it always
  sits beside the library root - never inside it, and never inside a cache
  file's folder or the media root (``refuse_overlap``).

This module does not import FastAPI and does not import
``backend.modules.library.router`` - it is the pure layer the router-facing
wizard endpoints (a later ticket) will build on.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Sequence
from pathlib import Path

from backend.modules.library.store import default_library_root

#: Name of the sibling folder the stage root lives in, beside the library root.
STAGE_DIR_NAME = "suno-stage"

#: Throwaway file used to probe that a folder is actually writable.
_WRITE_PROBE_NAME = ".suno-import-write-probe"


def safe_name(path: str | Path) -> str:
    """The file/folder name only - never a full path - for user-facing text."""
    return Path(path).name


class ImportPathError(ValueError):
    """A path-validation failure whose message names only file/folder names.

    ``.message`` mirrors ``str(self)`` so a caller (an eventual FastAPI route)
    can surface the text without re-deriving it from the exception's args.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _is_same_or_within(candidate: Path, ancestor: Path) -> bool:
    """True when ``candidate`` equals ``ancestor`` or sits under it.

    Compares with ``os.path.normcase`` (matching ``library/router.py``'s
    ``_outside_library``) so the check is case-insensitive on Windows. A
    drive root's ``str()`` (e.g. ``"E:\\"``) already ends in ``os.sep``, so
    the prefix is only extended when it doesn't already end in one -
    unconditionally appending would double the separator and never match.
    """
    candidate_norm = os.path.normcase(str(candidate))
    ancestor_norm = os.path.normcase(str(ancestor))
    prefix = ancestor_norm if ancestor_norm.endswith(os.sep) else ancestor_norm + os.sep
    return candidate_norm == ancestor_norm or candidate_norm.startswith(prefix)


def stage_root_for(library_root: Path) -> Path:
    """The Suno import staging folder for ``library_root``.

    Always a sibling of the library root - beside it, never inside it, and
    never inside a cache or media folder.
    """
    return Path(library_root).resolve().parent / STAGE_DIR_NAME


def default_stage_root() -> Path:
    """The staging folder beside the default library root."""
    return stage_root_for(default_library_root())


def validate_cache_paths(raw: Sequence[str]) -> list[Path]:
    """Validate caller-supplied Suno cache file paths, read-only.

    Every entry is expanded, resolved, confirmed to be an existing file, and
    probed with a read-only open that is closed immediately - nothing is
    ever written. Duplicates are dropped, preserving first-seen order.
    """
    if not raw:
        raise ImportPathError("cache_paths must name at least one file")

    resolved: list[Path] = []
    seen: set[Path] = set()
    for entry in raw:
        candidate = Path(entry).expanduser().resolve()
        if not candidate.is_file():
            raise ImportPathError(f"no such cache file: {safe_name(candidate)}")
        try:
            with candidate.open("rb"):
                pass
        except OSError as exc:
            raise ImportPathError(
                f"cache file is not readable: {safe_name(candidate)}"
            ) from exc

        if candidate in seen:
            continue
        seen.add(candidate)
        resolved.append(candidate)

    return resolved


def validate_media_root(raw: str | None) -> Path | None:
    """Validate a caller-supplied media root. Never creates it."""
    if not raw:
        return None
    candidate = Path(raw).expanduser().resolve()
    if not candidate.is_dir():
        raise ImportPathError(f"no such media folder: {safe_name(candidate)}")
    return candidate


def ensure_stage_root(root: Path) -> Path:
    """Create ``root`` (and parents) and confirm it is writable.

    Refuses - before touching the filesystem - when the resolved root is the
    library root itself or sits under it; the stage folder must always be a
    sibling of the library, never inside it.
    """
    resolved = Path(root).resolve()
    library_root = default_library_root().resolve()
    if _is_same_or_within(resolved, library_root):
        raise ImportPathError("stage folder must not sit inside the library")

    probe = resolved / _WRITE_PROBE_NAME
    try:
        resolved.mkdir(parents=True, exist_ok=True)
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as exc:
        raise ImportPathError(
            f"stage folder is not writable: {safe_name(resolved)}"
        ) from exc

    return resolved


def refuse_overlap(
    stage_root: Path, cache_paths: Sequence[Path], media_root: Path | None
) -> None:
    """Refuse when ``stage_root`` overlaps a cache file's folder or the media root."""
    resolved_stage = Path(stage_root).resolve()

    for cache_path in cache_paths:
        parent = Path(cache_path).resolve().parent
        if _is_same_or_within(resolved_stage, parent):
            raise ImportPathError(
                f"stage folder must not sit inside {safe_name(parent)}"
            )

    if media_root is not None:
        resolved_media = Path(media_root).resolve()
        if _is_same_or_within(resolved_stage, resolved_media):
            raise ImportPathError(
                f"stage folder must not sit inside {safe_name(resolved_media)}"
            )


def free_bytes_for(path: Path) -> int:
    """Free bytes on the filesystem containing ``path``, or 0 if undeterminable."""
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return 0
