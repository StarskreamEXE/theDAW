/**
 * saveFile: the kind map, and the sequence a save runs through.
 *
 * kindForName mirrors kind_for_path in backend/lib/known_paths.py; a file saved
 * under the wrong kind is offered to the wrong import control and opens the
 * wrong picker folder, so every extension group is pinned.
 *
 * The flow cases replay what a real local save does: Save As first, then the
 * bytes to /api/places/save at the chosen path, then the status bar. A picker
 * that answers 501 becomes a browser download.
 *
 * Run: `npx tsx src/lib/saveFile.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { extOfName, kindForName, safeFileName, saveFile } from './saveFile';
import { useStatusBarStore } from '../state/statusBarStore';

// ── kindForName ─────────────────────────────────────────────────────────────
const cases: Array<[string, string]> = [
  ['song.tasmo', 'tasmo'],
  ['plugin.gan', 'gan'],
  ['scene.sway', 'sway'],
  ['cloud.ares', 'ares'],
  ['set.als', 'daw-project'],
  ['mix.rpp-bak', 'daw-project'],
  ['beat.flp', 'daw-project'],
  ['take.aup3', 'daw-project'],
  ['layout.swayproj', 'daw-project'],
  ['song.dawproject', 'daw-project'],
  ['session.pts', 'daw-project'],
  ['take.wav', 'audio'],
  ['take.WAV', 'audio'],
  ['song.final.flac', 'audio'],
  ['clip.opus', 'audio'],
  ['clip.weba', 'audio'],
  ['clip.webm', 'audio'],
  ['riff.mid', 'midi'],
  ['riff.midi', 'midi'],
  ['riff.smf', 'midi'],
  ['score.musicxml', 'score'],
  ['score.mxl', 'score'],
  ['score.xml', 'score'],
  ['tab.alphatex', 'score'],
  ['sheet.pdf', 'score'],
  ['sheet.svg', 'score'],
  ['words.lrc', 'lyrics'],
  ['words.txt', 'lyrics'],
  ['map.json', 'json'],
  ['cover.png', 'image'],
  ['cover.jpeg', 'image'],
  ['cover.avif', 'image'],
  ['clip.mp4', 'video'],
  ['clip.ogv', 'video'],
  ['backup.zip', 'zip'],
  ['model.safetensors', 'checkpoint'],
  ['model.ckpt', 'checkpoint'],
  ['weights.bin', 'checkpoint'],
  ['quest.apk', 'apk'],
  ['README', 'file'],
  ['notes.docx', 'file'],
  ['.hidden', 'file'],
  ['C:\\some.dir\\README', 'file'],
  ['C:\\Users\\me\\Downloads\\take.wav', 'audio'],
];
for (const [name, kind] of cases) {
  assert.equal(kindForName(name), kind, `${name} -> ${kind}`);
}
assert.equal(extOfName('Song.Final.WAV'), '.wav');
assert.equal(extOfName('README'), '');

// ── safeFileName ────────────────────────────────────────────────────────────
assert.equal(safeFileName('AC/DC: Live? <2026>.wav'), 'AC_DC_ Live_ _2026_.wav');
assert.equal(safeFileName('tab\there|now*.mid'), 'tab_here_now_.mid');
assert.equal(safeFileName('C:\\Users\\me\\take.wav'), 'C__Users_me_take.wav');
assert.equal(safeFileName('trailing dots... '), 'trailing dots');
assert.equal(safeFileName('   '), 'download');
assert.equal(safeFileName('Björk – Jóga (live).flac'), 'Björk – Jóga (live).flac');

// ── the local save sequence ─────────────────────────────────────────────────
type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let routes: Record<string, () => Response> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : String(input);
  calls.push({ url, init });
  const handler = routes[url];
  if (!handler) return new Response('', { status: 404 });
  return handler();
}) as typeof fetch;

const g = globalThis as unknown as { window?: unknown; document?: unknown };
let clickedDownload: { href: string; download: string } | null = null;
g.window = {
  location: { hostname: 'localhost' },
  dispatchEvent: () => true,
};
g.document = {
  createElement: () => {
    const a = {
      href: '',
      download: '',
      click() {
        clickedDownload = { href: a.href, download: a.download };
      },
    };
    return a;
  },
  body: { appendChild: () => undefined, removeChild: () => undefined },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// 1. Save As, then the bytes and the dialog's grant to the chosen path, then the
//    status bar.
calls = [];
routes = {
  '/api/storage/pick-save': () => json({ path: 'D:\\Exports\\riff.mid', cancelled: false, grant: 'nonce-riff' }),
  '/api/places/save': () => json({ path: 'D:\\Exports\\riff.mid', kind: 'midi' }),
};
const saved = await saveFile({ blob: new Blob([new Uint8Array([1, 2, 3])]), suggestedName: 'riff.mid' });
assert.deepEqual(saved, { path: 'D:\\Exports\\riff.mid', cancelled: false, downloaded: false });
assert.deepEqual(calls.map((c) => c.url), ['/api/storage/pick-save', '/api/places/save'], 'picker before write');
const pickBody = JSON.parse(String(calls[0].init?.body));
assert.equal(pickBody.kind, 'midi');
assert.equal(pickBody.initial_name, 'riff.mid');
assert.equal(pickBody.default_ext, 'mid');
assert.equal(pickBody.filter, 'MID file (*.mid)|*.mid|All files (*.*)|*.*');
assert.equal(pickBody.initial_dir, undefined, 'no initialDir: the backend picks the last folder for the kind');
const form = calls[1].init?.body as FormData;
assert.equal(form.get('path'), 'D:\\Exports\\riff.mid');
assert.equal(form.get('kind'), 'midi');
assert.equal(form.get('grant'), 'nonce-riff', 'the write carries the grant the dialog answered with');
assert.equal((form.get('file') as Blob).size, 3);
assert.equal(useStatusBarStore.getState().text, 'SAVED: D:\\Exports\\riff.mid');

// 2. A url source is fetched before the write; an explicit kind wins.
calls = [];
routes = {
  '/api/storage/pick-save': () => json({ path: 'D:\\Exports\\take.wav', cancelled: false }),
  '/api/audio/abc': () => new Response(new Uint8Array([9, 9]), { status: 200 }),
  '/api/places/save': () => json({ path: 'D:\\Exports\\take.wav', kind: 'audio' }),
};
const fromUrl = await saveFile({ url: '/api/audio/abc', suggestedName: 'take.wav', kind: 'audio', filter: 'WAV|*.wav' });
assert.equal(fromUrl.path, 'D:\\Exports\\take.wav');
assert.deepEqual(calls.map((c) => c.url), ['/api/storage/pick-save', '/api/audio/abc', '/api/places/save']);
assert.equal(JSON.parse(String(calls[0].init?.body)).filter, 'WAV|*.wav');

// 3. Cancelling the dialog writes nothing.
calls = [];
routes = { '/api/storage/pick-save': () => json({ path: null, cancelled: true }) };
const cancelled = await saveFile({ blob: new Blob(['x']), suggestedName: 'words.lrc' });
assert.deepEqual(cancelled, { path: null, cancelled: true, downloaded: false });
assert.deepEqual(calls.map((c) => c.url), ['/api/storage/pick-save']);

// 4. No native dialog on this platform: a browser download instead.
calls = [];
clickedDownload = null;
routes = { '/api/storage/pick-save': () => json({ detail: 'no picker' }, 501) };
const downloaded = await saveFile({ url: '/api/audio/abc', suggestedName: 'take.wav' });
assert.deepEqual(downloaded, { path: null, cancelled: false, downloaded: true });
assert.deepEqual(clickedDownload, { href: '/api/audio/abc', download: 'take.wav' });

// 5. A refused write reports itself and returns no path.
calls = [];
routes = {
  '/api/storage/pick-save': () => json({ path: 'D:\\Exports\\map.json', cancelled: false }),
  '/api/places/save': () => json({ detail: 'That path was not chosen in a Save dialog.' }, 403),
};
const refused = await saveFile({ blob: new Blob(['{}']), suggestedName: 'map.json' });
assert.deepEqual(refused, { path: null, cancelled: false, downloaded: false });
assert.equal(useStatusBarStore.getState().text, 'SAVE FAILED: That path was not chosen in a Save dialog.');

// 6. A title with characters Windows refuses is offered as a safe name.
calls = [];
routes = { '/api/storage/pick-save': () => json({ path: null, cancelled: true }) };
await saveFile({ blob: new Blob(['x']), suggestedName: 'Intro: take 1/2?.wav' });
assert.equal(JSON.parse(String(calls[0].init?.body)).initial_name, 'Intro_ take 1_2_.wav');

// 7. The status bar names the destination while the bytes are on their way.
calls = [];
const seen: string[] = [];
const unsubscribe = useStatusBarStore.subscribe((s) => { seen.push(s.text); });
routes = {
  '/api/storage/pick-save': () => json({ path: 'D:\\Exports\\bundle.zip', cancelled: false }),
  '/api/library/bundle/1': () => new Response(new Uint8Array([7]), { status: 200 }),
  '/api/places/save': () => json({ path: 'D:\\Exports\\bundle.zip', kind: 'zip' }),
};
await saveFile({ url: '/api/library/bundle/1', suggestedName: 'bundle.zip' });
unsubscribe();
assert.deepEqual(seen.slice(-2), ['SAVING: D:\\Exports\\bundle.zip', 'SAVED: D:\\Exports\\bundle.zip']);

// 8. A backend without /api/places/save: the fetched bytes download instead.
calls = [];
clickedDownload = null;
const realCreate = URL.createObjectURL;
URL.createObjectURL = () => 'blob:saved-bytes';
routes = {
  '/api/storage/pick-save': () => json({ path: 'D:\\Exports\\take.wav', cancelled: false }),
  '/api/audio/abc': () => new Response(new Uint8Array([9, 9]), { status: 200 }),
};
const oldBackend = await saveFile({ url: '/api/audio/abc', suggestedName: 'take.wav' });
URL.createObjectURL = realCreate;
assert.deepEqual(oldBackend, { path: null, cancelled: false, downloaded: true });
assert.deepEqual(calls.map((c) => c.url), ['/api/storage/pick-save', '/api/audio/abc', '/api/places/save']);
assert.deepEqual(clickedDownload, { href: 'blob:saved-bytes', download: 'take.wav' });

// 9. A remote browser never opens the backend's dialog.
calls = [];
clickedDownload = null;
(g.window as { location: { hostname: string } }).location.hostname = 'studio.example';
const remote = await saveFile({ url: '/api/audio/abc', suggestedName: 'take.wav' });
assert.deepEqual(remote, { path: null, cancelled: false, downloaded: true });
assert.deepEqual(calls, []);
assert.deepEqual(clickedDownload, { href: '/api/audio/abc', download: 'take.wav' });

// 10. A file type the backend refuses: the dialog route's 400 reason reaches the
//     status bar, and nothing is written or downloaded.
(g.window as { location: { hostname: string } }).location.hostname = 'localhost';
calls = [];
clickedDownload = null;
routes = {
  '/api/storage/pick-save': () => json({ detail: 'That file type cannot be saved from theDAW.' }, 400),
};
const blocked = await saveFile({ blob: new Blob(['@echo off']), suggestedName: 'run.cmd' });
assert.deepEqual(blocked, { path: null, cancelled: false, downloaded: false });
assert.deepEqual(calls.map((c) => c.url), ['/api/storage/pick-save']);
assert.equal(clickedDownload, null);
assert.equal(useStatusBarStore.getState().text, 'SAVE FAILED: That file type cannot be saved from theDAW.');

// 11. initialDir reaches the dialog.
calls = [];
routes = { '/api/storage/pick-save': () => json({ path: null, cancelled: true }) };
await saveFile({ blob: new Blob(['x']), suggestedName: 'scene copy.sway', initialDir: 'C:\\Users\\me\\Downloads' });
assert.equal(JSON.parse(String(calls[0].init?.body)).initial_dir, 'C:\\Users\\me\\Downloads');

// 12. A dialog answer with no grant still sends the field, empty, so the
//     backend refuses the write with its own reason.
calls = [];
routes = {
  '/api/storage/pick-save': () => json({ path: 'D:\\Exports\\words.lrc', cancelled: false }),
  '/api/places/save': () => json({ detail: 'That path was not chosen in a Save dialog.' }, 403),
};
const noGrant = await saveFile({ blob: new Blob(['la']), suggestedName: 'words.lrc' });
assert.deepEqual(noGrant, { path: null, cancelled: false, downloaded: false });
assert.equal((calls[1].init?.body as FormData).get('grant'), '');
assert.equal(useStatusBarStore.getState().text, 'SAVE FAILED: That path was not chosen in a Save dialog.');

globalThis.fetch = realFetch;
delete g.window;
delete g.document;
console.log('saveFile tests passed');
