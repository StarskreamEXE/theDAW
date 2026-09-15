/**
 * liveMixer — real-time multi-track playback for the EDIT timeline.
 *
 * Until now, pressing Play in the editor did an OFFLINE bounce (mix every clip
 * into one WAV, then play that WAV through the footer's <audio>). That meant a
 * per-track fader / pan / mute / solo only changed the mix on the NEXT play.
 *
 * This module instead schedules each clip as a live Web Audio node graph so
 * track volume / pan / mute / solo are audible MID-playback:
 *
 *     BufferSource ─▶ clipGain (fade in/out) ─▶ trackGain (volume, live)
 *                                                   └▶ panner (pan, live) ─▶ master
 *
 * trackGain + panner are shared per track and updated in place when the EDIT
 * (or SLIDE) faders move — that's the whole point. clipGain carries each clip's
 * fade envelope. Everything routes through the shared engine master → analyser
 * → destination, so the visualizer + HUD keep working.
 *
 * Transport: a rAF clock advances a virtual playhead off the AudioContext
 * clock and mirrors it into playerStore.currentTime (footer time) and
 * editorStore.playheadSec (the moving line). The footer is UNCHANGED — it calls
 * the usual playerStore transport methods, which delegate here while a live
 * editor session is registered (see playerStore.setLiveTransport).
 *
 * The OFFLINE bounce is kept as-is for export / commit / send-to-init — those
 * genuinely need a rendered file. liveMixer only replaces the live PREVIEW.
 *
 * Honesty / scope: live updates cover the MIXER params (volume/pan/mute/solo)
 * plus per-clip mute (a retained gain gate per scheduled clip). Structural clip
 * edits (add/remove/split/move) made WHILE playing take effect on the next
 * play, same as a hardware mixer wouldn't re-cut tape mid-take.
 */
import {
  useEditorStore,
  sampleLane,
  automationTargetKey,
  clipPeakGain,
  type AudioClip,
  type EditorTrack,
  type AutomationLane,
  type AutomationTarget,
} from './editorStore';
import { clampCurve, interpolatePoints, sampleCurve, type CurvePoint } from '../lib/automationModes';
import {
  usePlayerStore,
  getEngineCtx,
  getMasterGain,
  setLiveTransport,
  registerChainProbe,
} from './playerStore';
import { logError } from './logStore';
import {
  ensureSoundfontReady,
  isLiveSynthReady,
  liveNoteOn,
  liveNoteOff,
  liveAllNotesOff,
  routeMidiChannel,
  resetMidiRouting,
  useSoundfontStore,
} from '../lib/soundfontEngine';
import { applyFadeAutomation, type AudioParamLike, type FadeClip } from '../lib/clipFade';
import { warpSegments, type WarpMarker, type WarpSegment } from '../lib/audioWarp';
import { buildEffectChain, teleportXYZ, SPATIAL_TELEPORT, type ChainHandle } from '../lib/rackEffects';
import { sliceChunks, type AudioChunk } from '../lib/audioAnalysis';
import { decodeClipBlob, peekDecoded } from '../lib/decodeCache';
import type { ChainEntry } from './effectChainStore';

const EDITOR_ENTRY_ID = 'editor-timeline'; // reuse so existing footer/playhead wiring keeps working
const RAMP_TC = 0.015; // setTargetAtTime time-constant for click-free param moves

// Decoded buffers live in lib/decodeCache, shared with the offline renderers,
// so a clip decoded here for playback is not decoded a second time by a bounce.

// Onset-sliced chunks cached by Blob identity (for the spatializer Teleport mode),
// so the (cheap but non-trivial) analysis runs once per clip, not per play/seek.
const analysisCache = new WeakMap<Blob, AudioChunk[]>();

interface TrackNodes {
  /** Volume fader (manual OR automated). Split from mute/solo so a volume
   *  automation lane can own this param while mute/solo stay live. */
  gain: GainNode;
  /** Mute/solo factor (0 or 1), always driven live (never automated). */
  muteGain: GainNode;
  panner: StereoPannerNode;
  /** Per-track insert FX, spliced gain -> muteGain -> [fx] -> panner. */
  fx: ChainHandle;
  fxFullSig: string; // topology + params (skip no-op reconciles)
  fxTopoSig: string; // topology only (rebuild trigger)
}

// ---- live session state (module singletons; one editor timeline at a time) --
let trackNodes = new Map<string, TrackNodes>();
let sources: AudioBufferSourceNode[] = [];
let rafId = 0;
let startCtxTime = 0; // ctx.currentTime at the moment playback (re)started
let startOffsetSec = 0; // timeline position playback started from
let totalDur = 0;
let playing = false;
let playToken = 0; // guards against overlapping async play() calls
let unsubEditor: (() => void) | null = null;
let lastMixSig = '';
let lastTimePush = 0; // throttle playerStore.currentTime writes
let midiTimers: number[] = []; // setTimeout handles for scheduled MIDI note on/off
// Per-clip mute gates retained at schedule time, keyed by clip id. Structural
// clip edits still require a re-schedule; muted is the one clip property gated
// live, so the editor-store subscription flips these gains mid-playback.
let clipMuteGains = new Map<string, GainNode>();
let lastClipMuteSig = '';
let liveMidiActive = false; // true while MIDI clips play via the live synth (vs their bounce)
let autoFxTimer = 0; // setInterval handle for the FX-param automation lookahead

// Session-local master bus + psychoacoustic insert rack. Every track's panner
// feeds masterBus; masterBus -> masterChain -> the shared engine master, so the
// EDIT rack processes ONLY the editor mix and never the library/DJ/sequencer
// audio that also routes through getMasterGain().
let masterBus: GainNode | null = null;
let masterChain: ChainHandle | null = null;
let lastMasterSig = '';     // topology only (rebuild trigger)
let lastMasterFullSig = ''; // topology + params (skip no-op ticks)

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Clamped manual fader value (the volume automation lane overrides this live). */
function volumeOf(t: EditorTrack): number {
  return clamp(t.volume, 0, 1);
}

/** Mute/solo gate: 0 when muted or hidden by an active solo, else 1. */
function muteSoloFactor(t: EditorTrack, anySolo: boolean): number {
  if (t.mute) return 0;
  if (anySolo && !t.solo) return 0;
  return 1;
}

/** Effective track gain honoring mute + (exclusive) solo (volume x gate). */
function effectiveVol(t: EditorTrack, anySolo: boolean): number {
  return volumeOf(t) * muteSoloFactor(t, anySolo);
}

/** Keys of native (vol/pan) targets that have an enabled automation lane, so the
 *  manual reconcile leaves those params to the scheduled envelope while playing. */
function automatedNativeKeys(): Set<string> {
  const keys = new Set<string>();
  for (const lane of useEditorStore.getState().automationLanes) {
    if (!lane.enabled) continue;
    const k = lane.target.kind;
    if (k === 'trackVolume' || k === 'trackPan') keys.add(automationTargetKey(lane.target));
  }
  return keys;
}

/* What the EDIT timeline's own nodes are doing, for playerStore.dumpAudioChain.
   `param` is the value the AudioParam is REALLY holding — which is not the
   fader when an automation lane owns it (scheduleAutomation writes the param,
   applyMixLive skips it), and that gap is exactly what makes a track quiet with
   its fader up. */
registerChainProbe('editTimeline', () => {
  const automated = automatedNativeKeys();
  const tracks = useEditorStore.getState().tracks;
  return {
    playing,
    masterBus: masterBus ? masterBus.gain.value : null,
    tracks: tracks.map((t) => {
      const n = trackNodes.get(t.id);
      return {
        name: t.name,
        fader: t.volume,
        param: n ? n.gain.gain.value : null,
        volumeAutomated: automated.has(automationTargetKey({ kind: 'trackVolume', trackId: t.id })),
        muteGate: n ? n.muteGain.gain.value : null,
        pan: n ? n.panner.pan.value : t.pan,
      };
    }),
  };
});

