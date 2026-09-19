// QA area q08-library — Library view: counts, search, sort, inspector.
//
// Run with:
//   cd "C:\Users\skream\projects\_thedaw-batch11\frontend" && node qa/q08-library.qa.mjs
//
// Reads (for reference, at commit 32f4531):
//   frontend/src/views/LibraryView.tsx
//   frontend/src/state/libraryStore.ts
//   frontend/src/lib/pagedRows.ts
//   frontend/src/components/library/AssetInspectorModal.tsx
//
// NEVER performs a delete action (per QA instructions for this area).

import { openApp, createReport, expect, expectClose } from './qaLib.mjs'

const AREA = 'q08-library'
const LIBRARY_ASIDE = '[data-tour="library"]'
const TRACKS_LIST = '[aria-label="Library tracks"]'
const ROW = '[data-library-entry-id]'
const SEARCH_INPUT = '#library-search'
const DIALOG = '[role="dialog"][aria-modal="true"]'

/** Approximate accessible name, good enough for a toolbar sweep. */
function accessibleNameOf(el) {
  const aria = el.getAttribute('aria-label')
  if (aria && aria.trim()) return aria.trim()
  const labelledby = el.getAttribute('aria-labelledby')
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
    if (text) return text
  }
  const text = (el.textContent ?? '').trim()
  if (text) return text
  const title = el.getAttribute('title')
  if (title && title.trim()) return title.trim()
  const placeholder = el.getAttribute('placeholder')
  if (placeholder && placeholder.trim()) return placeholder.trim()
  return ''
}

