"""HTTP API for the asset library.

    GET  /api/assets                list + search the catalog
    GET  /api/assets/facets         counts per kind, tag and tab
    GET  /api/assets/{id}           one entry
    GET  /api/assets/{id}/cover     its cover image
    GET  /api/assets/{id}/download  the file itself
    POST /api/assets/{id}/install   put the file where its format belongs

Install copies rather than moves: the catalog file is the shipped copy and a
second install has to keep working. Every install answers with the path it
wrote, so the UI can say where the thing went, and remembers it in
known_paths, so every list and detail row carries ``installed_path`` and the
library can open what it installed after a reload.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from backend.lib import known_paths, paths

from . import catalog

log = logging.getLogger(__name__)

router = APIRouter()

# (path, mtime_ns, size) -> the plugin id in that .gan's manifest. A listing
# asks for it on every row, and the answer only changes with the file.
_MANIFEST_IDS: dict[tuple[str, int, int], str] = {}
_MANIFEST_IDS_MAX = 256


def _entry_or_404(asset_id: str) -> catalog.AssetEntry:
    for e in catalog.load_entries():
        if e.id == asset_id:
            return e
    raise HTTPException(404, f"No asset with id {asset_id!r}")


def _same_file(a: Path, b: Path) -> bool:
    """True when two paths hold the same bytes. Size first, then a hash, so
    the common case costs one stat."""
    try:
        if a.stat().st_size != b.stat().st_size:
            return False
    except OSError:
        return False
    return _digest(a) == _digest(b)


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _existing_copy(target: Path, source: Path, name: str) -> Path | None:
    """An installed copy of this exact file, if one is already there.

    Pressing install twice used to leave "name (2)" and "name (3)" behind. An
    untouched copy is the same file, so the second press has nothing to do and
    the caller can open what is already on disk. A copy the user has since
    edited differs, and that one is kept.
    """
    stem, suffix = Path(name).stem, Path(name).suffix
    candidates = [target / name] + [
        target / f"{stem} ({n}){suffix}" for n in range(2, 20)
    ]
    for c in candidates:
        if c.is_file() and _same_file(c, source):
            return c
    return None


def _unique_path(target: Path, name: str) -> Path:
    """``target/name``, with a numeric suffix when that exists already, so an
    install never overwrites a copy the user has edited."""
    candidate = target / name
    if not candidate.exists():
        return candidate
    stem, suffix = Path(name).stem, Path(name).suffix
    for n in range(2, 1000):
        candidate = target / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
    raise HTTPException(500, "could not find a free filename to install into")


def _install_gan(entry: catalog.AssetEntry) -> tuple[Path, str, bool]:
    """Hand a .gan to the plugin module, which stores and extracts it.

    Returns the stored .gan, its plugin id, and whether that exact package was
    already on the shelf with its runtime extracted, in which case nothing is
    rewritten and an open surface keeps its cached assets.
    """
    from backend.modules.plugin.gan_file import GanFile
    from backend.modules.plugin.router import (
        GAN_DIR,
        _plugin_id_ok,
        _publish_runtime,
        _runtime_dir,
    )

    try:
        manifest = GanFile.info(str(entry.file))
    except (OSError, ValueError) as e:
        raise HTTPException(400, f"{entry.file.name} is not a readable .gan: {e}")
    plugin_id = str(manifest.get("id") or entry.id)
    if not _plugin_id_ok(plugin_id):
        raise HTTPException(400, f"{entry.file.name} has an invalid plugin id")
    dest = GAN_DIR / f"{plugin_id}.gan"
    already = (
        dest.is_file()
        and _same_file(dest, entry.file)
        and (_runtime_dir(plugin_id) / "index.html").is_file()
    )
    if not already:
        try:
            GanFile.install(str(entry.file), str(dest))
        except OSError as e:
            raise HTTPException(500, f"could not install {entry.name}: {e}") from e
        _publish_runtime(dest, plugin_id)
    return dest, plugin_id, already


def _install_path(entry: catalog.AssetEntry) -> Path:
    """Where this format belongs on this machine."""
    target_name = catalog.FORMAT_TARGETS.get(entry.format)
    if target_name == "projects":
        return known_paths.projects_dir()
    if target_name is None:
        raise HTTPException(500, f"{entry.format} has its own installer")
    return paths.data_path(target_name)


def _manifest_id(gan: Path) -> str | None:
    """The plugin id a .gan declares, or None when it cannot be read."""
    from backend.modules.plugin.gan_file import GanFile

    try:
        st = gan.stat()
    except OSError:
        return None
    key = (str(gan), st.st_mtime_ns, st.st_size)
    cached = _MANIFEST_IDS.get(key)
    if cached is not None:
        return cached
    try:
        plugin_id = str(GanFile.info(str(gan)).get("id") or "")
    except (OSError, ValueError):
        return None
    if not plugin_id:
        return None
    if len(_MANIFEST_IDS) >= _MANIFEST_IDS_MAX:
        _MANIFEST_IDS.clear()
    _MANIFEST_IDS[key] = plugin_id
    return plugin_id


def _installed_path(entry: catalog.AssetEntry) -> str | None:
    """Where this asset already sits on this machine, or None.

    The recorded install comes first. A copy with no record (installed before
    installs were recorded, or put there by hand) is found by name: the same
    file name and size in the folder its format installs into. The plugin
    module stores a .gan under its manifest id, so that is the name looked for
    on the plugin shelf.
    """
    recorded = known_paths.installed_asset_path(entry.id)
    if recorded:
        return recorded
    if not entry.available:
        return None
    if entry.format == ".gan":
        from backend.modules.plugin.router import GAN_DIR, _plugin_id_ok

        plugin_id = _manifest_id(entry.file)
        if not plugin_id or not _plugin_id_ok(plugin_id):
            return None
        shelf = GAN_DIR / f"{plugin_id}.gan"
        return str(shelf) if shelf.is_file() else None
    try:
        candidate = _install_path(entry) / entry.file.name
        if candidate.is_file() and candidate.stat().st_size == entry.size_bytes:
            return str(candidate)
    except (HTTPException, OSError):
        return None
    return None


def _row(entry: catalog.AssetEntry) -> dict[str, Any]:
    payload = entry.to_dict()
    payload["installed_path"] = _installed_path(entry)
    return payload


# Data-root folders theDAW installs into and keeps for itself.
_APP_DATA_FOLDERS = ("plugins", "sway-projects", "volumetric")


def _in_app_folder(dest: Path) -> bool:
    """True when ``dest`` sits in the plugin shelf, the scene folder or the
    volumetric folder."""
    from backend.modules.plugin.router import GAN_DIR

    target = os.path.normcase(os.path.abspath(dest))
    for root in (GAN_DIR, *(paths.data_path(n) for n in _APP_DATA_FOLDERS)):
        folder = os.path.normcase(os.path.abspath(root))
        if target == folder or target.startswith(folder.rstrip(os.sep) + os.sep):
            return True
    return False


def _remember_install(entry: catalog.AssetEntry, dest: Path) -> None:
    """Record where an install landed, so the library and every picker for
    that kind of file can find it again.

    An install into one of theDAW's own folders joins Recent without moving the
    picker's folder, which stays where the user last chose a file."""
    known_paths.set_installed_asset(entry.id, dest)
    known_paths.record(dest, source="install", update_folder=not _in_app_folder(dest))


