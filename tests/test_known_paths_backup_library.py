"""Backup and library folder flows remember their paths.

The backup folder picker opens where the last backup went, a finished export is
remembered as a servable backup zip, the projects root is the user's projects
folder, and the library's music folder picker opens where the last folder added
was. folder_dialog's functions are replaced with recorders, so no dialog opens.
"""

from __future__ import annotations

import inspect
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core import folder_dialog
from backend.lib import known_paths
from backend.modules.backup import router as backup_router
from backend.modules.backup import service as backup_service
from backend.modules.library import router as library_router


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
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "generations"))
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    return home


@pytest.fixture
def projects(home: Path, tmp_path: Path) -> Path:
    folder = tmp_path / "My Projects"
    known_paths.set_projects_dir(str(folder))
    return folder


@pytest.fixture
def backup(home: Path) -> TestClient:
    app = FastAPI()
    app.include_router(backup_router.router, prefix="/api/backup")
    return TestClient(app)


@pytest.fixture
def library(home: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(library_router, "_store", None)
    app = FastAPI()
    app.include_router(library_router.router, prefix="/api/library")
    return TestClient(app)


def _wait(client: TestClient, url: str, job: str) -> dict[str, Any]:
    deadline = time.monotonic() + 30.0
    while True:
        status = client.get(url, params={"job": job}).json()
        if status["state"] != "running" or time.monotonic() > deadline:
            return status
        time.sleep(0.05)


def _export(client: TestClient, dest_dir: str) -> dict[str, Any]:
    started = client.post(
        "/api/backup/export", json={"dest_dir": dest_dir, "include": ["projects"]}
    )
    assert started.status_code == 200, started.text
    return _wait(client, "/api/backup/export/status", started.json()["job"])


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------


def test_the_backup_folder_picker_opens_in_documents_then_in_the_last_choice(
    backup: TestClient, monkeypatch: pytest.MonkeyPatch, home: Path, tmp_path: Path
) -> None:
    documents = home / "Documents"
    documents.mkdir()
    dest = tmp_path / "Backups"
    dest.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", str(dest), None)

    assert backup.get("/api/backup/pick-folder").json() == {"path": str(dest)}
    assert dialog.calls[0]["initial"] == str(documents)
    assert [
        (i["path"], i["source"]) for i in known_paths.recent(kind="backup-dest")
    ] == [(str(dest), "pick")]

    assert backup.get("/api/backup/pick-folder").json() == {"path": None}
    assert dialog.calls[1]["initial"] == str(dest)
    # A cancel keeps the earlier choice.
    assert known_paths.last_folder("backup-dest") == str(dest)


def test_a_finished_export_is_remembered_as_a_servable_backup_zip(
    backup: TestClient, projects: Path, tmp_path: Path
) -> None:
    _touch(projects / "song.tasmo", b"{}")
    dest = tmp_path / "Backups"

    status = _export(backup, str(dest))
    assert status["state"] == "done", status
    zip_path = status["zip_path"]
    assert Path(zip_path).parent == dest

    items = known_paths.recent(kind="backup-zip")
    assert [(i["path"], i["source"], i["servable"]) for i in items] == [
        (zip_path, "backup", True)
    ]
    assert known_paths.find_servable(zip_path) == zip_path
    assert known_paths.last_folder("backup-dest") == str(dest)
    assert known_paths.last_folder("backup-zip") == str(dest)


def test_an_export_with_no_folder_goes_where_the_picker_last_pointed(
    backup: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    projects: Path,
    tmp_path: Path,
) -> None:
    _touch(projects / "song.tasmo", b"{}")
    dest = tmp_path / "Picked Backups"
    dest.mkdir()
    _dialog(monkeypatch, "pick_folder", str(dest))

    backup.get("/api/backup/pick-folder")
    status = _export(backup, "")
    assert status["state"] == "done", status
    assert Path(status["zip_path"]).parent == dest


def test_the_projects_root_is_the_projects_folder_the_user_chose(
    backup: TestClient, projects: Path
) -> None:
    _touch(projects / "song.tasmo", b"{}")

    roots = {r["id"]: r for r in backup.get("/api/backup/manifest").json()["roots"]}
    assert roots["projects"]["path"] == str(projects)
    assert (roots["projects"]["exists"], roots["projects"]["files"]) == (True, 1)


def test_a_restored_zip_is_offered_again_and_a_typed_one_stays_unservable(
    backup: TestClient, projects: Path, tmp_path: Path
) -> None:
    _touch(projects / "song.tasmo", b"{}")
    exported = _export(backup, str(tmp_path / "Backups"))["zip_path"]

    restored = backup.post(
        "/api/backup/import", json={"zip_path": exported, "mode": "merge"}
    )
    assert restored.status_code == 200, restored.text
    assert _wait(backup, "/api/backup/import/status", restored.json()["job"])[
        "state"
    ] == ("done")
    # Restoring the app's own export keeps it servable.
    assert [
        (i["path"], i["source"], i["servable"])
        for i in known_paths.recent(kind="backup-zip")
    ] == [(exported, "backup", True)]

    copied = tmp_path / "Elsewhere" / "from-a-friend.zip"
    copied.parent.mkdir()
    shutil.copyfile(exported, copied)
    typed = backup.post(
        "/api/backup/import", json={"zip_path": str(copied), "mode": "merge"}
    )
    assert typed.status_code == 200, typed.text
    _wait(backup, "/api/backup/import/status", typed.json()["job"])
    newest = known_paths.recent(kind="backup-zip")[0]
    assert (newest["path"], newest["source"], newest["servable"]) == (
        str(copied),
        "client",
        False,
    )
    assert known_paths.last_folder("backup-zip") == str(copied.parent)


def test_a_restore_keeps_this_machines_projects_folder_when_the_restored_one_is_missing(
    backup: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The settings root carries known_paths.json. A replace restore from a
    machine whose projects folder is not here must leave the projects folder the
    archive's .tasmo files were restored into."""
    data = tmp_path / "data"
    monkeypatch.setattr(known_paths, "_STORE_PATH", data / "known_paths.json")
    other = tmp_path / "other-machine" / "theDAW Projects"
    _touch(other / "song.tasmo", b"{}")
    known_paths.set_projects_dir(str(other))
    started = backup.post(
        "/api/backup/export",
        json={
            "dest_dir": str(tmp_path / "Backups"),
            "include": ["settings", "projects"],
        },
    )
    exported = _wait(backup, "/api/backup/export/status", started.json()["job"])
    assert exported["state"] == "done", exported
    shutil.rmtree(other.parent)

    here = tmp_path / "This PC Projects"
    here.mkdir()
    known_paths.set_projects_dir(str(here))
    restored = backup.post(
        "/api/backup/import", json={"zip_path": exported["zip_path"], "mode": "replace"}
    )
    status = _wait(backup, "/api/backup/import/status", restored.json()["job"])
    assert status["state"] == "done", status
    assert known_paths.projects_dir() == here
    assert (here / "song.tasmo").read_bytes() == b"{}"


def test_a_zip_that_is_not_a_backup_is_refused_and_not_remembered(
    backup: TestClient, home: Path, tmp_path: Path
) -> None:
    stray = tmp_path / "photos.zip"
    with zipfile.ZipFile(stray, "w") as zf:
        zf.writestr("a.txt", "hello")

    resp = backup.post("/api/backup/import", json={"zip_path": str(stray)})
    assert resp.status_code == 400
    assert backup_service.MANIFEST_NAME in resp.json()["detail"]
    assert known_paths.recent() == []


# ---------------------------------------------------------------------------
# Library folder import
# ---------------------------------------------------------------------------


def test_the_music_folder_picker_opens_in_music_then_in_the_last_folder_added(
    library: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    home: Path,
    tmp_path: Path,
) -> None:
    music = home / "Music"
    music.mkdir()
    album = tmp_path / "Album"
    _touch(album / "notes.txt")
    dialog = _dialog(monkeypatch, "pick_folder", str(album), None)

    body = library.post("/api/library/import-folder", json={}).json()
    assert (body["cancelled"], body["folder"]) == (False, str(album))
    assert dialog.calls[0]["initial"] == str(music)
    assert [
        (i["path"], i["kind"], i["source"], i["servable"])
        for i in known_paths.recent(kind="library-folder")
    ] == [(str(album), "library-folder", "library-folder", False)]

    cancelled = library.post("/api/library/import-folder", json={}).json()
    assert cancelled == {"cancelled": True, "folder": None, "entries": []}
    assert dialog.calls[1]["initial"] == str(album)


def test_a_typed_music_folder_is_remembered_without_a_dialog(
    library: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    album = tmp_path / "Typed Album"
    album.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", None)

    body = library.post("/api/library/import-folder", json={"path": str(album)})
    assert body.json()["folder"] == str(album)
    assert dialog.calls == []
    assert known_paths.last_folder("library-folder") == str(album)


def test_a_path_that_is_not_a_folder_is_refused_and_not_remembered(
    library: TestClient, tmp_path: Path
) -> None:
    take = _touch(tmp_path / "take.wav")

    resp = library.post("/api/library/import-folder", json={"path": str(take)})
    assert resp.status_code == 400
    assert known_paths.recent() == []


# ---------------------------------------------------------------------------
# Who may open a dialog
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"origin": "https://evil.example"},
    ],
)
def test_a_page_on_another_site_cannot_open_the_backup_or_music_pickers(
    backup: TestClient,
    library: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    headers: dict[str, str],
) -> None:
    folder = tmp_path / "Somewhere"
    folder.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", str(folder), str(folder))

    assert backup.get("/api/backup/pick-folder", headers=headers).status_code == 403
    resp = library.post("/api/library/import-folder", json={}, headers=headers)
    assert resp.status_code == 403
    assert dialog.calls == []
    assert known_paths.recent() == []
