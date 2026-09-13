"""/api/places over HTTP: what a request can make the server remember, show,
serve and write.

The server binds 0.0.0.0 and CORS is open, so each refusal here is paired with
the call from theDAW's own UI that must keep working.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.lib import known_paths
from backend.lib import reveal as reveal_lib
from backend.server import app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    return TestClient(app)


def _touch(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


class _Popen:
    """Stands in for subprocess.Popen so no file manager opens during a test."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], *_a: Any, **_k: Any) -> SimpleNamespace:
        self.calls.append(list(args))
        return SimpleNamespace()


def test_the_module_is_mounted() -> None:
    assert "places" in {m["name"] for m in app.state.loaded_modules}


# ---------------------------------------------------------------------------
# record, folder, recent
# ---------------------------------------------------------------------------


def test_a_recorded_download_sets_the_folder_and_joins_recent(
    client: TestClient, tmp_path: Path
) -> None:
    take = _touch(tmp_path / "Downloads" / "take.wav")
    resp = client.post("/api/places/record", json={"path": str(take)})
    assert resp.json() == {"recorded": True, "kind": "audio"}

    folder = client.get("/api/places/folder", params={"kind": "audio"}).json()
    assert folder == {"kind": "audio", "folder": str(take.parent)}

    items = client.get("/api/places/recent", params={"kind": "audio"}).json()["items"]
    assert [(i["name"], i["source"], i["servable"]) for i in items] == [
        ("take.wav", "client", False)
    ]
    assert set(items[0]) == {"path", "name", "kind", "source", "at", "servable"}


def test_recording_a_missing_path_records_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    resp = client.post(
        "/api/places/record",
        json={"path": str(tmp_path / "nope.wav"), "kind": "audio"},
    )
    assert resp.json() == {"recorded": False, "kind": None}
    assert client.get("/api/places/recent").json() == {"items": []}


def test_a_folder_request_without_a_kind_is_null(client: TestClient) -> None:
    assert client.get("/api/places/folder").json() == {"kind": "", "folder": None}


def test_recent_filters_by_extension(client: TestClient, tmp_path: Path) -> None:
    for name in ("a.mid", "b.midi", "c.wav"):
        known_paths.record(_touch(tmp_path / name), source="pick")
    items = client.get(
        "/api/places/recent", params={"exts": ".mid,.midi", "limit": 20}
    ).json()["items"]
    assert sorted(i["name"] for i in items) == ["a.mid", "b.midi"]
    assert all(i["servable"] for i in items)


# ---------------------------------------------------------------------------
# file
# ---------------------------------------------------------------------------


def test_a_file_a_request_named_is_not_served(
    client: TestClient, tmp_path: Path
) -> None:
    secret = _touch(tmp_path / "private" / "keys.json", b'{"key": "secret"}')
    client.post("/api/places/record", json={"path": str(secret), "kind": "json"})
    resp = client.get("/api/places/file", params={"path": str(secret)})
    assert resp.status_code == 403
    assert b"secret" not in resp.content


def test_a_file_the_backend_recorded_is_served(
    client: TestClient, tmp_path: Path
) -> None:
    saved = _touch(tmp_path / "exports" / "mix.wav", b"RIFF-bytes")
    known_paths.record(saved, source="save")
    resp = client.get("/api/places/file", params={"path": str(saved)})
    assert resp.status_code == 200
    assert resp.content == b"RIFF-bytes"
    assert 'filename="mix.wav"' in resp.headers["content-disposition"]


def test_file_refusals_all_look_the_same(client: TestClient, tmp_path: Path) -> None:
    unknown = _touch(tmp_path / "unknown.wav")
    gone = _touch(tmp_path / "gone.wav")
    known_paths.record(gone, source="save")
    gone.unlink()

    answers = [
        client.get("/api/places/file", params={"path": str(p)})
        for p in (unknown, gone, tmp_path / "never.wav")
    ]
    assert {r.status_code for r in answers} == {403}
    assert answers[0].json() == answers[1].json() == answers[2].json()
    assert str(tmp_path) not in answers[0].text


# ---------------------------------------------------------------------------
# save
# ---------------------------------------------------------------------------


def _save(client: TestClient, path: Path, data: bytes, kind: str | None = None):
    form = {"path": str(path)}
    if kind is not None:
        form["kind"] = kind
    return client.post(
        "/api/places/save",
        data=form,
        files={"file": (path.name, data, "application/octet-stream")},
    )


def test_save_without_a_grant_writes_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    target = tmp_path / "out" / "song.mid"
    resp = _save(client, target, b"MThd")
    assert resp.status_code == 403
    assert not target.exists()
    assert not target.parent.exists()


