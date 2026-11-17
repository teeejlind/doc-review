// tests/unit/core/ptext/ptext.test.ts (P1; CONTRACTS §5.1 ptext, normative).
//
// Golden cases: atom blocks and inline leaves are one U+FFFC each, hardbreak is '\n', top-level empty paragraphs are
// skipped entirely while nested empty textblocks are empty segments, nested textblocks (lists, quotes, table cells,
// footnote definitions) contribute in document order; offsets and PM positions map both ways.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { OBJ, ptextOf, segmentsOf } from '../../../../core/ptext'
import { load } from '../../../../core/splice/load'
import { FIXTURE_DOCS } from '../splice/fixtures'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const P = (src: string): string => {
  const L = load(md, src)
  return ptextOf(L.doc, L).text
}

describe('golden cases', () => {
  it('atom blocks: frontmatter, hr, a raw gap and promoted block HTML are one U+FFFC each', () => {
    expect(P('---\nk: v\n---\n\nA\n\n---\n\nB\n\n[d]: https://x.example\n\n<!-- c -->\n')).toBe([OBJ, 'A', OBJ, 'B', OBJ, OBJ].join('\n'))
  })

  it('inline leaves: image, inline html and footnote_reference are U+FFFC; hardbreak is \\n; marks drop', () => {
    expect(P('a ![i](x.png) b <span>c</span> d[^1] **e**  \nf\n\n[^1]: note\n')).toBe(`a ${OBJ} b ${OBJ}c${OBJ} d${OBJ} e\nf\nnote`)
  })

  it('nested textblocks: list items (and nested lists), blockquotes, table cells, code blocks', () => {
    expect(P('- one\n  - two\n- three\n')).toBe('one\ntwo\nthree')
    expect(P('> q1\n>\n> q2\n')).toBe('q1\nq2')
    expect(P('| a | b |\n|---|---|\n| c | d |\n')).toBe('a\nb\nc\nd')
    expect(P('```js\nline 1\nline 2\n```\n')).toBe('line 1\nline 2')
  })

  it('a nested empty textblock is an empty segment (and a top-level empty heading, not being a paragraph, too)', () => {
    expect(P('| a | |\n|---|---|\n| | d |\n')).toBe('a\n\n\nd')
    expect(P('#\n\nx\n')).toBe('\nx')
    // a bare "-" is an empty list item (an editable list since QA2 30; it used to fail the round trip and become a raw block)
    expect(P('- a\n-\n- b\n')).toBe('a\n\nb')
  })

  it('top-level empty paragraphs are skipped entirely, with no separator', () => {
    const L = load(md, 'A\n\nB\n')
    const kids = [md.schema.nodes.paragraph!.create(), L.doc.child(0), md.schema.nodes.paragraph!.create(), L.doc.child(1), md.schema.nodes.paragraph!.create()]
    const live = md.schema.topNodeType.create(null, kids)
    const p = ptextOf(live, L)
    expect(p.text).toBe('A\nB')
    expect(p.blockRanges).toEqual([{ index: 0, pStart: 0, pEnd: 1 }, { index: 1, pStart: 2, pEnd: 3 }])
    expect(P('')).toBe('')
  })

  it('no Unicode normalization: emoji, ZWJ, combining marks and RTL pass through verbatim', () => {
    const s = 'é 👩‍💻 שלום café'
    expect(P(`${s}\n`)).toBe(s)
  })
})

describe('offset ↔ position mapping', () => {
  const SRC = '---\nk: v\n---\n\n# Head\n\nLine one  \nline two ![i](x.png) end.\n\n- a\n- b\n\n---\n\n| c | d |\n|---|---|\n| e | f |\n'

  it('toOffset(toPos(o)) === o for every offset, both biases agree inside a segment', () => {
    const L = load(md, SRC)
    const p = ptextOf(L.doc, L)
    for (let o = 0; o <= p.text.length; o++) {
      expect(p.toOffset(p.toPos(o, 1))).toBe(o)
      const prev = p.text[o - 1]
      if (o > 0 && prev !== '\n') expect(p.toPos(o, -1)).toBe(p.toPos(o, 1))
    }
  })

  it('the text at a mapped position is the ptext character (text nodes)', () => {
    const L = load(md, SRC)
    const p = ptextOf(L.doc, L)
    for (const word of ['Head', 'line two', 'end.', 'e']) {
      const o = p.text.indexOf(word)
      const pos = p.toPos(o, 1)
      expect(L.doc.textBetween(pos, pos + word.length)).toBe(word)
    }
  })

  it('bias -1 at a segment start maps to the end of the previous segment', () => {
    const L = load(md, 'A\n\nB\n')
    const p = ptextOf(L.doc, L)
    expect(p.toPos(2, 1)).toBe(4)
    expect(p.toPos(2, -1)).toBe(2)
  })

  it('positions outside every segment map to null', () => {
    const L = load(md, 'A\n\nB\n')
    const p = ptextOf(L.doc, L)
    expect(p.toOffset(0)).toBeNull() // before the first paragraph opens
    expect(p.toOffset(3)).toBeNull() // between the two paragraphs
  })

  it('blockAt: offsets inside, at the ends of and past the blocks', () => {
    const L = load(md, '# T\n\nAB\n\nCD\n')
    const p = ptextOf(L.doc, L)
    expect(p.text).toBe('T\nAB\nCD')
    expect(p.blockAt(0)).toEqual({ index: 0, offsetInBlock: 0 })
    expect(p.blockAt(1)).toEqual({ index: 0, offsetInBlock: 1 })
    expect(p.blockAt(2)).toEqual({ index: 1, offsetInBlock: 0 })
    expect(p.blockAt(4)).toEqual({ index: 1, offsetInBlock: 2 })
    expect(p.blockAt(7)).toEqual({ index: 2, offsetInBlock: 2 })
    expect(p.blockAt(99)).toEqual({ index: 2, offsetInBlock: 94 })
  })
})

describe('per-block segments', () => {
  it('segmentsOf(entry.nodes).join("\\n") is each block range of ptextOf, for every fixture', () => {
    for (const [name, src] of Object.entries(FIXTURE_DOCS)) {
      const L = load(md, src)
      const p = ptextOf(L.doc, L)
      expect(p.blockRanges.length, name).toBe(L.entries.length)
      L.entries.forEach((e, i) => {
        const r = p.blockRanges[i]!
        expect(segmentsOf(e.nodes).join('\n'), `${name} block ${i}`).toBe(p.text.slice(r.pStart, r.pEnd))
        if (i > 0) expect(r.pStart, `${name} block ${i}`).toBe(p.blockRanges[i - 1]!.pEnd + 1)
      })
    }
  })
})
