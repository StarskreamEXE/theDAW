/**
 * rollLoom — LOOM's generators, gates, swing and accelerando as piano-roll
 * notes (docs/design/loom.md §9–10).
 *
 * genNotes asks lib/loomGen for one cell per rule step with the call
 * ColonyEngine.fireRule makes (ruleTile + symbolIndex, the colony's path
 * hash as the lane index): symbol i plays pitches[i], the cell's gain scales
 * the velocity, its transpose moves the pitch. renderGen plays laps of a rule
 * one after another through LoomEngine's chance or cycle gate. swingShift is
 * ColonyEngine.stepTime's swing. accelSpan re-times a span with the tempo ramp
 * of GenCell.warp and fits it back into the span, so the next bar line stays
 * where the meter puts it.
 *
 * Steps are the roll's 16th notes. Everything here is pure.
 */
import { GEN_BLURB, GEN_KINDS, genCell, unit, type GenKind, type GenTile } from './loomGen';
import { groupStarts, ruleTile, symbolIndex, type Meter, type RuleNode } from './colony';
import type { PianoNote } from '../state/pianoRollStore';

export type RollNote = Omit<PianoNote, 'id'>;

export interface GenNoteOpts {
  /** Roll step of rule step 0. */
  startStep: number;
  /** Roll steps per rule step. */
  stepLen: number;
  lap: number;
  seed: number;
  /** `AABA`: which generation a lap plays (life, sierpinski). */
  form?: string;
  /** Velocity at 0 dB. */
  baseVel: number;
  /** Polymeter lane written onto every note. */
  lane?: number;
  /** 0.5 = straight; odd rule steps land late, as in the colony. */
  swing?: number;
  /** The colony's meter: its group downbeats get the colony's accent. */
  meter?: Meter;
  /** genCell's lane index. Defaults to the colony's hash of a root rule with this id. */
  hash?: number;
}

export type GenGate = { kind: 'chance'; pct: number } | { kind: 'lap'; period: number; laps: number[] };

export interface RenderGenOpts extends Omit<GenNoteOpts, 'lap'> {
  /** Passes of the rule; pass k plays lap k. */
  laps: number;
  gate?: GenGate;
}

/** dB ColonyEngine.fireRule adds on a group's first step. */
export const GROUP_ACCENT_DB = 1.5;

const EPS = 1e-9;

