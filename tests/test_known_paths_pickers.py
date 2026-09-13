"""The native pickers in /api/storage open where the last path of a kind was,
and remember what the user chooses.

folder_dialog's functions are replaced with recorders, so no dialog opens. Each
sequence test replays the order the app produces: a first pick with no history,
then a second picker that has to open where the first one landed.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core import folder_dialog
from backend.lib import known_paths, paths
from backend.modules.places import router as places_router
from backend.modules.quest import router as quest_router
from backend.modules.storage import router as storage_router


class _Dialog:
    """Stands in for one folder_dialog function. Records every call's arguments
    by parameter name and answers with the next queued path; None is a cancel."""

    def __init__(self, real: Callable[..., Any], *answers: str | None) -> None:
        self._signature = inspect.signature(real)
        self._answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    def __call__(self, *args: Any, **kwargs: Any) -> str | None:
        bound = self._signature.bind(*args, **kwargs)
        bound.apply_defaults()
        self.calls.append(dict(bound.arguments))
        return self._answers.pop(0) if self._answers else None


def _dialog(
    monkeypatch: pytest.MonkeyPatch, name: str, *answers: str | None
) -> _Dialog:
    fake = _Dialog(getattr(folder_dialog, name), *answers)
    monkeypatch.setattr(folder_dialog, name, fake)
    return fake


def _touch(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    # Every dialog is replaced, so a headless runner has a "picker" too.
    monkeypatch.setattr(folder_dialog, "picker_available", lambda: True)
    return home


@pytest.fixture
def client(home: Path) -> TestClient:
    app = FastAPI()
    app.include_router(storage_router.router, prefix="/api/storage")
    app.include_router(places_router.router, prefix="/api/places")
    app.include_router(quest_router.router, prefix="/api/quest")
    return TestClient(app)


# ---------------------------------------------------------------------------
# pick-file
# ---------------------------------------------------------------------------


def test_a_picked_file_is_remembered_and_the_next_picker_opens_beside_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    plugin = _touch(tmp_path / "Plugins" / "chorus.gan")
    dialog = _dialog(monkeypatch, "pick_open_file", str(plugin), None)

    first = client.post(
        "/api/storage/pick-file",
        json={"kind": "gan", "filter": "GAN (*.gan)|*.gan", "title": "Open a plugin"},
    )
    assert first.json() == {"path": str(plugin), "cancelled": False}
    assert dialog.calls[0]["title"] == "Open a plugin"
    assert dialog.calls[0]["filter_spec"] == "GAN (*.gan)|*.gan"
    # No history yet: the kind's default folder.
    assert dialog.calls[0]["initial_dir"] == str(paths.data_path("plugins"))

    items = known_paths.recent(kind="gan")
    assert [(i["path"], i["source"], i["servable"]) for i in items] == [
        (str(plugin), "pick", True)
    ]

    second = client.post("/api/storage/pick-file", json={"kind": "gan"})
    assert second.json() == {"path": None, "cancelled": True}
    assert dialog.calls[1]["initial_dir"] == str(plugin.parent)


def test_an_existing_initial_dir_wins_over_the_remembered_folder(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    remembered = tmp_path / "Remembered"
    remembered.mkdir()
    field = tmp_path / "Field"
    field.mkdir()
    known_paths.record_folder("audio", remembered)
    dialog = _dialog(monkeypatch, "pick_open_file", None)

    client.post(
        "/api/storage/pick-file", json={"kind": "audio", "initial_dir": str(field)}
    )
    assert dialog.calls[0]["initial_dir"] == str(field)


def test_a_missing_initial_dir_falls_back_to_the_folder_for_the_kind(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    remembered = tmp_path / "Remembered"
    remembered.mkdir()
    known_paths.record_folder("audio", remembered)
    dialog = _dialog(monkeypatch, "pick_open_file", None)

    client.post(
        "/api/storage/pick-file",
        json={"kind": "audio", "initial_dir": str(tmp_path / "deleted")},
    )
    assert dialog.calls[0]["initial_dir"] == str(remembered)


def test_with_no_history_a_download_kind_opens_in_downloads(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, home: Path
) -> None:
    downloads = home / "Downloads"
    downloads.mkdir()
    dialog = _dialog(monkeypatch, "pick_open_file", None)

    client.post("/api/storage/pick-file", json={"kind": "midi"})
    assert dialog.calls[0]["initial_dir"] == str(downloads)


def test_without_a_body_the_pick_is_remembered_under_its_extension(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    riff = _touch(tmp_path / "Takes" / "riff.mid")
    dialog = _dialog(monkeypatch, "pick_open_file", str(riff))

    assert client.post("/api/storage/pick-file").json() == {
        "path": str(riff),
        "cancelled": False,
    }
    call = dialog.calls[0]
    assert call["title"] == "Select a file for theDAW"
    assert call["filter_spec"] == "All files (*.*)|*.*"
    assert call["initial_dir"] is None
    assert [i["path"] for i in known_paths.recent(kind="midi")] == [str(riff)]
    assert known_paths.last_folder("midi") == str(riff.parent)


def test_a_daw_project_picked_from_the_project_field_is_listed_as_a_daw_project(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The Session tab's Open field asks with kind 'tasmo' and also takes .als.
    The .als belongs in DAW project menus; the field's next dialog still opens
    in its folder."""
    song = _touch(tmp_path / "Ableton" / "Song Project" / "Song.als")
    dialog = _dialog(monkeypatch, "pick_open_file", str(song), None)

    client.post("/api/storage/pick-file", json={"kind": "tasmo"})
    assert [i["path"] for i in known_paths.recent(kind="daw-project")] == [str(song)]
    assert known_paths.recent(kind="tasmo") == []
    assert known_paths.last_folder("daw-project") == str(song.parent)

    client.post("/api/storage/pick-file", json={"kind": "tasmo"})
    assert dialog.calls[1]["initial_dir"] == str(song.parent)


