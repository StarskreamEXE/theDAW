/**
 * Quantize clip notes onto a snap grid.
 *
 * Deliberately not a hard snap: `strength` lets a performance keep its feel
 * while getting tighter, and `swing` moves every second grid line late (or
 * early) so a straight 1/8 grid can be pushed toward a shuffle. Both are what
 * the assistant reaches for when asked to "tighten this up a bit" rather than
 * "put it exactly on the grid".
 */
import type { PianoNote } from '../../state/pianoRollStore';
import type { SnapDivision } from '../../state/editorStore';
import { divisionToSteps } from './units';

/** The shortest note quantizing may ever leave behind, in steps. */
export const MIN_NOTE_STEPS = 0.25;

export interface QuantizeOptions {
  /** Grid to snap to. 'off' (or an unknown division) is a no-op. */
  grid: SnapDivision;
  /** How far toward the grid line to move, 0 = not at all, 1 = all the way. */
  strength?: number;
  /** Offsets every second grid line by `swing * gridSteps / 2`. -1..1. */
  swing?: number;
  /** Also snap note ends, changing lengths. Off by default. */
  quantizeEnds?: boolean;
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * The position of grid line `index`, in steps, with swing applied. Odd lines —
 * the offbeats — move by half the swing amount; even lines never move, so the
 * downbeat stays where the listener expects it.
 */
const gridLine = (index: number, gridSteps: number, swing: number): number =>
  index * gridSteps + (index % 2 === 0 ? 0 : (swing * gridSteps) / 2);

/**
 * The swung grid line nearest to `position`. Swing can push a line past the
 * midpoint between its neighbours, so the three candidates around the
 * unswung guess are all measured rather than trusting the rounding.
 */
const nearestLine = (position: number, gridSteps: number, swing: number): number => {
  const guess = Math.round(position / gridSteps);
  let best = gridLine(guess, gridSteps, swing);
  let bestDistance = Math.abs(position - best);
  for (const index of [guess - 1, guess + 1]) {
    if (index < 0) continue;
    const candidate = gridLine(index, gridSteps, swing);
    const distance = Math.abs(position - candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * Snap note starts (and optionally ends) toward the grid. Returns a new array
 * of new notes in the input order, ids preserved.
 */
export function quantizeNotes(
  notes: readonly PianoNote[],
  options: QuantizeOptions,
): PianoNote[] {
  const gridSteps = divisionToSteps(options.grid);
  if (gridSteps <= 0) return notes.map((note) => ({ ...note }));

  const strength = clamp(options.strength ?? 1, 0, 1);
  const swing = clamp(options.swing ?? 0, -1, 1);
  const quantizeEnds = options.quantizeEnds ?? false;

  return notes.map((note) => {
    const target = nearestLine(note.step, gridSteps, swing);
    const step = Math.max(0, note.step + (target - note.step) * strength);

    if (!quantizeEnds) return { ...note, step };

    const end = note.step + note.length;
    const endTarget = nearestLine(end, gridSteps, swing);
    const newEnd = end + (endTarget - end) * strength;
    return { ...note, step, length: Math.max(MIN_NOTE_STEPS, newEnd - step) };
  });
}
