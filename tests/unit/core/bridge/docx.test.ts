// tests/unit/core/bridge/docx.test.ts. The Word export (core/bridge/docx.ts): a valid stored zip, well-formed parts,
// and every comment range covering exactly the thread's ptext span, including the second of two identical quotes, a
// range across list items, a table cell, emoji, inline code and a link. Replies thread under their parent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { buildDocx, crc32, zipStore } from '../../../../core/bridge/docx'
import type { ExportThread } from '../../../../core/bridge/export-plan'
import { createMd, type Md } from '../../../../core/md/index'
import { ptextOf } from '../../../../core/ptext'
import { load } from '../../../../core/splice/load'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

/** Read a STORE-only zip back: name → UTF-8 text. */
function unzip(b: Uint8Array): Map<string, string> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out = new Map<string, string>()
  let p = 0
  while (v.getUint32(p, true) === 0x04034b50) {
    expect(v.getUint16(p + 8, true)).toBe(0)
    const crc = v.getUint32(p + 14, true)
    const size = v.getUint32(p + 18, true)
    const nlen = v.getUint16(p + 26, true)
    const name = new TextDecoder().decode(b.subarray(p + 30, p + 30 + nlen))
    const data = b.subarray(p + 30 + nlen, p + 30 + nlen + size)
    expect(crc32(data)).toBe(crc)
    out.set(name, new TextDecoder().decode(data))
    p += 30 + nlen + size
  }
  expect(v.getUint32(b.length - 22, true)).toBe(0x06054b50)
  return out
}

const parse = (xml: string): Document => {
  const d = new JSDOM(xml, { contentType: 'application/xml' }).window.document
  expect(d.getElementsByTagName('parsererror').length).toBe(0)
  return d
}

/** Comment id → the text between its range start and end, walking document.xml in order (⏎ between paragraphs). */
function rangeTexts(xml: string): Map<string, string> {
  const open = new Map<string, string>()
  const done = new Map<string, string>()
  for (const m of xml.matchAll(/<w:commentRangeStart w:id="(\d+)"\/>|<w:commentRangeEnd w:id="(\d+)"\/>|<w:t(?: [^>]*)?>(.*?)<\/w:t>|<w:br\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) open.set(m[1], '')
    else if (m[2] !== undefined) {
      done.set(m[2], open.get(m[2])!)
      open.delete(m[2])
    } else {
      const add = m[3] !== undefined ? m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : '⏎'
      for (const [k, s] of open) open.set(k, s + add)
    }
  }
  return done
}

const DOC = `---
owner: x
---

# Launch brief

Acme Co offers **garden classes** at a 12% member price. See [our site](https://example.com).

- Paid social
- Email
    - Segment A

1. Draft copy
2. Proofreading pass

| Channel | Budget |
| --- | --- |
| Meta | $40k |

Again: 12% member price, and \`inline code\` here.

Last line with café ☕ and 🎉.
`

describe('buildDocx', () => {
  it('crc32 and the zip container', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    const z = unzip(zipStore([['a.txt', 'hello'], ['dir/ü.xml', '<x/>']]))
    expect([...z.entries()]).toEqual([['a.txt', 'hello'], ['dir/ü.xml', '<x/>']])
  })

  it('anchors every open thread on its exact span and threads replies', () => {
    const L = load(md, DOC)
    const ptext = ptextOf(L.doc, L).text
    const span = (q: string, occ = 1): { from: number; to: number } => {
      let at = -1
      for (let i = 0; i < occ; i++) at = ptext.indexOf(q, at + 1)
      return { from: at, to: at + q.length }
    }
    const th = (id: string, q: string, occ = 1, replies = 0): ExportThread => ({
      id, span: span(q, occ), quote: q,
      messages: [{ who: 'Ana Díaz', at: '2026-11-16T10:00:00.000Z', body: `on ${q}` }, ...Array.from({ length: replies }, (_, i) => ({ who: 'Claude', body: `reply ${i + 1}` }))],
    })
    const threads: ExportThread[] = [
      th('a', 'garden classes'),
      th('b', '12% member price', 2, 2),
      th('c', 'Email\nSegment A'),
      th('d', '$40k'),
      th('e', 'inline code'),
      th('f', 'café ☕ and 🎉'),
      th('g', 'our site'),
      { id: 'h', span: null, quote: 'deleted words', messages: [{ who: 'Claude', body: 'orphan' }] },
    ]
    const built = buildDocx(L.doc, threads, { title: 'Launch brief', author: 'Ana Díaz', now: new Date('2026-11-16T12:00:00Z') })
    expect(built).toMatchObject({ comments: 8, replies: 2, general: 1 })
    const files = unzip(built.bytes)
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/comments.xml', 'word/commentsExtended.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
      expect(files.has(name), name).toBe(true)
      parse(files.get(name)!)
    }
    const doc = files.get('word/document.xml')!
    const ranges = rangeTexts(doc)
    const comments = parse(files.get('word/comments.xml')!)
    const byBody = new Map<string, string>()
    for (const c of Array.from(comments.getElementsByTagName('w:comment'))) byBody.set(c.textContent ?? '', c.getAttribute('w:id')!)
    const rangeOf = (body: string): string | undefined => ranges.get(byBody.get(body)!)
    expect(rangeOf('on garden classes')).toBe('garden classes')
    expect(rangeOf('on 12% member price')).toBe('12% member price')
    expect(rangeOf('on Email\nSegment A')).toBeUndefined()            // multi-line bodies split into paragraphs
    expect(ranges.get(byBody.get('on EmailSegment A')!)).toBe('Email⏎Segment A')
    expect(rangeOf('on $40k')).toBe('$40k')
    expect(rangeOf('on inline code')).toBe('inline code')
    expect(rangeOf('on café ☕ and 🎉')).toBe('café ☕ and 🎉')
    expect(rangeOf('on our site')).toBe('our site')
    expect(rangeOf('(General comment on “deleted words”) orphan')).toBe('Launch brief')
    // the second yield mention: its range starts after the first one's paragraph
    const startB = doc.indexOf(`<w:commentRangeStart w:id="${byBody.get('on 12% member price')}"/>`)
    expect(doc.indexOf('Again: ')).toBeLessThan(startB)
    // replies thread under the first message of their thread
    const ex = parse(files.get('word/commentsExtended.xml')!)
    const parents = Array.from(ex.getElementsByTagName('w15:commentEx')).filter((e) => e.getAttribute('w15:paraIdParent'))
    expect(parents).toHaveLength(2)
    expect(new Set(parents.map((e) => e.getAttribute('w15:paraIdParent'))).size).toBe(1)
    // the author is a real Word author, and the frontmatter is not in the body
    expect(Array.from(comments.getElementsByTagName('w:comment')).map((c) => c.getAttribute('w:author'))).toContain('Ana Díaz')
    expect(doc).not.toContain('owner: x')
    expect(files.get('word/settings.xml')).toContain('w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"')
    expect(files.get('word/_rels/document.xml.rels')).toContain('Target="https://example.com" TargetMode="External"')
  })

  it('a doc with no threads has no comment parts', () => {
    const L = load(md, '# Hi\n\nText.\n')
    const files = unzip(buildDocx(L.doc, [], { title: 'Hi', author: 'A' }).bytes)
    expect(files.has('word/comments.xml')).toBe(false)
    expect(files.get('[Content_Types].xml')).not.toContain('comments')
  })
})
