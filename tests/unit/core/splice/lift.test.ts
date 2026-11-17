// tests/unit/core/splice/lift.test.ts (written by the integrator with the day-0 S2 lift; P1 owns it from M0).
//
// The lifted S2 code behaves as S2 proved (FINDINGS): load() + the oracle save are byte-identical on a no-op over the
// edge cases, a one-word edit touches one line, the list-merge flip fires on a real merge hazard (D36), and the eq.ts
// comparators ignore exactly the volatile attrs and mark order. The full corpus gates are P1's (tests/corpus/run.ts).
import { Fragment, Slice, type Node as PMNode } from '@milkdown/kit/prose/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, SuggestionResidueError, type Md } from '../../../../core/md/index'
import { contentNodes, docsEquivalent, nodeEq, normMdast, VOLATILE_ATTRS } from '../../../../core/splice/eq'
import { load, loadRun } from '../../../../core/splice/load'
import { assertNoSuggestionMarks, parseBlock, parseMdast, renderNode } from '../../../../core/splice/render'
import { oracleSave } from '../../../corpus/oracle-save'

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')

/** A slice of spike/s2/src/synthetic.ts, kept as string literals so git can't touch the bytes. */
const EDGE_CASES: Record<string, string> = {
  crlf: crlf('---\ntitle: CRLF doc\n---\n\n# Heading with CRLF\n\nA paragraph that wraps\nonto a second line.\n\n- item one\n- item two\n  - nested item\n\n| Col A | Col B |\n|:------|------:|\n| 1     | 2     |\n\n> quote line\n'),
  'crlf-no-final-eol': crlf('Para one.\n\nPara two, no final newline.').replace(/\r\n$/, ''),
  bom: '﻿# Title after BOM\n\nBody text.\n',
  'no-trailing-newline': '# Title\n\nLast paragraph without newline',
  'trailing-whitespace': '# Title   \n\nHard break with two spaces  \nnext line.\n\nTrailing tab\t\nhere.\n\n   \n\n\n\nAfter many blank lines (one has spaces).\n\n\n',
  empty: '',
  'whitespace-only': '\n\n   \n',
  'frontmatter-only': '---\ntitle: Only frontmatter\n---\n',
  'mixed-bullets': '* star bullet\n* another star\n\n+ plus bullet\n+ another plus\n\n- dash bullet\n\n3) ordered paren starting at 3\n4) next\n\n- [ ] open task\n- [x] done task\n',
  html: '<div class="x">\n  <p>block html</p>\n</div>\n\n<!-- a comment -->\n\nText with <span>inline</span> html.\n\n<details>\n<summary>More</summary>\n\nHidden body.\n\n</details>\n',
  'refs-footnotes': 'See [the site][site] and a note.[^1]\n\n[site]: https://example.com "Example"\n\n[^1]: The footnote text.\n',
  table: '| A | B |\n|---|:-:|\n| 1 | 2 |\n| x \\| y | `z` |\n',
  escapes: 'Prices \\~40 and \\[TK: fill] and 5 \\* 3, &amp; entity, emoji 👩‍💻 and RTL שלום.\n',
  fences: '~~~\ntilde fence\n~~~\n\n````md\n```nested```\n````\n\n```ts title="x.ts"\nconst a = 1\n```\n',
  'titleless-image': 'Before ![alt](https://x.com/a.png) after.\n',
}

let md: Md

beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

/** Replace the first occurrence of `from` in the text of the doc with `to`, as a user edit would. */
function editText(doc: PMNode, from: string, to: string): PMNode {
  let pos = -1
  doc.descendants((n, p) => {
    if (pos >= 0) return false
    if (n.isText && n.text!.includes(from)) pos = p + n.text!.indexOf(from)
    return true
  })
  if (pos < 0) throw new Error(`"${from}" not in doc`)
  const marks = doc.resolve(pos + 1).marks()
  return doc.replace(pos, pos + from.length, new Slice(Fragment.from(md.schema.text(to, marks)), 0, 0))
}

