// tests/unit/web/editor/t2-editor-ux-tab.test.ts (T2 editor-ux, Pass 4 #31): Tab in a paragraph, heading or quote stays
// in the document (it does nothing), like it does in lists, code and tables; Esc, then Tab leaves it, so the document
// is never a keyboard trap.
import { afterEach, describe, expect, it } from 'vitest'
import { caret, mount, press, saved, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

describe('#31: Tab stays in the document', () => {
  for (const [name, md, at] of [
    ['a paragraph', 'Plain words here.\n', 'Plain'],
    ['a heading', '# A heading\n', 'A head'],
    ['a quote', '> Quoted words\n', 'Quoted'],
  ] as const) {
    it(`${name}: Tab and Shift+Tab are handled and change nothing`, async () => {
      m = await mount({ markdown: md })
      caret(m.view, at)
      const doc = m.view.state.doc
      expect(press(m, 'Tab')).toBe(true)
      expect(press(m, 'Tab', { shift: true })).toBe(true)
      expect(m.view.state.doc.eq(doc)).toBe(true)
      expect(await saved(m)).toBe(md)
    })
  }

  it('Tab in Suggesting mode is the same', async () => {
    m = await mount({ markdown: 'Plain words here.\n' })
    m.bridge.setMode('suggesting')
    caret(m.view, 'Plain')
    expect(press(m, 'Tab')).toBe(true)
    expect([...m.bridge.getSuggestionSummaries().values()]).toEqual([])
  })

  it('a list item still indents and outdents, code still takes two spaces', async () => {
    m = await mount({ markdown: '- one\n- two\n' })
    caret(m.view, 'two')
    expect(press(m, 'Tab')).toBe(true)
    expect(await saved(m)).toBe('- one\n  - two\n')
    expect(press(m, 'Tab', { shift: true })).toBe(true)
    expect(await saved(m)).toBe('- one\n- two\n')
    await m.close()
    m = await mount({ markdown: '```\nx\n```\n' })
    caret(m.view, 'x')
    press(m, 'Tab')
    expect(m.view.state.doc.textContent).toBe('x  ')
  })

  it('Esc, then Tab leaves the document; any other key in between and Tab is the editor\'s again', async () => {
    m = await mount({ markdown: 'Plain words here.\n' })
    caret(m.view, 'Plain')
    press(m, 'Escape')
    expect(press(m, 'Tab')).toBe(false)
    expect(press(m, 'Tab', { shift: true })).toBe(false)
    press(m, 'ArrowRight')
    expect(press(m, 'Tab')).toBe(true)
    press(m, 'Escape')
    m.view.dom.dispatchEvent(new FocusEvent('blur'))
    expect(press(m, 'Tab')).toBe(true)
  })
})
