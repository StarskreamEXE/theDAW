import assert from 'node:assert/strict';
import { seedFromRhythm, type RhythmAnalysis } from './rhythmSeed.ts';

const base: RhythmAnalysis = {
  status: 'ready',
  tempo: { bpm: 120, stable: true },
  downbeats: [0.25, 2],
  meter_map: [
    { start_bar: 0, bars: 4, numerator: 7, denominator: 8, grouping: [3, 2, 2], beats_per_bar: 7 },
    { start_bar: 4, bars: 2, numerator: 6, denominator: 8, grouping: [1, 1], beats_per_bar: 2, uncertain: true },
  ],
  polymeter: [
    { segment: 0, layer: 'high', beats_per_bar: 3, grouping: [3], denominator: 8, confidence: 0.8 },
    { segment: 0, layer: 'low', beats_per_bar: 5, grouping: [5], denominator: 4, confidence: 0.9 },
    { segment: 0, layer: 'mid', beats_per_bar: 7, grouping: [3, 2, 2], denominator: 8, confidence: 0.95 },
    { segment: 1, layer: 'drums', beats_per_bar: 4, grouping: [4], confidence: 0.99 },
    { segment: 0, layer: 'bass', beats_per_bar: 10, grouping: [5, 5], denominator: 8, confidence: 0.7 },
  ],
};

// Meter segments, the compound 6/8 grouping, a 2-step pickup, and lanes from the named polymeter loops.
{
  const s = seedFromRhythm(base, 90);
  assert.ok(s);
  assert.deepEqual(s.meterMap, [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }, { bar: 4, meter: { num: 6, den: 8, groups: [3, 3] } }]);
  assert.equal(s.pickupSteps, 2);
  // mid repeats the segment's own bar; drums names no denominator; bass loops 20 like low.
  assert.deepEqual(s.lanes, [
    { id: 0, name: 'A', cycleSteps: null },
    { id: 1, name: 'Low', cycleSteps: 20 },
    { id: 2, name: 'High', cycleSteps: 6 },
  ]);
  assert.equal(s.bpm, 120);
  assert.equal(s.tempoStable, true);
  assert.equal(s.uncertainBars, 2);
}

// A first downbeat more than a bar in: the whole bars go ahead of bar 0, the rest is the pickup.
{
  const s = seedFromRhythm({ ...base, downbeats: [3.25] }, 120);
  assert.ok(s);
  assert.equal(s.pickupSteps, 12);
  assert.deepEqual(s.meterMap.map((seg) => seg.bar), [0, 5]);
}

// Pending, empty, or no tempo.
{
  assert.equal(seedFromRhythm({ status: 'pending' }, 120), null);
  assert.equal(seedFromRhythm({ status: 'ready', meter_map: [] }, 120), null);
  const s = seedFromRhythm({ ...base, tempo: undefined, downbeats: [0.5], polymeter: undefined }, 60);
  assert.ok(s);
  assert.equal(s.bpm, null);
  assert.equal(s.pickupSteps, 2);
  assert.deepEqual(s.lanes.map((l) => l.id), [0]);
  assert.equal(seedFromRhythm(base, 120, 1)?.lanes.length, 2);
}

console.log('rhythmSeed: ok');
