// The .tasmo mapping projectImport.ts uses for piano-roll clips. projectImport.ts
// itself pulls the soundfont engine through a Vite `?url` import and does not
// load under node, so its pure mappers live in projectClient.ts.
import assert from 'node:assert/strict';
import { clipMeterToTasmo, pianoNoteToTasmo, tasmoMeterToClip, tasmoNotesToPiano } from './projectClient.ts';
import type { MeterSegment, PolyLane } from './meterMap.ts';
import type { LaneBend } from './pitchBend.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';

const MAP: MeterSegment[] = [
  { bar: 0, meter: { num: 4, den: 4, groups: [] } },
  { bar: 2, meter: { num: 7, den: 8, groups: [3, 2, 2] } },
];
const LANES: PolyLane[] = [
  { id: 0, name: 'A', cycleSteps: null },
  { id: 1, name: 'B', cycleSteps: 12 },
];
const withoutIds = (notes: readonly PianoNote[] = []) => notes.map(({ id: _id, ...n }) => n);

// A note keeps its lane when it has one, and gains none when it does not.
{
  assert.deepEqual(pianoNoteToTasmo({ id: 'a', note: 60, step: 3, length: 2, velocity: 90, lane: 1 }), {
    note: 60, step: 3, length: 2, velocity: 90, lane: 1,
  });
  assert.deepEqual(pianoNoteToTasmo({ id: 'b', note: 62, step: 0, length: 1, velocity: 80 }), {
    note: 62, step: 0, length: 1, velocity: 80,
  });
}

// Grid length, meter map, pickup and lanes round-trip through the JSON shape.
{
  const clip = { sourceTotalSteps: 46, sourceMeterMap: MAP, sourcePickupSteps: 4, sourceLanes: LANES };
  const saved = clipMeterToTasmo(clip);
  assert.deepEqual(saved, {
    total_steps: 46,
    meter_map: MAP,
    pickup_steps: 4,
    lanes: [{ id: 0, name: 'A', cycle_steps: null }, { id: 1, name: 'B', cycle_steps: 12 }],
  });
  // The payload goes to the backend as JSON and comes back from it as JSON.
  const loaded = tasmoMeterToClip(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded, clip);
  // The saved map is a copy.
  assert.notEqual(saved.meter_map?.[1].meter.groups, MAP[1].meter.groups);
}

