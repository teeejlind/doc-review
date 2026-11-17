// tests/e2e/qa2-c-cards.spec.ts (QA round 1, fix pass 2: confirmed 28).
//
// A card says what the suggestion does: "Bold: member", "Heading 2", "Checked: Todo one", "Link: /fees → /pricing",
// "Split paragraph", and a collapsed card previews it ("Add: (see below)") instead of showing only the author.
import { TESTID } from '../../shared/constants'
import { claude, MOD, openDoc, placeCaret } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const DOC = `# Heading to edit

A paragraph of text. We launch in Q3 with the member rate set.

Second paragraph to split here.

Third paragraph to promote.

- [ ] Todo one
- [x] Todo two

See the [fee schedule](https://example.com/fees) for details.
`

test('qa2-c: cards name the change, and collapsed cards preview it', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 's.md', content: DOC })
  await claude(server, 's.md', [{ op: 'suggest', quote: '[fee schedule](https://example.com/fees)', replace: '[fee schedule](https://example.com/pricing)' }])
  await ed.bridge((b) => b.setMode('suggesting'))
  await placeCaret(page, 'Q3', 'end')
  await page.keyboard.type(' (see below)')
  await placeCaret(page, 'member', 'select')
  await page.keyboard.press(`${MOD}+b`)
  await placeCaret(page, 'Third paragraph', 'start')
  await page.keyboard.type('## ')
  await placeCaret(page, 'Todo one', 'end')
  await ed.testid('taskCheckbox').first().click()
  await placeCaret(page, 'to split', 'start')
  await page.keyboard.press('Enter')
  await ed.session((s) => s.flush())

  const card = `[data-testid="${TESTID.card}"]`
  await expect(page.locator(card)).toHaveCount(6, { timeout: 15_000 })
  const read = (sel: string): Promise<string[]> => page.locator(card).evaluateAll((els, q) => els.map((e) => e.querySelector(q as string)?.textContent ?? ''), sel)
  // the head of every expanded or collapsed card carries the description (the DOM has all of them)
  await expect.poll(() => read('.mdr-suggestion-kind').then((a) => a.sort())).toEqual([
    'Add', 'Bold: member', 'Checked: Todo one', 'Heading 2', 'Link: /fees → /pricing', 'Split paragraph',
  ])
  // and so does each card's collapsed preview: no blank one
  const previews = await read('.mdr-card-preview')
  expect(previews.every((p) => p.trim() !== '')).toBe(true)
  expect(previews).toEqual(expect.arrayContaining(['Add: (see below)', 'Bold: member', 'Checked: Todo one', 'Heading 2', 'Split paragraph']))
})