@router.get("")
@router.get("/")
def list_assets(
    q: str = Query("", description="free text over name, summary, tags and tabs"),
    kind: str = Query("", description="project | plugin | volumetric | scene"),
    tag: str = Query(""),
    tab: str = Query("", description="an app tab the asset demonstrates"),
    available_only: bool = Query(False),
) -> dict[str, Any]:
    entries = catalog.load_entries()
    hits = catalog.search(
        entries,
        query=q,
        kind=kind,
        tag=tag,
        tab=tab,
        available_only=available_only,
    )
    return {
        "total": len(entries),
        "count": len(hits),
        "assets": [_row(e) for e in hits],
    }


@router.get("/facets")
def list_facets() -> dict[str, Any]:
    return catalog.facets(catalog.load_entries())


@router.get("/{asset_id}")
def get_asset(asset_id: str) -> dict[str, Any]:
    entry = _entry_or_404(asset_id)
    payload = _row(entry)
    payload["installs_to"] = (
        "the plugin shelf" if entry.format == ".gan" else str(_install_path(entry))
    )
    return payload


@router.get("/{asset_id}/cover")
def get_cover(asset_id: str) -> FileResponse:
    entry = _entry_or_404(asset_id)
    if entry.cover is None or not entry.cover.is_file():
        raise HTTPException(404, "no cover image")
    return FileResponse(entry.cover)


@router.get("/{asset_id}/download")
def download_asset(asset_id: str) -> FileResponse:
    entry = _entry_or_404(asset_id)
    if not entry.available:
        raise HTTPException(
            404, f"{entry.name} is listed but not present in this install"
        )
    return FileResponse(
        entry.file,
        filename=entry.file.name,
        media_type="application/octet-stream",
    )


@router.post("/{asset_id}/install")
def install_asset(asset_id: str) -> dict[str, Any]:
    entry = _entry_or_404(asset_id)
    if not entry.available:
        raise HTTPException(
            404, f"{entry.name} is listed but not present in this install"
        )

    if entry.format == ".gan":
        dest, plugin_id, already = _install_gan(entry)
        if not already:
            log.info("assets: installed %s to %s", entry.id, dest)
        _remember_install(entry, dest)
        return {
            "id": entry.id,
            "installed": True,
            "already": already,
            "path": str(dest),
            "where": "the plugin shelf",
            "kind": entry.kind,
            "plugin_id": plugin_id,
        }

    target = _install_path(entry)
    try:
        target.mkdir(parents=True, exist_ok=True)
        existing = _existing_copy(target, entry.file, entry.file.name)
        if existing is not None:
            dest, already = existing, True
        else:
            dest, already = _unique_path(target, entry.file.name), False
            shutil.copy2(entry.file, dest)
    except OSError as e:
        raise HTTPException(500, f"could not install {entry.name}: {e}") from e
    if not already:
        log.info("assets: installed %s to %s", entry.id, dest)
    _remember_install(entry, dest)
    return {
        "id": entry.id,
        "installed": True,
        "already": already,
        "path": str(dest),
        "where": str(target),
        "kind": entry.kind,
    }
