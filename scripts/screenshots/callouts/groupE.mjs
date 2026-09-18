// Group E: FOUNDRY, UNDERFIT, NODEFI, LOOM, LEARN, TOUR.
// cd frontend && node ../scripts/screenshots/callouts/groupE.mjs [foundry underfit nodefi loom learn tour]
import { open, settle, tab, mark, shot, ROOT } from './lib.mjs';
const want = new Set(process.argv.slice(2));
const on = (k) => want.size === 0 || want.has(k);
const DBG = ROOT + '/docs/guides/screenshots/callouts/_probeE/';
const R = (x, y, width, height) => ({ x, y, width, height });
const union = async (locs) => {
  const bs = (await Promise.all(locs.map((l) => l.first().boundingBox().catch(() => null)))).filter(Boolean);
  if (!bs.length) return null;
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return R(x, y, Math.max(...bs.map((b) => b.x + b.width)) - x, Math.max(...bs.map((b) => b.y + b.height)) - y);
};
const report = (slug, miss) => console.log(slug, 'missing:', JSON.stringify(miss));
const { browser, page } = await open();

if (on('foundry')) {
  await tab(page, 'Foundry'); await page.waitForTimeout(5000);
  const fr = page.frameLocator('iframe[title="VST Foundry"]');
  // DOM clicks only: the iframe is scaled, so mouse coordinates land on the wrong control.
  for (let i = 0; i < 6 && !(await fr.getByTitle('View Knobs elements').count()); i++) {
    await page.waitForTimeout(2000);
    if (await fr.getByTitle('View Knobs elements').count()) break;
    await fr.getByTitle('Toggle between editing and interacting with your UI').first().evaluate((e) => e.click());
    await page.waitForTimeout(2500);
  }
  const ifr = await page.locator('iframe[title="VST Foundry"]').boundingBox();
  const fw = await fr.locator('body').evaluate(() => innerWidth);
  const sc = ifr.width / fw;
  // map in-frame client rects to page coordinates (the iframe content is scaled)
  const fb = async (loc) => {
    const r = await loc.first().evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }).catch(() => null);
    return r ? R(ifr.x + r.x * sc, ifr.y + r.y * sc, r.w * sc, r.h * sc) : null;
  };
  const fu = async (a, b) => { const A = await fb(a), B = await fb(b); if (!A || !B) return A || B; const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y); return R(x, y, Math.max(A.x + A.width, B.x + B.width) - x, Math.max(A.y + A.height, B.y + B.height) - y); };
  await fr.locator('[aria-label="Add to Cart Button"]').first().evaluate((e) => {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) e.dispatchEvent(new MouseEvent(t, { bubbles: true }));
  });
  await page.waitForTimeout(1500);
  const canvas = await fb(fr.locator('svg[aria-label="Canvas annotations"]'));
  const miss = await mark(page, [
    { n: 1, target: R(1180, 830, 10, 10), box: false, at: 'c' },
    { n: 2, target: await fu(fr.getByTitle('View Knobs elements'), fr.getByTitle('A knob encircled by a glowing LED indicator ring.')) },
    { n: 3, target: await fb(fr.locator('[aria-label="Add to Cart Button"]')), at: 'tr' },
    { n: 4, target: await fu(fr.getByText('Properties', { exact: true }), fr.getByTitle('Center on Canvas')) },
    { n: 5, target: await fb(fr.getByTitle('Toggle between editing and interacting with your UI')) },
    { n: 6, target: await fu(fr.getByTitle('Export Full Package (ZIP)'), fr.getByTitle('Export Layout to React/TSX or JSON')) },
    { n: 7, target: page.getByRole('button', { name: 'Open VST Foundry in a new window' }), at: 'bl' },
  ]);
  report('13-foundry', miss);
  await shot(page, '13-foundry', { title: 'FOUNDRY', subtitle: 'Design custom plugin and performance interfaces, then export them as `.gan` plugins.' });
}

