// tests/e2e/final-table-suggest.spec.ts (final pass 2026-11-16): the 11/13 trial bug on the real UI. Claude suggests a
// change across neighbouring cells of one table row ("| Alpha | 12.0% | 9 mo |" → new values). Accept and Reject on
// the card must leave every cell in its own column, in the open editor and in the file; and TJ's own Suggesting-mode
// edits in two neighbouring cells must do the same.
import { browserChoice } from '../helpers/browser'
import { claude, openDoc, placeCaret, savedText, summaries } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })
test.skip(!BROWSER.available, BROWSER.reason)

const DOC = 'Intro.\n\n| Deal | Member | Term |\n|:-----|-------:|:----:|\n| Alpha | 12.0% | 9 mo |\n| Beta | 10.5% | 12 mo |\n\nOutro.\n'
const rows = (page: import('@playwright/test').Page): Promise<string[][]> =>
  page.locator('#mdr-editor-host table tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => (c.textContent ?? '').replace(/¶/g, ''))))

for (const decision of ['Accept', 'Reject'] as const) {
  test(`final: Claude's suggestion across two cells of a row, ${decision} keeps every cell in its column`, async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 't.md', content: DOC })
    await claude(server, 't.md', [{ op: 'suggest', quote: '| Alpha | 12.0% | 9 mo |', replace: '| Alpha | 13.0% | 10 mo |' }])
    await expect.poll(async () => (await summaries(ed)).filter((s) => s.placed).length).toBe(1)
    // shown inline per cell: the new value sits in the cell it replaces
    const marked = await page.locator('#mdr-editor-host table tr').nth(1).locator('td').evaluateAll((tds) =>
      tds.map((td) => [...td.querySelectorAll('[data-kind="ins"]')].map((x) => x.textContent).join('')))
    expect(marked).toEqual(['', '13.0%', '10'])
    await page.getByRole('button', { name: new RegExp(`^${decision}`) }).first().click()
    const want = decision === 'Accept' ? ['Alpha', '13.0%', '10 mo'] : ['Alpha', '12.0%', '9 mo']
    await expect.poll(() => rows(page)).toEqual([['Deal', 'Member', 'Term'], want, ['Beta', '10.5%', '12 mo']])
    const file = decision === 'Accept' ? DOC.replace('| Alpha | 12.0% | 9 mo |', '| Alpha | 13.0% | 10 mo |') : DOC
    await expect.poll(() => tmpRoot.read('t.md')).toBe(file)
    await expect.poll(() => ed.debug.liveMarkdown()).toBe(file)
    // a later keystroke elsewhere saves the row unchanged (the old bug saved "| Alpha | 13.0%10 mo | |")
    await placeCaret(page, 'Outro.')
    await page.keyboard.type('!')
    expect(await savedText(ed, tmpRoot, 't.md')).toBe(file.replace('Outro.', 'Outro.!'))
  })
}

test('final: TJ suggests in two neighbouring cells; Accept keeps each value in its own cell', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'u.md', content: DOC })
  await ed.testid('modePill').click()
  await placeCaret(page, '9', 'select')
  await page.keyboard.type('10', { delay: 30 })
  await placeCaret(page, '12.0%', 'select')
  await page.keyboard.type('13.0%', { delay: 30 })
  // two cards, one per cell, each with its own value
  await expect.poll(async () => (await summaries(ed)).map((x) => `${x.deletedText}>${x.insertedText}`).sort()).toEqual(['12.0%>13.0%', '9>10'])
  const accept = page.getByRole('button', { name: /^Accept: / })
  for (const left of [1, 0]) {
    await accept.first().click()
    await expect(accept).toHaveCount(left)
  }
  await expect.poll(() => rows(page)).toEqual([['Deal', 'Member', 'Term'], ['Alpha', '13.0%', '10 mo'], ['Beta', '10.5%', '12 mo']])
  expect(await savedText(ed, tmpRoot, 'u.md')).toBe(DOC.replace('| Alpha | 12.0% | 9 mo |', '| Alpha | 13.0% | 10 mo |'))
})