/** ColonyEngine's hash of a node's colony path, which it hands genCell as the lane index. */
export function ruleHash(id: string, path: readonly string[] = []): number {
  let h = 7;
  for (const ch of [...path, id].join('/')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** `baseVel` moved by `db`, as a MIDI velocity 1..127. */
export function dbToVelocity(baseVel: number, db: number): number {
  return Math.max(1, Math.min(127, Math.round(baseVel * 10 ** (db / 20))));
}

/** LoomEngine's chance gate: open when the (seed, lane, step, lap) die lands under `pct`. */
export function chanceOpen(seed: number, lane: number, step: number, lap: number, pct: number): boolean {
  return unit(seed, 3, lane, step, lap) * 100 < pct;
}

/** The cycle gate `!laps:period`: open on the listed laps (1-based) of every period. */
export function cycleOpen(lap: number, period: number, laps: readonly number[]): boolean {
  return laps.includes((lap % period) + 1);
}

/** How late rule step `i` lands under `swing`: odd steps move by (swing − 0.5)·2 steps. */
export function swingShift(i: number, swing: number, stepLen: number): number {
  return i % 2 === 1 ? (swing - 0.5) * 2 * stepLen : 0;
}

/** The note rule step `i` plays, or null on a rest. */
function cellNote(tile: GenTile, pitches: readonly number[], accents: readonly number[], hash: number, i: number, startStep: number, lap: number, o: Omit<GenNoteOpts, 'lap'>): RollNote | null {
  const cell = genCell(tile, i, lap, o.seed, o.form, hash, 0);
  const symbol = symbolIndex(cell?.query ?? null);
  if (!cell || symbol == null || !pitches.length) return null;
  const db = (cell.gain ?? 0) + (accents.includes(i) ? GROUP_ACCENT_DB : 0);
  const note: RollNote = {
    note: Math.max(0, Math.min(127, Math.round(pitches[symbol % pitches.length] + (cell.transpose ?? 0)))),
    step: startStep + i * o.stepLen + swingShift(i, o.swing ?? 0.5, o.stepLen),
    length: (cell.steps ?? 1) * o.stepLen,
    velocity: dbToVelocity(o.baseVel, db),
  };
  if (o.lane !== undefined) note.lane = o.lane;
  return note;
}

/** One lap of a colony rule as notes. */
export function genNotes(rule: RuleNode, pitches: readonly number[], o: GenNoteOpts): RollNote[] {
  const tile = ruleTile(rule);
  const accents = o.meter ? groupStarts(o.meter, rule.steps) : [];
  const hash = o.hash ?? ruleHash(rule.id);
  const out: RollNote[] = [];
  for (let i = 0; i < rule.steps; i += 1) {
    const n = cellNote(tile, pitches, accents, hash, i, o.startStep, o.lap, o);
    if (n) out.push(n);
  }
  return out;
}

/** `laps` passes of a rule back to back, each cell through the gate. */
export function renderGen(rule: RuleNode, pitches: readonly number[], o: RenderGenOpts): RollNote[] {
  const tile = ruleTile(rule);
  const accents = o.meter ? groupStarts(o.meter, rule.steps) : [];
  const hash = o.hash ?? ruleHash(rule.id);
  const lane = o.lane ?? 0;
  const out: RollNote[] = [];
  for (let lap = 0; lap < Math.floor(o.laps); lap += 1) {
    const start = o.startStep + lap * rule.steps * o.stepLen;
    for (let i = 0; i < rule.steps; i += 1) {
      if (o.gate?.kind === 'chance' && !chanceOpen(o.seed, lane, i, lap, o.gate.pct)) continue;
      if (o.gate?.kind === 'lap' && !cycleOpen(lap, o.gate.period, o.gate.laps)) continue;
      const n = cellNote(tile, pitches, accents, hash, i, start, lap, o);
      if (n) out.push(n);
    }
  }
  return out;
}

/**
 * The notes that start inside [start, start+len) re-timed by an accelerando
 * (from < to) or ritardando (from > to). Each step of the span lasts
 * GenCell.warp for its place in the ramp; the warped span is scaled back to
 * `len`. Note ends move with the same map. Other notes and the order are kept.
 */
export function accelSpan<T extends { step: number; length: number }>(notes: readonly T[], start: number, len: number, from: number, to: number, curve = 1): T[] {
  if (!(len > 0)) return [...notes];
  const cells = Math.max(1, Math.ceil(len - EPS));
  const tile: GenTile = { kind: 'gen', gen: 'accel', alphabet: [], span: cells, opts: { from, to, curve }, roll: 0 };
  const warp = Array.from({ length: cells }, (_, k) => genCell(tile, k, 0, 0)?.warp ?? 1);
  // Warped time at the start of each cell; the last cell may be a fraction of a step.
  const at = [0];
  for (let k = 0; k < cells; k += 1) at.push(at[k] + warp[k] * Math.min(1, len - k));
  const end = start + len;
  const map = (p: number): number => {
    if (p <= start || p >= end) return p;
    const k = Math.min(cells - 1, Math.floor(p - start));
    return start + (len * (at[k] + (p - start - k) * warp[k])) / at[cells];
  };
  return notes.map((n) => {
    if (n.step < start || n.step >= end) return n;
    const step = map(n.step);
    return { ...n, step, length: map(n.step + n.length) - step };
  });
}

export interface GenRule { kind: GenKind; legend: string; title: string }

const LEGEND: Record<GenKind, string> = {
  fib: 'Fibonacci', fractal: 'Fractal', euclid: 'Euclid', life: 'Life', rand: 'Random', frag: 'Fragment', echo: 'Echo', accel: 'Accel', gliss: 'Gliss',
};

/** Every generator for a menu: a one-word legend and the first sentence of LOOM's blurb. */
export const GEN_RULES: readonly GenRule[] = GEN_KINDS.map((kind) => ({
  kind,
  legend: LEGEND[kind],
  title: /^.*?[.!?](?=\s|$)/.exec(GEN_BLURB[kind])?.[0] ?? GEN_BLURB[kind],
}));
