"""FastAPI router for VST3 plugin hosting (/api/vst/*)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from backend.modules.vst.scanner import (
    Vst3PluginInfo,
    carry_over_metadata,
    scan_vst3_directories,
    load_cached_scan,
    read_cache_entries,
    save_scan_cache,
    start_background_enrichment,
)
from backend.modules.vst.host import (
    param_key,
    load_plugin,
    unload_plugin,
    get_instance,
    list_instances,
    process_chain,
    process_with_plugin,
    list_builtin_effects,
)
from backend.modules.vst.live_host import HostLocator, _os_reason
from backend.lib import paths
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)

#: Render subprocesses are headless: no console window may flash on Windows.
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
router = APIRouter()

# Per-plugin captured editor state (from the native-GUI sidecar) lands here.
_PRESET_DIR = paths.data_path("vst_presets")

# Editor sidecars spawned by this process, so a crashed editor can be detected
# instead of leaving the frontend polling a status that will never change.
_editor_procs: dict[str, subprocess.Popen] = {}


def _preset_path(plugin_path: str) -> Path:
    h = hashlib.sha1(plugin_path.encode("utf-8")).hexdigest()[:16]
    stem = Path(plugin_path).stem
    safe = "".join(c for c in stem if c.isalnum() or c in "-_") or "plugin"
    return _PRESET_DIR / f"{safe}_{h}.json"


def _rect_path(plugin_path: str) -> Path:
    return _preset_path(plugin_path).with_suffix(".rect.json")


def _size_path(plugin_path: str) -> Path:
    return _preset_path(plugin_path).with_suffix(".size.json")


def _pid_path(plugin_path: str) -> Path:
    return _preset_path(plugin_path).with_suffix(".pid")


def _pid_alive(pid: int) -> bool:
    """Whether a process id is still running, without signalling it."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x00000102
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _editor_alive(plugin_path: str) -> bool:
    """Whether the sidecar owning this plugin's editor is still running.

    The Popen handle is authoritative while the server that spawned it is up;
    the pid file covers the case where the server restarted underneath a live
    editor, so a running editor is never declared dead.
    """
    proc = _editor_procs.get(plugin_path)
    if proc is not None:
        return proc.poll() is None
    pid_file = _pid_path(plugin_path)
    if not pid_file.is_file():
        return False
    try:
        return _pid_alive(int(pid_file.read_text(encoding="utf-8").strip()))
    except (OSError, ValueError):
        return False


# --- Request / Response models ---
class LoadRequest(BaseModel):
    plugin_path: str
    instance_id: str | None = None


class SetParamRequest(BaseModel):
    name: str
    value: float


class ProcessRequest(BaseModel):
    instance_ids: list[str]  # Ordered chain of instance IDs
    audio_path: str  # Path to a WAV/FLAC/etc. on disk
    output_path: str | None = None  # Where to write; temp file if omitted


class ScanResponse(BaseModel):
    plugins: list[dict]


class EditorRequest(BaseModel):
    plugin_path: str
    raw_state: str | None = None
    # Which plugin inside a multi-plugin .vst3 to open. Omitted -> the loader's
    # first entry, which need not be the one this chain node renders with.
    plugin_name: str | None = None
    # Embedding (Electron/Windows): the host BrowserWindow HWND + initial embed
    # rect. When parent_hwnd is set the editor is reparented into that window over
    # the rect; omitted -> the editor opens as a floating window (default).
    parent_hwnd: int | None = None
    rect: dict | None = None  # {x, y, w, h, dpr} in CSS px (+ devicePixelRatio)


class EditorRectRequest(BaseModel):
    plugin_path: str
    x: float = 0
    y: float = 0
    w: float = 0
    h: float = 0
    sx: float = 0  # scroll offset within the (natural-size) editor, physical px
    sy: float = 0
    dpr: float = 1
    close: bool = False  # set true to close the embedded editor


# --- Endpoints ---