/** A short signature of just the mixer-relevant fields, so the editorStore
 *  subscription (which also fires on every playhead tick) only pushes live
 *  node updates when a fader/pan/mute/solo actually moved. */
function mixSignature(tracks: EditorTrack[]): string {
  let s = '';
  for (const t of tracks) s += `${t.id}:${t.volume}:${t.pan}:${t.mute}:${t.solo}|`;
  return s;
}

/** Signature of which clips are muted, so the clips-slice subscription (which
 *  also fires on drags/resizes) only touches the live gates on a mute change. */
function clipMuteSignature(clips: AudioClip[]): string {
  let s = '';
  for (const c of clips) if (c.muted) s += `${c.id}|`;
  return s;
}

/** Push each scheduled clip's live mute gate (0 or 1, click-free). Clips muted
 *  at schedule time were never scheduled, so unmuting those takes effect on the
 *  next play; muting (and re-unmuting) a playing clip is audible immediately. */
function applyClipMutesLive(): void {
  if (clipMuteGains.size === 0) return;
  const ctx = getEngineCtx();
  for (const clip of useEditorStore.getState().clips) {
    const gate = clipMuteGains.get(clip.id);
    if (!gate) continue;
    gate.gain.setTargetAtTime(clip.muted ? 0 : 1, ctx.currentTime, RAMP_TC);
  }
}

/** Push current track volume/pan/mute/solo onto the live nodes (click-free).
 *  Volume and pan are left to their scheduled envelope when an enabled lane owns
 *  them; the mute/solo gate is always applied live. */
function applyMixLive(): void {
  const ctx = getEngineCtx();
  const tracks = useEditorStore.getState().tracks;
  const anySolo = tracks.some((t) => t.solo);
  const automated = automatedNativeKeys();
  for (const t of tracks) {
    const n = trackNodes.get(t.id);
    if (!n) continue;
    const volKey = automationTargetKey({ kind: 'trackVolume', trackId: t.id });
    const panKey = automationTargetKey({ kind: 'trackPan', trackId: t.id });
    if (!automated.has(volKey)) n.gain.gain.setTargetAtTime(volumeOf(t), ctx.currentTime, RAMP_TC);
    n.muteGain.gain.setTargetAtTime(muteSoloFactor(t, anySolo), ctx.currentTime, RAMP_TC);
    if (!automated.has(panKey)) n.panner.pan.setTargetAtTime(clamp(t.pan, -1, 1), ctx.currentTime, RAMP_TC);
  }
}

/** Decode every clip's blob we'll need (cached by Blob identity + sample rate). */
async function ensureDecoded(clips: AudioClip[]): Promise<void> {
  const ctx = getEngineCtx();
  for (const clip of clips) {
    await decodeClipBlob(ctx, clip.audioBlob);
  }
}

/** Topology signature of an FX chain (order + effect + enabled), so the store
 *  subscription rebuilds the node graph only when the topology changes, and
 *  pushes param-only edits without a rebuild. */
function chainTopoSig(chain: ChainEntry[]): string {
  let s = '';
  for (const e of chain) s += `${e.id}:${e.effect}:${e.enabled ? 1 : 0}|`;
  return s;
}

/** (Re)build the session-local master bus + insert rack and route it into the
 *  shared engine master. Safe to call repeatedly (tears down the prior one). */
function buildMasterBus(): void {
  const ctx = getEngineCtx();
  if (masterChain) { masterChain.dispose(); masterChain = null; }
  if (masterBus) { try { masterBus.disconnect(); } catch { /* gone */ } masterBus = null; }
  masterBus = ctx.createGain();
  const chain = useEditorStore.getState().masterFxChain;
  masterChain = buildEffectChain(ctx, masterBus, getMasterGain(), chain);
  lastMasterSig = chainTopoSig(chain);
  lastMasterFullSig = JSON.stringify(chain);
}

/** Reconcile the live master rack with the store: rebuild on topology change,
 *  otherwise push each entry's params live. Cheap no-op when nothing changed
 *  (this runs on every store tick, including the 60 Hz playhead). */
function applyMasterChainLive(): void {
  if (!masterChain) return;
  const chain = useEditorStore.getState().masterFxChain;
  const full = JSON.stringify(chain);
  if (full === lastMasterFullSig) return;
  lastMasterFullSig = full;
  const sig = chainTopoSig(chain);
  if (sig !== lastMasterSig) {
    lastMasterSig = sig;
    masterChain.rebuild(chain);
  } else {
    for (const e of chain) masterChain.updateParams(e.id, e.params);
  }
}

/** Reconcile each track's live insert chain with the store (rebuild on topology
 *  change, push params otherwise). Runs on every store tick while playing. */
function applyTrackChainsLive(): void {
  const tracks = useEditorStore.getState().tracks;
  const byId = new Map<string, EditorTrack>(tracks.map((t): [string, EditorTrack] => [t.id, t]));
  for (const [id, n] of trackNodes) {
    const chain = byId.get(id)?.fxChain ?? [];
    const full = JSON.stringify(chain);
    if (full === n.fxFullSig) continue;
    n.fxFullSig = full;
    const topo = chainTopoSig(chain);
    if (topo !== n.fxTopoSig) { n.fxTopoSig = topo; n.fx.rebuild(chain); }
    else for (const e of chain) n.fx.updateParams(e.id, e.params);
  }
}

/** Dispose every track's FX handle + nodes (oscillators in some effects must be
 *  stopped explicitly). Leaves the trackNodes map for the caller to replace. */
function disposeTrackNodes(): void {
  for (const n of trackNodes.values()) {
    try { n.fx.dispose(); n.gain.disconnect(); n.muteGain.disconnect(); n.panner.disconnect(); } catch { /* gone */ }
  }
}

/** Build (or rebuild) per track: gain -> [insert FX] -> panner -> master bus.
 *  Panners feed the session master bus (built first), not the engine master. */
function buildTrackNodes(tracks: EditorTrack[]): void {
  const ctx = getEngineCtx();
  const dest: AudioNode = masterBus ?? getMasterGain();
  disposeTrackNodes();
  trackNodes = new Map();
  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    const gain = ctx.createGain();
    gain.gain.value = volumeOf(t);
    const muteGain = ctx.createGain();
    muteGain.gain.value = muteSoloFactor(t, anySolo);
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(t.pan, -1, 1);
    const chain = t.fxChain ?? [];
    gain.connect(muteGain);
    const fx = buildEffectChain(ctx, muteGain, panner, chain); // gain -> muteGain -> [fx] -> panner
    panner.connect(dest);
    trackNodes.set(t.id, {
      gain,
      muteGain,
      panner,
      fx,
      fxFullSig: JSON.stringify(chain),
      fxTopoSig: chainTopoSig(chain),
    });
  }
}

/** A MIDI clip = a piano-roll clip carrying its editable notes. */
function isMidiClip(clip: AudioClip): boolean {
  return clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll && clip.sourcePianoRoll.length > 0;
}

/* ── Per-clip schedule math ───────────────────────────────────────────────────
   One clip becomes one or more buffer-source plays. With none of T07a's fields
   that is a single play of the clip's length at unit rate, exactly as it always
   was. `timeStretchRate` rides the source's `playbackRate` instead of a
   destructive re-render; `warpMarkers` split the clip into one play per warp
   segment, each with its own rate. The computation is PURE — no audio context,
   no store — so the live scheduler here and the three offline bounces in
   WaveformEditor schedule from the same arithmetic, and so it is testable on
   its own (state/liveMixer.schedule.test.ts). */

