"""RVE-5: the VST editor router endpoints must never leak the server's
absolute filesystem paths to the browser.

``/open-editor`` used to hand back the on-disk preset/log paths (which embed
the Windows profile name), and a dead sidecar's failure detail pasted the raw
log tail — home directory and all — into the client-visible error. These
tests fake ``subprocess.Popen`` so no sidecar, plugin, or window is ever
touched.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst import router as vst_router  # noqa: E402


class _FakeEditorProc:
    """Stand-in for the ``subprocess.Popen`` handle of a launched sidecar."""

    def __init__(self, *args, **kwargs) -> None:
        self.pid = 4242

    def poll(self) -> int | None:
        return None


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    return TestClient(app)


@pytest.fixture
def preset_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep every preset/log/pid file this test writes out of the real app
    data directory."""
    root = tmp_path / "vst_presets"
    monkeypatch.setattr(vst_router, "_PRESET_DIR", root)
    return root


@pytest.fixture
def fake_popen(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vst_router.subprocess, "Popen", _FakeEditorProc)


@pytest.fixture
def plugin_file(tmp_path: Path) -> Path:
    path = tmp_path / "Fake.vst3"
    path.write_bytes(b"only the path is validated by the route")
    return path


def test_open_editor_response_has_no_filesystem_paths(
    client: TestClient,
    preset_root: Path,
    fake_popen: None,
    plugin_file: Path,
    tmp_path: Path,
):
    resp = client.post("/api/vst/open-editor", json={"plugin_path": str(plugin_file)})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body.get("preset_key")
    for value in body.values():
        if isinstance(value, str):
            assert "/" not in value
            assert "\\" not in value
            assert str(tmp_path) not in value


def test_open_editor_still_writes_the_launching_marker_and_pid_file(
    client: TestClient, preset_root: Path, fake_popen: None, plugin_file: Path
):
    resp = client.post("/api/vst/open-editor", json={"plugin_path": str(plugin_file)})
    assert resp.status_code == 200, resp.text

    preset_out = vst_router._preset_path(str(plugin_file))
    marker = json.loads(preset_out.read_text(encoding="utf-8"))
    assert marker["status"] == "launching"

    pid_file = vst_router._pid_path(str(plugin_file))
    assert pid_file.read_text(encoding="utf-8").strip() == "4242"


def test_failure_detail_scrubs_the_home_directory(preset_root: Path, plugin_file: Path):
    preset_out = vst_router._preset_path(str(plugin_file))
    preset_out.parent.mkdir(parents=True, exist_ok=True)
    home = str(Path.home())
    log_path = preset_out.with_suffix(".log")
    log_path.write_text(
        f'Traceback (most recent call last):\n  File "{home}\\editor_sidecar.py"\n',
        encoding="utf-8",
    )

    detail = vst_router._editor_failure_detail(preset_out)

    assert "~" in detail
    assert home not in detail


def test_failure_detail_without_a_log_is_the_plain_message(
    preset_root: Path, plugin_file: Path
):
    preset_out = vst_router._preset_path(str(plugin_file))
    detail = vst_router._editor_failure_detail(preset_out)
    assert detail == "Editor process exited before the plugin state was captured."
