import { create } from 'zustand';
import { logError, logInfo } from './logStore';
import type { PianoNote } from './pianoRollStore';
import type { MeterSegment, PolyLane } from '../lib/meterMap';
import type { LaneBend } from '../lib/pitchBend';
import { clampClipFades, type FadeCurve } from '../lib/clipFade';
import { crossfadeRegions } from '../lib/crossfade';
import { MIN_CLIP_SEC } from '../lib/clipDragMath';
import type { WarpMarker } from '../lib/audioWarp';
import type { ChainEntry, VstNode } from './effectChainStore';
import { rackEffectDefaults } from '../lib/rackEffects';
import {
  holdsAfterRelease, modeAfterStop, recordsWhileHeld, sampleCurve, upsertAutomationPoint,
  writeSpan, writesUntouched, type AutomationMode,
} from '../lib/automationModes';
import {
  MASTER_ID,
  addBus as graphAddBus,
  addSend as graphAddSend,
  emptyGraph,
  ensureTrackNode,
  removeNode as graphRemoveNode,
  removeSend as graphRemoveSend,
  setOutput as graphSetOutput,
  setSendGain as graphSetSendGain,
  type RoutingGraph,
  type RoutingRefusal,
} from './routingGraph';

export type { AutomationMode } from '../lib/automationModes';

export type ToolMode = 'move' | 'cut' | 'split';

/** Grid divisions for snapping. Straight notes, plus triplet (T) and dotted (D)
 *  variants. The four original values ('off' | '1/4' | '1/8' | '1/16') are all
 *  still members, so projects and prefs saved before the grid was widened keep
 *  resolving to the same step. */
export type SnapDivision =
  | 'off'
  | '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32'
  | '1/4T' | '1/8T' | '1/16T'
  | '1/4D' | '1/8D' | '1/16D';

/** Grid step for each division, in beats (a beat = one 1/4 note). Triplets are
 *  2/3 of the straight value, dotted are 3/2. '1/1' assumes 4/4 — the editor has
 *  no time-signature model yet, so a "bar" is four beats. */
const SNAP_BEATS: Record<Exclude<SnapDivision, 'off'>, number> = {
  '1/1': 4,
  '1/2': 2,
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
  '1/32': 0.125,
  '1/4T': 2 / 3,
  '1/8T': 1 / 3,
  '1/16T': 1 / 6,
  '1/4D': 1.5,
  '1/8D': 0.75,
  '1/16D': 0.375,
};

/** Ordered for the toolbar picker: straight, then triplets, then dotted. */
export const SNAP_DIVISIONS: SnapDivision[] = [
  'off',
  '1/1', '1/2', '1/4', '1/8', '1/16', '1/32',
  '1/4T', '1/8T', '1/16T',
  '1/4D', '1/8D', '1/16D',
];

/** The grid step in seconds, or null when snapping is off (or the stored value
 *  is not a division we know — e.g. a hand-edited project file). */
export const snapStepSec = (snap: SnapDivision, bpm: number): number | null => {
  if (snap === 'off') return null;
  const beats = SNAP_BEATS[snap];
  if (!beats) return null;
  return (60 / bpm) * beats;
};

export type ClipSourceKind = 'audio' | 'piano-roll';

export interface InpaintSelection {
  clipId: string;
  startSec: number; // timeline seconds
  endSec: number;   // timeline seconds
}

export interface AudioClip {
  id: string;
  trackId: string;
  label: string;
  /** Source audio Blob (the bytes we play / decode peaks from). */
  audioBlob: Blob;
  mimeType: string;
  /** Total length of the source audio in seconds. */
  sourceDuration: number;
  /** Seconds into the source where this clip starts. */
  offsetIntoSource: number;
  /** Length of this clip on the timeline. */
  durationSec: number;
  /** Position on the timeline (start time in seconds). */
  startSec: number;
  color: string;
  /** Cached peaks for waveform rendering; lazy-populated. */
  peaks?: Float32Array;
  /** Optional reference back to a Library entry id, if dropped from the library. */
  libraryEntryId?: string;
  /** How this clip was produced — informs "Edit in Piano Roll" availability. */
  sourceKind?: ClipSourceKind;
  /** When sourceKind === 'piano-roll', the note list that produced the audio, as it
   *  sounds: looping lanes written out, no lane ids. Playback and drawing read it. */
  sourcePianoRoll?: PianoNote[];
  /** When sourceKind === 'piano-roll', the roll's own notes with their lanes, which
   *  "Edit in Piano Roll" loads. Absent on clips bounced before lanes existed. */
  sourceRollNotes?: PianoNote[];
  /** When sourceKind === 'piano-roll', the BPM at render time. */
  sourceBpm?: number;
  /** When sourceKind === 'piano-roll', the grid length at render time. */
  sourceTotalSteps?: number;
  /** When sourceKind === 'piano-roll', the roll's time signatures by bar at render time. */
  sourceMeterMap?: MeterSegment[];
  /** When sourceKind === 'piano-roll', the steps before bar 0 at render time. */
  sourcePickupSteps?: number;
  /** When sourceKind === 'piano-roll', the roll's polymeter lanes at render time.
   *  `sourcePianoRoll` holds the notes already unrolled across those lanes. */
  sourceLanes?: PolyLane[];
  /** When sourceKind === 'piano-roll', each lane's pitch bend at render time (lib/pitchBend).
   *  Absent on clips bounced before the roll had pitch bend, or with none. */
  sourceBends?: LaneBend[];
  /** GM program (0-127) this MIDI clip plays through live on the timeline; falls
   *  back to the track default, then the global active instrument. Audio clips: undefined. */
  instrumentProgram?: number;
  /** The GM program `audioBlob` was actually rendered with. The live scheduler
   *  synthesises MIDI clips from `sourcePianoRoll` and honours instrumentProgram,
   *  but every offline bounce reads the pre-rendered blob — so the two diverge the
   *  moment an instrument is reassigned after insert. Recording what the blob
   *  contains lets the editor re-render it on change and keep export == preview. */
  renderedProgram?: number;
  /** Fade-in duration in seconds (0 = no fade). */
  fadeInSec?: number;
  /** Fade-out duration in seconds (0 = no fade). */
  fadeOutSec?: number;
  /** Shape of the fade-in; undefined = 'linear', which is what every clip
   *  faded before curves existed. Evaluated by lib/clipFade. */
  fadeInCurve?: FadeCurve;
  /** Shape of the fade-out; undefined = 'linear'. */
  fadeOutCurve?: FadeCurve;
  /** Linear clip gain (1 = unity, undefined = unity). Multiplies the fade
   *  envelope's peak, so it sits BEFORE the track fader and the per-track FX —
   *  gain-staging a loud clip changes what the track's compressor sees, exactly
   *  as clip gain does in a conventional DAW. Applied identically in live
   *  playback (liveMixer.scheduleClips) and in every offline bounce. */
  gain?: number;
  /** Muted: the clip is skipped by playback and every offline bounce. This is
   *  the ONE clip property liveMixer gates live mid-playback; all other clip
   *  edits are structural and take effect on the next play. */
  muted?: boolean;
  /** Time-stretch factor; 1 (or undefined) is the original speed and >1 makes
   *  the clip shorter. Independent of `warpMarkers`, which bend time within
   *  the clip rather than scaling all of it. */
  timeStretchRate?: number;
  /** How `timeStretchRate` is realised: 'repitch' rides the source's playback
   *  rate (pitch follows, like a tape machine), 'offline' renders a
   *  pitch-preserving stretch. Undefined = 'repitch'. */
  stretchMode?: 'repitch' | 'offline';
  /** Warp anchors tying moments of the source to moments of the clip, in
   *  clip-relative seconds. Read through lib/audioWarp. */
  warpMarkers?: WarpMarker[];
}

export interface EditorTrack {
  id: string;
  name: string;
  /** If true, the name was auto-generated and should be replaced by the first clip's label when one lands. */
  nameAutoGenerated: boolean;
  volume: number; // 0..1
  pan: number;    // -1..1
  mute: boolean;
  solo: boolean;
  color: string;
  /** Record-armed: target for mic/vocal recording. Shown as a red dot in the
   *  track header. */
  armed?: boolean;
  /** Default GM program (0-127) for MIDI clips on this track; undefined = global default. */
  instrumentProgram?: number;
  /** Per-track insert FX chain (real-time psychoacoustic rack), spliced between
   *  the track fader and its panner during live playback and offline bounce. */
  fxChain?: ChainEntry[];
  /** Present while the track is FROZEN: its clips + insert chain are rendered to a
   *  single printed stem (so backend-hosted VST3 — which can't run live in the
   *  browser — becomes audible). The originals are stashed here for unfreeze; the
   *  live fxChain is emptied because every effect is baked into the stem. */
  frozenOriginal?: { clips: AudioClip[]; fxChain: ChainEntry[] };
}

/**
 * A mix bus: a summing point with its own insert rack, fader and mute, between
 * whatever routes into it and whatever it routes out to.
 *
 * The bus's PLACE in the signal flow is not here — it is an edge in `routing`,
 * exactly like a track's. This slice is only the bus's own mixer strip, so the
 * two stay separable: deleting the strip (`removeBus`) and rewiring around it
 * (`removeNode`) are one action, but "what feeds this" is never duplicated.
 *
 * `fxChain` is required (not `ChainEntry[] | undefined` like `EditorTrack`'s):
 * a bus exists only because the user created it, so there is no pre-rack
 * document shape to stay compatible with.
 */
export interface EditorBus {
  id: string;
  name: string;
  fxChain: ChainEntry[];
  volume: number; // 0..1
  mute: boolean;
}

/* ── Automation (Phase E) ─────────────────────────────────────────────────────
   A lane records a parameter's value over timeline time as breakpoints. Playback
   schedules them ahead of the playhead: native AudioParam envelope for vol/pan
   (sample-accurate), a lookahead writer for FX params. */
export type AutomationTargetKind = 'trackVolume' | 'trackPan' | 'trackFx' | 'masterFx';

export interface AutomationTarget {
  kind: AutomationTargetKind;
  /** Set for trackVolume / trackPan / trackFx. */
  trackId?: string;
  /** ChainEntry id, set for trackFx / masterFx. */
  entryId?: string;
  /** Effect param key, set for trackFx / masterFx. */
  paramKey?: string;
}

/** One breakpoint: timeline seconds -> value (in the param's natural units).
 *  Structurally identical to `automationModes.CurvePoint`, which is what the pure
 *  model works in; the two are assignable both ways. */
