// Group D captures: PERFORM, DJ, VJ, VJ sources, SWAY workspace, SWAY bottom panel.
import { open, settle, tab, mark, shot } from './lib.mjs';
const only = (process.argv[2] || 'perform,dj,vj,sway,swaybottom').split(',');
const R = (x, y, w, h) => ({ x, y, width: w, height: h });
const bb = async (loc) => loc.first().boundingBox().catch(() => null);
const union = (...rs) => { rs = rs.filter(Boolean); if (!rs.length) return null;
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return R(x, y, Math.max(...rs.map(r => r.x + r.width)) - x, Math.max(...rs.map(r => r.y + r.height)) - y); };
const dump = async (page, maxY = 990) => console.log((await page.evaluate((maxY) => [...document.querySelectorAll('[title],[aria-label],select,input')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.y < maxY && b.y > 45; }).map(e => { const b = e.getBoundingClientRect(); return `${e.tagName} t=[${(e.getAttribute('title') || '').slice(0, 50)}] a=[${e.getAttribute('aria-label') || ''}] "${(e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)}" @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`; }), maxY)).join('\n'));
const report = (slug, miss) => console.log('MISSING', slug, JSON.stringify(miss));
const { browser, page } = await open();

if (only.includes('perform')) {
  await tab(page, 'Perform');
  const input = page.getByPlaceholder('.als / .swayproj / .tasmo / any project');
  await input.click();
  await page.waitForTimeout(1500);
  const opt = page.locator('#session-recent-listbox [role=option]').first();
  const dd = await bb(page.locator('#session-recent-listbox'));
  // Screenshot needs the dropdown for #2, but the grid for the rest: record its rect, then load.
  await opt.click();
  await settle(page, 5000);
  const routing = page.getByRole('button', { name: 'Sway routing' });
  if ((await routing.getAttribute('aria-pressed').catch(() => null)) === 'false') { await routing.click(); await settle(page, 2000); }
  if (process.env.DUMP) await dump(page);
  const col = await bb(page.getByText('01 Column', { exact: false }));
  const colRect = col ? R(col.x - 6, col.y - 8, 1637, 34) : null;
  const miss = await mark(page, [
    { n: 1, target: union(await bb(input), await bb(page.getByRole('button', { name: 'Browse for Open file' }))) },
    { n: 2, target: page.getByPlaceholder('.als / .swayproj / .tasmo / any project'), box: false, at: 'c' },
    { n: 3, target: colRect },
    { n: 4, target: page.locator('[aria-label^="Launch "][title^="Launch scene"]') },
    { n: 5, target: page.locator('[aria-label^="Launch "][aria-label*=" on "]') },
    { n: 6, target: page.locator('select[title^="Launch quantization"]') },
    { n: 7, target: page.getByRole('button', { name: 'Routes and parameters rail' }), at: 'bl' },
    { n: 8, target: routing },
    { n: 9, target: page.getByRole('button', { name: 'Save as .tasmo' }), at: 'bl' },
    { n: 10, target: page.getByRole('button', { name: 'Edit in timeline' }) },
  ]);
  report('08-perform', miss);
  await shot(page, '08-perform', { title: 'PERFORM', subtitle: 'Launch project clips and scenes live instead of playing a fixed left-to-right arrangement.' });
}

if (only.includes('dj')) {
  await tab(page, 'DJ');
  const search = page.getByPlaceholder(/search/i).last();
  for (const [q, d] of [['mixdown_357779', 'A'], ['mixdown_095087', 'B']]) {
    await search.fill(q); await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '→' + d, exact: true }).first().click();
    await page.waitForTimeout(3000);
  }
  await search.fill('');
  await settle(page, 5000);
  for (let i = 0; i < 2; i++) { await page.locator('button[title="Play"]').first().click().catch(() => {}); await page.waitForTimeout(800); }
  await page.waitForTimeout(5000);
  const T = (t) => page.locator(`[title^="${t}"]`);
  const sA = await bb(page.getByText('Deck A · Scroll', { exact: false }));
  const sB = await bb(page.getByText('Deck B · Scroll', { exact: false }));
  const deckAPlay = await bb(T('Cue to start'));
  const syncA = await bb(T('BPM Sync'));
  const itemsArr = [
    { n: 1, target: sA && sB ? R(22, sA.y - 6, 1876, sB.y - sA.y + 62) : null },
    { n: 2, target: union(syncA && R(syncA.x + syncA.width + 4, syncA.y, 365, syncA.height), deckAPlay) },
    { n: 3, target: T('Key-lock') },
    { n: 4, target: union(await bb(page.locator('[aria-label="Pch A"]')), await bb(T('Effective BPM at this pitch'))) },
    { n: 5, target: union(await bb(page.locator('[aria-label="Flt"]').first()), await bb(page.locator('[aria-label="Flt"]').last())) },
    { n: 6, target: page.locator('[aria-label="Crossfader"]') },
    { n: 7, target: union(await bb(T('Load or separate 4 stems for Deck A')), ...(await Promise.all((await T('Prepare stems for Deck A').all()).map(bb)))) },
    { n: 8, target: union(await bb(T('Toggle flanger')), await bb(page.locator('[aria-label="Wah"]'))) },
    { n: 9, target: T('Cue — pre-listen') },
    { n: 10, target: union(await bb(page.getByText('Source Tree', { exact: true })), await bb(page.getByText('Drag tracks here', { exact: false }))), at: 'tl' },
    { n: 12, target: null },
    { n: 11, target: page.getByText('Sampler', { exact: true }) },
  ];
  const items = () => itemsArr.filter((i) => i.n !== 12);
  // Edit Layout lives in the App menu: open it (read-only) so #12 can point at it.
  await page.getByRole('button', { name: 'App menu' }).click(); await page.waitForTimeout(1000);
  const el = page.getByText('Edit Layout', { exact: true });
  const m12 = await mark(page, [...items(), { n: 12, target: el }]);
  report('09-dj', m12);
  await shot(page, '09-dj', { title: 'DJ', subtitle: 'Mix two tracks live with beat sync, cueing, stems, effects, automix, and sampler controls.' });
}

