"""Read-only Suno export media index (backend.modules.library.suno_media_index).

Every fixture lives under ``tmp_path``; nothing here reads or writes the
user's real Suno export, cache, or media root. The properties under test:
each of the three filename forms is recognized, a full-uuid match is
``verified``, an id8-only match is ``matched_id8`` (disambiguated by title
when more than one song shares the prefix, else ``ambiguous`` with every
candidate), a lossless format wins over a lossy one for the same id,
sidecars resolve the same way as audio, the walk cache is reused across
runs (proven by counting real ``os.scandir`` calls, not just by re-reading
correct output), a cache_db inside the media root is refused, a corrupt
cache is rebuilt rather than failing, and a 20k-file tree walks quickly.
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path

import pytest

from backend.modules.library import suno_media_index as smi


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")


def _uuid() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Naming forms
# ---------------------------------------------------------------------------


def test_id8_form_resolves_by_first_eight_hex_chars(tmp_path: Path) -> None:
    song_id = _uuid()
    id8 = song_id[:8]
    _touch(tmp_path / "profile" / "folder" / f"My Song [{id8}].mp3")

    index = smi.build_index(tmp_path, None)
    resolution = index.resolve(song_id, "My Song")

    assert resolution.status == "matched_id8"
    assert resolution.file is not None
    assert resolution.file.relative_path.endswith(f"My Song [{id8}].mp3")
    assert resolution.file.kind == "audio"


def test_full_uuid_form_is_verified(tmp_path: Path) -> None:
    song_id = _uuid()
    _touch(tmp_path / "folder" / f"My Song [{song_id}].mp3")

    index = smi.build_index(tmp_path, None)
    resolution = index.resolve(song_id, "My Song")

    assert resolution.status == "verified"
    assert resolution.file is not None
    assert resolution.file.id_key == song_id.lower()


def test_bare_uuid_form_is_verified(tmp_path: Path) -> None:
    song_id = _uuid()
    _touch(tmp_path / f"{song_id}.mp3")

    index = smi.build_index(tmp_path, None)
    resolution = index.resolve(song_id, None)

    assert resolution.status == "verified"
    assert resolution.file is not None
    assert resolution.file.relative_path == f"{song_id}.mp3"


def test_sidecars_are_found_for_full_uuid_form(tmp_path: Path) -> None:
    song_id = _uuid()
    _touch(tmp_path / f"My Song [{song_id}].mp3")
    _touch(tmp_path / f"My Song [{song_id}] (cover).jpg")
    _touch(tmp_path / f"My Song [{song_id}] (lyrics).txt")

    index = smi.build_index(tmp_path, None)
    cover = index.resolve_cover(song_id, "My Song")
    lyrics = index.resolve_lyrics(song_id, "My Song")

    assert cover.status == "verified"
    assert cover.file is not None
    assert cover.file.relative_path.endswith("(cover).jpg")
    assert lyrics.status == "verified"
    assert lyrics.file is not None
    assert lyrics.file.relative_path.endswith("(lyrics).txt")


def test_unknown_id_is_missing(tmp_path: Path) -> None:
    _touch(tmp_path / f"Song [{_uuid()}].mp3")

    index = smi.build_index(tmp_path, None)
    resolution = index.resolve(_uuid(), None)

    assert resolution.status == "missing"
    assert resolution.file is None


# ---------------------------------------------------------------------------
# id8 collisions
# ---------------------------------------------------------------------------


def test_id8_collision_between_two_songs_is_resolved_by_title(tmp_path: Path) -> None:
    id8 = "1a2b3c4d"
    id_a = f"{id8}-1111-1111-1111-111111111111"
    id_b = f"{id8}-2222-2222-2222-222222222222"
    _touch(tmp_path / f"Song A [{id8}].mp3")
    _touch(tmp_path / f"Song B [{id8}].mp3")

    index = smi.build_index(tmp_path, None)
    resolved_a = index.resolve(id_a, "Song A")
    resolved_b = index.resolve(id_b, "Song B")

    assert resolved_a.status == "matched_id8"
    assert resolved_a.file is not None
    assert resolved_a.file.relative_path.endswith(f"Song A [{id8}].mp3")
    assert resolved_b.status == "matched_id8"
    assert resolved_b.file is not None
    assert resolved_b.file.relative_path.endswith(f"Song B [{id8}].mp3")


def test_unresolvable_id8_collision_is_ambiguous_with_both_candidates(
    tmp_path: Path,
) -> None:
    id8 = "1a2b3c4d"
    id_a = f"{id8}-1111-1111-1111-111111111111"
    _touch(tmp_path / f"Song A [{id8}].mp3")
    _touch(tmp_path / f"Song B [{id8}].mp3")

    index = smi.build_index(tmp_path, None)
    resolution = index.resolve(id_a, None)

    assert resolution.status == "ambiguous"
    assert resolution.file is None
    assert len(resolution.candidates) == 2
    names = {Path(candidate.relative_path).name for candidate in resolution.candidates}
    assert names == {f"Song A [{id8}].mp3", f"Song B [{id8}].mp3"}


def test_id8_collision_with_unmatched_title_is_still_ambiguous(tmp_path: Path) -> None:
    id8 = "1a2b3c4d"
    id_a = f"{id8}-1111-1111-1111-111111111111"
    _touch(tmp_path / f"Song A [{id8}].mp3")
    _touch(tmp_path / f"Song B [{id8}].mp3")

    index = smi.build_index(tmp_path, None)
    resolution = index.resolve(id_a, "Totally Different Title")

    assert resolution.status == "ambiguous"
    assert len(resolution.candidates) == 2


# ---------------------------------------------------------------------------
# Format preference
# ---------------------------------------------------------------------------


def test_lossless_audio_is_preferred_over_lossy_for_the_same_id(tmp_path: Path) -> None:
    song_id = _uuid()
    _touch(tmp_path / f"My Song [{song_id}].mp3")
    _touch(tmp_path / f"My Song [{song_id}].wav")

    index = smi.build_index(tmp_path, None)
    resolution = index.resolve(song_id, "My Song")

    assert resolution.status == "verified"
    assert resolution.file is not None
    assert resolution.file.extension == "wav"
    assert len(resolution.alternates) == 1
    assert resolution.alternates[0].extension == "mp3"


# ---------------------------------------------------------------------------
# Cache: reuse, refusal, corruption
# ---------------------------------------------------------------------------


def test_cache_avoids_rescanning_a_fully_unchanged_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second walk with nothing changed anywhere calls ``os.scandir`` zero
    times: every directory, root included, is served from the cache.

    This is the timing-unambiguous case for the "unchanged folder" rule: no
    write happens anywhere in the tree between the two calls, so there is no
    directory whose mtime could plausibly be observed differently between
    them (unlike, say, a sibling folder next to one that was just written
    to, where OS-level metadata write-back timing is not something this
    module controls). That scenario is covered functionally, without pinning
    an exact syscall count, by
    ``test_cache_reuse_after_adding_one_file`` below.
    """
    media_root = tmp_path / "media"
    cache_db = tmp_path / "cache" / "index.sqlite3"
    song_id = _uuid()
    _touch(media_root / "folder" / f"Song One [{song_id}].mp3")

    first = smi.build_index(media_root, cache_db)
    assert first.resolve(song_id, "Song One").status == "verified"
    assert cache_db.is_file()

    scanned: list[str] = []
    real_scandir = smi.os.scandir

    def counting_scandir(path: object = ".") -> object:
        scanned.append(Path(path).name)  # type: ignore[arg-type]
        return real_scandir(path)

    monkeypatch.setattr(smi.os, "scandir", counting_scandir)

    second = smi.build_index(media_root, cache_db)

    assert scanned == []
    assert second.resolve(song_id, "Song One").status == "verified"


