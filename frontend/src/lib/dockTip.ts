/**
 * The MIDI dock tooltip's pure parts: where the card goes, what it keeps clear
 * of, and which part of its text adds to its trigger's accessible name.
 *
 * Every box is in the Shell root's own CSS px (viewport px divided by its
 * `data-layout-zoom`), the space a `position: fixed` card inside that root is
 * laid out in.
 */

export interface TipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TipBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `right` is the action rail's side; `above` is every other key's. */
export type DockTipPlacement = 'right' | 'above';
export type DockTipSide = 'right' | 'left' | 'above' | 'below';

/** Gap between a rail key and its card, beside it. */
export const DOCK_TIP_GAP = 6;
/** Gap between a row or strip key and its card, above or below it. A 26px key
 *  sits 5px inside its 36px row, so the card stays 5px clear of the row's edge. */
export const DOCK_TIP_GAP_Y = 10;
/** The nearest a card comes to the edge of its bounds. */
export const DOCK_TIP_PAD = 6;
/** Pointer hover waits this long before a card opens; keyboard focus opens it at once. */
export const DOCK_TIP_DELAY_MS = 350;

const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.max(lo, Math.min(hi, v)));

/**
 * The card's top-left corner and the side it ended up on.
 *
 * `right` opens beside the key, centred on it vertically, and moves to the left
 * side only when the right has no room and the left does. `above` opens over the
 * key, centred on it, and flips below when the space above is too short and the
 * space below is not. Either way the card is then clamped inside `bounds`.
 */
export function placeDockTip(
  anchor: TipBox,
  tip: { width: number; height: number },
  bounds: TipBounds,
  placement: DockTipPlacement,
  gap: number = placement === 'right' ? DOCK_TIP_GAP : DOCK_TIP_GAP_Y,
  pad = DOCK_TIP_PAD,
): { x: number; y: number; side: DockTipSide } {
  const minX = bounds.left + pad;
  const maxX = bounds.right - pad - tip.width;
  const minY = bounds.top + pad;
  const maxY = bounds.bottom - pad - tip.height;
  const anchorRight = anchor.left + anchor.width;
  const anchorBottom = anchor.top + anchor.height;

  if (placement === 'right') {
    let side: DockTipSide = 'right';
    let x = anchorRight + gap;
    if (x > maxX && anchor.left - gap - tip.width >= minX) {
      side = 'left';
      x = anchor.left - gap - tip.width;
    }
    const y = anchor.top + anchor.height / 2 - tip.height / 2;
    return { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY), side };
  }

  let side: DockTipSide = 'above';
  let y = anchor.top - gap - tip.height;
  if (y < minY && anchorBottom + gap <= maxY) {
    side = 'below';
    y = anchorBottom + gap;
  }
  const x = anchor.left + anchor.width / 2 - tip.width / 2;
  return { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY), side };
}

/**
 * A card at `pos` moved off `obstacle` (the floating assistant orb, which sits
 * above every dock layer and takes the pointer across its box).
 *
 * A card that overlaps the obstacle moves up until its bottom is `gap` above
 * the obstacle's top, when that still leaves it inside `bounds`; otherwise it
 * moves to the obstacle's right, when that fits; otherwise it stays.
 */
export function clearObstacle(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  obstacle: TipBounds | null,
  bounds: TipBounds,
  gap = DOCK_TIP_GAP,
  pad = DOCK_TIP_PAD,
): { x: number; y: number } {
  if (!obstacle || obstacle.right <= obstacle.left || obstacle.bottom <= obstacle.top) return pos;
  const overlaps =
    pos.x < obstacle.right && pos.x + size.width > obstacle.left && pos.y < obstacle.bottom && pos.y + size.height > obstacle.top;
  if (!overlaps) return pos;
  const up = obstacle.top - gap - size.height;
  if (up >= bounds.top + pad) return { x: pos.x, y: up };
  const right = obstacle.right + gap;
  if (right + size.width <= bounds.right - pad) return { x: right, y: pos.y };
  return pos;
}

/**
 * The height a card opened below its anchor may take before it reaches a floor:
 * the room from `cardTop` down to `gap` above the nearest floor edge under it
 * (the SHAPE row's top), in whole px. Null when no floor edge lies below the
 * card's top, or when the room left is under `min` (a card that short is no use,
 * so it keeps its own height).
 */
export function floorCap(cardTop: number, floorTops: number[], gap = 4, min = 0): number | null {
  const below = floorTops.filter((t) => t > cardTop);
  if (below.length === 0) return null;
  const room = Math.floor(Math.min(...below) - gap - cardTop);
  return room >= min && room > 0 ? room : null;
}

/**
 * The lowest a card's bottom edge may reach: `gap` above the top of the nearest
 * floor (the SHAPE row) that is not wholly above the anchor's top. A card opened
 * above a key inside the row, or beside a key over the row, then ends clear of
 * the row's top edge. Null when no floor qualifies.
 */
