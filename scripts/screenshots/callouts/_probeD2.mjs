import { open, settle, tab } from './lib.mjs';
const { browser, page } = await open();
await tab(page, 'DJ');
const search = page.getByPlaceholder(/search/i).last();
for (const [q, d] of [['mixdown_357779','A'],['mixdown_095087','B']]) {
  await search.fill(q); await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '→'+d, exact: true }).first().click();
  await page.waitForTimeout(4000);
}
await search.fill('');
await settle(page, 8000);
const r = await page.evaluate(() => [...document.querySelectorAll('[title],[aria-label]')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&b.y<990}).map(e=>{const b=e.getBoundingClientRect();return `${e.tagName} t=[${(e.getAttribute('title')||'').slice(0,60)}] a=[${e.getAttribute('aria-label')||''}] "${(e.textContent||'').trim().slice(0,20)}" @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`}));
console.log(r.join('\n'));
await page.screenshot({path:'../docs/guides/screenshots/callouts/raw/_probeD_DJ2.png'});
await browser.close();