def test_a_kind_no_extension_produces_is_kept_for_the_pick(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    backup = _touch(tmp_path / "Backups" / "theDAW-backup-1.zip")
    _dialog(monkeypatch, "pick_open_file", str(backup))

    client.post("/api/storage/pick-file", json={"kind": "backup-zip"})
    assert [i["path"] for i in known_paths.recent(kind="backup-zip")] == [str(backup)]
    assert known_paths.recent(kind="zip") == []


@pytest.mark.parametrize(
    "route",
    ["/api/storage/pick-file", "/api/storage/pick-folder", "/api/storage/pick-save"],
)
def test_a_machine_with_no_dialog_answers_501(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, route: str
) -> None:
    """saveFile turns a 501 into a browser download, so "no dialog here" must
    not look like a cancel."""
    monkeypatch.setattr(folder_dialog, "picker_available", lambda: False)
    somewhere = str(_touch(tmp_path / "a.wav"))
    dialogs = [
        _dialog(monkeypatch, name, somewhere)
        for name in ("pick_open_file", "pick_folder", "pick_save_file")
    ]

    resp = client.post(route, json={"kind": "audio"})
    assert resp.status_code == 501
    assert all(not d.calls for d in dialogs)
    assert known_paths.consume_save_grant(somewhere) is False


def test_the_quest_apk_picker_opens_where_the_last_apk_landed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, home: Path
) -> None:
    """A downloaded APK is recorded by the desktop shell; the deploy dialog's
    picker then opens in that folder and remembers what the user picks."""
    monkeypatch.setattr(quest_router.service, "load_config", lambda: {})
    calls: list[tuple[Any, ...]] = []
    downloaded = _touch(home / "Downloads" / "theDAW-XR.apk")
    picked = _touch(tmp_path / "Builds" / "theDAW-XR-dev.apk")
    answers = [str(picked), None]

    def fake_pick(*args: Any) -> str | None:
        calls.append(args)
        return answers.pop(0)

    monkeypatch.setattr(quest_router, "pick_open_file", fake_pick)
    known_paths.record(downloaded, "apk", source="client")

    assert client.get("/api/quest/pick-apk").json() == {"path": str(picked)}
    assert calls[0][1] == str(downloaded.parent)
    assert [i["path"] for i in known_paths.recent(kind="apk")][0] == str(picked)

    client.get("/api/quest/pick-apk")
    assert calls[1][1] == str(picked.parent)


def test_a_cancelled_file_picker_remembers_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _dialog(monkeypatch, "pick_open_file", None)

    assert client.post("/api/storage/pick-file", json={"kind": "gan"}).json() == {
        "path": None,
        "cancelled": True,
    }
    assert known_paths.recent() == []


# ---------------------------------------------------------------------------
# pick-folder
# ---------------------------------------------------------------------------


