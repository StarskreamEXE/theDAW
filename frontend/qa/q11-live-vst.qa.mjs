// QA area q11-live-vst — a REAL VST3 plugin processing audio LIVE during playback.
//
// Run with:
//   cd "C:\Users\skream\projects\_thedaw-batch11\frontend" && node qa/q11-live-vst.qa.mjs
//
// What the app under test is expected to do (the code these checks follow):
//   - EDIT's track FX list (`FxChainList`, components/audio/EffectWindows.tsx)
//     shows each hosted plugin's state through `VstLiveRowBadge`: the pill text
//     is one of 'LIVE · <n> ms' / 'LIVE · DEFAULTS' / 'starting…' / 'error' /
//     'render-only' (components/audio/fxRackBadge.ts), and an error row offers
//     a retry button.
//   - A session nobody uses is shut down after a 10 s grace period
//     (`VST_LIVE_GRACE_MS`, lib/vstLive/sessionRegistry.ts) — that grace is what
//     lets a graph rebuild, or an undo of a remove, get the SAME running plugin
//     back. So "remove closes the host" is checked over 16 s, not instantly.
//   - A dead host is re-created automatically (`recreate` in the registry); the
//     row goes 'error' and comes back to LIVE without the user doing anything.
//   - Adding a plugin opens its window, and with a live host on the machine that
//     window must belong to the LIVE instance. qaLib switches plugin windows off
//     for every run, and the app then logs which editor it WOULD have opened
//     (lib/vstLive/editorWindowSwitch.ts) — that log line is the evidence here.
//     No window ever appears on the desktop.
//
// "Blocks flowing" is proven from the wire: the binary WebSocket traffic
// between the browser and the native host (docs/design/vst-live-protocol.md),
// seen through Playwright's page.on('websocket').
//
// Persistence is checked through the app's own crash-recovery autosave (OPFS,
// inside the browser profile): refresh the page, restore, and the plugin has to
// come back live. Nothing is saved to disk.

import { openApp, createReport, expect, ASSETS_DIR } from './qaLib.mjs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const AREA = 'q11-live-vst'
const BACKEND = process.env.QA_BACKEND || 'http://127.0.0.1:8611'
const PLUGIN_NAME = 'AIR Vocal Doubler'
const TONE_WAV = path.join(ASSETS_DIR, 'tone-440-10s.wav')

function hostProcCount() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq thedaw-vst-host.exe" /FO CSV /NH', { encoding: 'utf8', windowsHide: true })
    return out.split('\n').map((l) => l.trim()).filter((l) => l.toLowerCase().includes('thedaw-vst-host.exe')).length
  } catch {
    return 0
  }
}

function killPid(pid) {
  try {
    execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf8', windowsHide: true })
    return true
  } catch (e) {
    return String(e)
  }
}

async function apiGet(p) {
  const r = await fetch(`${BACKEND}${p}`)
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function apiDelete(p) {
  const r = await fetch(`${BACKEND}${p}`, { method: 'DELETE' })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// The QA backend's project is SHARED with every other area's script running
// concurrently in this batch (tracks from other agents' runs accumulate), and
// the shared instance has grown a persistent bottom-left "Click me ^ MIXER"
// hint tag that sits on top of the track-header column (confirmed via
// elementFromPoint: a button with count=1 and isVisible()=true still resolved
// to an unrelated overlay div at its own center point). Real clicks there
// hang for Playwright's full 30s actionability timeout. A plain DOM
// `.click()` fires the same React onClick without hit-testing, which is the
// reliable way to drive controls in that column.
async function jsClick(locator) {
  const handle = await locator.elementHandle()
  if (!handle) throw new Error('jsClick: locator resolved to no element')
  await handle.evaluate((el) => el.click())
}

/** Click normally (fast path); fall back to the DOM `.click()` above if the
 *  normal path can't hit-test it within `timeout`. */
async function safeClick(locator, opts = {}) {
  try {
    await locator.click({ timeout: opts.timeout ?? 6000 })
  } catch {
    await jsClick(locator)
  }
}

/** Open a context menu without depending on real screen coordinates being
 *  unobstructed: dispatch a genuine `contextmenu` MouseEvent on the element
 *  directly. React's delegated listener sees it exactly like a real
 *  right-click (only the later OS file-dialog trigger needs a trusted click,
 *  not this). */
async function dispatchContextMenu(locator) {
  const handle = await locator.elementHandle()
  if (!handle) throw new Error('dispatchContextMenu: locator resolved to no element')
  await handle.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }))
  })
}

