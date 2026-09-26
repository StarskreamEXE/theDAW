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
import type { WaveBin } from './djSemanticWaveformAnalysis.ts';
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
function countingBuffer(seed: number, counter: { calls: number }, duration = 210, sampleRate = 44100): AudioBuffer {
  const length = 20000;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) data[i] = Math.sin(i * 0.01 + seed) * 0.5;
  return {
    numberOfChannels: 1,
    length,
    duration,
    sampleRate,
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

// ── the memo key includes the buffer's SAMPLE RATE ────────────────────────

{
  // The analysis reads frequency bands out of the samples, so the rate the
  // buffer was decoded at changes the RESULT — `bandPower` is handed
  // `sampleRate / stride`. Keyed on (url, normalize, bins) alone, a buffer
  // re-decoded at another rate silently reused the first rate's bins.
  evictAnalysis('rate-memo.wav');
  const counter = { calls: 0 };
  const at44 = countingBuffer(3, counter, 210, 44100);
  const at48 = countingBuffer(3, counter, 210, 48000);

  const bins44 = analyzeBufferMemo('rate-memo.wav', at44, { normalize: true, width: 40 });
  assert.equal(counter.calls, 1);
  const bins48 = analyzeBufferMemo('rate-memo.wav', at48, { normalize: true, width: 40 });
  assert.equal(counter.calls, 2, 'a buffer decoded at another sample rate is a different analysis');
  assert.notEqual(bins44, bins48, 'and gets its own bins');

  assert.equal(analyzeBufferMemo('rate-memo.wav', at44, { normalize: true, width: 40 }), bins44);
  assert.equal(counter.calls, 2, 'each rate keeps its own memo entry');

  evictAnalysis('rate-memo.wav');
  analyzeBufferMemo('rate-memo.wav', at48, { normalize: true, width: 40 });
  assert.equal(counter.calls, 3, 'evictAnalysis drops every rate for that URL');
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
    // Delegation, not proof: the golden above is what pins the output.
    'the full view must delegate to drawWaveform, call for call',
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

// DJ-2R item 4: a golden of the PRE-DJ-2 full-view render.
//
// The "pixel-identical" check below compares `drawWaveformCached` against
// `drawWaveform`, which it delegates to for the full view — true by
// construction, and blind to the thing that could actually have broken:
// DJ-2 carved `drawWaveBody` / `paintGuides` / `paintSpine` / `paintVignette`
// out of what was one straight-line `drawWaveform`. THIS is the check that
// the extraction changed nothing: the call sequence below was generated once
// from `git show e190ee0:.../djSemanticWaveformAnalysis.ts` — the last
// revision before DJ-2 — and is compared against today's output for the same
// bins and the same box.
//
// Regenerating it is only correct if the waveform is MEANT to look different.

/** Fixed, hand-built bins: the golden is about DRAWING, so its input must not
 *  depend on the analysis. Covers a beat-coloured bin (the low rail), a
 *  silence-coloured one, and a spread of band energies. */
function goldenBins(): WaveBin[] {
  const colors = ['#ff3f4f', '#72ee78', '#2ea9ff', '#f5b84b', '#bca8ff', 'rgba(72, 83, 100, 0.45)'];
  const out: WaveBin[] = [];
  for (let i = 0; i < 12; i += 1) {
    const t = i / 11;
    out.push({
      peak: 0.15 + t * 0.8,
      rms: 0.08 + t * 0.4,
      min: -(0.1 + t * 0.7),
      max: 0.12 + t * 0.75,
      low: (i % 3) / 2,
      mid: ((i + 1) % 4) / 3,
      bright: ((i + 2) % 5) / 4,
      transient: (i % 6) / 5,
      color: colors[i % colors.length],
    });
  }
  return out;
}

const GOLDEN_BOX: CanvasBox = { cssWidth: 24, cssHeight: 16, deviceWidth: 24, deviceHeight: 16, scale: 1, zoom: 1, dpr: 1 };

const GOLDEN_CALLS: string[] = [
  "fillRect|gradient|0.0000|0.0000|24.0000|16.0000",
  "fillRect|rgba(255,255,255,0.035)|0.0000|4.0000|24.0000|1.0000",
  "fillRect|rgba(255,255,255,0.035)|0.0000|12.0000|24.0000|1.0000",
  "fillRect|rgba(255,255,255,0.055)|0.0000|7.5000|24.0000|1.0000",
  "fillRect|rgba(255, 89, 64, 0.39073887273085706)|0.0000|6.1983|1.0000|3.6034",
  "fillRect|rgba(30, 144, 255, 0.06662091123078989)|0.0000|6.6988|1.0000|2.6025",
  "fillRect|rgba(76, 241, 112, 0.20906666666666668)|0.0000|6.7989|1.0000|2.4023",
  "fillRect|rgba(255, 182, 65, 0.28)|0.0000|7.0000|1.0000|2.0000",
  "fillRect|rgba(255, 89, 64, 0.2)|0.0000|14.0000|1.0000|1.0000",
  "fillRect|rgba(255, 89, 64, 0.39073887273085706)|1.0000|6.1983|1.0000|3.6034",
  "fillRect|rgba(30, 144, 255, 0.06662091123078989)|1.0000|6.6988|1.0000|2.6025",
  "fillRect|rgba(76, 241, 112, 0.20906666666666668)|1.0000|6.7989|1.0000|2.4023",
  "fillRect|rgba(255, 182, 65, 0.28)|1.0000|7.0000|1.0000|2.0000",
  "fillRect|rgba(255, 89, 64, 0.2)|1.0000|14.0000|1.0000|1.0000",
  "fillRect|rgba(76, 241, 112, 0.4278942950987756)|2.0000|5.7340|1.0000|4.5320",
  "fillRect|rgba(30, 144, 255, 0.24348101061147662)|2.0000|5.8284|1.0000|4.3432",
  "fillRect|rgba(76, 241, 112, 0.3659151515151515)|2.0000|6.0487|1.0000|3.9025",
  "fillRect|rgba(255, 182, 65, 0.43700000000000006)|2.0000|6.6467|1.0000|2.7066",
  "fillRect|rgba(76, 241, 112, 0.4278942950987756)|3.0000|5.7340|1.0000|4.5320",
  "fillRect|rgba(30, 144, 255, 0.24348101061147662)|3.0000|5.8284|1.0000|4.3432",
  "fillRect|rgba(76, 241, 112, 0.3659151515151515)|3.0000|6.0487|1.0000|3.9025",
  "fillRect|rgba(255, 182, 65, 0.43700000000000006)|3.0000|6.6467|1.0000|2.7066",
  "fillRect|rgba(46, 169, 255, 0.461234540759595)|4.0000|5.3305|1.0000|5.3391",
  "fillRect|rgba(30, 144, 255, 0.41944342135519885)|4.0000|4.8114|1.0000|6.3772",
  "fillRect|rgba(76, 241, 112, 0.5227636363636363)|4.0000|5.3305|1.0000|5.3391",
  "fillRect|rgba(255, 182, 65, 0.5940000000000001)|4.0000|6.1462|1.0000|3.7077",
  "fillRect|rgba(255, 246, 210, 0.17064342135519883)|4.0000|5.4373|1.0000|5.1255",
  "fillRect|rgba(46, 169, 255, 0.47)|4.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(46, 169, 255, 0.461234540759595)|5.0000|5.3305|1.0000|5.3391",
  "fillRect|rgba(30, 144, 255, 0.41944342135519885)|5.0000|4.8114|1.0000|6.3772",
  "fillRect|rgba(76, 241, 112, 0.5227636363636363)|5.0000|5.3305|1.0000|5.3391",
  "fillRect|rgba(255, 182, 65, 0.5940000000000001)|5.0000|6.1462|1.0000|3.7077",
  "fillRect|rgba(255, 246, 210, 0.17064342135519883)|5.0000|5.4373|1.0000|5.1255",
  "fillRect|rgba(46, 169, 255, 0.47)|5.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(255, 182, 65, 0.4920561816333351)|6.0000|4.9670|1.0000|6.0659",
  "fillRect|rgba(30, 144, 255, 0.08481321920784356)|6.0000|5.8095|1.0000|4.3809",
  "fillRect|rgba(76, 241, 112, 0.09294545454545455)|6.0000|6.5678|1.0000|2.8645",
  "fillRect|rgba(255, 182, 65, 0.126)|6.0000|7.0000|1.0000|2.0000",
  "fillRect|rgba(255, 246, 210, 0.3400132192078435)|6.0000|5.0884|1.0000|5.8233",
  "fillRect|rgba(255, 182, 65, 0.4920561816333351)|7.0000|4.9670|1.0000|6.0659",
  "fillRect|rgba(30, 144, 255, 0.08481321920784356)|7.0000|5.8095|1.0000|4.3809",
  "fillRect|rgba(76, 241, 112, 0.09294545454545455)|7.0000|6.5678|1.0000|2.8645",
  "fillRect|rgba(255, 182, 65, 0.126)|7.0000|7.0000|1.0000|2.0000",
  "fillRect|rgba(255, 246, 210, 0.3400132192078435)|7.0000|5.0884|1.0000|5.8233",
  "fillRect|rgba(188, 168, 255, 0.5210469222279449)|8.0000|4.6328|1.0000|6.7345",
  "fillRect|rgba(30, 144, 255, 0.2597522169948106)|8.0000|4.7731|1.0000|6.4539",
  "fillRect|rgba(76, 241, 112, 0.2497939393939394)|8.0000|5.7552|1.0000|4.4896",
  "fillRect|rgba(255, 182, 65, 0.28300000000000003)|8.0000|6.8308|1.0000|2.3384",
  "fillRect|rgba(255, 246, 210, 0.5089522169948105)|8.0000|4.7675|1.0000|6.4651",
  "fillRect|rgba(188, 168, 255, 0.5210469222279449)|9.0000|4.6328|1.0000|6.7345",
  "fillRect|rgba(30, 144, 255, 0.2597522169948106)|9.0000|4.7731|1.0000|6.4539",
  "fillRect|rgba(76, 241, 112, 0.2497939393939394)|9.0000|5.7552|1.0000|4.4896",
  "fillRect|rgba(255, 182, 65, 0.28300000000000003)|9.0000|6.8308|1.0000|2.3384",
  "fillRect|rgba(255, 246, 210, 0.5089522169948105)|9.0000|4.7675|1.0000|6.4651",
  "fillRect|rgba(72, 83, 100, 0.5486251491971231)|10.0000|4.3210|1.0000|7.3580",
  "fillRect|rgba(30, 144, 255, 0.4343588586346172)|10.0000|3.6056|1.0000|8.7887",
  "fillRect|rgba(76, 241, 112, 0.40664242424242425)|10.0000|4.8320|1.0000|6.3361",
  "fillRect|rgba(255, 182, 65, 0.44000000000000006)|10.0000|6.2627|1.0000|3.4746",
  "fillRect|rgba(255, 246, 210, 0.66)|10.0000|4.4682|1.0000|7.0637",
  "fillRect|rgba(46, 169, 255, 0.47)|10.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(72, 83, 100, 0.5486251491971231)|11.0000|4.3210|1.0000|7.3580",
  "fillRect|rgba(30, 144, 255, 0.4343588586346172)|11.0000|3.6056|1.0000|8.7887",
  "fillRect|rgba(76, 241, 112, 0.40664242424242425)|11.0000|4.8320|1.0000|6.3361",
  "fillRect|rgba(255, 182, 65, 0.44000000000000006)|11.0000|6.2627|1.0000|3.4746",
  "fillRect|rgba(255, 246, 210, 0.66)|11.0000|4.4682|1.0000|7.0637",
  "fillRect|rgba(46, 169, 255, 0.47)|11.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(255, 89, 64, 0.5750685450389378)|12.0000|4.0212|1.0000|7.9515",
  "fillRect|rgba(30, 144, 255, 0.09869848118563243)|12.0000|5.1308|1.0000|5.7384",
  "fillRect|rgba(76, 241, 112, 0.563490909090909)|12.0000|4.0273|1.0000|7.9454",
  "fillRect|rgba(255, 182, 65, 0.405)|12.0000|5.6274|1.0000|4.7452",
  "fillRect|rgba(255, 89, 64, 0.2)|12.0000|14.0000|1.0000|1.0000",
  "fillRect|rgba(255, 89, 64, 0.5750685450389378)|13.0000|4.0212|1.0000|7.9515",
  "fillRect|rgba(30, 144, 255, 0.09869848118563243)|13.0000|5.1308|1.0000|5.7384",
  "fillRect|rgba(76, 241, 112, 0.563490909090909)|13.0000|4.0273|1.0000|7.9454",
  "fillRect|rgba(255, 182, 65, 0.405)|13.0000|5.6274|1.0000|4.7452",
  "fillRect|rgba(255, 89, 64, 0.2)|13.0000|14.0000|1.0000|1.0000",
  "fillRect|rgba(76, 241, 112, 0.600572915006052)|14.0000|3.5085|1.0000|8.7430",
  "fillRect|rgba(30, 144, 255, 0.27281715647201227)|14.0000|3.9257|1.0000|8.1486",
  "fillRect|rgba(76, 241, 112, 0.1336727272727273)|14.0000|5.9924|1.0000|4.0153",
  "fillRect|rgba(255, 182, 65, 0.562)|14.0000|5.0476|1.0000|5.9048",
  "fillRect|rgba(255, 246, 210, 0.030017156472012252)|14.0000|3.6882|1.0000|8.3932",
  "fillRect|rgba(76, 241, 112, 0.600572915006052)|15.0000|3.5085|1.0000|8.7430",
  "fillRect|rgba(30, 144, 255, 0.27281715647201227)|15.0000|3.9257|1.0000|8.1486",
  "fillRect|rgba(76, 241, 112, 0.1336727272727273)|15.0000|5.9924|1.0000|4.0153",
  "fillRect|rgba(255, 182, 65, 0.562)|15.0000|5.0476|1.0000|5.9048",
  "fillRect|rgba(255, 246, 210, 0.030017156472012252)|15.0000|3.6882|1.0000|8.3932",
  "fillRect|rgba(46, 169, 255, 0.6252826467725419)|16.0000|2.9958|1.0000|9.5846",
  "fillRect|rgba(30, 144, 255, 0.4467488580641275)|16.0000|2.6040|1.0000|10.7920",
  "fillRect|rgba(76, 241, 112, 0.2905212121212122)|16.0000|4.9883|1.0000|6.0234",
  "fillRect|rgba(255, 182, 65, 0.094)|16.0000|6.9961|1.0000|2.0078",
  "fillRect|rgba(255, 246, 210, 0.1979488580641275)|16.0000|3.1960|1.0000|9.2012",
  "fillRect|rgba(46, 169, 255, 0.47)|16.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(46, 169, 255, 0.6252826467725419)|17.0000|2.9958|1.0000|9.5846",
  "fillRect|rgba(30, 144, 255, 0.4467488580641275)|17.0000|2.6040|1.0000|10.7920",
  "fillRect|rgba(76, 241, 112, 0.2905212121212122)|17.0000|4.9883|1.0000|6.0234",
  "fillRect|rgba(255, 182, 65, 0.094)|17.0000|6.9961|1.0000|2.0078",
  "fillRect|rgba(255, 246, 210, 0.1979488580641275)|17.0000|3.1960|1.0000|9.2012",
  "fillRect|rgba(46, 169, 255, 0.47)|17.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(255, 182, 65, 0.6493079455407463)|18.0000|2.4831|1.0000|10.5759",
  "fillRect|rgba(30, 144, 255, 0.11051951659782266)|18.0000|4.5530|1.0000|6.8940",
  "fillRect|rgba(76, 241, 112, 0.447369696969697)|18.0000|3.8901|1.0000|8.2198",
  "fillRect|rgba(255, 182, 65, 0.251)|18.0000|6.3428|1.0000|3.3144",
  "fillRect|rgba(255, 246, 210, 0.36571951659782265)|18.0000|2.7037|1.0000|10.1528",
  "fillRect|rgba(255, 182, 65, 0.6493079455407463)|19.0000|2.4831|1.0000|10.5759",
  "fillRect|rgba(30, 144, 255, 0.11051951659782266)|19.0000|4.5530|1.0000|6.8940",
  "fillRect|rgba(76, 241, 112, 0.447369696969697)|19.0000|3.8901|1.0000|8.2198",
  "fillRect|rgba(255, 182, 65, 0.251)|19.0000|6.3428|1.0000|3.3144",
  "fillRect|rgba(255, 246, 210, 0.36571951659782265)|19.0000|2.7037|1.0000|10.1528",
  "fillRect|rgba(188, 168, 255, 0.6727352621442041)|20.0000|1.9703|1.0000|11.5671",
  "fillRect|rgba(30, 144, 255, 0.2841494734456951)|20.0000|3.1907|1.0000|9.6187",
  "fillRect|rgba(76, 241, 112, 0.6)|20.0000|2.9816|1.0000|10.0369",
  "fillRect|rgba(255, 182, 65, 0.40800000000000003)|20.0000|5.6302|1.0000|4.7396",
  "fillRect|rgba(255, 246, 210, 0.533349473445695)|20.0000|2.2115|1.0000|11.1044",
  "fillRect|rgba(188, 168, 255, 0.6727352621442041)|21.0000|1.9703|1.0000|11.5671",
  "fillRect|rgba(30, 144, 255, 0.2841494734456951)|21.0000|3.1907|1.0000|9.6187",
  "fillRect|rgba(76, 241, 112, 0.6)|21.0000|2.9816|1.0000|10.0369",
  "fillRect|rgba(255, 182, 65, 0.40800000000000003)|21.0000|5.6302|1.0000|4.7396",
  "fillRect|rgba(255, 246, 210, 0.533349473445695)|21.0000|2.2115|1.0000|11.1044",
  "fillRect|rgba(72, 83, 100, 0.6956339430391494)|22.0000|1.4576|1.0000|12.5584",
  "fillRect|rgba(30, 144, 255, 0.45765504542097635)|22.0000|1.7224|1.0000|12.5553",
  "fillRect|rgba(76, 241, 112, 0.17440000000000003)|22.0000|5.5181|1.0000|4.9637",
  "fillRect|rgba(255, 182, 65, 0.5650000000000001)|22.0000|4.8612|1.0000|6.2776",
  "fillRect|rgba(255, 246, 210, 0.66)|22.0000|1.7193|1.0000|12.0561",
  "fillRect|rgba(46, 169, 255, 0.47)|22.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(72, 83, 100, 0.6956339430391494)|23.0000|1.4576|1.0000|12.5584",
  "fillRect|rgba(30, 144, 255, 0.45765504542097635)|23.0000|1.7224|1.0000|12.5553",
  "fillRect|rgba(76, 241, 112, 0.17440000000000003)|23.0000|5.5181|1.0000|4.9637",
  "fillRect|rgba(255, 182, 65, 0.5650000000000001)|23.0000|4.8612|1.0000|6.2776",
  "fillRect|rgba(255, 246, 210, 0.66)|23.0000|1.7193|1.0000|12.0561",
  "fillRect|rgba(46, 169, 255, 0.47)|23.0000|12.0000|1.0000|3.0000",
  "fillRect|gradient|0.0000|7.5000|24.0000|1.0000",
  "fillRect|gradient|0.0000|0.0000|24.0000|16.0000",
];

const GOLDEN_GRADIENTS: string[] = [
  "created",
  "#06070d",
  "#0e1018",
  "#05060a",
  "created",
  "rgba(255,255,255,0.04)",
  "rgba(255,255,255,0.32)",
  "rgba(255,255,255,0.04)",
  "created",
  "rgba(0,0,0,0.34)",
  "rgba(0,0,0,0)",
  "rgba(0,0,0,0)",
  "rgba(0,0,0,0.36)",
];

/** One line per paint op, so a mismatch names the op that moved. */
function serialize(calls: { kind: string; style: unknown; x: number; y: number; w: number; h: number }[]): string[] {
  return calls.map(
    (c) =>
      `${c.kind}|${typeof c.style === 'object' && c.style !== null ? 'gradient' : String(c.style)}` +
      `|${c.x.toFixed(4)}|${c.y.toFixed(4)}|${c.w.toFixed(4)}|${c.h.toFixed(4)}`,
  );
}

{
  const direct = makeFakeCanvas();
  drawWaveform(direct.canvas, GOLDEN_BOX, goldenBins(), 0, 1, false, null);
  assert.deepEqual(
    serialize(direct.calls),
    GOLDEN_CALLS,
    'drawWaveform must paint exactly what it painted before DJ-2 split it into helpers',
  );
  assert.deepEqual(direct.gradients, GOLDEN_GRADIENTS, 'including every gradient stop, in order');

  const cached = makeFakeCanvas();
  drawWaveformCached(cached.canvas, GOLDEN_BOX, goldenBins(), 0, 1, false, null, 'golden');
  assert.deepEqual(
    serialize(cached.calls),
    GOLDEN_CALLS,
    'and the full view through drawWaveformCached reproduces the same pre-DJ-2 output',
  );
  assert.deepEqual(cached.gradients, GOLDEN_GRADIENTS);
}

// DJ-2R item 1: the cache must engage at the geometry the APP actually uses.
// `DJView`'s detail lane runs at zoom 8 (span 0.125) with
// `viewMin = -visibleFrac / 2`, so the viewport starts BEFORE the track for
// the first ~6% of it and runs past the end for the last ~6%; and its
// `box.scale` is zoom x dpr, which pushes the whole-track offscreen render
// past any fixed device-width ceiling. Rejecting either case sent every
// detail-lane frame - six a second per playing deck - down the slow path,
// which is the entire cost this cache exists to remove.
const LANE: CanvasBox = { cssWidth: 600, cssHeight: 64, deviceWidth: 1200, deviceHeight: 128, scale: 2, zoom: 8, dpr: 2 };

{
  offscreens.length = 0;
  // Start of the track: half the lane is off the left-hand end.
  const head = makeFakeCanvas();
  drawWaveformCached(head.canvas, LANE, REAL_BINS, -0.0625, 0.0625, false, null, 'detail-lane');

  assert.equal(offscreens.length, 1, 'the app\u2019s real detail lane must build an offscreen render');
  assert.equal(head.images.length, 1, 'and blit the in-range part of it');
  // The out-of-range half is left as background: the blit starts halfway
  // across the lane and covers only the half that has audio behind it.
  assert.equal(head.images[0].dx, 300, 'the blit is inset by the part of the viewport before the track');
  assert.equal(head.images[0].dw, 300, 'and covers only the half that has audio');
  assert.equal(head.images[0].sx, 0, 'reading from the very start of the render');

  // End of the track: the overhang is on the right instead.
  const tail = makeFakeCanvas();
  drawWaveformCached(tail.canvas, LANE, REAL_BINS, 0.9375, 1.0625, false, null, 'detail-lane');
  assert.equal(offscreens.length, 1, 'the same zoom reuses the same offscreen render');
  assert.equal(tail.images.length, 1);
  assert.equal(tail.images[0].dx, 0, 'an overhang past the END starts the blit at the left edge');
  assert.equal(tail.images[0].dw, 300, 'and still covers only the half that has audio');

  // And the ordinary mid-track pan at that zoom fills the lane edge to edge.
  const mid = makeFakeCanvas();
  drawWaveformCached(mid.canvas, LANE, REAL_BINS, 0.4, 0.525, false, null, 'detail-lane');
  assert.equal(offscreens.length, 1, 'panning still never re-renders');
  assert.equal(mid.images[0].dx, 0);
  assert.equal(mid.images[0].dw, 600, 'a fully in-range viewport blits the whole lane');
  assert.ok(mid.images[0].sx > 0, 'from further into the render');
}

{
  // The offscreen is bounded rather than abandoned: at zoom 8 / dpr 2 the
  // whole-track render would want 600/0.125 * 2 = 9,600 device px, past the
  // 8,192 ceiling. It is clamped (and resampled on the way out) instead of
  // falling back to the per-frame render.
  offscreens.length = 0;
  const wide = makeFakeCanvas();
  drawWaveformCached(wide.canvas, LANE, REAL_BINS, 0.4, 0.525, false, null, 'bounded');
  assert.equal(offscreens.length, 1, 'a render wider than the device-width ceiling is CLAMPED, not skipped');
  assert.equal(wide.images.length, 1);
  assert.ok(
    wide.images[0].sx + wide.images[0].sw <= 8192,
    'and every blit stays inside the clamped render',
  );
}

{
  // A viewport that covers the whole track, however it over-scrolls, still
  // goes straight to drawWaveform - there is nothing to cache.
  offscreens.length = 0;
  const whole = makeFakeCanvas();
  drawWaveformCached(whole.canvas, LANE, REAL_BINS, -0.1, 1.1, false, null, 'whole');
  assert.equal(offscreens.length, 0, 'a whole-track viewport builds no offscreen render');
  assert.equal(whole.images.length, 0, 'and blits nothing');
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