export interface AutomationPoint {
  t: number;
  v: number;
  /** Shape of the segment that STARTS at this point, in [-1, 1]. Absent (the
   *  only form every lane written before curves existed has) = 0 = linear.
   *  Positive reaches the next value early, negative late. Evaluated by
   *  lib/automationModes `curveShape`. */
  curve?: number;
}

/** One target held (or held-after-release) during a record pass. Transient pass
 *  state: deliberately OUTSIDE the undo snapshot and the autosave manifest — a
 *  half-finished fader ride is not part of the document. */
export interface AutomationHold {
  target: AutomationTarget;
  /** The value being written forward. */
  value: number;
  /** Timeline time the hold has written up to; the next write spans from here. */
  lastT: number;
  /** True once the control was let go and the mode kept the target (latch/write). */
  released: boolean;
}

export interface AutomationLane {
  id: string;
  target: AutomationTarget;
  points: AutomationPoint[]; // kept sorted ascending by t
  enabled: boolean;
}

/** A named position flag on the timeline (Phase F). */
export interface TimelineMarker {
  id: string;
  t: number;     // timeline seconds
  label: string;
}

/** Clip gain as a safe multiplier — unity for undefined, NaN, or negative values.
 *  Every scheduling path (live + the three offline bounces) reads clip gain through
 *  this, so a malformed value can never silence or invert a clip. */
export const clipPeakGain = (clip: Pick<AudioClip, 'gain'>): number => {
  const g = clip.gain;
  return typeof g === 'number' && Number.isFinite(g) && g >= 0 ? g : 1;
};

/** The rate a clip's source rides at during playback. An 'offline' stretch is
 *  already baked into the blob, so it plays at unity; anything that is not a
 *  usable positive rate falls back to unity rather than silencing the clip.
 *  `liveMixer.computeClipSchedule` holds the scheduling twin of this rule. */
export const clipStretchRate = (clip: Pick<AudioClip, 'timeStretchRate' | 'stretchMode'>): number => {
  if (clip.stretchMode === 'offline') return 1;
  const rate = clip.timeStretchRate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1;
};

/** How many seconds of source a clip covers. At rate `r` one timeline second
 *  eats `r` source seconds, so this is what a stretch has to preserve: the clip
 *  plays the same audio, just over a different length of timeline. */
export const clipSourceSpanSec = (clip: Pick<AudioClip, 'durationSec' | 'timeStretchRate' | 'stretchMode'>): number =>
  clip.durationSec * clipStretchRate(clip);

/**
 * Signature of everything that reaches the rendered master, so a frozen render
 * can be flagged stale after an edit (and an unchanged document re-uses it).
 *
 * The rule is simple and the file it is read from must keep to it: if a
 * renderer reads the field, it belongs here. The curves, the stretch ratio and
 * the warp markers were all invisible to this signature until the renderers
 * learned to play them, which meant editing a fade shape left a frozen master
 * claiming to be current. `peaks` is the counter-example — derived drawing data
 * no renderer ever reads.
 */
export const freezeSignature = (doc: {
  clips: readonly AudioClip[];
  tracks: readonly EditorTrack[];
  masterFxChain: readonly ChainEntry[];
  masterVstChain: readonly ChainEntry[];
  bpm: number;
}): string => {
  // A clip's muted flag is part of the shape because the bounce drops muted
  // clips, so toggling mute changes the rendered master.
  const clipPart = doc.clips
    .map((c) => [
      c.id, c.trackId, c.startSec, c.durationSec, c.offsetIntoSource,
      c.fadeInSec ?? 0, c.fadeOutSec ?? 0, c.fadeInCurve ?? 'linear', c.fadeOutCurve ?? 'linear',
      clipPeakGain(c), c.muted ? 1 : 0,
      c.timeStretchRate ?? 1, c.stretchMode ?? 'repitch',
      JSON.stringify(c.warpMarkers ?? []),
      c.audioBlob.size,
    ].join(':'))
    .join('|');
  const trackPart = doc.tracks
    .map((t) => `${t.id}:${t.volume}:${t.pan}:${t.mute}:${t.solo}:${JSON.stringify(t.fxChain ?? [])}`)
    .join('|');
  return [
    clipPart, trackPart,
    JSON.stringify(doc.masterFxChain), JSON.stringify(doc.masterVstChain), doc.bpm,
  ].join('::');
};

/** Stable identity for a target, so a control resolves to its one lane. */
export const automationTargetKey = (target: AutomationTarget): string =>
  `${target.kind}|${target.trackId ?? ''}|${target.entryId ?? ''}|${target.paramKey ?? ''}`;

/** Lane value at time `t`; null when the lane has no points. Holds the first/last
 *  value outside the breakpoint range, and shapes each interior segment by its
 *  left point's `curve` — which for a lane with no curves is the identical linear
 *  ramp this has always returned (`curveShape(u, 0) === u`). */
export const sampleLane = (lane: AutomationLane, t: number): number | null => sampleCurve(lane.points, t);

/** Minimum spacing between recorded breakpoints (thins ~50 Hz gestures). */
const MIN_POINT_DT = 0.02;

/** Insert (or replace a near neighbor's value) keeping `points` sorted + thinned.
 *  The rule itself lives in lib/automationModes so the held-target span write and
 *  the point actions here cannot drift apart. */
const upsertPoint = (points: AutomationPoint[], t: number, v: number, curve?: number): AutomationPoint[] =>
  upsertAutomationPoint(points, t, v, MIN_POINT_DT, curve);

/**
 * Where the pre-punch anchor goes: as close to `t - MIN_POINT_DT` as the upsert's
 * merge rule allows, so the punch-in anchor at `t` cannot swallow it.
 *
 * `t - MIN_POINT_DT` is NOT good enough on its own. The subtraction rounds, and
 * for ~96% of timeline positions (t = 5 among them) it rounds UP, leaving an exact
 * gap a hair BELOW MIN_POINT_DT — and the merge rule is a strict `<`, so the
 * punch-in write would replace the pre-anchor instead of sitting next to it.
 * Stepping down by one ulp (one iteration in practice; the loop is belt and
 * braces) makes the gap provably >= MIN_POINT_DT. The shift is ~1e-16 s.
 */
const prePunchTime = (t: number): number => {
  let preT = t - MIN_POINT_DT;
  for (let i = 0; i < 4 && t - preT < MIN_POINT_DT; i += 1) {
    preT -= Math.max(Number.MIN_VALUE, Math.abs(preT) * Number.EPSILON);
  }
  return preT;
};

/** Apply one hold's forward write to the lane it owns. A hold always has a lane
 *  (it was created by a gesture that made one, or seeded from an existing one),
 *  so a missing lane simply means there is nothing to write into. */
const writeHoldSpan = (
  lanes: AutomationLane[],
  key: string,
  fromT: number,
  toT: number,
  v: number,
): AutomationLane[] => {
  let hit = false;
  const next = lanes.map((l) => {
    if (automationTargetKey(l.target) !== key) return l;
    hit = true;
    return { ...l, points: writeSpan(l.points, fromT, toT, v, MIN_POINT_DT) };
  });
  return hit ? next : lanes;
};

/** The value a parameter is actually sitting at, for a lane that has no points to
 *  sample. Null when the target no longer resolves (a deleted track or FX entry). */
