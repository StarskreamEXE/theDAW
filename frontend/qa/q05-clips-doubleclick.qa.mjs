// QA probe/build for AREA q05-clips-doubleclick.
// Run: cd frontend && node qa/q05-clips-doubleclick.qa.mjs
import { openApp, createReport, expect, ASSETS_DIR } from './qaLib.mjs'

const { browser, page, consoleErrors } = await openApp()
try {
  // Boot cinematic: #boot-splash (an iframe overlay) blocks all clicks until
  // the backend is ready; App.tsx fades then removes it.
  await page.waitForSelector('#boot-splash', { state: 'detached', timeout: 25000 }).catch(() => {})
  await page.waitForTimeout(300)

  // First run on a fresh QA data folder auto-starts the onboarding tour.
  // Skip it so it doesn't spotlight-block the real controls.
  for (let i = 0; i < 4; i++) {
    const skipBtn = page.getByRole('button', { name: /skip tour|end tour|skip|close tour/i })
    if (await skipBtn.count()) {
      await skipBtn.first().click().catch(() => {})
      await page.waitForTimeout(200)
    } else break
  }
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(200)
  await page.screenshot({ path: 'E:/thedaw-build/qa/shots/q05-clips-doubleclick/00b-after-dismiss.png' })
  await page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 10000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'E:/thedaw-build/qa/shots/q05-clips-doubleclick/00-edit-tab.png' })

  const info = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).map((b) => ({
      text: (b.textContent || '').trim().slice(0, 40),
      aria: b.getAttribute('aria-label'),
    })).filter((b) => b.text || b.aria)
    const clipDivs = document.querySelectorAll('[data-clip="1"]').length
    return { btns: btns.slice(0, 200), clipDivs }
  })
  console.log(JSON.stringify(info, null, 1))
} finally {
  await browser.close()
}
