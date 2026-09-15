import assert from 'node:assert/strict';
import {
  DOCK_TIP_GAP,
  DOCK_TIP_GAP_Y,
  DOCK_TIP_PAD,
  clearAsides,
  clearObstacle,
  createTipLatch,
  floorCap,
  floorLimit,
  joinIds,
  listRowsFit,
  placeDockTip,
  tipAddsToName,
  tipBounds,
  tipDescribedBy,
} from './dockTip.ts';

const VIEW = { left: 0, top: 0, right: 1000, bottom: 600 };
const VIEW_TALL = { left: 0, top: 0, right: 1600, bottom: 900 };
const TIP = { width: 120, height: 40 };

// A rail key opens its card to the right, centred on the key.
{
  const key = { left: 4, top: 200, width: 31, height: 28 };
  const p = placeDockTip(key, TIP, VIEW, 'right');
  assert.equal(p.side, 'right');
  assert.equal(p.x, 4 + 31 + DOCK_TIP_GAP);
  assert.equal(p.y, 200 + 14 - 20);
}

// A rail key at the very top: the card slides down inside the bounds.
{
  const key = { left: 4, top: 0, width: 31, height: 28 };
  const p = placeDockTip(key, TIP, VIEW, 'right');
  assert.equal(p.y, DOCK_TIP_PAD);
}

// A right-placed card with no room on the right moves to the left side.
{
  const key = { left: 950, top: 300, width: 30, height: 28 };
  const p = placeDockTip(key, TIP, VIEW, 'right');
  assert.equal(p.side, 'left');
  assert.equal(p.x, 950 - DOCK_TIP_GAP - 120);
}

// Neither side has room: the card stays right-side and is clamped inside.
{
  const narrow = { left: 0, top: 0, right: 150, bottom: 600 };
  const key = { left: 60, top: 300, width: 30, height: 28 };
  const p = placeDockTip(key, TIP, narrow, 'right');
  assert.equal(p.side, 'right');
  assert.equal(p.x, 150 - DOCK_TIP_PAD - 120);
}

// A strip key opens above, centred on the key.
{
  const key = { left: 500, top: 560, width: 26, height: 26 };
  const p = placeDockTip(key, TIP, VIEW, 'above');
  assert.equal(p.side, 'above');
  assert.equal(p.y, 560 - DOCK_TIP_GAP_Y - 40);
  assert.equal(p.x, 513 - 60);
}

// No room above: it flips below.
{
  const key = { left: 500, top: 10, width: 26, height: 26 };
  const p = placeDockTip(key, TIP, VIEW, 'above');
  assert.equal(p.side, 'below');
  assert.equal(p.y, 36 + DOCK_TIP_GAP_Y);
}

// A SHAPE row key 5px inside its 36px row: the card ends 5px above the row's top edge.
{
  const rowTop = 650;
  const key = { left: 500, top: rowTop + 5, width: 26, height: 26 };
  const p = placeDockTip(key, TIP, VIEW_TALL, 'above');
  assert.equal(rowTop - (p.y + TIP.height), 5);
}

// No room above or below: it stays above, clamped to the top pad.
{
  const short = { left: 0, top: 0, right: 1000, bottom: 60 };
  const key = { left: 500, top: 10, width: 26, height: 26 };
  const p = placeDockTip(key, TIP, short, 'above');
  assert.equal(p.side, 'above');
  assert.equal(p.y, DOCK_TIP_PAD);
}

// A key at the right edge: the card is pulled left to stay inside.
{
  const key = { left: 985, top: 560, width: 15, height: 26 };
  const p = placeDockTip(key, TIP, VIEW, 'above');
  assert.equal(p.x, 1000 - DOCK_TIP_PAD - 120);
  assert.ok(p.x + TIP.width <= VIEW.right - DOCK_TIP_PAD);
}

