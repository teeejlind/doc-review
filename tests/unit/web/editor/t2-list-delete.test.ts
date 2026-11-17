// tests/unit/web/editor/t2-list-delete.test.ts (T2 suggest track): Delete at the end of a list item's text joins the next
// text onto it, as Google Docs does, in Editing mode (it made a loose two-paragraph item, and turned a paragraph after
// the list into an item), and Suggesting mode's Accept writes the same Markdown.
import { afterEach, describe, expect, it } from 'vitest'
import { caret, mount, press, until, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

/** Press Delete with the caret at the end of `at` on a fresh mount in `mode`; in Suggesting, accept what it filed; return the file. */
async function outcome(markdown: string, mode: 'editing' | 'suggesting', at: string): Promise<string> {
  const mm = await mount({ markdown })
  m = mm
  if (mode === 'suggesting') mm.bridge.setMode('suggesting')
  caret(mm.view, at)
  press(mm, 'Delete')
  await mm.session.flush()
  if (mode === 'suggesting') {
    await until(() => mm.session.getReview().suggestions.some((s) => s.status === 'pending')).catch(() => undefined)
    for (const s of mm.session.getReview().suggestions.filter((x) => x.status === 'pending')) await mm.bridge.accept(s.id)
    await mm.session.flush()
  }
  const out = mm.fx.root.read('doc.md')
  await mm.close()
  m = null
  return out
}

const LIST = '# T\n\n- Alpha item\n- Beta item\n- Gamma item\n\nTail.\n'

const CASES: Array<[string, string, string, string]> = [
  ['a middle item', LIST, 'Alpha item', '# T\n\n- Alpha itemBeta item\n- Gamma item\n\nTail.\n'],
  ['the last item takes the paragraph after the list', LIST, 'Gamma item', '# T\n\n- Alpha item\n- Beta item\n- Gamma itemTail.\n'],
  ['an item with a nested list takes the nested item', '# T\n\n- Alpha item\n  - Nested one\n- Beta item\n\nTail.\n', 'Alpha item', '# T\n\n- Alpha itemNested one\n- Beta item\n\nTail.\n'],
  ['the end of a nested item takes the next outer item', '# T\n\n- Alpha item\n  - Nested one\n- Beta item\n\nTail.\n', 'Nested one', '# T\n\n- Alpha item\n  - Nested oneBeta item\n\nTail.\n'],
  ['the next item keeps its nested list, now under this one', '- Alpha item\n- Beta item\n  - Beta child\n- Gamma item\n', 'Alpha item', '- Alpha itemBeta item\n  - Beta child\n- Gamma item\n'],
  ['a numbered list keeps counting', '1. One\n2. Two\n3. Three\n', 'One', '1. OneTwo\n2. Three\n'],
  ['a checklist item', '- [ ] One\n- [x] Two\n- [ ] Three\n', 'One', '- [ ] OneTwo\n- [ ] Three\n'],
]

describe('Delete at the end of a list item', () => {
  for (const [name, md, at, want] of CASES) {
    it(`Editing: ${name}`, async () => {
      expect(await outcome(md, 'editing', at)).toBe(want)
    })
    it(`Suggesting: ${name}: Accept writes what Editing writes`, async () => {
      expect(await outcome(md, 'suggesting', at)).toBe(want)
    })
  }

  it('the caret stays where the two met', async () => {
    m = await mount({ markdown: LIST })
    caret(m.view, 'Alpha item')
    press(m, 'Delete')
    const $c = m.view.state.selection.$from
    expect($c.parent.textContent).toBe('Alpha itemBeta item')
    expect($c.parentOffset).toBe('Alpha item'.length)
  })

  it('one undo takes the join back', async () => {
    m = await mount({ markdown: LIST })
    caret(m.view, 'Alpha item')
    press(m, 'Delete')
    m.ed.runAction('undo', m.view)
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe(LIST)
  })

  it('Suggesting mode, Reject restores the bytes', async () => {
    m = await mount({ markdown: LIST })
    m.bridge.setMode('suggesting')
    caret(m.view, 'Gamma item')
    press(m, 'Delete')
    await m.session.flush()
    await until(() => m!.session.getReview().suggestions.some((s) => s.status === 'pending'))
    for (const s of m.session.getReview().suggestions) await m.bridge.reject(s.id)
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe(LIST)
  })

  it('Delete in the middle of an item is the browser\'s, and at the end of a plain paragraph it is as it was', async () => {
    const edit = await outcome('# T\n\nOne paragraph.\n\nNext paragraph.\n', 'editing', 'One paragraph.')
    expect(edit).toBe('# T\n\nOne paragraph.Next paragraph.\n')
    m = await mount({ markdown: LIST })
    caret(m.view, 'Alpha')
    expect(press(m, 'Delete')).toBe(false)
  })
})
