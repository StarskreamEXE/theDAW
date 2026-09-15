// Run with: npx tsx src/state/underfitRunsStore.test.ts
//
// The UNDERFIT key's view of the dashboard's runs, replayed against a stub
// backend: which run STOP targets, how an unreachable dashboard and an old
// backend read, a stop in the order it happens (the kill goes out, a second
// press sends nothing, the dashboard marks the run killed, the key lets go),
// and a repeat (the last run's settings, a fresh name, the dashboard's refusals).
import assert from 'node:assert/strict';
import {
  lastUnderfitRun,
  liveUnderfitRun,
  nextRunName,
  runName,
  useUnderfitRunsStore,
  type UnderfitRun,
} from './underfitRunsStore.ts';
import { useLogStore } from './logStore.ts';

(globalThis as { window?: unknown }).window ??= globalThis;

type Reply = { status: number; body: unknown } | 'network-error';
type Route = (method: string, url: string) => Reply | Promise<Reply>;

const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
let route: Route = () => ({ status: 500, body: {} });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method ?? 'GET';
  calls.push({ method, url, body: init?.body ? bodyOf(init) : undefined });
  const reply = await route(method, url);
  if (reply === 'network-error') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const store = useUnderfitRunsStore.getState;
const logged = (text: string): boolean => useLogStore.getState().entries.some((e) => e.msg.includes(text));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const run = (id: string, status: string, created_at: string, display_name?: string, gpu?: number): UnderfitRun =>
  ({ id, status, created_at, display_name, gpu });
const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

