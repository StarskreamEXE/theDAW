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
import { basenameOf, dirnameOf, isLocalClient, normalizeExts, placesApi } from './placesClient';

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

globalThis.fetch = realFetch;
console.log('placesClient tests passed');