export function floorLimit(anchorTop: number, floors: TipBounds[], gap = 4): number | null {
  const under = floors.filter((f) => f.bottom > f.top && f.bottom > anchorTop);
  if (under.length === 0) return null;
  return Math.min(...under.map((f) => f.top)) - gap;
}

/**
 * The rows a capped flyout list shows whole (the MAP card's bindings).
 *
 * `room` is the height the list may take. When every row fits, `height` is null
 * and the list keeps its own height. Otherwise `cue` px are kept for the list's
 * scroll cue line, and `height` is the whole rows that fit the rest, never less
 * than the first row, so no row shows cut at the list's foot.
 */
export function listRowsFit(room: number, rowHeights: number[], gap: number, cue: number): { rows: number; height: number | null } {
  const n = rowHeights.length;
  if (n === 0) return { rows: 0, height: null };
  const total = rowHeights.reduce((s, h) => s + h, 0) + gap * (n - 1);
  if (total <= room + 0.5) return { rows: n, height: null };
  const avail = room - cue;
  let rows = 0;
  let height = 0;
  for (const h of rowHeights) {
    const next = height + (rows ? gap : 0) + h;
    if (next > avail + 0.5) break;
    height = next;
    rows += 1;
  }
  if (rows === 0) return { rows: 1, height: rowHeights[0] };
  return { rows, height };
}

/**
 * A card at `pos` moved left, clear of the side columns it would cover (the
 * Voice column, the artifact rail). Columns are tried from the right; a card
 * that overlaps one moves to `gap` left of it when that stays inside `bounds`,
 * and then checks the next column to the left. When a column cannot be cleared
 * the card keeps its original place.
 */
export function clearAsides(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  asides: TipBounds[],
  bounds: TipBounds,
  gap = 4,
  pad = DOCK_TIP_PAD,
): { x: number; y: number } {
  let x = pos.x;
  const top = pos.y;
  const bottom = pos.y + size.height;
  const sorted = asides.filter((a) => a.right > a.left && a.bottom > a.top).sort((a, b) => b.left - a.left);
  for (const a of sorted) {
    const overlaps = x < a.right && x + size.width > a.left && top < a.bottom && bottom > a.top;
    if (!overlaps) continue;
    const left = a.left - gap - size.width;
    if (left < bounds.left + pad) return pos;
    x = left;
  }
  return { x, y: pos.y };
}

/** The part of the viewport inside the host's box: the card's bounds. */
export function tipBounds(
  viewport: { width: number; height: number },
  host: TipBounds | null,
  zoom: number,
): TipBounds {
  const z = zoom > 0 ? zoom : 1;
  const left = Math.max(0, host?.left ?? 0);
  const top = Math.max(0, host?.top ?? 0);
  const right = Math.min(viewport.width, host?.right ?? viewport.width);
  const bottom = Math.min(viewport.height, host?.bottom ?? viewport.height);
  return { left: left / z, top: top / z, right: right / z, bottom: bottom / z };
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9/+#]+/g, ' ').trim();

/** True when `phrase` appears in `text` as whole words: "rec" is in "rec: stop", never in "record". */
const hasPhrase = (text: string, phrase: string): boolean => ` ${text} `.includes(` ${phrase} `);

/**
 * True when the card says more than the trigger's name. `name` is the
 * trigger's `aria-label`, or its visible word when it has none.
 */
export function tipAddsToName(name: string | undefined, word: string, description?: string): boolean {
  const own = normalize(name ?? '');
  const text = [word, description ?? ''].map(normalize).filter(Boolean);
  if (text.length === 0) return false;
  return text.some((part) => !hasPhrase(own, part));
}

/**
 * The id the trigger's `aria-describedby` points at: the whole card (`id`)
 * when its word is missing from the name, only the description
 * (`${id}-desc`) when the word is in the name and the description is not, and
 * nothing when the name already says it all. Words match whole.
 */
export function tipDescribedBy(name: string | undefined, word: string, description: string | undefined, id: string): string | undefined {
  const own = normalize(name ?? '');
  const w = normalize(word);
  if (w && !hasPhrase(own, w)) return id;
  const d = normalize(description ?? '');
  return d && !hasPhrase(own, d) ? `${id}-desc` : undefined;
}

/**
 * One open card at a time. A card that opens claims the latch with its own
 * close function, which closes the card that held it; a card that closes
 * releases it only while it still holds it.
 */
export interface TipLatch {
  claim: (close: () => void) => void;
  release: (close: () => void) => void;
}

export function createTipLatch(): TipLatch {
  let holder: (() => void) | null = null;
  return {
    claim(close) {
      if (holder && holder !== close) {
        const previous = holder;
        holder = null;
        previous();
      }
      holder = close;
    },
    release(close) {
      if (holder === close) holder = null;
    },
  };
}

/** Space-separated ids, empty parts dropped; undefined when nothing is left. */
export function joinIds(...ids: Array<string | undefined | false>): string | undefined {
  const out = ids.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).join(' ');
  return out || undefined;
}
