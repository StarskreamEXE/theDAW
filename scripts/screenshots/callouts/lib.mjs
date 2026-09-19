// Shared helpers for the Screenshot Callout User Guide captures
// (docs/guides/theDAW_Screenshot_Callout_User_Guide.md).
//
// Each group script:  import { open, settle, mark, shot, libDropAt } from './lib.mjs'
// Run from frontend/ so `playwright` resolves:
//   cd frontend && node ../scripts/screenshots/callouts/<group>.mjs
//
// Output: docs/guides/screenshots/callouts/raw/<slug>.png + <slug>.json
// Label:  uv run python scripts/screenshots/callouts/label_callouts.py <slug>...
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../frontend/package.json'));
const { chromium } = require('playwright');

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const RAW = resolve(ROOT, 'docs/guides/screenshots/callouts/raw');
mkdirSync(RAW, { recursive: true });

// 127.0.0.1, not localhost: the localhost host carries a stuck 80% browser zoom.
export const APP = process.env.THEDAW_URL || 'http://127.0.0.1:5173/';

/** Launch a fresh 1920x1080 context on theDAW with the tour, HOME and feature notes dismissed. */
export async function open({ headed = !!process.env.HEADED } = {}) {
  const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.getByText('SKIP TOUR').click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Close home screen' }).click({ timeout: 5000 }).catch(() => {});
  for (const n of ['Hide the Log feature note', 'Hide the Panels feature note']) {
    await page.getByRole('button', { name: n }).click({ timeout: 1500 }).catch(() => {});
  }
  await settle(page, 1500);
  return { browser, context, page };
}

/** Wait for network quiet and for any visible loading/connecting text to clear. */
export async function settle(page, extra = 1500, maxMs = 45000) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const n = await page
      .locator('text=/loading|connecting|starting up|spinning up|warming|analy[sz]ing/i')
      .filter({ visible: true })
      .count()
      .catch(() => 0);
    if (!n) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(extra);
}

/** Open a main workspace tab by its visible name (Make, Edit, Mix, DJ, ...). */
export async function tab(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click();
  await settle(page, 3000);
}

/** Toggle the right Library rail. */
export async function toggleLibrary(page) {
  await page.getByRole('button', { name: /Expand library|Collapse library/ }).first().click().catch(async () => {
    await page.mouse.click(1906, 505);
  });
  await settle(page, 2000);
}

/**
 * Simulate dragging a Library row (Library rail must be open) onto a target locator.
 * Library rows are [draggable=true] cards; the drop carries the library-id MIME the app reads.
 */
export async function libDropAt(page, rowText, target, dx = 40) {
  const b = await target.boundingBox();
  const dt = await page.evaluateHandle(() => new DataTransfer());
  const row = page.locator('[draggable="true"]').filter({ hasText: rowText }).first();
  const pos = { dataTransfer: dt, clientX: b.x + dx, clientY: b.y + b.height / 2, bubbles: true };
  await row.dispatchEvent('dragstart', { dataTransfer: dt });
  await target.dispatchEvent('dragenter', pos);
  await target.dispatchEvent('dragover', pos);
  await target.dispatchEvent('drop', pos);
  await row.dispatchEvent('dragend', { dataTransfer: dt });
}

/**
 * Draw numbered callout markers on the live page.
 * items: [{ n, target }] where target is a Playwright Locator or a rect {x,y,width,height}.
 * Optional per item: box:false (no outline), at:'tl'|'tr'|'bl'|'br'|'c' (marker anchor, default 'tl').
 * Returns the list of numbers that could not be placed (target missing/invisible).
 */
export async function mark(page, items) {
  const rects = [];
  const missing = [];
  for (const it of items) {
    let r = null;
    if (it.target && typeof it.target.boundingBox === 'function') {
      r = await it.target.first().boundingBox().catch(() => null);
    } else if (it.target) {
      r = it.target;
    }
    if (!r || r.width === 0) { missing.push(it.n); continue; }
    rects.push({ n: it.n, x: r.x, y: r.y, w: r.width, h: r.height, box: it.box !== false, at: it.at || 'tl' });
  }
  await page.evaluate((rects) => {
    document.getElementById('__callouts')?.remove();
    const layer = document.createElement('div');
    layer.id = '__callouts';
    Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
    const W = innerWidth, H = innerHeight, R = 17;
    for (const r of rects) {
      if (r.box) {
        const o = document.createElement('div');
        Object.assign(o.style, {
          position: 'fixed', left: r.x - 3 + 'px', top: r.y - 3 + 'px', width: r.w + 6 + 'px', height: r.h + 6 + 'px',
          border: '3px solid #ffd21f', borderRadius: '8px', boxShadow: '0 0 0 2px rgba(0,0,0,.7), 0 0 18px rgba(255,210,31,.55)',
        });
        layer.appendChild(o);
      }
      const ax = { tl: r.x, tr: r.x + r.w, bl: r.x, br: r.x + r.w, c: r.x + r.w / 2 }[r.at];
      const ay = { tl: r.y, tr: r.y, bl: r.y + r.h, br: r.y + r.h, c: r.y + r.h / 2 }[r.at];
      const cx = Math.min(W - R - 2, Math.max(R + 2, ax));
      const cy = Math.min(H - R - 2, Math.max(R + 2, ay));
      const m = document.createElement('div');
      m.textContent = String(r.n);
      Object.assign(m.style, {
        position: 'fixed', left: cx - R + 'px', top: cy - R + 'px', width: 2 * R + 'px', height: 2 * R + 'px',
        borderRadius: '50%', background: '#ffd21f', color: '#120a1c', border: '3px solid #120a1c',
        font: '800 18px/28px Segoe UI, Arial, sans-serif', textAlign: 'center', boxSizing: 'border-box',
        boxShadow: '0 0 0 2px #ffd21f, 0 4px 14px rgba(0,0,0,.8)',
      });
      layer.appendChild(m);
    }
    document.body.appendChild(layer);
  }, rects);
  return missing;
}

export async function clearMarks(page) {
  await page.evaluate(() => document.getElementById('__callouts')?.remove());
}

/**
 * Save the marked frame. meta: { title, subtitle } — title is the guide section heading,
 * subtitle its Purpose sentence. clip optional (close-ups).
 */
export async function shot(page, slug, meta, clip) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(RAW, `${slug}.png`), ...(clip ? { clip } : {}) });
  writeFileSync(resolve(RAW, `${slug}.json`), JSON.stringify(meta, null, 2));
  await clearMarks(page);
  console.log('shot', slug);
}