const storedValueForTarget = (
  s: Pick<EditorStoreState, 'tracks' | 'masterFxChain'>,
  target: AutomationTarget,
): number | null => {
  const { kind, trackId, entryId, paramKey } = target;
  if (kind === 'trackVolume' || kind === 'trackPan') {
    const track = s.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    return kind === 'trackVolume' ? track.volume : track.pan;
  }
  if (!entryId || !paramKey) return null;
  const chain = kind === 'masterFx'
    ? s.masterFxChain
    : s.tracks.find((t) => t.id === trackId)?.fxChain;
  const v = chain?.find((e) => e.id === entryId)?.params?.[paramKey];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

interface EditorStoreState {
  tracks: EditorTrack[];
  clips: AudioClip[];
  selectedClipId: string | null;
  tool: ToolMode;
  zoom: number;             // pixels per second
  /** Vertical zoom: the on-screen height of every track lane, in px. Uniform
   *  across tracks (per-track heights would need the timeline's `index * height`
   *  layout maths replaced with a cumulative offset table). View state, so it is
   *  deliberately outside undo history. */
  trackHeight: number;
  scrollSec: number;        // horizontal scroll position in seconds
  playheadSec: number;
  isPlaying: boolean;
  snap: SnapDivision;
  bpm: number;              // for snap math
  inpaintSelection: InpaintSelection | null;
  /** Master-bus insert FX chain (real-time psychoacoustic rack). Session-local —
   *  liveMixer routes the editor mix through it before the shared engine master. */
  masterFxChain: ChainEntry[];
  /**
   * Signal routing: which node each track/bus feeds, and every send. Document
   * state — in `docSnapshot`, in undo, in the autosave manifest — because it is
   * part of what a project IS, not how it is being viewed.
   *
   * The store keeps it consistent with `tracks` itself, so no caller has to:
   * every track-creating path (`loadProject`, `addTrack`, and the initial
   * document) calls `ensureTrackNode`, and `removeTrack` calls `removeNode`.
   * A track with no node would be a track the mixer cannot place.
   */
  routing: RoutingGraph;
  /** Mix-bus strips. Their PLACE in the flow is in `routing`; see `EditorBus`. */
  buses: EditorBus[];
  /** Automation lanes (Phase E): one per automated parameter. */
  automationLanes: AutomationLane[];
  /** How a control move is recorded: read / touch / latch / write. See
   *  lib/automationModes for what each one promises. */
  automationMode: AutomationMode;
  /** Targets currently held (or held-after-release) by the running record pass,
   *  keyed by `automationTargetKey`. Transient: NOT in the undo snapshot and NOT
   *  in the autosave manifest. */
  automationHolds: Record<string, AutomationHold>;
  /** Master-bus VST3 chain (hosted via pedalboard). NOT a Web-Audio rack — these
   *  apply when the master is rendered ("frozen"); see frozenMaster + previewMode. */
  masterVstChain: ChainEntry[];
  /** 'live' = play the realtime multitrack mix; 'frozen' = play the rendered
   *  VST-processed master. Toggled from the Master VST panel. */
  previewMode: 'live' | 'frozen';
  /** The latest VST-rendered master plus the project signature it was rendered
   *  from, so the UI can flag it stale after edits. Never persisted. */
  frozenMaster: { blob: Blob; sig: string } | null;

  // Mutations
  /** Replace the whole timeline with a loaded project (atomic; one fresh
   *  document — undo history is reset). Used when opening a .tasmo. */
  loadProject: (payload: {
    tracks: EditorTrack[];
    clips: AudioClip[];
    bpm?: number;
    /** The project's saved graph, if it has one. A project WITHOUT one — every
     *  document written before routing existed — is migrated: `emptyGraph()`
     *  plus a node per track. A project WITH one keeps it, reconciled against
     *  this payload: a node is added for any track/bus it lacks, and any node
     *  belonging to neither is pruned (see `migrateRouting`). */
    routing?: RoutingGraph;
    buses?: EditorBus[];
  }) => void;
  addTrack: (overrides?: Partial<EditorTrack>) => string;
  removeTrack: (id: string) => void;
  updateTrack: (id: string, updates: Partial<EditorTrack>) => void;
  toggleSolo: (id: string) => void;
  /** Freeze a track: replace its clips with one printed stem and empty its
   *  fxChain (effects + VST baked in), stashing the originals for unfreeze. */
  freezeTrack: (
    trackId: string,
    stem: { audioBlob: Blob; durationSec: number; peaks?: Float32Array },
  ) => void;
  /** Restore a frozen track's original clips + insert chain. */
  unfreezeTrack: (trackId: string) => void;

  addClipToTrack: (clip: Omit<AudioClip, 'id'> & { id?: string }) => string;
  updateClip: (id: string, updates: Partial<AudioClip>) => void;
  removeClip: (id: string) => void;
  splitClipAt: (id: string, atSec: number) => string | null;
  /** Shape one end of a clip's fade. */
  setClipFadeCurve: (id: string, edge: 'in' | 'out', curve: FadeCurve) => void;
  /** Cross-fade two clips that overlap on ONE track: the earlier one fades out
   *  across the overlap, the later one fades in across it, both equal power, as
   *  a single undo step. Returns false and writes nothing when the pair is not
   *  a crossfade (missing, same clip, different tracks, or no overlap). */
  createCrossfade: (clipAId: string, clipBId: string) => boolean;
  /** Make the clip last `newDurationSec` without re-rendering its audio: the
   *  source it covers is unchanged and a playback ratio carries the difference.
   *  `newStartSec` moves the head too, which is what stretching from the LEFT
   *  edge does. */
  /** Re-fit the source a clip covers into `newDurationSec` of timeline by
   *  storing a ratio — the audio is never re-rendered. Pass
   *  `{ coalesce: true }` from a continuous gesture so the whole drag stays one
   *  undo step; any other caller gets a step of its own. */
  stretchClipToFit: (id: string, newDurationSec: number, newStartSec?: number, opts?: { coalesce?: boolean }) => void;
  /** Back to the original speed, and to the length that speed implies. */
  resetClipStretch: (id: string) => void;
  /** Store peaks decoded from a clip's audio. Peaks are derived data, so the
   *  write goes through applyClipRender and stays out of undo history. */
  cachePeaks: (id: string, peaks: Float32Array) => void;
  /** Store audio derived from a clip's own document data, such as a MIDI clip's
   *  bounce through its instrument, together with its peaks. The write adds no
   *  undo step and keeps the redo stack: undo can restore a clip from before its
   *  bounce or peaks landed, and the write that replaces them must leave redo
   *  intact. */
  applyClipRender: (id: string, updates: Partial<AudioClip>, peaks?: Float32Array) => void;

  setSelected: (id: string | null) => void;
  setTool: (t: ToolMode) => void;
  setZoom: (z: number) => void;
  setTrackHeight: (h: number) => void;
  setScrollSec: (s: number) => void;
  setPlayhead: (s: number) => void;
  setPlaying: (p: boolean) => void;
  setSnap: (s: SnapDivision) => void;
  setBpm: (b: number) => void;
  setInpaintSelection: (sel: InpaintSelection | null) => void;
  clearInpaintSelection: () => void;

  /* ── Routing + buses ───────────────────────────────────────────────────────
     The STRUCTURAL ones (`addBus`, `removeBus`, `setTrackOutput`, `addSend`,
     `removeSend`) each record ONE undo step: they call `beginUndoStep()` first,
     so two of them inside the 300 ms coalescing window are still two steps. The
     VALUE ones do not — `updateBus` never, `setSendGain` unless the caller says
     it is not coalescing — because a fader or knob ride must be one step, not
     one per pointer move. The two that can be REFUSED return the model's `RoutingRefusal`
     for the UI to toast, and `null` when applied; the graph is untouched on a
     refusal, down to the object identity. The others cannot be refused by the
     model — `removeNode` / `setSendGain` / `removeSend` return a graph, not a
     `RoutingResult` — so they return `void` rather than a `null` that could
     never be anything else. */

  /** Create a mix bus (strip + graph node, feeding the master). Returns its id. */
  addBus: (name?: string) => string;
  /** Delete a bus. Anything whose output pointed at it is re-homed to the
   *  master by `removeNode`, so deleting a bus never silences what fed it. */
  removeBus: (id: string) => void;
  /** Rename / refader / mute a bus strip. Records NO undo step of its own, like
   *  `updateTrack`: a fader ride is a continuous gesture, and the 300 ms
   *  coalescer is what makes the whole ride one step. An unknown id is a no-op
   *  — it must not conjure a graph node for a strip that does not exist. */
  updateBus: (id: string, updates: Partial<Omit<EditorBus, 'id'>>) => void;
  /** Point a node's main output at another node. Named for its caller (a track
   *  in the routing picker), but the model treats a bus's output identically,
   *  so a bus id works as `fromId` too. */
  setTrackOutput: (fromId: string, toId: string) => RoutingRefusal | null;
  /** Add a post-pan send with its own gain. One send per (from, to) pair. */
  addSend: (fromId: string, toId: string, gain?: number) => RoutingRefusal | null;
  /** Move an existing send's gain. A send that does not exist is a no-op.
   *  Pass `{ coalesce: true }` from a continuous KNOB DRAG so the whole gesture
   *  stays one undo step (the pointer-down already cut the burst); a discrete
   *  edit — a typed value, a reset — omits it and gets a step of its own. */
  setSendGain: (fromId: string, toId: string, gain: number, opts?: { coalesce?: boolean }) => void;
  /** Drop a send. A send that does not exist is a no-op. */
  removeSend: (fromId: string, toId: string) => void;

  // Bus FX racks (mirror the per-track ones)
  addBusEffect: (busId: string, effectId: string) => void;
  removeBusEffect: (busId: string, entryId: string) => void;
  toggleBusEffect: (busId: string, entryId: string) => void;
  updateBusEffectParams: (busId: string, entryId: string, params: Record<string, number>) => void;

  // Master FX rack
  addMasterEffect: (effectId: string) => void;
  removeMasterEffect: (entryId: string) => void;
  reorderMasterEffect: (from: number, to: number) => void;
  toggleMasterEffect: (entryId: string) => void;
  updateMasterEffectParams: (entryId: string, params: Record<string, number>) => void;

  // Per-track FX rack
  addTrackEffect: (trackId: string, effectId: string) => void;
  /** Append a VST3 plugin to a track's insert chain. VST3 can't run in the live
   *  Web Audio graph (buildEffectChain only knows the rack effects), so the entry
   *  is inert during preview and is applied on the backend by renderTrackStem
   *  when the track is frozen — the same contract as the master VST chain. */
  addTrackVst: (trackId: string, plugin: VstNode) => void;
  removeTrackEffect: (trackId: string, entryId: string) => void;
  reorderTrackEffect: (trackId: string, from: number, to: number) => void;
  toggleTrackEffect: (trackId: string, entryId: string) => void;
  updateTrackEffectParams: (trackId: string, entryId: string, params: Record<string, number>) => void;
  /** Store a VST entry's captured native-editor state on a track chain node,
   *  so the dialed-in sound is applied at freeze/render time. */
  setTrackVstRawState: (trackId: string, entryId: string, rawState: string) => void;
  /** Replace an existing chain entry's effect with a live rack effect (reset to
   *  its defaults, enabled), keeping the entry's id + slot. Used to "rebuild" an
   *  imported device that came in inert so a controller mapping has a live home. */
  rebuildTrackEffect: (trackId: string, entryId: string, effectId: string) => void;

  // Automation (Phase E)
  setAutomationMode: (mode: AutomationMode) => void;
  /** Begin a gesture on `target`: create the lane if it has none, write the first
   *  point, and hold the target. No-op in `read`. Starts a fresh undo step, so
   *  the whole gesture that follows folds into one. */
  beginAutomationTouch: (target: AutomationTarget, t: number, v: number) => void;
  /** Continue a gesture: write `v` forward across everything between the hold's
   *  last write and `t`. Inert with no hold behind it. */
  moveAutomationTouch: (target: AutomationTarget, t: number, v: number) => void;
  /** Let the control go. `touch` writes the last span and punches out; `latch`
   *  and `write` keep the target, holding its released value. */
  endAutomationTouch: (target: AutomationTarget, t: number) => void;
  /** One frame of the record pass: every hold writes its value forward to `t`.
   *  With no holds this returns the state untouched (same object, no subscriber
   *  wakes), because it runs on the transport's frame timer. */
  advanceAutomationHolds: (t: number) => void;
  /** Play start. In `write` — and only there — every enabled lane is armed as a
   *  released hold at the value it has at `t`, which is what makes a write pass
   *  overwrite everything it rolls over. */
  beginAutomationPass: (t: number) => void;
  /** Transport stop: drop every hold and apply the mode's stop rule (`write`
   *  demotes to `latch`). */
  endAutomationPass: () => void;
  /** Shape the segment that starts at `index`, in [-1, 1]; 0 clears it.
   *  Pass `{ coalesce: true }` from a continuous DRAG so the whole gesture stays
   *  one undo step; any other caller gets a step of its own (see
   *  `stretchClipToFit`, which carries the same rule). */
  setAutomationPointCurve: (laneId: string, index: number, curve: number, opts?: { coalesce?: boolean }) => void;
  recordAutomationPoint: (target: AutomationTarget, t: number, v: number) => void;
  addAutomationPoint: (laneId: string, t: number, v: number) => void;
  updateAutomationPoint: (laneId: string, index: number, t: number, v: number) => void;
  removeAutomationPoint: (laneId: string, index: number) => void;
  toggleAutomationLane: (laneId: string) => void;
  clearAutomationLane: (laneId: string) => void;
  removeAutomationLane: (laneId: string) => void;
  getLaneForTarget: (target: AutomationTarget) => AutomationLane | undefined;

  // Loop region + markers (Phase F). The loop region, when enabled and valid,
  // makes the transport cycle within [loopStart, loopEnd] instead of the whole
  // timeline. Markers are named position flags.
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  markers: TimelineMarker[];
  setLoopEnabled: (on: boolean) => void;
  setLoopRegion: (start: number, end: number) => void;
  clearLoop: () => void;
  addMarker: (t: number, label?: string) => void;
  removeMarker: (id: string) => void;
  renameMarker: (id: string, label: string) => void;
  moveMarker: (id: string, t: number) => void;

  // Undo / redo (Phase D). Snapshots capture the document slices below; because
  // every mutation replaces arrays immutably, a snapshot just references the prior
  // arrays (no cloning, audio blobs/peaks stay shared). Rapid bursts (a drag, a
  // WRITE-record pass) coalesce into one step. _undo/_redo are exposed so the UI
  // can reflect availability.
  _undo: EditorHistorySnapshot[];
  _redo: EditorHistorySnapshot[];
  undo: () => void;
  redo: () => void;

  /** True when the document has changed since the last save (or since a load).
   *  Drives the unsaved-changes guard and the modified indicator. Set by the same
   *  subscription that records undo history, so it tracks exactly the slices that
   *  constitute "the project". */
  dirty: boolean;
  /** Clear the dirty flag — call after a successful save. */
  markSaved: () => void;

  // Selectors
  addMasterVst: (plugin: VstNode) => void;
  /** Store a VST entry's captured native-editor state on a master VST chain
   *  node (staleness is caught by the freeze signature, which covers raw_state). */
  setMasterVstRawState: (entryId: string, rawState: string) => void;
  removeMasterVst: (entryId: string) => void;
  reorderMasterVst: (from: number, to: number) => void;
  clearMasterVst: () => void;
  setPreviewMode: (mode: 'live' | 'frozen') => void;
  setFrozenMaster: (frozen: { blob: Blob; sig: string } | null) => void;

  getTotalDurationSec: () => number;
  snapSec: (s: number) => number;
}

/** The document slices tracked by undo / redo.
 *  `markers` and `bpm` are document state (they are part of what a project IS),
 *  so they belong here. The loop region deliberately does NOT — it is transport
 *  state, and DAWs that put it in the undo stack make undo unusable during a
 *  loop-edit session. */
interface EditorHistorySnapshot {
  tracks: EditorTrack[];
  clips: AudioClip[];
  masterFxChain: ChainEntry[];
  /** The master VST rack is document state like the master FX rack: a track's
   *  VST inserts already ride along inside `tracks`, so leaving the master's
   *  out made master-rack edits the one kind of rack edit undo could not
   *  reach. */
  masterVstChain: ChainEntry[];
  automationLanes: AutomationLane[];
  markers: TimelineMarker[];
  bpm: number;
  /** Routing is document state: undoing a "route drums into the drum bus" must
   *  take the edge back, and it must take the bus strip back with it — hence
   *  both slices, restored together. */
  routing: RoutingGraph;
  buses: EditorBus[];
}

/**
 * The graph a loaded document should hold: whatever it saved (when it saved
 * one), reconciled against the document it is being loaded WITH.
 *
 * This is the whole migration, and it is two-sided:
 *
 *  - ADD. Every project on disk today predates routing and so arrives with
 *    `existing` undefined — it gets `emptyGraph()` plus one node per track,
 *    which is exactly the hard-coded "every track to the master" the mixer did
 *    before there was a graph to describe it. A project that DOES carry a graph
 *    keeps it, including its buses and sends; the `ensureTrackNode` sweep only
 *    adds what is missing (a hand-edited file, or an importer that appended a
 *    track after the graph was built), because a track with no node is a track
 *    `wireRouting` cannot place.
 *  - PRUNE. A node whose strip is in NEITHER `tracks` nor `buses` is dropped.
 *    Without this a graph outlives the document it describes: loading project B
 *    over project A leaves A's track nodes behind, `validateGraph` reports them,
 *    `topoOrder` still orders them, and the stalest of them can even swallow a
 *    send aimed at a live node with the same id. `removeNode` is what does the
 *    dropping, so anything whose output pointed at a pruned node is re-homed to
 *    the master rather than orphaned.
 */
const migrateRouting = (
  tracks: EditorTrack[],
  existing?: RoutingGraph,
  buses: readonly EditorBus[] = [],
): RoutingGraph => {
  const sane = existing && Array.isArray(existing.nodes) && Array.isArray(existing.edges);
  let g: RoutingGraph = sane
    ? { nodes: (existing as RoutingGraph).nodes.slice(), edges: (existing as RoutingGraph).edges.slice() }
    : emptyGraph();
  // A saved graph with no master node cannot be ordered (every output edge
  // would dangle), so put one back rather than trusting the file.
  if (!g.nodes.some((n) => n.id === MASTER_ID)) {
    g = { nodes: [...emptyGraph().nodes, ...g.nodes], edges: g.edges };
  }
  const live = new Set<string>([MASTER_ID]);
  for (const t of tracks) live.add(t.id);
  for (const b of buses) live.add(b.id);
  for (const id of g.nodes.map((n) => n.id)) {
    if (!live.has(id)) g = graphRemoveNode(g, id);
  }
  for (const t of tracks) g = ensureTrackNode(g, t.id, t.name);
  for (const b of buses) g = graphAddBus(g, b.id, b.name);
  return g;
};

const DEFAULT_COLORS = ['#8b5cf6', '#a855f7', '#ec4899', '#06b6d4', '#10b981', '#facc15', '#f97316', '#ef4444'];

/** Track-lane height bounds, in px. The default matches the height the timeline
 *  was hardcoded to before vertical zoom existed, so an untouched session looks
 *  exactly as it did. */
export const TRACK_HEIGHT_MIN = 56;
export const TRACK_HEIGHT_MAX = 260;
export const TRACK_HEIGHT_DEFAULT = 104;

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;

// ── Undo / redo plumbing (module-scoped) ─────────────────────────────────────
const HISTORY_LIMIT = 100;
const HISTORY_COALESCE_MS = 300; // changes closer than this fold into one undo step
let historyApplying = false;     // true while undo/redo writes, so it doesn't self-record
let lastDocChangeAt = -Infinity;

/**
 * Cut the coalescing burst: the NEXT document change records an undo step of
 * its own instead of folding into whatever happened in the last 300 ms.
 *
 * A gesture is one undo step because the recorder coalesces — but that same
 * rule would swallow a gesture that starts right after another edit, so the
 * pointer-down that begins a gesture calls this first. (undo/redo already reset
 * the clock for the same reason.)
 */
export const beginUndoStep = (): void => {
  lastDocChangeAt = -Infinity;
};

const docSnapshot = (s: EditorStoreState): EditorHistorySnapshot => ({
  tracks: s.tracks,
  clips: s.clips,
  masterFxChain: s.masterFxChain,
  masterVstChain: s.masterVstChain,
  automationLanes: s.automationLanes,
  markers: s.markers,
  bpm: s.bpm,
  routing: s.routing,
  buses: s.buses,
});

/** The track the store ships with, before any project is loaded. */
const INITIAL_TRACK: EditorTrack = {
  id: 'track-1',
  name: 'Track 1',
  nameAutoGenerated: true,
  volume: 0.8,
  pan: 0,
  mute: false,
  solo: false,
  color: DEFAULT_COLORS[0],
};

export const useEditorStore = create<EditorStoreState>()((set, get) => ({
  tracks: [INITIAL_TRACK],
  // The first document is routed from the first frame: liveMixer places nodes
  // by walking this graph, so a track missing from it is a silent track.
  routing: migrateRouting([INITIAL_TRACK]),
  buses: [],
  clips: [],
  selectedClipId: null,
  tool: 'move',
  zoom: 30,        // px per second
  trackHeight: TRACK_HEIGHT_DEFAULT,
  scrollSec: 0,
  playheadSec: 0,
  isPlaying: false,
  snap: '1/16',
  bpm: 120,
  inpaintSelection: null,
  masterFxChain: [],
  masterVstChain: [],
  previewMode: 'live',
  frozenMaster: null,
  automationLanes: [],
  automationMode: 'read',
  automationHolds: {},
  loopEnabled: false,
  loopStart: 0,
  loopEnd: 0,
  markers: [],
  _undo: [],
  _redo: [],
  dirty: false,

  loadProject: ({ tracks, clips, bpm, routing, buses }) => {
    const fallbackTrack: EditorTrack = INITIAL_TRACK;
    // Suppress undo recording for the bulk swap, then start the loaded project as
    // a fresh document (empty undo/redo) so the user can't undo back into the
    // previous session's tracks.
    //
    // Markers, automation lanes and the loop region are cleared with the tracks:
    // they are per-project document state, and automation lanes in particular key
    // off trackId/entryId, so carrying them across a load left lanes pointing at
    // tracks that no longer exist. This also makes "New Project" (Shell.tsx, which
    // calls loadProject with empty tracks/clips) actually empty.
    //
    // Routing is the one per-project extra that is NOT cleared: clearing it
    // would leave every loaded track unplaceable. It is migrated instead —
    // `migrateRouting` builds the "everything to the master" graph for a project
    // that has none (which is every project written before this existed) and
    // completes one that does.
    const loadedTracks = tracks.length ? tracks : [fallbackTrack];
    historyApplying = true;
    set({
      tracks: loadedTracks,
      routing: migrateRouting(loadedTracks, routing, buses ?? []),
      buses: buses ?? [],
      clips,
      selectedClipId: null,
      playheadSec: 0,
      scrollSec: 0,
      isPlaying: false,
      bpm: bpm && Number.isFinite(bpm) ? Math.max(40, Math.min(240, bpm)) : get().bpm,
      markers: [],
      automationLanes: [],
      // A record pass cannot survive the document it was writing into.
      automationHolds: {},
      loopEnabled: false,
      loopStart: 0,
      loopEnd: 0,
      _undo: [],
      _redo: [],
      // A freshly loaded project is by definition unmodified.
      dirty: false,
    });
    historyApplying = false;
    lastDocChangeAt = -Infinity;
    logInfo('editor', `Loaded project: ${tracks.length} track(s), ${clips.length} clip(s)`);
  },

  addTrack: (overrides) => {
    const id = `track-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    set((s) => {
      const track: EditorTrack = {
        id,
        name: `Track ${s.tracks.length + 1}`,
        nameAutoGenerated: true,
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        color: DEFAULT_COLORS[s.tracks.length % DEFAULT_COLORS.length],
        ...overrides,
      };
      return {
        tracks: [...s.tracks, track],
        // A new track is routed to the master from the moment it exists, so it
        // is audible without the routing picker ever being opened.
        routing: ensureTrackNode(s.routing, id, track.name),
      };
    });
    logInfo('editor', `Added track: ${id}`);
    return id;
  },

  removeTrack: (id) => {
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      clips: s.clips.filter((c) => c.trackId !== id),
      automationLanes: s.automationLanes.filter((l) => l.target.trackId !== id),
      // Drops the node AND every edge that touched it — including sends INTO a
      // deleted track, which would otherwise be a dangling edge `topoOrder`
      // cannot resolve.
      routing: graphRemoveNode(s.routing, id),
      selectedClipId: s.clips.some((c) => c.id === s.selectedClipId && c.trackId === id) ? null : s.selectedClipId,
    }));
    logInfo('editor', `Removed track: ${id}`);
  },

  updateTrack: (id, updates) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  freezeTrack: (trackId, stem) => {
    set((s) => {
      const track = s.tracks.find((t) => t.id === trackId);
      if (!track) return {};
      const original = s.clips.filter((c) => c.trackId === trackId);
      const others = s.clips.filter((c) => c.trackId !== trackId);
      const stemClip: AudioClip = {
        id: uid(),
        trackId,
        label: `${track.name} (frozen)`,
        audioBlob: stem.audioBlob,
        mimeType: stem.audioBlob.type || 'audio/wav',
        sourceDuration: stem.durationSec,
        offsetIntoSource: 0,
        durationSec: stem.durationSec,
        startSec: 0,
        color: track.color,
        peaks: stem.peaks,
      };
      return {
        clips: [...others, stemClip],
        tracks: s.tracks.map((t) =>
          t.id === trackId
            ? { ...t, fxChain: [], frozenOriginal: { clips: original, fxChain: t.fxChain ?? [] } }
            : t,
        ),
        selectedClipId: null,
      };
    });
    logInfo('editor', `Froze track ${trackId}: printed FX into a stem`);
  },

  unfreezeTrack: (trackId) => {
    set((s) => {
      const track = s.tracks.find((t) => t.id === trackId);
      if (!track || !track.frozenOriginal) return {};
      const fo = track.frozenOriginal;
      const others = s.clips.filter((c) => c.trackId !== trackId);
      return {
        clips: [...others, ...fo.clips],
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, fxChain: fo.fxChain, frozenOriginal: undefined } : t,
        ),
        selectedClipId: null,
      };
    });
    logInfo('editor', `Unfroze track ${trackId}: restored clips + FX`);
  },

  toggleSolo: (id) => {
    const target = get().tracks.find((t) => t.id === id);
    if (!target) return;
    const willSolo = !target.solo;
    set((s) => ({
      tracks: s.tracks.map((t) => ({
        ...t,
        solo: t.id === id ? willSolo : (willSolo ? false : t.solo),
      })),
    }));
  },

  addClipToTrack: (clip) => {
    const id = clip.id ?? uid();
    const full: AudioClip = { ...clip, id };
    set((s) => {
      // If the track's name is still auto-generated and this is its first clip, inherit the clip label.
      const tracks = s.tracks.map((t) => {
        if (t.id !== full.trackId) return t;
        const hasExistingClips = s.clips.some((c) => c.trackId === t.id);
        if (!hasExistingClips && t.nameAutoGenerated && full.label) {
          return { ...t, name: full.label, nameAutoGenerated: false };
        }
        return t;
      });
      return {
        tracks,
        clips: [...s.clips, full],
        selectedClipId: id,
      };
    });
    logInfo('editor', `Added clip "${full.label}" to ${full.trackId} at ${full.startSec.toFixed(2)}s`);
    return id;
  },

  updateClip: (id, updates) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),

  removeClip: (id) => {
    const clip = get().clips.find((c) => c.id === id);
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
    }));
    if (clip) logInfo('editor', `Removed clip: ${clip.label}`);
  },

  splitClipAt: (id, atSec) => {
    const state = get();
    const clip = state.clips.find((c) => c.id === id);
    if (!clip) return null;
    const relSplit = atSec - clip.startSec;
    // Don't split too close to either edge.
    if (relSplit <= 0.05 || relSplit >= clip.durationSec - 0.05) {
      logError('editor', 'Cut point too close to clip edge');
      return null;
    }
    const newId = uid();
    const rightDur = clip.durationSec - relSplit;
    // The seam is a TIMELINE point, but `offsetIntoSource` counts SOURCE
    // seconds — and a stretched clip covers `rate` seconds of source per second
    // of timeline. Adding `relSplit` raw put the right half's read head short of
    // where the left half stopped, so a rate-2 split replayed half the seam.
    const relSplitInSource = relSplit * clipStretchRate(clip);
    // Each fade belongs to one end of the original clip, so it follows that
    // end: the fade-in stays with the left half and the fade-out moves to the
    // right half. Spreading `...clip` onto both used to give the left half a
    // fade-out it never had (and the right half a fade-in), so a split inside a
    // faded clip dipped to silence at the seam. What SURVIVES is then fitted by
    // clampClipFades — the one rule that governs fades everywhere, so a fade is
    // cut only when it no longer fits in the half it landed on. (It used to be
    // capped at half the half, which matched a fade-handle limit that is gone.)
    // fadeInSec / fadeOutSec are optional on AudioClip, and the clamp reads an
    // absent fade as 0.
    const left: AudioClip = {
      ...clip,
      durationSec: relSplit,
      ...clampClipFades({ durationSec: relSplit, fadeInSec: clip.fadeInSec, fadeOutSec: 0 }),
    };
    const right: AudioClip = {
      ...clip,
      id: newId,
      startSec: clip.startSec + relSplit,
      offsetIntoSource: clip.offsetIntoSource + relSplitInSource,
      durationSec: rightDur,
      label: `${clip.label}_b`,
      ...clampClipFades({ durationSec: rightDur, fadeInSec: 0, fadeOutSec: clip.fadeOutSec }),
    };
    set((s) => ({
      clips: s.clips.flatMap((c) => (c.id === id ? [left, right] : [c])),
      selectedClipId: newId,
    }));
    logInfo('editor', `Split clip at ${atSec.toFixed(2)}s → ${left.label} | ${right.label}`);
    return newId;
  },

  setClipFadeCurve: (id, edge, curve) => {
    // A menu action is one edit and must be undoable on its own, however close
    // it lands to the last one — the 300 ms coalescer exists for CONTINUOUS
    // gestures, and would otherwise fold two quick curve choices into one step.
    beginUndoStep();
    set((s) => ({
      clips: s.clips.map((c) => (
        c.id === id ? { ...c, ...(edge === 'in' ? { fadeInCurve: curve } : { fadeOutCurve: curve }) } : c
      )),
    }));
  },

  createCrossfade: (clipAId, clipBId) => {
    beginUndoStep(); // a menu action is its own undo step (see setClipFadeCurve)
    const { clips } = get();
    const a = clips.find((c) => c.id === clipAId);
    const b = clips.find((c) => c.id === clipBId);
    if (!a || !b || a.id === b.id || a.trackId !== b.trackId) return false;
    // A crossfade IS the overlap — nothing is stored beyond the two fades, so
    // moving either clip afterwards just changes where they cross. The region
    // also says WHICH clip fades out: the one that starts earlier.
    const [region] = crossfadeRegions([a, b]);
    if (!region || !(region.durationSec > 0)) return false;
    const out = region.outId === a.id ? a : b;
    const into = region.inId === a.id ? a : b;
    // Each clip's pair of fades is fitted by the same clamp as everywhere else,
    // so a clip already faded in over most of its length gives the crossfade
    // only the room that is left instead of overrunning its own head.
    const outFades = clampClipFades({
      durationSec: out.durationSec, fadeInSec: out.fadeInSec, fadeOutSec: region.durationSec,
    });
    const inFades = clampClipFades({
      durationSec: into.durationSec, fadeInSec: region.durationSec, fadeOutSec: into.fadeOutSec,
    });
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id === out.id) return { ...c, ...outFades, fadeOutCurve: 'equal-power' as FadeCurve };
        if (c.id === into.id) return { ...c, ...inFades, fadeInCurve: 'equal-power' as FadeCurve };
        return c;
      }),
    }));
    logInfo('editor', `Crossfade ${region.durationSec.toFixed(2)}s: ${out.label} → ${into.label}`);
    return true;
  },

  stretchClipToFit: (id, newDurationSec, newStartSec, opts) => {
    // Same rule as the other actions, with the exception the gesture needs: a
    // stretch DRAG calls this on every pointer move, and beginning a step each
    // time would leave an undo entry per animation frame. The drag says
    // `coalesce` (its pointer-down already cut the burst once, for the whole
    // gesture); every other caller gets its own step.
    if (!opts?.coalesce) beginUndoStep();
    const clip = get().clips.find((c) => c.id === id);
    if (!clip) return;
    if (!Number.isFinite(newDurationSec) || newDurationSec < MIN_CLIP_SEC) return;
    // Measured against the SOURCE the clip covers, not its current length, so
    // dragging an already-stretched edge re-fits the same audio instead of
    // compounding ratios.
    const span = clipSourceSpanSec(clip);
    if (!(span > 0)) return;
    const startSec = newStartSec !== undefined && Number.isFinite(newStartSec) ? Math.max(0, newStartSec) : clip.startSec;
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? {
        ...c,
        startSec,
        // durationSec moves WITH the ratio: every renderer sizes its
        // OfflineAudioContext from startSec + durationSec, so a stretch that
        // left the old length behind would be cut off (or trail silence).
        durationSec: newDurationSec,
        timeStretchRate: span / newDurationSec,
        // The gesture is the live, non-destructive path. The offline path is
        // the Time/Pitch popover, which bakes the stretch into a new blob and
        // leaves no ratio behind — so a clip that came through it carries its
        // baked audio as the source this ratio now rides.
        stretchMode: 'repitch' as const,
      } : c)),
    }));
  },

  resetClipStretch: (id) => {
    beginUndoStep(); // a menu action is its own undo step (see setClipFadeCurve)
    const clip = get().clips.find((c) => c.id === id);
    if (!clip) return;
    const span = clipSourceSpanSec(clip);
    if (!(span > 0)) return;
    // Clearing the ratio without restoring the length would leave the clip
    // playing a DIFFERENT stretch of source at the original speed.
    const available = clip.sourceDuration > 0
      ? Math.max(MIN_CLIP_SEC, clip.sourceDuration - clip.offsetIntoSource)
      : Infinity;
    const durationSec = Math.min(Math.max(MIN_CLIP_SEC, span), available);
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? {
        ...c, durationSec, timeStretchRate: undefined, stretchMode: undefined,
      } : c)),
    }));
  },

  cachePeaks: (id, peaks) => get().applyClipRender(id, {}, peaks),

  applyClipRender: (id, updates, peaks) => {
    if (!get().clips.some((c) => c.id === id)) return;
    historyApplying = true;
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...updates, ...(peaks ? { peaks } : {}) } : c)),
      // The saved project carries the clip's audio, so new audio still makes the
      // document dirty, as it did when this went through updateClip.
      dirty: true,
    }));
    historyApplying = false;
  },

  setSelected: (id) => set({ selectedClipId: id }),
  setTool: (t) => set({ tool: t }),
  setZoom: (z) => set({ zoom: Math.max(5, Math.min(400, z)) }),
  setTrackHeight: (h) => set({ trackHeight: Math.max(TRACK_HEIGHT_MIN, Math.min(TRACK_HEIGHT_MAX, Math.round(h))) }),
  setScrollSec: (s) => set({ scrollSec: Math.max(0, s) }),
  setPlayhead: (s) => set({ playheadSec: Math.max(0, s) }),
  setPlaying: (p) => set({ isPlaying: p }),
  setSnap: (s) => set({ snap: s }),
  setBpm: (b) => set({ bpm: Math.max(40, Math.min(240, b)) }),
  setInpaintSelection: (sel) => set({ inpaintSelection: sel }),
  clearInpaintSelection: () => set({ inpaintSelection: null }),

  // ── Routing + buses ────────────────────────────────────────────────────────

  addBus: (name) => {
    const id = `bus-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    beginUndoStep();
    set((s) => {
      const bus: EditorBus = {
        id,
        name: name && name.trim() ? name.trim() : `Bus ${s.buses.length + 1}`,
        fxChain: [],
        volume: 0.8,
        mute: false,
      };
      return { buses: [...s.buses, bus], routing: graphAddBus(s.routing, id, bus.name) };
    });
    logInfo('editor', `Added bus: ${id}`);
    return id;
  },

  removeBus: (id) => {
    beginUndoStep();
    set((s) => ({
      buses: s.buses.filter((b) => b.id !== id),
      routing: graphRemoveNode(s.routing, id),
      // `AutomationTarget.trackId` is the node id, and track ids and bus ids
      // share one namespace (both are uid strings, and `routing` keys nodes by
      // exactly this value) — so a lane pointed at a deleted BUS is matched by
      // the same filter `removeTrack` uses. If the two namespaces ever split,
      // this filter and `removeTrack`'s must split with them.
      automationLanes: s.automationLanes.filter((l) => l.target.trackId !== id),
    }));
    logInfo('editor', `Removed bus: ${id}`);
  },

  updateBus: (id, updates) =>
    // No `beginUndoStep()`: this is the bus's `updateTrack`, and a fader ride
    // that opened a step per pointer move would make undo unusable.
    set((s) => {
      // Guarded on the strip existing. `graphAddBus` is `ensureNode`, which
      // CREATES the node when it is absent — so an unknown id would otherwise
      // conjure a bus node with no strip behind it, which `wireRouting` would
      // then skip forever and `validateGraph` would report as damage.
      if (!s.buses.some((b) => b.id === id)) return {};
      const buses = s.buses.map((b) => (b.id === id ? { ...b, ...updates, id: b.id } : b));
      // A rename has to reach the graph too — the node's `name` is what a
      // routing picker lists, and a stale one would name a bus that is gone.
      const routing = updates.name ? graphAddBus(s.routing, id, updates.name) : s.routing;
      return { buses, routing };
    }),

  setTrackOutput: (fromId, toId) => {
    beginUndoStep();
    const res = graphSetOutput(get().routing, fromId, toId);
    if (!res.ok) return res.reason;
    set({ routing: res.graph });
    return null;
  },

  addSend: (fromId, toId, gain) => {
    beginUndoStep();
    const res = graphAddSend(get().routing, fromId, toId, gain ?? 0);
    if (!res.ok) return res.reason;
    set({ routing: res.graph });
    return null;
  },

  setSendGain: (fromId, toId, gain, opts) => {
    // Same rule as `stretchClipToFit` / `setAutomationPointCurve`: a drag says
    // `coalesce` and folds into the step its pointer-down opened; anything else
    // cuts a step of its own.
    if (!opts?.coalesce) beginUndoStep();
    set((s) => ({ routing: graphSetSendGain(s.routing, fromId, toId, gain) }));
  },

  removeSend: (fromId, toId) => {
    beginUndoStep();
    set((s) => ({ routing: graphRemoveSend(s.routing, fromId, toId) }));
  },

  // Bus FX racks — the per-track actions with `buses` in place of `tracks`.
  addBusEffect: (busId, effectId) =>
    set((s) => ({
      buses: s.buses.map((b) =>
        b.id === busId
          ? { ...b, fxChain: [...b.fxChain, { id: uid(), effect: effectId, params: rackEffectDefaults(effectId), enabled: true }] }
          : b,
      ),
    })),

  removeBusEffect: (busId, entryId) =>
    set((s) => ({
      buses: s.buses.map((b) => (b.id === busId ? { ...b, fxChain: b.fxChain.filter((e) => e.id !== entryId) } : b)),
      automationLanes: s.automationLanes.filter((l) => l.target.entryId !== entryId),
    })),

  toggleBusEffect: (busId, entryId) =>
    set((s) => ({
      buses: s.buses.map((b) =>
        b.id === busId
          ? { ...b, fxChain: b.fxChain.map((e) => (e.id === entryId ? { ...e, enabled: !e.enabled } : e)) }
          : b,
      ),
    })),

  updateBusEffectParams: (busId, entryId, params) =>
    set((s) => ({
      buses: s.buses.map((b) =>
        b.id === busId
          ? { ...b, fxChain: b.fxChain.map((e) => (e.id === entryId ? { ...e, params } : e)) }
          : b,
      ),
    })),

  addMasterEffect: (effectId) =>
    set((s) => ({
      masterFxChain: [
        ...s.masterFxChain,
        { id: uid(), effect: effectId, params: rackEffectDefaults(effectId), enabled: true },
      ],
    })),

  removeMasterEffect: (entryId) =>
    set((s) => ({
      masterFxChain: s.masterFxChain.filter((e) => e.id !== entryId),
      automationLanes: s.automationLanes.filter((l) => l.target.entryId !== entryId),
    })),

  reorderMasterEffect: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.masterFxChain.length || to >= s.masterFxChain.length) {
        return {};
      }
      const next = [...s.masterFxChain];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return { masterFxChain: next };
    }),

  toggleMasterEffect: (entryId) =>
    set((s) => ({
      masterFxChain: s.masterFxChain.map((e) => (e.id === entryId ? { ...e, enabled: !e.enabled } : e)),
    })),

  updateMasterEffectParams: (entryId, params) =>
    set((s) => ({
      masterFxChain: s.masterFxChain.map((e) => (e.id === entryId ? { ...e, params } : e)),
    })),

  // --- Master VST3 chain (rendered/frozen, not live Web-Audio) ---
  addMasterVst: (plugin) =>
    set((s) => ({
      masterVstChain: [
        ...s.masterVstChain,
        { id: uid(), effect: 'vst3', params: {}, enabled: true, vst: plugin },
      ],
      frozenMaster: null,
    })),

  setMasterVstRawState: (entryId, rawState) =>
    set((s) => ({
      masterVstChain: s.masterVstChain.map((e) =>
        e.id === entryId && e.vst ? { ...e, vst: { ...e.vst, raw_state: rawState } } : e,
      ),
    })),

  removeMasterVst: (entryId) =>
    set((s) => ({
      masterVstChain: s.masterVstChain.filter((e) => e.id !== entryId),
      frozenMaster: null,
    })),

  reorderMasterVst: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.masterVstChain.length || to >= s.masterVstChain.length) {
        return {};
      }
      const next = [...s.masterVstChain];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return { masterVstChain: next, frozenMaster: null };
    }),

  clearMasterVst: () => set({ masterVstChain: [], frozenMaster: null, previewMode: 'live' }),

  setPreviewMode: (mode) => set({ previewMode: mode }),

  setFrozenMaster: (frozen) => set({ frozenMaster: frozen }),

  addTrackEffect: (trackId, effectId) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId
          ? { ...t, fxChain: [...(t.fxChain ?? []), { id: uid(), effect: effectId, params: rackEffectDefaults(effectId), enabled: true }] }
          : t,
      ),
    })),

  addTrackVst: (trackId, plugin) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId
          ? { ...t, fxChain: [...(t.fxChain ?? []), { id: uid(), effect: 'vst3', params: {}, enabled: true, vst: plugin }] }
          : t,
      ),
    })),

  removeTrackEffect: (trackId, entryId) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId ? { ...t, fxChain: (t.fxChain ?? []).filter((e) => e.id !== entryId) } : t,
      ),
      automationLanes: s.automationLanes.filter((l) => l.target.entryId !== entryId),
    })),

  reorderTrackEffect: (trackId, from, to) =>
    set((s) => ({
      tracks: s.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const chain = t.fxChain ?? [];
        if (from === to || from < 0 || to < 0 || from >= chain.length || to >= chain.length) return t;
        const next = [...chain];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        return { ...t, fxChain: next };
      }),
    })),

  toggleTrackEffect: (trackId, entryId) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId
          ? { ...t, fxChain: (t.fxChain ?? []).map((e) => (e.id === entryId ? { ...e, enabled: !e.enabled } : e)) }
          : t,
      ),
    })),

  updateTrackEffectParams: (trackId, entryId, params) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId
          ? { ...t, fxChain: (t.fxChain ?? []).map((e) => (e.id === entryId ? { ...e, params } : e)) }
          : t,
      ),
    })),

  setTrackVstRawState: (trackId, entryId, rawState) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId
          ? {
              ...t,
              fxChain: (t.fxChain ?? []).map((e) =>
                e.id === entryId && e.vst ? { ...e, vst: { ...e.vst, raw_state: rawState } } : e,
              ),
            }
          : t,
      ),
    })),

  rebuildTrackEffect: (trackId, entryId, effectId) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId
          ? {
              ...t,
              // Keep the entry's id + original label (so the source device name
              // still shows), but make it a live rack effect at its defaults.
              fxChain: (t.fxChain ?? []).map((e) =>
                e.id === entryId
                  ? { ...e, effect: effectId, params: rackEffectDefaults(effectId), enabled: true, vst: undefined }
                  : e,
              ),
            }
          : t,
      ),
    })),

  setAutomationMode: (mode) =>
    // Switching to a mode that does not record ALSO ends the pass. Neither
    // moveAutomationTouch nor advanceAutomationHolds re-checks the mode (they
    // are driven by the pointer and the frame timer and must stay cheap), so a
    // hold left behind by a mid-pass switch to 'read' would go on overwriting
    // the lane until the transport stopped — the exact opposite of hands off.
    set({
      automationMode: mode,
      ...(recordsWhileHeld(mode) ? {} : { automationHolds: {} }),
    }),

  beginAutomationTouch: (target, t, v) => {
    if (!recordsWhileHeld(get().automationMode)) return;
    // The gesture is ONE undo step: this cuts the 300 ms coalescing burst, and
    // every frame that follows folds into the step this first write opens.
    beginUndoStep();
    set((s) => {
      const key = automationTargetKey(target);
      const existing = s.automationLanes.find((l) => automationTargetKey(l.target) === key);
      const automationLanes = existing
        ? s.automationLanes.map((l) => (l.id === existing.id ? { ...l, points: upsertPoint(l.points, t, v) } : l))
        : [...s.automationLanes, { id: uid(), target, points: [{ t, v }], enabled: true }];
      return {
        automationLanes,
        automationHolds: { ...s.automationHolds, [key]: { target, value: v, lastT: t, released: false } },
      };
    });
  },

  moveAutomationTouch: (target, t, v) =>
    set((s) => {
      const key = automationTargetKey(target);
      const hold = s.automationHolds[key];
      if (!hold) return {};
      return {
        automationLanes: writeHoldSpan(s.automationLanes, key, hold.lastT, t, v),
        automationHolds: { ...s.automationHolds, [key]: { ...hold, value: v, lastT: t } },
      };
    }),

  endAutomationTouch: (target, t) =>
    set((s) => {
      const key = automationTargetKey(target);
      const hold = s.automationHolds[key];
      if (!hold) return {};
      if (holdsAfterRelease(s.automationMode)) {
        // Latch/write keep the target, now released — but the span up to `t` is
        // written HERE rather than left to the next frame, because there may not
        // be one: a release followed immediately by a stop would otherwise lose
        // everything between the last move and the release. Advancing `lastT` to
        // `t` makes this idempotent with the frame that does follow.
        return {
          automationLanes: writeHoldSpan(s.automationLanes, key, hold.lastT, t, hold.value),
          automationHolds: { ...s.automationHolds, [key]: { ...hold, released: true, lastT: t } },
        };
      }
      // Touch punches out here: one last span, then the lane is the lane again.
      const { [key]: _dropped, ...rest } = s.automationHolds;
      return {
        automationLanes: writeHoldSpan(s.automationLanes, key, hold.lastT, t, hold.value),
        automationHolds: rest,
      };
    }),

  advanceAutomationHolds: (t) =>
    set((s) => {
      // Runs on the transport's frame timer. Returning the state object ITSELF
      // makes zustand's Object.is check short-circuit, so an idle transport wakes
      // no subscriber and allocates nothing.
      const keys = Object.keys(s.automationHolds);
      if (keys.length === 0) return s;
      let automationLanes = s.automationLanes;
      const automationHolds: Record<string, AutomationHold> = {};
      for (const key of keys) {
        const hold = s.automationHolds[key];
        automationLanes = writeHoldSpan(automationLanes, key, hold.lastT, t, hold.value);
        automationHolds[key] = { ...hold, lastT: t };
      }
      return { automationLanes, automationHolds };
    }),

  beginAutomationPass: (t) => {
    if (!writesUntouched(get().automationMode)) return;
    beginUndoStep(); // the whole pass is one undo step
    set((s) => {
      const automationHolds: Record<string, AutomationHold> = { ...s.automationHolds };
      const automationLanes = s.automationLanes.map((l) => {
        if (!l.enabled) return l;
        const key = automationTargetKey(l.target);
        if (automationHolds[key]) return l; // already held by a live gesture
        // A write pass records WHAT YOU HEAR, so the stored control position wins
        // over what the lane used to say. During the pass the scheduler leaves
        // every held lane alone and the parameter plays its stored value — seeding
        // from the lane instead would overwrite the lane with a value nobody is
        // hearing. The lane is the fallback for the case with no control behind
        // it at all (an FX param key whose chain entry is gone).
        const laneAtT = sampleLane(l, t);
        const value = storedValueForTarget(s, l.target) ?? laneAtT;
        if (value === null) return l;
        automationHolds[key] = { target: l.target, value, lastT: t, released: true };

        // TWO anchors, and the pass writes nothing behind them.
        //
        // The punch-in anchor at `t` is what stops the first frame's write from
        // landing a frame late and redrawing the segment that reaches it all the
        // way back to the previous breakpoint — a pass punched in at 5 s used to
        // change the lane at 1 s, which it never rolled over.
        //
        // But the punch-in carries the HEARD value, which is generally not what
        // the lane said at `t`, so the segment leading INTO it would still ramp
        // toward the new value. The pre-punch anchor pins the lane's own value
        // just before `t`, so the change is a step at the punch-in and everything
        // earlier plays exactly as it did. It is written FIRST, so the punch-in
        // upsert sees it as a left neighbour a full MIN_POINT_DT away.
        //
        // It is skipped when there is nothing to protect (no earlier point, or the
        // two values already agree), and when the nearest earlier point is within
        // 2 * MIN_POINT_DT — there the thinning rule leaves no room for a distinct
        // anchor, and a breakpoint that close is already holding the old value.
        let points = l.points;
        let prevT = -Infinity;
        for (const p of points) if (p.t < t && p.t > prevT) prevT = p.t;
        if (laneAtT !== null && laneAtT !== value && t - prevT >= 2 * MIN_POINT_DT) {
          const preT = prePunchTime(t);
          const preV = sampleLane(l, preT);
          if (preV !== null) points = upsertPoint(points, preT, preV);
        }
        return { ...l, points: upsertPoint(points, t, value) };
      });
      return { automationLanes, automationHolds };
    });
  },

  endAutomationPass: () =>
    set((s) => {
      return { automationHolds: {}, automationMode: modeAfterStop(s.automationMode) };
    }),

  setAutomationPointCurve: (laneId, index, curve, opts) => {
    // A menu/keyboard choice is its own undo step, however close it lands to the
    // last one (see setClipFadeCurve). A curve DRAG says `coalesce`: its
    // pointer-down already cut the burst once, for the whole gesture, and
    // beginning a step per pointermove would leave an undo entry per frame.
    if (!opts?.coalesce) beginUndoStep();
    set((s) => {
      const lane = s.automationLanes.find((l) => l.id === laneId);
      if (!lane || index < 0 || index >= lane.points.length) return {};
      const c = Math.max(-1, Math.min(1, Number.isFinite(curve) ? curve : 0));
      const p = lane.points[index];
      // 0 is linear, and linear is the ABSENT key — one canonical shape on disk.
      const next: AutomationPoint = c === 0 ? { t: p.t, v: p.v } : { t: p.t, v: p.v, curve: c };
      return {
        automationLanes: s.automationLanes.map((l) =>
          l.id === laneId ? { ...l, points: l.points.map((q, i) => (i === index ? next : q)) } : l,
        ),
      };
    });
  },

  recordAutomationPoint: (target, t, v) =>
    set((s) => {
      const key = automationTargetKey(target);
      const existing = s.automationLanes.find((l) => automationTargetKey(l.target) === key);
      if (existing) {
        return {
          automationLanes: s.automationLanes.map((l) =>
            l.id === existing.id ? { ...l, points: upsertPoint(l.points, t, v) } : l,
          ),
        };
      }
      return {
        automationLanes: [
          ...s.automationLanes,
          { id: uid(), target, points: [{ t, v }], enabled: true },
        ],
      };
    }),

  addAutomationPoint: (laneId, t, v) =>
    set((s) => ({
      automationLanes: s.automationLanes.map((l) =>
        l.id === laneId ? { ...l, points: upsertPoint(l.points, t, v) } : l,
      ),
    })),

  updateAutomationPoint: (laneId, index, t, v) =>
    set((s) => ({
      automationLanes: s.automationLanes.map((l) => {
        if (l.id !== laneId || index < 0 || index >= l.points.length) return l;
        // The point keeps its SHAPE when it moves. Rebuilding it as a bare
        // {t, v} silently flattened the segment the point owns.
        //
        // `curve` is passed through UNDEFINED when the point has none, not as an
        // explicit 0: an explicit 0 outranks a merged neighbour's curve, so
        // dragging a curve-less point to within MIN_POINT_DT of a curved one
        // would have wiped that neighbour's shape.
        const without = l.points.filter((_, i) => i !== index);
        return { ...l, points: upsertPoint(without, t, v, l.points[index].curve) };
      }),
    })),

  removeAutomationPoint: (laneId, index) =>
    set((s) => ({
      automationLanes: s.automationLanes.map((l) =>
        l.id === laneId ? { ...l, points: l.points.filter((_, i) => i !== index) } : l,
      ),
    })),

  toggleAutomationLane: (laneId) =>
    set((s) => ({
      automationLanes: s.automationLanes.map((l) =>
        l.id === laneId ? { ...l, enabled: !l.enabled } : l,
      ),
    })),

  clearAutomationLane: (laneId) =>
    set((s) => ({
      automationLanes: s.automationLanes.map((l) =>
        l.id === laneId ? { ...l, points: [] } : l,
      ),
    })),

  removeAutomationLane: (laneId) =>
    set((s) => ({ automationLanes: s.automationLanes.filter((l) => l.id !== laneId) })),

  getLaneForTarget: (target) => {
    const key = automationTargetKey(target);
    return get().automationLanes.find((l) => automationTargetKey(l.target) === key);
  },

  setLoopEnabled: (on) => set({ loopEnabled: on }),
  setLoopRegion: (start, end) =>
    set(() => {
      const a = Math.max(0, Math.min(start, end));
      const b = Math.max(start, end);
      return { loopStart: a, loopEnd: b, loopEnabled: b - a > 0.05 };
    }),
  clearLoop: () => set({ loopEnabled: false, loopStart: 0, loopEnd: 0 }),
  addMarker: (t, label) =>
    set((s) => ({
      markers: [...s.markers, { id: uid(), t: Math.max(0, t), label: label ?? String(s.markers.length + 1) }].sort((x, y) => x.t - y.t),
    })),
  removeMarker: (id) => set((s) => ({ markers: s.markers.filter((m) => m.id !== id) })),
  renameMarker: (id, label) => set((s) => ({ markers: s.markers.map((m) => (m.id === id ? { ...m, label } : m)) })),
  moveMarker: (id, t) =>
    set((s) => ({
      markers: s.markers.map((m) => (m.id === id ? { ...m, t: Math.max(0, t) } : m)).sort((x, y) => x.t - y.t),
    })),

  undo: () => {
    const s = get();
    if (s._undo.length === 0) return;
    const prev = s._undo[s._undo.length - 1];
    const current = docSnapshot(s);
    historyApplying = true;
    set({
      tracks: prev.tracks,
      clips: prev.clips,
      masterFxChain: prev.masterFxChain,
      masterVstChain: prev.masterVstChain,
      automationLanes: prev.automationLanes,
      markers: prev.markers,
      bpm: prev.bpm,
      routing: prev.routing,
      buses: prev.buses,
      _undo: s._undo.slice(0, -1),
      _redo: [...s._redo, current],
      // undo/redo run under historyApplying, so the dirty subscription skips
      // them — but stepping through history still moves the document away from
      // what is on disk, so mark it here explicitly.
      dirty: true,
    });
    historyApplying = false;
    lastDocChangeAt = -Infinity; // the next real edit starts a fresh undo step
  },

  redo: () => {
    const s = get();
    if (s._redo.length === 0) return;
    const next = s._redo[s._redo.length - 1];
    const current = docSnapshot(s);
    historyApplying = true;
    set({
      tracks: next.tracks,
      clips: next.clips,
      masterFxChain: next.masterFxChain,
      masterVstChain: next.masterVstChain,
      automationLanes: next.automationLanes,
      markers: next.markers,
      bpm: next.bpm,
      routing: next.routing,
      buses: next.buses,
      _undo: [...s._undo, current],
      _redo: s._redo.slice(0, -1),
      dirty: true,
    });
    historyApplying = false;
    lastDocChangeAt = -Infinity;
  },

  markSaved: () => set({ dirty: false }),

  getTotalDurationSec: () => {
    const { clips } = get();
    if (clips.length === 0) return 60; // default empty timeline shows 60s
    return Math.max(...clips.map((c) => c.startSec + c.durationSec), 30);
  },

  snapSec: (s) => {
    const { snap, bpm } = get();
    const step = snapStepSec(snap, bpm);
    if (step === null) return Math.max(0, s);
    return Math.max(0, Math.round(s / step) * step);
  },
}));

