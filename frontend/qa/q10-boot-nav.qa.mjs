// QA area q10-boot-nav — app boot, navigation between all views, build ids.
//
// Run with:
//   cd "C:\Users\skream\projects\_thedaw-batch11/frontend" && node qa/q10-boot-nav.qa.mjs
//
// Targets the already-running isolated QA instance (frontend :5183, backend
// :8611 by default via qaLib.mjs). Never touches :5173 / :8600.

import { openApp, createReport, expect, QA_URL } from './qaLib.mjs'

const BACKEND_URL = process.env.QA_BACKEND || 'http://127.0.0.1:8611'

// On-screen order from CenterTabBar.tsx's TABS table.
const ON_SCREEN_TABS = [
  'make', 'edit', 'mix', 'session', 'dj', 'vj', 'sway', 'foundry',
  'underfit', 'nodefi', 'loom', 'learn', 'tour',
]

// Named EDIT-view toolbar controls (WaveformEditor.tsx aria-labels) used for
// the resize / overlap / reachability check.
const EDIT_CONTROL_LABELS = [
  'Stop and return to start',
  'Undo',
  'Redo',
  'Zoom out around the edit cursor',
  'Zoom in around the edit cursor',
  'Zoom to fit the whole arrangement',
  'Zoom to selection',
  'Master FX',
  'Loop region',
  'Add marker at playhead',
]

/** Count of elements under <main> with a non-zero rendered bounding box.
 *  display:none ancestors (the DJ/VJ/SWAY/... "stay mounted, toggle
 *  visibility" pattern in DAWCenterPanel.tsx) collapse their whole subtree to
 *  0x0 rects, so this only counts what is actually painted for the ACTIVE
 *  tab, not left-over DOM from previously-warmed tabs. */
async function visibleElementCount(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')
    if (!main) return -1
    let n = 0
    for (const el of main.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) n++
    }
    return n
  })
}

/** Three first-run overlays stand between a fresh QA profile (this instance's
 *  data folder is empty every run) and the tab bar -- and unlike a typical
 *  "seen once" onboarding flag, the HOME screen reopens after EVERY reload,
 *  not just first boot: HomeScreen.tsx's `useHomeScreenStore` only persists
 *  `showAtStartup` (default true), while `open` always resets to false on
 *  each fresh app load and App.tsx re-arms it whenever `showAtStartup` is
 *  true (Shell.tsx: "Auto-opened by App on returning launches" -- by design,
 *  not a bug).
 *   1. `#boot-splash` -- a raw DOM node (main.tsx, pre-React) hosting the
 *      ~14-24s boot cinematic (App.tsx `cinematicDone`); navigating with
 *      `?nocinematic` (documented there as "used by the screenshot/capture
 *      harness") skips it outright instead of racing its timing.
 *   2. The onboarding tour ("N CHAPTERS" welcome dialog, role="dialog"
 *      aria-modal, onboarding/OnboardingTour.tsx) -- closes on Escape; once
 *      skipped it persists `seen: true` and does not return this run.
 *   3. The full-screen HOME screen (role="dialog" aria-modal, aria-labelledby
 *      "home-title", components/home/HomeScreen.tsx) -- also closes on
 *      Escape, but (per above) returns after every reload.
 *  (NOT `#footer-audio-out`, an unrelated role="dialog" popover that is
 *  `hidden` by default -- matching on aria-modal="true" keeps the Escape loop
 *  from spinning on that one forever.) Call this after every navigation AND
 *  every reload in this script, not just once at boot. */
