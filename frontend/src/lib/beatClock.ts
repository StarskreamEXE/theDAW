/**
 * beatClock — ONE bar/beat phase for every surface.
 *
 * Before this, tempo lived in five unrelated places (EDIT bpm, PERFORM
 * project.tempo, DJ per-deck analysis, NodeF.I. Live Out, the arp) and the only
 * launch quantizer in the app was PERFORM's bars-only `nextLaunchTime`, anchored
 * to a component-local ref nothing else could read. This module holds a single
 * (bpm, meter map, anchor) on the shared AudioContext so LOOM, the DJ shard
 * pads, PERFORM slots and NodeF.I. can all ask "when is the next bar?" and get
 * the same answer.
 *
 * The anchor is the AudioContext time of bar 0, beat 0. `setBpm` re-anchors so
 * the CURRENT beat position is preserved (no phase jump when a deck drifts).
 * The first `nextGrid` call with no anchor makes NOW bar 0, so a cold start is
 * immediate and everything after it lines up.
 *
 * The clock owns no arithmetic of its own. Beats and seconds go through
 * `tempoMap.ts` (its tempo is the degenerate one-event map, so constant tempo
 * is exactly what it always was), and bar lengths come from `meterMap.ts`, so
 * `nextGrid('bar')` is right in 7/8 and across a meter change — not just in
 * 4/4. A beat is a QUARTER NOTE everywhere here, whatever the meter, which is
 * why a 7/8 bar is 3.5 beats and `setBeatsPerBar(7)` means 7/4.
 */
import { getEngineCtx } from '../state/playerStore';
import { DEFAULT_METER } from './colony';
import { meterAtBar, normalizeMeterMap, stepsPerBar, type MeterSegment } from './meterMap';
import { beatToTime, getBarAtBeat, getBarLength, getBeatAtBar, timeToBeat, type TempoEvent } from './tempoMap';

export type ClockGrid = 'now' | '16th' | '8th' | 'beat' | 'half' | 'bar' | '2bar' | '4bar';
export type ClockSource = 'internal' | 'dj' | 'perform' | 'edit' | 'nodefi' | 'loom';

export interface BeatClockState {
  bpm: number;
  /** Quarter notes in bar 0's bar. 4/4 is 4, 7/8 is 3.5. */
  beatsPerBar: number;
  /** AudioContext time of bar 0 beat 0; null until something has launched. */
  anchor: number | null;
  source: ClockSource;
}

export interface ClockPhase {
  bar: number;
  beat: number;
  sixteenth: number;
  /** 0..1 inside the current beat. */
  beatFrac: number;
  /** 0..1 inside the current bar. */
  barFrac: number;
}

type Listener = (s: BeatClockState) => void;

/** Small scheduling lead so a launch computed "now" is never already past. */
export const CLOCK_LEAD_SEC = 0.01;

const state: BeatClockState = { bpm: 120, beatsPerBar: 4, anchor: null, source: 'internal' };
const listeners = new Set<Listener>();

/** The meter half. One segment until something calls `setMeterMap`. */
let meterSegs: MeterSegment[] = normalizeMeterMap([{ bar: 0, meter: { ...DEFAULT_METER, groups: [] } }]);
/** The tempo half: one event, so every conversion is the constant-tempo one. */
let tempoEvents: TempoEvent[] = [{ beat: 0, bpm: state.bpm, timeSec: 0 }];

/**
 * `meterSegs` with each segment's first bar in 16th-note steps, accumulated
 * left to right exactly as `meterMap.barStartStep` does — so a bar start read
 * from here is the same float that `getBeatAtBar` returns. Rebuilt when the
 * meter map changes, so walking bar lines costs no allocation and no sort:
 * `nextGrid` runs on the loom/colony launch path, and calling `meterAtBar` /
 * `getBeatAtBar` per bar re-normalized the whole map (Map + sort + allocate)
 * on every iteration.
 */
interface MeterSpan { bar: number; startStep: number; steps: number }
let meterSpans: MeterSpan[] = [];

function rebuildMeterSpans(): void {
  meterSpans = [];
  let startStep = 0;
  for (let i = 0; i < meterSegs.length; i += 1) {
    if (i > 0) startStep += (meterSegs[i].bar - meterSegs[i - 1].bar) * stepsPerBar(meterSegs[i - 1].meter);
    meterSpans.push({ bar: meterSegs[i].bar, startStep, steps: stepsPerBar(meterSegs[i].meter) });
  }
}
rebuildMeterSpans();

/** Whole bars between two lines of a bar-relative grid. */
const BAR_STRIDE: Partial<Record<ClockGrid, number>> = { half: 0.5, bar: 1, '2bar': 2, '4bar': 4 };

const emit = () => { for (const l of listeners) l({ ...state }); };
const clampBpm = (b: number) => Math.max(20, Math.min(300, b));

function now(): number {
  try { return getEngineCtx().currentTime; } catch { return 0; }
}

/** Seconds from the anchor to `beat`. */
const secOfBeat = (beat: number): number => beatToTime(tempoEvents, beat);

/**
 * The first line of a bar-relative grid at or after `t`. Only needed once the
 * meter map has more than one segment: with a single meter the lines are
 * evenly spaced and `nextGrid` uses the closed form instead.
 */
