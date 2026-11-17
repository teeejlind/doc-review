// tests/e2e/p2-shortcuts.spec.ts (P2; CONTRACTS §14 P2 e2e "p2-shortcuts", §11.5, §12.13). Every P2 row of the §11.5
// table pressed with the real keyboard in Chromium (Cmd on macOS, Ctrl elsewhere) and checked in the saved file: modes,
// bold / italic / strike / inline code, the link popover, normal text and headings 1-3, bullet / numbered / task
// list, blockquote and code block, Tab / Shift+Tab in a list, Cmd+Enter leaving a code block ahead of a P3 Send
// binding registered through the seam, Cmd+Shift+V, undo / redo. Milkdown's removed preset keys do nothing.
// (Tab in a table moves cells: p2-tables.)
import { TESTID } from '../../shared/constants'
import { browserChoice } from '../helpers/browser'
import { MOD, openDoc, placeCaret, pressInEditor, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const LINE = 'Change the middle word here.'

/** Each row: the key chord, what to select ('middle' word or a caret in the paragraph), and the saved file. */
const FORMAT_ROWS: Array<{ name: string; keys: string; select: 'middle' | 'caret'; want: string }> = [
  { name: 'bold (Cmd+B)', keys: `${MOD}+KeyB`, select: 'middle', want: 'Change the **middle** word here.\n' },
  { name: 'italic (Cmd+I)', keys: `${MOD}+KeyI`, select: 'middle', want: 'Change the *middle* word here.\n' },
  { name: 'strikethrough (Cmd+Shift+X)', keys: `${MOD}+Shift+KeyX`, select: 'middle', want: 'Change the ~~middle~~ word here.\n' },
  { name: 'inline code (Cmd+E)', keys: `${MOD}+KeyE`, select: 'middle', want: 'Change the `middle` word here.\n' },
  { name: 'heading 1 (Cmd+Opt+1)', keys: `${MOD}+Alt+Digit1`, select: 'caret', want: `# ${LINE}\n` },
  { name: 'heading 2 (Cmd+Opt+2)', keys: `${MOD}+Alt+Digit2`, select: 'caret', want: `## ${LINE}\n` },
  { name: 'heading 3 (Cmd+Opt+3)', keys: `${MOD}+Alt+Digit3`, select: 'caret', want: `### ${LINE}\n` },
  { name: 'bullet list (Cmd+Shift+8)', keys: `${MOD}+Shift+Digit8`, select: 'caret', want: `- ${LINE}\n` },
  { name: 'numbered list (Cmd+Shift+7)', keys: `${MOD}+Shift+Digit7`, select: 'caret', want: `1. ${LINE}\n` },
  { name: 'task list (Cmd+Shift+9)', keys: `${MOD}+Shift+Digit9`, select: 'caret', want: `- [ ] ${LINE}\n` },
  { name: 'blockquote (Cmd+Shift+B)', keys: `${MOD}+Shift+KeyB`, select: 'caret', want: `> ${LINE}\n` },
  { name: 'code block (Cmd+Opt+C)', keys: `${MOD}+Alt+KeyC`, select: 'caret', want: `\`\`\`\n${LINE}\n\`\`\`\n` },
]

test.describe('format and block keys', () => {
  for (const row of FORMAT_ROWS) {
    test(`p2-shortcuts: ${row.name}`, async ({ page, server, tmpRoot }) => {
      const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: `${LINE}\n` })
      await placeCaret(page, row.select === 'middle' ? 'middle' : 'word', row.select === 'middle' ? 'select' : 'end')
      await page.keyboard.press(row.keys)
      expect(await savedText(ed, tmpRoot, 'k.md')).toBe(row.want)
    })
  }

  test('p2-shortcuts: Cmd+Opt+0 turns a heading back into normal text', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: `## ${LINE}\n` })
    await placeCaret(page, 'middle', 'end')
    await page.keyboard.press(`${MOD}+Alt+Digit0`)
    expect(await savedText(ed, tmpRoot, 'k.md')).toBe(`${LINE}\n`)
  })
})

