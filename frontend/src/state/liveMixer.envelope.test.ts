// laneEnvelopeEvents — the ONE description of what an automation lane does to an
// AudioParam, shared by live playback and the offline bounces.
//
// Before this, the live scheduler and the offline `scheduleParamLane` each wrote
// their own loop and BOTH emitted `linearRampToValueAtTime` for every segment, so
// a breakpoint carrying a curve played back flat. The event list below is now the
// single source: linear segments stay ramps, a curved segment becomes one
// `setValueCurveAtTime` sampled off `interpolatePoints`, and the same list drives
// the real param live and the OfflineAudioContext on export.
//
// The constraints the 'curve' events are held to here come from the Web Audio API
// spec (https://webaudio.github.io/web-audio-api/#dom-audioparam-setvaluecurveattime,
// read 2026-09-15) and MDN's AudioParam.setValueCurveAtTime page:
//   - "If setValueCurveAtTime() is called for time T and duration D and there are
//     any events having a time strictly greater than T, but strictly less than
//     T+D, then a NotSupportedError exception MUST be thrown … it's ok to schedule
//     a value curve exactly at the time of another event." So back-to-back curves
//     and a ramp landing exactly on a curve's end are legal; anything strictly
//     inside the window is not. `noEventInsideACurve` below is that rule.
//   - `values` shorter than 2 throws InvalidStateError, and `duration` must be
//     finite and strictly positive (RangeError) — hence N is clamped to >= 2 and
//     zero-length segments never become curves.
//   - "An implicit call to setValueAtTime() is made at time T0+TD with value
//     V[N-1]", i.e. the LAST curve value holds and the next ramp starts from it.
//     That is why the last sample is pinned exactly to the segment's end value
//     rather than left to floating-point luck.
import assert from 'node:assert/strict';
import { laneEnvelopeEvents, applyEnvelopeEvents, type EnvelopeEvent } from './liveMixer.ts';
import { interpolatePoints, type CurvePoint } from '../lib/automationModes.ts';

/* ── An AudioParam that only records ──────────────────────────────────────── */

type Call =
  | ['setValueAtTime', number, number]
  | ['linearRampToValueAtTime', number, number]
  | ['setValueCurveAtTime', Float32Array, number, number];

const recorder = () => {
  const calls: Call[] = [];
  return {
    calls,
    setValueAtTime(v: number, t: number) { calls.push(['setValueAtTime', v, t]); },
    linearRampToValueAtTime(v: number, t: number) { calls.push(['linearRampToValueAtTime', v, t]); },
    setValueCurveAtTime(values: Float32Array, t: number, d: number) { calls.push(['setValueCurveAtTime', values, t, d]); },
  };
};

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
/** Float32Array rounds every sample to single precision, so a curve's endpoints
 *  can only be exact to ~1e-7 of full scale. */
const F32 = 1e-7;
const kinds = (evs: EnvelopeEvent[]) => evs.map((e) => e.kind);

/** The common live case: playback just started, so the context clock and the
 *  timeline are pinned together at `fromSec`. */
const live = (points: CurvePoint[], fromSec: number, now = 100) =>
  laneEnvelopeEvents({ points }, fromSec, now, fromSec, now);

/* ── 1. A linear lane is set + ramps, exactly as before ───────────────────── */

function linearLaneIsSetAndRamps(): void {
  const points: CurvePoint[] = [{ t: 0, v: 0.2 }, { t: 2, v: 0.8 }, { t: 4, v: 0.5 }];
  const evs = live(points, 0);
  assert.deepEqual(kinds(evs), ['set', 'ramp', 'ramp'], 'no curves anywhere on a curve-less lane');

  const anchor = evs[0];
  assert.ok(anchor.kind === 'set');
  assert.equal(anchor.when, 100, 'the anchor sits at the context clock, not the timeline');
  assert.equal(anchor.v, 0.2, 'anchored at the lane value under the playhead');

  const r1 = evs[1];
  const r2 = evs[2];
  assert.ok(r1.kind === 'ramp' && r2.kind === 'ramp');
  assert.deepEqual([r1.v, r1.when], [0.8, 102]);
  assert.deepEqual([r2.v, r2.when], [0.5, 104]);
}

