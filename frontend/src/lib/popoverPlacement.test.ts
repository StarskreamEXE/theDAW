/**
 * placePopover keeps a popover inside the window at its anchor, and again after
 * the popover grows. layoutPopover keeps it above the transport footer, and
 * watchPopover lays it out again when the popover or the window changes size.
 * The numbers are EDIT's track FX rack on a 1920x1080 screen: 360px wide,
 * opened by a click on a low lane's F button, over a 64px footer.
 */
import assert from 'node:assert/strict';
import {
  layoutPopover,
  placePopover,
  popoverMaxHeight,
  popoverRoom,
  watchPopover,
  POPOVER_EDGE_GAP_PX,
  POPOVER_MIN_ROOM_PX,
  type PopoverBox,
  type PopoverLayout,
} from './popoverPlacement.ts';

const SCREEN = { width: 1920, height: 1080 };
const FOOTER_H = 64;
const FOOTER_TOP = SCREEN.height - FOOTER_H;
const RACK_W = 360;
const gap = POPOVER_EDGE_GAP_PX;
const inside = (p: { x: number; y: number }, size: { width: number; height: number }, vp: PopoverBox = SCREEN) =>
  p.x >= gap && p.y >= gap && p.x + size.width <= vp.width - gap && p.y + size.height <= vp.height - gap;

// ── Room at the anchor: the popover opens exactly there ─────────────────────
{
  const at = placePopover({ x: 234, y: 300 }, { width: RACK_W, height: 118 }, SCREEN);
  assert.deepEqual(at, { x: 234, y: 300 }, 'a popover with room opens at its anchor');
}

// ── A low lane: the empty rack fits, then grows past the bottom as rows land ─
{
  const anchor = { x: 234, y: 733 };
  const empty = { width: RACK_W, height: 118 };
  assert.deepEqual(placePopover(anchor, empty, SCREEN), anchor, 'the empty rack opens at the click');

  // Every row adds 32px; the rack's CSS cap is 70vh (756px at 1080).
  let lastY = anchor.y;
  for (let rows = 1; rows <= 19; rows += 1) {
    const size = { width: RACK_W, height: Math.min(118 + rows * 32, 756) };
    const at = placePopover(anchor, size, SCREEN);
    assert.ok(inside(at, size), `the rack stays inside the window with ${rows} rows (y ${at.y}, h ${size.height})`);
    assert.ok(at.y <= lastY, 'a growing rack only moves up');
    if (anchor.y + size.height + gap > SCREEN.height) {
      assert.equal(at.y + size.height, SCREEN.height - gap, `with ${rows} rows the rack's bottom sits on the edge gap`);
    }
    lastY = at.y;
  }

  // Rows removed again: the rack comes back down to the click, never below it.
  const shrunk = placePopover(anchor, { width: RACK_W, height: 150 }, SCREEN);
  assert.deepEqual(shrunk, anchor, 'a rack that shrinks back returns to its anchor');
}

// ── The right edge: a click near it moves the popover left ──────────────────
{
  const size = { width: RACK_W, height: 200 };
  const at = placePopover({ x: 1800, y: 400 }, size, SCREEN);
  assert.equal(at.x, SCREEN.width - RACK_W - gap);
  assert.equal(at.y, 400);
  assert.ok(inside(at, size));
}

// ── The window shrinks with the popover open ─────────────────────────────────
{
  const anchor = { x: 234, y: 733 };
  const size = { width: RACK_W, height: 440 };
  const short = { width: 1920, height: 640 };
  const at = placePopover(anchor, size, short);
  assert.ok(inside(at, size, short), 'a shorter window moves the rack up to fit');
  assert.equal(at.y, 640 - 440 - gap);
}

// ── Larger than the window: pinned to the top-left gap ──────────────────────
{
  const at = placePopover({ x: 900, y: 900 }, { width: 2400, height: 1400 }, SCREEN);
  assert.deepEqual(at, { x: gap, y: gap }, 'a popover bigger than the window keeps its title and left edge on screen');
}

// ── Fractional measurements land on whole pixels ────────────────────────────
{
  const at = placePopover({ x: 100.4, y: 1000.6 }, { width: 359.5, height: 300.25 }, SCREEN);
  assert.equal(at.x, 100);
  assert.equal(at.y, Math.round(1080 - 300.25 - gap));
}

