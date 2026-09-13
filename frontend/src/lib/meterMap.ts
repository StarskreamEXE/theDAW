/**
 * meterMap — time signatures that change by bar, and polymeter lanes, for the
 * piano roll.
 *
 * A meter map is a sorted list of segments. Each starts at a bar and holds
 * until the next one. Steps are 16th notes, so a bar of num/den holds
 * num·16/den steps (7/8 = 14, 5/16 = 5, 7/32 = 3.5). An optional pickup of
 * `pickupSteps` sits before bar 0 and is reported as bar -1.
 *
 * The meter type, group starts and meter text come from LOOM's colony.ts, so
 * the app keeps one meter type.
 *
 * A note's `lane` names a PolyLane. A lane with a `cycleSteps` loops its notes
 * at that length; unrollLanes writes the repeats out for playback, bounce and
 * export.
 *
 * Everything here is pure.
 */
import { DEFAULT_METER, groupStarts, type Meter } from './colony';
import type { PianoNote } from '../state/pianoRollStore';

export interface MeterSegment { bar: number; meter: Meter }
export interface PolyLane { id: number; name: string; cycleSteps: number | null }
export interface BarSpan { bar: number; start: number; len: number; meter: Meter }
export interface MeterEvent { tick: number; num: number; den: number; groups?: number[] }
export type LaneNote = PianoNote & { lane?: number };

export const DEFAULT_METER_MAP: readonly MeterSegment[] = Object.freeze([{ bar: 0, meter: DEFAULT_METER }]);
export const METER_DENOMINATORS = [1, 2, 4, 8, 16, 32] as const;

const EPS = 1e-9;

export const stepsPerBar = (m: Meter): number => (m.num * 16) / m.den;

export function meterEquals(a: Meter, b: Meter): boolean {
  return a.num === b.num && a.den === b.den && a.groups.length === b.groups.length && a.groups.every((g, i) => g === b.groups[i]);
}

/** A copy of `m` with a valid numerator and denominator, and its groups kept only when they sum to the numerator. */
export function sanitizeMeter(m: Partial<Meter> | null | undefined): Meter | null {
  if (!m) return null;
  const num = Number(m.num);
  const den = Number(m.den);
  if (!Number.isInteger(num) || num < 1 || num > 64) return null;
  if (!(METER_DENOMINATORS as readonly number[]).includes(den)) return null;
  const groups = Array.isArray(m.groups) ? m.groups.map(Number) : [];
  const ok = groups.length > 1 && groups.every((g) => Number.isInteger(g) && g >= 1) && groups.reduce((a, b) => a + b, 0) === num;
  return { num, den, groups: ok ? groups : [] };
}

/**
 * Sorted, bar 0 first, one segment per bar (the later one wins). Bars before
 * the first segment take its meter. With `merge` (the default) a segment that
 * repeats the meter before it is dropped.
 */
export function normalizeMeterMap(map: readonly MeterSegment[] | null | undefined, merge = true): MeterSegment[] {
  const byBar = new Map<number, Meter>();
  for (const s of map ?? []) {
    const meter = sanitizeMeter(s?.meter);
    if (!meter || !Number.isFinite(s.bar)) continue;
    byBar.set(Math.max(0, Math.floor(s.bar)), meter);
  }
  const sorted = [...byBar.entries()].sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return [{ bar: 0, meter: { ...DEFAULT_METER, groups: [] } }];
  sorted[0] = [0, sorted[0][1]];
  const out: MeterSegment[] = [];
  for (const [bar, meter] of sorted) {
    if (merge && out.length && meterEquals(out[out.length - 1].meter, meter)) continue;
    out.push({ bar, meter });
  }
  return out;
}

/** Index of the segment that covers `bar`. */
export function segmentIndexAt(map: readonly MeterSegment[], bar: number): number {
  const segs = normalizeMeterMap(map, false);
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].bar <= bar) i += 1;
  return i;
}

export function meterAtBar(map: readonly MeterSegment[], bar: number): Meter {
  const segs = normalizeMeterMap(map, false);
  return segs[segmentIndexAt(segs, Math.max(0, bar))].meter;
}

