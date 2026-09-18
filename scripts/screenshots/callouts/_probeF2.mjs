import { open, settle, toggleLibrary } from './lib.mjs';
const { browser, page } = await open();
await toggleLibrary(page);
const r = await page.evaluate(() => [...document.querySelectorAll('[draggable="true"]')].filter(e=>/mixdown_357779|mixdown_095087/.test(e.textContent)).slice(0,2).map(row => [...row.querySelectorAll('button,[role=button]')].map(b=>{const x=b.getBoundingClientRect();return `[${b.getAttribute('aria-label')}|${b.getAttribute('title')}] "${b.textContent.trim().slice(0,20)}" @${Math.round(x.x)},${Math.round(x.y)}`}).join('\n')));
console.log(r.join('\n----\n'));
await page.screenshot({path:'../docs/guides/screenshots/callouts/raw/_probeF2.png'});
await browser.close();
