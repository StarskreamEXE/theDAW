// QA area q03-time-range: the ruler time-range highlight and its right-click
// menu. See frontend/src/components/audio/timelineInteraction.ts
// (highlightClearDecision, buildRangeMenu, rangeSplitPlan) and
// frontend/src/lib/timeline/timeSelection.ts for the rules under test.
//
// Run with:
//   cd "C:\Users\skream\projects\_thedaw-batch11/frontend" && node qa/q03-time-range.qa.mjs

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { openApp, createReport, expect, ASSETS_DIR } from './qaLib.mjs'

const AREA = 'q03-time-range'
const RULER_SELECTOR = 'div.cursor-col-resize'
// The ruler-band chip only (bg-sky-400/30, no "/50" suffix): the lanes area
// paints its OWN highlight rect(s) (bg-sky-400/10) which also contain the
// substring "border-sky-300", so a selector on that substring alone matches
// 2+ elements and trips Playwright's strict mode on .boundingBox(). This one
// is unique (single element) and is the one carrying the mm:ss readout <span>.
const RANGE_HIGHLIGHT_SELECTOR = 'div[aria-hidden="true"][class*="bg-sky-400/30"]'
const CLIP_SELECTOR = '[data-clip="1"]'

/** First-run onboarding tour ("Welcome to theDAW") steals pointer events from
 *  the whole page via a fixed inset-0 overlay. It shows a few seconds after
 *  load on a fresh (empty) QA data folder. Esc leaves it for good
 *  (OnboardingTour.tsx's key handler calls dismiss()); harmless no-op if it
 *  never appeared. */
async function dismissWelcomeTourIfPresent(page, timeoutMs = 20000) {
  const dlg = page.locator('[role="dialog"][aria-modal="true"]')
  const deadline = Date.now() + timeoutMs
  let sawIt = false
  while (Date.now() < deadline) {
    if (await dlg.count() > 0 && (await dlg.isVisible().catch(() => false))) {
      sawIt = true
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      continue
    }
    if (sawIt) return // was visible, now isn't - dismissed
    await page.waitForTimeout(300)
  }
  if (!sawIt) return // never showed up in the window (e.g. tour already marked seen)
  throw new Error('welcome tour dialog would not dismiss (Escape) within timeout')
}

async function getRulerBox(page) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, RULER_SELECTOR)
  if (!box) throw new Error(`ruler element not found (${RULER_SELECTOR})`)
  return box
}

async function getLanesBox(page) {
  const box = await page.evaluate((sel) => {
    const ruler = document.querySelector(sel)
    const lanes = ruler && ruler.nextElementSibling
    if (!lanes) return null
    const r = lanes.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, RULER_SELECTOR)
  if (!box) throw new Error('lanes container (ruler.nextElementSibling) not found')
  return box
}

async function dragOnRuler(page, x1, x2, y) {
  await page.mouse.move(x1, y)
  await page.mouse.down()
  await page.mouse.move(x1 + (x2 - x1) * 0.5, y, { steps: 3 })
  await page.mouse.move(x2, y, { steps: 3 })
  await page.mouse.up()
  await page.waitForTimeout(80)
}

async function countClips(page) {
  return page.locator(CLIP_SELECTOR).count()
}

async function waitForClipCount(page, n, timeout = 10000) {
  await page.waitForFunction(
    ({ sel, n }) => document.querySelectorAll(sel).length === n,
    { sel: CLIP_SELECTOR, n },
    { timeout },
  )
}

async function clipBoxes(page) {
  const boxes = await page.locator(CLIP_SELECTOR).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, cls: el.className }
    }),
  )
  return boxes.sort((a, b) => a.x - b.x)
}

/** Drop a real audio file onto the lanes container at (clientX, clientY), the
 *  same DataTransfer-based path a desktop file drop uses (onTimelineDrop). */
