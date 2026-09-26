/**
 * `analyzeBufferAsync` — the Worker offload path (DJ-2).
 *
 * The sibling `DJSemanticWaveform.b12.test.ts` pins the NO-Worker half: under
 * node/tsx `Worker` is undefined, so the async entry point falls back to the
 * synchronous analysis. That leaves the half that actually matters in the
 * browser — the offload itself — unpinned, so this file installs a fake
 * `Worker` BEFORE importing the module (the module memoises its worker in
 * module state, so the global has to exist at import time) and pins:
 *
 *  - the analysis really leaves the main thread (the resolved bins are the
 *    ones the worker sent, so nothing recomputed them here);
 *  - exactly ONE worker is ever constructed, shared by every request;
 *  - two instances mounting together share ONE in-flight request — the
 *    default DJ layout mounts two `DJSemanticWaveform`s per deck and they
 *    must not analyse the same audio twice;
 *  - the worker is fed COPIES of the channel data, never the `AudioBuffer`'s
 *    own arrays: `postMessage` DETACHES what it transfers, and detaching the
 *    engine's channel storage would silence the deck that is playing it;
 *  - a worker that reports an error falls back to the in-process analysis
 *    rather than leaving the lane blank, and stays usable afterwards.
 *
 * Run: `npx tsx src/components/audio/djSemanticWaveformAnalysis.worker.test.ts`
 * — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import type { WaveBin } from './djSemanticWaveformAnalysis.ts';

const g = globalThis as unknown as Record<string, unknown>;

// ── fake Worker + the `document` its availability check requires ───────────

type AnalyzeRequest = {
  id: number;
  channels: Float32Array[];
  length: number;
  sampleRate: number;
  bins: number;
  normalize: boolean;
};
type AnalyzeResponse = { id: number; bins: WaveBin[] } | { id: number; error: string };

/** A recognisable result the main thread could not possibly have computed:
 *  if `analyzeBufferAsync` resolves to THIS array, the work really happened
 *  on the other side of the `postMessage`. */
function sentinelBins(tag: string): WaveBin[] {
  return [
    { peak: 1, rms: 1, min: -1, max: 1, low: 1, mid: 1, bright: 1, transient: 1, color: tag },
  ];
}

type Post = { message: AnalyzeRequest; transfer: unknown[] };

let replyMode: 'bins' | 'error' = 'bins';
let replyTag = 'worker-0';

