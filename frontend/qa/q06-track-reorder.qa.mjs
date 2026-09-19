// QA script for AREA q06-track-reorder — reordering tracks in the arrangement.
//
// Run with:  cd "C:\Users\skream\projects\_thedaw-batch11/frontend" && node qa/q06-track-reorder.qa.mjs
//
// Reads the live DOM only (no window debug handle exists in this build):
//   - track order  == DOM order of `[data-track-grip]` buttons (one per track,
//     rendered by `tracks.map(...)`, so index in the DOM == index in the store).
//   - the reorder insertion line == an `aria-hidden` div with a `purple-400`
//     class that only exists while a drag is active (`reorderDraw` state).
//   - a clip's track == its vertical position lines up with its track's grip.

import { openApp, createReport, expect, ASSETS_DIR } from './qaLib.mjs';

const TONE_WAV = `${ASSETS_DIR}/tone-440-10s.wav`;
const INSERTION_LINE_SEL = '[aria-hidden="true"][class*="purple-400"]';

const gripSel = (id) => `button[data-track-grip="${id}"]`;
const gripIds = (page) =>
  page.$$eval('[data-track-grip]', (els) => els.map((el) => el.getAttribute('data-track-grip')));
const rowLocator = (page, id) => page.locator(gripSel(id)).locator('xpath=../..');