/** The step where `bar` starts. Bar -1 (the pickup) starts at 0. */
export function barStartStep(map: readonly MeterSegment[], bar: number, pickupSteps = 0): number {
  if (bar < 0) return 0;
  const segs = normalizeMeterMap(map, false);
  let step = Math.max(0, pickupSteps);
  for (let i = 0; i < segs.length; i += 1) {
    const from = segs[i].bar;
    if (bar <= from) break;
    const to = i + 1 < segs.length ? segs[i + 1].bar : Infinity;
    step += (Math.min(bar, to) - from) * stepsPerBar(segs[i].meter);
  }
  return step;
}

/** The bar that holds `step`. Accepts fractional steps. */
export function barAt(map: readonly MeterSegment[], step: number, pickupSteps = 0): BarSpan {
  const segs = normalizeMeterMap(map, false);
  const pickup = Math.max(0, pickupSteps);
  const s = Math.max(0, step);
  if (pickup > 0 && s < pickup - EPS) return { bar: -1, start: 0, len: pickup, meter: segs[0].meter };
  let start = pickup;
  for (let i = 0; i < segs.length; i += 1) {
    const meter = segs[i].meter;
    const len = stepsPerBar(meter);
    const count = i + 1 < segs.length ? segs[i + 1].bar - segs[i].bar : Infinity;
    if (count === Infinity || s < start + count * len - EPS) {
      const k = Math.max(0, Math.floor((s - start) / len + EPS));
      return { bar: segs[i].bar + k, start: start + k * len, len, meter };
    }
    start += count * len;
  }
  // Unreachable: the last segment runs forever.
  return { bar: 0, start: pickup, len: stepsPerBar(segs[0].meter), meter: segs[0].meter };
}

/** Every bar that starts before `totalSteps`, the pickup (bar -1) first when there is one. */
export function bars(map: readonly MeterSegment[], totalSteps: number, pickupSteps = 0): BarSpan[] {
  const segs = normalizeMeterMap(map, false);
  const pickup = Math.max(0, pickupSteps);
  const out: BarSpan[] = [];
  if (pickup > 0 && totalSteps > 0) out.push({ bar: -1, start: 0, len: pickup, meter: segs[0].meter });
  let start = pickup;
  let bar = 0;
  let si = 0;
  while (start < totalSteps - EPS) {
    while (si + 1 < segs.length && segs[si + 1].bar <= bar) si += 1;
    const meter = segs[si].meter;
    const len = stepsPerBar(meter);
    out.push({ bar, start, len, meter });
    start += len;
    bar += 1;
  }
  return out;
}

/** Start steps of every bar before `totalSteps`, the pickup's 0 included. */
export function barLines(map: readonly MeterSegment[], totalSteps: number, pickupSteps = 0): number[] {
  return bars(map, totalSteps, pickupSteps).map((b) => b.start);
}

/** Beat positions inside one bar, 0 included: every 16/den steps. */
export function beatLines(m: Meter): number[] {
  const beat = 16 / m.den;
  const len = stepsPerBar(m);
  const out: number[] = [];
  for (let t = 0; t < len - EPS; t += beat) out.push(t);
  return out;
}

/** Group starts inside one bar, 0 included (7/8 3+2+2 gives [0, 6, 10]). */
export function groupLines(m: Meter): number[] {
  return groupStarts(m, stepsPerBar(m));
}

/**
 * Absolute steps for the grid's three tiers before `totalSteps`: bar lines,
 * group starts that are not bar lines, and beats that are neither. The pickup
 * bar's beats count back from its end.
 */
export function gridLines(map: readonly MeterSegment[], totalSteps: number, pickupSteps = 0): { bar: number[]; group: number[]; beat: number[] } {
  const out = { bar: [] as number[], group: [] as number[], beat: [] as number[] };
  for (const b of bars(map, totalSteps, pickupSteps)) {
    out.bar.push(b.start);
    if (b.bar < 0) {
      const beat = 16 / b.meter.den;
      for (let t = b.len - beat; t > EPS; t -= beat) out.beat.push(t);
      continue;
    }
    const groups = groupLines(b.meter).filter((g) => g > EPS);
    for (const g of groups) if (b.start + g < totalSteps - EPS) out.group.push(b.start + g);
    for (const t of beatLines(b.meter)) {
      if (t <= EPS || groups.some((g) => Math.abs(g - t) <= EPS)) continue;
      if (b.start + t < totalSteps - EPS) out.beat.push(b.start + t);
    }
  }
  if (totalSteps > 0) out.bar.push(totalSteps);
  out.beat.sort((a, b) => a - b);
  return out;
}