class FakeWorker {
  static instances = 0;
  static posts: Post[] = [];
  onmessage: ((event: { data: AnalyzeResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(_url: URL, _opts?: unknown) {
    FakeWorker.instances += 1;
  }
  postMessage(message: AnalyzeRequest, transfer: unknown[] = []): void {
    FakeWorker.posts.push({ message, transfer });
    const mode = replyMode;
    const tag = replyTag;
    // A real worker answers on a later turn of the event loop; replying
    // synchronously here would hide ordering bugs in the pending-request map.
    queueMicrotask(() => {
      this.onmessage?.({
        data: mode === 'error' ? { id: message.id, error: 'worker blew up' } : { id: message.id, bins: sentinelBins(tag) },
      });
    });
  }
  terminate(): void {}
}

g.Worker = FakeWorker;
// `getAnalysisWorker` refuses to build a Worker without a `document` (that is
// how it detects "we are ourselves inside a worker"). A bare object is enough.
g.document = g.document ?? {};

const { analyzeBufferAsync, analyzeChannels, binCountFor, evictAnalysis } = await import(
  './djSemanticWaveformAnalysis.ts'
);

// ── fixture ───────────────────────────────────────────────────────────────

/** Stereo, with `duration` driving the BIN COUNT and `length` the loop work,
 *  so a cheap fixture can still stand in for a 3.5-minute track's sizing. */
function stereoBuffer(counter: { calls: number }, duration = 210): AudioBuffer {
  const length = 20000;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    left[i] = Math.sin(i * 0.01) * 0.6;
    right[i] = Math.sin(i * 0.013) * 0.4;
  }
  return {
    numberOfChannels: 2,
    length,
    duration,
    sampleRate: 44100,
    getChannelData(ch: number) {
      counter.calls += 1;
      return ch === 0 ? left : right;
    },
  } as unknown as AudioBuffer;
}

// ── the analysis leaves the main thread ───────────────────────────────────

{
  evictAnalysis('worker-a.wav');
  FakeWorker.posts = [];
  replyMode = 'bins';
  replyTag = 'from-worker';

  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const bins = await analyzeBufferAsync('worker-a.wav', buffer, { normalize: true, width: 1200 });

  assert.equal(FakeWorker.instances, 1, 'one Worker is constructed for the whole module');
  assert.equal(FakeWorker.posts.length, 1, 'and the analysis is posted to it exactly once');
  assert.equal(bins[0].color, 'from-worker', 'the resolved bins are the WORKER’s — nothing recomputed them here');
  assert.equal(bins.length, 1, 'the main thread did not analyse the buffer itself');

  const request = FakeWorker.posts[0].message;
  assert.equal(request.bins, binCountFor(210, 1200), 'the worker is told the width-derived bin count');
  assert.equal(request.normalize, true);
  assert.equal(request.length, buffer.length);
  assert.equal(request.sampleRate, buffer.sampleRate);
  assert.equal(request.channels.length, 2, 'both channels are sent');
}

// ── the worker gets COPIES, never the buffer's own channel storage ─────────

{
  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const liveLeft = buffer.getChannelData(0);
  const sent = FakeWorker.posts[0].message.channels;

  assert.notEqual(sent[0], liveLeft, 'the transferred array must not BE the buffer’s channel array');
  assert.notEqual(
    sent[0].buffer,
    liveLeft.buffer,
    'nor share its ArrayBuffer — transferring detaches it, silencing the deck that is playing this audio',
  );
  assert.deepEqual(Array.from(sent[0].slice(0, 8)), Array.from(liveLeft.slice(0, 8)), 'but it is the same audio');
  assert.equal(
    FakeWorker.posts[0].transfer[0],
    sent[0].buffer,
    'the copies themselves are transferred, so the copy is moved rather than cloned again',
  );
  assert.equal(liveLeft.length, buffer.length, 'and the live channel array is untouched');
}

// ── two instances mounting together share ONE request ─────────────────────

{
  evictAnalysis('worker-b.wav');
  FakeWorker.posts = [];
  replyTag = 'shared';

  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const [first, second] = await Promise.all([
    analyzeBufferAsync('worker-b.wav', buffer, { normalize: true, width: 1200 }),
    analyzeBufferAsync('worker-b.wav', buffer, { normalize: true, width: 1200 }),
  ]);

  assert.equal(FakeWorker.posts.length, 1, 'the deck’s two waveform instances share one worker request');
  assert.equal(first, second, 'and get the very same analysed array');
  assert.equal(FakeWorker.instances, 1, 'still only ever one Worker');

  // A third caller after it resolved is a memo hit, not a fourth request.
  const third = await analyzeBufferAsync('worker-b.wav', buffer, { normalize: true, width: 1200 });
  assert.equal(third, first, 'a later caller is served from the memo');
  assert.equal(FakeWorker.posts.length, 1, 'with no further worker traffic');

  // A different lane width is a different bin count, so it IS a new request.
  await analyzeBufferAsync('worker-b.wav', buffer, { normalize: true, width: 40 });
  assert.equal(FakeWorker.posts.length, 2, 'a narrower lane analyses at its own bin count');
  assert.equal(FakeWorker.posts[1].message.bins, binCountFor(210, 40));
}

// ── a worker error falls back to the in-process analysis ──────────────────

{
  evictAnalysis('worker-c.wav');
  FakeWorker.posts = [];
  replyMode = 'error';

  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const bins = await analyzeBufferAsync('worker-c.wav', buffer, { normalize: true, width: 40 });

  assert.equal(FakeWorker.posts.length, 1, 'the request was attempted on the worker');
  const expected = analyzeChannels(
    [buffer.getChannelData(0), buffer.getChannelData(1)],
    buffer.length,
    buffer.sampleRate,
    binCountFor(210, 40),
    true,
  );
  assert.equal(bins.length, expected.length, 'a failed worker analysis still produces a full set of bins');
  assert.deepEqual(bins[0], expected[0], 'computed in-process, identically');
  assert.notEqual(bins[0].color, 'shared', 'and it is not a stale worker result');

  // The worker itself is still healthy: a message-level error must not poison
  // it the way `onerror` (a dead worker) deliberately does.
  replyMode = 'bins';
  replyTag = 'recovered';
  evictAnalysis('worker-d.wav');
  const after = await analyzeBufferAsync('worker-d.wav', buffer, { normalize: true, width: 1200 });
  assert.equal(after[0].color, 'recovered', 'the next analysis still goes to the worker');
  assert.equal(FakeWorker.instances, 1, 'and no replacement worker was built');
}

console.log('djSemanticWaveformAnalysis.worker.test.ts OK');
