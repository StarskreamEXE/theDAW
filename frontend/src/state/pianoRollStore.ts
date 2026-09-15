import { create } from 'zustand';
import { normalizeMeterMap, roundUpToBar, type MeterSegment, type PolyLane } from '../lib/meterMap';
import {
  DEFAULT_BEND_RANGE,
  MAX_BENT_LANES,
  bentLanes,
  capBentLanes,
  clampBendRange,
  sanitizeBendPoints,
  sanitizeBends,
  type BendPoint,
  type BendPointInput,
  type LaneBend,
} from '../lib/pitchBend';

export interface PianoNote {
  id: string;
  /** MIDI note number (0-127). 60 = middle C. */
  note: number;
  /** Step index where the note starts (16th notes from 0). */
  step: number;
  /** Length in steps. */
  length: number;
  velocity: number;
  /** Polymeter lane id (see `lanes`). Absent means lane 0, which spans the whole roll. */
  lane?: number;
}

/** The roll's meter: time signatures by bar, the pickup before bar 0, and the polymeter lanes. */
export interface RollMeter {
  meterMap: MeterSegment[];
  pickupSteps: number;
  lanes: PolyLane[];
}

interface PianoRollState {
  notes: PianoNote[];
  bpm: number;
  /** Total grid length in 16th-note steps. */
  totalSteps: number;
  /** Lowest and highest MIDI note numbers in view (inclusive). */
  lowestNote: number;
  highestNote: number;
  selectedNoteId: string | null;
  isPlaying: boolean;
  currentStep: number;
  /** If set, the roll is editing an existing editor clip — next "send to editor" updates that clip in place. */
  editingClipId: string | null;
  /** Step span of the most recent live recording, highlighted in the grid; null
   *  when no recording has been placed. */
  recordedRange: { startStep: number; endStep: number } | null;
  /** Time signatures by bar (lib/meterMap). Always starts at bar 0. */
  meterMap: MeterSegment[];
  /** Steps before bar 0 (a pickup); 0 when the roll starts on a downbeat. */
  pickupSteps: number;
  /** Polymeter lanes. Lane 0 always exists and never loops. */
  lanes: PolyLane[];
  /** The lane new notes go into. */
  activeLane: number;
  /**
   * Pitch bend by lane (lib/pitchBend): each lane's points and range, sorted by
   * lane. A lane with no points and the default range has no entry. A bend
   * moves with its lane and keeps its steps through meter and length changes,
   * as notes do. At most MAX_BENT_LANES lanes have points.
   */
  bends: LaneBend[];