describe('load() + oracle save: no-op round trip is byte-identical', () => {
  for (const [name, src] of Object.entries(EDGE_CASES)) {
    it(name, () => {
      const L = load(md, src)
      const { text, stats } = oracleSave(md, L, L.doc)
      expect(text).toBe(src)
      expect(stats.verified).toBe(true)
      expect(L.gaps.length).toBe(L.entries.length + 1)
      expect(L.blocks.length).toBe(L.entries.length)
    })
  }
})

describe('load()', () => {
  it('detects the dominant EOL', () => {
    expect(load(md, EDGE_CASES.crlf!).eol).toBe('\r\n')
    expect(load(md, 'a\n\nb\n').eol).toBe('\n')
  })

  it('shifts offsets past a BOM so entry slices are exact', () => {
    const L = load(md, EDGE_CASES.bom!)
    expect(L.src.slice(L.entries[0]!.start, L.entries[0]!.end)).toBe('# Title after BOM')
  })

  it('keeps link reference definitions as a raw gap block and collects defs', () => {
    const L = load(md, EDGE_CASES['refs-footnotes']!)
    const gap = L.entries.find((e) => e.mdType === 'gap')
    expect(gap?.kind).toBe('raw')
    expect(gap?.nodes[0]!.type.name).toBe('raw_block')
    expect(L.defs).toContain('[site]: https://example.com')
    expect(L.defs).toContain('[^1]: The footnote text.')
  })

  it('classifies frontmatter as kind frontmatter', () => {
    const L = load(md, '---\ntitle: x\n---\n\nBody\n')
    expect(L.entries[0]!.kind).toBe('frontmatter')
    expect(L.entries[0]!.mdType).toBe('yaml')
  })

  it('promotes block HTML to a raw_block (D44); the full suite is splice/html-promotion.test.ts', () => {
    const L = load(md, '<!-- a comment -->\n')
    expect(L.entries[0]!).toMatchObject({ kind: 'raw', mdType: 'html', fidelity: 'exact', reason: 'html' })
    expect(L.entries[0]!.nodes[0]!.type.name).toBe('raw_block')
    expect(L.entries[0]!.nodes[0]!.attrs.value).toBe('<!-- a comment -->')
  })

  it('gives an empty doc one empty paragraph and no entries', () => {
    const L = load(md, '')
    expect(L.entries).toEqual([])
    expect(L.doc.childCount).toBe(1)
    expect(contentNodes(L.doc)).toEqual([])
  })
})

describe('loadRun()', () => {
  it('gives the nodes load() gives for the same blocks, with the doc defs as context', () => {
    const src = EDGE_CASES['refs-footnotes']!
    const L = load(md, src)
    const first = L.entries[0]!
    const run = loadRun(md, src.slice(first.start, first.end), L.defs, L.eol)
    expect(run.length).toBe(first.nodes.length)
    run.forEach((n, i) => expect(nodeEq(n, first.nodes[i]!)).toBe(true))
  })

  it('classifies raw runs as raw (a reference definition stays a raw_block)', () => {
    const run = loadRun(md, '[d]: https://example.com', '', '\n')
    expect(run.map((n) => n.type.name)).toEqual(['raw_block'])
    expect(renderNode(md, run[0]!, '\n')).toBe('[d]: https://example.com')
  })

  it('for every non-raw block of every edge case, loadRun gives exactly parse()\'s nodes (§3.4)', () => {
    for (const [name, src] of Object.entries(EDGE_CASES)) {
      const L = load(md, src)
      for (const e of L.entries) {
        if (e.kind === 'raw') continue
        const slice = src.slice(e.start, e.end)
        const run = loadRun(md, slice, L.defs, L.eol)
        const parsed = parseBlock(md, slice, L.defs)
        expect(run.length, `${name}: ${slice.slice(0, 30)}`).toBe(parsed.length)
        run.forEach((n, i) => expect(nodeEq(n, parsed[i]!), `${name}: ${slice.slice(0, 30)}`).toBe(true))
      }
    }
  })

  it('splits a multi-block run into its blocks', () => {
    expect(loadRun(md, '# A\n\nPara\n\n- x', '', '\n').map((n) => n.type.name)).toEqual(['heading', 'paragraph', 'bullet_list'])
  })
})

