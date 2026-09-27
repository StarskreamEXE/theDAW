"""Key detection on clips shorter than the full chroma analysis.

librosa.feature.chroma_cqt's default range, C1..C8 at 36 bins per octave,
needs about 3 s of audio: below that its lowest octaves get an FFT longer than
what is left of the signal, librosa zero-pads it and warns ("n_fft=1024 is too
large for input signal of length=690"), and those octaves are mostly padding.
The only guard was ``y.size < 1024``, so every clip between 46 ms and 3 s
warned. detect_key now fits the analysis to the clip and scales its
confidence by how much of the 3 s the clip held.

Each test runs with UserWarnings raised as errors (librosa's "n_fft is too
large" is one), so a clip that still gets an FFT larger than itself fails the
test.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from backend.lib.audio_io import save_audio
from backend.modules.analysis import key as key_mod

pytestmark = pytest.mark.filterwarnings("error::UserWarning")

SR = 22050
_NAMES = key_mod._NOTE_NAMES


def _progression(tonic: int, seconds: float, sr: int = SR) -> np.ndarray:
    """I-IV-V-I in the major key on ``tonic`` (0 = C): a bass note an octave
    below each triad, four harmonics per note, one chord per quarter."""
    n = int(round(seconds * sr))
    base = 110.0 * 2.0 ** ((tonic - 9) / 12.0)  # tonic in the A2 octave
    y = np.zeros(n)
    seg = max(1, n // 4)
    for i, chord in enumerate(((0, 4, 7), (5, 9, 12), (7, 11, 14), (0, 4, 7))):
        start, stop = i * seg, n if i == 3 else (i + 1) * seg
        t = np.arange(stop - start) / sr
        notes = [(base / 2 * 2.0 ** (chord[0] / 12.0), 0.6)] + [
            (base * 2.0 ** (iv / 12.0), 0.4) for iv in chord
        ]
        for f, gain in notes:
            for h in (1, 2, 3, 4):
                y[start:stop] += gain * np.sin(2 * np.pi * f * h * t) / h
    return (y / max(1e-9, float(np.max(np.abs(y)))) * 0.8).astype(np.float32)


def _clip(tmp_path: Path, tonic: int, seconds: float, sr: int = SR) -> Path:
    path = tmp_path / f"clip-{tonic}-{seconds}-{sr}.wav"
    save_audio(path, _progression(tonic, seconds, sr)[None, :], sr)
    return path


@pytest.mark.parametrize("seconds", [0.5, 0.75, 1.0, 1.5, 2.0, 2.9])
def test_a_short_clip_gets_its_key_without_a_padded_analysis(
    tmp_path: Path, seconds: float
) -> None:
    """E major, decoded from the file the way the library analysis does."""
    result = key_mod.detect_key(_clip(tmp_path, 4, seconds))
    assert (result["key"], result["scale"]) == ("E", "major")
    confidence = result["confidence"]
    assert isinstance(confidence, float)
    assert 0.0 < confidence < 1.0


def test_confidence_grows_with_the_length_heard(tmp_path: Path) -> None:
    confidences = []
    for seconds in (0.5, 1.0, 2.0, 4.0):
        result = key_mod.detect_key(_clip(tmp_path, 7, seconds))
        assert (result["key"], result["scale"]) == ("G", "major")
        confidences.append(result["confidence"])
    assert confidences == sorted(confidences)
    assert confidences[0] < 0.25 * confidences[-1], "half a second reads as a guess"


def test_every_key_on_a_short_clip(tmp_path: Path) -> None:
    """Handed the decoded clip (y_sr), as the chimera analysis does."""
    for tonic in range(12):
        path = _clip(tmp_path, tonic, 0.8)
        y = _progression(tonic, 0.8)
        result = key_mod.detect_key(path, y_sr=(y, SR))
        assert (result["key"], result["scale"]) == (_NAMES[tonic], "major"), tonic


def test_a_clip_too_short_for_three_octaves_reports_no_key(tmp_path: Path) -> None:
    result = key_mod.detect_key(_clip(tmp_path, 0, 0.04))
    assert result == {"key": None, "scale": None, "confidence": None, "strength": None}


def test_a_long_clip_keeps_librosas_default_analysis(tmp_path: Path) -> None:
    """From about 3 s the plan is chroma_cqt's own default, so a long track's
    key and confidence are what they were before short clips were handled."""
    import librosa

    y = _progression(2, 4.0)
    path = tmp_path / "long.wav"
    save_audio(path, y[None, :], SR)
    plan = key_mod.chroma_plan(y.size, SR)
    assert (plan.bins_per_octave, plan.n_octaves, plan.tuning, plan.coverage) == (
        36,
        7,
        None,
        1.0,
    )
    assert plan.fmin == pytest.approx(librosa.note_to_hz("C1"))

    result = key_mod.detect_key(path, y_sr=(y, SR))
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=512)
    major, minor = key_mod.key_profile_scores([float(c) for c in chroma.mean(axis=1)])
    assert result["confidence"] == pytest.approx(max(major + minor))


@pytest.mark.parametrize("sr", [16000, 22050, 44100, 48000])
@pytest.mark.parametrize("hop", [512, 2048])
def test_no_length_gets_an_fft_larger_than_itself(
    tmp_path: Path, sr: int, hop: int
) -> None:
    """Lengths on both sides of every octave boundary of both plans, at the
    rates callers decode at and the two hop sizes they pass."""
    path = tmp_path / "x.wav"
    path.write_bytes(b"")
    lengths: set[int] = set()
    for bins in (key_mod._SHORT_BINS_PER_OCTAVE, key_mod._FULL_BINS_PER_OCTAVE):
        fft = key_mod._octave_fft_size(sr, bins)
        for i in range(key_mod._FULL_OCTAVES):
            edge = fft * 2**i
            lengths.update({edge - 1, edge, edge + 1})
    for n in sorted(lengths):
        y = _progression(9, n / sr, sr)
        key_mod.detect_key(path, y_sr=(y, sr), chroma_hop=hop)
