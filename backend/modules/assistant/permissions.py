"""Permission policy for the Claude Code assistant provider.

Single policy point for the CLI's ``can_use_tool`` control requests. Pure
logic: no filesystem access, no network, no imports from the FastAPI layer.

Requests arrive as ``{tool_name, input, tool_use_id, ...}``. This module
answers three questions about such a request:

* what *kind* of tool is it (``classify``);
* does it touch the assistant's own surface (``self_modify_path``);
* given the user's mode and session state, allow / deny / ask (``decide``).
"""

from __future__ import annotations

import posixpath
import re
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Mode = Literal["ask", "accept_edits", "readonly", "trusted"]
Kind = Literal["read", "edit", "shell", "agent", "mcp", "other"]
Action = Literal["allow", "deny", "ask"]

MODES: tuple[Mode, ...] = ("ask", "accept_edits", "readonly", "trusted")

READ_TOOLS = {
    "Read",
    "Grep",
    "Glob",
    "LS",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "NotebookRead",
}
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell"}
AGENT_TOOLS = {"Agent", "Task"}

#: Baseline ``--allowedTools`` list handed to the CLI at spawn time. Ordered,
#: because it becomes argv. Same membership as :data:`READ_TOOLS`.
READ_BASELINE_TOOLS: tuple[str, ...] = (
    "Read",
    "Grep",
    "Glob",
    "LS",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "NotebookRead",
)

#: Paths whose modification changes the assistant's own tool surface.
SELF_SURFACE_GLOBS = [
    "backend/assistant_routes.py",
    "backend/modules/assistant/**",
    "frontend/src/orb-kit/**",
    "backend/rag.py",
]

#: Paths whose modification requires a backend restart to take effect.
BACKEND_RESTART_GLOBS = ["backend/**/*.py"]

#: MCP tool leaf names with one of these prefixes are treated as reads. The
#: trailing boundary keeps ``getaway_write`` / ``listen_and_delete`` out.
_MCP_READ_PREFIX = re.compile(r"^(get|list|read|status|search|find|describe)(?:_|$)")

_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:/")

_CLI_PERMISSION_MODES: dict[str, str] = {
    "ask": "default",
    "accept_edits": "acceptEdits",
    "readonly": "default",
    "trusted": "bypassPermissions",
}


@dataclass(frozen=True)
class Decision:
    """The policy verdict for one ``can_use_tool`` request."""

    kind: Kind
    action: Action
    reason: str
    self_modify: bool
    self_modify_path: str | None
    backend_restart: bool


def cli_permission_mode(mode: str) -> str:
    """Map a theDAW permission mode onto the CLI's ``--permission-mode`` value."""
    try:
        return _CLI_PERMISSION_MODES[mode]
    except KeyError:
        raise ValueError(f"unknown permission mode: {mode!r}") from None


def classify(tool_name: str, input: dict) -> Kind:  # noqa: A002 - contract name
    """Return the policy kind for a tool request."""
    del input  # kind depends on the tool name alone today
    name = (tool_name or "").strip()
    if name in READ_TOOLS:
        return "read"
    if name in EDIT_TOOLS:
        return "edit"
    if name in SHELL_TOOLS:
        return "shell"
    if name in AGENT_TOOLS:
        return "agent"
    if name.startswith("mcp__"):
        leaf = name.split("__", 2)[2] if name.count("__") >= 2 else ""
        if _MCP_READ_PREFIX.match(leaf):
            return "read"
        return "mcp"
    return "other"


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    out: list[str] = []
    i = 0
    length = len(pattern)
    while i < length:
        char = pattern[i]
        if char == "*":
            if pattern[i : i + 3] == "**/":
                out.append("(?:[^/]+/)*")
                i += 3
                continue
            if pattern[i : i + 2] == "**":
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
            i += 1
            continue
        if char == "?":
            out.append("[^/]")
            i += 1
            continue
        out.append(re.escape(char))
        i += 1
    return re.compile("^" + "".join(out) + "$")


