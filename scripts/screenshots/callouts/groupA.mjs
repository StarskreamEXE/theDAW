// Group A: SHARED APP SHELL, HOME, APP MENU, SETTINGS — MODELS, PROCESSING LOG, MOBILE COMPANION.
// Run from frontend/: node ../scripts/screenshots/callouts/groupA.mjs [slug ...]
import { open, settle, mark, shot, toggleLibrary } from './lib.mjs';

const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
const { browser, page } = await open();
const rectOf = async (loc) => loc.first().boundingBox();
const union = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

// ---------- 01 SHARED APP SHELL ----------
if (want('01-shared-app-shell')) {
  await toggleLibrary(page);
  const row = page.locator('[draggable="true"]').first();
  await row.click({ timeout: 5000 }).catch((e) => console.log('row click failed', e.message));
  await settle(page, 2000);
  const tabs = union(await rectOf(page.getByRole('button', { name: 'Make', exact: true })), await rectOf(page.getByRole('button', { name: 'Tour', exact: true })));
  const rail = await page.evaluate(() => {
    let e = document.querySelector('[draggable="true"]');
    while (e && e.getBoundingClientRect().height < 600) e = e.parentElement;
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  const miss = await mark(page, [
    { n: 1, target: tabs },
    { n: 2, target: page.getByRole('button', { name: 'Open mobile access QR/link' }), at: 'bl' },
    { n: 3, target: page.getByRole('button', { name: 'Find a feature, or open the docs' }), at: 'bl' },
    { n: 4, target: page.getByRole('button', { name: 'Import', exact: true }), at: 'bl' },
    { n: 5, target: page.getByRole('button', { name: 'App menu' }), at: 'bl' },
    { n: 6, target: rail, at: 'tl' },
    { n: 7, target: page.getByRole('button', { name: 'Expand bottom panel' }), at: 'c' },
    { n: 8, target: page.getByRole('button', { name: 'Play', exact: true }), at: 'tl' },
    { n: 9, target: page.locator('[aria-label="Toggle orb panel"]'), at: 'tr' },
  ]);
  console.log('01 missing', miss);
  await shot(page, '01-shared-app-shell', { title: 'SHARED APP SHELL', subtitle: 'Explain the controls that remain available while the user moves between tabs.' });
  await toggleLibrary(page);
}

// ---------- 31 APP MENU ----------
if (want('31-app-menu')) {
  await page.getByRole('button', { name: 'App menu' }).click();
  await page.waitForTimeout(800);
  const heads = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && /^(project|data|devices|app|help|support)$/i.test(e.textContent.trim()) && e.getBoundingClientRect().x > 1500)
      .map((h) => ({ t: h.textContent.trim().toLowerCase(), y: h.getBoundingClientRect().y })),
  );
  console.log(heads);
  const ys = Object.fromEntries(heads.map((m) => [m.t, m.y]));
  const grp = (a, b) => ({ x: 1666, y: ys[a] - 4, width: 236, height: ys[b] - ys[a] - 4 });
  const miss = await mark(page, [
    { n: 1, target: grp('project', 'data') },
    { n: 2, target: grp('data', 'devices') },
    { n: 3, target: grp('devices', 'app') },
    { n: 4, target: grp('app', 'help') },
    { n: 5, target: grp('help', 'support') },
    { n: 6, target: page.getByText('Edit Layout', { exact: true }), at: 'tr', box: false },
  ]);
  console.log('31 missing', miss);
  await shot(page, '31-app-menu', { title: 'APP MENU', subtitle: 'Collect project, maintenance, device, appearance, settings, and help actions in one place.' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

// ---------- 02 HOME ----------
if (want('02-home')) {
  await page.getByRole('button', { name: 'App menu' }).click();
  await page.waitForTimeout(600);
  await page.getByText('Home Screen', { exact: true }).click();
  await settle(page, 2000);
  const cards = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('[aria-label^="Open the "][aria-label$=" workspace"]')].map((e) => e.getBoundingClientRect());
    const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
    return { x, y, width: Math.max(...bs.map((b) => b.right)) - x, height: Math.max(...bs.map((b) => b.bottom)) - y };
  });
  const miss = await mark(page, [
    { n: 1, target: cards },
    { n: 2, target: page.getByRole('button', { name: 'Open a project file' }) },
    { n: 3, target: page.getByRole('button', { name: 'Import audio' }) },
    { n: 4, target: page.getByRole('button', { name: 'Start the feature tour' }), at: 'tr' },
    { n: 5, target: page.locator('label[for="home-show-at-startup"]'), at: 'tr' },
    { n: 6, target: page.getByRole('button', { name: 'Close home screen' }), at: 'bl' },
  ]);
  console.log('02 missing', miss);
  await shot(page, '02-home', { title: 'HOME', subtitle: 'Give new users a simple starting point before they enter the deeper workspaces.' });
  await page.getByRole('button', { name: 'Close home screen' }).click();
  await page.waitForTimeout(800);
}

