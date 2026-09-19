/**
 * Loosen clip notes that are too perfect.
 *
 * A clip drawn on the grid or generated from a pattern plays back mechanically;
 * scattering starts and velocities by a small amount fixes that. The PRNG is
 * seedable (mulberry32) so the assistant can offer "undo and try again with the
 * same feel", and so this file's behaviour is testable at all.
 */
import type { PianoNote } from '../../state/pianoRollStore';
import { MAX_VELOCITY, MIN_VELOCITY } from './velocity';

export interface HumanizeOptions {
  /** Maximum timing scatter in either direction, in steps. */
  timingSteps?: number;
  /** Maximum velocity scatter in either direction. */
  velocity?: number;
  /** Seed for deterministic output. Omit for a different result each call. */
  seed?: number;
}

/**
 * mulberry32 — a 32-bit PRNG small enough to inline and good enough for
 * scattering note timings. Same seed, same sequence, on every platform.
 */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Scatter note starts and velocities. Pitch and length are never touched —
 * humanizing is about feel, not about rewriting the part. Returns a new array
 * of new notes, ids preserved.
 */
export function humanizeNotes(
  notes: readonly PianoNote[],
  options: HumanizeOptions = {},
): PianoNote[] {
  const timingSteps = Math.abs(options.timingSteps ?? 0.1);
  const velocityAmount = Math.abs(options.velocity ?? 8);
  const random = options.seed === undefined ? Math.random : mulberry32(options.seed);

  return notes.map((note) => {
    // Two draws per note, always, so the sequence a seed produces does not
    // depend on which of the two amounts happens to be zero.
    const timingRoll = random() * 2 - 1;
    const velocityRoll = random() * 2 - 1;
    const step = Math.max(0, note.step + timingRoll * timingSteps);
    const velocity = Math.max(
      MIN_VELOCITY,
      Math.min(MAX_VELOCITY, Math.round(note.velocity + velocityRoll * velocityAmount)),
    );
    return { ...note, step, velocity };
  });
}
