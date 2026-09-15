/**
 * renderCore — ONE offline bounce for the whole timeline.
 *
 * The editor grew three offline renderers, and all three were the same graph:
 * pin 44.1 kHz, size an `OfflineAudioContext` from the clip extents, decode
 * every clip through the shared cache, give each clip its schedule
 * (`computeClipSchedule`) + its fade envelope (`lib/clipFade`) + one
 * `BufferSource` per warp segment (`scheduleClipSources`), render, encode. What
 * actually differed between them was *fidelity*:
 *
 *   - `sendSelectionToInit`  — no insert FX, no automation, but track volume /
 *                              pan / mute DO apply. Ignores solo.
 *   - `commitEdit`           — everything: master + per-track racks, the
 *                              automation lanes, mute AND solo.
 *   - `renderTrackStem`      — the track's own rack (hosted VST3 entries
 *                              stripped, they print on the backend after), no
 *                              automation, and no track volume/pan/mute/solo
 *                              at all: a stem is the track's raw audio.
 *
 * So the graph lives here once and the differences are flags on a request. A
 * job queue can then own the request (T11c) rather than three call sites owning
 * three copies. Nothing about the rendered audio changes: every divergence the
 * three had is reproduced behind its flag (or, where the two are not separable,
 * behind the scope), and `renderCore.test.ts` pins each one.
 *
 * ONE deliberate difference, and it is an improvement: the three copies each
 * called `src.start(clip.startSec + seg.targetStart, …)` raw, so a clip at a
 * negative `startSec` threw a `RangeError` and failed the whole bounce. The
 * shared `scheduleClipSources` clamps that start to 0, so such a clip renders
 * from the top of the timeline instead.
 *
 * DESIGN SOURCE (read for its design only — NO code was copied from it):
 *   - Tracktion Engine `modules/tracktion_engine/model/export/
 *     tracktion_Renderer.h`, `Renderer::Parameters` (GPL-3.0 or commercial) —
 *     the shape of the idea: one flat, copyable parameter object that names the
 *     scope (`tracksToDo` / `allowedClips`), the format (`sampleRateForAudio`,
 *     `bitDepth`) and the tail (`endAllowance`), handed to a renderer that owns
 *     no policy of its own. `BounceRequest` is that idea in this app's terms.
 * That reference is copyleft. Every line here was written from the described
 * behaviour, or moved across from this repo's own `WaveformEditor.tsx`.
 */
import type { ChainEntry } from '../state/effectChainStore';
import { sampleLane, type AudioClip, type AutomationLane, type EditorTrack } from '../state/editorStore';
import { scheduleClipSources } from '../state/liveMixer';
import { sliceChunks as defaultSliceChunks, type AudioChunk } from './audioAnalysis';
import {
  SPATIAL_TELEPORT, buildEffectChain, ensureChopModule, teleportXYZ, type ChainHandle,
} from './rackEffects';
import { encodeWav } from './wavEncode';

/** The rate every offline bounce pins. Decoded buffers are cached per rate
 *  (`lib/decodeCache`), so a bounce never inherits the output device's rate. */
export const BOUNCE_SAMPLE_RATE = 44100;

/** Channel count of every bounce. All three renderers hard-coded stereo. */
const BOUNCE_CHANNELS = 2;

/** What a bounce covers. The three variants are the three call sites:
 *  the whole timeline, one track (a freeze stem), or a hand-picked selection. */
export type BounceScope =
  | { kind: 'master' }
  | { kind: 'track'; trackId: string }
  | { kind: 'selection'; clipIds: string[] };

/**
 * Everything one bounce needs to know, and nothing about where the audio goes.
 *
 * The four booleans are the fidelity dial. They are independent, but today's
 * three call sites only use three of the combinations — see the module header.
 */
export interface BounceRequest {
  scope: BounceScope;
  /** 44100 today, everywhere. */
  sampleRate: number;
  /** Build the master + per-track insert racks. */
  includeFx: boolean;
  /** Bake the automation lanes: native volume/pan on an AudioParam timeline,
   *  rack params stepped through `suspend`/`resume`, and the spatializer's
   *  onset-driven teleport schedule — the three things the live engine drives
   *  in real time and an offline render has to write out in advance. */
  includeAutomation: boolean;
  /** Apply the track mix: volume, pan, mute (and solo — see `honoursSolo`). */
  includeTrackMix: boolean;
  /** Encode the result as 32-bit float rather than 16-bit PCM. Read only by
   *  `encodeBounce`; the render itself is float either way. */
  float32: boolean;
  /** Extra seconds past the clip extent, for tails to decay into. No call site
   *  sets it today, so it is 0 and the render length is unchanged. */
  tailSec?: number;
}

