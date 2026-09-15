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
 * SINCE T14 the bounce is no longer flat. Buses and sends are edges of
 * `state/routingGraph`, and the offline graph is wired by the SAME pass the
 * live mixer uses (`liveMixer.wireRoutingGraph`) rather than by a second copy
 * of the rule — a mix that plays through a bus now prints through it. Only the
 * MASTER scope walks the graph: a track stem and a clip selection are
 * pre-routing by definition (see `renderBounce`). The printed file is then
 * shifted forward by the largest latency the chains it built declare
 * (`trimLeadingSec`), so the SLOWEST path lands where live playback puts it.
 *
 * That last claim is deliberately narrow. Live playback compensates PER TRACK
 * (`liveMixer.applyCompDelays` holds `max - own` on each strip), so every track
 * arrives together, `maxSec` late, and §3.8's transport reads back by `maxSec`.
 * This render inserts no compensation delays at all — it never has — so track i
 * still prints at `own_i`, and taking `maxSec` off the front lands the slowest
 * path exactly and prints every other track `maxSec - own_i` EARLY. A dry track
 * sitting next to one compressed track therefore moves from exact to 6 ms early.
 * The inter-track skew is unchanged by T14, only its offset is: before, the
 * fastest track was exact and the slowest 6 ms late. The case that matters is
 * the one this fixes outright — a freeze STEM is re-placed on the timeline by
 * `editorStore.freezeTrack`, and a stem is one path, so its trim is exact.
 * Closing the skew means giving the offline graph the same per-track comp
 * delays live has; that is a follow-up, not something this file pretends to do.
 *
 * DESIGN SOURCES (read for their design only — NO code was copied from either):
 *   - Tracktion Engine `modules/tracktion_engine/model/export/
 *     tracktion_Renderer.h`, `Renderer::Parameters` (GPL-3.0 or commercial) —
 *     the shape of the idea: one flat, copyable parameter object that names the
 *     scope (`tracksToDo` / `allowedClips`), the format (`sampleRateForAudio`,
 *     `bitDepth`) and the tail (`endAllowance`), handed to a renderer that owns
 *     no policy of its own. `BounceRequest` is that idea in this app's terms.
 *   - The summing/bus rule this file now renders is NOT re-derived here: it is
 *     `state/routingGraph.ts`'s and `state/liveMixer.ts`'s, whose headers cite
 *     Ardour `libs/ardour/internal_return.cc` (GPL-2.0-or-later) and Stargate
 *     `src/sglib/models/daw/routing/graph.py` (GPL-3.0) as the DESIGN source of
 *     "a bus is a normal node that sums its inputs, and a send is a post-fader
 *     tap with its own gain". Neither reference was reopened for this file, and
 *     nothing from either is present in it — this module calls the repo's own
 *     `wireRoutingGraph` and adds no routing rule of its own.
 * Those references are copyleft. Every line here was written from the described
 * behaviour, or moved across from this repo's own `WaveformEditor.tsx`.
 */
import type { ChainEntry } from '../state/effectChainStore';
import {
  sampleLane, type AudioClip, type AutomationLane, type EditorBus, type EditorTrack,
} from '../state/editorStore';
import {
  applyEnvelopeEvents, laneEnvelopeEvents, scheduleClipSources, trackCompDelays, wireRoutingGraph,
  type RoutingEndpoints,
} from '../state/liveMixer';
import { MASTER_ID, topoOrder, type RoutingGraph } from '../state/routingGraph';
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
 * The first nine fields are what the app passes (two of them — the routing
 * graph and its buses — optional, and absent in a document that has neither).
 * The last four are optional and default to the real implementations, so a
 * production call site passes only the document and the three seams.
 */
