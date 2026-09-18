/** Original dependency-free helpers. Adapt through the existing editorStore.
 * UI seconds match the current theDAW model; rendering should use integer frames.
 */
export type Range = Readonly<{ startSec: number; endSec: number }>;
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type SelectionMode = 'replace' | 'add' | 'toggle' | 'subtract';

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}
export function clamp(value: number, min: number, max: number): number {
  finite(value, 'value'); finite(min, 'min'); finite(max, 'max');
  if (max < min) throw new RangeError('invalid bounds');
  return Math.min(max, Math.max(min, value));
}
export function normalizedRange(a: number, b: number): Range {
  finite(a, 'start'); finite(b, 'end');
  return { startSec: Math.min(a, b), endSec: Math.max(a, b) };
}
export function overlaps(a: Range, b: Range): boolean {
  return a.endSec > a.startSec && b.endSec > b.startSec
    && a.startSec < b.endSec && b.startSec < a.endSec;
}
export function pointInRange(t: number, range: Range): boolean {
  return t >= range.startSec && t < range.endSec;
}
export function rectFromPoints(a: {x: number; y: number}, b: {x: number; y: number}): Rect {
  [a.x, a.y, b.x, b.y].forEach(v => finite(v, 'coordinate'));
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}
/** Always combine hits with the selection captured at pointerdown.
 * Combining with the previous pointermove result would repeatedly toggle items.
 */
export function combineSelection(
  baseline: readonly string[], hits: readonly string[], mode: SelectionMode,
): string[] {
  const result = new Set(mode === 'replace' ? [] : baseline);
  for (const id of new Set(hits)) {
    if (mode === 'subtract') result.delete(id);
    else if (mode === 'toggle' && result.has(id)) result.delete(id);
    else result.add(id);
  }
  return [...result];
}
export function marqueeIds(
  items: readonly {id: string; rect: Rect}[], marquee: Rect,
): string[] {
  return items.filter(item => rectIntersects(item.rect, marquee)).map(item => item.id);
}

export interface SelectionState {
  selectedClipIds: readonly string[];
  primaryClipId: string | null;
  timeSelection: Range | null;
}
export type SelectionAction =
  | { type: 'focus-changed' }
  | { type: 'clear'; target: 'clips' | 'time' | 'all' }
  | { type: 'clips'; ids: readonly string[]; primaryId?: string | null }
  | { type: 'time'; a: number; b: number };
export function reduceSelection(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'focus-changed': return state;
    case 'clips': {
      const ids = [...new Set(action.ids)];
      const primary = action.primaryId && ids.includes(action.primaryId)
        ? action.primaryId : ids[0] ?? null;
      return { ...state, selectedClipIds: ids, primaryClipId: primary };
    }
    case 'time': return { ...state, timeSelection: normalizedRange(action.a, action.b) };
    case 'clear': return {
      selectedClipIds: action.target === 'time' ? state.selectedClipIds : [],
      primaryClipId: action.target === 'time' ? state.primaryClipId : null,
      timeSelection: action.target === 'clips' ? state.timeSelection : null,
    };
  }
}

export type HitTarget = 'clip' | 'empty' | 'ruler' | 'control';
export type PlacementIntent =
  | { kind: 'ignore' }
  | { kind: 'place'; editCursorSec: number; seekTransportSec: number | null };
/** This returns an intent, NEVER a new isPlaying value. Seeking must preserve it. */
export function placementIntent(
  target: HitTarget, timeSec: number, playing: boolean, forceSeek = false,
): PlacementIntent {
  const t = Math.max(0, finite(timeSec, 'timeSec'));
  if (target === 'control') return { kind: 'ignore' };
  const seek = !playing || forceSeek || target === 'empty' || target === 'ruler';
  return { kind: 'place', editCursorSec: t, seekTransportSec: seek ? t : null };
}
export interface Viewport { zoom: number; scrollSec: number; widthPx: number }
/** marker centered except near timeline zero, where non-negative scrolling wins.
 * Add a real leading gutter to the UI when exact centering at t=0 is required.
 */
