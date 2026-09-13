import { create } from 'zustand';
import { normalizeMeterMap, roundUpToBar, type MeterSegment, type PolyLane } from '../lib/meterMap';

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
  /** Load an editor clip. A `meter` field left out keeps the roll's current value. */
  loadFromClip: (clipId: string, notes: PianoNote[], bpm: number, totalSteps: number, meter?: Partial<RollMeter>) => void;
  /** Replace the grid with imported notes, auto-fitting length (to a bar line) AND
   *  pitch range to the content. A `meter` field left out keeps the roll's current value. */
  importNotes: (notes: PianoNote[], bpm?: number, meter?: Partial<RollMeter>) => void;
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
  /** Remove a lane; its notes move to lane 0. Lane 0 cannot be removed. */
  removeLane: (id: number) => void;
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

  setBpm: (bpm) => set({ bpm: Math.max(40, Math.min(240, bpm)) }),
  setTotalSteps: (totalSteps) => set({ totalSteps: Math.max(MIN_STEPS, Math.min(MAX_STEPS, totalSteps)) }),
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
  clear: () => set({ notes: [], selectedNoteId: null, editingClipId: null, recordedRange: null }),

  setEditingClip: (editingClipId) => set({ editingClipId }),
  loadFromClip: (clipId, incoming, bpm, totalSteps, meter) =>
    set((s) => {
      const notes = incoming.map((n) => ({ ...n }));
      const m = mergeMeter(s, meter);
      const fit = notes.length > 0 ? fitToNotes(notes, m.meterMap, m.pickupSteps) : null;
      return {
        notes,
        ...m,
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

  importNotes: (incoming, bpm, meter) =>
    set((s) => {
      const notes = incoming.map((n) => ({ ...n }));
      const m = mergeMeter(s, meter);
      if (notes.length === 0) {
        return { notes, ...m, selectedNoteId: null, currentStep: 0, isPlaying: false, recordedRange: null };
      }
      return {
        notes,
        ...m,
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

  setMeterMap: (map) => set({ meterMap: normalizeMeterMap(map) }),
  setPickupSteps: (steps) => set((s) => ({ pickupSteps: clampPickup(steps, s.pickupSteps) })),
  setLanes: (lanes) =>
    set((s) => {
      const next = sanitizeLanes(lanes);
      return { lanes: next, activeLane: next.some((l) => l.id === s.activeLane) ? s.activeLane : 0 };
    }),
  setActiveLane: (id) => set((s) => (s.lanes.some((l) => l.id === id) ? { activeLane: id } : {})),
  addLane: (cycleSteps = null) => {
    const { lanes } = get();
    const id = lanes.reduce((m, l) => Math.max(m, l.id), 0) + 1;
    set({ lanes: sanitizeLanes([...lanes, { id, name: laneName(id), cycleSteps: clampCycle(cycleSteps) }]) });
    return id;
  },
  setLaneCycle: (id, cycleSteps) =>
    set((s) => ({ lanes: s.lanes.map((l) => (l.id === id && id !== 0 ? { ...l, cycleSteps: clampCycle(cycleSteps) } : l)) })),
  removeLane: (id) =>
    set((s) => {
      if (id === 0 || !s.lanes.some((l) => l.id === id)) return {};
      return {
        lanes: s.lanes.filter((l) => l.id !== id),
        notes: s.notes.map((n) => {
          if (n.lane !== id) return n;
          const { lane: _drop, ...rest } = n;
          return rest;
        }),
        activeLane: s.activeLane === id ? 0 : s.activeLane,
      };
    }),
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
