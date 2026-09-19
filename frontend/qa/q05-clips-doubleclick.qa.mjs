// QA area q05-clips-doubleclick — Clip title chrome, double-click to edit
// (MIDI and audio drawer).
//
// Run with:
//   cd "C:\Users\skream\projects\_thedaw-batch11/frontend" && node qa/q05-clips-doubleclick.qa.mjs
//
// Reads: frontend/src/components/audio/clipDoubleClick.ts,
// frontend/src/components/layout/AudioEditorPanel.tsx,
// frontend/src/state/audioEditorStore.ts, frontend/src/lib/clipEditTarget.ts,
// frontend/src/components/audio/WaveformEditor.tsx (onClipDoubleClick,
// editClipInAudioEditor, editClipInPianoRoll, clip header chrome),
// frontend/src/lib/timeline/viewport.ts (clipChromeTier thresholds),
// frontend/src/components/audio/PianoRoll.tsx (handleSendToEditor, Clear key).

import { openApp, createReport, expect, ASSETS_DIR } from './qaLib.mjs'

const AREA = 'q05-clips-doubleclick'
const LANES_SEL = 'div.relative.outline-none[tabindex="-1"]'

function wav(name) {
  return `${ASSETS_DIR}/${name}`.replace(/\//g, '\\')
}

// ── scroll helpers (same pattern as q04-marquee.qa.mjs) ─────────────────────

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

async function setScrollLeft(page, value) {
  const h = await findScrollAncestor(page)
  return h.evaluate((el, v) => {
    if (!el) return null
    el.scrollLeft = v
    return el.scrollLeft
  }, value)
}

/** Center point (viewport px) of an existing track row, at a fixed x. Reads
 *  real [data-track-grip] geometry rather than guessing trackH, so it works
 *  whether the project starts with 0 tracks or (as this QA data folder does)
 *  a handful of pre-existing empty ones. */
async function trackRowPoint(page, index, x = 420) {
  const grip = page.locator('[data-track-grip]').nth(index)
  const box = await grip.boundingBox()
  expect(box, `track row ${index} must have a bounding box (add a track first if it does not exist)`)
  return { x, y: box.y + box.height / 2 }
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
  return page.locator('[data-clip="1"]').nth(before)
}

/** Right-click empty lane space at (x,y), pick "MIDI from System...", feed it bytes. */
async function addMidiClipAt(page, x, y, buffer, fileName) {
  const before = await page.locator('[data-clip="1"]').count()
  await page.mouse.click(x, y, { button: 'right' })
  const item = page.getByText(/MIDI from System/i).first()
  await item.waitFor({ state: 'visible', timeout: 5000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    item.click(),
  ])
  await chooser.setFiles({ name: fileName, mimeType: 'audio/midi', buffer })
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-clip="1"]').length === n,
    before + 1,
    { timeout: 10000 },
  )
  return page.locator('[data-clip="1"]').nth(before)
}

/** A minimal, standards-valid Standard MIDI File (format 0, 1 track, 1 note). */
function beU32(n) {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}
function oneNoteMidiBytes() {
  const track = Buffer.from([
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo meta: 500000 us/qtr (120bpm)
    0x00, 0x90, 0x3c, 0x64, // delta 0, Note On ch0 note60(C4) vel100
    0x60, 0x80, 0x3c, 0x40, // delta 96 (1 qtr @ 96 ppq), Note Off vel64
    0x00, 0xff, 0x2f, 0x00, // delta 0, End of Track
  ])
  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // chunk length = 6
    0x00, 0x00, // format 0
    0x00, 0x01, // 1 track
    0x00, 0x60, // division = 96 ticks/quarter
  ])
  const trackHeader = Buffer.concat([Buffer.from([0x4d, 0x54, 0x72, 0x6b]), beU32(track.length)])
  return Buffer.concat([header, trackHeader, track])
}

/** Which chrome tier a clip's header is showing, read from which button exists
 *  (mirrors WaveformEditor.tsx's clip header render, not the pure-fn tests). */
async function chromeTierOf(page, label) {
  const fx = page.getByRole('button', { name: `Open track FX for clip ${label}` })
  const more = page.getByRole('button', { name: `More actions for clip ${label}` })
  const grip = page.getByRole('button', { name: `${label} — clip actions` })
  if ((await fx.count()) && (await fx.isVisible())) return 'full'
  if ((await more.count()) && (await more.isVisible())) return 'compact'
  if ((await grip.count()) && (await grip.isVisible())) return 'handle'
  return 'none'
}

