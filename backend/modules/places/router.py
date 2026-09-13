"""HTTP API for the paths theDAW remembers (backend/lib/known_paths.py).

    GET  /api/places/folder?kind=            the folder a picker for this kind starts in
    GET  /api/places/recent?kind=&exts=&limit=  remembered files, newest first
    POST /api/places/record                  remember a path the client knows about
    POST /api/places/reveal                  show a path in the OS file manager
    GET  /api/places/file?path=              a servable remembered file's bytes
    POST /api/places/save                    write an upload to a path a Save dialog granted
    GET  /api/places/projects-dir            the folder .tasmo projects go in
    PUT  /api/places/projects-dir            change it

The server binds 0.0.0.0, so nothing a request body says can make a file
servable or writable on its own. /record stores what it is given as ``client``,
which /file never serves, unless the request carries the desktop shell's launch
token (``backend.lib.launch_token``); /file serves only servable sources; /save
writes only to a path the user chose in a native Save dialog, with the nonce
that dialog issued, once.

CORS is open on this server, so a page on another site could otherwise list the
recent files and then read them. Every route refuses a call that the browser
labels as coming from such a page (``backend.lib.cross_site``).
"""

from __future__ import annotations

import logging
import mimetypes
import os
import shutil
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request
from fastapi import UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.lib import known_paths, launch_token, reveal
from backend.lib.atomic import atomic_replace, temp_sibling
from backend.lib.cross_site import refuse_cross_site

log = logging.getLogger(__name__)


router = APIRouter(dependencies=[Depends(refuse_cross_site)])

# One save at a time, from the grant check to spending it, so two requests
# holding the same grant cannot both write.
_SAVE_LOCK = threading.Lock()


class RecordBody(BaseModel):
    path: str
    kind: str | None = None


class PathBody(BaseModel):
    path: str


@router.get("/folder")
def get_folder(kind: str = Query("")) -> dict[str, Any]:
    return {"kind": kind, "folder": known_paths.last_folder(kind or None)}


@router.get("/recent")
def get_recent(
    kind: str = Query(""),
    exts: str = Query("", description="comma-separated, e.g. .mid,.midi"),
    limit: int = Query(20),
) -> dict[str, Any]:
    wanted = [e for e in exts.split(",") if e.strip()] or None
    return {"items": known_paths.recent(kind or None, wanted, limit)}


@router.post("/record")
def post_record(body: RecordBody, request: Request) -> dict[str, Any]:
    # The body names the path. Only the desktop shell that started this backend
    # holds the launch token, and it sends it for a download it finished, so
    # that record is servable. Every other call is remembered as 'client', for
    # pickers and menus, and never served.
    source = "download" if launch_token.header_matches(request) else "client"
    entry = known_paths.record(body.path, body.kind, source=source)
    return {"recorded": entry is not None, "kind": entry["kind"] if entry else None}


@router.post("/reveal")
def post_reveal(body: PathBody) -> dict[str, Any]:
    try:
        shown = reveal.reveal(body.path)
    except FileNotFoundError as e:
        raise HTTPException(404, f"Not found: {body.path}") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except OSError as e:
        raise HTTPException(500, f"Could not open the file manager: {e}") from e
    return {"status": "ok", "path": shown}


@router.get("/file")
def get_file(path: str = Query("")) -> FileResponse:
    served = known_paths.find_servable(path)
    if served is None:
        # One answer for a path never recorded, one recorded but not servable,
        # and one that has since gone, so the route reveals nothing about the
        # filesystem to a caller that is not entitled to it.
        raise HTTPException(403, "theDAW does not serve that file.")
    media_type, _ = mimetypes.guess_type(served)
    return FileResponse(
        served,
        media_type=media_type or "application/octet-stream",
        filename=os.path.basename(served),
    )


@router.post("/save")
def post_save(
    file: UploadFile = File(...),
    path: str = Form(...),
    kind: str | None = Form(None),
    grant: str = Form(""),
) -> dict[str, Any]:
    """Write the upload to ``path``, which the user chose in a Save dialog.

    ``grant`` is the nonce /api/storage/pick-save returned for that path. It is
    spent only after the file is written, so a failed write can be retried with
    the same grant, and a second write with it is refused."""
    if known_paths.is_blocked_save_path(path):
        raise HTTPException(403, "That file type cannot be saved from theDAW.")
    with _SAVE_LOCK:
        if not known_paths.peek_save_grant(path, grant):
            raise HTTPException(403, "Choose where to save in the Save dialog first.")
        dest = Path(os.path.abspath(os.path.expanduser(path)))
        tmp = temp_sibling(dest)
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with tmp.open("wb") as out:
                shutil.copyfileobj(file.file, out, 1 << 20)
            atomic_replace(tmp, dest)
        except OSError as e:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                log.debug("places.save: leftover temp file %s", tmp)
            raise HTTPException(500, f"Could not save {dest.name}: {e}") from e
        known_paths.consume_save_grant(path, grant)

    entry = known_paths.record(dest, kind or None, source="save")
    log.info("places: saved %s", dest)
    return {
        "path": str(dest),
        "kind": entry["kind"] if entry else known_paths.kind_for_path(dest),
    }


@router.get("/projects-dir")
def get_projects_dir() -> dict[str, Any]:
    return {
        "path": str(known_paths.projects_dir()),
        "configured": known_paths.projects_dir_configured(),
    }


@router.put("/projects-dir")
def put_projects_dir(body: PathBody) -> dict[str, str]:
    try:
        chosen = known_paths.set_projects_dir(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"path": str(chosen)}
