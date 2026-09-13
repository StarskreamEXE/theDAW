"""Native OS folder and file dialogs.

Lets the user click through to choose a folder or file instead of typing a
path. Windows-first: a PowerShell WinForms dialog forced topmost and run in an
STA, out-of-process so it can never block or corrupt the FastAPI server's
threads. Falls back to tkinter elsewhere (best effort).

Each ``pick_*`` function returns the chosen absolute path, or ``None`` when the
user cancels. A dialog that could not open, failed while open, or got no answer
within ``_DIALOG_TIMEOUT_SEC`` raises ``PickerError``, and its ``timed_out`` marks
the last case, so a caller can tell a failure apart from the user's cancel.
``picker_available`` tells a caller beforehand whether a dialog can open at all;
on a machine without tkinter the tkinter dialogs answer ``None``.

PowerShell writes the chosen path as UTF-8 and it is decoded as UTF-8, so a
folder with accented or non-Latin characters comes back intact.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from typing import Any, Optional

log = logging.getLogger(__name__)

# A blocking native dialog can sit open for a long time while the user
# navigates; give them a generous window before we give up on it.
_DIALOG_TIMEOUT_SEC = 600.0

# First statement of every PowerShell dialog script. Without it the path is
# written in the console code page and a non-ASCII name arrives garbled.
_PS_UTF8 = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"

# Exit code of a PowerShell dialog script whose user cancelled. A script that
# writes the chosen path exits 0, and one that fails exits 1 with the error
# text on stderr.
_CANCEL_EXIT = 3

# The longest PowerShell error text a PickerError carries.
_MAX_ERROR_CHARS = 500


class PickerError(RuntimeError):
    """A native dialog that could not open, failed while open, or got no answer
    in time. ``timed_out`` is true for the last."""

    def __init__(self, message: str, *, timed_out: bool = False) -> None:
        super().__init__(message)
        self.timed_out = timed_out

    @property
    def status_code(self) -> int:
        """The HTTP status a route answers this failure with: 504 for a dialog
        that got no answer in time, else 500.

        A timeout is never 408: Chromium resends a request answered 408 on a
        reused HTTP/1.1 connection, which would open the dialog again."""
        return 504 if self.timed_out else 500


def picker_available() -> bool:
    """Whether this machine can show a native dialog: PowerShell on Windows,
    tkinter elsewhere, and on Linux a display for it to open on."""
    if sys.platform == "win32":
        return shutil.which("powershell.exe") is not None
    if sys.platform != "darwin" and not (
        os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    ):
        return False
    try:
        import tkinter  # noqa: F401
    except Exception:  # noqa: BLE001 — headless / no Tk available
        return False
    return True


def _run_powershell(script: list[str], what: str) -> Optional[str]:
    """Run a dialog script in an STA PowerShell and return the path it wrote.

    ``None`` means the script took its cancel exit (``_CANCEL_EXIT``). Anything
    else without a path raises PickerError: PowerShell could not start, the
    dialog was still open at ``_DIALOG_TIMEOUT_SEC`` (``timed_out``), or the
    script failed, in which case the error PowerShell wrote is the message.
    """
    command = " ".join(
        [
            _PS_UTF8,
            # 'Stop' hands every error to the catch, so a failed Add-Type or
            # New-Object exits 1 with its message and never exits like a cancel.
            "$ErrorActionPreference = 'Stop';",
            "try {",
            *script,
            "} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }",
        ]
    )
    cmd = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        command,
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_DIALOG_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired as e:
        log.warning("folder_dialog: PowerShell %s timed out", what)
        raise PickerError(
            f"The {what} was closed after {_DIALOG_TIMEOUT_SEC:g} seconds "
            "without an answer.",
            timed_out=True,
        ) from e
    except OSError as e:
        log.warning("folder_dialog: PowerShell %s failed to start: %s", what, e)
        raise PickerError(f"PowerShell could not open the {what}: {e}") from e
    path = (proc.stdout or "").strip().lstrip("\ufeff")
    if path:
        return path
    if proc.returncode == _CANCEL_EXIT:
        return None
    message = (proc.stderr or "").strip().lstrip("\ufeff")[:_MAX_ERROR_CHARS]
    log.warning(
        "folder_dialog: PowerShell %s exited %s: %s", what, proc.returncode, message
    )
    raise PickerError(
        message or f"The {what} ended without an answer (exit code {proc.returncode})."
    )


def _ps_show(result: str) -> list[str]:
    """The end of every dialog script: show ``$f``, then write ``result`` or take
    the cancel exit.

    Owning the dialog with a TopMost form forces it above theDAW so it never
    opens hidden behind the app window."""
    return [
        "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true};",
        "$r = $f.ShowDialog($owner);",
        "$owner.Dispose();",
        "if ($r -ne [System.Windows.Forms.DialogResult]::OK) {",
        f"exit {_CANCEL_EXIT}",
        "};",
        f"[Console]::Out.Write({result});",
    ]


def _run_tk(what: str, ask: Callable[[Any], Any]) -> Optional[str]:
    """Show a tkinter dialog through ``ask(filedialog)`` on a hidden topmost root.

    ``None`` means the user cancelled, or tkinter cannot be imported here. An
    exception while the dialog opens or is shown raises PickerError."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as e:  # noqa: BLE001 — headless / no Tk available
        log.warning("folder_dialog: tkinter unavailable: %s", e)
        return None
    root = None
    try:
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:  # noqa: BLE001 — topmost is cosmetic
            pass
        path = ask(filedialog)
    except Exception as e:  # noqa: BLE001 — no display / not main thread
        log.warning("folder_dialog: tkinter %s failed: %s", what, e)
        raise PickerError(f"The {what} could not open: {e}") from e
    finally:
        if root is not None:
            try:
                root.destroy()
            except Exception:  # noqa: BLE001 — the dialog has already answered
                pass
    return path if isinstance(path, str) and path else None