export function zoomCenteredOnMarker(
  viewport: Viewport, markerSec: number, factor: number,
  limits: Readonly<{ min: number; max: number }>,
): Viewport {
  if (finite(factor, 'factor') <= 0 || finite(viewport.widthPx, 'widthPx') <= 0
      || finite(viewport.zoom, 'zoom') <= 0 || limits.min <= 0)
    throw new RangeError('zoom, width and factor must be positive');
  const zoom = clamp(viewport.zoom * factor, limits.min, limits.max);
  return { ...viewport, zoom,
    scrollSec: Math.max(0, finite(markerSec, 'markerSec') - viewport.widthPx / (2 * zoom)) };
}
export type WheelAction =
  | { kind: 'zoom'; factor: number }
  | { kind: 'lane-height'; deltaPx: number }
  | { kind: 'pan-x' | 'pan-y'; deltaPx: number };
export function wheelAction(e: {
  deltaX: number; deltaY: number; deltaMode: number;
  ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
}, pageHeightPx = 800): WheelAction {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeightPx : 1;
  const x = finite(e.deltaX, 'deltaX') * scale;
  const y = finite(e.deltaY, 'deltaY') * scale;
  if ((e.ctrlKey || e.metaKey) && e.shiftKey)
    return { kind: 'lane-height', deltaPx: -clamp(y, -240, 240) * 0.15 };
  if (e.shiftKey) return { kind: 'pan-x', deltaPx: Math.abs(x) > Math.abs(y) ? x : y };
  if (e.altKey) return { kind: 'pan-y', deltaPx: y };
  // Both bindings honor the literal request for horizontal zoom; Ctrl is finer.
  // Ctrl+Shift resizes lanes vertically without changing that requested binding.
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-clamp(y, -240, 240) * 0.00125) };
  // A horizontal two-finger gesture still pans rather than zooming accidentally.
  if (Math.abs(x) > Math.abs(y)) return { kind: 'pan-x', deltaPx: x };
  return { kind: 'zoom', factor: Math.exp(-clamp(y, -240, 240) * 0.0025) };
}
export interface ChromeRect { leftInClipPx: number; widthPx: number; compact: boolean }
export function visibleClipChrome(
  clip: Range, viewport: Viewport, compactBelowPx = 100,
): ChromeRect | null {
  if (viewport.zoom <= 0 || viewport.widthPx <= 0) return null;
  const view = { startSec: viewport.scrollSec,
    endSec: viewport.scrollSec + viewport.widthPx / viewport.zoom };
  if (!overlaps(clip, view)) return null;
  const start = Math.max(clip.startSec, view.startSec);
  const end = Math.min(clip.endSec, view.endSec);
  const widthPx = (end - start) * viewport.zoom;
  return { leftInClipPx: (start - clip.startSec) * viewport.zoom,
    widthPx, compact: widthPx < compactBelowPx };
}
/** Correct for axis-aligned CSS scaling. Callers supply the content viewport,
 * excluding the pinned track header, and the element's LOCAL layout width.
 * Rotated/perspective canvases need a DOMMatrix inverse instead.
 */
export function clientXToTimeline(
  clientX: number, rectLeft: number, renderedWidth: number,
  layoutWidth: number, scrollSec: number, zoom: number,
): number {
  if (renderedWidth <= 0 || layoutWidth <= 0 || zoom <= 0) throw new RangeError('invalid geometry');
  return scrollSec + ((clientX - rectLeft) * layoutWidth / renderedWidth) / zoom;
}

