/**
 * Pure analysis + canvas-drawing helpers behind `DJSemanticWaveform`.
 *
 * Split out of the component module (batch-12 T21 audit follow-up) so that
 * module only exports the component itself — a module that exports both a
 * component and other values breaks Vite's React Fast Refresh, forcing a
 * full reload on every edit instead of a hot patch.
 *
 * DJ-2 — the three costs this module used to pay per waveform INSTANCE, and
 * the default DJ layout mounts two per deck:
 *
 *  - **decode**: its own fetch + its own throwaway real `AudioContext`. Now
 *    one shared fetch/decode per URL via `lib/djAudioCache`.
 *  - **analysis**: ~51M inner iterations for a 3.5-minute track, run
 *    synchronously on the main thread. Now memoised per
 *    (url, normalize, binCount), run in a Worker when one exists, and sized
 *    from the consuming canvas width rather than a flat 6,400 bins.
 *  - **repaint**: the whole canvas re-rendered on every viewport change
 *    (~6x/s/deck while playing). Now the rendered waveform is cached as an
 *    offscreen canvas and a viewport move is a `drawImage` offset
 *    ({@link drawWaveformCached}); {@link drawWaveform} itself is untouched.
 */
import { getDecodedAudio, measureSync, type AudioDecodeContext } from '../../lib/djAudioCache';
import { applyCanvasBox, scaleContextToBox, type CanvasBox } from '../../lib/canvasScale';

export type WaveBin = {
  peak: number;
  rms: number;
  min: number;
  max: number;
  low: number;
  mid: number;
  bright: number;
  transient: number;
  color: string;
};

export const EMPTY_BINS: WaveBin[] = [];
const SILENCE = 'rgba(72, 83, 100, 0.45)';
const BEAT = '#ff3f4f';
const VOCAL = '#72ee78';
const BASS = '#2ea9ff';
const BRIGHT = '#f5b84b';
const BODY = '#bca8ff';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * `AudioBuffer.getChannelData(ch)` is allowed to copy on every call (it does
 * on several implementations); calling it per-sample inside the analysis
 * loop below re-copied a full channel's worth of data for every single
 * sample read. Fetch each channel's array once and index into the cached
 * arrays instead. Exported for tests (FE-008).
 */
export function getChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    channels.push(buffer.getChannelData(ch));
  }
  return channels;
}

export function getMonoSample(channels: Float32Array[], index: number): number {
  let total = 0;
  for (let ch = 0; ch < channels.length; ch += 1) {
    total += channels[ch][index] ?? 0;
  }
  return total / Math.max(1, channels.length);
}

function bandPower(samples: Float32Array, sampleRate: number, freqs: number[]): number {
  let power = 0;
  for (const freq of freqs) {
    if (freq >= sampleRate * 0.45) continue;
    const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
    let q1 = 0;
    let q2 = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const q0 = coeff * q1 - q2 + samples[i];
      q2 = q1;
      q1 = q0;
    }
    power += Math.max(0, q1 * q1 + q2 * q2 - coeff * q1 * q2);
  }
  return power / Math.max(1, samples.length * samples.length * freqs.length);
}

function pickColor(peak: number, rms: number, low: number, mid: number, bright: number, zcr: number, transient: number): string {
  if (peak < 0.012 || rms < 0.004) return SILENCE;

  const total = low + mid + bright + 1e-9;
  const lowShare = low / total;
  const midShare = mid / total;
  const brightShare = bright / total;
  const noisyTop = clamp(zcr / 0.28, 0, 1);

  if (transient > 0.48 && (lowShare > 0.22 || peak > 0.72)) return BEAT;
  if (midShare > lowShare * 1.08 && midShare > brightShare * 0.86) return VOCAL;
  if (lowShare > 0.46) return BASS;
  if (brightShare > 0.34 || noisyTop > 0.58) return BRIGHT;
  return BODY;
}

function semanticRgb(color: string): [number, number, number] {
  switch (color) {
    case BEAT:
      return [255, 89, 64];
    case VOCAL:
      return [76, 241, 112];
    case BASS:
      return [46, 169, 255];
    case BRIGHT:
      return [255, 182, 65];
    case BODY:
      return [188, 168, 255];
    default:
      return [72, 83, 100];
  }
}