function nextBarLine(t: number, stride: number): number {
  const anchor = state.anchor ?? t;
  const beats = timeToBeat(tempoEvents, t - anchor);
  const last = meterSpans[meterSpans.length - 1];
  // From this bar on the meter never changes again, so the grid is uniform.
  const uniformFrom = stride >= 1 ? Math.ceil(last.bar / stride) * stride : last.bar;
  let si = 0;
  for (let bar = 0; bar < uniformFrom; bar += 1) {
    while (si + 1 < meterSpans.length && meterSpans[si + 1].bar <= bar) si += 1;
    if (stride >= 1 && bar % stride !== 0) continue;
    const span = meterSpans[si];
    const len = span.steps / 4;
    const start = (span.startStep + (bar - span.bar) * span.steps) / 4;
    if (start >= beats - 1e-6 * len) return anchor + secOfBeat(start);
    if (stride < 1 && start + len / 2 >= beats - 1e-6 * len) return anchor + secOfBeat(start + len / 2);
  }
  const len = last.steps / 4;
  const unit = stride < 1 ? len / 2 : len * stride;
  const base = (last.startStep + (uniformFrom - last.bar) * last.steps) / 4;
  const n = Math.ceil((beats - base) / unit - 1e-6);
  return anchor + secOfBeat(base + n * unit);
}

export const beatClock = {
  get state(): BeatClockState { return { ...state }; },
  get bpm(): number { return state.bpm; },
  get beatsPerBar(): number { return state.beatsPerBar; },
  /** The meter map the bar grid is built on. */
  get meterMap(): MeterSegment[] { return meterSegs.map((s) => ({ bar: s.bar, meter: { ...s.meter, groups: [...s.meter.groups] } })); },
  beatSec(): number { return 60 / state.bpm; },

  /** Quarter notes in `bar`'s bar. */
  beatsPerBarAt(bar: number): number { return getBarLength(meterAtBar(meterSegs, bar)); },

  barSec(bar = 0): number { return (60 / state.bpm) * this.beatsPerBarAt(bar); },

  /** Seconds per grid unit. Bar-relative grids are measured on `bar`'s bar. */
  gridSec(grid: ClockGrid, bar = 0): number {
    const beat = 60 / state.bpm;
    const beatsPerBar = this.beatsPerBarAt(bar);
    switch (grid) {
      case 'now': return 0;
      case '16th': return beat / 4;
      case '8th': return beat / 2;
      case 'beat': return beat;
      case 'half': return beat * beatsPerBar / 2;
      case 'bar': return beat * beatsPerBar;
      case '2bar': return beat * beatsPerBar * 2;
      case '4bar': return beat * beatsPerBar * 4;
    }
  },

  /** Make `at` (default now) bar `bar`, beat 0. */
  setAnchor(at?: number, bar = 0): void {
    const t = at ?? now();
    state.anchor = t - secOfBeat(getBeatAtBar(meterSegs, bar));
    emit();
  },

  /** Change tempo without a phase jump: the beat we are on stays the beat we are on. */
  setBpm(bpm: number, source?: ClockSource): void {
    const next = clampBpm(bpm);
    if (Math.abs(next - state.bpm) < 1e-6 && (!source || source === state.source)) return;
    const t = now();
    const beatsElapsed = state.anchor != null ? timeToBeat(tempoEvents, t - state.anchor) : 0;
    state.bpm = next;
    tempoEvents = [{ beat: 0, bpm: next, timeSec: 0 }];
    if (state.anchor != null) state.anchor = t - secOfBeat(beatsElapsed);
    if (source) state.source = source;
    emit();
  },

  /** Every bar is `n` quarter notes, i.e. n/4. The whole-bar shorthand for `setMeterMap`. */
  setBeatsPerBar(n: number): void {
    const v = Math.max(1, Math.min(16, Math.round(n)));
    if (v === state.beatsPerBar && meterSegs.length === 1) return;
    this.setMeterMap([{ bar: 0, meter: { num: v, den: 4, groups: [] } }]);
  },

  /** Time signatures by bar, so bar lines are right outside 4/4. */
  setMeterMap(map: readonly MeterSegment[] | null | undefined): void {
    meterSegs = normalizeMeterMap(map);
    rebuildMeterSpans();
    state.beatsPerBar = this.beatsPerBarAt(0);
    emit();
  },

  /** Where we are, at `at` (default now). */
  phase(at?: number): ClockPhase {
    const t = at ?? now();
    const anchor = state.anchor ?? t;
    const beats = Math.max(0, timeToBeat(tempoEvents, t - anchor));
    const pos = getBarAtBeat(meterSegs, beats);
    const beatIdx = Math.floor(pos.beatInBar);
    const beatFrac = pos.beatInBar - beatIdx;
    return {
      bar: pos.bar,
      beat: beatIdx,
      sixteenth: Math.floor(beatFrac * 4),
      beatFrac,
      barFrac: pos.beatInBar / pos.lengthBeats,
    };
  },

  /** The next `grid` line at or after `from` (default now + lead). A cold clock
   *  anchors itself at `from`, so the first launch is immediate. */
  nextGrid(grid: ClockGrid, from?: number): number {
    const t = from ?? now() + CLOCK_LEAD_SEC;
    if (state.anchor == null) {
      state.anchor = t;
      emit();
      return t;
    }
    if (grid === 'now') return t;
    const stride = BAR_STRIDE[grid];
    // Bar lines are only evenly spaced while the meter holds; walk them once it does not.
    if (stride !== undefined && meterSegs.length > 1) return nextBarLine(t, stride);
    const unit = this.gridSec(grid);
    const n = Math.ceil((t - state.anchor) / unit - 1e-6);
    return state.anchor + n * unit;
  },

  /** Time of an absolute step: bar `bar`, plus `stepsIntoBar` of `stepsPerBar`. */
  timeOf(bar: number, stepsIntoBar = 0, stepsPerBar = 16): number {
    const anchor = state.anchor ?? now();
    return anchor + secOfBeat(getBeatAtBar(meterSegs, bar)) + (stepsIntoBar / stepsPerBar) * this.barSec(bar);
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

export type BeatClock = typeof beatClock;
