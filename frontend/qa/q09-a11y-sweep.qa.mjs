// AREA q09-a11y-sweep — Accessibility sweep of the EDIT and MIX views.
//
// Scope (per the task brief / CLAUDE.md section 3): for EDIT and MIX, WITH ONE
// AUDIO TRACK AND ONE CLIP PRESENT on the timeline — a lot of what this checks
// (the clip's own "..." menu button, the track name field, the mute/solo
// buttons) only exists once a clip has been placed, so sweeping an empty
// project would silently skip them. One audio file is dropped onto the EDIT
// timeline via a synthetic desktop-file drop — the app's own import path
// (WaveformEditor's onTimelineDrop -> lib/libraryDrop.ts dropHasLibraryOrFiles
// / entriesFromDrop) — before either view is scanned. Project state
// (useEditorStore) is a single global store, so the seeded track/clip is
// still there after switching to MIX.
//
// Checks, run as DOM queries against the live rendered page for each view:
//   1. every <input>/<select>/<textarea> has id + name + a REAL label
//      (label[for=id] or a wrapping <label>) — aria-label alone does not
//      satisfy this project's rule (CLAUDE.md #3), but is noted as a fallback
//      when present.
//   2a. every custom control (role=slider, role=listbox/option/combobox) has
//       aria-label or aria-labelledby.
//   2b. every button-based popup trigger (anything with aria-haspopup) also
//       exposes aria-expanded, and has an accessible name. A plain
//       aria-expanded WITHOUT aria-haspopup (an inline expand/collapse
//       disclosure button, e.g. MixView's viz-row chevrons) is a separate,
//       correctly-accessible ARIA pattern on its own (WAI-ARIA APG disclosure
//       pattern) and is deliberately NOT required to also carry
//       aria-haspopup here — flagging it would be a false positive, not a bug.
//   3. no <label> wraps a non-native custom control (role=slider/listbox/
//      option/combobox/menu/button) instead of a real input/select/textarea.
//   4. every <button> has an accessible name (text content, aria-label,
//      aria-labelledby or title).
//
// Run with:  cd frontend && node qa/q09-a11y-sweep.qa.mjs

import { readFileSync } from 'node:fs'
import { openApp, createReport, expect, ASSETS_DIR, QA_URL } from './qaLib.mjs'

const VIEWS = [
  { id: 'edit', label: 'Edit' },
  { id: 'mix', label: 'Mix' },
]

const SEED_AUDIO_PATH = `${ASSETS_DIR}/tone-440-10s.wav`

/** Three first-run overlays stand between a fresh QA profile (this instance's
 *  data folder is empty every run) and the tab bar, and each has silently
 *  swallowed tab clicks in earlier runs of this script:
 *   1. `#boot-splash` — a raw DOM node (not React), a fixed inset-0 div at
 *      z-index 2147483001 hosting the boot cinematic iframe. main.tsx drops it
 *      before React even renders when the URL carries `?nocinematic` — the
 *      supported hook for exactly this ("Captures (?nocinematic) skip the
 *      boot sequence outright"), so navigating with that query is more
 *      reliable than racing the cinematic's own timing.
 *   2. The onboarding tour ("N CHAPTERS" welcome dialog, role="dialog"
 *      aria-modal, onboarding/OnboardingTour.tsx) — closes on Escape (its own
 *      "Esc leave" hint).
 *   3. The full-screen HOME screen (role="dialog" aria-modal, aria-labelledby
 *      "home-title") — also closes on Escape.
 *  (NOT `#footer-audio-out`, a third, unrelated role="dialog" popover that is
 *  `hidden` by default — matching on aria-modal="true" keeps the Escape loop
 *  from spinning on that one forever.) */
