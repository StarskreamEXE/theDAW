/**
 * One decode cache for the whole DAW.
 *
 * Every audio path used to decode a whole file into its own in-RAM AudioBuffer
 * (44.1 kHz stereo float32 ≈ 0.35 MB/s, ~85 MB for a 4-minute track): the live
 * mixer kept one Blob-keyed cache, and each offline renderer kept another. So
 * bouncing a project that was already playing re-decoded every clip and roughly
 * doubled peak memory — enough to OOM the Electron renderer on a 16 GB laptop.
 *
 * What this suite pins down is the part that is easy to get subtly wrong when
 * one cache is shared by the live path and the bounces: a failed decode must
 * NOT be remembered (otherwise one blip poisons every later bounce of that
 * clip), and two callers racing for the same clip must produce exactly one
 * decodeAudioData call, not two.
 *
 * And the one that is invisible until someone listens closely: decodeAudioData
 * resamples to the context's rate, and the live engine context runs at the
 * DEVICE rate while every offline renderer pins 44100. Handing a bounce the
 * 48 kHz buffer the live path decoded would make it resample 44.1 → 48 → 44.1
 * for material that needed no resampling at all — and would make a bounce's
 * output depend on whether the user had pressed play first. Entries are
 * therefore per rate.
 *
 * The context is a fake: decodeAudioData resolves, rejects, or never settles on
 * command, and timers are faked so the 15 s race is exercised in microseconds.
 *
 * Run: npx tsx src/lib/decodeCache.test.ts
 */
import assert from 'node:assert/strict';

/* ── fake timers ──────────────────────────────────────────────────────────
 * Installed for the whole suite, so the 15 s timeout is both assertable and
 * unable to keep the test process alive for 15 s after the last assertion.
 * A leaked timer would show up here as `cancelled === false`.                */

interface FakeTimer {
  cb: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

const timers: FakeTimer[] = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

globalThis.setTimeout = ((cb: () => void, ms: number) => {
  const t: FakeTimer = { cb, ms, cancelled: false, fired: false };
  timers.push(t);
  return t as unknown as ReturnType<typeof setTimeout>;
}) as unknown as typeof setTimeout;

globalThis.clearTimeout = ((handle: unknown) => {
  if (handle && typeof handle === 'object') (handle as FakeTimer).cancelled = true;
}) as unknown as typeof clearTimeout;

/** Fire every timer that is still armed (the 15 s deadline elapsing). */
const elapse = () => {
  for (const t of timers) {
    if (t.cancelled || t.fired) continue;
    t.fired = true;
    t.cb();
  }
};

/** Let queued microtasks (the decode chain) run to completion. */
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

/* ── fake context ─────────────────────────────────────────────────────────── */

/** A distinguishable stand-in for a decoded buffer (identity is what we assert). */
const makeBuffer = (tag: string, sampleRate = 44100) =>
  ({ tag, duration: 1, sampleRate }) as unknown as AudioBuffer;

type Outcome =
  | { kind: 'resolve'; buffer: AudioBuffer }
  | { kind: 'reject'; error: Error }
  | { kind: 'hang' };

class FakeContext {
  calls: ArrayBuffer[] = [];
  private outcomes: Outcome[] = [];

  /** Renderers pin 44100; the live engine context is whatever the device gives. */
  constructor(readonly sampleRate = 44100) {}

  /** Queue what the NEXT decodeAudioData call does (falls back to the last one). */
  will(outcome: Outcome): this {
    this.outcomes.push(outcome);
    return this;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    this.calls.push(data);
    const outcome = this.outcomes.shift() ?? { kind: 'hang' as const };
    if (outcome.kind === 'resolve') return Promise.resolve(outcome.buffer);
    if (outcome.kind === 'reject') return Promise.reject(outcome.error);
    return new Promise<AudioBuffer>(() => {});
  }

