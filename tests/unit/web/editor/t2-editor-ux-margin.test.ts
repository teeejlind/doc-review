// tests/unit/web/editor/t2-editor-ux-margin.test.ts (T2 editor-ux, Pass 4 #26): a click on the page beside the document
// puts the caret at the nearest line. jsdom has no layout, so the boxes and posAtCoords are stubbed; the real clicks are
// in the t2-editor-ux-margin e2e.
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

describe('#26: a click on the page beside the document', () => {
  const box = (left: number, top: number, right: number, bottom: number): DOMRect =>
    ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON: () => ({}) }) as DOMRect

  /** The scroll container is 0..1000 x 0..800 with a 15 px scroll bar; the text box is 300..700 x 100..500. */
  function layout(mm: Mounted): ReturnType<typeof vi.fn> {
    mm.scroll.getBoundingClientRect = () => box(0, 0, 1000, 800)
    Object.defineProperty(mm.scroll, 'clientWidth', { value: 985, configurable: true })
    Object.defineProperty(mm.scroll, 'clientHeight', { value: 800, configurable: true })
    mm.view.dom.getBoundingClientRect = () => box(300, 100, 700, 500)
    const at = find(mm)
    const posAtCoords = vi.fn((c: { left: number; top: number }) => ({ pos: at, inside: -1, c }))
    ;(mm.view as unknown as { posAtCoords: unknown }).posAtCoords = posAtCoords
    return posAtCoords
  }
  const find = (mm: Mounted): number => mm.view.state.doc.content.size - 1 // the end of the last paragraph
  const down = (target: Element, x: number, y: number, o: MouseEventInit = {}): MouseEvent => {
    const e = new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...o })
    target.dispatchEvent(e)
    return e
  }

  it('puts the caret at the nearest position, with the point pulled into the text box', async () => {
    m = await mount({ markdown: 'First.\n\nSecond line here.\n' })
    const posAtCoords = layout(m)
    const e = down(m.scroll, 6, 300)
    expect(e.defaultPrevented).toBe(true)
    expect(posAtCoords).toHaveBeenCalledWith({ left: 301, top: 300 })
    expect(m.view.state.selection.empty).toBe(true)
    expect(m.view.state.selection.from).toBe(find(m))
    expect(document.activeElement).toBe(m.view.dom)
  })

  it('the right margin, the space above and below the text, and the column wrapper all count', async () => {
    m = await mount({ markdown: 'First.\n\nSecond line here.\n' })
    const posAtCoords = layout(m)
    down(m.scroll, 900, 300)
    down(m.scroll, 500, 20)
    down(m.scroll, 500, 790)
    const column = m.host.parentElement ?? m.scroll
    down(column, 10, 300)
    expect(posAtCoords.mock.calls.map(([c]) => c)).toEqual([
      { left: 699, top: 300 },
      { left: 500, top: 101 },
      { left: 500, top: 499 },
      { left: 301, top: 300 },
    ])
  })

  it('leaves alone: the scroll bar, a click in the text, the rail, a right click, a read-only document', async () => {
    m = await mount({ markdown: 'First.\n\nSecond line here.\n' })
    const posAtCoords = layout(m)
    const rail = m.scroll.appendChild(document.createElement('aside'))
    for (const e of [
      down(m.scroll, 992, 300), // the scroll bar
      down(rail, 900, 300), // the comment rail
      down(m.scroll, 6, 300, { button: 2 }),
    ]) expect(e.defaultPrevented).toBe(false)
    m.ed.setEditable(false)
    expect(down(m.scroll, 6, 300).defaultPrevented).toBe(false)
    expect(posAtCoords).not.toHaveBeenCalled()
    // and the text itself is ProseMirror's own click, not ours
    m.ed.setEditable(true)
    expect(down(m.view.dom, 400, 200).defaultPrevented).toBe(false)
  })

  it('a click where the editor finds no position does nothing', async () => {
    m = await mount({ markdown: 'First.\n' })
    const posAtCoords = layout(m)
    posAtCoords.mockReturnValue(null as never)
    expect(down(m.scroll, 6, 300).defaultPrevented).toBe(false)
  })

  it('a click replaces a selection with the caret, as any click does', async () => {
    m = await mount({ markdown: 'First.\n\nSecond line here.\n' })
    layout(m)
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, 4)))
    down(m.scroll, 6, 300)
    expect(m.view.state.selection.empty).toBe(true)
  })
})
