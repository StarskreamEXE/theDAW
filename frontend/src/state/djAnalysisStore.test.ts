// Run with: npx tsx src/state/djAnalysisStore.test.ts
//
// DJ-1: the DJ tab's analysis storm. Opening the tab used to POST a run for
// every library row the browser had in hand, each one a real backend decode,
// with the deck the user just loaded queued behind all of them. These drive
// the store against a stub backend: the sweep is a capped, replaceable window,
// an explicit request jumps ahead of it, the queue can be paused, runs ask for
// the cheap `dj` profile, a failed entry is retried exactly once and only after
// a minute, and the parsed row carries the detector's BPM confidence.
import assert from 'node:assert/strict';
import {
  useDjAnalysisStore,
  analyzeEntries,
  DJ_SWEEP_CAP,
  ANALYSIS_ERROR_RETRY_MS,
} from './djAnalysisStore.ts';

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

/** Rows the stub backend already has analysed (GET answers from here). */
const ready = new Map<string, Record<string, unknown>>();
/** Ids whose POST /run must fail. */
const failing = new Set<string>();
/** Ids whose POST /run parks until released. */
const holds = new Map<string, Deferred>();
const gets: string[] = [];
const posts: string[] = [];
const postUrls: string[] = [];

/** A clock the test owns, so the 60 s retry window costs no wall time. */
let nowMs = 1_000_000;
const realNow = Date.now;
Date.now = () => nowMs;

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  bpm: 128.0,
  bpm_confidence: 0.82,
  key: 'A',
  scale: 'minor',
  key_confidence: 0.6,
  bars_estimated: 64,
  rms_db: -12.5,
  beats_json: '[0.5, 1.0, 1.5]',
  analyzed_at: 1234.5,
  ...over,
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if ((init?.method ?? 'GET') === 'GET') {
    const id = url.replace('/api/analysis/', '');
    gets.push(id);
    const have = ready.get(id);
    return json(have ?? { status: 'pending' });
  }

  const id = url.slice('/api/analysis/'.length).split('/')[0];
  posts.push(id);
  postUrls.push(url);
  const hold = holds.get(id);
  if (hold) {
    holds.delete(id);
    await hold.promise;
  }
  if (failing.has(id)) return json({ detail: 'nope' }, 500);
  const produced = row({ bpm: 120.0 });
  ready.set(id, produced);
  return json(produced);
}) as typeof fetch;

const st = () => useDjAnalysisStore.getState();

/** Wait for every queued analysis to finish: a sentinel appended to the SWEEP
 *  lane resolves only after everything ahead of it has run. */
let sentinelSeq = 0;
const drain = async (): Promise<void> => {
  sentinelSeq += 1;
  const id = `__drain_${sentinelSeq}`;
  ready.set(id, row());
  await st().ensureAnalyzed(id, { priority: false });
};

// ── the run uses the cheap DJ profile, and the parsed row keeps its fields ──
{
  await st().ensureAnalyzed('dj-profile');
  assert.deepEqual(posts, ['dj-profile']);
  assert.equal(postUrls[0], '/api/analysis/dj-profile/run?profile=dj',
    'a DJ run must ask for the deck-only profile, not a full analysis');

  const entry = st().byId['dj-profile'];
  assert.equal(entry.status, 'ready');
  assert.equal(entry.data?.bpm, 120.0);
  assert.equal(entry.data?.bpm_confidence, 0.82, 'the detector confidence reaches the deck');
  // The beats/beats_json tolerance the decks depend on is untouched.
  assert.deepEqual(entry.data?.beats, [0.5, 1.0, 1.5]);
  assert.equal(entry.data?.key, 'A');
  assert.equal(entry.data?.rms_db, -12.5);
}

// A cached row is taken from the GET; no run is posted for it.
{
  posts.length = 0;
  ready.set('already', row({ bpm: 90.0, beats: [1, 2], bpm_confidence: 0.3 }));
  await st().ensureAnalyzed('already');
  assert.deepEqual(posts, [], 'an analysed entry must not be re-run');
  assert.equal(st().byId['already'].data?.bpm, 90.0);
  assert.equal(st().byId['already'].data?.bpm_confidence, 0.3);
  assert.deepEqual(st().byId['already'].data?.beats, [1, 2], 'a parsed beats array is accepted too');
}

// ── analyzeAll is a CAPPED working set ──────────────────────────────────────
{
  posts.length = 0;
  await st().analyzeAll(Array.from({ length: 50 }, (_, i) => `cap_${i}`), { cap: 3 });
  await drain();
  const swept = posts.filter((id) => id.startsWith('cap_'));
  assert.deepEqual(swept, ['cap_0', 'cap_1', 'cap_2'],
    'the sweep must stop at the cap, in the order the caller ranked them');
}

// The default cap is the documented one: everything past it is dropped.
{
  posts.length = 0;
  await st().analyzeAll(Array.from({ length: DJ_SWEEP_CAP + 9 }, (_, i) => `dflt_${i}`));
  await drain();
  const swept = posts.filter((id) => id.startsWith('dflt_'));
  assert.equal(swept.length, DJ_SWEEP_CAP);
  assert.equal(swept[0], 'dflt_0');
  assert.equal(swept.at(-1), `dflt_${DJ_SWEEP_CAP - 1}`);
}

