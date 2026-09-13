"""The asset library: what the catalog accepts, and where an install lands.

A catalog file is data written by hand, so the parser's job is to drop a bad
entry and keep the rest. Install is the other half: each format has one place
it belongs, a second install of the same item must not overwrite the copy the
user has since edited, and every install is remembered so the library can open
what it installed after a reload.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.lib import known_paths
from backend.modules.assets import catalog
from backend.modules.plugin import router as plugin_router
from backend.modules.plugin.gan_file import GanFile
from backend.modules.plugin.owl_import import import_vst_foundry
from backend.modules.sway import router as sway_router
from backend.server import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def projects(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """known_paths and the projects folder inside tmp_path, so no test reads
    or writes the real store or the user's Documents folder."""
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    folder = tmp_path / "Documents" / "theDAW Projects"
    known_paths.set_projects_dir(folder)
    return folder


@pytest.fixture
def bundled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """A catalog of our own, standing in for examples/catalog.json."""
    root = tmp_path / "examples"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "demo.tasmo").write_bytes(b"PK\x03\x04 not really a zip")
    (root / "cover.jpg").write_bytes(b"\xff\xd8\xff")
    (root / "catalog.json").write_text(
        json.dumps(
            {
                "assets": [
                    {
                        "id": "demo",
                        "name": "Demo Project",
                        "file": "projects/demo.tasmo",
                        "cover": "cover.jpg",
                        "summary": "a demo",
                        "tags": ["uncanny", "meter"],
                        "tabs": ["EDIT"],
                    },
                    {
                        "id": "missing-file",
                        "name": "Listed But Absent",
                        "file": "projects/nope.tasmo",
                        "summary": "not shipped in this install",
                    },
                    {"name": "no id at all", "file": "projects/demo.tasmo"},
                    {
                        "id": "escapes",
                        "name": "Outside The Catalog",
                        "file": "../../etc/passwd",
                    },
                    {
                        "id": "unknown-format",
                        "name": "Some Other Thing",
                        "file": "projects/demo.exe",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(catalog, "EXAMPLES_DIR", root)
    monkeypatch.setattr(catalog, "BUNDLED_CATALOG", root / "catalog.json")
    monkeypatch.setattr(catalog, "user_catalog_dir", lambda: tmp_path / "userdata")
    return root


@pytest.fixture
def gan_catalog(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> str:
    """A catalog holding one real .gan, with the plugin shelf in tmp_path.
    Returns the plugin id inside the package."""
    root = tmp_path / "examples"
    (root / "plugins").mkdir(parents=True)
    foundry = tmp_path / "foundry.json"
    foundry.write_text(
        json.dumps(
            {
                "canvasWidth": 400,
                "canvasHeight": 300,
                "elements": [
                    {
                        "id": "k1",
                        "name": "Cutoff",
                        "type": "Knob",
                        "x": 10,
                        "y": 20,
                        "width": 80,
                        "height": 80,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    manifest, assets = import_vst_foundry(str(foundry), name="Shelf Demo")
    GanFile.save(manifest, assets, str(root / "plugins" / "shelf-demo.gan"))
    (root / "catalog.json").write_text(
        json.dumps(
            {
                "assets": [
                    {
                        "id": "plugin-shelf-demo",
                        "name": "Shelf Demo",
                        "file": "plugins/shelf-demo.gan",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(catalog, "EXAMPLES_DIR", root)
    monkeypatch.setattr(catalog, "BUNDLED_CATALOG", root / "catalog.json")
    monkeypatch.setattr(catalog, "user_catalog_dir", lambda: tmp_path / "userdata")
    monkeypatch.setattr(plugin_router, "GAN_DIR", tmp_path / "plugins")
    monkeypatch.setattr(plugin_router, "RUNTIME_DIR", tmp_path / "plugins" / "_runtime")
    return manifest.id


def _row(client: TestClient, asset_id: str) -> dict:
    rows = client.get("/api/assets").json()["assets"]
    return next(r for r in rows if r["id"] == asset_id)


def test_bad_entries_are_dropped_and_the_rest_survive(bundled: Path) -> None:
    entries = {e.id: e for e in catalog.load_entries()}
    assert set(entries) == {"demo", "missing-file"}
    assert entries["demo"].kind == "project"
    assert entries["demo"].format == ".tasmo"
    assert entries["demo"].available is True
    # Listed and absent is a state the browser shows, not a parse failure.
    assert entries["missing-file"].available is False


def test_search_ranks_a_name_match_first(bundled: Path) -> None:
    entries = catalog.load_entries()
    assert [e.id for e in catalog.search(entries, query="demo")] == ["demo"]
    assert [e.id for e in catalog.search(entries, tag="meter")] == ["demo"]
    assert [e.id for e in catalog.search(entries, tab="EDIT")] == ["demo"]
    assert catalog.search(entries, query="nothing here at all") == []
    assert [e.id for e in catalog.search(entries, available_only=True)] == ["demo"]


def test_user_catalog_overrides_a_bundled_id(
    bundled: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = tmp_path / "userdata"
    (user / "mine").mkdir(parents=True)
    (user / "mine" / "demo.tasmo").write_bytes(b"mine")
    (user / "extra.json").write_text(
        json.dumps(
            {
                "assets": [
                    {"id": "demo", "name": "My Own Demo", "file": "mine/demo.tasmo"}
                ]
            }
        ),
        encoding="utf-8",
    )
    entries = {e.id: e for e in catalog.load_entries()}
    assert entries["demo"].name == "My Own Demo"


def test_listing_and_detail_over_http(
    client: TestClient, bundled: Path, projects: Path
) -> None:
    body = client.get("/api/assets").json()
    assert body["count"] == 2
    assert {a["id"] for a in body["assets"]} == {"demo", "missing-file"}
    assert all(a["installed_path"] is None for a in body["assets"])

    one = client.get("/api/assets/demo").json()
    assert one["name"] == "Demo Project"
    assert one["installs_to"] == str(projects)
    assert one["installed_path"] is None

    assert client.get("/api/assets/nope").status_code == 404
    assert client.get("/api/assets/demo/cover").status_code == 200
    assert client.get("/api/assets/missing-file/cover").status_code == 404


def test_facets_count_every_axis(client: TestClient, bundled: Path) -> None:
    f = client.get("/api/assets/facets").json()
    assert {"value": "project", "count": 2} in f["kinds"]
    assert {"value": "uncanny", "count": 1} in f["tags"]
    assert {"value": "EDIT", "count": 1} in f["tabs"]


def test_installing_twice_reuses_the_copy_on_disk(
    client: TestClient, bundled: Path, projects: Path
) -> None:
    """Pressing the button twice used to leave demo (2) and demo (3) behind. An
    untouched copy is the same file, so the second press has nothing to do."""
    first = client.post("/api/assets/demo/install").json()
    assert Path(first["path"]).name == "demo.tasmo"
    assert first["already"] is False

    second = client.post("/api/assets/demo/install").json()
    assert second["path"] == first["path"]
    assert second["already"] is True
    assert [p.name for p in sorted(projects.iterdir())] == ["demo.tasmo"]


def test_an_edited_copy_is_never_overwritten(client: TestClient, bundled: Path) -> None:
    """The copy the user has worked on differs from the shipped file, so a fresh
    install lands beside it under a numbered name."""
    first = Path(client.post("/api/assets/demo/install").json()["path"])
    first.write_bytes(b"the user has been working on this")

    second = client.post("/api/assets/demo/install").json()
    assert Path(second["path"]).name == "demo (2).tasmo"
    assert second["already"] is False
    assert first.read_bytes() == b"the user has been working on this"


def test_a_project_installs_into_the_projects_folder_the_user_chose(
    client: TestClient, bundled: Path, tmp_path: Path
) -> None:
    chosen = tmp_path / "Elsewhere" / "Songs"
    known_paths.set_projects_dir(chosen)

    assert client.get("/api/assets/demo").json()["installs_to"] == str(chosen)
    body = client.post("/api/assets/demo/install").json()
    assert Path(body["path"]) == chosen / "demo.tasmo"
    assert body["where"] == str(chosen)
    assert body["kind"] == "project"
    assert "plugin_id" not in body


def test_an_install_is_remembered_and_listed_after_a_reload(
    client: TestClient, bundled: Path
) -> None:
    """The library loses its in-memory state on reload; the rows it fetches
    next must still say where the item went."""
    path = client.post("/api/assets/demo/install").json()["path"]

    assert known_paths.installed_asset_path("demo") == path
    assert _row(client, "demo")["installed_path"] == path
    assert client.get("/api/assets/demo").json()["installed_path"] == path

    [recent] = known_paths.recent(kind="tasmo")
    assert (recent["path"], recent["source"], recent["servable"]) == (
        path,
        "install",
        True,
    )
    assert known_paths.last_folder("tasmo") == str(Path(path).parent)


def test_a_second_press_is_remembered_too(
    client: TestClient,
    bundled: Path,
    projects: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An install made before installs were recorded answers 'already' on the
    next press, and that press is what records it."""
    first = client.post("/api/assets/demo/install").json()["path"]
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "fresh" / "known_paths.json"
    )
    known_paths.set_projects_dir(projects)
    assert known_paths.installed_asset_path("demo") is None

    again = client.post("/api/assets/demo/install").json()
    assert again["already"] is True
    assert known_paths.installed_asset_path("demo") == first


def test_an_unrecorded_copy_is_found_by_name_and_size(
    client: TestClient, bundled: Path, projects: Path
) -> None:
    projects.mkdir(parents=True)
    copy = projects / "demo.tasmo"
    copy.write_bytes((bundled / "projects" / "demo.tasmo").read_bytes())
    assert _row(client, "demo")["installed_path"] == str(copy)

    copy.write_bytes(b"a different file that happens to share the name")
    assert _row(client, "demo")["installed_path"] is None


def test_a_deleted_install_is_no_longer_listed_as_installed(
    client: TestClient, bundled: Path
) -> None:
    path = Path(client.post("/api/assets/demo/install").json()["path"])
    path.unlink()
    assert known_paths.installed_asset_path("demo") is None
    assert _row(client, "demo")["installed_path"] is None


def test_a_plugin_install_names_the_plugin_to_open(
    client: TestClient, gan_catalog: str, tmp_path: Path
) -> None:
    shelf = tmp_path / "plugins" / f"{gan_catalog}.gan"
    assert _row(client, "plugin-shelf-demo")["installed_path"] is None

    first = client.post("/api/assets/plugin-shelf-demo/install").json()
    assert first["plugin_id"] == gan_catalog
    assert first["kind"] == "plugin"
    assert first["path"] == str(shelf)
    assert first["already"] is False
    assert (plugin_router._runtime_dir(gan_catalog) / "index.html").is_file()

    second = client.post("/api/assets/plugin-shelf-demo/install").json()
    assert second["already"] is True
    assert second["path"] == str(shelf)

    [recent] = known_paths.recent(kind="gan")
    assert (recent["path"], recent["source"]) == (str(shelf), "install")
    assert _row(client, "plugin-shelf-demo")["installed_path"] == str(shelf)


def test_a_plugin_install_leaves_the_gan_picker_in_the_users_folder(
    client: TestClient, gan_catalog: str, tmp_path: Path
) -> None:
    """The user opened a .gan from their own folder, then installs a plugin
    from the library. The install joins Recent, and the next .gan dialog still
    opens where the user's file is."""
    mine = tmp_path / "Mine" / "pad.gan"
    mine.parent.mkdir()
    mine.write_bytes(
        (tmp_path / "examples" / "plugins" / "shelf-demo.gan").read_bytes()
    )
    known_paths.record(mine, source="pick")

    body = client.post("/api/assets/plugin-shelf-demo/install").json()
    assert body["installed"] is True
    assert known_paths.last_folder("gan") == str(mine.parent)
    assert [e["path"] for e in known_paths.recent(kind="gan")] == [
        body["path"],
        str(mine),
    ]


def test_a_scene_install_leaves_the_sway_picker_in_the_users_folder(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A .sway installs into data/sway-projects, theDAW's own folder, so the
    .sway dialog keeps the folder the user last chose a scene from."""
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    root = tmp_path / "examples"
    (root / "scenes").mkdir(parents=True)
    (root / "scenes" / "show.sway").write_text('{"version": 1}', encoding="utf-8")
    (root / "catalog.json").write_text(
        json.dumps(
            {"assets": [{"id": "show", "name": "Show", "file": "scenes/show.sway"}]}
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(catalog, "EXAMPLES_DIR", root)
    monkeypatch.setattr(catalog, "BUNDLED_CATALOG", root / "catalog.json")
    monkeypatch.setattr(catalog, "user_catalog_dir", lambda: tmp_path / "userdata")
    mine = tmp_path / "Shows" / "opener.sway"
    mine.parent.mkdir()
    mine.write_text("{}", encoding="utf-8")
    known_paths.record(mine, source="pick")

    body = client.post("/api/assets/show/install").json()
    assert Path(body["path"]) == tmp_path / "data" / "sway-projects" / "show.sway"
    assert known_paths.last_folder("sway") == str(mine.parent)
    assert [e["path"] for e in known_paths.recent(kind="sway")] == [
        body["path"],
        str(mine),
    ]


@pytest.fixture
def scene_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A catalog holding one .sway, with the home folders and the data tree in
    tmp_path. Returns data/sway-projects."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    scenes = tmp_path / "data" / "sway-projects"
    monkeypatch.setattr(sway_router, "_PROJECTS_DIR", scenes)
    root = tmp_path / "examples"
    (root / "scenes").mkdir(parents=True)
    (root / "scenes" / "show.sway").write_text(
        '{"version": 1, "scene": "show"}', encoding="utf-8"
    )
    (root / "catalog.json").write_text(
        json.dumps(
            {"assets": [{"id": "show", "name": "Show", "file": "scenes/show.sway"}]}
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(catalog, "EXAMPLES_DIR", root)
    monkeypatch.setattr(catalog, "BUNDLED_CATALOG", root / "catalog.json")
    monkeypatch.setattr(catalog, "user_catalog_dir", lambda: tmp_path / "userdata")
    return scenes


def _listed_scenes(client: TestClient) -> dict[str, bool]:
    rows = client.get("/api/sway/projects").json()["projects"]
    return {r["name"]: r["builtin"] for r in rows}


def test_the_scene_list_flags_catalog_installs_as_builtin(
    client: TestClient, scene_catalog: Path
) -> None:
    """A cockpit save is the user's own; a catalog install is built in."""
    saved = client.post(
        "/api/sway/project-save", json={"name": "My Set", "doc": {"version": 1}}
    )
    assert saved.status_code == 200
    installed = client.post("/api/assets/show/install").json()
    assert Path(installed["path"]) == scene_catalog / "show.sway"

    assert _listed_scenes(client) == {"My Set": False, "show": True}


def test_a_copy_of_a_catalog_scene_is_builtin_until_a_save_rewrites_it(
    client: TestClient, scene_catalog: Path
) -> None:
    """The flag follows the bytes: an unrecorded copy under another name still
    counts, and a cockpit save over the installed scene makes it custom."""
    client.post("/api/assets/show/install")
    shipped = (catalog.EXAMPLES_DIR / "scenes" / "show.sway").read_bytes()
    (scene_catalog / "show (2).sway").write_bytes(shipped)
    assert _listed_scenes(client) == {"show": True, "show (2)": True}

    client.post(
        "/api/sway/project-save",
        json={"name": "show", "doc": {"version": 1, "scene": "edited"}},
    )
    assert _listed_scenes(client) == {"show": False, "show (2)": True}


def test_a_plugin_on_the_shelf_is_found_by_its_manifest_id(
    client: TestClient, gan_catalog: str, tmp_path: Path
) -> None:
    """The bundled plugins are built onto the shelf at startup, with no install
    record. The shelf file is named by manifest id, not by catalog file name."""
    shelf = tmp_path / "plugins" / f"{gan_catalog}.gan"
    shelf.parent.mkdir(parents=True)
    shelf.write_bytes(
        (tmp_path / "examples" / "plugins" / "shelf-demo.gan").read_bytes()
    )
    assert _row(client, "plugin-shelf-demo")["installed_path"] == str(shelf)


def test_installing_something_absent_is_a_404(
    client: TestClient, bundled: Path
) -> None:
    assert client.post("/api/assets/missing-file/install").status_code == 404
    assert client.get("/api/assets/missing-file/download").status_code == 404


def test_the_shipped_catalog_is_valid() -> None:
    """The real examples/catalog.json, checked as it ships: every entry parses
    and every file it names is present."""
    entries = catalog.load_entries()
    assert entries, "the bundled catalog is empty"
    missing = [e.id for e in entries if not e.available]
    assert not missing, f"catalog lists files this checkout does not have: {missing}"