async function dismissStartupOverlays(page) {
  for (let i = 0; i < 4; i++) {
    const modal = page.locator('[role="dialog"][aria-modal="true"]')
    if ((await modal.count()) === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  // Defense in depth, in case a variant does not close on Escape: the home
  // screen's own explicit close control.
  const closeBtn = page.locator('[aria-label="Close home screen"]')
  try {
    if ((await closeBtn.count()) > 0 && (await closeBtn.first().isVisible())) {
      await closeBtn.first().click({ timeout: 3000 })
      await page.waitForTimeout(300)
    }
  } catch {
    // not fatal -- the tab bar may still be reachable
  }
}

const report = createReport('q10-boot-nav')
const { browser, page, consoleErrors } = await openApp({ width: 1600, height: 900 })

try {
  // App.tsx's boot sequence holds on a ~14-24s cinematic splash (particle
  // logo -> wordmark -> credit) before the tab bar mounts, independent of
  // backend-readiness / API calls. It is intentionally bypassable via
  // `?nocinematic`, documented in App.tsx as "used by the screenshot/capture
  // harness" -- i.e. exactly this kind of script. Navigate once so every
  // later page.reload() in this file keeps the same URL and never re-plays
  // the splash (nocinematic does not affect the API calls / console-error
  // checks below, only the cosmetic overlay).
  const bootUrl = `${QA_URL}${QA_URL.includes('?') ? '&' : '?'}nocinematic`
  await page.goto(bootUrl, { waitUntil: 'networkidle', timeout: 60000 })
  await dismissStartupOverlays(page)
  await page.waitForSelector('[data-tour="tab-make"]', { timeout: 15000 })

  // ---- Scenario 1: boot with no uncaught error / no unexpected 4xx-5xx ----
  const bootApiCalls = []
  page.on('response', (res) => {
    const u = res.url()
    if (u.includes('/api/')) bootApiCalls.push({ status: res.status(), url: u })
    if (res.status() >= 400) console.log(`DIAG failed resource ${res.status()}: ${u}`)
  })

  await report.scenario('1-boot-no-errors', async () => {
    // The navigation above happened before this listener was attached;
    // reload() is a full boot from the browser's point of view (same URL, so
    // it keeps the nocinematic hook) and gives complete request/console
    // capture. It re-arms the tour/home overlays by design (see
    // dismissStartupOverlays above), so dismiss them again before asserting.
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(1500)
    await dismissStartupOverlays(page)
    await page.screenshot({ path: report.shotPath('01-boot'), fullPage: true })

    const failed = bootApiCalls.filter((c) => c.status >= 400)
    console.log(
      failed.length
        ? `boot /api 4xx/5xx observed: ${failed.map((f) => `${f.status} ${f.url}`).join(' | ')}`
        : 'boot /api 4xx/5xx observed: (none)',
    )
    if (consoleErrors.length) {
      throw new Error(`uncaught console/page error(s) on boot: ${consoleErrors.join(' | ')}`)
    }
    const serverErrors = failed.filter((f) => f.status >= 500)
    expect(serverErrors.length === 0, `5xx during boot: ${serverErrors.map((f) => `${f.status} ${f.url}`).join(' | ')}`)
  })

  // ---- Scenario 2: switch through every top-bar view and back ----
  // Collect-and-continue rather than fail-fast: a single bad tab must not
  // hide whether every OTHER tab (the actual scope: "EVERY top-bar view")
  // is clean, so one run gives full 13-tab coverage instead of stopping at
  // the first failure.
  await report.scenario('2-nav-all-views-and-back', async () => {
    const failures = []
    for (const id of ON_SCREEN_TABS) {
      const before = consoleErrors.length
      try {
        const tab = page.locator(`[data-tour="tab-${id}"]`)
        expect(await tab.count() === 1, `no tab button found for [data-tour="tab-${id}"]`)
        await tab.click()
        await page.waitForTimeout(600)
        const box = await page.locator('main').boundingBox()
        expect(!!box && box.width > 100 && box.height > 100, `<main> has degenerate size after switching to ${id}`)
        const visible = await visibleElementCount(page)
        expect(visible > 10, `view "${id}" looks blank: only ${visible} elements with non-zero size under <main>`)
        await page.screenshot({ path: report.shotPath(`02-view-${id}`) })
        if (consoleErrors.length > before) {
          throw new Error(`uncaught error switching to "${id}": ${consoleErrors.slice(before).join(' | ')}`)
        }
      } catch (e) {
        failures.push(`[${id}] ${String((e && e.message) || e).slice(0, 200)}`)
      }
    }
    // ...and back to the default view.
    await page.locator('[data-tour="tab-make"]').click()
    await page.waitForTimeout(400)
    const pressed = await page.locator('[data-tour="tab-make"]').getAttribute('aria-pressed')
    if (pressed !== 'true') failures.push(`returning to MAKE did not mark it active (aria-pressed="${pressed}")`)
    if (failures.length) throw new Error(failures.join(' ;; '))
  })

  // ---- Scenario 3: Help/diagnostics build ids ----
  await report.scenario('3-build-ids-match', async () => {
    const apiBuild = await page.evaluate(async () => {
      const r = await fetch('/api/updates/build', { cache: 'no-store' })
      return { status: r.status, body: await r.json().catch(() => null) }
    })
    expect(apiBuild.status === 200, `GET /api/updates/build returned HTTP ${apiBuild.status}`)
    expect(
      !!apiBuild.body && typeof apiBuild.body.git_sha === 'string' && apiBuild.body.git_sha.length > 0,
      `GET /api/updates/build has no usable git_sha: ${JSON.stringify(apiBuild.body)}`,
    )

    await page.locator('button[aria-label="App menu"]').click()
    await page.locator('[role="menuitem"]', { hasText: 'Check for Updates' }).click()
    await page.waitForFunction(() => {
      const spans = [...document.querySelectorAll('span')]
      const label = spans.find((e) => e.textContent === 'Backend build')
      const sha = label?.nextElementSibling?.textContent
      return !!sha && sha !== '...'
    }, { timeout: 10000 })

    const frontendSha = (await page.locator('span:text-is("Frontend build") + span').innerText()).trim()
    const backendSha = (await page.locator('span:text-is("Backend build") + span').innerText()).trim()
    await page.screenshot({ path: report.shotPath('03-build-ids') })
    await page.locator('button[aria-label="Close updates dialog"]').click()
    await page.waitForTimeout(200)

    console.log(`frontend build: ${frontendSha} | backend build (UI): ${backendSha} | GET /api/updates/build: ${apiBuild.body.git_sha}`)
    expect(frontendSha !== 'unknown' && frontendSha.length > 0, `frontend build id shows "${frontendSha}"`)
    expect(backendSha !== 'unavailable' && backendSha !== '...', `backend build id UI shows "${backendSha}"`)
    expect(backendSha === apiBuild.body.git_sha, `UI backend build "${backendSha}" != GET /api/updates/build "${apiBuild.body.git_sha}"`)
  })

  // ---- Scenario 4: reloading on each view restores that view ----
  // Same collect-and-continue reasoning as Scenario 2.
  await report.scenario('4-reload-restores-view', async () => {
    const failures = []
    for (const id of ON_SCREEN_TABS) {
      try {
        await page.locator(`[data-tour="tab-${id}"]`).click()
        await page.waitForTimeout(500)
        const before = consoleErrors.length
        await page.reload({ waitUntil: 'networkidle', timeout: 60000 })
        await page.waitForTimeout(800)
        await dismissStartupOverlays(page)
        if (consoleErrors.length > before) {
          throw new Error(`uncaught error reloading on "${id}": ${consoleErrors.slice(before).join(' | ')}`)
        }
        const pressed = await page.locator(`[data-tour="tab-${id}"]`).getAttribute('aria-pressed')
        expect(pressed === 'true', `reload did not restore view "${id}" (aria-pressed="${pressed}")`)
        const visible = await visibleElementCount(page)
        expect(visible > 10, `view "${id}" looks blank after reload: only ${visible} visible elements`)
        await page.screenshot({ path: report.shotPath(`04-reload-${id}`) })
      } catch (e) {
        failures.push(`[${id}] ${String((e && e.message) || e).slice(0, 200)}`)
      }
    }
    if (failures.length) throw new Error(failures.join(' ;; '))
  })

  // ---- Scenario 5: resize 1280x720 / 1920x1080, no overlap/unreachable controls in EDIT ----
  await report.scenario('5-resize-edit-controls', async () => {
    await page.locator('[data-tour="tab-edit"]').click()
    await page.waitForTimeout(500)

    for (const [w, h] of [[1280, 720], [1920, 1080]]) {
      await page.setViewportSize({ width: w, height: h })
      await page.waitForTimeout(500)

      const rects = []
      for (const label of EDIT_CONTROL_LABELS) {
        const loc = page.getByLabel(label, { exact: true }).first()
        if ((await loc.count()) === 0) continue
        const box = await loc.boundingBox()
        if (!box) continue
        rects.push({ label, box })
        expect(
          box.x >= 0 && box.y >= 0 && box.x + box.width <= w && box.y + box.height <= h,
          `"${label}" is off-screen/unreachable at ${w}x${h}: ${JSON.stringify(box)}`,
        )
      }
      expect(
        rects.length >= 5,
        `only found ${rects.length}/${EDIT_CONTROL_LABELS.length} expected EDIT toolbar controls at ${w}x${h} (selectors may be stale)`,
      )

      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].box
          const b = rects[j].box
          const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
          const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
          const overlapArea = ox * oy
          const minArea = Math.min(a.width * a.height, b.width * b.height)
          expect(
            !(minArea > 0 && overlapArea / minArea > 0.3),
            `"${rects[i].label}" overlaps "${rects[j].label}" at ${w}x${h}`,
          )
        }
      }
      await page.screenshot({ path: report.shotPath(`05-edit-${w}x${h}`) })
    }
    await page.setViewportSize({ width: 1600, height: 900 })
  })
} finally {
  report.finish()
  await browser.close()
}
