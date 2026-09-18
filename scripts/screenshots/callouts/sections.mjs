// One screenshot per section of docs/guides/theDAW_Screenshot_Callout_User_Guide.md.
//   cd frontend && node ../scripts/screenshots/callouts/sections.mjs [slug,slug]
// Raw -> docs/guides/screenshots/sections/raw/<slug>.png + .json (title, Purpose)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { open, settle, tab, toggleLibrary, libDropAt, ROOT } from './lib.mjs';

const OUT = resolve(ROOT, 'docs/guides/screenshots/sections/raw');
mkdirSync(OUT, { recursive: true });

// Section headings + Purpose, straight from the guide.
const guide = readFileSync(resolve(ROOT, 'docs/guides/theDAW_Screenshot_Callout_User_Guide.md'), 'utf8');
const purpose = {};
for (const block of guide.split(/\n(?=# )/)) {
  const h = block.match(/^# (.+)/);
  const p = block.match(/\*\*Purpose:\*\* (.+)/);
  if (h && p) purpose[h[1].trim()] = p[1].trim();
}

const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const { browser, page } = await open();
const results = [];

async function shot(slug, heading) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(OUT, `${slug}.png`) });
  writeFileSync(resolve(OUT, `${slug}.json`), JSON.stringify({ title: heading, subtitle: purpose[heading] || '' }, null, 2));
}
const btn = (name, exact = true) => page.getByRole('button', { name, exact }).first();
const click = async (loc, wait = 1500) => { await loc.click({ timeout: 5000 }); await settle(page, wait); };
const dockTab = async (label) => {
  const collapsed = page.getByRole('button', { name: 'Expand bottom panel' });
  if (await collapsed.count()) await click(collapsed);
  const max = page.getByRole('button', { name: 'Maximize panel', exact: true });
  if (await max.count()) await click(max, 1000);
  await click(page.locator('button').filter({ visible: true, hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }).first(), 3000);
};
const collapseDock = async () => {
  await page.getByRole('button', { name: /Collapse bottom panel/i }).first().click({ timeout: 2000 }).catch(() => {});
  await settle(page, 800);
};
const libOpen = async () => { if (!(await page.locator('[draggable="true"]').filter({ visible: true }).count())) await toggleLibrary(page); };
const libClose = async () => { if (await page.locator('[draggable="true"]').filter({ visible: true }).count()) await toggleLibrary(page); };

