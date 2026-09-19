// QA area q07-grid-prefs — Grid contrast and timeline preferences panel.
//
// Covers: TimelinePrefsPanel.tsx, timelinePrefsPanelModel.ts,
// timelinePrefsStore.ts, TimelineGridLayer.tsx.
//
// Run with:
//   cd frontend && node qa/q07-grid-prefs.qa.mjs

import { openApp, createReport, expect, expectClose } from './qaLib.mjs'

const AREA = 'q07-grid-prefs'

// --- helpers ----------------------------------------------------------------

/** Dismiss the first-run onboarding tour if the fresh QA profile shows one. */
async function dismissTourIfPresent(page) {
  try {
    const skip = page.getByText('Skip tour', { exact: true })
    await skip.waitFor({ state: 'visible', timeout: 2000 })
    await skip.click()
  } catch {
    // No tour shown — fine.
  }
}

/** App.tsx shows a full-screen cinematic boot splash ([data-boot-splash])
 *  behind a bare "fixed inset-0 z-200" div until the backend health check
 *  resolves and a >= ~0s animation timer completes (hard fallback at 24s).
 *  It intercepts every click underneath it, so every load/reload must wait
 *  it out before touching the tab bar. */
async function waitForBootSplashGone(page) {
  try {
    await page.locator('[data-boot-splash]').waitFor({ state: 'hidden', timeout: 30000 })
  } catch {
    // Never shown (already booted) — fine.
  }
}

/** Switch to the EDIT tab and wait for the WaveformEditor toolbar to mount. */
async function gotoEdit(page) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Timeline preferences' }).waitFor({ state: 'visible', timeout: 15000 })
}

/** Open the Timeline preferences popover; returns its dialog locator. */
async function openPrefs(page) {
  const btn = page.getByRole('button', { name: 'Timeline preferences' })
  const expanded = await btn.getAttribute('aria-expanded')
  if (expanded === 'true') return page.getByRole('dialog', { name: 'Timeline preferences' })
  await btn.click()
  const dialog = page.getByRole('dialog', { name: 'Timeline preferences' })
  await dialog.waitFor({ state: 'visible', timeout: 5000 })
  return dialog
}

/** Close the popover with Escape and wait for it to leave the DOM. */
async function closePrefsWithEscape(page) {
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Timeline preferences' }).waitFor({ state: 'detached', timeout: 5000 })
}

/** The single TimelineGridLayer canvas behind the timeline lanes. */
function gridCanvas(page) {
  return page.locator('canvas[aria-hidden="true"]').first()
}

/** Sum of the canvas alpha channel — a robust numeric fingerprint of how much
 *  grid ink is drawn (higher opacity / thicker bar lines => bigger sum). */
async function gridAlphaSum(page) {
  const canvas = gridCanvas(page)
  await canvas.waitFor({ state: 'attached', timeout: 8000 })
  return canvas.evaluate((el) => {
    const ctx = el.getContext('2d')
    if (!ctx || el.width === 0 || el.height === 0) return -1
    const data = ctx.getImageData(0, 0, el.width, el.height).data
    let sum = 0
    for (let i = 3; i < data.length; i += 4) sum += data[i]
    return sum
  })
}

/** Every input/button/summary inside `dialog` must resolve a non-empty
 *  accessible name (aria-label, aria-labelledby text, <label>, or — for
 *  button-like controls — its own text content). */
async function findUnlabeledControls(dialog) {
  const handles = await dialog.locator('input, button, summary, select, textarea').elementHandles()
  const problems = []
  for (const h of handles) {
    const info = await h.evaluate((el) => {
      const tag = el.tagName.toLowerCase()
      const ariaLabel = (el.getAttribute('aria-label') || '').trim()
      const labelledby = el.getAttribute('aria-labelledby')
      let labelledbyText = ''
      if (labelledby) {
        labelledbyText = labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() || '')
          .join(' ')
          .trim()
      }
      let labelsText = ''
      if ('labels' in el && el.labels) {
        labelsText = Array.from(el.labels)
          .map((l) => l.textContent?.trim() || '')
          .join(' ')
          .trim()
      }
      const textContent = (el.textContent || '').trim()
      const hasName = !!(ariaLabel || labelledbyText || labelsText || ((tag === 'button' || tag === 'summary') && textContent))
      return {
        tag,
        type: el.getAttribute('type') || '',
        id: el.id || '',
        name: el.getAttribute('name') || '',
        hasName,
      }
    })
    if (!info.hasName) problems.push(info)
  }
  return { total: handles.length, problems }
}

async function readPersistedPrefs(page) {
  const raw = await page.evaluate(() => localStorage.getItem('thedaw.timelineprefs.v1'))
  if (!raw) return null
  const parsed = JSON.parse(raw)
  return parsed.state ?? parsed
}

// --- main ---------------------------------------------------------------------

