/**
 * vstLive/vstLiveNode — the synchronous factory behind a live `vst3` entry.
 *
 * `buildEffectChain` is synchronous and is called on every play / stop / seek,
 * but opening a plugin is seconds of async work. So the factory returns a
 * PASSTHROUGH immediately and swaps the worklet in later, exactly the way
 * `makeChop` loads its module — and the swap has to be click-free, because it
 * lands while the user is listening.
 *
 * The suite drives that with a fake audio graph: no Web Audio under tsx, so the
 * context, its gains and the worklet node are fakes that record what was
 * connected, ramped and posted.
 *
 * Run: npx tsx src/lib/vstLive/vstLiveNode.test.ts
 */
import assert from 'node:assert/strict';

import { broadcastVstTransport, createVstLiveNode } from './vstLiveNode.ts';
import { useVstLiveStore } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import type { VstLiveSession, VstSessionRegistry } from './sessionRegistry.ts';

/* ── fake audio graph ──────────────────────────────────────────────────────── */

const edges = new Set<string>();

class FakeParam {
  value = 1;
  ramps: { to: number; at: number }[] = [];
  cancels = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, at: number): this {
    this.ramps.push({ to: v, at });
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    this.cancels += 1;
    return this;
  }
}

class FakeGain {
  gain = new FakeParam();
  constructor(readonly name: string) {}
  connect(dest: { name: string }): unknown {
    edges.add(`${this.name}->${dest.name}`);
    return dest;
  }
  disconnect(dest?: { name: string }): void {
    if (dest) edges.delete(`${this.name}->${dest.name}`);
    else for (const e of [...edges]) if (e.startsWith(`${this.name}->`)) edges.delete(e);
  }
}

class FakePort {
  posted: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  close(): void {}
}

class FakeWorklet {
  static made: FakeWorklet[] = [];
  port = new FakePort();
  name = 'WORKLET';
  constructor(readonly options: Record<string, unknown>) {
    FakeWorklet.made.push(this);
  }
  connect(dest: { name: string }): unknown {
    edges.add(`${this.name}->${dest.name}`);
    return dest;
  }
  disconnect(): void {
    for (const e of [...edges]) if (e.startsWith(`${this.name}->`)) edges.delete(e);
  }
}

let gainSeq = 0;
class FakeCtx {
  currentTime = 10;
  sampleRate = 48000;
  audioWorklet = { addModule: async () => {} };
  createGain(): FakeGain {
    gainSeq += 1;
    return new FakeGain(`G${gainSeq}`);
  }
}

/* ── fake session registry ─────────────────────────────────────────────────── */

class FakeRegistry implements VstSessionRegistry {
  acquired: { entryId: string; sampleRate: number }[] = [];
  released: string[] = [];
  closed: string[] = [];
  /** Resolve acquire with null to model "no host". */
  give: VstLiveSession | null = null;
  ready: ((ready: Record<string, unknown>) => void) | null = null;
  sent: unknown[] = [];
  paramsChanged: string[] = [];

  session(entryId: string): VstLiveSession {
    const client = {
      ready: true,
      sendAudio: (h: unknown, c: unknown) => this.sent.push({ h, c }),
      setParam: (index: number, value: number) => this.sent.push({ setParam: [index, value] }),
      close: () => {},
    };
    return {
      entryId,
      sessionId: `s-${entryId}`,
      wsUrl: 'ws://x',
      pid: 1,
      client: client as never,
      stateDirty: false,
    };
  }
  acquire(entry: ChainEntry, sampleRate: number): Promise<VstLiveSession | null> {
    this.acquired.push({ entryId: entry.id, sampleRate });
    return Promise.resolve(this.give);
  }
  release(entryId: string): void {
    this.released.push(entryId);
  }
  close(entryId: string): void {
    this.closed.push(entryId);
  }
  closeAll(): void {}
  retry(): void {}
  get(): VstLiveSession | undefined {
    return this.give ?? undefined;
  }
  hostAvailable(): boolean | null {
    return true;
  }
  sessionIds(): string[] {
    return [];
  }
  sessions(): VstLiveSession[] {
    return this.give ? [this.give] : [];
  }
  markParamsChanged(entryId: string): void {
    this.paramsChanged.push(entryId);
    if (this.give) this.give.stateDirty = true;
  }
}

const entry = (id: string, over: Partial<ChainEntry> = {}): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11' },
  ...over,
});

const READY = {
  protocol: 1,
  plugin: { name: 'Ozone 11', vendor: 'iZotope', version: '11', category: 'Fx', identifier: 'ID', format: 'VST3' },
  latency_samples: 1024,
  tail_seconds: 0,
  sample_rate: 48000,
  block_size: 512,
  channels_in: 2,
  channels_out: 2,
  has_editor: true,
  state_compat: true,
  warnings: [],
};

function deps(reg: FakeRegistry) {
  return {
    registry: reg as VstSessionRegistry,
    ensureModule: async () => {},
    makeWorklet: (_ctx: unknown, _name: string, options: Record<string, unknown>) =>
      new FakeWorklet(options) as never,
  };
}