/** The first bar line at or after `step`; 0 stays 0. */
export function roundUpToBar(map: readonly MeterSegment[], step: number, pickupSteps = 0): number {
  if (step <= EPS) return 0;
  const b = barAt(map, step, pickupSteps);
  return Math.abs(step - b.start) <= EPS ? b.start : b.start + b.len;
}

/** First and last bar of segment `index`; the last segment ends at the last bar before `totalSteps`. */
export function segmentBars(map: readonly MeterSegment[], index: number, totalSteps: number, pickupSteps = 0): { first: number; last: number } {
  const segs = normalizeMeterMap(map, false);
  const i = Math.max(0, Math.min(segs.length - 1, index));
  const first = segs[i].bar;
  if (i + 1 < segs.length) return { first, last: segs[i + 1].bar - 1 };
  const all = bars(segs, totalSteps, pickupSteps);
  const lastBar = all.length ? all[all.length - 1].bar : first;
  return { first, last: Math.max(first, lastBar) };
}

/** Start `meter` at `bar`, holding until the next change. */
export function setMeterAt(map: readonly MeterSegment[], bar: number, meter: Meter, merge = true): MeterSegment[] {
  const clean = sanitizeMeter(meter);
  if (!clean) return normalizeMeterMap(map, merge);
  const b = Math.max(0, Math.floor(bar));
  const rest = normalizeMeterMap(map, false).filter((s) => s.bar !== b);
  return normalizeMeterMap([...rest, { bar: b, meter: clean }], merge);
}

/** Remove the change that starts at `bar`; bar 0 always keeps a meter. */
export function removeChangeAt(map: readonly MeterSegment[], bar: number): MeterSegment[] {
  if (bar <= 0) return normalizeMeterMap(map);
  return normalizeMeterMap(normalizeMeterMap(map, false).filter((s) => s.bar !== bar));
}

/** A step count as a time signature: 4 steps = 1/4, 6 = 3/8, 3 = 3/16, 1.5 = 3/32. */
export function stepsAsMeter(steps: number): Meter | null {
  if (!(steps > 0)) return null;
  let num: number;
  let den: number;
  if (Number.isInteger(steps)) { num = steps; den = 16; } else if (Number.isInteger(steps * 2)) { num = steps * 2; den = 32; } else return null;
  while (num % 2 === 0 && den > 4) { num /= 2; den /= 2; }
  return num <= 64 ? { num, den, groups: [] } : null;
}

/** MIDI time signature events (FF 58) for the map, a partial bar at tick 0 when there is a pickup. */
export function meterMapToMidiEvents(map: readonly MeterSegment[], ppq: number, pickupSteps = 0): MeterEvent[] {
  const segs = normalizeMeterMap(map);
  const tps = ppq / 4;
  const pickup = Math.max(0, pickupSteps);
  const out: MeterEvent[] = [];
  const partial = pickup > 0 ? stepsAsMeter(pickup) : null;
  if (partial) out.push({ tick: 0, num: partial.num, den: partial.den, groups: [] });
  for (const s of segs) {
    out.push({ tick: Math.round(barStartStep(segs, s.bar, partial ? pickup : 0) * tps), num: s.meter.num, den: s.meter.den, groups: [...s.meter.groups] });
  }
  return out;
}

/**
 * The inverse of meterMapToMidiEvents. A file with no signature at tick 0 is
 * 4/4 until its first one. A signature at tick 0 that lasts one bar or less,
 * and is shorter than a bar of the signature after it, is a pickup. A change
 * that lands inside a bar moves to the next bar line.
 */
