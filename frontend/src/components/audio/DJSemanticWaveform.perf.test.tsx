/**
 * DJSemanticWaveform — flipping `normalize` must re-run `analyzeBuffer` in
 * the new mode WITHOUT re-fetching or re-decoding the audio file (audit
 * follow-up #5): the fetch+decode step and the analysis step used to live in
 * ONE effect keyed on `[audioUrl, normalize]`, so a prop that only changes
 * how the SAME already-decoded buffer is scaled re-downloaded and re-decoded
 * the whole file every time it flipped.
 *
 * The fix splits them into two effects: fetch+decode is keyed on `audioUrl`
 * alone and keeps its `AudioBuffer` in state; a second effect, keyed on
 * `[buffer, normalize]`, re-runs `analyzeBuffer` against that SAME buffer.
 *
 * Real component, real React (via react-dom/client + act), under jsdom — the
 * same harness pattern `orb-kit/stream/useChatStream.hook.test.tsx` uses.
 * `fetch` and `window.AudioContext` are stubbed and counted; jsdom's own
 * `canvas.getContext('2d')` returns null with no canvas backend installed,
 * which `drawWaveform` already no-ops on, so no canvas stub is needed.
 *
 * Run: `npx tsx src/components/audio/DJSemanticWaveform.perf.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no ResizeObserver; DJSemanticWaveform's draw effect only needs
// the constructor + observe/disconnect surface, never a real callback.
class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
(g.window as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
g.ResizeObserver = FakeResizeObserver;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DJSemanticWaveform } = await import('./DJSemanticWaveform.tsx');

// ── fetch stub: counts calls, returns a tiny fixed payload every time ───────
let fetchCount = 0;
const lastFetchUrls: string[] = [];
g.fetch = async (input: unknown) => {
  fetchCount += 1;
  lastFetchUrls.push(String(input));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response;
};

// ── decoding context stub: counts decodeAudioData calls ────────────────────
// DJ-2: decoding goes through `lib/djAudioCache`, which decodes with a shared
// OfflineAudioContext (or the engine's context) and must NEVER build a real
// AudioContext — every real one opens the output device, which can glitch the
// engine's playing context on Windows/WASAPI.
let decodeCount = 0;
class FakeOfflineAudioContext {
  static constructed = 0;
  constructor(_channels: number, _length: number, _sampleRate: number) {
    FakeOfflineAudioContext.constructed += 1;
  }
  async decodeAudioData(_buf: ArrayBuffer): Promise<AudioBuffer> {
    decodeCount += 1;
    return {
      numberOfChannels: 1,
      length: 128,
      sampleRate: 44100,
      duration: 128 / 44100,
      getChannelData: () => new Float32Array(128),
    } as unknown as AudioBuffer;
  }
}
class ForbiddenAudioContext {
  constructor() {
    throw new Error('a real AudioContext was constructed for a waveform decode');
  }
}
(g.window as Record<string, unknown>).OfflineAudioContext = FakeOfflineAudioContext;
(g.window as Record<string, unknown>).AudioContext = ForbiddenAudioContext;
g.OfflineAudioContext = FakeOfflineAudioContext;
g.AudioContext = ForbiddenAudioContext;

/** Let the fetch → decode → analyze chain and its state updates settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const root = createRoot(dom.window.document.getElementById('root') as unknown as Element);

// First mount: one fetch, one decode.
await act(async () => {
  root.render(<DJSemanticWaveform audioUrl="track-a.wav" normalize={true} />);
});
await settle();
assert.equal(fetchCount, 1, 'the first mount fetches the audio once');
assert.equal(decodeCount, 1, 'and decodes it once');

// Flip `normalize` for the SAME audioUrl: must re-analyze, must NOT re-fetch
// or re-decode.
await act(async () => {
  root.render(<DJSemanticWaveform audioUrl="track-a.wav" normalize={false} />);
});
await settle();
assert.equal(fetchCount, 1, 'flipping normalize must not re-fetch the audio file');
assert.equal(decodeCount, 1, 'flipping normalize must not re-decode the audio file');

// Flip it right back: still no new fetch/decode — this is not "the first
// flip is cached, the second one is not".
await act(async () => {
  root.render(<DJSemanticWaveform audioUrl="track-a.wav" normalize={true} />);
});
await settle();
assert.equal(fetchCount, 1);
assert.equal(decodeCount, 1);

// Sanity: a truly NEW audioUrl still fetches and decodes — proves the
// counts above are not just stuck at 1 because the stubs are no-ops.
await act(async () => {
  root.render(<DJSemanticWaveform audioUrl="track-b.wav" normalize={true} />);
});
await settle();
assert.equal(fetchCount, 2, 'a new audioUrl does fetch again');
assert.equal(decodeCount, 2, 'and does decode again');
assert.deepEqual(lastFetchUrls, ['track-a.wav', 'track-b.wav'], 'exactly the two real URL changes fetched');

// DJ-2: every decode above ran on ONE shared OfflineAudioContext, and not a
// single real AudioContext was opened (ForbiddenAudioContext would have
// thrown). The old code built — and closed — one real output-device context
// per waveform INSTANCE, and the default deck layout mounts two of them.
assert.equal(FakeOfflineAudioContext.constructed, 1, 'one shared decoding context for every URL');

// DJ-2: a SECOND waveform instance for a URL already loaded must ride the
// shared cache — no second fetch, no second decode.
await act(async () => {
  root.render(
    <>
      <DJSemanticWaveform audioUrl="track-a.wav" normalize={true} />
      <DJSemanticWaveform audioUrl="track-a.wav" normalize={true} />
    </>,
  );
});
await settle();
assert.equal(fetchCount, 2, 'two instances of an already-decoded URL fetch nothing further');
assert.equal(decodeCount, 2, 'and decode nothing further');

await act(async () => {
  root.unmount();
});

console.log('DJSemanticWaveform.perf.test.tsx: ok');
