// Run with: npx tsx src/lib/bendLane.test.ts
//
// The bend lane's geometry: the y scale, the snapping a drag uses, the path a
// curve draws for each shape, and which point a pointer grabs.
import assert from 'node:assert/strict';
import {
  BEND_GRAB_R,
  BEND_LANE_HEIGHT,
  BEND_POINT_R,
  BEND_SHAPE_LABEL,
  BEND_SNAP_VALUES,
  BEND_VALUE_SNAP,
  bendPath,
  bendPointAt,
  bendValueToY,
  bendYToValue,
  nextBendShape,
  snapBendStep,
  snapBendValue,
} from './bendLane.ts';
import { SMOOTH_SEGMENTS, bendValueAt, type BendPoint } from './pitchBend.ts';

const H = BEND_LANE_HEIGHT;
const pt = (id: string, step: number, value: number, shape: BendPoint['shape'] = 'linear'): BendPoint =>
  ({ id, step, value, shape });

// (a) The y scale: +1 at the top, 0 on the centre line, -1 at the bottom, and
// a point at either extreme stays a full radius inside the strip so its handle
// is never half cut off.
{
  assert.equal(bendValueToY(0, H), H / 2);
  const top = bendValueToY(1, H);
  const bottom = bendValueToY(-1, H);
  assert.ok(top < H / 2 && bottom > H / 2, '+1 is up the screen');
  assert.equal(top, BEND_POINT_R);
  assert.equal(bottom, H - BEND_POINT_R);
  assert.equal(bendValueToY(2, H), top, 'out of range clamps');
  assert.equal(bendValueToY(Number.NaN, H), H / 2, 'a broken value is the centre');
}

// (b) y → value is the inverse, and reading past either edge clamps.
{
  for (const v of [-1, -0.5, 0, 0.25, 1]) {
    assert.ok(Math.abs(bendYToValue(bendValueToY(v, H), H) - v) < 1e-9, `${v} round-trips`);
  }
  assert.equal(bendYToValue(-100, H), 1);
  assert.equal(bendYToValue(H + 100, H), -1);
}

// (c) A drag snaps to centre, the half-range marks and both extremes, and Alt
// takes whatever is under the pointer so a bend between the marks is reachable.
{
  for (const mark of BEND_SNAP_VALUES) {
    assert.equal(snapBendValue(mark + BEND_VALUE_SNAP * 0.9), mark, `${mark} pulls`);
    assert.equal(snapBendValue(mark - BEND_VALUE_SNAP * 0.9), mark);
  }
  const between = 0.25;
  assert.equal(snapBendValue(between), between, 'a value far from every mark is left alone');
  assert.equal(snapBendValue(0.02, true), 0.02, 'Alt takes the raw value');
  assert.equal(snapBendValue(0.02), 0, 'without Alt it is the centre');
  assert.equal(snapBendValue(5), 1, 'out of range clamps first');
}

// (d) The step a pointer lands on: quantised, inside the roll, and free under Alt.
{
  const stepPx = 12;
  assert.equal(snapBendStep(0, stepPx, 64, 1), 0);
  assert.equal(snapBendStep(12 * 5 + 4, stepPx, 64, 1), 5, 'rounds to the nearest step');
  assert.equal(snapBendStep(12 * 5 + 7, stepPx, 64, 1), 6);
  assert.equal(snapBendStep(12 * 5 + 3, stepPx, 64, 0.25), 5.25, 'a finer quantum keeps the fraction');
  assert.equal(snapBendStep(-40, stepPx, 64, 1), 0, 'left of the roll is step 0');
  assert.equal(snapBendStep(12 * 999, stepPx, 64, 1), 64, 'right of it is the last step');
  assert.equal(snapBendStep(12 * 5 + 4, stepPx, 64, 1, true), 5.333, 'Alt keeps the fraction');
  assert.equal(snapBendStep(10, 0, 64, 1), 0, 'a zero-width step cannot place anything');
}

// (e) An empty lane draws its centre line across the whole roll, so the strip
// always shows where 0 is.
{
  const d = bendPath([], { stepPx: 10, totalSteps: 32, height: H });
  assert.equal(d, `M 0 ${H / 2} L 320 ${H / 2}`);
}