function semanticRgba(color: string, alpha: number): string {
  const [r, g, b] = semanticRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The decoded audio behind `audioUrl`.
 *
 * Delegates to the DJ-wide {@link getDecodedAudio} cache: one fetch and one
 * `decodeAudioData` per URL for every consumer on the page, decoded through a
 * shared `OfflineAudioContext` (or the engine's context) rather than a
 * throwaway real `AudioContext` per waveform instance.
 *
 * There is deliberately no `AbortSignal` any more: the request is SHARED, so
 * one unmounting instance must not cancel the download the others are waiting
 * on. Callers drop a stale result instead (see `DJSemanticWaveform`).
 */
export function decodeAudio(audioUrl: string, context?: AudioDecodeContext | null): Promise<AudioBuffer> {
  return getDecodedAudio(audioUrl, context);
}

export interface AnalyzeOptions {
  /** `true` (default): rescale every bin's peak/min/max/rms to the BUFFER's
   *  own loudest sample, exactly as this always did — the DJ decks want two
   *  tracks of very different mastering loudness to still fill the same
   *  visual height so they are easy to beatmatch by eye.
   *  `false`: absolute amplitude, clamped to [0, 1] / [-1, 1] (a float WAV's
   *  samples can exceed unity) but never rescaled — a quiet clip draws quiet
   *  and a loud one draws loud, which is what REAPER does by default and what
   *  D16 fixed `editorStore.computePeaks` (the EDIT timeline) to do; this is
   *  the same fix for the DJ-deck / SemanticWave waveform (audit MAJOR #2). */
  normalize?: boolean;
  /** Width in CSS px of the canvas that will CONSUME these bins. The overview
   *  lanes are 34-44 px wide and used to compute the full 6,400 bins anyway —
   *  ~7x the work for a result that cannot be seen. Omitted (or 0, i.e. not
   *  measured yet) keeps the historical 6,400 cap. See {@link binCountFor}. */
  width?: number;
}

/** Lower bound on bins, unchanged: below this the wave stops being readable
 *  even on a narrow lane. */
const MIN_BINS = 900;
/** Absolute upper bound on bins, unchanged from before DJ-2. */
const MAX_BINS = 6400;
/** Bins per consuming pixel. Above ~4 the extra bins are averaged away by
 *  `sliceStats` before anything is drawn. */
const BINS_PER_PX = 4;

/**
 * How many analysis bins a buffer of `duration` seconds gets when its bins
 * will be drawn into a `width`-px canvas.
 *
 * Same `round(duration * 32)` as always, clamped to [900, 6400] as always —
 * the only new term is the per-pixel ceiling, which never raises the count.
 * Exported for tests.
 */
export function binCountFor(duration: number, width?: number): number {
  const widthCap = width && width > 0 ? Math.max(MIN_BINS, Math.round(width) * BINS_PER_PX) : MAX_BINS;
  const upper = Math.min(MAX_BINS, widthCap);
  return clamp(Math.round(duration * 32), MIN_BINS, upper);
}

/**
 * The analysis loop itself, over raw channel data rather than an
 * `AudioBuffer` — an `AudioBuffer` cannot cross a `postMessage` boundary but
 * `Float32Array`s can, so this is the half that runs inside the Worker.
 * Identical arithmetic to the in-process path; the Worker is fed copies of
 * the very same Float32Arrays.
 */
export function analyzeChannels(
  channels: Float32Array[],
  length: number,
  sampleRate: number,
  bins: number,
  normalize: boolean,
): WaveBin[] {
  const samplesPerBin = Math.max(1, Math.floor(length / bins));
  const maxAnalysisSamples = 512;
  const out: WaveBin[] = [];
  let globalPeak = 0;
  let globalLow = 0;
  let globalMid = 0;
  let globalBright = 0;

  for (let i = 0; i < bins; i += 1) {
    const start = i * samplesPerBin;
    const end = i === bins - 1 ? length : Math.min(length, start + samplesPerBin);
    const stride = Math.max(1, Math.floor((end - start) / maxAnalysisSamples));
    const analysisCount = Math.max(1, Math.floor((end - start) / stride));
    const samples = new Float32Array(analysisCount);

    let peak = 0;
    let min = 0;
    let max = 0;
    let sumSq = 0;
    let crossings = 0;
    let prev = 0;

    for (let n = 0; n < analysisCount; n += 1) {
      const sample = getMonoSample(channels, Math.min(length - 1, start + n * stride));
      samples[n] = sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
      sumSq += sample * sample;
      if (n > 0 && ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0))) crossings += 1;
      prev = sample;
    }

    const rms = Math.sqrt(sumSq / analysisCount);
    const zcr = crossings / Math.max(1, analysisCount - 1);
    const analysisRate = sampleRate / stride;
    const low = bandPower(samples, analysisRate, [58, 88, 128, 180]);
    const mid = bandPower(samples, analysisRate, [420, 760, 1180, 1700]);
    const bright = bandPower(samples, analysisRate, [2600, 3600, 5200]);
    const crest = peak / Math.max(0.0001, rms);
    const transient = clamp((crest - 1.45) / 3.2, 0, 1);

    out.push({
      peak,
      rms,
      min,
      max,
      low,
      mid,
      bright,
      transient,
      color: pickColor(peak, rms, low, mid, bright, zcr, transient),
    });
    if (peak > globalPeak) globalPeak = peak;
    if (low > globalLow) globalLow = low;
    if (mid > globalMid) globalMid = mid;
    if (bright > globalBright) globalBright = bright;
  }

  if (normalize) {
    if (globalPeak > 0) {
      for (const bin of out) {
        bin.peak = clamp(bin.peak / globalPeak, 0, 1);
        bin.min = clamp(bin.min / globalPeak, -1, 1);
        bin.max = clamp(bin.max / globalPeak, -1, 1);
        bin.rms = clamp(bin.rms / globalPeak, 0, 1);
      }
    }
  } else {
    // Absolute amplitude — never rescaled to this buffer's own peak, only
    // clamped: a float WAV's samples are not guaranteed to stay within [-1, 1].
    for (const bin of out) {
      bin.peak = clamp(bin.peak, 0, 1);
      bin.min = clamp(bin.min, -1, 1);
      bin.max = clamp(bin.max, -1, 1);
      bin.rms = clamp(bin.rms, 0, 1);
    }
  }
  for (const bin of out) {
    bin.low = clamp(Math.sqrt(bin.low / Math.max(globalLow, 1e-9)), 0, 1);
    bin.mid = clamp(Math.sqrt(bin.mid / Math.max(globalMid, 1e-9)), 0, 1);
    bin.bright = clamp(Math.sqrt(bin.bright / Math.max(globalBright, 1e-9)), 0, 1);
  }

  return out;
}

