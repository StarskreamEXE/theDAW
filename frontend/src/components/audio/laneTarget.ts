/**
 * Where a vertical position on the EDIT timeline lands: on a lane, or in the
 * gap between two lanes. The gap is a band of `gapPx` at each lane edge, plus
 * everything above the first lane and below the last, so a clip dragged there
 * gets a lane of its own at that index. One resolver serves the clip drag, the
 * library drop and the desktop drop, so all three agree on what "between" is.
 */
export type LaneTarget =
  | { kind: 'lane'; index: number }
  | { kind: 'insert'; index: number };

/** The lane-edge band, in local px. Wide enough to aim at with a mouse at any
 *  lane height the editor allows (56px and up). */
export const LANE_GAP_PX = 10;

export function laneTargetAtY(yPx: number, laneCount: number, laneH: number, gapPx = LANE_GAP_PX): LaneTarget {
  if (laneCount <= 0 || laneH <= 0) return { kind: 'insert', index: 0 };
  if (yPx < 0) return { kind: 'insert', index: 0 };
  if (yPx >= laneCount * laneH) return { kind: 'insert', index: laneCount };
  const index = Math.floor(yPx / laneH);
  const within = yPx - index * laneH;
  if (within < gapPx) return { kind: 'insert', index };
  if (within >= laneH - gapPx) return { kind: 'insert', index: index + 1 };
  return { kind: 'lane', index };
}
