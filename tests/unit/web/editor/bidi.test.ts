// tests/unit/web/editor/bidi.test.ts (QA round 3, theme-polish: RTL text). Blocks carry dir="auto", so a paragraph,
// heading, list item or quote whose first strong character is Arabic or Hebrew reads right to left and aligns right,
// each on its own (a mixed document keeps its English blocks left to right). The attribute is a node decoration: it
// is not in the markdown, and a block typed later gets it too.
import { afterEach, describe, expect, it } from 'vitest'
import { caret, mount, press, typeKeys, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const DOC = ['# مرحبا بالعالم', '', 'هذه فقرة بالعربية.', '', '- بند أول', '- بند ثان', '', '> اقتباس بالعربية', '', 'פסקה בעברית.', '', 'An English paragraph.', '', '```js', 'const a = 1', '```', ''].join('\n')

const dirOf = (el: Element | null): string | null => el?.getAttribute('dir') ?? null

describe('RTL text (dir="auto")', () => {
  it('top-level headings and paragraphs, lists and quotes carry dir="auto"; what is inside a list or quote, and code, do not', async () => {
    m = await mount({ markdown: DOC })
    const root = m.view.dom
    expect(dirOf(root.querySelector('h1'))).toBe('auto')
    for (const p of Array.from(root.querySelectorAll(':scope > p'))) expect(dirOf(p)).toBe('auto')
    expect(dirOf(root.querySelector('ul'))).toBe('auto')
    expect(dirOf(root.querySelector('blockquote'))).toBe('auto')
    for (const el of Array.from(root.querySelectorAll('li, li > p, blockquote > p'))) expect(dirOf(el)).toBeNull()
    expect(dirOf(root.querySelector('pre'))).toBeNull()
  })

  it('a paragraph typed later gets it too, and the markdown on disk is unchanged by it', async () => {
    m = await mount({ markdown: 'First.\n' })
    caret(m.view, 'First.', { at: 'end' })
    press(m, 'Enter')
    typeKeys(m.view, 'مرحبا')
    expect([...m.view.dom.querySelectorAll(':scope > p')].map(dirOf)).toEqual(['auto', 'auto'])
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe('First.\n\nمرحبا\n')
  })
})
