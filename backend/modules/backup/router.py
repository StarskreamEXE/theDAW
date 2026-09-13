"""FastAPI router for backup/migration of user data (/api/backup/*).

Endpoints (prefix from module.json -> ``/api/backup``):

- ``GET  /manifest``       — every user-data root with size/file counts.
- ``POST /export``         — start a background zip export; returns a job id.
- ``GET  /export/status``  — poll an export job.
- ``POST /import``         — start a background restore from a backup zip.
- ``GET  /import/status``  — poll an import job.
- ``GET  /pick-folder``    — native OS folder picker for the export target. It
  opens in the folder the last backup went to and remembers the choice.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from backend.core import folder_dialog
from backend.lib import known_paths
from backend.lib.cross_site import refuse_cross_site
from backend.modules.backup import service

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/manifest")
async def backup_manifest() -> dict:
    """List every user-data root worth backing up with its size on disk. The
    scan runs in a worker thread with an internal 30s budget so it never
    blocks the event loop or hangs on a huge library."""
    return await asyncio.to_thread(service.compute_manifest)


class ExportRequest(BaseModel):
    dest_dir: Optional[str] = None
    include: Optional[list[str]] = None


@router.post("/export")
async def start_export(req: ExportRequest) -> dict:
    """Kick off a zip export in a background thread. ``dest_dir`` defaults to
    the user's Documents folder; ``include`` limits the export to a subset of
    root ids from GET /manifest."""
    try:
        job_id = await asyncio.to_thread(
            service.start_export, req.dest_dir, req.include
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"job": job_id, "state": "running"}


@router.get("/export/status")
async def export_status(job: str = Query(...)) -> dict:
    status = service.job_status(job, kind="export")
    if status is None:
        raise HTTPException(status_code=404, detail=f"unknown export job: {job}")
    return status


class ImportRequest(BaseModel):
    zip_path: str
    mode: Literal["merge", "replace"] = "merge"


@router.post("/import")
async def start_import(req: ImportRequest) -> dict:
    """Validate the archive (must contain theDAW-backup-manifest.json) and
    restore it in a background thread. ``merge`` skips files that already
    exist; ``replace`` overwrites them."""
    try:
        job_id = await asyncio.to_thread(service.start_import, req.zip_path, req.mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"job": job_id, "state": "running"}


@router.get("/import/status")
async def import_status(job: str = Query(...)) -> dict:
    status = service.job_status(job, kind="import")
    if status is None:
        raise HTTPException(status_code=404, detail=f"unknown import job: {job}")
    return status


def _pick_backup_dest() -> Optional[str]:
    path = folder_dialog.pick_folder(
        "Select backup folder", known_paths.last_folder("backup-dest")
    )
    if path:
        known_paths.record(path, "backup-dest", source="pick")
    return path


@router.get("/pick-folder", dependencies=[Depends(refuse_cross_site)])
async def pick_backup_folder() -> dict:
    """Open the native OS folder picker (blocking dialog runs out-of-process
    with its own timeout) and return the chosen path, or null on cancel. The
    dialog opens in the last backup folder, and a chosen folder becomes it."""
    path = await asyncio.to_thread(_pick_backup_dest)
    return {"path": path}
