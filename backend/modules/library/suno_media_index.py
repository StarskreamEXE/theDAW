"""Read-only media index for a Suno export folder (backend.modules.library).

The real export layout is not one convention but three, mixed within the same
tree, depending on when/how a batch was exported:

* ``<title> [<id8>].<ext>`` — ``id8`` is the first 8 hex characters of the
  song's UUID.
* ``<title> [<full-uuid>].<ext>``, with sidecars ``<title> [<full-uuid>]
  (cover).jpg`` and ``<title> [<full-uuid>] (lyrics).txt``.
* bare ``<full-uuid>.<ext>``.

:func:`build_index` walks a media root once with ``os.scandir`` — no file is
ever opened, and no *file's* metadata costs more than the ``DirEntry`` already
gives for free — and returns a :class:`MediaIndex` that answers "where is
this song's local file" by id (and, for the 8-hex-char form, by title when
the prefix alone is not enough). Nothing under ``media_root`` is written,
renamed, or deleted. A directory (never a file) does cost one extra
``os.stat`` beyond its ``DirEntry``, because its mtime is what the cache below
keys on and a ``DirEntry``-sourced mtime for a directory can lag a fresh
``os.stat`` by microseconds right after that directory changes; directories
are a tiny fraction of the file count this module is sized for.

Caching: an optional SQLite file the CALLER places outside ``media_root``
records, per directory, that directory's own mtime and the files/subdirectories
found directly inside it. A directory's own mtime does not change unless a
file or subdirectory is added, removed, or renamed directly inside it — so on
a later call, a directory whose mtime still matches the cached one is trusted
outright and ``os.scandir`` is never called on it again; only its immediate
subdirectories are each ``stat``-ed once to see whether *they* need rescanning.
This is exact for adds/removes/renames. It does not notice a file rewritten in
place under its existing name inside an otherwise-untouched directory — the
same tradeoff most mtime-based incremental scanners make, accepted here
because an exported archive is written once, not edited in place. A cache file
that fails to open as SQLite (corrupt, truncated, or simply not a database) is
replaced with a fresh one; the walk itself never fails because of it.
"""

from __future__ import annotations

import os
import re
import sqlite3
from collections import defaultdict
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

AUDIO_EXTENSIONS = frozenset({"mp3", "wav", "m4a", "flac", "ogg", "opus"})
IMAGE_EXTENSIONS = frozenset({"jpg", "jpeg", "png", "webp"})
LYRICS_EXTENSIONS = frozenset({"txt"})

#: Preference order for same-id audio alternates: lower sorts first. Lossless
#: containers (or the closest this project treats as such) beat lossy ones.
#: Only used for ``kind == "audio"``; cover/lyrics alternates have no such
#: ordering and fall back to the same rank, broken by relative path.
_AUDIO_FORMAT_RANK: dict[str, int] = {
    "flac": 0,
    "wav": 0,
    "ogg": 1,
    "opus": 1,
    "m4a": 1,
    "mp3": 2,
}

