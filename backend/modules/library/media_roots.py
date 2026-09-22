"""An index over the user's own media folders, keyed by entry id.

The library serves an entry from the entry's own directory. Entries exist
whose bytes were never written there -- catalogued from a provider that kept
the audio behind a URL, imported as metadata, restored from a backup that
carried the database and not the files -- and for those the only copy on this
machine is a file in the user's own media folders, under a name the entry
never recorded.

Two id shapes survive in those filenames, so both are indexed:

``<anything> <36-char uuid><anything>.<ext>``
    The entry id in full, anywhere in the name.

``<title> [<first 8 hex of the entry id>].<ext>``
    The short tag a library export writes when the full id would make the
    name unwieldy. Eight hex digits collide about as often as you would
    expect across a few hundred thousand files, which is why a collision has
    an explicit rule rather than a coin toss: a file that carries the FULL id
    wins, and between two that do not, the newest wins.

The walk is one pass with :func:`os.scandir` over every configured root, and
it is slow -- a few hundred thousand files on a spinning disk is minutes. So
nothing waits for it. :func:`start_scan` hands it to a daemon thread, and
:func:`lookup` answers ``None`` until the index exists: a request that
arrives first gets exactly the behaviour it got before this module existed.

Configuration, in order of precedence:

``theDAW_MEDIA_ROOTS``
    ``os.pathsep``-separated absolute folders. Wins outright when set.

``settings.library.media_roots``
    The list Settings -> Storage edits.

Nothing here is provider-specific: a folder of media files named after entry
ids is a folder of media files named after entry ids.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

log = logging.getLogger(__name__)

#: ``os.pathsep``-separated absolute folders. Set = the only roots consulted.
ENV_VAR = "theDAW_MEDIA_ROOTS"

#: Where the same list lives in ``data/settings.json`` when the env var is not
#: set (Settings -> Storage -> Media roots).
SETTINGS_SECTION = "library"
SETTINGS_KEY = "media_roots"

#: How often a lookup is allowed to re-stat the roots to notice that one of
#: them changed. Cheap (one stat per root), but not per request.
SIGNATURE_CHECK_SEC = 30.0

_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
#: ``[c27de18c]`` immediately before the extension, and nowhere else.
_ID8_RE = re.compile(r"\[([0-9a-fA-F]{8})\]\s*$")
_HEX8_RE = re.compile(r"^[0-9a-fA-F]{8}$")


def media_extensions() -> frozenset[str]:
    """Every container the library recognises, audio and visual.

    Derived from the store's own tables at call time rather than copied, so
    it cannot fall behind them -- and imported lazily because the store
    imports this module.
    """
    from .store import AUDIO_EXTS, _MEDIA_EXTS

    return frozenset(AUDIO_EXTS) | frozenset(_MEDIA_EXTS)


@dataclass(slots=True)
class MediaIndex:
    """One finished walk. Paths are plain ``str``: 170,000 ``Path`` objects
    cost several times what the strings do, and every consumer wants a
    ``Path`` for exactly one of them."""

    roots: tuple[str, ...]
    signature: tuple[tuple[str, Optional[float]], ...]
    by_full_id: dict[str, str] = field(default_factory=dict)
    by_id8: dict[str, str] = field(default_factory=dict)
    files: int = 0
    ambiguous: int = 0
    built_at: float = field(default_factory=time.time)
    duration_sec: float = 0.0


_lock = threading.Lock()
_index: Optional[MediaIndex] = None
_scanning = False
_scan_thread: Optional[threading.Thread] = None
_last_signature_check = 0.0


# ---- configuration ---------------------------------------------------------


def _clean(values: Iterator[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        folder = value.strip().strip('"')
        if not folder or folder in seen:
            continue
        seen.add(folder)
        out.append(folder)
    return out


def configured_roots() -> list[str]:
    """The folders to index, env first. Never raises: a settings store that
    cannot be read is the same as no roots configured."""
    raw = os.getenv(ENV_VAR)
    if raw:
        return _clean(iter(raw.split(os.pathsep)))
    try:
        from backend.modules.settings.router import get_store as get_settings_store

        value = get_settings_store().get_value(SETTINGS_SECTION, SETTINGS_KEY, [])
    except Exception:  # noqa: BLE001 -- settings are optional for serving audio
        log.debug("media_roots: settings unavailable", exc_info=True)
        return []
    if not isinstance(value, list):
        return []
    return _clean(str(v) for v in value if isinstance(v, str))


def _signature(roots: list[str]) -> tuple[tuple[str, Optional[float]], ...]:
    """The root list plus each root's own mtime -- enough to notice a folder
    added, removed, or given a new top-level child, and one stat per root."""
    out: list[tuple[str, Optional[float]]] = []
    for root in roots:
        try:
            out.append((root, os.stat(root).st_mtime))
        except OSError:
            out.append((root, None))
    return tuple(out)


# ---- the walk --------------------------------------------------------------


def _scan_files(root: str) -> Iterator[os.DirEntry]:
    """Every file under ``root``, depth-first, without following directory
    links. A junction or symlinked directory is skipped rather than walked:
    an index that never finishes because two folders point at each other is
    worse than one that misses a linked subtree the user can add as its own
    root. Hardlinked and symlinked FILES index normally."""
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                            continue
                        if not entry.is_file():
                            continue
                    except OSError:
                        continue
                    yield entry
        except OSError as exc:
            log.warning("media_roots: cannot read %s (%s)", current, exc)


def _keys_for(stem: str) -> tuple[Optional[str], list[str]]:
    """``(full id, [id8 keys])`` for a filename stem, all lowercase."""
    full_match = _UUID_RE.search(stem)
    full = full_match.group(0).lower() if full_match else None
    id8s: list[str] = []
    if full:
        id8s.append(full[:8])
    tag = _ID8_RE.search(stem)
    if tag:
        tagged = tag.group(1).lower()
        if tagged not in id8s:
            id8s.append(tagged)
    return full, id8s


def _mtime(path: str) -> float:
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0.0


def _build_index(roots: list[str]) -> MediaIndex:
    """Walk every root once. Never raises for a root that disappears mid-walk;
    the rest of the index is still worth having."""
    started = time.monotonic()
    index = MediaIndex(roots=tuple(roots), signature=_signature(roots))
    exts = media_extensions()
    # Rank per id8 key: 1 when the winning file carries the full id, else 0.
    # An mtime comparison costs a stat, so it is paid only on a collision
    # between two files of equal rank -- a few hundred stats, not 170,000.
    id8_rank: dict[str, int] = {}
    first_ambiguity: Optional[tuple[str, str, str]] = None

    for root in roots:
        if not os.path.isdir(root):
            log.warning("media_roots: %s is not a folder; skipped", root)
            continue
        for entry in _scan_files(root):
            name = entry.name
            dot = name.rfind(".")
            if dot <= 0 or name[dot:].lower() not in exts:
                continue
            full, id8s = _keys_for(name[:dot])
            if full is None and not id8s:
                continue
            index.files += 1
            path = entry.path
            if full is not None:
                previous = index.by_full_id.get(full)
                if previous is None:
                    index.by_full_id[full] = path
                elif previous != path and _mtime(path) > _mtime(previous):
                    index.by_full_id[full] = path
            has_full = 1 if full is not None else 0
            for key in id8s:
                previous = index.by_id8.get(key)
                if previous is None:
                    index.by_id8[key] = path
                    id8_rank[key] = has_full
                    continue
                if previous == path:
                    continue
                index.ambiguous += 1
                if first_ambiguity is None:
                    first_ambiguity = (key, previous, path)
                previous_rank = id8_rank.get(key, 0)
                if has_full > previous_rank or (
                    has_full == previous_rank and _mtime(path) > _mtime(previous)
                ):
                    index.by_id8[key] = path
                    id8_rank[key] = has_full

    index.duration_sec = time.monotonic() - started
    if first_ambiguity is not None:
        # Once per scan, with one worked example. Per-collision logging on a
        # 170,000-file tree is a log nobody can read.
        key, kept_or_dropped, other = first_ambiguity
        log.info(
            "media_roots: %d short-id collision(s); the full id wins, else the "
            "newest file. First: [%s] matched %s and %s",
            index.ambiguous,
            key,
            kept_or_dropped,
            other,
        )
    log.info(
        "media_roots: indexed %d file(s) from %d root(s) in %.1fs "
        "(%d full ids, %d short ids)",
        index.files,
        len(roots),
        index.duration_sec,
        len(index.by_full_id),
        len(index.by_id8),
    )
    return index


# ---- scanning --------------------------------------------------------------


def _run_scan(roots: list[str]) -> None:
    global _index, _scanning
    try:
        built = _build_index(roots)
    except Exception:  # noqa: BLE001 -- a daemon thread must not raise
        log.warning("media_roots: the scan failed", exc_info=True)
        built = None
    with _lock:
        if built is not None:
            _index = built
        _scanning = False


def start_scan(*, force: bool = False) -> bool:
    """Start a walk on a daemon thread and return immediately.

    Returns True when this call started one. A scan already running is left
    alone (a second walk over the same tree would only slow the first), and
    without ``force`` an index that is already built is kept.
    """
    global _scanning, _scan_thread
    roots = configured_roots()
    with _lock:
        if _scanning:
            return False
        if _index is not None and not force:
            return False
        if not roots:
            _index_empty(roots)
            return False
        _scanning = True
        thread = threading.Thread(
            target=_run_scan, args=(roots,), name="library-media-roots", daemon=True
        )
        _scan_thread = thread
    thread.start()
    return True


def _index_empty(roots: list[str]) -> None:
    """Record 'no roots configured' as a finished, empty index. Caller holds
    the lock. Without this a lookup would re-read the settings on every
    request for a user who has configured nothing."""
    global _index
    _index = MediaIndex(roots=tuple(roots), signature=_signature(roots))


def scan_now() -> MediaIndex:
    """Walk synchronously and install the result. For tests and for a caller
    that has already decided to wait -- no request path calls this."""
    global _index, _scanning
    roots = configured_roots()
    with _lock:
        _scanning = True
    try:
        built = _build_index(roots)
    finally:
        with _lock:
            _scanning = False
    with _lock:
        _index = built
    return built


def reset() -> None:
    """Forget the index and any scan state. Tests only."""
    global _index, _scanning, _scan_thread, _last_signature_check
    with _lock:
        _index = None
        _scanning = False
        _scan_thread = None
        _last_signature_check = 0.0


def _maybe_refresh(current: MediaIndex) -> None:
    """Notice that a root changed and start a rescan in the background. The
    caller keeps reading the index it already has -- a stale hit is a real
    file, and a miss costs exactly what a miss cost before."""
    global _last_signature_check
    now = time.monotonic()
    if now - _last_signature_check < SIGNATURE_CHECK_SEC:
        return
    _last_signature_check = now
    roots = configured_roots()
    if _signature(roots) != current.signature:
        log.info("media_roots: a root changed; rescanning in the background")
        start_scan(force=True)


# ---- lookup ----------------------------------------------------------------


def lookup(
    entry_id: str, *, extensions: Optional[frozenset[str] | set[str]] = None
) -> Optional[Path]:
    """The indexed file for ``entry_id``, full id first then its first eight
    hex digits, or None.

    Never blocks and never walks: before the first scan finishes this is
    ``None``, which is the behaviour the library had before the index
    existed. ``extensions`` (lowercase, with the dot) filters the hit, so an
    audio lookup cannot answer with the entry's video.
    """
    if not entry_id:
        return None
    with _lock:
        index = _index
    if index is None:
        return None
    _maybe_refresh(index)
    key = entry_id.strip().lower()
    found = index.by_full_id.get(key)
    if found is None and len(key) >= 8 and _HEX8_RE.match(key[:8]):
        found = index.by_id8.get(key[:8])
    if found is None:
        return None
    if extensions is not None:
        dot = found.rfind(".")
        if dot <= 0 or found[dot:].lower() not in extensions:
            return None
    path = Path(found)
    # The index can outlive the file: a user moves a folder between scans.
    return path if path.is_file() else None


def status() -> dict:
    """What the Settings panel shows: the roots, how big the index is, how
    old it is, and whether a walk is running right now."""
    with _lock:
        index = _index
        scanning = _scanning
    return {
        "roots": configured_roots(),
        "ready": index is not None,
        "scanning": scanning,
        "files": index.files if index is not None else 0,
        "full_ids": len(index.by_full_id) if index is not None else 0,
        "short_ids": len(index.by_id8) if index is not None else 0,
        "ambiguous": index.ambiguous if index is not None else 0,
        "age_seconds": (
            round(max(0.0, time.time() - index.built_at), 3)
            if index is not None
            else None
        ),
        "scan_seconds": round(index.duration_sec, 3) if index is not None else None,
    }
