// tests/e2e/t2-polish-copy.spec.ts (T2 polish, Pass 4 #37). Plain-English messages a colleague reads: the underline
// notice in the editor, shown as a toast on the real page. The offline toast and its "Copy message" action are in
// p3-handoff-ui.spec.ts, where the server can be stopped.
import { TESTID } from '../../shared/constants'
import { browserChoice } from '../helpers/browser'
import { MOD, openDoc, placeCaret } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

test.describe('t2-polish: plain-English copy', () => {
  test('#37: Cmd+U says the document cannot underline, without the word "markdown"', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'u.md', content: 'Underline this word here.\n' })
    await placeCaret(page, 'word', 'end')
    await page.keyboard.press(`${MOD}+KeyU`)
    const toast = page.locator(`[data-testid="${TESTID.toast}"][data-code="UNDERLINE_UNSUPPORTED"]`)
    await expect(toast).toContainText('Underline isn’t available in this document.')
    await expect(toast).not.toContainText(/markdown/i)
  })
})