/* ── The lane repaint throttle ────────────────────────────────────────────────
 *
 * `advanceAutomationHolds` runs on the transport's frame timer and, while a
 * latch/write pass holds anything, rewrites `automationLanes` EVERY frame. The
 * document has to be written every frame — undo and autosave read that slice and
 * a pass that skipped frames would record a staircase — but nothing on screen
 * needs 40 repaints a second of a curve that is a few pixels wide, and a
 * component subscribed to the slice re-renders on each one.
 *
 * So the throttle lives between the store and the VIEW rather than in the writer:
 * the store is untouched and stays the single source of truth, and this feed
 * republishes the same array at most once per `AUTOMATION_LANE_REPAINT_MS` WHILE
 * holds exist. With no hold — every ordinary edit, every undo, loading a project
 * — it publishes at once, so outside a record pass nothing ever waits on a timer.
 * The gate is the HOLDS, not who wrote: an edit made during a pass shares the
 * same 10 Hz window, which is the price of one rule instead of two and is
 * invisible next to the pass repainting the lane under it anyway.
 *
 * `getSnapshot` is reference-stable between publishes, which is what actually
 * stops the re-render: React (and zustand) compare with Object.is.
 *
 * The clock is injected so the whole thing is testable without a DOM
 * (editorStore.automationLaneFeed.test.ts), the same way lib/gestureTracker does.
 */