// A key at the left edge: the card is pushed right.
{
  const key = { left: 0, top: 560, width: 26, height: 26 };
  const p = placeDockTip(key, TIP, VIEW, 'above');
  assert.equal(p.x, DOCK_TIP_PAD);
}

// A card wider than the bounds starts at the left pad.
{
  const key = { left: 50, top: 300, width: 26, height: 26 };
  const p = placeDockTip(key, { width: 400, height: 40 }, { left: 0, top: 0, right: 200, bottom: 600 }, 'above');
  assert.equal(p.x, DOCK_TIP_PAD);
}

// Bounds: the viewport cut to the host, in the host's zoomed px.
{
  assert.deepEqual(tipBounds({ width: 1366, height: 768 }, null, 1), { left: 0, top: 0, right: 1366, bottom: 768 });
  assert.deepEqual(tipBounds({ width: 1366, height: 768 }, { left: 0, top: 0, right: 1366, bottom: 704 }, 0.85), {
    left: 0,
    top: 0,
    right: 1366 / 0.85,
    bottom: 704 / 0.85,
  });
  // A host larger than the viewport is cut to it.
  assert.deepEqual(tipBounds({ width: 800, height: 600 }, { left: -10, top: -10, right: 900, bottom: 700 }, 2), {
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
  });
  // A zoom of 0 or less reads as 1.
  assert.equal(tipBounds({ width: 800, height: 600 }, null, 0).right, 800);
}

// describedby: only when the card says more than the name.
{
  assert.equal(tipAddsToName('Import MIDI', 'Import'), false);
  assert.equal(tipAddsToName('Clear every note', 'Clear'), false);
  assert.equal(tipAddsToName('Import MIDI', 'Import', 'Import a MIDI file from disk'), true);
  assert.equal(tipAddsToName('Rec: record vocal to notes', 'Rec'), false);
  assert.equal(tipAddsToName(undefined, 'Apply'), true);
  assert.equal(tipAddsToName('Apply', 'Apply'), false);
  assert.equal(tipAddsToName('Zoom out', 'Zoom out'), false);
  assert.equal(tipAddsToName('Unit: quarter-note beat', '/4'), true);
  assert.equal(tipAddsToName('Play', 'Play'), false);
  assert.equal(tipAddsToName('', ''), false);
}

// describedby target: the whole card, only its description, or nothing.
{
  // The name holds the word; only the description adds.
  assert.equal(tipDescribedBy('Import MIDI', 'Import', 'Import a MIDI file from disk', 't'), 't-desc');
  assert.equal(tipDescribedBy('Capture the roll as the morph source', 'Capture', 'Snapshot the current piano roll', 't'), 't-desc');
  // The name misses the word: the whole card.
  assert.equal(tipDescribedBy('Quarter-note beat', '/4', 'Unit: quarter-note beats', 't'), 't');
  assert.equal(tipDescribedBy(undefined, 'Apply', undefined, 't'), 't');
  // Nothing to add.
  assert.equal(tipDescribedBy('Clear every note', 'Clear', undefined, 't'), undefined);
  assert.equal(tipDescribedBy('Zoom out', 'Zoom out', 'zoom out', 't'), undefined);
  assert.equal(tipDescribedBy('/4: Quarter-note beat', '/4', 'Quarter-note beat', 't'), undefined);
  assert.equal(tipDescribedBy('Add lane', 'Add lane', 'Add a lane that loops one bar of 7/8', 't'), 't-desc');
}

// Words match whole: a word inside a longer word is not in the name.
{
  assert.equal(tipAddsToName('Record', 'Rec'), true);
  assert.equal(tipDescribedBy('Record', 'Rec', undefined, 't'), 't');
  assert.equal(tipDescribedBy('Remap the keys', 'Map', undefined, 't'), 't');
  assert.equal(tipDescribedBy('Address book', 'Add', undefined, 't'), 't');
  // The same word at either end, or beside punctuation, still counts.
  assert.equal(tipDescribedBy('Rec: stop recording', 'Rec', undefined, 't'), undefined);
  assert.equal(tipDescribedBy('Record', 'Record', undefined, 't'), undefined);
  assert.equal(tipDescribedBy('Gen: write notes into the active lane', 'Gen', 'write notes into the active lane', 't'), undefined);
}

