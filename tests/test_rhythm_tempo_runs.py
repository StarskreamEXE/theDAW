"""Can the tempo rule follow a staircase?

The songwriter's House of the Rising Sun moves through eight tempo sections --
130, 200, 160, 174, 202, 200, 198, 128, by their own count, "approximations
+-4ish". The engine reported two. The obvious suspect was the tempo curve, and
it was the wrong suspect: handed the songwriter's own numbers as a PERFECT
curve, with no audio and nothing to estimate, the shipped rule still returned
three runs. Whatever else was wrong upstream, the rule was the binding
constraint, and no improvement to the curve could have shown through it.

These tests run on synthetic curves, not audio, which is the point. A rule that
cannot segment a curve it is handed for free will not segment one it has to
estimate. The regime problem that makes the rest of this engine's synthetic
tests untrustworthy does not apply here: there is no signal processing in a run
rule, only arithmetic on a sequence.

Run: `uv run pytest tests/test_rhythm_tempo_runs.py`
"""

from __future__ import annotations

import numpy as np

from backend.modules.rhythm.engine import (
    _HOP,
    _TEMPO_RUN_MIN_SEC,
    SR,
    _tempo_runs,
)

FRAME_SEC = _HOP / SR


def curve(values: list[float], seconds: float = 34.0) -> np.ndarray:
    """A curve that sits on each value in turn, with no noise and no ramp."""
    per = int(round(seconds / FRAME_SEC))
    return np.concatenate([np.full(per, float(v)) for v in values])


def bpms(values: list[float], seconds: float = 34.0) -> list[int]:
    return [round(b) for _, _, b in _tempo_runs(curve(values, seconds), FRAME_SEC)]


def test_a_staircase_is_followed_to_the_top():
    """Every step of an even climb is its own run.

    The shipped rule returned [120, 180] here: an excursion ended only when the
    curve came back to the tempo it had left, so a curve that climbed and
    stayed climbed was one excursion from the second step to the end.
    """
    assert bpms([120, 150, 180, 210]) == [120, 150, 180, 210]
    assert bpms([100, 130, 160, 190]) == [100, 130, 160, 190]


def test_a_staircase_is_followed_to_the_bottom():
    assert bpms([160, 140, 120, 100]) == [160, 140, 120, 100]


def test_the_songwriters_own_eight_sections():
    """House of the Rising Sun, the songwriter's numbers handed over directly.

    Six runs, not eight, and six is right: they gave the numbers as
    "approximations +-4ish", and 202, 200 and 198 are one tempo within that
    tolerance. The rule folds adjacent runs that agree, so it reports the six
    tempos the sequence actually contains. The shipped rule returned three.
    """
    assert bpms([130, 200, 160, 174, 202, 200, 198, 128]) == [
        130,
        200,
        160,
        174,
        200,
        128,
    ]


def test_a_tempo_that_returns_is_two_boundaries_not_one():
    assert bpms([120, 180, 120]) == [120, 180, 120]


def test_a_steady_tempo_is_one_run():
    """The rule must not invent changes. This is the failure mode a looser rule
    trades for, and the one that would make the map worse rather than better."""
    assert bpms([120]) == [120]
    assert bpms([120, 120, 120, 120]) == [120]
    assert len(_tempo_runs(curve([174], seconds=240.0), FRAME_SEC)) == 1


def test_drift_within_the_step_is_not_a_change():
    """A tempo wandering inside the step threshold is one run, however long it
    wanders for. A human player is never metronomic."""
    rng = np.random.default_rng(4)
    wander = 140.0 * (1.0 + 0.015 * np.sin(np.linspace(0, 12 * np.pi, 9000)))
    wander = wander + rng.normal(scale=0.4, size=wander.size)
    runs = _tempo_runs(wander, FRAME_SEC)
    assert len(runs) == 1, f"drift inside the threshold split into {len(runs)} runs"


def test_a_brief_wobble_does_not_open_a_run():
    """A few seconds at another tempo is a fill or a fermata, not a section."""
    steady = np.full(int(round(120.0 / FRAME_SEC)), 150.0)
    steady[4000:4200] = 190.0
    runs = _tempo_runs(steady, FRAME_SEC)
    assert len(runs) == 1, f"a 4.6 s wobble opened {len(runs)} runs"


def test_runs_are_valued_by_their_own_span():
    """A run reports the tempo of the music it covers.

    The merge step used to adopt the neighbour's bpm wholesale, so a merged run
    could report a tempo that appears nowhere inside it.
    """
    c = curve([150, 151, 152, 190, 191, 192], seconds=30.0)
    for a, b, bpm in _tempo_runs(c, FRAME_SEC):
        span = c[a:b]
        assert span.min() - 1 <= bpm <= span.max() + 1, (
            f"run {a}:{b} reports {bpm:.1f}, outside its own span "
            f"[{span.min():.1f}, {span.max():.1f}]"
        )


def test_adjacent_runs_never_carry_the_same_tempo():
    """Re-valuing a merged run can land it on its neighbour's tempo. Two
    adjacent runs at the same tempo are one run, and a map that shows a change
    where nothing changed is worse than one that shows none."""
    for values in ([150, 151, 190, 189, 150], [120, 180, 120], [100, 100, 160]):
        runs = _tempo_runs(curve(values, seconds=30.0), FRAME_SEC)
        for (_, _, x), (_, _, y) in zip(runs, runs[1:]):
            assert abs(np.log(x / y)) > np.log(1.02), (
                f"{values}: adjacent runs {x:.1f} and {y:.1f}"
            )


def test_a_section_shorter_than_the_minimum_folds_away():
    short = int(round((_TEMPO_RUN_MIN_SEC - 4.0) / FRAME_SEC))
    long = int(round(60.0 / FRAME_SEC))
    c = np.concatenate(
        [np.full(long, 120.0), np.full(short, 190.0), np.full(long, 120.0)]
    )
    assert len(_tempo_runs(c, FRAME_SEC)) == 1


def test_an_empty_curve_does_not_crash():
    assert _tempo_runs(np.asarray([]), FRAME_SEC) == []
    assert len(_tempo_runs(np.asarray([120.0]), FRAME_SEC)) == 1
