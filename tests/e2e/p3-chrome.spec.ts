// tests/e2e/p3-chrome.spec.ts (P3; CONTRACTS §12.2.4 quiet chrome, §12.15 topbar data-quiet, §14 P3 E2E "p3-chrome").
//
// Quiet chrome in a real browser: after QUIET_CHROME_AFTER_MS of continuous typing, --mdr-chrome-opacity on #mdr-app
// drops to QUIET_CHROME_OPACITY (the top bar's data-quiet turns true and P3's top-bar items fade), and a real pointer
// move brings it back. With the real P2 the typing is real keystrokes in the editor; on the fake P2 modules the fake
// bridge reports the typing activity P2's onTypingActivity would.
import type { Page } from '@playwright/test'
import { CONSTANTS } from '../../shared/constants'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { P3_SERVER_KIND, sel } from './fixtures/p3'

const FILE = 'chrome.md'
test.use({ serverKind: P3_SERVER_KIND, fixtureFiles: [], docFile: FILE })

const opacity = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.getElementById('mdr-app')!).getPropertyValue('--mdr-chrome-opacity').trim())

async function typeContinuously(page: Page, ms: number): Promise<void> {
  if (P3_SERVER_KIND === 'fake') {
    await page.evaluate(() => (window as unknown as { __mdrFake: { bridge: { emitTyping(b: boolean): void } } }).__mdrFake.bridge.emitTyping(true))
    await page.waitForTimeout(ms)
    return
  }
  await page.locator(sel('editor')).click()
  const end = Date.now() + ms
  while (Date.now() < end) await page.keyboard.type('quiet ', { delay: 40 })
}

test('quiet chrome fades after continuous typing and returns on a pointer move', async ({ page, server, tmpRoot }) => {
  tmpRoot.write(FILE, '# Quiet chrome\n\nType here for a while and the chrome fades.\n')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.mouse.move(700, 450)
  await openEditor(page, { port: server.port, file: FILE })
  await expect(page.locator(sel('topbar'))).toHaveAttribute('data-quiet', 'false')
  expect(await opacity(page)).toBe('1')
  await typeContinuously(page, CONSTANTS.QUIET_CHROME_AFTER_MS + 400)
  await expect(page.locator(sel('topbar'))).toHaveAttribute('data-quiet', 'true')
  expect(await opacity(page)).toBe(String(CONSTANTS.QUIET_CHROME_OPACITY))
  // P3's own top-bar items read the token (the bar itself never fades; each item reads it, so a warning chip can opt out)
  await expect.poll(() => page.locator(sel('send')).evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.5)
  expect(await page.locator('.mdr-topbar-actions').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  expect(await page.locator(sel('topbar')).evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  await page.mouse.move(720, 470, { steps: 4 })
  await expect(page.locator(sel('topbar'))).toHaveAttribute('data-quiet', 'false')
  expect(await opacity(page)).toBe('1')
})
