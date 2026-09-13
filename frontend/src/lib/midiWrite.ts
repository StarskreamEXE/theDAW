/**
 * Minimal Standard MIDI File (type-0) writer.
 *
 * Bridges the app's absolute-seconds note model (`RenderNote`) into SMF bytes so
 * the notes can be fed to engines that render from a parsed MIDI sequence rather
 * than loose notes (SpessaSynth's offline render takes a `BasicMIDI`). Writes a
 * 480 PPQ grid at one tempo, 120 BPM unless given, with a matching tempo meta
 * event, so tick time maps back to the original seconds.
 *
 * Time signatures are written only when given (the .mid export), and then at
 * the roll's tempo: notesToRollSmf puts the notes and the roll's meter on that
 * tempo's grid, where a roll step is PPQ / 4 ticks, so bar lines and notes agree.
 */
import { meterEventMetas } from './midi';
import { meterMapToMidiEvents, type MeterEvent, type MeterSegment } from './meterMap';
import type { RenderNote } from './midiSynth';

const PPQ = 480;
const DEFAULT_BPM = 120;

/** The tempo meta's microseconds per quarter, and the seconds one tick lasts at that tempo. */
function tempoGrid(bpm: number): { usPerQuarter: number; secPerTick: number } {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
  const usPerQuarter = Math.min(0xffffff, Math.round(60_000_000 / Math.max(20, tempo)));
  return { usPerQuarter, secPerTick: usPerQuarter / 1_000_000 / PPQ };
}

/** Append a variable-length quantity (MIDI delta-time encoding). */
function pushVlq(out: number[], value: number): void {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  for (const b of bytes) out.push(b);
}

/**
 * The roll's meter map as signatures on this writer's grid at the roll's own
 * tempo: a roll step is PPQ / 4 ticks, so each bar start is its roll step times
 * that, and the pickup text counts roll steps.
 */
export function rollMeterToSmfEvents(meterMap: readonly MeterSegment[], pickupSteps: number): MeterEvent[] {
  return meterMapToMidiEvents(meterMap, PPQ, pickupSteps);
}

/**
 * Encode absolute-seconds notes as a single-track Standard MIDI File, with a
 * leading program change so the whole part plays on one GM instrument.
 * `signatures` sit on the grid of `bpm` (rollMeterToSmfEvents).
 */
export function notesToSmf(
  notes: RenderNote[],
  program = 0,
  channel = 0,
  signatures: readonly MeterEvent[] = [],
  bpm = DEFAULT_BPM,
): Uint8Array {
  const ch = channel & 0x0f;
  const { usPerQuarter, secPerTick } = tempoGrid(bpm);
  interface Ev {
    tick: number;
    order: number; // tie-break at equal ticks: meta (-1), then note-off (0), then note-on (1)
    data: number[];
  }
  const evs: Ev[] = [{ tick: 0, order: 0, data: [0xc0 | ch, program & 0x7f] }];
  for (const s of signatures) {
    const tick = Number.isFinite(s.tick) ? Math.max(0, Math.round(s.tick)) : 0;
    for (const data of meterEventMetas(s)) evs.push({ tick, order: -1, data });
  }
  for (const n of notes) {
    const start = Math.max(0, Math.round(n.startSec / secPerTick));
    const end = Math.max(start + 1, Math.round((n.startSec + n.durationSec) / secPerTick));
    const note = Math.max(0, Math.min(127, Math.round(n.midi)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
    evs.push({ tick: start, order: 1, data: [0x90 | ch, note, vel] });
    evs.push({ tick: end, order: 0, data: [0x80 | ch, note, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  // Tempo meta (FF 51 03 tttttt) at tick 0.
  pushVlq(track, 0);
  track.push(0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  let last = 0;
  for (const e of evs) {
    pushVlq(track, e.tick - last);
    last = e.tick;
    for (const b of e.data) track.push(b);
  }
  // End of track.
  pushVlq(track, 0);
  track.push(0xff, 0x2f, 0x00);

  const len = track.length;
  const head = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff, // MThd, format 0, 1 track, PPQ
    0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, // MTrk + length
  ];
  const out = new Uint8Array(head.length + track.length);
  out.set(head, 0);
  out.set(track, head.length);
  return out;
}

/**
 * The .mid export's bytes: the notes at the roll's tempo with the roll's meter
 * on the same grid, so a signature lands on the bar line its notes are placed
 * against and each note keeps its time in seconds to the tick.
 */
export function notesToRollSmf(
  notes: RenderNote[],
  meter: { meterMap: readonly MeterSegment[]; pickupSteps: number; bpm: number },
): Uint8Array {
  return notesToSmf(notes, 0, 0, rollMeterToSmfEvents(meter.meterMap, meter.pickupSteps), meter.bpm);
}
