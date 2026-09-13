/**
 * openSwayScene and openSwaySceneFromPath hand a scene the backend returns to
 * the SWAY cockpit: the doc goes into localStorage under its stem, the stem
 * goes to the top of the cockpit's recents, and the SWAY tab opens it. Neither
 * throws; a failure resolves false and says why in the status bar. A file from
 * outside the scene folder never takes a listed scene's name, so a cockpit save
 * of it cannot write over that scene.
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const LISTING = '/api/sway/projects';
const calls: string[] = [];
let answer: () => Response | Promise<Response> = () => new Response('', { status: 404 });
// What GET /api/sway/projects lists; null makes that request fail.
let listed: Array<{ name: string; path: string; mtime: number }> | null = [];
const recordingFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : String(input);
  calls.push(url);
  if (url === LISTING) return listed ? json({ projects: listed }) : json({ detail: 'listing broke' }, 500);
  return answer();
}) as typeof fetch;
globalThis.fetch = recordingFetch;

// Imported after the browser globals exist, because the stores read them.
const { openSwaySceneFromPath, openSwayScene, freeSceneStem } = await import('./swayOpen');
const { useSwayOpenStore } = await import('../state/swayOpenStore');
const { useAppUiStore } = await import('../state/appUiStore');
const { useStatusBarStore } = await import('../state/statusBarStore');

const projectsStore = () => JSON.parse(store.get('sway:projects') as string) as Record<string, unknown>;

// ── A servable .sway anywhere on disk opens under the stem the backend returns ─
const scenePath = 'C:\\Users\\me\\Downloads\\Night Drive (2).sway';
answer = () => json({ name: 'Night Drive (2)', path: scenePath, doc: { v: 1, layers: [] } });
assert.equal(await openSwaySceneFromPath(scenePath), true);
assert.deepEqual(calls, [`/api/sway/project?path=${encodeURIComponent(scenePath)}`, LISTING]);
const target = 'swayproject:/Night Drive (2).sway';
assert.deepEqual(projectsStore()[target], { v: 1, layers: [] });
assert.deepEqual(JSON.parse(store.get('sway:recents') as string)[0], { path: target, name: 'Night Drive (2).sway' });
assert.equal(useSwayOpenStore.getState().request?.target, target);
assert.equal(useAppUiStore.getState().centerTab, 'sway');
const nonce = useSwayOpenStore.getState().request?.nonce ?? 0;

// ── A path the backend does not serve resolves false and says why ────────────
calls.length = 0;
answer = () => json({ detail: 'That scene file is gone or was never opened in theDAW.' }, 403);
assert.equal(await openSwaySceneFromPath('C:\\secret\\x.sway'), false);
assert.equal(
  useStatusBarStore.getState().text,
  'SCENE OPEN FAILED: That scene file is gone or was never opened in theDAW.',
);
assert.equal(useSwayOpenStore.getState().request?.nonce, nonce, 'a refused open sends no open request');
assert.deepEqual(calls, ['/api/sway/project?path=C%3A%5Csecret%5Cx.sway'], 'a refused open lists nothing');

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

// ── Then a file named like that scene, from outside the scene folder, opens ───
// under the next free number, and the listed scene's doc stays as it was.
listed = [
  { name: 'Club', path: 'D:\\data\\sway-projects\\Club.sway', mtime: 3 },
  { name: 'Club (2)', path: 'D:\\data\\sway-projects\\Club (2).sway', mtime: 2 },
  { name: 'Warehouse 2', path: 'D:\\data\\sway-projects\\Warehouse 2.sway', mtime: 1 },
];
answer = () => json({ name: 'Club', path: 'C:\\Users\\me\\Downloads\\Club.sway', doc: { outside: 1 } });
assert.equal(await openSwaySceneFromPath('C:\\Users\\me\\Downloads\\Club.sway'), true);
assert.equal(useSwayOpenStore.getState().request?.target, 'swayproject:/Club (3).sway');
assert.deepEqual(projectsStore()['swayproject:/Club (3).sway'], { outside: 1 });
assert.deepEqual(projectsStore()['swayproject:/Club.sway'], { c: 1 }, 'the listed scene is untouched');

// ── The listed scene itself, opened by its path, keeps its name ──────────────
answer = () => json({ name: 'Club', path: 'd:/data/sway-projects/Club.sway', doc: { c: 2 } });
assert.equal(await openSwaySceneFromPath('d:/data/sway-projects/Club.sway'), true);
assert.equal(useSwayOpenStore.getState().request?.target, 'swayproject:/Club.sway');

// ── Names match without case, and as a save would write them ─────────────────
answer = () => json({ name: 'CLUB', path: 'C:\\x\\CLUB.sway', doc: {} });
assert.equal(await openSwaySceneFromPath('C:\\x\\CLUB.sway'), true);
assert.equal(useSwayOpenStore.getState().request?.target, 'swayproject:/CLUB (3).sway');
// A save drops the parentheses, so "Warehouse (2)" would write Warehouse 2.sway.
answer = () => json({ name: 'Warehouse', path: 'C:\\x\\Warehouse.sway', doc: {} });
listed = [...listed, { name: 'Warehouse', path: 'D:\\data\\sway-projects\\Warehouse.sway', mtime: 0 }];
assert.equal(await openSwaySceneFromPath('C:\\x\\Warehouse.sway'), true);
assert.equal(useSwayOpenStore.getState().request?.target, 'swayproject:/Warehouse (3).sway');

// ── A file whose name no listed scene has keeps it ───────────────────────────
answer = () => json({ name: 'Solo', path: 'C:\\x\\Solo.sway', doc: {} });
assert.equal(await openSwaySceneFromPath('C:\\x\\Solo.sway'), true);
assert.equal(useSwayOpenStore.getState().request?.target, 'swayproject:/Solo.sway');

// ── A listing that fails still opens the file under its own name ─────────────
listed = null;
answer = () => json({ name: 'Club', path: 'C:\\x\\Club.sway', doc: { late: 1 } });
assert.equal(await openSwaySceneFromPath('C:\\x\\Club.sway'), true);
assert.equal(useSwayOpenStore.getState().request?.target, 'swayproject:/Club.sway');

// ── freeSceneStem on its own ─────────────────────────────────────────────────
assert.equal(freeSceneStem('Intro', []), 'Intro');
assert.equal(freeSceneStem('Intro', ['intro']), 'Intro (2)');
assert.equal(freeSceneStem('Intro', ['Intro', 'Intro (2)', 'intro (3)']), 'Intro (4)');
assert.equal(freeSceneStem('Intro!', ['Intro']), 'Intro! (2)', 'a save of "Intro!" would write Intro.sway');

console.log('swayOpen tests passed');
