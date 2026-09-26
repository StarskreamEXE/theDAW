/**
 * DJSemanticWaveform — batch-12 fixes (T21).
 *
 * FE-008: `getMonoSample` used to call `AudioBuffer.getChannelData(ch)` once
 *   per sample read, and `getChannelData` is allowed to copy on every call.
 *   `analyzeBuffer` must fetch each channel's array exactly once (via
 *   `getChannels`) and index into the cached arrays for every sample.
 * FE-021: `drawWaveform` painted an opaque background gradient unconditionally,
 *   which defeated `transparentBg` (SemanticWave embeds the canvas over an
 *   already-coloured panel). The gradient fill must be skipped when the
 *   caller asks for a transparent background.
 * FE-011: a failed decode used to fall through to the exact same thin
 *   centre-line render as "no data yet" — a broken audio URL was invisible.
 *   `drawWaveform` must paint a distinct, visible failure state.
 *
 * Pure helpers only: no React, no real DOM canvas (not available under plain
 * node/tsx) — a minimal fake canvas/context records what was drawn.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/components/audio/DJSemanticWaveform.b12.test.ts`
 * — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  analyzeBuffer,
  analyzeBufferAsync,
  analyzeBufferMemo,
  binCountFor,
  drawWaveform,
  drawWaveformCached,
  evictAnalysis,
  getChannels,
  getMonoSample,
} from './djSemanticWaveformAnalysis.ts';
import type { CanvasBox } from '../../lib/canvasScale.ts';

// ── FE-008: getChannelData is fetched once per channel, not per sample ─────

{
  let callCount = 0;
  const chLeft = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const chRight = new Float32Array([0.5, 0.6, 0.7, 0.8]);
  const fakeBuffer = {
    numberOfChannels: 2,
    length: 4,
    duration: 4 / 44100,
    sampleRate: 44100,
    getChannelData(ch: number) {
      callCount += 1;
      return ch === 0 ? chLeft : chRight;
    },
  } as unknown as AudioBuffer;

  const channels = getChannels(fakeBuffer);
  assert.equal(callCount, 2, 'getChannelData must be called exactly once per channel');
  assert.equal(channels.length, 2);

  // Reading many samples afterwards must not call getChannelData again.
  for (let i = 0; i < fakeBuffer.length; i += 1) getMonoSample(channels, i);
  assert.equal(callCount, 2, 'getMonoSample must reuse the cached channel arrays, not re-fetch per sample');

  // The mono mix is still the average of the channels at that index.
  const mixed = getMonoSample(channels, 1);
  // Float32Array values round-trip with float32 precision, not float64.
  assert.ok(Math.abs(mixed - (0.2 + 0.6) / 2) < 1e-6);
}

{
  // analyzeBuffer (the real per-sample analysis loop) must also only call
  // getChannelData once per channel regardless of the buffer's sample count.
  let callCount = 0;
  const length = 20000; // several analysis bins' worth
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) data[i] = Math.sin(i * 0.01) * 0.5;
  const fakeBuffer = {
    numberOfChannels: 1,
    length,
    duration: length / 44100,
    sampleRate: 44100,
    getChannelData(_ch: number) {
      callCount += 1;
      return data;
    },
  } as unknown as AudioBuffer;

  const bins = analyzeBuffer(fakeBuffer);
  assert.equal(callCount, 1, 'analyzeBuffer must fetch each channel once, never per sample');
  assert.ok(bins.length > 0);
}

// ── Fake canvas/context for drawWaveform assertions ─────────────────────────

type FillCall = { kind: 'fillRect' | 'strokeRect'; style: unknown; x: number; y: number; w: number; h: number };
type ImageCall = { source: unknown; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number };

function makeFakeCanvas() {
  const calls: FillCall[] = [];
  const gradients: string[] = [];
  const images: ImageCall[] = [];
  let fillStyle: unknown = null;
  let strokeStyle: unknown = null;

  const ctx = {
    clearRect() {},
    drawImage(source: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
      images.push({ source, sx, sy, sw, sh, dx, dy, dw, dh });
    },
    createLinearGradient() {
      gradients.push('created');
      return { addColorStop(_offset: number, color: string) { gradients.push(color); } };
    },
    setTransform() {},
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'fillRect', style: fillStyle, x, y, w, h });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'strokeRect', style: strokeStyle, x, y, w, h });
    },
    fillText() {},
    set fillStyle(v: unknown) { fillStyle = v; },
    get fillStyle() { return fillStyle; },
    set strokeStyle(v: unknown) { strokeStyle = v; },
    get strokeStyle() { return strokeStyle; },
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
  };

  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;

  return { canvas, calls, gradients, images };
}

const BOX: CanvasBox = { cssWidth: 200, cssHeight: 64, deviceWidth: 200, deviceHeight: 64, scale: 1, zoom: 1, dpr: 1 };

// ── FE-021: transparentBg must not be covered by the opaque bg gradient ────

{
  const { canvas, gradients } = makeFakeCanvas();
  drawWaveform(canvas, BOX, [], 0, 1, true, null);
  assert.equal(gradients.length, 0, 'transparent=true must skip the opaque background gradient entirely');
}

{
  const { canvas, gradients } = makeFakeCanvas();
  drawWaveform(canvas, BOX, [], 0, 1, false, null);
  assert.ok(gradients.length > 0, 'transparent=false must still paint the background gradient (unchanged default behaviour)');
}

// ── FE-011: a decode failure paints a distinct, visible state ──────────────

{
  const { canvas, calls } = makeFakeCanvas();
  drawWaveform(canvas, BOX, [], 0, 1, false, 'Unable to load audio waveform: 404');
  const strokes = calls.filter((c) => c.kind === 'strokeRect');
  assert.ok(strokes.length > 0, 'a decode error must draw a visible border, not the silent "no data" line');
  assert.ok(
    String(strokes[0].style).includes('255, 89, 64'),
    'the error state must use the failure colour, not the neutral "no data" colour',
  );
}

{
  // The pre-existing "no data yet" (bins empty, no error) state is unchanged:
  // a faint centre line, not the red error indicator.
  const { canvas, calls } = makeFakeCanvas();
  drawWaveform(canvas, BOX, [], 0, 1, false, null);
  const strokes = calls.filter((c) => c.kind === 'strokeRect');
  assert.equal(strokes.length, 0, 'the plain "no data yet" state must not draw the error border');
}

// ══ DJ-2: the deck's main-thread burst at load ═════════════════════════════

// ── bins come from the CONSUMING canvas width, not a flat 6,400 ────────────

{
  // Unchanged behaviour when nothing says how wide the canvas is.
  assert.equal(binCountFor(210, undefined), 6400, 'no width: the historical 6,400 cap');
  assert.equal(binCountFor(210, 0), 6400, 'a not-yet-measured (zero) width falls back to the cap too');

  // A 34-44 px overview lane used to compute the full 6,400 bins — 4*width
  // is far below the 900 floor, so it settles on the floor.
  assert.equal(binCountFor(210, 40), 900, 'a 40 px overview lane computes the floor, not 6,400 bins');

  // A wide zoomed lane: capped at 4 bins per pixel, still under 6,400.
  assert.equal(binCountFor(210, 1200), 4800, '4 bins per pixel caps a 1200 px lane');

  // A short track still never drops below the 900 floor.
  assert.equal(binCountFor(20, 1200), 900, 'the 900-bin floor is unchanged');

  // And the width cap never INCREASES the bin count past the old behaviour.
  assert.equal(binCountFor(210, 4000), 6400, 'the absolute 6,400 cap still wins over 4*width');
}

// ── the analysis is memoised per (url, normalize, bins) ────────────────────

/** `duration` drives the BIN COUNT while `length` drives the analysis loop, so
 *  a cheap 20k-sample fixture can still stand in for a 3.5-minute track's bin
 *  sizing (which is the thing `width` changes). */
