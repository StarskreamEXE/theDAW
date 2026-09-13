"""Show a file or folder in the OS file manager, selected.

Every "Show in folder" button in the app ends here, so the three platform
spellings live in one place.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

__all__ = ["reveal"]


def reveal(path: str | os.PathLike[str]) -> str:
    """Open the file manager at ``path`` with it selected. Returns the path shown.

    Raises FileNotFoundError when nothing is there. An OSError from starting
    the file manager propagates, so a route can answer the two cases apart.
    """
    text = os.fspath(path)
    if not isinstance(text, str) or not text.strip() or "\x00" in text:
        raise FileNotFoundError(str(text))
    # Absolute and normalized: Explorer's /select needs backslashes and a full
    # path, and opens the default folder when handed anything else.
    target = Path(os.path.abspath(os.path.expanduser(text)))
    try:
        exists = target.exists()
    except (OSError, ValueError):
        exists = False
    if not exists:
        raise FileNotFoundError(str(target))

    if sys.platform == "win32":
        subprocess.Popen(["explorer", f"/select,{target}"])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target.parent)])
    return str(target)
