// tests/e2e/t2-suggest-retype.spec.ts (T2 suggest track): Pass 4 #34 on the real keyboard. Delete a word and type it
// back in Suggesting mode: no struck word, no inserted copy, no card, nothing in the review.
import { TESTID } from '../../shared/constants'
import { openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const MD = '# Title\n\nIntro paragraph with some words in it.\n\nTail.\n'
const marks = '#mdr-editor-host .ProseMirror [data-testid="mdr-suggestion"]'

test('#34: Backspace over "some", then typing "some": it cancels out, nothing is suggested', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'r.md', content: MD })
  await ed.testid('modePill').click()
  await placeCaret(page, 'some', 'select')
  await page.keyboard.press('Backspace')
  await expect(page.locator(marks)).toHaveCount(1) // the strike alone, for now
  await page.keyboard.type('some', { delay: 30 })
  await expect(page.locator(marks)).toHaveCount(0)
  await page.waitForTimeout(3_000)
  await expect(page.locator(`[data-testid="${TESTID.card}"]`)).toHaveCount(0)
  expect(await ed.session((s) => s.getReview().suggestions.length)).toBe(0)
  expect(await page.locator('#mdr-editor-host .ProseMirror').innerText()).toContain('Intro paragraph with some words in it.')
  expect(await savedText(ed, tmpRoot, 'r.md')).toBe(MD)
})

test('#34: typing "some" over the selected "some" cancels too', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'o.md', content: MD })
  await ed.testid('modePill').click()
  await placeCaret(page, 'some', 'select')
  await page.keyboard.type('some', { delay: 30 })
  await expect(page.locator(marks)).toHaveCount(0)
  await page.waitForTimeout(2_000)
  expect(await ed.session((s) => s.getReview().suggestions.length)).toBe(0)
})

test('#34: a different word is still one suggestion with a card', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'd.md', content: MD })
  await ed.testid('modePill').click()
  await placeCaret(page, 'some', 'select')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('few', { delay: 30 })
  await expect(page.locator(`[data-testid="${TESTID.card}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator(marks)).toHaveCount(2)
})