/** The clip fields the schedule math reads. `AudioClip` satisfies it. */
export interface ScheduleClip {
  offsetIntoSource: number;
  durationSec: number;
  timeStretchRate?: number;
  stretchMode?: 'repitch' | 'offline';
  warpMarkers?: WarpMarker[];
}

/** One `AudioBufferSourceNode` worth of playback. All times are seconds. */
export interface ScheduledSegment {
  /** Offset from the clip's HEAD at which this piece starts on the timeline —
   *  add the clip's own start (live: its context time) to place it. */
  targetStart: number;
  /** Offset from the clip's head at which it ends. */
  targetEnd: number;
  /** Where in the decoded buffer this piece starts reading. */
  sourceOffset: number;
  /** How much of the buffer it reads: timeline length x `playbackRate`. */
  sourceDuration: number;
  /** `AudioBufferSourceNode.playbackRate` for this piece. */
  playbackRate: number;
}

export interface ClipSchedule {
  /** The clip's EFFECTIVE length on the timeline, once the decoded buffer's real
   *  length, the stretch rate and the warp map are known. Every fade site passes
   *  it to `applyFadeAutomation` as `effectiveDurationSec`, so a fade-out lands
   *  on the end of the audio that actually plays rather than fading past audio
   *  that is not there. (`lib/clipFade` caps it at `clip.durationSec`, so a warp
   *  map that runs the clip PAST its box still fades over the box.) Unaffected
   *  by a mid-clip start: the envelope describes the whole clip either way. */
  durationSec: number;
  /** In timeline order, and already trimmed to the requested start point. */
  segments: ScheduledSegment[];
}

/** How close to the end of a decoded buffer a clip's offset may land. Keeps a
 *  clip whose offset runs past its (re-decoded, slightly shorter) buffer
 *  audible instead of silent — the app's behaviour since before this module. */
const SOURCE_END_GUARD = 0.01;

/** The rate `playbackRate` must ride. An 'offline' stretch is already baked into
 *  the clip's blob, so it schedules like an unstretched clip; anything that is
 *  not a usable positive rate falls back to unity rather than silencing a clip. */
const stretchRateOf = (clip: ScheduleClip): number => {
  if (clip.stretchMode === 'offline') return 1;
  const rate = clip.timeStretchRate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1;
};

/**
 * Does this segment list actually bend time?
 *
 * `warpSegments` discards markers it cannot use — not finite, before the head of
 * the source, past its end — and a clip whose markers ALL go that way is handed
 * back the identity map: the whole source, once, at rate 1. So is a clip whose
 * only marker restates where the source already ends. Neither is a warp, and
 * treating them as one would silently drop the clip's `timeStretchRate`, so they
 * fall through to the ordinary stretch path instead.
 */
const isWarp = (segments: readonly WarpSegment[], sourceSpan: number): boolean => {
  if (segments.length === 0) return false;
  if (segments.length > 1) return true;
  const only = segments[0];
  return !(
    only.sourceStart === 0 && only.targetStart === 0
    && only.sourceEnd === sourceSpan && only.targetEnd === sourceSpan
  );
};

/**
 * How to play one clip out of `bufferDurationSec` seconds of decoded audio,
 * starting `fromClipSec` seconds into the clip (0 for an offline bounce, the
 * seek position for a mid-clip start). Returns `null` when there is nothing
 * left to play — no buffer, a zero-length clip, or a start past its end.
 */
export function computeClipSchedule(
  clip: ScheduleClip,
  bufferDurationSec: number,
  fromClipSec = 0,
): ClipSchedule | null {
  if (!Number.isFinite(bufferDurationSec) || bufferDurationSec <= 0) return null;
  const baseOffset = Math.min(clip.offsetIntoSource, Math.max(0, bufferDurationSec - SOURCE_END_GUARD));
  const available = bufferDurationSec - baseOffset;
  if (!(available > 0)) return null;

  // Markers are anchored against the clip's own stretch of source, so the map is
  // closed over the source the clip actually owns — a buffer shorter than the
  // clip shortens the map with it.
  const sourceSpan = Math.min(clip.durationSec, available);
  const markers = clip.warpMarkers;
  const warped = markers && markers.length > 0 ? warpSegments(markers, sourceSpan) : [];

  let segments: ScheduledSegment[];
  if (isWarp(warped, sourceSpan)) {
    // The markers already say where every moment lands, so `timeStretchRate` is
    // NOT applied on top of them. The map can re-time audio PAST the clip's own
    // box (`warpSegments` closes it by continuing at rate 1 from the last
    // marker), and the box is what the timeline draws, what the offline renders
    // are sized from, and what the fade envelope spans — so the schedule is
    // clamped to it. Without that, preview would play a tail that export cuts.
    segments = [];
    for (const seg of warped) {
      // A pathological map can place a later segment earlier, so this is a skip
      // and not a break.
      if (!(seg.targetStart < clip.durationSec)) continue;
      const targetEnd = Math.min(seg.targetEnd, clip.durationSec);
      segments.push({
        targetStart: seg.targetStart,
        targetEnd,
        sourceOffset: baseOffset + seg.sourceStart,
        // Untrimmed, the source span is the map's own — recomputing it from the
        // rate would only add float noise.
        sourceDuration: targetEnd === seg.targetEnd
          ? seg.sourceEnd - seg.sourceStart
          : (targetEnd - seg.targetStart) * seg.playbackRate,
        playbackRate: seg.playbackRate,
      });
    }
  } else {
    const playbackRate = stretchRateOf(clip);
    // At rate r, one timeline second eats r source seconds, so the buffer runs
    // out after `available / r` seconds of timeline.
    const targetEnd = Math.min(clip.durationSec, available / playbackRate);
    segments = targetEnd > 0
      ? [{
          targetStart: 0,
          targetEnd,
          sourceOffset: baseOffset,
          sourceDuration: targetEnd * playbackRate,
          playbackRate,
        }]
      : [];
  }
  if (segments.length === 0) return null;
  // The max, not the last: see the skip above.
  const durationSec = segments.reduce((end, seg) => Math.max(end, seg.targetEnd), 0);

  const from = Number.isFinite(fromClipSec) && fromClipSec > 0 ? fromClipSec : 0;
  const playable: ScheduledSegment[] = [];
  for (const seg of segments) {
    if (seg.targetEnd <= from) continue;                        // already finished
    if (seg.targetStart >= from) { playable.push(seg); continue; } // still ahead
    // The playhead is inside this one: skip into it at ITS playback rate.
    const skipped = (from - seg.targetStart) * seg.playbackRate;
    playable.push({
      targetStart: from,
      targetEnd: seg.targetEnd,
      sourceOffset: seg.sourceOffset + skipped,
      sourceDuration: seg.sourceDuration - skipped,
      playbackRate: seg.playbackRate,
    });
  }
  if (playable.length === 0) return null;
  return { durationSec, segments: playable };
}

/** Everything `scheduleClipSources` reads off a clip. `AudioClip` satisfies it
 *  structurally, and building one in a test needs no Blob. */
export type SchedulableClip = ScheduleClip & FadeClip & { id: string; startSec: number; gain?: number };

/** The audio-context surface the per-clip wiring needs — the two factories, and
 *  nothing else. `AudioContext` satisfies it; so does a stand-in. The real one
 *  is built by `playerStore.ensureEngine()` off `window.AudioContext`, which a
 *  test cannot supply, so the seam that makes this testable lives here. */
export interface ClipNodeFactory {
  createGain(): GainNode;
  createBufferSource(): AudioBufferSourceNode;
}