// The roll's own notes round-trip with their lanes. The file stores no ids, so loaded notes get new ones.
{
  const rollNotes: PianoNote[] = [
    { id: 'a', note: 60, step: 0, length: 2, velocity: 90 },
    { id: 'b', note: 64, step: 3.5, length: 1, velocity: 80, lane: 1 },
  ];
  const saved = clipMeterToTasmo({ sourceRollNotes: rollNotes, sourceLanes: LANES });
  assert.deepEqual(saved.roll_notes, [
    { note: 60, step: 0, length: 2, velocity: 90 },
    { note: 64, step: 3.5, length: 1, velocity: 80, lane: 1 },
  ]);
  const loaded = tasmoMeterToClip(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(withoutIds(loaded.sourceRollNotes), withoutIds(rollNotes));
  assert.deepEqual(loaded.sourceRollNotes?.map((n) => n.id), ['rn-0', 'rn-1']);
  assert.deepEqual(loaded.sourceLanes, LANES);
}

// A clip without the fields writes none, and a file without them loads none.
{
  assert.deepEqual(clipMeterToTasmo({}), {});
  assert.deepEqual(tasmoMeterToClip({}), {});
  assert.deepEqual(tasmoMeterToClip({ roll_notes: null, total_steps: null, meter_map: null, pickup_steps: null, lanes: null }), {});
  assert.deepEqual(tasmoMeterToClip({ roll_notes: [] }), {});
  assert.deepEqual(JSON.parse(JSON.stringify(clipMeterToTasmo({ sourceTotalSteps: undefined }))), {});
  // A file written after the meter fields and before roll_notes: the meter loads, no stored notes.
  const meterOnly = tasmoMeterToClip({ total_steps: 32, lanes: [{ id: 0, name: 'A', cycle_steps: null }] });
  assert.deepEqual(meterOnly, { sourceTotalSteps: 32, sourceLanes: [{ id: 0, name: 'A', cycleSteps: null }] });
}

// Malformed values from a hand-edited file stay out.
{
  const loaded = tasmoMeterToClip({
    total_steps: -3,
    pickup_steps: Number.NaN,
    meter_map: [{ bar: 0, meter: { num: 7, den: 8, groups: [4, 4] } }],
    lanes: [{ id: 1.5, name: 'x', cycle_steps: 8 }, { id: 2, name: 'C', cycle_steps: 0 }],
  });
  assert.equal(loaded.sourceTotalSteps, undefined);
  assert.equal(loaded.sourcePickupSteps, undefined);
  assert.deepEqual(loaded.sourceMeterMap, [{ bar: 0, meter: { num: 7, den: 8, groups: [] } }]);
  assert.deepEqual(loaded.sourceLanes, [{ id: 2, name: 'C', cycleSteps: null }]);
  assert.deepEqual(
    tasmoNotesToPiano(
      [
        { note: 60, step: 0, length: 0, velocity: 90 },
        { note: 128, step: 0, length: 1, velocity: 90 },
        { note: 'C4', step: 0, length: 1 },
        null,
        { note: 61, step: 2, length: 1, velocity: 300, lane: -1 },
        { note: 62, step: 4, length: 1, lane: 2 },
      ],
      'x',
    ),
    [
      { id: 'x-0', note: 61, step: 2, length: 1, velocity: 127 },
      { id: 'x-1', note: 62, step: 4, length: 1, velocity: 100, lane: 2 },
    ],
  );
}

// Each lane's pitch bend round-trips through the JSON shape: a linear point stores no shape, and loaded points get new ids.
{
  const bends: LaneBend[] = [
    { lane: 0, range: 2, points: [{ id: 'a', step: 0, value: 0, shape: 'linear' }, { id: 'b', step: 4.5, value: 1, shape: 'hold' }] },
    { lane: 1, range: 12, points: [{ id: 'c', step: 2, value: -0.5, shape: 'smooth' }] },
  ];
  const saved = clipMeterToTasmo({ sourceBends: bends });
  assert.deepEqual(saved, {
    roll_bends: [
      { lane: 0, range: 2, points: [{ step: 0, value: 0 }, { step: 4.5, value: 1, shape: 'hold' }] },
      { lane: 1, range: 12, points: [{ step: 2, value: -0.5, shape: 'smooth' }] },
    ],
  });
  const loaded = tasmoMeterToClip(JSON.parse(JSON.stringify(saved)));
  const strip = (list: readonly LaneBend[] = []) => list.map((b) => ({ ...b, points: b.points.map(({ id: _id, ...p }) => p) }));
  assert.deepEqual(strip(loaded.sourceBends), strip(bends));
  assert.deepEqual(loaded.sourceBends?.map((b) => b.points.map((p) => p.id)), [['rb0-0', 'rb0-1'], ['rb1-0']]);
  // No bend writes none, and a file without one loads none.
  assert.deepEqual(clipMeterToTasmo({ sourceBends: [] }), {});
  assert.deepEqual(tasmoMeterToClip({ roll_bends: [] }), {});
  assert.deepEqual(tasmoMeterToClip({ roll_bends: null }), {});
}

// Malformed bends from a hand-edited file stay out.
{
  const loaded = tasmoMeterToClip({
    roll_bends: [
      null,
      { lane: -1, range: 2, points: [{ step: 0, value: 1 }] },
      { lane: 1, range: 'x', points: [{ step: 'a', value: 1 }, null, { step: 3, value: 9, shape: 'zigzag' }] },
      { lane: 2, range: 2, points: 'nope' },
    ],
  } as unknown as Parameters<typeof tasmoMeterToClip>[0]);
  assert.deepEqual(loaded.sourceBends, [{ lane: 1, range: 2, points: [{ id: 'rb1-2', step: 3, value: 1, shape: 'linear' }] }]);
}

console.log('projectImport mapping tests passed');
