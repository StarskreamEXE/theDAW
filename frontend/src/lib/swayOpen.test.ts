/**
 * openSwayScene and openSwaySceneFromPath hand a scene the backend returns to
 * the SWAY cockpit: the doc goes into localStorage under its stem, the stem
 * goes to the top of the cockpit's recents, and the SWAY tab opens it. Neither
 * throws; a failure resolves false and says why in the status bar.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/lib/swayOpen.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';

const store = new Map<string, string>();
let storageFull = false;
const localStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    if (storageFull && k === 'sway:projects') throw new Error('QuotaExceededError');
    store.set(k, String(v));
  },
  removeItem: (k: string) => void store.delete(k),
};
const g = globalThis as unknown as Record<string, unknown>;
g.window = { localStorage, location: { hostname: 'localhost' }, dispatchEvent: () => true };
g.localStorage = localStorage;

const calls: string[] = [];
let answer: () => Response | Promise<Response> = () => new Response('', { status: 404 });
const recordingFetch = (async (input: RequestInfo | URL) => {
  calls.push(typeof input === 'string' ? input : String(input));
  return answer();
}) as typeof fetch;
globalThis.fetch = recordingFetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Imported after the browser globals exist, because the stores read them.
const { openSwaySceneFromPath, openSwayScene } = await import('./swayOpen');
const { useSwayOpenStore } = await import('../state/swayOpenStore');
const { useAppUiStore } = await import('../state/appUiStore');
const { useStatusBarStore } = await import('../state/statusBarStore');

// ── A servable .sway anywhere on disk opens under the stem the backend returns ─
const scenePath = 'C:\\Users\\me\\Downloads\\Night Drive (2).sway';
answer = () => json({ name: 'Night Drive (2)', path: scenePath, doc: { v: 1, layers: [] } });
assert.equal(await openSwaySceneFromPath(scenePath), true);
assert.deepEqual(calls, [`/api/sway/project?path=${encodeURIComponent(scenePath)}`]);
const target = 'swayproject:/Night Drive (2).sway';
assert.deepEqual(JSON.parse(store.get('sway:projects') as string)[target], { v: 1, layers: [] });
assert.deepEqual(JSON.parse(store.get('sway:recents') as string)[0], { path: target, name: 'Night Drive (2).sway' });
assert.equal(useSwayOpenStore.getState().request?.target, target);
assert.equal(useAppUiStore.getState().centerTab, 'sway');
const nonce = useSwayOpenStore.getState().request?.nonce ?? 0;

// ── A path the backend does not serve resolves false and says why ────────────
calls.length = 0;
answer = () => json({ detail: 'theDAW does not serve that scene.' }, 403);
assert.equal(await openSwaySceneFromPath('C:\\secret\\x.sway'), false);
assert.equal(useStatusBarStore.getState().text, 'SCENE OPEN FAILED: theDAW does not serve that scene.');
assert.equal(useSwayOpenStore.getState().request?.nonce, nonce, 'a refused open sends no open request');

// ── An empty path never reaches the backend ──────────────────────────────────
calls.length = 0;
assert.equal(await openSwaySceneFromPath(''), false);
assert.equal(await openSwaySceneFromPath('   '), false);
assert.deepEqual(calls, []);

// ── A network failure resolves false ─────────────────────────────────────────
globalThis.fetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof fetch;
assert.equal(await openSwaySceneFromPath('C:\\x\\a.sway'), false);
assert.equal(useStatusBarStore.getState().text, 'SCENE OPEN FAILED: Failed to fetch');
globalThis.fetch = recordingFetch;

// ── Full browser storage resolves false with the storage reason ──────────────
answer = () => json({ name: 'Big', path: 'C:\\x\\Big.sway', doc: {} });
storageFull = true;
assert.equal(await openSwaySceneFromPath('C:\\x\\Big.sway'), false);
assert.match(useStatusBarStore.getState().text, /^SCENE OPEN FAILED: Browser storage is full/);
storageFull = false;

// ── A response without a name falls back to the file's stem ──────────────────
answer = () => json({ path: 'C:\\x\\Fallback.sway', doc: { f: 1 } });
assert.equal(await openSwaySceneFromPath('C:\\x\\Fallback.sway'), true);
assert.equal(useSwayOpenStore.getState().request?.target, 'swayproject:/Fallback.sway');

// ── openSwayScene reads a saved scene by name ────────────────────────────────
calls.length = 0;
answer = () => json({ name: 'Club', path: 'D:\\data\\sway-projects\\Club.sway', doc: { c: 1 } });
assert.equal(await openSwayScene('Club.sway'), true);
assert.deepEqual(calls, ['/api/sway/project?name=Club']);
assert.equal(useSwayOpenStore.getState().request?.target, 'swayproject:/Club.sway');

console.log('swayOpen tests passed');