_SELF_SURFACE_RE = [_glob_to_regex(p) for p in SELF_SURFACE_GLOBS]
_BACKEND_RESTART_RE = [_glob_to_regex(p) for p in BACKEND_RESTART_GLOBS]
_SELF_SURFACE_RE_CI = [re.compile(rx.pattern, re.IGNORECASE) for rx in _SELF_SURFACE_RE]
_BACKEND_RESTART_RE_CI = [
    re.compile(rx.pattern, re.IGNORECASE) for rx in _BACKEND_RESTART_RE
]


def _case_insensitive(repo_root: Path) -> bool:
    """Whether the repo lives on a case-insensitive (Windows) filesystem.

    NTFS resolves ``Backend/RAG.py`` to ``backend/rag.py``, so a case-sensitive
    glob match there would let a mixed-case path skip the self-modify bubble.
    A drive-letter root is a Windows path wherever this code happens to run.
    """
    if sys.platform == "win32":
        return True
    root = str(repo_root).replace("\\", "/").rstrip("/") + "/"
    return bool(_WINDOWS_DRIVE.match(root))


def _is_self_surface(rel: str, insensitive: bool) -> bool:
    patterns = _SELF_SURFACE_RE_CI if insensitive else _SELF_SURFACE_RE
    return any(rx.match(rel) for rx in patterns)


def _is_backend_restart(rel: str, insensitive: bool) -> bool:
    patterns = _BACKEND_RESTART_RE_CI if insensitive else _BACKEND_RESTART_RE
    return any(rx.match(rel) for rx in patterns)


def _repo_relative(raw: str, repo_root: Path) -> str | None:
    """Normalise ``raw`` to a repo-relative POSIX path, or ``None`` if outside.

    Pure string work — never touches the filesystem. Handles Windows absolute
    paths, Windows relative paths, POSIX paths, and quoted shell tokens.
    """
    text = (raw or "").strip().strip("\"'").strip()
    if not text:
        return None
    # Collapse `..` BEFORE the prefix comparison, otherwise
    # `C:/repo/../repo/backend/rag.py` slips past the root check.
    text = posixpath.normpath(text.replace("\\", "/"))
    root = posixpath.normpath(str(repo_root).replace("\\", "/")).rstrip("/")

    if text.startswith("/") or _WINDOWS_DRIVE.match(text):
        if not root:
            return None
        prefix = root + "/"
        if text.lower().startswith(prefix.lower()):
            rel = text[len(prefix) :]
        elif text.lower() == root.lower():
            return None
        else:
            return None
    else:
        rel = text

    rel = posixpath.normpath(rel)
    if rel in (".", "") or rel == ".." or rel.startswith("../"):
        return None
    if rel.startswith("/") or _WINDOWS_DRIVE.match(rel):
        return None
    return rel


def _candidate_paths(tool_name: str, input: dict, repo_root: Path) -> list[str]:  # noqa: A002
    """Every repo-relative path this request could write to."""
    kind = classify(tool_name, input)
    raw_values: list[str] = []

    if kind == "edit":
        for key in ("file_path", "notebook_path"):
            value = input.get(key) if isinstance(input, dict) else None
            if isinstance(value, str):
                raw_values.append(value)
    elif kind == "shell":
        command = input.get("command") if isinstance(input, dict) else None
        if isinstance(command, str) and command.strip():
            for token in _shell_tokens(command):
                raw_values.extend(_token_variants(token))

    seen: set[str] = set()
    paths: list[str] = []
    for raw in raw_values:
        rel = _repo_relative(raw, repo_root)
        if rel and rel not in seen:
            seen.add(rel)
            paths.append(rel)
    return paths


_SHELL_SEPARATORS = re.compile(r"[;&|()]+")


