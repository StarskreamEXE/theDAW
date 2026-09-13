// The sequence a roll in 7/8 with a looping lane goes through, in the order the
// app runs it: bounce to EDIT, open the clip in the roll, save the project
// (.tasmo JSON), reload, open in the roll again. projectImport.ts does not load
// under node, so the save and the reload replay its projectClient mappers.
import assert from 'node:assert/strict';
import { clipRollLoad, playedRollNotes, rollClipFields, type RollClipInput, type RollLoadArgs } from './rollClip.ts';
import { clipMeterToTasmo, pianoNoteToTasmo, tasmoMeterToClip, tasmoNotesToPiano, type TasmoStepNote } from './projectClient.ts';
import { rollMeterOf, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import type { MeterSegment } from './meterMap.ts';

const st = () => usePianoRollStore.getState();
const M78: MeterSegment[] = [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }];
const M44: MeterSegment[] = [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }];
const LANE_A = [{ id: 0, name: 'A', cycleSteps: null }];
const BPM = 96;
/** The pickup (4 steps) and four bars of 7/8 (14 steps each). */
const TOTAL = 60;
const withoutIds = (notes: readonly PianoNote[] = []) => notes.map(({ id: _id, ...n }) => n);

// 1. The roll: 7/8 3+2+2, a pickup of 4, lane B looping every 12 steps, notes in both lanes.
st().setBpm(BPM);
st().setMeterMap(M78);
st().setPickupSteps(4);
st().setLanes(LANE_A);
assert.equal(st().addLane(12), 1);
st().replaceAll([
  { id: 'a0', note: 60, step: 0, length: 4, velocity: 100 },
  { id: 'a1', note: 67, step: 18, length: 2, velocity: 90 },
  { id: 'b0', note: 36, step: 2, length: 1, velocity: 110, lane: 1 },
  { id: 'b1', note: 38, step: 8, length: 2, velocity: 80, lane: 1 },
]);
st().setTotalSteps(TOTAL);

const original = { meter: rollMeterOf(st()), notes: st().notes.map((n) => ({ ...n })) };
assert.deepEqual(original.meter.meterMap, M78);
assert.equal(original.meter.pickupSteps, 4);
assert.deepEqual(original.meter.lanes, [...LANE_A, { id: 1, name: 'B', cycleSteps: 12 }]);
// Lane B's two notes sound at every cycle before step 60: 5 times each.
const played = playedRollNotes(original.notes, original.meter.lanes, TOTAL);
assert.equal(played.length, 2 + 2 * 5);

/** loadFromClip's arguments carry the original roll. */
const assertLoad = (args: RollLoadArgs, clipId: string) => {
  const [id, notes, bpm, total, meter] = args;
  assert.equal(id, clipId);
  assert.equal(bpm, BPM);
  assert.equal(total, TOTAL);
  assert.deepEqual(meter, original.meter);
  assert.deepEqual(withoutIds(notes), withoutIds(original.notes));
};

/** The roll holds the original, and its notes unroll once. */
const assertRoll = (clipId: string) => {
  assert.equal(st().editingClipId, clipId);
  assert.deepEqual(rollMeterOf(st()), original.meter);
  assert.deepEqual(withoutIds(st().notes), withoutIds(original.notes));
  assert.equal(st().totalSteps, TOTAL);
  assert.equal(st().bpm, BPM);
  const again = rollClipFields(st());
  assert.equal(again.sourcePianoRoll.length, played.length);
  assert.deepEqual(withoutIds(again.sourcePianoRoll), withoutIds(played));
};

// 2. Bounce to EDIT: the fields the clip stores.
const fields = rollClipFields(st());
assert.deepEqual(fields.sourceMeterMap, original.meter.meterMap);
assert.equal(fields.sourcePickupSteps, 4);
assert.deepEqual(fields.sourceLanes, original.meter.lanes);
assert.deepEqual(fields.sourceRollNotes, original.notes);
assert.equal(fields.sourceBpm, BPM);
assert.equal(fields.sourceTotalSteps, TOTAL);
// EDIT plays the unrolled notes, with no lane left to loop.
assert.deepEqual(fields.sourcePianoRoll, played);
assert.equal(fields.sourcePianoRoll.some((n) => 'lane' in n), false);
// The fields are copies of the roll's state.
assert.notEqual(fields.sourceRollNotes[0], st().notes[0]);
assert.notEqual(fields.sourceMeterMap, st().meterMap);
assert.notEqual(fields.sourceLanes, st().lanes);