if (on('underfit')) {
  await tab(page, 'Underfit'); await page.waitForTimeout(6000); await settle(page, 1000);
  const miss = await mark(page, [
    { n: 1, target: await union([page.getByText("Underfit's environment is incomplete"), page.getByRole('button', { name: 'Re-check' })]) },
    { n: 9, target: await union([page.getByRole('button', { name: 'Reload Underfit' }), page.getByRole('link', { name: 'Open Underfit externally' })]), at: 'bl' },
  ]);
  report('14-underfit', [2, 3, 4, 5, 6, 7, 8, ...miss]);
  await shot(page, '14-underfit', { title: 'UNDERFIT', subtitle: 'Prepare datasets and train Stable Audio LoRA adapters from inside theDAW.' });
}

if (on('nodefi')) {
  await tab(page, 'NodeFI');
  const kinds = ['Library', 'Generate', 'Effect', 'Merge / Mix', 'Output'];
  const pos = [[560, 360], [560, 660], [900, 360], [1180, 510], [1440, 510]];
  for (let i = 0; i < kinds.length; i++) {
    const b = await page.getByRole('button', { name: `Add ${kinds[i]} node` }).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 28);
    await page.mouse.down();
    await page.mouse.move(pos[i][0], pos[i][1], { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(1000);
  const port = (node, dir) => page.locator(`[data-node^="${node}_"][data-port-${dir}]`).first();
  const wire = async (a, b) => {
    const pa = await port(a, 'out').boundingBox().catch(() => null), pb = await port(b, 'in').boundingBox().catch(() => null);
    if (!pa || !pb) { console.log('noport', a, b); return; }
    await page.mouse.move(pa.x + pa.width / 2, pa.y + pa.height / 2);
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  };
  await wire('input', 'effect'); await wire('generate', 'merge'); await wire('effect', 'merge'); await wire('merge', 'output');
  const gOut = await port('generate', 'out').boundingBox().catch(() => null);
  await page.screenshot({ path: DBG + 'N4pre.png' });
  if (gOut) { await page.mouse.click(gOut.x - 45, gOut.y - 20); await page.waitForTimeout(1200); }
  const oIn = await port('output', 'in').boundingBox().catch(() => null);
  const miss = await mark(page, [
    { n: 1, target: await union([page.getByRole('button', { name: 'Add Library node' }), page.getByRole('button', { name: 'Add Live Out node' })]) },
    { n: 2, target: R(1250, 780, 10, 10), box: false, at: 'c' },
    { n: 3, target: await port('merge', 'in').boundingBox().catch(() => null), at: 'tl' },
    { n: 4, target: gOut ? R(gOut.x - 110, gOut.y - 85, 125, 125) : null },
    { n: 5, target: R(1640, 64, 256, 440) },
    { n: 6, target: page.getByRole('button', { name: 'Run', exact: true }) },
    { n: 7, target: oIn ? R(oIn.x - 10, oIn.y - 75, 125, 125) : null, at: 'tr' },
  ]);
  report('15-nodefi', miss);
  await shot(page, '15-nodefi', { title: 'NODEFI', subtitle: 'Build repeatable generation and processing workflows by connecting nodes.' });
}

if (on('loom')) {
  await tab(page, 'Loom');
  const cv = await page.locator('canvas[aria-label^="Colony"]').boundingBox();
  await page.mouse.click(748, 448); // the lone spore
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Play the colony' }).click({ timeout: 4000 }).catch(() => console.log('loom: no Play button after spore click'));
  for (let i = 0; i < 4; i++) { await page.getByTitle('One growth step now').click(); await page.waitForTimeout(700); }
  await page.waitForTimeout(6000);
  const miss = await mark(page, [
    { n: 1, target: R(cv.x + 700, cv.y + 700, 10, 10), box: false, at: 'c' },
    { n: 2, target: R(1486, 150, 410, 390), at: 'bl' },
    { n: 3, target: page.locator('span[title="cells in the colony · root bar · growth steps"]') },
    { n: 4, target: await union([page.getByRole('button', { name: 'Add a loop' }), page.getByRole('button', { name: 'Add a colony' })]) },
  ]);
  report('16-loom', [5, ...miss]);
  await shot(page, '16-loom', { title: 'LOOM', subtitle: 'Explore the Shard Index as an evolving generative colony rather than a normal linear arrangement.' });
  await page.getByRole('button', { name: /stop/i }).first().click({ timeout: 3000 }).catch(() => {});
}

if (on('learn')) {
  await tab(page, 'Learn');
  await page.getByRole('button', { name: '3D graph' }).click();
  await page.waitForTimeout(12000);
  const png = (await page.screenshot({ clip: R(560, 240, 800, 560) })).toString('base64');
  const pts = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; const out = [];
    for (let yy = 2; yy < c.height - 2; yy += 2) for (let xx = 2; xx < c.width - 2; xx += 2) {
      const i = (yy * c.width + xx) * 4; const s = d[i] + d[i + 1] + d[i + 2];
      if (s > 360) out.push([xx + 560, yy + 240, s]);
    }
    return out.sort((a, b) => b[2] - a[2]).slice(0, 80);
  }, png);
  const before = await page.evaluate(() => document.body.innerText.length);
  let picked = null;
  for (const [x, y] of pts) {
    await page.mouse.click(x, y); await page.waitForTimeout(350);
    const after = await page.evaluate(() => document.body.innerText.length);
    if (Math.abs(after - before) > 40) { picked = [x, y]; break; }
  }
  console.log('learn picked', picked, 'candidates', pts.length);
  await page.mouse.move(1880, 700);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: DBG + 'L4.png' });
  const miss = await mark(page, [
    { n: 1, target: await union([page.getByRole('button', { name: 'Genealogy', exact: true }), page.getByRole('button', { name: '3D graph', exact: true })]) },
    { n: 2, target: picked ? R(picked[0] - 14, picked[1] - 14, 28, 28) : null },
    { n: 3, target: picked ? R(picked[0] - 45, picked[1] - 45, 90, 90) : null, at: 'br' },
    { n: 4, target: page.getByText('CHIMERA_SOURCE_OF', { exact: true }).last().locator('..').locator('..'), at: 'tr' },
    { n: 5, target: page.getByTitle('Appearance options'), at: 'bl' },
    { n: 6, target: await union([page.getByTitle('FTL jump forward (F)'), page.getByRole('button', { name: /home/i }).last()]), at: 'br' },
    { n: 7, target: page.getByText('Node inspector', { exact: false }).first().locator('..').locator('..'), at: 'bl' },
  ]);
  report('17-learn', miss);
  await shot(page, '17-learn', { title: 'LEARN', subtitle: 'Visualize how every track, stem, MIDI file, remix, inpaint, and generated version is related.' });
}

if (on('tour')) {
  await tab(page, 'Tour');
  await page.getByRole('button', { name: 'Dismiss guide' }).click().catch(() => {});
  await page.getByPlaceholder('City or region, e.g. Austin, TX').fill('Austin, TX');
  await page.getByRole('button', { name: 'Search', exact: true }).first().click();
  await page.waitForTimeout(12000);
  const adds = page.locator('button').filter({ hasText: /^\s*\+?\s*Add\s*$/ });
  for (const i of [5, 2, 0]) { await adds.nth(i).click({ timeout: 5000 }).catch(() => console.log('add fail', i)); await page.waitForTimeout(1000); }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: DBG + 'T4.png' });
  const dump = await page.evaluate(() => [...document.querySelectorAll('aside button,aside input,aside select,[aria-pressed]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0}).map(e=>{const r=e.getBoundingClientRect();return `${e.tagName} a=${e.getAttribute('aria-label')} x=${e.getAttribute('aria-expanded')} txt=${(e.textContent||'').trim().slice(0,30)} @${r.x|0},${r.y|0} ${r.width|0}x${r.height|0}`}).join(String.fromCharCode(10)));
  console.log(dump);
}

await browser.close();
