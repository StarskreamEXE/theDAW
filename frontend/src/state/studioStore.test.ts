// Run with: npx tsx src/state/studioStore.test.ts
//
// One studio run at a time. EDIT's PROCESS (triggerPendingProcess) and MIX's
// CHAIN (processChain) share studioStore's source, output and isProcessing, so a
// press while either runs must send nothing. Replayed in the order a real double
// click and a real run produce: two presses in one tick, presses and the other
// triggers while the request is out, the run ending, then the next press.
//
// A refused press is never awaited: without the guard it would wait on the stub
// request, which only answers when the test says so, and the test would hang
// where it has to fail.
import assert from 'node:assert/strict';
import { useStudioStore } from './studioStore.ts';

const calls: string[] = [];
const pending: Array<(r: Response) => void> = [];
globalThis.fetch = ((input: RequestInfo | URL) => {
  calls.push(typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url);
  return new Promise<Response>((resolve) => pending.push(resolve));
}) as typeof fetch;

const sent = (path: string): number => calls.filter((u) => u === path).length;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** The stub backend answers the oldest open request with a failure, which ends that run. */
const failPending = (): void => {
  const resolve = pending.shift();
  assert.ok(resolve, 'a request is out');
  resolve(new Response(JSON.stringify({ detail: 'stub backend' }), { status: 500 }));
};

(async () => {
  const studio = useStudioStore.getState;
  useStudioStore.setState({ sourceFile: new File(['RIFF'], 'source.wav', { type: 'audio/wav' }) });

  // (a) A double click: two presses in the same tick start one process.
  const first = studio().triggerPendingProcess();
  void studio().triggerPendingProcess();
  await tick();
  assert.equal(sent('/api/studio/process'), 1, 'the second press of a double click sends nothing');
  assert.equal(studio().isProcessing, true);

  // (b) While the request is out, a later press and every other trigger of a
  // studio run are refused: a direct processAudio, a VST stage, MIX's chain.
  void studio().triggerPendingProcess();
  void studio().processAudio({ effect: 'mastering_chain', params: {} });
  void studio().processVst({ pluginPath: 'plugin.vst3', pluginName: 'Plugin', params: {} });
  void studio().processChain();
  await tick();
  assert.equal(sent('/api/studio/process'), 1, 'nothing else reached /api/studio/process');
  assert.equal(sent('/api/vst/process-file'), 0, 'no VST stage started');
  assert.equal(studio().isChainProcessing, false, 'the chain did not start');

  // (c) The run ends; the next press starts exactly one new process.
  failPending();
  await first;
  assert.equal(studio().isProcessing, false, 'the failed run released the studio');
  const second = studio().triggerPendingProcess();
  await tick();
  assert.equal(sent('/api/studio/process'), 2, 'a press after the run ended starts one');
  failPending();
  await second;

  // (d) While MIX's chain renders, EDIT's PROCESS sends nothing.
  useStudioStore.setState({ isChainProcessing: true });
  void studio().triggerPendingProcess();
  await tick();
  assert.equal(sent('/api/studio/process'), 2, 'PROCESS waits for the chain');
  useStudioStore.setState({ isChainProcessing: false });

  assert.equal(pending.length, 0, 'no request left open');
  console.log('studioStore: one studio run at a time');
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