/** Playback starting mid-lane anchors at the interpolated value and keeps only
 *  the breakpoints still ahead of the playhead. */
function midLaneStartAnchorsAtTheSampledValue(): void {
  const points: CurvePoint[] = [{ t: 0, v: 0 }, { t: 2, v: 1 }, { t: 4, v: 0 }];
  const evs = live(points, 1);
  assert.deepEqual(kinds(evs), ['set', 'ramp', 'ramp']);
  const a = evs[0];
  assert.ok(a.kind === 'set');
  assert.ok(close(a.v, 0.5), `half way up the first ramp, got ${a.v}`);
}

/* ── 2. A point at or before `fromSec` leaves only the anchor ─────────────── */

function pointsBehindThePlayheadAreJustTheAnchor(): void {
  const points: CurvePoint[] = [{ t: 0, v: 0.25 }, { t: 1, v: 0.9 }];
  const evs = live(points, 5); // both breakpoints are behind us
  assert.deepEqual(kinds(evs), ['set'], 'nothing is scheduled for a lane that is entirely in the past');
  const a = evs[0];
  assert.ok(a.kind === 'set');
  assert.equal(a.v, 0.9, 'the last value holds after the last point');
  assert.equal(a.when, 100);
}

/** A lane whose points sit in the future of the TIMELINE but in the past of the
 *  CONTEXT clock (a late re-schedule) collapses to a set at `now`, never a ramp
 *  into the past. */
function pointsBehindTheContextClockBecomeSets(): void {
  const points: CurvePoint[] = [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 9, v: 0.3 }];
  // now is 2 s AHEAD of where the transport thinks it started.
  const evs = laneEnvelopeEvents({ points }, 0, 100, 0, 102);
  assert.deepEqual(kinds(evs), ['set', 'set', 'ramp']);
  const late = evs[1];
  assert.ok(late.kind === 'set');
  assert.deepEqual([late.v, late.when], [1, 102], 'the passed breakpoint lands at `now`, not at 101');
}

/* ── 3. A curved point becomes one curve event ───────────────────────────── */

function curvedSegmentBecomesACurve(): void {
  const p0: CurvePoint = { t: 0, v: 0.2, curve: 0.75 };
  const p1: CurvePoint = { t: 2, v: 0.9 };
  const evs = live([p0, p1], 0);
  assert.deepEqual(kinds(evs), ['set', 'curve']);

  const c = evs[1];
  assert.ok(c.kind === 'curve');
  assert.equal(c.start, 100, 'the curve starts where the segment starts on the context clock');
  assert.ok(close(c.duration, 2), `two seconds of segment, got ${c.duration}`);

  // N = clamp(ceil(duration * 200), 2, 512) -> ceil(400) = 400.
  assert.equal(c.values.length, 400);

  // Endpoints are the segment's own values (to float32, which is what a
  // Float32Array can hold — the spec's implicit setValueAtTime at T0+TD is what
  // the next ramp departs from, so the end must not drift).
  assert.ok(close(c.values[0], p0.v, F32), `first sample is the segment start: ${c.values[0]}`);
  assert.ok(close(c.values[c.values.length - 1], p1.v, F32), `last sample is the segment end: ${c.values[c.values.length - 1]}`);

  // The interior is `interpolatePoints`, i.e. `curveShape`, not a straight line.
  const n = c.values.length;
  for (const k of [1, 37, n >> 2, n >> 1, n - 2]) {
    const t = p0.t + (p1.t - p0.t) * (k / (n - 1));
    assert.ok(
      close(c.values[k], interpolatePoints(p0, p1, t), 1e-5),
      `sample ${k}: ${c.values[k]} != ${interpolatePoints(p0, p1, t)}`,
    );
  }
  const linearMid = (p0.v + p1.v) / 2;
  assert.ok(
    c.values[n >> 1] - linearMid > 0.05,
    'a +0.75 curve must be clearly ahead of the straight line at halfway',
  );
}

