import assert from 'node:assert/strict';
import { laneTargetAtY } from './laneTarget';

const H = 100;

// Lane centres resolve to the lane.
assert.deepEqual(laneTargetAtY(50, 3, H), { kind: 'lane', index: 0 });
assert.deepEqual(laneTargetAtY(150, 3, H), { kind: 'lane', index: 1 });
assert.deepEqual(laneTargetAtY(250, 3, H), { kind: 'lane', index: 2 });

// The band at a lane's top edge is the gap above it; at its bottom edge, the
// gap below it. Both name the index the new lane takes.
assert.deepEqual(laneTargetAtY(105, 3, H), { kind: 'insert', index: 1 });
assert.deepEqual(laneTargetAtY(95, 3, H), { kind: 'insert', index: 1 });
assert.deepEqual(laneTargetAtY(90, 3, H), { kind: 'insert', index: 1 });
assert.deepEqual(laneTargetAtY(89, 3, H), { kind: 'lane', index: 0 });
assert.deepEqual(laneTargetAtY(110, 3, H), { kind: 'lane', index: 1 });

// Above the first lane and its own top band both mean "a lane above the first".
assert.deepEqual(laneTargetAtY(-30, 3, H), { kind: 'insert', index: 0 });
assert.deepEqual(laneTargetAtY(3, 3, H), { kind: 'insert', index: 0 });

// Below the last lane and its own bottom band both mean "a lane after the last".
assert.deepEqual(laneTargetAtY(300, 3, H), { kind: 'insert', index: 3 });
assert.deepEqual(laneTargetAtY(295, 3, H), { kind: 'insert', index: 3 });
assert.deepEqual(laneTargetAtY(5000, 3, H), { kind: 'insert', index: 3 });

// No lanes at all: everything is the first lane.
assert.deepEqual(laneTargetAtY(40, 0, H), { kind: 'insert', index: 0 });

// The band width is a parameter, so a taller lane can use a wider band.
assert.deepEqual(laneTargetAtY(115, 3, H, 20), { kind: 'insert', index: 1 });
assert.deepEqual(laneTargetAtY(115, 3, H, 10), { kind: 'lane', index: 1 });

console.log('laneTarget: ok');
