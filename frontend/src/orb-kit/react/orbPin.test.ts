/**
 * The orb's corner pin, under plain node.
 *
 * Covered: a pinned box sits flush in its corner and stays whole on screen
 * however small the viewport; the first click is remembered under its own key,
 * an unreadable store leaves the orb pinned and a failed write reports the miss;
 * a pinned orb never moves under a drag while a free one follows the pointer;
 * only a press that did not drag toggles, and on a pinned orb it also unpins.
 * The last two blocks replay the sequence a fresh profile produces, once with a
 * working store and once with a broken one.
 *
 * Run: `npx tsx src/orb-kit/react/orbPin.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  orbCornerPosition,
  orbPinKey,
  orbPointerMove,
  orbPressResult,
  persistOrbUnpinned,
  readOrbPinned,
  readSavedOrbPosition,
  type OrbPinStorage,
} from './orbPin';

const memory = (seed: Record<string, string> = {}): OrbPinStorage & { data: Record<string, string> } => {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
};
const broken: OrbPinStorage = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

// ── the pinned position ─────────────────────────────────────────────────────
// theDAW's orb: a 112px box, flush to the bottom-left corner.
assert.deepEqual(orbCornerPosition('bottom-left', { width: 1366, height: 768 }, 112), { x: 0, y: 656 });
assert.deepEqual(orbCornerPosition('bottom-left', { width: 1920, height: 1080 }, 112), { x: 0, y: 968 });
// A margin insets the box from both edges of its corner.
assert.deepEqual(orbCornerPosition('bottom-left', { width: 1366, height: 768 }, 112, 16), { x: 16, y: 640 });
assert.deepEqual(orbCornerPosition('bottom-right', { width: 1366, height: 768 }, 112, 16), { x: 1238, y: 640 });
assert.deepEqual(orbCornerPosition('top-right', { width: 1366, height: 768 }, 112), { x: 1254, y: 0 });
assert.deepEqual(orbCornerPosition('top-left', { width: 1366, height: 768 }, 112, 12), { x: 12, y: 12 });
// A viewport too small for box + margin keeps the whole box on screen.
assert.deepEqual(orbCornerPosition('bottom-left', { width: 120, height: 120 }, 112, 16), { x: 8, y: 0 });
assert.deepEqual(orbCornerPosition('bottom-right', { width: 100, height: 80 }, 112, 16), { x: 0, y: 0 });

// ── the first click, remembered ─────────────────────────────────────────────
const key = orbPinKey('thedaw-orb-pos-v4');
assert.equal(key, 'thedaw-orb-pos-v4-clicked');
assert.equal(orbPinKey(false), null);
const store = memory();
assert.equal(readOrbPinned(store, key), true, 'a fresh profile starts pinned');
assert.equal(persistOrbUnpinned(store, key), true);
assert.equal(store.data['thedaw-orb-pos-v4-clicked'], '1');
assert.equal(readOrbPinned(store, key), false, 'a remembered click starts unpinned');
// An earlier drag release and a saved position are not a click.
assert.equal(
  readOrbPinned(memory({ 'thedaw-orb-pos-v4-unstuck': '1', 'thedaw-orb-pos-v4': '{"x":400,"y":300}' }), key),
  true,
);
assert.equal(readOrbPinned(broken, key), true, 'an unreadable store leaves the orb pinned');
assert.equal(persistOrbUnpinned(broken, key), false, 'a failed write reports the miss');
assert.equal(readOrbPinned(null, key), true);
assert.equal(persistOrbUnpinned(null, key), false);
assert.equal(readOrbPinned(store, null), true, 'without a persistence key every load starts pinned');

// ── the saved position of a free orb ────────────────────────────────────────
const vp = { width: 1366, height: 768 };
assert.deepEqual(readSavedOrbPosition(memory({ pos: '{"x":490,"y":290}' }), 'pos', vp, 112), { x: 490, y: 290 });
// Saved in a bigger window: clamped so the whole box is on screen.
assert.deepEqual(readSavedOrbPosition(memory({ pos: '{"x":1800,"y":1000}' }), 'pos', vp, 112), { x: 1254, y: 656 });
assert.deepEqual(readSavedOrbPosition(memory({ pos: '{"x":-40,"y":-9}' }), 'pos', vp, 112), { x: 0, y: 0 });
assert.equal(readSavedOrbPosition(memory(), 'pos', vp, 112), null, 'nothing saved');
assert.equal(readSavedOrbPosition(memory({ pos: 'not json' }), 'pos', vp, 112), null);
assert.equal(readSavedOrbPosition(memory({ pos: '{"x":"490","y":290}' }), 'pos', vp, 112), null);
assert.equal(readSavedOrbPosition(memory({ pos: 'null' }), 'pos', vp, 112), null);
assert.equal(readSavedOrbPosition(broken, 'pos', vp, 112), null, 'an unreadable store yields nothing');
assert.equal(readSavedOrbPosition(memory({ pos: '{"x":490,"y":290}' }), null, vp, 112), null, 'no persistence key');

// ── dragging ────────────────────────────────────────────────────────────────
const corner = { x: 0, y: 656 };
assert.deepEqual(orbPointerMove(true, corner, { x: 3, y: 4 }, 5), { dragged: false, position: null }, 'inside the threshold is still a click');
assert.deepEqual(orbPointerMove(true, corner, { x: 200, y: -300 }, 5), { dragged: true, position: null }, 'a pinned orb never moves');
assert.deepEqual(orbPointerMove(false, corner, { x: 200, y: -300 }, 5), { dragged: true, position: { x: 200, y: 356 } });
assert.deepEqual(orbPointerMove(false, corner, { x: 3, y: 4 }, 5), { dragged: false, position: null });

// ── the release ─────────────────────────────────────────────────────────────
assert.deepEqual(orbPressResult(true, false), { toggle: true, unpin: true }, 'the first click opens and unpins');
assert.deepEqual(orbPressResult(true, true), { toggle: false, unpin: false }, 'a drag attempt on a pinned orb does nothing');
assert.deepEqual(orbPressResult(false, false), { toggle: true, unpin: false });
assert.deepEqual(orbPressResult(false, true), { toggle: false, unpin: false }, 'a drag is not a click');

// ── the sequence: load, drag attempt, click, drag, reload ───────────────────
{
  const s = memory();
  let pinned = readOrbPinned(s, key);
  const pos = orbCornerPosition('bottom-left', { width: 1366, height: 768 }, 112);
  let toggles = 0;
  const release = (dragged: boolean) => {
    const r = orbPressResult(pinned, dragged);
    if (r.toggle) toggles += 1;
    if (r.unpin) { pinned = false; persistOrbUnpinned(s, key); }
  };

  const attempt = orbPointerMove(pinned, pos, { x: 300, y: -200 }, 5);
  assert.equal(attempt.position, null, 'the pinned orb stays in its corner');
  release(attempt.dragged);
  assert.equal(toggles, 0);
  assert.equal(pinned, true);

  release(false);
  assert.equal(toggles, 1, 'the click opened the assistant');
  assert.equal(pinned, false);

  const dragged = orbPointerMove(pinned, pos, { x: 300, y: -200 }, 5).position;
  assert.deepEqual(dragged, { x: 300, y: 456 }, 'now it drags');
  s.setItem('thedaw-orb-pos-v4', JSON.stringify(dragged));
  assert.equal(readOrbPinned(s, key), false, 'and the reload starts unpinned');
  assert.deepEqual(
    readSavedOrbPosition(s, 'thedaw-orb-pos-v4', { width: 1366, height: 768 }, 112),
    { x: 300, y: 456 },
    'at the dragged spot',
  );
}

// ── the sequence with a store that throws ───────────────────────────────────
{
  let pinned = readOrbPinned(broken, key);
  assert.equal(pinned, true);
  if (orbPressResult(pinned, false).unpin) {
    pinned = false;
    assert.equal(persistOrbUnpinned(broken, key), false);
  }
  assert.equal(pinned, false, 'the click unpins this session');
  assert.equal(readOrbPinned(broken, key), true, 'the next load is pinned again');
}

console.log('orbPin tests passed');
