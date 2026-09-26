/**
 * djAutomixPlan — the DJ Automix transition brain, tested outside React.
 *
 * Every branch of the five pure functions the automix interval now leans on:
 *
 *   planTransition — when the blend starts, quantised DOWN to a 16-beat
 *     phrase boundary; refuses to start into an unanalysed/undecoded incoming
 *     track until the outgoing one is nearly gone; and rescues dead air when
 *     the outgoing track already ended.
 *   fadeStep      — the crossfader position during a fade; MUST land exactly
 *     on `to` (a fade that stops short parks the fader mid-blend).
 *   eqSwap        — the bass swap across the middle third of the fade.
 *   tempoMatch    — never claims a beatmatch the pitch range cannot deliver.
 *   chooseNextIndex — harmonic next-track preference (Camelot).
 *
 * Run: `npx tsx src/lib/djAutomixPlan.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  camelotCompatible,
  chooseNextIndex,
  eqSwap,
  fadeStep,
  planTransition,
  tempoMatch,
  type AutomixIncoming,
  type AutomixOutgoing,
} from './djAutomixPlan';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ═════════════════════════════ planTransition ═════════════════════════════ */
{
  // 128 BPM: beat = 0.46875 s, a 16-beat phrase = 7.5 s, grid anchored at 0.5.
  const beatLen = 60 / 128;
  const out = (over: Partial<AutomixOutgoing> = {}): AutomixOutgoing => ({
    currentTime: 0, duration: 300, bpm: 128, gridAnchor: 0.5, beatLen,
    playing: true, mixOut: null, downbeats: null, ...over,
  });
  const inc = (over: Partial<AutomixIncoming> = {}): AutomixIncoming => ({
    bpm: 124, hasBuffer: true, cueIn: null, ...over,
  });
  const plan = (o: Partial<AutomixOutgoing>, i: Partial<AutomixIncoming> = {}, extra: { forced?: boolean } = {}) =>
    planTransition({ outgoing: out(o), incoming: inc(i), fadeSec: 10, tailSec: 18, now: 1000, ...extra });

  // ── phrase quantisation ──────────────────────────────────────────────────
  // Tail rule puts the raw mix-out at 300 - 18 = 282 s. Phrase lines sit at
  // 0.5 + k·7.5 → 278 is the last one at or before 282, so THAT is the start
  // (a DJ starts a blend on a phrase, not 4 s into one).
  const p0 = plan({ currentTime: 200 });
  assert.ok(near(p0.startAt!, 278), `phrase-quantised start, got ${p0.startAt}`);
  assert.equal(p0.phraseAligned, true, 'a known grid gives a phrase-aligned start');
  assert.equal(p0.start, false, 'not started 80 s early');
  assert.equal(p0.reason, 'not-due');

  assert.equal(plan({ currentTime: 277.9 }).start, false, 'a hair before the phrase line: still waiting');
  const p1 = plan({ currentTime: 278.1 });
  assert.equal(p1.start, true, 'at/after the phrase line: blend starts');
  assert.equal(p1.reason, 'phrase');
  assert.equal(p1.matched, true, 'both BPMs known → the plan claims a beatmatch');
  assert.equal(p1.startedAt, 1000, 'the fade clock starts at the `now` handed in (audio clock, not performance.now)');
  assert.equal(p1.fadeSec, 10);

  // A prepared set's exact mixOut point replaces the tail rule, and is phrase
  // quantised the same way: 0.5 + 7.5k ≤ 120 → 113.
  const pm = plan({ currentTime: 0, mixOut: 120 });
  assert.ok(near(pm.startAt!, 113), `mixOut quantised down to a phrase, got ${pm.startAt}`);

  // No grid (analysis never landed for the OUTGOING deck) → no quantisation,
  // and the plan says so rather than pretending.
  const pn = plan({ currentTime: 0, beatLen: null, gridAnchor: null, bpm: null });
  assert.ok(near(pn.startAt!, 282), 'without a grid the raw tail point is the start');
  assert.equal(pn.phraseAligned, false);
  assert.equal(plan({ currentTime: 283, beatLen: null, gridAnchor: null, bpm: null }).matched, false,
    'outgoing BPM unknown → not a matched mix');

  // Unknown duration and no mixOut: nothing to aim at, never due on its own.
  const pu = plan({ currentTime: 10, duration: 0 });
  assert.equal(pu.startAt, null);
  assert.equal(pu.start, false, 'unknown duration: the tail rule is inert');

  // ── downbeats beat the raw grid ──────────────────────────────────────────
  // Downbeats every 4 beats from 1.0; a 16-beat multiple of the FIRST one is
  // 1.0 + 7.5·k → 278.5 is the last such downbeat at or before 282.
  const db: number[] = [];
  for (let k = 0; k < 200; k++) db.push(1 + k * 4 * beatLen);
  const pd = plan({ currentTime: 200, downbeats: db });
  assert.ok(near(pd.startAt!, 278.5), `downbeat on a 16-beat multiple, got ${pd.startAt}`);
  assert.equal(pd.phraseAligned, true);
  assert.ok(pd.startAt !== 278, 'the downbeat list wins over the bare grid anchor');
  // Downbeats that are all past the mix-out point fall back to the grid.
  assert.ok(near(plan({ currentTime: 200, downbeats: [290, 297.5] }).startAt!, 278),
    'no usable downbeat before the mix-out → grid quantisation');

  // ── incoming not ready ───────────────────────────────────────────────────
  // Buffer decoded but BPM still unknown: refuse, we would be mixing blind.
  const pb = plan({ currentTime: 285 }, { bpm: null });
  assert.equal(pb.start, false, 'incoming BPM unknown and plenty of track left: wait');
  assert.equal(pb.reason, 'incoming-not-ready');
  // …until the outgoing track is inside tailSec/2 (9 s) of the end. Then a
  // messy mix beats dead air — but the plan admits it is unmatched.
  const pb2 = plan({ currentTime: 292 }, { bpm: null });
  assert.equal(pb2.start, true, 'less than tailSec/2 left: start anyway rather than run to silence');
  assert.equal(pb2.matched, false, 'and it is honestly reported as unmatched');
  assert.equal(pb2.reason, 'incoming-not-ready');
  // No decoded buffer at all: there is nothing to start, ever.
  assert.equal(plan({ currentTime: 299 }, { hasBuffer: false }).start, false, 'no incoming buffer: cannot start');
  assert.equal(plan({ currentTime: 299 }, { hasBuffer: false }).reason, 'incoming-not-ready');

  // ── dead air (fix 6): the outgoing deck already ran out ──────────────────
  const pdead = plan({ currentTime: 300, playing: false });
  assert.equal(pdead.start, true, 'outgoing deck stopped: start the incoming one NOW');
  assert.equal(pdead.immediate, true);
  assert.equal(pdead.reason, 'outgoing-stopped');
  assert.equal(pdead.phraseAligned, false, 'no phrase to align to once the music stopped');
  // Even an unanalysed incoming track is better than silence, as long as it
  // has audio to play.
  assert.equal(plan({ currentTime: 300, playing: false }, { bpm: null }).start, true,
    'silence beaten by an unmatched start');
  assert.equal(plan({ currentTime: 300, playing: false }, { hasBuffer: false }).start, false,
    'nothing decoded to play: stay put');
  assert.equal(plan({ currentTime: 300, playing: false }, { hasBuffer: false }).reason, 'no-incoming');
  // A paused-but-not-finished deck is the same dead-air case: automix never
  // pauses the outgoing deck itself before the swap.
  assert.equal(plan({ currentTime: 12, playing: false }).immediate, true, 'a stopped deck mid-track is still dead air');

  // ── the assistant's "transition NOW" ─────────────────────────────────────
  const pf = plan({ currentTime: 10 }, {}, { forced: true });
  assert.equal(pf.start, true, 'forced: start regardless of position');
  assert.equal(pf.reason, 'forced');
  assert.ok(near(pf.startAt!, 10), 'a forced blend starts where the track is, not at the far-off phrase line');
  assert.equal(plan({ currentTime: 10 }, { hasBuffer: false }, { forced: true }).start, false,
    'even forced needs something decoded on the incoming deck');
  assert.equal(plan({ currentTime: 10 }, { bpm: null }, { forced: true }).start, true,
    'forced overrides the not-ready wait');
  assert.equal(plan({ currentTime: 10 }, { bpm: null }, { forced: true }).matched, false,
    'and is still honest about being unmatched');

  // cueIn is carried through untouched; 0 is a real cue-in, not "unset".
  assert.equal(plan({ currentTime: 285 }, { cueIn: 12.5 }).cueIn, 12.5);
  assert.equal(plan({ currentTime: 285 }, { cueIn: 0 }).cueIn, 0);
  assert.equal(plan({ currentTime: 285 }, { cueIn: null }).cueIn, 0, 'no cue-in point → start of the track');
}