test('p2-shortcuts: the mode keys switch Editing / Suggesting', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: `${LINE}\n` })
  const pill = ed.testid('modePill')
  await placeCaret(page, 'middle')
  await page.keyboard.press(`${MOD}+Alt+Shift+KeyX`)
  await expect(pill).toHaveAttribute('data-mode', 'suggesting')
  expect(await ed.bridge((b) => b.getMode())).toBe('suggesting')
  await page.keyboard.press(`${MOD}+Alt+Shift+KeyE`)
  await expect(pill).toHaveAttribute('data-mode', 'editing')
  await expect(ed.editor()).toHaveAttribute('data-mode', 'editing')
})

test('p2-shortcuts: Tab / Shift+Tab indent and outdent a list item', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: '- one\n- two\n- three\n' })
  await placeCaret(page, 'two')
  await page.keyboard.press('Tab')
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('- one\n  - two\n- three\n')
  await page.keyboard.press('Shift+Tab')
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('- one\n- two\n- three\n')
})

test('p2-shortcuts: Cmd+Enter leaves a code block ahead of a Send binding registered with when not-in-code (§11.5 seam)', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: 'Before the code.\n\n```\nx = 1\n```\n' })
  await ed.bridge((b) => {
    const w = window as unknown as { __sends: number }
    w.__sends = 0
    b.registerShortcut({ key: 'Mod-Enter', when: 'not-in-code', run: () => ((w.__sends += 1), true) })
  })
  const sends = (): Promise<number> => page.evaluate(() => (window as unknown as { __sends: number }).__sends)
  // inside the code block: P2 exits the block, the Send binding does not run
  await placeCaret(page, 'x = 1')
  await page.keyboard.press(`${MOD}+Enter`)
  await page.keyboard.type('After the code.')
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Before the code.\n\n```\nx = 1\n```\n\nAfter the code.\n')
  expect(await sends()).toBe(0)
  // outside a code block: the registered binding handles it and the doc is untouched
  await placeCaret(page, 'Before the code.')
  await page.keyboard.press(`${MOD}+Enter`)
  expect(await sends()).toBe(1)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Before the code.\n\n```\nx = 1\n```\n\nAfter the code.\n')
})

test('p2-shortcuts: Cmd+K opens the link popover on a selection', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: `${LINE}\n` })
  await placeCaret(page, 'middle', 'select')
  await page.keyboard.press(`${MOD}+KeyK`)
  await expect(ed.testid('linkPopover')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(ed.testid('linkPopover')).toHaveCount(0)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe(`${LINE}\n`)
})

test('p2-shortcuts: Cmd+Z undoes and Cmd+Shift+Z redoes a typed edit, on disk', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: `${LINE}\n` })
  await placeCaret(page, 'here.')
  await page.keyboard.type(' Again')
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Change the middle word here. Again\n')
  await pressInEditor(ed, `${MOD}+KeyZ`)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe(`${LINE}\n`)
  await pressInEditor(ed, `${MOD}+Shift+KeyZ`)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Change the middle word here. Again\n')
})

test('p2-shortcuts: Cmd+Shift+V pastes text/plain only', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: `${LINE}\n` })
  await placeCaret(page, 'here.')
  // the shortcut's keydown (synthetic, so Chromium runs no native paste of its own), then the paste event
  await page.evaluate(() => {
    const dom = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    const mac = /Mac/.test(navigator.platform)
    dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', shiftKey: true, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }))
    const dt = new DataTransfer()
    dt.setData('text/html', '<p><b>bold</b> <i>rich</i></p>')
    dt.setData('text/plain', ' plain words')
    dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Change the middle word here. plain words\n')
})

test('p2-shortcuts: Milkdown\'s removed preset keys (Cmd+Opt+8, Cmd+Opt+X) and unregistered P3 keys change nothing', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: `${LINE}\n` })
  await placeCaret(page, 'middle', 'select')
  for (const keys of [`${MOD}+Alt+Digit8`, `${MOD}+Alt+KeyX`, `${MOD}+Alt+KeyM`, `${MOD}+Alt+BracketRight`]) {
    await page.keyboard.press(keys)
  }
  expect(await ed.debug.liveMarkdown()).toBe(`${LINE}\n`)
  expect(await ed.debug.planSave()).toEqual([])
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe(`${LINE}\n`)
  await expect(page.locator(`[data-testid="${TESTID.toolbarButton}"]`).first()).toBeVisible()
})