/** An `AudioContext` used only to decode (and then closed). */
export type DecodeContext = BaseAudioContext & { close(): Promise<void> };

/**
 * The world the render reads. An explicit seam, so the graph can be driven by
 * a stand-in context in a test — the real `OfflineAudioContext`,
 * `AudioContext`, worklet registration and onset analysis are all unavailable
 * under Node.
 *
 * The first seven fields are what the app passes. The last four are optional
 * and default to the real implementations, so a production call site passes
 * only the seven.
 */
export interface RenderDeps {
  clips: AudioClip[];
  tracks: EditorTrack[];
  masterFxChain: ChainEntry[];
  /** The raw lane list; `renderBounce` applies the same
   *  `enabled && points.length > 0` filter `commitEdit` did. */
  automationLanes: AutomationLane[];
  decode: (ctx: BaseAudioContext, blob: Blob) => Promise<AudioBuffer>;
  buildChain: typeof buildEffectChain;
  scheduleSources: typeof scheduleClipSources;
  makeContext?: (channels: number, length: number, rate: number) => OfflineAudioContext;
  /** Decoding runs on a real `AudioContext`, not the offline one — more
   *  reliable than `OfflineAudioContext.decodeAudioData`, and it is what all
   *  three renderers did. Closed as soon as the last clip is decoded. */
  makeDecodeContext?: (rate: number) => DecodeContext;
  /** Register the chop worklet on the render context before the rack is built,
   *  so an enabled chop entry bakes in instead of degrading to passthrough. */
  ensureChop?: (ctx: BaseAudioContext) => Promise<void>;
  /** Onset slicing, for the spatializer's teleport schedule. */
  sliceChunks?: (buf: AudioBuffer) => AudioChunk[];
}

/* ── Scope ────────────────────────────────────────────────────────────────── */

/** The clips a scope covers, in timeline order (the order `clips` is in — the
 *  selection scope filters, it does not reorder to match `clipIds`). */
export function clipsInScope(clips: AudioClip[], scope: BounceScope): AudioClip[] {
  if (scope.kind === 'master') return clips;
  if (scope.kind === 'track') return clips.filter((c) => c.trackId === scope.trackId);
  const wanted = new Set(scope.clipIds);
  return clips.filter((c) => wanted.has(c.id));
}

/**
 * How long the render is, in seconds — `max(startSec + durationSec)` over the
 * scope's clips, against a floor.
 *
 * The three renderers do NOT agree on that floor and this preserves all three:
 * the master bounce reads `editorStore.getTotalDurationSec` (60 s for an empty
 * timeline, otherwise at least 30 s), the selection bounce floors at 1 s, and a
 * track stem at 0.1 s. Each is the length its own consumer has always got.
 */
export function renderExtentSec(clips: AudioClip[], scope: BounceScope): number {
  const scoped = clipsInScope(clips, scope);
  if (scope.kind === 'master') {
    if (clips.length === 0) return 60;
    return Math.max(...scoped.map((c) => c.startSec + c.durationSec), 30);
  }
  const floor = scope.kind === 'selection' ? 1 : 0.1;
  if (scoped.length === 0) return floor;
  return Math.max(...scoped.map((c) => c.startSec + c.durationSec), floor);
}

/* ── Render ───────────────────────────────────────────────────────────────── */

/** Write a lane onto a native AudioParam. The offline context renders from
 *  t = 0, so a breakpoint's timeline time IS its param time. The first value is
 *  held until its own breakpoint, then every later one is a linear ramp; the
 *  `1e-4` nudge keeps two breakpoints at the same instant in order. */
const scheduleParamLane = (
  param: AudioParam, lane: AutomationLane, clampFn: (v: number) => number,
): void => {
  const pts = lane.points;
  param.setValueAtTime(clampFn(pts[0].v), 0);
  if (pts[0].t > 0) param.setValueAtTime(clampFn(pts[0].v), pts[0].t);
  for (let i = 1; i < pts.length; i += 1) {
    param.linearRampToValueAtTime(clampFn(pts[i].v), Math.max(pts[i].t, pts[i - 1].t + 1e-4));
  }
};

