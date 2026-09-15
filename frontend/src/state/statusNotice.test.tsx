/**
 * Status notices, replayed in the order the app produces them.
 *
 * A save posts a success, then a failure, then the same failure again, and then
 * time passes. Each step checks the LOG entries, the orb bubble's markup and its
 * live region; the last step checks that the bubble is back on the tip it
 * showed. The cases after it: the idle READY value, a caller that writes its own
 * LOG line before or after the post, a repeat once the window has passed, a
 * success that waits out a failure's hold, a start that fails and is retried at
 * once, a fast start and complete whose caller lines name the same effect or
 * path, a call site that logged the event in other words, levels read from the
 * label, and the health poll in launch order and then per heartbeat.
 *
 * setTimeout and Date are node:test mocks, so the run takes no real time.
 * The pointer sequences (hover, click, pointer away) are in
 * components/audio/orbStatusBubble.test.tsx.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/state/statusNotice.test.tsx` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useStatusBarStore } from './statusBarStore';
import { logError, logInfo, logWarn, useLogStore } from './logStore';
import {
  FAILURE_HOLD_MS,
  LOG_MATCH_MS,
  STATUS_FAILURE_MS,
  STATUS_INFO_MS,
  STATUS_REPEAT_MS,
  sameLine,
  sameOutcome,
  statusLevel,
  statusSource,
  useStatusNoticeStore,
} from './statusNoticeStore';
import { OrbTipBubble, bubbleText } from '../components/audio/OrbTipBubble';

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });

const GREETING = 'click me for assistance';
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
};
const setText = async (text: string, options?: Parameters<ReturnType<typeof useStatusBarStore.getState>['setText']>[1]) => {
  useStatusBarStore.getState().setText(text, options);
  await flush();
};
const log = () => useLogStore.getState().entries.map((e) => [e.level, e.source, e.msg]);
const shown = () => useStatusNoticeStore.getState().current;
const bubble = () => renderToStaticMarkup(<OrbTipBubble onOpenLog={() => undefined} />);
const liveRegion = (html: string) => /<span role="status" class="sr-only">(.*?)<\/span>/.exec(html)?.[1];
/** Let every notice go and start the next case on an empty LOG. */
const nextCase = () => {
  mock.timers.tick(STATUS_FAILURE_MS);
  useStatusNoticeStore.getState().dismiss();
  useLogStore.getState().clear();
};

// ── The idle value is not a notice ───────────────────────────────────────────
await setText('READY');
assert.deepEqual(log(), []);
assert.equal(shown(), null);
assert.ok(bubble().includes(GREETING));
assert.equal(liveRegion(bubble()), '');

// ── 1. A success: one info LOG line, and the bubble says it ──────────────────
await setText('SAVED: D:\\Exports\\riff.mid');
assert.deepEqual(log(), [['info', 'files', 'SAVED: D:\\Exports\\riff.mid']]);
let html = bubble();
assert.ok(html.includes('aria-label="Status: SAVED: D:\\Exports\\riff.mid. Activate to open the LOG."'));
assert.equal(liveRegion(html), 'SAVED: D:\\Exports\\riff.mid');
assert.ok(!html.includes(GREETING), 'the notice takes the bubble over');
assert.ok(html.includes('from-[rgb(var(--et-accent)/0.14)]'), 'a success wears the theme accent');
assert.ok(html.includes('et-ink'), 'in the theme ink, which no light-theme rule re-points');
assert.ok(html.includes('w-72') && html.includes('line-clamp-4'), 'in the panel that grows upward');

// ── 2. A second later, a failure: an error LOG line, failure colours ─────────
mock.timers.tick(1000);
await setText('SAVE FAILED: The disk is full.');
assert.deepEqual(log(), [
  ['info', 'files', 'SAVED: D:\\Exports\\riff.mid'],
  ['error', 'files', 'SAVE FAILED: The disk is full.'],
]);
html = bubble();
assert.equal(liveRegion(html), 'SAVE FAILED: The disk is full.');
assert.ok(html.includes('border-red-500/60') && html.includes('text-red-200'), 'a failure reads as a failure');
assert.ok(!html.includes('SAVED: D:'), 'the failure replaces the success');
assert.ok(!/shadow|glow/.test(html), 'no glow');
const failure = shown();

