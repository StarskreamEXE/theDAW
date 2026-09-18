import { open, settle, tab, toggleLibrary, libDropAt, ROOT } from './lib.mjs';
import { writeFileSync } from 'node:fs';
const P = ROOT + '/docs/guides/screenshots/callouts/_probeC/';
const { browser, page } = await open();
await tab(page, 'Edit');
await page.locator('button[title="Remove track"]').first().click().catch(e=>console.log('rm fail'));
await toggleLibrary(page);
for (const t of ['mixdown_095087','mixdown_357779','UrZunzet']) {
  await libDropAt(page, t, page.getByText('DROP HERE TO CREATE A NEW TRACK').first());
  await settle(page, 2500);
}
await toggleLibrary(page);
await page.getByTitle('Zoom to fit the whole arrangement (Shift+F)').click().catch(()=>console.log('nofit'));
await settle(page, 2500);
await page.screenshot({ path: P + 'edit0.png' });
const info = await page.evaluate(() => [...document.querySelectorAll('button,[role=slider],input,select,canvas,[title],[aria-label]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.y<1080}).map(e=>{const r=e.getBoundingClientRect();return `${e.tagName} t=${e.title||''} a=${e.getAttribute('aria-label')||''} txt=${(e.textContent||'').trim().slice(0,30)} @${r.x|0},${r.y|0} ${r.width|0}x${r.height|0}`}).join('\n'));
writeFileSync(P + 'edit0.txt', info);
await browser.close();