// One open card: opening a second closes the first; a stale release changes nothing.
{
  const latch = createTipLatch();
  const closed: string[] = [];
  const closeA = () => closed.push('A');
  const closeB = () => closed.push('B');
  // A keyboard-focused card opens.
  latch.claim(closeA);
  assert.deepEqual(closed, []);
  // The pointer rests on another key: its card opens and the first closes.
  latch.claim(closeB);
  assert.deepEqual(closed, ['A']);
  // The first card's own close then releases; B still holds the latch.
  latch.release(closeA);
  latch.claim(closeA);
  assert.deepEqual(closed, ['A', 'B']);
  // The same card claiming twice does not close itself.
  latch.claim(closeA);
  assert.deepEqual(closed, ['A', 'B']);
  latch.release(closeA);
  latch.claim(closeB);
  assert.deepEqual(closed, ['A', 'B']);
}

// The orb: a card over it moves up, else to its right, else stays.
{
  const orb = { left: 30, top: 770, right: 162, bottom: 900 };
  const bounds = { left: 0, top: 0, right: 1600, bottom: 900 };
  // The IMPORT card, clamped to the bottom, runs into the orb: it moves up clear of it.
  const card = { width: 288, height: 418 };
  const moved = clearObstacle({ x: 42, y: 476 }, card, orb, bounds);
  assert.equal(moved.x, 42);
  assert.equal(moved.y, 770 - DOCK_TIP_GAP - 418);
  // No overlap: unchanged.
  assert.deepEqual(clearObstacle({ x: 200, y: 476 }, card, orb, bounds), { x: 200, y: 476 });
  assert.deepEqual(clearObstacle({ x: 42, y: 100 }, { width: 288, height: 60 }, orb, bounds), { x: 42, y: 100 });
  // No orb: unchanged.
  assert.deepEqual(clearObstacle({ x: 42, y: 476 }, card, null, bounds), { x: 42, y: 476 });
  // Too tall to fit above: it moves to the orb's right.
  const tall = { width: 200, height: 880 };
  assert.deepEqual(clearObstacle({ x: 42, y: 10 }, tall, orb, bounds), { x: 162 + DOCK_TIP_GAP, y: 10 });
  // Neither fits: it stays.
  assert.deepEqual(clearObstacle({ x: 42, y: 10 }, { width: 1500, height: 880 }, orb, bounds), { x: 42, y: 10 });
  // An orb with no box (hidden) is ignored.
  assert.deepEqual(clearObstacle({ x: 42, y: 476 }, card, { left: 0, top: 0, right: 0, bottom: 0 }, bounds), { x: 42, y: 476 });
}

// A card opened below its key stops above the SHAPE row: the MAP card at 1366x768, in CSS px.
{
  const cardTop = 537;
  const rowTop = 764;
  assert.equal(floorCap(cardTop, [rowTop], 4), 223);
  // A floor edge above the card's top is not under it.
  assert.equal(floorCap(cardTop, [500], 4), null);
  // The nearest floor under the card wins.
  assert.equal(floorCap(cardTop, [900, rowTop], 4), 223);
  // No floor, or too little room for a usable card: the card keeps its own height.
  assert.equal(floorCap(cardTop, [], 4), null);
  assert.equal(floorCap(cardTop, [rowTop], 4, 240), null);
  assert.equal(floorCap(cardTop, [cardTop + 3], 4), null);
}

