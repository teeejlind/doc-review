// tests/unit/core/splice/html-promotion.test.ts (P1; CONTRACTS §3.4 HTML promotion, D44, §13 row 91).
//
// Block HTML (a <div> block, an HTML comment, <details> / </details> lines) becomes a raw_block entry with
// mdType 'html', editable in the raw popover; a paragraph mixing text and <span>s is never promoted. Promotion changes
// nothing else: no-op bytes, block hashes, ptext and (hash, start, end, fidelity) are what the unpromoted paragraph
// gives, and an edited raw run verifies through loadRun.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blockHash } from '../../../../core/hash'
import { createMd, type Md } from '../../../../core/md/index'
import { OBJ, ptextOf } from '../../../../core/ptext'
import { applyBlockOps } from '../../../../core/splice/apply'
import { load, loadRun, isEmptyParagraphEntry, isHtmlOnlyParagraph } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import { renderNode } from '../../../../core/splice/render'
import { FIXTURE_DOCS, fixture } from './fixtures'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const sliceOf = (src: string, e: { start: number; end: number }): string => src.slice(e.start, e.end)

describe('block HTML is promoted to raw_block (D44)', () => {
  it('the block-HTML fixture: <div>, comment and <details> lines are raw html; the <span> paragraph is not', () => {
    const src = fixture('syn__block-html.md')
    const L = load(md, src)
    const html = L.entries.filter((e) => e.mdType === 'html')
    expect(html.map((e) => sliceOf(src, e))).toEqual([
      '<div class="callout">\n  <p>Raw block HTML stays byte-exact.</p>\n</div>',
      '<!-- reviewer note: an HTML comment block -->',
      '<details>\n<summary>More detail</summary>',
      '</details>',
    ])
    for (const e of html) {
      expect(e).toMatchObject({ kind: 'raw', mdType: 'html', fidelity: 'exact', reason: 'html' })
      expect(e.nodes).toHaveLength(1)
      expect(e.nodes[0]!.type.name).toBe('raw_block')
      expect(e.nodes[0]!.attrs).toMatchObject({ value: sliceOf(src, e), reason: 'html' })
    }
    const span = L.entries.find((e) => sliceOf(src, e).includes('<span'))!
    expect(span).toMatchObject({ kind: 'md', mdType: 'paragraph' })
    const inline: string[] = []
    span.nodes[0]!.forEach((n) => inline.push(n.type.name))
    expect(inline.filter((t) => t === 'html')).toHaveLength(4)
    // the markdown inside <details> stays an ordinary paragraph
    expect(L.entries.find((e) => sliceOf(src, e).startsWith('Markdown *inside*'))!.kind).toBe('md')
  })

  it('isHtmlOnlyParagraph: html atoms with hardbreaks / whitespace only, at least one atom', () => {
    const p = (s: string): PMNode[] => [md.parseDoc(s).firstChild!]
    expect(isHtmlOnlyParagraph(p('<!-- c -->'))).toBe(true)
    expect(isHtmlOnlyParagraph(p('<br>\n<br>'))).toBe(true)
    expect(isHtmlOnlyParagraph(p('a <span>b</span> c'))).toBe(false)
    expect(isHtmlOnlyParagraph(p('<b>bold</b>'))).toBe(false)
    expect(isHtmlOnlyParagraph(p('plain text'))).toBe(false)
    expect(isHtmlOnlyParagraph([...p('<!-- a -->'), ...p('<!-- b -->')])).toBe(false)
  })

  it('a `<br>`-only line (an empty paragraph in Milkdown) is promoted, so a save never drops it', () => {
    for (const br of ['<br>', '<br />', '<BR/>']) {
      const src = `Above.\n\n${br}\n\nBelow.\n`
      const L = load(md, src)
      expect(L.entries[1]).toMatchObject({ kind: 'raw', mdType: 'html', fidelity: 'exact', reason: 'html' })
      expect(L.entries[1]!.nodes[0]!.attrs.value).toBe(br)
      expect(ptextOf(L.doc, L).text).toBe(`Above.\n${OBJ}\nBelow.`)
      expect(planSave(md, L, L.doc)).toEqual([])
      // an unrelated edit keeps the line
      const next = load(md, src.replace('Below.', 'Below, edited.')).doc
      const r = applyBlockOps(md, L, planSave(md, L, next))
      expect(r.text).toBe(src.replace('Below.', 'Below, edited.'))
      // with fidelityHints it classifies the same way
      const H = load(md, src, { fidelityHints: new Map(L.blocks.map((b) => [b.hash, b.fidelity])) })
      expect(H.blocks).toEqual(L.blocks)
    }
  })

  it('lossy blocks are never promoted (they are already raw with their own mdType)', () => {
    const L = load(md, '[ ](https://example.com)\n')
    expect(L.entries[0]!.kind).toBe('raw')
    expect(L.entries[0]!.mdType).not.toBe('html')
  })
})

