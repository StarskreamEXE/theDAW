// The Web Audio side of pitch bend, on a context that records what a voice does
// with it: the automation a bent voice gets, every built-in voice's oscillators
// following the bend, and the roll's notes as render input.
import assert from 'node:assert/strict';
import { BEND_TAIL_SEC, scheduleBendAutomation, stepNotesToRender, voiceContext, type VoiceBend } from './pitchBendVoice.ts';
import { bendAutomation, loopedBendAutomation, rollRenderBends, wheelRawStep, type BendPoint, type BendShape } from './pitchBend.ts';
import { SYNTH_VOICES } from './synthVoices.ts';

const P = (step: number, value: number, shape: BendShape = 'linear', id = `p${step}`): BendPoint => ({ id, step, value, shape });

type Call = [kind: string, value: number, time: number];

/** An AudioParam that records its automation. */
class FakeParam {
  calls: Call[] = [];
  value = 0;
  setValueAtTime(v: number, t: number) {
    this.calls.push(['set', v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['ramp', v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(['exp', v, t]);
    return this;
  }
  setTargetAtTime(v: number, t: number) {
    this.calls.push(['target', v, t]);
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

interface FakeNode {
  kind: string;
  connections: unknown[];
  started?: number;
  stopped?: number;
  detune: FakeParam;
  offset: FakeParam;
  [param: string]: unknown;
}

/** A node that records its connections and start and stop, with every AudioParam a voice reaches for. */
const makeNode = (kind: string): FakeNode => {
  const node: Record<string, unknown> = { kind, connections: [] };
  node.connect = (dest: unknown) => {
    (node.connections as unknown[]).push(dest);
    return dest;
  };
  node.disconnect = () => {};
  node.start = (t: number) => {
    node.started = t;
  };
  node.stop = (t: number) => {
    node.stopped = t;
  };
  return new Proxy(node, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target)) target[prop] = new FakeParam();
      return target[prop as string];
    },
  }) as FakeNode;
};

const real = new WeakSet<object>();

/** A context whose methods and getters throw unless called on the context itself, as a browser's do. */
class FakeCtx {
  currentTime = 5;
  oscillators: FakeNode[] = [];
  constants: FakeNode[] = [];
  constructor() {
    real.add(this);
  }
  private own() {
    if (!real.has(this)) throw new TypeError('Illegal invocation');
  }
  get sampleRate(): number {
    this.own();
    return 44100;
  }
  createOscillator() {
    this.own();
    const o = makeNode('oscillator');
    this.oscillators.push(o);
    return o;
  }
  createConstantSource() {
    this.own();
    const c = makeNode('constant');
    this.constants.push(c);
    return c;
  }
  createGain() {
    this.own();
    return makeNode('gain');
  }
  createBiquadFilter() {
    this.own();
    return makeNode('biquad');
  }
  createStereoPanner() {
    this.own();
    return makeNode('stereo-panner');
  }
  createPanner() {
    this.own();
    return makeNode('panner');
  }
  createWaveShaper() {
    this.own();
    return makeNode('shaper');
  }
}

const asCtx = (c: FakeCtx) => c as unknown as BaseAudioContext;

// The automation lands on the parameter at its times: step `originStep` at `when`, a step every `stepSec`.
{
  const param = new FakeParam();
  const bend: VoiceBend = {
    events: [{ step: 14, cents: 200, ramp: false }, { step: 16, cents: 0, ramp: false }, { step: 18, cents: 33.5, ramp: true }],
    originStep: 14,
    stepSec: 0.125,
  };
  scheduleBendAutomation(param as unknown as AudioParam, bend, 10);
  assert.deepEqual(param.calls, [['set', 200, 10], ['set', 0, 10.25], ['ramp', 33.5, 10.5]]);
}

// A bent voice: one constant source carries the bend into the detune of every oscillator the voice makes; everything else is the context's own.
{
  const ctx = new FakeCtx();
  const bend: VoiceBend = { events: bendAutomation([P(0, 0), P(4, 1, 'hold')], 2, 0, 6), originStep: 0, stepSec: 0.1 };
  const voiceCtx = voiceContext(asCtx(ctx), bend, 10, 0.5);
  assert.notEqual(voiceCtx, asCtx(ctx));
  const o1 = voiceCtx.createOscillator() as unknown as FakeNode;
  voiceCtx.createGain();
  const o2 = voiceCtx.createOscillator() as unknown as FakeNode;
  assert.equal(voiceCtx.sampleRate, 44100);
  assert.equal(ctx.constants.length, 1);
  const src = ctx.constants[0];
  assert.deepEqual(src.connections, [o1.detune, o2.detune]);
  assert.deepEqual(src.offset.calls, [['set', 0, 10], ['ramp', 200, 10.4]]);
  assert.equal(src.started, 10);
  assert.equal(src.stopped, 10 + 0.5 + BEND_TAIL_SEC);
  // A bend that stays at 0, or none, hands the voice the context itself.
  const flat: VoiceBend = { events: [{ step: 0, cents: 0, ramp: false }], originStep: 0, stepSec: 0.1 };
  assert.equal(voiceContext(asCtx(ctx), flat, 10, 0.5), asCtx(ctx));
  assert.equal(voiceContext(asCtx(ctx), undefined, 10, 0.5), asCtx(ctx));
  assert.equal(ctx.constants.length, 1);
}

// Every built-in voice builds through a bent context, and every oscillator it makes follows the bend.
{
  const bend: VoiceBend = { events: bendAutomation([P(0, 0), P(2, -1, 'smooth'), P(4, 1)], 12, 0, 8), originStep: 0, stepSec: 0.125 };
  assert.ok(SYNTH_VOICES.length > 0);
  for (const voice of SYNTH_VOICES) {
    const ctx = new FakeCtx();
    const dest = makeNode('destination') as unknown as AudioNode;
    voice.trigger(voiceContext(asCtx(ctx), bend, 1, 0.5), dest, 60, 100, 1, 0.5, 1);
    // The bend source is made before the voice runs, so it is the first; a voice may make constant sources of its own (a wobble's cutoff).
    const src = ctx.constants[0];
    assert.equal(src.offset.calls.length, bend.events.length, `${voice.id}: the first constant source carries the bend`);
    assert.ok(ctx.oscillators.length > 0, `${voice.id}: makes oscillators`);
    assert.deepEqual(src.connections, ctx.oscillators.map((o) => o.detune), `${voice.id}: every oscillator bends`);
  }
}

// The roll's scheduler for a note near the end of a looping roll: the curve held at the end, starting over, ramping on.
{
  const played = { range: 2, points: [P(0, 0, 'linear'), P(12, 1, 'hold')] };
  const stepSec = 0.125;
  const { events, originStep } = loopedBendAutomation(played, 16, 14, 4 + BEND_TAIL_SEC / stepSec);
  const param = new FakeParam();
  scheduleBendAutomation(param as unknown as AudioParam, { events, originStep, stepSec }, 20);
  assert.deepEqual(param.calls.map(([kind]) => kind), ['set', 'set', 'ramp']);
  const [[, held, t0], [, restart, t1], [, ramped, t2]] = param.calls;
  assert.deepEqual([held, t0, restart, t1], [200, 20, 0, 20.25]);
  assert.ok(Math.abs(ramped - 140) < 1e-9 && Math.abs(t2 - 21.3) < 1e-9, `ramp ${ramped} at ${t2}`);
}

// Step notes as render notes: with no bend, the four fields a render has always taken; with bends, each note's channel and bend, and each bent lane's wheel.
{
  const notes = [
    { note: 60, velocity: 100, step: 0, length: 4 },
    { note: 64, velocity: 90, step: 2, length: 2, lane: 1 },
    { note: 67, velocity: 80, step: 4, length: 1, lane: 9 },
  ];
  assert.deepEqual(stepNotesToRender(notes, 0.125), {
    notes: [
      { midi: 60, velocity: 100, startSec: 0, durationSec: 0.5 },
      { midi: 64, velocity: 90, startSec: 0.25, durationSec: 0.25 },
      { midi: 67, velocity: 80, startSec: 0.5, durationSec: 0.125 },
    ],
    wheel: [],
  });
  const lanes = [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: null }];
  const bends = rollRenderBends([{ lane: 1, range: 12, points: [P(2, 0), P(4, 1, 'hold')] }], lanes, 16);
  const out = stepNotesToRender(notes, 0.125, bends);
  assert.deepEqual(out.notes.map((n) => [n.midi, n.channel, !!n.bend]), [[60, 0, false], [64, 1, true], [67, 0, false]]);
  assert.deepEqual(out.notes[1].bend, {
    events: [{ step: 2, cents: 0, ramp: false }, { step: 4, cents: 1200, ramp: true }],
    originStep: 2,
    stepSec: 0.125,
  });
  assert.equal(out.wheel.length, 1);
  const [w] = out.wheel;
  // At a range of 12 the ramp's messages move wheelRawStep(12) positions (about 3 cents): the centre, the centre again
  // at step 2 where the ramp starts, the stairs, the top.
  assert.deepEqual([w.channel, w.range, w.events.length], [1, 12, 2 + Math.ceil(8191 / wheelRawStep(12))]);
  assert.deepEqual(w.events[1], { sec: 0.25, raw: 8192 });
  assert.ok(w.events.every((e, i) => i === 0 || Math.abs(e.raw - w.events[i - 1].raw) <= wheelRawStep(12)));
  assert.deepEqual(w.events[0], { sec: 0, raw: 8192 });
  assert.deepEqual(w.events[w.events.length - 1], { sec: 0.5, raw: 16383 });
}

console.log('pitchBendVoice: ok');
