import { open, settle, tab, ROOT } from './lib.mjs';
import { writeFileSync } from 'node:fs';
const P = ROOT + '/docs/guides/screenshots/callouts/_probeE/';
const { browser, page } = await open();
const dump = async (name) => {
  await page.screenshot({ path: P + name + '.png' });
  const info = await page.evaluate(() => [...document.querySelectorAll('button,[role=slider],input,select,canvas,iframe,textarea,[title],[aria-label]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.y<1080&&r.y>=0}).map(e=>{const r=e.getBoundingClientRect();return `${e.tagName} t=${e.title||''} a=${e.getAttribute('aria-label')||''} src=${e.getAttribute('src')||''} txt=${(e.textContent||'').trim().slice(0,30)} @${r.x|0},${r.y|0} ${r.width|0}x${r.height|0}`}).join('\n'));
  writeFileSync(P + name + '.txt', info);
};
for (const t of ['Foundry','Underfit','NodeFI','Loom','Learn','Tour']) {
  await tab(page, t); await page.waitForTimeout(6000); await dump(t);
  for (const f of page.frames().slice(1)) {
    const i = await f.evaluate(() => [...document.querySelectorAll('button,input,select,canvas,[title],[aria-label]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0}).map(e=>{const r=e.getBoundingClientRect();return `${e.tagName} t=${e.title||''} a=${e.getAttribute('aria-label')||''} txt=${(e.textContent||'').trim().slice(0,30)} @${r.x|0},${r.y|0} ${r.width|0}x${r.height|0}`}).join('\n')).catch(e=>'ERR '+e);
    writeFileSync(P + t + '_frame_' + encodeURIComponent(f.url()).slice(0,40) + '.txt', f.url()+'\n'+i);
  }
}
await browser.close();
