// SpessaSynth reads a pitch bend range's CC 38 as 1/128 semitone ((CC 6 << 7 | CC 38) / 128), where the MIDI spec
// has cents. The live synth and the soundfont render send it that way, so a range between semitones plays at its
// pitch there; a .mid file keeps cents. Checked against SpessaSynth's own processor.
import assert from 'node:assert/strict';
import { SpessaSynthProcessor } from 'spessasynth_core';
import { RANGE_LSB_SPESSA, bendRangeMessages, encodeMidi, parseMidi } from './midi.ts';
import { notesToSmf } from './midiWrite.ts';

const hasBytes = (hay: Uint8Array, needle: number[]): boolean => {
  for (let i = 0; i + needle.length <= hay.length; i += 1) if (needle.every((b, j) => hay[i + j] === b)) return true;
  return false;
};

const synth = new SpessaSynthProcessor(44100, { effectsEnabled: false, eventsEnabled: false });

/** The bend range SpessaSynth's channel `channel` holds after `messages`. */
const spessaRange = (messages: readonly number[][], channel: number): number => {
  for (const m of messages) synth.processMessage(new Uint8Array(m), 0);
  return synth.midiChannels[channel].midiParameters.pitchWheelRange;
};

// The soundfont path's bytes: CC 6 the semitones, CC 38 the 128ths, and SpessaSynth lands on the range.
{
  const cases: Array<[semitones: number, msb: number, lsb: number]> = [[12.5, 12, 64], [2, 2, 0], [0.25, 0, 32], [47.99, 47, 127], [48, 48, 0]];
  for (const [semitones, msb, lsb] of cases) {
    const messages = bendRangeMessages(3, semitones, RANGE_LSB_SPESSA);
    assert.deepEqual(messages.slice(2, 4), [[0xb3, 6, msb], [0xb3, 38, lsb]]);
    const read = spessaRange(messages, 3);
    assert.ok(Math.abs(read - semitones) <= 1 / 256, `${semitones} semitones: SpessaSynth reads ${read}`);
  }
  assert.equal(spessaRange(bendRangeMessages(3, 12.5, RANGE_LSB_SPESSA), 3), 12.5);
}

// Cents, the .mid file's bytes, fall short in SpessaSynth on a fractional range, which is why the soundfont path counts 128ths.
assert.equal(spessaRange(bendRangeMessages(4, 12.5), 4), 12 + 50 / 128);

// A .mid file keeps cents, and the parser reads them back.
{
  const bytes = encodeMidi({
    ppq: 480,
    bpm: 120,
    tracks: [{ name: 'x', notes: [{ tick: 0, note: 60, velocity: 100, durationTicks: 480, channel: 5 }], bendRanges: [{ tick: 0, channel: 5, semitones: 12.5 }] }],
  });
  assert.ok(hasBytes(bytes, [0xb5, 6, 12, 0x00, 0xb5, 38, 50]));
  assert.deepEqual(parseMidi(bytes).tracks[0].bendRanges, [{ tick: 0, channel: 5, semitones: 12.5 }]);
}

// The soundfont render's file counts 128ths on its wheel's channel.
{
  const render = notesToSmf([{ midi: 60, startSec: 0, durationSec: 0.5, velocity: 100, channel: 1 }], 0, 0, [], 120, [
    { channel: 1, range: 12.5, events: [{ sec: 0, raw: 16383 }] },
  ]);
  assert.ok(hasBytes(render, [0xb1, 6, 12, 0x00, 0xb1, 38, 64]));
}

console.log('bendRangeSpessa: ok');
