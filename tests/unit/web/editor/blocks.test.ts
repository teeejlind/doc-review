// tests/unit/web/editor/blocks.test.ts (P2; CONTRACTS §12.13 Lists, Task items, Blockquote, Code blocks). Keys go
// through the view's whole handleKeyDown chain (press), each case checked against the saved file.
import { afterEach, describe, expect, it } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import { caret, mount, press, saved, typeKeys, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

describe('lists (§12.13)', () => {
  it('Enter splits the item; Enter on an empty item leaves the list', async () => {
    m = await mount({ markdown: '- one\n- two\n\nAfter.\n' })
    caret(m.view, 'two')
    press(m, 'Enter')
    typeKeys(m.view, 'three')
    press(m, 'Enter')
    press(m, 'Enter')
    typeKeys(m.view, 'Out of the list.')
    expect(await saved(m)).toBe('- one\n- two\n- three\n\nOut of the list.\n\nAfter.\n')
  })

  it('Enter on an empty nested item outdents it', async () => {
    m = await mount({ markdown: '- one\n  - nested\n' })
    caret(m.view, 'nested')
    press(m, 'Enter')
    press(m, 'Enter')
    typeKeys(m.view, 'two')
    expect(await saved(m)).toBe('- one\n  - nested\n- two\n')
  })

  it('Tab / Shift+Tab sink and lift; nested lists of any depth round-trip', async () => {
    m = await mount({ markdown: '- a\n- b\n- c\n- d\n' })
    caret(m.view, 'b')
    press(m, 'Tab')
    caret(m.view, 'c')
    press(m, 'Tab')
    press(m, 'Tab')
    expect(await saved(m)).toBe('- a\n  - b\n    - c\n- d\n')
    caret(m.view, 'c')
    press(m, 'Tab', { shift: true })
    expect(await saved(m)).toBe('- a\n  - b\n  - c\n- d\n')
  })

  it('Backspace at the start of an item lifts it', async () => {
    m = await mount({ markdown: '- a\n- b\n' })
    caret(m.view, 'b', { at: 'start' })
    press(m, 'Backspace')
    expect(await saved(m)).toBe('- a\n\nb\n')
  })

  it('ordered lists keep their start number and renumber on save', async () => {
    m = await mount({ markdown: '3. three\n4. four\n' })
    caret(m.view, 'four')
    press(m, 'Enter')
    typeKeys(m.view, 'five')
    expect(await saved(m)).toBe('3. three\n4. four\n5. five\n')
  })
})

describe('task items (§12.13, §6.5)', () => {
  it('renders a keyboard-focusable checkbox per task item; a click writes through in Editing mode (one byte)', async () => {
    m = await mount({ markdown: '- [ ] todo\n- [x] done\n- plain\n' })
    const boxes = [...m.host.querySelectorAll<HTMLInputElement>(`[data-testid="${TESTID.taskCheckbox}"]`)]
    expect(boxes.map((b) => b.dataset.checked)).toEqual(['false', 'true'])
    expect(boxes.every((b) => b.tabIndex >= 0)).toBe(true)
    expect(m.host.querySelectorAll('li[data-task]').length).toBe(2)
    boxes[0]!.click()
    expect(await saved(m)).toBe('- [x] todo\n- [x] done\n- plain\n')
    expect(m.host.querySelector<HTMLInputElement>(`[data-testid="${TESTID.taskCheckbox}"]`)!.dataset.checked).toBe('true')
  })

  it('Enter in a task item makes an unchecked task item', async () => {
    m = await mount({ markdown: '- [x] done\n' })
    caret(m.view, 'done')
    press(m, 'Enter')
    typeKeys(m.view, 'next')
    expect(await saved(m)).toBe('- [x] done\n- [ ] next\n')
  })

  it('Suggesting mode: a toggle is a tracked structure suggestion (S2-b), never written', async () => {
    m = await mount({ markdown: '- [ ] todo\n' })
    m.bridge.setMode('suggesting')
    const box = m.host.querySelector<HTMLInputElement>(`[data-testid="${TESTID.taskCheckbox}"]`)!
    box.click()
    expect([...m.bridge.getSuggestionSummaries().values()].map((s) => [s.by, s.kind])).toEqual([['TJ', 'structure']])
    expect(m.notices.some((n) => n.code === 'SUGGEST_MODE_BLOCKED')).toBe(false)
    expect(m.host.querySelector<HTMLInputElement>(`[data-testid="${TESTID.taskCheckbox}"]`)!.checked).toBe(true)
    expect(await saved(m)).toBe('- [ ] todo\n')
  })
})

describe('blockquote (§12.13)', () => {
  it('nested content edits normally; Backspace at the start of its first block lifts out', async () => {
    m = await mount({ markdown: '> first\n>\n> second\n' })
    caret(m.view, 'second')
    typeKeys(m.view, ' line')
    caret(m.view, 'first', { at: 'start' })
    press(m, 'Backspace')
    expect(await saved(m)).toBe('first\n\n> second line\n')
  })
})

describe('code blocks (§12.13)', () => {
  it('Tab inserts two spaces, Shift+Tab removes up to two, Enter inserts a newline', async () => {
    m = await mount({ markdown: '```js\nconst a = 1\n```\n' })
    caret(m.view, 'const a = 1')
    press(m, 'Enter')
    press(m, 'Tab')
    typeKeys(m.view, 'b()')
    expect(await saved(m)).toBe('```js\nconst a = 1\n  b()\n```\n')
    press(m, 'Tab', { shift: true })
    expect(await saved(m)).toBe('```js\nconst a = 1\nb()\n```\n')
  })

  it('Cmd+Enter, or a third Enter at the end, exits to a paragraph below', async () => {
    m = await mount({ markdown: '```\nx\n```\n' })
    caret(m.view, 'x')
    press(m, 'Enter', { mod: true })
    typeKeys(m.view, 'after')
    expect(await saved(m)).toBe('```\nx\n```\n\nafter\n')
    caret(m.view, 'x')
    press(m, 'Enter')
    press(m, 'Enter')
    press(m, 'Enter')
    typeKeys(m.view, 'between')
    expect(await saved(m)).toBe('```\nx\n```\n\nbetween\n\nafter\n')
  })

  it('the language field edits code_block.attrs.language and keeps meta', async () => {
    m = await mount({ markdown: '```ts title="a.ts"\nlet a\n```\n' })
    const field = m.host.querySelector<HTMLInputElement>(`[data-testid="${TESTID.codeLanguage}"]`)!
    expect(field.value).toBe('ts')
    field.focus()
    field.value = 'tsx'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(await saved(m)).toBe('```tsx title="a.ts"\nlet a\n```\n')
  })

  it('text edits in a code block are blocked in Suggesting mode', async () => {
    m = await mount({ markdown: '```\nx\n```\n' })
    m.bridge.setMode('suggesting')
    caret(m.view, 'x')
    typeKeys(m.view, 'y')
    expect(m.notices.map((n) => n.code)).toContain('SUGGEST_MODE_BLOCKED')
    expect(m.view.state.doc.textContent).toBe('x')
  })
})

describe('toolbar hr (§12.13 "Headings and hr")', () => {
  it('inserts a rule below the current block in Editing mode', async () => {
    m = await mount({ markdown: 'One.\n\nTwo.\n' })
    caret(m.view, 'One.')
    m.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.toolbarButton}"][data-action="hr"]`)!.click()
    expect(await saved(m)).toBe('One.\n\n---\n\nTwo.\n')
  })
})

describe('toolbar horizontal rule (QA round 1: unverified 22)', () => {
  it('leaves the caret on a new empty paragraph below the rule, so typing never lands in the next block', async () => {
    const mm = await mount({ markdown: 'Intro here.\n\n## Goals\n' })
    try {
      caret(mm.view, 'Intro here.', { at: 'end' })
      mm.ed.runAction('hr', mm.view)
      mm.view.dispatch(mm.view.state.tr.insertText('typed after hr'))
      await mm.session.flush()
      expect(mm.fx.root.read('doc.md')).toBe('Intro here.\n\n---\n\ntyped after hr\n\n## Goals\n')
    } finally {
      await mm.close()
    }
  })
})
