/**
 * mergeRecentProjects: the project router's ordered list and known places'
 * timed .tasmo rows become one list, one row per file, newest first.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/lib/recentProjects.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import type { PlaceItem } from './placesClient';
import { mergeRecentProjects } from './recentProjects';

const place = (path: string, at: number, source = 'client'): PlaceItem => ({
  path,
  name: path.split(/[\\/]/).pop() ?? path,
  kind: 'tasmo',
  source,
  at,
  servable: false,
});
const labels = (rows: Array<{ path: string; name: string }>) => rows.map((r) => `${r.name}|${r.path}`);

// A Save a copy the router never saw goes on top by its time. A router row
// with no known time takes the time of the row above it. Case and separator
// variants of one Windows path are one row, and a non-.tasmo row is dropped.
assert.deepEqual(
  labels(
    mergeRecentProjects(
      [
        { path: 'C:\\P\\b.tasmo', name: 'Song B' },
        { path: 'C:\\P\\gone.tasmo', name: 'Gone' },
        { path: 'C:\\P\\a.tasmo', name: 'Song A' },
        { path: 'c:/p/B.tasmo', name: 'dup of B' },
      ],
      [
        place('C:\\Users\\me\\Downloads\\Demo copy.tasmo', 300, 'save'),
        place('C:\\P\\B.TASMO', 200),
        place('C:\\P\\a.tasmo', 100),
        place('C:\\P\\old copy.tasmo', 50, 'install'),
        place('C:\\P\\notes.txt', 400, 'save'),
      ],
    ),
  ),
  [
    'Demo copy|C:\\Users\\me\\Downloads\\Demo copy.tasmo',
    'Song B|C:\\P\\b.tasmo',
    'Gone|C:\\P\\gone.tasmo',
    'Song A|C:\\P\\a.tasmo',
    'old copy|C:\\P\\old copy.tasmo',
  ],
);

// With nothing from known places the router's order stands, and POSIX paths
// keep their case.
assert.deepEqual(
  mergeRecentProjects(
    [
      { path: '/home/me/x.tasmo', name: 'x' },
      { path: '/home/me/X.tasmo', name: 'X' },
    ],
    [],
  ).map((r) => r.name),
  ['x', 'X'],
);

// A router row above every match stays on top.
assert.deepEqual(
  mergeRecentProjects(
    [
      { path: 'C:\\P\\new-missing.tasmo', name: 'N' },
      { path: 'C:\\P\\a.tasmo', name: 'A' },
    ],
    [place('C:\\P\\z.tasmo', 500), place('C:\\P\\a.tasmo', 100)],
  ).map((r) => r.name),
  ['N', 'z', 'A'],
);

// Of two known rows for one file, the newer one sets its place.
assert.deepEqual(
  mergeRecentProjects(
    [{ path: 'C:\\P\\late.tasmo', name: 'Late' }],
    [place('C:\\P\\early.tasmo', 20), place('C:\\P\\late.tasmo', 5), place('c:/P/LATE.tasmo', 40)],
  ).map((r) => r.name),
  ['Late', 'early'],
);

// Blank and malformed rows are skipped.
assert.deepEqual(
  mergeRecentProjects(
    [{ path: '  ', name: 'blank' }, null as unknown as { path: string; name: string }],
    [{ ...place('C:\\P\\ok.tasmo', 1), name: '' }],
  ),
  [{ path: 'C:\\P\\ok.tasmo', name: 'ok' }],
);

console.log('recentProjects tests passed');
