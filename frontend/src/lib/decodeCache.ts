/**
 * One decode cache for the whole DAW.
 *
 * A decoded clip is stereo float32 in RAM — about 0.35 MB per second at
 * 44.1 kHz, ~85 MB for a four-minute track. Before this module the live mixer
 * and each offline renderer kept a private Blob-keyed cache and each re-ran the
 * same timeout-guarded decodeAudioData, so bouncing a project that was already
 * playing decoded every clip a second time and roughly doubled peak memory. In
 * Electron that is a renderer-process OOM on a 16 GB laptop, not a slowdown.
 *
 * Everything that decodes a clip's `audioBlob` goes through here instead, so a
 * clip decoded once is reused by every later play and bounce.
 *
 * Sharing one buffer across contexts is safe by spec: an AudioBuffer is a
 * memory-resident asset, not a child of the context that produced it, and may
 * be used by one or more contexts — assigning it to an AudioBufferSourceNode of
 * an OfflineAudioContext is exactly the supported case.
 *
 * TWO invariants this module exists to hold:
 *
 * 1. The cache only ever contains buffers that decoded SUCCESSFULLY. A rejected
 *    or timed-out decode leaves no entry — neither a resolved one (silence
 *    would play forever) nor a rejected promise (one blip would poison every
 *    later play and bounce of that clip).
 *
 * 2. A buffer is only ever handed to a caller decoding at the SAME sample rate.
 *    decodeAudioData resamples its output to the context's rate, and the two
 *    kinds of caller here do not agree on one: the live engine context runs at
 *    whatever the output device gives (commonly 48 kHz), while every offline
 *    renderer deliberately pins 44100 to match its OfflineAudioContext. Handing
 *    a bounce the live 48 kHz buffer would resample 44.1 -> 48 -> 44.1 material
 *    that needed no resampling at all, and — worse — would make a bounce's
 *    output depend on whether the user happened to press play first. Entries
 *    are therefore per rate, so reuse is always a pure win and never a quality
 *    or determinism change.
 */

/** How long a single clip decode may take before the race rejects it.
 *  This is the live mixer's long-standing value; the offline renderers used
 *  the same number, independently. */
export const DECODE_TIMEOUT_MS = 15000;

/** Decoded buffers, keyed by Blob identity then by the sample rate they were
 *  decoded at. A WeakMap means a clip's buffers are reclaimed once its Blob is
 *  gone, and an edited clip (a fresh Blob) decodes again rather than playing
 *  the pre-edit audio. */
const decoded = new WeakMap<Blob, Map<number, AudioBuffer>>();

/** Decodes currently running, same keying, so two callers asking for the same
 *  clip at the same rate at the same time (playback starting while a bounce
 *  walks the same timeline) share one decodeAudioData instead of allocating
 *  the buffer twice. */
const inFlight = new WeakMap<Blob, Map<number, Promise<AudioBuffer>>>();

function lane<T>(store: WeakMap<Blob, Map<number, T>>, blob: Blob): Map<number, T> {
  let byRate = store.get(blob);
  if (!byRate) {
    byRate = new Map<number, T>();
    store.set(blob, byRate);
  }
  return byRate;
}

/**
 * The decoded buffer for a clip at this context's sample rate, if one is
 * already in the cache.
 *
 * For the synchronous readers on the live path — the scheduler builds source
 * nodes inside a loop that cannot await, having called `decodeClipBlob` for
 * every clip beforehand.
 */
export function peekDecoded(ctx: BaseAudioContext, blob: Blob): AudioBuffer | undefined {
  return decoded.get(blob)?.get(ctx.sampleRate);
}

async function runDecode(ctx: BaseAudioContext, blob: Blob, rate: number): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // `slice(0)` because decodeAudioData detaches the buffer it is given, and a
    // retry after a failure would otherwise be handed an empty one.
    const buffer = await Promise.race([
      ctx.decodeAudioData(bytes.slice(0)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS);
      }),
    ]);
    lane(decoded, blob).set(rate, buffer);
    return buffer;
  } finally {
    // The deadline is disarmed once the race is decided either way. The old
    // per-site copies left it armed, which held a timer handle (and, under a
    // test runner, the whole process) alive for the full 15 s.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Decode a clip's audio Blob, reusing the buffer if any other part of the app
 * has already decoded it at this context's sample rate.
 *
 * `ctx` does the decoding and sets the rate; the resulting buffer belongs to no
 * context in particular and may be played on any of them. A failed decode is
 * not cached, so the caller may retry.
 */
export function decodeClipBlob(ctx: BaseAudioContext, blob: Blob): Promise<AudioBuffer> {
  const rate = ctx.sampleRate;

  const hit = decoded.get(blob)?.get(rate);
  if (hit) return Promise.resolve(hit);

  const pending = inFlight.get(blob)?.get(rate);
  if (pending) return pending;

  const started = runDecode(ctx, blob, rate);
  lane(inFlight, blob).set(rate, started);
  // Clear the in-flight slot however it settles — on success the buffer has
  // already moved into `decoded`, and on failure the next caller must be free
  // to try again rather than re-await a promise that is known to reject.
  // Both handlers return undefined, so this derived promise never rejects and
  // the caller's own rejection stays the only one to handle.
  const release = () => {
    const byRate = inFlight.get(blob);
    if (byRate?.get(rate) === started) byRate.delete(rate);
  };
  void started.then(release, release);
  return started;
}
