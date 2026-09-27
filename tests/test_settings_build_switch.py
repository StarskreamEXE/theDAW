"""The LAN HTTPS switch survives a run of an older build.

Schema 10 kept the switch at ``app.lan_https``, and a missing key means ON.
main 851f6a0's store keeps only the keys it knows inside a section it knows,
and its first load of a newer file rewrites it (the schema differs), so one
start of main dropped the key and a user's "off" came back on. The switch now
lives in a section of its own, ``lan.https``, which main keeps whole.

main's store runs from ``tests/fixtures/main_851f6a0/settings_store.py``, a
byte-identical copy of ``backend/modules/settings/store.py`` at 851f6a0, so
each sequence below goes through the older build's real load and save code.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

from backend.lib import lan_https
from backend.modules.settings.store import SCHEMA_VERSION, SettingsStore

MAIN_STORE = (
    Path(__file__).resolve().parent / "fixtures" / "main_851f6a0" / "settings_store.py"
)
LAN = ["192.168.1.34"]


def _main_store() -> ModuleType:
    """main 851f6a0's settings store, imported fresh."""
    spec = importlib.util.spec_from_file_location("main_851f6a0_settings", MAIN_STORE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _launcher_blocks(path: Path, monkeypatch: pytest.MonkeyPatch) -> bool:
    """Whether a launcher reading ``path`` would leave the listener off.

    The launcher reads the raw file (lan_https.read_settings), before the
    backend's store has loaded or migrated anything. The environment override
    is left out so only the stored value decides.
    """
    monkeypatch.setenv("theDAW_SETTINGS_PATH", str(path))
    return lan_https.blocking_reason(lan_https.read_settings(), {}, LAN) is not None


def _on_disk(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_an_off_switch_stays_off_after_main_loads_and_saves(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"

    # This build: the user switches the listener off.
    SettingsStore(path).patch({"lan": {"https": False}})
    assert _launcher_blocks(path, monkeypatch)

    # main starts (its load rewrites the file) and the user changes a setting.
    main = _main_store()
    main.SettingsStore(path).patch({"stems": {"auto_on_import": True}})
    assert _on_disk(path)["schema_version"] == 8, "main really rewrote the file"
    assert _on_disk(path)["stems"]["auto_on_import"] is True

    # This build again: the launcher first, then the backend's store.
    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False
    assert _launcher_blocks(path, monkeypatch)


def test_an_off_stored_at_app_lan_https_moves_to_lan_and_survives_main(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"
    # What the schema-10 build wrote after the user switched the listener off.
    path.write_text(
        json.dumps(
            {
                "schema_version": 10,
                "app": {"launch_mode": "desktop", "lan_https": False},
                "library": {"media_roots": []},
                "models": {"extra_folders": []},
            }
        ),
        encoding="utf-8",
    )

    # The launcher honours the old key before anything has been migrated.
    assert _launcher_blocks(path, monkeypatch)

    SettingsStore(path)
    migrated = _on_disk(path)
    assert migrated["schema_version"] == SCHEMA_VERSION
    assert migrated["lan"] == {"https": False}
    assert "lan_https" not in migrated["app"]
    assert migrated["app"]["launch_mode"] == "desktop"

    main = _main_store()
    main.SettingsStore(path).patch({"notation": {"artist": "SOMEONE"}})
    assert _on_disk(path)["lan"] == {"https": False}, "main kept the section whole"

    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False


def test_an_off_written_to_the_old_key_after_this_build_ran_still_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A schema-10 build running after this one keeps ``lan`` whole, writes
    ``app.lan_https: true`` from its own defaults, and the user may switch the
    listener off there. An off in either place wins."""
    path = tmp_path / "settings.json"
    SettingsStore(path)
    written_by_schema_10 = _on_disk(path)
    written_by_schema_10["schema_version"] = 10
    written_by_schema_10["app"]["lan_https"] = False
    path.write_text(json.dumps(written_by_schema_10), encoding="utf-8")

    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False
    assert "lan_https" not in _on_disk(path)["app"]
    assert _launcher_blocks(path, monkeypatch)


def test_the_old_key_at_the_current_schema_is_moved_on_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A hand edit can put the old key back at schema 11. The store rewrites
    the file on load, so the next write cannot drop the off it carried."""
    path = tmp_path / "settings.json"
    SettingsStore(path)
    edited = _on_disk(path)
    edited["app"]["lan_https"] = "off"
    path.write_text(json.dumps(edited), encoding="utf-8")

    SettingsStore(path)
    assert _on_disk(path)["lan"] == {"https": False}
    assert "lan_https" not in _on_disk(path)["app"]
    assert _launcher_blocks(path, monkeypatch)


def test_the_default_stays_on_through_main(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"
    SettingsStore(path)
    assert _on_disk(path)["lan"] == {"https": True}
    assert not _launcher_blocks(path, monkeypatch)

    _main_store().SettingsStore(path).patch({"stems": {"auto_on_import": True}})
    assert not _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is True


def test_a_known_section_that_is_not_an_object_keeps_its_defaults(
    tmp_path: Path,
) -> None:
    """A hand edit that nulls a section used to replace its defaults with
    None, and the load raised on it (every /api/settings call answered 500).
    An off at the old key still carries over into the rebuilt section."""
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 10,
                "app": {"lan_https": False},
                "lan": None,
                "models": None,
                "library": "not a section",
            }
        ),
        encoding="utf-8",
    )

    store = SettingsStore(path)

    assert store.get_value("lan", "https") is False
    assert store.get_section("models") == {"extra_folders": []}
    assert store.get_section("library") == {"media_roots": []}
    store.patch({"models": {"extra_folders": ["C:/models"]}})
    assert store.get_section("models") == {"extra_folders": ["C:/models"]}