interface TrackNodes {
  gain: GainNode;
  /** Only when `includeTrackMix`. A track stem has none — inserting a
   *  `StereoPannerNode` at pan 0 would still down-mix a mono source by 3 dB. */
  panner: StereoPannerNode | null;
  fx: ChainHandle | null;
}

/** `-1 <= pan <= 1`, the clamp all three renderers applied. */
const clampPan = (v: number): number => Math.max(-1, Math.min(1, v));

/**
 * Render one bounce and hand back the raw buffer. The caller owns what happens
 * next (library import, Save As, the backend VST3 hops, peaks) — this owns the
 * graph and nothing else.
 *
 * Rejects if any clip in scope fails to decode, exactly as the three renderers
 * did: they primed every clip through the cache up front, muted ones included,
 * so a clip that will not decode has always failed the whole bounce.
 */
export async function renderBounce(req: BounceRequest, deps: RenderDeps): Promise<AudioBuffer> {
  const { scope } = req;
  const sr = req.sampleRate;
  const scoped = clipsInScope(deps.clips, scope);
  const lengthSec = renderExtentSec(deps.clips, scope) + Math.max(0, req.tailSec ?? 0);

  const makeContext = deps.makeContext
    ?? ((channels, length, rate) => new OfflineAudioContext(channels, length, rate));
  const ctx = makeContext(BOUNCE_CHANNELS, Math.ceil(lengthSec * sr), sr);

  // ── Decode ───────────────────────────────────────────────────────────────
  const makeDecodeContext = deps.makeDecodeContext
    ?? ((rate: number) => new AudioContext({ sampleRate: rate }) as DecodeContext);
  const decodeCtx = makeDecodeContext(sr);
  const buffers = new Map<Blob, AudioBuffer>();
  try {
    for (const clip of scoped) {
      buffers.set(clip.audioBlob, await deps.decode(decodeCtx, clip.audioBlob));
    }
  } finally {
    decodeCtx.close().catch(() => {});
  }

  // ── Which tracks, and which of their entries ─────────────────────────────
  const trackUniverse = scope.kind === 'track'
    ? deps.tracks.filter((t) => t.id === scope.trackId)
    : deps.tracks;

  /** A track stem strips hosted VST3 entries: they cannot run in the browser
   *  and the consumer posts the stem through them on the backend afterwards.
   *  The master bounce leaves them in — `buildEffectChain` reports them as
   *  inert passthroughs, which is what the UI reads. */
  const chainFor = (t: EditorTrack): ChainEntry[] => (scope.kind === 'track'
    ? (t.fxChain ?? []).filter((e) => e.effect !== 'vst3')
    : (t.fxChain ?? []));

  /** A track stem has no master bus to run a master rack on. */
  const useMasterFx = req.includeFx && scope.kind !== 'track';

  const anySolo = deps.tracks.some((t) => t.solo);
  const honoursMute = req.includeTrackMix;
  /** Solo is a monitoring decision about the master bus, and only the master
   *  bounce has ever acted on it — `sendSelectionToInit` bounces exactly what
   *  was selected and checks `track.mute` alone. Preserved, not fixed. */
  const honoursSolo = req.includeTrackMix && scope.kind === 'master';

  // ── The chop worklet, before any rack is built ───────────────────────────
  if (req.includeFx) {
    const candidates = [
      ...(useMasterFx ? [deps.masterFxChain] : []),
      ...trackUniverse.map(chainFor),
    ];
    if (candidates.some((ch) => ch.some((e) => e.effect === 'chop' && e.enabled))) {
      const ensureChop = deps.ensureChop ?? ensureChopModule;
      try { await ensureChop(ctx); } catch { /* falls back to passthrough */ }
    }
  }

  // ── Master bus ───────────────────────────────────────────────────────────
  const chains: ChainHandle[] = [];
  const masterBus = ctx.createGain();
  let masterFx: ChainHandle | null = null;
  if (useMasterFx) {
    masterFx = deps.buildChain(ctx, masterBus, ctx.destination, deps.masterFxChain);
    chains.push(masterFx);
  } else {
    masterBus.connect(ctx.destination);
  }

  const lanes = req.includeAutomation
    ? deps.automationLanes.filter((l) => l.enabled && l.points.length > 0)
    : [];

  /**
   * The selection bounce built a gain AND a panner for every CLIP, not one pair
   * per track, and that is not the same audio: a mono clip sharing a track
   * gain with a stereo one is up-mixed to stereo (`channelCountMode: 'max'`)
   * before it reaches a shared panner, so it hits the stereo pan law instead of
   * the mono one — about +3 dB at centre. So the per-clip shape is kept for the
   * selection scope. It is only possible without a rack: an insert chain is a
   * per-track object, so `includeFx` puts the mix back on the track.
   */
  const perClipMix = scope.kind === 'selection' && req.includeTrackMix && !req.includeFx;

  /** gain (track volume) -> panner (track pan) -> master bus, for ONE clip. */
  const makeClipMix = (trk: EditorTrack): GainNode => {
    const gain = ctx.createGain();
    gain.gain.value = trk.volume;
    const panner = ctx.createStereoPanner();
    panner.pan.value = clampPan(trk.pan);
    gain.connect(panner).connect(masterBus);
    return gain;
  };

  // ── One fader + rack + panner per audible track ──────────────────────────
  const audibleTracks = new Map<string, EditorTrack>();
  const trackNodeById = new Map<string, TrackNodes>();
  for (const trk of trackUniverse) {
    if (honoursMute && trk.mute) continue;
    if (honoursSolo && anySolo && !trk.solo) continue;
    audibleTracks.set(trk.id, trk);
    if (perClipMix) continue; // the mix nodes are built per clip instead

    const gain = ctx.createGain();
    let panner: StereoPannerNode | null = null;
    if (req.includeTrackMix) {
      const volLane = lanes.find((l) => l.target.kind === 'trackVolume' && l.target.trackId === trk.id);
      if (volLane) scheduleParamLane(gain.gain, volLane, (v) => Math.max(0, v));
      else gain.gain.value = trk.volume;

      panner = ctx.createStereoPanner();
      const panLane = lanes.find((l) => l.target.kind === 'trackPan' && l.target.trackId === trk.id);
      if (panLane) scheduleParamLane(panner.pan, panLane, clampPan);
      else panner.pan.value = clampPan(trk.pan);
    }

    // gain -> [rack] -> panner -> masterBus, with the panner dropped when the
    // track mix is off (the rack then feeds the bus directly).
    const tail: AudioNode = panner ?? masterBus;
    let fx: ChainHandle | null = null;
    if (req.includeFx) {
      fx = deps.buildChain(ctx, gain, tail, chainFor(trk));
      chains.push(fx);
    } else {
      gain.connect(tail);
    }
    panner?.connect(masterBus);
    trackNodeById.set(trk.id, { gain, panner, fx });
  }

  // ── The clips ────────────────────────────────────────────────────────────
  for (const clip of scoped) {
    if (clip.muted) continue; // muted clips are excluded, matching live playback
    const trk = audibleTracks.get(clip.trackId);
    if (!trk) continue; // no such track, or it is muted / hidden by a solo
    const buf = buffers.get(clip.audioBlob);
    if (!buf) continue;
    const destination = perClipMix ? makeClipMix(trk) : trackNodeById.get(trk.id)?.gain;
    if (!destination) continue;
    // `nowSec` = `fromSec` = 0: the offline context renders from the top, so a
    // clip's timeline time IS its context time. The clip's own gain rides the
    // fade envelope (`clipPeakGain`, NOT the track volume); the track fader is
    // a node of its own, so per-track inserts process the post-fade signal.
    deps.scheduleSources(ctx, clip, buf, destination, 0, 0);
  }

  // ── Spatializer teleport ─────────────────────────────────────────────────
  // The live preview jumps the panner on each onset; offline there is no rAF
  // loop, so the same jumps are written out as scheduled values.
  if (req.includeFx && req.includeAutomation) {
    const slice = deps.sliceChunks ?? defaultSliceChunks;
    const chunkCache = new Map<Blob, AudioChunk[]>();
    for (const trk of trackUniverse) {
      const nodes = trackNodeById.get(trk.id);
      if (!nodes?.fx) continue;
      const teleEntries = chainFor(trk).filter(
        (e) => e.enabled && e.effect === 'spatializer'
          && Math.round(e.params?.motion ?? 0) === SPATIAL_TELEPORT,
      );
      if (teleEntries.length === 0) continue;
      const insts = nodes.fx.instances();
      // Muted clips render no audio, so their onsets must not drive jumps.
      const trackClips = scoped.filter((c) => c.trackId === trk.id && !c.muted);
      for (const teleEntry of teleEntries) {
        const li = insts.find((x) => x.id === teleEntry.id);
        if (!li?.inst.scheduleTeleport) continue;
        const spread = teleEntry.params?.motionDepth ?? 5;
        const events: { when: number; x: number; y: number; z: number }[] = [];
        let idx = 0;
        for (const c of trackClips) {
          const buf = buffers.get(c.audioBlob);
          if (!buf) continue;
          const offset = Math.min(c.offsetIntoSource, Math.max(0, buf.duration - 0.01));
          const cdur = Math.min(c.durationSec, buf.duration - offset);
          if (cdur <= 0) continue;
          let chunks = chunkCache.get(c.audioBlob);
          if (!chunks) { chunks = slice(buf); chunkCache.set(c.audioBlob, chunks); }
          for (const chunk of chunks) {
            if (chunk.tSec < offset || chunk.tSec >= offset + cdur) continue;
            const pos = teleportXYZ(idx, chunk.loudness, chunk.brightness, spread);
            events.push({ when: c.startSec + (chunk.tSec - offset), x: pos.x, y: pos.y, z: pos.z });
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

  // ── Rack-param automation ────────────────────────────────────────────────
  // Rack params are plain numbers, not AudioParams, so they cannot ride a
  // timeline. The render is suspended on each breakpoint's render quantum and
  // the merged params pushed in. Native volume/pan were scheduled above.
  const fxTargets: {
    handle: ChainHandle;
    entryId: string;
    baseParams: Record<string, number>;
    lanes: AutomationLane[];
  }[] = [];
  if (req.includeAutomation && req.includeFx) {
    const groupFx = (
      kind: 'trackFx' | 'masterFx', handle: ChainHandle, chain: ChainEntry[], trackId?: string,
    ) => {
      for (const e of chain) {
        if (!e.enabled) continue;
        const entryLanes = lanes.filter(
          (l) => l.target.kind === kind && l.target.entryId === e.id
            && (kind === 'masterFx' || l.target.trackId === trackId),
        );
        if (entryLanes.length > 0) {
          fxTargets.push({ handle, entryId: e.id, baseParams: e.params, lanes: entryLanes });
        }
      }
    };
    if (masterFx) groupFx('masterFx', masterFx, deps.masterFxChain);
    for (const trk of trackUniverse) {
      const nodes = trackNodeById.get(trk.id);
      if (!nodes?.fx) continue;
      groupFx('trackFx', nodes.fx, chainFor(trk), trk.id);
    }
  }

  if (fxTargets.length > 0) {
    const applyFxAt = (t: number) => {
      for (const tgt of fxTargets) {
        const merged: Record<string, number> = { ...tgt.baseParams };
        for (const lane of tgt.lanes) {
          const v = sampleLane(lane, t);
          if (v != null && lane.target.paramKey) merged[lane.target.paramKey] = v;
        }
        tgt.handle.updateParams(tgt.entryId, merged);
      }
    };
    applyFxAt(0); // initial state at the top of the render
    // Union of breakpoint times, quantised to the render quantum, in (0, length).
    const q = 128 / sr;
    const times = new Set<number>();
    for (const tgt of fxTargets) {
      for (const lane of tgt.lanes) {
        for (const p of lane.points) {
          if (p.t <= 0 || p.t >= lengthSec) continue;
          times.add(Math.min(lengthSec - q, Math.ceil(p.t / q) * q));
        }
      }
    }
    for (const tq of [...times].sort((a, b) => a - b)) {
      if (tq <= 0 || tq >= lengthSec) continue;
      ctx.suspend(tq).then(() => { applyFxAt(tq); ctx.resume(); }).catch(() => {});
    }
  }

  try {
    return await ctx.startRendering();
  } finally {
    // `renderTrackStem` disposed its chain and the other two leaked theirs.
    // Disposal happens after the render has finished, so it cannot change a
    // sample — it only stops the oscillators and worklets the rack built.
    for (const handle of chains) {
      try { handle.dispose(); } catch { /* already gone */ }
    }
  }
}

/** Encode a rendered bounce, per the request that produced it. 16-bit PCM
 *  unless `float32`, which is for the hops where the audio is handed straight
 *  to another processor (the VST3 chain) rather than stored. Taking the request
 *  rather than a loose boolean keeps the format decision on the request object,
 *  so a job queue that owns the request owns the encoding too. */
export function encodeBounce(buffer: AudioBuffer, req: Pick<BounceRequest, 'float32'>): Blob {
  return encodeWav(buffer, { float32: req.float32 });
}
