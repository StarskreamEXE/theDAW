import assert from 'node:assert/strict';
import { euclidPattern, GEN_BLURB, GEN_KINDS, genCell, unit } from './loomGen.ts';
import { ruleTile, symbolIndex, type RuleNode } from './colony.ts';
import { accelSpan, chanceOpen, cycleOpen, dbToVelocity, GEN_RULES, genNotes, renderGen, ruleHash, swingShift } from './rollLoom.ts';

const rule = (gen: RuleNode['gen'], steps: number, symbols: number, opts: RuleNode['opts'] = {}, id = 'r'): RuleNode =>
  ({ kind: 'rule', id, gen, steps, symbols, opts });
const hitSteps = (pat: boolean[]): number[] => pat.flatMap((hit, i) => (hit ? [i] : []));
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} != ${b}`);
const PITCHES = [36, 38, 42];

// genNotes plays the colony's symbol sequence: symbol i on pitches[i], rests silent, gain on velocity.
{
  for (const r of [rule('rand', 16, 3, { p: 0.6 }, 'swarm'), rule('life', 16, 3, { density: 0.4 }, 'crowd'), rule('fib', 13, 2)]) {
    for (const lap of [0, 3]) {
      const tile = ruleTile(r);
      const cells = Array.from({ length: r.steps }, (_, i) => genCell(tile, i, lap, 11, undefined, ruleHash(r.id), 0));
      const want = cells.map((c) => symbolIndex(c?.query ?? null));
      const notes = genNotes(r, PITCHES, { startStep: 8, stepLen: 1, lap, seed: 11, baseVel: 100 });
      const got: (number | null)[] = new Array(r.steps).fill(null);
      for (const n of notes) got[n.step - 8] = PITCHES.indexOf(n.note);
      assert.deepEqual(got, want, `${r.gen} lap ${lap}`);
      assert.ok(notes.length > 0, `${r.gen} lap ${lap} plays`);
      for (const n of notes) {
        assert.equal(n.velocity, dbToVelocity(100, cells[n.step - 8]?.gain ?? 0));
        assert.equal(n.length, 1);
        assert.equal('lane' in n, false, 'no lane unless one is given');
      }
    }
  }
  // Echo decays in velocity; gliss transposes; stepLen spaces and lengthens; lane is written.
  const echo = genNotes(rule('echo', 12, 1, { every: 3, decay: 6, depth: 3 }), [60], { startStep: 0, stepLen: 2, lap: 0, seed: 1, baseVel: 100, lane: 2 });
  assert.deepEqual(echo.map((n) => [n.step, n.length, n.velocity, n.lane]), [[0, 2, 100, 2], [6, 2, 50, 2], [12, 2, 25, 2], [18, 2, 13, 2]]);
  const gliss = genNotes(rule('gliss', 5, 1, { from: 0, to: 12 }), [60], { startStep: 0, stepLen: 1, lap: 0, seed: 1, baseVel: 90 });
  assert.deepEqual(gliss.map((n) => n.note), [60, 63, 66, 69, 72]);
  // The colony's accent: 7/8 3+2+2 lifts steps 0, 3 and 5 by 1.5 dB.
  const accented = genNotes(rule('euclid', 7, 1, { hits: 7, rotate: 0 }), [60], { startStep: 0, stepLen: 2, lap: 0, seed: 1, baseVel: 80, meter: { num: 7, den: 8, groups: [3, 2, 2] } });
  assert.deepEqual(accented.map((n) => n.velocity), [95, 80, 80, 95, 80, 95, 80]);
  // Swing moves odd steps late by (swing - 0.5) * 2 steps.
  const swung = genNotes(rule('euclid', 4, 1, { hits: 4, rotate: 0 }), [60], { startStep: 16, stepLen: 2, lap: 0, seed: 1, baseVel: 80, swing: 0.75 });
  assert.deepEqual(swung.map((n) => n.step), [16, 19, 20, 23]);
}

// A euclid rule with 5 hits over 12 steps and rotate 2 plays where euclidPattern(5, 12, 2) marks.
// LOOM rotates by rotate × lap, so the rotation lands on lap 1; lap 0 is unrotated.
{
  const r = rule('euclid', 12, 1, { hits: 5, rotate: 2 });
  const opts = { startStep: 0, stepLen: 1, seed: 1, baseVel: 100 };
  assert.deepEqual(genNotes(r, [36], { ...opts, lap: 1 }).map((n) => n.step), hitSteps(euclidPattern(5, 12, 2)));
  assert.deepEqual(hitSteps(euclidPattern(5, 12, 2)), [1, 3, 6, 8, 10]);
  assert.deepEqual(genNotes(r, [36], { ...opts, lap: 0 }).map((n) => n.step), hitSteps(euclidPattern(5, 12, 0)));
}

// The chance gate is LoomEngine's die: the same for a seed, and open close to pct.
{
  const roll = (seed: number) => Array.from({ length: 2000 }, (_, i) => chanceOpen(seed, 1, i, 0, 30));
  const a = roll(42);
  assert.deepEqual(roll(42), a, 'same seed, same gates');
  assert.notDeepEqual(roll(43), a, 'another seed, other gates');
  const rate = a.filter(Boolean).length / a.length;
  assert.ok(Math.abs(rate - 0.3) < 0.04, `opened ${rate} of the steps at pct 30`);
  assert.equal(chanceOpen(7, 2, 9, 4, 50), unit(7, 3, 2, 9, 4) * 100 < 50);
  assert.equal(chanceOpen(7, 2, 9, 4, 0), false);
  assert.equal(chanceOpen(7, 2, 9, 4, 100), true);
}

// The cycle gate opens on the listed laps of every period.
{
  assert.deepEqual(Array.from({ length: 8 }, (_, lap) => cycleOpen(lap, 4, [2, 4])), [false, true, false, true, false, true, false, true]);
  assert.deepEqual(Array.from({ length: 6 }, (_, lap) => cycleOpen(lap, 3, [1])), [true, false, false, true, false, false]);
}

// Swing shift: even steps stay, odd steps land late.
{
  assert.equal(swingShift(0, 0.67, 1), 0);
  near(swingShift(1, 0.67, 1), 0.34);
  assert.equal(swingShift(3, 0.5, 2), 0);
  assert.equal(swingShift(5, 0.75, 2), 1);
}

// accelSpan keeps the span's length, the order, and every note that starts outside it.
{
  const before = { id: 'a', step: 0, length: 6 };
  const after = { id: 'z', step: 12, length: 4 };
  const inside = Array.from({ length: 8 }, (_, k) => ({ id: `n${k}`, step: 4 + k, length: 1 }));
  const input = [before, inside[5], inside[0], after, ...inside.filter((_, k) => k !== 0 && k !== 5)];
  const out = accelSpan(input, 4, 8, 1, 2, 1);
  assert.deepEqual(out.map((n) => n.id), input.map((n) => n.id), 'order kept');
  assert.equal(out[0], before, 'a note before the span is untouched');
  assert.equal(out[3], after, 'a note at the span end is untouched');
  const byId = new Map(out.map((n) => [n.id, n]));
  const timed = inside.map((n) => byId.get(n.id)!);
  near(timed[0].step, 4, 'the span starts where it did');
  near(timed[7].step + timed[7].length, 12, 'the span still ends at start + len');
  near(timed.reduce((s, n) => s + n.length, 0), 8, 'the steps still fill the span');
  for (let k = 1; k < 8; k += 1) near(timed[k].step, timed[k - 1].step + timed[k - 1].length, 'each step starts where the last one ends');
  // GenCell.warp: from 1 to 2 over 8 cells, the first step lasts twice the last.
  const gaps = timed.map((n) => n.length);
  for (let k = 1; k < 8; k += 1) assert.ok(gaps[k] < gaps[k - 1], 'accelerando: every step is shorter');
  near(gaps[0] / gaps[7], 2);
  const rit = accelSpan(inside, 4, 8, 2, 1).map((n) => n.length);
  for (let k = 1; k < 8; k += 1) assert.ok(rit[k] > rit[k - 1], 'ritardando: every step is longer');
  // A note that runs past the span keeps its tail after the span end.
  const [long] = accelSpan([{ step: 10, length: 6 }], 4, 8, 1, 2);
  near(long.step + long.length, 16);
}

// renderGen plays passes back to back, and a lap gate plays only the listed laps.
{
  const r = rule('euclid', 8, 1, { hits: 3, rotate: 0 });
  const base = { startStep: 0, stepLen: 2, laps: 6, seed: 3, baseVel: 100, lane: 1 };
  const all = renderGen(r, [40], base);
  assert.equal(all.length, 18);
  for (let lap = 0; lap < 6; lap += 1) {
    const pass = all.filter((n) => n.step >= lap * 16 && n.step < (lap + 1) * 16);
    assert.deepEqual(pass, genNotes(r, [40], { ...base, startStep: lap * 16, lap }), `pass ${lap} is lap ${lap}`);
  }
  const gated = renderGen(r, [40], { ...base, gate: { kind: 'lap', period: 3, laps: [1, 3] } });
  assert.deepEqual([...new Set(gated.map((n) => Math.floor(n.step / 16)))], [0, 2, 3, 5]);
  assert.equal(gated.length, 12);
  assert.ok(gated.every((n) => n.lane === 1));
  // A chance gate drops exactly the cells LoomEngine's die closes.
  const dense = rule('euclid', 8, 1, { hits: 8, rotate: 0 });
  const chance = renderGen(dense, [40], { ...base, gate: { kind: 'chance', pct: 50 } });
  const expected = renderGen(dense, [40], base).filter((n) => chanceOpen(3, 1, (n.step % 16) / 2, Math.floor(n.step / 16), 50));
  assert.deepEqual(chance, expected);
  assert.ok(chance.length > 0 && chance.length < 48);
}

// The menu lists every generator with a one-word legend and one sentence of LOOM's blurb.
{
  assert.deepEqual(GEN_RULES.map((g) => g.kind), [...GEN_KINDS]);
  for (const g of GEN_RULES) {
    assert.match(g.legend, /^[A-Za-z]+$/, `${g.kind} legend`);
    assert.ok(GEN_BLURB[g.kind].startsWith(g.title), `${g.kind} title comes from the blurb`);
    assert.match(g.title, /[.!?]$/);
    assert.doesNotMatch(g.title, /[.!?]\s/, `${g.kind} title is one sentence`);
  }
}

console.log('rollLoom: all assertions passed');
