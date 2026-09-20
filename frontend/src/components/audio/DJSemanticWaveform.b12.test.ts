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
  drawWaveform,
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

function makeFakeCanvas() {
  const calls: FillCall[] = [];
  const gradients: string[] = [];
  let fillStyle: unknown = null;
  let strokeStyle: unknown = null;

  const ctx = {
    clearRect() {},
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

  return { canvas, calls, gradients };
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

console.log('DJSemanticWaveform.b12.test.ts OK');