export function midiEventsToMeterMap(events: readonly MeterEvent[], ppq: number): { map: MeterSegment[]; pickupSteps: number } {
  const tps = ppq / 4;
  const byStep = new Map<number, Meter>();
  for (const e of events) {
    const meter = sanitizeMeter({ num: e.num, den: e.den, groups: e.groups ?? [] });
    if (!meter || !Number.isFinite(e.tick) || e.tick < 0) continue;
    byStep.set(e.tick / tps, meter);
  }
  const evs = [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([step, meter]) => ({ step, meter }));
  if (!evs.length) return { map: normalizeMeterMap(null), pickupSteps: 0 };
  if (evs[0].step > EPS) evs.unshift({ step: 0, meter: { ...DEFAULT_METER, groups: [] } });
  let pickupSteps = 0;
  if (evs.length > 1 && evs[1].step <= stepsPerBar(evs[0].meter) + EPS && evs[1].step < stepsPerBar(evs[1].meter) - EPS) {
    pickupSteps = evs[1].step;
    evs.shift();
  }
  const map: MeterSegment[] = [{ bar: 0, meter: evs[0].meter }];
  let bar = 0;
  let cursor = pickupSteps;
  let current = evs[0].meter;
  for (let i = 1; i < evs.length; i += 1) {
    const len = stepsPerBar(current);
    const n = Math.max(0, Math.ceil((evs[i].step - cursor) / len - EPS));
    bar += n;
    cursor += n * len;
    current = evs[i].meter;
    map.push({ bar, meter: current });
  }
  return { map: normalizeMeterMap(map), pickupSteps };
}

/**
 * A meter from the rhythm engine's meter_map segment. Its grouping sums to
 * beats_per_bar, which is the numerator except in compound meters (6/8 has 2
 * beats), so the groups scale by numerator / sum.
 */
export function meterFromAnalysis(seg: { numerator?: number; denominator?: number; grouping?: number[]; beats_per_bar?: number }): Meter | null {
  const num = Math.round(Number(seg.numerator ?? seg.beats_per_bar ?? 0));
  const base = sanitizeMeter({ num, den: Number(seg.denominator ?? 4), groups: [] });
  if (!base) return null;
  const g = (seg.grouping ?? []).map((x) => Math.round(Number(x))).filter((x) => x >= 1);
  const sum = g.reduce((a, b) => a + b, 0);
  if (g.length > 1 && sum > 0 && num % sum === 0) {
    const f = num / sum;
    return sanitizeMeter({ ...base, groups: g.map((x) => x * f) });
  }
  return base;
}

/**
 * Lane notes written out across the roll. A lane with a cycle shorter than
 * the roll repeats its notes every cycle; a note placed past its lane's first
 * cycle wraps into it. Notes with no lane, or a lane without a cycle, pass
 * through. Repeats get the id `<id>~<k>`. Sorted by step, then pitch.
 */
export function unrollLanes<T extends LaneNote>(notes: readonly T[], lanes: readonly PolyLane[], totalSteps: number): T[] {
  const cycles = new Map(lanes.map((l) => [l.id, l.cycleSteps]));
  const out: T[] = [];
  for (const n of notes) {
    const cyc = n.lane === undefined ? null : cycles.get(n.lane) ?? null;
    if (!cyc || cyc <= 0 || cyc >= totalSteps) { out.push(n); continue; }
    const base = ((n.step % cyc) + cyc) % cyc;
    for (let k = 0; base + k * cyc < totalSteps - EPS; k += 1) {
      const step = base + k * cyc;
      out.push({ ...n, id: k === 0 ? n.id : `${n.id}~${k}`, step, length: Math.min(n.length, totalSteps - step) });
    }
  }
  return out.sort((a, b) => a.step - b.step || a.note - b.note);
}

/** Steps until every looping lane starts together again (the least common multiple of their cycles). */
export function lanesRealign(lanes: readonly PolyLane[]): number | null {
  const cycles = lanes.map((l) => l.cycleSteps).filter((c): c is number => typeof c === 'number' && c > 0);
  if (!cycles.length) return null;
  const scale = cycles.every(Number.isInteger) ? 1 : 2;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const ints = cycles.map((c) => Math.round(c * scale));
  return ints.reduce((a, b) => (a * b) / gcd(a, b)) / scale;
}
