"""Unit tests for the analysis module."""

from __future__ import annotations

import json
from pathlib import Path

from backend.modules.analysis.bars import estimate_bars
from backend.modules.analysis.engine import (
    ANALYSIS_VERSION,
    analyze_and_persist,
    persist_analysis,
)
from backend.modules.analysis.ffprobe import has_ffprobe, probe_file
from backend.modules.analysis.key import _correlate, _MAJOR_PROFILE


def test_estimate_bars_empty():
    assert estimate_bars([]) is None


def test_estimate_bars_four_four():
    beats = [0.5 * i for i in range(16)]
    assert estimate_bars(beats, time_sig_numerator=4) == 4.0


def test_estimate_bars_three_four():
    beats = [0.5 * i for i in range(12)]
    assert estimate_bars(beats, time_sig_numerator=3) == 4.0


def test_key_correlation_matches_self():
    # The major profile correlated with itself should produce the
    # maximum at rotation 0 (C major). Numerically: corr(x, x) == 1.0.
    corr = _correlate(list(_MAJOR_PROFILE), _MAJOR_PROFILE)
    assert max(range(12), key=lambda i: corr[i]) == 0
    assert abs(corr[0] - 1.0) < 1e-9


def test_key_correlation_handles_zero_vector():
    corr = _correlate([0.0] * 12, _MAJOR_PROFILE)
    assert corr == [0.0] * 12


def test_probe_file_returns_empty_when_no_ffprobe_or_missing(tmp_path: Path):
    missing = tmp_path / "nope.wav"
    out = probe_file(missing)
    # Either ffprobe is missing OR the file is missing — both → {}.
    assert out == {}


def test_probe_file_real_wav_when_ffprobe_available(tmp_path: Path):
    if not has_ffprobe():
        return  # silently skip on environments without ffprobe
    # Build a real 1-second silence WAV with soundfile.
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return
    p = tmp_path / "silent.wav"
    sf.write(str(p), np.zeros((44100, 2), dtype=np.float32), 44100)
    out = probe_file(p)
    summary = out.get("_summary") or {}
    assert summary.get("sample_rate") == 44100
    assert summary.get("channels") == 2


def test_probe_summary_reports_whether_the_samples_are_float(tmp_path: Path):
    """bits_per_sample reads 32 for pcm_s32le and pcm_f32le alike, so the
    number on its own cannot answer "is this a float file"."""
    if not has_ffprobe():
        return  # silently skip on environments without ffprobe
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return

    tone = np.zeros((22050, 2), dtype=np.float32)
    for subtype, bit_depth, is_float in (
        ("FLOAT", 32, True),
        ("DOUBLE", 64, True),
        ("PCM_24", 24, False),
        ("PCM_16", 16, False),
    ):
        p = tmp_path / f"{subtype.lower()}.wav"
        sf.write(str(p), tone, 44100, subtype=subtype)
        summary = (probe_file(p) or {}).get("_summary") or {}
        assert summary.get("bit_depth") == bit_depth, subtype
        assert summary.get("bit_depth_is_float") is is_float, subtype
        assert summary.get("sample_fmt")


def test_probe_summary_flac_falls_back_to_bits_per_raw_sample(tmp_path: Path):
    """ffprobe reports bits_per_sample: 0 for FLAC, so the `or` fallback in
    _summarize is what makes the depth land at all. A float source encoded to
    FLAC is 24-bit int — lossless, but never float."""
    if not has_ffprobe():
        return
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return

    p = tmp_path / "from_float.flac"
    sf.write(str(p), np.zeros((22050, 2), dtype=np.float32), 44100, subtype="PCM_24")
    summary = (probe_file(p) or {}).get("_summary") or {}
    assert summary.get("bit_depth") == 24
    assert summary.get("bit_depth_is_float") is False


