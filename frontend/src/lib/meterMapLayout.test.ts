/**
 * meterMapLayout: the rules that turn a rhythm result into blocks on a lane.
 *
 * Each rule is pinned by the case that would misdraw the map if it slipped:
 * 15/8 coloured as a three, 6/8 coloured by its two tracked beats, a "4/4 2+2"
 * block wearing a grouping it does not need, a tatum block with no badge.
 *
 * Run: `npx tsx src/lib/meterMapLayout.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  chipsFor,
  dataFromResult,
  describeSegment,
  factsFor,
  familyOf,
  labelFit,
  levelMark,
  mmss,
  numeratorOf,
  segmentLabel,
  tickStep,
  ticksFor,
  type MapSegment,
} from './meterMapLayout';

// ── families ────────────────────────────────────────────────────────────────
assert.equal(familyOf(2), 'm2');
assert.equal(familyOf(4), 'm4');
assert.equal(familyOf(8), 'm4');
assert.equal(familyOf(16), 'm4');
assert.equal(familyOf(3), 'm3');
assert.equal(familyOf(6), 'm3');
assert.equal(familyOf(9), 'm3');
assert.equal(familyOf(12), 'm3');
assert.equal(familyOf(5), 'm5');
assert.equal(familyOf(10), 'm5');
assert.equal(familyOf(15), 'm5', '15 is a five, not a three');
assert.equal(familyOf(7), 'm7');
assert.equal(familyOf(14), 'm7');
assert.equal(familyOf(21), 'm7', '21 is a seven, not a three');
assert.equal(familyOf(11), 'mx');
assert.equal(familyOf(13), 'mx');
assert.equal(familyOf(33), 'm3');

// ── the numerator a block is coloured by ────────────────────────────────────
const sixEight: MapSegment = {
  start_sec: 0,
  end_sec: 10,
  time_signature: '6/8',
  bpm: 120,
  bars: 5,
  confidence: 0.2,
  beats_per_bar: 2,
  grouping: [2],
  numerator: 6,
  denominator: 8,
};
assert.equal(numeratorOf(sixEight), 6, 'the written numerator, not the tracked beat count');
assert.equal(numeratorOf({ ...sixEight, numerator: undefined }), 6, 'falls back to the signature text');
assert.equal(numeratorOf({ ...sixEight, numerator: undefined, time_signature: 'free' }), 2, 'then to beats per bar');

// ── labels ──────────────────────────────────────────────────────────────────
assert.deepEqual(segmentLabel({ ...sixEight, time_signature: '7/8 3+2+2', grouping: [3, 2, 2], beats_per_bar: 7 }), {
  sig: '7/8',
  grp: '3+2+2',
});
assert.deepEqual(segmentLabel({ ...sixEight, time_signature: '4/4 2+2', grouping: [2, 2], beats_per_bar: 4 }), {
  sig: '4/4',
  grp: '',
}, 'a plain four does not spell out 2+2');
assert.deepEqual(segmentLabel({ ...sixEight, time_signature: '5/4 3+2', grouping: [3, 2], beats_per_bar: 5 }), {
  sig: '5/4',
  grp: '3+2',
});

// ── tatum badges ────────────────────────────────────────────────────────────
assert.equal(levelMark(sixEight), '', 'no level means the tracked beat');
assert.equal(levelMark({ ...sixEight, level: 'tracked' }), '');
assert.equal(levelMark({ ...sixEight, level: 'tatum', denominator: 8 }), '8TH');
assert.equal(levelMark({ ...sixEight, level: 'tatum', denominator: 16, time_signature: '15/16' }), '16TH');
assert.equal(levelMark({ ...sixEight, level: 'tatum', denominator: undefined, time_signature: '9/16 2+2+2+3' }), '16TH', 'reads the denominator off the signature');
assert.equal(levelMark({ ...sixEight, level: 'tatum', denominator: 4 }), 'TATUM');

// ── time ────────────────────────────────────────────────────────────────────
assert.equal(mmss(0), '0:00');
assert.equal(mmss(59.6), '1:00', 'rounding up to the minute carries');
assert.equal(mmss(134.2346), '2:14');

// ── ticks fit the width ─────────────────────────────────────────────────────
assert.equal(tickStep(159, 1000), 10);
assert.equal(tickStep(159, 300), 30);
assert.equal(tickStep(600, 300), 120);
assert.equal(tickStep(3600, 100), 600, 'the widest step when nothing fits');
assert.deepEqual(ticksFor(65, 1000), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65]);

assert.equal(labelFit(20), 'none');
assert.equal(labelFit(50), 'sig');
assert.equal(labelFit(200), 'full');

// ── the sentence ────────────────────────────────────────────────────────────
assert.equal(
  describeSegment({ ...sixEight, subdivision: 'compound', uncertain: true, confidence: 0.05 }),
  '6/8 · 0:00–0:10 · 5 bars · 120 bpm · compound · conf 0.05 (guess) · read at the tracked beat',
);

// ── data from the engine's result ───────────────────────────────────────────
const result = {
  duration_sec: 20,
  meter_map: [sixEight, { ...sixEight, start_sec: 10, end_sec: 20, time_signature: '7/8 3+2+2', bars: 4, uncertain: true }],
  tempo: { segments: [{ start_sec: 0, bpm: 120 }, { start_sec: 12, bpm: 126 }] },
  bars: [
    { start_sec: 0, end_sec: 2, syncopation: { lhl: 0.1 } },
    { start_sec: 2, end_sec: 4, syncopation: { lhl: 0.4 } },
    { start_sec: 4, end_sec: 4, syncopation: { lhl: 9 } },
  ],
  syncopation: { mean_lhl: 0.25, max_lhl: 0.4, swing_ratio: 1.6, swing_confidence: 0.7 },
  polymeter: [
    { layer: 'low', relation: 'against 7', beats_per_bar: 4, confidence: 0.3, segment: 1 },
    { layer: 'low', relation: 'against 7', beats_per_bar: 4, confidence: 0.2, segment: 1 },
    { layer: 'high', relation: 'against 7', beats_per_bar: 3, confidence: 0.25 },
  ],
  cross_rhythms: [
    { ratio: '3:2', strength: 0.5 },
    { ratio: '3:2', strength: 0.7 },
    { ratio: '4:3', strength: 0.6 },
    { ratio: '5:4', strength: 0.2 },
    { ratio: '7:4', strength: 0.1 },
  ],
};
const data = dataFromResult(result);
assert.equal(data.duration, 20);
assert.equal(data.bars.length, 2, 'a zero-length bar is dropped');
assert.deepEqual(data.bars[1], { start_sec: 2, end_sec: 4, lhl: 0.4 });

const chips = chipsFor(data);
assert.deepEqual(
  chips.map((c) => [c.kind, c.head]),
  [
    ['poly', 'low keeps 4'],
    ['poly', 'high keeps 3'],
    ['cross', 'cross 3:2'],
    ['cross', 'cross 4:3'],
    ['cross', 'cross 5:4'],
    ['swing', 'swing 1.60'],
  ],
  'one chip per layer and bar length, the three strongest ratios, swing when sure',
);
assert.equal(chips[0].tail, 'against 7 · from 0:10 · 0.30', 'the strongest reading names its segment');
assert.equal(chips[5].tail, 'swung');

assert.deepEqual(
  chipsFor({ ...data, swingConfidence: 0.3 }).filter((c) => c.kind === 'swing'),
  [],
  'unsure swing is not a chip',
);

// An older cache with a curve and no bars still gets a syncopation lane.
const old = dataFromResult({ ...result, bars: undefined, syncopation: { ...result.syncopation, curve: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] } });
assert.equal(old.bars.length, 9);
assert.equal(old.bars[0].start_sec, 0);
assert.equal(old.bars[0].end_sec, 2);
assert.equal(old.bars[5].start_sec, 10, 'the second segment starts where it says');

// ── facts ───────────────────────────────────────────────────────────────────
assert.deepEqual(factsFor(data, 123.4), [
  ['length', '0:20'],
  ['tempo', '123 bpm · 2 tempo runs'],
  ['meter', '2 segments · 1 solid'],
  ['reads', '6/8'],
  ['syncopation', 'mean 0.25 · peak 0.40'],
]);

console.log('meterMapLayout: ok');

// ── tempo labels never overlap ──────────────────────────────────────────────
// The songwriter's House of the Rising Sun moves through eight tempos. Two
// changes close together put two labels in the same pixels, and a number a
// reader cannot separate from its neighbour says less than no number at all.
import { placeTempoFlags, TIER_H } from '../components/layout/meterMapDraw';

const eightTempos = {
  ...data,
  duration: 273,
  tempo: [
    { start_sec: 0, bpm: 130 },
    { start_sec: 31, bpm: 200 },
    { start_sec: 68, bpm: 160 },
    { start_sec: 74, bpm: 174 },
    { start_sec: 80, bpm: 202 },
    { start_sec: 176, bpm: 200 },
    { start_sec: 205, bpm: 198 },
    { start_sec: 240, bpm: 128 },
  ],
};

{
  const W = 1000;
  const x = (t: number) => (t / 273) * W;
  const flags = placeTempoFlags(eightTempos, W, x);
  assert.equal(flags.length, 7, 'the first tempo is the starting tempo, not a change');

  // No two labels on the same tier may overlap.
  const boxes = flags
    .filter((f) => f.label)
    .map((f) => {
      const w = f.label.length * 12 * 0.58;
      return { tier: f.tier, lo: f.anchor === 'start' ? f.lx : f.lx - w, hi: f.anchor === 'start' ? f.lx + w : f.lx };
    });
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxes[i].tier !== boxes[j].tier) continue;
      const clear = boxes[i].hi <= boxes[j].lo || boxes[j].hi <= boxes[i].lo;
      assert.ok(clear, `labels ${i} and ${j} overlap on tier ${boxes[i].tier}`);
    }
  }
  // The three changes inside twelve seconds are what forces a second tier.
  assert.ok(flags.some((f) => f.tier > 0), 'three changes in twelve seconds should step a label up');
  // Every label stays on the canvas.
  for (const f of boxes) {
    assert.ok(f.lo >= -0.01 && f.hi <= W + 0.01, `a label ran off the canvas: ${f.lo}..${f.hi}`);
  }
  // The flag itself never moves off its own change.
  for (const [i, f] of flags.entries()) {
    assert.ok(Math.abs(f.x - x(eightTempos.tempo[i + 1].start_sec)) < 1e-9, 'a flag moved off its change');
  }
  assert.equal(TIER_H, 13);
}

// A narrow chart is the crowded case: the same eight tempos in a DETAILS panel.
{
  const W = 320;
  const flags = placeTempoFlags(eightTempos, W, (t) => (t / 273) * W);
  const drawn = flags.filter((f) => f.label);
  assert.ok(drawn.length >= 4, `too many labels dropped at ${W}px: ${drawn.length} of ${flags.length}`);
  assert.equal(flags.length, 7, 'a flag is never dropped, only its label');
}

console.log('meterMapLayout: tempo flags ok');
