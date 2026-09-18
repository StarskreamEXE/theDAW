"""``POST /api/vst/process-file`` rendered through our own native host.

The route grew one optional form field, ``state_host``. Absent or
``pedalboard`` it runs today's pedalboard code path; ``thedaw`` sends the
upload through ``thedaw-vst-host --render``. These tests drive the second
branch against ``tests/fake_vst_host.py`` (which copies ``--in`` to ``--out``
and honours the ``FAKE_VST_HOST_*`` env overrides), so no native binary and no
real plugin is needed.

The rule the tests exist to protect: the ``thedaw`` branch NEVER falls back to
pedalboard. A missing host is 503, a non-zero exit is 502 — never quietly
different audio.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst import live_host as lh  # noqa: E402
from backend.modules.vst import router as vst_router  # noqa: E402

FAKE_HOST = Path(__file__).resolve().parent / "fake_vst_host.py"


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    return TestClient(app)


@pytest.fixture
def plugin_file(tmp_path: Path) -> Path:
    path = tmp_path / "Vinyl.vst3"
    path.write_bytes(b"only the path is validated by the route")
    return path


@pytest.fixture
def wav_bytes() -> bytes:
    signal = np.linspace(-0.5, 0.5, 480, dtype="float32").reshape(-1, 2)
    buf = io.BytesIO()
    sf.write(buf, signal, 48000, format="WAV", subtype="FLOAT")
    return buf.getvalue()


@pytest.fixture
def render_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep every temp render out of the real app data directory."""
    root = tmp_path / "vst_render"
    monkeypatch.setattr(vst_router, "_RENDER_DIR", root)
    return root


@pytest.fixture
def fake_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))


@pytest.fixture
def no_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No host anywhere: env unset AND the built path pointed at an empty dir."""
    monkeypatch.delenv(lh.HOST_ENV_VAR, raising=False)
    empty = tmp_path / "empty-root"
    empty.mkdir()
    monkeypatch.setattr(lh.paths, "PROJECT_ROOT", empty)


@pytest.fixture
def pedalboard_spy(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Records every pedalboard call so 'no silent fallback' is provable."""
    calls: list[dict] = []

    def fake_process(plugin_path, signal, sr, param_map, raw_state, warnings):
        calls.append({"plugin_path": plugin_path, "raw_state": raw_state})
        return signal * 0.0 + 0.25

    monkeypatch.setattr(vst_router, "process_with_plugin", fake_process)
    return calls


def _post(client, plugin_file, wav_bytes, **form):
    return client.post(
        "/api/vst/process-file",
        files={"audio": ("in.wav", wav_bytes, "audio/wav")},
        data={"plugin_path": str(plugin_file), **form},
    )


# ---------------------------------------------------------------------------
# The default path must stay exactly what it was
# ---------------------------------------------------------------------------


def test_absent_state_host_still_runs_pedalboard(
    client, plugin_file, wav_bytes, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes)

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert len(pedalboard_spy) == 1
    audio, _sr = sf.read(io.BytesIO(resp.content), dtype="float32", always_2d=True)
    assert np.allclose(audio, 0.25)


def test_pedalboard_state_host_runs_pedalboard(
    client, plugin_file, wav_bytes, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes, state_host="pedalboard")

    assert resp.status_code == 200
    assert len(pedalboard_spy) == 1


def test_an_unknown_state_host_is_rejected(
    client, plugin_file, wav_bytes, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes, state_host="reaper")

    assert resp.status_code == 400
    assert "state_host" in resp.json()["detail"]
    assert pedalboard_spy == []


# ---------------------------------------------------------------------------
# thedaw: render through our host
# ---------------------------------------------------------------------------


def test_thedaw_returns_what_the_host_rendered(
    client, plugin_file, wav_bytes, fake_host, render_root, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "audio/wav"
    # The fake host copies --in to --out, so the body proves the bytes went
    # through the host and came back, not through pedalboard.
    assert resp.content == wav_bytes
    assert pedalboard_spy == []


def test_thedaw_hands_the_host_the_decoded_raw_state(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch
):
    monkeypatch.setenv("FAKE_VST_HOST_RENDER_ECHO", "1")
    blob = b"\x00\x01\x02state bytes\xff"

    resp = _post(
        client,
        plugin_file,
        wav_bytes,
        state_host="thedaw",
        raw_state=base64.b64encode(blob).decode("ascii"),
        plugin_name="Vinyl",
    )

    assert resp.status_code == 200, resp.text
    warnings = json.loads(resp.headers["X-Vst-Warnings"])
    assert f"echo: state-bytes={len(blob)}" in warnings
    assert "echo: plugin-name=Vinyl" in warnings


def test_thedaw_rejects_raw_state_that_is_not_base64(
    client, plugin_file, wav_bytes, fake_host, render_root, pedalboard_spy
):
    resp = _post(
        client, plugin_file, wav_bytes, state_host="thedaw", raw_state="not base64!!"
    )

    assert resp.status_code == 400
    assert "raw_state" in resp.json()["detail"]
    assert pedalboard_spy == []


def test_thedaw_forwards_the_hosts_warnings(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch
):
    monkeypatch.setenv(
        "FAKE_VST_HOST_RENDER_WARNINGS",
        json.dumps(["the plugin changed its latency during the render"]),
    )

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 200, resp.text
    warnings = json.loads(resp.headers["X-Vst-Warnings"])
    assert "the plugin changed its latency during the render" in warnings
    assert "X-Vst-Warnings" in resp.headers["Access-Control-Expose-Headers"]


def test_thedaw_cleans_up_its_temp_files(
    client, plugin_file, wav_bytes, fake_host, render_root
):
    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 200, resp.text
    assert list(render_root.glob("*")) == []


# ---------------------------------------------------------------------------
# Failures: loud, never a fallback
# ---------------------------------------------------------------------------


def test_thedaw_without_a_host_binary_is_503_with_the_reason(
    client, plugin_file, wav_bytes, no_host, render_root, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 503
    assert "thedaw-vst-host" in resp.json()["detail"]
    assert pedalboard_spy == []


def test_thedaw_non_zero_exit_is_502_with_the_meaning_and_the_log_tail(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch, pedalboard_spy
):
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_CODE", "7")
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_MESSAGE", "fake-host: RIFF header is junk")

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert "exit code 7" in detail
    # The documented meaning of 7, plus what the host actually said.
    assert "could not be read" in detail
    assert "RIFF header is junk" in detail
    assert pedalboard_spy == []


def test_thedaw_missing_plugin_is_still_a_404_before_any_spawn(
    client, tmp_path, wav_bytes, fake_host, render_root, pedalboard_spy
):
    resp = _post(client, tmp_path / "Nope.vst3", wav_bytes, state_host="thedaw")

    assert resp.status_code == 404
    assert pedalboard_spy == []