async function dismissStartupOverlays(page) {
  await page.goto(`${QA_URL}${QA_URL.includes('?') ? '&' : '?'}nocinematic`, { waitUntil: 'networkidle', timeout: 60000 })
  for (let i = 0; i < 4; i++) {
    const modal = page.locator('[role="dialog"][aria-modal="true"]')
    if ((await modal.count()) === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  // Defense in depth, in case a future build adds a variant that does not
  // close on Escape: the home screen's own explicit close control.
  const closeBtn = page.locator('[aria-label="Close home screen"]')
  try {
    if ((await closeBtn.count()) > 0 && (await closeBtn.first().isVisible())) {
      await closeBtn.first().click({ timeout: 3000 })
      await page.waitForTimeout(300)
    }
  } catch {
    // not fatal — the tab bar may still be reachable
  }
}

/** Picks the first VISIBLE match — some views render both a desktop and a
 *  mobile tree (CSS-breakpoint hidden), so `.first()` on DOM order alone can
 *  resolve to an off-screen duplicate and time out waiting for actionability. */
async function firstVisible(locator, what) {
  const count = await locator.count()
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i)
    if (await el.isVisible()) return el
  }
  throw new Error(`No visible ${what} found among ${count} candidate(s)`)
}

async function switchTab(page, label) {
  const candidates = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })
  const btn = await firstVisible(candidates, `"${label}" tab button`)
  await btn.click({ timeout: 10000 })
  await page.waitForTimeout(500)
}

/** Drops one real audio file onto the EDIT timeline the way a Finder/Explorer
 *  drag would: a DataTransfer carrying a real File, dispatched as
 *  dragover+drop on the timeline lanes element (WaveformEditor.tsx
 *  onTimelineDragOver/onTimelineDrop -> lib/libraryDrop.ts). On an empty
 *  timeline this both creates a new track AND places the file as a clip on it
 *  (laneTargetAtY returns an 'insert' at index 0 when there are no lanes yet)
 *  — the "one audio track and one clip" precondition the task brief asks for,
 *  in one action.
 *
 *  Chosen over setInputFiles on WaveformEditor's hidden `<input type=file>`:
 *  that input's onChange only calls onAddAudioFiles with a non-null target
 *  once `pendingSystemAdd` has been armed by a real "Add Audio... from
 *  System" context-menu click first — the drop handler needs no such
 *  priming, so it is the more direct path to the same end state. */
