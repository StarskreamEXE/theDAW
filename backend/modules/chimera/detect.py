"""BPM and beat detection.

Public API:
    detect_tempo_and_beats(path) -> DetectionResult

aubio is the detector for every container. Its own source reader opens PCM
WAV only (the vendored wheels carry just ``wavread``), so the file is decoded
through ``backend/lib/audio_io.py`` — libsndfile, then the ffmpeg CLI — and
aubio is fed the samples at the file's native rate. FLAC, Opus, MP3, M4A and
float WAV therefore read the same tempo as the PCM WAV of the same audio.
librosa's beat tracker stays as the fallback for a real aubio failure (a file
nothing can decode, or an aubio error). ``engine`` in the result names the
path that ran.

Returns None for `bpm` when the file is too short or no tempo can be locked
(silence, very sparse onsets). The caller decides how to handle that: the
Chimera mashup treats a None-BPM clip as "do not stretch, include as-is."
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional, TypedDict, cast

log = logging.getLogger(__name__)


_WIN_S = 1024
_HOP_S = 512
_MIN_DURATION_SEC = 1.5
_LIBROSA_SR = 22050  # beat tracking is accurate here and half the memory of 44.1k


class DetectionResult(TypedDict):
    bpm: Optional[float]
    beats: list[float]
    confidence: float
    samplerate: int
    duration_sec: float
    engine: str  # "aubio", "librosa", or "none" when both failed


def _empty_result(sr: int = 0, duration_sec: float = 0.0) -> DetectionResult:
    return {
        "bpm": None,
        "beats": [],
        "confidence": 0.0,
        "samplerate": int(sr),
        "duration_sec": duration_sec,
        "engine": "none",
    }


def detect_tempo_and_beats(
    path: str | Path,
    *,
    # y_sr carries a pre-decoded librosa.load(path, sr=22050, mono=True) result; only the librosa fallback consumes it (aubio decodes the file at its native rate through audio_io).
    y_sr: Optional[tuple] = None,
) -> DetectionResult:
    """Detect tempo + beat times (seconds). aubio first, librosa fallback."""
    try:
        return _detect_aubio(path)
    except Exception as e:
        log.info(
            "chimera detect: aubio failed on %s (%s); falling back to librosa",
            Path(path).name,
            e,
        )
        try:
            return _detect_librosa(path, y_sr=y_sr)
        except Exception as e2:
            log.warning(
                "chimera detect: librosa fallback also failed for %s: %s",
                Path(path).name,
                e2,
            )
            return _empty_result()


def _detect_librosa(
    path: str | Path,
    *,
    y_sr: Optional[tuple] = None,
) -> DetectionResult:
    """Tempo + beats via librosa, for a file aubio could not take."""
    import librosa
    import numpy as np

    if y_sr is not None:
        y, sr = y_sr
    else:
        y, sr = librosa.load(str(path), sr=_LIBROSA_SR, mono=True)
    sr = int(sr)
    duration_sec = (len(y) / float(sr)) if sr else 0.0
    if y.size == 0 or duration_sec < _MIN_DURATION_SEC:
        return {**_empty_result(sr, duration_sec), "engine": "librosa"}

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beats = [float(t) for t in librosa.frames_to_time(beat_frames, sr=sr)]
    bpm_val = float(np.atleast_1d(tempo)[0]) if tempo is not None else 0.0
    bpm: Optional[float] = bpm_val if bpm_val > 0 and beats else None

    # Confidence heuristic: how regular the inter-beat intervals are.
    confidence = 0.0
    if len(beats) > 2:
        intervals = np.diff(beats)
        mean_i = float(intervals.mean())
        if mean_i > 0:
            cv = float(intervals.std()) / mean_i
            confidence = max(0.0, min(1.0, 1.0 - cv))

    log.info(
        "chimera detect: %s via librosa: sr=%d dur=%.2f bpm=%s beats=%d conf=%.3f",
        Path(path).name,
        sr,
        duration_sec,
        bpm,
        len(beats),
        confidence,
    )
    return {
        "bpm": bpm,
        "beats": beats,
        "confidence": confidence,
        "samplerate": int(sr),
        "duration_sec": duration_sec,
        "engine": "librosa",
    }


def _detect_aubio(path: str | Path) -> DetectionResult:
    import aubio
    import numpy as np

    from backend.lib.audio_io import load_audio_array

    # Decode here and feed aubio the samples: aubio.source would refuse every
    # container but PCM WAV. The channel mean is aubio.source's own downmix.
    data, sr = load_audio_array(path)
    mono = np.ascontiguousarray(data.mean(axis=0), dtype=np.float32)

    # aubio is a C extension without type stubs — treat as Any so the analyzer
    # doesn't flag .tempo (which it can't resolve).
    a = cast(Any, aubio)
    tempo_o = a.tempo("default", _WIN_S, _HOP_S, sr)

    beats: list[float] = []
    confidences: list[float] = []
    total_frames = 0
    pos = 0

    # Hop by hop, the way aubio.source hands them out: the last hop is padded
    # with zeros and ends the loop.
    while True:
        samples = mono[pos : pos + _HOP_S]
        read = int(samples.size)
        if read < _HOP_S:
            samples = np.pad(samples, (0, _HOP_S - read))
        pos += _HOP_S
        is_beat = tempo_o(samples)
        total_frames += read
        if is_beat:
            beats.append(float(tempo_o.get_last_s()))
            confidences.append(float(tempo_o.get_confidence()))
        if read < _HOP_S:
            break

    duration_sec = total_frames / float(sr) if sr > 0 else 0.0
    bpm_raw = float(tempo_o.get_bpm())

    bpm: Optional[float]
    if duration_sec < _MIN_DURATION_SEC or bpm_raw <= 0 or not beats:
        bpm = None
    else:
        bpm = bpm_raw

    confidence = sum(confidences) / len(confidences) if confidences else 0.0

    log.info(
        "chimera detect: %s via aubio: sr=%d dur=%.2f bpm=%s beats=%d conf=%.3f",
        Path(path).name,
        sr,
        duration_sec,
        bpm,
        len(beats),
        confidence,
    )

    return {
        "bpm": bpm,
        "beats": beats,
        "confidence": confidence,
        "samplerate": int(sr),
        "duration_sec": duration_sec,
        "engine": "aubio",
    }