// (f) Before the first point the bend is 0, and after the last it holds — the
// path says both, so what is drawn is what is played.
{
  const points = [pt('a', 4, 0.5), pt('b', 8, -1)];
  const d = bendPath(points, { stepPx: 10, totalSteps: 16, height: H });
  assert.ok(d.startsWith(`M 0 ${bendValueToY(0, H)}`), 'starts at the centre');
  assert.ok(d.includes(`L 40 ${bendValueToY(0, H)}`), 'flat until the first point');
  assert.ok(d.endsWith(`L 160 ${bendValueToY(-1, H)}`), 'holds the last value to the end');
}

// (g) hold draws the flat run and the jump; linear draws neither.
{
  const held = bendPath([pt('a', 0, 1, 'hold'), pt('b', 8, -1)], { stepPx: 10, totalSteps: 8, height: H });
  assert.ok(held.includes(`L 80 ${bendValueToY(1, H)}`), 'flat at the old value up to the next step');
  assert.ok(held.trimEnd().endsWith(`L 80 ${bendValueToY(-1, H)}`), 'then the jump');

  const ramp = bendPath([pt('a', 0, 1, 'linear'), pt('b', 8, -1)], { stepPx: 10, totalSteps: 8, height: H });
  assert.ok(!ramp.includes(`L 80 ${bendValueToY(1, H)}`), 'a ramp has no flat run');
}

// (h) smooth is sampled through the same easing the audio plays, so the drawn
// curve and the sounding one cannot drift apart.
{
  const points = [pt('a', 0, -1, 'smooth'), pt('b', 8, 1)];
  const d = bendPath(points, { stepPx: 10, totalSteps: 8, height: H });
  const segments = d.split('L').length - 1;
  assert.ok(segments >= SMOOTH_SEGMENTS, `sampled at least ${SMOOTH_SEGMENTS} times, got ${segments}`);
  // A sample from the middle of the curve is on the path.
  const mid = bendValueAt(points, 4);
  assert.ok(d.includes(`L 40 ${Math.round(bendValueToY(mid, H) * 100) / 100}`), 'the midpoint is where it sounds');
  assert.ok(Math.abs(mid) < 1, 'and the easing has not reached either end there');
}

// (i) Grabbing a point: inside the grab radius, nearest wins, and a miss is
// null. The grab radius is wider than the drawn dot, so a 4px handle is not a
// 4px target.
{
  assert.ok(BEND_GRAB_R > BEND_POINT_R, 'the target is bigger than the dot');
  const points = [pt('a', 2, 0), pt('b', 3, 0)];
  const geom = { stepPx: 20, height: H };
  assert.equal(bendPointAt(points, 40, H / 2, geom)?.id, 'a');
  assert.equal(bendPointAt(points, 60, H / 2, geom)?.id, 'b');
  assert.equal(bendPointAt(points, 50, H / 2, geom)?.id, 'a', 'exactly between them, the first wins');
  assert.equal(bendPointAt(points, 46, H / 2, geom)?.id, 'a', 'nearest wins');
  assert.equal(bendPointAt(points, 54, H / 2, geom)?.id, 'b');
  assert.equal(bendPointAt(points, 40, H / 2 + BEND_GRAB_R + 1, geom), null, 'too far below');
  assert.equal(bendPointAt(points, 200, H / 2, geom), null, 'nowhere near');
  assert.equal(bendPointAt([], 40, H / 2, geom), null);
}

// (j) The SHAPE key cycles all three and comes back, and every shape has a word.
{
  assert.equal(nextBendShape('linear'), 'hold');
  assert.equal(nextBendShape('hold'), 'smooth');
  assert.equal(nextBendShape('smooth'), 'linear');
  for (const shape of ['linear', 'hold', 'smooth'] as const) {
    assert.match(BEND_SHAPE_LABEL[shape], /^[A-Z]+$/, `${shape} has an uppercase word`);
  }
}

console.log('bendLane: the drawn curve is the one that sounds, and a drag snaps where it should');
