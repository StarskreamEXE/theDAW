import assert from 'node:assert/strict';
import { laneName, rollMeterOf, sanitizeLanes, usePianoRollStore } from './pianoRollStore.ts';

const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M54 = { num: 5, den: 4, groups: [2, 3] };
const M44 = { num: 4, den: 4, groups: [] };
const note = (step: number, length = 2, lane?: number) => ({ id: `n${step}`, note: 60, step, length, velocity: 90, ...(lane !== undefined ? { lane } : {}) });
const st = () => usePianoRollStore.getState();

// A 7/8 roll keeps its meter through an import that brings none, and fits to its bar lines.
{
  st().setMeterMap([{ bar: 0, meter: M78 }]);
  st().importNotes([note(0), note(18)]);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M78 }]);
  assert.equal(st().totalSteps, 28);
}

// An import that brings a meter replaces it; the pickup shifts the bar lines.
{
  st().importNotes([note(0), note(20)], 100, { meterMap: [{ bar: 0, meter: M54 }], pickupSteps: 4 });
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M54 }]);
  assert.equal(st().pickupSteps, 4);
  assert.equal(st().totalSteps, 24);
  assert.equal(st().bpm, 100);
}

// Lanes: add, draw into the active one, loop length, removal moves notes to lane 0.
{
  st().replaceAll([]);
  const b = st().addLane(12);
  assert.equal(b, 1);
  assert.deepEqual(st().lanes.map((l) => [l.id, l.name, l.cycleSteps]), [[0, 'A', null], [1, 'B', 12]]);
  st().setActiveLane(1);
  const id = st().addNote({ note: 48, step: 3, length: 2, velocity: 100 });
  assert.equal(st().notes.find((n) => n.id === id)?.lane, 1);
  st().setActiveLane(0);
  const a = st().addNote({ note: 60, step: 0, length: 2, velocity: 100 });
  assert.equal('lane' in (st().notes.find((n) => n.id === a) ?? {}), false);
  st().setLaneCycle(1, 10.4);
  st().setLaneCycle(0, 8);
  assert.deepEqual(st().lanes.map((l) => l.cycleSteps), [null, 10]);
  st().setActiveLane(1);
  st().removeLane(1);
  assert.deepEqual(st().lanes.map((l) => l.id), [0]);
  assert.equal(st().activeLane, 0);
  assert.equal(st().notes.find((n) => n.id === id)?.lane, undefined);
  st().removeLane(0);
  assert.deepEqual(st().lanes.map((l) => l.id), [0]);
}

// Sequence: a clip loaded with no meter keeps the roll's; a clip with one restores it, lanes included.
{
  st().setMeterMap([{ bar: 0, meter: M78 }]);
  st().setPickupSteps(0);
  st().loadFromClip('c1', [note(0)], 120, 32);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M78 }]);
  assert.equal(st().editingClipId, 'c1');
  const saved = rollMeterOf(st());
  st().loadFromClip('c2', [note(0, 2, 2)], 120, 16, { meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, lanes: [{ id: 2, name: 'C', cycleSteps: 6 }] });
  assert.deepEqual(st().lanes.map((l) => [l.id, l.cycleSteps]), [[0, null], [2, 6]]);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M44 }]);
  st().loadFromClip('c1', [note(0)], 120, 32, saved);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M78 }]);
  assert.deepEqual(st().lanes.map((l) => l.id), [0]);
}

// A recording rounds the grid up to a bar line of the meter.
{
  st().setMeterMap([{ bar: 0, meter: M78 }]);
  st().setTotalSteps(256);
  st().placeRecording([note(4)], { startStep: 0, endStep: 8 });
  assert.equal(st().totalSteps, 266);
}

// Lane names and sanitizing.
{
  assert.deepEqual([laneName(0), laneName(1), laneName(25), laneName(26), laneName(27)], ['A', 'B', 'Z', 'AA', 'AB']);
  assert.deepEqual(sanitizeLanes([{ id: 3, name: '', cycleSteps: 0 }, { id: 3, name: 'dup', cycleSteps: 4 }, { id: 0, name: 'Keys', cycleSteps: 9 }]), [
    { id: 0, name: 'Keys', cycleSteps: null },
    { id: 3, name: 'D', cycleSteps: null },
  ]);
}

console.log('pianoRollStore: ok');