/* ═══════════════════════════════ fadeStep ═════════════════════════════════ */
{
  assert.equal(fadeStep(100, 100, 10, -1, 1), -1, 'at t0 the fader has not moved');
  assert.equal(fadeStep(100, 105, 10, -1, 1), 0, 'halfway');
  assert.equal(fadeStep(100, 110, 10, -1, 1), 1, 'at the end: EXACTLY the destination');
  assert.equal(fadeStep(100, 1e6, 10, -1, 1), 1, 'long past the end: still exactly the destination, never overshoot');
  assert.equal(fadeStep(100, 99, 10, -1, 1), -1, 'a clock that went backwards does not pull the fader past the start');
  // THE BUG (fix 7): a fade whose length is 0/negative/NaN used to divide and
  // park the fader wherever the partial write left it. It must land on `to`.
  assert.equal(fadeStep(100, 100, 0, -1, 1), 1, 'zero-length fade: snap to the destination');
  assert.equal(fadeStep(100, 100, -5, -1, 1), 1, 'negative fade length: snap to the destination');
  assert.equal(fadeStep(100, Number.NaN, 10, -1, 1), 1, 'a NaN clock snaps home rather than parking mid-fade');
  assert.equal(fadeStep(100, 103, 10, 1, -1), 0.4, 'B→A direction');
}

