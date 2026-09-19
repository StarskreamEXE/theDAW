import { open, settle } from './lib.mjs';
const { browser, page } = await open();
const dump = async (label) => {
  const r = await page.evaluate(() => [...document.querySelectorAll('button,[role=button],[aria-label],input,select,canvas,[role=slider],[title],label')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&b.y<980}).map(e=>{const b=e.getBoundingClientRect();return `${e.tagName} [${e.getAttribute('aria-label')||''}|${(e.getAttribute('title')||'').slice(0,50)}] "${(e.textContent||'').trim().replace(/\s+/g,' ').slice(0,40)}" @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`}));
  console.log('=====', label); console.log(r.join('\n'));
};
await page.getByRole('button', { name: 'Expand bottom panel' }).click();
await settle(page, 1000);
await page.getByRole('button', { name: 'Maximize panel' }).click();
await settle(page, 1000);
const T = {LEVELS:'Master loudness',VISUALIZE:'Live spectrum',MIDI:'Piano roll:',SEQUENCE:'Program drum',DRAW:'Draw to play'};
for (const [t,ti] of Object.entries(T)) {
  await page.locator(`button[title^="${ti}"]`).first().click();
  await settle(page, 1500);
  await dump(t);
  await page.screenshot({path:`../docs/guides/screenshots/callouts/raw/_probeF_${t}.png`});
}
await browser.close();
