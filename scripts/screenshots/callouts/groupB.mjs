import { open, tab, toggleLibrary, settle, libDropAt, mark, shot } from './lib.mjs';
const ONLY = process.env.ONLY || 'make,lib,details';
const PROBE = !!process.env.PROBE;
const MAKE_PURPOSE = 'Generate new audio, transform existing audio, replace part of a song, or combine multiple sources.';
const dumpRegion = async (page, x0, y0, x1, y1) => {
  const r = await page.evaluate(([x0,y0,x1,y1]) => [...document.querySelectorAll('button,[role=button],input,select,textarea,span,div')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&b.x>=x0&&b.y>=y0&&b.x<x1&&b.y<y1&&(e.children.length===0||['BUTTON','INPUT','SELECT'].includes(e.tagName))}).map(e=>{const b=e.getBoundingClientRect();return `${e.tagName}#${e.id} [${e.getAttribute('aria-label')||''}] t=${(e.getAttribute('title')||'').slice(0,40)} "${(e.textContent||e.value||'').trim().slice(0,40)}" @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`}), [x0,y0,x1,y1]);
  console.log(r.join('\n'));
};

if (ONLY.includes('make')) {
  const { browser, page } = await open();
  await tab(page, 'Make');
  await toggleLibrary(page);
  await page.locator('#gen-prompt').fill('128 BPM melodic techno, rolling sub bass, shimmering analog arps, wide pads, driving hi-hats, dark euphoric mood');
  await page.locator('textarea').nth(1).fill('vocals, distortion, muddy low end, harsh cymbals');
  await page.locator('#gen-model').selectOption({ label: 'Medium (ARC)' }).catch((e) => console.log('model sel', e.message));
  // Init via context menu
  await page.locator('[draggable="true"]').filter({ hasText: 'mixdown_357779' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Send selected to Init/ }).click({ timeout: 5000 }).catch((e) => console.log('init', e.message));
  await page.keyboard.press('Escape');
  await settle(page, 2000);
  await libDropAt(page, 'UrZunzet', page.getByText('No inpaint audio'));
  await settle(page, 3000);
  await libDropAt(page, 'Little Kitty', page.getByText(/drop or click to start a chimera/i));
  await settle(page, 3000);
  await libDropAt(page, 'I Never Knew', page.getByText(/drop more tracks here/i));
  await settle(page, 6000, 120000);
  await page.mouse.move(980, 140); await page.waitForTimeout(200); await page.mouse.down(); await page.waitForTimeout(150); for (let x = 990; x <= 1240; x += 10) { await page.mouse.move(x, 140); await page.waitForTimeout(25); } await page.mouse.up();
  await settle(page, 1500);
  await page.mouse.move(700, 600);
  if (PROBE) { await page.screenshot({ path: '../docs/guides/screenshots/callouts/raw/_probeMake.png' }); await dumpRegion(page, 300, 190, 1210, 800); await browser.close(); process.exit(0); }
  const chim = page.locator('text=/chimera stack/i').first();
  let miss = await mark(page, [
    { n: 1, target: page.locator('#gen-prompt') },
    { n: 2, target: page.getByTitle('AI-enhance prompt', { exact: true }), box: false, at: 'c' },
    { n: 3, target: page.locator('textarea').nth(1) },
    { n: 4, target: page.locator('#gen-model') },
    { n: 5, target: { x: 30, y: 285, width: 255, height: 170 } },
    { n: 6, target: { x: 30, y: 68, width: 712, height: 112 } },
    { n: 7, target: { x: 760, y: 68, width: 712, height: 112 } },
    { n: 8, target: { x: 305, y: 300, width: 895, height: 480 } },
    { n: 9, target: page.getByText(/No output loaded|IDLE/).first() },
    { n: 10, target: page.getByTitle(/Submit .* to \/api\/generate/) },
  ]);
  console.log('make missing', miss);
  await shot(page, '03-make', { title: 'MAKE', subtitle: MAKE_PURPOSE });
  const clip = { x: 300, y: 300, width: 905, height: 255 };
  miss = await mark(page, [
    { n: 1, target: page.locator('#chimera-target-bpm'), at: 'tr' },
    { n: 2, target: page.getByTitle('Use this clip as the BPM reference').first(), at: 'bl' },
    { n: 3, target: { x: 1082, y: 378, width: 104, height: 22 }, at: 'tl' },
    { n: 4, target: page.locator('#chimera-align-mode'), at: 'tr' },
    { n: 5, target: { x: 352, y: 378, width: 130, height: 22 }, at: 'br' },
  ]);
  console.log('chimera missing', miss);
  await shot(page, '04-make-chimera', { title: 'MAKE — CHIMERA CLOSE-UP', subtitle: MAKE_PURPOSE }, clip);
  await browser.close();
}

