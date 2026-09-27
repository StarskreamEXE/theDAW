"""Stopping the Magenta engine stops only the engine this checkout started.

Two checkouts of theDAW on one machine (the user's app tree and a worktree, or
two clones) each spawn their own engine from their own sidecars/magenta
folder. The stop used to run ``pkill -f "sidecars/magenta/server.py|
studio_server.py"`` inside WSL, which ends every magenta engine on the machine:
a test run or a second checkout stopping its engine killed the running app's.

The stop now signals the pid the spawn recorded, and only while that pid still
runs this checkout's script, plus this checkout's own bundled Studio server.
The fake tests replay start -> (backend restart) -> stop against a process
table that holds both checkouts' engines; the POSIX test does it with real
processes.
"""

from __future__ import annotations

import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from backend.modules.magenta import sidecar


class _ProcTable:
    """The engine side's processes. Answers ``ps`` with the table, removes a
    pid on ``kill``, and removes every pid whose args match on ``pkill -f``
    (what the real pkill does), so a stop that reaps by name shows up as the
    other checkout's engine vanishing."""

    def __init__(self, table: dict[int, str]) -> None:
        self.table = dict(table)
        self.signalled: list[int] = []
        self.commands: list[list[str]] = []

    def run(self, cmd: list[str], *args: Any, **kwargs: Any):
        argv = list(cmd)
        self.commands.append(argv)
        if argv[:1] == ["wsl.exe"]:
            # wsl.exe -d <distro> --exec <argv> | -- bash -lc <script>
            if "--exec" in argv:
                argv = argv[argv.index("--exec") + 1 :]
            else:
                argv = ["bash", "-lc", argv[-1]]
        if argv[:2] == ["bash", "-lc"]:
            argv = argv[2].split(" || ")[0].split()
            argv = [a.strip("'") for a in argv]
            if argv[:2] == ["pkill", "-f"]:
                argv = ["pkill", "-f", argv[2]]
        out = ""
        if argv and argv[0] == "ps":
            out = "".join(f"{pid:>7} {a}\n" for pid, a in sorted(self.table.items()))
        elif argv and argv[0] == "kill":
            for p in argv[2:]:
                self.signalled.append(int(p))
                self.table.pop(int(p), None)
        elif argv[:2] == ["pkill", "-f"]:
            alternatives = argv[2].split("|")
            for pid, a in list(self.table.items()):
                if any(alt in a for alt in alternatives):
                    self.signalled.append(pid)
                    del self.table[pid]
        text = kwargs.get("text") or kwargs.get("encoding")
        return subprocess.CompletedProcess(argv, 0, out if text else out.encode(), "")


class _SpawnedEngine:
    """The child ``start_engine`` gets back: on Windows that is wsl.exe."""

    pid = 101

    def poll(self) -> int | None:
        return None

    def terminate(self) -> None:
        pass

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def kill(self) -> None:
        pass


def _checkout(root: Path) -> tuple[Path, Path]:
    engine = root / "sidecars" / "magenta" / "server.py"
    studio = root / "sidecars" / "magenta-rt2-nvidia" / "app" / "studio_server.py"
    for f in (engine, studio):
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("", encoding="utf-8")
    return engine, studio


@pytest.fixture
def two_checkouts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    ours, our_studio = _checkout(tmp_path / "theDAW-worktree")
    theirs, their_studio = _checkout(tmp_path / "theDAW")
    python = tmp_path / "python"
    python.write_text("", encoding="utf-8")
    monkeypatch.setattr(sidecar, "_engine_proc", None)
    monkeypatch.setattr(sidecar, "_ENGINE_SCRIPT", ours)
    # raising=False: the same test runs, and fails, against a build without them.
    monkeypatch.setattr(sidecar, "_STUDIO_SCRIPT", our_studio, raising=False)
    monkeypatch.setattr(
        sidecar, "_PID_FILE", tmp_path / "data" / "magenta_engine.pid", raising=False
    )
    monkeypatch.setattr(sidecar, "_NATIVE_PYTHON", str(python))
    monkeypatch.setattr(sidecar, "_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(sidecar, "_wsl_distro", lambda: "Ubuntu")
    monkeypatch.setattr(sidecar, "_resolve_start_model", lambda: ("mrt2_small", None))
    monkeypatch.setattr(sidecar, "_ENGINE_STOP_GRACE_SEC", 0.0, raising=False)
    return {
        "ours": ours,
        "our_studio": our_studio,
        "theirs": theirs,
        "their_studio": their_studio,
    }


def _as_engine_sees(path: Path) -> str:
    """How a process on the engine side spells ``path`` in its arguments: the
    WSL mount path on Windows, the path itself elsewhere."""
    return sidecar._wsl_path(path) if sidecar.sys.platform == "win32" else str(path)


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_stop_leaves_the_other_checkouts_engine_running(
    platform: str, two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sidecar.sys, "platform", platform)
    c = two_checkouts
    monkeypatch.setattr(sidecar.subprocess, "Popen", lambda *a, **k: _SpawnedEngine())

    # 1. This checkout's backend starts its engine.
    started = sidecar.start_engine()
    assert started["spawned"] is True
    if platform == "win32":
        # Inside WSL the spawn's bash writes its own pid before exec (the
        # command is checked in the next test); this is that write.
        pid_file = sidecar._PID_FILE
        pid_file.parent.mkdir(parents=True, exist_ok=True)
        pid_file.write_text("101\n", encoding="utf-8")
    assert sidecar._PID_FILE.read_text(encoding="utf-8").strip() == "101"

    # 2. The backend restarts: the child handle is gone, the engine is not.
    monkeypatch.setattr(sidecar, "_engine_proc", None)

    procs = _ProcTable(
        {
            1: "/init",
            101: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['ours'])}",
            202: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['theirs'])}",
            303: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['our_studio'])}",
            404: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['their_studio'])}",
            # A checkout whose folder ends in this one's path: not this one.
            505: f"/home/u/mrt2/.venv/bin/python /srv{_as_engine_sees(c['our_studio'])}",
        }
    )
    monkeypatch.setattr(sidecar.subprocess, "run", procs.run)

    # 3. It stops its engine.
    stopped = sidecar.stop_engine()

    assert sorted(procs.signalled) == [101, 303]
    assert sorted(procs.table) == [1, 202, 404, 505], "the others run on"
    assert sorted(stopped["reaped"]) == [101, 303]
    assert [e["pid"] for e in stopped["left_running"]] == [202, 404, 505]
    assert not sidecar._PID_FILE.exists(), "the spent pid record is cleared"


