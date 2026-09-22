"""Settings store: the `io` device section, its migration, and the patch
semantics the frontend depends on.

The device menu persists here rather than in localStorage because the same
user opens theDAW as a browser tab AND as the desktop app (app.launch_mode),
which are two origins with two localStorage partitions. That makes these
guarantees load-bearing:

  - a settings file written by an older build gains `io` without losing a
    single existing choice;
  - `patch()` assigns a dict-valued key WHOLESALE, so the frontend must send
    the complete object — pinned here so nobody "fixes" it into a deep merge
    and silently changes what a partial PATCH means;
  - a key that is not in DEFAULT_SETTINGS is dropped, not stored.
"""

import json

from backend.modules.settings.store import (
    DEFAULT_SETTINGS,
    SCHEMA_VERSION,
    SettingsStore,
    _merge_defaults,
)

IO_SLOTS = (
    "audio_output",
    "cue_output",
    "audio_input",
    "midi_output",
    "visual_display",
)


def test_io_defaults_are_system_default_everywhere():
    io = DEFAULT_SETTINGS["io"]
    for slot in IO_SLOTS:
        assert io[slot] == {"id": "", "label": ""}, slot
    # 'all' so a controller plugged in after the choice was made still works
    # without a trip to Settings.
    assert io["midi_inputs"] == {"mode": "all", "ports": []}
    assert io["overrides"] == {}


def test_v7_file_gains_io_without_losing_existing_choices():
    old = {
        "schema_version": 7,
        "app": {"launch_mode": "desktop"},
        "stems": {"auto_on_import": True, "device": "cpu"},
        "notation": {"artist": "SOMEONE"},
    }

    merged = _merge_defaults(old)

    assert merged["schema_version"] == SCHEMA_VERSION == 10
    assert merged["io"] == DEFAULT_SETTINGS["io"]
    # v9 -> v10 added the library section; a file that predates it gets the
    # empty list rather than a missing key the media-root index would trip on.
    assert merged["library"] == {"media_roots": []}
    assert merged["io"] is not DEFAULT_SETTINGS["io"], "must be a deep copy"
    assert merged["app"]["launch_mode"] == "desktop"
    assert merged["stems"]["device"] == "cpu"
    assert merged["notation"]["artist"] == "SOMEONE"


def test_existing_io_choices_survive_a_reload():
    old = {
        "schema_version": 8,
        "io": {
            "audio_output": {"id": "abc", "label": "Scarlett 2i2"},
            "overrides": {"singPitch": {"id": "mic1", "label": "Yeti"}},
        },
    }

    merged = _merge_defaults(old)

    assert merged["io"]["audio_output"] == {"id": "abc", "label": "Scarlett 2i2"}
    assert merged["io"]["overrides"] == {"singPitch": {"id": "mic1", "label": "Yeti"}}
    # Slots the file never carried are filled from the defaults.
    assert merged["io"]["cue_output"] == {"id": "", "label": ""}


def test_patch_replaces_a_dict_slot_wholesale(tmp_path):
    """The frontend MUST send a complete slot object. This is the reason."""
    store = SettingsStore(tmp_path / "settings.json")

    store.patch({"io": {"audio_output": {"id": "abc", "label": "Scarlett 2i2"}}})
    assert store.get_section("io")["audio_output"] == {
        "id": "abc",
        "label": "Scarlett 2i2",
    }

    # A fragment REPLACES; it does not merge. The label is gone, not kept.
    store.patch({"io": {"audio_output": {"id": "def"}}})
    assert store.get_section("io")["audio_output"] == {"id": "def"}


def test_patch_drops_an_unknown_io_key(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")

    store.patch({"io": {"camera_input": {"id": "cam0", "label": "Webcam"}}})

    assert "camera_input" not in store.get_section("io")


def test_deleting_an_override_sticks(tmp_path):
    """`overrides` is replaced wholesale, so dropping a key really removes it —
    a deleted per-surface override must not resurrect on the next load."""
    path = tmp_path / "settings.json"
    store = SettingsStore(path)

    store.patch(
        {
            "io": {
                "overrides": {
                    "singPitch": {"id": "mic1", "label": "Yeti"},
                    "micRecorder": {"id": "mic2", "label": "Scarlett"},
                }
            }
        }
    )
    store.patch(
        {"io": {"overrides": {"micRecorder": {"id": "mic2", "label": "Scarlett"}}}}
    )

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["io"]["overrides"] == {
        "micRecorder": {"id": "mic2", "label": "Scarlett"}
    }
    assert SettingsStore(path).get_section("io")["overrides"] == {
        "micRecorder": {"id": "mic2", "label": "Scarlett"}
    }


def test_migrated_schema_is_persisted(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"schema_version": 7, "vj": {}}), encoding="utf-8")

    SettingsStore(path)

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["schema_version"] == SCHEMA_VERSION
    assert on_disk["io"]["midi_inputs"] == {"mode": "all", "ports": []}


# ---------------------------------------------------------------------------
# The two list-valued keys name folders on this machine. A LAN caller must not
# be able to point the media-root index (or the model scan) anywhere it likes.
# ---------------------------------------------------------------------------


def _settings_app(tmp_path, monkeypatch, peer):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.settings import router as settings_router
    from backend.modules.settings.store import SettingsStore

    monkeypatch.setattr(
        settings_router, "_store", SettingsStore(tmp_path / "settings.json")
    )
    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api/settings")
    return TestClient(app, client=peer)


def test_a_lan_caller_cannot_set_the_folder_lists(tmp_path, monkeypatch):
    lan = _settings_app(tmp_path, monkeypatch, ("10.20.30.40", 51000))

    roots = lan.patch("/api/settings", json={"library": {"media_roots": ["C:\\"]}})
    assert roots.status_code == 403
    models = lan.patch("/api/settings", json={"models": {"extra_folders": ["C:\\"]}})
    assert models.status_code == 403
    # Everything else still works from the LAN (the phone toggles features).
    assert (
        lan.patch("/api/settings", json={"stems": {"auto_on_import": True}}).status_code
        == 200
    )


def test_this_machine_can_set_the_media_roots(tmp_path, monkeypatch):
    local = _settings_app(tmp_path, monkeypatch, ("127.0.0.1", 51000))
    folder = tmp_path / "music"
    folder.mkdir()

    ok = local.patch("/api/settings", json={"library": {"media_roots": [str(folder)]}})
    assert ok.status_code == 200
    assert len(ok.json()["library"]["media_roots"]) == 1


def test_a_relative_media_root_is_refused_with_a_reason(tmp_path, monkeypatch):
    local = _settings_app(tmp_path, monkeypatch, ("127.0.0.1", 51000))

    bad = local.patch(
        "/api/settings", json={"library": {"media_roots": ["music/here"]}}
    )

    assert bad.status_code == 400
    assert "absolute" in bad.json()["detail"]
