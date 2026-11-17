// tests/unit/web/editor/t2-editor-ux-images.test.ts (T2 editor-ux, Pass 4 #28): images beside the markdown file.
// `![x](./pic.png)` is the file next to the document, which the page can't reach as written (it lives at /). The image
// view loads a relative src through GET /api/asset; the node keeps the src the markdown says, so nothing saved changes.
import { afterEach, describe, expect, it } from 'vitest'
import { assetUrl } from '../../../../web/src/editor/assets'
import { caret, mount, saved, typeAt, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const CTX = { file: 'notes/plan.md', token: 'tok/en' }
const via = (path: string): string => `/api/asset?file=notes%2Fplan.md&path=${encodeURIComponent(path)}&t=tok%2Fen`

describe('assetUrl: which srcs go through the server', () => {
  it('a relative path does, with the document and token named', () => {
    expect(assetUrl('./pic.png', CTX)).toBe(via('./pic.png'))
    expect(assetUrl('images/pic.png', CTX)).toBe(via('images/pic.png'))
    expect(assetUrl('../shared/pic.png', CTX)).toBe(via('../shared/pic.png'))
  })

  it('the browser decodes %20 and drops a ?query or #fragment before it reaches a file; so does this', () => {
    expect(assetUrl('./my%20pic.png', CTX)).toBe(via('./my pic.png'))
    expect(assetUrl('./pic.png?raw=true', CTX)).toBe(via('./pic.png'))
    expect(assetUrl('./pic.png#top', CTX)).toBe(via('./pic.png'))
    expect(assetUrl('./100%.png', CTX)).toBe(via('./100%.png'))
  })

  it('an address, a data: or blob: URI, a root path and a #fragment load as written', () => {
    for (const src of ['https://example.com/a.png', 'http://example.com/a.png', '//cdn.example.com/a.png', 'data:image/png;base64,AAAA', 'blob:http://x/1', '/abs/a.png', '#frag', 'C:\\x.png', '', '   ', '?x=1']) {
      expect(assetUrl(src, CTX), JSON.stringify(src)).toBeNull()
    }
  })
})

describe('the image view', () => {
  const MD = 'Before.\n\n![local](./local.png)\n\n![remote alt text](./images/pic.png "A title")\n\n![web](https://example.com/w.png)\n\nAfter.\n'
  // (ProseMirror puts src-less <img class="ProseMirror-separator"> hacks around inline atoms)
  const imgs = (mm: Mounted): HTMLImageElement[] => Array.from(mm.host.querySelectorAll<HTMLImageElement>('img:not(.ProseMirror-separator)'))

  it('loads a relative image through the server and leaves a web one alone, with alt and title', async () => {
    m = await mount({ markdown: MD })
    const [a, b, c] = imgs(m)
    expect(a!.getAttribute('src')).toBe(`/api/asset?file=doc.md&path=${encodeURIComponent('./local.png')}&t=${encodeURIComponent(m.internals.boot.token)}`)
    expect(a!.getAttribute('alt')).toBe('local')
    expect(b!.getAttribute('src')).toContain(`path=${encodeURIComponent('./images/pic.png')}`)
    expect(b!.getAttribute('alt')).toBe('remote alt text')
    expect(b!.getAttribute('title')).toBe('A title')
    expect(c!.getAttribute('src')).toBe('https://example.com/w.png')
  })

  it('the node keeps the markdown src, so the saved file is byte-for-byte what was opened, before and after an edit', async () => {
    m = await mount({ markdown: MD })
    const srcs: string[] = []
    m.view.state.doc.descendants((n) => {
      if (n.type.name === 'image') srcs.push(String(n.attrs.src))
    })
    expect(srcs).toEqual(['./local.png', './images/pic.png', 'https://example.com/w.png'])
    expect(await saved(m)).toBe(MD)
    caret(m.view, 'After.', { at: 'start' })
    typeAt(m.view, m.view.state.selection.from, 'Edited. ')
    expect(await saved(m)).toBe(MD.replace('After.', 'Edited. After.'))
    expect(imgs(m)[0]!.getAttribute('src')).toContain('/api/asset?')
  })

  it('an image in a table cell and in a list item is rewritten too', async () => {
    m = await mount({ markdown: '| a |\n|---|\n| ![in cell](./cell.png) |\n\n- ![in list](./item.png)\n' })
    expect(imgs(m).map((i) => i.getAttribute('src')!.includes('/api/asset?'))).toEqual([true, true])
  })
})
