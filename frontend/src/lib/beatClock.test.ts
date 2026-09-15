/**
 * Every constant-tempo number below was captured from beatClock BEFORE it was
 * rewired onto `tempoMap.ts` / `meterMap.ts`, and is pinned bit-for-bit
 * (`assert.equal`, not a tolerance). The clock is a module singleton, so the
 * blocks run in order and each one states the tempo/meter/anchor it needs.
 */
import assert from 'node:assert/strict';
import { CLOCK_LEAD_SEC, beatClock, type ClockGrid } from './beatClock.ts';
import type { MeterSegment } from './meterMap.ts';

const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M44 = { num: 4, den: 4, groups: [] };

// Defaults.
{
  assert.equal(CLOCK_LEAD_SEC, 0.01);
  assert.deepEqual(beatClock.state, { bpm: 120, beatsPerBar: 4, anchor: null, source: 'internal' });
  assert.equal(beatClock.bpm, 120);
  assert.equal(beatClock.beatsPerBar, 4);
}

// A cold clock anchors itself on the first nextGrid, so the first launch is
// immediate. This has to run before anything else sets an anchor — nothing can
// put it back to null. It exercises the `anchor == null` branch: it mutates the
// anchor and emits.
{
  assert.equal(beatClock.state.anchor, null);
  const seen: (number | null)[] = [];
  const off = beatClock.subscribe((s) => seen.push(s.anchor));
  // Every grid returns `from` unchanged while cold, not a quantized line.
  assert.equal(beatClock.nextGrid('bar', 42.5), 42.5);
  assert.equal(beatClock.state.anchor, 42.5);
  assert.deepEqual(seen, [42.5], 'the cold-start anchor is emitted');
  // Warm now: the same call quantizes instead of re-anchoring.
  assert.equal(beatClock.nextGrid('bar', 43), 44.5);
  assert.equal(beatClock.state.anchor, 42.5);
  assert.deepEqual(seen, [42.5], 'a warm nextGrid emits nothing');
  assert.deepEqual(beatClock.phase(42.5), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  off();
}

// --- 120 bpm, 4/4, bar 0 at t = 10 -------------------------------------------
beatClock.setAnchor(10, 0);
{
  assert.equal(beatClock.state.anchor, 10);
  assert.equal(beatClock.beatSec(), 0.5);
  assert.equal(beatClock.barSec(), 2);
  const grids: [ClockGrid, number][] = [
    ['now', 0], ['16th', 0.125], ['8th', 0.25], ['beat', 0.5],
    ['half', 1], ['bar', 2], ['2bar', 4], ['4bar', 8],
  ];
  for (const [g, sec] of grids) assert.equal(beatClock.gridSec(g), sec, g);
}

// phase()
{
  const cases: [number, [number, number, number, number, number]][] = [
    [10, [0, 0, 0, 0, 0]],
    [10.25, [0, 0, 2, 0.5, 0.125]],
    [10.5, [0, 1, 0, 0, 0.25]],
    [11, [0, 2, 0, 0, 0.5]],
    [12.75, [1, 1, 2, 0.5, 0.375]],
    [13, [1, 2, 0, 0, 0.5]],
    [20.125, [5, 0, 1, 0.25, 0.0625]],
    [9.5, [0, 0, 0, 0, 0]], // before the anchor, beats clamp at 0
  ];
  for (const [t, [bar, beat, sixteenth, beatFrac, barFrac]] of cases) {
    assert.deepEqual(beatClock.phase(t), { bar, beat, sixteenth, beatFrac, barFrac }, `phase(${t})`);
  }
}

// nextGrid()
{
  const expected: Record<ClockGrid, number[]> = {
    now: [10, 10.3, 12, 14.7],
    '16th': [10, 10.375, 12, 14.75],
    '8th': [10, 10.5, 12, 14.75],
    beat: [10, 10.5, 12, 15],
    half: [10, 11, 12, 15],
    bar: [10, 12, 12, 16],
    '2bar': [10, 14, 14, 18],
    '4bar': [10, 18, 18, 18],
  };
  const from = [10, 10.3, 12, 14.7];
  for (const g of Object.keys(expected) as ClockGrid[]) {
    for (let i = 0; i < from.length; i += 1) {
      assert.equal(beatClock.nextGrid(g, from[i]), expected[g][i], `nextGrid(${g}, ${from[i]})`);
    }
  }
}

// timeOf()
{
  assert.equal(beatClock.timeOf(0, 0, 16), 10);
  assert.equal(beatClock.timeOf(1, 0, 16), 12);
  assert.equal(beatClock.timeOf(2, 4, 16), 14.5);
  assert.equal(beatClock.timeOf(3, 7, 16), 16.875);
  assert.equal(beatClock.timeOf(1, 3, 8), 12.75);
}

// --- setBpm re-anchors so the beat we are on stays the beat we are on --------
{
  beatClock.setBpm(140, 'loom');
  assert.deepEqual(beatClock.state, { bpm: 140, beatsPerBar: 4, anchor: 8.571428571428571, source: 'loom' });
  assert.equal(beatClock.beatSec(), 0.42857142857142855);
  // Same bpm, same source: no re-anchor, no event.
  const anchor = beatClock.state.anchor;
  beatClock.setBpm(140, 'loom');
  assert.equal(beatClock.state.anchor, anchor);
  // The clamp is unchanged: 20..300.
  beatClock.setBpm(1, 'loom');
  assert.equal(beatClock.bpm, 20);
  beatClock.setBpm(9999, 'loom');
  assert.equal(beatClock.bpm, 300);
  beatClock.setBpm(140, 'loom');
}

// --- 140 bpm, 7 beats to the bar (i.e. 7/4), bar 0 at t = 0 ------------------
beatClock.setAnchor(0, 0);
beatClock.setBeatsPerBar(7);
{
  assert.equal(beatClock.beatsPerBar, 7);
  assert.equal(beatClock.barSec(), 3);
  assert.equal(beatClock.gridSec('half'), 1.5);
  assert.equal(beatClock.gridSec('bar'), 3);
  assert.equal(beatClock.gridSec('2bar'), 6);
  assert.equal(beatClock.gridSec('4bar'), 12);
  assert.deepEqual(beatClock.phase(0), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  assert.deepEqual(beatClock.phase(1), { bar: 0, beat: 2, sixteenth: 1, beatFrac: 0.3333333333333335, barFrac: 0.33333333333333337 });
  assert.deepEqual(beatClock.phase(3.0001), { bar: 1, beat: 0, sixteenth: 0, beatFrac: 0.00023333333333397377, barFrac: 0.00003333333333342482 });
  assert.deepEqual(beatClock.phase(5), { bar: 1, beat: 4, sixteenth: 2, beatFrac: 0.6666666666666679, barFrac: 0.6666666666666669 });
  assert.deepEqual([0, 1, 3.0001, 5].map((t) => beatClock.nextGrid('bar', t)), [0, 3, 6, 6]);
  assert.deepEqual([0, 1, 3.0001, 5].map((t) => beatClock.nextGrid('beat', t)), [0, 1.2857142857142856, 3.4285714285714284, 5.142857142857142]);
  assert.equal(beatClock.timeOf(2, 8, 16), 7.5);
  // setBeatsPerBar still clamps to 1..16 whole beats.
  beatClock.setBeatsPerBar(0);
  assert.equal(beatClock.beatsPerBar, 1);
  beatClock.setBeatsPerBar(99);
  assert.equal(beatClock.beatsPerBar, 16);
  beatClock.setBeatsPerBar(7);
}

// --- setAnchor with a bar offset ---------------------------------------------
{
  beatClock.setAnchor(0, 0);
  beatClock.setBpm(90, 'loom');
  assert.equal(beatClock.state.anchor, 0);
  beatClock.setAnchor(5, 2);
  assert.equal(beatClock.state.anchor, -4.333333333333332);
}

// --- the meter map: a bar is 7/8, not 7 quarter notes ------------------------
{
  beatClock.setBpm(120, 'loom');
  beatClock.setMeterMap([{ bar: 0, meter: M78 }]);
  beatClock.setAnchor(0, 0);
  // 7/8 is 3.5 quarter notes, so at 120 bpm a bar is 1.75 s — NOT 3.5 s.
  assert.equal(beatClock.beatsPerBar, 3.5);
  assert.equal(beatClock.beatsPerBarAt(0), 3.5);
  assert.equal(beatClock.barSec(), 1.75);
  assert.equal(beatClock.gridSec('bar'), 1.75);
  assert.equal(beatClock.gridSec('2bar'), 3.5);
  assert.equal(beatClock.gridSec('half'), 0.875);
  // The sub-beat grids are quarter-note subdivisions in every meter.
  assert.equal(beatClock.gridSec('beat'), 0.5);
  assert.equal(beatClock.gridSec('16th'), 0.125);
  assert.deepEqual([0, 0.1, 1.75, 1.8, 5].map((t) => beatClock.nextGrid('bar', t)), [0, 1.75, 1.75, 3.5, 5.25]);
  assert.deepEqual(beatClock.phase(0), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  assert.deepEqual(beatClock.phase(1.75), { bar: 1, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  assert.deepEqual(beatClock.phase(2.25), { bar: 1, beat: 1, sixteenth: 0, beatFrac: 0, barFrac: 1 / 3.5 });
  assert.equal(beatClock.timeOf(2, 0, 16), 3.5);
  assert.equal(beatClock.timeOf(2, 8, 16), 4.375);
}

// --- a meter change mid-song: bar lines stop being evenly spaced -------------
{
  const MAP: MeterSegment[] = [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }, { bar: 4, meter: M44 }];
  beatClock.setMeterMap(MAP);
  beatClock.setAnchor(0, 0);
  assert.equal(beatClock.beatsPerBar, 4);
  assert.equal(beatClock.beatsPerBarAt(2), 3.5);
  assert.equal(beatClock.beatsPerBarAt(4), 4);
  // 120 bpm: bars start at beats 0, 4, 8, 11.5, 15, 19 -> seconds 0, 2, 4, 5.75, 7.5, 9.5.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((b) => beatClock.timeOf(b)), [0, 2, 4, 5.75, 7.5, 9.5]);
  // A step into a bar is a fraction of THAT bar: half of a 7/8 bar is 0.875 s
  // at 120 bpm, not half of a 4/4 bar (1 s).
  assert.equal(beatClock.timeOf(2, 8, 16), 4.875);
  assert.equal(beatClock.timeOf(3, 4, 16), 6.1875);
  assert.equal(beatClock.timeOf(1, 8, 16), 3); // still a 4/4 bar
  assert.equal(beatClock.timeOf(4, 8, 16), 8.5); // 4/4 again after the change
  assert.deepEqual([0, 0.1, 4, 4.1, 5.75, 6, 7.6].map((t) => beatClock.nextGrid('bar', t)), [0, 2, 4, 5.75, 5.75, 7.5, 9.5]);
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('2bar', t)), [4, 7.5]);
  assert.deepEqual([0.1, 4.1, 5.8].map((t) => beatClock.nextGrid('half', t)), [1, 4.875, 6.625]);
  // Sub-beat grids are still uniform.
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('beat', t)), [0.5, 4.5]);
  assert.equal(beatClock.phase(4).bar, 2);
  assert.equal(beatClock.phase(5.75).bar, 3);
  assert.equal(beatClock.phase(7.5).bar, 4);
  assert.deepEqual(beatClock.meterMap, MAP);
}

// --- subscribers get every change, and an unsubscribed one gets none --------
{
  beatClock.setMeterMap([{ bar: 0, meter: M44 }]);
  const seen: number[] = [];
  const off = beatClock.subscribe((s) => seen.push(s.bpm));
  beatClock.setBpm(128, 'edit');
  assert.deepEqual(seen, [128]);
  off();
  beatClock.setBpm(120, 'edit');
  assert.deepEqual(seen, [128]);
}

console.log('beatClock: ok');
