// tests/e2e/p2-blocks.spec.ts (P2; CONTRACTS §12.13, §0.2 item 10, D44, §12.15). Real keyboard in Chromium on the day-0
// harness page: every auto-format trigger in Editing mode against the saved file; triggers in Suggesting mode are
// tracked; Backspace-undo; nested list Tab / Shift+Tab; task checkbox toggles in both modes; code block Enter / exit
// and the language field; and the raw-HTML cases on syn__block-html.md (byte-identical no-op save, the <div> block and
// an inline <span> chip edited through the popover with the diff confined to their lines, both blocked in Suggesting
// mode).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TESTID } from '../../shared/constants'
import { browserChoice } from '../helpers/browser'
import { openEditor } from '../helpers/openEditor'
import { captureNotices, changedLines, MOD, notices, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const FILE = 'blocks.md'

test('p2-blocks: every auto-format trigger with the real keyboard (Editing mode)', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: 'Intro.\n' })
  await placeCaret(page, 'Intro.')
  const k = page.keyboard
  await k.press('Enter')
  await k.type('# Title')
  await k.press('Enter')
  await k.type('- item')
  await k.press('Enter')
  await k.press('Enter')
  await k.type('1. one')
  await k.press('Enter')
  await k.press('Enter')
  await k.type('- [ ] task')
  await k.press('Enter')
  await k.press('Enter')
  await k.type('> quote')
  await k.press('Enter')
  await k.press('Enter')
  await k.type('**bold** *it* `code` ~~gone~~ __b2__ _i2_')
  await k.press('Enter')
  await k.type('```ts')
  await k.press('Enter')
  await k.type('let a')
  await k.press(`${MOD}+Enter`)
  await k.type('---')
  await k.press('Enter')
  await k.type('after')
  expect(await savedText(ed, tmpRoot, FILE)).toBe([
    'Intro.', '', '# Title', '', '- item', '', '1. one', '', '- [ ] task', '', '> quote', '',
    '**bold** *it* `code` ~~gone~~ **b2** *i2*', '', '```ts', 'let a', '```', '', '---', '', 'after', '',
  ].join('\n'))
})

