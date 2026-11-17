// tests/e2e/t2-editor-ux-tab.spec.ts (T2 editor-ux, Pass 4 #31): Tab and Shift+Tab in a paragraph, heading or quote keep the
// caret in the document; Esc, then Tab leaves it.
import type { Page } from '@playwright/test'
import { browserChoice } from '../helpers/browser'
import { openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const inEditor = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('[data-testid="mdr-editor"]'))

for (const [name, content, at] of [
  ['a paragraph', 'Plain words here.\n', 'here.'],
  ['a heading', '# A heading\n', 'heading'],
  ['a quote', '> Quoted words\n', 'words'],
] as const) {
  test(`#31: Tab and Shift+Tab in ${name} keep the caret in the document`, async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content })
    await placeCaret(page, at, 'end')
    await page.keyboard.press('Tab')
    expect(await inEditor(page)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await inEditor(page)).toBe(true)
    await page.keyboard.type('Z')
    const saved = await savedText(ed, tmpRoot, 'k.md')
    expect(saved).toBe(content.replace(/\n$/, '') + 'Z\n')
  })
}

test('#31: Esc, then Tab leaves the document, so it is not a keyboard trap', async ({ page, server, tmpRoot }) => {
  await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: 'Plain words here.\n' })
  await placeCaret(page, 'here.', 'end')
  await page.keyboard.press('Tab')
  expect(await inEditor(page)).toBe(true)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  expect(await inEditor(page)).toBe(false)
  // back in with Shift+Tab, Tab is the editor's again
  await page.keyboard.press('Shift+Tab')
  expect(await inEditor(page)).toBe(true)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Tab')
  expect(await inEditor(page)).toBe(true)
})

test('#31: Esc, then Shift+Tab leaves the document: the bare Shift keydown does not end the way out', async ({ page, server, tmpRoot }) => {
  await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: 'Plain words here.\n' })
  await placeCaret(page, 'here.', 'end')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+Tab')
  expect(await inEditor(page)).toBe(false)
})

test('#31: a real keystroke after Esc still ends the way out, so Tab is the editor\'s again', async ({ page, server, tmpRoot }) => {
  await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: 'Plain words here.\n' })
  await placeCaret(page, 'here.', 'end')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+Tab')
  expect(await inEditor(page)).toBe(true)
})
