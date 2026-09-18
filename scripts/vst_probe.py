"""Open an installed VST3 in a plain, UNEMBEDDED pedalboard process.

This is the diagnostic that separates "the plugin's own GUI is broken under
pedalboard" from "theDAW's window embedding broke it". Nothing here reparents,
owns, clips or resizes anything: the editor opens as an ordinary floating
window, exactly as ``pedalboard`` opens it. If the plugin behaves here and
misbehaves inside theDAW, the fault is in the embedding (win_embed.py); if it
misbehaves here too, the fault is below us, in pedalboard or the plugin.

It installs NOTHING, downloads nothing and talks to no network service; it only
reads the .vst3 you point it at and writes the files you ask for. Run it with
the project's own environment::

    uv run python scripts/vst_probe.py --plugin "C:/Program Files/Common Files/VST3/Ozone 11.vst3"

Ported from docs/design/repair-pack/repair/python/vst_probe.py.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

EXIT_OK = 0
EXIT_USAGE = 2  # also argparse's own code for a bad command line
EXIT_NO_PEDALBOARD = 3
EXIT_LOAD_FAILED = 4
EXIT_EDITOR_FAILED = 5
EXIT_STATE_FAILED = 6

_EPILOG = """\
exit codes:
  0  OK — for a GUI run, the editor opened AND was closed by you
  2  bad command line, or --plugin does not exist
  3  pedalboard could not be imported (wrong environment; use `uv run`)
  4  the plugin could not be loaded (a wrong --plugin-name lands here; the
     error lists the names the file actually contains)
  5  show_editor() raised — pedalboard/the plugin refused to open a GUI
  6  the plugin state could not be read back, or --state-out could not be written

  Any OTHER exit code came from the operating system, not from this script: the
  plugin crashed its host process natively (on Windows e.g. 3221225477 /
  -1073741819 = 0xC0000005 access violation). There is no Python traceback for
  those, so every stage prints a line to stderr first — the LAST stage line you
  see is the one that killed it.

identity fields are read straight off the loaded plugin, so the report answers
"which plugin did I actually just open?" for multi-plugin .vst3 shells.
"""


def _stage(name: str) -> None:
    """Announce a stage on stderr before entering it.

    A native crash takes the process down with no traceback; the last stage line
    is then the only evidence of where it died.
    """
    print(f"[vst_probe] {name}", file=sys.stderr, flush=True)


def _write_atomic(path: Path, text: str) -> None:
    """Write via a temp file in the same directory + os.replace.

    A half-written report is worse than no report: the caller cannot tell a
    truncated state blob from a plugin that returned one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=f"{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _pedalboard_version(pedalboard) -> str:
    try:
        import importlib.metadata

        return importlib.metadata.version("pedalboard")
    except Exception:
        return str(getattr(pedalboard, "__version__", "unknown"))


def _identity(plugin) -> dict[str, str]:
    out: dict[str, str] = {}
    for field in ("name", "identifier", "version", "manufacturer_name", "category"):
        try:
            value = getattr(plugin, field, None)
        except Exception:
            value = None
        if value is not None:
            out[field] = str(value)
    return out


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="vst_probe.py",
        description=__doc__,
        epilog=_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--plugin", type=Path, required=True, help="path to the .vst3")
    ap.add_argument(
        "--plugin-name",
        default=None,
        help="sub-plugin to open inside a multi-plugin .vst3 (no fallback: a name "
        "the file does not contain is an error, not a different plugin)",
    )
    ap.add_argument(
        "--list-only",
        action="store_true",
        help="print the file's plugin names and the loaded plugin's identity, "
        "then exit — no GUI is opened",
    )
    ap.add_argument(
        "--state-out",
        type=Path,
        default=None,
        help="write the JSON report (including the base64 raw_state) to this path, "
        "atomically",
    )
    return ap.parse_args(argv)


