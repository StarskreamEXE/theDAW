// Group F: bottom-dock panels LEVELS, VISUALIZE, MIDI / PIANO ROLL, SEQUENCE, DRAW.
import { open, settle, mark, shot, RAW, toggleLibrary } from './lib.mjs';
import { resolve } from 'node:path';
const only = (process.argv[2] || 'levels,visualize,midi,sequence,draw').split(',');
const { browser, page } = await open();
const R = (x, y, width, height) => ({ x, y, width, height });
const report = (s, m) => console.log('missing', s, JSON.stringify(m));

const needAudio = only.includes('levels') || only.includes('visualize');
if (needAudio) {
  await toggleLibrary(page);
  const row = page.locator('[draggable="true"]').filter({ hasText: 'mixdown_357779' }).first();
  await row.locator('button[title="Play"]').first().click();
  await page.waitForTimeout(1500);
  await toggleLibrary(page);
  await page.getByRole('button', { name: 'Jump to start', exact: true }).last().click().catch(() => {});
  await page.waitForTimeout(4000);
}
await page.getByRole('button', { name: 'Expand bottom panel' }).click();
await settle(page, 1000);
await page.getByRole('button', { name: 'Maximize panel' }).click();
await settle(page, 1000);
const dockTab = async (ti) => { await page.locator(`button[title^="${ti}"]`).first().click(); await page.waitForTimeout(2500); };

if (only.includes('levels')) {
  await dockTab('Master loudness');
  await page.waitForTimeout(8000);
  report('levels', await mark(page, [
    { n: 1, target: R(733, 112, 290, 432) },
    { n: 2, target: R(433, 550, 292, 432) },
    { n: 3, target: R(135, 550, 292, 432) },
    { n: 4, target: R(1032, 872, 880, 108) },
    { n: 5, target: R(4, 84, 124, 896), at: 'tr' },
  ]));
  await shot(page, '20-levels', { title: 'LEVELS', subtitle: 'Check loudness, peaks, dynamics, and stereo behavior before delivery.' });
}

if (only.includes('visualize')) {
  await dockTab('Live spectrum');
  await page.locator('button[title="Spectrum"]').click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: resolve(RAW, '_groupF_viz_clean.png') });
  const miss = await mark(page, [
    { n: 1, target: R(20, 95, 28, 108), at: 'tr' },
    { n: 2, target: R(12, 230, 1890, 712), at: 'tr' },
    { n: 3, target: R(128, 912, 92, 52) },
    { n: 4, target: R(234, 912, 96, 52) },
    { n: 5, target: R(1824, 912, 36, 52) },
    { n: 6, target: R(1874, 912, 26, 52), at: 'tr' },
  ]);
  report('visualize', miss);
  await shot(page, '21-visualize', { title: 'VISUALIZE', subtitle: 'View the current audio signal as waveform and frequency data.' });
}

if (only.includes('midi') || only.includes('sequence') || only.includes('draw')) {
  // stop transport so MIDI/SEQUENCE previews are the only audio
  await page.getByRole('button', { name: 'Pause', exact: true }).last().click({ timeout: 2000 }).catch(() => {});
}

if (only.includes('midi')) {
  await dockTab('Piano roll:');
  await page.locator('button[title="Play"]').filter({ visible: true }).first().click().catch(() => {});
  await page.waitForTimeout(1200);
  report('midi', await mark(page, [
    { n: 1, target: R(0, 240, 68, 720) },
    { n: 2, target: R(360, 240, 1230, 715), at: 'c' },
    { n: 3, target: page.locator('div[title*=" · step "]').nth(3), at: 'tr' },
    { n: 4, target: R(45, 184, 178, 24), at: 'tr' },
    { n: 5, target: R(704, 182, 192, 30) },
    { n: 6, target: R(9, 183, 27, 27) },
    { n: 7, target: page.getByRole('button', { name: /import midi/i }).first() },
    { n: 8, target: page.getByRole('button', { name: /export midi/i }).first() },
    { n: 9, target: page.getByRole('button', { name: /send to editor/i }).first() },
  ]));
  await shot(page, '22-midi-piano-roll', { title: 'MIDI / PIANO ROLL', subtitle: 'Edit musical notes directly, choose instruments, import MIDI, and render note data into audio.' });
  await page.locator('button[title="Stop"]').filter({ visible: true }).first().click().catch(() => {});
}

if (only.includes('sequence')) {
  await dockTab('Program drum');
  const add = page.locator('button[title="Add track"]');
  await add.click();
  await page.waitForTimeout(500);
  await page.locator('button[title="Randomize all step patterns"]').click();
  await page.waitForTimeout(500);
  await page.mouse.click(114, 110); // sequencer play
  await page.waitForTimeout(1700);
  report('sequence', await mark(page, [
    { n: 1, target: R(14, 92, 72, 36) },
    { n: 2, target: R(98, 94, 33, 33) },
    { n: 3, target: R(168, 145, 1690, 101), at: 'c' },
    { n: 4, target: page.locator('button[title^="Voice: snare"]').first() },
    { n: 5, target: page.getByLabel('Voice volume').first(), at: 'bl' },
    { n: 6, target: page.locator('button[title="Randomize all step patterns"]'), at: 'bl' },
    { n: 7, target: page.locator('button[title="Clear all steps"]'), at: 'br' },
    { n: 8, target: add, at: 'br' },
    { n: 9, target: page.locator('button[title^="Render this pattern"]'), at: 'br' },
    { n: 10, target: page.locator('button[title^="Download this pattern"]'), at: 'bl' },
  ]));
  await shot(page, '23-sequence', { title: 'SEQUENCE', subtitle: 'Build quick 16-step drum and rhythm patterns.' });
  await page.mouse.click(114, 110);
}

if (only.includes('draw')) {
  await dockTab('Draw to play');
  await page.locator('button[title^="Soft drifting nebula"]').click().catch(() => {});
  await page.locator('button[title^="Vine-like"]').click();
  await page.mouse.move(300, 700);
  await page.mouse.down();
  for (let i = 0; i <= 80; i++) {
    const x = 300 + i * 16, y = 600 - Math.sin(i / 8) * 220 - i * 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);
  report('draw', await mark(page, [
    { n: 1, target: R(470, 235, 1140, 530), box: false },
    { n: 2, target: page.locator('button[title^="Vine-like"]'), at: 'bl' },
    { n: 3, target: page.locator('button[title^="Sunflower"]'), at: 'bl' },
    { n: 4, target: page.locator('button[title^="A wireframe"]'), at: 'bl' },
    { n: 5, target: page.locator('button[title^="Soft drifting nebula"]'), at: 'bl' },
    { n: 6, target: page.locator('select[title^="How strokes"]'), at: 'bl' },
    { n: 7, target: R(1020, 80, 115, 35), at: 'bl' },
  ]));
  await shot(page, '24-draw', { title: 'DRAW', subtitle: 'Turn mouse, pen, or touch gestures into generative musical material.' });
}
await browser.close();
