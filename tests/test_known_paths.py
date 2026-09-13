"""What theDAW remembers about paths, and what that memory lets through.

known_paths is behind every picker's starting folder and every Recent menu, and
it is the gate on /api/places/file and /api/places/save. The rules pinned here
are the security ones (a request body never makes a path servable, a save grant
writes once) and the ones a user notices (a picker starts where the last one
ended, a deleted file drops out of the list).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from backend.lib import known_paths


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An empty store under tmp_path, a home folder with nothing in it, and a
    data root of our own."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    path = tmp_path / "state" / "known_paths.json"
    monkeypatch.setattr(known_paths, "_STORE_PATH", path)
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    return path


def _touch(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.mark.parametrize(
    ("name", "kind"),
    [
        ("song.tasmo", "tasmo"),
        ("pad.gan", "gan"),
        ("scene.sway", "sway"),
        ("capture.ares", "ares"),
        ("set.als", "daw-project"),
        ("session.rpp-bak", "daw-project"),
        ("session.pts", "daw-project"),
        ("take.WAV", "audio"),
        ("mix.flac", "audio"),
        ("clip.webm", "audio"),
        ("groove.mid", "midi"),
        ("lead.musicxml", "score"),
        ("chart.pdf", "score"),
        ("words.lrc", "lyrics"),
        ("notes.txt", "lyrics"),
        ("export.json", "json"),
        ("cover.jpeg", "image"),
        ("show.mkv", "video"),
        ("bundle.zip", "zip"),
        ("model.safetensors", "checkpoint"),
        ("companion.apk", "apk"),
        ("readme.md", "file"),
        ("no-extension", "file"),
    ],
)
def test_kind_follows_the_extension(name: str, kind: str, tmp_path: Path) -> None:
    assert known_paths.kind_for_path(tmp_path / name) == kind


def test_a_directory_is_a_folder_unless_it_is_a_project_bundle(tmp_path: Path) -> None:
    plain = tmp_path / "Samples.wav"
    plain.mkdir()
    bundle = tmp_path / "Song.logicx"
    bundle.mkdir()
    assert known_paths.kind_for_path(plain) == "folder"
    assert known_paths.kind_for_path(bundle) == "daw-project"


def test_a_missing_path_is_not_remembered(store: Path, tmp_path: Path) -> None:
    assert known_paths.record(tmp_path / "nope.wav", source="pick") is None
    assert known_paths.recent() == []
    assert not store.exists()


def test_record_stores_the_entry_and_its_folder(store: Path, tmp_path: Path) -> None:
    take = _touch(tmp_path / "takes" / "take.wav")
    entry = known_paths.record(take, source="pick")
    assert entry is not None
    assert entry["path"] == str(take)
    assert entry["name"] == "take.wav"
    assert entry["kind"] == "audio"
    assert entry["source"] == "pick"
    assert entry["servable"] is True
    assert isinstance(entry["at"], float)
    assert known_paths.last_folder("audio") == str(take.parent)

    library = tmp_path / "library"
    library.mkdir()
    folder_entry = known_paths.record(
        library, kind="library-folder", source="library-folder"
    )
    assert folder_entry is not None
    assert folder_entry["servable"] is False
    assert known_paths.last_folder("library-folder") == str(library)

    raw = json.loads(store.read_text(encoding="utf-8"))
    stored = raw["recent"]["audio"][0]
    assert stored["path"] == str(take)
    # Servable is worked out on every read, so a stored flag cannot be forged.
    assert "servable" not in stored


def test_recording_again_moves_the_path_to_the_front_once(
    store: Path, tmp_path: Path
) -> None:
    first = _touch(tmp_path / "a.mid")
    second = _touch(tmp_path / "b.mid")
    known_paths.record(first, source="pick")
    known_paths.record(second, source="pick")
    known_paths.record(first, source="pick")
    names = [e["name"] for e in known_paths.recent(kind="midi")]
    assert names == ["a.mid", "b.mid"]


@pytest.mark.skipif(os.name != "nt", reason="case-insensitive paths are Windows")
def test_windows_paths_match_without_regard_to_case(
    store: Path, tmp_path: Path
) -> None:
    take = _touch(tmp_path / "Take.wav")
    known_paths.record(take, source="pick")
    known_paths.record(str(take).upper(), source="pick")
    assert len(known_paths.recent(kind="audio")) == 1
    assert known_paths.find_servable(str(take).lower()) is not None


def test_each_kind_keeps_the_newest_thirty(store: Path, tmp_path: Path) -> None:
    for i in range(known_paths.MAX_PER_KIND + 5):
        known_paths.record(_touch(tmp_path / f"t{i:02}.wav"), source="pick")
    items = known_paths.recent(kind="audio", limit=100)
    names = [e["name"] for e in items]
    assert len(items) == known_paths.MAX_PER_KIND
    assert names[0] == f"t{known_paths.MAX_PER_KIND + 4:02}.wav"
    assert "t04.wav" not in names


def test_kinds_are_capped(store: Path, tmp_path: Path) -> None:
    take = _touch(tmp_path / "take.wav")
    total = known_paths.MAX_KINDS + 5
    for i in range(total):
        known_paths.record(take, kind=f"k{i}", source="client")
    raw = json.loads(store.read_text(encoding="utf-8"))
    assert len(raw["recent"]) == known_paths.MAX_KINDS
    assert len(raw["folders"]) == known_paths.MAX_KINDS
    assert "k0" not in raw["recent"]
    assert f"k{total - 1}" in raw["recent"]


def test_an_invalid_kind_falls_back_to_the_extension(
    store: Path, tmp_path: Path
) -> None:
    take = _touch(tmp_path / "take.wav")
    assert known_paths.record(take, kind="../../etc", source="pick")["kind"] == "audio"
    assert known_paths.record(take, kind="", source="pick")["kind"] == "audio"
    assert known_paths.record(take, kind="Big Kind", source="pick")["kind"] == "audio"


def test_recent_drops_missing_files_and_filters_by_extension(
    store: Path, tmp_path: Path
) -> None:
    keep = _touch(tmp_path / "keep.mid")
    gone = _touch(tmp_path / "gone.midi")
    wav = _touch(tmp_path / "x.wav")
    for p in (keep, gone, wav):
        known_paths.record(p, source="pick")
    gone.unlink()

    assert [e["name"] for e in known_paths.recent(exts=[".mid", "MIDI"])] == [
        "keep.mid"
    ]
    assert {e["name"] for e in known_paths.recent()} == {"keep.mid", "x.wav"}
    assert [e["name"] for e in known_paths.recent(kind="audio")] == ["x.wav"]
    assert len(known_paths.recent(limit=1)) == 1
    assert known_paths.recent(limit=0) == []


def test_a_client_record_is_remembered_but_never_servable(
    store: Path, tmp_path: Path
) -> None:
    secret = _touch(tmp_path / "private" / "keys.json")
    entry = known_paths.record(secret, source="client")
    assert entry is not None
    assert entry["servable"] is False
    assert known_paths.recent()[0]["servable"] is False
    assert known_paths.find_servable(secret) is None
    # Still useful for the next picker.
    assert known_paths.last_folder("json") == str(secret.parent)


def test_a_download_record_is_never_servable(store: Path, tmp_path: Path) -> None:
    fetched = _touch(tmp_path / "Downloads" / "loop.wav")
    known_paths.record(fetched, source="download")
    assert known_paths.find_servable(fetched) is None


def test_a_client_record_keeps_a_picked_file_servable(
    store: Path, tmp_path: Path
) -> None:
    picked = _touch(tmp_path / "picked.wav")
    known_paths.record(picked, source="pick")
    again = known_paths.record(picked, source="client")
    assert again is not None
    assert again["source"] == "pick"
    assert known_paths.find_servable(picked) == str(picked)

    # Recorded under another kind as well: one row, still servable.
    known_paths.record(picked, kind="stems", source="client")
    items = known_paths.recent()
    assert len(items) == 1
    assert items[0]["servable"] is True


def test_find_servable_answers_with_the_stored_path(
    store: Path, tmp_path: Path
) -> None:
    saved = _touch(tmp_path / "out" / "mix.wav")
    known_paths.record(saved, source="save")
    spelled = tmp_path / "out" / ".." / "out" / "mix.wav"
    assert known_paths.find_servable(str(spelled)) == str(saved)
    assert known_paths.find_servable(tmp_path / "out" / "other.wav") is None
    assert known_paths.find_servable("") is None

    picked_folder = tmp_path / "picked-folder"
    picked_folder.mkdir()
    known_paths.record(picked_folder, kind="library-folder", source="library-folder")
    assert known_paths.find_servable(picked_folder) is None

    saved.unlink()
    assert known_paths.find_servable(saved) is None


def test_last_folder_falls_back_when_the_folder_is_gone(
    store: Path, tmp_path: Path
) -> None:
    downloads = tmp_path / "home" / "Downloads"
    assert known_paths.last_folder("audio") is None
    downloads.mkdir()
    assert known_paths.last_folder("audio") == str(downloads)

    take = _touch(tmp_path / "session" / "take.wav")
    known_paths.record(take, source="pick")
    assert known_paths.last_folder("audio") == str(take.parent)

    take.unlink()
    take.parent.rmdir()
    assert known_paths.last_folder("audio") == str(downloads)


def test_default_folders(store: Path, tmp_path: Path) -> None:
    home = tmp_path / "home"
    data = tmp_path / "data"
    assert known_paths.default_folder("tasmo") == str(
        home / "Documents" / "theDAW Projects"
    )
    assert known_paths.default_folder("gan") == str(data / "plugins")
    assert known_paths.default_folder("sway") == str(data / "sway-projects")
    assert known_paths.default_folder("ares") == str(data / "volumetric")
    assert known_paths.default_folder("backup-zip") is None
    assert known_paths.default_folder("library-folder") is None
    assert known_paths.default_folder("checkpoint") is None
    assert known_paths.default_folder("apk") is None
    assert known_paths.default_folder(None) is None

    (home / "Documents").mkdir()
    (home / "Music").mkdir()
    (home / "Downloads").mkdir()
    assert known_paths.default_folder("backup-zip") == str(home / "Documents")
    assert known_paths.default_folder("backup-dest") == str(home / "Documents")
    assert known_paths.default_folder("library-folder") == str(home / "Music")
    assert known_paths.default_folder("apk") == str(home / "Downloads")


def test_record_folder_needs_an_existing_folder(store: Path, tmp_path: Path) -> None:
    known_paths.record_folder("backup-dest", tmp_path / "missing")
    assert known_paths.last_folder("backup-dest") is None
    known_paths.record_folder("backup-dest", tmp_path)
    assert known_paths.last_folder("backup-dest") == str(tmp_path)
    known_paths.record_folder("Not A Kind", tmp_path)
    raw = json.loads(store.read_text(encoding="utf-8"))
    assert raw["folders"] == {"backup-dest": str(tmp_path)}


def test_projects_dir_is_stored_and_must_be_absolute(
    store: Path, tmp_path: Path
) -> None:
    home = tmp_path / "home"
    assert known_paths.projects_dir() == home / "Documents" / "theDAW Projects"

    chosen = tmp_path / "My Projects"
    assert known_paths.set_projects_dir(str(chosen)) == chosen
    assert known_paths.projects_dir() == chosen
    assert known_paths.default_folder("tasmo") == str(chosen)

    for bad in ("", "   ", "relative/projects"):
        with pytest.raises(ValueError):
            known_paths.set_projects_dir(bad)
    assert known_paths.projects_dir() == chosen


def test_installed_asset_path_needs_the_file(store: Path, tmp_path: Path) -> None:
    copy = _touch(tmp_path / "Projects" / "demo.tasmo")
    known_paths.set_installed_asset("demo", copy)
    assert known_paths.installed_asset_path("demo") == str(copy)
    assert known_paths.installed_asset_path("other") is None
    copy.unlink()
    assert known_paths.installed_asset_path("demo") is None


def test_a_save_grant_writes_once(store: Path, tmp_path: Path) -> None:
    target = tmp_path / "exports" / "mix.wav"
    assert known_paths.consume_save_grant(target) is False
    known_paths.grant_save(target)
    # Grants live in memory only.
    assert not store.exists()
    assert known_paths.consume_save_grant(tmp_path / "exports" / "other.wav") is False
    assert known_paths.consume_save_grant(tmp_path / "exports" / "." / "mix.wav")
    assert known_paths.consume_save_grant(target) is False


def test_a_save_grant_expires(
    store: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = [1000.0]
    monkeypatch.setattr(known_paths, "_clock", lambda: now[0])
    target = tmp_path / "late.wav"
    known_paths.grant_save(target)
    now[0] += known_paths.SAVE_GRANT_SECONDS + 1
    assert known_paths.consume_save_grant(target) is False


def test_a_corrupt_store_reads_as_empty_and_is_rewritten(
    store: Path, tmp_path: Path
) -> None:
    store.parent.mkdir(parents=True)
    store.write_text("{not json", encoding="utf-8")
    assert known_paths.recent() == []
    assert known_paths.last_folder("checkpoint") is None

    take = _touch(tmp_path / "take.wav")
    assert known_paths.record(take, source="pick") is not None
    raw = json.loads(store.read_text(encoding="utf-8"))
    assert raw["recent"]["audio"][0]["name"] == "take.wav"


def test_malformed_entries_are_dropped(store: Path, tmp_path: Path) -> None:
    take = _touch(tmp_path / "take.wav")
    store.parent.mkdir(parents=True)
    store.write_text(
        json.dumps(
            {
                "recent": {
                    "audio": [
                        {"path": str(take), "source": "pick", "at": 1.0},
                        {"path": 5, "source": "pick", "at": 2.0},
                        {"path": str(take), "source": "pick", "at": "yesterday"},
                        "junk",
                    ],
                    "Bad Kind!": [{"path": str(take), "source": "pick", "at": 3.0}],
                },
                "folders": {"audio": 3},
                "installed": ["not", "a", "map"],
            }
        ),
        encoding="utf-8",
    )
    items = known_paths.recent()
    assert [(e["name"], e["kind"], e["servable"]) for e in items] == [
        ("take.wav", "audio", True)
    ]
    assert known_paths.installed_asset_path("demo") is None


def test_an_unwritable_store_never_raises(
    store: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    blocker = tmp_path / "blocker"
    blocker.write_text("a file where the store folder should be", encoding="utf-8")
    monkeypatch.setattr(known_paths, "_STORE_PATH", blocker / "known_paths.json")

    take = _touch(tmp_path / "take.wav")
    assert known_paths.record(take, source="pick") is not None
    known_paths.record_folder("audio", tmp_path)
    known_paths.set_installed_asset("demo", take)
    assert known_paths.set_projects_dir(str(tmp_path / "P")) == tmp_path / "P"
    assert known_paths.recent() == []
    assert known_paths.find_servable(take) is None