// ---------- 33 PROCESSING LOG ----------
if (want('33-processing-log')) {
  await page.getByRole('button', { name: 'Expand log' }).click();
  await settle(page, 4000);
  const body = page.locator('.log-scroll');
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
  const sev = page.locator('.log-scroll p[class*="border-red-500"], .log-scroll p[class*="border-amber-500"]');
  const nSev = await sev.count();
  const rep = page.locator('.log-scroll p span.text-zinc-600').filter({ hasText: /x\d+/ });
  const nRep = await rep.count();
  console.log('warn/error rows', nSev, 'repeat rows', nRep);
  const target = nSev ? sev.last() : nRep ? rep.last() : null;
  if (target) await target.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const bodyBox = await body.boundingBox();
  let sevBox = nSev ? await sev.last().boundingBox() : null;
  if (!sevBox) { const ps = body.locator('p'); for (let i = 0; i < await ps.count(); i++) { const r = await ps.nth(i).boundingBox(); if (r && r.y > bodyBox.y + 20) { sevBox = r; break; } } }
  const miss = await mark(page, [
    { n: 1, target: body, at: 'bl' },
    { n: 2, target: sevBox ? { x: sevBox.x - 1, y: sevBox.y, width: 5, height: sevBox.height } : null, at: 'tl' },
    { n: 3, target: page.getByRole('button', { name: 'Toggle verbose log' }), at: 'bl' },
    { n: 4, target: await (async () => { const bb = await body.boundingBox(); for (let i = nRep - 1; i >= 0; i--) { const r = await rep.nth(i).boundingBox(); if (r && r.y > bb.y && r.y + r.height < bb.y + bb.height) return r; } return null; })(), at: 'tr' },
    { n: 5, target: page.getByRole('button', { name: 'Download log' }), at: 'tl' },
    { n: 6, target: page.getByRole('button', { name: 'Clear log' }), at: 'bl' },
    { n: 6, target: page.getByRole('button', { name: 'Collapse log' }), at: 'c' },
  ]);
  console.log('33 missing', miss);
  await shot(page, '33-processing-log', { title: 'PROCESSING LOG', subtitle: 'Show what theDAW is doing and provide useful error information.' });
  await page.getByRole('button', { name: 'Collapse log' }).click();
  await page.waitForTimeout(600);
}

// ---------- 32 SETTINGS — MODELS ----------
if (want('32-settings-models')) {
  await page.getByRole('button', { name: 'App menu' }).click();
  await page.waitForTimeout(600);
  await page.getByText('Settings', { exact: true }).click();
  await settle(page, 3000);
  const add = page.locator('button[aria-controls="settings-add-checkpoint"]');
  await add.click();
  await page.waitForTimeout(800);
  const cardOf = async (name) => page.getByText(name, { exact: true }).filter({ visible: true }).and(page.locator(':left-of(:text("Inputs & Outputs"))')).first().evaluate((t) => {
    let e = t; while (e.parentElement && e.parentElement.getBoundingClientRect().height < 260 && e.parentElement.getBoundingClientRect().width < 320) e = e.parentElement;
    const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height };
  }).catch(() => null);
  let engines = null;
  for (const n of ['Magenta RT2', 'Suno API', 'Demucs / Stems', 'MIDI Engines']) engines = union(engines, await cardOf(n));
  const storage = await page.evaluate(() => {
    const h = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim().toLowerCase() === 'storage');
    let e = h;
    while (e && e.parentElement && !/modules/i.test(e.parentElement.textContent)) e = e.parentElement;
    const b = e?.getBoundingClientRect();
    return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  });
  const hfRow = page.getByText(/Hugging Face/i).filter({ visible: true }).first().locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
  const miss = await mark(page, [
    { n: 1, target: page.locator('button[aria-pressed]').filter({ hasText: 'Download' }), at: 'tl' },
    { n: 2, target: await cardOf('Stable Audio 3'), at: 'tl' },
    { n: 3, target: engines, at: 'tr' },
    { n: 4, target: add, at: 'tr' },
    { n: 5, target: page.locator('#settings-add-checkpoint').getByRole('button', { name: 'Add', exact: true }), at: 'tr' },
    { n: 6, target: storage, at: 'tl' },
    { n: 7, target: hfRow, at: 'tr' },
    { n: 8, target: page.getByText(/loaded and ready/i).first(), at: 'bl' },
  ]);
  console.log('32 missing', miss);
  await shot(page, '32-settings-models', { title: 'SETTINGS — MODELS', subtitle: 'Show whether the main engines are ready and control where models come from.' });
  await add.click();
  await page.getByRole('button', { name: 'Close settings' }).click().catch(() => {});
}

// ---------- 34 MOBILE COMPANION ----------
if (want('34-mobile-companion')) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const m = await ctx.newPage();
  await m.goto(new URL('mobile.html', process.env.THEDAW_URL || 'http://127.0.0.1:5173/').href, { waitUntil: 'domcontentloaded' });
  await settle(m, 3000);
  await m.locator('.m-tab', { hasText: 'Remote' }).click();
  await settle(m, 2500);
  const tabBtn = (t) => m.locator('.m-tab').filter({ hasText: new RegExp(`^${t}$`) });
  const miss = await mark(m, [
    { n: 1, target: m.locator('.m-dot'), at: 'bl' },
    { n: 2, target: tabBtn('Make'), at: 'tl' },
    { n: 3, target: tabBtn('Remote'), at: 'tl' },
    { n: 4, target: tabBtn('DJ'), at: 'tl' },
    { n: 5, target: tabBtn('Library'), at: 'tl' },
  ]);
  console.log('34 missing', miss, 'status', await m.locator('.m-dot').textContent());
  await shot(m, '34-mobile-companion', { title: 'MOBILE COMPANION', subtitle: 'Control selected parts of theDAW from a phone without loading the full desktop application.' });
  await ctx.close();
}

await browser.close();