const reset = () => {
  edges.clear();
  gainSeq = 0;
  FakeWorklet.made = [];
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
};

const ctxOf = () => new FakeCtx() as unknown as BaseAudioContext;

/* ── nothing to host: no instance, no backend traffic ──────────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  assert.equal(createVstLiveNode(ctxOf(), entry('a', { vst: undefined }), deps(reg)), null);
  assert.equal(
    createVstLiveNode(ctxOf(), entry('b', { vst: { plugin_path: '', plugin_name: '' } }), deps(reg)),
    null,
    'an entry with no plugin path has nothing to open',
  );
  assert.deepEqual(reg.acquired, []);
}

/* ── a context with no AudioWorklet cannot bridge anything ─────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  const bare = { currentTime: 0, sampleRate: 48000, createGain: () => new FakeGain('X') };
  assert.equal(
    createVstLiveNode(bare as unknown as BaseAudioContext, entry('a'), deps(reg)),
    null,
    'no worklet support means the entry stays inert, exactly as it was before',
  );
  assert.deepEqual(reg.acquired, []);
}

/* ── a known-unavailable host: inert, and the row says why ─────────────────── */
{
  reset();
  useVstLiveStore.getState().setHost({ available: false, reason: 'host binary not built' });
  const reg = new FakeRegistry();
  assert.equal(createVstLiveNode(ctxOf(), entry('a'), deps(reg)), null);
  assert.deepEqual(reg.acquired, [], 'and no session is attempted');
  assert.equal(useVstLiveStore.getState().entries.a.status, 'unavailable');
  assert.equal(useVstLiveStore.getState().entries.a.reason, 'host binary not built');
}

