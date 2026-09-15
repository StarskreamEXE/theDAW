/**
 * Where a floating popover sits so the whole of it stays inside the window and
 * above the transport footer.
 *
 * A popover opens at an anchor point (usually the click that opened it) and
 * grows down and to the right from there. When its measured size would carry
 * an edge past its room, it moves back by the overflow and keeps an edge gap,
 * so a panel opened from a low lane grows upward from the bottom of its room as
 * rows are added. The room is the window less a bar fixed along the window's
 * bottom edge (the transport footer), so an open popover leaves the transport
 * visible and clickable; a window too short to leave POPOVER_MIN_ROOM_PX above
 * that bar gives the popover the whole window. A popover larger than its room
 * pins to the top or left gap, and its max-height (the room less both gaps)
 * turns that case into a scroll inside the panel.
 *
 * layoutPopover is pure. watchPopover runs it when the popover opens and again
 * whenever the panel or the window changes size, through an environment a test
 * can fake; browserPopoverEnv is that environment for a live panel.
 */

/** Gap kept between a popover and every edge of its room, in px. */
export const POPOVER_EDGE_GAP_PX = 8;

/** The least height above the footer a popover is confined to, in px. */
export const POPOVER_MIN_ROOM_PX = 240;

export interface PopoverPoint {
  x: number;
  y: number;
}

export interface PopoverBox {
  width: number;
  height: number;
}

export interface PopoverLayout extends PopoverPoint {
  /** The tallest the popover may be, in px: its room less both edge gaps. */
  maxHeight: number;
}

export function placePopover(
  anchor: PopoverPoint,
  size: PopoverBox,
  viewport: PopoverBox,
  gap: number = POPOVER_EDGE_GAP_PX,
): PopoverPoint {
  const fit = (start: number, extent: number, room: number) =>
    Math.max(gap, Math.min(start, room - extent - gap));
  return {
    x: Math.round(fit(anchor.x, size.width, viewport.width)),
    y: Math.round(fit(anchor.y, size.height, viewport.height)),
  };
}

/** The part of the window a popover may use: everything above `floor` (the
 *  top edge of a bar fixed to the window's bottom, in viewport px), or the
 *  whole window when there is no such bar or it leaves too little room. */
export function popoverRoom(viewport: PopoverBox, floor: number | null): PopoverBox {
  const bottom = floor == null ? viewport.height : Math.min(viewport.height, floor);
  return { width: viewport.width, height: bottom >= POPOVER_MIN_ROOM_PX ? bottom : viewport.height };
}

export function layoutPopover(
  anchor: PopoverPoint,
  size: PopoverBox,
  viewport: PopoverBox,
  floor: number | null,
  gap: number = POPOVER_EDGE_GAP_PX,
): PopoverLayout {
  const room = popoverRoom(viewport, floor);
  return {
    ...placePopover(anchor, size, room, gap),
    maxHeight: Math.max(0, Math.floor(room.height - gap * 2)),
  };
}

export const sameLayout = (a: PopoverLayout, b: PopoverLayout): boolean =>
  a.x === b.x && a.y === b.y && a.maxHeight === b.maxHeight;

/** The CSS max-height for a popover: its measured room (`maxPx`), or the window
 *  less both edge gaps before the first measurement, capped by the panel's own
 *  design height when it has one (a CSS length such as `70vh`). */
export function popoverMaxHeight(
  maxPx: number | null,
  cap?: string,
  gap: number = POPOVER_EDGE_GAP_PX,
): string {
  const room = maxPx == null ? `calc(100vh - ${gap * 2}px)` : `${maxPx}px`;
  return cap ? `min(${cap}, ${room})` : room;
}

/** What watchPopover reads from the page. */
export interface PopoverEnv {
  /** The popover's current rendered size. */
  measure: () => PopoverBox;
  viewport: () => PopoverBox;
  /** The top edge of a bar fixed along the window's bottom, or null. */
  floor: () => number | null;
  /** Call `onResize` whenever the popover's own size changes; returns a stop. */
  observeResize?: (onResize: () => void) => () => void;
  /** Call `onResize` whenever the window changes size; returns a stop. */
  onWindowResize: (onResize: () => void) => () => void;
}

/**
 * Lay the popover out now (`initial` true) and again on every change of its own
 * size or the window's (`initial` false). Returns the function that stops it.
 */
export function watchPopover(
  anchor: PopoverPoint,
  env: PopoverEnv,
  apply: (layout: PopoverLayout, initial: boolean) => void,
  gap: number = POPOVER_EDGE_GAP_PX,
): () => void {
  const place = (initial: boolean) =>
    apply(layoutPopover(anchor, env.measure(), env.viewport(), env.floor(), gap), initial);
  place(true);
  const later = () => place(false);
  const stopObserving = env.observeResize?.(later);
  const stopListening = env.onWindowResize(later);
  return () => {
    stopObserving?.();
    stopListening();
  };
}

/** The top edge of the `<footer>` fixed along the window's bottom (the
 *  transport), in viewport px; null when none is showing. */
export function fixedFooterTop(): number | null {
  let top: number | null = null;
  for (const bar of Array.from(document.querySelectorAll('footer'))) {
    if (getComputedStyle(bar).position !== 'fixed') continue;
    const r = bar.getBoundingClientRect();
    if (r.height > 0 && r.bottom >= window.innerHeight - 1) top = top == null ? r.top : Math.min(top, r.top);
  }
  return top;
}

export function browserPopoverEnv(el: Element): PopoverEnv {
  return {
    measure: () => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    },
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    floor: fixedFooterTop,
    observeResize:
      typeof ResizeObserver === 'undefined'
        ? undefined
        : (onResize) => {
            const observer = new ResizeObserver(onResize);
            observer.observe(el);
            return () => observer.disconnect();
          },
    onWindowResize: (onResize) => {
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    },
  };
}
