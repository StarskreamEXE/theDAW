/**
 * tempoMap — the tempo half of the app's ONE time map, beside `meterMap.ts`.
 *
 * Before this, tempo lived in at least four places with four different clamps
 * (editorStore, pianoRollStore, beatClock, DJ per-deck) and every surface did
 * its own `60 / bpm`. A DAW has exactly one tempo owner, and it exposes
 * conversions — not a bare `bpm`. This module is that owner's arithmetic:
 * pure functions over a sorted `TempoEvent[]`, with no store behind them (a
 * store would just recreate the multi-owner problem).
 *
 * Model
 * -----
 * A beat is a QUARTER NOTE, everywhere, whatever the meter — the same unit
 * `notechart.ts` and MIDI use. `bpm` is quarter notes per minute, so one beat
 * lasts `60 / bpm` seconds. The map is PIECEWISE CONSTANT: each event holds
 * its tempo until the next one, and `beatToTime` is the exact integral of
 * `60 / bpm` over beats, which for constant segments is a sum of products.
 * Tempo RAMPS are not implemented; `interpolateToNext`-style blending is
 * ignored, exactly as the previous `notechart.ts` code ignored it.
 *
 * The map can never be empty: an empty, null or all-junk map is read as a
 * single 120 bpm event at beat 0, so every caller gets an answer.
 *
 * Bars come from `meterMap.ts` (`barStartStep` / `barAt`, in 16th-note steps);
 * this module only converts those steps to quarter-note beats, so there is one
 * meter implementation and one tempo implementation and nothing in between.
 *
 * Design references (READ, NOT COPIED — both are copyleft and incompatible
 * with this repo; no code from either was used):
 *   - ACE-Step-DAW `src/utils/tempoMap.ts` — AGPL-3.0-or-later.
 *   - Tracktion Engine `tracktion_TempoSequence.h` — GPL-3.0-or-later /
 *     commercial; the source of the "seeded, never-empty map" rule and of
 *     "every conversion funnels through one object".
 * Everything below is written from the mathematical spec.
 */
import { barAt, barStartStep, normalizeMeterMap, stepsPerBar, type MeterSegment } from './meterMap';
import type { Meter } from './colony';

/** One tempo change. `beat` is a quarter-note position; `bpm` is quarter notes per minute. */
export interface TempoEvent {
  beat: number;
  bpm: number;
  /**
   * Absolute seconds of `beat`, when the source already knows them (a
   * `notechart` `TempoEntry` does). Left out, it is integrated from the events
   * before it.
   */
  timeSec?: number;
}

/** A normalized event: sorted, deduped, with its seconds and seconds-per-beat resolved. */
export interface TempoPoint {
  beat: number;
  bpm: number;
  timeSec: number;
  secPerBeat: number;
}

/** Where a beat falls in the bar grid. Lengths and positions are quarter notes. */
export interface BarPosition {
  bar: number;
  startBeat: number;
  lengthBeats: number;
  beatInBar: number;
  meter: Meter;
}

export const DEFAULT_BPM = 120;
/** The seeded default: a map is never empty, so a conversion always has an answer. */
export const DEFAULT_TEMPO_MAP: readonly TempoEvent[] = Object.freeze([{ beat: 0, bpm: DEFAULT_BPM, timeSec: 0 }]);

/** The normalization of every empty/missing/all-junk map. Shared, so it costs nothing. */
const DEFAULT_POINTS = Object.freeze([
  Object.freeze({ beat: 0, bpm: DEFAULT_BPM, timeSec: 0, secPerBeat: 60 / DEFAULT_BPM }),
]) as unknown as TempoPoint[];

/**
 * Normalized points per input array IDENTITY. The SCORE highway converts once
 * per chart event, so re-normalizing (sort + allocate) on every call turned a
 * 500-event chart into a 400x slowdown. `notechart.ts` already caches its
 * `TempoEvent[]` by the same rule, and `beatClock` replaces its one-event array
 * whenever the bpm changes, so identity tracks content for both.
 *
 * The contract that buys this: **a `TempoEvent[]` handed to this module is
 * immutable.** Change the tempo by passing a NEW array; mutating one in place
 * is not a supported input and will keep serving the old normalization.
 */
const normalizedByMap = new WeakMap<readonly TempoEvent[], TempoPoint[]>();

/** Quarter notes in one bar of `m` (7/8 is 3.5). */
export function getBarLength(m: Meter): number {
  return stepsPerBar(m) / 4;
}

/** Quarter notes in one notated beat of `m` (an 8th in x/8). */
export function getBeatLength(m: Meter): number {
  return 4 / m.den;
}

/**
 * Sorted by beat, one event per beat (the later one wins), every `timeSec` and
 * `secPerBeat` filled in. Events with a non-finite beat or a bpm that is not
 * positive are dropped. An empty result becomes the seeded 120 bpm default.
 *
 * A first event that starts after beat 0 and carries no seconds of its own has
 * its tempo run backwards to beat 0, which is what the old `notechart.ts`
 * lookup did (`max(0, bisect_right(...) - 1)` clamps to the first entry).
 *
 * A bpm that is zero or NEGATIVE is dropped rather than trusted: the inline
 * code this replaced would have run time backwards through such an event.
 *
 * PRECONDITION on `timeSec`: if any event carries one, the resulting seconds
 * must be non-decreasing, because `timeToBeat` searches on them. Authoritative
 * seconds are never clamped to enforce that — a caller that supplies `timeSec`
 * supplies it for EVERY event, as `notechart.ts` does. Mixing authoritative
 * seconds on some events with integrated seconds on others can put the
 * sequence out of order (0, 4, 2), after which `timeToBeat` stops being the
 * inverse of `beatToTime`. No caller does this today.
 *
 * The result is CACHED against `map`'s identity and frozen: it is shared with
 * every other caller holding that array, so treat it as read-only.
 */
