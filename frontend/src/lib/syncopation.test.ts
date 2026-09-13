import assert from 'node:assert/strict';
import { bars } from './meterMap.ts';
import { barSyncopation, metricalWeights, stepsPerBeat, syncopationByBar } from './syncopation.ts';

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

// The one-pass grouping scores every bar as filtering the notes bar by bar does:
// unsorted input, fractional steps, notes before 0 and past the end, a pickup
// and bars of 3.5 steps.
{
  const map = [
    { bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } },
    { bar: 3, meter: { num: 7, den: 32, groups: [] } },
    { bar: 7, meter: { num: 5, den: 4, groups: [2, 3] } },
    { bar: 9, meter: { num: 4, den: 4, groups: [] } },
  ];
  const pickup = 2.5;
  const total = 200;
  const eps = 1e-9;
  const byFilter = (notes: { step: number; velocity?: number }[]) =>
    bars(map, total, pickup).map((b) => {
      const full = metricalWeights(b.meter);
      const size = Math.max(1, Math.ceil(b.len - eps));
      const offset = b.bar < 0 ? Math.max(0, full.length - size) : 0;
      const inBar = notes.filter((nt) => nt.step >= b.start - eps && nt.step < b.start + b.len - eps);
      const vel = inBar.map((nt) => (typeof nt.velocity === 'number' ? nt.velocity : 127) / 127);
      const score = barSyncopation(inBar.map((nt) => Math.round(nt.step - b.start)), vel, b.bar < 0 ? full.slice(offset) : full, stepsPerBeat(b.meter));
      if (offset > 0 && score.onsets > 0) score.wnbd = barSyncopation(inBar.map((nt) => Math.round(nt.step - b.start) + offset), vel, full, stepsPerBeat(b.meter)).wnbd;
      return { bar: b.bar, start: b.start, len: b.len, ...score };
    });
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const notes: { step: number; velocity?: number }[] = [];
  for (let i = 0; i < 600; i += 1) {
    const step = Math.floor(rnd() * 440) / 2 - 10;
    notes.push(i % 7 === 0 ? { step } : { step, velocity: 1 + Math.floor(rnd() * 127) });
  }
  notes.push({ step: pickup }, { step: pickup - 1e-12 }, { step: total }, { step: Number.NaN });
  const want = byFilter(notes);
  const got = syncopationByBar(notes, map, total, pickup);
  assert.equal(got.length, want.length);
  got.forEach((g, i) => {
    const w = want[i];
    assert.deepEqual([g.bar, g.start, g.len, g.onsets], [w.bar, w.start, w.len, w.onsets], `bar ${w.bar}`);
    close(g.lhl, w.lhl, `bar ${w.bar} lhl`);
    close(g.wnbd, w.wnbd, `bar ${w.bar} wnbd`);
    close(g.offbeatRatio, w.offbeatRatio, `bar ${w.bar} offbeat`);
  });
  assert.ok(got.some((b) => b.onsets > 1 && b.lhl > 0), 'the case scores some syncopation');
  const sorted = [...notes].sort((a, b) => a.step - b.step);
  assert.deepEqual(syncopationByBar(sorted, map, total, pickup), got, 'sorted input scores the same');
}

console.log('syncopation: ok');