export interface ScheduledClipNodes {
  /** The clip's live mute gate, for the caller to key by clip id. */
  muteGate: GainNode;
  /** One source per played segment, in the schedule's order. */
  sources: AudioBufferSourceNode[];
}

/**
 * Wire one clip up for playback and start it:
 *
 *     source(s) ─▶ clipGain (fade envelope) ─▶ muteGate ─▶ destination
 *
 * `nowSec` is the context's current time (captured once for the whole pass, so
 * every clip is placed against the same instant) and `fromSec` is the timeline
 * position playback starts at. A warped clip gets one source per warp segment;
 * they share the one envelope and the one gate, which are therefore torn down
 * only once the LAST source has ended. Returns `null` — having built nothing —
 * when the clip has nothing left to play.
 */
export function scheduleClipSources(
  ctx: ClipNodeFactory,
  clip: SchedulableClip,
  buf: AudioBuffer,
  destination: AudioNode,
  nowSec: number,
  fromSec: number,
): ScheduledClipNodes | null {
  // How far into this clip the playhead already is (0 if clip is in the future).
  const into = Math.max(0, fromSec - clip.startSec);
  // One entry per buffer play: one for an ordinary clip, one per warp segment
  // for a warped one, already trimmed to `into`. Null = nothing left to play.
  const schedule = computeClipSchedule(clip, buf.duration, into);
  if (!schedule) return null;

  const clipStartCtx = nowSec + (clip.startSec - fromSec); // may be < now when straddling

  // Per-clip fade envelope on a dedicated gain (track volume lives on trackGain).
  // `peak` is the clip's own gain — the envelope rises to it instead of to unity,
  // so clip gain lands before the track fader and its insert FX, matching the
  // three offline bounce paths in WaveformEditor. The envelope is applied ONCE,
  // over the whole clip, however many segments the clip plays as.
  const clipGain = ctx.createGain();
  applyFadeAutomation(clipGain.gain, clip, clipStartCtx, into, {
    peak: clipPeakGain(clip),
    effectiveDurationSec: schedule.durationSec,
  });

  // Live mute gate, kept separate from clipGain so a mid-playback mute toggle
  // never clobbers the fade envelope's scheduled ramps.
  const muteGate = ctx.createGain();
  muteGate.gain.value = 1;
  clipGain.connect(muteGate).connect(destination);

  const clipSources: AudioBufferSourceNode[] = [];
  let pending = schedule.segments.length;
  for (const seg of schedule.segments) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = seg.playbackRate;
    src.connect(clipGain);
    src.start(Math.max(nowSec, clipStartCtx + seg.targetStart), seg.sourceOffset, seg.sourceDuration);
    src.onended = () => {
      pending -= 1;
      try { src.disconnect(); } catch { /* already gone */ }
      if (pending > 0) return;
      try { clipGain.disconnect(); muteGate.disconnect(); } catch { /* already gone */ }
    };
    clipSources.push(src);
  }
  return { muteGate, sources: clipSources };
}

/** Schedule every clip that is at or after `fromSec` (or straddling it). */
function scheduleClips(clips: AudioClip[], fromSec: number): void {
  const ctx = getEngineCtx();
  const now = ctx.currentTime;
  sources = [];
  clipMuteGains = new Map();
  for (const clip of clips) {
    // Muted clips are not scheduled at all; a mute toggled DURING playback is
    // handled live by the clip's mute gate (see applyClipMutesLive).
    if (clip.muted) continue;
    // When the live synth drives MIDI, skip the clip's bounced audio so we don't
    // double up; scheduleMidiClips plays its notes instead.
    if (liveMidiActive && isMidiClip(clip)) continue;
    const nodes = trackNodes.get(clip.trackId);
    if (!nodes) continue;
    const buf = peekDecoded(ctx, clip.audioBlob);
    if (!buf) continue;

    const scheduled = scheduleClipSources(ctx, clip, buf, nodes.gain, now, fromSec);
    if (!scheduled) continue;
    clipMuteGains.set(clip.id, scheduled.muteGate);
    for (const src of scheduled.sources) sources.push(src);
  }
}

/** Onset-sliced chunks for a clip's decoded buffer (cached by Blob identity). */
function chunksFor(clip: AudioClip): AudioChunk[] {
  const buf = peekDecoded(getEngineCtx(), clip.audioBlob);
  if (!buf) return [];
  let chunks = analysisCache.get(clip.audioBlob);
  if (!chunks) {
    chunks = sliceChunks(buf);
    analysisCache.set(clip.audioBlob, chunks);
  }
  return chunks;
}

/**
 * For every track whose spatializer is in Teleport mode, slice that track's clips
 * on their onsets and schedule one panner jump per chunk — the position comes from
 * the chunk's loudness (closer when louder) and brightness (higher when brighter),
 * spread by the effect's Depth. Runs after scheduleClips, on every (re)start; the
 * golden-angle index advances across passed chunks too, so a mid-timeline start
 * lands the same positions a from-zero play would.
 */
