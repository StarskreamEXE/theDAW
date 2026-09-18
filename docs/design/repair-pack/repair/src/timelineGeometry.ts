/** Original, dependency-free helpers. All distances are local CSS pixels.
 * Adapt the existing timeline coordinate functions; do not create a second clock.
 */
export interface Viewport {
  zoom: number;
  scrollLeft: number;
  width: number;
  duration: number;
}
export const finite = (n: number, name: string): number => {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`);
  return n;
};
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function timeAtClientX(clientX: number, left: number, scale: number, view: Viewport): number {
  [clientX, left, scale, view.zoom, view.scrollLeft].forEach((v) => finite(v, 'coordinate'));
  if (scale <= 0 || view.zoom <= 0) throw new RangeError('scale and zoom must be positive');
  return Math.max(0, ((clientX - left) / scale + view.scrollLeft) / view.zoom);
}

export function zoomAtMarker(view: Viewport, requestedZoom: number, markerSec: number,
  bounds = { min: 0.25, max: 400 }): Viewport {
  [view.width, view.duration, requestedZoom, markerSec, bounds.min, bounds.max]
    .forEach((v) => finite(v, 'zoom input'));
  if (view.width <= 0 || view.duration < 0 || bounds.min <= 0 || bounds.max < bounds.min)
    throw new RangeError('Invalid viewport or zoom bounds');
  const zoom = clamp(requestedZoom, bounds.min, bounds.max);
  const contentWidth = Math.max(view.width, view.duration * zoom);
  return { ...view, zoom, scrollLeft: clamp(markerSec * zoom - view.width / 2, 0, contentWidth - view.width) };
}

export type WheelAction = 'zoom-time' | 'resize-lanes' | 'pan-time' | 'pan-lanes';
export interface WheelMap { plain: WheelAction; ctrl: WheelAction; shift: WheelAction; alt: WheelAction }
/** Literal horizontal-wheel request: Ctrl also zooms time, with a finer step.
 * The UI can remap Ctrl to lane height, but must label that as VERTICAL sizing.
 */
export const requestedWheelMap: WheelMap = {
  plain: 'zoom-time', ctrl: 'zoom-time', shift: 'pan-time', alt: 'resize-lanes',
};
export function wheelIntent(event: { deltaY: number; deltaMode: number; ctrlKey: boolean;
  metaKey: boolean; shiftKey: boolean; altKey: boolean }, map: WheelMap, pageHeight: number):
  { action: WheelAction; pixels: number; zoomFactor: number } {
  const pixels = finite(event.deltaY, 'wheel delta') * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1);
  const modified = event.ctrlKey || event.metaKey;
  const action = event.altKey ? map.alt : modified ? map.ctrl : event.shiftKey ? map.shift : map.plain;
  return { action, pixels, zoomFactor: Math.exp(-clamp(pixels, -400, 400) * (modified ? 0.001 : 0.002)) };
}

export interface Row { id: string; top: number; height: number }
export function layoutRows(items: readonly { id: string; height: number }[]): Row[] {
  let top = 0;
  return items.map((row) => {
    if (!Number.isFinite(row.height) || row.height <= 0) throw new RangeError('Row height must be positive');
    const result = { ...row, top }; top += row.height; return result;
  });
}
export function rowAtY(rows: readonly Row[], y: number): Row | undefined {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].top + rows[mid].height <= y) lo = mid + 1; else hi = mid; }
  const row = rows[lo]; return row && y >= row.top ? row : undefined;
}
/** Header bounds within the visible portion of a clip. Never changes audio geometry. */
export function visibleClipHeader(clipLeft: number, clipWidth: number, scrollLeft: number,
  viewportWidth: number, padding = 4): { leftInClip: number; width: number } | null {
  [clipLeft, clipWidth, scrollLeft, viewportWidth, padding].forEach((v) => finite(v, 'header input'));
  const left = Math.max(clipLeft, scrollLeft), right = Math.min(clipLeft + clipWidth, scrollLeft + viewportWidth);
  if (right <= left) return null;
  const inset = Math.min(Math.max(0, padding), (right - left) / 2);
  return { leftInClip: left - clipLeft + inset, width: Math.max(0, right - left - inset * 2) };
}