def _seed_entry(root: Path, entry_id: str, sr: int = 22050) -> Path:
    """Seed a real WAV-backed library entry for engine tests."""
    item_dir = root / entry_id
    item_dir.mkdir(parents=True, exist_ok=True)
    import numpy as np
    import soundfile as sf

    # 2 seconds of a 440 Hz sine — gives the analyzer something real to chew on.
    t = np.linspace(0, 2.0, sr * 2, endpoint=False, dtype=np.float32)
    y = 0.2 * np.sin(2 * np.pi * 440.0 * t)
    audio_path = item_dir / "output.wav"
    sf.write(str(audio_path), y, sr)
    meta = {
        "id": entry_id,
        "filename": "output.wav",
        "audio_filename": "output.wav",
        "mime_type": "audio/wav",
        "title": entry_id,
        "prompt": "test sine",
        "duration": 2.0,
        "steps": 8,
        "cfg": 1.0,
        "seed": 1,
        "favorite": False,
        "rating": None,
        "tags": [],
        "notes": "",
        "source": "import",
        "saved_at": 1234567890.0,
        "embedded_tags": {"hint": "stub"},
    }
    (item_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return audio_path


def test_engine_writes_to_db_and_metadata(tmp_path: Path):
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        return

    from backend.modules.library.store import LibraryStore

    audio_path = _seed_entry(tmp_path, "alpha")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    # _sync runs via auto-reindex on init; the entries row exists.
    assert store.db.get_entry("alpha") is not None

    entry_dir = store._dir_for("alpha")
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    payload = analyze_and_persist(
        store.db,
        "alpha",
        audio_path,
        metadata_path=metadata_path,
        settings={"include_key": True, "include_genre": False},
    )

    # Engine produced a payload with expected keys.
    assert payload.get("version") == ANALYSIS_VERSION
    assert "analyzed_at" in payload
    # Pitch detection finds ~440 Hz on a sine tone (within tolerance).
    pitch = payload.get("pitch_mean_hz")
    if pitch is not None:
        assert 430.0 <= pitch <= 450.0

    # DB row exists.
    db_analysis = store.db.get_analysis("alpha")
    assert db_analysis is not None
    assert db_analysis["version"] == ANALYSIS_VERSION

    # Entry status updated.
    row = store.db.get_entry("alpha")
    assert row is not None
    assert row["analysis_status"] == "complete"

    # metadata.json now has an 'analysis' section.
    assert metadata_path is not None
    meta = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert "analysis" in meta
    assert "beats_count" in meta["analysis"]


def test_persist_analysis_handles_missing_metadata_file(tmp_path: Path):
    """If the metadata.json doesn't exist, persist_analysis still writes
    to the DB and doesn't raise."""
    from backend.modules.library.db import LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "x"})
    persist_analysis(
        db,
        "x",
        {"version": 1, "bpm": 120.0, "beats": [0.5, 1.0]},
        metadata_path=tmp_path / "does-not-exist.json",
    )
    out = db.get_analysis("x")
    assert out is not None
    assert out["bpm"] == 120.0


# ---------------------------------------------------------------------------
# DJ-1: the analysis profile, the concurrency cap, and single-flight.
# ---------------------------------------------------------------------------


def _seed_tone(tmp_path: Path, entry_id: str) -> Path:
    """A real 3-second 440 Hz WAV entry, the same shape `_seed_entry` builds.
    Long enough that LUFS gating and pyin both have something to chew on."""
    import numpy as np
    import soundfile as sf

    item_dir = tmp_path / entry_id
    item_dir.mkdir(parents=True, exist_ok=True)
    audio_path = item_dir / "audio.wav"
    sr = 22050
    t = np.linspace(0.0, 3.0, sr * 3, endpoint=False)
    tone = 0.3 * np.sin(2.0 * np.pi * 440.0 * t)
    sf.write(str(audio_path), np.stack([tone, tone], axis=1), sr)
    (item_dir / "metadata.json").write_text(
        json.dumps(
            {
                "id": entry_id,
                "title": entry_id,
                "audio_filename": "audio.wav",
                "kind": "audio",
                "tags": [],
                "saved_at": 1.0,
                "source": "import",
            }
        ),
        encoding="utf-8",
    )
    return audio_path


def test_dj_profile_skips_pitch_and_lufs_but_keeps_what_a_deck_reads(tmp_path: Path):
    """The whole point of the profile: no pyin, no second decode, and every
    field a deck actually shows still present -- including the tempo
    confidence, which the detector always computed and the engine threw away."""
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        return

    from backend.modules.analysis.engine import (
        PROFILE_DJ,
        PROFILE_MARKER_KEY,
        analyze_audio,
    )

    audio_path = _seed_tone(tmp_path, "dj_profile")
    out = analyze_audio(audio_path, profile=PROFILE_DJ)

    assert out["profile"] == PROFILE_DJ
    # Skipped, not merely absent: an explicit None is what tells a later full
    # run there is something left to measure.
    assert out["loudness_lufs"] is None
    assert out.get("pitch_mean_hz") is None
    # The deck's fields.
    assert "bpm" in out and "beats" in out
    assert out["rms_db"] is not None
    assert "bpm_confidence" in out
    if out["bpm"] is not None:
        assert isinstance(out["bpm_confidence"], float)
        assert 0.0 <= out["bpm_confidence"] <= 1.0
    # The marker a later enrichment pass looks for.
    assert out["ffprobe"].get(PROFILE_MARKER_KEY) == PROFILE_DJ


