// Run with: npx tsx src/lib/editThemeAccent.test.ts
import assert from 'node:assert/strict';
import {
  ACCENT_TEXT_TARGET,
  CUSTOM_IMAGE_ID,
  EDIT_THEMES,
  accentKeyTile,
  contrastRatio,
  resolveEditThemeVars,
} from './editThemes.ts';

type Rgb = [number, number, number];
const triplet = (v: string): Rgb => {
  const n = v.trim().split(/\s+/).map(Number);
  assert.equal(n.length, 3, `"${v}" is an rgb triplet`);
  return [n[0], n[1], n[2]];
};

/**
 * Key tiles sampled from the running app (1366x768, 1x): the pixel inside a
 * latched LOOP, PLAY and action key, one row per neutral theme and key. These
 * are the real grounds, including what shows through the footer's 95% fill,
 * which the estimate leaves out.
 */
const SAMPLED_TILES: Record<string, Rgb[]> = {
  midnight: [[29, 28, 31]],
  obsidian: [[32, 32, 35], [32, 32, 38], [26, 26, 28]],
  graphite: [[39, 40, 45]],
  'silver-black': [[52, 56, 63], [52, 55, 63], [53, 56, 64]],
  'brushed-steel': [[58, 62, 70], [57, 62, 69], [67, 71, 79]],
  titanium: [[52, 56, 62]],
  porcelain: [[190, 188, 183]],
  ash: [[179, 185, 190]],
  paper: [[203, 195, 179]],
  'olive-bone': [[190, 191, 172]],
  'blush-charcoal': [[211, 193, 196], [211, 192, 196], [210, 191, 194]],
};

// (a) Every theme's accent reads as 12px text on its latched key tile.
for (const theme of EDIT_THEMES) {
  const { vars } = resolveEditThemeVars(theme.id, null);
  const tile = accentKeyTile(vars);
  assert.ok(tile, `${theme.id}: the key tile is estimated`);
  const ratio = contrastRatio(triplet(vars['--et-accent']), tile);
  assert.ok(ratio >= 4.5, `${theme.id}: accent ${vars['--et-accent']} is ${ratio.toFixed(2)}:1 on the estimated tile`);
}

// (b) The neutral themes, against the tiles the running app actually drew.
for (const [id, tiles] of Object.entries(SAMPLED_TILES)) {
  const { vars } = resolveEditThemeVars(id, null);
  const accent = triplet(vars['--et-accent']);
  for (const tile of tiles) {
    const ratio = contrastRatio(accent, tile);
    assert.ok(ratio >= 4.5, `${id}: accent ${vars['--et-accent']} is ${ratio.toFixed(2)}:1 on sampled ${tile.join(',')}`);
  }
  const est = accentKeyTile(vars);
  assert.ok(est && contrastRatio(accent, est) >= ACCENT_TEXT_TARGET, `${id}: a neutral accent clears the target on its estimate`);
}

// (c) A custom background image resolves on the dark ladder and still reads.
{
  const { vars, light } = resolveEditThemeVars(CUSTOM_IMAGE_ID, 'data:image/png;base64,AAAA');
  assert.equal(light, false);
  const tile = accentKeyTile(vars);
  assert.ok(tile, 'the rgba() popup parses');
  assert.ok(contrastRatio(triplet(vars['--et-accent']), tile) >= 4.5);
}

// (d) Hued themes keep their own tint as the accent.
{
  assert.equal(resolveEditThemeVars('navy-gold', null).vars['--et-accent'], '230 200 130');
  assert.equal(resolveEditThemeVars('mint', null).vars['--et-accent'], '24 60 46');
}

// (e) The ratio itself: black on white is 21:1 and a colour on itself is 1:1.
{
  assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255]) * 100) / 100, 21);
  assert.equal(contrastRatio([120, 40, 200], [120, 40, 200]), 1);
}

console.log('editThemeAccent: all assertions passed');
