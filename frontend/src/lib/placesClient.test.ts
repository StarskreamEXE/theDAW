/**
 * Path helpers the known-places UI builds on.
 *
 * PathInput opens a file picker in `dirnameOf(field value)`, and the Recent
 * menu shows each file's folder with it, so both separator styles, drive and
 * POSIX roots, UNC shares and bare names are pinned here.
 *
 * Run: `npx tsx src/lib/placesClient.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  basenameOf,
  dirnameOf,
  isLocalClient,
  mergePlaceItems,
  normalizeExts,
  pathKey,
  placesApi,
  type PlaceItem,
} from './placesClient';

// ── dirnameOf ───────────────────────────────────────────────────────────────
assert.equal(dirnameOf('C:\\Users\\me\\Downloads\\song.wav'), 'C:\\Users\\me\\Downloads');
assert.equal(dirnameOf('/home/me/Music/song.wav'), '/home/me/Music');
assert.equal(dirnameOf('C:/Users/me/song.wav'), 'C:/Users/me', 'forward slashes on Windows');
assert.equal(dirnameOf('C:\\Users/me\\song.wav'), 'C:\\Users/me', 'mixed separators');
assert.equal(dirnameOf('song.wav'), '', 'a bare name has no folder');
assert.equal(dirnameOf(''), '');
assert.equal(dirnameOf('C:\\song.wav'), 'C:\\', 'a file at a drive root keeps the root separator');
assert.equal(dirnameOf('C:/song.wav'), 'C:/');
assert.equal(dirnameOf('/song.wav'), '/', 'a file at the POSIX root');
assert.equal(dirnameOf('\\\\server\\share\\song.wav'), '\\\\server\\share', 'UNC share');
assert.equal(dirnameOf('C:\\Users\\me\\Projects\\'), 'C:\\Users\\me', 'a trailing separator names the folder itself');
assert.equal(dirnameOf('/home/me/Projects/'), '/home/me');
assert.equal(dirnameOf('C:\\'), 'C:\\', 'a drive root is its own folder');
assert.equal(dirnameOf('/'), '/');

// ── basenameOf ──────────────────────────────────────────────────────────────
assert.equal(basenameOf('C:\\Users\\me\\song.wav'), 'song.wav');
assert.equal(basenameOf('/home/me/Projects/'), 'Projects');
assert.equal(basenameOf('song.wav'), 'song.wav');

// ── pathKey ─────────────────────────────────────────────────────────────────
assert.equal(pathKey('C:\\Users\\Me\\Song.TASMO'), pathKey('c:/users/me/song.tasmo'), 'a Windows path ignores case and separators');
assert.equal(pathKey('  D:\\x.sway '), 'd:\\x.sway', 'padding is dropped');
assert.equal(pathKey('\\\\Server\\Share\\a.wav'), '\\\\server\\share\\a.wav', 'a UNC share is a Windows path');
assert.notEqual(pathKey('/home/me/Song.tasmo'), pathKey('/home/me/song.tasmo'), 'a POSIX path keeps its case');

// ── normalizeExts ───────────────────────────────────────────────────────────
assert.deepEqual(normalizeExts(['.MID', 'midi', ' .Mid ', 'audio/*', '*']), ['.mid', '.midi']);
assert.deepEqual(normalizeExts(undefined), []);

// ── isLocalClient outside a browser ─────────────────────────────────────────
assert.equal(isLocalClient(), false, 'no window means no local disk to offer');

// ── fileUrl encodes the whole path ──────────────────────────────────────────
assert.equal(
  placesApi.fileUrl('C:\\a b\\c&d.wav'),
  '/api/places/file?path=C%3A%5Ca%20b%5Cc%26d.wav',
);

// ── recent sends its filters and never throws ───────────────────────────────
const realFetch = globalThis.fetch;
let lastUrl = '';
globalThis.fetch = (async (input: RequestInfo | URL) => {
  lastUrl = typeof input === 'string' ? input : String(input);
  return new Response(
    JSON.stringify({
      items: [{ path: 'C:\\x\\a.mid', name: 'a.mid', kind: 'midi', source: 'save', at: 1, servable: true }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}) as typeof fetch;
const rows = await placesApi.recent({ kind: 'midi', exts: ['MID', '.midi'], limit: 5 });
assert.equal(lastUrl, '/api/places/recent?kind=midi&exts=.mid%2C.midi&limit=5');
assert.equal(rows.length, 1);
assert.equal(rows[0].name, 'a.mid');

globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
assert.deepEqual(await placesApi.recent(), [], 'a backend without the route yields no rows');
assert.equal(await placesApi.folder('audio'), null);
assert.deepEqual(await placesApi.record('C:\\x\\a.mid'), { recorded: false, kind: null });
await assert.rejects(placesApi.projectsDir(), 'projectsDir is an action and throws');

// ── mergePlaceItems: one row per path, the newest entry, newest first ─────────
const row = (path: string, kind: string, at: number): PlaceItem => ({
  path,
  name: basenameOf(path),
  kind,
  source: 'save',
  at,
  servable: true,
});
assert.deepEqual(
  mergePlaceItems([
    [row('C:\\a\\set.json', 'nodefi-set', 10), row('C:\\a\\old.json', 'nodefi-set', 2)],
    [row('C:\\a\\map.json', 'meter-map', 7), row('C:\\a\\set.json', 'nodefi-set', 4)],
  ]).map((r) => [r.path, r.at]),
  [
    ['C:\\a\\set.json', 10],
    ['C:\\a\\map.json', 7],
    ['C:\\a\\old.json', 2],
  ],
);
assert.deepEqual(mergePlaceItems([]), []);

// ── recentOfKinds: one request per kind, merged ──────────────────────────────
const byKind: Record<string, PlaceItem[]> = {
  'meter-map': [row('C:\\m\\a.json', 'meter-map', 30), row('C:\\m\\b.json', 'meter-map', 5)],
  'meter-report': [row('C:\\m\\a.md', 'meter-report', 20)],
};
let urls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : String(input);
  urls.push(url);
  const kind = new URL(url, 'http://x').searchParams.get('kind');
  // A backend that ignores `kind` for 'meter-report' answers with a stray row.
  const items = kind === 'meter-report' ? [...byKind[kind], row('C:\\m\\log.txt', 'log', 99)] : kind ? byKind[kind] ?? [] : [];
  return new Response(JSON.stringify({ items }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;
const merged = await placesApi.recentOfKinds({ kinds: ['meter-map', 'meter-report', 'meter-map'], exts: ['.json', '.md'], limit: 30 });
assert.deepEqual(urls.sort(), [
  '/api/places/recent?kind=meter-map&exts=.json%2C.md&limit=30',
  '/api/places/recent?kind=meter-report&exts=.json%2C.md&limit=30',
]);
assert.deepEqual(merged.map((r) => r.path), ['C:\\m\\a.json', 'C:\\m\\a.md', 'C:\\m\\b.json'], 'other kinds are dropped');
urls = [];
await placesApi.recentOfKinds({ exts: ['.mid'] });
assert.deepEqual(urls, ['/api/places/recent?exts=.mid'], 'no kinds: one request for every kind');
urls = [];
await placesApi.recentOfKinds({ kinds: ['lyrics'], exts: ['.txt'] });
assert.deepEqual(urls, ['/api/places/recent?kind=lyrics&exts=.txt']);

// ── projectsDir reports whether a folder was stored ──────────────────────────
let dirBody: unknown = { path: 'D:\\Music\\Projects', configured: true };
globalThis.fetch = (async () =>
  new Response(JSON.stringify(dirBody), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
assert.deepEqual(await placesApi.projectsDir(), { path: 'D:\\Music\\Projects', configured: true });
dirBody = { path: 'C:\\Users\\me\\Documents\\theDAW Projects', configured: false };
assert.deepEqual(await placesApi.projectsDir(), { path: 'C:\\Users\\me\\Documents\\theDAW Projects', configured: false });
dirBody = { path: 'C:\\Users\\me\\Documents\\theDAW Projects' };
assert.deepEqual(
  await placesApi.projectsDir(),
  { path: 'C:\\Users\\me\\Documents\\theDAW Projects', configured: false },
  'a backend that does not say is read as the default folder',
);

globalThis.fetch = realFetch;
console.log('placesClient tests passed');