  get ctx(): BaseAudioContext {
    return this as unknown as BaseAudioContext;
  }
}

const { DECODE_TIMEOUT_MS, decodeClipBlob, peekDecoded } = await import('./decodeCache.ts');

/* ── one decode serves every caller ───────────────────────────────────────── */

{
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' });
  const want = makeBuffer('clip-a');
  const fake = new FakeContext().will({ kind: 'resolve', buffer: want });

  // The live mixer decodes it for playback…
  const first = await decodeClipBlob(fake.ctx, blob);
  assert.equal(first, want);
  assert.equal(fake.calls.length, 1);

  // …and the bounce that follows reuses the very same buffer. Equality here is
  // identity, not deep-equality: a second AudioBuffer is the 85 MB we are
  // trying not to allocate twice.
  const second = await decodeClipBlob(fake.ctx, blob);
  assert.equal(second, want, 'a cached clip is not decoded again');
  assert.equal(fake.calls.length, 1, 'no second decodeAudioData call');

  // It really was handed the clip's bytes. That a DETACHING decoder — which is
  // what the real decodeAudioData is — cannot break a later decode of the same
  // Blob is proved below, in the block where the fake detaches for real.
  assert.equal(fake.calls[0].byteLength, 4);

  // The synchronous readers the live scheduler uses see it without awaiting.
  assert.equal(peekDecoded(fake.ctx, blob), want);

  // The timeout guard was armed at the value the live mixer has always used,
  // and disarmed once the decode won the race.
  assert.equal(DECODE_TIMEOUT_MS, 15000);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15000);
  assert.equal(timers[0].cancelled, true, 'a won race leaves no 15 s timer behind');
}

/* ── distinct clips are distinct entries ──────────────────────────────────── */

{
  const blobA = new Blob([new Uint8Array([9])], { type: 'audio/wav' });
  const blobB = new Blob([new Uint8Array([9])], { type: 'audio/wav' });
  const bufA = makeBuffer('a');
  const bufB = makeBuffer('b');
  const fake = new FakeContext()
    .will({ kind: 'resolve', buffer: bufA })
    .will({ kind: 'resolve', buffer: bufB });

  assert.equal(await decodeClipBlob(fake.ctx, blobA), bufA);
  // Same bytes, different Blob object: keyed by identity, so an edited clip
  // (which gets a fresh Blob) re-decodes instead of playing the stale audio.
  assert.equal(await decodeClipBlob(fake.ctx, blobB), bufB);
  assert.equal(fake.calls.length, 2);
  assert.equal(peekDecoded(fake.ctx, blobA), bufA);
  assert.equal(peekDecoded(fake.ctx, blobB), bufB);
}

/* ── a buffer is only reused at the rate that asked for it ────────────────── */

{
  const blob = new Blob([new Uint8Array([4, 4])], { type: 'audio/wav' });
  const at48 = makeBuffer('live-48k', 48000);
  const at44 = makeBuffer('bounce-44k1', 44100);

  // The live engine context on a 48 kHz output device: decodeAudioData resamples
  // the 44.1 kHz source up on the way in, and the live path plays that.
  const live = new FakeContext(48000).will({ kind: 'resolve', buffer: at48 });
  assert.equal(await decodeClipBlob(live.ctx, blob), at48);

  // A bounce now runs. Its OfflineAudioContext is 44100 and it decodes at 44100
  // to match, so its source needs no resampling at all. Handing it the 48 kHz
  // buffer would silently insert a 44.1 → 48 → 44.1 round trip AND make the
  // bounce differ depending on whether the user pressed play first.
  const bounce = new FakeContext(44100).will({ kind: 'resolve', buffer: at44 });
  assert.equal(
    await decodeClipBlob(bounce.ctx, blob),
    at44,
    'a bounce at 44100 does not inherit the live 48 kHz buffer',
  );
  assert.equal(bounce.calls.length, 1, 'it really decoded at its own rate');

  // Both entries stand: each caller keeps getting the buffer at its own rate,
  // and neither re-decodes.
  assert.equal(await decodeClipBlob(live.ctx, blob), at48);
  assert.equal(live.calls.length, 1, 'the live entry was not evicted by the bounce');
  assert.equal(await decodeClipBlob(bounce.ctx, blob), at44);
  assert.equal(bounce.calls.length, 1);

  assert.equal(peekDecoded(live.ctx, blob), at48);
  assert.equal(peekDecoded(bounce.ctx, blob), at44);

  // The renderers all pin 44100, so they share with each other unconditionally —
  // which is the dedupe a single bounce of a timeline reusing one clip relies on.
  const otherRenderer = new FakeContext(44100);
  assert.equal(await decodeClipBlob(otherRenderer.ctx, blob), at44);
  assert.equal(otherRenderer.calls.length, 0, 'a second renderer at 44100 reuses the buffer');
}

/* ── a clip not yet decoded ───────────────────────────────────────────────── */

{
  const fake = new FakeContext();
  const blob = new Blob([new Uint8Array([7])], { type: 'audio/wav' });
  assert.equal(peekDecoded(fake.ctx, blob), undefined, 'an undecoded clip peeks as undefined');
}

/* ── two callers racing for one clip decode it once ───────────────────────── */

