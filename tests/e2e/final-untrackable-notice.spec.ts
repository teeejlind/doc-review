// tests/e2e/final-untrackable-notice.spec.ts (final pass 2026-11-16, QA bug 3). Shift+Tab on a middle nested list item
// in Suggesting mode is refused (the outdent can't be tracked); the notice blamed "a pending suggestion there" when
// there was none. It now says the change can't be tracked; the old wording stays for a real pending suggestion.
import { browserChoice } from '../helpers/browser'
import { captureNotices, notices, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })
test.skip(!BROWSER.available, BROWSER.reason)

const DOC = '- aa\n  - bb\n  - cc\n- dd\n'

test('final: a refused Suggesting-mode outdent with no pending suggestion says it cannot be tracked', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'l.md', content: DOC })
  await captureNotices(ed)
  await ed.testid('modePill').click()
  await placeCaret(page, 'bb')
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => notices(page)).toContain('SUGGEST_MODE_BLOCKED')
  await expect(page.getByText("That change can't be tracked as a suggestion. Switch to Editing to make it.")).toBeVisible()
  await expect(page.getByText(/pending suggestion there/)).toHaveCount(0)
  expect(await savedText(ed, tmpRoot, 'l.md')).toBe(DOC)
})
