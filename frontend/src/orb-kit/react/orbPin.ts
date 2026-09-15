/**
 * The orb's corner pin, as plain functions GantasmoOrb runs.
 *
 * A host that passes `stickCorner` gets an orb pinned to that viewport corner
 * until the user clicks it for the first time. While pinned the orb cannot be
 * dragged, a saved drag position is ignored, and the corner is re-solved from
 * the live viewport on every resize. The first click (a press released without
 * travelling past the drag threshold, or Enter / Space) does what a click always
 * does and unpins the orb for good. The unpin is written under
 * `orbPinKey(persistenceKey)`; when storage cannot be read the orb starts
 * pinned, and when it cannot be written the click still unpins it for the rest
 * of the session.
 *
 * Kept apart from the component so the rules run under plain node
 * (orbPin.test.ts).
 */

export type OrbCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface OrbPoint {
  x: number;
  y: number;
}

/** The part of Storage the pin reads and writes. */
export interface OrbPinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Top-left of a pinned orb's box: `margin` px in from both edges of its corner,
 * clamped so the whole box stays on screen. A margin of 0 is flush to the corner.
 */
export function orbCornerPosition(
  corner: OrbCorner,
  viewport: { width: number; height: number },
  bounds: number,
  margin = 0,
): OrbPoint {
  const maxX = Math.max(0, viewport.width - bounds);
  const maxY = Math.max(0, viewport.height - bounds);
  const clampX = (x: number) => Math.max(0, Math.min(maxX, x));
  const clampY = (y: number) => Math.max(0, Math.min(maxY, y));
  const left = clampX(margin);
  const right = clampX(viewport.width - bounds - margin);
  const top = clampY(margin);
  const bottom = clampY(viewport.height - bounds - margin);
  switch (corner) {
    case 'bottom-left': return { x: left, y: bottom };
    case 'bottom-right': return { x: right, y: bottom };
    case 'top-left': return { x: left, y: top };
    case 'top-right': return { x: right, y: top };
  }
}

/** Where the first click is remembered, or null when the host persists nothing. */
export function orbPinKey(persistenceKey: string | false): string | null {
  return persistenceKey ? `${persistenceKey}-clicked` : null;
}

/** window.localStorage, or null where reaching it throws or there is no window. */
export function browserStorage(): OrbPinStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the orb starts pinned: yes, unless the first click was remembered. */
export function readOrbPinned(storage: OrbPinStorage | null, key: string | null): boolean {
  if (!storage || !key) return true;
  try {
    return storage.getItem(key) !== '1';
  } catch {
    return true;
  }
}

/** Remember the first click. Returns false when the write did not land. */
export function persistOrbUnpinned(storage: OrbPinStorage | null, key: string | null): boolean {
  if (!storage || !key) return false;
  try {
    storage.setItem(key, '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * The position a free orb saved, clamped so the whole box fits this viewport,
 * or null when nothing usable is stored or the store cannot be read. The orb
 * reads it when its position state is created, never in an effect, where the
 * read raced the effect that writes the position back and a reload landed on
 * the default spot.
 */
export function readSavedOrbPosition(
  storage: OrbPinStorage | null,
  key: string | null,
  viewport: { width: number; height: number },
  bounds: number,
): OrbPoint | null {
  if (!storage || !key) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { x, y } = parsed as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(Math.max(0, viewport.width - bounds), x)),
    y: Math.max(0, Math.min(Math.max(0, viewport.height - bounds), y)),
  };
}

/**
 * One pointer move during a press. `dragged` is true once the pointer has
 * travelled past the threshold, which means the release is no longer a click.
 * `position` is where a free orb goes (unclamped); a pinned orb gets null and
 * stays where it is.
 */
export function orbPointerMove(
  pinned: boolean,
  start: OrbPoint,
  delta: OrbPoint,
  threshold: number,
): { dragged: boolean; position: OrbPoint | null } {
  if (Math.hypot(delta.x, delta.y) <= threshold) return { dragged: false, position: null };
  return { dragged: true, position: pinned ? null : { x: start.x + delta.x, y: start.y + delta.y } };
}

/**
 * What releasing a press does. A press that never dragged is a click: it
 * toggles, and on a pinned orb it also unpins.
 */
export function orbPressResult(pinned: boolean, dragged: boolean): { toggle: boolean; unpin: boolean } {
  const click = !dragged;
  return { toggle: click, unpin: click && pinned };
}