function countingBuffer(seed: number, counter: { calls: number }, duration = 210): AudioBuffer {
  const length = 20000;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) data[i] = Math.sin(i * 0.01 + seed) * 0.5;
  return {
    numberOfChannels: 1,
    length,
    duration,
    sampleRate: 44100,
    getChannelData(_ch: number) {
      counter.calls += 1;
      return data;
    },
  } as unknown as AudioBuffer;
}

{
  evictAnalysis('memo-a.wav');
  const counter = { calls: 0 };
  const buffer = countingBuffer(0, counter);

  const first = analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, width: 40 });
  const second = analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, width: 40 });
  assert.equal(counter.calls, 1, 'the SECOND waveform instance for the same URL must cost nothing');
  assert.equal(first, second, 'and gets the very same analysed bins array back');

  // A different `normalize` is a different cache key — it must re-analyse.
  const flipped = analyzeBufferMemo('memo-a.wav', buffer, { normalize: false, width: 40 });
  assert.equal(counter.calls, 2, 'flipping normalize is a different analysis');
  assert.notEqual(first, flipped);

  // A different bin count (a wider lane) is also a different key.
  analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, width: 1200 });
  assert.equal(counter.calls, 3, 'a wider lane analyses at its own bin count');

  // The async entry point (the one the component calls) resolves to the same
  // memoised array without re-analysing when no Worker exists — which is the
  // path these node/tsx tests exercise.
  assert.equal(typeof (globalThis as Record<string, unknown>).Worker, 'undefined', 'no Worker under node/tsx');
  const viaAsync = await analyzeBufferAsync('memo-a.wav', buffer, { normalize: true, width: 40 });
  assert.equal(viaAsync, first, 'analyzeBufferAsync returns the memoised bins');
  assert.equal(counter.calls, 3, 'and does not re-run the analysis');

  // Evicting the URL drops every one of its keyed entries.
  evictAnalysis('memo-a.wav');
  analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, width: 40 });
  assert.equal(counter.calls, 4, 'evictAnalysis clears the memo for that URL');
}

