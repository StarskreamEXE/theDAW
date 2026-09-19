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

/** Waits until a locator's bounding box stops moving (e.g. an add-track auto-scroll
 *  settling), then returns it. Two reads `intervalMs` apart must match within 1px. */
async function stableBox(locator, { intervalMs = 150, attempts = 15 } = {}) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    const box = await locator.boundingBox()
    expect(box, 'element must have a bounding box while waiting for it to settle')
    if (last && Math.abs(box.y - last.y) < 1 && Math.abs(box.x - last.x) < 1) return box
    last = box
    await locator.page().waitForTimeout(intervalMs)
  }
  return last
}

/** Click "Add track", wait for a new [data-track-grip] row, return its DOM index.
 *  Deliberately does NOT resolve a Y here: the panel re-settles its scroll on every
 *  add (confirmed by reading the same row's position before/after a LATER add-track
 *  call and seeing it move), so a Y captured right after this call goes stale the
 *  moment another track is added. Callers must resolve the Y via trackRowCenterY
 *  right before they use it, once no more track-count changes are pending. */
async function addTrackRow(page) {
  const before = await page.locator('[data-track-grip]').count()
  await page.locator('button[aria-label="Add track"]').click({ timeout: 15000 })
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-track-grip]').length === n,
    before + 1,
    { timeout: 15000 },
  )
  return before
}

/** Resolves a track header row's current, settled center Y (viewport px). Always call
 *  this as late as possible -- immediately before the click that uses it -- since any
 *  later addTrackRow() call invalidates a previously-read Y (see addTrackRow). */
async function trackRowCenterY(page, index) {
  const box = await stableBox(page.locator('[data-track-grip]').nth(index))
  expect(box, `track row at index ${index} must have a bounding box`)
  return box.y + box.height / 2
}

/** True if (x,y) in viewport space currently lands on a clip, per the DOM (not a guess). */
async function pointIsOnClip(page, x, y) {
  return page.evaluate(
    ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-clip="1"]'),
    { x, y },
  )
}

/** Right-click empty lane space at (x,y), pick "Audio from System...", feed it a file.
 *  The track panel's add-track auto-scroll can leave a just-added row's settled Y
 *  coincident with a clip placed earlier in the setup (see addTrackRow) -- rather than
 *  silently right-clicking a clip and hanging on a menu item that will never appear,
 *  nudge downward within the row to find genuinely empty space, or fail with a clear
 *  diagnostic instead of a bare 15s timeout. */
