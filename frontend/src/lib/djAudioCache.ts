/**
 * One fetch + one decode per audio URL for the whole DJ tab (DJ-2).
 *
 * ## Why
 *
 * Loading a deck used to download and decode the same file several times over.
 * `djEngine.loadDeck` does its own `fetch` -> `arrayBuffer` ->
 * `ctx.decodeAudioData`, and the default DJ layout mounts TWO
 * `DJSemanticWaveform` instances per deck (the zoomed lane and the overview),
 * each of which ran `djSemanticWaveformAnalysis.decodeAudio` independently:
 * its own `fetch`, its own `arrayBuffer.slice(0)` (a full extra copy of the
 * file), its own `new AudioContext()` — a REAL output-device context — and a
 * `close()` afterwards. Loading two decks was therefore 6 fetches, 6 decodes
 * and 4 throwaway output contexts, every one of which can glitch the engine's
 * own playing context on Windows/WASAPI.
 *
 * ## The contract
 *
 *   getDecodedAudio(url)            -> Promise<AudioBuffer>
 *   getDecodedAudio(url, context)   -> ... decoded through `context`
 *   evict(url) / evictAll()
 *   setDecodeContext(ctx)
 *
 * - **Keyed by URL.** Same URL, same `AudioBuffer` instance, for every caller.
 * - **Single-flight.** Callers that arrive while a decode is in flight join it;
 *   they never start a second fetch.
 * - **LRU of {@link DJ_AUDIO_CACHE_MAX} buffers** (decoded audio is large — a
 *   3.5-minute stereo track is ~74 MB of Float32: 210 s x 44,100 x 2 ch x 4 B
 *   — so this is deliberately
 *   small: two decks plus one on either side of a transition).
 * - **Never constructs a real `AudioContext`.** Decoding needs *a* context, not
 *   an output device: this uses the caller's context if given, else the one
 *   registered with {@link setDecodeContext}, else a single shared
 *   `OfflineAudioContext`, which allocates no device.
 * - **No defensive copy.** The fetched `ArrayBuffer` goes straight into
 *   `decodeAudioData`; nothing else reads it afterwards, so the old
 *   `.slice(0)` was pure waste on a multi-MB buffer.
 * - **Failures are not cached.** A rejected load leaves no entry, so the next
 *   caller retries.
 *
 * ## The call `djEngine.loadDeck` will make
 *
 * `loadDeck` (`src/state/djEngine.ts`, the fetch + decode at :501-:516) is
 * owned by another change and still does its own round trip. It becomes:
 *
 * ```ts
 * const buf = await getDecodedAudio(url, getEngineCtx());
 * ```
 *
 * replacing `fetch` -> `arrayBuffer` -> `getEngineCtx().decodeAudioData`, with
 * `evict(url)` when a deck is unloaded for good. Passing the engine context is
 * what makes that call worth making: `decodeAudioData` resamples to the
 * decoding context's own sample rate, so decoding through the engine's context
 * lands the buffer at exactly the rate playback runs at. Until that lands, the
 * engine can register its context once at start-up with
 * `setDecodeContext(getEngineCtx())` and every waveform decode picks it up.
 * Without either, the shared `OfflineAudioContext` below decodes at
 * {@link FALLBACK_SAMPLE_RATE}; a buffer at a different rate than the output
 * still plays at the correct pitch (`AudioBufferSourceNode` resamples), it is
 * only resampled twice.
 */

/** The slice of `BaseAudioContext` this module actually needs. Accepting the
 *  structural type (rather than `AudioContext`) is what lets an
 *  `OfflineAudioContext` — or the engine's context — serve as the decoder. */
export interface AudioDecodeContext {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  /** The rate `decodeAudioData` RESAMPLES to. Part of the cache key: a buffer
   *  decoded at 44.1k is not interchangeable with the same file decoded at
   *  48k, so two contexts running at different rates must not share an entry.
   *  Optional because a caller may pass a bare decoder with no rate to
   *  advertise; those share one key (rate 0) among themselves. */
  readonly sampleRate?: number;
}

/** Decoded buffers held at once. Four = both decks plus the pair either side
 *  of an automix transition. */
export const DJ_AUDIO_CACHE_MAX = 4;

/** Sample rate of the shared fallback `OfflineAudioContext`. Only used when
 *  no engine context is available; see the module doc. */
const FALLBACK_SAMPLE_RATE = 44100;

/** Insertion-ordered = LRU order: the first key is the least recently used.
 *  Keyed `${url}@${decodeSampleRate}` — see {@link cacheKeyFor}. */
const decoded = new Map<string, AudioBuffer>();
/** In-flight decodes, same key — the single-flight table. */
const inFlight = new Map<string, Promise<AudioBuffer>>();

/**
 * The cache key: the URL AND the rate the audio will be resampled to.
 *
 * `decodeAudioData` resamples to the decoding context's own rate, so the same
 * file decoded through the 44.1 kHz offline fallback and through a 48 kHz
 * engine context are two different buffers. Keyed on the URL alone, whichever
 * caller decoded FIRST silently fixed the rate for everyone that followed -
 * and since nothing calls {@link setDecodeContext} yet, in practice that was
 * the waveform's offline fallback deciding the rate the engine got.
 *
 * A context that advertises no `sampleRate` keys as rate 0: unknown, but at
 * least consistently unknown.
 */
function cacheKeyFor(url: string, ctx: AudioDecodeContext): string {
  return `${url}@${typeof ctx.sampleRate === 'number' ? ctx.sampleRate : 0}`;
}