if (only.includes('vj') || only.includes('swaybottom')) {
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  await tab(page, 'VJ');
  await page.waitForTimeout(20000);
  await settle(page, 2000);
  console.log('VJ failed responses', bad.slice(0, 8));
  const A = (n) => page.getByRole('button', { name: n, exact: true });
  const frame = page.locator('iframe[src*="vj-app"]');
  if (only.includes('vj')) {
    const miss = await mark(page, [
      { n: 1, target: frame },
      { n: 2, target: union(await bb(A('Microphone input')), await bb(A('MIDI forwarding')), await bb(A('Camera source'))) },
      { n: 3, target: null },
      { n: 4, target: A('Audio bridge'), at: 'bl' },
      { n: 5, target: null }, { n: 6, target: null }, { n: 7, target: null }, { n: 8, target: null }, { n: 9, target: null },
      { n: 10, target: page.getByRole('button', { name: 'Pop out' }) },
      { n: 11, target: A('Mobile URL'), at: 'bl' },
      { n: 12, target: null },
    ]);
    report('10-vj', miss);
    await shot(page, '10-vj', { title: 'VJ', subtitle: 'Create and perform live visuals from audio, cameras, media, shaders, depth sources, and Quest feeds.' });
    const miss2 = await mark(page, [
      { n: 1, target: A('Camera source'), at: 'bl' },
      { n: 2, target: union(await bb(A('delinQuest Quest video relay — Start')), await bb(A('Refresh delinQuest status'))), at: 'br' },
      { n: 3, target: null }, { n: 4, target: null }, { n: 5, target: null }, { n: 6, target: null },
    ]);
    report('11-vj-sources', miss2);
    await shot(page, '11-vj-sources', { title: 'VJ', subtitle: 'Create and perform live visuals from audio, cameras, media, shaders, depth sources, and Quest feeds.' }, R(1000, 45, 920, 200));
  }
  if (only.includes('swaybottom')) {
    await page.getByRole('button', { name: 'Expand bottom panel' }).click();
    await settle(page, 2000);
    // No SWAY tab exists in BottomMultiTabPanel (tabs end at SLIDE); capture the dock as it is, VJ still active.
    console.log('bottom SWAY tab present:', await page.locator('button', { hasText: /^SWAY$/ }).count());
    await settle(page, 6000);
    if (process.env.DUMP) await dump(page, 1080);
    const midi = page.getByText(/no MIDI device|MIDI/).last();
    const miss = await mark(page, [
      { n: 1, target: null }, { n: 2, target: null }, { n: 3, target: null },
      { n: 4, target: null },
      { n: 5, target: null }, { n: 6, target: null },
    ]);
    report('30-sway-bottom-panel', miss);
    await shot(page, '30-sway-bottom-panel', { title: 'SWAY — BOTTOM PANEL', subtitle: 'Keep the SwayCommand cockpit and motion system available while another main workspace stays open.' });
    await page.getByRole('button', { name: 'Collapse bottom panel' }).click().catch(() => {});
  }
}

if (only.includes('sway')) {
  await tab(page, 'Sway');
  await settle(page, 8000);
  const miss = await mark(page, [
    { n: 1, target: null }, { n: 2, target: null }, { n: 3, target: null },
    { n: 4, target: page.getByText('no MIDI device', { exact: false }).first() },
    { n: 5, target: null }, { n: 6, target: null },
  ]);
  report('12-sway-workspace', miss);
  await shot(page, '12-sway-workspace', { title: 'SWAY — MAIN WORKSPACE', subtitle: 'Use the SwayCommand performance system and expressive-motion controls at full size.' });
}
await browser.close();
