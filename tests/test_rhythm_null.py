"""The surrogate null under the meter fit: is there any bar here at all?

Every threshold in the rhythm engine was fitted on synthetic signals, where the
evidence score reads near 1.0. On a mastered mix the same score reads 0.00-0.04,
so the thresholds are unreachable and the engine spends 70% of a real album on
its shortest possible bar. A number that means the same thing in both regimes is
the only way out of that, and a rank-based permutation p-value is one: the
chance that a beat-SHUFFLED copy of this same window scores as well.

Shuffling destroys every periodicity while keeping the accent distribution
exactly, so the null says what this window's own accents look like with no
meter in them.

Two properties are load-bearing and both are tested here.

  * On noise, nothing is significant. The obvious cheap version of this -- a
    handful of draws turned into a z-score and mapped through an erf -- reads
    z = +6 on pure Gaussian noise, which would be reported as overwhelming
    evidence for a bar that is not there. Rank, at K=199, does not.
  * On a real cycle, EVERY length that can see the cycle is significant, not
    just the true one: a 7-periodic row is significant at 7 and at 14. That is
    correct and it is the point. Significance says a bar exists; it cannot say
    which one, and anything claiming otherwise from this number is wrong.

Run: `uv run pytest tests/test_rhythm_null.py`
"""

from __future__ import annotations

import time

import numpy as np

from backend.modules.rhythm.engine import (
    _NULL_K,
    _TEMPLATE_MIN_LENGTH,
    best_grouping,
    fit_meter,
)


def _significant(fits, alpha: float = 0.01) -> set[int]:
    return {f.beats_per_bar for f in fits if f.p <= alpha}


def test_noise_has_no_significant_bar_length():
    """Pure noise: no bar length beats its own null.

    This is the falsifier for the whole approach. If it ever fails, the engine
    is inventing meter, which is worse than the collapse it was built to fix.
    """
    for seed in (7, 11, 1984):
        s = np.random.default_rng(seed).normal(size=48)
        fits = fit_meter(s)
        assert fits, "noise should still produce fits, just insignificant ones"
        assert not _significant(fits), (
            f"seed {seed}: {sorted(_significant(fits))} read as significant on noise"
        )
        assert min(f.p for f in fits) > 0.01


def test_a_seven_cycle_is_significant_at_seven_and_its_multiples():
    """A real cycle is found -- at 7 and at 14, because a 14-beat window over a
    7-beat cycle genuinely repeats. The null answers "is there structure", and
    every length that can see the structure answers yes."""
    cycle = np.asarray([3.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0])
    s = np.tile(cycle, 8)[:48] + 0.35 * np.random.default_rng(3).normal(size=48)
    sig = _significant(fit_meter(s))
    assert 7 in sig, f"the true bar was not significant: {sorted(sig)}"
    assert sig <= {7, 14}, f"a length unrelated to 7 read as significant: {sorted(sig)}"


def test_significance_does_not_pick_the_bar():
    """On a 4-periodic row every even length sees the cycle, so significance
    alone cannot choose between them. Pinned so nobody later reads a p-value as
    a bar-length vote."""
    s = np.tile([3.0, 0.0, 1.0, 0.0], 12) + 0.25 * np.random.default_rng(5).normal(
        size=48
    )
    sig = _significant(fit_meter(s))
    assert 4 in sig
    assert len(sig) > 1, (
        "if only one length is ever significant, selection is hiding in the null"
    )
    assert all(n % 2 == 0 for n in sig), f"an odd length saw a 4-cycle: {sorted(sig)}"


def test_the_null_is_deterministic():
    """The same audio gives the same map. A meter map that changed between runs
    would be worse than one that is wrong, so the permutation seed comes from
    the window's own bytes rather than from global randomness."""
    s = np.tile([3.0, 0.0, 1.0, 0.0], 12)
    first = {f.beats_per_bar: f.p for f in fit_meter(s)}
    second = {f.beats_per_bar: f.p for f in fit_meter(s.copy())}
    assert first == second


def test_template_credit_under_four_beats_is_a_dimensional_artefact():
    """A short bar gets template credit for free, and the credit cannot be
    withdrawn on its own.

    `best_grouping` returns a template correlation of 1.0 for a two-point
    profile, because a Pearson correlation on two points is +/-1 whatever the
    numbers are. That is 0.15 of the evidence score handed to the shortest bar
    for having two dimensions rather than for being right.

    Withholding it alone, though, makes a synthetic 6/8 read as 12/8: with
    identical accents in every bar nothing else separates one bar of 6/8 from
    half a bar of 12/8, so the artefact is currently load-bearing. The honest
    separator is pinned in the test below. This test documents the artefact so
    the next reader does not have to rediscover it, and so removing the floor
    without a separator fails loudly here rather than quietly in a map.
    """
    rng = np.random.default_rng(23)
    for _ in range(6):
        assert best_grouping(rng.normal(size=2))[2] > 0.999
    assert best_grouping(rng.normal(size=3))[2] > 0.8

    assert _TEMPLATE_MIN_LENGTH == 4, (
        "the floor value moved; re-measure the artefact before applying it"
    )
    s = np.tile([3.0, 0.0, 1.0, 0.0], 12)
    two = next(f for f in fit_meter(s) if f.beats_per_bar == 2)
    assert two.template_corr > 0.9, (
        "the artefact is no longer being handed out, so the floor may now be "
        "applied -- check the 6/8-versus-12/8 separator below first"
    )


def test_a_repeated_half_bar_is_what_separates_six_eight_from_twelve_eight():
    """The separator that has to land before the template floor can.

    A true 6/8 read at four beats shows two identical halves; a true 12/8 does
    not. That difference, not the template artefact, is the honest reason to
    prefer the shorter bar, and it is what the selection rework will use.
    """

    def half_gap(profile: tuple[float, ...]) -> float:
        p = np.asarray(profile)
        return float(abs(p[:2].mean() - p[2:].mean()) / (abs(p).mean() + 1e-9))

    noise = 0.15 * np.random.default_rng(1).normal(size=48)
    six = np.tile([3.0, 1.0], 24) + noise
    twelve = np.tile([3.0, 1.0, 2.0, 1.0], 12) + noise

    six_gap = half_gap(next(f for f in fit_meter(six) if f.beats_per_bar == 4).profile)
    twelve_gap = half_gap(
        next(f for f in fit_meter(twelve) if f.beats_per_bar == 4).profile
    )

    assert six_gap < 0.08, (
        f"a true 6/8 should have near-identical halves, got {six_gap:.3f}"
    )
    assert twelve_gap > 0.15, (
        f"a true 12/8 should have distinct halves, got {twelve_gap:.3f}"
    )
    assert twelve_gap > 5 * six_gap, "the separation is too small to decide on"


def test_the_null_is_affordable():
    """One permutation pool is shared across every candidate length, so the null
    costs one shuffle per window rather than one per length. A full track is
    roughly 190 windows; the whole analysis budget is seconds, not minutes."""
    s = np.tile([3.0, 0.0, 1.0, 0.0], 12)
    started = time.perf_counter()
    for _ in range(20):
        fit_meter(s)
    elapsed = time.perf_counter() - started
    per_window = elapsed / 20.0
    assert per_window * 190 < 10.0, (
        f"{per_window * 190:.1f}s of null for a track at K={_NULL_K}: too slow to ship"
    )