export interface RenderDeps {
  clips: AudioClip[];
  tracks: EditorTrack[];
  masterFxChain: ChainEntry[];
  /** The raw lane list; `renderBounce` applies the same
   *  `enabled && points.length > 0` filter `commitEdit` did. */
  automationLanes: AutomationLane[];
  /**
   * Where the signal goes: `editorStore.routing`. OPTIONAL, and absent means
   * the pre-batch-6 flat render — every track straight to one master bus, no
   * bus strips, no sends. That is not a fallback nobody reaches: it is what a
   * caller with no document routing (a test, a tool) should get, and it is what
   * keeps a routing-less project bit-identical to what it always rendered.
   * Read ONLY by the master scope; see `renderBounce`.
   */
  routing?: RoutingGraph;
  /** The bus strips the graph refers to: `editorStore.buses`. Absent (or empty)
   *  with a `routing` present is legal — a graph of tracks and a master. */
  buses?: EditorBus[];
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

/**
 * Write a lane onto a native AudioParam — the SAME event list live playback
 * puts on that param (`liveMixer.laneEnvelopeEvents`), with the offline
 * pinning: the render starts at t = 0 and the context clock IS the timeline, so
 * `fromSec` / `startCtxTime` / `startOffset` / `now` are all 0.
 *
 * This used to be a hand-written loop here — a `setValueAtTime` for the first
 * value, a hold to its breakpoint, then one `linearRampToValueAtTime` per later
 * point. For a lane with no curves that loop and the envelope agree (a hold is
 * emitted as a flat ramp instead of a second `set`, which is the same audio),
 * but a CURVED breakpoint flattened to a straight line, and every mixdown and
 * VST freeze exported automation the user could not hear in preview. The
 * component's `commitEdit` had already been moved onto the envelope builder;
 * this had not, so adopting the core would have put the bug back. One rule, one
 * implementation: the clamp reaches inside a curve too, which is why it is
 * passed down rather than applied to the points up front.
 */
const scheduleParamLane = (
  param: AudioParam, lane: AutomationLane, clampFn: (v: number) => number,
): void => {
  applyEnvelopeEvents(param, laneEnvelopeEvents(lane, 0, 0, 0, 0), clampFn);
};

interface TrackNodes {
  gain: GainNode;
  /** Only when `includeTrackMix`. A track stem has none — inserting a
   *  `StereoPannerNode` at pan 0 would still down-mix a mono source by 3 dB. */
  panner: StereoPannerNode | null;
  fx: ChainHandle | null;
  /** What this track FEEDS DOWNSTREAM — the panner when there is one, else the
   *  rack's (or the fader's) own output. Handed to `wireRoutingGraph` as the
   *  strip's `outputNodeOf`; the live mixer hands it the comp delay, which is
   *  the same position in the strip (there are no comp delays offline — see
   *  `trimLeadingSec`). */
  tail: AudioNode;
}

/** One bus strip, offline. The shape MIRRORS `liveMixer.createBusNodes`:
 *  `input -> [fx] -> gain -> muteGain -> output`, with the output left
 *  unconnected because where a bus goes is a property of the graph. It is
 *  mirrored rather than called because a bounce's rack builder is the injected
 *  `deps.buildChain` (a test drives a stand-in through it) and because the two
 *  fidelity flags apply: `includeFx` decides whether the rack exists at all and
 *  `includeTrackMix` whether the fader and the mute are honoured. */
interface BusStrip {
  input: GainNode;
  output: GainNode;
}

/** `-1 <= pan <= 1`, the clamp all three renderers applied. */
const clampPan = (v: number): number => Math.max(-1, Math.min(1, v));

/** `0 <= volume <= 1`, the clamp `liveMixer.createBusNodes` applies to a bus. */
const clampGain = (v: number): number => Math.max(0, Math.min(1, v));

/** A chain as the latency math reads it: an id and the entries that were built. */
interface RenderedChain {
  id: string;
  fxChain: ChainEntry[];
}

/**
 * How far the printed file lags the timeline, in seconds: the largest declared
 * latency along any path the render actually built, which is exactly what
 * `liveMixer.trackLatencyReport().maxSec` reports for live playback.
 *
 * It is computed over the chains that WERE built, not over the document: a
 * muted track, a track a solo silenced, and every chain under `includeFx: false`
 * contribute nothing to the file and so must not move it.
 *
 * The MASTER rack is deliberately absent, for the same reason it is absent from
 * the live figure — it is downstream of the sum, so it lags every track equally
 * and compensating for it would be compensating for the whole mix twice.
 */
function renderLatencySec(
  tracks: RenderedChain[], sampleRate: number, routing?: { graph: RoutingGraph; buses: RenderedChain[] },
): number {
  let max = 0;
  for (const row of trackCompDelays(tracks, undefined, sampleRate, routing)) {
    if (row.latencySec > max) max = row.latencySec;
  }
  return max;
}

/**
 * Shift a rendered bounce forward by `sec`, keeping its LENGTH.
 *
 * Live playback is latency-compensated (`liveMixer.applyCompDelays`): every
 * track is delayed to meet the slowest one, so the mix arrives `maxSec` late
 * and §3.8's transport reads back by the same amount. An offline render has no
 * transport to read back, so the lag its racks impose is printed into the file
 * and a bounce of a compressed mix lands late against the timeline it came
 * from. This takes it off the front.
 *
 * WHAT IT DOES NOT DO. There are no per-track compensation delays in the
 * offline graph, so this is ONE offset on a mix whose tracks are not aligned
 * with each other: at `sec = maxSec` the slowest path lands exactly and every
 * other track prints `maxSec - own` EARLY. The skew between two tracks is
 * exactly what it was before the trim existed — a dry track beside a compressed
 * one is 6 ms out either way — and only which of the two is exact has changed.
 * A single-path render (a freeze stem) has no skew to have, so its trim is
 * exact. Removing the skew needs comp delays offline; see the module header.
 *
 * PURE: no context, no store — a buffer and a number go in, a new buffer comes
 * out and the input is untouched. The length is preserved by zero-padding the
 * tail rather than by returning a shorter buffer, because the length is the
 * bounce's contract: `renderExtentSec` is what the library entry, the freeze
 * stem and the Save As all report, and a file 265 samples short of it would
 * disagree with every one of them.
 *
 * `sec <= 0` hands back the SAME buffer, so a project that declares no latency
 * is not merely close to unchanged — it is the identical object the context
 * rendered, never copied and never re-quantised.
 */
export function trimLeadingSec(buffer: AudioBuffer, sec: number): AudioBuffer {
  // Nearest sample: a declaration is a time, not a sample count, and 6 ms at
  // 44.1 kHz is 264.6 samples. Rounding down would leave a fraction of the lag
  // in every file.
  const skip = Math.round(Math.max(0, sec) * buffer.sampleRate);
  if (skip <= 0) return buffer;
  const { length, sampleRate, numberOfChannels } = buffer;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    const out = new Float32Array(length); // zero-filled: the pad is free
    if (skip < length) out.set(buffer.getChannelData(ch).subarray(skip, length), 0);
    channels.push(out);
  }
  // A plain object rather than `ctx.createBuffer`: this function is pure, and
  // the only surface a bounce is read through downstream is `lib/wavEncode`'s
  // (`numberOfChannels` / `length` / `sampleRate` / `getChannelData`) plus
  // `duration`, which the call sites report. One cast, stated here.
  return {
    duration: length / sampleRate,
    length,
    sampleRate,
    numberOfChannels,
    getChannelData: (ch: number) => channels[ch],
  } as unknown as AudioBuffer;
}

