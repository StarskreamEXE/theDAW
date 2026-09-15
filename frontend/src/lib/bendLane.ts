/**
 * The pitch bend lane's geometry: where a point sits in the strip under the
 * piano roll, and what the curve between points looks like.
 *
 * The strip shares the grid's x scale — one step is `stepPx` wide, so a point
 * sits under the note it bends — and its own y scale: +1 (the lane's full range
 * up) at the top, 0 on the centre line, -1 at the bottom.
 *
 * Everything here is pure, so the lane's behaviour is testable without a DOM:
 * the path a curve draws, the step a pointer lands on, and the value it lands
 * at, including the snapping each uses.
 */
import { SMOOTH_SEGMENTS, bendValueAt, clampBendValue, type BendPoint } from './pitchBend';

/** The strip's height in px. Two 12px legends and room to pull a curve. */
export const BEND_LANE_HEIGHT = 72;
/** A point's drawn radius. */
export const BEND_POINT_R = 4;
/** How near a pointer has to be to grab a point. Wider than the drawn dot, so a
 *  4px handle is not a 4px target. */
export const BEND_GRAB_R = 10;
/** Values this close to 0, ±0.5 or ±1 snap to it while dragging, unless Alt is held. */
export const BEND_VALUE_SNAP = 0.04;
/** The values a drag snaps to: centre, both half-range points, both extremes. */
export const BEND_SNAP_VALUES: readonly number[] = Object.freeze([-1, -0.5, 0, 0.5, 1]);

/** The strip's usable half-height: the centre line to either edge, less the point radius. */
export const bendHalfHeight = (height: number): number => Math.max(1, height / 2 - BEND_POINT_R);

/** The y of `value` in a strip `height` tall. +1 is the top. */
export function bendValueToY(value: number, height: number): number {
  return height / 2 - clampBendValue(value) * bendHalfHeight(height);
}

/** The value at `y` in a strip `height` tall, clamped to -1..1. */
export function bendYToValue(y: number, height: number): number {
  return clampBendValue((height / 2 - y) / bendHalfHeight(height));
}

/**
 * The value a drag lands on: `raw`, pulled to the nearest of BEND_SNAP_VALUES
 * within BEND_VALUE_SNAP. `free` (Alt held) takes the raw value, so any bend
 * between the marks is still reachable.
 */
export function snapBendValue(raw: number, free = false): number {
  const v = clampBendValue(raw);
  if (free) return v;
  let best = v;
  let bestD = BEND_VALUE_SNAP;
  for (const mark of BEND_SNAP_VALUES) {
    const d = Math.abs(v - mark);
    if (d <= bestD) {
      best = mark;
      bestD = d;
    }
  }
  return best;
}

/**
 * The step a pointer at `x` lands on, quantised to `quantum` steps (1 is every
 * 16th, 0.25 a 64th) and held inside the roll. `free` (Alt held) keeps the
 * fractional step, which is what a fine glide needs.
 */
export function snapBendStep(x: number, stepPx: number, totalSteps: number, quantum: number, free = false): number {
  if (!(stepPx > 0)) return 0;
  const raw = Math.max(0, Math.min(totalSteps, x / stepPx));
  if (free || !(quantum > 0)) return Math.round(raw * 1000) / 1000;
  return Math.max(0, Math.min(totalSteps, Math.round(raw / quantum) * quantum));
}

/**
 * The SVG path of a lane's curve across `totalSteps`.
 *
 * Before the first point the bend is 0 and after the last it holds, so the path
 * runs the full width whatever the points cover. A `linear` segment is a
 * straight line, a `hold` segment is a flat run and a jump at the next point,
 * and a `smooth` one is sampled through bendValueAt at SMOOTH_SEGMENTS per
 * segment, which is the same easing the audio plays.
 *
 * An empty lane draws its centre line, so the strip always shows where 0 is.
 */
export function bendPath(
  points: readonly BendPoint[],
  { stepPx, totalSteps, height }: { stepPx: number; totalSteps: number; height: number },
): string {
  const x = (step: number) => Math.round(step * stepPx * 100) / 100;
  const y = (value: number) => Math.round(bendValueToY(value, height) * 100) / 100;
  if (points.length === 0) return `M 0 ${y(0)} L ${x(totalSteps)} ${y(0)}`;

  const d: string[] = [`M 0 ${y(bendValueAt(points, 0))}`];
  const lineTo = (step: number, value: number) => d.push(`L ${x(step)} ${y(value)}`);

  // Up to the first point the bend is 0 (bendValueAt says so); draw that run.
  if (points[0].step > 0) lineTo(points[0].step, 0);

  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const next = points[i + 1];
    lineTo(p.step, p.value);
    if (!next) break;
    if (p.shape === 'hold') {
      // Flat to the next point, then the jump the wheel message makes.
      lineTo(next.step, p.value);
    } else if (p.shape === 'smooth') {
      const span = next.step - p.step;
      for (let s = 1; s < SMOOTH_SEGMENTS; s += 1) {
        const step = p.step + (span * s) / SMOOTH_SEGMENTS;
        lineTo(step, bendValueAt(points, step));
      }
    }
    // 'linear' needs no intermediate point: the next lineTo is the ramp.
  }

  const last = points[points.length - 1];
  if (last.step < totalSteps) lineTo(totalSteps, last.value);
  return d.join(' ');
}

/** The point within BEND_GRAB_R of (`x`, `y`), nearest first, or null. */
export function bendPointAt(
  points: readonly BendPoint[],
  x: number,
  y: number,
  { stepPx, height }: { stepPx: number; height: number },
): BendPoint | null {
  const reach = BEND_GRAB_R;
  let best: BendPoint | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const dx = p.step * stepPx - x;
    const dy = bendValueToY(p.value, height) - y;
    const d = Math.hypot(dx, dy);
    if (d <= reach && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** What each shape is called on the key that cycles them, and what it does. */
export const BEND_SHAPE_LABEL = {
  linear: 'LINE',
  hold: 'HOLD',
  smooth: 'CURVE',
} as const;

export const BEND_SHAPE_TITLE = {
  linear: 'Line: ramp straight to the next point',
  hold: 'Hold: keep this value, then jump at the next point',
  smooth: 'Curve: ease out of this point and into the next',
} as const;

/** The shape after `shape` when the SHAPE key is pressed. */
export function nextBendShape(shape: BendPoint['shape']): BendPoint['shape'] {
  return shape === 'linear' ? 'hold' : shape === 'hold' ? 'smooth' : 'linear';
}
