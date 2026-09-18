/**
 * tempoStore — the app's ONE owned, mutable tempo map.
 *
 * `lib/tempoMap.ts` is pure arithmetic over a `TempoEvent[]` and deliberately
 * owns no state: the batch-3 note that created it warned that a store would
 * "recreate the multi-owner problem". That warning is about ARITHMETIC, and it
 * still holds — nothing here converts anything. What it left unanswered is who
 * HOLDS the array once a project has more than one tempo, and "nobody" is how
 * the app ended up with three bpm scalars and three different clamps. This
 * store is that holder, and there is exactly one of it:
 *
 *   tempoStore (the array)  ->  beatClock (the live clock)  ->  every surface
 *
 * so the map still has a single owner and the maths still has a single
 * implementation. No clamp is defined here: `clampClockBpm` comes from
 * `beatClock`, which is the app's one tempo range (20..300).
 *
 * IMMUTABILITY. `tempoMap.ts` caches its normalization on the array's IDENTITY,
 * so a map handed to it must never be edited in place. Every action here
 * therefore builds a NEW array and freezes it, events and all: a mutation
 * attempt throws in a module, and silently does nothing in a bundle, instead of
 * leaving conversions serving a stale map.
 *
 * SECONDS are not stored. A `TempoEvent` may carry an authoritative `timeSec`
 * (a `notechart` supplies one), but a map being EDITED must not: the whole
 * point of changing a tempo is that everything after it moves, and a stored
 * second would pin it. Seconds are derived, every time, through `tempoMap.ts`.
 * `remapOnTempoChange` is the helper for moving beat-anchored material when
 * they do.
 */
import { create } from 'zustand';
import { clampClockBpm, beatClock } from '../lib/beatClock';
import { DEFAULT_BPM, type TempoCurve, type TempoEvent } from '../lib/tempoMap';

/** A frozen array of frozen events — the shape every action returns. */
function seal(events: TempoEvent[]): readonly TempoEvent[] {
  for (const e of events) Object.freeze(e);
  return Object.freeze(events);
}

/** What a fresh project starts with: one constant event, the seeded default. */
export const INITIAL_TEMPO_EVENTS: readonly TempoEvent[] = seal([{ beat: 0, bpm: DEFAULT_BPM, curve: 'step' }]);

interface TempoState {
  /** Sorted by beat, one event per beat, never empty, always frozen. */
  events: readonly TempoEvent[];
  /** Replace the whole map. Sorted, deduped, clamped and frozen on the way in. */
  setEvents: (events: readonly TempoEvent[]) => void;
  /** Add a tempo change at `beat`, replacing any event already sitting there. */
  insertEvent: (beat: number, bpm: number, curve?: TempoCurve) => void;
  /** Move the event at `fromBeat` to `toBeat`, keeping its tempo and curve. */
  moveEvent: (fromBeat: number, toBeat: number) => void;
  /** Drop the event at `beat`. The last remaining event is never removed. */
  removeEvent: (beat: number) => void;
  /** Change the tempo of the event IN FORCE at `beat`, wherever that event starts. */
  setBpmAt: (beat: number, bpm: number) => void;
}

/**
 * A sorted, deduped, clamped, frozen COPY. Junk is dropped on the same rule
 * `normalizeTempoMap` uses (a non-finite beat, or a bpm that is not positive,
 * cannot define a segment), and a map that ends up empty falls back to the
 * seeded default rather than leaving the project without a tempo.
 *
 * A later event at the same beat wins, so an action can express "replace what
 * is there" by appending.
 */
function sanitize(events: readonly TempoEvent[]): readonly TempoEvent[] {
  const byBeat = new Map<number, TempoEvent>();
  for (const e of events) {
    if (!e || !Number.isFinite(e.beat) || !Number.isFinite(e.bpm) || e.bpm <= 0) continue;
    byBeat.set(e.beat, { beat: e.beat, bpm: clampClockBpm(e.bpm), curve: e.curve === 'linear' ? 'linear' : 'step' });
  }
  const out = [...byBeat.values()].sort((a, b) => a.beat - b.beat);
  return out.length ? seal(out) : INITIAL_TEMPO_EVENTS;
}

/** The index of the event in force at `beat`: the last at or before it, or the first. */
function indexInForce(events: readonly TempoEvent[], beat: number): number {
  let idx = 0;
  for (let i = 0; i < events.length; i += 1) if (events[i].beat <= beat) idx = i;
  return idx;
}

export const useTempoStore = create<TempoState>()((set, get) => ({
  events: INITIAL_TEMPO_EVENTS,

  setEvents: (events) => set({ events: sanitize(events ?? []) }),

  insertEvent: (beat, bpm, curve = 'step') => {
    if (!Number.isFinite(beat) || !Number.isFinite(bpm) || bpm <= 0) return;
    set({ events: sanitize([...get().events, { beat, bpm, curve }]) });
  },

  moveEvent: (fromBeat, toBeat) => {
    const { events } = get();
    if (!Number.isFinite(toBeat) || fromBeat === toBeat) return;
    const found = events.find((e) => e.beat === fromBeat);
    if (!found) return;
    // The moved event goes last, so it wins if something already sits on `toBeat`.
    set({ events: sanitize([...events.filter((e) => e.beat !== fromBeat), { ...found, beat: toBeat }]) });
  },

  removeEvent: (beat) => {
    const { events } = get();
    // A tempo map always has a tempo; the last event is not removable.
    if (events.length <= 1) return;
    const out = events.filter((e) => e.beat !== beat);
    if (out.length === events.length) return;
    set({ events: seal(out.map((e) => ({ ...e }))) });
  },

  setBpmAt: (beat, bpm) => {
    const { events } = get();
    const next = clampClockBpm(bpm);
    if (!Number.isFinite(next)) return;
    const idx = indexInForce(events, beat);
    if (events[idx].bpm === next) return;
    const out = events.map((e) => ({ ...e }));
    out[idx].bpm = next;
    set({ events: seal(out) });
  },
}));

/**
 * Push the map into `beatClock` and keep pushing it. That is the whole wiring:
 * the clock is the only consumer that needs telling, because every surface
 * already asks the clock rather than holding a bpm of its own.
 *
 * Returns the unsubscribe. It is the caller's, so a second call makes a second
 * subscription — both would push the same array, and `setTempoMap` no-ops on an
 * identical one, but there is no reason to have two.
 */
export function subscribeTempoMap(): () => void {
  beatClock.setTempoMap(useTempoStore.getState().events);
  return useTempoStore.subscribe((s, prev) => {
    if (s.events !== prev.events) beatClock.setTempoMap(s.events);
  });
}