async function seedOneTrackAndClip(page, filePath) {
  const bytes = readFileSync(filePath)
  const base64 = bytes.toString('base64')
  const fileName = filePath.split(/[\\/]/).pop()
  const found = await page.evaluate(
    ({ base64, fileName }) => {
      // The timeline lanes div (WaveformEditor.tsx, ref={timelineRef}) carries
      // no test id; it is the tabIndex=-1 child of the scroll container
      // (ref={setTimelineScroller}, class includes overflow-x-auto overflow-y-auto).
      const scroller = Array.from(document.querySelectorAll('div')).find(
        (d) => typeof d.className === 'string' && d.className.includes('overflow-x-auto') && d.className.includes('overflow-y-auto'),
      )
      const target = scroller && Array.from(scroller.children).find((c) => c.getAttribute('tabindex') === '-1')
      if (!target) return false
      const byteChars = atob(base64)
      const arr = new Uint8Array(byteChars.length)
      for (let i = 0; i < byteChars.length; i++) arr[i] = byteChars.charCodeAt(i)
      const file = new File([arr], fileName, { type: 'audio/wav' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const rect = target.getBoundingClientRect()
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 20, dataTransfer: dt }
      target.dispatchEvent(new DragEvent('dragover', opts))
      target.dispatchEvent(new DragEvent('drop', opts))
      return true
    },
    { base64, fileName },
  )
  if (!found) throw new Error('EDIT timeline drop target (scroller > [tabindex="-1"]) not found in the DOM')
  // Backend upload (library import) + peak computation follow the drop
  // asynchronously; give them real headroom before deciding it failed.
  await page.waitForSelector('[data-clip="1"]', { timeout: 20000 })
}

/** Runs the four DOM-query checks against whatever is currently rendered. */
async function scanA11y(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (typeof el.checkVisibility === 'function') {
        try {
          return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
        } catch {
          /* fall through to computed-style check */
        }
      }
      const cs = getComputedStyle(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden'
    }

    function excerpt(el) {
      const html = el.outerHTML || ''
      return html.length > 240 ? html.slice(0, 240) + '…' : html
    }

    function hasRealLabel(el) {
      const id = el.getAttribute('id')
      if (id) {
        try {
          if (document.querySelector(`label[for="${CSS.escape(id)}"]`)) return true
        } catch {
          /* invalid id for a CSS selector — treat as no matching label */
        }
      }
      let p = el.parentElement
      let hops = 0
      while (p && hops < 6) {
        if (p.tagName === 'LABEL') return true
        p = p.parentElement
        hops++
      }
      return false
    }

    function accessibleButtonName(el) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (text) return text
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim()
      const labelledby = el.getAttribute('aria-labelledby')
      if (labelledby) {
        const t = labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() || '')
          .join(' ')
          .trim()
        if (t) return t
      }
      const title = el.getAttribute('title')
      if (title && title.trim()) return title.trim()
      return ''
    }

    const rule1 = []
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      if (el.type === 'hidden') return
      if (!visible(el)) return
      const id = el.getAttribute('id') || ''
      const name = el.getAttribute('name') || ''
      const real = hasRealLabel(el)
      const missing = []
      if (!id) missing.push('id')
      if (!name) missing.push('name')
      if (!real) missing.push('label[for]/wrapping <label>')
      if (missing.length) {
        rule1.push({
          missing,
          hasAriaFallback: !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')),
          html: excerpt(el),
        })
      }
    })

    const rule2 = []
    document.querySelectorAll('[role="slider"], [role="listbox"], [role="option"], [role="combobox"]').forEach((el) => {
      if (!visible(el)) return
      const name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
      if (!name) rule2.push({ kind: 'custom-control-no-name', role: el.getAttribute('role'), html: excerpt(el) })
    })
    // aria-haspopup unambiguously means "this opens a floating menu / listbox
    // / dialog", so it must also carry aria-expanded (see file header for why
    // the converse — aria-expanded alone — is NOT flagged).
    document.querySelectorAll('[aria-haspopup]').forEach((el) => {
      if (!visible(el)) return
      const problems = []
      if (!el.hasAttribute('aria-expanded')) problems.push('missing aria-expanded')
      if (!accessibleButtonName(el)) problems.push('no accessible name')
      if (problems.length) rule2.push({ kind: 'dropdown-button', problems, html: excerpt(el) })
    })

    const rule3 = []
    document.querySelectorAll('label').forEach((label) => {
      if (!visible(label)) return
      const custom = label.querySelector('[role="slider"], [role="listbox"], [role="option"], [role="combobox"], [role="menu"], [role="button"]')
      const native = label.querySelector('input, select, textarea')
      if (custom && custom !== native) {
        rule3.push({ html: excerpt(label) })
      }
    })

    const rule4 = []
    document.querySelectorAll('button').forEach((el) => {
      if (!visible(el)) return
      if (!accessibleButtonName(el)) rule4.push({ html: excerpt(el) })
    })

    return { rule1, rule2, rule3, rule4 }
  })
}