{
  const blob = new Blob([new Uint8Array([5, 5])], { type: 'audio/wav' });
  const want = makeBuffer('shared');
  let release!: (b: AudioBuffer) => void;
  const fake = new FakeContext();
  fake.decodeAudioData = ((data: ArrayBuffer) => {
    fake.calls.push(data);
    return new Promise<AudioBuffer>((resolve) => {
      release = resolve;
    });
  }) as typeof fake.decodeAudioData;

  // Playback starts and a bounce is kicked off before the decode returns.
  const live = decodeClipBlob(fake.ctx, blob);
  const bounce = decodeClipBlob(fake.ctx, blob);
  await settle();
  assert.equal(fake.calls.length, 1, 'the in-flight decode is shared, not restarted');

  // Nothing is cached until it actually lands — a half-decoded clip must never
  // be visible to the scheduler.
  assert.equal(peekDecoded(fake.ctx, blob), undefined);

  release(want);
  assert.equal(await live, want);
  assert.equal(await bounce, want, 'both callers get the one buffer');
  assert.equal(peekDecoded(fake.ctx, blob), want);
}

/* ── a failed decode is not remembered ────────────────────────────────────── */

{
  const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])], { type: 'audio/wav' });
  const good = makeBuffer('recovered');
  const fake = new FakeContext()
    .will({ kind: 'reject', error: new Error('EncodingError') })
    .will({ kind: 'resolve', buffer: good });

  // The real decodeAudioData DETACHES the ArrayBuffer it is handed, so this fake
  // does too. Byte lengths are recorded before detaching, because afterwards the
  // recorded buffer reads as empty.
  const handed: number[] = [];
  const inner = fake.decodeAudioData.bind(fake);
  fake.decodeAudioData = ((data: ArrayBuffer) => {
    handed.push(data.byteLength);
    const decoding = inner(data);
    structuredClone(data, { transfer: [data] }); // detach, exactly as the decoder does
    return decoding;
  }) as typeof fake.decodeAudioData;

  await assert.rejects(decodeClipBlob(fake.ctx, blob), /EncodingError/);
  assert.equal(peekDecoded(fake.ctx, blob), undefined, 'a rejected decode is not cached');
  assert.equal(fake.calls[0].byteLength, 0, 'the fake really detached the first attempt');

  // …and the clip is not written off: the next attempt really re-decodes, and is
  // handed the WHOLE clip again rather than the husk the failed decode left.
  assert.equal(await decodeClipBlob(fake.ctx, blob), good, 'a later call retries');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(handed, [6, 6], 'the retry gets the full bytes, not a detached buffer');
  assert.equal(peekDecoded(fake.ctx, blob), good);
}

/* ── a shared decode that fails, fails both callers and releases the slot ──── */

{
  const blob = new Blob([new Uint8Array([8, 8])], { type: 'audio/wav' });
  const good = makeBuffer('after-shared-failure');
  let failIt!: (e: Error) => void;
  const fake = new FakeContext();
  let attempt = 0;
  fake.decodeAudioData = ((data: ArrayBuffer) => {
    fake.calls.push(data);
    attempt += 1;
    if (attempt === 1) {
      return new Promise<AudioBuffer>((_, reject) => {
        failIt = reject;
      });
    }
    return Promise.resolve(good);
  }) as typeof fake.decodeAudioData;

  // Playback and a bounce both wait on the one decode…
  const live = decodeClipBlob(fake.ctx, blob);
  const bounce = decodeClipBlob(fake.ctx, blob);
  await settle();
  assert.equal(fake.calls.length, 1);

  // …and it fails. Neither caller may be left hanging on a promise nobody will
  // settle, and neither may quietly receive a buffer that does not exist.
  failIt(new Error('EncodingError'));
  await assert.rejects(live, /EncodingError/);
  await assert.rejects(bounce, /EncodingError/, 'the shared decode fails both callers');
  assert.equal(peekDecoded(fake.ctx, blob), undefined);

  // The in-flight slot was released on the failure, so the clip is retryable —
  // it is not stuck re-awaiting a promise that is known to reject.
  assert.equal(await decodeClipBlob(fake.ctx, blob), good, 'the released slot allows a retry');
  assert.equal(fake.calls.length, 2);
}

/* ── concurrent callers at different rates do not de-dupe each other ───────── */