export interface TrackNode {
  id: string;
  kind: 'audio' | 'midi' | 'folder' | 'master';
  parentId: string | null;
  heightPx: number;
  collapsed?: boolean;
  /** Grouping and routing are deliberately independent. This helper never edits it. */
  outputBusId?: string | null;
}
export function validateTracks(tracks: readonly TrackNode[]): void {
  const byId = new Map(tracks.map(t => [t.id, t]));
  if (byId.size !== tracks.length) throw new Error('duplicate track id');
  if (tracks.filter(t => t.kind === 'master').length !== 1) throw new Error('exactly one master required');
  for (const track of tracks) {
    if (track.heightPx <= 0 || !Number.isFinite(track.heightPx)) throw new Error('invalid track height');
    if (track.kind === 'master' && track.parentId !== null) throw new Error('master must be root');
    const seen = new Set([track.id]);
    let parent = track.parentId;
    while (parent !== null) {
      if (seen.has(parent)) throw new Error('track folder cycle');
      seen.add(parent);
      const node = byId.get(parent);
      if (!node || node.kind !== 'folder') throw new Error('parent must be an existing folder');
      parent = node.parentId;
    }
  }
}
function childrenOf(tracks: readonly TrackNode[]): Map<string | null, TrackNode[]> {
  const result = new Map<string | null, TrackNode[]>();
  for (const t of tracks) {
    const siblings = result.get(t.parentId);
    if (siblings) siblings.push(t); else result.set(t.parentId, [t]);
  }
  return result;
}
export interface TrackRow { id: string; depth: number; topPx: number; heightPx: number }
export function visibleTrackRows(tracks: readonly TrackNode[]): TrackRow[] {
  validateTracks(tracks);
  const children = childrenOf(tracks);
  const rows: TrackRow[] = [];
  let top = 0;
  const visit = (parentId: string | null, depth: number): void => {
    for (const track of children.get(parentId) ?? []) {
      if (track.kind === 'master') continue; // pinned in a separate region
      rows.push({ id: track.id, depth, topPx: top, heightPx: track.heightPx });
      top += track.heightPx;
      if (!track.collapsed) visit(track.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}
/** Single atomic reparent/reorder. beforeId is an EXISTING sibling in destination.
 * Select an ancestor plus children: descendants move once, inside their ancestor.
 * Preserve resulting preorder, children, id references and every outputBusId.
 */
export function moveTrackSubtrees(
  tracks: readonly TrackNode[], selectedIds: readonly string[],
  parentId: string | null, beforeId: string | null,
): TrackNode[] {
  validateTracks(tracks);
  const byId = new Map(tracks.map(t => [t.id, t]));
  const requested = new Set(selectedIds);
  if (!requested.size) return [...tracks];
  for (const id of requested) {
    if (!byId.has(id)) throw new Error('unknown selected track');
    if (byId.get(id)!.kind === 'master') throw new Error('master cannot move');
  }
  if (parentId !== null && byId.get(parentId)?.kind !== 'folder') throw new Error('invalid destination folder');
  const hasAncestorIn = (id: string, ids: ReadonlySet<string>): boolean => {
    let p = byId.get(id)!.parentId;
    while (p !== null) { if (ids.has(p)) return true; p = byId.get(p)!.parentId; }
    return false;
  };
  const roots = tracks.filter(t => requested.has(t.id) && !hasAncestorIn(t.id, requested));
  const rootIds = new Set(roots.map(t => t.id));
  if (parentId !== null && (rootIds.has(parentId) || hasAncestorIn(parentId, rootIds)))
    throw new Error('cannot move into own subtree');
  if (beforeId !== null) {
    const before = byId.get(beforeId);
    if (!before || before.parentId !== parentId || before.kind === 'master' || rootIds.has(beforeId))
      throw new Error('beforeId must be a nonmoving destination sibling');
  }
  const children = childrenOf(tracks);
  for (const [p, list] of children) children.set(p, list.filter(t => !rootIds.has(t.id)));
  const dest = children.get(parentId) ?? [];
  const index = beforeId === null ? dest.length : dest.findIndex(t => t.id === beforeId);
  dest.splice(index, 0, ...roots.map(t => ({ ...t, parentId })));
  children.set(parentId, dest);
  const result: TrackNode[] = [tracks.find(t => t.kind === 'master')!];
  const visit = (p: string | null): void => {
    for (const t of children.get(p) ?? []) {
      if (t.kind === 'master') continue;
      result.push(t); visit(t.id);
    }
  };
  visit(null);
  validateTracks(result);
  return result;
}

export type ContextTarget =
  | { kind: 'clip'; clipId: string }
  | { kind: 'selection'; range: Range; clipIdUnderPointer: string | null }
  | { kind: 'empty' };
export function contextTarget(
  timeSec: number, range: Range | null, clipId: string | null, selectionAppliesToLane = true,
): ContextTarget {
  if (range && selectionAppliesToLane && pointInRange(timeSec, range))
    return { kind: 'selection', range, clipIdUnderPointer: clipId };
  return clipId ? { kind: 'clip', clipId } : { kind: 'empty' };
}
