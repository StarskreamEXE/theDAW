/**
 * The track menu's focus, replayed against the row set changing under it.
 *
 * The sequence that broke it: the key is pressed with ArrowUp, which means "open
 * at the last row"; the menu opens with the Stems group as one "Checking"
 * placeholder, so the last row is that placeholder; the probe lands and the
 * placeholder becomes one line per stem. Focus has to end on the last of those,
 * not on the row that was last before they arrived.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/components/audio/trackMenuFocus.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  lastMenuItem,
  markOf,
  menuItems,
  restoreTarget,
  rovingIndex,
  type FocusMark,
  type MenuKey,
} from './trackMenuFocus.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { document } = dom.window;

/** Builds a menu of `[group id, ...row ids]`, the shape TrackMenu renders. */
function menu(...groups: Array<[string, ...string[]]>): HTMLElement {
  const root = document.createElement('div');
  root.id = 'footer-track-menu';
  for (const [groupId, ...rows] of groups) {
    const g = document.createElement('div');
    g.setAttribute('role', 'group');
    g.dataset.groupId = groupId;
    for (const rowId of rows) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.dataset.rowId = rowId;
      g.appendChild(b);
    }
    root.appendChild(g);
  }
  return root;
}

const idOf = (el: HTMLElement | null): string | null => el?.dataset.rowId ?? null;
const rowIn = (root: HTMLElement, id: string): HTMLElement =>
  menuItems(root).find((el) => el.dataset.rowId === id)!;

// (a) menuItems reads every row in reading order, across groups.
{
  const m = menu(['play', 'play-now', 'play-next'], ['stems', 'stem-each']);
  assert.deepEqual(menuItems(m).map(idOf), ['play-now', 'play-next', 'stem-each']);
  assert.equal(idOf(lastMenuItem(m)), 'stem-each');
  assert.equal(lastMenuItem(document.createElement('div')), null);
}

// (b) markOf records the group and whether the row is the end of it.
{
  const m = menu(['play', 'play-now', 'play-next'], ['stems', 'a', 'b']);
  assert.deepEqual(markOf(rowIn(m, 'play-now')), { rowId: 'play-now', groupId: 'play', atGroupEnd: false });
  assert.deepEqual(markOf(rowIn(m, 'play-next')), { rowId: 'play-next', groupId: 'play', atGroupEnd: true });
  assert.deepEqual(markOf(rowIn(m, 'b')), { rowId: 'b', groupId: 'stems', atGroupEnd: true });
}

// (c) The row is still there after a repack: focus goes back to it, not to a
// neighbour that happens to sit where it used to.
{
  const before = menu(['play', 'play-now', 'play-next'], ['stems', 'stem-each']);
  const after = menu(['stems', 'stem-each'], ['play', 'play-now', 'play-next']);
  assert.equal(idOf(restoreTarget(after, markOf(rowIn(before, 'play-next')))), 'play-next');
}

// (d) THE BUG. The user was on the Stems placeholder, the last row of the menu.
// The probe replaces it with a line per stem. Focus must land on the last of
// them; it used to land on the first, six rows short of where the user was.
{
  const before = menu(['play', 'play-now'], ['stems', 'stem-each']);
  const mark = markOf(rowIn(before, 'stem-each'));
  const after = menu(
    ['play', 'play-now'],
    ['stems', 'vocals-edit', 'vocals-save', 'drums-edit', 'drums-save', 'bass-edit', 'bass-save'],
  );
  assert.equal(idOf(restoreTarget(after, mark)), 'bass-save');
}

// (e) A user at the START of a group that gets replaced stays at its start.
{
  const before = menu(['play', 'play-now'], ['stems', 'stem-each', 'stem-other']);
  const mark = markOf(rowIn(before, 'stem-each'));
  assert.equal(mark.atGroupEnd, false);
  const after = menu(['play', 'play-now'], ['stems', 'vocals-edit', 'vocals-save', 'drums-edit']);
  assert.equal(idOf(restoreTarget(after, mark)), 'vocals-edit');
}

// (f) The whole group is gone: the menu's first row takes focus rather than
// nothing, so the keyboard is never stranded outside the rows.
{
  const before = menu(['play', 'play-now'], ['stems', 'stem-each']);
  const mark = markOf(rowIn(before, 'stem-each'));
  const after = menu(['play', 'play-now', 'play-next']);
  assert.equal(idOf(restoreTarget(after, mark)), 'play-now');
  assert.equal(restoreTarget(menu(), mark), null, 'an empty menu has nothing to focus');
}

// (g) A mark with no row id at all (focus was on the card, not a row).
{
  const mark: FocusMark = { rowId: null, groupId: 'stems', atGroupEnd: true };
  const after = menu(['play', 'play-now'], ['stems', 'a', 'b']);
  assert.equal(idOf(restoreTarget(after, mark)), 'b');
}

// (h) rovingIndex: both ends wrap, and -1 (focus not on a row) means ArrowUp
// opens at the last row and ArrowDown at the first — which is what the key's
// ArrowUp and ArrowDown are asking for.
{
  const keys: MenuKey[] = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  for (const key of keys) assert.equal(rovingIndex(-1, 0, key), -1, `${key} on an empty menu`);

  assert.equal(rovingIndex(-1, 5, 'ArrowUp'), 4, 'ArrowUp from nowhere is the last row');
  assert.equal(rovingIndex(-1, 5, 'ArrowDown'), 0, 'ArrowDown from nowhere is the first row');
  assert.equal(rovingIndex(0, 5, 'ArrowUp'), 4, 'the first row wraps to the last');
  assert.equal(rovingIndex(4, 5, 'ArrowDown'), 0, 'the last row wraps to the first');
  assert.equal(rovingIndex(2, 5, 'ArrowUp'), 1);
  assert.equal(rovingIndex(2, 5, 'ArrowDown'), 3);
  assert.equal(rovingIndex(2, 5, 'Home'), 0);
  assert.equal(rovingIndex(2, 5, 'End'), 4);
  assert.equal(rovingIndex(0, 1, 'ArrowUp'), 0, 'one row is both ends');
  assert.equal(rovingIndex(0, 1, 'ArrowDown'), 0);
}

// (i) End and ArrowUp-from-nowhere agree with lastMenuItem, so the key's
// "open at the last row" and the menu's End land on the same row.
{
  const m = menu(['play', 'play-now', 'play-next'], ['stems', 'a', 'b', 'c']);
  const items = menuItems(m);
  assert.equal(items[rovingIndex(-1, items.length, 'ArrowUp')], lastMenuItem(m));
  assert.equal(items[rovingIndex(3, items.length, 'End')], lastMenuItem(m));
}

console.log('trackMenuFocus: a probe that replaces rows keeps focus at the end the user was at');