async function safeRightClick(locator) {
  try {
    await locator.click({ button: 'right', timeout: 6000 })
  } catch {
    await dispatchContextMenu(locator)
  }
}

/** Current display name of the first track, read fresh: importing a clip
 *  auto-renames an untouched track to the clip's file stem
 *  (`nameAutoGenerated`), so a name captured before the import is stale by
 *  the time it's needed for an aria-label lookup afterwards. */
async function firstTrackName(page) {
  const el = page.locator('input[aria-label^="Track "][aria-label$=" name"]').first()
  const label = await el.getAttribute('aria-label')
  return label.replace(/^Track /, '').replace(/ name$/, '')
}

async function dismissBootAndTour(page) {
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
}

async function main() {
  const { browser, page, consoleErrors } = await openApp()
  const report = createReport(AREA)

  // Track every websocket the page opens; the live-vst bridge client opens
  // one binary+JSON socket per session, at the ws_url the backend returns from
  // POST /api/vst/live/session. We correlate by that exact URL (read off the
  // network response) rather than guessing by port.
  const sockets = [] // { url, ws, sent, received, closed }
  page.on('websocket', (ws) => {
    const entry = { url: ws.url(), ws, sent: 0, received: 0, closed: false }
    ws.on('framesent', () => { entry.sent++ })
    ws.on('framereceived', () => { entry.received++ })
    ws.on('close', () => { entry.closed = true })
    sockets.push(entry)
  })
  let lastCreateSessionBody = null
  page.on('response', async (res) => {
    if (res.request().method() === 'POST' && /\/api\/vst\/live\/session$/.test(res.url())) {
      lastCreateSessionBody = await res.json().catch(() => null)
    }
  })
  // Plugin windows are switched off for QA; the app logs which editor it would
  // have opened instead (lib/vstLive/editorWindowSwitch.ts).
  const withheld = { live: 0, offline: 0 }
  page.on('console', (m) => {
    const text = m.text()
    if (text.includes('[vstLive] open_editor withheld')) withheld.live += 1
    if (text.includes('[vst] offline editor withheld')) withheld.offline += 1
  })
  let offlineEditorPosts = 0
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/vst\/open-editor$/.test(req.url())) offlineEditorPosts += 1
  })

  /** The live pill(s) the page shows right now, e.g. ['LIVE · 46.4 ms']. */
  const readPills = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('span[title]'))
        .map((el) => (el.textContent || '').trim())
        .filter((t) => /^(LIVE|starting|error|render-only)/.test(t)),
    )
  const aliveSessions = async () => ((await apiGet('/api/vst/live/sessions')).body?.sessions ?? []).filter((s) => s.alive)

  let trackName = null
  let sessionId = null
  let hostPid = null
  let liveEntryId = null // chain entry id of the plugin scenarios 5 and 6 work on
  // Only ever close sessions THIS run opened — the backend is shared with
  // other areas' concurrent scripts, so a blanket "delete every session" in
  // cleanup would be able to kill another agent's live plugin out from under
  // it. Track exactly what we spawned.
  const createdSessionIds = new Set()

  try {
    await dismissBootAndTour(page)
    const editTab = page.locator('[data-tour="tab-edit"]')
    expect(await editTab.count() > 0, 'no [data-tour="tab-edit"] tab button found')
    await editTab.click()
    await page.waitForTimeout(500)

    // ── Scenario 1: add the VST3 plugin through the app's own UI ──────────
    await report.scenario('add-plugin-goes-live-within-10s', async () => {
      const before = await apiGet('/api/vst/live/sessions')
      expect(before.status === 200, `GET /api/vst/live/sessions returned HTTP ${before.status}`)
      const beforeCount = before.body?.sessions?.length ?? 0
      const beforeProcCount = hostProcCount()

      // This QA backend's project is shared with every other area's script
      // running concurrently in this batch, so tracks accumulate across runs
      // and a brand-new track lands increasingly far down a track-header
      // column that is `overflow-hidden` (no user scrollbar) with a
      // persistent "Click me ^ MIXER" hint tag pinned over its bottom-left
      // corner. Both make a freshly-added track's own controls unreliable to
      // hit-test. Track 1 (topmost, always on screen) is used instead — a
      // pure addition (a clip, an FX entry) is not destructive to whatever
      // another concurrent run put on it.
      const nameInputs = page.locator('input[aria-label^="Track "][aria-label$=" name"]')
      expect(await nameInputs.count() > 0, 'expected at least one existing track in the shared QA project')
      const firstInput = nameInputs.first()

      // Import tone-440-10s.wav via the track's "Audio from System..." menu.
      await safeRightClick(firstInput)
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        page.getByRole('menuitem', { name: /Audio from System/i }).click(),
      ])
      await chooser.setFiles(TONE_WAV)
      await page.waitForFunction(() => document.querySelectorAll('[data-clip="1"]').length > 0, { timeout: 15000 })
      await page.screenshot({ path: report.shotPath('01a-clip-imported') })

      // Read the name AFTER import: an untouched track auto-renames itself to
      // the clip's file stem (nameAutoGenerated), so a name read beforehand
      // (e.g. "Track 1") would be stale here (verified empirically — it
      // became "tone-440").
      trackName = await firstTrackName(page)

      // Open the track's FX rack and add the VST3 plugin via the app's own
      // plugin browser (FxChainList's "VST" toggle -> Plugins list).
      await safeClick(page.getByRole('button', { name: `Track ${trackName} insert FX` }))
      await page.waitForTimeout(200)
      const vstToggle = page.getByRole('button', { name: 'VST', exact: true })
      await vstToggle.waitFor({ state: 'visible', timeout: 5000 })
      await safeClick(vstToggle)

      let pluginBtn = page.getByTitle(`Insert ${PLUGIN_NAME}`)
      if (!(await pluginBtn.count())) {
        // Plugin list not warm yet: rescan and give it real time (the scan
        // walks every VST3 folder on the machine).
        const rescan = page.getByRole('button', { name: 'Rescan VST3 folders' })
        if (await rescan.count()) await safeClick(rescan)
        await page.waitForSelector(`text=${PLUGIN_NAME}`, { timeout: 15000 }).catch(() => {})
        pluginBtn = page.getByTitle(`Insert ${PLUGIN_NAME}`)
      }
      expect(await pluginBtn.count() > 0, `plugin browser never showed an "Insert ${PLUGIN_NAME}" row`)
      await safeClick(pluginBtn.first())
      await page.screenshot({ path: report.shotPath('01b-plugin-added') })

      // FxChainList's onAddVst is `addAndEditTrackVst`: adding a plugin also asks
      // for its editor window. Windows are switched off for QA (qaLib), so none
      // appears; scenario 2 checks WHICH editor the app reached for.

      // Backend truth: exactly one new session, exactly one new host process.
      // NOTE: sessionRegistry.acquire() only runs when buildEffectChain
      // actually builds the chain, which vstLiveNode.ts says happens "on
      // every play / stop / seek" — so if the session never appears merely
      // from adding the entry, press Play (scenario 2's action) to force a
      // build, and record that the "within ~10s of adding" wording did not
      // hold as stated.
      let sessions = null
      let neededPlayToGoLive = false
      const deadline1 = Date.now() + 6000
      while (Date.now() < deadline1) {
        const r = await apiGet('/api/vst/live/sessions')
        if ((r.body?.sessions?.length ?? 0) > beforeCount) { sessions = r.body.sessions; break }
        await page.waitForTimeout(300)
      }
      if (!sessions) {
        neededPlayToGoLive = true
        await safeClick(page.getByRole('button', { name: 'Play the arrangement' }))
        const deadline2 = Date.now() + 10000
        while (Date.now() < deadline2) {
          const r = await apiGet('/api/vst/live/sessions')
          if ((r.body?.sessions?.length ?? 0) > beforeCount) { sessions = r.body.sessions; break }
          await page.waitForTimeout(300)
        }
      }
      expect(
        !!sessions,
        `no new session appeared under GET /api/vst/live/sessions within 6s of adding the plugin, or within 10s more after pressing Play (had ${beforeCount} before)`,
      )
      if (neededPlayToGoLive) {
        console.log('  FINDING: the entry did NOT go live merely from being added — a session only appeared after pressing Play (buildEffectChain only runs on play/stop/seek, per vstLiveNode.ts). This contradicts the "within about 10s" of adding wording taken alone.')
      }
      const mine = sessions[sessions.length - 1]
      sessionId = mine.session_id
      hostPid = mine.pid
      createdSessionIds.add(sessionId)
      expect(mine.alive === true, `new session ${sessionId} reports alive=false: ${JSON.stringify(mine)}`)

      const afterProcCount = hostProcCount()
      expect(
        afterProcCount === beforeProcCount + 1,
        `expected exactly one new thedaw-vst-host.exe process (before=${beforeProcCount}, after=${afterProcCount})`,
      )

      // UI truth: does the row the user is looking at actually say LIVE?
      // (fxRackBadge.ts: 'LIVE' / 'LIVE · DEFAULTS' / 'starting…' / 'error' /
      // 'render-only' are the only possible pill texts.)
      await page.waitForTimeout(1500) // let a 'ready' round-trip land if it's going to
      const popoverText = await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('span')).find((el) => /^Track FX/.test(el.textContent || ''))
        const panel = heading ? heading.closest('div.hardware-card, div[class*="hardware-card"]') || heading.parentElement?.parentElement : null
        return panel ? panel.textContent : document.body.textContent.slice(0, 2000)
      })
      const pillTexts = ['LIVE · DEFAULTS', 'LIVE', 'starting…', 'render-only']
      const shownPill = pillTexts.find((t) => popoverText.includes(t))
      await page.screenshot({ path: report.shotPath('01c-fx-rack-after-live') })

      expect(
        !!shownPill && (shownPill === 'LIVE' || shownPill === 'LIVE · DEFAULTS'),
        `backend confirms the plugin is live (session ${sessionId}, pid ${hostPid}), but the EDIT track FX rack row shows no LIVE pill at all ` +
        `(FxChainList in EffectWindows.tsx never renders vstLiveBadge/liveBadge; that only happens inside <FxRack>, which EDIT's per-track rack does not use). ` +
        `Popover text was: ${JSON.stringify(popoverText.slice(0, 300))}`,
      )
    })

    // ── Scenario 1b: the window the app asks for is the LIVE instance's ────
    await report.scenario('plugin-window-request-goes-to-the-live-instance', async () => {
      expect(!!sessionId, 'setup: no live session')
      // The request follows the session going live (a cold start can take a few seconds).
      const deadline = Date.now() + 20000
      while (Date.now() < deadline && withheld.live === 0 && withheld.offline === 0 && offlineEditorPosts === 0) {
        await page.waitForTimeout(250)
      }
      expect(
        withheld.offline === 0 && offlineEditorPosts === 0,
        `the app reached for the OFFLINE (pedalboard) editor after adding a plugin with a live host available ` +
        `(withheld offline opens=${withheld.offline}, open-editor POSTs=${offlineEditorPosts}) — a second copy of the plugin, not the one being heard`,
      )
      expect(withheld.live >= 1, 'the app never asked the LIVE host to open the plugin window within 20s of adding the plugin')

      // Closing the plugin window must not take the live plugin out of the mix.
      const editorClose = page.getByRole('button', { name: new RegExp(`^Close .*${PLUGIN_NAME}.*window$`, 'i') })
      if (await editorClose.count().catch(() => 0)) {
        await safeClick(editorClose.first())
        await page.waitForTimeout(500)
      }
      const s = await apiGet(`/api/vst/live/session/${sessionId}`)
      expect(s.status === 200 && s.body?.alive === true, `session ${sessionId} is no longer alive after the window request/close: ${JSON.stringify(s.body)}`)
    })

    // ── Scenario 2: press play, prove blocks flow through the plugin ──────
    await report.scenario('playback-drives-live-audio-blocks-through-plugin', async () => {
      expect(!!sessionId, 'setup: no live session from scenario 1 to test playback against')
      const wsUrl = lastCreateSessionBody?.ws_url
      // Scenario 1 may already have pressed Play to force the chain to build
      // (see its FINDING log) — only press it here if playback isn't already
      // running, since SurfacePlayKey toggles play/pause on the same control.
      if (!(await page.getByRole('button', { name: 'Pause the arrangement' }).count())) {
        await safeClick(page.getByRole('button', { name: 'Play the arrangement' }))
      }
      await page.waitForTimeout(2500)

      const stillPlaying = await page.getByRole('button', { name: 'Pause the arrangement' }).count()
      expect(stillPlaying > 0, 'transport did not stay in the playing state 2.5s after pressing play')

      const sock = sockets.find((s) => wsUrl && s.url === wsUrl) ?? sockets.find((s) => /^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(s.url))
      await page.screenshot({ path: report.shotPath('02-playing') })
      await page.waitForTimeout(1500)

      const sInfo = await apiGet(`/api/vst/live/session/${sessionId}`)
      expect(sInfo.status === 200 && sInfo.body?.alive, `session ${sessionId} not alive during playback: ${JSON.stringify(sInfo.body)}`)

      expect(consoleErrors.length === 0, `console errors during playback: ${consoleErrors.join(' | ')}`)

      if (sock) {
        console.log(`  evidence: live-vst websocket ${sock.url} — frames sent=${sock.sent} received=${sock.received}`)
        expect(sock.sent > 0 && sock.received > 0, `expected binary audio_in/audio_out frames on ${sock.url}, saw sent=${sock.sent} received=${sock.received}`)
      } else {
        console.log(`  note: could not correlate a websocket to ws_url=${wsUrl}; sockets seen: ${sockets.map((s) => s.url).join(', ') || '(none)'}`)
        throw new Error(`no websocket connection observed to the live-vst host (expected one at ${wsUrl || '<unknown, POST /session response not captured>'})`)
      }

      await safeClick(page.getByRole('button', { name: 'Stop and return to start' }))
      await page.waitForTimeout(300)

      console.log('  note: no xrun counter is exposed anywhere reachable (LiveSessionInfo has no counters; vstLiveStore.xruns is never rendered by EDIT); frame counts above are the strongest available evidence of "no underrun storm" (steady sent≈received, no exceptions).')
    })

    // ── Scenario 3: declared latency non-zero live, zero bypassed/removed ─
    await report.scenario('declared-latency-reflects-live-state', async () => {
      const popoverText = await page.evaluate(() => document.body.textContent || '')
      const hasMsReading = /\d+(\.\d+)?\s*ms/.test(popoverText)
      if (!hasMsReading) {
        throw new Error(
          'BLOCKED: no latency (ms) readout exists anywhere in the EDIT UI for a track vst3 entry to assert against. ' +
          'The only "X ms of latency" text in the whole frontend is the `title` on FxRack.tsx\'s vstLiveBadge pill ' +
          '(components/audio/FxRack.tsx L131), and EDIT\'s track FX rack uses FxChainList (EffectWindows.tsx), which never renders <FxRack> for vst3 rows. ' +
          'No window debug handle exists (grepped window.__/globalThis.__) to read chainLatencyReport/vstLiveLatencySec directly. ' +
          'Cannot verify this expectation without violating "never invent a result".',
        )
      }
    })

    // ── Scenario 4: bypass / un-bypass / remove ────────────────────────────
    await report.scenario('bypass-unbypass-remove-closes-session', async () => {
      expect(!!sessionId, 'setup: no live session to bypass/remove')
      const bypassBtn = page.getByRole('button', { name: new RegExp(`Bypass ${PLUGIN_NAME}`, 'i') })
      await bypassBtn.waitFor({ state: 'visible', timeout: 5000 })
      await safeClick(bypassBtn)
      await page.waitForTimeout(300)
      const enableBtn = page.getByRole('button', { name: new RegExp(`Enable ${PLUGIN_NAME}`, 'i') })
      expect(await enableBtn.count() > 0, 'bypass click did not flip the row to the Enable state')
      await page.screenshot({ path: report.shotPath('04a-bypassed') })

      await safeClick(enableBtn)
      await page.waitForTimeout(300)
      expect(await page.getByRole('button', { name: new RegExp(`Bypass ${PLUGIN_NAME}`, 'i') }).count() > 0, 'un-bypass click did not flip the row back to Bypass state')

      const removeBtn = page.getByRole('button', { name: new RegExp(`Remove ${PLUGIN_NAME}`, 'i') })
      expect(await removeBtn.count() > 0, 'no Remove button found for the plugin row')
      await safeClick(removeBtn)
      await page.waitForTimeout(300)
      await page.screenshot({ path: report.shotPath('04b-removed') })

      // 10 s grace (VST_LIVE_GRACE_MS) + the host's own shutdown: see the header.
      const removedAt = Date.now()
      const deadline = removedAt + 16000
      let closed = false
      let procGone = false
      while (Date.now() < deadline) {
        const s = await apiGet(`/api/vst/live/session/${sessionId}`)
        const aliveNow = s.status === 200 ? s.body?.alive : false
        procGone = hostProcCount() === 0 || !(await pidAlive(hostPid))
        if ((s.status === 404 || aliveNow === false) && procGone) { closed = true; break }
        await page.waitForTimeout(400)
      }
      expect(closed, `session ${sessionId} / pid ${hostPid} did not close within 16s of Remove (last check: procGone=${procGone})`)
      console.log(`  host exited ${((Date.now() - removedAt) / 1000).toFixed(1)} s after Remove`)
      const pills = await readPills()
      expect(pills.length === 0, `the removed plugin still shows a live pill: ${JSON.stringify(pills)}`)
    })

    // ── Scenario 5: failure path — kill the host process out from under it ─
    await report.scenario('failure-path-kill-host-recovers-to-live', async () => {
      const knownIds = new Set(((await apiGet('/api/vst/live/sessions')).body?.sessions ?? []).map((s) => s.session_id))
      trackName = await firstTrackName(page)

      await safeClick(page.getByRole('button', { name: `Track ${trackName} insert FX` }))
      await page.waitForTimeout(200)
      let vstToggle = page.getByRole('button', { name: 'VST', exact: true })
      if (!(await vstToggle.count())) {
        await safeClick(page.getByRole('button', { name: `Track ${trackName} insert FX` }))
        await page.waitForTimeout(200)
        vstToggle = page.getByRole('button', { name: 'VST', exact: true })
      }
      await safeClick(vstToggle)
      const pluginBtn = page.getByTitle(`Insert ${PLUGIN_NAME}`)
      await pluginBtn.waitFor({ state: 'visible', timeout: 5000 })
      await safeClick(pluginBtn)

      // A session this run has not seen before, by id: counting sessions is wrong
      // while the removed plugin's host is still inside its grace period.
      let mine = null
      let deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        mine = (await aliveSessions()).find((s) => !knownIds.has(s.session_id)) ?? null
        if (mine) break
        await page.waitForTimeout(300)
      }
      expect(!!mine, 're-adding the plugin never produced a new session within 15s')
      sessionId = mine.session_id
      hostPid = mine.pid
      liveEntryId = mine.chain_entry_id
      createdSessionIds.add(sessionId)

      deadline = Date.now() + 15000
      while (Date.now() < deadline && !(await readPills()).some((t) => t.startsWith('LIVE'))) await page.waitForTimeout(250)
      expect((await readPills()).some((t) => t.startsWith('LIVE')), `the re-added plugin never showed LIVE: ${JSON.stringify(await readPills())}`)

      await safeClick(page.getByRole('button', { name: 'Play the arrangement' }))
      await page.waitForTimeout(1500)

      const killResult = killPid(hostPid);
      expect(killResult === true, `taskkill /PID ${hostPid} /F failed: ${killResult}`)

      // EXPECTED: the row leaves LIVE and says so, the transport keeps running
      // (the track plays dry), and the registry re-creates the host by itself.
      const seen = []
      let recovered = null
      let clickedRetry = false
      const killedAt = Date.now()
      while (Date.now() - killedAt < 25000) {
        const pill = (await readPills())[0] ?? '(none)'
        if (seen[seen.length - 1] !== pill) seen.push(pill)
        const again = (await aliveSessions()).find((s) => s.chain_entry_id === liveEntryId && s.pid !== hostPid)
        if (again && pill.startsWith('LIVE')) { recovered = again; break }
        // Still down after 12 s: use the retry the error row offers.
        if (!clickedRetry && Date.now() - killedAt > 12000) {
          const retryBtn = page.getByRole('button', { name: /^Retry the live plugin host/i })
          if (await retryBtn.count()) { await safeClick(retryBtn.first()); clickedRetry = true }
        }
        await page.waitForTimeout(120)
      }
      console.log(`  pill sequence after the kill: ${seen.join(' -> ')}${clickedRetry ? ' (retry clicked)' : ''}`)
      await page.screenshot({ path: report.shotPath('05a-after-host-killed') })

      const stillPlaying = await page.getByRole('button', { name: 'Pause the arrangement' }).count()
      expect(stillPlaying > 0, 'transport stopped/crashed after the host process was killed — should keep running dry')
      // A failed WebSocket logs a console error by itself; an uncaught exception is the real failure.
      const pageErrors = consoleErrors.filter((t) => t.startsWith('PAGEERROR'))
      expect(pageErrors.length === 0, `uncaught exception after killing the host: ${pageErrors.join(' | ')}`)
      expect(seen.some((t) => /^(error|starting)/.test(t)), `the row never left LIVE after its host was killed (saw: ${seen.join(' -> ')})`)
      expect(!!recovered, `the plugin did not come back LIVE within 25s of its host being killed (saw: ${seen.join(' -> ')})`)
      sessionId = recovered.session_id
      hostPid = recovered.pid
      createdSessionIds.add(sessionId)
      console.log(`  recovered ${((Date.now() - killedAt) / 1000).toFixed(1)} s after the kill, new pid ${hostPid}`)

      await safeClick(page.getByRole('button', { name: 'Stop and return to start' })).catch(() => {})
    })

    // ── Scenario 6: save + reload persistence ──────────────────────────────
    await report.scenario('refresh-and-restore-brings-the-plugin-back-live', async () => {
      expect(!!liveEntryId, 'setup: no live plugin left in the chain from scenario 5')
      // The crash-recovery autosave is debounced 2 s behind the last edit.
      await page.waitForTimeout(4000)
      const oldSessionId = sessionId
      const oldPid = hostPid

      await page.reload({ waitUntil: 'networkidle', timeout: 60000 })
      await dismissBootAndTour(page)
      const restore = page.getByRole('button', { name: 'Restore', exact: true })
      await restore.waitFor({ state: 'visible', timeout: 20000 })
      await restore.click()
      await page.locator('[data-tour="tab-edit"]').click()
      await page.waitForFunction(() => document.querySelectorAll('[data-clip="1"]').length > 0, { timeout: 20000 })

      // The page that went away must have closed ITS host (pagehide -> keepalive DELETE).
      let deadline = Date.now() + 8000
      while (Date.now() < deadline && (await pidAlive(oldPid))) await page.waitForTimeout(300)
      expect(!(await pidAlive(oldPid)), `the refreshed page left its host process running (pid ${oldPid}, session ${oldSessionId})`)

      // The restored plugin is the same chain entry, hosted again.
      let again = null
      let neededPlay = false
      deadline = Date.now() + 10000
      while (Date.now() < deadline && !again) {
        again = (await aliveSessions()).find((s) => s.chain_entry_id === liveEntryId && s.session_id !== oldSessionId) ?? null
        if (!again) await page.waitForTimeout(300)
      }
      if (!again) {
        neededPlay = true
        await safeClick(page.getByRole('button', { name: 'Play the arrangement' }))
        deadline = Date.now() + 15000
        while (Date.now() < deadline && !again) {
          again = (await aliveSessions()).find((s) => s.chain_entry_id === liveEntryId && s.session_id !== oldSessionId) ?? null
          if (!again) await page.waitForTimeout(300)
        }
      }
      expect(!!again, `after refresh + Restore the plugin (entry ${liveEntryId}) was never hosted again`)
      createdSessionIds.add(again.session_id)
      if (neededPlay) console.log('  NOTE: the restored plugin only went live once Play was pressed')

      trackName = await firstTrackName(page)
      await safeClick(page.getByRole('button', { name: `Track ${trackName} insert FX` }))
      deadline = Date.now() + 15000
      while (Date.now() < deadline && !(await readPills()).some((t) => t.startsWith('LIVE'))) await page.waitForTimeout(250)
      const pills = await readPills()
      await page.screenshot({ path: report.shotPath('06a-after-refresh-restore') })
      expect(pills.some((t) => t.startsWith('LIVE')), `the restored plugin row does not say LIVE: ${JSON.stringify(pills)}`)
      expect(!pills.some((t) => t.includes('DEFAULTS')), `the restored plugin came back at its DEFAULTS — its saved state was refused: ${JSON.stringify(pills)}`)
      await safeClick(page.getByRole('button', { name: 'Stop and return to start' })).catch(() => {})
    })
  } finally {
    // Close only the sessions THIS run opened — never touch a session another
    // concurrent QA area's script might be holding on the shared backend.
    try {
      for (const id of createdSessionIds) {
        const s = await apiGet(`/api/vst/live/session/${id}`)
        if (s.status === 200 && s.body?.alive) await apiDelete(`/api/vst/live/session/${id}`).catch(() => {})
      }
      await page.waitForTimeout(1000)
      for (const id of createdSessionIds) {
        const s = await apiGet(`/api/vst/live/session/${id}`)
        if (s.status === 200 && s.body?.alive) console.log(`  cleanup warning: session ${id} (pid ${s.body.pid}) still alive after cleanup`)
      }
    } catch (e) {
      console.log(`  cleanup warning: ${e}`)
    }
    report.finish()
    await browser.close()
  }
}

async function pidAlive(pid) {
  if (!pid) return false
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true })
    return out.toLowerCase().includes(String(pid))
  } catch {
    return false
  }
}

await main()