/** Every cache key currently held for `url`, at any rate. */
function keysFor(url: string): string[] {
  const prefix = `${url}@`;
  return [...decoded.keys(), ...inFlight.keys()].filter((key) => key.startsWith(prefix));
}

let registeredContext: AudioDecodeContext | null = null;
let sharedOfflineContext: AudioDecodeContext | null = null;

/**
 * Register the context every decode should go through when the caller does not
 * supply one — the engine's own `AudioContext`. Pass `null` to clear it (and
 * to drop the reference, e.g. when the engine tears its context down).
 */
export function setDecodeContext(ctx: AudioDecodeContext | null): void {
  registeredContext = ctx;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => AudioDecodeContext;

function resolveContext(explicit?: AudioDecodeContext | null): AudioDecodeContext {
  if (explicit) return explicit;
  if (registeredContext) return registeredContext;
  if (sharedOfflineContext) return sharedOfflineContext;

  const scope = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  if (!Ctor) {
    // Deliberately NOT falling back to `new AudioContext()`: that opens the
    // output device, which is the exact cost this module exists to remove.
    throw new Error('No audio decoding context available (pass one to getDecodedAudio or call setDecodeContext)');
  }
  // 1 channel / 1 frame: the context is a decoder, it never renders anything.
  sharedOfflineContext = new Ctor(1, 1, FALLBACK_SAMPLE_RATE);
  return sharedOfflineContext;
}

/** Move `key` to the most-recently-used end of the LRU order. */
function touch(key: string): AudioBuffer | undefined {
  const hit = decoded.get(key);
  if (hit === undefined) return undefined;
  decoded.delete(key);
  decoded.set(key, hit);
  return hit;
}

function store(key: string, buffer: AudioBuffer): void {
  decoded.delete(key);
  decoded.set(key, buffer);
  while (decoded.size > DJ_AUDIO_CACHE_MAX) {
    const oldest = decoded.keys().next();
    if (oldest.done) break;
    decoded.delete(oldest.value);
  }
}

/**
 * Wrap `fn` in a `performance.mark`/`measure` pair named `name`, so the cost
 * shows up on the DevTools performance timeline instead of only in a profile.
 * The marks are cleared again (the measure is kept — that is the visible part)
 * so a long session does not accumulate thousands of entries. Never logs.
 */
export function measureSync<T>(name: string, fn: () => T): T {
  const perf = (globalThis as unknown as { performance?: Performance }).performance;
  if (!perf || typeof perf.mark !== 'function' || typeof perf.measure !== 'function') return fn();
  const startMark = `${name}:start`;
  const endMark = `${name}:end`;
  perf.mark(startMark);
  try {
    return fn();
  } finally {
    try {
      perf.mark(endMark);
      perf.measure(name, startMark, endMark);
      perf.clearMarks?.(startMark);
      perf.clearMarks?.(endMark);
    } catch {
      /* measurement must never break the thing it measures */
    }
  }
}

/** The async twin of {@link measureSync}. */
async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const perf = (globalThis as unknown as { performance?: Performance }).performance;
  if (!perf || typeof perf.mark !== 'function' || typeof perf.measure !== 'function') return fn();
  const startMark = `${name}:start`;
  const endMark = `${name}:end`;
  perf.mark(startMark);
  try {
    return await fn();
  } finally {
    try {
      perf.mark(endMark);
      perf.measure(name, startMark, endMark);
      perf.clearMarks?.(startMark);
      perf.clearMarks?.(endMark);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The decoded audio for `url`, fetching and decoding it at most once.
 *
 * @param url      audio URL; also the cache key.
 * @param context  optional context to decode through — the engine's
 *                 `AudioContext` when the caller has one. Only consulted when
 *                 this call is the one that performs the decode; a cache hit
 *                 returns the already-decoded buffer regardless.
 */
export function getDecodedAudio(url: string, context?: AudioDecodeContext | null): Promise<AudioBuffer> {
  // Resolved FIRST because the rate it decodes at is part of the key. That is
  // a lookup, not a construction, on every call but the very first.
  const ctx = resolveContext(context);
  const key = cacheKeyFor(url, ctx);

  const hit = touch(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const job = measureAsync(`dj:decode:${url}`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Unable to load audio waveform: ${res.status}`);
    // No `.slice(0)`: nothing reads these bytes after the decode, and the copy
    // was a full extra multi-MB allocation per waveform instance.
    const bytes = await res.arrayBuffer();
    return ctx.decodeAudioData(bytes);
  })
    .then((buffer) => {
      // A concurrent `evict(url)` while this was in flight means the caller no
      // longer wants it cached; still resolve this promise, just do not store.
      if (inFlight.get(key) === job) store(key, buffer);
      return buffer;
    })
    .finally(() => {
      // Failures are not cached — dropping the in-flight entry is what lets
      // the next caller retry.
      if (inFlight.get(key) === job) inFlight.delete(key);
    });

  inFlight.set(key, job);
  return job;
}

/** Drop one URL's decoded buffers — EVERY rate held for it — and disown any
 *  in-flight decode for it. Callers know URLs, not decode rates. */
export function evict(url: string): void {
  for (const key of keysFor(url)) {
    decoded.delete(key);
    inFlight.delete(key);
  }
}

/** Drop everything — deck teardown, and test isolation. */
export function evictAll(): void {
  decoded.clear();
  inFlight.clear();
}

/** Whether `url` is decoded and resident right now. Read-only; does not
 *  refresh LRU recency. */
export function isDecoded(url: string): boolean {
  const prefix = `${url}@`;
  for (const key of decoded.keys()) if (key.startsWith(prefix)) return true;
  return false;
}