def test_a_picked_folder_becomes_where_the_next_folder_picker_opens(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    checkpoints = tmp_path / "Checkpoints"
    checkpoints.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", str(checkpoints), None)

    first = client.post("/api/storage/pick-folder", json={"kind": "checkpoint"})
    assert first.json() == {"path": str(checkpoints), "cancelled": False}
    assert known_paths.last_folder("checkpoint") == str(checkpoints)

    client.post("/api/storage/pick-folder", json={"kind": "checkpoint"})
    assert dialog.calls[1]["initial"] == str(checkpoints)


def test_a_folder_picker_opens_at_the_fields_folder_and_needs_no_kind(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    field = tmp_path / "Field"
    field.mkdir()
    chosen = tmp_path / "Chosen"
    chosen.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", str(chosen))

    resp = client.post("/api/storage/pick-folder", json={"initial_dir": str(field)})
    assert resp.json() == {"path": str(chosen), "cancelled": False}
    assert dialog.calls[0]["initial"] == str(field)
    assert dialog.calls[0]["title"] == "Select a folder for theDAW"
    items = known_paths.recent(kind="folder")
    assert [(i["path"], i["source"], i["servable"]) for i in items] == [
        (str(chosen), "pick", False)
    ]


# ---------------------------------------------------------------------------
# pick-save
# ---------------------------------------------------------------------------


def _upload(client: TestClient, path: Path, data: bytes) -> Any:
    return client.post(
        "/api/places/save",
        data={"path": str(path), "kind": "midi"},
        files={"file": (path.name, data, "audio/midi")},
    )


def test_a_save_dialog_grants_one_write_and_the_next_save_opens_in_that_folder(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    exports = tmp_path / "Exports"
    exports.mkdir()
    target = exports / "riff.mid"
    dialog = _dialog(monkeypatch, "pick_save_file", str(target), None)

    picked = client.post(
        "/api/storage/pick-save",
        json={
            "kind": "midi",
            "initial_name": "riff.mid",
            "default_ext": ".mid",
            "filter": "MID file (*.mid)|*.mid",
            "title": "Save MIDI",
        },
    )
    assert picked.json() == {"cancelled": False, "path": str(target)}
    call = dialog.calls[0]
    assert (call["initial_name"], call["default_ext"], call["filter_spec"]) == (
        "riff.mid",
        ".mid",
        "MID file (*.mid)|*.mid",
    )
    assert call["title"] == "Save MIDI"
    assert not target.exists()
    assert known_paths.last_folder("midi") == str(exports)

    assert _upload(client, target, b"MThd").status_code == 200
    assert target.read_bytes() == b"MThd"
    # The grant is spent by the first write.
    assert _upload(client, target, b"MThd again").status_code == 403
    assert target.read_bytes() == b"MThd"

    client.post("/api/storage/pick-save", json={"kind": "midi"})
    assert dialog.calls[1]["initial_dir"] == str(exports)


def test_a_cancelled_save_dialog_grants_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _dialog(monkeypatch, "pick_save_file", None)
    target = tmp_path / "Exports" / "riff.mid"

    assert client.post("/api/storage/pick-save", json={"kind": "midi"}).json() == {
        "cancelled": True,
        "path": None,
    }
    assert _upload(client, target, b"MThd").status_code == 403
    assert not target.exists()
    assert known_paths.last_folder("midi") is None


def test_a_save_without_a_kind_remembers_the_folder_under_its_extension(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    exports = tmp_path / "Exports"
    exports.mkdir()
    not_yet = tmp_path / "theDAW Projects"
    dialog = _dialog(monkeypatch, "pick_save_file", str(exports / "mix.wav"))

    client.post("/api/storage/pick-save", json={"initial_dir": str(not_yet)})
    # With no kind to fall back on, a folder that does not exist yet is passed
    # through for the dialog to handle.
    assert dialog.calls[0]["initial_dir"] == str(not_yet)
    assert known_paths.last_folder("audio") == str(exports)
    assert known_paths.consume_save_grant(exports / "mix.wav") is True


# ---------------------------------------------------------------------------
# Who may open a dialog
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "route",
    [
        "/api/storage/pick-file",
        "/api/storage/pick-folder",
        "/api/storage/pick-save",
        "/api/storage/open",
    ],
)
@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"origin": "https://evil.example"},
        {"referer": "https://evil.example/page"},
    ],
)
def test_a_page_on_another_site_cannot_open_a_dialog(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    route: str,
    headers: dict[str, str],
) -> None:
    somewhere = str(_touch(tmp_path / "a.wav"))
    dialogs = [
        _dialog(monkeypatch, name, somewhere)
        for name in ("pick_open_file", "pick_folder", "pick_save_file")
    ]

    resp = client.post(route, json={"path": somewhere}, headers=headers)
    assert resp.status_code == 403
    assert all(not d.calls for d in dialogs)
    assert known_paths.recent() == []
    assert known_paths.consume_save_grant(somewhere) is False


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"origin": "http://localhost:5173"},
        {"origin": "app://."},
        {"sec-fetch-site": "same-origin"},
    ],
)
def test_the_apps_own_ui_opens_the_file_picker(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    headers: dict[str, str],
) -> None:
    take = _touch(tmp_path / "take.wav")
    _dialog(monkeypatch, "pick_open_file", str(take))

    resp = client.post("/api/storage/pick-file", json={}, headers=headers)
    assert resp.json() == {"path": str(take), "cancelled": False}