@router.get("/scan", response_model=ScanResponse)
def scan_vst3(
    refresh: bool = False, enrich: bool = True, include_unloadable: bool = False
):
    """Scan standard VST3 directories.

    Serves the cache when it is still valid for the current contents of the scan
    roots; ``refresh=true`` forces a fresh walk and gives previously failed
    plugins another chance. Plugins this host cannot load are withheld unless
    ``include_unloadable`` asks for them, so the UI never offers a dead tile.
    """
    plugins: list[Vst3PluginInfo] | None = None
    if not refresh:
        plugins = load_cached_scan()
    if plugins is None:
        plugins = scan_vst3_directories()
        carry_over_metadata(plugins, read_cache_entries(), retry_failed=refresh)
        save_scan_cache(plugins)
    body = _plugin_dicts(plugins, include_unloadable)
    if enrich:
        # Vendor/version/category only come from opening the plugin, which is far
        # too slow to hold a request; the worker fills the cache in and the next
        # scan serves it.
        start_background_enrichment(plugins)
    return ScanResponse(plugins=body)


@router.get("/scan/{path:path}", response_model=ScanResponse)
def scan_vst3_custom(path: str, include_unloadable: bool = False):
    """Scan a custom directory for VST3 plugins (always live, never cached)."""
    plugins = scan_vst3_directories(extra_paths=[path])
    return ScanResponse(plugins=_plugin_dicts(plugins, include_unloadable))