async function main() {
  const report = createReport('q09-a11y-sweep')
  const allIssues = {}
  let browser
  try {
    const opened = await openApp()
    browser = opened.browser
    const { page, consoleErrors } = opened

    await report.scenario('startup: overlays dismissible / app reaches tab bar', async () => {
      await dismissStartupOverlays(page)
      const tabBar = page.locator('button[aria-pressed]')
      await tabBar.first().waitFor({ state: 'attached', timeout: 15000 })
      expect((await tabBar.count()) > 0, 'no CenterTabBar buttons (aria-pressed) found after startup')
    })

    let seeded = false
    await report.scenario('setup: one audio track + one clip present on the EDIT timeline', async () => {
      await switchTab(page, 'Edit')
      await seedOneTrackAndClip(page, SEED_AUDIO_PATH)
      // >= 1, not === 1: this QA app instance is shared with every other area
      // script in the same swarm run, so a track/clip another script seeded
      // concurrently can legitimately already be on the timeline too.
      const clipCount = await page.locator('[data-clip="1"]').count()
      expect(clipCount >= 1, `expected at least 1 clip on the timeline after seeding, found ${clipCount}`)
      seeded = true
    })

    for (const v of VIEWS) {
      let opened_ok = false
      await report.scenario(`${v.id}: view is reachable from the top bar`, async () => {
        await switchTab(page, v.label)
        const pressed = page.locator(`button[aria-pressed="true"]`).filter({ hasText: new RegExp(`^${v.label}$`, 'i') })
        expect((await pressed.count()) > 0, `${v.label} tab button never reached aria-pressed="true"`)
        opened_ok = true
      })
      if (!opened_ok) {
        allIssues[v.id] = { rule1: [], rule2: [], rule3: [], rule4: [], blocked: 'view did not open' }
        continue
      }
      await page.waitForTimeout(500) // let the lazy-loaded view (Suspense) finish its first paint

      const result = await scanA11y(page)
      allIssues[v.id] = { ...result, seededTrackAndClip: seeded }
      try {
        await page.screenshot({ path: report.shotPath(v.id), fullPage: true })
      } catch {
        /* screenshot best-effort only */
      }

      await report.scenario(`${v.id}: native inputs/selects/textareas have id+name+label`, async () => {
        expect(
          result.rule1.length === 0,
          `${result.rule1.length} control(s) missing id/name/real-label — first: ${JSON.stringify(result.rule1[0] || null)}`
        )
      })
      await report.scenario(`${v.id}: custom controls (slider/listbox/combobox) + popup buttons have accessible names/state`, async () => {
        expect(result.rule2.length === 0, `${result.rule2.length} custom control(s) — first: ${JSON.stringify(result.rule2[0] || null)}`)
      })
      await report.scenario(`${v.id}: no <label> wraps a non-native custom control`, async () => {
        expect(result.rule3.length === 0, `${result.rule3.length} label(s) wrap a custom control — first: ${JSON.stringify(result.rule3[0] || null)}`)
      })
      await report.scenario(`${v.id}: every button has an accessible name`, async () => {
        expect(result.rule4.length === 0, `${result.rule4.length} button(s) with no accessible name — first: ${JSON.stringify(result.rule4[0] || null)}`)
      })
    }

    // The clip header renders one of three chrome tiers by available on-screen
    // width (full / compact / handle — WaveformEditor.tsx); only "full" shows
    // FX/Mute as their own labeled buttons; "compact" and "handle" collapse to
    // a single "…" button (aria-haspopup="menu") that opens the same clip
    // menu. The seeded clip is wide at the default zoom, so the rule-2 scan
    // above only ever saw the "full" tier — zoom out first so the same clip
    // renders at "compact"/"handle" width and the other two tiers get swept
    // too, not just the one the default zoom happens to land on.
    await report.scenario('edit: clip menu trigger at a narrow (compact/handle) zoom still has aria-expanded + a name', async () => {
      await switchTab(page, 'Edit')
      const zoomOutBtn = page.getByRole('button', { name: 'Zoom out around the edit cursor' })
      for (let i = 0; i < 10; i++) {
        await zoomOutBtn.click({ timeout: 5000 })
      }
      await page.waitForTimeout(300)
      const narrow = await scanA11y(page)
      allIssues.edit = allIssues.edit || {}
      allIssues.edit.rule2AtNarrowZoom = narrow.rule2
      try {
        await page.screenshot({ path: report.shotPath('edit-narrow-zoom') })
      } catch {
        /* best effort */
      }
      expect(narrow.rule2.length === 0, `${narrow.rule2.length} custom control(s) at narrow zoom — first: ${JSON.stringify(narrow.rule2[0] || null)}`)
    })

    await report.scenario('no uncaught console/page errors during the sweep', async () => {
      expect(consoleErrors.length === 0, `console/page errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`)
    })

    console.log('\n=== QA_ISSUES_JSON_START ===')
    console.log(JSON.stringify(allIssues, null, 2))
    console.log('=== QA_ISSUES_JSON_END ===\n')

    report.finish()
  } catch (fatal) {
    console.error('FATAL', fatal)
    console.log('\n=== QA_ISSUES_JSON_START ===')
    console.log(JSON.stringify(allIssues, null, 2))
    console.log('=== QA_ISSUES_JSON_END ===\n')
    process.exitCode = 1
  } finally {
    if (browser) await browser.close()
  }
}

main()