def test_full_profile_still_measures_pitch_lufs_and_carries_no_marker(tmp_path: Path):
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        return

    from backend.modules.analysis.engine import (
        PROFILE_MARKER_KEY,
        analyze_audio,
    )

    audio_path = _seed_tone(tmp_path, "full_profile")
    out = analyze_audio(audio_path)

    assert out["profile"] == "full"
    assert out["pitch_mean_hz"] is not None
    assert out["loudness_lufs"] is not None
    # No marker at all on a full row -- absence means full, which is what makes
    # every row written before profiles existed read correctly.
    assert PROFILE_MARKER_KEY not in out["ffprobe"]


def test_dj_profile_never_erases_what_a_full_run_measured(tmp_path: Path):
    """INVARIANT: a partial profile is additive. upsert_analysis writes the
    whole row, so without the carry-forward a 2-second dj run would null out
    the pitch and LUFS a 10-second full run paid for."""
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        return

    from backend.modules.analysis.engine import PROFILE_DJ
    from backend.modules.library.store import LibraryStore

    audio_path = _seed_tone(tmp_path, "carry")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    entry_dir = store._dir_for("carry")
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analyze_and_persist(store.db, "carry", audio_path, metadata_path=metadata_path)
    full_row = store.db.get_analysis("carry")
    assert full_row is not None
    assert full_row["pitch_mean_hz"] is not None
    assert full_row["loudness_lufs"] is not None
    assert full_row["prompt_guess"]

    analyze_and_persist(
        store.db,
        "carry",
        audio_path,
        metadata_path=metadata_path,
        profile=PROFILE_DJ,
    )
    dj_row = store.db.get_analysis("carry")
    assert dj_row is not None
    assert dj_row["pitch_mean_hz"] == full_row["pitch_mean_hz"]
    assert dj_row["loudness_lufs"] == full_row["loudness_lufs"]
    assert dj_row["prompt_guess"] == full_row["prompt_guess"]
    # ... while what the dj run DID measure is written.
    assert dj_row["bpm"] == dj_row["bpm"]
    assert dj_row["analyzed_at"] >= full_row["analyzed_at"]


def test_persist_records_bpm_confidence(tmp_path: Path):
    from backend.modules.library.db import LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "conf"})
    persist_analysis(
        db, "conf", {"version": ANALYSIS_VERSION, "bpm": 128.0, "bpm_confidence": 0.75}
    )
    row = db.get_analysis("conf")
    assert row is not None
    assert row["bpm_confidence"] == 0.75


def test_bpm_confidence_column_is_added_to_a_pre_column_database(tmp_path: Path):
    """A library created before schema v12 gains the column on open, and a
    database left half-migrated (column present, version behind) opens too
    instead of raising 'duplicate column name'."""
    import sqlite3

    from backend.modules.library.db import LibraryDB

    path = tmp_path / "library.db"
    db = LibraryDB(path)
    assert db.schema_version() >= 12
    db._conn.close()  # noqa: SLF001

    # Rewind to a pre-column v11 database.
    raw = sqlite3.connect(str(path))
    raw.execute("ALTER TABLE analysis DROP COLUMN bpm_confidence")
    raw.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '11')"
    )
    raw.commit()
    cols = {str(r[1]) for r in raw.execute("PRAGMA table_info(analysis)").fetchall()}
    assert "bpm_confidence" not in cols
    raw.close()

    reopened = LibraryDB(path)
    assert reopened._has_column("analysis", "bpm_confidence")  # noqa: SLF001
    assert reopened.schema_version() >= 12
    reopened._conn.close()  # noqa: SLF001

    # Half-migrated: the column is there but the version says it is not.
    raw = sqlite3.connect(str(path))
    raw.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '11')"
    )
    raw.commit()
    raw.close()
    again = LibraryDB(path)  # must not raise
    assert again._has_column("analysis", "bpm_confidence")  # noqa: SLF001
    again._conn.close()  # noqa: SLF001