def test_a_granted_save_writes_once_and_is_remembered(
    client: TestClient, tmp_path: Path
) -> None:
    target = tmp_path / "new folder" / "song.mid"
    known_paths.grant_save(target)
    resp = _save(client, target, b"MThd", kind="midi")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"path": str(target), "kind": "midi"}
    assert target.read_bytes() == b"MThd"
    # The temp file was renamed into place, so nothing else is left beside it.
    assert [p.name for p in target.parent.iterdir()] == ["song.mid"]

    item = client.get("/api/places/recent", params={"kind": "midi"}).json()["items"][0]
    assert (item["path"], item["source"], item["servable"]) == (
        str(target),
        "save",
        True,
    )
    served = client.get("/api/places/file", params={"path": str(target)})
    assert served.content == b"MThd"

    again = _save(client, target, b"overwritten")
    assert again.status_code == 403
    assert target.read_bytes() == b"MThd"


def test_a_granted_save_replaces_the_file_the_user_chose(
    client: TestClient, tmp_path: Path
) -> None:
    target = _touch(tmp_path / "chart.json", b"old")
    known_paths.grant_save(target)
    resp = _save(client, target, b'{"new": true}')
    assert resp.status_code == 200, resp.text
    assert resp.json()["kind"] == "json"
    assert target.read_bytes() == b'{"new": true}'


# ---------------------------------------------------------------------------
# reveal
# ---------------------------------------------------------------------------


def test_revealing_a_missing_path_is_404(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _Popen()
    monkeypatch.setattr(reveal_lib, "subprocess", SimpleNamespace(Popen=fake))
    resp = client.post("/api/places/reveal", json={"path": str(tmp_path / "no.wav")})
    assert resp.status_code == 404
    assert fake.calls == []


@pytest.mark.parametrize("platform", ["win32", "darwin", "linux"])
def test_reveal_selects_the_file_on_each_platform(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    platform: str,
) -> None:
    take = _touch(tmp_path / "take.wav")
    fake = _Popen()
    monkeypatch.setattr(reveal_lib, "subprocess", SimpleNamespace(Popen=fake))
    monkeypatch.setattr(reveal_lib, "sys", SimpleNamespace(platform=platform))

    resp = client.post("/api/places/reveal", json={"path": str(take)})
    assert resp.json() == {"status": "ok", "path": str(take)}
    expected = {
        "win32": ["explorer", f"/select,{take}"],
        "darwin": ["open", "-R", str(take)],
        "linux": ["xdg-open", str(take.parent)],
    }[platform]
    assert fake.calls == [expected]


def test_a_file_manager_that_will_not_start_is_500(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_a: Any, **_k: Any) -> None:
        raise OSError("no file manager here")

    monkeypatch.setattr(reveal_lib, "subprocess", SimpleNamespace(Popen=refuse))
    take = _touch(tmp_path / "take.wav")
    resp = client.post("/api/places/reveal", json={"path": str(take)})
    assert resp.status_code == 500


# ---------------------------------------------------------------------------
# projects-dir
# ---------------------------------------------------------------------------


def test_projects_dir_round_trip(client: TestClient, tmp_path: Path) -> None:
    default = tmp_path / "home" / "Documents" / "theDAW Projects"
    assert client.get("/api/places/projects-dir").json() == {"path": str(default)}

    chosen = tmp_path / "Songs"
    put = client.put("/api/places/projects-dir", json={"path": str(chosen)})
    assert put.json() == {"path": str(chosen)}
    assert client.get("/api/places/projects-dir").json() == {"path": str(chosen)}

    bad = client.put("/api/places/projects-dir", json={"path": "relative/dir"})
    assert bad.status_code == 400
    assert client.get("/api/places/projects-dir").json() == {"path": str(chosen)}


# ---------------------------------------------------------------------------
# who may call
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"origin": "https://evil.example"},
        {"referer": "https://evil.example/page"},
        {"origin": "null"},
    ],
)
def test_a_page_on_another_site_is_refused(
    client: TestClient, tmp_path: Path, headers: dict[str, str]
) -> None:
    saved = _touch(tmp_path / "exports" / "mix.wav", b"RIFF-bytes")
    known_paths.record(saved, source="save")

    listing = client.get("/api/places/recent", headers=headers)
    assert listing.status_code == 403
    assert str(saved) not in listing.text
    served = client.get(
        "/api/places/file", params={"path": str(saved)}, headers=headers
    )
    assert served.status_code == 403
    assert b"RIFF-bytes" not in served.content
    recorded = client.post(
        "/api/places/record", json={"path": str(saved)}, headers=headers
    )
    assert recorded.status_code == 403


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"origin": "http://localhost:5173"},
        {"origin": "app://."},
        {"origin": "http://192.168.1.50:8600"},
        {"sec-fetch-site": "same-origin"},
    ],
)
def test_theDAW_own_pages_and_the_desktop_shell_pass(
    client: TestClient, tmp_path: Path, headers: dict[str, str]
) -> None:
    saved = _touch(tmp_path / "exports" / "mix.wav", b"RIFF-bytes")
    known_paths.record(saved, source="save")
    resp = client.get("/api/places/file", params={"path": str(saved)}, headers=headers)
    assert resp.status_code == 200
    assert resp.content == b"RIFF-bytes"