  setBpm: (bpm: number) => void;
  setTotalSteps: (s: number) => void;
  setRange: (lo: number, hi: number) => void;
  addNote: (note: Omit<PianoNote, 'id'>) => string;
  removeNote: (id: string) => void;
  updateNote: (id: string, patch: Partial<PianoNote>) => void;
  setSelectedNote: (id: string | null) => void;
  setPlaying: (playing: boolean) => void;
  setCurrentStep: (s: number) => void;
  replaceAll: (notes: PianoNote[]) => void;
  clear: () => void;
  setEditingClip: (id: string | null) => void;
  /** Load an editor clip. A `meter` field left out keeps the roll's current value.
   *  `bends` replaces every lane's bend (a lane the roll ends without is dropped, and
   *  lanes past MAX_BENT_LANES lose their points); left out, every lane's points are
   *  cleared and its range stays, as CLEAR does, since the notes they bent are gone. */
  loadFromClip: (
    clipId: string,
    notes: PianoNote[],
    bpm: number,
    totalSteps: number,
    meter?: Partial<RollMeter>,
    bends?: readonly LaneBend[],
  ) => void;
  /** Replace the grid with imported notes, auto-fitting length (to a bar line) AND
   *  pitch range to the content. A `meter` field left out keeps the roll's current value.
   *  `bends` replaces every lane's bend (a lane the roll ends without is dropped, and
   *  lanes past MAX_BENT_LANES lose their points); left out, every lane's points are
   *  cleared and its range stays, as CLEAR does, since the notes they bent are gone. */
  importNotes: (notes: PianoNote[], bpm?: number, meter?: Partial<RollMeter>, bends?: readonly LaneBend[]) => void;
  /** Place a live recording WITHOUT shrinking the grid (keeps at least the 256
   *  default, rounded up to a bar), expanding the pitch range to fit, and marks the recorded span. */
  placeRecording: (notes: PianoNote[], range: { startStep: number; endStep: number }) => void;
  setMeterMap: (map: MeterSegment[]) => void;
  setPickupSteps: (steps: number) => void;
  setLanes: (lanes: PolyLane[]) => void;
  setActiveLane: (id: number) => void;
  /** Add a lane that loops every `cycleSteps` (null = the whole roll); returns its id. */
  addLane: (cycleSteps?: number | null) => number;
  /** Set a lane's loop length; lane 0 never loops. */
  setLaneCycle: (id: number, cycleSteps: number | null) => void;
  /** Remove a lane; its notes move to lane 0, and its bend too when lane 0 has no points. Lane 0 cannot be removed. */
  removeLane: (id: number) => void;
  /** Replace every lane's bend. A bend for a lane the roll does not have is dropped, and lanes past MAX_BENT_LANES lose their points. */
  setBends: (bends: readonly LaneBend[]) => void;
  /** Replace one lane's points (sorted, one per step, values clamped to -1..1). A lane without points takes none while MAX_BENT_LANES lanes bend. */
  setBendPoints: (lane: number, points: readonly BendPointInput[]) => void;
  /**
   * Add a point to a lane's curve, replacing a point at the same step. Returns the
   * new point's id, or null when the roll has no such lane, or when the lane has no
   * points while MAX_BENT_LANES lanes already bend (a MIDI file and the live synth
   * have no channel left for it).
   */
  addBendPoint: (lane: number, point: Omit<BendPointInput, 'id'>) => string | null;
  /** Move, re-value or re-shape a point. Landing on another point's step replaces that point. */
  moveBendPoint: (lane: number, id: string, patch: Partial<Omit<BendPoint, 'id'>>) => void;
  removeBendPoint: (lane: number, id: string) => void;
  /** Remove a lane's points, or every lane's when `lane` is left out. Ranges stay. */
  clearBend: (lane?: number) => void;
  /** Set a lane's bend range in semitones (0-48, to the cent). */
  setBendRange: (lane: number, semitones: number) => void;
  /** Write any of the meter map, pickup and lanes, then round the roll's length
   *  up to a bar line. `merge` false keeps a change that repeats the meter before
   *  it (the METER face's ADD). setMeterMap and setPickupSteps go through here.
   *  Lanes given take the bends of lanes that go with them, and a lane that
   *  arrives starts unbent (MATCH, and the METER face's ADD LANE). */
  applyMeter: (meter: Partial<RollMeter>, merge?: boolean) => void;
}

const DEFAULT_STEPS = 256;

const MIN_STEPS = 16;
const MAX_STEPS = 4096; // ~256 bars; enough for full-song MIDI imports
const FULL_LOW = 21; // A0 — the full 88-key piano stays in view so the roll scrolls
const FULL_HIGH = 108; // C8

export const DEFAULT_LANES: readonly PolyLane[] = Object.freeze([{ id: 0, name: 'A', cycleSteps: null }]);

/** A, B, … Z, then AA, AB … */
export const laneName = (index: number): string => {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
};

const clampCycle = (steps: number | null | undefined): number | null =>
  typeof steps === 'number' && Number.isFinite(steps) && steps >= 1 ? Math.min(MAX_STEPS, Math.round(steps)) : null;

/** Lane 0 first and never looping, unique ids, cycles clamped to whole steps. */
export const sanitizeLanes = (lanes: readonly PolyLane[] | null | undefined): PolyLane[] => {
  const seen = new Set<number>();
  const out: PolyLane[] = [];
  for (const l of lanes ?? []) {
    if (!l || !Number.isInteger(l.id) || l.id < 0 || seen.has(l.id)) continue;
    seen.add(l.id);
    out.push({ id: l.id, name: String(l.name || laneName(l.id)), cycleSteps: l.id === 0 ? null : clampCycle(l.cycleSteps) });
  }
  if (!seen.has(0)) out.unshift({ id: 0, name: 'A', cycleSteps: null });
  return out.sort((a, b) => a.id - b.id);
};