/* ════════════════════════════════ eqSwap ══════════════════════════════════ */
{
  const start = eqSwap(0);
  assert.equal(start.outLowDb, 0, 'fade start: the outgoing bass is untouched');
  assert.ok(start.inLowDb < -20, 'fade start: the incoming bass is killed (no two basslines at once)');
  assert.deepEqual(eqSwap(1 / 3), start, 'nothing happens for the first third');
  const mid = eqSwap(0.5);
  assert.ok(near(mid.outLowDb, mid.inLowDb), 'mid-swap both sit at the crossover');
  assert.ok(mid.outLowDb < -5 && mid.outLowDb > -21, `mid-swap is a crossover, not a jump: ${mid.outLowDb}`);
  const end = eqSwap(2 / 3);
  assert.ok(end.outLowDb < -20, 'by the last third the outgoing bass is gone');
  assert.equal(end.inLowDb, 0, 'and the incoming bass is fully in');
  assert.deepEqual(eqSwap(1), end, 'the last third holds');
  assert.deepEqual(eqSwap(5), end, 'progress past 1 clamps');
  assert.deepEqual(eqSwap(-2), start, 'progress below 0 clamps');
  // Monotonic: the outgoing low never comes back up mid-fade.
  let prev = 1;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const v = eqSwap(p).outLowDb;
    assert.ok(v <= prev + 1e-9, `outgoing low must only ever fall (at ${p})`);
    prev = v;
  }
}

