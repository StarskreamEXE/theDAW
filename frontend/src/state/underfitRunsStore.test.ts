// Run with: npx tsx src/state/underfitRunsStore.test.ts
//
// The UNDERFIT key's view of the dashboard's runs, replayed against a stub
// backend: which run STOP targets, how an unreachable dashboard and an old
// backend read, and a stop in the order it happens (the kill goes out, a second
// press sends nothing, the dashboard marks the run killed, the key lets go).
import assert from 'node:assert/strict';
import { liveUnderfitRun, runName, useUnderfitRunsStore, type UnderfitRun } from './underfitRunsStore.ts';
import { useLogStore } from './logStore.ts';

(globalThis as { window?: unknown }).window ??= globalThis;

type Reply = { status: number; body: unknown } | 'network-error';
type Route = (method: string, url: string) => Reply | Promise<Reply>;

const calls: Array<{ method: string; url: string }> = [];
let route: Route = () => ({ status: 500, body: {} });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method ?? 'GET';
  calls.push({ method, url });
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
const run = (id: string, status: string, created_at: string, display_name?: string): UnderfitRun => ({ id, status, created_at, display_name });

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

  console.log('underfitRunsStore: STOP targets the newest live run and says what happened');
  process.exit(0);
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