@router.post("/load")
def load_vst(req: LoadRequest):
    """Load a VST3 plugin and return its parameter descriptors."""
    try:
        inst = load_plugin(req.plugin_path, req.instance_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load VST3: {e}")
    return {
        "instance_id": inst.instance_id,
        "plugin_name": inst.plugin_name,
        "plugin_path": inst.plugin_path,
        "parameters": inst.parameters,
    }


@router.get("/plugins")
def get_loaded_plugins():
    """List all currently loaded plugin instances."""
    return list_instances()


@router.post("/process")
def process_audio(req: ProcessRequest):
    """Run an audio file through an ordered chain of loaded VST instances.

    Reads the file at its native sample rate, processes it through the
    instances named in ``instance_ids`` (in order), and writes a WAV to
    ``output_path`` (or a temp file) at the source's own bit depth. Returns
    the output path.
    """
    import soundfile as sf

    from backend.lib.audio_depth import write_like_source

    src = Path(req.audio_path)
    if not src.is_file():
        raise HTTPException(
            status_code=404, detail=f"Audio file not found: {req.audio_path}"
        )
    try:
        # soundfile returns (frames, channels) float32 — the layout pedalboard expects.
        audio, sr = sf.read(str(src), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read audio: {e}")

    try:
        processed = process_chain(req.instance_ids, audio, sr)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VST processing failed: {e}")

    created_temp = False
    out_path = req.output_path
    if out_path:
        out = Path(out_path)
        if out.is_dir():
            raise HTTPException(
                status_code=400, detail=f"output_path is a directory: {out_path}"
            )
        if not out.parent.exists():
            raise HTTPException(
                status_code=400,
                detail=f"output_path parent directory does not exist: {out.parent}",
            )
        if not out.suffix:
            # soundfile infers the container format from the extension.
            out_path = str(out.with_suffix(".wav"))
    else:
        fd, out_path = tempfile.mkstemp(suffix="_vst.wav")
        os.close(fd)
        created_temp = True

    try:
        # Float in, float out, same as /process-file below: a chain that
        # requantizes between stages loses a little at every plugin, and this
        # endpoint exists precisely to run several in a row.
        write_like_source(out_path, processed, sr, src)
    except Exception as e:
        if created_temp:
            try:
                os.unlink(out_path)
            except OSError:
                pass
        raise HTTPException(status_code=500, detail=f"Could not write output: {e}")

    return {
        "output_path": out_path,
        "sample_rate": int(sr),
        "instance_ids": req.instance_ids,
        "frames": int(processed.shape[0]),
    }


#: Temp input/output/state files for ``state_host=thedaw`` renders.
_RENDER_DIR = paths.data_path("vst_render")

#: The render mode's documented exit codes (``native/vst-host/src/util/Args.cpp``),
#: in words the user can act on. 0 never reaches this table.
RENDER_EXIT_MEANINGS: dict[int, str] = {
    1: "the rendered file could not be written",
    2: "the host rejected its command line",
    3: "the plugin file was not found",
    4: "the plugin failed to load or initialize",
    5: "the plugin does not support the uploaded channel layout",
    6: "the host could not open its local socket",
    7: "the uploaded audio could not be read by the host",
}

#: A render is faster than real time, but a plugin that hangs must not hold the
#: request open forever.
RENDER_TIMEOUT_SECONDS = 300.0

#: After a timed-out render is killed, how long to wait for it to actually
#: exit before giving up on reading its pipes. Bounded on purpose: the
#: unbounded wait ``subprocess.run`` performs after a post-timeout kill is
#: exactly what could stall the request (review R5 nit #10).
RENDER_KILL_WAIT_SECONDS = 5.0

#: Bytes read per chunk while streaming an upload past its cap check.
_UPLOAD_READ_CHUNK_BYTES = 1024 * 1024

#: Default cap on a thedaw render's uploaded audio; override with
#: THEDAW_VST_RENDER_MAX_BYTES (review R5 item #7 — uploads had no cap at all).
_DEFAULT_RENDER_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

#: raw_state is a small serialized preset, not a rendered file; a caller
#: sending more than this is misusing the field, not tuning ops, so there is
#: no env override.
_RENDER_MAX_RAW_STATE_CHARS = 64 * 1024 * 1024


class _UploadTooLarge(Exception):
    """Raised internally when a capped upload read exceeds its byte limit."""


def _render_max_upload_bytes() -> int:
    """``THEDAW_VST_RENDER_MAX_BYTES``, or the 2 GiB default if unset/invalid."""
    raw = os.environ.get("THEDAW_VST_RENDER_MAX_BYTES", "")
    try:
        value = int(raw)
    except ValueError:
        value = 0
    return value if value > 0 else _DEFAULT_RENDER_MAX_UPLOAD_BYTES


async def _read_upload_capped(upload: UploadFile, max_bytes: int) -> bytes:
    """Read ``upload`` in chunks, never buffering past ``max_bytes``.

    Stops at the first chunk that pushes the running total over the cap, so
    an oversized upload cannot hold the request (or its memory) open for the
    full transfer (review R5 item #7).
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(_UPLOAD_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise _UploadTooLarge(total)
        chunks.append(chunk)
    return b"".join(chunks)


def _strip_render_paths(text: str, paths_used: list[Path]) -> str:
    """Reduce any of this render's own temp-file paths to just their name.

    The host only ever learns these paths because they were put on its argv;
    if it echoes one back in a warning, the client should see the file name,
    never the server's directory layout (review R5 item #11).
    """
    for path in paths_used:
        text = text.replace(str(path), path.name)
    return text


def _render_log_tail(stderr: str, limit: int = 600) -> str:
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    if not lines:
        return "The host logged nothing."
    return "Log tail: " + " | ".join(lines[-8:])[:limit]


def _render_report_warnings(stdout: str) -> list[str]:
    """The ``warnings`` array out of the host's JSON report line, if any."""
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if not isinstance(payload, dict):
            continue
        found = payload.get("warnings")
        if isinstance(found, list):
            return [str(item) for item in found]
        return []
    return []


def _render_with_thedaw_host(
    plugin_path: str,
    plugin_name: str,
    audio_bytes: bytes,
    state_blob: bytes | None,
    param_map: dict,
    warnings: list[str],
) -> bytes:
    """Render ``audio_bytes`` through ``thedaw-vst-host --render``.

    Synchronous end to end (spawn, wait, cleanup): the caller offloads this
    whole call with ``asyncio.to_thread`` so the up-to-``RENDER_TIMEOUT_SECONDS``
    wait never blocks the event loop. Returns the rendered WAV bytes. Every
    failure raises ``HTTPException``; there is deliberately no pedalboard
    fallback — a caller that asked for our host and silently got a different
    renderer would be shipping audio it never heard.

    Raises:
        HTTPException: 503 when the host binary is absent (with the locator's
            reason), 502 when the host exits non-zero or times out, 500 when the
            temp files cannot be written or the output cannot be read back.
    """
    locator = HostLocator()
    host = locator.resolve()
    if host is None:
        raise HTTPException(status_code=503, detail=locator.describe()["reason"])

    try:
        _RENDER_DIR.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="render-", dir=str(_RENDER_DIR)))
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not create the render directory: {_os_reason(e)}",
        )

    in_path = work / "in.wav"
    out_path = work / "out.wav"
    #: Every path the host was handed on its argv — the only paths it could
    #: possibly echo back in a warning (see ``_strip_render_paths``).
    temp_paths = [in_path, out_path]
    try:
        try:
            in_path.write_bytes(audio_bytes)
            cmd = locator.launch_prefix(host) + [
                "--render",
                "--plugin",
                plugin_path,
                "--in",
                str(in_path),
                "--out",
                str(out_path),
                "--block-size",
                "1024",
                "--tail-seconds",
                "auto",
            ]
            if plugin_name:
                cmd += ["--plugin-name", plugin_name]
            if state_blob:
                state_path = work / "state.bin"
                state_path.write_bytes(state_blob)
                temp_paths.append(state_path)
                cmd += ["--state-file", str(state_path)]
            if param_map:
                params_path = work / "params.json"
                params_path.write_text(json.dumps(param_map), encoding="utf-8")
                temp_paths.append(params_path)
                cmd += ["--params-json", str(params_path)]
        except OSError as e:
            raise HTTPException(
                status_code=500,
                detail=f"Could not stage the render input: {_os_reason(e)}",
            )

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(paths.PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                creationflags=_NO_WINDOW,
                env=child_env(),
            )
        except OSError as e:
            raise HTTPException(
                status_code=502,
                detail=f"Could not start the VST host: {_os_reason(e)}",
            )

        try:
            stdout, stderr = proc.communicate(timeout=RENDER_TIMEOUT_SECONDS)
            returncode = proc.returncode
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                # A bounded wait, never the unbounded one subprocess.run does
                # after a post-timeout kill (review R5 nit #10). If the host
                # still won't die, stop waiting rather than stall the request.
                proc.communicate(timeout=RENDER_KILL_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            raise HTTPException(
                status_code=502,
                detail=(
                    f"The VST host did not finish the render within "
                    f"{RENDER_TIMEOUT_SECONDS:.0f}s and was stopped."
                ),
            )

        if returncode != 0:
            code = int(returncode)
            meaning = RENDER_EXIT_MEANINGS.get(
                code, f"the host exited with code {code}"
            )
            raise HTTPException(
                status_code=502,
                detail=(
                    f"The VST host could not render this file (exit code {code}): "
                    f"{meaning}. " + _render_log_tail(stderr)
                ),
            )

        try:
            rendered = out_path.read_bytes()
        except OSError as e:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"The VST host reported success but its output could not be "
                    f"read ({_os_reason(e)}). " + _render_log_tail(stderr)
                ),
            )
        warnings.extend(
            _strip_render_paths(w, temp_paths) for w in _render_report_warnings(stdout)
        )
        return rendered
    finally:
        shutil.rmtree(work, ignore_errors=True)


