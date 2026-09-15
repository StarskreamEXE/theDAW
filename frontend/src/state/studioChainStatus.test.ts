/**
 * The statuses one MIX chain run posts, replayed through studioStore.processChain
 * with the backend answered in-process.
 *
 * - Three backend effects that all succeed: the status line reads MIX CHAIN
 *   STARTED and then MIX CHAIN COMPLETE, and nothing else. No stage posts
 *   STUDIO SOURCE LOADED, STARTED or COMPLETE, so the bubble and its live region
 *   carry two notices for the run, and the LOG holds no per-stage status lines.
 * - The second stage fails: the status line reads MIX CHAIN STARTED and then
 *   MIX CHAIN FAILED at that stage, the stage's own FAILED LOG line is kept, and
 *   the chain's failure adds no second LOG line for the same event.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/state/studioChainStatus.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { useStudioStore } from './studioStore';
import { MIX_RACK_IDS, useEffectChainStore, type ChainEntry } from './effectChainStore';
import { useAdvancedEditorSourceStore } from './advancedEditorStore';
import { useLibraryStore } from './libraryStore';
import { usePlayerStore } from './playerStore';
import { useStatusBarStore } from './statusBarStore';
import { useStatusNoticeStore } from './statusNoticeStore';
import { useLogStore } from './logStore';

const EFFECTS = ['compression', 'highpass', 'volume'];
for (const effect of EFFECTS) assert.ok(!MIX_RACK_IDS.has(effect), `${effect} is a backend effect`);

let failEffect: string | null = null;
const requested: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('blob:')) {
    const blob = resolveObjectURL(url);
    assert.ok(blob, `object URL ${url} resolves`);
    return new Response(blob as unknown as Blob, { headers: { 'content-type': 'audio/wav' } });
  }
  if (url === '/api/studio/process') {
    const effect = String((init?.body as FormData).get('effect'));
    requested.push(effect);
    if (effect === failEffect) {
      return new Response(JSON.stringify({ detail: `${effect} could not run` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(new Blob([new Uint8Array(64)], { type: 'audio/wav' }), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    });
  }
  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

// The library import and the player load are the app's; answer them here.
useLibraryStore.setState({ importEntry: (async () => ({ id: 'chain-test-entry' })) as never });
usePlayerStore.setState({ load: async () => undefined });
useAdvancedEditorSourceStore.setState({ sourceFile: new File([new Uint8Array(64)], 'loop.wav', { type: 'audio/wav' }) });
useEffectChainStore.setState({
  chain: EFFECTS.map((effect, i): ChainEntry => ({ id: `stage-${i}`, effect, params: {}, enabled: true })),
});

const texts: string[] = [];
useStatusBarStore.subscribe((state, prev) => {
  if (state.text !== prev.text) texts.push(state.text);
});
const notices: string[] = [];
useStatusNoticeStore.subscribe((state, prev) => {
  if (state.current && state.current.id !== prev.current?.id) notices.push(state.current.text);
});
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};
const logMsgs = () => useLogStore.getState().entries.map((e) => `${e.level} ${e.msg}`);

// ── Three stages, all succeed ────────────────────────────────────────────────
await useStudioStore.getState().processChain();
await flush();
assert.deepEqual(requested, EFFECTS, 'every stage ran, in order');
assert.equal(texts.length, 2, `two statuses for the run, got: ${JSON.stringify(texts)}`);
assert.match(texts[0], /^MIX CHAIN STARTED: /);
assert.match(texts[1], /^MIX CHAIN COMPLETE: /);
assert.deepEqual(notices, texts, 'the bubble carries the same two');
assert.ok(
  !logMsgs().some((m) => /STUDIO (SOURCE LOADED|PROCESS STARTED|PROCESS COMPLETE)/.test(m)),
  'no per-stage status lines in the LOG',
);
assert.equal(useStudioStore.getState().isChainProcessing, false);

// ── The second stage fails ───────────────────────────────────────────────────
texts.length = 0;
notices.length = 0;
requested.length = 0;
useLogStore.getState().clear();
useStatusNoticeStore.getState().dismiss();
failEffect = 'highpass';
await useStudioStore.getState().processChain();
await flush();
assert.deepEqual(requested, ['compression', 'highpass'], 'the chain stops at the failed stage');
assert.equal(texts.length, 2, `two statuses for the run, got: ${JSON.stringify(texts)}`);
assert.match(texts[0], /^MIX CHAIN STARTED: /);
assert.equal(texts[1], 'MIX CHAIN FAILED at highpass: highpass could not run');
assert.deepEqual(notices, texts);
const log = logMsgs();
assert.ok(log.includes('error effect=highpass FAILED — highpass could not run'), 'the stage keeps its FAILED LOG line');
assert.ok(!log.some((m) => m.includes('MIX CHAIN FAILED')), 'the chain adds no second line for it');
assert.ok(!log.some((m) => /STUDIO PROCESS (STARTED|COMPLETE|FAILED)/.test(m)));

useStatusNoticeStore.getState().dismiss();
globalThis.fetch = realFetch;
console.log('studioChainStatus tests passed');