if (ONLY.includes('lib')) {
  const { browser, page } = await open();
  await tab(page, 'Make');
  await toggleLibrary(page);
  const row = page.locator('[draggable="true"]').filter({ hasText: 'mixdown_357779' }).first();
  const rb = await row.boundingBox();
  await row.click({ position: { x: 60, y: 14 } });
  await settle(page, 1000);
  const b = { tabs: await page.getByRole('button', { name: /^Tracks/ }).first().boundingBox(), vid: await page.getByRole('button', { name: /^Video/ }).first().boundingBox() };
  const imported = page.locator('[draggable="true"]').filter({ hasText: 'UrZunzet' }).first();
  const provider = row.getByText(/^editor-mixdown$/i).first();
  const favs = await page.getByRole('button', { name: 'FAVS', exact: true }).boundingBox();
  const plays = await page.getByRole('button', { name: 'PLAYS', exact: true }).boundingBox();
  const act0 = await row.getByTitle('Play').first().boundingBox();
  const actN = await row.getByTitle('Delete').first().boundingBox();
  // Open context menu on a lower row so it does not cover the header controls
  await page.mouse.click(1620, 620, { button: 'right' });
  await page.waitForTimeout(1200);
  const menu = page.getByRole('menu').first();
  if (PROBE) { await page.screenshot({ path: '../docs/guides/screenshots/callouts/raw/_probeLibMenu.png' }); console.log(await menu.boundingBox()); }
  const miss = await mark(page, [
    { n: 1, target: { x: b.tabs.x, y: b.tabs.y, width: b.vid.x + b.vid.width - b.tabs.x, height: b.tabs.height }, at: 'bl' },
    { n: 2, target: page.locator('#library-search'), at: 'tl' },
    { n: 3, target: { x: favs.x, y: favs.y, width: plays.x + plays.width - favs.x, height: favs.height }, at: 'bl' },
    { n: 4, target: { x: rb.x, y: rb.y, width: rb.width, height: rb.height }, at: 'tr' },
    { n: 5, target: { x: act0.x, y: act0.y, width: actN.x + actN.width - act0.x, height: act0.height }, at: 'br' },
    { n: 6, target: menu },
    { n: 7, target: provider, at: 'bl' },
    { n: 8, target: row.getByTitle(/Open details/).first(), at: 'bl' },
    { n: 9, target: page.getByRole('button', { name: 'SUGGEST' }), at: 'tr' },
    { n: 10, target: page.getByTitle('Expand to full library'), at: 'tr' },
  ]);
  console.log('lib missing', miss);
  await shot(page, '19-library-catalogue', { title: 'LIBRARY / CATALOGUE', subtitle: 'Browse, organize, route, analyze, and reuse everything stored in theDAW.' });
  await page.keyboard.press('Escape');
  await browser.close();
}

if (ONLY.includes('details')) {
  const { browser, page } = await open();
  await tab(page, 'Make');
  await page.getByTitle('Expand bottom panel').first().click();
  await settle(page, 1500);
  await page.getByRole('button', { name: 'Details', exact: true }).first().click();
  await settle(page, 2000);
  await page.getByRole('button', { name: 'Maximize panel' }).click();
  await settle(page, 2000);
  await page.locator('#details-library-filter').fill('Seamless');
  await settle(page, 1500);
  await page.getByText(/Seamless/).last().click();
  await settle(page, 2000);
  await page.locator('#details-library-filter').fill('');
  await settle(page, 2500);
  const miss = await mark(page, [
    { n: 1, target: { x: 10, y: 92, width: 1190, height: 30 } },
    { n: 2, target: { x: 14, y: 395, width: 1468, height: 52 }, at: 'tr' },
    { n: 3, target: { x: 14, y: 220, width: 730, height: 104 } },
    { n: 4, target: { x: 758, y: 274, width: 725, height: 72 }, at: 'tr' },
    { n: 5, target: { x: 1208, y: 90, width: 277, height: 29 }, at: 'bl' },
    { n: 6, target: { x: 14, y: 810, width: 1468, height: 52 } },
    { n: 7, target: { x: 1504, y: 82, width: 408, height: 22 }, at: 'bl' },
    { n: 8, target: { x: 1504, y: 190, width: 408, height: 780 }, at: 'c' },
  ]);
  console.log('details missing', miss);
  await shot(page, '28-details', { title: 'DETAILS', subtitle: 'Inspect and edit the metadata for the selected Library item.' });
  await browser.close();
}
