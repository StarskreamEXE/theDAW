/** Persistent selection semantics, independent of DOM focus and playback. */
export interface TimeRange {
  start: number; end: number;
  scope: { kind: 'all-tracks' } | { kind: 'tracks'; ids: readonly string[] };
}
export interface Selection { clipIds: readonly string[]; range: TimeRange | null }
export interface Rect { x1: number; y1: number; x2: number; y2: number }
export function normalizedRect(r: Rect): Rect {
  if (![r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)) throw new RangeError('Non-finite rectangle');
  return { x1: Math.min(r.x1, r.x2), x2: Math.max(r.x1, r.x2), y1: Math.min(r.y1, r.y2), y2: Math.max(r.y1, r.y2) };
}
export function intersects(a: Rect, b: Rect): boolean {
  a = normalizedRect(a); b = normalizedRect(b);
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}
export function marquee(baseIds: readonly string[], hits: readonly string[],
  mode: 'replace' | 'add' | 'subtract' | 'toggle'): string[] {
  const out = new Set(mode === 'replace' ? [] : baseIds);
  for (const id of new Set(hits)) {
    if (mode === 'subtract') out.delete(id);
    else if (mode === 'toggle' && out.has(id)) out.delete(id);
    else out.add(id);
  }
  return [...out];
}
export function rangeContains(range: TimeRange | null, time: number, trackId: string): boolean {
  return !!range && time >= range.start && time < range.end &&
    (range.scope.kind === 'all-tracks' || range.scope.ids.includes(trackId));
}
export type MenuContext = { kind: 'time-range'; range: TimeRange } |
  { kind: 'clips'; ids: readonly string[] } | { kind: 'empty'; trackId: string; time: number };
export function contextAt(selection: Selection, hit: { trackId: string; time: number; clipId?: string }): MenuContext {
  if (rangeContains(selection.range, hit.time, hit.trackId)) return { kind: 'time-range', range: selection.range! };
  if (hit.clipId) return { kind: 'clips', ids: selection.clipIds.includes(hit.clipId) ? [...selection.clipIds] : [hit.clipId] };
  return { kind: 'empty', trackId: hit.trackId, time: hit.time };
}
export function blurSelection(selection: Selection): Selection { return selection; }
export function setRange(selection: Selection, range: TimeRange | null): Selection {
  if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start))
    throw new RangeError('Range must be a non-empty, non-negative interval');
  return { ...selection, range };
}
export interface TransportState { playing: boolean; playbackSec: number; editSec: number }
export function clickPosition(s: TransportState, time: number, surface: 'ruler' | 'empty' | 'clip',
  explicitSeek = false): { state: TransportState; seekTo?: number } {
  if (!Number.isFinite(time) || time < 0) throw new RangeError('Invalid position');
  // Empty-space clicks are dispatched on pointer UP only after rejecting drags.
  const seek = !s.playing || explicitSeek || surface !== 'clip';
  return { state: { ...s, editSec: time, playbackSec: seek ? time : s.playbackSec }, ...(seek ? { seekTo: time } : {}) };
}
