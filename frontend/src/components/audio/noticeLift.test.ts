/**
 * The status notice never covers the scrub strip.
 *
 * The notice panel is anchored to the bottom of the orb's bubble slot and grows
 * upward. The scrub strip — the playhead — is the footer row directly above it,
 * 16px tall, and a notice of three or four lines used to grow straight over it,
 * taking the only pointer seek off the screen for as long as it showed.
 *
 * The numbers here are the footer's real ones: h-16 (64px) tall, a 16px strip
 * across its top, and a 42px slot (h-10.5) centred in the 48px row below.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/components/audio/noticeLift.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { NOTICE_LIFT_GAP_PX, noticeLift, type Box } from './noticeLift.ts';

/** A 900px-tall window with the footer along its bottom. */
const VIEWPORT_H = 900;
const FOOTER_TOP = VIEWPORT_H - 64;
const STRIP: Box = { top: FOOTER_TOP, bottom: FOOTER_TOP + 16 };
/** The slot: 42px, centred in the 48px row under the strip, less its 2px pad. */
const SLOT: Box = { top: VIEWPORT_H - 48, bottom: VIEWPORT_H - 6 };
/** Room above the slot's bottom before a panel's top reaches the strip. */
const ROOM = SLOT.bottom - STRIP.bottom;

// The footer's own geometry, so a change to it fails here rather than on screen.
assert.equal(ROOM, 42, 'the slot is exactly as tall as the room above it');

// (a) A one- or two-line notice fits in the slot and stays in it.
{
  assert.equal(noticeLift(SLOT, 20, STRIP), 0, 'one line');
  assert.equal(noticeLift(SLOT, 42, STRIP), 0, 'two lines, exactly the room');
}

// (b) THE BUG. A three- or four-line notice used to grow over the strip. It now
// rises until its whole box is clear of the strip's top.
{
  for (const height of [43, 58, 74, 120]) {
    const lift = noticeLift(SLOT, height, STRIP);
    assert.ok(lift > 0, `a ${height}px notice lifts`);
    const bottom = SLOT.bottom - lift;
    assert.ok(bottom <= STRIP.top, `a ${height}px notice ends above the strip (${bottom} <= ${STRIP.top})`);
    assert.ok(bottom < STRIP.top + 1, 'and does not hover inside it');
  }
}

// (c) The lift is the same whatever the notice's height: the panel clears the
// strip by one gap, so a taller notice grows further up the page and its foot
// never moves. A notice that grew and shrank would jump.
{
  assert.equal(noticeLift(SLOT, 58, STRIP), noticeLift(SLOT, 400, STRIP));
  assert.equal(noticeLift(SLOT, 43, STRIP), SLOT.bottom - STRIP.top + NOTICE_LIFT_GAP_PX);
}

// (d) No strip on the page (below the breakpoint that shows this bubble, or
// before the footer mounts): nothing is in the way, so nothing moves.
{
  assert.equal(noticeLift(SLOT, 400, null), 0);
}

// (e) A panel that has not been measured yet does not move the bubble.
{
  assert.equal(noticeLift(SLOT, 0, STRIP), 0);
  assert.equal(noticeLift(SLOT, -1, STRIP), 0);
}

// (f) The window bottom as the slot, which is how OrbStatusFloat's footer
// placement sits: the same rule holds, with the footer's own 48px of room.
{
  const windowBottom: Box = { top: VIEWPORT_H, bottom: VIEWPORT_H };
  assert.equal(windowBottom.bottom - STRIP.bottom, 48, 'the footer row under the strip');
  assert.equal(noticeLift(windowBottom, 48, STRIP), 0, 'a notice inside the row stays');
  const lift = noticeLift(windowBottom, 80, STRIP);
  assert.ok(lift > 0);
  assert.ok(windowBottom.bottom - lift <= STRIP.top, 'a taller one clears the strip');
}

console.log('noticeLift: a notice too tall for the footer row rises clear of the scrub strip');