const clampPickup = (steps: number | undefined, fallback: number): number =>
  typeof steps === 'number' && Number.isFinite(steps) ? Math.max(0, Math.min(64, Math.round(steps * 2) / 2)) : fallback;

/** The meter fields a load or import ends with: each one given replaces the current one. */
const mergeMeter = (s: Pick<PianoRollState, 'meterMap' | 'pickupSteps' | 'lanes' | 'activeLane'>, meter?: Partial<RollMeter>) => {
  const lanes = meter?.lanes ? sanitizeLanes(meter.lanes) : s.lanes;
  return {
    meterMap: meter?.meterMap ? normalizeMeterMap(meter.meterMap) : s.meterMap,
    pickupSteps: clampPickup(meter?.pickupSteps, s.pickupSteps),
    lanes,
    activeLane: lanes.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
  };
};

const hasLane = (lanes: readonly PolyLane[], id: number): boolean => lanes.some((l) => l.id === id);

/** `bends` with only the lanes in `lanes`. */
const bendsForLanes = (bends: readonly LaneBend[], lanes: readonly PolyLane[]): LaneBend[] =>
  bends.filter((b) => hasLane(lanes, b.lane));

/** `bends` of the lanes in both `before` and `after`: a lane that goes takes its bend, and a lane that arrives starts unbent, whatever a lane with its id once had. */
const bendsAcrossLanes = (bends: readonly LaneBend[], before: readonly PolyLane[], after: readonly PolyLane[]): LaneBend[] =>
  bends.filter((b) => hasLane(before, b.lane) && hasLane(after, b.lane));

/** True when lane `lane` may take points: it bends already, or fewer than MAX_BENT_LANES lanes do. */
const mayBend = (s: Pick<PianoRollState, 'lanes' | 'bends'>, lane: number): boolean => {
  const bent = bentLanes(s.lanes, s.bends);
  return bent.has(lane) || bent.size < MAX_BENT_LANES;
};

/**
 * `bends` with lane `lane` rewritten by `edit`, which gets the lane's bend (an
 * empty one at the default range when it has none). Other lanes keep their
 * objects; an edit that leaves no points and the default range removes the entry.
 */
const withLaneBend = (bends: readonly LaneBend[], lane: number, edit: (b: LaneBend) => Partial<LaneBend>): LaneBend[] => {
  const current = bends.find((b) => b.lane === lane) ?? { lane, range: DEFAULT_BEND_RANGE, points: [] };
  const patch = edit(current);
  const next: LaneBend = {
    lane,
    range: clampBendRange(patch.range ?? current.range),
    points: patch.points ? sanitizeBendPoints(patch.points, `bp${lane}`) : current.points,
  };
  const others = bends.filter((b) => b.lane !== lane);
  const keep = next.points.length > 0 || next.range !== DEFAULT_BEND_RANGE;
  return (keep ? [...others, next] : others).sort((a, b) => a.lane - b.lane);
};

/** Every lane's points removed, ranges kept. */
const clearedBends = (bends: readonly LaneBend[]): LaneBend[] => sanitizeBends(bends.map((b) => ({ ...b, points: [] })));

/**
 * The bends a load or import that replaces the notes ends with: `incoming` for
 * the lanes the roll ends with (capped at MAX_BENT_LANES), or with none given,
 * the roll's own for the lanes it keeps with every point removed.
 */
const replacedBends = (
  s: Pick<PianoRollState, 'lanes' | 'bends'>,
  lanes: readonly PolyLane[],
  incoming: readonly LaneBend[] | undefined,
): LaneBend[] =>
  incoming ? capBentLanes(bendsForLanes(sanitizeBends(incoming), lanes), lanes) : clearedBends(bendsAcrossLanes(s.bends, s.lanes, lanes));