async function main() {
  const { browser, page, consoleErrors } = await openApp({ width: 1600, height: 900 })
  const report = createReport(AREA)
  const blocked = []

  try {
    // Boot cinematic + first-run tour dismissal.
    await page.waitForSelector('#boot-splash', { state: 'detached', timeout: 25000 }).catch(() => {})
    await page.waitForTimeout(300)
    for (let i = 0; i < 4; i++) {
      const skipBtn = page.getByRole('button', { name: /skip tour|end tour|skip|close tour/i })
      if (await skipBtn.count()) {
        await skipBtn.first().click().catch(() => {})
        await page.waitForTimeout(200)
      } else break
    }
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(200)
    await page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 10000 })
    await page.waitForTimeout(500)
    // Per-feature onboarding callouts (FeatureNotes.tsx) float over the lanes
    // ("PANELS", "LOG", ...) and are not part of the skip-tour flow above;
    // each has its own "Hide the X feature note" close button. Clear all of
    // them so a right-click on empty lane space cannot land on a tooltip.
    for (let i = 0; i < 10; i++) {
      const hideBtn = page.locator('button[aria-label^="Hide the "]')
      const n = await hideBtn.count()
      if (n === 0) break
      await hideBtn.first().click().catch(() => {})
      await page.waitForTimeout(150)
    }
    await page.screenshot({ path: report.shotPath('00-edit-tab') })

    // ── Fixtures: two audio clips (A, B) and one 1-note MIDI clip ───────────
    const p1 = await trackRowPoint(page, 0)
    const clipALoc = await addAudioClipAt(page, p1.x, p1.y, 'tone-440-10s.wav')
    const labelA = ((await clipALoc.locator('span[title]').first().textContent()) || '').trim()
    expect(labelA, 'clip A must render a title')

    const p2 = await trackRowPoint(page, 1)
    const clipBLoc = await addAudioClipAt(page, p2.x, p2.y, 'tone-220-6s.wav')
    const labelB = ((await clipBLoc.locator('span[title]').first().textContent()) || '').trim()
    expect(labelB, 'clip B must render a title')
    expect(labelB !== labelA, `clip A and B must have different labels (both "${labelA}")`)

    // ── 1. Title chrome degrades as the clip's start scrolls out of view ───
    await report.scenario('clip-header-slides-and-degrades-on-scroll', async () => {
      const t0 = await chromeTierOf(page, labelA)
      expect(t0 === 'full', `clip A should start at 'full' chrome tier (got ${t0})`)

      // Zoom way in (plain wheel = time zoom) so the 10s clip spans far more
      // than the viewport, then scroll its start out of view.
      const lanesBox = await page.locator(LANES_SEL).first().boundingBox()
      await page.mouse.move(lanesBox.x + lanesBox.width / 2, lanesBox.y + 20)
      let clipWidth = 0
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, -200)
        await page.waitForTimeout(30)
        const style = await clipALoc.getAttribute('style')
        const m = /width:\s*([0-9.]+)px/.exec(style || '')
        clipWidth = m ? parseFloat(m[1]) : 0
        if (clipWidth > 3000) break
      }
      expect(clipWidth > 800, `clip A did not grow with zoom (width ${clipWidth}px)`)
      // The clip does not start at content-x 0 (it was dropped a few seconds
      // into the timeline), so the scan for "start scrolled past" must be
      // relative to the clip's own left edge, not to absolute scrollLeft.
      const clipLeftMatch = /left:\s*(-?[0-9.]+)px/.exec((await clipALoc.getAttribute('style')) || '')
      const clipLeft = clipLeftMatch ? parseFloat(clipLeftMatch[1]) : 0

      // Step scrollLeft up until the header degrades past 'full'. Each step
      // re-checks with the clip's start (left edge) already off-screen.
      let sawFullOffscreenStart = false
      let landedTier = 'full'
      for (let s = clipLeft + 60; s < clipLeft + clipWidth - 40; s += 150) {
        await setScrollLeft(page, s)
        await page.waitForTimeout(30)
        const tier = await chromeTierOf(page, labelA)
        if (tier === 'full') {
          sawFullOffscreenStart = true
          // Prove it SLID: the FX button must be inside the lanes' own visible
          // client rect, not stuck at the (now off-screen) original position.
          const fx = page.getByRole('button', { name: `Open track FX for clip ${labelA}` })
          const fxBox = await fx.boundingBox()
          const lanesBox2 = await page.locator(LANES_SEL).first().boundingBox()
          expect(fxBox, 'FX button must have a bounding box while clip is scrolled')
          expect(
            fxBox.x >= lanesBox2.x - 1 && fxBox.x <= lanesBox2.x + lanesBox2.width,
            `FX button at x=${fxBox.x} should be inside the lanes viewport [${lanesBox2.x}, ${lanesBox2.x + lanesBox2.width}]`,
          )
          continue
        }
        landedTier = tier
        break
      }
      expect(sawFullOffscreenStart, 'never observed the full-chrome header while clip A start was scrolled offscreen')
      expect(landedTier === 'compact', `expected chrome to degrade to 'compact' (title + More); got '${landedTier}'`)

      // Compact tier: title still shown, FX/Mute buttons gone.
      const titleStillVisible = await clipALoc.locator(`span[title="${labelA}"]`).first().isVisible().catch(() => false)
      expect(titleStillVisible, 'compact tier must still show the clip title')
      const fxGone = !(await page.getByRole('button', { name: `Open track FX for clip ${labelA}` }).isVisible().catch(() => false))
      expect(fxGone, 'compact tier must not show the FX button')
      await page.screenshot({ path: report.shotPath('01-chrome-compact') })

      await setScrollLeft(page, 0)
    })

    // Reset zoom-ish state is not straightforward (no "reset zoom" control
    // read in the source); re-fit via the standard shortcut instead so the
    // rest of the run works with clips fully on screen.
    await page.keyboard.press('Escape').catch(() => {})

    // ── 2. Double-click an AUDIO clip opens the drawer bound to it ─────────
    await report.scenario('double-click-audio-clip-opens-bound-drawer', async () => {
      await clipALoc.dblclick({ position: { x: 10, y: 30 } })
      await page.waitForTimeout(300)
      const clipTab = page.getByRole('button', { name: 'Clip', exact: true })
      await expect_visible(clipTab)
      const pressed = await clipTab.getAttribute('aria-pressed')
      expect(pressed === 'true', `'Clip' bottom tab should be pressed after double-click (aria-pressed=${pressed})`)
      const nav = page.locator('nav[aria-label="Clip being edited"]')
      await nav.waitFor({ state: 'visible', timeout: 5000 })
      const navText = (await nav.textContent()) || ''
      expect(navText.includes(labelA), `drawer breadcrumb "${navText}" should include clip A's label "${labelA}"`)
      await page.screenshot({ path: report.shotPath('02-drawer-bound-to-A') })
    })

    // ── 3. Trim start: non-destructive, one undo step ──────────────────────
    await report.scenario('drawer-trim-start-is-one-undo-step', async () => {
      const trimStart = page.getByRole('slider', { name: /Trim the clip.s start, in source seconds/ })
      await trimStart.waitFor({ state: 'visible', timeout: 5000 })
      await trimStart.focus()
      const before = await trimStart.getAttribute('aria-valuenow')
      await page.keyboard.press('ArrowRight')
      const after = await trimStart.getAttribute('aria-valuenow')
      expect(after !== before, `ArrowRight on the trim-start handle should change its value (stayed ${before})`)
      await page.keyboard.press('Control+Z')
      const restored = await trimStart.getAttribute('aria-valuenow')
      expect(restored === before, `Ctrl+Z should restore trim-start to ${before} (got ${restored})`)
    })

    // ── 4. Fade in: non-destructive, one undo step ─────────────────────────
    await report.scenario('drawer-fade-in-is-one-undo-step', async () => {
      const fadeIn = page.getByRole('slider', { name: 'Fade in length, in clip seconds' })
      await fadeIn.waitFor({ state: 'visible', timeout: 5000 })
      await fadeIn.focus()
      const before = await fadeIn.getAttribute('aria-valuenow')
      await page.keyboard.press('ArrowRight')
      const after = await fadeIn.getAttribute('aria-valuenow')
      expect(after !== before, `ArrowRight on the fade-in handle should change its value (stayed ${before})`)
      await page.keyboard.press('Control+Z')
      const restored = await fadeIn.getAttribute('aria-valuenow')
      expect(restored === before, `Ctrl+Z should restore fade-in to ${before} (got ${restored})`)
    })

    // ── 5. Gain: non-destructive, one undo step ─────────────────────────────
    await report.scenario('drawer-gain-is-one-undo-step', async () => {
      const gain = page.getByLabel('Clip gain')
      await gain.waitFor({ state: 'visible', timeout: 5000 })
      const before = await gain.inputValue()
      const box = await gain.boundingBox()
      expect(box, 'gain slider must have a bounding box')
      await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2)
      const after = await gain.inputValue()
      expect(after !== before, `clicking the gain slider should change its value (stayed ${before})`)
      // Focus is left on the <input> by the click, exactly as a real drag
      // would leave it — this is the realistic "drag then Ctrl+Z" sequence.
      await page.keyboard.press('Control+Z')
      const restoredWhileFocused = await gain.inputValue()
      if (restoredWhileFocused !== before) {
        // Root-cause isolation #1: the dedicated Undo TOOLBAR BUTTON bypasses
        // the keyboard shortcut's focus guard entirely — if IT restores the
        // value, the step was recorded fine and Ctrl+Z alone is what's broken.
        const undoBtn = page.getByRole('button', { name: 'Undo' })
        const disabledAttr = await undoBtn.getAttribute('disabled')
        await undoBtn.click({ force: true }).catch(() => {})
        const restoredViaButton = await gain.inputValue()
        if (restoredViaButton === before) {
          throw new Error(
            `Ctrl+Z did not restore clip gain while the gain <input> still had focus ` +
            `(value stayed ${restoredWhileFocused}, wanted ${before}); clicking the toolbar ` +
            `Undo button DID restore it (disabled attr was "${disabledAttr}") — so the undo step ` +
            `exists but the Ctrl+Z shortcut is swallowed while a form control has focus ` +
            `(WaveformEditor.tsx's global keydown handler returns early on ` +
            `tgt.closest('input, textarea, select, [contenteditable]'), and the gain <input> ` +
            `keeps focus after a click/drag).`,
          )
        }
        throw new Error(
          `Clip gain change is not undoable at all: after clicking the slider (value ${before} -> ` +
          `${after}), neither Ctrl+Z (value ${restoredWhileFocused}) nor the toolbar Undo button ` +
          `(value ${restoredViaButton}, disabled attr was "${disabledAttr}") restored it to ${before}.`,
        )
      }
    })

    // ── 6. Every control in the drawer has an accessible name ──────────────
    await report.scenario('drawer-controls-have-accessible-names', async () => {
      const result = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Clip being edited"]')
        if (!nav) return { error: 'drawer breadcrumb not found' }
        const root = nav.parentElement && nav.parentElement.parentElement
        if (!root) return { error: 'drawer root not found' }
        const controls = Array.from(root.querySelectorAll('button, input, select, textarea, [role="slider"]'))
        const bad = []
        for (const el of controls) {
          const tag = el.tagName.toLowerCase()
          const role = el.getAttribute('role')
          let name = ''
          const ariaLabel = el.getAttribute('aria-label')
          const labelledby = el.getAttribute('aria-labelledby')
          if (ariaLabel && ariaLabel.trim()) {
            name = ariaLabel.trim()
          } else if (labelledby) {
            name = labelledby
              .split(/\s+/)
              .map((id) => (document.getElementById(id) && document.getElementById(id).textContent) || '')
              .join(' ')
              .trim()
          } else if (tag === 'input' || tag === 'select' || tag === 'textarea') {
            const id = el.getAttribute('id')
            const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null
            if (lbl && lbl.textContent && lbl.textContent.trim()) name = lbl.textContent.trim()
            else {
              const wrap = el.closest('label')
              if (wrap && wrap.textContent) name = wrap.textContent.trim()
            }
          } else if (tag === 'button' || role === 'slider') {
            if (el.textContent && el.textContent.trim()) name = el.textContent.trim()
          }
          if (!name) {
            const title = el.getAttribute('title')
            if (title && title.trim()) name = title.trim()
          }
          if (!name) {
            bad.push({ tag, role, id: el.id, outer: el.outerHTML.slice(0, 160) })
          }
        }
        return { total: controls.length, bad }
      })
      expect(!result.error, `accessible-name sweep failed: ${result.error}`)
      expect(result.total > 5, `expected several controls in the drawer, found ${result.total}`)
      expect(
        result.bad.length === 0,
        `${result.bad.length} control(s) with no accessible name: ${JSON.stringify(result.bad)}`,
      )
    })

    // ── 7. Double-click a MIDI clip opens the piano roll for it ────────────
    let midiLabel = null
    await report.scenario('double-click-midi-clip-opens-piano-roll', async () => {
      const p3 = await trackRowPoint(page, 2)
      const midiLoc = await addMidiClipAt(page, p3.x, p3.y, oneNoteMidiBytes(), 'qa-one-note.mid')
      midiLabel = ((await midiLoc.locator('span[title]').first().textContent()) || '').trim()
      expect(midiLabel, 'MIDI clip must render a title')

      await midiLoc.dblclick({ position: { x: 10, y: 30 } })
      const midiTab = page.getByRole('button', { name: 'MIDI', exact: true })
      await midiTab.waitFor({ state: 'visible', timeout: 5000 })
      const pressed = await midiTab.getAttribute('aria-pressed')
      expect(pressed === 'true', `'MIDI' bottom tab should be pressed after double-click (aria-pressed=${pressed})`)

      const unlink = page.getByRole('button', { name: 'Unlink from the editor clip' })
      await unlink.waitFor({ state: 'visible', timeout: 5000 })

      const velocityLane = page.locator('[aria-label^="Velocity lane"]').first()
      await velocityLane.waitFor({ state: 'visible', timeout: 5000 })
      const vLabel = (await velocityLane.getAttribute('aria-label')) || ''
      expect(/Velocity lane, 1 note,/.test(vLabel), `expected 1 note in the roll, got aria-label "${vLabel}"`)
      await page.screenshot({ path: report.shotPath('03-midi-roll-linked') })
    })

    // ── 8. Empty MIDI clip — investigate whether one can exist to double-click ──
    {
      const reason =
        'No UI path in this build can leave a MIDI clip on the timeline with zero notes: ' +
        'MIDI import rejects it (WaveformEditor.tsx addMidiClipFromBytes: `if (notes.length === 0) { logError(...); return; }`, ' +
        'no clip is created), and the roll\'s own bounce-to-clip action is disabled at 0 notes ' +
        '(PianoRoll.tsx handleSendToEditor: `if (roll.notes.length === 0) { logError(\'piano-roll\', \'No notes to bounce\'); return; }`, ' +
        'and the linked Save/Edit RailKey is `disabled={noteCount === 0}`). The "Clear every note" action ' +
        '(PianoRollClearKey) also sets `editingClipId: null`, so it detaches rather than saving an empty roll back ' +
        'to the clip. Emptying the roll\'s in-memory notes for an already-linked clip therefore cannot be persisted ' +
        'back onto the timeline clip through any control this session found — reopening that same clip reloads its ' +
        'last-saved (non-empty) sourcePianoRoll. Not exercised further to avoid fabricating applicaton state that a ' +
        'real user cannot reach through the UI.'
      console.log(`BLOCKED double-click-empty-midi-clip :: ${reason}`)
      blocked.push({ name: 'double-click-empty-midi-clip', reason })
    }

    // ── 9. Closing the drawer + double-clicking another clip rebinds it ────
    await report.scenario('closing-drawer-then-double-click-rebinds', async () => {
      // Re-bind to A first (state may have moved on to MIDI above).
      await clipALoc.dblclick({ position: { x: 10, y: 30 } })
      const navA = page.locator('nav[aria-label="Clip being edited"]')
      await navA.waitFor({ state: 'visible', timeout: 5000 })
      expect((await navA.textContent() || '').includes(labelA), 'drawer should be bound to A before closing')

      const collapse = page.getByRole('button', { name: 'Collapse bottom panel' })
      await collapse.waitFor({ state: 'visible', timeout: 5000 })
      await collapse.click()
      await page.locator('nav[aria-label="Clip being edited"]').waitFor({ state: 'hidden', timeout: 5000 })

      await clipBLoc.dblclick({ position: { x: 10, y: 30 } })
      const navB = page.locator('nav[aria-label="Clip being edited"]')
      await navB.waitFor({ state: 'visible', timeout: 5000 })
      const textB = (await navB.textContent()) || ''
      expect(textB.includes(labelB), `after reopening on clip B the breadcrumb "${textB}" should show B's label "${labelB}"`)
      expect(!textB.includes(labelA), `breadcrumb "${textB}" should no longer show A's label "${labelA}" (stale binding)`)
      await page.screenshot({ path: report.shotPath('04-rebound-to-B') })
    })

    // ── 10. No uncaught console errors from anything above ─────────────────
    await report.scenario('no-console-errors', async () => {
      expect(consoleErrors.length === 0, `uncaught console errors: ${JSON.stringify(consoleErrors)}`)
    })

    const rows = report.finish()
    console.log(JSON.stringify({ rows, blocked }, null, 1))
  } finally {
    await browser.close()
  }
}

async function expect_visible(locator) {
  await locator.waitFor({ state: 'visible', timeout: 5000 })
}

await main()