def pick_folder(
    title: str = "Select folder", initial: Optional[str] = None
) -> Optional[str]:
    """Open a native folder picker and return the chosen absolute path.

    ``None`` means the user cancelled or no picker is available; a dialog that
    fails raises PickerError.
    """
    plat: str = sys.platform
    if plat == "win32":
        return _pick_folder_windows(title, initial)
    return _pick_folder_tk(title, initial)


def pick_save_file(
    title: str = "Save as",
    initial_dir: Optional[str] = None,
    initial_name: Optional[str] = None,
    default_ext: Optional[str] = None,
    filter_spec: Optional[str] = None,
) -> Optional[str]:
    """Open a native *Save As* dialog and return the chosen absolute path.

    ``None`` means the user cancelled or no picker is available; a dialog that
    fails raises PickerError. ``filter_spec`` is a Windows-style filter
    (``"theDAW project (*.tasmo)|*.tasmo|All files (*.*)|*.*"``); the tkinter
    fallback parses it into filetypes.
    """
    plat: str = sys.platform
    if plat == "win32":
        return _pick_save_windows(
            title, initial_dir, initial_name, default_ext, filter_spec
        )
    return _pick_save_tk(title, initial_dir, initial_name, default_ext, filter_spec)


def pick_open_file(
    title: str = "Open file",
    initial_dir: Optional[str] = None,
    filter_spec: Optional[str] = None,
) -> Optional[str]:
    """Open a native *Open file* dialog and return the chosen absolute path.

    ``None`` means the user cancelled or no picker is available; a dialog that
    fails raises PickerError. ``filter_spec`` is a Windows-style filter
    (``"Android package (*.apk)|*.apk|All files (*.*)|*.*"``); the tkinter
    fallback parses it into filetypes.
    """
    plat: str = sys.platform
    if plat == "win32":
        return _pick_open_windows(title, initial_dir, filter_spec)
    return _pick_open_tk(title, initial_dir, filter_spec)


