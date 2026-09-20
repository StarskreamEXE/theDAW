"""T23 DEAD CODE (batch 12) -- moved modules stay moved, dead exports stay gone.

``deprecated/`` (repo root) is git-ignored (see ``.gitignore``), so it will
not exist on a fresh clone/CI checkout -- mirroring the discipline in
``tests/test_suno_promote_b12.py::test_the_legacy_ingest_script_moved_to_deprecated``,
these assertions only check that the OLD path is gone, never that a
git-ignored new path exists.

``backend/deprecated/`` is explicitly un-ignored (``!backend/deprecated/``
in ``.gitignore``), so files moved there ARE tracked and DO exist on a
fresh checkout -- for ``model_registry.py`` we assert both the old path is
gone and the new path exists.

Covers:

* The four files already moved to ``deprecated/`` (frontend components/
  state + the legacy ingest script) stay absent from their old locations.
* ``backend/core/model_registry.py`` moved to ``backend/deprecated/`` and
  is absent from ``backend/core``.
* The six dead exports named in the T23 ticket (``fetchBytesWithRetry``,
  ``followSurfaceSink``, ``currentDeviceIds``, ``activeThruPortId``,
  ``getCueSinkId``, ``listAudioInputs``) are gone from the frontend source
  tree.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# ---------------------------------------------------------------------------
# Moved-file paths (old locations must be gone)
# ---------------------------------------------------------------------------

OLD_WAVEFORM_PREVIEW = (
    REPO_ROOT / "frontend" / "src" / "components" / "audio" / "WaveformPreview.tsx"
)
OLD_ASSISTANT_BRIDGE_STORE = (
    REPO_ROOT / "frontend" / "src" / "state" / "assistantBridgeStore.ts"
)
OLD_STORAGE_QUOTA_STORE = (
    REPO_ROOT / "frontend" / "src" / "state" / "storageQuotaStore.ts"
)
OLD_INGEST_SCRIPT = REPO_ROOT / "scripts" / "ingest_suno_cache.py"

OLD_MODEL_REGISTRY = REPO_ROOT / "backend" / "core" / "model_registry.py"
NEW_MODEL_REGISTRY = REPO_ROOT / "backend" / "deprecated" / "model_registry.py"

# ---------------------------------------------------------------------------
# Dead-export source locations (source file, symbol name)
# ---------------------------------------------------------------------------

DEAD_EXPORT_FILES = {
    REPO_ROOT / "frontend" / "src" / "components" / "audio" / "IoDeviceSelect.tsx": [
        "currentDeviceIds",
    ],
    REPO_ROOT / "frontend" / "src" / "state" / "midiOutBus.ts": [
        "activeThruPortId",
    ],
    REPO_ROOT / "frontend" / "src" / "state" / "djEngine.ts": [
        "getCueSinkId",
    ],
    REPO_ROOT / "frontend" / "src" / "lib" / "vocalToMidi.ts": [
        "listAudioInputs",
    ],
}


def test_the_four_previously_moved_files_are_absent_from_their_old_locations() -> None:
    for old_path in (
        OLD_WAVEFORM_PREVIEW,
        OLD_ASSISTANT_BRIDGE_STORE,
        OLD_STORAGE_QUOTA_STORE,
        OLD_INGEST_SCRIPT,
    ):
        assert not old_path.exists(), f"{old_path} should have moved to deprecated/"


def test_model_registry_moved_from_core_to_backend_deprecated() -> None:
    assert not OLD_MODEL_REGISTRY.exists(), (
        "backend/core/model_registry.py should have moved to backend/deprecated/"
    )
    assert NEW_MODEL_REGISTRY.exists(), (
        "backend/deprecated/model_registry.py should exist "
        "(backend/deprecated/ is tracked, unlike the repo-root deprecated/)"
    )


def test_the_six_dead_exports_are_gone_from_frontend_source() -> None:
    for file_path, symbols in DEAD_EXPORT_FILES.items():
        text = file_path.read_text(encoding="utf-8")
        for symbol in symbols:
            pattern = re.compile(
                rf"\bexport\s+(?:const|function)\s+{re.escape(symbol)}\b"
            )
            assert not pattern.search(text), (
                f"{symbol} should be removed from {file_path}"
            )


def test_fetch_bytes_with_retry_and_follow_surface_sink_stay_removed() -> None:
    """These two were already removed before this ticket picked up the
    remaining four; guard them too so a future edit cannot silently
    reintroduce either."""
    src_root = REPO_ROOT / "frontend" / "src"
    for symbol in ("fetchBytesWithRetry", "followSurfaceSink"):
        pattern = re.compile(rf"\bexport\s+(?:const|function)\s+{re.escape(symbol)}\b")
        for ts_file in src_root.rglob("*.ts"):
            text = ts_file.read_text(encoding="utf-8", errors="ignore")
            assert not pattern.search(text), f"{symbol} reappeared in {ts_file}"
        for tsx_file in src_root.rglob("*.tsx"):
            text = tsx_file.read_text(encoding="utf-8", errors="ignore")
            assert not pattern.search(text), f"{symbol} reappeared in {tsx_file}"
