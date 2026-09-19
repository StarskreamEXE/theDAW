"""Path validation for the Suno cache -> theDAW library import wizard.

``paths.py`` is a pure layer: nothing under test here ever writes, moves,
renames or deletes a cache file or a media folder. Every test builds its own
tmp library root, tmp cache files and tmp media folder - never the real Suno
cache or the real theDAW library.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.modules.sunoimport import paths


def test_stage_root_sits_beside_the_library_root(tmp_path: Path) -> None:
    library_root = tmp_path / "library"
    library_root.mkdir()

    stage_root = paths.stage_root_for(library_root)

    assert stage_root.name == "suno-stage"
    assert stage_root.parent == library_root.resolve().parent
    assert not stage_root.is_relative_to(library_root.resolve())


def test_stage_root_inside_library_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    library_root = tmp_path / "library"
    library_root.mkdir()
    monkeypatch.setattr(paths, "default_library_root", lambda: library_root)

    bad_root = library_root / "suno-stage"

    with pytest.raises(paths.ImportPathError) as excinfo:
        paths.ensure_stage_root(bad_root)

    assert str(excinfo.value) == "stage folder must not sit inside the library"
    assert not bad_root.exists()


def test_validate_cache_paths_dedupes_and_resolves(tmp_path: Path) -> None:
    cache_file = tmp_path / "cache.jsonl"
    cache_file.write_bytes(b'{"song": 1}\n')

    result = paths.validate_cache_paths([str(cache_file), str(cache_file)])

    assert result == [cache_file.resolve()]


def test_missing_cache_file_error_names_only_the_file_name(tmp_path: Path) -> None:
    missing = tmp_path / "deep" / "nested" / "missing-cache.jsonl"

    with pytest.raises(paths.ImportPathError) as excinfo:
        paths.validate_cache_paths([str(missing)])

    message = str(excinfo.value)
    assert message == "no such cache file: missing-cache.jsonl"
    assert str(missing.parent) not in message


def test_missing_media_root_is_refused_and_never_created(tmp_path: Path) -> None:
    missing = tmp_path / "media-that-does-not-exist"

    with pytest.raises(paths.ImportPathError) as excinfo:
        paths.validate_media_root(str(missing))

    assert str(excinfo.value) == "no such media folder: media-that-does-not-exist"
    assert not missing.exists()


def test_refuse_overlap_when_stage_root_is_under_the_media_root(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    stage_root = media_root / "suno-stage"

    with pytest.raises(paths.ImportPathError) as excinfo:
        paths.refuse_overlap(stage_root, [], media_root)

    assert str(excinfo.value) == "stage folder must not sit inside media"


def test_cache_file_is_unchanged_after_validation(tmp_path: Path) -> None:
    cache_file = tmp_path / "cache.jsonl"
    cache_file.write_bytes(b'{"song": 1}\n')
    before_bytes = cache_file.read_bytes()
    before_mtime = cache_file.stat().st_mtime

    paths.validate_cache_paths([str(cache_file)])

    assert cache_file.read_bytes() == before_bytes
    assert cache_file.stat().st_mtime == before_mtime


def test_ensure_stage_root_wraps_mkdir_failure_in_import_path_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: mkdir must share ensure_stage_root's OSError handler.

    A parent path segment that is a regular file makes ``mkdir`` raise
    (``FileExistsError`` on Windows, ``NotADirectoryError`` on POSIX) - both
    are ``OSError`` subclasses, and must surface as ``ImportPathError``
    naming only the stage folder, never as a raw OSError carrying a full
    filesystem path.
    """
    library_root = tmp_path / "library"
    library_root.mkdir()
    monkeypatch.setattr(paths, "default_library_root", lambda: library_root)

    blocking_file = tmp_path / "not-a-dir"
    blocking_file.write_bytes(b"")
    bad_stage_root = blocking_file / "suno-stage"

    with pytest.raises(paths.ImportPathError) as excinfo:
        paths.ensure_stage_root(bad_stage_root)

    message = str(excinfo.value)
    assert message == "stage folder is not writable: suno-stage"
    assert str(tmp_path) not in message


def test_is_same_or_within_true_for_drive_root_ancestor(tmp_path: Path) -> None:
    """Regression: ``str()`` of a drive root already ends in ``os.sep``
    (e.g. ``"E:\\\\"``), so unconditionally appending another ``os.sep``
    before the ``startswith`` check built an unmatchable doubled separator -
    every candidate under a drive-root ancestor was wrongly reported as not
    within it. Uses ``tmp_path.anchor`` so the drive letter matches whatever
    drive the test runner's temp dir is actually on.
    """
    drive_root = Path(tmp_path.anchor)
    candidate = drive_root / "suno-stage"

    assert paths._is_same_or_within(candidate, drive_root) is True


def test_refuse_overlap_refuses_stage_root_under_a_drive_root_media_root(
    tmp_path: Path,
) -> None:
    drive_root = Path(tmp_path.anchor)
    stage_root = drive_root / "suno-stage"

    with pytest.raises(paths.ImportPathError):
        paths.refuse_overlap(stage_root, [], drive_root)
