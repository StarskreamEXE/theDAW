"""The high-quality resampler options for ffmpeg's ``aresample`` on this machine.

libsoxr is the mastering-grade engine High-Quality SRC, Classical Upsample and
Super-Res ask for, but it is an optional ffmpeg dependency. gyan.dev's
"essentials" Windows build, the one other audio tools bundle and put on PATH,
is built without it, and there ``aresample=resampler=soxr`` fails the whole
render with "Requested resampling engine is unavailable". Those three tools
answered a bare 500 on such a machine.

``hq_resampler`` answers soxr at the requested precision when this ffmpeg has
it, and otherwise ffmpeg's own swr engine with the same precision mapped onto
its filter: at 28 bits a 256-tap Kaiser (beta 14) polyphase filter with 2^16
phases and no linear interpolation, cutoff at 0.96 of the output Nyquist;
each 2 bits less halves the taps and takes 2 off the Kaiser beta. Measured on
a 96 kHz to 44.1 kHz conversion at 28: flat to 20 kHz, and a 30 or 40 kHz
tone folds back at -140 dB (swr's defaults: -1.3 dB at 20 kHz and -100 dB).
"""

from __future__ import annotations

import functools
import shutil
import subprocess

from backend.lib.launch_token import child_env


def swr_hq(precision: int = 28) -> str:
    """swr options whose quality follows soxr's ``precision`` (20-28 bits)."""
    bits = max(20, min(28, int(precision)))
    taps = 16 * 2 ** ((bits - 20) // 2)
    beta = 6 + (bits - 20)
    phase_shift = 10 + round((bits - 20) * 0.75)
    return (
        f"resampler=swr:filter_size={taps}:phase_shift={phase_shift}:linear_interp=0"
        f":cutoff=0.96:filter_type=kaiser:kaiser_beta={beta}"
    )


@functools.lru_cache(maxsize=1)
def soxr_available() -> bool:
    """Whether the ffmpeg on PATH can resample through libsoxr. Probed once
    per process with a 10 ms silent conversion; False when ffmpeg is missing,
    fails or hangs."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return False
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=mono",
        "-t",
        "0.01",
        "-af",
        "aresample=48000:resampler=soxr",
        "-f",
        "null",
        "-",
    ]
    try:
        # stdin=DEVNULL: the backend does not always own a console, and an
        # inherited handle makes ffmpeg's console reader block forever.
        proc = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=child_env(),
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def hq_resampler(precision: int = 28) -> str:
    """``aresample`` options for a high-quality conversion: soxr at
    ``precision`` bits when available, else ``swr_hq(precision)``."""
    if soxr_available():
        return f"resampler=soxr:precision={precision}"
    return swr_hq(precision)