test('p2-blocks: Suggesting-mode triggers are tracked; Backspace right after a rule undoes it', async ({ page, server, tmpRoot }) => {
  const DOC = 'Make this a title.\n\nPlain line.\n'
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
  await captureNotices(ed)
  // Backspace-undo in Editing mode
  await placeCaret(page, 'Plain line.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('# ')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('x')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('Make this a title.\n\nPlain line.\n\n\\# x\n')
  const afterUndo = tmpRoot.read(FILE)
  // Suggesting mode: `# ` is a structure suggestion, the code fence is blocked
  await ed.testid('modePill').click()
  await placeCaret(page, 'Make this', 'start')
  await page.keyboard.type('# ')
  await expect(page.locator('#mdr-editor-host .ProseMirror h1')).toContainText('Make this a title.')
  const kinds = await ed.bridge((b) => [...b.getSuggestionSummaries().values()].map((s) => s.kind))
  expect(kinds).toContain('structure')
  await placeCaret(page, 'Plain line.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('```')
  await page.keyboard.press('Enter')
  expect(await notices(page)).toContain('SUGGEST_MODE_BLOCKED')
  expect(await page.locator('#mdr-editor-host .ProseMirror pre').count()).toBe(0)
  expect(await savedText(ed, tmpRoot, FILE)).toBe(afterUndo)
})

test('p2-blocks: nested lists with Tab / Shift+Tab round-trip', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: '- a\n- b\n- c\n- d\n' })
  await placeCaret(page, 'b')
  await page.keyboard.press('Tab')
  await placeCaret(page, 'c')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('- a\n  - b\n    - c\n- d\n')
  await placeCaret(page, 'c')
  await page.keyboard.press('Shift+Tab')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('- a\n  - b\n  - c\n- d\n')
})

test('p2-blocks: task checkboxes toggle in Editing mode (one byte) and are tracked in Suggesting mode', async ({ page, server, tmpRoot }) => {
  const DOC = '- [ ] todo\n- [x] done\n'
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
  await captureNotices(ed)
  const box = ed.testid('taskCheckbox').first()
  await expect(box).toHaveAttribute('data-checked', 'false')
  await box.click()
  await expect(box).toHaveAttribute('data-checked', 'true')
  const out = await savedText(ed, tmpRoot, FILE)
  expect(out).toBe('- [x] todo\n- [x] done\n')
  // keyboard: Space on the focused checkbox
  await ed.testid('taskCheckbox').nth(1).focus()
  await page.keyboard.press('Space')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('- [x] todo\n- [ ] done\n')
  const before = tmpRoot.read(FILE)
  await ed.testid('modePill').click()
  await box.click()
  // a tracked `structure` suggestion: the schema carries list-item marks (S2-b)
  await expect.poll(() => ed.bridge((b) => [...b.getSuggestionSummaries().values()].map((s) => s.kind))).toEqual(['structure'])
  expect(await notices(page)).not.toContain('SUGGEST_MODE_BLOCKED')
  expect(await savedText(ed, tmpRoot, FILE)).toBe(before)
  await expect.poll(() => ed.session((s) => s.getReview().suggestions.map((x) => [x.by, x.proposed]))).toEqual([['TJ', '- [ ] todo\n- [ ] done']])
})

test('p2-blocks: code block Enter, exit and the language field', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: '```js\nconst a = 1\n```\n\nAfter.\n' })
  await placeCaret(page, 'const a = 1')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('b()')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('```js\nconst a = 1\n  b()\n```\n\nAfter.\n')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Between.')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('```js\nconst a = 1\n  b()\n```\n\nBetween.\n\nAfter.\n')
  const lang = ed.testid('codeLanguage')
  await expect(lang).toHaveValue('js')
  await lang.fill('ts')
  await lang.press('Enter')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('```ts\nconst a = 1\n  b()\n```\n\nBetween.\n\nAfter.\n')
})

test.describe('raw HTML', () => {
  test.use({ fixtureFiles: ['syn__block-html.md'], docFile: 'syn__block-html.md' })

  test('p2-blocks: byte-identical no-op save; the <div> block and an inline chip edit only their lines; both blocked in Suggesting mode', async ({ page, server, tmpRoot }) => {
    const F = 'syn__block-html.md'
    const original = readFileSync(join(process.cwd(), 'tests/fixtures/docs', F), 'utf8')
    const ed = await openEditor(page, { port: server.port, file: F })
    await captureNotices(ed)
    expect(await ed.debug.planSave()).toEqual([])
    expect(await savedText(ed, tmpRoot, F)).toBe(original)

    // the <div> block: a raw block once P1 promotes block HTML (M1), an inline chip on the day-0 loader
    const div = page.locator(`[data-testid="${TESTID.rawBlock}"], [data-testid="${TESTID.inlineHtml}"]`).filter({ hasText: '<div class="callout">' })
    await div.first().click()
    const pop = ed.testid('rawPopover')
    await expect(pop).toBeVisible()
    const src = pop.locator('[data-field="source"]')
    await expect(src).toHaveValue(/Raw block HTML stays byte-exact/)
    await src.fill((await src.inputValue()).replace('stays byte-exact', 'stays exact'))
    await pop.locator('[data-action="save"]').click()
    let out = await savedText(ed, tmpRoot, F)
    expect(changedLines(original, out)).toEqual([3])
    const afterDiv = out

    // an inline <span> chip: only that paragraph's line
    await ed.testid('inlineHtml').filter({ hasText: '<span class="tag">' }).click()
    await expect(pop.locator('[data-field="source"]')).toHaveValue('<span class="tag">')
    await pop.locator('[data-field="source"]').fill('<span class="note">')
    await pop.locator('[data-action="save"]').click()
    out = await savedText(ed, tmpRoot, F)
    const changed = changedLines(afterDiv, out)
    expect(changed!.length).toBe(1)
    expect(out.split('\n')[changed![0]!]).toContain('<span class="note">inline</span>')

    // Suggesting mode: the popover opens, Save is disabled and raises the notice
    const before = out
    await ed.testid('modePill').click()
    await ed.testid('inlineHtml').filter({ hasText: '<span class="note">' }).click()
    await expect(pop.locator('[data-action="save"]')).toHaveAttribute('aria-disabled', 'true')
    await pop.locator('[data-field="source"]').fill('<span class="x">')
    await pop.locator('[data-action="save"]').click({ force: true })
    expect(await notices(page)).toContain('SUGGEST_MODE_BLOCKED')
    await pop.locator('[data-action="cancel"]').click()
    await div.first().click()
    await expect(pop.locator('[data-action="save"]')).toHaveAttribute('aria-disabled', 'true')
    expect(await savedText(ed, tmpRoot, F)).toBe(before)
  })
})
