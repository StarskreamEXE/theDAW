/**
 * Groove extraction — turn a reference performance (a Library song's transcribed
 * MIDI, delivered as raw Standard MIDI File bytes) into a GrooveTemplate: the
 * per-16th-slot timing "pocket" and rhythmic-density emphasis that the virtuoso
 * humanizer applies in place of random jitter.
 *
 * Note: audio-to-MIDI transcription (basic-pitch) does not recover per-note
 * velocity, so the emphasis weights come from how often each slot is struck
 * (density), not from recorded dynamics. The timing pocket, however, is real —
 * it preserves each onset's deviation from the quantized grid.
 */
import { parseMidi } from './midi';
import { midiEventsToMeterMap, stepsPerBar } from './meterMap';
import type { GrooveTemplate } from './virtuosoTransform';

const SLOTS = 16;
const clampDev = (v: number): number => Math.max(-0.5, Math.min(0.5, v));

/**
 * Build a 16-slot groove from MIDI bytes. An onset's slot is its 16th inside its
 * bar, counted from the bar start. The bar is the file's first bar: its time
 * signature (4/4 when the file has none), after any pickup, which counts back
 * from the bar's end. A position past 16 wraps, the same way humanize reads the
 * template. Returns null if the file has no notes (nothing to learn a pocket from).
 */
export function buildGrooveFromMidiBytes(buf: ArrayBuffer | Uint8Array, name: string): GrooveTemplate | null {
  const data = parseMidi(buf);
  const stepTicks = Math.max(1, data.ppq / 4); // ticks per 16th note
  const { map, pickupSteps } = midiEventsToMeterMap(data.timeSignatures ?? [], data.ppq);
  const barLen = stepsPerBar(map[0].meter);
  const devSum = new Array<number>(SLOTS).fill(0);
  const devCount = new Array<number>(SLOTS).fill(0);
  const hits = new Array<number>(SLOTS).fill(0);

  let total = 0;
  for (const track of data.tracks) {
    for (const n of track.notes) {
      const stepF = n.tick / stepTicks;
      const onStep = Math.round(stepF);
      const inBar = (((onStep - pickupSteps) % barLen) + barLen) % barLen;
      const slot = ((Math.round(inBar) % SLOTS) + SLOTS) % SLOTS;
      const dev = clampDev(stepF - onStep);
      devSum[slot] += dev;
      devCount[slot] += 1;
      hits[slot] += 1;
      total += 1;
    }
  }
  if (total === 0) return null;

  const timing = devSum.map((s, i) => (devCount[i] ? clampDev(s / devCount[i]) : 0));
  const maxHit = Math.max(1, ...hits);
  const accent = hits.map((h) => h / maxHit);
  return { name, timing, accent };
}