// ── 3. The same failure again inside the window: nothing new ─────────────────
mock.timers.tick(1000);
await setText('SAVE FAILED: The disk is full.');
assert.equal(log().length, 2, 'a repeat writes no LOG line');
assert.equal(shown(), failure, 'a repeat leaves the notice and its timer alone');

// ── 4. Time passes: the failure holds for STATUS_FAILURE_MS, then the tip ────
mock.timers.tick(STATUS_FAILURE_MS - 1000 - 1);
assert.equal(shown()?.text, 'SAVE FAILED: The disk is full.', 'still up one millisecond before it ends');
mock.timers.tick(1);
assert.equal(shown(), null);
html = bubble();
assert.ok(html.includes(`aria-label="Assistant tip: ${GREETING}. Activate for the next tip."`), 'back on the tip it showed');
assert.equal(liveRegion(html), '');
assert.ok(!html.includes('border-red-500/60'));
assert.equal(log().length, 2);

// ── A caller that writes its own line just before the post ───────────────────
mock.timers.tick(STATUS_REPEAT_MS);
useLogStore.getState().clear();
logError('files', 'Could not save riff.mid: Access is denied.');
await setText('SAVE FAILED: Access is denied.');
assert.deepEqual(log(), [['error', 'files', 'Could not save riff.mid: Access is denied.']]);
assert.equal(shown()?.level, 'error', 'the bubble still shows it');

// ...or right after it, in the same task.
mock.timers.tick(STATUS_FAILURE_MS);
useStatusBarStore.getState().setText('DOWNLOADED: C:\\Users\\me\\Downloads\\take.wav');
logInfo('files', 'Downloaded take.wav to C:\\Users\\me\\Downloads\\take.wav');
await flush();
assert.deepEqual(log()[1], ['info', 'files', 'Downloaded take.wav to C:\\Users\\me\\Downloads\\take.wav']);
assert.equal(log().length, 2);

// A caller's line from longer ago than LOG_MATCH_MS does not count.
mock.timers.tick(STATUS_INFO_MS);
logWarn('sway', 'Choose a file that ends in .sway.');
mock.timers.tick(LOG_MATCH_MS + 1);
await setText('SCENE OPEN FAILED: Choose a file that ends in .sway.');
assert.deepEqual(log().slice(2), [
  ['warn', 'sway', 'Choose a file that ends in .sway.'],
  ['error', 'sway', 'SCENE OPEN FAILED: Choose a file that ends in .sway.'],
]);

// ── The same text once the window has passed posts again ─────────────────────
mock.timers.tick(STATUS_FAILURE_MS);
useLogStore.getState().clear();
await setText('SAVE FAILED: The disk is full.');
assert.deepEqual(log(), [['error', 'files', 'SAVE FAILED: The disk is full.']]);

// ── A success right after a failure waits out the failure's hold ─────────────
mock.timers.tick(STATUS_FAILURE_MS);
assert.equal(shown(), null);
await setText('SAVE FAILED: The folder is read-only.');
mock.timers.tick(500);
await setText('SAVED: D:\\Exports\\take.wav');
assert.equal(shown()?.text, 'SAVE FAILED: The folder is read-only.', 'the success waits');
assert.deepEqual(log()[log().length - 1], ['info', 'files', 'SAVED: D:\\Exports\\take.wav'], 'and is in the LOG at once');
mock.timers.tick(FAILURE_HOLD_MS - 500 - 1);
assert.equal(shown()?.level, 'error');
mock.timers.tick(1);
assert.equal(shown()?.text, 'SAVED: D:\\Exports\\take.wav');
mock.timers.tick(STATUS_INFO_MS);
assert.equal(shown(), null);