// ── the analysis is instrumented as `dj:analyze:<url>` ─────────────────────

{
  evictAnalysis('measured.wav');
  const counter = { calls: 0 };
  const buffer = countingBuffer(1, counter);
  const measures: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const realPerf = g.performance as Record<string, unknown> | undefined;
  g.performance = {
    now: () => 0,
    mark: () => undefined,
    measure: (name: string) => { measures.push(name); return undefined; },
    clearMarks: () => undefined,
    clearMeasures: () => undefined,
  };
  analyzeBufferMemo('measured.wav', buffer, { normalize: true, width: 40 });
  g.performance = realPerf;
  assert.ok(
    measures.includes('dj:analyze:measured.wav'),
    `analysis must emit a "dj:analyze:<url>" measure — got ${JSON.stringify(measures)}`,
  );
}

// ── repaint: the full view is unchanged, a viewport pan is a blit ──────────

// `drawWaveformCached` builds its offscreen render with
// `document.createElement('canvas')`; under plain node there is no document,
// so one is faked here with the same recording canvas as above.
const offscreens: Array<ReturnType<typeof makeFakeCanvas>> = [];
(globalThis as unknown as Record<string, unknown>).document = {
  createElement(tag: string) {
    assert.equal(tag, 'canvas', 'the offscreen cache only ever creates canvases');
    const fake = makeFakeCanvas();
    offscreens.push(fake);
    return fake.canvas;
  },
};

const REAL_BINS = analyzeBuffer(countingBuffer(2, { calls: 0 }));

{
  offscreens.length = 0;
  const direct = makeFakeCanvas();
  drawWaveform(direct.canvas, BOX, REAL_BINS, 0, 1, false, null);

  const cached = makeFakeCanvas();
  drawWaveformCached(cached.canvas, BOX, REAL_BINS, 0, 1, false, null, 'full-view');

  // `createLinearGradient` hands back a fresh object each time, so compare a
  // projection where a gradient style is just "gradient" — every other style
  // is the literal colour string and is compared exactly.
  const normalize = (calls: typeof direct.calls) =>
    calls.map((c) => ({ ...c, style: typeof c.style === 'object' && c.style !== null ? 'gradient' : String(c.style) }));
  assert.deepEqual(
    normalize(cached.calls),
    normalize(direct.calls),
    'the full view must paint exactly what drawWaveform always painted, call for call',
  );
  assert.deepEqual(cached.gradients, direct.gradients, 'including every gradient stop');
  assert.equal(cached.images.length, 0, 'the full view blits nothing');
  assert.equal(offscreens.length, 0, 'and allocates no offscreen canvas at all');
}

{
  offscreens.length = 0;
  const first = makeFakeCanvas();
  drawWaveformCached(first.canvas, BOX, REAL_BINS, 0.2, 0.4, false, null, 'zoomed');
  assert.equal(offscreens.length, 1, 'a zoomed view renders the whole track once, offscreen');
  const paintedOnce = offscreens[0].calls.length;
  assert.ok(paintedOnce > 0, 'the offscreen actually holds a rendered waveform');
  assert.equal(first.images.length, 1, 'and the visible slice is blitted onto the real canvas');

  // The hot path: the viewport moves ~6x/second per deck while a deck plays.
  const panned = makeFakeCanvas();
  drawWaveformCached(panned.canvas, BOX, REAL_BINS, 0.25, 0.45, false, null, 'zoomed');
  assert.equal(offscreens.length, 1, 'panning the viewport must NOT re-render the waveform');
  assert.equal(offscreens[0].calls.length, paintedOnce, 'the cached offscreen is never repainted');
  assert.equal(panned.images.length, 1, 'the pan is one blit');
  assert.notEqual(first.images[0].sx, panned.images[0].sx, 'at a shifted source offset');

  // Changing the ZOOM (the span) is a different render and does rebuild.
  const zoomed = makeFakeCanvas();
  drawWaveformCached(zoomed.canvas, BOX, REAL_BINS, 0.25, 0.65, false, null, 'zoomed');
  assert.equal(offscreens.length, 2, 'a different zoom span rebuilds the offscreen render');
}

{
  // A decode error and the "no data yet" state keep going straight through to
  // drawWaveform — the FE-011 / FE-021 behaviour pinned above is untouched.
  offscreens.length = 0;
  const errored = makeFakeCanvas();
  drawWaveformCached(errored.canvas, BOX, REAL_BINS, 0.2, 0.4, false, 'Unable to load audio waveform: 404', 'err');
  assert.ok(errored.calls.some((c) => c.kind === 'strokeRect'), 'the error state still paints its border');
  assert.equal(offscreens.length, 0, 'and never builds an offscreen render');

  const empty = makeFakeCanvas();
  drawWaveformCached(empty.canvas, BOX, [], 0.2, 0.4, false, null, 'empty');
  assert.equal(empty.images.length, 0);
  assert.equal(offscreens.length, 0);
}

console.log('DJSemanticWaveform.b12.test.ts OK');
