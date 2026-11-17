// tests/e2e/final-narrow-toolbar.spec.ts (final pass 2026-11-16, QA bug 1). In a narrow window (a Claude pane beside the
// chat, a phone) the toolbar ran past the window edge and the Editing / Suggesting pill, its last item, was cut off.
// Below the desktop layout the toolbar wraps: every control stays inside the window and the pill switches modes.
import { browserChoice } from '../helpers/browser'
import { openDoc } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

for (const width of [390, 480, 560, 700, 1000]) {
  test(`final: at ${width} px every toolbar control is inside the window and the mode pill works`, async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width, height: 800 })
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'n.md', content: '# Hi\n\nPara.\n' })
    const outside = await page.evaluate((w) => [...document.querySelectorAll<HTMLElement>('#mdr-toolbar-host button, #mdr-toolbar-host [role="button"]')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ name: b.getAttribute('aria-label') ?? b.textContent, r: b.getBoundingClientRect() }))
      .filter((x) => x.r.left < 0 || x.r.right > w + 0.5)
      .map((x) => x.name), width)
    expect(outside).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const pill = ed.testid('modePill')
    await expect(pill).toBeInViewport({ ratio: 1 })
    await pill.click()
    await expect(pill).toHaveAttribute('data-mode', 'suggesting')
  })
}
