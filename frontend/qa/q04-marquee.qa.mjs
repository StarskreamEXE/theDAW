// QA area: q04-marquee — Drag on empty space to select clips (marquee)
//
// Run with:
//   cd "C:\Users\skream\projects\_thedaw-batch11\frontend" && node qa/q04-marquee.qa.mjs
//
// Reads: frontend/src/lib/timeline/pointerGesture.ts, timeSelection.ts,
// frontend/src/components/audio/WaveformEditor.tsx (onLanesPointerDown/Move/Up,
// onClipPointerDown, marqueeAutoscrollRef, timelineEscapeRef).

import { openApp, createReport, expect, ASSETS_DIR } from './qaLib.mjs'

const AREA = 'q04-marquee'
const LANES_SEL = 'div.relative.outline-none[tabindex="-1"]'
const SELECTED_CLASS = 'border-white'
const MARQUEE_OVERLAY_SEL = 'div[class*="bg-sky-400/10"]'
const EDIT_CURSOR_SEL = 'div[class*="border-sky-300/70"]'

function wav(name) {
  return `${ASSETS_DIR}/${name}`.replace(/\//g, '\\')
}

async function findScrollAncestor(page) {
  return page.evaluateHandle((sel) => {
    const lanes = document.querySelector(sel)
    let el = lanes ? lanes.parentElement : null
    while (el && el !== document.body) {
      if (el.scrollWidth > el.clientWidth + 1) return el
      el = el.parentElement
    }
    return lanes ? lanes.parentElement : null
  }, LANES_SEL)
}

async function getScrollLeft(page) {
  const h = await findScrollAncestor(page)
  return h.evaluate((el) => (el ? el.scrollLeft : null))
}

async function setScrollLeft(page, value) {
  const h = await findScrollAncestor(page)
  return h.evaluate((el, v) => {
    if (!el) return null
    el.scrollLeft = v === 'max' ? el.scrollWidth - el.clientWidth : v
    return el.scrollLeft
  }, value)
}

async function laneWidthPx(page) {
  const el = page.locator(LANES_SEL).first()
  const style = await el.getAttribute('style')
  const m = /width:\s*([0-9.]+)px/.exec(style || '')
  return m ? parseFloat(m[1]) : null
}

async function clipStates(page) {
  const boxes = await page.locator('[data-clip="1"]').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, selected: el.classList.contains('border-white') }
    }),
  )
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x)
}

async function editCursorLeft(page) {
  const el = page.locator(EDIT_CURSOR_SEL).first()
  const style = await el.getAttribute('style')
  const m = /left:\s*(-?[0-9.]+)px/.exec(style || '')
  return m ? parseFloat(m[1]) : null
}

async function marqueeOverlayCount(page) {
  return page.locator(MARQUEE_OVERLAY_SEL).count()
}

/** Click "Add track", wait for a new [data-track-grip] row, return its center Y (viewport px). */
async function addTrackRow(page) {
  const before = await page.locator('[data-track-grip]').count()
  await page.locator('button[aria-label="Add track"]').click()
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-track-grip]').length === n,
    before + 1,
    { timeout: 5000 },
  )
  const box = await page.locator('[data-track-grip]').nth(before).boundingBox()
  expect(box, 'new track header row must have a bounding box')
  return box.y + box.height / 2
}

/** Right-click empty lane space at (x,y), pick "Audio from System...", feed it a file. */
async function addAudioClipAt(page, x, y, fileName) {
  const before = await page.locator('[data-clip="1"]').count()
  await page.mouse.click(x, y, { button: 'right' })
  const item = page.getByText(/Audio from System/i).first()
  await item.waitFor({ state: 'visible', timeout: 5000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    item.click(),
  ])
  await chooser.setFiles(wav(fileName))
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-clip="1"]').length === n,
    before + 1,
    { timeout: 10000 },
  )
}

async function clickEmpty(page, x, y) {
  await page.mouse.click(x, y)
}

/** Press-move-hold a marquee gesture; caller decides when to release/cancel. */
async function beginMarquee(page, x1, y1, x2, y2, modifiers = []) {
  for (const m of modifiers) await page.keyboard.down(m)
  await page.mouse.move(x1, y1)
  await page.mouse.down()
  await page.mouse.move(x1 + 8, y1 + 8) // cross the 4px threshold
  await page.mouse.move(x2, y2, { steps: 12 })
  return {
    release: async () => {
      await page.mouse.up()
      for (const m of modifiers.slice().reverse()) await page.keyboard.up(m)
    },
  }
}