/** Only the segment that carries the curve bends; its neighbours stay ramps, and
 *  a 0 (or absent) curve is a ramp like it always was. */
function onlyTheCurvedSegmentBends(): void {
  const points: CurvePoint[] = [
    { t: 0, v: 0 },
    { t: 1, v: 1, curve: -0.6 },
    { t: 3, v: 0.4, curve: 0 },
    { t: 4, v: 0.4 },
  ];
  const evs = live(points, 0);
  assert.deepEqual(kinds(evs), ['set', 'ramp', 'curve', 'ramp']);
}

/* ── 4. A curve that would start at or before `now` degrades ─────────────── */

function aCurveStartingInThePastDegrades(): void {
  const p0: CurvePoint = { t: 0, v: 0, curve: 0.5 };
  const p1: CurvePoint = { t: 4, v: 1 };
  // Start playback 1 s into the curved segment.
  const evs = live([p0, p1], 1);
  assert.deepEqual(kinds(evs), ['set', 'curve'], 'a set of the value at fromSec, then the rest of the curve');

  const a = evs[0];
  const c = evs[1];
  assert.ok(a.kind === 'set' && c.kind === 'curve');

  const vAtFrom = interpolatePoints(p0, p1, 1);
  assert.ok(close(a.v, vAtFrom), `anchor is the value at fromSec: ${a.v} vs ${vAtFrom}`);
  assert.equal(c.start, 100, 'the sub-curve starts at `now`, never before it');
  assert.ok(close(c.duration, 3), `only the remaining 3 s are scheduled, got ${c.duration}`);
  assert.ok(close(c.values[0], vAtFrom, F32), 'the sub-curve resumes from the value under the playhead');
  assert.ok(close(c.values[c.values.length - 1], p1.v, F32));

  // The sub-curve is a WINDOW onto the same shape, not a fresh curve from 0.
  const n = c.values.length;
  const mid = interpolatePoints(p0, p1, 1 + 3 * ((n >> 1) / (n - 1)));
  assert.ok(close(c.values[n >> 1], mid, 1e-5), `sub-curve interior follows the parent shape (${c.values[n >> 1]} vs ${mid})`);
}

/** Same degrade when the CONTEXT clock has run past the segment start even though
 *  the timeline has not (a re-schedule that arrives late). */
function aCurveBehindTheContextClockAlsoDegrades(): void {
  const points: CurvePoint[] = [{ t: 0, v: 0, curve: 0.5 }, { t: 4, v: 1 }];
  const evs = laneEnvelopeEvents({ points }, 0, 100, 0, 101.5);
  const c = evs[1];
  assert.ok(c.kind === 'curve');
  assert.equal(c.start, 101.5);
  assert.ok(close(c.duration, 2.5), `got ${c.duration}`);
  assert.ok(close(c.values[0], interpolatePoints(points[0], points[1], 1.5), 1e-6));
}

/* ── 5. N is clamped both ways, and a zero-length segment is never a curve ── */

function sampleCountIsClamped(): void {
  const tiny = live([{ t: 0, v: 0, curve: 1 }, { t: 0.001, v: 1 }], 0);
  const t = tiny[1];
  assert.ok(t.kind === 'curve');
  assert.equal(t.values.length, 2, 'ceil(0.2) = 1 is floored to the 2 the spec demands');

  const long = live([{ t: 0, v: 0, curve: 1 }, { t: 60, v: 1 }], 0);
  const l = long[1];
  assert.ok(l.kind === 'curve');
  assert.equal(l.values.length, 512, 'ceil(12000) is capped at 512');

  // Two breakpoints at the same instant cannot become a zero-duration curve —
  // `duration` must be strictly positive or setValueCurveAtTime throws RangeError.
  const degenerate = live([{ t: 0, v: 0 }, { t: 2, v: 0.5, curve: 0.8 }, { t: 2, v: 1 }], 0);
  assert.ok(!degenerate.some((e) => e.kind === 'curve' && !(e.duration > 0)), 'no zero-duration curve');
}