/* ══════════════════════════════ tempoMatch ════════════════════════════════ */
{
  const m = tempoMatch(128, 124, 10);
  assert.ok(near(m.pct, (128 / 124 - 1) * 100), 'plain 3.2% pull-up');
  assert.equal(m.matched, true);
  assert.equal(m.folded, false);

  // Double-time: 140 against 70 is a legitimate half/double match at 0%.
  const dbl = tempoMatch(140, 70, 10);
  assert.ok(near(dbl.pct, 0), `octave-folded to 0%, got ${dbl.pct}`);
  assert.equal(dbl.matched, true);
  assert.equal(dbl.folded, true, 'the fold is reported, not hidden');

  // THE BUG (fix 4): 140 → 95 needs -26%; ±10% cannot do it. The old code
  // clamped silently and still flashed "BPM Sync … matched".
  const lie = tempoMatch(140, 95, 10);
  assert.equal(lie.matched, false, 'a clamped rate is NOT a match');
  assert.ok(Math.abs(lie.pct) <= 10 + 1e-9, 'the pitch still stays inside the fader range');
  assert.ok(lie.folded, '140/95 folds an octave first');
  assert.equal(tempoMatch(140, 95, 30).matched, true, 'a wider range makes the same pair matchable');

  // Unknown tempo is never a match (and never moves the pitch fader).
  for (const args of [[null, 124], [128, null], [0, 124], [128, 0], [Number.NaN, 124]] as const) {
    const r = tempoMatch(args[0] as number | null, args[1] as number | null, 10);
    assert.equal(r.matched, false, `unknown BPM ${JSON.stringify(args)} is not a match`);
    assert.equal(r.pct, 0, 'and leaves the pitch alone');
  }
  // The returned rate is the one the clamped pitch actually produces.
  assert.ok(near(tempoMatch(140, 95, 10).rate, 0.9), 'rate mirrors the CLAMPED pct, not the wish');
}

/* ═══════════════════════════ camelot / next track ═════════════════════════ */
{
  assert.equal(camelotCompatible('8A', '8A'), true, 'same key');
  assert.equal(camelotCompatible('8A', '9A'), true, '+1 on the ring');
  assert.equal(camelotCompatible('8A', '7A'), true, '-1 on the ring');
  assert.equal(camelotCompatible('8A', '8B'), true, 'relative major');
  assert.equal(camelotCompatible('12A', '1A'), true, 'the ring wraps 12 → 1');
  assert.equal(camelotCompatible('1A', '12A'), true, 'and back');
  assert.equal(camelotCompatible('8A', '3A'), false, 'across the wheel: clash');
  assert.equal(camelotCompatible('8A', '9B'), false, 'diagonal is not a Camelot move');
  assert.equal(camelotCompatible(null, '8A'), false, 'unknown key is never "compatible"');
  assert.equal(camelotCompatible('8A', 'nonsense'), false);

  const set = (codes: Array<string | null>) => codes.map((camelot) => ({ camelot }));
  const pick = (args: Parameters<typeof chooseNextIndex>[0]) => chooseNextIndex(args);

  // Immediate next clashes; a compatible track sits later in the set.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '3A', '9A', '5A']), currentCamelot: '8A', preferHarmonic: true,
  }), 2, 'skips the clashing 3A for the harmonic 9A');
  // Immediate next already works: never reorder for its own sake.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '9A', '3A', '5A']), currentCamelot: '8A', preferHarmonic: true,
  }), 1, 'a compatible next track is left exactly where the DJ put it');
  // Flag off → strict set order, always.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '3A', '9A', '5A']), currentCamelot: '8A', preferHarmonic: false,
  }), 1, 'preferHarmonic off: strict order');
  // Fewer than 3 tracks left: not enough room to be choosy.
  assert.equal(pick({
    fromIndex: 1, candidates: set(['8A', '8A', '3A', '9A']), currentCamelot: '8A', preferHarmonic: true,
  }), 2, 'only 2 left: take the next one');
  // Nothing compatible anywhere ahead → strict order rather than no track.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '3A', '2A', '3B']), currentCamelot: '8A', preferHarmonic: true,
  }), 1, 'no harmonic option: fall back to the set order');
  // Unknown keys never reorder anything.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', null, '9A']), currentCamelot: '8A', preferHarmonic: true,
  }), 1, 'an unanalysed next track is not skipped over');
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '3A', '9A', '5A']), currentCamelot: null, preferHarmonic: true,
  }), 1, 'unknown outgoing key: strict order');
  // End of set.
  assert.equal(pick({
    fromIndex: 2, candidates: set(['8A', '3A', '9A']), currentCamelot: '9A', preferHarmonic: true,
  }), null, 'last track: nothing follows');
  // Unknown outgoing position (track not in the set) starts from the top.
  assert.equal(pick({
    fromIndex: -1, candidates: set(['8A', '3A']), currentCamelot: null, preferHarmonic: true,
  }), 0, 'not in the set: start at the first track');
}

console.log('djAutomixPlan: ok');