function scheduleTeleports(clips: AudioClip[], fromSec: number): void {
  const ctx = getEngineCtx();
  const now = ctx.currentTime;
  const tracks = useEditorStore.getState().tracks;
  for (const t of tracks) {
    const chain = t.fxChain ?? [];
    const teleEntries = chain.filter(
      (e) =>
        e.enabled &&
        e.effect === 'spatializer' &&
        Math.round(e.params?.motion ?? 0) === SPATIAL_TELEPORT,
    );
    if (teleEntries.length === 0) continue;
    const nodes = trackNodes.get(t.id);
    if (!nodes) continue;
    const insts = nodes.fx.instances();
    const trackClips = clips.filter(
      (c) => c.trackId === t.id && !c.muted && !(liveMidiActive && isMidiClip(c)),
    );

    for (const entry of teleEntries) {
      const li = insts.find((x) => x.id === entry.id);
      if (!li?.inst.scheduleTeleport) continue;
      const spread = entry.params?.motionDepth ?? 5;
      const events: { when: number; x: number; y: number; z: number }[] = [];
      let idx = 0;
      for (const clip of trackClips) {
        const buf = peekDecoded(ctx, clip.audioBlob);
        if (!buf) continue;
        const offset = Math.min(clip.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const dur = Math.min(clip.durationSec, buf.duration - offset);
        if (dur <= 0) continue;
        for (const chunk of chunksFor(clip)) {
          if (chunk.tSec < offset || chunk.tSec >= offset + dur) continue;
          const timelineSec = clip.startSec + (chunk.tSec - offset);
          if (timelineSec < fromSec - 0.001) { idx += 1; continue; } // already passed
          const pos = teleportXYZ(idx, chunk.loudness, chunk.brightness, spread);
          const whenCtx = startCtxTime + (timelineSec - startOffsetSec);
          events.push({ when: Math.max(whenCtx, now), x: pos.x, y: pos.y, z: pos.z });
          idx += 1;
        }
      }
      if (events.length > 0) {
        events.sort((a, b) => a.when - b.when);
        li.inst.scheduleTeleport(events);
      }
    }
  }
}

/* ── Automation (Phase E) ─────────────────────────────────────────────────────
   Native vol/pan lanes schedule their whole breakpoint envelope onto the real
   AudioParam at play/seek (sample-accurate, zero ongoing cost). FX-param lanes
   ride a ~40 Hz lookahead writer because they sit behind the rack's setParams. */

/** Resolve a native (vol/pan) automation target to its live AudioParam. */
function nativeParamFor(target: AutomationTarget): AudioParam | null {
  if (!target.trackId) return null;
  const n = trackNodes.get(target.trackId);
  if (!n) return null;
  if (target.kind === 'trackVolume') return n.gain.gain;
  if (target.kind === 'trackPan') return n.panner.pan;
  return null;
}

/** One scheduled change on an AudioParam. `curve` is a rasterised segment for
 *  `setValueCurveAtTime`; the other two are the plain set/ramp pair the lanes
 *  have always emitted. */
export type EnvelopeEvent =
  | { kind: 'set'; when: number; v: number }
  | { kind: 'ramp'; when: number; v: number }
  | { kind: 'curve'; start: number; duration: number; values: Float32Array };

/** The part of an automation lane the envelope needs. `AutomationLane` satisfies
 *  it structurally, which keeps the event builder testable without a store. */
export interface EnvelopeLane {
  points: readonly CurvePoint[];
}

/** Rasterisation density for a curved segment, and the bounds on the count. The
 *  minimum is the spec's: fewer than 2 values throws InvalidStateError. */
const CURVE_SAMPLES_PER_SEC = 200;
const CURVE_SAMPLES_MIN = 2;
const CURVE_SAMPLES_MAX = 512;
/** Smallest gap forced between two scheduled events, so a project carrying two
 *  breakpoints at the same instant cannot produce a zero-duration curve —
 *  `setValueCurveAtTime` throws RangeError unless `duration` is strictly
 *  positive. Same 1e-4 the offline bounce has always used. */
const MIN_EVENT_DT = 1e-4;

/** True when `points` is already in ascending `t` order (the common case). */
function isAscending(points: readonly CurvePoint[]): boolean {
  for (let i = 1; i < points.length; i += 1) if (points[i].t < points[i - 1].t) return false;
  return true;
}

/**
 * The event list one automation lane puts on its AudioParam — the ONE definition,
 * shared by live playback and by the offline bounces.
 *
 * `fromSec` is the timeline position playback resumes at; `startCtxTime` /
 * `startOffsetSec` are the transport's context-clock↔timeline pinning (both 0 for
 * an OfflineAudioContext, which renders from t=0); `now` is the context clock.
 *
 * Shape: an anchor `set` at `now` carrying the lane's value under the playhead,
 * then one event per breakpoint still ahead. A segment whose LEFT point has a
 * non-zero `curve` becomes a single `curve` sampled off `interpolatePoints`;
 * every other segment stays the `ramp` it was, so a curve-less lane emits exactly
 * what it emitted before this function existed.
 *
 * The `curve` events obey the Web Audio API spec's rules for
 * `setValueCurveAtTime` (https://webaudio.github.io/web-audio-api/
 * #dom-audioparam-setvaluecurveattime, read 2026-09-15; MDN's AudioParam page
 * agrees):
 *   - "If setValueCurveAtTime() is called for time T and duration D and there are
 *     any events having a time strictly greater than T, but strictly less than
 *     T+D, then a NotSupportedError exception MUST be thrown … it's ok to schedule
 *     a value curve exactly at the time of another event." Segments here are
 *     contiguous — each curve starts exactly where the previous event lands — so
 *     nothing ever falls strictly inside a curve's window.
 *   - The anchor is placed at `now` and every later event at or after it, so the
 *     anchor precedes the first curve (and may sit exactly on its start).
 *   - `values` needs at least 2 entries and `duration` must be finite and
 *     strictly positive; hence the clamps above.
 *   - "After the end of the curve time interval the value will remain constant at
 *     the final curve value … An implicit call to setValueAtTime() is made at time
 *     T0+TD with value V[N−1]". The last sample is therefore pinned exactly to the
 *     segment's end value rather than left to the rasteriser's rounding, so the
 *     ramp that follows departs from the breakpoint the user drew.
 *   - `startTime` earlier than `currentTime` is clamped to `currentTime` by the
 *     implementation, which would silently SHIFT a curve. Rather than let that
 *     happen, a segment already under way degrades here: the anchor holds the
 *     value at `fromSec` and the curve covers only the part still ahead, sampled
 *     as a window onto the same shape.
 */
export function laneEnvelopeEvents(
  lane: EnvelopeLane,
  fromSec: number,
  startCtxTime: number,
  startOffsetSec: number,
  now: number,
): EnvelopeEvent[] {
  if (lane.points.length === 0) return [];
  // Ascending order is load-bearing here — `cursor` only keeps events out of a
  // curve's window because each breakpoint is later than the last, and
  // `sampleCurve` binary-searches. The store's writers all keep lanes sorted, but a
  // hand-edited or imported project need not, and an out-of-order point would
  // otherwise drop a `set` BEHIND a curve already placed (NotSupportedError). Sort
  // a copy — stable, so points sharing a `t` keep their authored order — and only
  // when the lane actually needs it, so the normal path allocates nothing.
  const pts = isAscending(lane.points) ? lane.points : [...lane.points].sort((a, b) => a.t - b.t);
  const toCtx = (t: number) => startCtxTime + (t - startOffsetSec);
  const toTimeline = (x: number) => startOffsetSec + (x - startCtxTime);

  const out: EnvelopeEvent[] = [{ kind: 'set', when: now, v: sampleCurve(pts, fromSec) ?? pts[0].v }];
  // Nothing may be scheduled at or before `cursor`: it is `now` until the first
  // future event is placed and the END of the last placed event after that. It is
  // what keeps each curve's window free of other events.
  let cursor = now;

  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (p.t <= fromSec) continue; // behind the playhead — the anchor already covers it
    const whenCtx = toCtx(p.t);
    if (whenCtx <= now) {
      // Behind the CONTEXT clock (a re-schedule that arrived late): take the value
      // immediately rather than ramping backwards into the past.
      out.push({ kind: 'set', when: now, v: p.v });
      continue;
    }
    const when = Math.max(whenCtx, cursor + MIN_EVENT_DT);
    const prev = i > 0 ? pts[i - 1] : null;
    const curve = prev ? clampCurve(prev.curve) : 0;
    if (!prev || curve === 0) {
      out.push({ kind: 'ramp', when, v: p.v });
      cursor = when;
      continue;
    }
    const segStartCtx = toCtx(prev.t);
    const start = Math.max(segStartCtx, cursor);
    const duration = when - start;
    if (!(duration > 0)) {
      out.push({ kind: 'ramp', when, v: p.v });
      cursor = when;
      continue;
    }
    // Timeline window the rasterisation covers. It starts at the segment's own left
    // point, or wherever the playhead cut into it; it ends at the right point,
    // EXCEPT when `when` was bumped off `whenCtx` to keep the event ordered, in
    // which case the window is stretched by the same amount so `duration` and the
    // sampled span describe the same stretch of time (the two clocks run 1:1, so
    // the bump is the same number of seconds on both).
    const t0 = start <= segStartCtx ? prev.t : toTimeline(start);
    const t1 = when === whenCtx ? p.t : p.t + (when - whenCtx);
    const n = Math.max(
      CURVE_SAMPLES_MIN,
      Math.min(CURVE_SAMPLES_MAX, Math.ceil(duration * CURVE_SAMPLES_PER_SEC)),
    );
    const values = new Float32Array(n);
    for (let k = 0; k < n; k += 1) {
      values[k] = interpolatePoints(prev, p, t0 + (t1 - t0) * (k / (n - 1)));
    }
    values[n - 1] = p.v; // exact end value (see the spec note above)
    out.push({ kind: 'curve', start, duration, values });
    cursor = when;
  }
  return out;
}

/** Write an event list onto a param. `clampValue` (the offline bounces' range
 *  clamp) reaches INSIDE a curve too — a curved pan lane must not be the one path
 *  that escapes it. */
