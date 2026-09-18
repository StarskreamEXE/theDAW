/**
 * plainAscii: the fold that keeps unicode glyphs out of the console.
 *
 * The console carries the backend, the Electron main process and the dev server
 * in one stream, and it is read to find out what broke. The load-bearing rule
 * here is that a glyph carrying meaning is TRANSLITERATED, never dropped: a log
 * line reading "key of F#" is correct and one reading "key of F" is a lie.
 *
 * Run: `npx tsx src/lib/plainText.test.ts` -- `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { hasNonAscii, plainAscii } from './plainText';

// ── the line that started this ──────────────────────────────────────────────
assert.equal(
  plainAscii('10:47:19 PM [vite] (client) ✨ new dependencies optimized: react-dom/server'),
  '10:47:19 PM [vite] (client) new dependencies optimized: react-dom/server',
);
assert.equal(
  plainAscii('[vite] (client) ✨ optimized dependencies changed. reloading'),
  '[vite] (client) optimized dependencies changed. reloading',
);

// ── meaning is transliterated, never dropped ────────────────────────────────
assert.equal(plainAscii('key of F♯ minor'), 'key of F# minor', 'a sharp must not vanish');
assert.equal(plainAscii('B♭ major'), 'Bb major');
assert.equal(plainAscii('129.2 → 198.8 bpm'), '129.2 -> 198.8 bpm');
assert.equal(plainAscii('MIDI ← import'), 'MIDI <- import');
assert.equal(plainAscii('A ↔ B'), 'A <-> B');
assert.equal(plainAscii('−∞ dB'), '-inf dB', 'a level meter must still read minus infinity');
assert.equal(plainAscii('≥ 90 bars'), '>= 90 bars');
assert.equal(plainAscii('≤ 4'), '<= 4');
assert.equal(plainAscii('≈ -100 dBFS'), '~ -100 dBFS');
assert.equal(plainAscii('180° ± 2'), '180 deg +/- 2');
assert.equal(plainAscii('don’t — it…'), "don't - it...");

// ── decoration goes ─────────────────────────────────────────────────────────
assert.equal(plainAscii('\u{1F6A8} HARD RULES'), 'HARD RULES');
assert.equal(plainAscii('done \u{1F389}\u{1F389}'), 'done');
assert.equal(plainAscii('\u{1F1EF}\u{1F1F5} flag'), 'flag');
assert.equal(plainAscii('a ❤\u{FE0F} b'), 'a b', 'a variation selector must not be left behind');
assert.equal(plainAscii('\u{1F512}'), '', 'a line of only decoration comes back empty');
assert.equal(plainAscii('☰ menu'), 'menu');
assert.equal(plainAscii('⚄ dice'), 'dice');
assert.equal(plainAscii('⬢ mod'), 'mod');
assert.equal(plainAscii('⣿ grip'), 'grip');

// ── box drawing becomes its ASCII ancestor ──────────────────────────────────
assert.equal(plainAscii('─── section'), '--- section');
assert.equal(plainAscii('│ pipe'), '| pipe');

// ── nothing that is already ASCII moves ─────────────────────────────────────
const plain = "tempo 129.2 -> 198.8 bpm, a 3:2 error. See 'the map' (x2).";
assert.equal(plainAscii(plain), plain);
assert.equal(plainAscii(''), '');

// Every output is pure ASCII, whatever went in.
for (const sample of [
  '✨ x',
  'F♯ → G♭',
  '\u{1F3B5}\u{1F3B6}',
  '─'.repeat(40),
  'café naïve',
]) {
  const out = plainAscii(sample);
  assert.ok(!hasNonAscii(out), `left non-ASCII behind for ${JSON.stringify(sample)}: ${JSON.stringify(out)}`);
}

// Multi-line input keeps its lines.
assert.equal(plainAscii('a → b\nc → d'), 'a -> b\nc -> d');

assert.ok(hasNonAscii('✨'));
assert.ok(!hasNonAscii('plain ascii only'));

console.log('plainText: ok');