async function addAudioClipAt(page, x, y, fileName) {
  const before = await page.locator('[data-clip="1"]').count()
  let targetY = y
  for (let nudge = 0; nudge <= 60 && (await pointIsOnClip(page, x, targetY)); nudge += 15) {
    targetY = y + nudge
  }
  expect(
    !(await pointIsOnClip(page, x, targetY)),
    `(${x}, ${y}) and nearby points are all covered by an existing clip -- cannot right-click empty lane space there`,
  )
  await page.mouse.click(x, targetY, { button: 'right' })
  const item = page.getByText(/Audio from System/i).first()
  await item.waitFor({ state: 'visible', timeout: 15000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
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

/** Click a spot that is provably EMPTY LANE: inside the lanes element, with no clip under it.
 *  ("40 px below the lowest clip" used to be the spot, and with the clips on the bottom rows
 *  that is the transport bar, not the timeline - the selection was never cleared and every
 *  precondition after it failed.) Rows are scanned top-down, right-to-left. */
async function clickEmptyLane(page) {
  const spot = await page.evaluate((lanesSel) => {
    const lanes = document.querySelector(lanesSel)
    if (!lanes) return null
    const r = lanes.getBoundingClientRect()
    const bottom = Math.min(r.bottom, window.innerHeight) - 6
    for (let y = r.top + 12; y < bottom; y += 16) {
      for (let x = Math.min(r.right, window.innerWidth) - 24; x > r.left + 8; x -= 48) {
        const el = document.elementFromPoint(x, y)
        if (!el || !lanes.contains(el)) continue
        if (el.closest('[data-clip="1"]') || el.closest('button, input, select, [role="slider"]')) continue
        return { x, y }
      }
    }
    return null
  }, LANES_SEL)
  if (!spot) throw new Error('no empty lane space on screen to click')
  await page.mouse.click(spot.x, spot.y)
}

/** A Y (viewport px) just below the lowest currently-rendered clip -- read live off the
 *  DOM every time rather than reusing a box captured earlier in the run, since the track
 *  panel's settled scroll position moves whenever a track is added (see addTrackRow). */
async function belowLowestClipY(page) {
  const bottoms = await page
    .locator('[data-clip="1"]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom))
  if (bottoms.length) return Math.max(...bottoms) + 40
  const lanes = await page.locator(LANES_SEL).first().boundingBox()
  return lanes.y + 20
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
  /** Re-read the two clips and the lanes box from the LIVE page, once the layout has stopped
   *  moving. The boxes captured during setup go stale: the track panel scrolls itself after a
   *  track is added and again when a selection changes, and a gesture aimed at a stale box
   *  lands on the wrong clip (or on no clip). Called at the top of every scenario. */
  const refreshBoxes = async () => {
    let prev = null
    for (let i = 0; i < 20; i++) {
      const now = await clipStates(page)
      const sig = JSON.stringify(now.map((c) => [Math.round(c.x), Math.round(c.y)]))
      if (now.length === 2 && sig === prev) {
        ;[boxA, boxB] = now
        lanesBox = await page.locator(LANES_SEL).first().boundingBox()
        return
      }
      prev = sig
      await page.waitForTimeout(150)
    }
    throw new Error('the two clips never settled on screen')
  }

  try {
    // ---- Setup: EDIT view, two tracks with one clip each ----
    // A fresh QA data folder shows first-run onboarding on load: the "Welcome"
    // feature-tour overlay, then a full-screen HOME workspace picker -- both sit
    // above the tab bar and intercept the tab-edit click until dismissed. Skip
    // the tour, then prefer HOME's own "Open the Edit workspace" button; fall
    // back to the tab bar for a warm profile where HOME never appears.
    // Both onboarding surfaces can take a long time to mount under a busy
    // multi-agent swarm, so give each a generous budget; a warm profile that
    // never shows them falls through to the plain tab click.
    await page.getByText('Skip tour', { exact: true }).click({ timeout: 20000 }).catch(() => {})
    await page.getByRole('button', { name: 'Open the Edit workspace' }).click({ timeout: 20000 }).catch(async () => {
      // Warm profile: HOME never appeared (or "show at startup" was off) -- the tab bar is already live.
      await page.click('[data-tour="tab-edit"]', { timeout: 20000 })
    })
    // Whichever path got us here, make sure no onboarding overlay is still mounted --
    // LANES_SEL is a generic utility-class combo that can false-match a dialog's own
    // focus-trapped scroll container while a tour/home overlay is still up.
    await page.waitForSelector('[role="dialog"][aria-modal="true"]', { state: 'detached', timeout: 8000 }).catch(() => {})
    await page.waitForSelector(LANES_SEL, { timeout: 15000 })
    const tabPressed = await page.locator('[data-tour="tab-edit"]').getAttribute('aria-pressed').catch(() => null)
    expect(tabPressed === 'true', `must land on the EDIT tab (aria-pressed=true), got ${tabPressed}`)
    // The tab flips aria-pressed before the track panel finishes its own (async)
    // project init -- querying [data-track-grip]/clip counts before that settles
    // races a DOM that is still empty, so wait for a stable landmark first.
    await page.waitForSelector('button[aria-label="Add track"]', { state: 'visible', timeout: 20000 })
    await page.keyboard.press('Escape').catch(() => {})
    lanesBox = await page.locator(LANES_SEL).first().boundingBox()
    expect(lanesBox && lanesBox.width > 200, 'lanes container must be visible with a sane width')

    // Add BOTH tracks before resolving either row's Y (see addTrackRow/trackRowCenterY):
    // adding track B moves track A's settled position, so a Y read between the two
    // add-track calls would be stale by the time it is used.
    const idxA = await addTrackRow(page)
    const idxB = await addTrackRow(page)
    await addAudioClipAt(page, lanesBox.x + 80, await trackRowCenterY(page, idxA), 'tone-440-10s.wav')
    await addAudioClipAt(page, lanesBox.x + 80, await trackRowCenterY(page, idxB), 'tone-220-6s.wav')

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
    await refreshBoxes()
    await clickEmptyLane(page) // clear selection
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
    await refreshBoxes()
    await clickEmptyLane(page)
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
    await refreshBoxes()
    await clickEmptyLane(page)
    // Baseline: select clip A alone via a plain click on its TITLE BAR (the top 14 px). A click on
    // the waveform body places the edit cursor and does not select - see the lead's note in
    // orchestration/plans/P-20260918-daw-vst-timeline-plan.md (open behaviour question).
    await page.mouse.click(boxA.x + 40, boxA.y + 7)
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
    await refreshBoxes()
    await clickEmptyLane(page)
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
    await refreshBoxes()
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
    const idxC = await addTrackRow(page)
    const farX = lanesBox.x + lanesBox.width - 60
    await addAudioClipAt(page, farX, await trackRowCenterY(page, idxC), 'noise-5s.wav')
    await setScrollLeft(page, 0)

    const states0 = await clipStates(page)
    const clipC = states0[states0.length - 1]
    expect(clipC.x > lanesBox.x + lanesBox.width - 5, `clip C should start off-screen to the right, box=${JSON.stringify(clipC)}`)

    const scrollLeftBefore = await getScrollLeft(page)
    // Re-resolve row C's Y fresh (placing its clip and scrolling back to 0 can also
    // move the settled position -- see addTrackRow/trackRowCenterY).
    const rowCY = await trackRowCenterY(page, idxC)
    // Start a marquee near the left/visible area, then hold at the right edge to autoscroll.
    await page.mouse.move(lanesBox.x + 40, rowCY)
    await page.mouse.down()
    await page.mouse.move(lanesBox.x + 60, rowCY - 4)
    // The right edge of what is VISIBLE: the scroll container's box, not the lanes content
    // (which is as wide as the zoomed arrangement - a pointer sent there is off the window
    // and the page never receives the move).
    const vpBox = await page.locator('div[class*="overflow-x-auto"][class*="07050a"]').first().boundingBox()
    const edgeX = Math.min(vpBox.x + vpBox.width, page.viewportSize().width) - 3
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
    await refreshBoxes()
    await clickEmptyLane(page)
    // Re-read clip A's box live: the previous scenario added a third track, which
    // (per addTrackRow/trackRowCenterY) moves already-placed clips' settled position.
    const liveA = (await clipStates(page))[0]
    expect(liveA, 'clip A must still exist to press on it')
    await page.mouse.move(liveA.x + liveA.width / 2, liveA.y + liveA.height / 2)
    await page.mouse.down()
    await page.mouse.move(liveA.x + liveA.width / 2 + 40, liveA.y + liveA.height / 2 + 4, { steps: 6 })
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
