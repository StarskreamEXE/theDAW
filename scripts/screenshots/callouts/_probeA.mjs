import { open, settle } from './lib.mjs';
const { browser, page } = await open();
const P='../docs/guides/screenshots/callouts/raw/';
const dump = async (sel) => console.log((await page.evaluate((sel) => [...document.querySelectorAll(sel+' button,'+sel+' input,'+sel+' select,'+sel+' h2,'+sel+' h3,'+sel+' h4,'+sel+' [role=switch]')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0}).map(e=>{const b=e.getBoundingClientRect();return `${e.tagName} [${e.getAttribute('aria-label')||''}] t=${(e.getAttribute('title')||'').slice(0,30)} "${(e.textContent||'').trim().slice(0,40)}" @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`}), sel)).join('\n'));
// log
await page.getByRole('button', { name: 'Expand log' }).click(); await settle(page, 1000);
await page.screenshot({path:P+'_probe_log.png'});
console.log('==LOG'); await dump('body');
await page.keyboard.press('Escape');
// settings
await page.getByRole('button', { name: 'App menu' }).click(); await page.waitForTimeout(500);
await page.getByText('Settings', {exact:true}).click(); await settle(page, 2000);
await page.getByRole('button', {name: /^Models/}).first().click().catch(e=>console.log('nomodels nav'));
await settle(page, 2500);
await page.screenshot({path:P+'_probe_settings.png'});
console.log('==SETTINGS'); await dump('[role=dialog]');
await browser.close();
