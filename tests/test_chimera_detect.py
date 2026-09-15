"""Unit tests for backend.modules.chimera.detect.

Synthesizes click tracks at known BPMs and asserts the detector recovers them
within tolerance. Also covers degenerate inputs (too short, silent).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.lib.audio_io import save_audio
from backend.modules.chimera.detect import detect_tempo_and_beats
from tests.rhythm_synth import MeterSegment, meter_track


def _synth_click_track(
    bpm: float,
    duration_sec: float,
    sr: int = 44100,
    seed: int = 42,
) -> np.ndarray:
    n_samples = int(duration_sec * sr)
    audio = np.zeros(n_samples, dtype=np.float32)
    rng = np.random.default_rng(seed=seed)
    click_len = int(0.01 * sr)
    envelope = np.linspace(1.0, 0.0, click_len, dtype=np.float32)
    click = rng.standard_normal(click_len).astype(np.float32) * envelope * 0.5

    period = 60.0 / bpm
    t = 0.0
    while t < duration_sec:
        start = int(t * sr)
        end = min(start + click_len, n_samples)
        if start < n_samples:
            audio[start:end] += click[: end - start]
        t += period
    return audio


@pytest.mark.parametrize("target_bpm", [90.0, 120.0, 140.0])
def test_detect_known_bpm(tmp_path: Path, target_bpm: float):
    sr = 44100
    audio = _synth_click_track(target_bpm, duration_sec=8.0, sr=sr)
    wav = tmp_path / f"click_{int(target_bpm)}.wav"
    sf.write(str(wav), audio, sr)

    result = detect_tempo_and_beats(wav)

    assert result["bpm"] is not None, "expected a BPM lock on a clean click track"
    # aubio is allowed to land on half/double tempo; accept that.
    candidates = [target_bpm, target_bpm * 2, target_bpm / 2]
    assert any(abs(result["bpm"] - c) < 3.0 for c in candidates), (
        f"target={target_bpm} got={result['bpm']}"
    )
    # aubio's tempo tracker has a ~2s warmup before it starts emitting beats,
    # so a clean 8s click track typically yields 5–10 beats, not the
    # theoretical maximum. Downbeat alignment only needs the first beat.
    assert len(result["beats"]) >= 4, f"too few beats: {len(result['beats'])}"
    assert result["beats"][0] < 4.0, "first beat should land in the first half"
    assert result["samplerate"] == sr
    assert result["duration_sec"] == pytest.approx(8.0, abs=0.05)


# aubio's own reader opens PCM WAV only. These containers made the detector
# drop to the librosa fallback, so one track read 121.7 bpm as a PCM WAV and
# 117.5 bpm as FLAC, float WAV or Opus.
_CONTAINERS = {
    "float-wav": ("wav", "FLOAT"),
    "flac": ("flac", "PCM_16"),
    "opus": ("opus", "OPUS"),
}


@pytest.mark.parametrize("container", sorted(_CONTAINERS))
def test_detect_same_path_and_tempo_for_every_container(tmp_path: Path, container: str):
    ext, subtype = _CONTAINERS[container]
    if subtype == "OPUS" and "OPUS" not in sf.available_subtypes("OGG"):
        pytest.skip("this libsndfile cannot write Opus")
    sr = 48000  # Opus encodes at 48 kHz only
    mono, _ = meter_track([MeterSegment(bpm=120.0, beats_per_bar=4, bars=15)], sr=sr)
    wav = tmp_path / "track.wav"
    save_audio(wav, mono[None, :], sr, subtype="PCM_16")
    other = tmp_path / f"track-{container}.{ext}"
    save_audio(other, mono[None, :], sr, subtype=subtype)

    ref = detect_tempo_and_beats(wav)
    got = detect_tempo_and_beats(other)

    assert ref["bpm"] is not None
    assert got["bpm"] == pytest.approx(ref["bpm"], abs=1.0)
    assert got["samplerate"] == ref["samplerate"] == sr
    assert ref["engine"] == "aubio"
    assert got["engine"] == ref["engine"]


def test_detect_short_file_returns_none(tmp_path: Path):
    sr = 44100
    audio = np.zeros(int(0.5 * sr), dtype=np.float32)
    wav = tmp_path / "short.wav"
    sf.write(str(wav), audio, sr)

    result = detect_tempo_and_beats(wav)

    assert result["bpm"] is None
    assert result["duration_sec"] < 1.0


def test_detect_silent_file_returns_none(tmp_path: Path):
    sr = 44100
    audio = np.zeros(int(3.0 * sr), dtype=np.float32)
    wav = tmp_path / "silent.wav"
    sf.write(str(wav), audio, sr)

    result = detect_tempo_and_beats(wav)

    assert result["bpm"] is None
    assert result["beats"] == []
