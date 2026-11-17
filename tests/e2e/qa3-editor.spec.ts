// tests/e2e/qa3-editor.spec.ts (QA round 3, editor fixer). The editor findings that depend on the real keyboard and
// browser: what Chrome does with a keystroke the editor leaves to it is exactly what went wrong.
import { TESTID } from '../../shared/constants'
import { captureNotices, MOD, notices, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [] })

const PARA = '# Plan\n\nSecond paragraph talks about the waitlist and the explainer page. It is short but has two sentences.\n\nFinal paragraph.\n'
const BASIC = '# Launch plan\n\nThe notes carry a member rate of 12% paid monthly. We launch in Q3.\n\nThe member rate is reviewed every quarter.\n'
const TWO = 'First para.\n\nSecond para.\n'

/** Struck and inserted runs in the editor, in document order. */
const runs = (page: import('@playwright/test').Page): Promise<string[]> => page.evaluate(() => {
  const out: string[] = []
  for (const el of Array.from(document.querySelectorAll('#mdr-editor-host .mdr-sugg--del, #mdr-editor-host .mdr-sugg--ins'))) {
    const k = el.classList.contains('mdr-sugg--del') ? 'DEL' : 'INS'
    const text = (el.textContent ?? '').replace(/​/g, '')
    if (!text) continue
    const last = out[out.length - 1]
    if (last?.startsWith(k + '[') && el.previousSibling === null) out[out.length - 1] = `${last.slice(0, -1)}${text}]`
    else out.push(`${k}[${text}]`)
  }
  return out
})

test('F1: Enter right after a space, a pause past autosave, more typing: saved, no merge banner', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'f1.md', content: PARA })
  await placeCaret(page, 'explainer', 'start')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1_500)
  await page.keyboard.type('MY TYPED TEXT ', { delay: 30 })
  await page.waitForTimeout(1_500)
  expect(await savedText(ed, tmpRoot, 'f1.md')).toContain('and the \n\nMY TYPED TEXT explainer page.')
  await expect(ed.testid('banner')).toHaveCount(0)
  expect(await ed.session((s) => s.getSaveState().state)).toBe('saved')
  await expect(ed.editor()).toContainText('MY TYPED TEXT explainer')
})

test.describe('Suggesting mode keystrokes', () => {
  test('forward Delete strikes the next character each press', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'del.md', content: BASIC })
    await ed.testid('modePill').click()
    await placeCaret(page, 'quarter', 'start')
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Delete')
      await page.waitForTimeout(60)
    }
    await expect.poll(() => runs(page)).toEqual(['DEL[quarter]'])
  })

  test('double-click a word, Backspace twice: the word and the space before it struck, nothing inserted', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'bs.md', content: BASIC })
    await ed.testid('modePill').click()
    await page.locator('#mdr-editor-host .ProseMirror p', { hasText: 'paid monthly' }).getByText('paid', { exact: false }).first().waitFor()
    await placeCaret(page, 'paid', 'select')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await expect.poll(() => runs(page)).toEqual(['DEL[ paid]'])
    await expect.poll(() => page.locator(`[data-testid="${TESTID.card}"]`).count(), { timeout: 15_000 }).toBe(1)
  })

  test('Backspace from just after a space strikes one more character per press', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'bs2.md', content: BASIC })
    await ed.testid('modePill').click()
    await placeCaret(page, 'monthly', 'start')
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(60)
    }
    await expect.poll(() => runs(page)).toEqual(['DEL[12% paid ]'])
  })

  test('a list typed after Enter: Enter makes new items; Enter then Backspace is never refused', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'list.md', content: TWO })
    await captureNotices(ed)
    await ed.testid('modePill').click()
    await placeCaret(page, 'First para.')
    await page.keyboard.press('Enter')
    for (const t of ['- a', 'b', 'c']) {
      if (t !== '- a') await page.keyboard.press('Enter')
      await page.keyboard.type(t, { delay: 40 })
      await page.waitForTimeout(300)
    }
    await expect(page.locator('#mdr-editor-host .ProseMirror ul li')).toHaveCount(3)
    await placeCaret(page, 'Second para.')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Backspace')
    expect(await notices(page)).not.toContain('SUGGEST_MODE_BLOCKED')
    expect(await ed.debug.liveMarkdown()).toBe('First para.\n\n- a\n- b\n- c\n\nSecond para.\n')
    expect(await savedText(ed, tmpRoot, 'list.md')).toBe(TWO)
  })

  test('typing over a selected word, then one Cmd+Z, takes back the whole replace', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'undo.md', content: BASIC })
    await ed.testid('modePill').click()
    await placeCaret(page, 'monthly', 'select')
    await page.keyboard.type('weekly', { delay: 40 })
    await expect.poll(() => runs(page)).toEqual(['DEL[monthly]', 'INS[weekly]'])
    await page.waitForTimeout(1_000)
    await page.keyboard.press(`${MOD}+z`)
    await expect.poll(() => runs(page)).toEqual([])
    await expect.poll(() => page.locator(`[data-testid="${TESTID.card}"]`).count(), { timeout: 15_000 }).toBe(0)
  })
})

