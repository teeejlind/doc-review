// tests/unit/web/editor/reload-scroll.test.ts (P2; CONTRACTS §12.6 steps 4 and 7, §14 P2 unit "minimal replace keeps
// node identity, selection and scroll anchor"). jsdom has no layout, so every top-level editor block is given a
// 100 px box and the scroll container a writable scrollTop. A remote change above the first visible block moves
// scrollTop by exactly the height it added, so the block TJ was looking at stays put; a change below it leaves
// scrollTop alone. Untouched blocks keep node identity and the caret through the reload. (The real-layout half is the
// e2e p2-reload spec.)
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { find, mount, until, type Mounted } from './helpers'

const MD = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1} text.`).join('\n\n') + '\n'
const H = 100

let m: Mounted | null = null
let restore: (() => void) | null = null

function layout(mm: Mounted): { scrollTop(): number; setScrollTop(v: number): void } {
  let st = 0
  Object.defineProperty(mm.scroll, 'scrollTop', { configurable: true, get: () => st, set: (v: number) => void (st = v) })
  const orig = Element.prototype.getBoundingClientRect
  const pm = mm.view.dom
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this === mm.scroll) return new DOMRect(0, 0, 800, 3 * H)
    if (this.parentElement === pm) {
      const i = Array.prototype.indexOf.call(pm.children, this)
      return new DOMRect(0, i * H - st, 800, H)
    }
    return orig.call(this)
  }
  restore = () => {
    Element.prototype.getBoundingClientRect = orig
  }
  return { scrollTop: () => st, setScrollTop: (v) => void (st = v) }
}

const blockTop = (mm: Mounted, text: string, st: number): number => {
  const i = [...mm.view.dom.children].findIndex((c) => c.textContent?.includes(text))
  return i * H - st
}

beforeEach(() => {
  restore = null
})
afterEach(async () => {
  restore?.()
  await m?.close()
  m = null
})

describe('reload scroll anchor (§12.6)', () => {
  it('blocks inserted above the first visible block move scrollTop by their height; identity and caret kept', async () => {
    m = await mount({ markdown: MD })
    const geo = layout(m)
    geo.setScrollTop(450) // Paragraph 5 is the first visible block, 50 px into it
    const p9 = find(m.view, 'Paragraph 9 text.')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, p9.from + 4)))
    const nodeBefore = m.view.state.doc.child(8)
    expect(blockTop(m, 'Paragraph 5 text.', geo.scrollTop())).toBe(-50)

    await m.fx.agent([{ op: 'insert_after', target: { quote: 'Paragraph 1 text.' }, markdown: 'New A.\n\nNew B.' } as never])
    await until(() => m!.view.state.doc.textContent.includes('New B.'))
    await until(() => geo.scrollTop() !== 450)
    expect(geo.scrollTop()).toBe(650)
    expect(blockTop(m, 'Paragraph 5 text.', geo.scrollTop())).toBe(-50)
    // untouched blocks keep node identity; the caret stays in Paragraph 9 at the same offset
    expect(m.view.state.doc.child(10)).toBe(nodeBefore)
    const sel = m.view.state.selection
    expect(sel.empty).toBe(true)
    expect(sel.from).toBe(find(m.view, 'Paragraph 9 text.').from + 4)
  })

  it('a change below the first visible block leaves scrollTop alone', async () => {
    m = await mount({ markdown: MD })
    const geo = layout(m)
    geo.setScrollTop(450)
    await m.fx.agent([{ op: 'insert_after', target: { quote: 'Paragraph 8 text.' }, markdown: 'Below the fold.' } as never])
    await until(() => m!.view.state.doc.textContent.includes('Below the fold.'))
    await new Promise((r) => setTimeout(r, 50)) // past the rAF the restore runs in
    expect(geo.scrollTop()).toBe(450)
    expect(blockTop(m, 'Paragraph 5 text.', geo.scrollTop())).toBe(-50)
  })

  it('a block removed above the first visible block moves scrollTop up by its height', async () => {
    m = await mount({ markdown: MD })
    const geo = layout(m)
    geo.setScrollTop(450)
    await m.fx.agent([{ op: 'delete_block', target: { quote: 'Paragraph 2 text.' } } as never])
    await until(() => !m!.view.state.doc.textContent.includes('Paragraph 2 text.'))
    await until(() => geo.scrollTop() !== 450)
    expect(geo.scrollTop()).toBe(350)
    expect(blockTop(m, 'Paragraph 5 text.', geo.scrollTop())).toBe(-50)
  })
})