export function applyEnvelopeEvents(
  param: AudioParamLike,
  events: readonly EnvelopeEvent[],
  clampValue?: (v: number) => number,
): void {
  const fix = clampValue ?? ((v: number) => v);
  for (const e of events) {
    if (e.kind === 'set') { param.setValueAtTime(fix(e.v), e.when); continue; }
    if (e.kind === 'ramp') { param.linearRampToValueAtTime(fix(e.v), e.when); continue; }
    const values = clampValue ? e.values.map(clampValue) : e.values;
    if (param.setValueCurveAtTime) { param.setValueCurveAtTime(values, e.start, e.duration); continue; }
    // No value-curve support on this param: walk the same samples as ramps, so the
    // SHAPE survives instead of the segment silently flattening to a straight line.
    // The leading `set` matters — `setValueCurveAtTime` does nothing until `start`,
    // so without it the first ramp would start sliding from the anchor at `now`,
    // which for a degraded sub-curve (start > now) is a slope the curve does not
    // have. Pinning the value at `start` makes the param HOLD until the curve
    // begins, exactly as the real call does.
    param.setValueAtTime(values[0], e.start);
    for (let k = 1; k < values.length; k += 1) {
      param.linearRampToValueAtTime(values[k], e.start + e.duration * (k / (values.length - 1)));
    }
  }
}

/** Re-arm ONE native lane's envelope on its AudioParam from `fromSec`. Used by
 *  play/seek (via `scheduleAutomation`) and by a touch punch-out, which hands the
 *  param back to the lane the gesture just wrote into. */
function scheduleLaneNative(lane: AutomationLane, fromSec: number): void {
  const param = nativeParamFor(lane.target);
  if (!param) return;
  const now = getEngineCtx().currentTime;
  param.cancelScheduledValues(now);
  applyEnvelopeEvents(param, laneEnvelopeEvents(lane, fromSec, startCtxTime, startOffsetSec, now));
}

