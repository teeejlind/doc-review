// tests/unit/web/editor/t2-editor-ux-cell.test.ts (T2 editor-ux, Pass 4 #27): in a table cell the block buttons are
// disabled and say why, instead of being live and doing nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import { caret, mount, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

describe('#27: block buttons in a table cell', () => {
  const MD = 'Intro line.\n\n| a | b |\n|---|---|\n| one | two |\n'
  const btn = (mm: Mounted, action: string): HTMLElement => mm.toolbarHost.querySelector<HTMLElement>(`[data-testid="${TESTID.toolbarButton}"][data-action="${action}"]`)!
  const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

  it('lists, quote, code block and headings are disabled in a cell, each with its reason, and come back outside it', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'one')
    await frame()
    for (const [action, reason] of [
      ['bullet', "A table cell can't hold a list."],
      ['ordered', "A table cell can't hold a list."],
      ['task', "A table cell can't hold a list."],
      ['blockquote', "A table cell can't hold a quote."],
      ['code-block', "A table cell can't hold a code block."],
      ['heading-1', "A table cell can't hold a heading."],
      ['heading-3', "A table cell can't hold a heading."],
    ] as const) {
      expect(btn(m, action).getAttribute('aria-disabled'), action).toBe('true')
      expect(btn(m, action).title, action).toBe(reason)
    }
    // what a cell can do stays on: formatting, links, undo, normal text, the rule below the table
    for (const action of ['bold', 'italic', 'link', 'undo', 'heading-0', 'hr', 'heading']) expect(btn(m, action).getAttribute('aria-disabled'), action).toBeNull()

    caret(m.view, 'Intro')
    await frame()
    expect(btn(m, 'bullet').getAttribute('aria-disabled')).toBeNull()
    expect(btn(m, 'bullet').title).toBe(btn(m, 'bullet').getAttribute('aria-label'))
    expect(btn(m, 'bullet').title).toMatch(/^Bulleted list \(/)
  })

  it('clicking a disabled one changes nothing', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'one')
    await frame()
    const doc = m.view.state.doc
    for (const action of ['bullet', 'blockquote', 'code-block', 'heading-2']) btn(m, action).click()
    expect(m.view.state.doc.eq(doc)).toBe(true)
  })
})
