/** Pure gesture state machine. DOM adapter must capture/release the pointer.
 * Pointer movement is measured in screen CSS pixels for a zoom-independent
 * drag threshold; hit tests use model-space coordinates supplied by the caller.
 */
import { combineSelection, rectFromPoints, type Rect, type SelectionMode } from './timelineCore.js';
export interface Point { x: number; y: number }
export interface PendingGesture {
  pointerId: number;
  originClient: Point;
  originModel: Point;
  currentModel: Point;
  baselineIds: readonly string[];
  mode: SelectionMode;
  phase: 'pending' | 'marquee';
}
export function startGesture(
  pointerId: number, client: Point, model: Point, baselineIds: readonly string[], mode: SelectionMode,
): PendingGesture {
  return { pointerId, originClient: client, originModel: model, currentModel: model,
    baselineIds: [...baselineIds], mode, phase: 'pending' };
}
export function moveGesture(
  state: PendingGesture, pointerId: number, client: Point, model: Point,
  hitTest: (rect: Rect) => readonly string[], thresholdPx = 4,
): { state: PendingGesture; selectedIds: readonly string[] | null; rect: Rect | null } {
  if (pointerId !== state.pointerId) return { state, selectedIds: null, rect: null };
  const dragged = Math.hypot(client.x - state.originClient.x, client.y - state.originClient.y) >= thresholdPx;
  if (state.phase === 'pending' && !dragged)
    return { state: { ...state, currentModel: model }, selectedIds: null, rect: null };
  const next = { ...state, phase: 'marquee' as const, currentModel: model };
  const rect = rectFromPoints(next.originModel, model);
  return { state: next, selectedIds: combineSelection(state.baselineIds, hitTest(rect), state.mode), rect };
}
export function finishGesture(state: PendingGesture, pointerId: number): 'click' | 'marquee' | 'ignore' {
  if (pointerId !== state.pointerId) return 'ignore';
  return state.phase === 'pending' ? 'click' : 'marquee';
}
export function cancelGesture(state: PendingGesture): readonly string[] { return [...state.baselineIds]; }
