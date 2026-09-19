// QA area q01-click-cursor — click, edit cursor and playhead in the EDIT view.
//
// Exercises:
//  - frontend/src/lib/timeline/pointerGesture.ts       (4px click-vs-drag slop, isPrimaryGestureButton)
//  - frontend/src/components/audio/timelineInteraction.ts (classifyRulerPress, placementIntent)
//  - frontend/src/components/audio/WaveformEditor.tsx  (placeClickAt, onLanesPointerUp, onRulerPointerUp, seekEditorTo)
//  - frontend/src/state/editorStore.ts                 (editCursorSec vs playheadSec/isPlaying)
//
// Run with:  cd "C:\Users\skream\projects\_thedaw-batch11/frontend" && node qa/q01-click-cursor.qa.mjs
import { openApp, createReport, expect, ASSETS_DIR, QA_URL } from './qaLib.mjs';

const report = createReport('q01-click-cursor');

// Both the ruler and the lanes container are direct children of the single
// horizontally/vertically-scrolling wrapper; neither has its own id/testid,
// so they are picked out by the literal class strings read from
// WaveformEditor.tsx at the commit under test.
const RULER_SELECTOR = 'div.overflow-x-auto.overflow-y-auto > div.cursor-col-resize';
const LANES_SELECTOR = 'div.overflow-x-auto.overflow-y-auto > div.relative.outline-none';

function parseCursorLabel(label) {
  // formatCursorTime() in timelineInteraction.ts: `${mm}:${ss}.${mmm}`.
  const m = /Edit cursor at (\d\d):(\d\d)\.(\d\d\d)/.exec(label || '');
  if (!m) throw new Error(`Could not parse edit cursor aria-label: "${label}"`);
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
}

/** A y coordinate guaranteed to land on a lane row rather than the sticky
 * ruler strip above it. Closing a right-click context menu returns focus to
 * the lane and that focus-restore scrolls the lanes content down by exactly
 * the ruler's height (observed: scrollTop 0 -> 24), which slides the lanes
 * content's own boundingBox().y up underneath the ruler; a fixed
 * `lanesBox.y + 20` offset then lands on the ruler instead of a track once
 * that has happened. Anchoring to the ruler's bottom edge (sticky, so its
 * boundingBox() does not move with that internal scroll) is stable across
 * scenarios regardless of run order. */
function laneRowY(rulerBox, lanesBox) {
  return Math.max(lanesBox.y, rulerBox.y + rulerBox.height) + 10;
}