const sections = [
  ['01-shared-app-shell', 'SHARED APP SHELL', async () => {
    await tab(page, 'Make'); await libOpen();
    await page.locator('[draggable="true"]').filter({ hasText: 'mixdown_357779' }).first().click();
    await dockTab('Visualize');
  }],
  ['02-home', 'HOME', async () => {
    await collapseDock();
    await click(btn('App menu'), 800); await click(page.getByText('Home Screen', { exact: true }), 2000);
  }],
  ['03-make', 'MAKE', async () => {
    await btn('Close home screen').click().catch(() => {}); await settle(page, 800);
    await tab(page, 'Make'); await libOpen();
    await page.locator('textarea').first().fill('warm lo-fi hip hop beat, dusty vinyl drums, mellow Rhodes chords, 85 BPM');
    await page.locator('textarea').nth(1).fill('vocals, distortion, harshness');
    await page.locator('[draggable="true"]').filter({ hasText: 'UrZunzet' }).first().click({ button: 'right' });
    await click(page.getByRole('menuitem', { name: /Send selected to Init/ }), 3000);
    await libDropAt(page, 'Little Kitty', page.getByText(/DROP OR CLICK TO START A CHIMERA/i).first()); await settle(page, 3000);
    await libDropAt(page, 'I Never Knew', page.getByText(/DROP MORE TRACKS HERE/i).first()); await settle(page, 6000);
  }],
  ['04-edit', 'EDIT', async () => {
    await tab(page, 'Edit'); await libOpen();
    const rm = page.locator('button[title="Remove track"]');
    if (await rm.count()) { await rm.first().click({ force: true }); await settle(page, 1000); }
    for (const t of ['mixdown_095087', 'mixdown_573993', 'mixdown_357779']) {
      await libDropAt(page, t, page.getByText('DROP HERE TO CREATE A NEW TRACK').first()); await settle(page, 5000);
    }
    await libClose();
    await page.locator('button[title^="Zoom to fit"]').click().catch(() => {}); await settle(page, 2500);
  }],
  ['05-mix', 'MIX', async () => {
    await tab(page, 'Mix'); await libOpen();
    await libDropAt(page, 'mixdown_357779', page.getByText(/drop audio or click/i).first()); await settle(page, 5000);
    await libClose();
  }],
  ['06-perform', 'PERFORM', async () => { await tab(page, 'Perform'); }],
  ['07-dj', 'DJ', async () => { await tab(page, 'DJ'); await settle(page, 4000); }],
  ['08-vj', 'VJ', async () => { await tab(page, 'VJ'); await page.getByRole('button', { name: 'Play', exact: true }).last().click().catch(() => {}); await page.waitForTimeout(20000); await settle(page, 2000); }],
  ['09-sway-main-workspace', 'SWAY — MAIN WORKSPACE', async () => { await tab(page, 'Sway'); await page.waitForTimeout(5000); }],
  ['10-foundry', 'FOUNDRY', async () => { await tab(page, 'Foundry'); await page.waitForTimeout(8000); }],
  ['11-underfit', 'UNDERFIT', async () => { await tab(page, 'Underfit'); await page.waitForTimeout(5000); }],
  ['12-nodefi', 'NODEFI', async () => { await tab(page, 'NodeFI'); await page.waitForTimeout(3000); }],
  ['13-loom', 'LOOM', async () => { await tab(page, 'Loom'); await page.waitForTimeout(4000); }],
  ['14-learn', 'LEARN', async () => {
    await tab(page, 'Learn');
    await page.getByRole('button', { name: /3D/ }).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(8000);
  }],
  ['15-tour', 'TOUR', async () => { await tab(page, 'Tour'); await page.waitForTimeout(6000); }],
  ['16-library-catalogue', 'LIBRARY / CATALOGUE', async () => {
    await tab(page, 'Make'); await libOpen();
    await page.locator('button[title="Expand to full library"]').filter({ visible: true }).first().click({ timeout: 8000 });
    await settle(page, 3000);
  }],
  ['17-levels', 'LEVELS', async () => {
    await page.keyboard.press('Escape'); await settle(page, 800);
    await tab(page, 'Make'); await libOpen();
    await libClose();
    await page.getByRole('button', { name: 'Play', exact: true }).last().click().catch(() => {});
    await dockTab('Levels'); await page.waitForTimeout(5000);
  }],
  ['18-visualize', 'VISUALIZE', async () => {
    await dockTab('Visualize'); await page.locator('button[title="Spectrum"]').first().click().catch(() => {}); await page.waitForTimeout(3000);
  }],
  ['19-midi-piano-roll', 'MIDI / PIANO ROLL', async () => { await dockTab('MIDI'); }],
  ['20-sequence', 'SEQUENCE', async () => {
    await dockTab('Sequence');
    await page.locator('button[title="Randomize all step patterns"]').click().catch(() => {}); await settle(page, 1000);
  }],
  ['21-draw', 'DRAW', async () => {
    await dockTab('Draw');
    const c = page.locator('canvas').filter({ visible: true }).last(); const b = await c.boundingBox();
    if (b) { await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.6); await page.mouse.down();
      for (let i = 0; i <= 30; i++) await page.mouse.move(b.x + b.width * (0.2 + i * 0.02), b.y + b.height * (0.5 + 0.25 * Math.sin(i / 4)));
      await page.mouse.up(); }
    await settle(page, 1500);
  }],
  ['22-score', 'SCORE', async () => {
    await page.getByRole('button', { name: 'Restore panel', exact: true }).click().catch(() => {}); await collapseDock();
    await libOpen(); await page.locator('[draggable="true"]').filter({ visible: true, hasText: 'UrZunzet' }).first().click({ timeout: 8000 }).catch(() => {}); await libClose();
    await dockTab('Score'); await page.waitForTimeout(4000);
  }],
  ['23-sing', 'SING', async () => { await dockTab('Sing'); await page.waitForTimeout(4000); }],
  ['24-lyric', 'LYRIC', async () => { await dockTab('Lyric'); }],
  ['25-details', 'DETAILS', async () => { await dockTab('Details'); }],
  ['26-slide', 'SLIDE', async () => { await dockTab('Slide'); }],
  ['27-sway-bottom-panel', 'SWAY — BOTTOM PANEL', async () => { await tab(page, 'VJ'); await dockTab('Sway'); await page.waitForTimeout(4000); }],
  ['28-app-menu', 'APP MENU', async () => { await page.getByRole('button', { name: 'Restore panel', exact: true }).click().catch(() => {}); await collapseDock(); await click(btn('App menu'), 1500); }],
  ['29-settings-models', 'SETTINGS — MODELS', async () => {
    await click(page.getByText('Settings', { exact: true }), 5000);
  }],
  ['30-processing-log', 'PROCESSING LOG', async () => {
    await btn('Close settings').click().catch(() => page.keyboard.press('Escape')); await settle(page, 800);
    await click(btn('Expand log'), 2000);
  }],
];

for (const [slug, heading, prep] of sections) {
  if (only && !only.has(slug)) continue;
  try { await prep(); await settle(page, 1500); await shot(slug, heading); results.push([slug, 'ok']); }
  catch (e) { results.push([slug, 'FAIL ' + String(e.message).split('\n')[0]]); await page.keyboard.press('Escape').catch(() => {}); }
  console.log(results.at(-1).join('  '));
}

if (!only || only.has('31-mobile-companion')) {
  try {
    const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await m.goto(new URL('mobile.html', process.env.THEDAW_URL || 'http://127.0.0.1:5173/').href, { waitUntil: 'domcontentloaded' });
    await m.waitForTimeout(5000);
    await m.locator('.m-tab', { hasText: 'Remote' }).click().catch(() => {});
    await m.waitForTimeout(2500);
    await m.screenshot({ path: resolve(OUT, '31-mobile-companion.png') });
    writeFileSync(resolve(OUT, '31-mobile-companion.json'), JSON.stringify({ title: 'MOBILE COMPANION', subtitle: purpose['MOBILE COMPANION'] || '' }, null, 2));
    console.log('31-mobile-companion  ok');
  } catch (e) { console.log('31-mobile-companion  FAIL', e.message); }
}
await browser.close();