// ── Start, fail, retry at once: every step is logged, the retry shows ────────
nextCase();
await setText('GENERATION STARTED');
mock.timers.tick(1500);
await setText('GENERATION FAILED: CUDA out of memory');
mock.timers.tick(2000);
await setText('GENERATION STARTED');
assert.deepEqual(log(), [
  ['info', 'generate', 'GENERATION STARTED'],
  ['error', 'generate', 'GENERATION FAILED: CUDA out of memory'],
  ['info', 'generate', 'GENERATION STARTED'],
], 'a retry that repeats an earlier text is not a repeat');
assert.equal(useStatusBarStore.getState().text, 'GENERATION STARTED');
assert.equal(shown()?.text, 'GENERATION FAILED: CUDA out of memory', 'the failure keeps its hold');
mock.timers.tick(FAILURE_HOLD_MS - 2000);
assert.equal(shown()?.text, 'GENERATION STARTED', 'then the retry shows');
mock.timers.tick(STATUS_INFO_MS);
assert.equal(shown(), null);

// ── A fast start and complete, whose caller lines name the same effect ───────
// studioStore.processAudio's order: the STARTED post, then its two LOG lines in
// the same task, then 800ms later the response line and the COMPLETE post.
nextCase();
useStatusBarStore.getState().setText('STUDIO PROCESS STARTED: reverb');
logInfo('studio', 'Processing: effect=reverb format=wav source=a.wav (12KB)');
logInfo('studio', 'POST /api/studio/process — effect=reverb params={}');
await flush();
mock.timers.tick(800);
logInfo('studio', 'POST /api/studio/process → 200 OK — 40KB wav');
await setText('STUDIO PROCESS COMPLETE: reverb');
assert.deepEqual(log(), [
  ['info', 'studio', 'Processing: effect=reverb format=wav source=a.wav (12KB)'],
  ['info', 'studio', 'POST /api/studio/process — effect=reverb params={}'],
  ['info', 'studio', 'STUDIO PROCESS STARTED: reverb'],
  ['info', 'studio', 'POST /api/studio/process → 200 OK — 40KB wav'],
  ['info', 'studio', 'STUDIO PROCESS COMPLETE: reverb'],
], 'a request line that names the effect stands in for neither the start nor the result');

// projectStore.save's order: the request line, then the SAVED post.
nextCase();
logInfo('project', 'POST /api/project/save — D:\\Projects\\song.tasmo embed=true');
mock.timers.tick(300);
await setText('PROJECT SAVED (embed): D:\\Projects\\song.tasmo');
assert.deepEqual(log(), [
  ['info', 'project', 'POST /api/project/save — D:\\Projects\\song.tasmo embed=true'],
  ['info', 'project', 'PROJECT SAVED (embed): D:\\Projects\\song.tasmo'],
], 'a request line with the same path does not say the save worked');

// ── A call site that logs the event in other words passes logged ─────────────
nextCase();
logError('generate', 'Heal pass failed — keeping the first result: boom');
await setText('HEAL PASS FAILED — first result kept', { logged: true });
useStatusBarStore.getState().setText('GENERATION STOPPED', { logged: true });
logInfo('generate', 'Job aborted by user');
await flush();
assert.deepEqual(log(), [
  ['error', 'generate', 'Heal pass failed — keeping the first result: boom'],
  ['info', 'generate', 'Job aborted by user'],
]);
assert.equal(shown()?.text, 'HEAL PASS FAILED — first result kept', 'the bubble still shows it');

