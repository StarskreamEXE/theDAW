import assert from 'node:assert/strict';
import { barSyncopation, metricalWeights, syncopationByBar } from './syncopation.ts';

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

// Weights match backend/modules/rhythm/engine.py _metrical_weights (values captured from the engine).
{
  assert.deepEqual(metricalWeights({ num: 7, den: 8, groups: [3, 2, 2] }), [4, 1, 2, 1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1]);
  assert.deepEqual(metricalWeights({ num: 4, den: 4, groups: [] }), [4, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0]);
  assert.deepEqual(metricalWeights({ num: 5, den: 4, groups: [2, 3] }), [4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0]);
  assert.deepEqual(metricalWeights({ num: 5, den: 16, groups: [] }), [4, 2, 2, 2, 2]);
  assert.equal(metricalWeights({ num: 7, den: 32, groups: [] }).length, 4);
}

// Scores match _bar_syncopation for the same positions and saliences.
{
  const w78 = metricalWeights({ num: 7, den: 8, groups: [3, 2, 2] });
  const w44 = metricalWeights({ num: 4, den: 4, groups: [] });
  const s78 = barSyncopation([0, 3, 5, 9], [1, 0.5, 1, 0.8], w78, 2);
  close(s78.lhl, 0.25625, 'lhl 7/8');
  close(s78.wnbd, 0.375, 'wnbd 7/8');
  close(s78.offbeatRatio, 0.6969696969696969, 'offbeat 7/8');
  assert.equal(s78.onsets, 4);
  const s44 = barSyncopation([0, 3, 7, 10, 14], [1, 1, 1, 1, 1], w44, 4);
  close(s44.lhl, 0.25, 'lhl 4/4');
  close(s44.wnbd, 0.6, 'wnbd 4/4');
  close(s44.offbeatRatio, 0.8, 'offbeat 4/4');
  assert.deepEqual(barSyncopation([], [], w44, 4), { lhl: 0, wnbd: 0, offbeatRatio: 0, onsets: 0 });
  const dup = barSyncopation([2, 2, 6], [0.4, 0.9, 1], w44, 4);
  close(dup.lhl, 0.2375, 'lhl duplicate onsets');
  close(dup.wnbd, 0.5, 'wnbd duplicate onsets');
  assert.equal(dup.onsets, 2);
}

// Bar by bar through a meter change: 7/8 then 4/4.
{
  const map = [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }, { bar: 1, meter: { num: 4, den: 4, groups: [] } }];
  const notes = [0, 3, 5, 9, 14, 17, 21, 24, 28].map((step) => ({ step, velocity: 127 }));
  const out = syncopationByBar(notes, map, 30);
  assert.deepEqual(out.map((b) => [b.bar, b.start, b.len, b.onsets]), [[0, 0, 14, 4], [1, 14, 16, 5]]);
  close(out[0].lhl, 0.3125, 'bar 1 lhl');
  close(out[1].lhl, 0.25, 'bar 2 lhl');
  close(out[1].wnbd, 0.6, 'bar 2 wnbd');
  const withPickup = syncopationByBar([{ step: 2 }, { step: 4 }], [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], 20, 4);
  assert.deepEqual(withPickup.map((b) => [b.bar, b.onsets]), [[-1, 1], [0, 1]]);
}

console.log('syncopation: ok');
