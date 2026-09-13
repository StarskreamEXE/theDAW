import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { meterMapToMidiEvents, midiEventsToMeterMap, normalizeMeterMap, type MeterSegment } from './meterMap.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** True when `needle` appears in `hay` as one run of bytes. */
const hasBytes = (hay: Uint8Array, needle: number[]): boolean => {
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    if (needle.every((b, j) => hay[i + j] === b)) return true;
  }
  return false;
};

/** A format-1 file built by hand from track bodies (each gets its end-of-track). */
const smf = (ppq: number, ...bodies: number[][]): Uint8Array => {
  const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, bodies.length, (ppq >>> 8) & 0xff, ppq & 0xff];
  for (const b of bodies) {
    const body = [...b, 0x00, 0xff, 0x2f, 0x00];
    const n = body.length;
    out.push(0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body);
  }
  return new Uint8Array(out);
};

const NOTES = [
  { tick: 0, note: 60, velocity: 100, durationTicks: 240, channel: 0 },
  { tick: 240, note: 64, velocity: 90, durationTicks: 480, channel: 0 },
  { tick: 960, note: 67, velocity: 127, durationTicks: 120, channel: 0 },
  { tick: 200000, note: 72, velocity: 50, durationTicks: 480, channel: 0 },
];
const KIT = [
  { tick: 0, note: 36, velocity: 110, durationTicks: 60, channel: 9 },
  { tick: 480, note: 38, velocity: 80, durationTicks: 60, channel: 9 },
];

// With no tempo or signature list, the bytes are the ones the writer produced
// before it could write either (captured from the unmodified encoder).
{
  const BEFORE =
    '4d546864000000060001000301e04d54726b0000001c00ff030554656d706f00ff510309703d00ff58040402180800ff2f00' +
    '4d54726b0000003200ff03044c65616400903c648170803c000090405a8360804000817090437f788043008c9208904832836080480000ff2f00' +
    '4d54726b0000001c00ff03034b69740099246e3c89240083249926503c89260000ff2f00';
  const file: MidiFileData = { ppq: 480, bpm: 97, tracks: [{ name: 'Lead', notes: NOTES }, { name: 'Kit', notes: KIT }] };
  assert.equal(hex(encodeMidi(file)), BEFORE);
  assert.equal(hex(encodeMidi({ ...file, timeSignatures: [], tempos: [] })), BEFORE);
}

// Meter changes with groups and several tempos round-trip at their ticks.
{
  const file: MidiFileData = {
    ppq: 480,
    bpm: 120,
    tracks: [{ name: 'Lead', notes: NOTES }],
    // Out of order on purpose: the writer sorts.
    timeSignatures: [
      { tick: 3600, num: 5, den: 16 },
      { tick: 0, num: 4, den: 4 },
      { tick: 4200, num: 11, den: 8, groups: [3, 3, 3, 2] },
      { tick: 1920, num: 7, den: 8, groups: [3, 2, 2] },
    ],
    tempos: [{ tick: 3600, bpm: 140.5 }, { tick: 0, bpm: 120 }, { tick: 1920, bpm: 97 }],
  };
  const bytes = encodeMidi(file);
  // FF 58 04 num log2(den) 96/den 08
  assert.ok(hasBytes(bytes, [0xff, 0x58, 0x04, 7, 3, 12, 8]));
  assert.ok(hasBytes(bytes, [0xff, 0x58, 0x04, 5, 4, 6, 8]));
  assert.ok(hasBytes(bytes, [0xff, 0x01, 19, ...Array.from('theDAW:groups=3+2+2', (c) => c.charCodeAt(0))]));
  const parsed = parseMidi(bytes);
  assert.deepEqual(parsed.timeSignatures, [
    { tick: 0, num: 4, den: 4 },
    { tick: 1920, num: 7, den: 8, groups: [3, 2, 2] },
    { tick: 3600, num: 5, den: 16 },
    { tick: 4200, num: 11, den: 8, groups: [3, 3, 3, 2] },
  ]);
  assert.deepEqual(parsed.tempos, [{ tick: 0, bpm: 120 }, { tick: 1920, bpm: 97 }, { tick: 3600, bpm: 140.5 }]);
  assert.equal(parsed.bpm, 120);
  assert.deepEqual(parsed.tracks[0].notes, NOTES);
}

// The tick-0 tempo wins: over a later tempo in the same track (the old parser
// kept the last one seen), over `bpm` in the writer, and across tracks.
{
  const parsed = parseMidi(encodeMidi({ ppq: 480, bpm: 60, tracks: [], tempos: [{ tick: 960, bpm: 90 }, { tick: 0, bpm: 132 }] }));
  assert.equal(parsed.bpm, 132);
  assert.deepEqual(parsed.tempos, [{ tick: 0, bpm: 132 }, { tick: 960, bpm: 90 }]);

  // Track 0: 90 BPM at tick 960. Track 1: 132 BPM at tick 0.
  const split = parseMidi(smf(480, [0x87, 0x40, 0xff, 0x51, 0x03, 0x0a, 0x2c, 0x2b], [0x00, 0xff, 0x51, 0x03, 0x06, 0xef, 0x91]));
  assert.equal(split.bpm, 132);
  assert.deepEqual(split.tempos, [{ tick: 0, bpm: 132 }, { tick: 960, bpm: 90 }]);
}

// No FF 58: no timeSignatures. No tempo at tick 0: the first tempo is the bpm.
{
  const parsed = parseMidi(
    smf(
      480,
      [0x83, 0x60, 0xff, 0x51, 0x03, 0x09, 0x27, 0xc0], // 100 BPM at tick 480
      [0x00, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0],
    ),
  );
  assert.equal('timeSignatures' in parsed, false);
  assert.equal(parsed.bpm, 100);
  assert.deepEqual(parsed.tempos, [{ tick: 480, bpm: 100 }]);
  assert.equal(parsed.tracks[0].notes.length, 1);

  const bare = parseMidi(smf(96, [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0]));
  assert.equal(bare.bpm, 120);
  assert.equal('tempos' in bare, false);
  assert.equal('timeSignatures' in bare, false);
}

// A meter map with a pickup survives encode and parse.
{
  const MAP: MeterSegment[] = [
    { bar: 0, meter: { num: 4, den: 4, groups: [] } },
    { bar: 2, meter: { num: 7, den: 8, groups: [3, 2, 2] } },
    { bar: 3, meter: { num: 5, den: 16, groups: [] } },
    { bar: 5, meter: { num: 8, den: 8, groups: [3, 3, 2] } },
  ];
  for (const pickupSteps of [4, 6]) {
    const events = meterMapToMidiEvents(MAP, 480, pickupSteps);
    const parsed = parseMidi(encodeMidi({ ppq: 480, bpm: 110, tracks: [{ name: 'Lead', notes: NOTES }], timeSignatures: events }));
    const back = midiEventsToMeterMap(parsed.timeSignatures ?? [], parsed.ppq);
    assert.deepEqual(back, { map: normalizeMeterMap(MAP), pickupSteps });
  }
}

console.log('midi tests passed');
