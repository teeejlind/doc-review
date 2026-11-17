// tests/e2e/p2-modes.spec.ts (P2; CONTRACTS §14 P2 e2e "p2-modes", §6.4, §6.5, §12.2.4, §12.15). Real keyboard input in
// Chromium on the day-0 harness page: the mode pill and the mode shortcut; Editing-mode typing saves to disk;
// Suggesting-mode typing makes tracked marks (insert, delete, replace, split, list-item add, merge) and leaves the .md alone while the
// record is upserted; a D14 block raises SUGGEST_MODE_BLOCKED through bridge().onNotice (the toast is P3's).
import { TESTID } from '../../shared/constants'
import { browserChoice } from '../helpers/browser'
import { captureNotices, LINE_END, notices, placeCaret } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: ['basic.md', 'syn__code-blocks.md'] })
test.skip(!BROWSER.available, BROWSER.reason)

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Select `word` inside the first editor text node containing `context`, through the DOM (PM picks it up). */
async function selectText(page: import('@playwright/test').Page, context: string, word: string): Promise<void> {
  const ok = await page.evaluate(([c, w]) => {
    const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? ''
      const i = t.indexOf(w ?? '')
      if (t.includes(c ?? '') && i >= 0) {
        root.focus()
        window.getSelection()!.setBaseAndExtent(n, i, n, i + (w ?? '').length)
        return true
      }
    }
    return false
  }, [context, word])
  expect(ok).toBe(true)
  await page.waitForTimeout(50)
}

test('p2-modes: pill and shortcut toggle modes; Editing typing saves; Suggesting typing is tracked and never reaches the .md', async ({ page, editorPage, tmpRoot }) => {
  const original = tmpRoot.read('basic.md')
  const pill = editorPage.testid('modePill')
  await expect(pill).toHaveAttribute('data-mode', 'editing')
  await expect(editorPage.editor()).toHaveAttribute('data-mode', 'editing')

  // Editing: a real keystroke edit saves to disk
  await page.getByText('We launch in Q3.').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' Soon.')
  await expect.poll(() => tmpRoot.read('basic.md'), { timeout: 10_000 }).toContain('We launch in Q3. Soon.')

  // the pill toggles; the shortcut toggles back and forth
  await pill.click()
  await expect(pill).toHaveAttribute('data-mode', 'suggesting')
  await editorPage.editor().focus()
  await page.keyboard.press(`${MOD}+Alt+Shift+KeyE`)
  await expect(pill).toHaveAttribute('data-mode', 'editing')
  await page.keyboard.press(`${MOD}+Alt+Shift+KeyX`)
  await expect(pill).toHaveAttribute('data-mode', 'suggesting')
  await expect(editorPage.editor()).toHaveAttribute('data-mode', 'suggesting')

  // Suggesting: insert, delete, replace, split, list-item add and merge are tracked
  const afterEdit = tmpRoot.read('basic.md')
  await captureNotices(editorPage)
  await page.getByText('Grow the waitlist').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' fast')
  await expect(editorPage.testid('suggestion', { 'data-kind': 'ins' }).first()).toBeVisible()
  await page.getByText('The member rate is reviewed every quarter.').click()
  await page.keyboard.press(LINE_END)
  for (let i = 0; i < 'quarter.'.length; i++) await page.keyboard.press('Backspace')
  await expect(editorPage.testid('suggestion', { 'data-kind': 'del' }).first()).toBeVisible()
  // replace a selected word: struck, the new text inserted after it, one suggestion
  await selectText(page, 'A short quote', 'short')
  await page.keyboard.type('brief')
  await expect(page.locator('#mdr-editor-host blockquote')).toContainText('shortbrief')
  // split a paragraph with Enter
  await selectText(page, 'Final paragraph', 'paragraph')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  // add a list item: Enter at the end of an item, then type (S2-b: the new item carries the marks)
  await placeCaret(page, 'Ship the explainer page', 'end')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Hire a writer')
  await expect(editorPage.testid('suggestion', { 'data-kind': 'ins' }).filter({ hasText: 'Hire a writer' }).first()).toBeVisible()
  // merge: Backspace at the start of the paragraph under the heading joins it into the one above
  await placeCaret(page, 'The notes carry', 'start')
  await page.keyboard.press('Backspace')
  expect(await notices(page)).not.toContain('SUGGEST_MODE_BLOCKED')
  const summaries = await editorPage.bridge((b) => [...b.getSuggestionSummaries().values()].map((s) => ({ by: s.by, kind: s.kind })))
  expect(summaries.length).toBeGreaterThanOrEqual(5)
  expect(summaries.every((s) => s.by === 'TJ')).toBe(true)
  await editorPage.session((s) => s.flush())
  expect(tmpRoot.read('basic.md')).toBe(afterEdit)
  await expect.poll(() => editorPage.session((s) => s.getReview().suggestions.filter((x) => x.by === 'TJ').length)).toBeGreaterThanOrEqual(3)
  expect(original).not.toBe(afterEdit)
  await expect(editorPage.testid('toolbar')).toBeVisible()
  await expect(page.locator(`[data-testid="${TESTID.toolbarButton}"][data-action="bold"]`)).toBeVisible()
})

test.describe('D14', () => {
  test.use({ docFile: 'syn__code-blocks.md' })
  test('p2-modes: a code-block edit in Suggesting mode raises SUGGEST_MODE_BLOCKED and changes nothing', async ({ page, editorPage }) => {
    await editorPage.bridge((b) => {
      const w = window as unknown as { __notices: string[] }
      w.__notices = []
      b.onNotice((n) => w.__notices.push(n.code))
      b.setMode('suggesting')
    })
    const before = await editorPage.debug.liveMarkdown()
    await page.locator('#mdr-editor-host pre').first().click()
    await page.keyboard.type('xyz')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __notices: string[] }).__notices)).toContain('SUGGEST_MODE_BLOCKED')
    expect(await editorPage.debug.liveMarkdown()).toBe(before)
  })
})