describe('promotion changes nothing but kind and mdType', () => {
  // the unpromoted view of an entry: Milkdown's plain parse of its own slice (what S2 load() gave)
  const unpromoted = (src: string, e: { start: number; end: number }): PMNode[] => {
    const nodes: PMNode[] = []
    md.parseDoc(sliceOf(src, e)).forEach((n) => nodes.push(n))
    return nodes
  }

  for (const [name, src] of Object.entries(FIXTURE_DOCS)) {
    it(`${name}: no-op bytes, hashes, ptext and (hash, start, end, fidelity)`, () => {
      const L = load(md, src)
      // no-op round trip
      expect(planSave(md, L, L.doc)).toEqual([])
      expect(applyBlockOps(md, L, []).text).toBe(src)
      for (const [i, e] of L.entries.entries()) {
        expect(L.blocks[i]!.hash).toBe(blockHash(sliceOf(src, e)))
        // (a `<br>`-only line has no unpromoted form worth comparing: it is an empty paragraph, tested above)
        if (e.mdType !== 'html' || isEmptyParagraphEntry(unpromoted(src, e))) continue
        // bytes: renderNode of a raw_block is its value, the source slice
        expect(renderNode(md, e.nodes[0]!, L.eol)).toBe(sliceOf(src, e))
        // fidelity: the unpromoted paragraph re-renders byte-exactly too, so 'exact' is what S2 classified
        const para = unpromoted(src, e)
        expect(para).toHaveLength(1)
        expect(isHtmlOnlyParagraph(para)).toBe(true)
        expect(renderNode(md, para[0]!, L.eol)).toBe(sliceOf(src, e))
      }
      // ptext: a doc with every promoted entry swapped back to its paragraph has the same ptext and block ranges
      const swapped = md.schema.topNodeType.create(
        null,
        L.entries.flatMap((e) => (e.mdType === 'html' && !isEmptyParagraphEntry(unpromoted(src, e)) ? unpromoted(src, e) : e.nodes)).concat(L.entries.length ? [] : [md.schema.nodes.paragraph!.create()]),
      )
      const a = ptextOf(L.doc, L)
      const b = ptextOf(swapped, { entries: L.entries.map((e) => (e.mdType === 'html' && !isEmptyParagraphEntry(unpromoted(src, e)) ? { ...e, nodes: unpromoted(src, e) } : e)) })
      expect(b.text).toBe(a.text)
      expect(b.blockRanges).toEqual(a.blockRanges)
    })
  }

  it('each promoted block is one U+FFFC in ptext, like the html atom it replaced', () => {
    const L = load(md, '<!-- note -->\n\nText.\n')
    expect(ptextOf(L.doc, L).text).toBe(`${OBJ}\nText.`)
  })
})

describe('an edited raw run verifies through loadRun', () => {
  it('replacing a promoted <div> block with edited HTML verifies as raw and changes only its lines', () => {
    const src = fixture('syn__block-html.md')
    const L = load(md, src)
    const i = L.entries.findIndex((e) => sliceOf(src, e).startsWith('<div'))
    const edited = '<div class="callout">\n  <p>Raw block HTML, edited in the popover.</p>\n</div>'
    expect(loadRun(md, edited, L.defs, L.eol).map((n) => [n.type.name, n.attrs.reason])).toEqual([['raw_block', 'html']])
    const r = applyBlockOps(md, L, [{ after: i - 1, before: i + 1, covers: [L.blocks[i]!.hash], blocks: [edited] }])
    expect(r).toMatchObject({ verified: true, widened: [], failed: [] })
    expect(r.text).toBe(src.replace('<p>Raw block HTML stays byte-exact.</p>', '<p>Raw block HTML, edited in the popover.</p>'))
    const R = load(md, r.text)
    expect(R.entries[i]).toMatchObject({ kind: 'raw', mdType: 'html' })
  })

  it('a raw edit that turns block HTML into markdown is an ordinary block afterwards', () => {
    const L = load(md, '<!-- note -->\n\nText.\n')
    const r = applyBlockOps(md, L, [{ after: -1, before: 1, covers: [L.blocks[0]!.hash], blocks: ['A note, now *markdown*.'] }])
    expect(r.verified).toBe(true)
    expect(load(md, r.text).entries[0]).toMatchObject({ kind: 'md', mdType: 'paragraph' })
  })
})
