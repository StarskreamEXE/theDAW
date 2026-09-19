// Shared helpers for the end-to-end QA scripts in this folder.
//
// These scripts drive a RUNNING app in a headless browser; they are not part of
// `npm test` (that runner only picks up *.test.ts(x) under src/). Run one with:
//
//   cd frontend && node qa/<area>.qa.mjs
//
// The app under test defaults to http://127.0.0.1:5183 (override with QA_URL).
// The installed Google Chrome is used (channel 'chrome') so no browser download
// is needed; every run gets a throwaway profile.

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

export const QA_URL = process.env.QA_URL || 'http://127.0.0.1:5183'
export const SHOTS_DIR = process.env.QA_SHOTS || 'E:/thedaw-build/qa/shots'
export const ASSETS_DIR = process.env.QA_ASSETS || 'E:/thedaw-build/qa/assets'

// Console noise that says nothing about the feature under test.
const IGNORED_CONSOLE = [
  /questmidi\/ws/, // optional hardware bridge, not running in QA
  /Download the React DevTools/,
]

export async function openApp({ width = 1600, height = 900, launchArgs = [] } = {}) {
  // Audio has to start without a click inside a headless run, or the transport
  // and every AudioWorklet (metering, the live VST bridge) would stay suspended.
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required', ...launchArgs],
  })
  const context = await browser.newContext({ viewport: { width, height } })
  // A plugin editor is a NATIVE window on the desktop of whoever is sitting at this machine.
  // Every QA run switches them off inside the app before the first script runs, so adding or
  // opening a plugin in a test can never put a window on the screen.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('thedaw.vst.noEditorWindows', '1')
    } catch {
      /* storage unavailable: the app then behaves normally, so tests must not open editors */
    }
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return
    consoleErrors.push(text.slice(0, 400))
  })
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e).slice(0, 400)))
  await page.goto(QA_URL, { waitUntil: 'networkidle', timeout: 60000 })
  return { browser, context, page, consoleErrors }
}

/** Collects scenario results; `finish()` prints a summary and sets the exit code. */
export function createReport(area) {
  const rows = []
  mkdirSync(`${SHOTS_DIR}/${area}`, { recursive: true })
  return {
    shotPath: (name) => `${SHOTS_DIR}/${area}/${name}.png`,
    async scenario(name, fn) {
      try {
        await fn()
        rows.push({ name, result: 'PASS' })
        console.log(`PASS  ${name}`)
      } catch (err) {
        const msg = String(err && err.message ? err.message : err).split('\n')[0].slice(0, 300)
        rows.push({ name, result: 'FAIL', msg })
        console.log(`FAIL  ${name} :: ${msg}`)
      }
    },
    finish() {
      const failed = rows.filter((r) => r.result === 'FAIL').length
      console.log(`\n${area}: ${rows.length - failed}/${rows.length} scenarios passed`)
      process.exitCode = failed ? 1 : 0
      return rows
    },
  }
}

export function expect(cond, message) {
  if (!cond) throw new Error(message)
}

export function expectClose(actual, wanted, tolerance, message) {
  if (!(Math.abs(actual - wanted) <= tolerance)) {
    throw new Error(`${message} (got ${actual}, wanted ${wanted} ± ${tolerance})`)
  }
}