const uidBend = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `bp-${crypto.randomUUID()}` : `bp-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** Fit grid LENGTH (snapped up to a bar line of the meter map) to a note set, and
 *  keep the full piano range in view (expanded if content goes beyond it) so
 *  vertical scrolling always works and notes are never cropped. */
const fitToNotes = (
  notes: PianoNote[],
  meterMap: MeterSegment[],
  pickupSteps: number,
): { totalSteps: number; lowestNote: number; highestNote: number } => {
  const lastStep = notes.reduce((m, n) => Math.max(m, n.step + Math.max(1, n.length)), 0);
  const totalSteps = Math.min(MAX_STEPS, roundUpToBar(meterMap, Math.max(MIN_STEPS, lastStep), pickupSteps));
  const lo = Math.max(0, Math.min(FULL_LOW, notes.reduce((m, n) => Math.min(m, n.note), 127) - 2));
  const hi = Math.min(127, Math.max(FULL_HIGH, notes.reduce((m, n) => Math.max(m, n.note), 0) + 2));
  return { totalSteps, lowestNote: lo, highestNote: hi };
};

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `pn-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const seed = (): PianoNote[] => {
  // A short C-major arpeggio across two bars so the grid isn't empty on first load.
  const arr: PianoNote[] = [];
  const pitches = [60, 64, 67, 72, 67, 64, 60, 67]; // C E G C G E C G
  for (let i = 0; i < pitches.length; i += 1) {
    arr.push({ id: uid(), note: pitches[i], step: i * 2, length: 2, velocity: 90 });
  }
  return arr;
};

