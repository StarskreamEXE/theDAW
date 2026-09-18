import { open, tab, toggleLibrary, settle } from './lib.mjs';
const { browser, page } = await open();
const dump = async (label) => {
  const r = await page.evaluate(() => [...document.querySelectorAll('button,[role=button],[role=tab],[role=menuitem],input,select,textarea,h2,h3,canvas')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&b.y<1080&&b.y>=0}).map(e=>{const b=e.getBoundingClientRect();return `${e.tagName}#${e.id} [${e.getAttribute('aria-label')||''}] t=${(e.getAttribute('title')||'').slice(0,30)} "${(e.textContent||'').trim().slice(0,30)}" @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`}));
  console.log('=====', label); console.log(r.filter(l=>!/t=(Play|Open details|Send to|Download|Delete|Favorite) ""/.test(l)).join('\n'));
};
await tab(page, 'Make');
await toggleLibrary(page);
await page.getByTitle('Expand to full library').click();
await settle(page, 3000);
await page.locator('[draggable="true"]').filter({ hasText: 'mixdown_357779' }).first().click();
await settle(page, 2000);
await dump('catalogue');
await page.screenshot({path:'../docs/guides/screenshots/callouts/raw/_probeLib.png'});
await page.getByTitle('Expand bottom panel').first().click().catch(e=>console.log(e.message));
await settle(page, 2000);
await dump('bottom');
await page.screenshot({path:'../docs/guides/screenshots/callouts/raw/_probeBottom.png'});
await browser.close();