/* ── 6. The list is legal to hand to a real AudioParam ───────────────────── */

function noEventInsideACurve(): void {
  const points: CurvePoint[] = [
    { t: 0, v: 0.1, curve: 0.4 },
    { t: 1.5, v: 0.9, curve: -0.9 },
    { t: 3, v: 0.2 },
    { t: 5, v: 0.7, curve: 0.2 },
    { t: 6, v: 0.1 },
  ];
  const evs = live(points, 0.5);
  const at = (e: EnvelopeEvent) => (e.kind === 'curve' ? e.start : e.when);
  const curves = evs.filter((e): e is Extract<EnvelopeEvent, { kind: 'curve' }> => e.kind === 'curve');
  assert.ok(curves.length >= 2, 'this lane has several curved segments');
  for (const c of curves) {
    const end = c.start + c.duration;
    for (const e of evs) {
      if (e === c) continue; // an event cannot overlap itself — compare by identity,
      //                        not by time: two curves may legally share a start
      assert.ok(
        !(at(e) > c.start && at(e) < end),
        `event at ${at(e)} falls strictly inside the curve window [${c.start}, ${end}) — NotSupportedError`,
      );
    }
  }
  // …and the list is contiguous: nothing is scheduled before a curve has finished,
  // which is what makes the rule above hold for every lane rather than this one.
  for (let i = 0; i < evs.length - 1; i += 1) {
    const e = evs[i];
    if (e.kind !== 'curve') continue;
    assert.ok(
      at(evs[i + 1]) >= e.start + e.duration,
      `the event after a curve must land at or after its end (${at(evs[i + 1])} vs ${e.start + e.duration})`,
    );
  }
}

/** Ascending order is load-bearing (the cursor rule, and `sampleCurve`'s binary
 *  search), and the store's writers keep it — but a hand-edited or imported
 *  project need not. An out-of-order lane is sorted first, so it schedules exactly
 *  what its sorted form does instead of dropping a `set` behind a placed curve. */
function unsortedPointsScheduleAsIfSorted(): void {
  const sorted: CurvePoint[] = [
    { t: 0, v: 0.1, curve: 0.5 },
    { t: 1, v: 0.9 },
    { t: 2.5, v: 0.3, curve: -0.4 },
    { t: 4, v: 0.7 },
  ];
  const shuffled: CurvePoint[] = [sorted[2], sorted[0], sorted[3], sorted[1]];
  assert.deepEqual(live(shuffled, 0), live(sorted, 0));
  assert.deepEqual(live(shuffled, 1.5), live(sorted, 1.5), 'and from a playhead inside the lane');
  // The un-sorted input itself is left alone — the sort works on a copy.
  assert.deepEqual(shuffled, [sorted[2], sorted[0], sorted[3], sorted[1]]);
}

function applyWritesTheParamInOrder(): void {
  const points: CurvePoint[] = [{ t: 0, v: 0.2 }, { t: 1, v: 0.8, curve: 0.5 }, { t: 3, v: 0.4 }];
  const p = recorder();
  applyEnvelopeEvents(p, live(points, 0));
  assert.deepEqual(
    p.calls.map((c) => c[0]),
    ['setValueAtTime', 'linearRampToValueAtTime', 'setValueCurveAtTime'],
  );
  const curve = p.calls[2];
  assert.equal(curve[0], 'setValueCurveAtTime');
  assert.ok(curve[1] instanceof Float32Array);
  assert.equal(curve[2], 101);
  assert.ok(close(curve[3] as number, 2));
}