export const AUTOMATION_LANE_REPAINT_MS = 100;

export interface AutomationLaneFeedOptions {
  getState: () => { automationLanes: AutomationLane[]; automationHolds: Record<string, AutomationHold> };
  /** Subscribe to "something in the store changed". */
  subscribe: (onChange: () => void) => () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  /** Repaint window while holds exist. Defaults to `AUTOMATION_LANE_REPAINT_MS`. */
  repaintMs?: number;
}

export interface AutomationLaneFeed {
  /** `useSyncExternalStore`'s subscribe: the callback fires once per publish. */
  subscribe: (onPublish: () => void) => () => void;
  /** The published lanes. Stable by reference until the next publish. */
  getSnapshot: () => AutomationLane[];
}

export function createAutomationLaneFeed(opts: AutomationLaneFeedOptions): AutomationLaneFeed {
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((handle: number) => clearTimeout(handle));
  const repaintMs = opts.repaintMs ?? AUTOMATION_LANE_REPAINT_MS;

  let published: AutomationLane[] | null = null;
  let publishedAt = -Infinity;
  let timer = 0;
  let offStore: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const disarm = () => {
    if (timer === 0) return;
    clearTimer(timer);
    timer = 0;
  };

  const publish = () => {
    disarm();
    const next = opts.getState().automationLanes;
    if (next === published) return; // caught up already — wake nobody
    published = next;
    publishedAt = now();
    for (const l of [...listeners]) l();
  };

  const onStoreChanged = () => {
    const s = opts.getState();
    if (s.automationLanes === published) return; // the write missed this slice
    if (Object.keys(s.automationHolds).length === 0) { publish(); return; }
    if (timer !== 0) return; // a repaint is already due; it will take the latest
    const due = publishedAt + repaintMs - now();
    if (due <= 0) { publish(); return; }
    timer = setTimer(publish, due);
  };

  return {
    subscribe: (onPublish) => {
      if (listeners.size === 0) {
        // Re-sync on the first subscriber: the lanes may have moved on while
        // nothing was mounted, and a stale snapshot would paint the old document.
        published = opts.getState().automationLanes;
        publishedAt = now();
        offStore = opts.subscribe(onStoreChanged);
      }
      listeners.add(onPublish);
      return () => {
        listeners.delete(onPublish);
        if (listeners.size > 0) return;
        offStore?.();
        offStore = null;
        disarm();
      };
    },
    getSnapshot: () => (published ??= opts.getState().automationLanes),
  };
}