def _finish(report: dict, state_out: Path | None, code: int) -> int:
    """Print the report to stdout, optionally persist it, return the exit code."""
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    report["exit_code"] = code
    text = json.dumps(report, indent=2, ensure_ascii=False)
    print(text, flush=True)
    if state_out is not None:
        try:
            _write_atomic(state_out, text)
            _stage(f"wrote {state_out}")
        except Exception as e:
            print(f"[vst_probe] could not write {state_out}: {e}", file=sys.stderr)
            return EXIT_STATE_FAILED
    return code


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    state_out: Path | None = args.state_out

    report: dict = {
        "status": "started",
        "plugin_path": str(args.plugin),
        "requested_plugin_name": args.plugin_name,
        "list_only": bool(args.list_only),
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        plugin_path = args.plugin.resolve(strict=True)
    except OSError as e:
        report.update(status="failed", error=f"--plugin not found: {e}")
        return _finish(report, state_out, EXIT_USAGE)
    report["plugin_path"] = str(plugin_path)

    _stage("importing pedalboard")
    try:
        import pedalboard
    except Exception as e:
        report.update(status="failed", error=f"pedalboard import failed: {e}")
        return _finish(report, state_out, EXIT_NO_PEDALBOARD)
    report["pedalboard_version"] = _pedalboard_version(pedalboard)

    _stage("reading plugin names from the file")
    try:
        names = list(pedalboard.VST3Plugin.get_plugin_names_for_file(str(plugin_path)))
    except Exception as e:
        names = []
        report["plugin_names_error"] = f"{type(e).__name__}: {e}"
    report["plugins_in_file"] = names

    _stage(f"loading plugin (plugin_name={args.plugin_name!r})")
    try:
        if args.plugin_name:
            plugin = pedalboard.load_plugin(
                str(plugin_path), plugin_name=args.plugin_name
            )
        else:
            plugin = pedalboard.load_plugin(str(plugin_path))
    except Exception as e:
        report.update(
            status="failed",
            error=f"load failed: {type(e).__name__}: {e}",
            hint=(
                f"the file contains {names}"
                if names
                else "pedalboard could not list the file's plugins either"
            ),
        )
        return _finish(report, state_out, EXIT_LOAD_FAILED)

    report["identity"] = _identity(plugin)
    try:
        report["parameter_names"] = list(plugin.parameters)
    except Exception as e:
        report["parameter_names_error"] = f"{type(e).__name__}: {e}"

    _stage("reading raw_state (before)")
    try:
        before = bytes(plugin.raw_state)
    except Exception as e:
        report.update(
            status="failed", error=f"state read failed: {type(e).__name__}: {e}"
        )
        return _finish(report, state_out, EXIT_STATE_FAILED)
    report["before_sha256"] = hashlib.sha256(before).hexdigest()
    report["before_bytes"] = len(before)

    if args.list_only:
        report.update(
            status="listed", raw_state=base64.b64encode(before).decode("ascii")
        )
        _stage("--list-only: no GUI opened")
        return _finish(report, state_out, EXIT_OK)

    # FLOATING ONLY. No parent HWND, no SetWindowPos, no SetWindowRgn — that is
    # the entire point of this script. show_editor() blocks the main thread
    # (which is why it runs here and not inside the server) until you close it.
    _stage("show_editor() — close the plugin window to continue")
    try:
        plugin.show_editor()
    except Exception as e:
        report.update(
            status="failed", error=f"editor unavailable: {type(e).__name__}: {e}"
        )
        return _finish(report, state_out, EXIT_EDITOR_FAILED)
    _stage("show_editor() returned (window closed)")

    _stage("reading raw_state (after)")
    try:
        after = bytes(plugin.raw_state)
    except Exception as e:
        report.update(
            status="failed", error=f"state capture failed: {type(e).__name__}: {e}"
        )
        return _finish(report, state_out, EXIT_STATE_FAILED)

    report.update(
        status="complete",
        after_sha256=hashlib.sha256(after).hexdigest(),
        after_bytes=len(after),
        state_changed=before != after,
        raw_state=base64.b64encode(after).decode("ascii"),
    )
    return _finish(report, state_out, EXIT_OK)


if __name__ == "__main__":
    sys.exit(main())