/**
 * Analyse a decoded buffer in-process. Unchanged behaviour and unchanged
 * signature; `opts.width` is the only addition (see {@link binCountFor}).
 *
 * This is the SYNCHRONOUS path — it blocks the main thread for the length of
 * the analysis. Components should go through {@link analyzeBufferAsync},
 * which memoises and offloads to a Worker where one exists.
 */
export function analyzeBuffer(buffer: AudioBuffer, opts?: AnalyzeOptions): WaveBin[] {
  return analyzeChannels(
    getChannels(buffer),
    buffer.length,
    buffer.sampleRate,
    binCountFor(buffer.duration, opts?.width),
    opts?.normalize ?? true,
  );
}

// ── memo + Worker offload ──────────────────────────────────────────────────

/**
 * Analysed bins, keyed by `${url}|${normalize}|${binCount}` — the full set of
 * inputs that decide the result. The second `DJSemanticWaveform` instance for
 * a deck therefore costs nothing at all, and re-mounting a deck's lane after a
 * layout change is free too.
 *
 * Small and LRU for the same reason as the decode cache: each entry is up to
 * 6,400 objects.
 */
const analysisMemo = new Map<string, WaveBin[]>();
const ANALYSIS_MEMO_MAX = 8;
/** In-flight Worker analyses, so two instances mounting together share one. */
const analysisInFlight = new Map<string, Promise<WaveBin[]>>();

/** `analysisRate` belongs in the key: `analyzeChannels` feeds `sampleRate /
 *  stride` to `bandPower`, so the SAME file decoded at 44.1k and at 48k does
 *  not yield the same bands — and with the decode cache now able to hold both
 *  (see `djAudioCache`'s `cacheKeyFor`), both can reach this memo. */
function memoKey(url: string, normalize: boolean, bins: number, analysisRate: number): string {
  return `${url}|${normalize ? 'n' : 'a'}|${bins}|${analysisRate}`;
}

function rememberAnalysis(key: string, bins: WaveBin[]): WaveBin[] {
  analysisMemo.delete(key);
  analysisMemo.set(key, bins);
  while (analysisMemo.size > ANALYSIS_MEMO_MAX) {
    const oldest = analysisMemo.keys().next();
    if (oldest.done) break;
    analysisMemo.delete(oldest.value);
  }
  return bins;
}

/** Drop every memoised analysis for `url` (any normalize / any bin count). */
export function evictAnalysis(url: string): void {
  const prefix = `${url}|`;
  for (const key of [...analysisMemo.keys()]) if (key.startsWith(prefix)) analysisMemo.delete(key);
  for (const key of [...analysisInFlight.keys()]) if (key.startsWith(prefix)) analysisInFlight.delete(key);
}

/**
 * Memoised, in-process analysis. Returns the SAME array instance for repeat
 * calls with the same (url, normalize, binCount).
 *
 * Instrumented as `dj:analyze:<url>` so the main-thread cost of a miss shows
 * up on the DevTools timeline.
 */