export const usePianoRollStore = create<PianoRollState>()((set, get) => ({
  notes: seed(),
  bpm: 120,
  totalSteps: DEFAULT_STEPS, // 16 bars at 16ths — a roomy default canvas
  lowestNote: FULL_LOW, // A0 — full piano in view, scrollable
  highestNote: FULL_HIGH, // C8
  selectedNoteId: null,
  isPlaying: false,
  currentStep: 0,
  editingClipId: null,
  recordedRange: null,
  meterMap: normalizeMeterMap(null),
  pickupSteps: 0,
  lanes: sanitizeLanes(DEFAULT_LANES),
  activeLane: 0,
  bends: [],

  setBpm: (bpm) => set({ bpm: Math.max(40, Math.min(240, bpm)) }),
  setTotalSteps: (totalSteps) =>
    set((s) => ({ totalSteps: Math.min(MAX_STEPS, roundUpToBar(s.meterMap, Math.max(MIN_STEPS, totalSteps), s.pickupSteps)) })),
  setRange: (lo, hi) => set({ lowestNote: Math.max(0, lo), highestNote: Math.min(127, hi) }),

  addNote: (note) => {
    const id = uid();
    set((s) => {
      const lane = note.lane ?? (s.activeLane !== 0 ? s.activeLane : undefined);
      const { lane: _drop, ...rest } = note;
      return { notes: [...s.notes, { ...rest, ...(lane !== undefined ? { lane } : {}), id }], selectedNoteId: id };
    });
    return id;
  },

  removeNote: (id) =>
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      selectedNoteId: s.selectedNoteId === id ? null : s.selectedNoteId,
    })),

  updateNote: (id, patch) =>
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })),

  setSelectedNote: (selectedNoteId) => set({ selectedNoteId }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentStep: (currentStep) => set({ currentStep }),
  replaceAll: (notes) => set({ notes, selectedNoteId: null }),
  clear: () =>
    set((s) => ({ notes: [], selectedNoteId: null, editingClipId: null, recordedRange: null, bends: clearedBends(s.bends) })),

  setEditingClip: (editingClipId) => set({ editingClipId }),
  loadFromClip: (clipId, incoming, bpm, totalSteps, meter, incomingBends) =>
    set((s) => {
      const notes = incoming.map((n) => ({ ...n }));
      const m = mergeMeter(s, meter);
      const fit = notes.length > 0 ? fitToNotes(notes, m.meterMap, m.pickupSteps) : null;
      return {
        notes,
        ...m,
        bends: replacedBends(s, m.lanes, incomingBends),
        bpm: Math.max(40, Math.min(240, bpm)),
        totalSteps: Math.min(
          MAX_STEPS,
          roundUpToBar(m.meterMap, Math.max(MIN_STEPS, totalSteps, fit?.totalSteps ?? MIN_STEPS), m.pickupSteps),
        ),
        ...(fit ? { lowestNote: fit.lowestNote, highestNote: fit.highestNote } : {}),
        editingClipId: clipId,
        selectedNoteId: null,
        isPlaying: false,
        currentStep: 0,
        recordedRange: null,
      };
    }),

  importNotes: (incoming, bpm, meter, incomingBends) =>
    set((s) => {
      const notes = incoming.map((n) => ({ ...n }));
      const m = mergeMeter(s, meter);
      const bends = replacedBends(s, m.lanes, incomingBends);
      if (notes.length === 0) {
        return { notes, ...m, bends, selectedNoteId: null, currentStep: 0, isPlaying: false, recordedRange: null };
      }
      return {
        notes,
        ...m,
        bends,
        ...fitToNotes(notes, m.meterMap, m.pickupSteps),
        selectedNoteId: null,
        currentStep: 0,
        isPlaying: false,
        recordedRange: null,
        ...(typeof bpm === 'number' && Number.isFinite(bpm)
          ? { bpm: Math.max(40, Math.min(240, Math.round(bpm))) }
          : {}),
      };
    }),

  placeRecording: (incoming, range) =>
    set((s) => {
      const notes = incoming.map((n) => ({ ...n }));
      // Keep at least the 256-step default — never shrink the grid for a short
      // take. Expand the pitch range to include the take (full keyboard stays).
      const lo = notes.length
        ? Math.max(0, Math.min(s.lowestNote, notes.reduce((m, n) => Math.min(m, n.note), 127) - 2))
        : s.lowestNote;
      const hi = notes.length
        ? Math.min(127, Math.max(s.highestNote, notes.reduce((m, n) => Math.max(m, n.note), 0) + 2))
        : s.highestNote;
      return {
        notes,
        totalSteps: Math.min(MAX_STEPS, roundUpToBar(s.meterMap, Math.max(DEFAULT_STEPS, s.totalSteps), s.pickupSteps)),
        lowestNote: lo,
        highestNote: hi,
        recordedRange: range,
        selectedNoteId: null,
        currentStep: 0,
        isPlaying: false,
      };
    }),

  setMeterMap: (map) => get().applyMeter({ meterMap: map }),
  setPickupSteps: (steps) => get().applyMeter({ pickupSteps: steps }),
  applyMeter: (meter, merge = true) =>
    set((s) => {
      const m = mergeMeter(s, meter);
      const meterMap = meter.meterMap ? normalizeMeterMap(meter.meterMap, merge) : m.meterMap;
      const bends = meter.lanes ? bendsAcrossLanes(s.bends, s.lanes, m.lanes) : s.bends;
      return {
        ...m,
        meterMap,
        // The same object when no lane took a bend with it, so a player sees no bend edit.
        bends: bends.length === s.bends.length ? s.bends : bends,
        totalSteps: Math.min(MAX_STEPS, roundUpToBar(meterMap, Math.max(MIN_STEPS, s.totalSteps), m.pickupSteps)),
      };
    }),
  setLanes: (lanes) =>
    set((s) => {
      const next = sanitizeLanes(lanes);
      return {
        lanes: next,
        activeLane: next.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
        bends: bendsForLanes(s.bends, next),
      };
    }),
  setActiveLane: (id) => set((s) => (s.lanes.some((l) => l.id === id) ? { activeLane: id } : {})),
  addLane: (cycleSteps = null) => {
    const { lanes, bends } = get();
    const id = lanes.reduce((m, l) => Math.max(m, l.id), 0) + 1;
    // A new lane starts unbent, whatever a lane with its id once had.
    set({
      lanes: sanitizeLanes([...lanes, { id, name: laneName(id), cycleSteps: clampCycle(cycleSteps) }]),
      bends: bends.filter((b) => b.lane !== id),
    });
    return id;
  },
  setLaneCycle: (id, cycleSteps) =>
    set((s) => ({ lanes: s.lanes.map((l) => (l.id === id && id !== 0 ? { ...l, cycleSteps: clampCycle(cycleSteps) } : l)) })),
  removeLane: (id) =>
    set((s) => {
      if (id === 0 || !s.lanes.some((l) => l.id === id)) return {};
      // The lane's notes move to lane 0, and its bend goes with them when lane 0 has no points of its own.
      const gone = s.bends.find((b) => b.lane === id);
      const zero = s.bends.find((b) => b.lane === 0);
      const rest = s.bends.filter((b) => b.lane !== id);
      const bends = gone?.points.length && !zero?.points.length
        ? withLaneBend(rest, 0, () => ({ range: gone.range, points: gone.points }))
        : rest;
      return {
        lanes: s.lanes.filter((l) => l.id !== id),
        notes: s.notes.map((n) => {
          if (n.lane !== id) return n;
          const { lane: _drop, ...rest } = n;
          return rest;
        }),
        activeLane: s.activeLane === id ? 0 : s.activeLane,
        bends,
      };
    }),

  setBends: (bends) => set((s) => ({ bends: capBentLanes(bendsForLanes(sanitizeBends(bends), s.lanes), s.lanes) })),
  setBendPoints: (lane, points) =>
    set((s) =>
      hasLane(s.lanes, lane) && (points.length === 0 || mayBend(s, lane))
        ? { bends: withLaneBend(s.bends, lane, () => ({ points: points.map((p) => ({ ...p })) as BendPoint[] })) }
        : {},
    ),
  addBendPoint: (lane, point) => {
    const s = get();
    if (!hasLane(s.lanes, lane) || !mayBend(s, lane)) return null;
    const id = uidBend();
    // Appended last, so it wins over a point already at its step.
    set((s) => ({ bends: withLaneBend(s.bends, lane, (b) => ({ points: [...b.points, { ...point, id } as BendPoint] })) }));
    return id;
  },
  moveBendPoint: (lane, id, patch) =>
    set((s) => {
      const bend = s.bends.find((b) => b.lane === lane);
      const p = bend?.points.find((x) => x.id === id);
      if (!bend || !p) return {};
      const moved: BendPoint = {
        id,
        step: typeof patch.step === 'number' && Number.isFinite(patch.step) ? patch.step : p.step,
        value: typeof patch.value === 'number' && Number.isFinite(patch.value) ? patch.value : p.value,
        shape: patch.shape ?? p.shape,
      };
      return { bends: withLaneBend(s.bends, lane, (b) => ({ points: [...b.points.filter((x) => x.id !== id), moved] })) };
    }),
  removeBendPoint: (lane, id) =>
    set((s) => {
      const bend = s.bends.find((b) => b.lane === lane);
      if (!bend?.points.some((x) => x.id === id)) return {};
      return { bends: withLaneBend(s.bends, lane, (b) => ({ points: b.points.filter((x) => x.id !== id) })) };
    }),
  clearBend: (lane) =>
    set((s) => ({
      bends: lane === undefined ? clearedBends(s.bends) : withLaneBend(s.bends, lane, () => ({ points: [] })),
    })),
  setBendRange: (lane, semitones) =>
    set((s) => (hasLane(s.lanes, lane) ? { bends: withLaneBend(s.bends, lane, () => ({ range: semitones })) } : {})),
}));

/** The roll's meter fields, for a bounce payload, a project save or an export. */
export const rollMeterOf = (s: Pick<PianoRollState, 'meterMap' | 'pickupSteps' | 'lanes'>): RollMeter => ({
  meterMap: s.meterMap.map((seg) => ({ bar: seg.bar, meter: { ...seg.meter, groups: [...seg.meter.groups] } })),
  pickupSteps: s.pickupSteps,
  lanes: s.lanes.map((l) => ({ ...l })),
});

/** Convert the store's note list into the shared MIDI util's note format. */
export const pianoNotesToMidiNotes = (
  notes: PianoNote[],
  ppq: number,
): Array<{ tick: number; note: number; velocity: number; durationTicks: number; channel: number }> => {
  // 16th note = ppq / 4 ticks
  const stepTicks = ppq / 4;
  return notes.map((n) => ({
    tick: Math.round(n.step * stepTicks),
    note: n.note,
    velocity: Math.max(1, Math.min(127, n.velocity)),
    durationTicks: Math.max(1, Math.round(n.length * stepTicks)),
    channel: 0,
  }));
};