/** The app-wide feed over `useEditorStore.automationLanes`. */
export const automationLaneFeed = createAutomationLaneFeed({
  getState: () => useEditorStore.getState(),
  subscribe: (onChange) => useEditorStore.subscribe(() => onChange()),
});

// Record undo history whenever a tracked document slice changes. Only the FIRST
// change of a burst captures the pre-change snapshot, so a continuous gesture (clip
// drag, fader ride, WRITE-record pass) collapses into a single undo step. Playhead,
// zoom, selection, and transport changes don't touch these slices, so they never
// pollute history. undo/redo set historyApplying so their own writes aren't recorded.
useEditorStore.subscribe((state, prev) => {
  if (historyApplying) return;
  if (
    state.tracks === prev.tracks &&
    state.clips === prev.clips &&
    state.masterFxChain === prev.masterFxChain &&
    state.masterVstChain === prev.masterVstChain &&
    state.automationLanes === prev.automationLanes &&
    state.markers === prev.markers &&
    state.bpm === prev.bpm &&
    state.routing === prev.routing &&
    state.buses === prev.buses
  ) return;
  const now = performance.now();
  const coalesce = now - lastDocChangeAt < HISTORY_COALESCE_MS;
  lastDocChangeAt = now;
  // The same slices that constitute an undo step constitute "the project", so
  // this is also where the document becomes dirty. Skip the write entirely when
  // there is nothing to record AND nothing to flag — otherwise a 50 Hz clip drag
  // would push a no-op setState (and wake every subscriber) on every frame.
  const needsDirty = !state.dirty;
  if (coalesce && !needsDirty) return; // mid-burst; the burst start captured the undo point
  historyApplying = true;
  useEditorStore.setState((s) => {
    if (coalesce) return { dirty: true };
    const undo = [...s._undo, docSnapshot(prev)];
    if (undo.length > HISTORY_LIMIT) undo.shift();
    return needsDirty ? { dirty: true, _undo: undo, _redo: [] } : { _undo: undo, _redo: [] };
  });
  historyApplying = false;
});