export function analyzeBufferMemo(url: string, buffer: AudioBuffer, opts?: AnalyzeOptions): WaveBin[] {
  const normalize = opts?.normalize ?? true;
  const bins = binCountFor(buffer.duration, opts?.width);
  const key = memoKey(url, normalize, bins, buffer.sampleRate);
  const hit = analysisMemo.get(key);
  if (hit) {
    analysisMemo.delete(key);
    analysisMemo.set(key, hit);
    return hit;
  }
  const result = measureSync(`dj:analyze:${url}`, () =>
    analyzeChannels(getChannels(buffer), buffer.length, buffer.sampleRate, bins, normalize),
  );
  return rememberAnalysis(key, result);
}

type AnalyzeRequest = {
  id: number;
  channels: Float32Array[];
  length: number;
  sampleRate: number;
  bins: number;
  normalize: boolean;
};
export type AnalyzeResponse = { id: number; bins: WaveBin[] } | { id: number; error: string };

let analysisWorker: Worker | null = null;
let workerUnavailable = false;
let nextRequestId = 1;
const pendingRequests = new Map<number, { resolve: (bins: WaveBin[]) => void; reject: (err: Error) => void }>();

/** How many analyses are waiting on the Worker right now. Introspection for
 *  tests only — a request that is registered and never resolved, rejected or
 *  removed is a leaked closure pair, and nothing else can observe that. */
export function pendingAnalysisCount(): number {
  return pendingRequests.size;
}

/**
 * Give up on the Worker: TERMINATE it (dereferencing alone leaves the thread
 * and its copy of the channel data alive), fail everything waiting on it, and
 * latch `workerUnavailable` so callers use the synchronous path from here on.
 */
function killAnalysisWorker(): void {
  workerUnavailable = true;
  analysisWorker?.terminate();
  analysisWorker = null;
  for (const [, waiting] of pendingRequests) waiting.reject(new Error('waveform analysis worker failed'));
  pendingRequests.clear();
}

/**
 * The shared analysis Worker, or `null` where Workers do not exist — inside a
 * Worker itself (no `document`), under node/tsx in the test suite, or if
 * construction throws (a CSP that forbids worker blobs, say). Every caller
 * falls back to the synchronous path in that case.
 */
function getAnalysisWorker(): Worker | null {
  if (analysisWorker) return analysisWorker;
  if (workerUnavailable) return null;
  if (typeof Worker === 'undefined' || typeof document === 'undefined') {
    workerUnavailable = true;
    return null;
  }
  try {
    analysisWorker = new Worker(new URL('./djSemanticWaveform.worker.ts', import.meta.url), { type: 'module' });
    analysisWorker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
      const data = event.data;
      const waiting = pendingRequests.get(data.id);
      if (!waiting) return;
      pendingRequests.delete(data.id);
      if ('error' in data) waiting.reject(new Error(data.error));
      else waiting.resolve(data.bins);
    };
    // BOTH error channels, not just `onerror`. `onmessageerror` fires when a
    // reply cannot be DESERIALISED on this side; it never reaches `onmessage`,
    // so an unhandled one leaves the request that caused it pending forever
    // and the lane blank. Same treatment: kill the worker, fall everyone back.
    analysisWorker.onerror = killAnalysisWorker;
    analysisWorker.onmessageerror = killAnalysisWorker;
    return analysisWorker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

/**
 * Analysed bins for `url`, off the main thread wherever that is possible.
 *
 * Order of preference:
 *  1. the memo — a repeat (url, normalize, binCount) costs nothing;
 *  2. an in-flight request for the same key — the deck's two waveform
 *     instances mount together and must not analyse the same audio twice;
 *  3. the Worker, fed COPIES of the channel data (the copies are transferred,
 *     never the `AudioBuffer`'s own arrays — transferring those would detach
 *     them and destroy the buffer the engine is playing);
 *  4. the synchronous path, when no Worker exists or the Worker failed.
 */
export function analyzeBufferAsync(url: string, buffer: AudioBuffer, opts?: AnalyzeOptions): Promise<WaveBin[]> {
  const normalize = opts?.normalize ?? true;
  const bins = binCountFor(buffer.duration, opts?.width);
  const key = memoKey(url, normalize, bins, buffer.sampleRate);

  const hit = analysisMemo.get(key);
  if (hit) {
    analysisMemo.delete(key);
    analysisMemo.set(key, hit);
    return Promise.resolve(hit);
  }

  const pending = analysisInFlight.get(key);
  if (pending) return pending;

  const worker = getAnalysisWorker();
  if (!worker) return Promise.resolve(analyzeBufferMemo(url, buffer, { normalize, width: opts?.width }));

  const id = nextRequestId++;
  // Copies, not the live channel arrays: `postMessage` with a transfer list
  // DETACHES what it transfers, and `getChannelData` hands back the buffer's
  // own storage.
  const channels = getChannels(buffer).map((ch) => new Float32Array(ch));
  const request: AnalyzeRequest = { id, channels, length: buffer.length, sampleRate: buffer.sampleRate, bins, normalize };

  const job = new Promise<WaveBin[]>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    try {
      worker.postMessage(request, channels.map((ch) => ch.buffer));
    } catch (err) {
      // Structured clone can refuse the payload outright (a detached buffer,
      // say) and throws SYNCHRONOUSLY. The entry was registered a line ago and
      // no reply will ever clear it, so it has to come back out here — the
      // rejection is caught below and the analysis runs in-process.
      pendingRequests.delete(id);
      throw err;
    }
  })
    .then((result) => rememberAnalysis(key, result))
    .catch(() => {
      // Worker refused or died — analyse in-process rather than show nothing.
      return analyzeBufferMemo(url, buffer, { normalize, width: opts?.width });
    })
    .finally(() => {
      if (analysisInFlight.get(key) === job) analysisInFlight.delete(key);
    });

  analysisInFlight.set(key, job);
  return job;
}