def _ps_quote(value: str) -> str:
    """Single-quote a string for safe interpolation into PowerShell."""
    return "'" + value.replace("'", "''") + "'"


def _pick_save_windows(
    title: str,
    initial_dir: Optional[str],
    initial_name: Optional[str],
    default_ext: Optional[str],
    filter_spec: Optional[str],
) -> Optional[str]:
    script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$f = New-Object System.Windows.Forms.SaveFileDialog;",
        f"$f.Title = {_ps_quote(title)};",
        "$f.AddExtension = $true;",
        "$f.OverwritePrompt = $true;",
    ]
    if initial_dir:
        script.append(f"$f.InitialDirectory = {_ps_quote(initial_dir)};")
    if initial_name:
        script.append(f"$f.FileName = {_ps_quote(initial_name)};")
    if default_ext:
        script.append(f"$f.DefaultExt = {_ps_quote(default_ext.lstrip('.'))};")
    if filter_spec:
        script.append(f"$f.Filter = {_ps_quote(filter_spec)};")
    script += _ps_show("$f.FileName")
    return _run_powershell(script, "Save dialog")


def _parse_filetypes(filter_spec: Optional[str]) -> list[tuple[str, str]]:
    """Turn a Windows filter string into tkinter filetypes pairs."""
    if not filter_spec:
        return []
    parts = [p for p in filter_spec.split("|")]
    pairs: list[tuple[str, str]] = []
    for i in range(0, len(parts) - 1, 2):
        pairs.append((parts[i], parts[i + 1]))
    return pairs


def _pick_save_tk(
    title: str,
    initial_dir: Optional[str],
    initial_name: Optional[str],
    default_ext: Optional[str],
    filter_spec: Optional[str],
) -> Optional[str]:
    return _run_tk(
        "Save dialog",
        lambda filedialog: filedialog.asksaveasfilename(
            title=title,
            initialdir=initial_dir or None,
            initialfile=initial_name or None,
            defaultextension=(f".{default_ext.lstrip('.')}" if default_ext else None),
            filetypes=_parse_filetypes(filter_spec) or None,
        ),
    )


def _pick_folder_windows(title: str, initial: Optional[str]) -> Optional[str]:
    script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog;",
        f"$f.Description = {_ps_quote(title)};",
        "$f.ShowNewFolderButton = $true;",
    ]
    if initial:
        script.append(f"$f.SelectedPath = {_ps_quote(initial)};")
    script += _ps_show("$f.SelectedPath")
    return _run_powershell(script, "folder dialog")


def _pick_folder_tk(title: str, initial: Optional[str]) -> Optional[str]:
    return _run_tk(
        "folder dialog",
        lambda filedialog: filedialog.askdirectory(
            title=title, initialdir=initial or None
        ),
    )


def _pick_open_windows(
    title: str, initial_dir: Optional[str], filter_spec: Optional[str]
) -> Optional[str]:
    script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$f = New-Object System.Windows.Forms.OpenFileDialog;",
        f"$f.Title = {_ps_quote(title)};",
        "$f.Multiselect = $false;",
        "$f.CheckFileExists = $true;",
    ]
    if initial_dir:
        script.append(f"$f.InitialDirectory = {_ps_quote(initial_dir)};")
    if filter_spec:
        script.append(f"$f.Filter = {_ps_quote(filter_spec)};")
    script += _ps_show("$f.FileName")
    return _run_powershell(script, "Open dialog")


def _pick_open_tk(
    title: str, initial_dir: Optional[str], filter_spec: Optional[str]
) -> Optional[str]:
    return _run_tk(
        "Open dialog",
        lambda filedialog: filedialog.askopenfilename(
            title=title,
            initialdir=initial_dir or None,
            filetypes=_parse_filetypes(filter_spec) or None,
        ),
    )
