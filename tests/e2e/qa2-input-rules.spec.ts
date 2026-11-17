// tests/e2e/qa2-input-rules.spec.ts (TJ's hands-on findings 1 and 2, 2026-10-16). Markdown input rules and Enter, typed
// with the real keyboard, in both modes; in Suggesting mode they are tracked, and one burst of typing is one suggestion.
import { captureNotices, notices, openDoc, placeCaret, summaries } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [] })

const DOC = 'Title line.\n\nPlain line.\n'
const FILE = 'rules.md'

for (const mode of ['editing', 'suggesting'] as const) {
  test.describe(`${mode} mode`, () => {
    for (const [typed, selector, text, md] of [
      ['# Big title', 'h1', 'Big title', '# Big title'],
      ['## Smaller', 'h2', 'Smaller', '## Smaller'],
      ['### Smallest', 'h3', 'Smallest', '### Smallest'],
      ['- one', 'ul li', 'one', '- one'],
      ['1. first', 'ol li', 'first', '1. first'],
      ['> quoted', 'blockquote', 'quoted', '> quoted'],
    ] as const) {
      test(`"${typed}" on a new line becomes ${selector}`, async ({ page, server, tmpRoot }) => {
        const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
        await captureNotices(ed)
        if (mode === 'suggesting') await ed.testid('modePill').click()
        await placeCaret(page, 'Plain line.')
        await page.keyboard.press('Enter')
        await page.keyboard.type(typed)
        await expect(page.locator(`#mdr-editor-host .ProseMirror ${selector}`).filter({ hasText: text })).toHaveCount(1)
        expect(await notices(page)).not.toContain('SUGGEST_MODE_BLOCKED')
        await ed.session((x) => x.flush())
        if (mode === 'suggesting') {
          // tracked: the file is untouched until TJ accepts; accepting writes the block
          await page.waitForTimeout(2600)
          await ed.session((x) => x.flush())
          expect(tmpRoot.read(FILE)).toBe(DOC)
          expect((await summaries(ed)).filter((x) => x.by === 'TJ')).toHaveLength(1)
          await ed.bridge((b) => b.acceptAll({ by: 'TJ' }))
          await ed.session((x) => x.flush())
        }
        await expect.poll(() => tmpRoot.read(FILE)).toContain(`\n\n${md}\n`)
      })
    }
  })
}

test('one burst of typing with Enter in Suggesting mode is one suggestion, not one per line (finding 2)', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
  await ed.testid('modePill').click()
  await placeCaret(page, 'Plain line.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('And a second paragraph.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Third.')
  await ed.session((s) => s.flush())
  await page.waitForTimeout(2600) // SUGGESTION_UPSERT_STABLE_MS
  await ed.session((s) => s.flush())
  const mine = (await summaries(ed)).filter((s) => s.by === 'TJ')
  expect(mine.map((x) => [x.kind, x.deletedText, x.insertedText]), 'TJ suggestions').toHaveLength(1)
  const threads = await ed.session((s) => s.getReview().threads.filter((t) => t.kind === 'suggestion' && t.createdBy === 'TJ').length)
  expect(threads).toBe(1)
})

test('typing resumed after a pause (the first Enter already saved) continues the same suggestion (finding 2)', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
  await ed.testid('modePill').click()
  await placeCaret(page, 'Plain line.')
  await page.keyboard.press('Enter')
  await ed.session((s) => s.flush())
  await page.waitForTimeout(2600)
  await ed.session((s) => s.flush())
  expect((await summaries(ed)).filter((x) => x.by === 'TJ')).toHaveLength(1) // the lone Enter is saved as a suggestion
  await page.keyboard.type('Heading text')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Body text.')
  await page.waitForTimeout(2600)
  await ed.session((s) => s.flush())
  await page.waitForTimeout(300)
  const mine = (await summaries(ed)).filter((x) => x.by === 'TJ')
  expect(mine.map((x) => [x.kind, x.insertedText]), 'TJ suggestions').toHaveLength(1)
})
