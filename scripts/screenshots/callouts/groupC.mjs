// Group C: 05-edit, 06-edit-fx-rack, 07-mix
import { open, settle, tab, toggleLibrary, libDropAt, mark, shot, ROOT } from './lib.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const P = ROOT + '/docs/guides/screenshots/callouts/_probeC/'; mkdirSync(P, { recursive: true });
const STAGE = process.env.STAGE || 'all';
const EDIT_T = 'EDIT', EDIT_S = 'Arrange audio on a multitrack timeline, repair sections, apply effects, automate controls, and render a finished arrangement.';
const { browser, page } = await open();
const dump = async (f) => writeFileSync(P + f, await page.evaluate(() => [...document.querySelectorAll('button,[role=slider],input,select,canvas,[title],[aria-label],[draggable=true]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.y<980&&r.y>50}).map(e=>{const r=e.getBoundingClientRect();return `${e.tagName} t=${(e.getAttribute('title')||'').slice(0,60)} a=${e.getAttribute('aria-label')||''} txt=${(e.textContent||'').trim().slice(0,40)} @${r.x|0},${r.y|0} ${r.width|0}x${r.height|0}`}).join('\n')));
const rect = (x, y, width, height) => ({ x, y, width, height });

if (STAGE === 'all' || STAGE === 'edit') {
  await tab(page, 'Edit');
  await page.locator('button[title="Remove track"]').first().click().catch(() => console.log('rm fail'));
  await toggleLibrary(page);
  for (const t of ['mixdown_095087', 'mixdown_357779', 'UrZunzet']) {
    await libDropAt(page, t, page.getByText('DROP HERE TO CREATE A NEW TRACK').first());
    await settle(page, 2500);
  }
  await toggleLibrary(page);
  await page.getByTitle('Zoom to fit the whole arrangement (Shift+F)').click();
  for (let i = 0; i < 3; i++) { await page.getByTitle('Zoom in (+)').click(); await page.waitForTimeout(400); }
  await settle(page, 1500);
  // record automation on track 1 volume
  await page.getByLabel('Automation write').click();
  await page.getByTitle('Play from playhead (Space)').click();
  await page.waitForTimeout(600);
  const vb = await page.getByLabel('mixdown_095087.wav volume').boundingBox();
  await page.mouse.move(vb.x + vb.width * 0.8, vb.y + vb.height / 2); await page.mouse.down();
  for (let i = 0; i < 70; i++) { await page.mouse.move(vb.x + vb.width * (0.5 + 0.4 * Math.sin(i / 4)), vb.y + vb.height / 2); await page.waitForTimeout(120); }
  await page.mouse.up();
  await page.getByTitle('Stop and return to start').click();
  await page.getByLabel('Automation write').click();
  await settle(page, 1000);
  // splits
  await page.getByTitle('Cut tool: click a clip to split it at that point').click();
  await page.mouse.click(1500, 440); await page.waitForTimeout(500);
  await page.mouse.click(1100, 210); await page.waitForTimeout(500);
  await page.getByTitle('Move tool: drag clips').click();
  // fade-in on the second part of track 1
  const fb = await page.getByTitle('Fade in — drag right').nth(1).boundingBox();
  await page.mouse.move(fb.x + 4, fb.y + 40); await page.mouse.down(); await page.mouse.move(fb.x + 120, fb.y + 40, { steps: 10 }); await page.mouse.up();
  await settle(page, 800);
  // region selection on track 2 + inpaint panel
  await page.mouse.move(900, 330); await page.mouse.down(); await page.mouse.move(1250, 330, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(500);
  await page.getByTitle('Inpaint selected region (Ctrl+P)').click();
  await settle(page, 1000);
  await page.screenshot({ path: P + 'edit.png' }); await dump('edit.txt');
  {
    const miss = await mark(page, [
      { n: 1, target: page.locator('button[aria-label="Add track"]') },
      { n: 2, target: rect(38, 77, 590, 28) },
      { n: 3, target: rect(28, 143, 197, 114) },
      { n: 4, target: rect(420, 400, 600, 72), at: 'c' },
      { n: 5, target: rect(1100, 166, 125, 80) },
      { n: 6, target: rect(227, 118, 1350, 22), at: 'c' },
      { n: 7, target: rect(232, 150, 480, 98), at: 'bl' },
      { n: 8, target: rect(1588, 132, 312, 228) },
      { n: 9, target: page.locator('button[aria-label="Master FX"]') },
      { n: 10, target: page.locator('button[title^="Render all clips"]'), at: 'bl' },
    ]);
    console.log('05-edit missing', miss);
    await shot(page, '05-edit', { title: EDIT_T, subtitle: EDIT_S });
  }
}
if (STAGE === 'all' || STAGE === 'fx') {
  await page.getByPlaceholder('Describe what to generate in this region…').locator('xpath=ancestor::div[.//button][1]').locator('button').first().click().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  await page.locator('[aria-label$="insert FX"]').first().click();
  await settle(page, 800);
  for (const fx of ['Parametric EQ', 'Compressor', 'Reverb']) {
    await page.locator('select').filter({ hasText: '+ Add effect' }).first().selectOption({ label: fx }).catch((e) => console.log('add fail', fx, e.message.slice(0, 80)));
    await settle(page, 800);
  }
  await page.screenshot({ path: P + 'fx1.png' }); await dump('fx1.txt');
  {
    await page.getByTitle('Open Compressor controls').click().catch((e) => console.log('fxwin', e.message.slice(0, 80)));
    await settle(page, 1000);
    const hb = await page.locator('[aria-label="Compressor controls"]').boundingBox();
    await page.mouse.move(hb.x + 120, hb.y + 25); await page.mouse.down();
    await page.mouse.move(hb.x + 120 + (600 - hb.x), hb.y + 25, { steps: 12 }); await page.mouse.up();
    await settle(page, 800);
    const wb = await page.locator('[aria-label="Compressor controls"]').boundingBox();
    const rows = await page.locator('button[aria-label="Bypass Parametric EQ"]').boundingBox();
    const miss = await mark(page, [
      { n: 1, target: page.locator('select[aria-label="Add effect"]').filter({ visible: true }).first() },
      { n: 2, target: rect(rows.x - 4, rows.y - 6, 330, 84), at: 'tr' },
      { n: 3, target: page.locator('button[aria-label="Bypass Parametric EQ"]'), at: 'bl' },
      { n: 4, target: wb, at: 'tr' },
      { n: 5, target: page.locator('[aria-label="Compressor controls"] section[aria-label="Detector"]') },
    ]);
    console.log('06 missing', miss, JSON.stringify(wb));
    await shot(page, '06-edit-fx-rack', { title: 'EDIT — FX RACK CLOSE-UP', subtitle: EDIT_S }, { x: 170, y: 60, width: Math.min(1750, wb.x + wb.width + 40) - 170, height: Math.max(360, wb.y + wb.height + 30) - 60 });
  }
}
if (STAGE === 'all' || STAGE === 'mix') {
  await tab(page, 'Mix');
  await toggleLibrary(page);
  await libDropAt(page, 'mixdown_095087', page.getByText('drop audio or click').first());
  await settle(page, 3000);
  await toggleLibrary(page);
  await page.getByRole('button', { name: /^Dynamics\d/ }).click(); await settle(page, 800);
  const tiles = page.locator('div[title][style*="width: 90px"]').filter({ visible: true });
  for (let i = 0; i < 3; i++) { await tiles.nth(i).click().catch((e) => console.log('tile', i, e.message.slice(0, 60))); await settle(page, 800); }
  await page.screenshot({ path: P + 'mix2.png' }); await dump('mix2.txt');
  const miss = await mark(page, [
    { n: 1, target: rect(26, 65, 1400, 77), at: 'c' },
    { n: 2, target: rect(1440, 74, 296, 18), at: 'bl' },
    { n: 3, target: rect(31, 219, 308, 348) },
    { n: 4, target: rect(1545, 200, 340, 760) },
    { n: 5, target: rect(31, 765, 308, 200) },
    { n: 6, target: rect(368, 240, 1156, 90) },
    { n: 7, target: page.locator('#mix-output-format') },
    { n: 8, target: page.getByTitle('Process audio'), at: 'tl' },
    { n: 9, target: rect(26, 150, 1867, 26), at: 'c' },
    { n: 10, target: page.locator('button[title="Process history"]'), at: 'tr' },
  ]);
  console.log('07 missing', miss);
  await shot(page, '07-mix', { title: 'MIX', subtitle: 'Process and master one audio file through an ordered effect chain.' });
}
await browser.close();
