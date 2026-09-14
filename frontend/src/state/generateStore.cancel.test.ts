// Run with: npx tsx src/state/generateStore.cancel.test.ts
//
// STOP on a CREATE run, replayed through the real submitGeneration against a
// stub backend, in the order the app and the backend produce it: the job POST,
// the QUEUED and running polls, STOP between polls and while a poll is still out,
// the held poll then answering (running, completed, an error), a second CREATE
// while the first cancel settles, a Magenta run, and a Chimera polish heal pass.
// STOP must return the key to CREATE at once, cancel the job on the server
// (CANCELLING... until it reports, then CANCELLED), and no answer that arrives
// after it may revive the stopped run.
import assert from 'node:assert/strict';
import { useGenerateStore, type GenerateParams } from './generateStore.ts';
import { useGenerateParamsStore } from './generateParamsStore.ts';
import { useLogStore } from './logStore.ts';

// The store's timers are window.setTimeout.
(globalThis as { window?: unknown }).window ??= globalThis;

type Reply = { status: number; body: unknown };
type Route = (method: string, url: string) => Reply | Promise<Reply> | null;

const calls: Array<{ method: string; url: string }> = [];
let route: Route = () => null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method ?? 'GET';
  calls.push({ method, url });
  // The model-status probe is offline in every case: the POST gate then submits.
  if (url === '/api/storage/model-status') throw new Error('probe offline');
  const reply = (await route(method, url)) ?? { status: 500, body: { detail: `unrouted ${method} ${url}` } };
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const gen = useGenerateStore.getState;
const count = (method: string, url: string): number => calls.filter((c) => c.method === method && c.url === url).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, what: string, ms = 6000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what} (statusLabel=${gen().statusLabel})`);
    await sleep(10);
  }
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const logged = (text: string): boolean => useLogStore.getState().entries.some((e) => e.msg.includes(text));
/** Every caption the store writes, in order, from the moment it is armed. */
const captions: string[] = [];
useGenerateStore.subscribe((s, prev) => {
  if (s.statusLabel !== prev.statusLabel) captions.push(s.statusLabel);
});
const captionsSince = (mark: number): string[] => captions.slice(mark);
/** Prints each case as it starts, so a stuck case names itself. */
const step = (name: string): void => console.log(`- ${name}`);

const PARAMS: GenerateParams = {
  prompt: 'a test tone',
  negativePrompt: '',
  model: 'small',
  duration: 10,
  steps: 8,
  cfg: 1,
  seed: 1,
  batch: 1,
  initNoise: 1,
  initType: 'Audio',
};
const running = (id: string, step = 3): Reply => ({ status: 200, body: { id, status: 'running', progress: { step, steps: 8 } } });
const completed = (id: string): Reply => ({
  status: 200,
  body: { id, status: 'completed', result: { batch: false, item: { audio_base64: 'AAAA', mime_type: 'audio/wav', filename: `${id}.wav` } } },
});
const cancelled = (id: string): Reply => ({ status: 200, body: { id, status: 'cancelled', saved_takes: 0 } });

/**
 * Submits a run whose POST returns `id` and waits for its first poll. The run's
 * promise comes back wrapped: an async function returning the bare promise would
 * adopt it, and the caller would wait for the whole run instead.
 */
const startRun = async (id: string, params: GenerateParams = PARAMS): Promise<{ run: Promise<void> }> => {
  const run = gen().submitGeneration(params);
  await until(() => count('GET', `${params.model.startsWith('magenta-') ? '/api/magenta/jobs' : '/api/jobs'}/${id}`) >= 1, `the first poll of ${id}`);
  return { run };
};

(async () => {
  // (a) STOP between two polls of a running job: CREATE at once, CANCELLING...
  // while the job finishes its step, CANCELLED once it reports, and no poll after.
  {
    step('(a) STOP between polls');
    let cancelReplies = 0;
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'job-a' } } };
      if (method === 'GET' && url === '/api/jobs/job-a') return running('job-a');
      if (method === 'POST' && url === '/api/jobs/job-a/cancel') {
        return cancelReplies++ === 0 ? { status: 200, body: { id: 'job-a', status: 'running', cancel_requested: true } } : cancelled('job-a');
      }
      return null;
    };
    const { run } = await startRun('job-a');
    await until(() => gen().jobStatus === 'running', 'the running poll to land');
    assert.equal(gen().isGenerating, true);
    assert.equal(gen().currentJobId, 'job-a');
    const polls = count('GET', '/api/jobs/job-a');
    gen().cancelGeneration();
    assert.equal(gen().isGenerating, false, 'the key is CREATE again at once');
    assert.equal(gen().currentJobId, null);
    assert.equal(gen().statusLabel, 'CANCELLING...', 'the caption says the job is winding down');
    await run;
    await until(() => gen().statusLabel === 'CANCELLED', 'CANCELLED');
    await sleep(1300);
    assert.equal(count('GET', '/api/jobs/job-a'), polls, 'the stopped run never polls again');
    assert.equal(count('POST', '/api/jobs/job-a/cancel'), 2, 'asked once, then watched until it settled');
    assert.equal(gen().isGenerating, false);
  }

  // (b)-(d) STOP while a poll is still out; the held poll then answers running,
  // completed, or an error. None of the three may revive the stopped run.
  for (const [id, answer] of [
    ['held-run', (x: string) => running(x, 5)],
    ['held-done', completed],
    ['held-err', (): Reply => ({ status: 500, body: { detail: 'boom' } })],
  ] as const) {
    step(`(b-d) STOP while a poll is out: ${id}`);
    let hold: ReturnType<typeof deferred<Reply>> | null = null;
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id } } };
      if (method === 'GET' && url === `/api/jobs/${id}`) {
        if (count('GET', url) === 1) return running(id, 1);
        hold = deferred<Reply>();
        return hold.promise;
      }
      if (method === 'POST' && url === `/api/jobs/${id}/cancel`) return cancelled(id);
      return null;
    };
    const { run } = await startRun(id);
    await until(() => hold !== null, `${id}: the second poll to be out`);
    const mark = captions.length;
    gen().cancelGeneration();
    await until(() => gen().statusLabel === 'CANCELLED', `${id}: CANCELLED`);
    (hold as unknown as ReturnType<typeof deferred<Reply>>).resolve(answer(id));
    await run;
    await sleep(1300);
    const s = gen();
    assert.equal(s.isGenerating, false, `${id}: the held poll did not revive the run`);
    assert.equal(s.statusLabel, 'CANCELLED', `${id}: the caption ends CANCELLED`);
    assert.equal(s.currentJobId, null, `${id}: no job adopted`);
    assert.equal(s.lastAudioUrl, null, `${id}: no result taken from the stopped run`);
    assert.equal(count('GET', `/api/jobs/${id}`), 2, `${id}: no poll after the held one`);
    assert.deepEqual(captionsSince(mark), ['STOPPED', 'CANCELLING...', 'CANCELLED'], `${id}: nothing but the cancel wrote a caption`);
    assert.notEqual(s.jobStatus, 'failed', `${id}: never FAILED`);
  }

  // (e) A backend that predates the route answers FastAPI's own 404. The job is
  // still running there, so the log asks for a restart and never says it stopped.
  {
    step('(e) a backend without the cancel route');
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'job-old' } } };
      if (method === 'GET' && url === '/api/jobs/job-old') return running('job-old');
      if (method === 'POST' && url === '/api/jobs/job-old/cancel') return { status: 404, body: { detail: 'Not Found' } };
      return null;
    };
    const { run } = await startRun('job-old');
    gen().cancelGeneration();
    await run;
    await until(() => gen().statusLabel === 'STOPPED', 'STOPPED after the missing route');
    assert.ok(logged('restart the backend'), 'the log names the fix');
    assert.ok(!logged('Job job-old is no longer on the server'), 'a missing route is not read as a lost job');
  }

  // (f) The server lost the job (it restarted): the route's own 404.
  {
    step('(f) a lost job');
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'job-lost' } } };
      if (method === 'GET' && url === '/api/jobs/job-lost') return running('job-lost');
      if (method === 'POST' && url === '/api/jobs/job-lost/cancel') return { status: 404, body: { detail: 'Job not found' } };
      return null;
    };
    const { run } = await startRun('job-lost');
    gen().cancelGeneration();
    await run;
    await until(() => gen().statusLabel === 'STOPPED', 'STOPPED after the lost job');
    assert.ok(logged('Job job-lost is no longer on the server'));
  }

  // (g) CREATE pressed again while the first cancel settles: a real second run.
  // The first cancel's answer must not touch the second run's caption or state.
  {
    step('(g) a second CREATE while the first cancel settles');
    const firstCancel = deferred<Reply>();
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') {
        return { status: 200, body: { job: { id: count('POST', url) === 1 ? 'first' : 'second' } } };
      }
      if (method === 'GET' && url === '/api/jobs/first') return running('first');
      if (method === 'GET' && url === '/api/jobs/second') return running('second', 2);
      if (method === 'POST' && url === '/api/jobs/first/cancel') return firstCancel.promise;
      if (method === 'POST' && url === '/api/jobs/second/cancel') return cancelled('second');
      return null;
    };
    calls.length = 0;
    const { run: one } = await startRun('first');
    gen().cancelGeneration();
    assert.equal(gen().statusLabel, 'CANCELLING...');
    await one;
    const { run: two } = await startRun('second');
    await until(() => gen().jobStatus === 'running' && gen().currentJobId === 'second', 'the second run sampling');
    firstCancel.resolve(cancelled('first'));
    await until(() => count('POST', '/api/jobs/first/cancel') === 1, 'the first cancel');
    await sleep(200);
    assert.equal(gen().isGenerating, true, 'the second run is still live');
    assert.equal(gen().currentJobId, 'second');
    assert.match(gen().statusLabel, /^SAMPLING/, 'the second run keeps its caption');
    gen().cancelGeneration();
    await two;
    await until(() => gen().statusLabel === 'CANCELLED', 'the second run cancelled');
    assert.equal(count('POST', '/api/jobs/second/cancel'), 1);
  }

  // (h) A Magenta run is cancelled on its own job routes.
  {
    step('(h) a Magenta run');
    route = (method, url) => {
      if (method === 'POST' && url === '/api/magenta/generate') return { status: 200, body: { ok: true, job: { id: 'mag-1' }, engine_state: 'running' } };
      if (method === 'GET' && url === '/api/magenta/jobs/mag-1') return { status: 200, body: { id: 'mag-1', status: 'running', engine_state: 'running', progress: { step: 0, steps: 1, stage: 'generating' } } };
      if (method === 'POST' && url === '/api/magenta/jobs/mag-1/cancel') return cancelled('mag-1');
      return null;
    };
    const { run } = await startRun('mag-1', { ...PARAMS, model: 'magenta-small' });
    assert.equal(gen().runJobsBase, '/api/magenta/jobs');
    gen().cancelGeneration();
    assert.equal(gen().statusLabel, 'CANCELLING...');
    await run;
    await until(() => gen().statusLabel === 'CANCELLED', 'the Magenta job cancelled');
    assert.equal(count('POST', '/api/jobs/mag-1/cancel'), 0, 'never sent to the Stable Audio routes');
  }

  // (i) STOP while POST /api/generate-jobs is in flight: the run ends at once,
  // and the job that comes back is cancelled, never polled.
  {
    step('(i) STOP while the job POST is out');
    const submit = deferred<Reply>();
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return submit.promise;
      if (method === 'POST' && url === '/api/jobs/late/cancel') return cancelled('late');
      return null;
    };
    const run = gen().submitGeneration(PARAMS);
    assert.equal(gen().isGenerating, true);
    assert.equal(gen().runJobsBase, '/api/jobs');
    await until(() => count('POST', '/api/generate-jobs') >= 1 && calls[calls.length - 1].url === '/api/generate-jobs', 'the job POST');
    gen().cancelGeneration();
    assert.equal(gen().isGenerating, false);
    assert.equal(gen().statusLabel, 'STOPPED', 'no job id yet, so the run is stopped');
    assert.ok(logged('STOP pressed before the backend returned a job id'), 'the log says STOP came before the id');
    submit.resolve({ status: 200, body: { job: { id: 'late' } } });
    await run;
    await until(() => gen().statusLabel === 'CANCELLED', 'the late job cancelled');
    assert.equal(count('POST', '/api/jobs/late/cancel'), 1);
    assert.equal(count('GET', '/api/jobs/late'), 0, 'the stopped run never polls the late job');
    assert.equal(gen().currentJobId, null, 'the stopped run never adopts the late job');
  }

  // (j) The same for a Magenta submission: its late job is cancelled on the Magenta routes.
  {
    step('(j) STOP while the Magenta POST is out');
    const submit = deferred<Reply>();
    route = (method, url) => {
      if (method === 'POST' && url === '/api/magenta/generate') return submit.promise;
      if (method === 'POST' && url === '/api/magenta/jobs/mag-late/cancel') return cancelled('mag-late');
      return null;
    };
    const run = gen().submitGeneration({ ...PARAMS, model: 'magenta-small' });
    await until(() => calls[calls.length - 1]?.url === '/api/magenta/generate', 'the Magenta POST');
    gen().cancelGeneration();
    submit.resolve({ status: 200, body: { ok: true, job: { id: 'mag-late' } } });
    await run;
    await until(() => gen().statusLabel === 'CANCELLED', 'the late Magenta job cancelled');
    assert.equal(count('GET', '/api/magenta/jobs/mag-late'), 0);
  }

  // (k) Chimera with HEAL = polish: the first job finishes and the heal pass
  // starts. STOP while the heal POST is out cancels nothing of the finished first
  // job, and cancels the heal job once its id is back; STOP while the heal job's
  // poll is out cancels the heal job, and the held poll cannot write HEALING SEAMS.
  {
    const clip = (label: string) => ({ id: label, blob: new Blob([new Uint8Array(8)]), mimeType: 'audio/wav', label, noise: 0.5, isBase: false });
    const base = useGenerateParamsStore.getState().chimera;
    useGenerateParamsStore.getState().patch({ chimera: { ...base, clips: [clip('clip-a'), clip('clip-b')], heal: 'polish' } });
    const mashup: Reply = {
      status: 200,
      body: {
        mix_base64: 'AAAA',
        mime: 'audio/wav',
        duration_sec: 10,
        target_bpm_used: 120,
        target_bpm_source: 'auto',
        align_mode_used: 'weave',
        seams: [{ heal_start_sec: 4, heal_end_sec: 6 }],
        per_clip: [],
        warnings: [],
      },
    };
    for (const stopDuring of ['heal-post', 'heal-poll'] as const) {
      step(`(k) Chimera polish heal pass: STOP during the ${stopDuring}`);
      const first = `first-${stopDuring}`;
      const heal = `heal-${stopDuring}`;
      const healPost = deferred<Reply>();
      let healPoll: ReturnType<typeof deferred<Reply>> | null = null;
      let posts = 0;
      route = (method, url) => {
        if (method === 'POST' && url === '/api/chimera/mashup') return mashup;
        if (method === 'POST' && url === '/api/generate-jobs') {
          posts += 1;
          if (posts === 1) return { status: 200, body: { job: { id: first } } };
          return stopDuring === 'heal-post' ? healPost.promise : { status: 200, body: { job: { id: heal } } };
        }
        if (method === 'GET' && url === `/api/jobs/${first}`) return completed(first);
        if (method === 'GET' && url === `/api/jobs/${heal}`) {
          healPoll = deferred<Reply>();
          return healPoll.promise;
        }
        if (method === 'POST' && url === `/api/jobs/${heal}/cancel`) return cancelled(heal);
        return null;
      };
      const run = gen().submitGeneration(PARAMS);
      if (stopDuring === 'heal-post') {
        await until(() => posts === 2, 'the heal POST');
        assert.equal(gen().statusLabel, 'HEALING SEAMS...');
        assert.equal(gen().currentJobId, null, 'the finished first job is not what STOP cancels');
      } else {
        await until(() => healPoll !== null, 'the heal poll');
        assert.equal(gen().currentJobId, heal);
      }
      const mark = captions.length;
      gen().cancelGeneration();
      assert.equal(gen().isGenerating, false);
      if (stopDuring === 'heal-post') {
        healPost.resolve({ status: 200, body: { job: { id: heal } } });
      } else {
        await until(() => gen().statusLabel === 'CANCELLED', 'the heal job cancelled');
        (healPoll as unknown as ReturnType<typeof deferred<Reply>>).resolve(running(heal));
      }
      await run;
      await until(() => gen().statusLabel === 'CANCELLED', `${stopDuring}: CANCELLED`);
      await sleep(1300);
      assert.equal(count('POST', `/api/jobs/${first}/cancel`), 0, `${stopDuring}: the finished first job gets no cancel`);
      assert.equal(count('POST', `/api/jobs/${heal}/cancel`), 1, `${stopDuring}: the heal job is cancelled once`);
      assert.equal(count('GET', `/api/jobs/${heal}`), stopDuring === 'heal-post' ? 0 : 1, `${stopDuring}: no heal poll after STOP`);
      assert.ok(!captionsSince(mark).includes('HEALING SEAMS...'), `${stopDuring}: nothing writes HEALING SEAMS... after STOP`);
      assert.equal(gen().statusLabel, 'CANCELLED');
      assert.equal(gen().isGenerating, false);
      assert.equal(useGenerateParamsStore.getState().inpaintRegions?.length ?? 0, 0, 'the heal run gave back the inpaint fields');
    }
    useGenerateParamsStore.getState().patch({ chimera: { ...base, clips: [] } });
  }

  // (l) With no live run, STOP does nothing.
  {
    const before = calls.length;
    useGenerateStore.setState({ isGenerating: false, statusLabel: 'COMPLETE' });
    gen().cancelGeneration();
    assert.equal(gen().statusLabel, 'COMPLETE');
    assert.equal(calls.length, before);
  }

  console.log('generateStore: STOP cancels the job, and nothing that answers after it revives the run');
  process.exit(0);
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
