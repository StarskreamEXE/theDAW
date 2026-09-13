// The .tasmo mapping projectImport.ts uses for piano-roll clips. projectImport.ts
// itself pulls the soundfont engine through a Vite `?url` import and does not
// load under node, so its pure mappers live in projectClient.ts.
import assert from 'node:assert/strict';
import { clipMeterToTasmo, pianoNoteToTasmo, tasmoMeterToClip } from './projectClient.ts';
import type { MeterSegment, PolyLane } from './meterMap.ts';

const MAP: MeterSegment[] = [
  { bar: 0, meter: { num: 4, den: 4, groups: [] } },
  { bar: 2, meter: { num: 7, den: 8, groups: [3, 2, 2] } },
];
const LANES: PolyLane[] = [
  { id: 0, name: 'A', cycleSteps: null },
  { id: 1, name: 'B', cycleSteps: 12 },
];

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

// A clip without the fields writes none, and a file without them loads none.
{
  assert.deepEqual(clipMeterToTasmo({}), {});
  assert.deepEqual(tasmoMeterToClip({}), {});
  assert.deepEqual(tasmoMeterToClip({ total_steps: null, meter_map: null, pickup_steps: null, lanes: null }), {});
  assert.deepEqual(JSON.parse(JSON.stringify(clipMeterToTasmo({ sourceTotalSteps: undefined }))), {});
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
}

console.log('projectImport mapping tests passed');
