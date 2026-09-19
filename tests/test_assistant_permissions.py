"""Permission policy tests for the Claude Code assistant (plan contract C3)."""

from pathlib import Path

import pytest

from backend.modules.assistant.permissions import (
    AGENT_TOOLS,
    EDIT_TOOLS,
    READ_BASELINE_TOOLS,
    READ_TOOLS,
    SHELL_TOOLS,
    Decision,
    classify,
    cli_permission_mode,
    decide,
    self_modify_path,
)

REPO_ROOT = Path("C:/proj/theDAW")

# (case id, tool_name, input)
CASES: dict[str, tuple[str, dict]] = {
    "read": ("Read", {"file_path": "README.md"}),
    "edit_in_repo": (
        "Edit",
        {"file_path": "frontend/src/components/audio/WaveformEditor.tsx"},
    ),
    "edit_self_frontend": (
        "Write",
        {"file_path": "frontend/src/orb-kit/AssistantPanel.tsx"},
    ),
    "edit_self_backend": ("Edit", {"file_path": "backend/assistant_routes.py"}),
    "shell": ("Bash", {"command": "uv run pytest -q"}),
    "shell_self": (
        "Bash",
        {"command": "sed -i s/a/b/ backend/modules/assistant/permissions.py"},
    ),
    "agent": ("Task", {"prompt": "investigate the failing suite"}),
    "mcp_read": ("mcp__serena__get_diagnostics_for_file", {"relative_path": "x.py"}),
    "mcp_write": ("mcp__memory__create_entities", {"entities": []}),
}

EXPECTED_KIND = {
    "read": "read",
    "edit_in_repo": "edit",
    "edit_self_frontend": "edit",
    "edit_self_backend": "edit",
    "shell": "shell",
    "shell_self": "shell",
    "agent": "agent",
    "mcp_read": "read",
    "mcp_write": "mcp",
}

# mode -> case id -> expected action
MATRIX: dict[str, dict[str, str]] = {
    "readonly": {
        "read": "allow",
        "edit_in_repo": "deny",
        "edit_self_frontend": "deny",
        "edit_self_backend": "deny",
        "shell": "deny",
        "shell_self": "deny",
        "agent": "deny",
        "mcp_read": "allow",
        "mcp_write": "deny",
    },
    "ask": {
        "read": "allow",
        "edit_in_repo": "ask",
        "edit_self_frontend": "ask",
        "edit_self_backend": "ask",
        "shell": "ask",
        "shell_self": "ask",
        "agent": "ask",
        "mcp_read": "allow",
        "mcp_write": "ask",
    },
    "accept_edits": {
        "read": "allow",
        "edit_in_repo": "allow",
        "edit_self_frontend": "ask",
        "edit_self_backend": "ask",
        "shell": "ask",
        "shell_self": "ask",
        "agent": "ask",
        "mcp_read": "allow",
        "mcp_write": "ask",
    },
    "trusted": {
        "read": "allow",
        "edit_in_repo": "allow",
        "edit_self_frontend": "ask",
        "edit_self_backend": "ask",
        "shell": "allow",
        "shell_self": "ask",
        "agent": "allow",
        "mcp_read": "allow",
        "mcp_write": "allow",
    },
}

SELF_MODIFY_CASES = {"edit_self_frontend", "edit_self_backend", "shell_self"}
BACKEND_RESTART_CASES = {"edit_self_backend", "shell_self"}


def _decide(mode: str, case_id: str, **kwargs) -> Decision:
    tool_name, tool_input = CASES[case_id]
    params = {
        "session_allow": set(),
        "deny_count": 0,
        "repo_root": REPO_ROOT,
    }
    params.update(kwargs)
    return decide(mode, tool_name, tool_input, **params)


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_classify_matches_contract_kinds(case_id):
    tool_name, tool_input = CASES[case_id]

    assert classify(tool_name, tool_input) == EXPECTED_KIND[case_id]


