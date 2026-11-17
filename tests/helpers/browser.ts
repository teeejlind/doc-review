// tests/helpers/browser.ts (integrator, day 0; CONTRACTS §1 playwright.config.ts, §1.3 e2e/smoke).
//
// Which Chromium the e2e suite drives. Playwright's own Chromium build is the default and the reference (the perf
// trace budgets in §11.7 are calibrated on it). When it is not installed, the suite falls back to the installed
// Google Chrome through Playwright's `chrome` channel, so the browser half of the specs still runs on a machine where
// `npx playwright install chromium` hasn't been run. `MDR_PW_CHANNEL=chromium` forces the bundled build (specs that
// need a browser then skip if it is missing); `MDR_PW_CHANNEL=chrome` forces the installed Chrome.
import { existsSync } from 'node:fs'
import { chromium } from '@playwright/test'

const SYSTEM_CHROME: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  win32: [
    `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
}

const bundledChromium = (): boolean => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}
const systemChrome = (): boolean => (SYSTEM_CHROME[process.platform] ?? []).some((p) => p !== '' && existsSync(p))

export interface BrowserChoice {
  /** Playwright `channel` for the chromium project; undefined = the bundled Chromium build. */
  channel: 'chrome' | undefined
  /** False when no usable browser exists, so browser specs skip with `reason` instead of failing to launch. */
  available: boolean
  reason: string
}

export function browserChoice(): BrowserChoice {
  const forced = process.env['MDR_PW_CHANNEL']
  if (forced === 'chrome') return { channel: 'chrome', available: systemChrome(), reason: 'MDR_PW_CHANNEL=chrome but Google Chrome is not installed' }
  if (forced === 'chromium' || bundledChromium())
    return { channel: undefined, available: bundledChromium(), reason: 'Playwright Chromium is not installed (npx playwright install chromium)' }
  if (systemChrome()) return { channel: 'chrome', available: true, reason: '' }
  return { channel: undefined, available: false, reason: 'no browser: Playwright Chromium is not installed (npx playwright install chromium) and Google Chrome was not found' }
}