/**
 * Render one bounce and hand back the raw buffer. The caller owns what happens
 * next (library import, Save As, the backend VST3 hops, peaks) — this owns the
 * graph and nothing else.
 *
 * Rejects if any clip in scope fails to decode, exactly as the three renderers
 * did: they primed every clip through the cache up front, muted ones included,
 * so a clip that will not decode has always failed the whole bounce.
 *
 * RETURN TYPE, stated rather than narrowed: when the trim fires this is a
 * structural stand-in cast to `AudioBuffer` (see `trimLeadingSec`), not a real
 * one. It stays declared as `AudioBuffer` because the type is load-bearing for
 * `lib/wavEncode.encodeWav`, which takes an `AudioBuffer`; narrowing here would
 * push the same cast into that file and into every call site instead of keeping
 * it in the one function that creates the object. Everything downstream reads
 * only `duration`, `length`, `sampleRate`, `numberOfChannels` and
 * `getChannelData` — a consumer that reaches for `copyFromChannel` or
 * `copyToChannel` would be the first, and would need this widened to a real
 * buffer (an `OfflineAudioContext.createBuffer`) rather than the cast removed.
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

  /**
   * Whether this bounce walks the routing graph.
   *
   * ONLY the master scope does, and the other two are not oversights:
   *
   *  - A `track` scope is a freeze STEM, and a stem is pre-routing by
   *    definition — it is the track's own audio, to be re-summed by whatever
   *    consumes it, so sending it through the drum bus (and that bus's rack,
   *    and its fader) would print the bus twice the moment the stem is played
   *    back through the same mix. It also renders with no master bus rack and
   *    ignores mute and solo for the same reason.
   *  - A `selection` scope is Send Selection to Init: the picked clips, mixed
   *    as the user balanced them, handed to MAKE as a source. It has always
   *    been a per-clip mix straight to the master (see `perClipMix` below), and
   *    the selection is not a mix position — it is a set of clips that may not
   *    even share a destination.
   *
   * Absent `deps.routing`, the master scope renders the pre-batch-6 flat graph.
   */
  const routingActive = scope.kind === 'master' && !!deps.routing;

  // ── Bus strips ───────────────────────────────────────────────────────────
  // Built before the tracks so every destination exists by the time the wiring
  // pass runs. Each is `liveMixer.createBusNodes`'s shape (see `BusStrip`).
  const busStrips = new Map<string, BusStrip>();
  const renderedBusChains: RenderedChain[] = [];
  if (routingActive) {
    for (const b of deps.buses ?? []) {
      const input = ctx.createGain();
      const gain = ctx.createGain();
      gain.gain.value = req.includeTrackMix ? clampGain(b.volume) : 1;
      const muteGain = ctx.createGain();
      // Opened at the stored value, as the live strip is: a bounce of a project
      // with a muted bus is muted from its first sample.
      muteGain.gain.value = req.includeTrackMix && b.mute ? 0 : 1;
      const output = ctx.createGain();
      const chain = b.fxChain ?? [];
      if (req.includeFx) {
        const fx = deps.buildChain(ctx, input, gain, chain); // input -> [fx] -> gain
        chains.push(fx);
        renderedBusChains.push({ id: b.id, fxChain: chain });
      } else {
        input.connect(gain);
      }
      gain.connect(muteGain).connect(output);
      busStrips.set(b.id, { input, output });
    }
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
  const renderedTrackChains: RenderedChain[] = [];
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

    // gain -> [rack] -> panner -> (wherever the graph says), with the panner
    // dropped when the track mix is off. Without routing that destination is
    // the master bus and the rack feeds it directly, exactly as before; WITH
    // routing the tail is left unconnected for `wireRoutingGraph` to place, and
    // a strip with no panner gets an explicit unity gain to be placed BY — a
    // node the pass can connect, where `masterBus` would have been the
    // hard-wired destination this ticket exists to remove. A unity `GainNode`
    // is transparent (`gain` defaults to 1 and multiplying by 1 is exact), and
    // it is created only on this path, so a routing-less render is unchanged.
    const tail: AudioNode = panner ?? (routingActive ? ctx.createGain() : masterBus);
    let fx: ChainHandle | null = null;
    if (req.includeFx) {
      const chain = chainFor(trk);
      fx = deps.buildChain(ctx, gain, tail, chain);
      chains.push(fx);
      renderedTrackChains.push({ id: trk.id, fxChain: chain });
    } else {
      gain.connect(tail);
    }
    if (!routingActive) panner?.connect(masterBus);
    trackNodeById.set(trk.id, { gain, panner, fx, tail });
  }

  // ── Where everything goes ────────────────────────────────────────────────
  // ONE wiring pass for the whole app: the same `wireRoutingGraph` the live
  // mixer runs, over offline endpoints. It brings its own contract with it —
  // topological order, one gain node per send tapped off the SAME output as the
  // main path, and a graph it cannot order degrading to every strip straight to
  // the master (logged, never silent). Re-deriving any of that here is what
  // would let the bounce and the preview drift apart again.
  //
  // `routedPaths` is whether the graph ACTUALLY ordered. `wireRoutingGraph`
  // degrades a graph it cannot order to every strip straight to the master with
  // no bus in any path, and the trim below has to degrade with it: handed the
  // unvetted graph, `trackCompDelays` would walk a cycle until it runs out of
  // hops and bill a bus's rack once per hop — tens of milliseconds of "latency"
  // for racks that are not in the rendered file at all, and the trim would then
  // delete that much of the head of the user's audio. Asked here rather than
  // taken from the pass because `wireRoutingGraph` reports its verdict by
  // logging, not by returning it.
  let routedPaths = false;
  if (routingActive) {
    try {
      topoOrder(deps.routing as RoutingGraph);
      routedPaths = true;
    } catch { /* degraded: wireRoutingGraph logs it and flattens the graph */ }
    const ends: RoutingEndpoints = {
      outputNodeOf: (id) => trackNodeById.get(id)?.tail ?? busStrips.get(id)?.output,
      inputNodeOf: (id) => (id === MASTER_ID ? masterBus : busStrips.get(id)?.input),
      makeSendGain: (amount) => {
        const g = ctx.createGain();
        g.gain.value = amount;
        return g;
      },
      // Every strip this render actually built. On the degraded path it is
      // these, not the damaged file, that decide who reaches the master.
      liveIds: () => [...trackNodeById.keys(), ...busStrips.keys()],
    };
    wireRoutingGraph(deps.routing as RoutingGraph, ends);
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

  // How late the file will be, measured off the chains this render built AND
  // the paths it actually wired. A selection, a stem, and a graph that could
  // not be ordered are all unrouted (see `routingActive` / `routedPaths`), so
  // none of them carries a bus's latency: a stem trims by its own chain alone,
  // and a damaged graph trims by exactly what the degraded mix put in the path.
  const trimSec = req.includeFx
    ? renderLatencySec(
      renderedTrackChains,
      ctx.sampleRate, // the rate the file is actually at, not the one requested
      routedPaths ? { graph: deps.routing as RoutingGraph, buses: renderedBusChains } : undefined,
    )
    : 0;

  try {
    return trimLeadingSec(await ctx.startRendering(), trimSec);
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