// ── The footer: a full rack on a low lane ends above the transport ──────────
{
  const anchor = { x: 234, y: 733 };
  const full = { width: RACK_W, height: 706 };
  const laid = layoutPopover(anchor, full, SCREEN, FOOTER_TOP);
  assert.equal(laid.y + full.height, FOOTER_TOP - gap, 'the rack bottom sits one gap above the footer');
  assert.equal(laid.maxHeight, FOOTER_TOP - gap * 2, 'the rack may grow to the footer less both gaps');
  assert.deepEqual(
    layoutPopover({ x: 234, y: 300 }, { width: RACK_W, height: 118 }, SCREEN, FOOTER_TOP),
    { x: 234, y: 300, maxHeight: FOOTER_TOP - gap * 2 },
    'a popover clear of the footer still opens at its anchor',
  );
  assert.deepEqual(popoverRoom(SCREEN, null), SCREEN, 'no footer: the whole window');
  assert.deepEqual(popoverRoom(SCREEN, 1200), SCREEN, 'a footer below the window changes nothing');
}

// ── A window too short to leave room above the footer uses all of it ────────
{
  const tiny = { width: 1920, height: 280 };
  const room = popoverRoom(tiny, tiny.height - FOOTER_H);
  assert.ok(tiny.height - FOOTER_H < POPOVER_MIN_ROOM_PX);
  assert.deepEqual(room, tiny, 'the popover takes the whole window');
  const laid = layoutPopover({ x: 234, y: 200 }, { width: RACK_W, height: 400 }, tiny, tiny.height - FOOTER_H);
  assert.equal(laid.y, gap);
  assert.equal(laid.maxHeight, tiny.height - gap * 2);
}

// ── The CSS max-height: measured room, or the window before a measurement ───
assert.equal(popoverMaxHeight(null), 'calc(100vh - 16px)');
assert.equal(popoverMaxHeight(null, '70vh'), 'min(70vh, calc(100vh - 16px))');
assert.equal(popoverMaxHeight(1000, '70vh'), 'min(70vh, 1000px)');
assert.equal(popoverMaxHeight(1000), '1000px');

// ── watchPopover: the sequence a live rack goes through ─────────────────────
{
  // A low lane's rack opens, grows as effects land, the window gets shorter,
  // and the rack closes. Each size change reports through the fake observers,
  // after the layout that caused it, the way ResizeObserver and window resize
  // report in the browser.
  let size: PopoverBox = { width: RACK_W, height: 118 };
  let viewport: PopoverBox = { ...SCREEN };
  const hooks: { resize?: () => void; window?: () => void } = {};
  const placed: { layout: PopoverLayout; initial: boolean }[] = [];
  const anchor = { x: 234, y: 733 };

  const stop = watchPopover(
    anchor,
    {
      measure: () => size,
      viewport: () => viewport,
      floor: () => viewport.height - FOOTER_H,
      observeResize: (cb) => {
        hooks.resize = cb;
        return () => { hooks.resize = undefined; };
      },
      onWindowResize: (cb) => {
        hooks.window = cb;
        return () => { hooks.window = undefined; };
      },
    },
    (layout, initial) => placed.push({ layout, initial }),
  );

  assert.equal(placed.length, 1, 'the popover is laid out once when it opens');
  assert.equal(placed[0].initial, true);
  assert.deepEqual({ x: placed[0].layout.x, y: placed[0].layout.y }, anchor, 'the empty rack opens at the click');

  // Effects land: the panel grows, and only the observer says so.
  size = { width: RACK_W, height: 706 };
  assert.ok(hooks.resize, 'the popover watches its own size');
  hooks.resize();
  assert.equal(placed.length, 2);
  assert.equal(placed[1].initial, false, 'a re-layout after a size change is not the opening one');
  assert.ok(placed[1].layout.y < anchor.y, 'the grown rack moved up');
  assert.equal(placed[1].layout.y + size.height, FOOTER_TOP - gap, 'and ends one gap above the footer');

  // The window gets shorter with the rack open; the rack is capped to the new
  // room, and its own resize to that cap follows.
  viewport = { width: 1920, height: 640 };
  assert.ok(hooks.window, 'the popover watches the window');
  hooks.window();
  const shortRoom = 640 - FOOTER_H;
  assert.equal(placed[2].layout.maxHeight, shortRoom - gap * 2, 'the max-height follows the shorter window');
  size = { width: RACK_W, height: placed[2].layout.maxHeight };
  hooks.resize();
  assert.equal(placed[3].layout.y, gap, 'the capped rack sits at the top gap');
  assert.ok(placed[3].layout.y + size.height <= shortRoom - gap, 'and still ends above the footer');

  stop();
  assert.equal(hooks.resize, undefined, 'closing stops watching the popover size');
  assert.equal(hooks.window, undefined, 'closing stops watching the window');
}

console.log('popoverPlacement test passed');
