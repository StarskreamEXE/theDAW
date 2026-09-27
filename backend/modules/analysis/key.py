"""Musical key detection via chroma + Krumhansl-Schmuckler profiles.

Pure librosa — no extra deps. Cheap enough to run on every imported /
generated track. Returns the most likely key (24 candidates: 12 major +
12 minor) and a correlation confidence in ``[0, 1]``.

Reference: Krumhansl, C. L. (1990). Cognitive Foundations of Musical
Pitch. The profiles below are the canonical major / minor key profiles
from that work.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# The chroma analysis range: librosa.feature.chroma_cqt's own default, seven
# octaves C1..C8 at 36 bins per octave. A clip too short for that is analysed
# with the plan ``chroma_plan`` fits to it.
_FULL_BINS_PER_OCTAVE = 36
# The short-clip resolution: one bin per semitone. Its filters are a third as
# long, so a clip of 0.75 s already holds all seven octaves. On short clips of
# I-IV-V-I progressions (0.4-2 s, all twelve keys) it named the key 60 times
# out of 60, where 36 bins over the octaves that fit named it 48 times.
_SHORT_BINS_PER_OCTAVE = 12
_FULL_OCTAVES = 7
_C1_HZ = 32.70319566257483  # librosa.note_to_hz("C1")
# Below three octaves (C5..C8) the chroma holds too little of the music for a
# key to mean anything; such a clip reports no key.
MIN_CHROMA_OCTAVES = 3
# librosa.estimate_tuning's default FFT size (piptrack's n_fft). A clip shorter
# than one such frame is analysed at A440 instead of estimating its tuning.
_TUNING_FFT = 2048


def _octave_fft_size(sr: float, bins_per_octave: int) -> int:
    """The FFT size librosa's CQT gives each octave at sample rate ``sr``.

    The CQT runs octave by octave, halving the signal between octaves, and
    every octave's filters are the same length in samples: the longest one,
    the lowest bin of the top octave (C7 here), is ``Q * sr / f`` long with
    ``Q = 1 / (2 ** (1 / bins) - 1)``. Each octave's FFT is that length
    rounded up to a power of two.
    """
    q = 1.0 / (2.0 ** (1.0 / bins_per_octave) - 1.0)
    top_octave_low_hz = _C1_HZ * 2.0 ** (_FULL_OCTAVES - 1)
    return 2 ** math.ceil(math.log2(q * sr / top_octave_low_hz))


def _fitted_octaves(n_samples: int, sr: float, bins_per_octave: int) -> int:
    """How many octaves, counted down from C8, a clip of ``n_samples`` fills.

    Octave ``i`` below the top sees the signal halved ``i`` times, and its FFT
    must fit what is left: ``n_samples / 2**i >= fft``. Octaves that fail it
    are left out (librosa would zero-pad a frame longer than the signal and
    warn).
    """
    fft = _octave_fft_size(sr, bins_per_octave)
    if n_samples < fft:
        return 0
    return min(_FULL_OCTAVES, int(math.floor(math.log2(n_samples / fft))) + 1)


@dataclass(frozen=True)
class ChromaPlan:
    """The ``librosa.feature.chroma_cqt`` parameters for one clip (see
    :func:`chroma_plan`), and how much of the full analysis it covers."""

    bins_per_octave: int
    n_octaves: int
    fmin: float
    # None lets chroma_cqt estimate the tuning; a clip shorter than the
    # estimator's frame is taken at A440 (0.0).
    tuning: Optional[float]
    coverage: float


def chroma_plan(n_samples: int, sr: float) -> ChromaPlan:
    """The chroma parameters that fit a clip of ``n_samples`` at ``sr``.

    The full plan (36 bins per octave, C1..C8) whenever the clip holds it,
    from about 3 s. A shorter clip gets one bin per semitone over as many
    octaves as fit it. ``coverage`` is the clip's length over the length the
    full plan needs, capped at 1, and scales the reported confidence: a short
    clip has heard less of the music, whatever its resolution.
    """
    full_fft = _octave_fft_size(sr, _FULL_BINS_PER_OCTAVE)
    full_len = full_fft * 2 ** (_FULL_OCTAVES - 1)
    bins = _FULL_BINS_PER_OCTAVE
    octaves = _fitted_octaves(n_samples, sr, bins)
    if octaves < _FULL_OCTAVES:
        bins = _SHORT_BINS_PER_OCTAVE
        octaves = _fitted_octaves(n_samples, sr, bins)
    return ChromaPlan(
        bins_per_octave=bins,
        n_octaves=octaves,
        fmin=_C1_HZ * 2.0 ** (_FULL_OCTAVES - octaves),
        tuning=None if n_samples >= _TUNING_FFT else 0.0,
        coverage=min(1.0, n_samples / full_len),
    )


# Krumhansl-Schmuckler key profiles. Index 0 = C.
_MAJOR_PROFILE = (
    6.35,
    2.23,
    3.48,
    2.33,
    4.38,
    4.09,
    2.52,
    5.19,
    2.39,
    3.66,
    2.29,
    2.88,
)
_MINOR_PROFILE = (
    6.33,
    2.68,
    3.52,
    5.38,
    2.60,
    3.53,
    2.54,
    4.75,
    3.98,
    2.69,
    3.34,
    3.17,
)
_NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def _correlate(chroma_mean: list[float], profile: tuple[float, ...]) -> list[float]:
    """Compute Pearson correlation of the chroma vector against all 12
    rotations of ``profile``. Returns 12 correlations (one per tonic)."""
    import statistics

    chroma_mean = list(chroma_mean)
    if len(chroma_mean) != 12:
        return [0.0] * 12

    mean_x = statistics.fmean(chroma_mean)
    out: list[float] = []
    for rotation in range(12):
        rotated = profile[-rotation:] + profile[:-rotation]
        mean_y = statistics.fmean(rotated)
        num = sum((x - mean_x) * (y - mean_y) for x, y in zip(chroma_mean, rotated))
        denom_x = sum((x - mean_x) ** 2 for x in chroma_mean) ** 0.5
        denom_y = sum((y - mean_y) ** 2 for y in rotated) ** 0.5
        if denom_x == 0 or denom_y == 0:
            out.append(0.0)
        else:
            out.append(num / (denom_x * denom_y))
    return out


def key_profile_scores(chroma_mean: list[float]) -> tuple[list[float], list[float]]:
    """Correlate a 12-bin mean chroma against all 24 Krumhansl-Schmuckler keys.

    Returns ``(major, minor)``: two 12-element lists of Pearson correlations,
    index 0 = C. Pure Python, importable without librosa.
    """
    chroma_mean = [float(c) for c in chroma_mean]
    return (
        _correlate(chroma_mean, _MAJOR_PROFILE),
        _correlate(chroma_mean, _MINOR_PROFILE),
    )


def detect_key(
    audio_path: Path,
    *,
    # y_sr carries a pre-decoded librosa.load(path, sr=22050, mono=True) result so callers can share one decode.
    y_sr: Optional[tuple] = None,
    # chroma_cqt hop length. 512 is librosa's default (library analysis keeps
    # it); chimera passes 2048 for a ~8x speedup on multi-minute clips.
    chroma_hop: int = 512,
) -> dict[str, Optional[float] | Optional[str]]:
    """Return ``{key, scale, confidence, strength}`` for the audio file.

    ``confidence`` is the winning key's profile correlation in ``[-1, 1]``;
    ``strength`` is that correlation minus the mean of all 24 correlations
    (how much the winner stands out — near 0 means atonal / ambiguous).

    A clip shorter than the full C1..C8 analysis needs (about 3 s) is analysed
    at one bin per semitone over the octaves it fills (all seven from about
    0.75 s), and both numbers are scaled by the clip's share of the 3 s, so a
    short clip reports a low confidence. A clip too short for three octaves
    (under about 46 ms at 22.05 kHz) reports no key.

    On failure (no librosa, unreadable file, silent input) returns
    ``{"key": None, "scale": None, "confidence": None, "strength": None}``.
    """
    out: dict[str, Optional[float] | Optional[str]] = {
        "key": None,
        "scale": None,
        "confidence": None,
        "strength": None,
    }
    try:
        import librosa
    except ImportError:
        return out

    p = Path(audio_path)
    if not p.is_file():
        return out

    if y_sr is not None:
        y, sr = y_sr
    else:
        try:
            y, sr = librosa.load(str(p), sr=22050, mono=True)
        except Exception as e:
            log.info("analysis.key: librosa load failed for %s: %s", p.name, e)
            return out

    if y.size == 0:
        return out
    plan = chroma_plan(int(y.size), float(sr))
    if plan.n_octaves < MIN_CHROMA_OCTAVES:
        return out

    try:
        chroma = librosa.feature.chroma_cqt(
            y=y,
            sr=sr,
            hop_length=int(chroma_hop),
            fmin=plan.fmin,
            n_octaves=plan.n_octaves,
            bins_per_octave=plan.bins_per_octave,
            tuning=plan.tuning,
        )
    except Exception as e:
        log.info("analysis.key: chroma_cqt failed for %s: %s", p.name, e)
        return out

    chroma_mean = [float(c) for c in chroma.mean(axis=1)]

    major_corr, minor_corr = key_profile_scores(chroma_mean)

    best_major_idx = max(range(12), key=lambda i: major_corr[i])
    best_minor_idx = max(range(12), key=lambda i: minor_corr[i])

    if major_corr[best_major_idx] >= minor_corr[best_minor_idx]:
        out["key"] = _NOTE_NAMES[best_major_idx]
        out["scale"] = "major"
        best = float(major_corr[best_major_idx])
    else:
        out["key"] = _NOTE_NAMES[best_minor_idx]
        out["scale"] = "minor"
        best = float(minor_corr[best_minor_idx])

    all_corr = major_corr + minor_corr
    mean_corr = sum(all_corr) / len(all_corr)
    out["confidence"] = best * plan.coverage
    out["strength"] = (best - mean_corr) * plan.coverage

    return out