// 3. Open the clip in the roll.
const clip: RollClipInput = { id: 'clip-1', ...fields };
const firstLoad = clipRollLoad(clip);
assertLoad(firstLoad, 'clip-1');
assert.deepEqual(firstLoad[1], original.notes);

// 4. The roll has moved on to another clip in 4/4 when the user opens this one.
st().loadFromClip('other', [{ id: 'x', note: 60, step: 0, length: 1, velocity: 90 }], 120, 16, {
  meterMap: M44,
  pickupSteps: 0,
  lanes: LANE_A,
});
st().loadFromClip(...firstLoad);
assertRoll('clip-1');
// A second bounce writes the same clip.
assert.deepEqual(rollClipFields(st()), fields);

// 5. Save the project: captureEditorSession writes these keys, and the file goes out and back as JSON.
const saved: { midi_notes: TasmoStepNote[] } & ReturnType<typeof clipMeterToTasmo> = JSON.parse(
  JSON.stringify({ midi_notes: clip.sourcePianoRoll?.map(pianoNoteToTasmo), ...clipMeterToTasmo(clip) }),
);
assert.equal(saved.midi_notes.length, played.length);
assert.equal(saved.midi_notes.some((n) => 'lane' in n), false);
assert.deepEqual(saved.roll_notes?.map((n) => n.lane), [undefined, undefined, 1, 1]);

// 6. Reload: buildClip takes the project tempo and the mapped fields.
const reloaded: RollClipInput = {
  id: 'clip-1',
  sourceBpm: BPM,
  sourcePianoRoll: tasmoNotesToPiano(saved.midi_notes, 'pn'),
  ...tasmoMeterToClip(saved),
};
assert.deepEqual(withoutIds(reloaded.sourcePianoRoll), withoutIds(played));
assert.equal(reloaded.sourcePianoRoll?.some((n) => 'lane' in n), false);

// 7. Open the reloaded clip in the roll.
const secondLoad = clipRollLoad(reloaded);
assertLoad(secondLoad, 'clip-1');
st().loadFromClip('other', [], 120, 16, { meterMap: M44, pickupSteps: 0, lanes: LANE_A });
st().loadFromClip(...secondLoad);
assertRoll('clip-1');

// A clip bounced before the roll had a meter: notes only. The roll still holds the 7/8 clip with lane B.
{
  const legacy: RollClipInput = {
    id: 'old',
    sourcePianoRoll: [
      { id: 'o0', note: 60, step: 0, length: 4, velocity: 100 },
      { id: 'o1', note: 64, step: 17, length: 3, velocity: 100 },
    ],
    sourceBpm: 110,
    sourceTotalSteps: 20,
  };
  const args = clipRollLoad(legacy);
  const [id, notes, bpm, total, meter] = args;
  assert.equal(id, 'old');
  assert.equal(bpm, 110);
  assert.deepEqual(notes, legacy.sourcePianoRoll);
  assert.deepEqual(meter, { meterMap: M44, pickupSteps: 0, lanes: LANE_A });
  // 20 steps rounds up to the end of the second 4/4 bar.
  assert.equal(total, 32);
  st().loadFromClip(...args);
  assert.deepEqual(rollMeterOf(st()), meter);
  assert.equal(st().totalSteps, 32);
  // With no grid length either, the notes' end rounds up to a bar; with no notes, one bar.
  assert.equal(clipRollLoad({ ...legacy, sourceTotalSteps: undefined })[3], 32);
  assert.equal(clipRollLoad({ id: 'empty' })[3], 16);
  // The same clip saved and reloaded from a file without meter fields stays 4/4.
  const fromFile: RollClipInput = { id: 'old', sourceBpm: 110, sourcePianoRoll: legacy.sourcePianoRoll, ...tasmoMeterToClip({}) };
  assert.deepEqual(clipRollLoad(fromFile)[4], meter);
}

console.log('rollClip: ok');