(async () => {
  // (a) STOP targets the newest live run; finished and failed runs never count.
  {
    assert.equal(liveUnderfitRun([]), null);
    assert.equal(liveUnderfitRun([run('a', 'killed', '2026-09-01'), run('b', 'error', '2026-09-02'), run('c', 'completed', '2026-09-03')]), null);
    const live = liveUnderfitRun([
      run('old', 'training', '2026-09-01T10:00:00Z'),
      run('done', 'killed', '2026-09-12T10:00:00Z'),
      run('new', 'loading', '2026-09-10T10:00:00Z', 'drums lora'),
      run('held', 'paused', '2026-09-05T10:00:00Z'),
    ]);
    assert.equal(live?.run.id, 'new');
    assert.equal(live?.others, 2);
    assert.equal(runName(live!.run), 'drums lora');
    assert.equal(runName(run('bare', 'demos', '')), 'bare', 'a run without a display name prints its id');
    for (const status of ['training', 'demos', 'loading', 'resuming', 'paused']) {
      assert.ok(liveUnderfitRun([run('x', status, '')]), `${status} is live`);
    }
  }

  // (b) What the poll reads.
  {
    route = () => ({ status: 200, body: { reachable: true, runs: [run('r1', 'training', '2026-09-13')] } });
    await store().refresh();
    assert.equal(store().link, 'ok');
    assert.equal(store().runs.length, 1);

    route = () => ({ status: 200, body: { reachable: false, runs: [], error: 'connection refused' } });
    await store().refresh();
    assert.equal(store().link, 'dashboard-down');
    assert.deepEqual(store().runs, []);

    route = () => ({ status: 404, body: { detail: 'Not Found' } });
    await store().refresh();
    assert.equal(store().link, 'backend-old', 'a backend without the route needs a restart');

    route = () => 'network-error';
    await store().refresh();
    assert.equal(store().link, 'dashboard-down');
  }

  // (c) A stop in order: the kill is out, a second press sends nothing, the
  // dashboard reports the run killed, the key lets go.
  {
    const kill = deferred<Reply>();
    let killed = false;
    route = (method, url) => {
      if (method === 'GET' && url === '/api/underfit/runs') {
        return { status: 200, body: { reachable: true, runs: [run('r 1', killed ? 'killed' : 'training', '2026-09-13', 'vox')] } };
      }
      if (method === 'POST' && url === '/api/underfit/runs/r%201/kill') return kill.promise;
      return { status: 500, body: {} };
    };
    await store().refresh();
    const stop = store().stopRun('r 1');
    assert.equal(store().stoppingId, 'r 1', 'busy while the kill is out');
    await store().stopRun('r 1');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'a second press sends nothing');
    killed = true;
    kill.resolve({ status: 200, body: { ok: true, status: 'killed' } });
    await stop;
    assert.equal(store().stoppingId, null);
    assert.equal(liveUnderfitRun(store().runs), null, 'the killed run leaves the key');
    assert.ok(logged('Stopped the Underfit training run "vox"'));
  }

  // (d) The dashboard refuses (the run already ended): its message is logged.
  {
    route = (method, url) => {
      if (method === 'GET') return { status: 200, body: { reachable: true, runs: [run('r2', 'training', '')] } };
      if (url === '/api/underfit/runs/r2/kill') return { status: 400, body: { detail: "cannot stop run in state 'killed'" } };
      return { status: 500, body: {} };
    };
    await store().refresh();
    await store().stopRun('r2');
    assert.ok(logged("Could not stop the Underfit training run \"r2\": cannot stop run in state 'killed'"));
    assert.equal(store().stoppingId, null);
  }

  // (e) A backend without the kill route: the log names the fix.
  {
    route = (method) => (method === 'GET'
      ? { status: 200, body: { reachable: true, runs: [run('r3', 'training', '')] } }
      : { status: 404, body: { detail: 'Not Found' } });
    await store().refresh();
    await store().stopRun('r3');
    assert.ok(logged('restart the backend to get them'));
  }

  // (f) nextRunName: a repeat never collides with a name the dashboard holds.
  {
    assert.equal(nextRunName('vox', []), 'vox 2');
    assert.equal(nextRunName('vox', ['vox']), 'vox 2');
    assert.equal(nextRunName('vox 2', ['vox', 'vox 2']), 'vox 3', 'a trailing number counts on');
    assert.equal(nextRunName('vox 2', ['vox 2', 'vox 3', 'vox 4']), 'vox 5', 'runs to the first free number');
    assert.equal(nextRunName('drums-lora', ['Drums Lora 2']), 'drums-lora 3', 'the dashboard slugifies, so the search does');
    assert.equal(nextRunName('  ', []), 'run 2', 'a blank name still produces one');
  }

  // (g) lastUnderfitRun: the newest run of ANY status is the one to repeat.
  {
    assert.equal(lastUnderfitRun([]), null);
    const last = lastUnderfitRun([
      run('a', 'completed', '2026-09-01T10:00:00Z'),
      run('b', 'error', '2026-09-14T10:00:00Z'),
      run('c', 'killed', '2026-09-03T10:00:00Z'),
    ]);
    assert.equal(last?.id, 'b', 'a finished or failed run still holds the last settings chosen');
  }

  // (h) TRAIN repeats: it reads the last run's config, posts it under a fresh
  // name on the same GPU, and says what it started.
  {
    route = (method, url) => {
      if (method === 'GET' && url === '/api/underfit/runs') {
        return { status: 200, body: { reachable: true, runs: [
          run('r9', 'completed', '2026-09-14T10:00:00Z', 'drums lora', 1),
          run('r8', 'killed', '2026-09-01T10:00:00Z', 'old one', 0),
        ] } };
      }
      if (url === '/api/underfit/runs/r9/config') {
        return { status: 200, body: { base_model: 'sa3-medium', dataset_id: 'ds1', rank: 32, lr: 0.0001 } };
      }
      if (url === '/api/underfit/runs/new') return { status: 200, body: { ok: true, id: 'r10' } };
      return { status: 500, body: {} };
    };
    await store().refresh();
    calls.length = 0;
    await store().trainAgain();
    const post = calls.find((c) => c.url === '/api/underfit/runs/new');
    assert.ok(post, 'the start goes out');
    assert.equal(post?.method, 'POST');
    assert.equal(post?.body?.name, 'drums lora 2', 'a fresh name off the newest run');
    assert.equal(post?.body?.gpu, 1, 'the card the last run used');
    assert.equal(post?.body?.base_model, 'sa3-medium', "the last run's settings ride along");
    assert.equal(post?.body?.rank, 32);
    assert.ok(logged('Started the Underfit training run "drums lora 2"'));
    assert.equal(store().starting, false, 'the key lets go');
  }

  // (i) A second press while the start is out sends nothing.
  {
    const held = deferred<Reply>();
    route = (method, url) => {
      if (method === 'GET' && url === '/api/underfit/runs') {
        return { status: 200, body: { reachable: true, runs: [run('r9', 'completed', '2026-09-14T10:00:00Z', 'vox', 0)] } };
      }
      if (url === '/api/underfit/runs/r9/config') return { status: 200, body: { base_model: 'sa3-small' } };
      if (url === '/api/underfit/runs/new') return held.promise;
      return { status: 500, body: {} };
    };
    await store().refresh();
    calls.length = 0;
    const first = store().trainAgain();
    // The config read goes out first; wait for the start itself to be in flight.
    for (let i = 0; i < 50 && !calls.some((c) => c.url === '/api/underfit/runs/new'); i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    await store().trainAgain();
    assert.equal(calls.filter((c) => c.url === '/api/underfit/runs/new').length, 1, 'one start, not two');
    held.resolve({ status: 200, body: { ok: true } });
    await first;
    assert.equal(store().starting, false);
  }

  // (j) The dashboard refuses the start: its own words reach the LOG, and the
  // key lets go so the next press can try again.
  {
    route = (method, url) => {
      if (method === 'GET' && url === '/api/underfit/runs') {
        return { status: 200, body: { reachable: true, runs: [run('r9', 'completed', '2026-09-14T10:00:00Z', 'vox', 0)] } };
      }
      if (url === '/api/underfit/runs/r9/config') return { status: 200, body: { base_model: 'sa3-small' } };
      if (url === '/api/underfit/runs/new') return { status: 400, body: { detail: 'No free GPU' } };
      return { status: 500, body: {} };
    };
    await store().refresh();
    await store().trainAgain();
    assert.ok(logged('Could not start an Underfit training run: No free GPU'));
    assert.equal(store().starting, false);
  }

  // (k) A backend without the config route: the log names the fix, and no start
  // goes out on settings that were never read.
  {
    route = (method, url) => {
      if (method === 'GET' && url === '/api/underfit/runs') {
        return { status: 200, body: { reachable: true, runs: [run('r9', 'completed', '2026-09-14T10:00:00Z', 'vox', 0)] } };
      }
      if (url === '/api/underfit/runs/r9/config') return { status: 404, body: { detail: 'Not Found' } };
      return { status: 500, body: {} };
    };
    await store().refresh();
    calls.length = 0;
    await store().trainAgain();
    assert.ok(logged('restart the backend to get them'));
    assert.equal(calls.filter((c) => c.url === '/api/underfit/runs/new').length, 0, 'nothing is started blind');
  }

  // (l) Nothing to repeat: the press sends no request at all.
  {
    route = (method, url) => (method === 'GET' && url === '/api/underfit/runs'
      ? { status: 200, body: { reachable: true, runs: [] } }
      : { status: 500, body: {} });
    await store().refresh();
    calls.length = 0;
    await store().trainAgain();
    assert.equal(calls.length, 0);
  }

  console.log('underfitRunsStore: TRAIN repeats the last run and STOP targets the newest live one');
  process.exit(0);
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