def _token_variants(token: str) -> list[str]:
    """Split a shell token into every substring that could name a file.

    ``shlex`` does not split on shell operators, so the path arrives glued to
    them: redirects and flag values (``>backend/rag.py``, ``2>>backend/rag.py``,
    ``--output=backend/rag.py``, ``of=backend/rag.py``, ``--out:backend/rag.py``,
    ``<backend/rag.py``) and command separators (``backend/rag.py;``,
    ``backend/rag.py&&ls``, ``>|backend/rag.py``, ``(echo x >backend/rag.py)``).
    The raw token alone never matches a glob, so every piece is offered.
    """
    pieces = [token, *(p for p in _SHELL_SEPARATORS.split(token) if p)]
    variants: list[str] = []
    for piece in pieces:
        candidates = [piece]
        for sep in (">", "=", ":"):
            _head, found, tail = piece.rpartition(sep)
            if found and tail:
                candidates.append(tail)
        stripped = piece.lstrip("<")
        if stripped != piece and stripped:
            candidates.append(stripped)
        variants.extend(candidates)
    return list(dict.fromkeys(variants))


def _shell_tokens(command: str) -> list[str]:
    posix = sys.platform != "win32"
    try:
        return shlex.split(command, posix=posix)
    except ValueError:
        return command.split()


def self_modify_path(
    tool_name: str,
    input: dict,  # noqa: A002 - contract name
    repo_root: Path,
) -> str | None:
    """Return the repo-relative path of a self-surface write, else ``None``.

    The path keeps the caller's casing so the permission bubble shows what the
    model actually asked to write.
    """
    insensitive = _case_insensitive(repo_root)
    for rel in _candidate_paths(tool_name, input, repo_root):
        if _is_self_surface(rel, insensitive):
            return rel
    return None


def decide(
    mode: str,
    tool_name: str,
    input: dict,  # noqa: A002 - contract name
    *,
    session_allow: set[str],
    deny_count: int,
    repo_root: Path,
) -> Decision:
    """Apply the C3 rules, in order, to one ``can_use_tool`` request.

    ``deny_count`` is supplied by the caller, keyed on
    ``(tool_name, json.dumps(input, sort_keys=True))``.
    """
    if mode not in _CLI_PERMISSION_MODES:
        raise ValueError(f"unknown permission mode: {mode!r}")

    kind = classify(tool_name, input)
    paths = _candidate_paths(tool_name, input, repo_root)
    insensitive = _case_insensitive(repo_root)
    self_path = next(
        (rel for rel in paths if _is_self_surface(rel, insensitive)),
        None,
    )
    backend_restart = any(_is_backend_restart(rel, insensitive) for rel in paths)

    def verdict(action: Action, reason: str) -> Decision:
        return Decision(
            kind=kind,
            action=action,
            reason=reason,
            self_modify=self_path is not None,
            self_modify_path=self_path,
            backend_restart=backend_restart,
        )

    # 1. Read-only mode short-circuits everything, including self-modification.
    if mode == "readonly":
        if kind == "read":
            return verdict("allow", "Read-only mode allows read-only tools")
        return verdict("deny", "Read-only mode")

    # 2. Self-modification always bubbles, and is never remembered.
    if self_path is not None:
        return verdict("ask", f"Modifies the assistant's own surface: {self_path}")

    # 3. Trusted mode allows the rest.
    if mode == "trusted":
        return verdict("allow", "Trusted mode")

    # 4. Explicitly allowed for this session.
    if tool_name in session_allow:
        return verdict("allow", "Allowed for this session")

    # 5. Declined three times for the identical (tool, input).
    if deny_count >= 3:
        return verdict("deny", "declined 3× — not asking again")

    # 6. Accept-edits allows reads and edits that stay inside the repo.
    if mode == "accept_edits":
        if kind == "read":
            return verdict("allow", "Accept-edits mode allows read-only tools")
        if kind == "edit" and paths:
            return verdict("allow", "Accept-edits mode allows edits inside the repo")
        return verdict("ask", "Accept-edits mode asks for this tool")

    # 7. Ask mode: reads are free, everything else bubbles.
    if kind == "read":
        return verdict("allow", "Read-only tool")
    return verdict("ask", "Ask mode requires approval for this tool")