{
  const blob = new Blob([new Uint8Array([6, 6])], { type: 'audio/wav' });
  const at48 = makeBuffer('live-48k', 48000);
  const at44 = makeBuffer('bounce-44k1', 44100);
  let release48!: (b: AudioBuffer) => void;
  let release44!: (b: AudioBuffer) => void;

  const live = new FakeContext(48000);
  live.decodeAudioData = ((data: ArrayBuffer) => {
    live.calls.push(data);
    return new Promise<AudioBuffer>((resolve) => {
      release48 = resolve;
    });
  }) as typeof live.decodeAudioData;

  const bounce = new FakeContext(44100);
  bounce.decodeAudioData = ((data: ArrayBuffer) => {
    bounce.calls.push(data);
    return new Promise<AudioBuffer>((resolve) => {
      release44 = resolve;
    });
  }) as typeof bounce.decodeAudioData;

  // Playback (device rate) and a bounce (pinned 44100) start together on the
  // same clip. The in-flight de-dupe must be per lane: collapsing these would
  // hand one of them audio at the wrong rate.
  const p48 = decodeClipBlob(live.ctx, blob);
  const p44 = decodeClipBlob(bounce.ctx, blob);
  await settle();
  assert.equal(live.calls.length, 1, 'the 48 kHz lane decoded');
  assert.equal(bounce.calls.length, 1, 'the 44.1 kHz lane decoded separately');

  release48(at48);
  release44(at44);
  assert.equal(await p48, at48);
  assert.equal(await p44, at44);
  assert.notEqual(await p48, await p44, 'two buffers, one per rate');
  assert.equal(peekDecoded(live.ctx, blob), at48, 'each lands in its own lane');
  assert.equal(peekDecoded(bounce.ctx, blob), at44);
}

/* ── the timeout rejects and does not poison the cache ────────────────────── */

{
  const blob = new Blob([new Uint8Array([3, 3, 3])], { type: 'audio/wav' });
  const good = makeBuffer('second-try');
  const fake = new FakeContext().will({ kind: 'hang' }).will({ kind: 'resolve', buffer: good });

  const stuck = decodeClipBlob(fake.ctx, blob);
  await settle();
  const armed = timers.filter((t) => !t.cancelled && !t.fired);
  assert.equal(armed.length, 1, 'a decode in flight has exactly one deadline armed');
  assert.equal(armed[0].ms, 15000);

  elapse();
  await assert.rejects(stuck, /decodeAudioData timeout/);

  // The clip is still playable: a stalled decode leaves no entry behind, so the
  // next play or bounce tries again instead of inheriting the failure forever.
  assert.equal(peekDecoded(fake.ctx, blob), undefined, 'a timed-out decode is not cached');
  assert.equal(await decodeClipBlob(fake.ctx, blob), good, 'a later call retries');
  assert.equal(fake.calls.length, 2);
}

/* ── a decode that loses the race and lands late is discarded ─────────────── */

{
  const blob = new Blob([new Uint8Array([2, 2, 2])], { type: 'audio/wav' });
  const tooLate = makeBuffer('arrived-after-the-deadline');
  const fresh = makeBuffer('fresh');
  let resolveLate!: (b: AudioBuffer) => void;
  const fake = new FakeContext();
  let attempt = 0;
  fake.decodeAudioData = ((data: ArrayBuffer) => {
    fake.calls.push(data);
    attempt += 1;
    if (attempt === 1) {
      return new Promise<AudioBuffer>((resolve) => {
        resolveLate = resolve;
      });
    }
    return Promise.resolve(fresh);
  }) as typeof fake.decodeAudioData;

  const stuck = decodeClipBlob(fake.ctx, blob);
  await settle();
  const armed = timers.filter((t) => !t.cancelled && !t.fired);
  assert.equal(armed.length, 1);
  elapse();
  await assert.rejects(stuck, /decodeAudioData timeout/);

  // The decoder finally comes back — a slow file on a busy machine, not an
  // error. The caller has already been told it failed, so this buffer must be
  // dropped on the floor: writing it now would resurrect a decode nobody is
  // waiting for and hand it to whoever asks next.
  resolveLate(tooLate);
  await settle();
  assert.equal(peekDecoded(fake.ctx, blob), undefined, 'a late buffer never lands in the cache');

  // The next caller decodes afresh and gets ITS buffer, not the stale one.
  assert.equal(await decodeClipBlob(fake.ctx, blob), fresh, 'the next call decodes afresh');
  assert.equal(fake.calls.length, 2);
  assert.equal(peekDecoded(fake.ctx, blob), fresh);
}

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

console.log('shared decode cache: dedupe, in-flight sharing, timeout and failure recovery passed');