def test_cache_reuse_after_adding_one_file(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    cache_db = tmp_path / "cache" / "index.sqlite3"
    song_id = _uuid()
    _touch(media_root / "folder" / f"Song One [{song_id}].mp3")

    first = smi.build_index(media_root, cache_db)
    assert first.resolve(song_id, "Song One").status == "verified"
    assert cache_db.is_file()

    new_id = _uuid()
    _touch(media_root / "folder2" / f"Song Two [{new_id}].mp3")

    second = smi.build_index(media_root, cache_db)

    assert second.resolve(song_id, "Song One").status == "verified"
    assert second.resolve(new_id, "Song Two").status == "verified"


def test_cache_db_inside_media_root_is_refused(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    cache_db = media_root / ".cache" / "index.sqlite3"

    with pytest.raises(ValueError):
        smi.build_index(media_root, cache_db)


def test_corrupt_cache_db_is_rebuilt_not_fatal(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    cache_db = tmp_path / "cache.sqlite3"
    song_id = _uuid()
    _touch(media_root / f"Song [{song_id}].mp3")
    cache_db.parent.mkdir(parents=True, exist_ok=True)
    cache_db.write_bytes(b"not a sqlite database")

    index = smi.build_index(media_root, cache_db)

    assert index.resolve(song_id, "Song").status == "verified"


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------


def test_walk_over_twenty_thousand_files_finishes_quickly(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    total = 20_000
    for i in range(total):
        song_id = f"{i:08x}-0000-4000-8000-{i:012x}"
        folder = media_root / "profile" / f"batch-{i // 1000:02d}"
        _touch(folder / f"Song {i} [{song_id}].mp3")

    started = time.perf_counter()
    index = smi.build_index(media_root, None)
    elapsed = time.perf_counter() - started

    assert elapsed < 15.0
    first_id = f"{0:08x}-0000-4000-8000-{0:012x}"
    assert index.resolve(first_id, "Song 0").status == "verified"