describe('oracle save: edits', () => {
  it('a one-word edit changes only that block line, CRLF kept', () => {
    const src = EDGE_CASES.crlf!
    const L = load(md, src)
    const { text, stats } = oracleSave(md, L, editText(L.doc, 'second', 'third'))
    expect(stats.verified).toBe(true)
    const a = src.split('\r\n')
    const b = text.split('\r\n')
    expect(b.length).toBe(a.length)
    expect(a.filter((l, i) => l !== b[i])).toEqual(['onto a second line.'])
  })

  it('a table-cell edit keeps the delimiter row (3-way region splice)', () => {
    const src = EDGE_CASES.table!
    const L = load(md, src)
    const { text, stats } = oracleSave(md, L, editText(L.doc, '2', '3'))
    expect(stats.verified).toBe(true)
    expect(text.split('\n')[1]).toBe('|---|:-:|')
  })

  it('deleting the paragraph between two same-marker lists flips the second list (D36)', () => {
    const src = '- a\n\nPara\n\n- b\n'
    const L = load(md, src)
    const kept = contentNodes(L.doc).filter((n) => n.type.name !== 'paragraph')
    const { text, stats } = oracleSave(md, L, md.schema.topNodeType.create(null, kept))
    expect(text).toBe('- a\n\n* b\n')
    expect(stats.listMarkerSwaps).toBe(1)
    expect(stats.verified).toBe(true)
  })

  it('an inserted paragraph gets blank-line seams, the original gap follows it', () => {
    const src = '# T\n\n\n\nBody\n'
    const L = load(md, src)
    const nodes = contentNodes(L.doc)
    const fresh = md.schema.nodes.paragraph!.create(null, md.schema.text('New'))
    const { text, stats } = oracleSave(md, L, md.schema.topNodeType.create(null, [nodes[0]!, fresh, nodes[1]!]))
    expect(stats.verified).toBe(true)
    expect(text).toBe('# T\n\nNew\n\n\n\nBody\n')
  })

  it('refuses a doc that still carries suggestion marks', () => {
    const L = load(md, 'Hello\n')
    const ins = md.schema.marks.insertion!.create({ id: 1 })
    const doc = md.schema.topNodeType.create(null, md.schema.nodes.paragraph!.create(null, md.schema.text('Hello', [ins])))
    expect(() => oracleSave(md, L, doc)).toThrow(SuggestionResidueError)
    expect(() => assertNoSuggestionMarks(doc)).toThrow(SuggestionResidueError)
  })
})

describe('eq.ts comparators', () => {
  it('nodeEq ignores heading.id and list_item.label only', () => {
    expect(VOLATILE_ATTRS).toEqual({ heading: ['id'], list_item: ['label'] })
    const h = md.parseDoc('# Title').firstChild!
    const withId = h.type.create({ ...h.attrs, id: 'title' }, h.content)
    expect(nodeEq(h, withId)).toBe(true)
    const otherLevel = h.type.create({ ...h.attrs, level: 2 }, h.content)
    expect(nodeEq(h, otherLevel)).toBe(false)
  })

  it('docsEquivalent ignores top-level empty paragraphs', () => {
    const a = md.parseDoc('One\n\nTwo')
    const empty = md.schema.nodes.paragraph!.create()
    const b = md.schema.topNodeType.create(null, [empty, ...contentNodes(a), empty])
    expect(docsEquivalent(a, b)).toBe(true)
    expect(docsEquivalent(a, md.parseDoc('One\n\nThree'))).toBe(false)
  })

  it('normMdast treats mark nesting order as equal, content changes as different', () => {
    const n = (s: string) => JSON.stringify(normMdast(parseMdast(md, s).children))
    expect(n('[**x**](u)')).toBe(n('**[x](u)**'))
    expect(n('[**x**](u)')).not.toBe(n('[**y**](u)'))
  })
})