_UUID_PATTERN = (
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_ID8_PATTERN = r"[0-9a-fA-F]{8}"

# Checked most-specific first: a full-uuid-with-sidecar name would otherwise
# also satisfy the plain full-uuid pattern (the sidecar marker would end up
# folded into the title).
_FULL_UUID_SIDECAR_RE = re.compile(
    rf"^(?P<title>.+) \[(?P<id>{_UUID_PATTERN})\] \((?P<sidecar>cover|lyrics)\)"
    rf"\.(?P<ext>[^.]+)$"
)
_FULL_UUID_RE = re.compile(
    rf"^(?P<title>.+) \[(?P<id>{_UUID_PATTERN})\]\.(?P<ext>[^.]+)$"
)
_ID8_RE = re.compile(rf"^(?P<title>.+) \[(?P<id>{_ID8_PATTERN})\]\.(?P<ext>[^.]+)$")
_BARE_UUID_RE = re.compile(rf"^(?P<id>{_UUID_PATTERN})\.(?P<ext>[^.]+)$")

#: ``(pattern, id key is a full uuid)`` in match-order.
_NAME_PATTERNS: tuple[tuple[re.Pattern[str], bool], ...] = (
    (_FULL_UUID_SIDECAR_RE, True),
    (_FULL_UUID_RE, True),
    (_ID8_RE, False),
    (_BARE_UUID_RE, True),
)


def _extension_kind(extension: str) -> str | None:
    """``"audio"``/``"cover"``/``"lyrics"`` for a recognized extension, else ``None``."""
    if extension in AUDIO_EXTENSIONS:
        return "audio"
    if extension in IMAGE_EXTENSIONS:
        return "cover"
    if extension in LYRICS_EXTENSIONS:
        return "lyrics"
    return None


def _parse_filename(name: str) -> tuple[str, bool, str | None, str] | None:
    """Recognize one of the three export filename forms.

    Returns ``(id key, id key is a full uuid, title or None, extension)`` with
    the id and extension lowercased, or ``None`` when ``name`` matches none of
    them. A ``(cover)``/``(lyrics)`` marker only separates the title from the
    id here — the file's kind always comes from its extension.
    """
    for pattern, id_is_full in _NAME_PATTERNS:
        match = pattern.match(name)
        if match is None:
            continue
        fields = match.groupdict()
        return (
            fields["id"].lower(),
            id_is_full,
            fields.get("title"),
            fields["ext"].lower(),
        )
    return None


def _normalize_title(title: str | None) -> str:
    """Case/whitespace-insensitive title key used to split id8 collisions."""
    if title is None:
        return ""
    return re.sub(r"\s+", " ", title.strip().lower())


@dataclass(frozen=True)
class MediaFile:
    """One recognized file under a media root."""

    id_key: str
    id_is_full: bool
    kind: str
    title: str | None
    relative_path: str
    size: int
    mtime: float
    extension: str


@dataclass(frozen=True)
class Resolution:
    """Outcome of matching one song id (and optional title) to local media.

    ``status`` is one of ``"verified"`` (full-uuid match), ``"matched_id8"``
    (a single id8 candidate, possibly narrowed from several by title),
    ``"ambiguous"`` (several id8 candidates remain and none was picked — see
    ``candidates``) or ``"missing"``.
    """

    status: str
    file: MediaFile | None = None
    alternates: tuple[MediaFile, ...] = ()
    candidates: tuple[MediaFile, ...] = ()


_MISSING = Resolution(status="missing")


def _pick_best(files: Sequence[MediaFile]) -> tuple[MediaFile, tuple[MediaFile, ...]]:
    """Best file first (lossless before lossy for audio); the rest as alternates."""
    ordered = sorted(
        files, key=lambda f: (_AUDIO_FORMAT_RANK.get(f.extension, 1), f.relative_path)
    )
    return ordered[0], tuple(ordered[1:])


def _resolve_id8_matches(matches: Sequence[MediaFile], title: str | None) -> Resolution:
    """Disambiguate files that only share an 8-hex-character id prefix.

    Files are first grouped by normalized title: format alternates of the
    *same* song share both id8 and title, so a single group means there is no
    real collision. More than one group means distinct songs collide on their
    id8 — resolved by ``title`` when it names exactly one group, else reported
    ``ambiguous`` with one (best-format) candidate per colliding song.
    """
    groups: dict[str, list[MediaFile]] = defaultdict(list)
    for file in matches:
        groups[_normalize_title(file.title)].append(file)

    if len(groups) == 1:
        (only_group,) = groups.values()
        chosen, alternates = _pick_best(only_group)
        return Resolution(status="matched_id8", file=chosen, alternates=alternates)

    if title is not None:
        group = groups.get(_normalize_title(title))
        if group is not None:
            chosen, alternates = _pick_best(group)
            return Resolution(status="matched_id8", file=chosen, alternates=alternates)

    candidates = tuple(_pick_best(group)[0] for group in groups.values())
    return Resolution(status="ambiguous", candidates=candidates)


class MediaIndex:
    """Read-only, in-memory index of :class:`MediaFile` records.

    Built by :func:`build_index`. Lookups are always by song id: a full-uuid
    match is ``verified``; a match by the leading 8 hex characters only is
    ``matched_id8`` (disambiguated by title when more than one song shares
    that prefix) or ``ambiguous`` when it cannot be. Covers and lyrics resolve
    the same way, through :meth:`resolve_cover` and :meth:`resolve_lyrics`.
    """

    def __init__(self, files: Iterable[MediaFile]) -> None:
        self._full: dict[tuple[str, str], list[MediaFile]] = defaultdict(list)
        self._id8: dict[tuple[str, str], list[MediaFile]] = defaultdict(list)
        for file in files:
            table = self._full if file.id_is_full else self._id8
            table[(file.kind, file.id_key)].append(file)

    def resolve(self, song_id: str, title: str | None) -> Resolution:
        """Resolve a song's audio file."""
        return self._resolve(song_id, title, "audio")

    def resolve_cover(self, song_id: str, title: str | None) -> Resolution:
        """Resolve a song's cover image, the same way :meth:`resolve` does audio."""
        return self._resolve(song_id, title, "cover")

    def resolve_lyrics(self, song_id: str, title: str | None) -> Resolution:
        """Resolve a song's lyrics text file, the same way :meth:`resolve` does audio."""
        return self._resolve(song_id, title, "lyrics")

    def _resolve(self, song_id: str, title: str | None, kind: str) -> Resolution:
        normalized_id = song_id.strip().lower()
        full_matches = self._full.get((kind, normalized_id))
        if full_matches:
            chosen, alternates = _pick_best(full_matches)
            return Resolution(status="verified", file=chosen, alternates=alternates)

        id8_matches = self._id8.get((kind, normalized_id[:8]))
        if not id8_matches:
            return _MISSING
        return _resolve_id8_matches(id8_matches, title)


def _join_rel(parent_rel: str, name: str) -> str:
    """POSIX-style relative path, independent of the host OS separator."""
    return name if not parent_rel else f"{parent_rel}/{name}"


class _WalkCache:
    """SQLite-backed cache of one directory walk. See the module docstring
    for exactly what "unchanged" means here."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._connection = self._open()

    def _open(self) -> sqlite3.Connection:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            return self._connect_and_init()
        except sqlite3.Error:
            # Corrupt, truncated, or not a database at all: start over rather
            # than fail the walk.
            try:
                self._path.unlink(missing_ok=True)
            except OSError:
                pass
            return self._connect_and_init()

    def _connect_and_init(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS dirs("
                " rel_path TEXT PRIMARY KEY, mtime REAL NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS entries("
                " dir_rel_path TEXT NOT NULL,"
                " name TEXT NOT NULL,"
                " is_dir INTEGER NOT NULL,"
                " kind TEXT,"
                " id_key TEXT,"
                " id_is_full INTEGER,"
                " title TEXT,"
                " extension TEXT,"
                " size INTEGER,"
                " mtime REAL,"
                " PRIMARY KEY (dir_rel_path, name))"
            )
            # Forces a corrupt-but-openable file (e.g. a bad page) to raise
            # here, before any directory is walked, rather than mid-walk.
            connection.execute("SELECT COUNT(*) FROM dirs")
            connection.execute("SELECT COUNT(*) FROM entries")
            connection.commit()
        except sqlite3.Error:
            connection.close()
            raise
        return connection

    def dir_mtime(self, rel_path: str) -> float | None:
        row = self._connection.execute(
            "SELECT mtime FROM dirs WHERE rel_path=?", (rel_path,)
        ).fetchone()
        return None if row is None else float(row["mtime"])

    def dir_children(self, rel_path: str) -> list[sqlite3.Row]:
        return list(
            self._connection.execute(
                "SELECT * FROM entries WHERE dir_rel_path=?", (rel_path,)
            )
        )

    def put_dir(
        self, rel_path: str, mtime: float, children: Sequence[tuple[object, ...]]
    ) -> None:
        self._connection.execute(
            "INSERT INTO dirs(rel_path, mtime) VALUES(?, ?)"
            " ON CONFLICT(rel_path) DO UPDATE SET mtime=excluded.mtime",
            (rel_path, mtime),
        )
        self._connection.execute(
            "DELETE FROM entries WHERE dir_rel_path=?", (rel_path,)
        )
        if children:
            self._connection.executemany(
                "INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?)", children
            )
        self._connection.commit()

    def close(self) -> None:
        self._connection.close()


def _row_to_media_file(rel_dir: str, row: sqlite3.Row) -> MediaFile:
    return MediaFile(
        id_key=row["id_key"],
        id_is_full=bool(row["id_is_full"]),
        kind=row["kind"],
        title=row["title"],
        relative_path=_join_rel(rel_dir, row["name"]),
        size=row["size"],
        mtime=row["mtime"],
        extension=row["extension"],
    )


def _walk_dir(
    directory: Path,
    rel_dir: str,
    dir_mtime: float,
    cache: _WalkCache | None,
) -> Iterator[MediaFile]:
    if cache is not None:
        cached_mtime = cache.dir_mtime(rel_dir)
        if cached_mtime is not None and cached_mtime == dir_mtime:
            for row in cache.dir_children(rel_dir):
                child_path = directory / row["name"]
                if row["is_dir"]:
                    try:
                        current_mtime = os.stat(child_path).st_mtime
                    except OSError:
                        continue  # Vanished since the cache was written.
                    yield from _walk_dir(
                        child_path,
                        _join_rel(rel_dir, row["name"]),
                        current_mtime,
                        cache,
                    )
                else:
                    yield _row_to_media_file(rel_dir, row)
            return

    children: list[tuple[object, ...]] = []
    try:
        with os.scandir(directory) as it:
            entries = list(it)
    except OSError:
        return
    for entry in entries:
        try:
            if entry.is_dir(follow_symlinks=False):
                child_path = Path(entry.path)
                # A directory's mtime is always read with a direct os.stat,
                # never trusted from the DirEntry: on Windows/NTFS a
                # FindNextFile-sourced (DirEntry) mtime for a directory can
                # lag microseconds behind the authoritative value a fresh
                # os.stat returns when that directory was just written to.
                # The cache-hit branch above has no DirEntry to read from and
                # must call os.stat regardless, so using anything else here
                # would compare two different clocks and make the cache miss
                # spuriously. Directories are few next to the file count this
                # module is sized for, so the extra syscall is negligible.
                try:
                    sub_mtime = os.stat(child_path).st_mtime
                except OSError:
                    continue
                children.append(
                    (
                        rel_dir,
                        entry.name,
                        1,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        sub_mtime,
                    )
                )
                yield from _walk_dir(
                    child_path, _join_rel(rel_dir, entry.name), sub_mtime, cache
                )
                continue
            if not entry.is_file(follow_symlinks=False):
                continue
            parsed = _parse_filename(entry.name)
            if parsed is None:
                continue
            id_key, id_is_full, title, extension = parsed
            kind = _extension_kind(extension)
            if kind is None:
                continue
            info = entry.stat(follow_symlinks=False)
            media_file = MediaFile(
                id_key=id_key,
                id_is_full=id_is_full,
                kind=kind,
                title=title,
                relative_path=_join_rel(rel_dir, entry.name),
                size=info.st_size,
                mtime=info.st_mtime,
                extension=extension,
            )
            children.append(
                (
                    rel_dir,
                    entry.name,
                    0,
                    kind,
                    id_key,
                    int(id_is_full),
                    title,
                    extension,
                    info.st_size,
                    info.st_mtime,
                )
            )
            yield media_file
        except OSError:
            continue
    if cache is not None:
        cache.put_dir(rel_dir, dir_mtime, children)


def _iter_tree(root: Path, cache: _WalkCache | None) -> Iterator[MediaFile]:
    try:
        root_mtime = os.stat(root).st_mtime
    except OSError as exc:
        raise ValueError(f"Cannot read media_root: {root}") from exc
    yield from _walk_dir(root, "", root_mtime, cache)


def _check_cache_db_location(media_root: Path, cache_db: Path) -> None:
    resolved_root = media_root.resolve()
    resolved_cache = cache_db.resolve()
    if resolved_cache.is_relative_to(resolved_root):
        raise ValueError(
            f"cache_db must live outside media_root, got {cache_db} under {media_root}"
        )


def build_index(media_root: Path, cache_db: Path | None) -> MediaIndex:
    """Walk ``media_root`` and index every audio/cover/lyrics file found.

    Read-only: nothing under ``media_root`` is ever opened, written, renamed,
    or deleted; every file's metadata comes from its ``DirEntry`` alone (see
    the module docstring for the one, deliberate, directory-only exception).
    ``cache_db``, when given, is a SQLite file the caller places outside
    ``media_root`` — a path that resolves inside it raises ``ValueError`` —
    that persists the walk so a later call skips ``os.scandir`` for any
    directory whose own mtime has not changed (see the module docstring for
    what that does and does not catch). A cache that fails to open as SQLite
    is replaced, never fatal.
    """
    root = Path(media_root)
    if not root.is_dir():
        raise NotADirectoryError(f"media_root is not a directory: {root}")

    cache: _WalkCache | None = None
    if cache_db is not None:
        cache_path = Path(cache_db)
        _check_cache_db_location(root, cache_path)
        cache = _WalkCache(cache_path)

    try:
        return MediaIndex(_iter_tree(root, cache))
    finally:
        if cache is not None:
            cache.close()
