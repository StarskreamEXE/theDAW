"""Policy checks for browser-supplied VST3 plugin paths.

``check_plugin_path`` is the one gate a live-VST route will call before a raw
path from the browser reaches the native host (wiring it in is a later
ticket). Every test here monkeypatches ``path_policy.allowed_roots`` to a
tmp directory, so nothing depends on what VST3 folders actually exist on the
machine running the suite.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.modules.vst import path_policy

UNC_PATHS = [
    "\\\\server\\share\\x.vst3",
    "//server/share/x.vst3",
    "\\\\?\\UNC\\server\\share\\x.vst3",
]


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An allowed VST3 root under tmp_path, with no plugin in it yet."""
    allowed = tmp_path / "VST3"
    allowed.mkdir()
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [allowed.resolve()])
    return allowed


def _bundle(root: Path, name: str = "Foo.vst3") -> Path:
    plugin = root / name
    plugin.mkdir()
    return plugin


def test_a_plugin_inside_the_root_is_allowed(root: Path) -> None:
    plugin = _bundle(root)
    assert path_policy.check_plugin_path(str(plugin)) == plugin.resolve()


def test_a_dotdot_escape_is_forbidden(root: Path) -> None:
    escape = str(root / ".." / "Escape.vst3")
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(escape)
    assert exc.value.status == 403


@pytest.mark.parametrize("raw", UNC_PATHS)
def test_unc_paths_are_rejected_without_touching_the_filesystem(
    root: Path, monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    def _boom(self: Path, strict: bool = False) -> Path:
        raise AssertionError("resolve() must not run for a network path")

    monkeypatch.setattr(Path, "resolve", _boom)
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(raw)
    assert exc.value.status == 400


def test_a_non_vst3_suffix_is_rejected(root: Path) -> None:
    other = str(root / "Foo.dll")
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(other)
    assert exc.value.status == 400


@pytest.mark.parametrize("raw", ["", "   "])
def test_empty_input_is_rejected(raw: str) -> None:
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(raw)
    assert exc.value.status == 400


@pytest.mark.skipif(os.name != "nt", reason="case-insensitive paths are Windows")
def test_root_match_is_case_insensitive_on_windows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    allowed = tmp_path / "vst3"
    allowed.mkdir()
    plugin = _bundle(allowed)
    # The configured root is spelled in different case than the plugin's own
    # resolved path; only the comparison is case-insensitive, not the value
    # check_plugin_path hands back.
    monkeypatch.setattr(
        path_policy, "allowed_roots", lambda: [Path(str(allowed).upper())]
    )
    assert path_policy.check_plugin_path(str(plugin)) == plugin.resolve()


def test_the_403_message_names_a_count_never_the_root_or_the_path(root: Path) -> None:
    secret_input = str(root / ".." / "Escape.vst3")
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(secret_input)
    message = exc.value.message
    assert "1" in message
    assert str(root) not in message
    assert secret_input not in message