/** Schedule every enabled native lane's envelope from `fromSec`. */
function scheduleAutomation(fromSec: number): void {
  const ed = useEditorStore.getState();
  const holds = ed.automationHolds;
  for (const lane of ed.automationLanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    if (lane.target.kind !== 'trackVolume' && lane.target.kind !== 'trackPan') continue;
    // A HELD target is being ridden — by a hand on the fader, or by a latch/write
    // hold that outlives the release. Its param is where the hold put it, and
    // re-scheduling the lane here would fight the hold for the same AudioParam, so
    // the hold wins and the lane stays off it. `endAutomationPass` clears the
    // holds on stop/pause, so in practice this only fires for a SEEK taken during
    // a latch or write pass — which is exactly the case where the held value is
    // meant to keep running across the seek.
    if (holds[automationTargetKey(lane.target)]) continue;
    // One bad lane must not take the transport down with it. This runs inside
    // `start()` BEFORE `playing = true`, so an exception escaping here would leave
    // the sources already scheduled and audible with no clock, no playhead and a
    // Play button that thinks nothing is running. A lane that cannot be scheduled
    // is simply a lane that does not play.
    try {
      scheduleLaneNative(lane, fromSec);
    } catch (e) {
      logError('editor', `Automation lane skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** One lookahead frame: write each enabled FX lane's current value into its live
 *  effect param. Values are grouped per effect entry first, so a multi-param
 *  effect (e.g. OWL-Pad x + y) gets ONE merged update instead of competing
 *  single-key updates that would each reset the other key to its static value. */
function applyFxAutomationFrame(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const t = clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
  // Held targets first. A latch/write hold keeps writing its value forward into
  // its lane for as long as the transport rolls, and the FX pass below reads the
  // lanes — so the hold has to land before the read, not after it. This is a
  // no-op (same state object back) when nothing is held.
  useEditorStore.getState().advanceAutomationHolds(t);
  const ed = useEditorStore.getState();

  const byEntry = new Map<string, { master: boolean; trackId?: string; entryId: string; values: Record<string, number> }>();
  for (const lane of ed.automationLanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    const { kind, trackId, entryId, paramKey } = lane.target;
    if ((kind !== 'trackFx' && kind !== 'masterFx') || !entryId || !paramKey) continue;
    const v = sampleLane(lane, t);
    if (v == null) continue;
    const mapKey = `${kind}|${trackId ?? ''}|${entryId}`;
    let acc = byEntry.get(mapKey);
    if (!acc) { acc = { master: kind === 'masterFx', trackId, entryId, values: {} }; byEntry.set(mapKey, acc); }
    acc.values[paramKey] = v;
  }

  for (const acc of byEntry.values()) {
    if (acc.master) {
      if (!masterChain) continue;
      const entry = ed.masterFxChain.find((e) => e.id === acc.entryId);
      if (!entry || !entry.enabled) continue;
      masterChain.updateParams(acc.entryId, { ...entry.params, ...acc.values });
    } else {
      if (!acc.trackId) continue;
      const n = trackNodes.get(acc.trackId);
      const entry = ed.tracks.find((tr) => tr.id === acc.trackId)?.fxChain?.find((e) => e.id === acc.entryId);
      if (!n || !entry || !entry.enabled) continue;
      n.fx.updateParams(acc.entryId, { ...entry.params, ...acc.values });
    }
  }
}

function startFxAutomation(): void {
  stopFxAutomation();
  const ed = useEditorStore.getState();
  const hasFxLane = ed.automationLanes.some(
    (l) => l.enabled && (l.target.kind === 'trackFx' || l.target.kind === 'masterFx'),
  );
  // The same timer is the HOLD clock. An armed mode (touch/latch/write) has to run
  // it even in a project with no FX lane at all, because a latch or write hold
  // writes its value forward frame by frame — without the timer a held fader would
  // leave a single breakpoint at the moment it was released and nothing after it.
  if (hasFxLane || ed.automationMode !== 'read') {
    autoFxTimer = window.setInterval(applyFxAutomationFrame, 25); // ~40 Hz
  }
}

function stopFxAutomation(): void {
  if (autoFxTimer) { clearInterval(autoFxTimer); autoFxTimer = 0; }
}

/** Current transport position in timeline seconds (for recording timestamps). */
export function currentTransportSec(): number {
  if (!playing) return useEditorStore.getState().playheadSec;
  const ctx = getEngineCtx();
  return clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
}

/**
 * Drive a native (vol/pan) param live for the BEGIN and MOVE of a gesture, so the
 * move is heard the moment the hand makes it.
 *
 * It drops whatever the lane had scheduled ahead of now and glides the param to
 * `value` — and then the param simply STAYS there. That is all this function
 * decides; it is not a mode. What happens on RELEASE is the mode's business:
 * `touch` punches out through `automationReleaseNative`, which re-arms the lane,
 * while `latch` and `write` never call it, and the value left here is the hold.
 * The breakpoints themselves are written by the store, not here.
 *
 * (The comment this replaces claimed the call WAS latch behaviour. It was not:
 * nothing held after release and nothing punched out — D15.)
 */
export function automationTouchNative(target: AutomationTarget, value: number): void {
  if (!playing) return;
  const param = nativeParamFor(target);
  if (!param) return;
  const ctx = getEngineCtx();
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, RAMP_TC);
}

/**
 * Punch out of a gesture on a native target: hand the AudioParam back to its lane
 * by re-scheduling that ONE lane's envelope from the current transport position.
 *
 * Only `touch` calls this (see `holdsAfterRelease`) — in latch and write the
 * released value is supposed to keep running, so leaving the param exactly where
 * `automationTouchNative` left it IS the hold. Safe to call for a target with no
 * lane, a disabled lane, or a stopped transport: it does nothing.
 */
export function automationReleaseNative(target: AutomationTarget): void {
  if (!playing) return;
  if (target.kind !== 'trackVolume' && target.kind !== 'trackPan') return;
  const key = automationTargetKey(target);
  const lane = useEditorStore.getState().automationLanes.find(
    (l) => automationTargetKey(l.target) === key,
  );
  if (!lane || !lane.enabled || lane.points.length === 0) return;
  scheduleLaneNative(lane, currentTransportSec());
}

/**
 * Schedule live-synth note on/off for every MIDI clip at or after `fromSec`.
 * Notes fire via timers aligned to the transport (preview-accurate); the offline
 * export keeps using the sample-accurate render path. One synth channel per track
 * (16-channel cap); per-track volume/pan are not yet applied to MIDI, but mute and
 * solo are honored by skipping the track.
 */
function scheduleMidiClips(clips: AudioClip[], fromSec: number): void {
  const ed = useEditorStore.getState();
  const tracks = ed.tracks;
  const anySolo = tracks.some((t) => t.solo);
  const trackById = new Map<string, EditorTrack>(tracks.map((t): [string, EditorTrack] => [t.id, t]));
  const globalProgram = useSoundfontStore.getState().activeProgram;

  // One synth channel per track that has MIDI clips (16-channel cap).
  const channelOf = new Map<string, number>();
  let nextCh = 0;
  for (const clip of clips) {
    if (clip.muted || !isMidiClip(clip) || channelOf.has(clip.trackId)) continue;
    if (nextCh > 15) break;
    channelOf.set(clip.trackId, nextCh++);
  }

  // Point each of those channels at its track's gain node, so live MIDI runs
  // through the same fader -> insert FX -> panner -> master rack path its bounced
  // audio takes on export. Channels with no MIDI track stay on the engine master,
  // which is what the piano roll and MIDI panel preview through.
  for (const [trackId, ch] of channelOf) {
    const node = trackNodes.get(trackId);
    if (node) routeMidiChannel(ch, node.gain);
  }

  for (const clip of clips) {
    if (!isMidiClip(clip)) continue;
    // Clips muted before play schedule no notes; mute is ALSO re-checked at
    // note-fire time below, so muting a sounding clip lands mid-playback.
    if (clip.muted) continue;
    const track = trackById.get(clip.trackId);
    if (!track || effectiveVol(track, anySolo) <= 0) continue; // honor mute/solo
    const channel = channelOf.get(clip.trackId);
    if (channel === undefined) continue; // beyond the 16-instrument cap
    const program = clip.instrumentProgram ?? track.instrumentProgram ?? globalProgram;
    const bpm = clip.sourceBpm ?? ed.bpm ?? 120;
    const stepSec = 60 / Math.max(40, bpm) / 4;
    const offsetIntoSource = clip.offsetIntoSource ?? 0;
    for (const n of clip.sourcePianoRoll ?? []) {
      // Notes are positioned in SOURCE time; the clip is a window onto that
      // source. Subtract the trim offset and clamp to the clip's length, exactly
      // as MidiClipNotes does when drawing them. Without this, splitClipAt — which
      // copies the whole sourcePianoRoll into BOTH halves — made a split MIDI clip
      // play its entire pattern twice, while the on-screen notes showed it once.
      const relStart = n.step * stepSec - offsetIntoSource;
      const relEnd = relStart + Math.max(1, n.length) * stepSec;
      if (relEnd <= 0 || relStart >= clip.durationSec) continue; // outside this clip's window
      const onSec = clip.startSec + Math.max(0, relStart);
      // Clamp the note-off to the clip edge so a note running past the trim point
      // is cut there rather than sustaining beyond the clip.
      const offSec = clip.startSec + Math.min(clip.durationSec, relEnd);
      if (offSec <= fromSec || onSec < fromSec) continue; // finished, or already sounding
      const onDelay = Math.max(0, (onSec - fromSec) * 1000);
      const offDelay = Math.max(onDelay + 10, (offSec - fromSec) * 1000);
      const midi = n.note;
      const vel = n.velocity;
      const clipId = clip.id;
      midiTimers.push(window.setTimeout(() => {
        // Structural edits (moved/resized/added notes) still need a re-schedule,
        // but mute is re-read from the editor store at fire time so muting a
        // sounding MIDI clip lands mid-playback like an audio clip's gate.
        const live = useEditorStore.getState().clips.find((c) => c.id === clipId);
        if (live?.muted) return;
        liveNoteOn(channel, program, midi, vel);
      }, onDelay));
      // The note-off always fires: a note-off for a note that was skipped is
      // harmless, and skipping it would leave a stuck note when the clip is
      // muted between a note's on and off timers.
      midiTimers.push(window.setTimeout(() => liveNoteOff(channel, midi), offDelay));
    }
  }
}

/** Cancel pending MIDI note timers and silence the synth. */
function clearMidiTimers(): void {
  for (const id of midiTimers) clearTimeout(id);
  midiTimers = [];
  liveAllNotesOff();
}

/** Stop + disconnect every scheduled source (does not tear down track nodes). */
function clearSources(): void {
  for (const s of sources) {
    try { s.onended = null; s.stop(); s.disconnect(); } catch { /* already stopped */ }
  }
  sources = [];
  for (const g of clipMuteGains.values()) {
    try { g.disconnect(); } catch { /* already gone */ }
  }
  clipMuteGains = new Map();
  clearMidiTimers();
  // Release per-channel synth routing while the track nodes it points at are
  // still alive. clearSources() runs at the top of every start() and from
  // stop/pause/dispose, so this is always ahead of disposeTrackNodes().
  resetMidiRouting();
  stopFxAutomation();
}

function stopClock(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/** rAF transport clock — advances the playhead off the AudioContext clock. */
function tick(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const elapsed = startOffsetSec + (ctx.currentTime - startCtxTime);

  // Loop region (Phase F): cycle within [loopStart, loopEnd] when enabled + valid.
  const ed = useEditorStore.getState();
  const loopRegion = ed.loopEnabled && ed.loopEnd - ed.loopStart > 0.05;
  if (loopRegion && elapsed >= ed.loopEnd) {
    void start(ed.loopStart);
    return;
  }

  if (elapsed >= totalDur) {
    if (loopRegion) {
      void start(ed.loopStart); // region loop also catches the timeline end
      return;
    }
    if (usePlayerStore.getState().isLooping) {
      void start(0); // seamless-ish loop from the top
      return;
    }
    finishAtEnd();
    return;
  }

  // Playhead every frame (smooth line); footer time ~10 Hz is plenty.
  useEditorStore.getState().setPlayhead(elapsed);
  if (ctx.currentTime - lastTimePush > 0.1) {
    lastTimePush = ctx.currentTime;
    usePlayerStore.setState({ currentTime: elapsed });
  }
  rafId = requestAnimationFrame(tick);
}

/** Reached the end with looping off — park at end, mark stopped. */
function finishAtEnd(): void {
  clearSources();
  stopClock();
  playing = false;
  useEditorStore.getState().endAutomationPass(); // running off the end ends the pass too
  usePlayerStore.setState({ isPlaying: false, currentTime: totalDur });
  useEditorStore.getState().setPlayhead(totalDur);
}

/** (Re)start playback from `fromSec`. Decodes, builds nodes, schedules, runs. */
async function start(fromSec: number): Promise<void> {
  const token = ++playToken;
  const ed = useEditorStore.getState();
  const clips = ed.clips;
  if (clips.length === 0) return;

  totalDur = ed.getTotalDurationSec();
  const begin = fromSec >= totalDur - 0.05 ? 0 : Math.max(0, fromSec);

  // Tear down any previous run first.
  clearSources();
  stopClock();

  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* will retry on next gesture */ }
  }

  try {
    await ensureDecoded(clips);
  } catch (e) {
    logError('editor', `Live decode failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (token !== playToken) return; // superseded by a newer start()

  // Decide MIDI playback mode. Drive notes through the live synth only when the
  // user opted into a soundfont (global picker) or assigned an instrument to a
  // clip/track; otherwise keep playing the clip's bounced audio, so users who
  // never touch soundfonts see no behavior change or surprise soundfont load.
  const wantLiveMidi =
    clips.some(isMidiClip) &&
    (useSoundfontStore.getState().useSoundfont ||
      clips.some((c) => isMidiClip(c) && c.instrumentProgram !== undefined) ||
      ed.tracks.some((t) => t.instrumentProgram !== undefined));
  if (wantLiveMidi) {
    liveMidiActive = isLiveSynthReady() ? true : await ensureSoundfontReady();
    if (token !== playToken) return;
  } else {
    liveMidiActive = false;
  }

  // (Re)assert ourselves as the live transport — a library track played in the
  // meantime may have cleared it via playerStore.load().
  setLiveTransport({ play, pause, stop, seek });

  buildMasterBus();
  buildTrackNodes(ed.tracks);
  startCtxTime = ctx.currentTime;
  startOffsetSec = begin;
  lastTimePush = 0;
  lastMixSig = mixSignature(ed.tracks);
  lastClipMuteSig = clipMuteSignature(clips);
  scheduleClips(clips, begin);
  scheduleTeleports(clips, begin);
  scheduleAutomation(begin); // native vol/pan envelopes onto their AudioParams
  startFxAutomation();        // ~40 Hz lookahead writer for FX-param lanes
  if (liveMidiActive) scheduleMidiClips(clips, begin);

  playing = true;
  usePlayerStore.setState({
    isPlaying: true,
    duration: totalDur,
    currentTime: begin,
    currentLabel: 'Editor Timeline',
    currentEntryId: EDITOR_ENTRY_ID,
    hasTrack: true,
  });
  useEditorStore.getState().setPlayhead(begin);

  // Live mixer-param updates. Gate on the FX-bearing slices changing BY REFERENCE
  // so the 60Hz playhead tick (which only sets playheadSec, leaving tracks/
  // masterFxChain refs intact) never triggers the per-frame JSON.stringify
  // reconciliation. editorStore updates these slices immutably, so a real edit
  // always swaps the reference.
  if (!unsubEditor) {
    unsubEditor = useEditorStore.subscribe((state, prev) => {
      if (!playing) return;
      if (state.tracks !== prev.tracks) {
        const sig = mixSignature(state.tracks);
        if (sig !== lastMixSig) {
          lastMixSig = sig;
          applyMixLive();
        }
        applyTrackChainsLive(); // live per-track rack edits
      }
      if (state.masterFxChain !== prev.masterFxChain) {
        applyMasterChainLive(); // live master rack edits (add/remove/reorder/param)
      }
      // Arming (or disarming) a record mode MID-PLAYBACK. The hold clock's gate is
      // evaluated once per `start()`, so without this a user who presses play and
      // THEN picks latch, in a project with no FX lane, gets no timer at all and no
      // hold ever advances. Re-running the starter re-evaluates the gate in both
      // directions — it stops the timer again when the mode goes back to read and
      // nothing else needs it.
      if (state.automationMode !== prev.automationMode) {
        startFxAutomation();
        // Arming `write` mid-play has to mean what arming it before play means:
        // every enabled lane is seeded from here on. (`beginAutomationPass` is a
        // no-op in the other three modes, but the check keeps that visible.)
        if (state.automationMode === 'write') {
          useEditorStore.getState().beginAutomationPass(currentTransportSec());
        }
      }
      // Clip mute is the one clip property applied live; every other clip edit
      // is structural and lands on the next (re)schedule.
      if (state.clips !== prev.clips) {
        const sig = clipMuteSignature(state.clips);
        if (sig !== lastClipMuteSig) {
          lastClipMuteSig = sig;
          applyClipMutesLive();
        }
      }
    });
  }

  rafId = requestAnimationFrame(tick);
}

/* ------------------------------- public API ------------------------------- */

/** Open a record pass at `fromSec`. In `write` this arms every enabled lane so the
 *  pass overwrites what it rides over; every other mode is untouched by it. Both
 *  play entries do it — the footer transport calls `play`, the editor's own Play
 *  button calls `playAsync`, and a write pass has to start either way. Loop
 *  restarts and seeks go through `start` directly and so do NOT re-arm: they are
 *  the same pass. */
function beginPass(fromSec: number): void {
  useEditorStore.getState().beginAutomationPass(fromSec);
}

/** Begin live playback from the current editor playhead. */
export function play(): void {
  const from = useEditorStore.getState().playheadSec;
  beginPass(from);
  void start(from);
}

/** Awaitable play (resolves once decode + scheduling are done) — lets the
 *  editor show a brief "Rendering" state on the first play of new clips. */
export async function playAsync(): Promise<void> {
  const from = useEditorStore.getState().playheadSec;
  beginPass(from);
  await start(from);
}

/** Pause in place (keeps the playhead). */
export function pause(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const elapsed = clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
  clearSources();
  stopClock();
  playing = false;
  // The pass ends with the transport: holds are released, and a `write` mode
  // demotes itself to `latch` so the next play does not overwrite everything again.
  useEditorStore.getState().endAutomationPass();
  useEditorStore.getState().setPlayhead(elapsed);
  usePlayerStore.setState({ isPlaying: false, currentTime: elapsed });
}

/** Stop and rewind to 0. */
export function stop(): void {
  clearSources();
  stopClock();
  playing = false;
  useEditorStore.getState().endAutomationPass();
  useEditorStore.getState().setPlayhead(0);
  usePlayerStore.setState({ isPlaying: false, currentTime: 0 });
}

/** Seek to `sec`; reschedules from there if currently playing. */
export function seek(sec: number): void {
  const target = clamp(sec, 0, totalDur || useEditorStore.getState().getTotalDurationSec());
  useEditorStore.getState().setPlayhead(target);
  usePlayerStore.setState({ currentTime: target });
  if (playing) void start(target);
}

/** True while live playback is running. */
export function isPlaying(): boolean {
  return playing;
}

/** Re-assert liveMixer as the active transport after a frozen-master audition.
 *  Auditioning the rendered VST master loads a non-editor track into the player
 *  (which clears the live hook), so switching EDIT back to Live mode calls this
 *  to route the footer transport at the live multitrack mix again. */
export function reactivate(): void {
  setLiveTransport({ play, pause, stop, seek });
  usePlayerStore.setState({ currentEntryId: EDITOR_ENTRY_ID, currentLabel: 'Editor Timeline' });
}

/** Register this module as playerStore's live transport so the footer's normal
 *  transport buttons drive it. Call on editor mount. Returns an unregister. */
export function attach(): () => void {
  setLiveTransport({ play, pause, stop, seek });
  return () => {
    dispose();
  };
}

/** Tear everything down (editor unmount, or superseded by a library track). */
export function dispose(): void {
  clearSources();
  stopClock();
  playing = false;
  if (unsubEditor) { unsubEditor(); unsubEditor = null; }
  disposeTrackNodes();
  trackNodes = new Map();
  if (masterChain) { masterChain.dispose(); masterChain = null; }
  if (masterBus) { try { masterBus.disconnect(); } catch { /* gone */ } masterBus = null; }
  lastMasterSig = '';
  lastMasterFullSig = '';
  setLiveTransport(null);
  // Mirror stop()/pause() and leave the shared player store consistent. Without
  // this, a dispose() while rolling left `isPlaying` stuck true: the footer kept
  // rendering a Pause button forever, and pause() early-returns on `!playing`, so
  // pressing it could never clear the state — only a full Stop recovered.
  // Guarded on the entry id so disposing the editor mixer never clobbers the
  // transport state of a library track playing through the same store.
  if (usePlayerStore.getState().currentEntryId === EDITOR_ENTRY_ID) {
    usePlayerStore.setState({ isPlaying: false });
  }
}
