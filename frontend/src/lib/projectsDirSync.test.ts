/**
 * The projects-folder handover between clients.
 *
 * Replays the order a real session produces: a client boots and reads the
 * backend's folder, the user sets a folder in one client, and another client
 * holding an old stored folder opens later. Each step applies
 * decideProjectsDir the way projectStore.ensureDefaultDir does, against one
 * backend both clients share.
 *
 * Run: `npx tsx src/lib/projectsDirSync.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { decideProjectsDir, looksAbsolute } from './projectsDirSync';

const DEFAULT = 'C:\\Users\\me\\Documents\\theDAW Projects';

interface Backend {
  path: string;
  configured: boolean;
  failPut: boolean;
  puts: string[];
}

interface Client {
  dir: string;
  synced: boolean;
}

const freshBackend = (): Backend => ({ path: DEFAULT, configured: false, failPut: false, puts: [] });

/** PUT /api/places/projects-dir. */
function put(b: Backend, dir: string): boolean {
  b.puts.push(dir);
  if (b.failPut) return false;
  b.path = dir;
  b.configured = true;
  return true;
}

/** projectStore.ensureDefaultDir: read the backend, then show, push or adopt. */
function ensure(c: Client, b: Backend): void {
  const d = decideProjectsDir({
    local: c.dir,
    backend: { path: b.path, configured: b.configured },
    synced: c.synced,
  });
  if (d.push) {
    if (put(b, d.push)) {
      c.synced = true;
      c.dir = b.path;
    }
    return;
  }
  if (d.markSynced) c.synced = true;
  c.dir = d.show;
}

/** projectStore.setDefaultDir: the user types or picks a folder. */
function userSets(c: Client, b: Backend, dir: string): void {
  c.dir = dir;
  if (looksAbsolute(dir) && put(b, dir)) c.synced = true;
}

// ── A folder set in the desktop app is adopted by a second browser ──────────
{
  const b = freshBackend();
  const electron: Client = { dir: '', synced: false };
  ensure(electron, b);
  assert.equal(electron.dir, DEFAULT, 'a client with no folder shows the backend default');
  assert.equal(b.configured, false);
  assert.deepEqual(b.puts, []);

  userSets(electron, b, 'E:\\Music\\Projects');
  assert.equal(b.path, 'E:\\Music\\Projects');
  assert.equal(b.configured, true);

  const browser: Client = { dir: 'D:\\Old Projects', synced: false };
  ensure(browser, b);
  assert.equal(browser.dir, 'E:\\Music\\Projects', 'the second client adopts the folder set in the first');
  assert.equal(b.path, 'E:\\Music\\Projects', 'an old stored folder never replaces a configured one');
  assert.deepEqual(b.puts, ['E:\\Music\\Projects']);
  assert.equal(browser.synced, true);

  // Both clients ask again (asset install, backup dialog): nothing moves.
  ensure(browser, b);
  ensure(electron, b);
  assert.equal(browser.dir, 'E:\\Music\\Projects');
  assert.equal(electron.dir, 'E:\\Music\\Projects');
  assert.deepEqual(b.puts, ['E:\\Music\\Projects']);
}

// ── With no folder on the backend, the first client's folder is handed over ─
{
  const b = freshBackend();
  const browser: Client = { dir: 'D:\\Old Projects', synced: false };
  ensure(browser, b);
  assert.deepEqual(b.puts, ['D:\\Old Projects'], 'the stored folder is sent once');
  assert.equal(b.configured, true);
  assert.equal(browser.synced, true);
  assert.equal(browser.dir, 'D:\\Old Projects');

  const electron: Client = { dir: '', synced: false };
  ensure(electron, b);
  assert.equal(electron.dir, 'D:\\Old Projects', 'a client opened later shows the handed-over folder');
  assert.deepEqual(b.puts, ['D:\\Old Projects']);

  userSets(electron, b, 'F:\\New Projects');
  ensure(browser, b);
  assert.equal(browser.dir, 'F:\\New Projects', 'a later change reaches the other client when it asks');
  assert.deepEqual(b.puts, ['D:\\Old Projects', 'F:\\New Projects']);
}

// ── A push the backend refuses keeps the folder and is tried again ──────────
{
  const b = freshBackend();
  b.failPut = true;
  const c: Client = { dir: 'J:\\Mine', synced: false };
  ensure(c, b);
  assert.equal(c.dir, 'J:\\Mine', 'the client keeps its folder');
  assert.equal(c.synced, false, 'the synced flag waits for an accepted push');
  assert.equal(b.configured, false);

  b.failPut = false;
  ensure(c, b);
  assert.deepEqual(b.puts, ['J:\\Mine', 'J:\\Mine']);
  assert.equal(b.path, 'J:\\Mine');
  assert.equal(c.synced, true);
}

// ── A synced client follows the backend even when nothing is configured ─────
{
  const d = decideProjectsDir({ local: 'D:\\Old', backend: { path: DEFAULT, configured: false }, synced: true });
  assert.deepEqual(d, { show: DEFAULT, push: null, markSynced: true });
}

// ── Stored values that are never sent ───────────────────────────────────────
for (const local of [
  '',
  '   ',
  'relative\\dir',
  'projects',
  '\\\\server\\share\\Projects',
  '//server/share/Projects',
  '\\\\?\\C:\\Projects',
  '\\\\.\\PhysicalDrive0',
]) {
  const d = decideProjectsDir({ local, backend: { path: DEFAULT, configured: false }, synced: false });
  assert.equal(d.push, null, `never pushed: ${JSON.stringify(local)}`);
  assert.equal(d.show, DEFAULT);
  assert.equal(d.markSynced, true);
}

// ── The same folder as the backend needs no request ─────────────────────────
assert.deepEqual(
  decideProjectsDir({ local: DEFAULT, backend: { path: DEFAULT, configured: false }, synced: false }),
  { show: DEFAULT, push: null, markSynced: true },
);

// ── Surrounding spaces are not part of the folder ───────────────────────────
assert.deepEqual(
  decideProjectsDir({ local: '  E:\\Padded  ', backend: { path: DEFAULT, configured: false }, synced: false }),
  { show: 'E:\\Padded', push: 'E:\\Padded', markSynced: false },
);

// ── A backend that answers no path leaves the client's folder shown ─────────
assert.equal(
  decideProjectsDir({ local: 'E:\\Mine', backend: { path: '', configured: true }, synced: true }).show,
  'E:\\Mine',
);

// ── looksAbsolute ───────────────────────────────────────────────────────────
assert.equal(looksAbsolute('C:\\Users\\me'), true);
assert.equal(looksAbsolute('c:/Users/me'), true);
assert.equal(looksAbsolute('/home/me/Projects'), true);
assert.equal(looksAbsolute('\\Projects'), true, 'a path rooted on the current drive');
assert.equal(looksAbsolute('C:Projects'), false, 'a drive-relative path');
assert.equal(looksAbsolute('\\\\server\\share'), false, 'a UNC share');
assert.equal(looksAbsolute('//server/share'), false, 'a UNC share with forward slashes');
assert.equal(looksAbsolute('\\\\?\\C:\\x'), false, 'a device path');
assert.equal(looksAbsolute('\\\\.\\COM1'), false, 'a device path');
assert.equal(looksAbsolute(''), false);

console.log('projectsDirSync: all checks passed');