type SliceStats = {
  peak: number;
  rms: number;
  min: number;
  max: number;
  low: number;
  mid: number;
  bright: number;
  transient: number;
  color: string;
};

function sliceStats(bins: WaveBin[], start: number, end: number): SliceStats {
  const first = bins[start] ?? bins[0];
  let strongest = first;
  let peak = 0;
  let rms = 0;
  let min = 0;
  let max = 0;
  let low = 0;
  let mid = 0;
  let bright = 0;
  let transient = 0;
  let count = 0;

  for (let i = start; i < end; i += 1) {
    const bin = bins[i] ?? first;
    count += 1;
    if (bin.peak > peak) {
      peak = bin.peak;
      strongest = bin;
    }
    rms += bin.rms;
    if (bin.min < min) min = bin.min;
    if (bin.max > max) max = bin.max;
    if (bin.low > low) low = bin.low;
    mid += bin.mid;
    bright += bin.bright;
    if (bin.transient > transient) transient = bin.transient;
  }

  return {
    peak,
    rms: rms / Math.max(1, count),
    min,
    max,
    low,
    mid: mid / Math.max(1, count),
    bright: bright / Math.max(1, count),
    transient,
    color: strongest.color,
  };
}

function fillSymmetricBar(ctx: CanvasRenderingContext2D, x: number, center: number, topHalf: number, bottomHalf: number, width: number): void {
  ctx.fillRect(x, center - topHalf, width, Math.max(1, topHalf + bottomHalf));
}

