// tests/e2e/p2-tables.spec.ts (P2; CONTRACTS §12.13 Tables, D14, D51, §12.15). Real keyboard and clicks in Chromium on
// the day-0 harness page: Tab / Shift+Tab traversal; Tab in the last cell adds a row; every tableAction in Editing
// mode with the on-disk diff confined to that table's lines; a cell text edit changes only its row's line and keeps
// the delimiter row; in Suggesting mode every action is disabled and raises the notice while a cell text edit is a
// tracked suggestion.
import { TESTID, TEST_ACTIONS } from '../../shared/constants'
import { browserChoice } from '../helpers/browser'
import { captureNotices, changedLines, notices, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const FILE = 'table.md'
const DOC = 'Intro.\n\n| Deal | Member | Term |\n|:-----|-------:|:----:|\n| Alpha | 12.0% | 9 mo |\n| Beta | 10.5% | 12 mo |\n\nOutro.\n'

const selectedText = (page: import('@playwright/test').Page): Promise<string> => page.evaluate(() => window.getSelection()?.toString() ?? '')

test('p2-tables: Tab / Shift+Tab traverse cells; Tab in the last cell adds a body row', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
  await placeCaret(page, 'Deal')
  await page.keyboard.press('Tab')
  expect(await selectedText(page)).toBe('Member')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  expect(await selectedText(page)).toBe('Alpha')
  await page.keyboard.press('Shift+Tab')
  expect(await selectedText(page)).toBe('Term')
  await placeCaret(page, '12 mo')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Gamma')
  const out = await savedText(ed, tmpRoot, FILE)
  expect(out.startsWith('Intro.\n\n')).toBe(true)
  expect(out.endsWith('\n\nOutro.\n')).toBe(true)
  expect(out).toContain('| Gamma | | |')
  expect(out.split('\n').filter((l) => l.startsWith('|')).length).toBe(5)
})

test('p2-tables: every tableAction in Editing mode changes only that table on disk', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
  const bar = ed.testid('tableControls')
  const action = (a: string): import('@playwright/test').Locator => ed.testid('tableAction', { 'data-action': a })
  const tableLines = (t: string): string[] => t.split('\n').filter((l) => l.startsWith('|'))
  // the delimiter row's cells; after the column steps below, Alpha sits in column 1
  const delim = (t: string): string[] => tableLines(t)[1]!.split('|').slice(1, -1).map((c) => c.trim())
  await placeCaret(page, 'Alpha')
  await expect(bar).toBeVisible()
  const expectations: Array<[string, (t: string) => void]> = [
    ['row-above', (t) => expect(tableLines(t).length).toBe(5)],
    ['row-below', (t) => expect(tableLines(t).length).toBe(6)],
    ['row-delete', (t) => expect(tableLines(t).length).toBe(5)],
    ['col-left', (t) => expect(tableLines(t)[0]!.split('|').length - 2).toBe(4)],
    ['col-right', (t) => expect(tableLines(t)[0]!.split('|').length - 2).toBe(5)],
    ['col-delete', (t) => expect(tableLines(t)[0]!.split('|').length - 2).toBe(4)],
    ['align-center', (t) => expect(delim(t)).toEqual(['-', ':-:', '-:', ':-:'])],
    ['align-right', (t) => expect(delim(t)).toEqual(['-', '-:', '-:', ':-:'])],
    ['align-left', (t) => expect(delim(t)).toEqual(['-', ':-', '-:', ':-:'])],
    ['align-none', (t) => expect(delim(t)).toEqual(['-', '-', '-:', ':-:'])],
    ['table-delete', (t) => expect(tableLines(t).length).toBe(0)],
  ]
  expect(expectations.map((e) => e[0]).sort()).toEqual([...TEST_ACTIONS.tableAction].sort())
  for (const [a, check] of expectations) {
    if (a.startsWith('align-') || a === 'table-delete') await placeCaret(page, 'Alpha')
    await expect(action(a)).not.toHaveAttribute('aria-disabled', 'true')
    await action(a).click()
    const out = await savedText(ed, tmpRoot, FILE)
    expect(out.startsWith('Intro.\n\n'), a).toBe(true)
    expect(out.endsWith('Outro.\n'), a).toBe(true)
    check(out)
  }
  expect(await savedText(ed, tmpRoot, FILE)).toBe('Intro.\n\nOutro.\n')
})

test('p2-tables: a cell text edit changes only that row and keeps the delimiter row', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
  await placeCaret(page, 'Beta')
  await page.keyboard.type('x')
  const out = await savedText(ed, tmpRoot, FILE)
  expect(changedLines(DOC, out)).toEqual([5])
  expect(out.split('\n')[3]).toBe('|:-----|-------:|:----:|')
})

test('p2-tables: in Suggesting mode every action is disabled and raises the notice; a cell edit is tracked', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
  await captureNotices(ed)
  await ed.testid('modePill').click()
  await expect(ed.testid('modePill')).toHaveAttribute('data-mode', 'suggesting')
  await placeCaret(page, 'Alpha')
  for (const a of TEST_ACTIONS.tableAction) {
    const b = ed.testid('tableAction', { 'data-action': a })
    await expect(b).toHaveAttribute('aria-disabled', 'true')
    await b.click({ force: true })
  }
  expect((await notices(page)).filter((c) => c === 'SUGGEST_MODE_BLOCKED').length).toBe(TEST_ACTIONS.tableAction.length)
  await placeCaret(page, 'Beta')
  await page.keyboard.type('z')
  await expect(page.locator(`[data-testid="${TESTID.suggestion}"][data-kind="ins"]`).first()).toBeVisible()
  const kinds = await ed.bridge((b) => [...b.getSuggestionSummaries().values()].map((s) => s.kind))
  expect(kinds).toContain('insert')
  expect(await savedText(ed, tmpRoot, FILE)).toBe(DOC)
})