def test_the_windows_spawn_records_the_engine_pid(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    seen: list[list[str]] = []

    def popen(cmd, *a, **k):
        seen.append(cmd)
        return _SpawnedEngine()

    monkeypatch.setattr(sidecar.subprocess, "Popen", popen)
    sidecar.start_engine()
    [cmd] = seen
    # --exec: no default shell reads the script first and expands $$ itself.
    assert cmd[:6] == ["wsl.exe", "-d", "Ubuntu", "--exec", "bash", "-lc"]
    script = cmd[-1]
    record = sidecar._wsl_path(sidecar._PID_FILE)
    tmp, final = shlex.quote(record + ".tmp"), shlex.quote(record)
    # $$ is the bash that ``exec`` turns into the engine: the same pid.
    assert f"echo $$ > {tmp}" in script
    assert f"mv -f {tmp} {final};" in script
    assert script.index(final) < script.index("exec ")


def test_a_reused_pid_is_not_signalled(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The record says 101, but the engine it named exited long ago and the
    system gave 101 to the other checkout's engine. Nothing of ours runs, so
    nothing is signalled and the record is cleared."""
    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    c = two_checkouts
    sidecar._PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    sidecar._PID_FILE.write_text("101\n", encoding="utf-8")
    procs = _ProcTable(
        {101: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['theirs'])}"}
    )
    monkeypatch.setattr(sidecar.subprocess, "run", procs.run)

    stopped = sidecar.stop_engine()

    assert procs.signalled == []
    assert sorted(procs.table) == [101]
    assert stopped["reaped"] == []
    assert not sidecar._PID_FILE.exists()


def test_a_listing_that_fails_signals_nothing(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """WSL did not answer: the stop cannot tell whose engine is whose, so it
    signals nobody and keeps the record for the next stop."""
    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    sidecar._PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    sidecar._PID_FILE.write_text("101\n", encoding="utf-8")
    calls: list[list[str]] = []

    def run(cmd, *a, **k):
        calls.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 1, "", "WSL is starting")

    monkeypatch.setattr(sidecar.subprocess, "run", run)
    stopped = sidecar.stop_engine()
    assert all("kill" not in c and "pkill" not in " ".join(c) for c in calls)
    assert stopped["reaped"] == []
    assert sidecar._PID_FILE.read_text(encoding="utf-8").strip() == "101"


_SLEEPER = "import time\ntime.sleep(120)\n"


@pytest.mark.skipif(sys.platform == "win32", reason="the engine side is WSL here")
def test_real_processes_only_this_checkouts_engine_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ours, our_studio = _checkout(tmp_path / "theDAW-worktree")
    theirs, _their_studio = _checkout(tmp_path / "theDAW")
    ours.write_text(_SLEEPER, encoding="utf-8")
    theirs.write_text(_SLEEPER, encoding="utf-8")
    monkeypatch.setattr(sidecar, "_engine_proc", None)
    monkeypatch.setattr(sidecar, "_ENGINE_SCRIPT", ours)
    # raising=False: the same test runs, and fails, against a build without them.
    monkeypatch.setattr(sidecar, "_STUDIO_SCRIPT", our_studio, raising=False)
    monkeypatch.setattr(
        sidecar, "_PID_FILE", tmp_path / "data" / "magenta_engine.pid", raising=False
    )
    monkeypatch.setattr(sidecar, "_NATIVE_PYTHON", sys.executable)
    monkeypatch.setattr(sidecar, "_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(sidecar, "_resolve_start_model", lambda: ("mrt2_small", None))

    other = subprocess.Popen([sys.executable, str(theirs)])
    try:
        sidecar.start_engine()
        mine = sidecar._engine_proc
        assert mine is not None
        # The backend restarts: the handle is lost, the engine runs on.
        monkeypatch.setattr(sidecar, "_engine_proc", None)
        time.sleep(0.2)

        stopped = sidecar.stop_engine()

        assert mine.wait(timeout=10) is not None, "this checkout's engine stopped"
        assert stopped["reaped"] == [mine.pid]
        assert other.poll() is None, "the other checkout's engine is still running"
    finally:
        other.kill()
        other.wait(timeout=10)
