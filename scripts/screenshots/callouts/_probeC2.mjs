import { open, settle, tab, toggleLibrary, libDropAt, ROOT } from './lib.mjs';
import { writeFileSync } from 'node:fs';
const P = ROOT + '/docs/guides/screenshots/callouts/_probeC/';
const dump = async (f) => writeFileSync(P + f, await page.evaluate(() => [...document.querySelectorAll('button,[role=slider],input,select,canvas,svg,[title],[aria-label]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.y<1080&&r.y>60&&r.y<980}).map(e=>{const r=e.getBoundingClientRect();return `${e.tagName} t=${(e.getAttribute('title')||'').slice(0,60)} a=${e.getAttribute('aria-label')||''} txt=${(e.textContent||'').trim().slice(0,30)} @${r.x|0},${r.y|0} ${r.width|0}x${r.height|0}`}).join('\n')));
const { browser, page } = await open();
await tab(page, 'Edit');
await page.locator('button[title="Remove track"]').first().click().catch(e=>console.log('rm fail'));
await toggleLibrary(page);
for (const t of ['mixdown_095087','mixdown_357779','UrZunzet']) {
  await libDropAt(page, t, page.getByText('DROP HERE TO CREATE A NEW TRACK').first());
  await settle(page, 2500);
}
await toggleLibrary(page);
await page.getByTitle('Zoom to fit the whole arrangement (Shift+F)').click();
for(let i=0;i<3;i++){await page.getByTitle('Zoom in (+)').click();await page.waitForTimeout(400);}
await settle(page, 1500);
// automation record on track 1 volume
await page.getByLabel('Automation write').click();
await page.getByTitle('Play from playhead (Space)').click();
await page.waitForTimeout(800);
const vol = page.getByLabel('mixdown_095087.wav volume');
const vb = await vol.boundingBox();
await page.mouse.move(vb.x + vb.width*0.8, vb.y + vb.height/2); await page.mouse.down();
for (let i=0;i<70;i++){ await page.mouse.move(vb.x + vb.width*(0.5+0.4*Math.sin(i/4)), vb.y+vb.height/2); await page.waitForTimeout(120); }
await page.mouse.up();
await page.getByTitle('Stop and return to start').click();
await page.getByLabel('Automation write').click();
await settle(page, 1000);
await page.screenshot({ path: P + 'e1.png' });
// cut clips
await page.getByTitle('Cut tool: click a clip to split it at that point').click();
await page.mouse.click(1500, 440); await page.waitForTimeout(500);
await page.mouse.click(1100, 210); await page.waitForTimeout(500);
await page.getByTitle('Move tool: drag clips').click();
// fade in on clip 2
const fi = page.getByTitle('Fade in — drag right').nth(1);
const fb = await fi.boundingBox();
await page.mouse.move(fb.x+4, fb.y+40); await page.mouse.down(); await page.mouse.move(fb.x+120, fb.y+40, {steps:10}); await page.mouse.up();
await settle(page, 1000);
await page.screenshot({ path: P + 'e2.png' });
await dump('e2.txt');
// select region on track 2 & inpaint
await page.mouse.move(900, 330); await page.mouse.down(); await page.mouse.move(1250, 330, {steps:10}); await page.mouse.up();
await page.waitForTimeout(500);
await page.getByTitle('Inpaint selected region (Ctrl+P)').click();
await settle(page, 1000);
await page.screenshot({ path: P + 'e3.png' });
await dump('e3.txt');
await browser.close();