// ── Levels, sources, outcomes and the same-line rule ─────────────────────────
assert.equal(statusLevel('OPEN .gan FAILED: bad manifest'), 'error');
assert.equal(statusLevel('HEALTH FAIL (500)'), 'error');
assert.equal(statusLevel('NO USABLE MODEL — see Settings → Models'), 'error');
assert.equal(statusLevel('PROMPT REQUIRED'), 'warn');
assert.equal(statusLevel('PROJECT SAVE SKIPPED: timeline is empty'), 'warn');
assert.equal(statusLevel('Saved to disk, but the library list did not refresh — reload the Library panel.'), 'warn');
assert.equal(statusLevel('STUDIO LIBRARY SAVE FAILED — check Processing Log: quota'), 'error');
assert.equal(statusLevel('GENERATION COMPLETE'), 'info');
// A file, folder, effect or plugin name in the detail never sets the level.
assert.equal(statusLevel('SAVED: D:\\Takes\\failed takes\\riff.wav'), 'info');
assert.equal(statusLevel('STUDIO SOURCE LOADED: error-loop.wav'), 'info');
assert.equal(statusLevel('DOWNLOADED: C:\\Users\\me\\Downloads\\not found.wav'), 'info');
assert.equal(statusLevel('VST PROCESS COMPLETE: Unhealthy Distortion'), 'info');
assert.equal(statusSource('SCENE OPEN FAILED: x'), 'sway');
assert.equal(statusSource('INSTALL FAILED: x'), 'assets');
assert.equal(statusSource('Saved to disk, but the library list did not refresh'), 'generate');
assert.equal(statusSource('SAVING: D:\\Exports\\bundle.zip'), 'files');
assert.equal(statusSource('VST GUI FAILED: no editor'), 'vst');
assert.equal(statusSource('VST PROCESS COMPLETE: Reverb'), 'studio');
assert.equal(statusSource('MIX CHAIN FAILED at highpass: broke'), 'studio');
assert.equal(statusSource('ABLETON: export-to-audio required'), 'dawimport');
assert.equal(statusSource('OPEN .gan FAILED: bad manifest'), 'plugin');
assert.equal(statusSource('SOMETHING NEW'), 'status');
assert.ok(sameLine('GENERATION COMPLETE', '[+12.3s] Generation pipeline complete.'));
assert.ok(sameLine('GENERATION QUEUED: abcd1234', '[+0.4s] Job queued: abcd1234 — waiting for backend to start sampling'));
assert.ok(!sameLine('GENERATION STARTED', '[+0.0s] CREATE pressed: model=small'));
assert.ok(sameOutcome('GENERATION COMPLETE', 'info', '[+12.3s] Generation pipeline complete.', 'info'));
assert.ok(sameOutcome('SAVE FAILED: Access is denied.', 'error', 'Could not save riff.mid: Access is denied.', 'error'));
assert.ok(!sameOutcome('SAVE FAILED: Access is denied.', 'error', 'Saving riff.mid: Access is denied.', 'info'));
assert.ok(!sameOutcome('STUDIO PROCESS COMPLETE: reverb', 'info', 'Processing: effect=reverb', 'info'));
assert.ok(!sameOutcome('PROJECT SAVED (embed): D:\\a.tasmo', 'info', 'POST /api/project/save — D:\\a.tasmo embed=true', 'info'));
assert.ok(!sameOutcome('SAVED: D:\\a.wav', 'info', 'Projects folder was not read: D:\\a.wav', 'warn'));

// ── A long path keeps its file name in the bubble, and its full text elsewhere ─
nextCase();
const longPath = 'SAVED: C:\\Users\\me\\Documents\\theDAW\\exports\\a very long track title for the bubble test.wav';
assert.equal(bubbleText(longPath), 'SAVED: …\\a very long track title for the bubble test.wav');
assert.equal(bubbleText('SAVED: D:\\Exports\\riff.mid'), 'SAVED: D:\\Exports\\riff.mid', 'a short one is drawn as written');
const longReason = `SAVE FAILED: ${'the folder refused the write '.repeat(3).trim()}`;
assert.equal(bubbleText(longReason), longReason, 'only a path is shortened');
assert.equal(bubbleText('DOWNLOADED: /home/me/Downloads/some/deep/folder/with/a/long/name/take.wav'), 'DOWNLOADED: …/take.wav');
await setText(longPath);
html = bubble();
assert.ok(html.includes('>SAVED: …\\a very long track title for the bubble test.wav</span>'));
assert.ok(html.includes(`title="${longPath}"`));
assert.ok(html.includes(`aria-label="Status: ${longPath}. Activate to open the LOG."`));
assert.equal(liveRegion(html), longPath);
assert.deepEqual(log()[log().length - 1], ['info', 'files', longPath], 'the LOG keeps the whole path');
mock.timers.tick(STATUS_INFO_MS);
assert.equal(shown(), null);

