"""The media-root index: the library resolves an entry's file from the user's
own folders before it ever asks a CDN.

Every test here builds its own tree under ``tmp_path`` and points the roots at
it through the env var or the settings store. Nothing reads a real library.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import media_roots
from backend.modules.library import router as library_router_module
from backend.modules.library.store import LibraryStore
from tests.test_library_store import _seed_generate_entry

UUID_A = "c27de18c-1b0e-4a2f-8b71-9d0c5f2a1e33"
UUID_B = "aa11bb22-3c4d-4e5f-8aa9-0b1c2d3e4f50"


@pytest.fixture(autouse=True)
def _clean_index(monkeypatch):
    """Every test starts with no index, no roots and no scan in flight."""
    monkeypatch.delenv(media_roots.ENV_VAR, raising=False)
    media_roots.reset()
    yield
    media_roots.reset()


def _write(path: Path, data: bytes = b"RIFF\x00\x00\x00\x00WAVE") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _roots_env(monkeypatch, *roots: Path) -> None:
    import os

    monkeypatch.setenv(media_roots.ENV_VAR, os.pathsep.join(str(r) for r in roots))


# ---- the index -------------------------------------------------------------


def test_index_maps_id8_and_full_id_across_nested_folders(tmp_path, monkeypatch):
    root = tmp_path / "media"
    id8 = _write(root / "artists" / "a" / f"high voltage [{UUID_A[:8]}].mp3")
    full = _write(root / "deep" / "er" / f"take one {UUID_B}.flac")
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A) == id8
    assert media_roots.lookup(UUID_B) == full
    # A full-id file answers its own first eight hex too.
    assert media_roots.lookup(UUID_B[:8]) == full
    assert media_roots.status()["files"] == 2


def test_non_media_files_are_ignored(tmp_path, monkeypatch):
    root = tmp_path / "media"
    _write(root / f"notes [{UUID_A[:8]}].txt")
    _write(root / f"cover [{UUID_B[:8]}].part")
    keep = _write(root / f"song [{UUID_B[:8]}].mp3")
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A) is None
    assert media_roots.lookup(UUID_B) == keep
    assert media_roots.status()["files"] == 1


def test_id8_ambiguity_prefers_the_full_id_file(tmp_path, monkeypatch):
    root = tmp_path / "media"
    tagged = _write(root / "one" / f"tagged [{UUID_A[:8]}].mp3")
    full = _write(root / "two" / f"named {UUID_A}.mp3")
    # The id8-only file is the NEWER one, so only the full-id rule can win.
    import os

    os.utime(tagged, (time.time() + 60, time.time() + 60))
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A) == full
    assert media_roots.status()["ambiguous"] == 1


def test_id8_ambiguity_without_a_full_id_takes_the_newest(tmp_path, monkeypatch):
    root = tmp_path / "media"
    old = _write(root / "old" / f"take [{UUID_A[:8]}].mp3")
    new = _write(root / "new" / f"take [{UUID_A[:8]}].m4a")
    import os

    os.utime(old, (time.time() - 600, time.time() - 600))
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A) == new


def test_lookup_filters_by_extension(tmp_path, monkeypatch):
    root = tmp_path / "media"
    clip = _write(root / f"clip [{UUID_A[:8]}].mp4")
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A, extensions={".mp3", ".wav"}) is None
    assert media_roots.lookup(UUID_A, extensions={".mp4"}) == clip


# ---- configuration ---------------------------------------------------------


def test_env_wins_over_settings(tmp_path, monkeypatch):
    from backend.modules.settings import router as settings_router
    from backend.modules.settings.store import SettingsStore

    store = SettingsStore(tmp_path / "settings.json")
    store.patch({"library": {"media_roots": [str(tmp_path / "from-settings")]}})
    monkeypatch.setattr(settings_router, "_store", store)

    assert media_roots.configured_roots() == [str(tmp_path / "from-settings")]

    _roots_env(monkeypatch, tmp_path / "from-env")
    assert media_roots.configured_roots() == [str(tmp_path / "from-env")]


def test_settings_media_roots_survive_a_round_trip(tmp_path):
    from backend.modules.settings.store import SettingsStore

    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    store.patch({"library": {"media_roots": ["  D:\\a  ", "D:\\a", "", 7]}})

    reloaded = SettingsStore(path)
    assert reloaded.get_value("library", "media_roots") == ["D:\\a"]


# ---- the store falls through ----------------------------------------------


def test_get_audio_path_falls_through_to_a_media_root(tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_A
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "no bytes here", "cdn_audio_url": "https://cdn/x.mp3"}),
        encoding="utf-8",
    )
    root = tmp_path / "media"
    target = _write(root / "nested" / f"no bytes here [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    store = LibraryStore(lib)
    resolved = store.get_audio_path(UUID_A)

    assert resolved == target
    # Reference in place: nothing was copied into the entry, and the metadata
    # is byte-for-byte what it was.
    assert sorted(p.name for p in entry_dir.iterdir()) == ["metadata.json"]
    assert json.loads((entry_dir / "metadata.json").read_text(encoding="utf-8")) == {
        "title": "no bytes here",
        "cdn_audio_url": "https://cdn/x.mp3",
    }


def test_get_audio_path_prefers_the_entry_dir(tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = _seed_generate_entry(lib, "job_local", 0)
    root = tmp_path / "media"
    _write(root / "job_local_00 [deadbeef].mp3")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    store = LibraryStore(lib)
    assert store.get_audio_path("job_local_00") == entry_dir / "output.wav"


def test_get_audio_path_ignores_the_index_for_an_unknown_id(tmp_path, monkeypatch):
    root = tmp_path / "media"
    _write(root / f"orphan [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    store = LibraryStore(tmp_path / "lib")
    assert store.get_audio_path(UUID_A) is None


def test_get_media_path_falls_through_for_a_video_entry(tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_B
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"kind": "video", "title": "clip"}), encoding="utf-8"
    )
    root = tmp_path / "media"
    target = _write(root / f"clip [{UUID_B[:8]}].mp4")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    store = LibraryStore(lib)
    assert store.get_media_path(UUID_B) == target


# ---- the index never blocks a request --------------------------------------


def test_lookup_does_not_block_while_a_scan_runs(tmp_path, monkeypatch):
    root = tmp_path / "media"
    _write(root / f"song [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)

    release = threading.Event()
    started = threading.Event()

    def _never_finishes(roots):
        started.set()
        release.wait(30)
        return media_roots.MediaIndex(roots=tuple(roots), signature=())

    monkeypatch.setattr(media_roots, "_build_index", _never_finishes)
    media_roots.start_scan()
    assert started.wait(5)

    began = time.monotonic()
    assert media_roots.lookup(UUID_A) is None
    assert time.monotonic() - began < 1.0
    assert media_roots.status()["scanning"] is True
    release.set()


# ---- the routes ------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "lib"))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def test_media_roots_status_and_rescan_routes(client, tmp_path, monkeypatch):
    root = tmp_path / "media"
    _write(root / f"song [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)

    before = client.get("/api/library/media-roots")
    assert before.status_code == 200
    assert before.json()["roots"] == [str(root)]
    assert before.json()["ready"] is False

    rescan = client.post("/api/library/media-roots/rescan")
    assert rescan.status_code == 200
    deadline = time.monotonic() + 10
    while not media_roots.status()["ready"] and time.monotonic() < deadline:
        time.sleep(0.02)

    after = client.get("/api/library/media-roots")
    assert after.json()["ready"] is True
    assert after.json()["files"] == 1
    assert after.json()["scanning"] is False
    assert after.json()["age_seconds"] is not None


def test_stream_audio_serves_the_media_root_file(client, tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_A
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "remote only"}), encoding="utf-8"
    )
    root = tmp_path / "media"
    _write(root / f"remote only [{UUID_A[:8]}].mp3", b"ID3fake-mp3-bytes")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    r = client.get(f"/api/library/audio/{UUID_A}")

    assert r.status_code == 200
    assert r.content == b"ID3fake-mp3-bytes"
    # The type comes from `mimetypes`, which reads the OS registry on Windows
    # and answers "audio/mp3" there and "audio/mpeg" on Linux. Both are mp3 to
    # a browser; what matters is that the out-of-tree file was typed at all.
    assert r.headers["content-type"] in {"audio/mpeg", "audio/mp3"}


# ---- the CDN is asked once -------------------------------------------------


class _Resp:
    status_code = 403

    def raise_for_status(self):
        import httpx

        raise httpx.HTTPStatusError("403 Forbidden", request=None, response=self)


def test_cdn_403_is_remembered_and_not_refetched(client, tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_B
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "gone", "cdn_audio_url": "https://cdn.example/x.mp3"}),
        encoding="utf-8",
    )
    calls: list[str] = []

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            calls.append(url)
            return _Resp()

    monkeypatch.setattr(library_router_module.httpx, "AsyncClient", _Client)

    first = client.get(f"/api/library/audio/{UUID_B}")
    assert first.status_code == 404
    assert "no local file in any media root" in first.json()["detail"]
    assert "not accessible" in first.json()["detail"]

    second = client.get(f"/api/library/audio/{UUID_B}")
    assert second.status_code == 404
    assert second.json()["detail"] == first.json()["detail"]
    assert calls == ["https://cdn.example/x.mp3"]