async function main() {
  const { browser, page, consoleErrors } = await openApp()
  const report = createReport(AREA)
  /** @type {{url:string, method:string, t:number}[]} */
  const requests = []
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/api/library/')) requests.push({ url, method: req.method(), t: Date.now() })
  })

  try {
    // Make sure the library rail is visible for scenarios 2-6 (a reveal
    // click, not "opening" a dedicated library view/route).
    const ensureLibraryVisible = async () => {
      const aside = page.locator(LIBRARY_ASIDE)
      if (await aside.isVisible().catch(() => false)) return
      const toggle = page.locator('[data-edge-tab="library"]').first()
      if (await toggle.count()) {
        await toggle.click()
        await aside.waitFor({ state: 'visible', timeout: 5000 })
      }
    }

    // ── Scenario 1: counts at app start, without opening the library ──────
    await report.scenario('counts-appear-at-boot-without-opening-library', async () => {
      requests.length = 0
      // openApp() already did the FIRST load before we could attach a request
      // listener, so a reload stands in for "app start" here (same boot path,
      // App.tsx -> useLibraryStore.load() -> useLibraryCounts.invalidate()).
      await page.reload({ waitUntil: 'networkidle' })
      const sawSummary = requests.some((r) => r.url.includes('/api/library/summary'))
      expect(sawSummary, `expected a request to /api/library/summary on boot; saw: ${requests.map((r) => r.url).join(', ') || '(none)'}`)
      // The count must be usable without navigating into/expanding the library.
      const libraryOpenAtBoot = await page.locator(LIBRARY_ASIDE).isVisible().catch(() => false)
      await page.screenshot({ path: report.shotPath('01-boot-network'), fullPage: false })
      if (libraryOpenAtBoot) {
        const tracksTab = page.getByText(/Tracks \(\d[\d,]*\)/)
        await tracksTab.waitFor({ state: 'visible', timeout: 5000 })
      } else {
        // Panel closed by default in this profile: the network evidence above
        // is what scenario 1 actually asks for (the summary endpoint fires at
        // boot); note it rather than force-open the panel to "prove" the text.
        console.log('  note: library rail is collapsed by default; verified via network only')
      }
    })

    await ensureLibraryVisible()
    await page.locator(TRACKS_LIST).waitFor({ state: 'visible', timeout: 15000 })

    // ── Scenario 2: virtualization + big-scroll-jump performance ──────────
    await report.scenario('virtualized-rows-and-fast-big-scroll', async () => {
      const idsOf = () => page.$$eval(ROW, (els) => els.map((e) => e.getAttribute('data-library-entry-id')))
      const before = await idsOf()
      expect(before.length > 0, 'expected some rows rendered before scrolling')
      expect(before.length < 200, `DOM should hold only a window of rows, got ${before.length} rendered`)

      const beforeSet = new Set(before)
      const t0 = Date.now()
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (el) el.scrollTop = Math.floor(el.scrollHeight * 0.7)
      }, TRACKS_LIST)

      await page.waitForFunction(
        (args) => {
          const [rowSel, beforeIds] = args
          const rows = Array.from(document.querySelectorAll(rowSel)).map((e) => e.getAttribute('data-library-entry-id'))
          if (rows.length === 0) return false
          return rows.some((id) => !beforeIds.includes(id))
        },
        [ROW, before],
        { timeout: 2500 },
      )
      const elapsedMs = Date.now() - t0
      const after = await idsOf()
      await page.screenshot({ path: report.shotPath('02-after-big-scroll') })

      expect(elapsedMs < 2000, `expected new rows within 2s of a big scroll jump, took ${elapsedMs}ms`)
      expect(after.length < 200, `DOM should still hold only a window of rows after scroll, got ${after.length}`)
      const overlap = after.filter((id) => beforeSet.has(id)).length
      expect(overlap < after.length, 'expected the visible row set to actually change after the scroll jump')

      // Scroll back to top for the following scenarios.
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (el) el.scrollTop = 0
      }, TRACKS_LIST)
    })

    // ── Scenario 3: search narrows via backend; stale slow answer loses ───
    await report.scenario('search-narrows-via-backend-and-ignores-stale-response', async () => {
      const search = page.locator(SEARCH_INPUT)
      await search.fill('')
      await page.waitForTimeout(300)

      requests.length = 0
      const probe = 'zzz-qa-no-match-probe-9f2'
      await search.fill(probe)
      await page.waitForResponse((r) => r.url().includes('/api/library/entries') && r.url().includes('q='), { timeout: 3000 })
      await page.waitForTimeout(50)

      const searchReq = requests.find((r) => r.url.includes('/api/library/entries') && r.url.includes(encodeURIComponent(probe)))
      expect(!!searchReq, `expected a request with q=${probe}; saw: ${requests.map((r) => r.url).join(', ')}`)
      const url = new URL(searchReq.url)
      const limitParam = Number(url.searchParams.get('limit') ?? '0')
      expect(limitParam > 0 && limitParam < 5000, `expected a scoped/paged fetch (small limit), got limit=${limitParam} (looks like a full-list fetch)`)

      await page.locator('text=No entries match your filter.').waitFor({ state: 'visible', timeout: 3000 })
      const rowsForProbe = await page.locator(ROW).count()
      expect(rowsForProbe === 0, `expected 0 rows for an unmatched query, got ${rowsForProbe}`)

      // Stale-response guard: hold the NEXT empty-query ("show everything")
      // response, fire a second real query that resolves fast, then release
      // the stale one late and confirm it does not clobber the newer state.
      let releaseStale
      const staleGate = new Promise((resolve) => { releaseStale = resolve })
      await page.route('**/api/library/entries*', async (route) => {
        const u = new URL(route.request().url())
        if (!u.searchParams.get('q')) {
          await staleGate
        }
        await route.continue()
      })

      await search.fill('') // triggers the empty-query request, which we hold
      await page.waitForTimeout(400) // let the debounced request go out and get held
      await search.fill(probe) // triggers a second, later query seq; not held (has q=)
      await page.locator('text=No entries match your filter.').waitFor({ state: 'visible', timeout: 3000 })

      releaseStale()
      await page.waitForTimeout(600) // give the stale response time to arrive and (not) apply

      const rowsAfterStaleLanded = await page.locator(ROW).count()
      const noMatchStillShown = await page.locator('text=No entries match your filter.').isVisible().catch(() => false)
      await page.screenshot({ path: report.shotPath('03-stale-response-guard') })
      expect(
        rowsAfterStaleLanded === 0 && noMatchStillShown,
        `a stale (empty-query) response overwrote the newer search: rows=${rowsAfterStaleLanded}, noMatchShown=${noMatchStillShown}`,
      )

      await page.unroute('**/api/library/entries*')
      await search.fill('')
      await page.waitForTimeout(400)
    })

    // ── Scenario 4: sort changes order and resets to top ───────────────────
    await report.scenario('sort-changes-order-and-resets-to-top', async () => {
      await page.locator(TRACKS_LIST).waitFor({ state: 'visible' })
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (el) el.scrollTop = Math.floor(el.scrollHeight * 0.5)
      }, TRACKS_LIST)
      await page.waitForTimeout(150)
      const scrollBefore = await page.$eval(TRACKS_LIST, (el) => el.scrollTop)
      expect(scrollBefore > 0, 'setup: expected the list to actually be scrolled down before changing sort')

      const newestBtn = page.getByRole('button', { name: /NEWEST/ })
      const lengthBtn = page.getByRole('button', { name: /LENGTH/ })
      const newestActive = (await newestBtn.getAttribute('aria-pressed')) === 'true'
      const target = newestActive ? lengthBtn : newestBtn
      const targetSort = newestActive ? 'duration_desc' : 'created_desc'

      requests.length = 0
      await target.click()
      await page.waitForResponse((r) => r.url().includes('/api/library/entries') && r.url().includes(`sort=${targetSort}`), { timeout: 3000 })
      await page.waitForTimeout(150)

      const scrollAfter = await page.$eval(TRACKS_LIST, (el) => el.scrollTop)
      await page.screenshot({ path: report.shotPath('04-sort-changed') })
      expect((await target.getAttribute('aria-pressed')) === 'true', 'clicked sort button should become the active one (aria-pressed)')
      expectClose(scrollAfter, 0, 2, `expected the list to reset to the top after changing sort, scrollTop=${scrollAfter}`)
    })

    // ── Scenario 5: inspector dialog — centered, tabs, Escape, focus trap ─
    await report.scenario('inspector-dialog-centered-tabs-escape-focus-trap', async () => {
      await page.evaluate(() => { document.activeElement?.setAttribute('data-qa-opener-probe', '1') })
      const firstRow = page.locator(ROW).first()
      await firstRow.dblclick()

      const dialog = page.locator(DIALOG)
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      await page.screenshot({ path: report.shotPath('05-inspector-open') })

      // Centered: dialog's bounding-box center close to the viewport's.
      const viewport = page.viewportSize()
      const box = await dialog.boundingBox()
      expect(!!box, 'expected the dialog to have a bounding box')
      const dialogCenterX = box.x + box.width / 2
      const dialogCenterY = box.y + box.height / 2
      expectClose(dialogCenterX, viewport.width / 2, viewport.width * 0.05, 'dialog not horizontally centered')
      expectClose(dialogCenterY, viewport.height / 2, viewport.height * 0.05, 'dialog not vertically centered')

      // Tabs present.
      const tabCount = await dialog.locator('[role="tab"]').count()
      expect(tabCount > 1, `expected multiple tabs in the inspector, found ${tabCount}`)

      // Initial focus on the close control.
      const closeFocused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Close the asset inspector')
      expect(closeFocused, 'expected initial focus on the close button')

      // Focus trap: Tab repeatedly, focus must stay inside the dialog.
      for (let i = 0; i < 20; i += 1) {
        await page.keyboard.press('Tab')
        const inside = await page.evaluate((sel) => {
          const dlg = document.querySelector(sel)
          return !!dlg && dlg.contains(document.activeElement)
        }, DIALOG)
        expect(inside, `focus escaped the dialog after ${i + 1} Tab presses`)
      }

      // Escape closes, and focus returns to the pre-open element.
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 5000 })
      const returned = await page.evaluate(() => document.activeElement?.getAttribute('data-qa-opener-probe') === '1')
      await page.screenshot({ path: report.shotPath('05-inspector-closed') })
      expect(returned, 'expected focus to return to the pre-dialog element after Escape')
    })

    // ── Scenario 6: every toolbar control has an accessible name ──────────
    await report.scenario('toolbar-controls-have-accessible-names', async () => {
      const failures = await page.evaluate(
        (args) => {
          const [asideSel, subTabTextRe] = args
          const aside = document.querySelector(asideSel)
          if (!aside) return { error: 'library aside not found' }
          const subTabEls = Array.from(aside.querySelectorAll('button')).filter((b) => new RegExp(subTabTextRe).test(b.textContent || ''))
          if (subTabEls.length === 0) return { error: 'could not locate the sub-tab strip to bound the toolbar region' }
          const subTabTop = Math.min(...subTabEls.map((el) => el.getBoundingClientRect().top))
          const controls = Array.from(aside.querySelectorAll('button, input, select, textarea, [role="tab"]'))
          const toolbarControls = controls.filter((el) => el.getBoundingClientRect().bottom <= subTabTop + 1)
          const bad = []
          for (const el of toolbarControls) {
            const aria = el.getAttribute('aria-label')
            const labelledby = el.getAttribute('aria-labelledby')
            const text = (el.textContent || '').trim()
            const title = el.getAttribute('title')
            const placeholder = el.getAttribute('placeholder')
            const hasName = !!(aria?.trim() || labelledby || text || title?.trim() || placeholder?.trim())
            if (!hasName) bad.push(el.outerHTML.slice(0, 160))
          }
          return { total: toolbarControls.length, bad }
        },
        [LIBRARY_ASIDE, 'Tracks \\('],
      )
      expect(!failures.error, String(failures.error))
      expect(failures.total > 0, 'expected to find at least one toolbar control to check')
      expect(failures.bad.length === 0, `${failures.bad.length}/${failures.total} toolbar controls have no accessible name:\n${failures.bad.join('\n')}`)
    })

    if (consoleErrors.length > 0) {
      console.log(`\n${consoleErrors.length} uncaught console error(s) during the run:`)
      for (const e of consoleErrors.slice(0, 10)) console.log('  ' + e)
    }
  } finally {
    await browser.close()
  }
  report.finish()
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exitCode = 1
})