async function waitUntil(fn, { timeout = 5000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start >= timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Every run gets a throwaway profile (qaLib.mjs), so the first-run onboarding
 * tour (frontend/src/onboarding/onboardingStore.ts shouldAutoStart) auto-opens
 * a modal overlay on every launch and blocks every other click until closed. */
async function dismissOnboardingTour(page) {
  const closeBtn = page.getByRole('button', { name: /close tour/i });
  const appeared = await closeBtn
    .waitFor({ state: 'visible', timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await closeBtn.click().catch(() => {});
}

/** After the first-run tour is skipped, App.tsx surfaces the HOME screen
 * (useHomeScreenStore showAtStartup) as its own full-screen dialog. */
async function dismissHomeScreen(page) {
  const closeBtn = page.getByRole('button', { name: /close home screen/i });
  const appeared = await closeBtn
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await closeBtn.click().catch(() => {});
}

async function run() {
  const { browser, context, page, consoleErrors } = await openApp();
  const shot = (name) => page.screenshot({ path: report.shotPath(name) }).catch(() => {});

  try {
    // App.tsx plays a ~14s (up to 24s) particle-splash cinematic behind a
    // full-screen z-200 overlay before the app is interactive; `?nocinematic`
    // is the documented bypass ("used by the screenshot/capture harness").
    await page.goto(`${QA_URL}${QA_URL.includes('?') ? '&' : '?'}nocinematic`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await dismissOnboardingTour(page);
    await dismissHomeScreen(page);
    await page.getByRole('button', { name: /^edit$/i }).first().click();

    const ruler = page.locator(RULER_SELECTOR);
    const lanes = page.locator(LANES_SELECTOR);
    await lanes.waitFor({ state: 'visible', timeout: 15000 });
    await ruler.waitFor({ state: 'visible', timeout: 15000 });

    const cursorLabelLocator = () => page.getByRole('img', { name: /Edit cursor at/ });
    const getCursorSec = async () => parseCursorLabel(await cursorLabelLocator().getAttribute('aria-label'));
    const playHandle = page.locator('[data-playhead-handle="1"]');
    const getPlayheadX = async () => {
      const box = await playHandle.boundingBox();
      if (!box) throw new Error('playhead handle [data-playhead-handle="1"] not found');
      return box.x + box.width / 2;
    };
    const footerPlayBtn = () => page.getByRole('button', { name: 'Play', exact: true });
    const footerPauseBtn = () => page.getByRole('button', { name: 'Pause', exact: true });
    const isPlayingNow = async () => (await footerPauseBtn().count()) > 0;

    await shot('00-edit-view');

    await report.scenario('1: empty-lane click moves edit cursor, does not start/stop playback', async () => {
      expect(!(await isPlayingNow()), 'transport should be stopped at the start of this scenario');
      const lanesBox = await lanes.boundingBox();
      if (!lanesBox) throw new Error('lanes container has no bounding box (no tracks?)');
      const rulerBox = await ruler.boundingBox();
      const y = laneRowY(rulerBox, lanesBox);

      const initialSec = await getCursorSec();
      const x1 = lanesBox.x + 60;
      await page.mouse.click(x1, y);
      await shot('01-empty-lane-click-1');
      const sec1 = await getCursorSec();
      expect(sec1 !== initialSec, `edit cursor should have moved from its initial value ${initialSec}`);
      expect(!(await isPlayingNow()), 'a plain empty-lane click must not start playback');

      const x2 = lanesBox.x + 220;
      await page.mouse.click(x2, y);
      await shot('01-empty-lane-click-2');
      const sec2 = await getCursorSec();
      expect(sec2 > sec1, `clicking further right should move the cursor further right (got ${sec1}s then ${sec2}s)`);
      expect(!(await isPlayingNow()), 'a second empty-lane click must not start playback either');
    });

    await report.scenario('3: click vs drag decided on pointer-up at a 4px slop', async () => {
      const lanesBox = await lanes.boundingBox();
      const rulerBox = await ruler.boundingBox();
      const y = laneRowY(rulerBox, lanesBox);

      const before3 = await getCursorSec();
      const ox = lanesBox.x + 320;
      await page.mouse.move(ox, y);
      await page.mouse.down();
      await page.mouse.move(ox + 3, y); // 3px < 4px slop -> click
      await page.mouse.up();
      await shot('03-click-3px');
      const after3 = await getCursorSec();
      expect(after3 !== before3, `a 3px press-release (under the 4px slop) must be a click and move the cursor (stayed at ${before3}s)`);

      const before6 = after3;
      const dx = lanesBox.x + 420;
      await page.mouse.move(dx, y);
      await page.mouse.down();
      await page.mouse.move(dx + 6, y); // 6px >= 4px slop -> drag
      await page.mouse.up();
      await shot('03-drag-6px');
      const after6 = await getCursorSec();
      expect(after6 === before6, `a 6px press-release (at/past the 4px slop) is a drag and must not move the cursor (was ${before6}s, now ${after6}s)`);
    });

    await report.scenario('4: right-click never moves the edit cursor', async () => {
      const before = await getCursorSec();
      const lanesBox = await lanes.boundingBox();
      const rulerBox = await ruler.boundingBox();
      const x = lanesBox.x + 500;
      const y = laneRowY(rulerBox, lanesBox);
      await page.mouse.click(x, y, { button: 'right' });
      await shot('04-right-click');
      const after = await getCursorSec();
      expect(after === before, `a right-click must never move the edit cursor (was ${before}s, now ${after}s)`);
      await page.keyboard.press('Escape');
    });

    await report.scenario('5: clicking the ruler seeks (moves cursor AND playhead)', async () => {
      const rulerBox = await ruler.boundingBox();
      const x = rulerBox.x + 250;
      const y = rulerBox.y + rulerBox.height / 2;
      const cursorBefore = await getCursorSec();
      const playheadXBefore = await getPlayheadX();
      await page.mouse.click(x, y);
      await shot('05-ruler-click');
      const cursorAfter = await getCursorSec();
      const playheadXAfter = await getPlayheadX();
      expect(cursorAfter !== cursorBefore, `ruler click should move the edit cursor (stayed at ${cursorBefore}s)`);
      expect(Math.abs(playheadXAfter - x) < 10, `ruler click should seek the playhead to the click point (handle x=${playheadXAfter}, clicked x=${x})`);
      expect(Math.abs(playheadXAfter - playheadXBefore) > 5, `playhead should have moved from its previous position (x=${playheadXBefore})`);
    });

    await report.scenario('2: edit cursor and playhead are separate during playback', async () => {
      const lanesBox = await lanes.boundingBox();
      const rulerBoxForClick = await ruler.boundingBox();
      await page.mouse.click(lanesBox.x + 60, laneRowY(rulerBoxForClick, lanesBox), { button: 'right' });
      await shot('02a-add-menu');
      const addMenuItem = page.getByText('Audio from System', { exact: false }).first();
      await addMenuItem.waitFor({ state: 'visible', timeout: 5000 });
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        addMenuItem.click(),
      ]);
      await chooser.setFiles(`${ASSETS_DIR}/tone-440-10s.wav`);

      const clip = page.locator('[data-clip="1"]').first();
      await clip.waitFor({ state: 'visible', timeout: 15000 });
      await shot('02b-clip-imported');

      await footerPlayBtn().click();
      const started = await waitUntil(isPlayingNow, { timeout: 5000 });
      expect(started, 'pressing Play in the EDIT view should start playback (footer button should read Pause)');

      // Bonus coverage of scenario 5's rule: placementIntent returns
      // {moveEditCursor:true, seek:true} for surface==='ruler' BEFORE it ever
      // looks at `playing`, so a ruler click should seek even mid-playback.
      const rulerBox = await ruler.boundingBox();
      const rulerX = rulerBox.x + 340;
      await page.mouse.click(rulerX, rulerBox.y + rulerBox.height / 2);
      await shot('02c-ruler-click-during-playback');
      const playheadAfterRulerSeek = await getPlayheadX();
      expect(
        Math.abs(playheadAfterRulerSeek - rulerX) < 10,
        `ruler click should seek the playhead even during playback (handle x=${playheadAfterRulerSeek}, clicked x=${rulerX})`,
      );
      expect(await isPlayingNow(), 'a ruler seek during playback must not stop playback');

      const cursorBefore = await getCursorSec();
      const playheadXBefore = await getPlayheadX();
      const clipBox = await clip.boundingBox();
      if (!clipBox) throw new Error('imported clip has no bounding box');
      const clickX = clipBox.x + clipBox.width * 0.5;
      const clickY = clipBox.y + clipBox.height / 2;
      await page.mouse.click(clickX, clickY);
      await shot('02d-clip-click-during-playback');
      const cursorAfter = await getCursorSec();
      const playheadXAfter = await getPlayheadX();

      expect(await isPlayingNow(), 'clicking a clip during playback must not stop playback');
      expect(cursorAfter !== cursorBefore, `clicking a clip during playback should move the edit cursor (stayed at ${cursorBefore}s)`);
      expect(
        Math.abs(playheadXAfter - clickX) > 30,
        `the playhead must NOT jump to the clicked point while playing (handle x=${playheadXAfter}, clicked x=${clickX}, was x=${playheadXBefore})`,
      );

      await footerPauseBtn().click();
      await waitUntil(async () => !(await isPlayingNow()), { timeout: 3000 });
    });

    await report.scenario('6: no console error during any of the above', async () => {
      expect(consoleErrors.length === 0, `console errors captured during the run:\n${consoleErrors.join('\n')}`);
    });
  } catch (fatal) {
    console.error('FATAL', fatal);
  } finally {
    report.finish();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

run();
