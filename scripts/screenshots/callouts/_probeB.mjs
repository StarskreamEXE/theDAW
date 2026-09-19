import { open, tab, toggleLibrary, settle } from './lib.mjs';
const { browser, page } = await open();
const dump = async (label) => {
  const r = await page.evaluate(() => [...document.querySelectorAll('button,[role=button],[role=tab],input,select,textarea,h2,h3')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0}).map(e=>{const b=e.getBoundingClientRect();return `${e.tagName}#${e.id} [${e.getAttribute('aria-label')||''}] t=${(e.getAttribute('title')||'').slice(0,30)} "${(e.textContent||'').trim().slice(0,30)}" @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`}));
  console.log('=====', label); console.log(r.join('\n'));
};
await tab(page, 'Make');
await toggleLibrary(page);
await dump('make+lib');
await page.screenshot({path:'C:/Users/skream/projects/theDAW/docs/guides/screenshots/callouts/raw/_probeB.png'});
await browser.close();
