// Group G: bottom-dock SCORE, SING, LYRIC, SLIDE.
import { open, settle, toggleLibrary, mark, shot } from './lib.mjs';
const { browser, page } = await open();
const T = { Score: 'Sheet music', Sing: 'Karaoke', Lyric: 'Write, edit and analyse', Slide: 'Control surface' };
const dockTab = (t) => page.locator(`button[title^="${T[t]}"]`).first();
const union = async (locs) => {
  const bs = (await Promise.all(locs.map((l) => l.first().boundingBox({ timeout: 3000 }).catch(() => null)))).filter(Boolean);
  if (!bs.length) return null;
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, width: Math.max(...bs.map((b) => b.x + b.width)) - x, height: Math.max(...bs.map((b) => b.y + b.height)) - y };
};
const report = (slug, miss) => console.log(slug, 'missing', JSON.stringify(miss));

await toggleLibrary(page);
if (!(await dockTab('Score').isVisible())) await page.getByRole('button', { name: 'Expand bottom panel' }).click();
await settle(page, 1500);
await dockTab('Score').click();
await settle(page, 1500);
// Row index 2 of the UrZunzet rows is entry e9072f8e (scores, tabs, timed lyrics).
await page.locator('div[title^="Click to inspect metadata"]').filter({ hasText: 'UrZunzet' }).nth(2).click();
await page.getByRole('button', { name: 'Maximize panel' }).first().click();
await settle(page, 10000);
const hideOrb = () => page.evaluate(() => { const o = document.querySelector('[aria-label="Toggle orb panel"]'); if (o) (o.parentElement || o).style.visibility = 'hidden'; });
await hideOrb();

// ---- 25-score
await page.getByRole('button', { name: 'Export', exact: true }).click();
await page.waitForTimeout(800);
const menu = page.locator('[role=menu]').first();
let miss = await mark(page, [
  { n: 1, target: await union([page.locator('button').filter({ hasText: /recovered-from-disk/ }), page.locator('button').filter({ hasText: /^Chordschordtrack/ })]) },
  { n: 2, target: { x: 300, y: 128, width: 568, height: 800 }, box: false, at: 'c' },
  { n: 3, target: page.locator('button[title="Convert the first MIDI artifact to MusicXML"]') },
  { n: 4, target: await union([page.getByLabel('Tab instrument'), page.getByLabel('Capo fret'), page.locator('button[title="Arrange the first MIDI artifact into tablature"]')]) },
  { n: 5, target: await union([page.getByLabel('Arrangement style'), page.locator('button[title="Arrange the first MIDI artifact"]')]) },
  { n: 6, target: menu.locator('[role=group][aria-label="Part"]') },
  { n: 7, target: menu.locator('[role=group][aria-label^="Format for"]') },
  { n: 8, target: page.getByRole('button', { name: 'Export', exact: true }), at: 'bl' },
]);
report('25-score', miss);
await shot(page, '25-score', {
  title: 'SCORE',
  subtitle: 'Turn MIDI into sheet music, tablature, arrangements, and exportable notation files.',
});
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// ---- 26-sing
await dockTab('Sing').click();
await settle(page, 4000);
await page.locator('button[title="Lyrics and the score side by side"]').click();
await settle(page, 6000);
const play = page.locator('button[title*="UrZunzet"]').filter({ visible: true });
const pb = await play.all();
for (const b of pb) { const bb = await b.boundingBox(); if (bb && bb.y > 900 && bb.x < 100) { await b.click(); break; } }
await page.waitForTimeout(25000);
await hideOrb();
miss = await mark(page, [
  { n: 1, target: { x: 20, y: 130, width: 900, height: 800 }, box: false, at: 'c' },
  { n: 2, target: page.getByRole('group', { name: 'Sing tab layout' }) },
  { n: 3, target: page.locator('button').filter({ hasText: /^\s*align\s*$/i }) },
  { n: 4, target: page.locator('label[for="sing-tap"]'), at: 'tr' },
  { n: 5, target: page.locator('label[for="sing-auto-align"]'), at: 'tl' },
  { n: 6, target: await union([page.locator('button').filter({ hasText: /transcribe/i }), page.locator('select[title^="Language for"]')]) },
  { n: 7, target: page.locator('label[for="sing-pitch"]') },
  { n: 8, target: page.locator('button').filter({ hasText: /^\s*export\s*$/i }).filter({ visible: true }), at: 'tr' },
]);
report('26-sing', miss);
await shot(page, '26-sing', {
  title: 'SING',
  subtitle: 'Display synchronized lyrics, align words, transcribe vocals, and practice pitch.',
});
// stop playback
for (const b of await play.all()) { const bb = await b.boundingBox(); if (bb && bb.y > 900 && bb.x < 100) { await b.click(); break; } }

// ---- 27-lyric (read-only: existing empty draft, nothing typed)
await dockTab('Lyric').click();
await settle(page, 4000);
miss = await mark(page, [
  { n: 1, target: { x: 90, y: 150, width: 1015, height: 800 }, box: false, at: 'c' },
  { n: 2, target: page.locator('select').filter({ hasText: /lines/ }).first() },
  { n: 3, target: { x: 1118, y: 150, width: 795, height: 820 }, box: false, at: 'c' },
  { n: 4, target: page.locator('span[title^="Rhyme class letters"]') },
  { n: 5, target: page.locator('span, div').filter({ hasText: /^saved$/ }).filter({ visible: true }).last(), at: 'tr' },
]);
report('27-lyric', miss);
await shot(page, '27-lyric', {
  title: 'LYRIC',
  subtitle: 'Write and analyze lyric drafts that are not tied to one finished Library track.',
});

// ---- 29-slide
await dockTab('Slide').click();
await settle(page, 5000);
await hideOrb();
const info = await page.evaluate(() => { const e = document.elementFromPoint(1816, 61); const b = e?.closest('button'); return b ? (b.title || b.getAttribute('aria-label')) : e?.outerHTML?.slice(0, 120); });
console.log('icon@1816,61 =', info);
const capsules = page.locator('[role=slider]').filter({ visible: true });
const faderBox = await union([page.getByText('CROSSFADE', { exact: true }), page.getByText('ASPECT', { exact: true }).locator('xpath=..')]);
const firstVal = page.getByText(/^\d+\.\d\d$/).filter({ visible: true }).first();
miss = await mark(page, [
  { n: 1, target: faderBox ? { ...faderBox, height: 230 } : capsules },
  { n: 2, target: { x: 38, y: 898, width: 62, height: 20 }, at: 'bl' },
  { n: 3, target: await union([page.getByRole('button', { name: 'Audio', exact: true }), page.getByRole('button', { name: 'Visual', exact: true })]), at: 'bl' },
  { n: 4, target: { x: 50, y: 780, width: 36, height: 40 }, at: 'tr' },
  { n: 5, target: page.getByRole('button', { name: 'Detach SLIDE window' }), at: 'bl' },
  { n: 6, target: page.getByRole('button', { name: 'Restore panel' }), at: 'br' },
]);
report('29-slide', miss);
await shot(page, '29-slide', {
  title: 'SLIDE',
  subtitle: 'Control VJ and other published parameters from a touch-friendly fader surface.',
});
await browser.close();