// ── A notice that ends in a full stop is not given a second one ──────────────
await setText('SCENE OPEN FAILED: Choose a file that ends in .sway.');
assert.ok(bubble().includes('aria-label="Status: SCENE OPEN FAILED: Choose a file that ends in .sway. Activate to open the LOG."'));
mock.timers.tick(STATUS_FAILURE_MS);

// ── Health polling, in launch order ──────────────────────────────────────────
nextCase();
let answer: () => Response = () => new Response('', { status: 500 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => answer()) as typeof fetch;
const healthy = (modelLoaded: boolean) => () =>
  new Response(JSON.stringify({ status: 'ok', model_loaded: modelLoaded }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const unreachable = () => {
  throw new TypeError('Failed to fetch');
};
const poll = async () => {
  await useStatusBarStore.getState().refreshHealth();
  await flush();
};

// The backend has not bound: the dev proxy answers 502, then the port refuses.
// The LOG keeps the 502 and the bubble keeps the greeting.
answer = () => new Response(JSON.stringify({ detail: 'Backend unreachable' }), { status: 502 });
await poll();
assert.deepEqual(log(), [['error', 'health', 'API responded 502']]);
assert.equal(shown(), null, 'a 502 before the API has answered is the backend still binding');
answer = unreachable;
mock.timers.tick(400);
await poll();
mock.timers.tick(400);
await poll();
assert.equal(log().length, 1);
assert.equal(shown(), null);

// It binds: the first good reading writes its LOG line and is not a recovery.
answer = healthy(false);
mock.timers.tick(400);
await poll();
assert.deepEqual(log(), [
  ['error', 'health', 'API responded 502'],
  ['info', 'health', 'API healthy, no model loaded'],
]);
assert.equal(shown(), null, 'the launch reaching the backend posts nothing');
assert.equal(useStatusBarStore.getState().text, 'API HEALTHY // NO MODEL LOADED');
useLogStore.getState().clear();

// The heartbeat reads the same thing: nothing.
mock.timers.tick(30_000);
await poll();
assert.equal(log().length, 0);
assert.equal(shown(), null);

// A model loads: one notice and one LOG line.
mock.timers.tick(30_000);
answer = healthy(true);
await poll();
assert.deepEqual(log(), [['info', 'health', 'API HEALTHY // MODEL LOADED']]);
assert.equal(shown()?.text, 'API HEALTHY // MODEL LOADED');

// Thirty seconds on, the same reading: nothing.
mock.timers.tick(30_000);
await poll();
assert.equal(log().length, 1);
assert.equal(shown(), null);

// The backend goes away: the health check's own LOG line, and the bubble in failure colours.
answer = unreachable;
mock.timers.tick(30_000);
await poll();
assert.deepEqual(log()[1], ['error', 'health', 'API unreachable']);
assert.equal(log().length, 2);
assert.equal(shown()?.text, 'API UNREACHABLE');
assert.ok(bubble().includes('border-red-500/60'));

// Still away on the brisk 400ms retries: nothing new.
for (let i = 0; i < 5; i += 1) {
  mock.timers.tick(400);
  await poll();
}
assert.equal(log().length, 2);

// It comes back after having been healthy: that is a recovery, and it posts.
mock.timers.tick(STATUS_FAILURE_MS);
answer = healthy(true);
await poll();
assert.deepEqual(log()[2], ['info', 'health', 'API recovered (model loaded)']);
assert.equal(log().length, 3);
assert.equal(shown()?.text, 'API HEALTHY // MODEL LOADED');

globalThis.fetch = realFetch;
mock.timers.reset();
console.log('statusNotice tests passed');