async function main() {
  const { browser, page, consoleErrors } = await openApp({ width: 1600, height: 900 })
  const report = createReport(AREA)
  let setupOk = false
  let boxA = null
  let boxB = null
  let lanesBox = null

  try {
    // ---- Setup: EDIT view, two tracks with one clip each ----
    await page.click('[data-tour="tab-edit"]')
    await page.waitForSelector(LANES_SEL, { timeout: 10000 })
    await page.keyboard.press('Escape').catch(() => {})
    lanesBox = await page.locator(LANES_SEL).first().boundingBox()
    expect(lanesBox && lanesBox.width > 200, 'lanes container must be visible with a sane width')

    const rowAY = await addTrackRow(page)
    await addAudioClipAt(page, lanesBox.x + 80, rowAY, 'tone-440-10s.wav')
    const rowBY = await addTrackRow(page)
    await addAudioClipAt(page, lanesBox.x + 80, rowBY, 'tone-220-6s.wav')

    let states = await clipStates(page)
    expect(states.length === 2, `expected 2 clips after setup, got ${states.length}`)
    ;[boxA, boxB] = states
    await page.screenshot({ path: report.shotPath('00-setup-two-clips') })
    setupOk = true
  } catch (err) {
    console.log('SETUP FAILED:', err && err.message ? err.message : err)
  }

  if (!setupOk) {
    for (const name of [
      'cross-track-marquee-select',
      'modifier-add-toggle-replace',
      'autoscroll-grows-selection',
      'escape-cancels-restores-baseline',
      'clip-press-never-starts-marquee',
      'marquee-does-not-move-edit-cursor',
    ]) {
      await report.scenario(name, () => {
        throw new Error('BLOCKED: setup (two tracks + two clips) failed, see SETUP FAILED log above')
      })
    }
    report.finish()
    await browser.close()
    return
  }

  await report.scenario('cross-track-marquee-select', async () => {
    await clickEmpty(page, lanesBox.x + 10, boxB.y + boxB.height + 40) // clear selection
    let s = await clipStates(page)
    expect(!s[0].selected && !s[1].selected, 'precondition: nothing selected before drag')

    const startX = Math.min(boxA.x, boxB.x) - 20
    const startY = lanesBox.y + 2
    const endX = Math.max(boxA.x + boxA.width, boxB.x + boxB.width) + 30
    const endY = boxB.y + boxB.height + 20
    const g = await beginMarquee(page, startX, startY, endX, endY)
    await g.release()

    s = await clipStates(page)
    await page.screenshot({ path: report.shotPath('01-cross-track-select') })
    expect(s[0].selected && s[1].selected, `expected both clips selected across tracks, got ${JSON.stringify(s)}`)
  })

  await report.scenario('modifier-add-toggle-replace', async () => {
    await clickEmpty(page, lanesBox.x + 10, boxB.y + boxB.height + 40)
    let s = await clipStates(page)
    expect(!s[0].selected && !s[1].selected, 'precondition: nothing selected')

    // Plain drag over only A -> replace: A selected, B not.
    let g = await beginMarquee(page, boxA.x - 8, boxA.y - 8, boxA.x + boxA.width + 3, boxA.y + boxA.height + 3)
    await g.release()
    s = await clipStates(page)
    expect(s[0].selected && !s[1].selected, `plain drag over A should select only A, got ${JSON.stringify(s)}`)

    // Shift+drag over only B -> add: both selected.
    g = await beginMarquee(page, boxB.x - 8, boxB.y - 8, boxB.x + boxB.width + 3, boxB.y + boxB.height + 3, ['Shift'])
    await g.release()
    s = await clipStates(page)
    await page.screenshot({ path: report.shotPath('02a-shift-add') })
    expect(s[0].selected && s[1].selected, `shift+drag over B should ADD to selection (A stays), got ${JSON.stringify(s)}`)

    // Ctrl+drag over only B -> toggle: B removed, A stays.
    g = await beginMarquee(page, boxB.x - 8, boxB.y - 8, boxB.x + boxB.width + 3, boxB.y + boxB.height + 3, ['Control'])
    await g.release()
    s = await clipStates(page)
    await page.screenshot({ path: report.shotPath('02b-ctrl-toggle') })
    expect(s[0].selected && !s[1].selected, `ctrl+drag over B should TOGGLE B off (A stays), got ${JSON.stringify(s)}`)
  })

  await report.scenario('escape-cancels-restores-baseline', async () => {
    await clickEmpty(page, lanesBox.x + 10, boxB.y + boxB.height + 40)
    // Baseline: select clip A alone via a plain click on it.
    await page.mouse.click(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2)
    let s = await clipStates(page)
    expect(s[0].selected && !s[1].selected, `baseline should be A only, got ${JSON.stringify(s)}`)

    const startX = Math.min(boxA.x, boxB.x) - 20
    const startY = lanesBox.y + 2
    const endX = Math.max(boxA.x + boxA.width, boxB.x + boxB.width) + 30
    const endY = boxB.y + boxB.height + 20
    const g = await beginMarquee(page, startX, startY, endX, endY)

    s = await clipStates(page)
    expect(s[0].selected && s[1].selected, `mid-drag both should be selected before Escape, got ${JSON.stringify(s)}`)

    await page.keyboard.press('Escape')
    await g.release()

    s = await clipStates(page)
    await page.screenshot({ path: report.shotPath('03-escape-restore') })
    expect(
      s[0].selected && !s[1].selected,
      `Escape mid-drag must restore pre-drag baseline (A only), got ${JSON.stringify(s)}`,
    )
  })

  await report.scenario('marquee-does-not-move-edit-cursor', async () => {
    await clickEmpty(page, lanesBox.x + 10, boxB.y + boxB.height + 40)
    const before = await editCursorLeft(page)

    const startX = Math.min(boxA.x, boxB.x) - 20
    const startY = lanesBox.y + 2
    const endX = Math.max(boxA.x + boxA.width, boxB.x + boxB.width) + 30
    const endY = boxB.y + boxB.height + 20
    const g = await beginMarquee(page, startX, startY, endX, endY)
    await g.release()

    const afterMarquee = await editCursorLeft(page)
    expect(
      before !== null && afterMarquee !== null && Math.abs(afterMarquee - before) < 0.5,
      `marquee drag must not move the edit cursor (before=${before}, after=${afterMarquee})`,
    )

    // Sanity: a genuine plain click on empty space DOES move the cursor.
    const clickX = boxB.x + boxB.width + 120
    const clickY = boxB.y + boxB.height / 2
    await clickEmpty(page, clickX, clickY)
    const afterClick = await editCursorLeft(page)
    await page.screenshot({ path: report.shotPath('04-cursor-click-vs-marquee') })
    expect(
      afterClick !== null && Math.abs(afterClick - afterMarquee) > 0.5,
      `sanity check failed: a plain empty-lane click should move the edit cursor (afterMarquee=${afterMarquee}, afterClick=${afterClick})`,
    )
  })

  await report.scenario('autoscroll-grows-selection', async () => {
    // Try to force horizontal overflow by zooming in with ctrl+wheel over the lanes.
    const widthBefore = await laneWidthPx(page)
    await page.mouse.move(lanesBox.x + lanesBox.width / 2, lanesBox.y + 40)
    await page.keyboard.down('Control')
    for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -120)
    await page.keyboard.up('Control')
    let widthAfter = await laneWidthPx(page)
    if (!(widthAfter > widthBefore * 1.3)) {
      // wrong wheel direction for this app's zoom convention -- try the other way
      await page.keyboard.down('Control')
      for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 120)
      await page.keyboard.up('Control')
      widthAfter = await laneWidthPx(page)
    }
    const scrollWidthNow = await page.evaluate(() => document.querySelector('body')?.scrollWidth ?? 0)
    void scrollWidthNow
    const canScroll = (await setScrollLeft(page, 'max')) > 5
    if (!canScroll) {
      throw new Error(
        `BLOCKED: could not establish horizontal overflow to exercise autoscroll (laneWidth before=${widthBefore} after=${widthAfter})`,
      )
    }

    // Add a third track + clip near the far right (currently visible since we scrolled to max).
    const rowCY = await addTrackRow(page)
    const farX = lanesBox.x + lanesBox.width - 60
    await addAudioClipAt(page, farX, rowCY, 'noise-5s.wav')
    await setScrollLeft(page, 0)

    const states0 = await clipStates(page)
    const clipC = states0[states0.length - 1]
    expect(clipC.x > lanesBox.x + lanesBox.width - 5, `clip C should start off-screen to the right, box=${JSON.stringify(clipC)}`)

    const scrollLeftBefore = await getScrollLeft(page)
    // Start a marquee near the left/visible area, then hold at the right edge to autoscroll.
    await page.mouse.move(lanesBox.x + 40, rowCY)
    await page.mouse.down()
    await page.mouse.move(lanesBox.x + 60, rowCY - 4)
    const edgeX = lanesBox.x + lanesBox.width - 2
    await page.mouse.move(edgeX, rowCY, { steps: 5 })
    await page.waitForTimeout(900) // let the rAF autoscroll loop run
    const scrollLeftAfter = await getScrollLeft(page)
    await page.mouse.up()

    const statesFinal = await clipStates(page)
    await page.screenshot({ path: report.shotPath('05-autoscroll-select') })
    expect(scrollLeftAfter > scrollLeftBefore, `autoscroll should have advanced scrollLeft (${scrollLeftBefore} -> ${scrollLeftAfter})`)
    expect(
      statesFinal[statesFinal.length - 1].selected,
      `off-screen clip C should be selected once the autoscrolling marquee reached it`,
    )
  })

  await report.scenario('clip-press-never-starts-marquee', async () => {
    await clickEmpty(page, lanesBox.x + 10, boxB.y + boxB.height + 40)
    await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2)
    await page.mouse.down()
    await page.mouse.move(boxA.x + boxA.width / 2 + 40, boxA.y + boxA.height / 2 + 4, { steps: 6 })
    const overlayDuringDrag = await marqueeOverlayCount(page)
    await page.screenshot({ path: report.shotPath('06-press-on-clip-no-marquee') })
    await page.mouse.up()
    expect(overlayDuringDrag === 0, 'a press-drag starting on a clip body must never show the marquee rubber band')
  })

  const failed = report.finish()
  const badConsole = consoleErrors.filter(Boolean)
  if (badConsole.length) {
    console.log(`\nConsole errors captured during the run (${badConsole.length}):`)
    for (const c of badConsole.slice(0, 10)) console.log(' -', c)
  }
  void failed
  await browser.close()
}

main().catch(async (err) => {
  console.error('FATAL:', err)
  process.exitCode = 1
})
