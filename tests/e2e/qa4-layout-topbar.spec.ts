// tests/e2e/qa4-layout-topbar.spec.ts (QA round 4, Pass 4 item #4 "the Claude badge is cut to stubs at 1280-1600 px").
//
// The badge is the main status message of the handoff: its full text stays readable at the desktop widths, and the file
// name (kept at a readable minimum) and the toolbar give way first. Each test is the failing repro first.
import { TESTID } from '../../shared/constants'
import type { Page } from '@playwright/test'
import { installClipboard } from './fixtures/p3'
import { openDoc } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [] })

const FILE = 'qa4-topbar.md'
const DOC = '# Top bar\n\nA paragraph to type in, with a member rate of 12% in it.\n\nAnother paragraph after it.\n'
const sel = (key: keyof typeof TESTID): string => `[data-testid="${TESTID[key]}"]`

/** Badge text fit and the file name's width at the current viewport. */
async function badgeMetrics(page: Page) {
  return page.evaluate(() => {
    const text = document.querySelector<HTMLElement>('[data-testid="mdr-claude-badge"] .mdr-claude-badge-text')!
    const name = document.querySelector<HTMLElement>('[data-testid="mdr-doc-name"]')!
    const bar = document.querySelector<HTMLElement>('[data-testid="mdr-topbar"]')!
    return {
      vw: window.innerWidth,
      badgeFull: text.scrollWidth <= text.clientWidth + 1,
      badgeText: text.textContent ?? '',
      badgeWidth: Math.round(text.clientWidth),
      nameFull: name.scrollWidth <= name.clientWidth + 1,
      barHeight: Math.round(bar.getBoundingClientRect().height),
    }
  })
}

for (const w of [1280, 1440, 1600]) {
  test(`${w}px: the waiting-to-paste badge reads in full and the file name reads in full`, async ({ page, server, tmpRoot }) => {
    await installClipboard(page)
    await page.setViewportSize({ width: w, height: 800 })
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
    await page.locator('#mdr-editor-host .ProseMirror').click()
    await page.keyboard.type('x')
    await page.locator(sel('send')).click()
    await expect(page.locator(sel('claudeBadge'))).toContainText('Waiting for you to paste it into Claude')
    const m = await badgeMetrics(page)
    expect(m.badgeFull, `badge text cut: ${m.badgeText} in ${m.badgeWidth}px`).toBe(true)
    // the name moved to the file strip (onboarding), where a short name reads in full
    expect(m.nameFull, 'file name cut').toBe(true)
  })
}