export function normalizeTempoMap(map: readonly TempoEvent[] | null | undefined): TempoPoint[] {
  if (!map) return DEFAULT_POINTS;
  const cached = normalizedByMap.get(map);
  if (cached) return cached;
  const built = buildPoints(map);
  normalizedByMap.set(map, built);
  return built;
}

function buildPoints(map: readonly TempoEvent[]): TempoPoint[] {
  const byBeat = new Map<number, TempoEvent>();
  for (const e of map) {
    if (!e || !Number.isFinite(e.beat) || !Number.isFinite(e.bpm) || e.bpm <= 0) continue;
    byBeat.set(e.beat, e);
  }
  const sorted = [...byBeat.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  if (!sorted.length) return DEFAULT_POINTS;
  const out: TempoPoint[] = [];
  for (const e of sorted) {
    const secPerBeat = 60 / e.bpm;
    let timeSec: number;
    if (typeof e.timeSec === 'number' && Number.isFinite(e.timeSec)) timeSec = e.timeSec;
    else if (out.length) {
      const prev = out[out.length - 1];
      timeSec = prev.timeSec + (e.beat - prev.beat) * prev.secPerBeat;
    } else timeSec = e.beat * secPerBeat;
    out.push(Object.freeze({ beat: e.beat, bpm: e.bpm, timeSec, secPerBeat }));
  }
  return Object.freeze(out) as unknown as TempoPoint[];
}

/**
 * The last point at or before `value` on `key`, the first point below that —
 * the same clamped upper bound the `notechart.ts` binary search used (Python's
 * `max(0, bisect_right(starts, value) - 1)`). Beats are strictly increasing
 * after normalization; `timeSec` is too unless an input supplied explicit
 * seconds that run backwards, which is not a supported map.
 */
function indexAt(points: readonly TempoPoint[], key: 'beat' | 'timeSec', value: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid][key] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? lo - 1 : 0;
}

/** The point that owns `beat`. */
function pointAtBeat(points: readonly TempoPoint[], beat: number): TempoPoint {
  return points[indexAt(points, 'beat', beat)];
}

/** The point that owns `sec`. Seconds rise with beats, so this mirrors `pointAtBeat`. */
function pointAtTime(points: readonly TempoPoint[], sec: number): TempoPoint {
  return points[indexAt(points, 'timeSec', sec)];
}

/** Quarter notes per minute in force at `beat`. An event owns its own beat. */
export function getTempoAtBeat(map: readonly TempoEvent[] | null | undefined, beat: number): number {
  return pointAtBeat(normalizeTempoMap(map), beat).bpm;
}

/** Seconds in one quarter note at `beat`. */
export function getSecPerBeatAt(map: readonly TempoEvent[] | null | undefined, beat: number): number {
  return pointAtBeat(normalizeTempoMap(map), beat).secPerBeat;
}

/**
 * Absolute seconds of `beat`. Piecewise integration of `60 / bpm`: the owning
 * event's own seconds, plus the beats since it at its own rate. Beats before
 * the first event extend that event's tempo backwards.
 */
export function beatToTime(map: readonly TempoEvent[] | null | undefined, beat: number): number {
  const p = pointAtBeat(normalizeTempoMap(map), beat);
  return p.timeSec + (beat - p.beat) * p.secPerBeat;
}

/** The inverse of `beatToTime`. */
export function timeToBeat(map: readonly TempoEvent[] | null | undefined, sec: number): number {
  const p = pointAtTime(normalizeTempoMap(map), sec);
  return p.beat + (sec - p.timeSec) / p.secPerBeat;
}

/**
 * The quarter-note beat where `bar` starts, meter-aware. `meterMap.ts` counts
 * in 16th-note steps; four of those are one beat. Bar -1 (a pickup) starts at
 * beat 0, as it does there.
 */
export function getBeatAtBar(
  meterMap: readonly MeterSegment[] | null | undefined,
  bar: number,
  pickupSteps = 0,
): number {
  return barStartStep(normalizeMeterMap(meterMap, false), bar, pickupSteps) / 4;
}

/**
 * The bar holding `beat`, with where it starts and how long it is — all in
 * quarter notes. Negative beats read as beat 0, matching `meterMap.barAt`.
 *
 * `beatInBar` is clamped at 0. `meterMap.barAt` snaps to the next bar inside a
 * ~1e-9-step window below a bar line, so without the clamp a beat a hair under
 * a bar line would report the NEXT bar with a NEGATIVE offset into it — and
 * `beatClock.phase()` would hand out `beat: -1`, `sixteenth: 3` and a negative
 * `barFrac`, which the floor-based code it replaced could never produce.
 */
export function getBarAtBeat(
  meterMap: readonly MeterSegment[] | null | undefined,
  beat: number,
  pickupSteps = 0,
): BarPosition {
  const span = barAt(normalizeMeterMap(meterMap, false), beat * 4, pickupSteps);
  const startBeat = span.start / 4;
  return {
    bar: span.bar,
    startBeat,
    lengthBeats: span.len / 4,
    beatInBar: Math.max(0, beat - startBeat),
    meter: span.meter,
  };
}