async function main() {
  const { browser, page, consoleErrors } = await openApp()
  const report = createReport(AREA)

  try {
    await waitForBootSplashGone(page)
    await dismissTourIfPresent(page)
    await gotoEdit(page)

    // 1. Panel opens from its button; every control has a real accessible name.
    await report.scenario('panel opens with real labels on every control', async () => {
      const btn = page.getByRole('button', { name: 'Timeline preferences' })
      await expect((await btn.getAttribute('aria-expanded')) === 'false', 'trigger button should start collapsed (aria-expanded=false)')

      const dialog = await openPrefs(page)
      await expect(await dialog.isVisible(), 'preferences dialog should be visible after clicking the trigger button')
      await expect((await btn.getAttribute('aria-expanded')) === 'true', 'trigger button should report aria-expanded=true once open')

      // Expand "Advanced" so its opacity sliders + bar-width radios are in the DOM too.
      await dialog.getByText('Advanced', { exact: true }).click()
      await dialog.locator('#timeline-grid-bar-opacity').waitFor({ state: 'visible', timeout: 3000 })

      const { total, problems } = await findUnlabeledControls(dialog)
      await expect(total >= 15, `expected at least 15 controls in the panel, found ${total}`)
      if (problems.length > 0) {
        throw new Error(
          `${problems.length}/${total} controls have no accessible name: ` +
            problems.map((p) => `<${p.tag}${p.type ? ` type=${p.type}` : ''} id="${p.id}" name="${p.name}">`).join(', '),
        )
      }

      await page.screenshot({ path: report.shotPath('01-panel-open'), fullPage: false })
      await closePrefsWithEscape(page)
    })

    // 2. Grid strength / contrast controls visibly change the grid canvas.
    let afterHighContrastAlpha = -1
    await report.scenario('grid preset visibly changes the grid canvas pixels', async () => {
      let dialog = await openPrefs(page)
      // Known baseline regardless of what earlier scenarios left behind.
      await dialog.getByRole('button', { name: /Reset timeline preferences/i }).click()
      await expect(await dialog.locator('#timeline-grid-visible').isChecked(), 'grid should be visible after reset')
      await closePrefsWithEscape(page)

      const before = await gridAlphaSum(page)
      await expect(before > 0, `expected the grid canvas to have drawn ink at the normal preset, got alpha sum ${before}`)
      await page.locator(await gridCanvasSelector(page)).screenshot({ path: report.shotPath('02-grid-before-normal') })

      dialog = await openPrefs(page)
      await dialog.getByRole('button', { name: 'High contrast' }).click()
      await expect(await dialog.getByRole('button', { name: 'High contrast' }).getAttribute('aria-pressed') === 'true', 'High contrast preset pill should report aria-pressed=true once selected')
      await closePrefsWithEscape(page)

      const after = await gridAlphaSum(page)
      afterHighContrastAlpha = after
      await page.locator(await gridCanvasSelector(page)).screenshot({ path: report.shotPath('02-grid-after-high-contrast') })

      await expect(after > before * 1.3, `High contrast preset should draw noticeably more ink than Normal (before=${before}, after=${after})`)
    })

    // 3. Preferences persist across a page reload.
    await report.scenario('grid preference persists across reload', async () => {
      const persistedBefore = await readPersistedPrefs(page)
      await expect(persistedBefore?.gridPreset === 'high-contrast', `localStorage should have gridPreset=high-contrast before reload, got ${JSON.stringify(persistedBefore?.gridPreset)}`)

      await page.reload({ waitUntil: 'networkidle' })
      await waitForBootSplashGone(page)
      await dismissTourIfPresent(page)
      await gotoEdit(page)

      const alphaAfterReload = await gridAlphaSum(page)
      expectClose(alphaAfterReload, afterHighContrastAlpha, Math.max(1, afterHighContrastAlpha * 0.02), 'grid canvas ink should match the pre-reload High-contrast rendering')

      const dialog = await openPrefs(page)
      await expect(
        (await dialog.getByRole('button', { name: 'High contrast' }).getAttribute('aria-pressed')) === 'true',
        'High contrast pill should still show selected after reload',
      )
      await page.screenshot({ path: report.shotPath('03-after-reload') })
      await closePrefsWithEscape(page)
    })

    // 4. Wheel-profile choice persists and takes effect.
    await report.scenario('wheel profile choice persists and takes effect', async () => {
      const lanes = page.locator('div[style*="cursor"]').first()
      const laneHeight = page.locator('#editor-track-height')
      const box = await page.locator('canvas[aria-hidden="true"]').first().boundingBox()
      await expect(box !== null, 'need the timeline lanes area on screen to dispatch wheel events')

      const ctrlWheelAt = async (x, y) => {
        await page.mouse.move(x, y)
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -120)
        await page.keyboard.up('Control')
        await page.waitForTimeout(120)
      }

      // Baseline profile is theDAW (set explicitly in case an earlier scenario changed it).
      let dialog = await openPrefs(page)
      await dialog.locator('#timeline-wheel-profile-thedaw').check()
      await closePrefsWithEscape(page)

      const cx = box.x + box.width / 2
      const cy = box.y + Math.min(60, box.height / 2)
      const v0 = await laneHeight.inputValue()
      await ctrlWheelAt(cx, cy)
      const v1 = await laneHeight.inputValue()
      await expect(v0 === v1, `under the theDAW profile, Ctrl+wheel is fine-zoom and must NOT resize lanes (before=${v0}, after=${v1})`)

      // Switch to REAPER bindings: Ctrl+wheel now resizes lanes.
      dialog = await openPrefs(page)
      await dialog.locator('#timeline-wheel-profile-reaper').check()
      await expect(await dialog.locator('#timeline-wheel-profile-reaper').isChecked(), 'reaper radio should be checked once clicked')
      await closePrefsWithEscape(page)

      const v2 = await laneHeight.inputValue()
      await ctrlWheelAt(cx, cy)
      let v3 = await laneHeight.inputValue()
      if (v3 === v2) {
        // Possibly saturated at a bound; retry the other wheel direction once.
        await page.mouse.move(cx, cy)
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, 120)
        await page.keyboard.up('Control')
        await page.waitForTimeout(120)
        v3 = await laneHeight.inputValue()
      }
      await expect(v2 !== v3, `under the REAPER profile, Ctrl+wheel must resize lanes (before=${v2}, after=${v3})`)

      // Persist across reload, and the effect must still hold.
      await page.reload({ waitUntil: 'networkidle' })
      await waitForBootSplashGone(page)
      await dismissTourIfPresent(page)
      await gotoEdit(page)
      dialog = await openPrefs(page)
      await expect(await dialog.locator('#timeline-wheel-profile-reaper').isChecked(), 'reaper radio should still be checked after reload')
      const persisted = await readPersistedPrefs(page)
      await expect(persisted?.wheelProfile === 'reaper', `localStorage should have wheelProfile=reaper, got ${JSON.stringify(persisted?.wheelProfile)}`)
      await closePrefsWithEscape(page)

      const box2 = await page.locator('canvas[aria-hidden="true"]').first().boundingBox()
      const v4 = await laneHeight.inputValue()
      await ctrlWheelAt(box2.x + box2.width / 2, box2.y + Math.min(60, box2.height / 2))
      const v5 = await laneHeight.inputValue()
      await expect(v4 !== v5, `after reload, the persisted REAPER profile should still make Ctrl+wheel resize lanes (before=${v4}, after=${v5})`)
      void lanes
    })

    // 5. Keyboard: open, operate and close the panel.
    await report.scenario('panel is keyboard operable and closable', async () => {
      // Reset first so we know the wheel-profile radio order (theDAW checked = first focusable radio).
      let dialog = await openPrefs(page)
      await dialog.getByRole('button', { name: /Reset timeline preferences/i }).click()
      await closePrefsWithEscape(page)

      const trigger = page.getByRole('button', { name: 'Timeline preferences' })
      await trigger.focus()
      await page.keyboard.press('Enter')
      dialog = page.getByRole('dialog', { name: 'Timeline preferences' })
      await dialog.waitFor({ state: 'visible', timeout: 5000 })

      // Focus should move into the panel on open (a rAF after placement).
      await page.waitForTimeout(150)
      const focusInPanel = await dialog.evaluate((el) => el.contains(document.activeElement))
      await expect(focusInPanel, 'focus should move into the preferences panel when it opens')

      // Tab forward until we reach the coarse-zoom slider, then operate it with arrow keys.
      let reached = false
      for (let i = 0; i < 15; i++) {
        const isSlider = await page.evaluate(() => document.activeElement?.id === 'timeline-zoom-coarse')
        if (isSlider) { reached = true; break }
        await page.keyboard.press('Tab')
      }
      await expect(reached, 'should be able to Tab from the panel open to the coarse-zoom slider')

      const slider = page.locator('#timeline-zoom-coarse')
      const before = Number(await slider.inputValue())
      await page.keyboard.press('ArrowRight')
      const after = Number(await slider.inputValue())
      await expect(after > before, `ArrowRight on a focused range slider should increase its value (before=${before}, after=${after})`)

      // Escape closes the panel and returns focus to the opener.
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached', timeout: 5000 })
      const focusBack = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
      await expect(focusBack === 'Timeline preferences', `focus should return to the "Timeline preferences" button on close, got aria-label="${focusBack}"`)
    })

    const unexpected = consoleErrors.filter(Boolean)
    if (unexpected.length > 0) {
      console.log(`\n${AREA}: ${unexpected.length} unexpected console error(s) captured during the run:`)
      for (const e of unexpected.slice(0, 10)) console.log('  ' + e)
    }
  } finally {
    report.finish()
    await browser.close()
  }
}

/** Selector string for the grid canvas (kept as a helper for element screenshots). */
async function gridCanvasSelector(_page) {
  return 'canvas[aria-hidden="true"]'
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exitCode = 1
})