@pytest.mark.parametrize("mode", sorted(MATRIX))
@pytest.mark.parametrize("case_id", sorted(CASES))
def test_full_mode_matrix(mode, case_id):
    decision = _decide(mode, case_id)

    assert decision.action == MATRIX[mode][case_id]
    assert decision.kind == EXPECTED_KIND[case_id]
    assert decision.reason


@pytest.mark.parametrize("mode", sorted(MATRIX))
@pytest.mark.parametrize("case_id", sorted(CASES))
def test_self_modify_flags_are_reported_in_every_mode(mode, case_id):
    decision = _decide(mode, case_id)

    assert decision.self_modify is (case_id in SELF_MODIFY_CASES)
    assert decision.backend_restart is (case_id in BACKEND_RESTART_CASES)
    if case_id in SELF_MODIFY_CASES:
        assert decision.self_modify_path is not None
    else:
        assert decision.self_modify_path is None


def test_self_modify_asks_in_trusted_mode_and_is_never_remembered():
    decision = _decide(
        "trusted",
        "edit_self_backend",
        session_allow={"Edit"},
        deny_count=9,
    )

    assert decision.action == "ask"
    assert decision.self_modify is True
    assert decision.self_modify_path == "backend/assistant_routes.py"
    assert decision.backend_restart is True


def test_readonly_denies_self_modify_and_never_asks():
    decision = _decide("readonly", "edit_self_backend")

    assert decision.action == "deny"
    assert decision.reason == "Read-only mode"
    assert decision.self_modify is True


def test_session_allow_short_circuits_ask_mode():
    decision = _decide("ask", "shell", session_allow={"Bash"})

    assert decision.action == "allow"

    without = _decide("ask", "shell", session_allow={"Write"})

    assert without.action == "ask"


def test_deny_count_of_three_stops_asking():
    twice = _decide("ask", "shell", deny_count=2)
    thrice = _decide("ask", "shell", deny_count=3)

    assert twice.action == "ask"
    assert thrice.action == "deny"
    assert thrice.reason == "declined 3\u00d7 — not asking again"


def test_session_allow_wins_over_deny_count():
    decision = _decide("ask", "shell", session_allow={"Bash"}, deny_count=5)

    assert decision.action == "allow"


def test_windows_absolute_path_normalises_to_repo_relative_posix():
    result = self_modify_path(
        "Edit",
        {"file_path": "C:\\proj\\theDAW\\backend\\assistant_routes.py"},
        REPO_ROOT,
    )

    assert result == "backend/assistant_routes.py"