async function dropAudioFile(page, filePath, clientX, clientY) {
  const buf = await readFile(filePath)
  const base64 = buf.toString('base64')
  const filename = path.basename(filePath)
  await page.evaluate(
    async ({ base64, x, y, filename, rulerSel }) => {
      const bin = atob(base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const file = new File([bytes], filename, { type: 'audio/wav' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const ruler = document.querySelector(rulerSel)
      const lanes = ruler && ruler.nextElementSibling
      if (!lanes) throw new Error('lanes container not found for drop')
      const mk = (type) =>
        new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt })
      lanes.dispatchEvent(mk('dragenter'))
      lanes.dispatchEvent(mk('dragover'))
      lanes.dispatchEvent(mk('drop'))
    },
    { base64, x: clientX, y: clientY, filename, rulerSel: RULER_SELECTOR },
  )
}

async function getHighlight(page) {
  const loc = page.locator(RANGE_HIGHLIGHT_SELECTOR)
  const count = await loc.count()
  if (count === 0) return null
  const box = await loc.boundingBox()
  const text = await loc.locator('span').first().textContent().catch(() => null)
  return { box, text }
}

async function getMenuRows(page) {
  const menu = page.locator('[role="menu"]')
  await menu.waitFor({ state: 'visible', timeout: 3000 })
  const items = menu.locator('[role="menuitem"], [role="menuitemradio"]')
  const n = await items.count()
  const rows = []
  for (let i = 0; i < n; i++) {
    const it = items.nth(i)
    const disabled = await it.isDisabled()
    const text = (await it.textContent())?.trim() ?? ''
    rows.push({ text, disabled })
  }
  const title = await menu.locator('..').locator('text=Range ·').first().textContent().catch(() => null)
  return { rows, title }
}

async function main() {
  const { browser, page, consoleErrors } = await openApp({ width: 1920, height: 1000 })
  const report = createReport(AREA)
  const bugs = []

  try {
    await dismissWelcomeTourIfPresent(page)

    // --- Get into EDIT (WaveformEditor mounts the ruler / lanes / range menu) ---
    await page.locator('button[data-tour="tab-edit"]').click()
    // WaveformEditor is a lazy chunk - give it real time to mount rather than
    // failing on the first immediate check.
    await page.waitForSelector(RULER_SELECTOR, { state: 'visible', timeout: 10000 })
    await page.waitForTimeout(200)

    const ruler = await getRulerBox(page)
    const rulerY = ruler.y + ruler.height / 2
    // A fixed, clip-free test range used for scenarios 1-4 (before any clip
    // import). Kept well inside the visible viewport.
    const OX1 = ruler.x + 150
    const OX2 = ruler.x + 350
    const OUTSIDE_X = ruler.x + 600

    // ---------------------------------------------------------------------
    await report.scenario('1-ruler-drag-creates-highlight', async () => {
      await dragOnRuler(page, OX1, OX2, rulerY)
      const h = await getHighlight(page)
      expect(h !== null, 'expected a time-range highlight after dragging the ruler')
      expect(h.box.width > 100, `highlight width should track the drag (got ${h.box?.width}px)`)
      expect(!!h.text && h.text.includes('–'), `expected an mm:ss readout, got ${JSON.stringify(h.text)}`)
    })

    await report.scenario('2-left-click-outside-clears-highlight', async () => {
      const before = await getHighlight(page)
      expect(before !== null, 'setup: expected a highlight to be present before the outside click')
      await page.mouse.click(OUTSIDE_X, ruler.y + 40)
      await page.waitForTimeout(100)
      const after = await getHighlight(page)
      expect(after === null, 'a left-click outside the range should clear it')
    })

    await report.scenario('3-left-click-inside-keeps-highlight', async () => {
      await dragOnRuler(page, OX1, OX2, rulerY)
      const mid = (OX1 + OX2) / 2
      await page.mouse.click(mid, ruler.y + 40)
      await page.waitForTimeout(100)
      const after = await getHighlight(page)
      expect(after !== null, 'a left-click inside the range should NOT clear it')
    })

    await report.scenario('4-escape-clears-highlight', async () => {
      const before = await getHighlight(page)
      expect(before !== null, 'setup: expected a highlight before pressing Escape')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(100)
      const after = await getHighlight(page)
      expect(after === null, 'Escape should clear the range highlight')
    })

    // --- Bring two real clips onto the timeline for the clip-aware scenarios ---
    const lanes = await getLanesBox(page)
    const dropAX = lanes.x + 250
    const dropAY = lanes.y + 20
    const dropBX = lanes.x + 850
    const dropBY = lanes.y + 220

    await dropAudioFile(page, path.join(ASSETS_DIR, 'tone-440-10s.wav'), dropAX, dropAY)
    await waitForClipCount(page, 1, 12000)
    await dropAudioFile(page, path.join(ASSETS_DIR, 'tone-220-6s.wav'), dropBX, dropBY)
    await waitForClipCount(page, 2, 12000)

    let [boxA, boxB] = await clipBoxes(page) // sorted by x ascending
    expect(boxB.x > boxA.x + boxA.width + 50, 'setup: clip B should render clearly to the right of clip A')

    const RX1 = boxA.x + boxA.width * 0.25
    const RX2 = boxA.x + boxA.width * 0.75
    const rangeMidX = (RX1 + RX2) / 2
    const outsideBothX = boxA.x + boxA.width + 20 // between A and B, still on row 0

    async function resetHighlightsAndSelection() {
      await page.mouse.click(outsideBothX, boxA.y + boxA.height / 2)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(60)
    }
    await resetHighlightsAndSelection()

    // ---------------------------------------------------------------------
    await report.scenario('5a-selecting-a-clip-outside-range-clears-range', async () => {
      await dragOnRuler(page, RX1, RX2, rulerY)
      const before = await getHighlight(page)
      expect(before !== null, 'setup: expected a range near clip A')
      // Clip B sits far outside [RX1,RX2] in time.
      await page.mouse.click(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2)
      await page.waitForTimeout(100)
      const after = await getHighlight(page)
      expect(after === null, 'clicking a clip outside the range should clear the range (highlightClearDecision)')
      const cls = await page.locator(CLIP_SELECTOR).nth(1).getAttribute('class')
      expect(cls?.includes('border-white'), 'clicking clip B should select it (border-white ring)')
    })

    await report.scenario('5b-drawing-a-range-clears-clip-selection', async () => {
      // Clip B is selected from 5a. Drawing a fresh range should put that
      // selection away too (T44: only one highlight/focus at a time).
      const selectedBefore = (await page.locator(CLIP_SELECTOR).nth(1).getAttribute('class'))?.includes('border-white')
      expect(selectedBefore === true, 'setup: expected clip B still selected from 5a')
      await dragOnRuler(page, RX1, RX2, rulerY)
      const h = await getHighlight(page)
      expect(h !== null, 'setup: expected the new range to be drawn')
      const clsAfter = await page.locator(CLIP_SELECTOR).nth(1).getAttribute('class')
      const stillSelected = clsAfter?.includes('border-white')
      if (stillSelected) await page.screenshot({ path: report.shotPath('5b-range-and-clip-both-highlighted'), fullPage: false })
      expect(!stillSelected, 'drawing a new time range should clear the existing clip selection')
    })

    // ---------------------------------------------------------------------
    await report.scenario('6-right-click-inside-opens-range-menu-rows', async () => {
      // Right-click on row 1 (clip B's row), at an X inside the range but
      // where row 1 is empty (clip B is far to the right) -> plain range menu,
      // no "Clip actions..." row, matching buildRangeMenu's onLane case.
      const before = await getHighlight(page)
      expect(before !== null, 'setup: expected the range from 5b to still be present')
      await page.mouse.click(rangeMidX, boxB.y + boxB.height / 2, { button: 'right' })
      const { rows } = await getMenuRows(page)
      const byLabel = (label) => rows.find((r) => r.text.startsWith(label))

      const play = byLabel('Play selection')
      const loop = byLabel('Loop selection')
      const zoom = byLabel('Zoom to selection')
      const split = byLabel('Split clips at range edges')
      const copy = byLabel('Copy range to inpaint')
      const clipActions = byLabel('Clip actions')
      // F24-7 wired the model (buildRangeMenu): a non-empty range labels this
      // row "Render range..." and enables it (disabled only when the range is
      // zero-length, which this UI range is not). F24-8 (wiring the row's
      // CLICK to the render popover + queue) is a separate, still-open ticket
      // per orchestration/tasks/daw/F24-8.md - at commit 60d4a44,
      // WaveformEditor.tsx's action map still has `render: { run: () => undefined }`.
      // So: enabled + correctly labelled is the CORRECT current state; a
      // silent no-op on click is the EXPECTED gap, not a new bug.
      const render = byLabel('Render range')
      const send = byLabel('Send range to gantasmob0t')
      const clear = byLabel('Clear range')

      expect(!!play && !play.disabled, `"Play selection" should be enabled, got ${JSON.stringify(play)}`)
      expect(!!loop && !loop.disabled, `"Loop selection" should be enabled, got ${JSON.stringify(loop)}`)
      expect(!!zoom && !zoom.disabled, `"Zoom to selection" should be enabled, got ${JSON.stringify(zoom)}`)
      expect(!!split && !split.disabled, `"Split clips at range edges" should be enabled (clip A crosses both edges), got ${JSON.stringify(split)}`)
      expect(!!copy && copy.disabled, `"Copy range to inpaint" should be disabled on this (clipless) lane, got ${JSON.stringify(copy)}`)
      expect(!!copy && copy.text.includes('No audio clip on this track is under the range'), `copy-to-inpaint disabled reason not visible/correct: ${JSON.stringify(copy)}`)
      expect(!clipActions, '"Clip actions..." should be absent when no clip is under the pointer')
      expect(!!render && !render.disabled, `"Render range..." should be enabled for a non-empty range (F24-7), got ${JSON.stringify(render)}`)
      expect(!!send && !send.disabled, `"Send range to gantasmob0t" should be enabled, got ${JSON.stringify(send)}`)
      expect(!!clear && !clear.disabled, `"Clear range" should be enabled, got ${JSON.stringify(clear)}`)

      // Right-click opening the menu must not itself have cleared the range.
      await page.keyboard.press('Escape') // closes the menu only (menuOpen guard)
      await page.waitForTimeout(100)
      const after = await getHighlight(page)
      expect(after !== null, 'opening (and closing) the range menu must not clear the range (T44 rule 5)')
    })

    // ---------------------------------------------------------------------
    await report.scenario('6b-render-range-click-is-known-noop-F24-8', async () => {
      // Clicking the enabled-but-not-yet-wired "Render range..." row must at
      // least fail SAFE: menu closes, no console error, range untouched, no
      // new render job UI appears. (F24-8 not yet applied at this commit.)
      const before = await getHighlight(page)
      expect(before !== null, 'setup: expected the range to still be present')
      const errsBefore = consoleErrors.length
      await page.mouse.click(rangeMidX, boxB.y + boxB.height / 2, { button: 'right' })
      const menu = page.locator('[role="menu"]')
      await menu.waitFor({ state: 'visible', timeout: 3000 })
      await menu.getByRole('menuitem', { name: /^Render range/ }).click()
      await page.waitForTimeout(150)
      expect(await menu.count() === 0 || !(await menu.isVisible()), 'the menu should close after selecting "Render range..."')
      const after = await getHighlight(page)
      expect(after !== null, 'the (known no-op) Render range click must not clear the time range')
      expect(consoleErrors.length === errsBefore, `Render range click threw new console error(s): ${JSON.stringify(consoleErrors.slice(errsBefore))}`)
    })

    // ---------------------------------------------------------------------
    await report.scenario('7-highlight-survives-edit-mix-edit', async () => {
      const before = await getHighlight(page)
      expect(before !== null, 'setup: expected a highlight before switching tabs')
      await page.locator('button[data-tour="tab-mix"]').click()
      await page.waitForTimeout(200)
      await page.locator('button[data-tour="tab-edit"]').click()
      await page.waitForTimeout(200)
      const after = await getHighlight(page)
      expect(after !== null, 'the time-range highlight should survive EDIT -> MIX -> EDIT')
      expect(after.text === before.text, `readout changed across tab switch: ${before.text} -> ${after.text}`)
    })

    // ---------------------------------------------------------------------
    await report.scenario('8-split-acts-on-exactly-the-clips-under-range', async () => {
      const beforeCount = await countClips(page)
      expect(beforeCount === 2, `setup: expected 2 clips before split, got ${beforeCount}`)
      await page.mouse.click(rangeMidX, boxB.y + boxB.height / 2, { button: 'right' })
      const menu = page.locator('[role="menu"]')
      await menu.waitFor({ state: 'visible', timeout: 3000 })
      await menu.getByRole('menuitem', { name: /^Split clips at range edges/ }).click()
      await page.waitForTimeout(300)
      const afterCount = await countClips(page)
      // Clip A's two in-range edges each produce a cut -> 1 clip becomes 3.
      // Clip B (never under the range) is untouched -> total 2 -> 4.
      expect(afterCount === 4, `expected clip A to split into 3 pieces (2 + 2 new = 4 total), got ${afterCount}`)
      const boxes = await clipBoxes(page)
      const stillHasB = boxes.some((b) => Math.abs(b.x - boxB.x) < 2 && Math.abs(b.width - boxB.width) < 2)
      expect(stillHasB, 'clip B (outside the range) should be untouched by Split, but no matching clip rect was found')
    })

    // ---------------------------------------------------------------------
    await report.scenario('9-clear-range-row-clears-the-highlight', async () => {
      await dragOnRuler(page, RX1, RX2, rulerY)
      const before = await getHighlight(page)
      expect(before !== null, 'setup: expected a fresh range before testing Clear range')
      await page.mouse.click(rangeMidX, boxB.y + boxB.height / 2, { button: 'right' })
      const menu = page.locator('[role="menu"]')
      await menu.waitFor({ state: 'visible', timeout: 3000 })
      await menu.getByRole('menuitem', { name: /^Clear range/ }).click()
      await page.waitForTimeout(100)
      const after = await getHighlight(page)
      expect(after === null, '"Clear range" should remove the highlight')
    })

    if (consoleErrors.length > 0) {
      bugs.push({
        title: 'Uncaught console errors during q03-time-range interactions',
        detail: consoleErrors.slice(0, 10).join('\n'),
      })
    }
  } catch (err) {
    bugs.push({ title: 'Unhandled script error', detail: String(err && err.stack ? err.stack : err) })
  } finally {
    const shot = report.shotPath('final-state')
    try {
      await page.screenshot({ path: shot, fullPage: false })
    } catch {
      // best-effort
    }
    report.finish()
    if (bugs.length) {
      console.log('\n--- extra notes ---')
      for (const b of bugs) console.log(`${b.title}\n${b.detail}\n`)
    }
    await browser.close()
  }
}

await main()