/** The offline bounce clamps every value into the param's legal range (a pan
 *  lane cannot leave [-1, 1]); the clamp has to reach INSIDE a curve too, or a
 *  curved pan lane would be the one path that escapes it. */
function applyClampsCurveSamplesToo(): void {
  const points: CurvePoint[] = [{ t: 0, v: -4, curve: 0.5 }, { t: 2, v: 4 }];
  const p = recorder();
  applyEnvelopeEvents(p, laneEnvelopeEvents({ points }, 0, 0, 0, 0), (v) => Math.max(-1, Math.min(1, v)));
  const anchor = p.calls[0];
  assert.equal(anchor[1], -1, 'the anchor is clamped');
  const curve = p.calls[1];
  assert.equal(curve[0], 'setValueCurveAtTime');
  const values = curve[1] as Float32Array;
  assert.ok(values.every((v) => v >= -1 && v <= 1), 'every curve sample is clamped');
  assert.equal(values[0], -1);
  assert.equal(values[values.length - 1], 1);
}

/** A param with no `setValueCurveAtTime` (an older shim, or a test double) still
 *  gets the SHAPE — walked as ramps — rather than a silently flattened segment. */
function applyFallsBackToRampsWithoutCurveSupport(): void {
  const calls: [string, number, number][] = [];
  const bare = {
    setValueAtTime(v: number, t: number) { calls.push(['setValueAtTime', v, t]); },
    linearRampToValueAtTime(v: number, t: number) { calls.push(['linearRampToValueAtTime', v, t]); },
  };
  // A linear segment first, so the curved one starts a second AFTER `now`. The
  // walk has to pin the value at the curve's own start — which is what the real
  // setValueCurveAtTime does by simply doing nothing until then — instead of
  // sliding towards it from whatever came before.
  const points: CurvePoint[] = [{ t: 0, v: 0.2 }, { t: 1, v: 0.4, curve: 0.8 }, { t: 3, v: 1 }];
  applyEnvelopeEvents(bare, live(points, 0));
  const sets = calls.filter((c) => c[0] === 'setValueAtTime');
  assert.equal(sets.length, 2, 'the lane anchor, then the curve start');
  assert.deepEqual([sets[0][1], sets[0][2]], [0.2, 100], 'anchor');
  assert.equal(sets[1][2], 101, 'the curve begins a second after `now`');
  assert.ok(close(sets[1][1], 0.4, F32), 'pinned at the segment start value, not ramped into');
  const ramps = calls.filter((c) => c[0] === 'linearRampToValueAtTime');
  assert.ok(ramps.length > 2, `the curve is walked, not collapsed (${ramps.length} ramps)`);
  assert.equal(ramps[ramps.length - 1][1], 1, 'and it still lands on the segment end value');
  const times = calls.map((c) => c[2]);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'times stay monotonic');
}

/* ── 7. An empty lane schedules nothing ──────────────────────────────────── */

function emptyLaneIsNoEvents(): void {
  assert.deepEqual(laneEnvelopeEvents({ points: [] }, 0, 0, 0, 0), []);
}

linearLaneIsSetAndRamps();
midLaneStartAnchorsAtTheSampledValue();
pointsBehindThePlayheadAreJustTheAnchor();
pointsBehindTheContextClockBecomeSets();
curvedSegmentBecomesACurve();
onlyTheCurvedSegmentBends();
aCurveStartingInThePastDegrades();
aCurveBehindTheContextClockAlsoDegrades();
sampleCountIsClamped();
noEventInsideACurve();
unsortedPointsScheduleAsIfSorted();
applyWritesTheParamInOrder();
applyClampsCurveSamplesToo();
applyFallsBackToRampsWithoutCurveSupport();
emptyLaneIsNoEvents();

console.log('liveMixer.envelope: ok');