test.describe('serializer and links', () => {
  test('Suggesting mode: select all + Backspace in a doc with a table is blocked, nothing struck, save stays clean', async ({ page, server, tmpRoot }) => {
    const md = '# Tables\n\n| Deal | Member |\n|:-----|-------:|\n| Alpha | 12.0% |\n\nText between.\n'
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'tbl.md', content: md })
    await captureNotices(ed)
    await ed.testid('modePill').click()
    await placeCaret(page, 'Tables', 'start')
    await page.keyboard.press(`${MOD}+a`)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(1_500)
    expect(await notices(page)).toContain('SUGGEST_MODE_BLOCKED')
    await expect.poll(() => runs(page)).toEqual([])
    expect(await ed.session((s) => s.getSaveState().state)).toBe('saved')
    expect(await savedText(ed, tmpRoot, 'tbl.md')).toBe(md)
  })

  test('typed and pasted addresses: linked on screen, no backslashes in the file', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'url.md', content: 'First para.\n' })
    await placeCaret(page, 'First para.')
    await page.keyboard.press('Enter')
    await page.keyboard.type('typed https://example.com/path_with_under?x=1&y=2 here and more.', { delay: 10 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('mail me at someone@example.com now', { delay: 10 })
    await expect(page.locator('#mdr-editor-host .ProseMirror a')).toHaveCount(2)
    const out = await savedText(ed, tmpRoot, 'url.md')
    expect(out).toBe('First para.\n\ntyped https://example.com/path_with_under?x=1&y=2 here and more.\n\nmail me at someone@example.com now\n')
  })

  test('a click inside a link keeps typing in the document; retyping the whole link text keeps the link', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'lnk.md', content: 'See [the primer](https://example.com/primer) today.\n' })
    await page.locator('#mdr-editor-host .ProseMirror a').click()
    await expect(ed.testid('linkPopover')).toBeVisible()
    expect(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror') ?? false)).toBe(true)
    await page.keyboard.press('End')
    await placeCaret(page, 'the primer', 'start')
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.type('the guide', { delay: 30 })
    expect(await savedText(ed, tmpRoot, 'lnk.md')).toBe('See [the guide](https://example.com/primer) today.\n')
  })

  test('an empty line in a quote and spaces typed at a line start write no HTML or entities', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'q.md', content: '> A short quote for context here.\n\nThe notes carry a member.\n' })
    await placeCaret(page, 'A short quote', 'start')
    await page.keyboard.press('Enter')
    await placeCaret(page, 'The notes', 'start')
    await page.keyboard.type('  ')
    const out = await savedText(ed, tmpRoot, 'q.md')
    expect(out).not.toContain('<br')
    expect(out).not.toContain('&#x')
  })
})

test.describe('opening, code blocks, anchors', () => {
  test('typing right after a doc opens goes into the document', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'open.md', content: '---\ntitle: Simple\nstatus: draft only\n---\n\n# Heading\n\nBody text.\n' })
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('ProseMirror') ?? false)).toBe(true)
    await expect(page.locator('.is-selected, .ProseMirror-selectednode')).toHaveCount(0)
    await page.keyboard.type('Typed right after open ')
    expect(await savedText(ed, tmpRoot, 'open.md')).toContain('# Typed right after open Heading')
  })

  test('code block language: Enter puts the caret back in that code block', async ({ page, server, tmpRoot }) => {
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some words to make the page scroll.`).join('\n\n')
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'code.md', content: `# Title\n\n${filler}\n\n\`\`\`\nx = 1\n\`\`\`\n` })
    const lang = page.locator(`[data-testid="${TESTID.codeLanguage}"]`)
    await lang.scrollIntoViewIfNeeded()
    await lang.click()
    await page.keyboard.type('python')
    await page.keyboard.press('Enter')
    await page.keyboard.type('print(1)')
    const out = await savedText(ed, tmpRoot, 'code.md')
    expect(out.startsWith('# Title\n')).toBe(true)
    expect(out).toContain('```python\nprint(1)x = 1\n```')
  })

  test('a suggestion typed at the end of a paragraph is anchored to that paragraph', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'anc.md', content: 'First paragraph text.\n\nSecond paragraph.\n\nThird.\n' })
    await ed.testid('modePill').click()
    await placeCaret(page, 'First paragraph text.')
    await page.keyboard.type(' It also covers pricing.', { delay: 20 })
    await expect.poll(() => ed.session((s) => s.getReview().threads.map((t) => t.anchor.kind === 'text' ? t.anchor.quote : '')), { timeout: 15_000 }).toEqual(['text'])
  })
})