def test_windows_absolute_path_decides_as_self_modify():
    decision = decide(
        "accept_edits",
        "Edit",
        {"file_path": "C:\\proj\\theDAW\\frontend\\src\\orb-kit\\useChatStream.ts"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify is True
    assert decision.self_modify_path == "frontend/src/orb-kit/useChatStream.ts"
    assert decision.backend_restart is False


def test_notebook_edit_uses_notebook_path():
    result = self_modify_path(
        "NotebookEdit",
        {"notebook_path": "backend/modules/assistant/scratch.ipynb"},
        REPO_ROOT,
    )

    assert result == "backend/modules/assistant/scratch.ipynb"


def test_path_outside_repo_is_not_self_modify_and_still_asks():
    decision = decide(
        "accept_edits",
        "Write",
        {"file_path": "D:\\elsewhere\\backend\\assistant_routes.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert decision.self_modify_path is None
    assert decision.action == "ask"


def test_backend_restart_true_for_ordinary_backend_python_edit():
    decision = _decide("ask", "edit_in_repo")
    backend_edit = decide(
        "ask",
        "Edit",
        {"file_path": "backend/modules/midi/engine.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.backend_restart is False
    assert backend_edit.backend_restart is True
    assert backend_edit.self_modify is False


def test_read_tool_on_self_surface_is_not_self_modify():
    decision = _decide("ask", "read")
    reading_self = decide(
        "ask",
        "Read",
        {"file_path": "backend/assistant_routes.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert reading_self.self_modify is False
    assert reading_self.action == "allow"


@pytest.mark.parametrize(
    "tool_name,expected",
    [
        ("mcp__serena__list_dir", "read"),
        ("mcp__docs-mcp-server__search_docs", "read"),
        ("mcp__deepwiki__read_wiki_contents", "read"),
        ("mcp__everything-search__find_files", "read"),
        ("mcp__serena__get", "read"),
        ("mcp__playwright__browser_click", "mcp"),
        ("mcp__memory__delete_entities", "mcp"),
        # Boundary: a read prefix glued to more letters is NOT a read (B3).
        ("mcp__serena__getaway_write", "mcp"),
        ("mcp__serena__listen_and_delete", "mcp"),
        ("mcp__serena__finder_destroy", "mcp"),
    ],
)
def test_mcp_tool_name_prefix_classification(tool_name, expected):
    assert classify(tool_name, {}) == expected


def test_unknown_tool_is_other():
    assert classify("SomeFutureTool", {}) == "other"
    assert classify("", {}) == "other"


def test_shell_self_surface_detection_handles_quoted_windows_token():
    result = self_modify_path(
        "Bash",
        {"command": 'python "C:\\proj\\theDAW\\backend\\rag.py" --rebuild'},
        REPO_ROOT,
    )

    assert result == "backend/rag.py"


def test_shell_with_unbalanced_quotes_still_classifies():
    decision = decide(
        "ask",
        "Bash",
        {"command": 'echo "unbalanced backend/rag.py'},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.kind == "shell"
    assert decision.self_modify is True


def test_cli_permission_mode_mapping():
    assert cli_permission_mode("ask") == "default"
    assert cli_permission_mode("accept_edits") == "acceptEdits"
    assert cli_permission_mode("readonly") == "default"
    assert cli_permission_mode("trusted") == "bypassPermissions"


def test_cli_permission_mode_rejects_unknown_mode():
    with pytest.raises(ValueError):
        cli_permission_mode("yolo")


def test_read_baseline_tools_is_the_allowed_tools_list():
    assert list(READ_BASELINE_TOOLS) == [
        "Read",
        "Grep",
        "Glob",
        "LS",
        "WebFetch",
        "WebSearch",
        "TodoWrite",
        "NotebookRead",
    ]
    assert set(READ_BASELINE_TOOLS) == READ_TOOLS


def test_tool_sets_match_contract():
    assert EDIT_TOOLS == {"Edit", "Write", "MultiEdit", "NotebookEdit"}
    assert SHELL_TOOLS == {"Bash", "PowerShell"}
    assert AGENT_TOOLS == {"Agent", "Task"}


@pytest.mark.parametrize(
    "raw",
    [
        "C:\\proj\\theDAW\\..\\theDAW\\backend\\rag.py",
        "C:/proj/theDAW/../theDAW/backend/rag.py",
        "C:\\proj\\theDAW\\backend\\..\\backend\\rag.py",
        "backend/../backend/rag.py",
        "frontend/src/orb-kit/../orb-kit/useChatStream.ts/../useChatStream.ts",
    ],
)
def test_traversal_inside_repo_still_resolves_to_self_surface(raw):
    """B1: `..` segments must not smuggle a self-surface write past the policy."""
    result = self_modify_path("Write", {"file_path": raw}, REPO_ROOT)

    assert result in ("backend/rag.py", "frontend/src/orb-kit/useChatStream.ts")


@pytest.mark.parametrize(
    "raw",
    [
        "C:\\proj\\theDAW\\..\\other\\backend\\rag.py",
        "C:/proj/theDAW/../../elsewhere/backend/rag.py",
        "../outside/backend/rag.py",
        "../../backend/rag.py",
    ],
)
def test_traversal_that_leaves_the_repo_is_not_self_modify(raw):
    """B1: genuine escapes stay outside the repo and are not self-surface."""
    assert self_modify_path("Write", {"file_path": raw}, REPO_ROOT) is None


def test_traversal_decides_as_self_modify_in_trusted_mode():
    decision = decide(
        "trusted",
        "Edit",
        {"file_path": "C:\\proj\\theDAW\\..\\theDAW\\backend\\assistant_routes.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/assistant_routes.py"
    assert decision.backend_restart is True


@pytest.mark.parametrize(
    "command",
    [
        "echo hi >backend/rag.py",
        "echo hi >>backend/rag.py",
        "python -m foo 2>backend/rag.py",
        "python -m foo 1>backend/rag.py",
        "generate --output=backend/rag.py",
        "dd if=/dev/zero of=backend/rag.py",
        "patch <backend/rag.py",
        "tee >backend/rag.py",
        'echo hi >"backend/rag.py"',
        "python gen.py --out=C:\\proj\\theDAW\\backend\\rag.py",
    ],
)
def test_glued_shell_redirect_tokens_are_detected(command):
    """B2: a path glued to a redirect/flag operator is still a write target."""
    assert self_modify_path("Bash", {"command": command}, REPO_ROOT) == "backend/rag.py"


def test_glued_shell_token_decides_as_self_modify():
    decision = decide(
        "trusted",
        "Bash",
        {"command": "echo pwned >backend/modules/assistant/permissions.py"},
        session_allow={"Bash"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/modules/assistant/permissions.py"
    assert decision.backend_restart is True


def test_glued_token_without_a_repo_path_is_not_self_modify():
    decision = decide(
        "ask",
        "Bash",
        {"command": "curl https://example.com/x --output=/tmp/out.bin 2>/dev/null"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert decision.self_modify_path is None
    assert decision.backend_restart is False


def test_powershell_is_a_shell_tool_through_decide():
    """B4: PowerShell follows the same shell rules as Bash."""
    plain = decide(
        "ask",
        "PowerShell",
        {"command": "Get-ChildItem backend"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    trusted = decide(
        "trusted",
        "PowerShell",
        {"command": "Get-ChildItem backend"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    readonly = decide(
        "readonly",
        "PowerShell",
        {"command": "Get-ChildItem backend"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert (plain.kind, plain.action) == ("shell", "ask")
    assert (trusted.kind, trusted.action) == ("shell", "allow")
    assert (readonly.kind, readonly.action) == ("shell", "deny")


def test_powershell_touching_self_surface_always_asks():
    decision = decide(
        "trusted",
        "PowerShell",
        {"command": "Set-Content -Path backend/rag.py -Value x"},
        session_allow={"PowerShell"},
        deny_count=7,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/rag.py"


def test_multiedit_is_an_edit_tool_through_decide():
    """B4: MultiEdit carries file_path like the other edit tools."""
    in_repo = decide(
        "accept_edits",
        "MultiEdit",
        {
            "file_path": "frontend/src/components/audio/WaveformEditor.tsx",
            "edits": [{"old_string": "a", "new_string": "b"}],
        },
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    self_surface = decide(
        "accept_edits",
        "MultiEdit",
        {
            "file_path": "C:\\proj\\theDAW\\backend\\modules\\assistant\\permissions.py",
            "edits": [{"old_string": "a", "new_string": "b"}],
        },
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert (in_repo.kind, in_repo.action) == ("edit", "allow")
    assert in_repo.self_modify is False
    assert (self_surface.kind, self_surface.action) == ("edit", "ask")
    assert self_surface.self_modify_path == "backend/modules/assistant/permissions.py"
    assert self_surface.backend_restart is True


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("C:\\proj\\theDAW\\Backend\\RAG.py", "Backend/RAG.py"),
        ("c:\\proj\\thedaw\\backend\\rag.py", "backend/rag.py"),
        ("c:/PROJ/theDAW/backend/assistant_routes.py", "backend/assistant_routes.py"),
        ("Backend/assistant_routes.py", "Backend/assistant_routes.py"),
        ("FRONTEND/src/orb-kit/x.ts", "FRONTEND/src/orb-kit/x.ts"),
        (
            "backend\\Modules\\Assistant\\Permissions.py",
            "backend/Modules/Assistant/Permissions.py",
        ),
    ],
)
def test_case_variant_self_surface_is_detected_on_windows_roots(raw, expected):
    """V2-1: NTFS is case-insensitive, so `Backend\\RAG.py` IS `backend/rag.py`."""
    assert self_modify_path("Edit", {"file_path": raw}, REPO_ROOT) == expected


@pytest.mark.parametrize("mode", ["trusted", "accept_edits"])
@pytest.mark.parametrize(
    "raw",
    [
        "C:\\proj\\theDAW\\Backend\\RAG.py",
        "c:\\proj\\theDAW\\backend\\rag.py",
        "Backend/assistant_routes.py",
        "FRONTEND/src/orb-kit/x.ts",
    ],
)
def test_case_variant_self_surface_asks_in_permissive_modes(mode, raw):
    decision = decide(
        mode,
        "Edit",
        {"file_path": raw},
        session_allow={"Edit"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is True
    assert decision.action == "ask"


def test_case_variant_backend_python_needs_restart_on_windows_roots():
    decision = decide(
        "trusted",
        "Edit",
        {"file_path": "BACKEND\\Modules\\Midi\\Engine.PY"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert decision.backend_restart is True
    assert decision.action == "allow"


def test_case_variant_is_case_sensitive_on_posix_roots(monkeypatch):
    """On a case-sensitive filesystem `Backend/` is a different directory."""
    import backend.modules.assistant.permissions as permissions

    monkeypatch.setattr(permissions.sys, "platform", "linux")
    posix_root = Path("/srv/theDAW")

    assert self_modify_path("Edit", {"file_path": "Backend/rag.py"}, posix_root) is None
    assert (
        self_modify_path("Edit", {"file_path": "backend/rag.py"}, posix_root)
        == "backend/rag.py"
    )


def test_windows_platform_is_case_insensitive_even_for_posix_style_root(monkeypatch):
    import backend.modules.assistant.permissions as permissions

    monkeypatch.setattr(permissions.sys, "platform", "win32")

    assert (
        self_modify_path("Edit", {"file_path": "Backend/rag.py"}, Path("/srv/theDAW"))
        == "Backend/rag.py"
    )


@pytest.mark.parametrize(
    "command",
    [
        "echo x >backend/rag.py;",
        "echo x > backend/rag.py; ls",
        "echo x > backend/rag.py&&ls",
        "echo x >backend/rag.py&&ls",
        "echo x >|backend/rag.py",
        "(echo x >backend/rag.py)",
        "(echo x > backend/rag.py)",
        "cat a|tee backend/rag.py|wc",
        "true&&cp a backend/rag.py",
        "cp a backend/rag.py&",
    ],
)
def test_glued_shell_separators_do_not_hide_the_target(command):
    """V2-2: `;`, `&&`, `|`, `(`, `)` glued to a path must not defeat detection."""
    assert self_modify_path("Bash", {"command": command}, REPO_ROOT) == "backend/rag.py"


def test_glued_separator_decides_as_self_modify_in_trusted_mode():
    decision = decide(
        "trusted",
        "Bash",
        {"command": "echo pwned > backend/assistant_routes.py; ls"},
        session_allow={"Bash"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/assistant_routes.py"


def test_colon_separator_variant_is_detected():
    """V2-4: `--out:path` style flags (MSVC, robocopy) name a write target."""
    assert (
        self_modify_path("Bash", {"command": "tool --out:backend/rag.py"}, REPO_ROOT)
        == "backend/rag.py"
    )


def test_url_containing_a_self_surface_path_is_not_self_modify():
    """V2-4 false-positive guard: a URL path is not a repo path."""
    decision = decide(
        "ask",
        "Bash",
        {"command": "curl https://host/backend/rag.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert decision.self_modify_path is None
    assert decision.backend_restart is False
    assert decision.action == "ask"


def test_decide_rejects_unknown_mode():
    with pytest.raises(ValueError):
        decide(
            "supervised",
            "Read",
            {"file_path": "README.md"},
            session_allow=set(),
            deny_count=0,
            repo_root=REPO_ROOT,
        )
