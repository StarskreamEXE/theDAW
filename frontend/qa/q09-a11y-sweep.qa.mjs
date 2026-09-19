// AREA q09-a11y-sweep — Accessibility sweep of MAKE, EDIT, MIX, DJ and the Library.
//
// Checks (per CLAUDE.md section 3 / the task brief), run as DOM queries against
// the live rendered page for each view:
//   1. every <input>/<select>/<textarea> has id + name + a REAL label
//      (label[for=id] or a wrapping <label>) — aria-label alone does not
//      satisfy this project's rule, but is noted as a fallback when present.
//   2. every custom control (role=slider, role=listbox/option, role=combobox,
//      button-based dropdowns) has aria-label or aria-labelledby; dropdown
//      buttons (button[aria-haspopup] or button[aria-expanded]) must also
//      expose both aria-expanded and aria-haspopup.
//   3. no <label> wraps a non-native custom control (role=slider/listbox/
//      option/combobox/menu/button) instead of a real input/select/textarea.
//   4. every <button> has an accessible name (text content, aria-label,
//      aria-labelledby or title).
//
// Run with:  cd frontend && node qa/q09-a11y-sweep.qa.mjs

import { openApp, createReport, expect } from './qaLib.mjs'

const VIEWS = [
  { id: 'make', label: 'Make' },
  { id: 'edit', label: 'Edit' },
  { id: 'mix', label: 'Mix' },
  { id: 'dj', label: 'DJ' },
]

async function dismissHomeScreenIfPresent(page) {
  const closeBtn = page.locator('[aria-label="Close home screen"]')
  try {
    if (await closeBtn.count() > 0 && (await closeBtn.first().isVisible())) {
      await closeBtn.first().click({ timeout: 3000 })
      await page.waitForTimeout(300)
      return true
    }
  } catch (e) {
    // fall through — not fatal, the tab bar may still be reachable
  }
  return false
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

async function openLibraryRail(page) {
  const candidates = page.locator('[data-edge-tab="library"]')
  await candidates.first().waitFor({ state: 'attached', timeout: 10000 })
  const btn = await firstVisible(candidates, 'library edge tab')
  const expanded = await btn.getAttribute('aria-expanded')
  if (expanded !== 'true') {
    await btn.click({ timeout: 10000 })
    await page.waitForTimeout(500)
  }
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
    document
      .querySelectorAll('button[aria-haspopup], button[aria-expanded], [role="button"][aria-haspopup], [role="button"][aria-expanded]')
      .forEach((el) => {
        if (!visible(el)) return
        const problems = []
        if (!el.hasAttribute('aria-expanded')) problems.push('missing aria-expanded')
        if (!el.hasAttribute('aria-haspopup')) problems.push('missing aria-haspopup')
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

    await report.scenario('startup: home screen dismissible / app reaches tab bar', async () => {
      await dismissHomeScreenIfPresent(page)
      const tabBar = page.locator('button[aria-pressed]')
      await tabBar.first().waitFor({ state: 'attached', timeout: 15000 })
      expect((await tabBar.count()) > 0, 'no CenterTabBar buttons (aria-pressed) found after startup')
    })

    // --- TEMP DIAGNOSTIC: why does the first tab click time out? ---
    try {
      await page.screenshot({ path: report.shotPath('DEBUG-after-startup') })
      const candidates = page.getByRole('button', { name: /^make$/i })
      const n = await candidates.count()
      const info = []
      for (let i = 0; i < n; i++) {
        const el = candidates.nth(i)
        const box = await el.boundingBox().catch(() => null)
        const vis = await el.isVisible().catch(() => 'ERR')
        info.push({ i, vis, box })
      }
      const elAtPoint = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter((b) => /^make$/i.test((b.textContent || '').trim()))
        return btns.map((b) => {
          const r = b.getBoundingClientRect()
          const cx = r.left + r.width / 2
          const cy = r.top + r.height / 2
          const top = document.elementFromPoint(cx, cy)
          return {
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            topElementTag: top ? top.tagName : null,
            topElementIsSelf: top === b,
            topElementOuter: top ? top.outerHTML.slice(0, 200) : null,
          }
        })
      })
      console.log('DEBUG candidates', JSON.stringify(info))
      console.log('DEBUG elementFromPoint', JSON.stringify(elAtPoint, null, 2))
    } catch (dbgErr) {
      console.log('DEBUG failed', dbgErr)
    }
    // --- END TEMP DIAGNOSTIC ---

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

      const result = await scanA11y(page)
      allIssues[v.id] = result
      try {
        await page.screenshot({ path: report.shotPath(v.id) })
      } catch {
        /* screenshot best-effort only */
      }

      await report.scenario(`${v.id}: native inputs/selects/textareas have id+name+label`, async () => {
        expect(
          result.rule1.length === 0,
          `${result.rule1.length} control(s) missing id/name/real-label — first: ${JSON.stringify(result.rule1[0] || null)}`
        )
      })
      await report.scenario(`${v.id}: custom controls (slider/listbox/combobox/dropdown) have accessible names + state`, async () => {
        expect(result.rule2.length === 0, `${result.rule2.length} custom control(s) — first: ${JSON.stringify(result.rule2[0] || null)}`)
      })
      await report.scenario(`${v.id}: no <label> wraps a non-native custom control`, async () => {
        expect(result.rule3.length === 0, `${result.rule3.length} label(s) wrap a custom control — first: ${JSON.stringify(result.rule3[0] || null)}`)
      })
      await report.scenario(`${v.id}: every button has an accessible name`, async () => {
        expect(result.rule4.length === 0, `${result.rule4.length} button(s) with no accessible name — first: ${JSON.stringify(result.rule4[0] || null)}`)
      })
    }

    // Library: a rail beside the canvas, not a CenterTabBar tab — toggled via
    // the edge tab (data-edge-tab="library"). See Shell.tsx.
    let libOk = false
    await report.scenario('library: rail is reachable via the edge tab', async () => {
      await openLibraryRail(page)
      const btn = page.locator('[data-edge-tab="library"]')
      expect((await btn.getAttribute('aria-expanded')) === 'true', 'library edge tab never reached aria-expanded="true"')
      libOk = true
    })
    if (libOk) {
      const result = await scanA11y(page)
      allIssues.library = result
      try {
        await page.screenshot({ path: report.shotPath('library') })
      } catch {
        /* best effort */
      }
      await report.scenario('library: native inputs/selects/textareas have id+name+label', async () => {
        expect(result.rule1.length === 0, `${result.rule1.length} control(s) missing id/name/real-label — first: ${JSON.stringify(result.rule1[0] || null)}`)
      })
      await report.scenario('library: custom controls (slider/listbox/combobox/dropdown) have accessible names + state', async () => {
        expect(result.rule2.length === 0, `${result.rule2.length} custom control(s) — first: ${JSON.stringify(result.rule2[0] || null)}`)
      })
      await report.scenario('library: no <label> wraps a non-native custom control', async () => {
        expect(result.rule3.length === 0, `${result.rule3.length} label(s) wrap a custom control — first: ${JSON.stringify(result.rule3[0] || null)}`)
      })
      await report.scenario('library: every button has an accessible name', async () => {
        expect(result.rule4.length === 0, `${result.rule4.length} button(s) with no accessible name — first: ${JSON.stringify(result.rule4[0] || null)}`)
      })
    } else {
      allIssues.library = { rule1: [], rule2: [], rule3: [], rule4: [], blocked: 'rail did not open' }
    }

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
