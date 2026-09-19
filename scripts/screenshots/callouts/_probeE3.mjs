import { open, settle, tab, ROOT } from './lib.mjs';
import { writeFileSync } from 'node:fs';
const P = ROOT + '/docs/guides/screenshots/callouts/_probeE/';
const { browser, page } = await open();
const dumpAll = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.y<1080}).map(e=>{const r=e.getBoundingClientRect();return `${e.tagName}.${(e.className?.baseVal??e.className??'').toString().slice(0,60)} t=${e.title||''} a=${e.getAttribute('aria-label')||''} d=${JSON.stringify(e.dataset)} txt=${(e.textContent||'').trim().slice(0,30)} @${r.x|0},${r.y|0} ${r.width|0}x${r.height|0}`}).join('\n'), sel);
//SKIPawait tab(page, 'NodeFI');
if(0)for (const n of ['Library','Generate','Effect','Merge / Mix','Output']) { await page.getByRole('button',{name:`Add ${n} node`}).click(); await page.waitForTimeout(700); }
await page.waitForTimeout(1500);
if(0)await page.screenshot({ path: P + 'N3.png' });
if(0)writeFileSync(P+'N3.txt', await dumpAll('main *, [class*=node] , [data-port], [data-handle], svg path'));
if(0){await tab(page, 'Learn');
await page.getByRole('button',{name:'3D graph'}).click(); await page.waitForTimeout(8000);
await page.screenshot({ path: P + 'L3.png' });
writeFileSync(P+'L3.txt', await dumpAll('button,canvas,input,select,[title],[aria-label]'));}
await tab(page, 'Tour');
await page.getByRole('button',{name:'Dismiss guide'}).click().catch(()=>{});
await page.getByPlaceholder('City or region, e.g. Austin, TX').fill('Austin, TX'); await page.getByRole('button',{name:'Search',exact:true}).first().click();
await page.waitForTimeout(12000);
await page.screenshot({ path: P + 'T3.png' });
writeFileSync(P+'T3.txt', await dumpAll('button,input,select,[title],[aria-label]'));
await browser.close();