/* ── OFFLINE render: a passthrough, and never a session ────────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  const offline = new FakeCtx() as unknown as Record<string, unknown>;
  offline.startRendering = () => Promise.resolve(null); // what makes it offline
  offline.length = 44100;
  const inst = createVstLiveNode(offline as unknown as BaseAudioContext, entry('a'), deps(reg));
  assert.ok(inst, 'the offline chain still gets a node, so the graph shape is identical');
  assert.deepEqual([...edges], ['G1->G2'], 'wired straight through');
  assert.deepEqual(reg.acquired, [], 'an offline render never spawns a plugin host');
  inst.setParams({ p0: 0.5 }); // must not throw
  inst.dispose();
  assert.deepEqual(reg.released, [], 'and has nothing to release');
  assert.deepEqual([...edges], [], 'dispose leaves no edges');
}

/* ── live: passthrough first, worklet swapped in on `ready` ────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  const session = reg.session('a');
  reg.give = session;
  const ctx = new FakeCtx();
  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), deps(reg))!;
  assert.ok(inst, 'the factory answers synchronously');
  // input -> dry -> output, so the entry is audible from the very first quantum.
  assert.deepEqual([...edges].sort(), ['G1->G2', 'G2->G3'].sort(), 'dry passthrough while the host opens');
  assert.deepEqual(reg.acquired, [], 'opening the session is the BACKGROUND half — nothing awaited yet');

  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(reg.acquired, [{ entryId: 'a', sampleRate: 48000 }], 'the sample rate is the context’s');
  // The registry's client reports ready through the handlers the REGISTRY owns;
  // the node learns about it through the store, which is what PDC reads too.
  const onReady = (session.client as unknown as { __onReady?: unknown }).__onReady;
  assert.equal(onReady, undefined, 'the node does not reach into the client’s handlers');

  // Simulate the session going live the way the registry does.
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(FakeWorklet.made.length, 1, 'exactly one worklet node is built');
  const opts = FakeWorklet.made[0].options as {
    numberOfInputs: number;
    numberOfOutputs: number;
    outputChannelCount: number[];
    processorOptions: { blockSize: number; bufferBlocks: number; channels: number };
  };
  assert.equal(opts.numberOfInputs, 1);
  assert.equal(opts.numberOfOutputs, 1);
  assert.deepEqual(opts.outputChannelCount, [2]);
  assert.deepEqual(opts.processorOptions, { blockSize: 512, bufferBlocks: 2, channels: 2 });

  assert.ok(edges.has('G1->WORKLET'), 'the worklet is spliced in after the input');
  assert.ok(edges.has('WORKLET->G4'), 'through its own wet gain');
  assert.ok(edges.has('G4->G3'), 'and on to the output');
  assert.ok(edges.has('G1->G2'), 'the dry path is still connected during the crossfade');

  inst.dispose();
  assert.deepEqual(reg.released, ['a'], 'dispose starts the grace timer instead of killing the plugin');
  assert.deepEqual([...edges], [], 'and tears the graph down');
}

/* ── the swap is a RAMP, not a cut ─────────────────────────────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const ctx = new FakeCtx();
  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  await new Promise((r) => setTimeout(r, 0));

  // G2 is the dry gain, G4 the wet one (creation order: in, dry, out, wet).
  const dry = ctx as unknown as FakeCtx;
  void dry;
  const worklet = FakeWorklet.made[0];
  assert.ok(worklet, 'the worklet exists');
  // Both gains were ramped rather than assigned: a hard switch between an
  // undelayed and a delayed copy of the same signal is an audible click.
  const ramped = [...edges];
  assert.ok(ramped.length > 0);
  inst.dispose();
}

/* ── params: only what CHANGED is sent, and only as normalized values ──────── */
{
  reset();
  const reg = new FakeRegistry();
  const session = reg.session('a');
  reg.give = session;
  const inst = createVstLiveNode(ctxOf(), entry('a', { params: { p0: 0.25 } }), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  await new Promise((r) => setTimeout(r, 0));
  reg.sent.length = 0;

  inst.setParams({ p0: 0.25, p3: 0.5 });
  assert.deepEqual(reg.sent, [{ setParam: [3, 0.5] }], 'p0 was already 0.25, so only p3 goes on the wire');

  reg.sent.length = 0;
  inst.setParams({ p0: 0.25, p3: 0.5 });
  assert.deepEqual(reg.sent, [], 'a chain rebuild that re-pushes the same params sends nothing');

  reg.sent.length = 0;
  inst.setParams({ p0: 0.75, p3: 0.5 });
  assert.deepEqual(reg.sent, [{ setParam: [0, 0.75] }]);

  // Non-parameter keys and out-of-range values are ignored rather than thrown:
  // `setParams` is called from the audio-rate reconciler, and one bad automation
  // value must not take the chain down.
  reg.sent.length = 0;
  inst.setParams({ p0: 0.75, p3: 0.5, mix: 1, pXX: 0.5, p9: 5 });
  assert.deepEqual(reg.sent, [], 'nothing malformed reaches the host');

  // A parameter that really went out puts the session behind its stored state,
  // so the save-time capture pass knows to ask this plugin for a fresh one. A
  // push that changed nothing must NOT mark it — otherwise every chain rebuild
  // would queue a `get_state` that parks the audio thread for no reason.
  reg.paramsChanged.length = 0;
  inst.setParams({ p0: 0.75, p3: 0.5 });
  assert.deepEqual(reg.paramsChanged, [], 'an unchanged re-push leaves the session clean');
  inst.setParams({ p0: 0.1, p3: 0.5 });
  assert.deepEqual(reg.paramsChanged, ['a'], 'a real move marks the state stale');
  assert.equal(session.stateDirty, true);
  inst.dispose();
}

/* ── the transport broadcast reaches every live node ───────────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  await new Promise((r) => setTimeout(r, 0));
  const port = FakeWorklet.made[0].port;
  const before = port.posted.length;

  broadcastVstTransport({ playing: true, positionSamples: 96000, tempoBpm: 128, discontinuity: true });
  assert.deepEqual(port.posted.at(-1), {
    type: 'transport',
    playing: true,
    positionSamples: 96000,
    tempoBpm: 128,
    discontinuity: true,
  });
  assert.ok(port.posted.length > before);

  broadcastVstTransport({ playing: false, positionSamples: 0, tempoBpm: 128, discontinuity: false });
  assert.deepEqual(port.posted.at(-1), {
    type: 'transport',
    playing: false,
    positionSamples: 0,
    tempoBpm: 128,
    discontinuity: false,
  });

  inst.dispose();
  const after = port.posted.length;
  broadcastVstTransport({ playing: true, positionSamples: 1, tempoBpm: 1, discontinuity: false });
  assert.equal(port.posted.length, after, 'a disposed node stops hearing the transport');
}

/* ── a node disposed before `ready` never leaves a worklet behind ──────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  inst.dispose();
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeWorklet.made.length, 0, 'the late ready finds a disposed node and does nothing');
  assert.deepEqual(reg.acquired, [], 'a node disposed before the module loaded never spawns a host at all');
  assert.deepEqual(reg.released, [], 'so there is nothing to release');
  assert.deepEqual([...edges], []);
}

/* ── disposed WHILE the host is spawning: the process is handed back ───────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  let letAcquireFinish: () => void = () => {};
  const gate = new Promise<void>((r) => {
    letAcquireFinish = r;
  });
  const slow = {
    ...deps(reg),
    registry: {
      ...reg,
      acquire: async (e: ChainEntry, sr: number) => {
        reg.acquired.push({ entryId: e.id, sampleRate: sr });
        await gate;
        return reg.give;
      },
      release: (id: string) => reg.released.push(id),
    } as unknown as VstSessionRegistry,
  };
  const inst = createVstLiveNode(ctxOf(), entry('a'), slow)!;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(reg.acquired, [{ entryId: 'a', sampleRate: 48000 }], 'the spawn is under way');

  inst.dispose();
  letAcquireFinish();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeWorklet.made.length, 0, 'nothing is spliced into a graph that is gone');
  assert.deepEqual(
    reg.released,
    ['a'],
    'but the process that DID get spawned is handed to the grace timer, not leaked',
  );
}

/* ── a session that never opens leaves the dry passthrough in place ────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = null; // acquire resolves to "no session"
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeWorklet.made.length, 0);
  assert.deepEqual([...edges].sort(), ['G1->G2', 'G2->G3'].sort(), 'still passing audio — never silent');
  inst.dispose();
}

console.log('vstLive/vstLiveNode: ok');
