// QA area q02-zoom-wheel: zoom + mouse wheel behaviour in the EDIT timeline.
// Run with: cd "C:\Users\skream\projects\_thedaw-batch11/frontend" && node qa/q02-zoom-wheel.qa.mjs
//
// Reads (pinned commit 60d4a44): components/audio/timelineZoom.ts,
// lib/timeline/viewport.ts, state/timelinePrefsStore.ts, state/editorStore.ts
// (ZOOM_MIN=0.25, ZOOM_MAX=400, TRACK_HEIGHT_MIN=56, TRACK_HEIGHT_MAX=260,
// default zoom=30), components/audio/WaveformEditor.tsx (requestZoom,
// wheel handler, onTimelineDrop), components/audio/TimelinePrefsPanel.tsx.

import { readFileSync } from 'node:fs'
import { openApp, createReport, expect, expectClose, ASSETS_DIR } from './qaLib.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCondition(fn, timeout = 10000, interval = 150) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await sleep(interval)
  }
  return false
}

/** Simulate a real desktop file drop (Playwright's documented technique: a
 *  DataTransfer built in-page from base64 bytes, dispatched as dragover+drop
 *  DOM events on the target). */
async function dropFileOnto(page, locator, filePath, mimeType, clientX, clientY) {
  const base64 = readFileSync(filePath).toString('base64')
  const name = filePath.split(/[\\/]/).pop()
  const dataTransfer = await page.evaluateHandle(
    ({ base64, name, type }) => {
      const bin = atob(base64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const file = new File([arr], name, { type })
      const dt = new DataTransfer()
      dt.items.add(file)
      return dt
    },
    { base64, name, type: mimeType },
  )
  await locator.dispatchEvent('dragover', { dataTransfer, clientX, clientY })
  await locator.dispatchEvent('drop', { dataTransfer, clientX, clientY })
}

async function main() {
  const { page, consoleErrors } = await openApp({ width: 1600, height: 900 })
  const report = createReport('q02-zoom-wheel')
  const shot = (name) => page.screenshot({ path: report.shotPath(name) }).catch(() => {})

  try {
    // Dismiss the first-run "Welcome to theDAW" tour overlay. On a fresh QA
    // data folder it does not appear immediately: it shows up somewhere
    // between ~6s and ~10s after load (after the boot splash finishes), so a
    // one-shot check at t=0 misses it and it then pops up mid-click on the
    // Edit tab and blocks for the rest of that click's timeout. Wait for the
    // close button across that whole window instead of a fixed short probe.
    try {
      const dismiss = page.getByRole('button', { name: /close tour|skip|got it|dismiss/i }).first()
      await dismiss.waitFor({ state: 'visible', timeout: 16000 })
      await dismiss.click()
      await sleep(200)
    } catch {
      /* no overlay this run: fine */
    }

    // --- Navigate to EDIT ---
    // A fresh QA data folder has no project yet, so the app opens on the
    // modal HOME screen (role="dialog", aria-labelledby="home-title") which
    // covers the top tab bar until dismissed. Its own "Open the Edit
    // workspace" tile dismisses Home and switches workspace in one action;
    // fall back to the top-bar Edit tab if Home did not appear this run.
    const homeEditTile = page.getByRole('button', { name: 'Open the Edit workspace' })
    try {
      await homeEditTile.waitFor({ state: 'visible', timeout: 5000 })
      await homeEditTile.click()
    } catch {
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
    }
    await sleep(150)
    const scroller = page.locator('[class*="07050a"]').first()
    await scroller.waitFor({ state: 'visible', timeout: 10000 })
    const ruler = scroller.locator(':scope > div').nth(0)
    const lanes = scroller.locator(':scope > div').nth(1)

    const metrics = async () => {
      const handle = await scroller.elementHandle()
      return page.evaluate(
        (el) => ({
          scrollWidth: el.scrollWidth,
          scrollLeft: el.scrollLeft,
          scrollTop: el.scrollTop,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight,
        }),
        handle,
      )
    }
    const cursorMarker = () => page.locator('[role="img"][aria-label^="Edit cursor at"]')
    const cursorScreenX = async () => {
      const box = await cursorMarker().boundingBox()
      return box ? box.x + box.width / 2 : null
    }
    const wheelAt = async (dx, dy, mods = []) => {
      const box = await scroller.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height - 10, 150))
      for (const k of mods) await page.keyboard.down(k)
      await page.mouse.wheel(dx, dy)
      for (const k of mods) await page.keyboard.up(k)
      await sleep(150)
    }
    const zoomInBtn = page.getByRole('button', { name: 'Zoom in around the edit cursor' })
    const zoomOutBtn = page.getByRole('button', { name: 'Zoom out around the edit cursor' })
    const fitBtn = page.getByRole('button', { name: 'Zoom to fit the whole arrangement' })
    const heightSlider = page.locator('#editor-track-height')

    // --- Setup: 4 different clips on 4 tracks (real duration, real overflow) ---
    await report.scenario('setup-import-four-clips-onto-timeline', async () => {
      const files = [
        ['tone-440-10s.wav', 'audio/wav'],
        ['tone-220-6s.wav', 'audio/wav'],
        ['click-120bpm-16s.wav', 'audio/wav'],
        ['noise-5s.wav', 'audio/wav'],
      ]
      for (const [fname, mime] of files) {
        const before = await lanes.locator('> *').count()
        const box = await lanes.boundingBox()
        const y = Math.max(10, box.height + 5)
        await dropFileOnto(page, lanes, `${ASSETS_DIR}/${fname}`, mime, box.x + 60, box.y + y)
        const grew = await waitForCondition(async () => (await lanes.locator('> *').count()) > before, 10000)
        expect(grew, `dropping ${fname} should add a track/clip to the timeline (child count stayed ${before})`)
        await sleep(250)
      }
      await shot('01-four-clips-imported')
    })

    // Baseline zoom: fit, then 3 steps in — comfortably mid-range with real
    // scroll headroom (content clearly wider than the viewport) but nowhere
    // near ZOOM_MIN/MAX, so ratio- and anchor-based checks below are not
    // confused by bound clamping.
    await fitBtn.click()
    await sleep(150)
    for (let i = 0; i < 3; i++) {
      await zoomInBtn.click()
      await sleep(60)
    }
    await heightSlider.fill('260') // tall lanes -> vertical overflow for the alt-wheel check
    await sleep(150)

    const baseline = await metrics()
    await report.scenario('setup-scroll-range-available', async () => {
      expect(
        baseline.scrollWidth > baseline.clientWidth + 50,
        `need horizontal scroll range to test anchoring (scrollWidth=${baseline.scrollWidth}, clientWidth=${baseline.clientWidth})`,
      )
    })

    // Place the edit cursor away from the very start via a ruler click.
    const rulerBox = await ruler.boundingBox()
    const labelBefore = await cursorMarker().getAttribute('aria-label')
    await page.mouse.click(rulerBox.x + rulerBox.width * 0.5, rulerBox.y + rulerBox.height / 2)
    await sleep(100)
    const labelAfterRulerClick = await cursorMarker().getAttribute('aria-label')
    await report.scenario('setup-ruler-click-moves-edit-cursor', async () => {
      expect(
        labelAfterRulerClick !== labelBefore,
        `a ruler click should move the edit cursor (label stayed "${labelAfterRulerClick}")`,
      )
    })

    // --- 1. Plain wheel zooms TIME, anchored on the edit cursor ---
    await report.scenario('plain-wheel-zooms-time-anchored-on-edit-cursor', async () => {
      const m0 = await metrics()
      const x0 = await cursorScreenX()
      await wheelAt(0, -150)
      const m1 = await metrics()
      const x1 = await cursorScreenX()
      expect(m1.scrollWidth !== m0.scrollWidth, `plain wheel should change TIME zoom (scrollWidth stayed ${m0.scrollWidth})`)
      expectClose(x1, x0, 2, 'edit cursor should stay at the same screen x after a plain wheel zoom')
    })

    // --- 2. Ctrl+wheel = fine zoom (smaller step than plain wheel) ---
    await report.scenario('ctrl-wheel-is-a-finer-zoom-step-than-plain', async () => {
      const w0 = (await metrics()).scrollWidth
      await wheelAt(0, -150)
      const w1 = (await metrics()).scrollWidth
      const ratioPlain = w1 / w0
      const w2 = (await metrics()).scrollWidth
      await wheelAt(0, -150, ['Control'])
      const w3 = (await metrics()).scrollWidth
      const ratioFine = w3 / w2
      expect(
        Math.abs(ratioFine - 1) < Math.abs(ratioPlain - 1),
        `ctrl+wheel step (ratio ${ratioFine.toFixed(4)}) should be smaller than plain wheel step (ratio ${ratioPlain.toFixed(4)})`,
      )
    })

    // --- 3a. Shift+wheel = horizontal scroll ---
    await report.scenario('shift-wheel-scrolls-horizontally', async () => {
      const m0 = await metrics()
      await wheelAt(0, 150, ['Shift'])
      const m1 = await metrics()
      expect(m1.scrollLeft !== m0.scrollLeft, `shift+wheel should change scrollLeft (stayed ${m0.scrollLeft})`)
      expect(m1.scrollTop === m0.scrollTop, `shift+wheel should not move scrollTop (was ${m0.scrollTop}, now ${m1.scrollTop})`)
    })

    // --- 3b. Alt+wheel = vertical scroll ---
    await report.scenario('alt-wheel-scrolls-vertically', async () => {
      const m0 = await metrics()
      expect(m0.scrollTop === 0, `test assumes scrollTop starts at 0 (was ${m0.scrollTop}) — script setup issue, not a product bug`)
      await wheelAt(0, 150, ['Alt'])
      const m1 = await metrics()
      expect(m1.scrollTop !== m0.scrollTop, `alt+wheel should change scrollTop (stayed ${m0.scrollTop}) — lanes height was set to max for overflow`)
      expect(m1.scrollLeft === m0.scrollLeft, `alt+wheel should not move scrollLeft (was ${m0.scrollLeft}, now ${m1.scrollLeft})`)
    })

    // --- 3c. Ctrl+Shift+wheel = lane height ---
    await report.scenario('ctrl-shift-wheel-changes-lane-height', async () => {
      await heightSlider.fill('260')
      await sleep(100)
      const before = await heightSlider.inputValue()
      await wheelAt(0, 150, ['Control', 'Shift']) // positive deltaY = shrink, per code comment
      const after = await heightSlider.inputValue()
      expect(Number(after) < Number(before), `ctrl+shift+wheel should shrink lane height (was ${before}, now ${after})`)
    })

    // --- 4. At ZOOM_MIN / ZOOM_MAX, further wheel ticks change nothing ---
    await report.scenario('zoom-max-bound-ignores-further-wheel-ticks', async () => {
      for (let i = 0; i < 45; i++) {
        await zoomInBtn.click()
      }
      await sleep(150)
      const m0 = await metrics()
      const x0 = await cursorScreenX()
      await wheelAt(0, -150)
      const m1 = await metrics()
      const x1 = await cursorScreenX()
      expect(m1.scrollWidth === m0.scrollWidth, `zoom should stay clamped at ZOOM_MAX (scrollWidth ${m0.scrollWidth} -> ${m1.scrollWidth})`)
      const jumped = Math.abs(x1 - x0) > 2 || m1.scrollLeft !== m0.scrollLeft
      report.note = report.note ?? []
      report.note.push(
        `zoom-max: cursor x ${x0}->${x1}, scrollLeft ${m0.scrollLeft}->${m1.scrollLeft} — ${jumped ? 'a view yank occurred (matches known ticket F3 if this is the only symptom)' : 'no yank observed'}`,
      )
    })
    await shot('02-at-zoom-max')

    await report.scenario('zoom-min-bound-ignores-further-wheel-ticks', async () => {
      for (let i = 0; i < 60; i++) {
        await zoomOutBtn.click()
      }
      await sleep(150)
      const m0 = await metrics()
      const x0 = await cursorScreenX()
      await wheelAt(0, 150)
      const m1 = await metrics()
      const x1 = await cursorScreenX()
      expect(m1.scrollWidth === m0.scrollWidth, `zoom should stay clamped at ZOOM_MIN (scrollWidth ${m0.scrollWidth} -> ${m1.scrollWidth})`)
      const jumped = Math.abs(x1 - x0) > 2 || m1.scrollLeft !== m0.scrollLeft
      report.note = report.note ?? []
      report.note.push(
        `zoom-min: cursor x ${x0}->${x1}, scrollLeft ${m0.scrollLeft}->${m1.scrollLeft} — ${jumped ? 'a view yank occurred (matches known ticket F3 if this is the only symptom)' : 'no yank observed'}`,
      )
    })
    await shot('03-at-zoom-min')

    // Back to a comfortable mid zoom with real scroll range for the rest.
    await fitBtn.click()
    await sleep(120)
    for (let i = 0; i < 3; i++) {
      await zoomInBtn.click()
      await sleep(60)
    }
    await sleep(120)

    // --- 5. Toolbar buttons and zoom keys use the same (edit-cursor) anchor ---
    await report.scenario('toolbar-button-and-plus-minus-keys-share-the-anchor', async () => {
      const rBox = await ruler.boundingBox()
      await page.mouse.click(rBox.x + rBox.width * 0.35, rBox.y + rBox.height / 2)
      await sleep(100)

      const x0 = await cursorScreenX()
      await zoomInBtn.click()
      await sleep(120)
      const x1 = await cursorScreenX()
      expectClose(x1, x0, 2, 'the toolbar zoom-in button should keep the edit cursor at the same screen x')

      const x2 = await cursorScreenX()
      const box = await scroller.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.press('+')
      await sleep(120)
      const x3 = await cursorScreenX()
      expectClose(x3, x2, 2, 'the "+" zoom key should keep the edit cursor at the same screen x')
    })

    // --- 6. The page itself never scrolls or browser-zooms over the timeline ---
    await report.scenario('page-never-scrolls-or-browser-zooms', async () => {
      const before = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
        dpr: window.devicePixelRatio,
        vw: window.innerWidth,
      }))
      await wheelAt(0, -150)
      await wheelAt(0, 150, ['Shift'])
      await wheelAt(0, 150, ['Alt'])
      await wheelAt(0, -150, ['Control'])
      await wheelAt(0, 150, ['Control', 'Shift'])
      const after = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
        dpr: window.devicePixelRatio,
        vw: window.innerWidth,
      }))
      expect(after.x === before.x && after.y === before.y, `the page must not scroll (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`)
      expect(
        after.dpr === before.dpr && after.vw === before.vw,
        `the page must not browser-zoom (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`,
      )
    })

    // --- 6b. Targeted: ctrl+shift+wheel AT the lane-height bounds must still preventDefault ---
    await report.scenario('lane-height-bounds-do-not-leak-to-native-browser-zoom', async () => {
      const before = await page.evaluate(() => ({ dpr: window.devicePixelRatio, vw: window.innerWidth }))
      await heightSlider.fill('260')
      await sleep(100)
      await wheelAt(0, -150, ['Control', 'Shift']) // try to grow past max
      const afterMax = await page.evaluate(() => ({ dpr: window.devicePixelRatio, vw: window.innerWidth }))
      const valAfterMax = await heightSlider.inputValue()

      await heightSlider.fill('56')
      await sleep(100)
      await wheelAt(0, 150, ['Control', 'Shift']) // try to shrink past min
      const afterMin = await page.evaluate(() => ({ dpr: window.devicePixelRatio, vw: window.innerWidth }))
      const valAfterMin = await heightSlider.inputValue()

      expect(valAfterMax === '260', `lane height should stay clamped at TRACK_HEIGHT_MAX (got ${valAfterMax})`)
      expect(valAfterMin === '56', `lane height should stay clamped at TRACK_HEIGHT_MIN (got ${valAfterMin})`)
      expect(
        afterMax.dpr === before.dpr && afterMax.vw === before.vw,
        `ctrl+shift+wheel at the max lane-height bound must not browser-zoom (${JSON.stringify(before)} -> ${JSON.stringify(afterMax)})`,
      )
      expect(
        afterMin.dpr === before.dpr && afterMin.vw === before.vw,
        `ctrl+shift+wheel at the min lane-height bound must not browser-zoom (${JSON.stringify(before)} -> ${JSON.stringify(afterMin)})`,
      )
    })

    // --- 7. Alternative wheel profile (REAPER) switches the bindings ---
    await report.scenario('reaper-wheel-profile-switches-bindings', async () => {
      // The slider is step=4 from min=56 (56, 60, 64, ...): 150 is not on that
      // grid, so the browser's range-input validity check rejects it and
      // Playwright's fill() throws "Malformed value". 156 (56 + 4*25) is a
      // real reachable mid-range value.
      await heightSlider.fill('156')
      await sleep(100)
      await page.getByRole('button', { name: 'Timeline preferences' }).click()
      await page.getByRole('radio', { name: /reaper/i }).check()
      await page.getByRole('button', { name: 'Close timeline preferences' }).click()
      await sleep(100)

      // REAPER: ctrl = resize-lanes (not zoom).
      const valBefore = await heightSlider.inputValue()
      const wBefore = (await metrics()).scrollWidth
      await wheelAt(0, -150, ['Control'])
      const valAfter = await heightSlider.inputValue()
      const wAfter = (await metrics()).scrollWidth
      expect(valAfter !== valBefore, `reaper profile: ctrl+wheel should resize lanes (value stayed ${valBefore})`)
      expect(wAfter === wBefore, `reaper profile: ctrl+wheel should NOT change TIME zoom (scrollWidth ${wBefore} -> ${wAfter})`)

      // REAPER: ctrl+shift = fine zoom (not lane height).
      const valBefore2 = await heightSlider.inputValue()
      const wBefore2 = (await metrics()).scrollWidth
      await wheelAt(0, -150, ['Control', 'Shift'])
      const valAfter2 = await heightSlider.inputValue()
      const wAfter2 = (await metrics()).scrollWidth
      expect(valAfter2 === valBefore2, `reaper profile: ctrl+shift+wheel should NOT change lane height (value ${valBefore2} -> ${valAfter2})`)
      expect(wAfter2 !== wBefore2, `reaper profile: ctrl+shift+wheel should change TIME zoom (scrollWidth stayed ${wBefore2})`)

      // Restore theDAW profile.
      await page.getByRole('button', { name: 'Timeline preferences' }).click()
      await page.getByRole('radio', { name: /^theDAW/i }).check()
      await page.getByRole('button', { name: 'Close timeline preferences' }).click()
    })

    // --- Console-error sweep ---
    await report.scenario('no-uncaught-console-errors-from-this-session', async () => {
      expect(consoleErrors.length === 0, `uncaught console errors: ${JSON.stringify(consoleErrors)}`)
    })

    if (report.note) console.log('\nNOTES:\n' + report.note.map((n) => `  - ${n}`).join('\n'))
  } finally {
    report.finish()
    await page.context().browser().close()
  }
}

main().catch((err) => {
  console.error('QA SCRIPT CRASHED:', err)
  process.exitCode = 1
})
