import { open, settle, tab } from './lib.mjs';
const { browser, page } = await open();
const dump = async (label) => {
  const r = await page.evaluate(() => [...document.querySelectorAll('button,[role=button],[aria-label],input,select,iframe,canvas,video,h1,h2,h3,[role=slider]')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0}).map(e=>{const b=e.getBoundingClientRect();return `${e.tagName} [${e.getAttribute('aria-label')||''}]${e.tagName==='IFRAME'?' src='+e.src:''} "${(e.textContent||'').trim().replace(/\s+/g,' ').slice(0,40)}" @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`}));
  console.log('=====', label); console.log(r.join('\n'));
};
for (const t of (process.argv[2]||'Perform,DJ,VJ,Sway').split(',')) {
  try { await tab(page, t); } catch(e) { console.log('TAB FAIL', t, e.message); await dump('top'); continue; }
  await settle(page, 6000);
  await dump(t);
  await page.screenshot({path:`../docs/guides/screenshots/callouts/raw/_probeD_${t}.png`});
}
await browser.close();