@router.post("/process-file")
async def process_file(
    audio: UploadFile = File(...),
    plugin_path: str = Form(...),
    params: str = Form("{}"),
    raw_state: str = Form(""),
    state_host: str = Form(""),
    plugin_name: str = Form(""),
):
    """Process an UPLOADED audio file through one VST3 plugin; return WAV bytes.

    Stateless mirror of /api/studio/process so a VST3 can be one stage of the
    MIX effect chain: the frontend uploads the running audio plus the plugin
    path and receives processed WAV back. The plugin is loaded fresh and
    discarded (never added to the instance registry).
    """
    import soundfile as sf

    path = Path(plugin_path)
    if not path.exists():
        raise HTTPException(
            status_code=404, detail=f"VST3 plugin not found: {plugin_path}"
        )

    mode = (state_host or "").strip().lower() or "pedalboard"
    if mode not in ("pedalboard", "thedaw"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown state_host {state_host!r}: expected 'thedaw' or "
                "'pedalboard' (or no value for the default)."
            ),
        )
    if mode == "thedaw":
        # Our own host renders the file. Deliberately a separate branch: it
        # neither reads nor rewrites the audio here, so the bytes the plugin
        # sees are the bytes that were uploaded.
        host_warnings: list[str] = []
        state_blob: bytes | None = None
        if raw_state:
            if len(raw_state) > _RENDER_MAX_RAW_STATE_CHARS:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"raw_state exceeds the {_RENDER_MAX_RAW_STATE_CHARS} "
                        "byte limit for a thedaw render."
                    ),
                )
            try:
                state_blob = base64.b64decode(raw_state, validate=True)
            except (binascii.Error, ValueError) as e:
                raise HTTPException(
                    status_code=400, detail=f"raw_state was not valid base64: {e}"
                )
        try:
            host_params = json.loads(params) if params else {}
            if not isinstance(host_params, dict):
                host_warnings.append(
                    "params was not a JSON object; no parameters applied"
                )
                host_params = {}
        except json.JSONDecodeError as e:
            host_warnings.append(
                f"params was not valid JSON ({e}); no parameters applied"
            )
            host_params = {}
        max_upload_bytes = _render_max_upload_bytes()
        try:
            uploaded = await _read_upload_capped(audio, max_upload_bytes)
        except _UploadTooLarge:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"The uploaded audio exceeds the {max_upload_bytes} byte "
                    "limit for a thedaw render."
                ),
            )
        except Exception as e:
            raise HTTPException(
                status_code=400, detail=f"Could not read uploaded audio: {e}"
            )
        # Only the spawn+wait needs a thread — everything else here is small,
        # local file I/O that would not meaningfully block the event loop.
        rendered = await asyncio.to_thread(
            _render_with_thedaw_host,
            plugin_path,
            plugin_name,
            uploaded,
            state_blob,
            host_params,
            host_warnings,
        )
        host_headers: dict[str, str] = {}
        if host_warnings:
            host_headers["X-Vst-Warnings"] = json.dumps(
                host_warnings, ensure_ascii=True
            )[:4000]
            host_headers["Access-Control-Expose-Headers"] = "X-Vst-Warnings"
        return Response(content=rendered, media_type="audio/wav", headers=host_headers)

    try:
        data = await audio.read()
        # soundfile returns (frames, channels) float32 — the layout pedalboard expects.
        signal, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Could not read uploaded audio: {e}"
        )

    warnings: list[str] = []
    try:
        param_map = json.loads(params) if params else {}
        if not isinstance(param_map, dict):
            warnings.append("params was not a JSON object; no parameters applied")
            param_map = {}
    except json.JSONDecodeError as e:
        warnings.append(f"params was not valid JSON ({e}); no parameters applied")
        param_map = {}

    try:
        processed = process_with_plugin(
            plugin_path, signal, sr, param_map, raw_state or None, warnings
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VST processing failed: {e}")

    buf = io.BytesIO()
    # Float WAV: this is one stage of a chain, and 16-bit here would requantize
    # the signal at every plugin it passes through.
    sf.write(buf, processed, sr, format="WAV", subtype="FLOAT")
    headers: dict[str, str] = {}
    if warnings:
        # The body is audio, so a state or parameter that did not apply has to
        # ride along in a header, otherwise it renders at defaults in silence.
        headers["X-Vst-Warnings"] = json.dumps(warnings, ensure_ascii=True)[:4000]
        headers["Access-Control-Expose-Headers"] = "X-Vst-Warnings"
    return Response(content=buf.getvalue(), media_type="audio/wav", headers=headers)


@router.post("/open-editor")
def open_editor(req: EditorRequest):
    """Open a VST3 plugin's native GUI in a sidecar process.

    pedalboard's ``show_editor()`` blocks its thread and must run on a process
    main thread, so it runs as a subprocess. On window close the sidecar writes
    the plugin's full state to a per-plugin JSON file; poll ``/editor-result`` to
    read it back and store it on the chain node, so the dialed-in sound is reused
    at process time.
    """
    path = Path(req.plugin_path)
    if not path.exists():
        raise HTTPException(
            status_code=404, detail=f"VST3 plugin not found: {req.plugin_path}"
        )
    _PRESET_DIR.mkdir(parents=True, exist_ok=True)
    out = _preset_path(req.plugin_path)
    # Clear any prior result so the poller tracks THIS session, not a stale one.
    out.write_text(
        json.dumps({"status": "launching", "plugin_path": req.plugin_path}),
        encoding="utf-8",
    )
    # The published editor size belongs to the session too: leaving the old one
    # in place would size this session's scroll area to the last plugin's window.
    for stale in (_size_path(req.plugin_path), _pid_path(req.plugin_path)):
        stale.unlink(missing_ok=True)

    preset_in: Path | None = None
    if req.raw_state:
        preset_in = out.with_suffix(".in.json")
        preset_in.write_text(json.dumps({"raw_state": req.raw_state}), encoding="utf-8")

    repo_root = Path(__file__).resolve().parents[3]
    cmd = [
        sys.executable,
        "-m",
        "backend.modules.vst.editor_sidecar",
        "--plugin-path",
        str(path),
        "--preset-out",
        str(out),
    ]
    if preset_in is not None:
        cmd += ["--preset-in", str(preset_in)]
    if req.plugin_name:
        cmd += ["--plugin-name", req.plugin_name]

    # Embedding: seed the rect file with the initial geometry and hand the sidecar
    # the parent HWND + rect file so its watcher reparents the editor in-window.
    rect_file = _rect_path(req.plugin_path)
    if req.parent_hwnd:
        r = req.rect or {}
        rect_file.write_text(
            json.dumps(
                {
                    "x": r.get("x", 0),
                    "y": r.get("y", 0),
                    "w": r.get("w", 480),
                    "h": r.get("h", 320),
                    "dpr": r.get("dpr", 1),
                    "close": False,
                }
            ),
            encoding="utf-8",
        )
        cmd += [
            "--parent-hwnd",
            str(int(req.parent_hwnd)),
            "--rect-file",
            str(rect_file),
        ]

    # Capture the sidecar's stdout+stderr so editor/embed failures are diagnosable
    # (the editor + watcher run in that subprocess, out of the server's sight).
    log_path = out.with_suffix(".log")
    log_fh = None
    try:
        log_fh = open(log_path, "w")
    except Exception:
        log_fh = None
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(repo_root),
            stdout=log_fh or None,
            stderr=(subprocess.STDOUT if log_fh else None),
            env=child_env(),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not launch editor: {e}")
    finally:
        if log_fh:
            log_fh.close()
    _editor_procs[req.plugin_path] = proc
    # Also on disk, so an editor that outlives a server restart is still
    # recognized as running rather than reported dead.
    _pid_path(req.plugin_path).write_text(str(proc.pid), encoding="utf-8")
    return {"status": "launched", "preset_path": str(out), "log_path": str(log_path)}


@router.post("/editor-rect")
def editor_rect(req: EditorRectRequest):
    """Push a live embed-rect update (or a close request) for an open editor.

    The frontend calls this as the MIX embed area moves/resizes, or with
    close=true to dismiss the embedded editor. The sidecar's watcher polls this
    file and re-positions (or WM_CLOSEs) the reparented window.
    """
    rect_file = _rect_path(req.plugin_path)
    if not rect_file.parent.exists():
        rect_file.parent.mkdir(parents=True, exist_ok=True)
    rect_file.write_text(
        json.dumps(
            {
                "x": req.x,
                "y": req.y,
                "w": req.w,
                "h": req.h,
                "sx": req.sx,
                "sy": req.sy,
                "dpr": req.dpr,
                "close": req.close,
            }
        ),
        encoding="utf-8",
    )
    return {"status": "updated"}


@router.get("/editor-size")
def editor_size(plugin_path: str):
    """Natural (physical px) size of the embedded editor window, published by the
    sidecar watcher so the frontend can size its scroll area. ``{status:'none'}``
    until it is known."""
    size_file = _size_path(plugin_path)
    if not size_file.is_file():
        return {"status": "none"}
    try:
        data = json.loads(size_file.read_text(encoding="utf-8"))
        return {"status": "ok", "w": data.get("w"), "h": data.get("h")}
    except Exception:
        return {"status": "none"}


@router.get("/editor-result")
def editor_result(plugin_path: str):
    """Read the latest captured state from a plugin's editor session.

    Returns ``{"status": "none"|"launching"|"opening"|"ok"|"error", ...}``. When
    ``ok``, includes the base64 ``raw_state`` to store on the chain node. A
    sidecar that died before writing its result is reported as an error here,
    because the in-progress statuses are otherwise terminal and the frontend
    would poll them forever.
    """
    out = _preset_path(plugin_path)
    if not out.is_file():
        return {"status": "none"}
    payload = _read_json(out)
    if payload is None:
        return {"status": "none"}
    if payload.get("status") not in ("launching", "opening"):
        return payload
    if _editor_alive(plugin_path):
        return payload
    # It may have finished between the read and the liveness check.
    settled = _read_json(out)
    if settled is not None and settled.get("status") not in ("launching", "opening"):
        return settled
    error = {
        "status": "error",
        "plugin_path": plugin_path,
        "error": _editor_failure_detail(out),
    }
    # Persist it so every later poll agrees, and drop the stale pid.
    try:
        out.write_text(json.dumps(error), encoding="utf-8")
    except OSError:
        pass
    _pid_path(plugin_path).unlink(missing_ok=True)
    _editor_procs.pop(plugin_path, None)
    log.warning("VST3 editor sidecar died for %s: %s", plugin_path, error["error"])
    return error


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _editor_failure_detail(preset_out: Path) -> str:
    """Explain a dead sidecar using the tail of the log it wrote, when there is one."""
    base = "Editor process exited before the plugin state was captured."
    log_path = preset_out.with_suffix(".log")
    try:
        tail = log_path.read_text(encoding="utf-8", errors="replace").strip()[-400:]
    except OSError:
        tail = ""
    return f"{base} {tail}" if tail else base


@router.get("/param/{instance_id}")
def get_params(instance_id: str):
    """Read all current parameter values on a loaded plugin."""
    try:
        inst = get_instance(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    return {"instance_id": instance_id, "parameters": inst.parameters}


@router.put("/param/{instance_id}")
def set_param(instance_id: str, req: SetParamRequest):
    """Set a single parameter value on a loaded plugin."""
    try:
        inst = get_instance(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    try:
        inst.set_parameter(req.name, req.value)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # Echo what the plugin actually holds now: it may quantize or clamp.
    applied = inst.parameters.get(req.name) or inst.parameters.get(
        param_key(req.name), {}
    )
    return {
        "instance_id": instance_id,
        "name": req.name,
        "value": applied.get("value", req.value),
        "raw_value": applied.get("raw_value"),
        "label": applied.get("label", ""),
    }


@router.delete("/unload/{instance_id}")
def unload_vst(instance_id: str):
    """Unload a plugin instance."""
    try:
        unload_plugin(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    return {"status": "unloaded", "instance_id": instance_id}


@router.get("/builtin")
def builtin_effects():
    """List pedalboard's built-in effects (no VST3 required)."""
    return list_builtin_effects()


def _plugin_dict(p: Vst3PluginInfo) -> dict:
    from dataclasses import asdict

    return asdict(p)


def _plugin_dicts(
    plugins: list[Vst3PluginInfo], include_unloadable: bool
) -> list[dict]:
    if include_unloadable:
        return [_plugin_dict(p) for p in plugins]
    hidden = [p.name for p in plugins if not p.loadable]
    if hidden:
        log.info("Withholding %d VST3 plugin(s) this host cannot load", len(hidden))
    return [_plugin_dict(p) for p in plugins if p.loadable]


# ---------------------------------------------------------------------------
# Live VST hosting — /api/vst/live/*
# ---------------------------------------------------------------------------
# One native ``thedaw-vst-host`` process per live chain entry, so the user's
# real plugin processes the live signal. The backend only spawns, tracks and
# reaps those processes: the browser opens the returned ``ws_url`` itself and
# no audio passes through here. Contract: docs/design/vst-live-protocol.md
# ("Backend API"). The session manager lives in ``live_host.py``.
#
# The import sits with the routes rather than in the header block above so the
# whole feature is one contiguous addition to this file.
from backend.modules.vst import live_host  # noqa: E402
from backend.modules.vst.live_host import LiveHostError  # noqa: E402


class LiveSessionRequest(BaseModel):
    """``POST /api/vst/live/session``.

    Ranges are checked in the manager rather than declared here so that the
    HTTP path and direct callers reject exactly the same things with exactly
    the same messages.
    """

    chain_entry_id: str
    plugin_path: str
    sample_rate: int
    plugin_name: str | None = None
    block_size: int = 512
    channels: int = 2
    # Base64 of the shared VST3 state container — the SAME blob the offline
    # (pedalboard) path stores on the chain entry. Written to the session's
    # state file before the host starts, never logged.
    raw_state: str | None = None


class LiveSessionCreated(BaseModel):
    session_id: str
    ws_url: str
    pid: int
    protocol: int


class LiveSessionInfo(BaseModel):
    session_id: str
    chain_entry_id: str
    # The plugin's file name only: the API never echoes back its directory.
    plugin_file: str
    plugin_name: str | None = None
    sample_rate: int
    block_size: int
    channels: int
    alive: bool
    pid: int
    port: int | None = None
    ws_url: str | None = None
    protocol: int
    started_at: float
    ended_at: float | None = None
    exit_code: int | None = None
    has_state: bool
    log_tail: list[str]


class LiveSessionList(BaseModel):
    sessions: list[LiveSessionInfo]


class LiveSessionClosed(BaseModel):
    session_id: str
    chain_entry_id: str
    exit_code: int | None = None
    # The state the host wrote on its way out, base64, or null when it wrote
    # none (a force-killed host that never got to save).
    raw_state: str | None = None
    log_tail: list[str]


class LiveHostInfo(BaseModel):
    available: bool
    path: str | None = None
    version: str | None = None
    # Why live VST is off, so the UI can say how to turn it on.
    reason: str | None = None


@router.get("/live/host", response_model=LiveHostInfo)
def live_host_status():
    """Whether the native host is built, and if not, why live VST is off."""
    return live_host.get_manager().host_info()


@router.post("/live/session", response_model=LiveSessionCreated)
def create_live_session(req: LiveSessionRequest):
    """Start a host for a chain entry, or return the one it already has."""
    try:
        session = live_host.get_manager().create(
            chain_entry_id=req.chain_entry_id,
            plugin_path=req.plugin_path,
            plugin_name=req.plugin_name,
            sample_rate=req.sample_rate,
            block_size=req.block_size,
            channels=req.channels,
            raw_state=req.raw_state,
        )
    except LiveHostError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return {
        "session_id": session.session_id,
        "ws_url": session.ws_url,
        "pid": session.pid,
        "protocol": session.protocol,
    }


@router.get("/live/sessions", response_model=LiveSessionList)
def list_live_sessions():
    """Every tracked session, including ones that died recently."""
    manager = live_host.get_manager()
    manager.reap()
    return {"sessions": [s.to_dict() for s in manager.list()]}


@router.get("/live/session/{session_id}", response_model=LiveSessionInfo)
def get_live_session(session_id: str):
    """One session's state, with the tail of its host log."""
    manager = live_host.get_manager()
    manager.reap()
    try:
        return manager.get(session_id).to_dict()
    except LiveHostError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.delete("/live/session/{session_id}", response_model=LiveSessionClosed)
def delete_live_session(session_id: str):
    """Shut a host down and return the plugin state it saved on the way out."""
    try:
        return live_host.get_manager().delete(session_id)
    except LiveHostError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