/** The opaque panel background. Skipped for `transparentBg` callers (FE-021). */
function paintBackgroundGradient(ctx: CanvasRenderingContext2D, width: number, pixelHeight: number): void {
  const bg = ctx.createLinearGradient(0, 0, 0, pixelHeight);
  bg.addColorStop(0, '#06070d');
  bg.addColorStop(0.5, '#0e1018');
  bg.addColorStop(1, '#05060a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, pixelHeight);
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  box: CanvasBox,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
  transparent = false,
  decodeError: string | null = null,
): void {
  // The canvas stretches with `absolute inset-0 h-full w-full`, so only the
  // backing store is set here; an inline width in viewport px would apply the
  // shell zoom a second time and shrink the wave away from the playhead.
  applyCanvasBox(canvas, box);
  // Kept unrounded so the painted extent matches the backing store exactly; the
  // per-column loop below still steps in whole units.
  const width = box.cssWidth;
  const pixelHeight = box.cssHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  scaleContextToBox(ctx, box);
  ctx.clearRect(0, 0, width, pixelHeight);

  // `transparentBg` callers (e.g. SemanticWave embedded over an already
  // coloured panel) need the caller's background to actually show through;
  // painting this gradient unconditionally defeated that (FE-021).
  if (!transparent) paintBackgroundGradient(ctx, width, pixelHeight);

  if (decodeError) {
    // A failed decode used to fall through to the exact same thin centre
    // line as "no data yet", so a broken audio URL was silently invisible
    // (FE-011). Paint a distinct, visible failure state instead.
    ctx.fillStyle = 'rgba(255, 89, 64, 0.16)';
    ctx.fillRect(0, 0, width, pixelHeight);
    ctx.strokeStyle = 'rgba(255, 89, 64, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, pixelHeight - 1));
    if (width >= 60) {
      ctx.fillStyle = 'rgba(255, 210, 200, 0.9)';
      ctx.font = `${Math.max(9, Math.min(12, pixelHeight * 0.4))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waveform unavailable', width / 2, pixelHeight / 2);
    }
    return;
  }

  if (bins.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(0, pixelHeight / 2 - 0.5, width, 1);
    return;
  }

  const center = pixelHeight / 2;
  paintGuides(ctx, width, center);
  drawWaveBody(ctx, width, pixelHeight, bins, viewportStart, viewportEnd);
  paintSpine(ctx, width, center);
  paintVignette(ctx, width, pixelHeight);
}

/** The three faint horizontal rules under the wave. */
function paintGuides(ctx: CanvasRenderingContext2D, width: number, center: number): void {
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fillRect(0, Math.floor(center * 0.5), width, 1);
  ctx.fillRect(0, Math.floor(center * 1.5), width, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.055)';
  ctx.fillRect(0, center - 0.5, width, 1);
}

/**
 * The per-column waveform render — everything between the guide rules and the
 * spine, exactly as it always was.
 *
 * Extracted (DJ-2) so {@link drawWaveformCached} can render it ONCE into an
 * offscreen canvas covering the whole track and then blit slices as the
 * viewport moves. `drawWaveform` calls it in the same place with the same
 * arguments, so its output is unchanged.
 */
function drawWaveBody(
  ctx: CanvasRenderingContext2D,
  width: number,
  pixelHeight: number,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
): void {
  const center = pixelHeight / 2;
  const maxBar = Math.max(3, pixelHeight * 0.47);

  const spanNorm = Math.max(0.001, viewportEnd - viewportStart);

  ctx.globalCompositeOperation = 'lighter';
  for (let x = 0; x < width; x += 1) {
    const startNorm = viewportStart + (x / width) * spanNorm;
    const endNorm = viewportStart + ((x + 1) / width) * spanNorm;
    if (endNorm <= 0 || startNorm >= 1) {
      ctx.fillStyle = 'rgba(72, 83, 100, 0.13)';
      fillSymmetricBar(ctx, x, center, 1, 1, 1);
      continue;
    }
    const start = Math.floor(clamp(startNorm, 0, 0.999) * bins.length);
    const end = Math.max(start + 1, Math.ceil(clamp(endNorm, 0.001, 1) * bins.length));
    const bin = sliceStats(bins, start, end);
    const amp = Math.pow(clamp(bin.peak, 0, 1), 0.58);
    const minHalf = Math.max(1, Math.abs(bin.min) * maxBar);
    const maxHalf = Math.max(1, Math.abs(bin.max) * maxBar);
    const fallbackHalf = Math.max(1.25, amp * maxBar);
    const upper = Math.max(maxHalf, fallbackHalf * 0.72);
    const lower = Math.max(minHalf, fallbackHalf * 0.72);

    if (amp < 0.012) {
      ctx.fillStyle = 'rgba(72, 83, 100, 0.24)';
      fillSymmetricBar(ctx, x, center, 1, 1, 1);
      continue;
    }

    const semanticAlpha = clamp(0.26 + amp * 0.34 + bin.rms * 0.22, 0.28, 0.86);
    const lowAlpha = clamp(0.04 + bin.low * 0.34 + amp * 0.08, 0.05, 0.48);
    const midAlpha = clamp(0.04 + bin.mid * 0.44 + bin.rms * 0.28, 0.06, 0.6);
    const brightAlpha = clamp(0.03 + bin.bright * 0.5 + bin.transient * 0.16, 0.04, 0.62);
    const transientAlpha = clamp((bin.transient - 0.24) * 0.82 + amp * 0.08, 0, 0.66);

    ctx.fillStyle = semanticRgba(bin.color, semanticAlpha);
    fillSymmetricBar(ctx, x, center, upper, lower, 1);

    const lowHalf = Math.max(1, fallbackHalf * clamp(0.52 + bin.low * 0.34, 0.42, 0.86));
    ctx.fillStyle = `rgba(30, 144, 255, ${lowAlpha})`;
    fillSymmetricBar(ctx, x, center, lowHalf, lowHalf, 1);

    const midHalf = Math.max(1, fallbackHalf * clamp(0.34 + bin.mid * 0.42, 0.28, 0.72));
    ctx.fillStyle = `rgba(76, 241, 112, ${midAlpha})`;
    fillSymmetricBar(ctx, x, center, midHalf, midHalf, 1);

    const brightHalf = Math.max(1, fallbackHalf * clamp(0.16 + bin.bright * 0.36, 0.14, 0.5));
    ctx.fillStyle = `rgba(255, 182, 65, ${brightAlpha})`;
    fillSymmetricBar(ctx, x, center, brightHalf, brightHalf, 1);

    if (transientAlpha > 0.03) {
      ctx.fillStyle = `rgba(255, 246, 210, ${transientAlpha})`;
      fillSymmetricBar(ctx, x, center, Math.max(1, upper * 0.96), Math.max(1, lower * 0.96), 1);
    }

    if (bin.color === BEAT) {
      const rail = Math.max(1, Math.round(1 + bin.low * 3 + bin.transient * 2));
      ctx.fillStyle = `rgba(255, 89, 64, ${clamp(0.18 + bin.low * 0.4 + bin.transient * 0.34, 0.2, 0.86)})`;
      ctx.fillRect(x, pixelHeight - rail - 1, 1, rail);
    } else if (bin.low > 0.56) {
      const rail = Math.max(1, Math.round(1 + bin.low * 2));
      ctx.fillStyle = `rgba(46, 169, 255, ${clamp(0.12 + bin.low * 0.35, 0.18, 0.58)})`;
      ctx.fillRect(x, pixelHeight - rail - 1, 1, rail);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function paintSpine(ctx: CanvasRenderingContext2D, width: number, center: number): void {
  const spine = ctx.createLinearGradient(0, 0, width, 0);
  spine.addColorStop(0, 'rgba(255,255,255,0.04)');
  spine.addColorStop(0.5, 'rgba(255,255,255,0.32)');
  spine.addColorStop(1, 'rgba(255,255,255,0.04)');
  ctx.fillStyle = spine;
  ctx.fillRect(0, center - 0.5, width, 1);
}

function paintVignette(ctx: CanvasRenderingContext2D, width: number, pixelHeight: number): void {
  const vignette = ctx.createLinearGradient(0, 0, 0, pixelHeight);
  vignette.addColorStop(0, 'rgba(0,0,0,0.34)');
  vignette.addColorStop(0.12, 'rgba(0,0,0,0)');
  vignette.addColorStop(0.88, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.36)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, pixelHeight);
}

// ── viewport repaint: render once, blit thereafter ─────────────────────────

/** Widest offscreen render we will allocate, in device px. A deep zoom on a
 *  high-dpr display asks for more than browsers will back (zoom 8 x dpr 2 on a
 *  600 px lane wants 9,600), so the render is CLAMPED to this and the blit
 *  resamples — still one `drawImage` per frame instead of a full re-render. */
const MAX_OFFSCREEN_DEVICE_WIDTH = 8192;

type CachedRender = { canvas: HTMLCanvasElement; fullWidth: number; deviceWidth: number };
const renderCache = new Map<string, CachedRender>();
const RENDER_CACHE_MAX = 4;

/** Drop every cached offscreen render whose key starts with `prefix` (the
 *  caller's `cacheKey`, i.e. one track). */
export function evictWaveformRender(prefix: string): void {
  for (const key of [...renderCache.keys()]) if (key.startsWith(`${prefix}|`)) renderCache.delete(key);
}

function cachedRender(
  key: string,
  box: CanvasBox,
  bins: WaveBin[],
  fullWidth: number,
  deviceWidth: number,
): CachedRender | null {
  const hit = renderCache.get(key);
  if (hit) {
    renderCache.delete(key);
    renderCache.set(key, hit);
    return hit;
  }
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = deviceWidth;
  canvas.height = box.deviceHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Horizontal scale is the (possibly CLAMPED) device width over the whole
  // track's CSS width, so the render always fits the backing store; vertical
  // stays the box's own scale. Unclamped this is exactly `box.scale`, which
  // is what it always was.
  ctx.setTransform(deviceWidth / fullWidth, 0, 0, box.scale, 0, 0);
  ctx.clearRect(0, 0, fullWidth, box.cssHeight);
  // The WHOLE track, at the current zoom, with no background/guides/spine —
  // those are painted per frame on the real canvas so they stay anchored to
  // the visible lane rather than scrolling with the audio.
  drawWaveBody(ctx, fullWidth, box.cssHeight, bins, 0, 1);

  const entry: CachedRender = { canvas, fullWidth, deviceWidth };
  renderCache.set(key, entry);
  while (renderCache.size > RENDER_CACHE_MAX) {
    const oldest = renderCache.keys().next();
    if (oldest.done) break;
    renderCache.delete(oldest.value);
  }
  return entry;
}

/**
 * {@link drawWaveform} with the waveform body cached.
 *
 * A playing deck moves its viewport ~6 times a second, and every one of those
 * used to re-run the full per-column render (`sliceStats` over the bins, five
 * fills per column). Here the body is rendered once into an offscreen canvas
 * covering the whole track at the current zoom, keyed by
 * `(cacheKey, width, height, scale, span, binCount)`; moving the viewport is
 * then a single `drawImage` at a different source offset.
 *
 * A viewport that covers the WHOLE track and both degenerate states (decode
 * error, no bins) go straight to `drawWaveform`, byte for byte — there is
 * nothing to cache when the visible extent already IS the whole render.
 *
 * Two things this deliberately does NOT refuse, because the app's own detail
 * lane does both on every frame (`DJView`'s `DeckWaveform` at zoom 8):
 *
 *  - **an over-scrolled viewport.** `viewMin = -visibleFrac / 2` puts the
 *    viewport before the start of the track for its first ~6% and past the
 *    end for its last ~6%. The lookup clamps to the part that has audio
 *    behind it and blits only that; the rest of the lane keeps the painted
 *    background, exactly as `drawWaveBody`'s own out-of-range columns look.
 *  - **a render wider than {@link MAX_OFFSCREEN_DEVICE_WIDTH}.** `box.scale`
 *    is zoom x dpr, so a 600 px lane at zoom 8 / dpr 2 wants a 9,600 px
 *    backing store. That is clamped (the blit then resamples) rather than
 *    abandoned: resampling one `drawImage` is far cheaper than re-running the
 *    per-column render six times a second.
 *
 * @param cacheKey identifies the ANALYSIS behind `bins` — `${audioUrl}|${normalize}`.
 */
export function drawWaveformCached(
  canvas: HTMLCanvasElement,
  box: CanvasBox,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
  transparent: boolean,
  decodeError: string | null,
  cacheKey: string,
): void {
  const width = box.cssWidth;
  const pixelHeight = box.cssHeight;
  const span = viewportEnd - viewportStart;
  const fullWidth = span > 0 ? Math.round(width / span) : 0;

  // The part of the viewport that has audio behind it. The detail lane
  // over-scrolls half a screen past both ends of the track, so clamping here
  // — rather than refusing to cache — is what keeps the cache engaged for
  // the first and last ~6% of every track.
  const visibleStart = clamp(viewportStart, 0, 1);
  const visibleEnd = clamp(viewportEnd, 0, 1);
  const visibleSpan = visibleEnd - visibleStart;

  const cacheable =
    !decodeError &&
    bins.length > 0 &&
    span > 0 &&
    visibleSpan > 0 &&
    // A viewport covering the WHOLE track has nothing to gain: the render it
    // would cache is the frame itself.
    !(viewportStart <= 0 && viewportEnd >= 1) &&
    width > 0 &&
    Number.isFinite(fullWidth) &&
    fullWidth >= width;

  if (!cacheable) {
    drawWaveform(canvas, box, bins, viewportStart, viewportEnd, transparent, decodeError);
    return;
  }

  // Clamped, not abandoned — see the note on MAX_OFFSCREEN_DEVICE_WIDTH above.
  const deviceWidth = Math.max(1, Math.min(Math.round(fullWidth * box.scale), MAX_OFFSCREEN_DEVICE_WIDTH));

  const key = `${cacheKey}|${Math.round(width)}|${Math.round(pixelHeight)}|${box.scale}|${span.toFixed(6)}|${bins.length}|${deviceWidth}`;
  const render = cachedRender(key, box, bins, fullWidth, deviceWidth);
  if (!render) {
    drawWaveform(canvas, box, bins, viewportStart, viewportEnd, transparent, decodeError);
    return;
  }

  applyCanvasBox(canvas, box);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  scaleContextToBox(ctx, box);
  ctx.clearRect(0, 0, width, pixelHeight);
  if (!transparent) paintBackgroundGradient(ctx, width, pixelHeight);
  paintGuides(ctx, width, pixelHeight / 2);

  // Source: whole device pixels of the in-range slice (a 1:1 copy whenever the
  // render was not clamped).
  const sx = clamp(Math.round(visibleStart * render.deviceWidth), 0, Math.max(0, render.deviceWidth - 1));
  const sw = Math.max(1, Math.min(Math.round(visibleSpan * render.deviceWidth), render.deviceWidth - sx));
  // Destination: the slice of the LANE that in-range part occupies. Anything
  // the viewport covers beyond either end of the track is left as the
  // background painted above.
  const dx = ((visibleStart - viewportStart) / span) * width;
  const dw = (visibleSpan / span) * width;
  // The body was composited additively onto transparency; replaying it over
  // the background with the same operator keeps the blend it was drawn with.
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(render.canvas, sx, 0, sw, box.deviceHeight, dx, 0, dw, pixelHeight);
  ctx.globalCompositeOperation = 'source-over';

  paintSpine(ctx, width, pixelHeight / 2);
  paintVignette(ctx, width, pixelHeight);
}