/**
 * Decode an audio Blob and produce a downsampled peak array suitable for
 * rendering. Returns a Float32Array of `bins` values in [0, 1] representing
 * the absolute peak amplitude in each bin.
 */
export const computePeaks = async (blob: Blob, bins = 200): Promise<{ peaks: Float32Array; duration: number }> => {
  const arrayBuf = await blob.arrayBuffer();
  const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  const ctx = new Ctor();
  try {
    const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
    const data = audioBuf.getChannelData(0);
    const out = new Float32Array(bins);
    const samplesPerBin = Math.floor(data.length / bins);
    let max = 0;
    for (let i = 0; i < bins; i += 1) {
      let peak = 0;
      const start = i * samplesPerBin;
      const end = Math.min(start + samplesPerBin, data.length);
      for (let j = start; j < end; j += 1) {
        const v = Math.abs(data[j]);
        if (v > peak) peak = v;
      }
      out[i] = peak;
      if (peak > max) max = peak;
    }
    // Normalize.
    if (max > 0) {
      for (let i = 0; i < bins; i += 1) out[i] /= max;
    }
    return { peaks: out, duration: audioBuf.duration };
  } finally {
    // Don't await close; some browsers GC fine without explicit close.
    try { await ctx.close(); } catch { /* ignore */ }
  }
};

