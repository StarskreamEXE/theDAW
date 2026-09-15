/**
 * How far the footer's status notice rises so it never covers the scrub strip.
 *
 * The notice panel is anchored to the bottom of the orb's bubble slot and grows
 * upward. The slot sits in the footer's second row, and the scrub strip — the
 * playhead, and the only way to seek with the pointer — is the row directly
 * above it. A one- or two-line notice fits in the slot; a longer one grew up
 * over the strip and took the playhead off the screen for as long as it showed.
 *
 * So a panel that would cross the strip is lifted instead: its whole box moves
 * up past the strip's top edge, where it grows over the workspace and leaves
 * the footer alone. A panel that fits stays in the slot, which is the common
 * case and the one the bubble is shaped for.
 *
 * Pure: it takes three boxes and returns a number of px, so a test can place
 * them by hand.
 */

/** The gap kept between a lifted panel and the strip above it, in px. */
export const NOTICE_LIFT_GAP_PX = 6;

/** The parts of a DOMRect this needs. `bottom` and `top` are viewport px. */
export interface Box {
  top: number;
  bottom: number;
}

/**
 * The `bottom` offset for the notice panel, in px from the slot's bottom edge.
 *
 * 0 leaves the panel in the slot. Anything else lifts it until its bottom edge
 * clears the strip's top by NOTICE_LIFT_GAP_PX.
 *
 * `strip` is null when the strip is not on the page (below the breakpoint that
 * shows this bubble, or before the footer mounts), and then nothing is in the
 * way and the panel stays put.
 */
export function noticeLift(slot: Box, panelHeight: number, strip: Box | null): number {
  if (!strip || panelHeight <= 0) return 0;
  // Room above the slot's bottom before the panel's top edge reaches the strip.
  const room = slot.bottom - strip.bottom;
  if (panelHeight <= room) return 0;
  return Math.max(0, slot.bottom - strip.top + NOTICE_LIFT_GAP_PX);
}