/** Focus a grip WITHOUT dragging: press and release in place (kind: 'click', a no-op). */
async function focusGripByClick(page, id) {
  const box = await page.locator(gripSel(id)).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

/** Drag `dragId`'s grip until the pointer sits in the upper/lower half of `targetId`'s row.
 *  The target box MUST be the whole row (`rowLocator`), not the grip itself: the grip is a
 *  small (h-4) handle docked near the top of the row's first flex line, so a grip-sized box
 *  never reaches the row's true lower half for anything but the shortest possible trackH. */
async function dragToHalf(page, dragId, targetId, half) {
  const dragBox = await page.locator(gripSel(dragId)).boundingBox();
  const targetBox = await rowLocator(page, targetId).boundingBox();
  const startX = dragBox.x + dragBox.width / 2;
  const startY = dragBox.y + dragBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Cross the 4px threshold first so the session goes 'pending' -> 'active'.
  await page.mouse.move(startX, startY + 10, { steps: 3 });
  const targetY = half === 'upper' ? targetBox.y + 2 : targetBox.y + targetBox.height - 2;
  await page.mouse.move(startX, targetY, { steps: 8 });
  return { startX, startY };
}

async function main() {
  const { browser, page, consoleErrors } = await openApp();
  const report = createReport('q06-track-reorder');
  try {
    // Fresh QA data dir -> shouldAutoStart() is true -> the first-run tour
    // would overlay the whole app. Seed its persisted "seen" flag (the app's
    // own localStorage key, `thedaw-onboarding`) and reload once, same as a
    // returning user, so it never appears and steals clicks. A fresh data dir
    // also defaults `thedaw-home-screen-v1`'s `showAtStartup` to true (see
    // HomeScreen.tsx), which pops a full-screen HOME overlay (role="dialog",
    // z-60) right after boot and swallows the very first click — seed it off
    // too, exactly like a returning user who turned "show at startup" off.
    await page.context().addInitScript(() => {
      localStorage.setItem(
        'thedaw-onboarding',
        JSON.stringify({ state: { seen: true, neverShow: true, completedChapters: [] }, version: 0 }),
      );
      localStorage.setItem(
        'thedaw-home-screen-v1',
        JSON.stringify({ state: { showAtStartup: false }, version: 0 }),
      );
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-tour="tab-edit"]').click();
    await page.waitForSelector('[data-track-grip]', { timeout: 15000 });

    // Make sure there is room to move things around: at least 4 tracks.
    const addTrackBtn = page.getByRole('button', { name: 'Add track' });
    while ((await gripIds(page)).length < 4) {
      await addTrackBtn.click();
    }
    const baseline = await gripIds(page);
    console.log('baseline track order:', baseline);

    // ── Scenario 1 — drag by the grip shows an insertion line, drops at that
    //    position, and the clip on the dragged track follows it. ─────────────
    await report.scenario('drag-grip-shows-line-and-drops-with-clips', async () => {
      const order = await gripIds(page);
      const dragId = order[0];
      const targetId = order[2]; // drop dragId after order[2]

      // Put a clip on the track we're about to drag, via the app's own
      // "Audio from System" import path (right-click the row -> file dialog).
      await rowLocator(page, dragId).click({ button: 'right', position: { x: 2, y: 2 } });
      await page.getByRole('menuitem', { name: /Audio from System/ }).click();
      await page.getByLabel('Audio files to add to a track').setInputFiles(TONE_WAV);
      await page.waitForSelector('[data-clip="1"]', { timeout: 15000 });
      const clipBoxBefore = await page.locator('[data-clip="1"]').first().boundingBox();
      const gripBoxBefore = await page.locator(gripSel(dragId)).boundingBox();
      expect(Math.abs(clipBoxBefore.y - gripBoxBefore.y) < 20, 'clip should start out aligned with its track row');

      await dragToHalf(page, dragId, targetId, 'lower');
      const lineCountDuring = await page.locator(INSERTION_LINE_SEL).count();
      await page.screenshot({ path: report.shotPath('01-mid-drag-insertion-line') });
      expect(lineCountDuring > 0, `insertion line should be visible mid-drag (found ${lineCountDuring})`);

      await page.mouse.up();
      await page.screenshot({ path: report.shotPath('01-after-drop') });
      const lineCountAfter = await page.locator(INSERTION_LINE_SEL).count();
      expect(lineCountAfter === 0, 'insertion line should be gone after drop');

      const newOrder = await gripIds(page);
      expect(newOrder.length === order.length, 'track count must not change from a reorder');
      const expectAfter = order.filter((id) => id !== dragId);
      const anchorIdx = expectAfter.indexOf(targetId);
      expectAfter.splice(anchorIdx + 1, 0, dragId);
      expect(
        JSON.stringify(newOrder) === JSON.stringify(expectAfter),
        `dragging ${dragId} to just after ${targetId} should give [${expectAfter}], got [${newOrder}]`,
      );

      const gripBoxAfter = await page.locator(gripSel(dragId)).boundingBox();
      const clipBoxAfter = await page.locator('[data-clip="1"]').first().boundingBox();
      expect(
        Math.abs(clipBoxAfter.y - gripBoxAfter.y) < 20,
        `clip should have moved to its track's new row (clip y=${clipBoxAfter.y}, grip y=${gripBoxAfter.y})`,
      );
      expect(
        Math.abs(clipBoxAfter.y - clipBoxBefore.y) > 10,
        'clip should visibly have moved vertically along with its dragged track',
      );
    });

    // ── Scenario 2 — Alt+ArrowUp / Alt+ArrowDown move the focused or selected
    //    track. ─────────────────────────────────────────────────────────────
    await report.scenario('alt-arrow-moves-grip-focused-track', async () => {
      const order = await gripIds(page);
      const id = order[1];
      await focusGripByClick(page, id);
      const activeLabel = await page.evaluate(() => document.activeElement?.getAttribute('data-track-grip'));
      expect(activeLabel === id, `clicking the grip should focus it (active grip is ${activeLabel})`);
      await page.keyboard.press('Alt+ArrowDown');
      const newOrder = await gripIds(page);
      expect(newOrder.indexOf(id) === order.indexOf(id) + 1, `Alt+ArrowDown on a focused grip should move ${id} down one row, got [${newOrder}]`);
      // put it back for the next scenarios
      await page.keyboard.press('Control+z');
      expect(JSON.stringify(await gripIds(page)) === JSON.stringify(order), 'undo should restore the order');
    });

    await report.scenario('alt-arrow-moves-selected-track-without-grip-focus', async () => {
      const order = await gripIds(page);
      const id = order[1];
      // Select the track by its row body (padding area — avoids the grip, the
      // name <input>, and the arm/fx buttons, none of which select the track).
      await rowLocator(page, id).click({ position: { x: 2, y: 2 } });
      const active = await page.evaluate(() => document.activeElement?.getAttribute('data-track-grip') ?? document.activeElement?.tagName);
      expect(active !== id, `selecting via the row body should not focus the grip (active: ${active})`);

      await page.keyboard.press('Alt+ArrowDown');
      const afterPlainAlt = await gripIds(page);
      await page.keyboard.press('Alt+Shift+ArrowDown');
      const afterAltShift = await gripIds(page);

      // Restore order regardless of which one moved it, for later scenarios.
      if (JSON.stringify(afterAltShift) !== JSON.stringify(order)) await page.keyboard.press('Control+z');
      if (JSON.stringify(afterPlainAlt) !== JSON.stringify(order)) await page.keyboard.press('Control+z');

      expect(
        afterAltShift.indexOf(id) === order.indexOf(id) + 1,
        `Alt+Shift+ArrowDown should move the selected, unfocused track ${id} down one row (got [${afterAltShift}])`,
      );
      expect(
        JSON.stringify(afterPlainAlt) === JSON.stringify(order),
        `plain Alt+ArrowDown moved the selected-but-unfocused track ${id} ([${order}] -> [${afterPlainAlt}]); ` +
          `per WaveformEditor.tsx the global handler requires Shift (Alt+Shift+Arrow) unless the grip itself has focus`,
      );
    });

    // ── Scenario 3 — one undo step per move; redo reapplies it. ─────────────
    await report.scenario('one-undo-step-per-move-and-redo-reapplies', async () => {
      const order = await gripIds(page);
      const id = order[1];
      await focusGripByClick(page, id);
      await page.keyboard.press('Alt+ArrowDown');
      const moved = await gripIds(page);
      expect(moved.indexOf(id) === order.indexOf(id) + 1, 'setup: the move should have happened');

      await page.keyboard.press('Control+z');
      const afterUndo = await gripIds(page);
      expect(JSON.stringify(afterUndo) === JSON.stringify(order), `Ctrl+Z should fully restore the pre-move order, got [${afterUndo}]`);

      await page.keyboard.press('Control+Shift+Z');
      const afterRedo = await gripIds(page);
      expect(JSON.stringify(afterRedo) === JSON.stringify(moved), `Ctrl+Shift+Z should reapply the move, got [${afterRedo}]`);

      // leave things clean
      await page.keyboard.press('Control+z');
      expect(JSON.stringify(await gripIds(page)) === JSON.stringify(order), 'cleanup undo should restore baseline');
    });

    // ── Scenario 4 — moving several selected tracks keeps their relative
    //    order. ────────────────────────────────────────────────────────────
    await report.scenario('multi-select-move-keeps-relative-order', async () => {
      const order = await gripIds(page);
      const idA = order[0];
      const idB = order[2]; // non-adjacent on purpose
      await rowLocator(page, idA).click({ position: { x: 2, y: 2 } });
      await rowLocator(page, idB).click({ position: { x: 2, y: 2 }, modifiers: ['Control'] });
      // Focus idB's grip WITHOUT changing the selection (a plain grip press
      // never calls the selection setters — see onGripPointerDown).
      await focusGripByClick(page, idB);
      await page.keyboard.press('Alt+ArrowDown');
      const after = await gripIds(page);

      expect(after.length === order.length, 'move must not change track count');
      const relBefore = order.filter((id) => id === idA || id === idB);
      const relAfter = after.filter((id) => id === idA || id === idB);
      expect(
        JSON.stringify(relBefore) === JSON.stringify(relAfter),
        `relative order of the selected tracks should be preserved: before [${relBefore}], after [${relAfter}]`,
      );
      expect(JSON.stringify(after) !== JSON.stringify(order), 'the move should actually have changed something');

      await page.keyboard.press('Control+z');
      expect(JSON.stringify(await gripIds(page)) === JSON.stringify(order), 'cleanup undo should restore baseline');
    });

    // ── Scenario 5 — Escape during a drag cancels with no change. ───────────
    await report.scenario('escape-during-drag-cancels', async () => {
      const order = await gripIds(page);
      const dragId = order[0];
      const targetId = order[2];
      await dragToHalf(page, dragId, targetId, 'lower');
      const lineDuring = await page.locator(INSERTION_LINE_SEL).count();
      expect(lineDuring > 0, 'insertion line should show once the drag is active, before cancelling');

      await page.keyboard.press('Escape');
      await page.screenshot({ path: report.shotPath('05-after-escape') });
      const lineAfterEscape = await page.locator(INSERTION_LINE_SEL).count();
      expect(lineAfterEscape === 0, 'insertion line should disappear the moment Escape cancels the drag');
      const orderRightAfterEscape = await gripIds(page);
      expect(
        JSON.stringify(orderRightAfterEscape) === JSON.stringify(order),
        `order must be unchanged immediately after Escape, got [${orderRightAfterEscape}]`,
      );

      await page.mouse.up(); // release the still-down button; must not move anything either
      const orderAfterRelease = await gripIds(page);
      expect(
        JSON.stringify(orderAfterRelease) === JSON.stringify(order),
        `order must still be unchanged after releasing the pointer post-Escape, got [${orderAfterRelease}]`,
      );
    });

    // ── Scenario 6 — the grip is reachable by keyboard and has an accessible
    //    name. ────────────────────────────────────────────────────────────
    await report.scenario('grip-keyboard-reachable-with-accessible-name', async () => {
      const order = await gripIds(page);
      const id = order[0];
      const grip = page.locator(gripSel(id));
      const [tag, ariaLabel, roleDescription, tabIndex] = await grip.evaluate((el) => [
        el.tagName,
        el.getAttribute('aria-label'),
        el.getAttribute('aria-roledescription'),
        el.tabIndex,
      ]);
      expect(tag === 'BUTTON', `grip should be a native button (a real tab stop), got <${tag}>`);
      expect(tabIndex !== -1, `grip must stay in the tab order (tabIndex=${tabIndex})`);
      expect(!!ariaLabel && /Reorder track/.test(ariaLabel), `grip needs a descriptive accessible name, got "${ariaLabel}"`);
      expect(roleDescription === 'drag handle', `grip should identify itself as a drag handle to AT, got "${roleDescription}"`);

      await grip.focus();
      const focusedIsGrip = await page.evaluate(
        (expectedId) => document.activeElement?.getAttribute('data-track-grip') === expectedId,
        id,
      );
      expect(focusedIsGrip, 'grip should be focusable via .focus() (i.e. reachable by keyboard/Tab)');
    });

    const rows = report.finish();

    const realConsoleErrors = consoleErrors.filter(Boolean);
    if (realConsoleErrors.length > 0) {
      console.log('\nUnexpected console errors captured during the run:');
      for (const e of realConsoleErrors) console.log(' -', e);
    }
    return { rows, consoleErrors: realConsoleErrors };
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