// Every dock card ends 4px above the SHAPE row, in CSS px at 1920x1080 (row 860-896).
{
  const row = { left: 0, top: 860, right: 1745, bottom: 896 };
  // FORM and GEN open above a key 5px inside the row: their bottom rises above the row's top edge.
  assert.equal(floorLimit(865, [row], 4), 856);
  // IMPORT and AI open beside a rail key above the row: the same edge.
  assert.equal(floorLimit(420, [row], 4), 856);
  // A floor wholly above the anchor is not under it.
  assert.equal(floorLimit(900, [row], 4), null);
  // The nearest floor wins; a floor with no box is ignored; no floor gives no limit.
  assert.equal(floorLimit(420, [{ left: 0, top: 1000, right: 10, bottom: 1030 }, row], 4), 856);
  assert.equal(floorLimit(420, [{ left: 0, top: 0, right: 0, bottom: 0 }], 4), null);
  assert.equal(floorLimit(420, [], 4), null);
}

// The MAP card's binding list shows whole rows only.
{
  // Two 42px rows and a 4px gap in 105px: both fit, the list keeps its own height.
  assert.deepEqual(listRowsFit(105, [42, 42], 4, 14), { rows: 2, height: null });
  assert.deepEqual(listRowsFit(88, [42, 42], 4, 14), { rows: 2, height: null });
  // 83px (a controller line pushed the card taller): one whole row and the cue line.
  assert.deepEqual(listRowsFit(83, [42, 42], 4, 14), { rows: 1, height: 42 });
  // Five rows in 150px: 136px for rows after the cue, three whole rows.
  assert.deepEqual(listRowsFit(150, [42, 42, 42, 42, 42], 4, 14), { rows: 3, height: 134 });
  // Less room than one row: the first row still shows, whole.
  assert.deepEqual(listRowsFit(30, [42, 42], 4, 14), { rows: 1, height: 42 });
  // Rows of different heights add up in order.
  assert.deepEqual(listRowsFit(100, [30, 50, 30], 4, 10), { rows: 2, height: 84 });
  // No rows: nothing to cap.
  assert.deepEqual(listRowsFit(100, [], 4, 14), { rows: 0, height: null });
}

// The MAP card moves left of the Voice column, then of the artifact rail beside it.
{
  const bounds = { left: 0, top: 0, right: 1607, bottom: 903 };
  const size = { width: 288, height: 223 };
  const voice = { left: 1316, top: 537, right: 1604, bottom: 764 };
  const artifacts = { left: 1060, top: 537, right: 1316, bottom: 764 };
  // Anchored at MAP's right end, the card sits over the Voice column.
  assert.deepEqual(clearAsides({ x: 1312, y: 541 }, size, [voice], bounds), { x: 1316 - 4 - 288, y: 541 });
  // With the artifact rail shown as well, it clears both, right to left, in either order given.
  assert.deepEqual(clearAsides({ x: 1312, y: 541 }, size, [artifacts, voice], bounds), { x: 1060 - 4 - 288, y: 541 });
  // A card already clear, or a column beside it that it does not reach vertically, stays.
  assert.deepEqual(clearAsides({ x: 700, y: 541 }, size, [voice], bounds), { x: 700, y: 541 });
  assert.deepEqual(clearAsides({ x: 1312, y: 100 }, { width: 288, height: 200 }, [voice], bounds), { x: 1312, y: 100 });
  // A column the card cannot clear inside the bounds: the card keeps its place.
  const wide = { left: 200, top: 537, right: 1604, bottom: 764 };
  assert.deepEqual(clearAsides({ x: 1312, y: 541 }, size, [wide], bounds), { x: 1312, y: 541 });
  // A column with no box (hidden) is ignored.
  assert.deepEqual(clearAsides({ x: 1312, y: 541 }, size, [{ left: 0, top: 0, right: 0, bottom: 0 }], bounds), { x: 1312, y: 541 });
}

// ids join with spaces and drop empties.
{
  assert.equal(joinIds('a', undefined, 'b'), 'a b');
  assert.equal(joinIds(undefined, false, ''), undefined);
  assert.equal(joinIds('mf-beats-value'), 'mf-beats-value');
}

console.log('dockTip: all assertions passed');