// ── a later sweep REPLACES the window: scrolled-away rows stop costing ──────
{
  posts.length = 0;
  const hold = deferred();
  holds.set('win_0', hold);
  void st().analyzeAll(['win_0', 'win_1', 'win_2'], { cap: 3 });
  // Let the first run start and park inside its POST.
  await new Promise((r) => setTimeout(r, 5));
  // The browser scrolled: a new window, none of the old rows in it.
  await st().analyzeAll(['win_9'], { cap: 3 });
  hold.resolve();
  await drain();
  assert.deepEqual(posts, ['win_0', 'win_9'],
    'rows that left the window must not be analysed after the window moved');
}

// ── an explicit request jumps the whole sweep ───────────────────────────────
{
  posts.length = 0;
  const hold = deferred();
  holds.set('jump_a', hold);
  void st().analyzeAll(['jump_a', 'jump_b', 'jump_c'], { cap: 3 });
  await new Promise((r) => setTimeout(r, 5));
  // A deck loads while the sweep is mid-flight.
  const deckLoad = st().ensureAnalyzed('deck_now');
  hold.resolve();
  await deckLoad;
  await drain();
  assert.equal(posts[0], 'jump_a', 'the run already in flight is not abandoned');
  assert.equal(posts[1], 'deck_now', 'a deck load must not wait behind the browsing sweep');
  assert.deepEqual(posts.slice(2), ['jump_b', 'jump_c']);
}

// analyzeEntries (setlist / VJ) is an explicit request too: a sweep can
// neither delay nor discard it.
{
  posts.length = 0;
  const hold = deferred();
  holds.set('set_a', hold);
  void st().analyzeAll(['set_a', 'set_b'], { cap: 2 });
  await new Promise((r) => setTimeout(r, 5));
  analyzeEntries(['added_1', null, undefined, 'added_1']);
  await st().analyzeAll(['unrelated'], { cap: 2 });
  hold.resolve();
  await drain();
  assert.deepEqual(posts, ['set_a', 'added_1', 'unrelated'],
    'an added track keeps its place when the sweep window is replaced');
}

// ── pause / resume ──────────────────────────────────────────────────────────
{
  posts.length = 0;
  st().pauseQueue();
  await st().analyzeAll(['pause_a', 'pause_b'], { cap: 2 });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(posts, [], 'a paused queue must not start new analyses');
  st().resumeQueue();
  await drain();
  assert.deepEqual(posts, ['pause_a', 'pause_b'], 'resume drains what was queued');
}

// The run already in flight when pause is called still finishes.
{
  posts.length = 0;
  const hold = deferred();
  holds.set('inflight', hold);
  void st().analyzeAll(['inflight', 'after_pause'], { cap: 2 });
  await new Promise((r) => setTimeout(r, 5));
  st().pauseQueue();
  hold.resolve();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(posts, ['inflight'], 'the in-flight run completes; the next one waits');
  assert.equal(st().byId['inflight'].status, 'ready');
  st().resumeQueue();
  await drain();
  assert.deepEqual(posts, ['inflight', 'after_pause']);
}

// ── a failed entry is retried exactly once, and only after the window ───────
{
  posts.length = 0;
  failing.add('flaky');
  await st().ensureAnalyzed('flaky');
  assert.equal(st().byId['flaky'].status, 'error');
  assert.deepEqual(posts, ['flaky']);

  // Immediately, and all the way up to the window, it is left alone.
  await st().ensureAnalyzed('flaky');
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  nowMs += ANALYSIS_ERROR_RETRY_MS - 1;
  await st().ensureAnalyzed('flaky');
  assert.deepEqual(posts, ['flaky'], 'a failing entry must not be re-hammered');

  // Past the window: exactly one retry.
  nowMs += 2;
  await st().ensureAnalyzed('flaky');
  assert.deepEqual(posts, ['flaky', 'flaky'], 'one retry after the window');

  nowMs += ANALYSIS_ERROR_RETRY_MS * 10;
  await st().ensureAnalyzed('flaky');
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  assert.deepEqual(posts, ['flaky', 'flaky'], 'the retry is spent; no third attempt');
}

// A run that succeeds after a failure clears the retry budget, so a LATER
// failure still gets its own retry.
{
  posts.length = 0;
  failing.add('recovers');
  await st().ensureAnalyzed('recovers');
  assert.equal(st().byId['recovers'].status, 'error');
  failing.delete('recovers');
  nowMs += ANALYSIS_ERROR_RETRY_MS;
  await st().ensureAnalyzed('recovers');
  assert.equal(st().byId['recovers'].status, 'ready');
  assert.deepEqual(posts, ['recovers', 'recovers']);

  // Fail it again from a clean slate: the budget was reset by the success.
  ready.delete('recovers');
  failing.add('recovers');
  useDjAnalysisStore.setState((s) => {
    const next = { ...s.byId };
    delete next['recovers'];
    return { byId: next };
  });
  await st().ensureAnalyzed('recovers');
  nowMs += ANALYSIS_ERROR_RETRY_MS;
  await st().ensureAnalyzed('recovers');
  // fail, success, fail, retry — the fourth POST only happens because the
  // success in between cleared the spent retry.
  assert.deepEqual(posts, ['recovers', 'recovers', 'recovers', 'recovers'],
    'a success resets the one-retry budget');
}

Date.now = realNow;
console.log('djAnalysisStore: all assertions passed');
