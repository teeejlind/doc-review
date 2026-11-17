// tests/e2e/t2-suggest-ime.spec.ts (T2 suggest track): Pass 4 #30. An accent dead key or an IME over a selected word in
// Suggesting mode replaces the word with what was composed, as Editing mode does, and leaves no composing character
// behind. Driven with CDP's Input.imeSetComposition + insertText, which fire the same composition events.
import type { Page } from '@playwright/test'
import { openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'
import type { EditorPage } from '../helpers/openEditor'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const MD = '# Title\n\nIntro paragraph with some words in it.\n\nTail.\n'

async function compose(page: Page, steps: string[], commit: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  for (const text of steps) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await page.waitForTimeout(50)
  }
  await cdp.send('Input.insertText', { text: commit })
  await page.waitForTimeout(250)
}

const insertedText = (page: Page): Promise<string[]> =>
  page.locator('#mdr-editor-host .ProseMirror [data-kind="ins"]').evaluateAll((els) => els.map((e) => e.textContent ?? ''))
const struckText = (page: Page): Promise<string[]> =>
  page.locator('#mdr-editor-host .ProseMirror [data-kind="del"]').evaluateAll((els) => els.map((e) => e.textContent ?? ''))

async function pending(ed: EditorPage): Promise<Array<{ base: string; proposed: string }>> {
  return ed.session((s) => s.getReview().suggestions.filter((x) => x.status === 'pending').map((x) => ({ base: x.base, proposed: x.proposed })))
}

test('#30: accent dead key over "some": the suggestion replaces it with the accented letter, nothing else', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'd.md', content: MD })
  await ed.testid('modePill').click()
  await placeCaret(page, 'some', 'select')
  await compose(page, ['´'], 'á')
  expect(await struckText(page)).toEqual(['some'])
  expect(await insertedText(page)).toEqual(['á'])
  await expect.poll(() => pending(ed)).toEqual([{ base: 'Intro paragraph with some words in it.', proposed: 'Intro paragraph with á words in it.' }])
  // the caret is after the composed letter: the next typing continues it
  await page.keyboard.type('x')
  expect(await insertedText(page)).toEqual(['áx'])
  // Accept writes what Editing writes
  const id = await ed.session((s) => s.getReview().suggestions.find((x) => x.status === 'pending')!.id)
  await page.waitForTimeout(1_500)
  expect(await ed.bridge((b, sid) => b.accept(sid), id)).toMatchObject({ ok: true })
  expect(await savedText(ed, tmpRoot, 'd.md')).toBe(MD.replace('some', 'áx'))
})

test('#30: pinyin over "some": the suggestion holds the typed characters only', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'p.md', content: MD })
  await ed.testid('modePill').click()
  await placeCaret(page, 'some', 'select')
  await compose(page, ['n', 'ni'], '你好')
  expect(await struckText(page)).toEqual(['some'])
  expect(await insertedText(page)).toEqual(['你好'])
  await expect.poll(() => pending(ed)).toEqual([{ base: 'Intro paragraph with some words in it.', proposed: 'Intro paragraph with 你好 words in it.' }])
})

test('#30: composing without a selection, and in Editing mode, are as before', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'e.md', content: MD })
  await placeCaret(page, 'some', 'select')
  await compose(page, ['´'], 'á')
  expect(await page.locator('#mdr-editor-host .ProseMirror').innerText()).toContain('Intro paragraph with á words in it.')
  await ed.testid('modePill').click()
  await placeCaret(page, 'words', 'end')
  await compose(page, ['´'], 'é')
  expect(await insertedText(page)).toEqual(['é'])
  expect(await struckText(page)).toEqual([])
})

test('#30: a cancelled composition over a selection strikes nothing', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'c.md', content: MD })
  await ed.testid('modePill').click()
  await placeCaret(page, 'some', 'select')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(80)
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await cdp.send('Input.insertText', { text: '' }).catch(() => undefined)
  await page.waitForTimeout(400)
  expect(await struckText(page)).toEqual([])
  expect(await page.locator('#mdr-editor-host .ProseMirror').innerText()).toContain('Intro paragraph with some words in it.')
})

test('#30: a cancelled composition next to the author\'s own pending insertion strikes nothing', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'n.md', content: MD })
  await ed.testid('modePill').click()
  // an insertion of ours right after "some"
  await placeCaret(page, 'some', 'end')
  await page.keyboard.type('ZZ')
  expect(await insertedText(page)).toEqual(['ZZ'])
  const cdp = await page.context().newCDPSession(page)
  // cancelling more than once: the browser unwraps the insertion's decoration span, which nothing redraws unless the
  // cancel does (the typed-over text and the insertion kept their model, but the insertion stopped looking like one)
  for (let i = 0; i < 3; i++) {
    await placeCaret(page, 'some', 'select')
    await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 })
    await page.waitForTimeout(80)
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await cdp.send('Input.insertText', { text: '' }).catch(() => undefined)
    await page.waitForTimeout(400)
    expect(await struckText(page)).toEqual([])
    expect(await insertedText(page)).toEqual(['ZZ'])
    // still drawn as a suggestion (the decoration span survives), so a click on it still finds its card
    await expect(page.locator('#mdr-editor-host .ProseMirror [data-suggestion][data-kind="ins"]')).toHaveText('ZZ')
  }
})
