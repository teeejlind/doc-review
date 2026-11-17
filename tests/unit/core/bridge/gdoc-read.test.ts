// tests/unit/core/bridge/gdoc-read.test.ts. Google Docs read_doc JSON → markdown + review items
// (core/bridge/gdoc-read.ts). The load-bearing property: the plain text the importer computes equals the ptext the
// store will compute for the markdown it wrote, so every comment's quote and occurrence land on the same span.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mapRange, occurrenceAt, parseGdoc, unescapeHtml, type GStructural } from '../../../../core/bridge/gdoc-read'
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

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../fixtures/gdocs/${name}`, import.meta.url), 'utf8'))
const ptext = (markdown: string): string => {
  const L = load(md, markdown)
  return ptextOf(L.doc, L).text
}

/** Build a body from paragraphs of runs, assigning Google indices the way documents.get does. */
function body(paras: Array<{ runs: Array<string | { t: string; s?: Record<string, unknown>; ins?: string[]; del?: string[] }>; style?: string; bullet?: { listId: string; nestingLevel?: number } }>): GStructural[] {
  const out: GStructural[] = [{ endIndex: 1, sectionBreak: {} }]
  let i = 1
  for (const p of paras) {
    const start = i
    const elements = p.runs.map((r, k) => {
      const run = typeof r === 'string' ? { t: r } : r
      const t = k === p.runs.length - 1 ? run.t + '\n' : run.t
      const el = { startIndex: i, endIndex: i + t.length, textRun: { content: t, textStyle: run.s ?? {}, ...(run.ins ? { suggestedInsertionIds: run.ins } : {}), ...(run.del ? { suggestedDeletionIds: run.del } : {}) } }
      i += t.length
      return el
    })
    out.push({ startIndex: start, endIndex: i, paragraph: { elements, paragraphStyle: { namedStyleType: p.style ?? 'NORMAL_TEXT' }, ...(p.bullet ? { bullet: p.bullet } : {}) } })
  }
  return out
}
const doc = (content: GStructural[], extra: Record<string, unknown> = {}): unknown => ({ content: { title: 'T', tabs: [{ documentTab: { body: { content }, ...extra } }] } })

describe('parseGdoc on the spike fixtures', () => {
  it('converts the spike doc and its text equals the markdown ptext', () => {
    const r = parseGdoc(fixture('spike-small.read_doc.json'))
    expect(ptext(r.markdown)).toBe(r.text)
    expect(r.markdown).toContain('# Spike heading one')       // the original text, not the suggested one
    expect(r.markdown).toContain('**bold text**')
    expect(r.markdown).toContain('[link to example](<https://example.com>)')
    expect(r.markdown).toContain('    - Nested bullet')
    expect(r.markdown).toContain('2. Numbered two')
    expect(r.markdown).toContain('| Beta | café ☕ |')
    expect(r.markdown).toContain('`inline code`')
  })

  it('maps every anchored comment onto its exact span, including the second of two identical quotes', () => {
    const r = parseGdoc(fixture('spike-small.read_doc.json'))
    const by = new Map(r.threads.map((t) => [t.body, t]))
    const spans = [...by.values()].filter((t) => t.anchor.kind === 'text')
    for (const t of spans) {
      if (t.anchor.kind !== 'text') continue
      expect(r.text.slice(t.anchor.from, t.anchor.to)).toBe(t.anchor.quote)
    }
    expect(by.get('C2 on SECOND pricing claim')!.anchor).toMatchObject({ kind: 'text', quote: 'pricing claim', occurrence: 2 })
    expect(by.get('C3 on table cell café')!.anchor).toMatchObject({ kind: 'text', quote: 'café ☕' })
    expect(by.get('C4 on emoji')!.anchor).toMatchObject({ kind: 'text', quote: 'emoji 🎉' })
    expect(by.get('C5 spanning two list items')!.anchor).toMatchObject({ kind: 'text', quote: 'Numbered one\nNumbered two' })
    expect(by.get('C5 spanning two list items')!.resolved).toBe(true)
    expect(by.get('C1 on bold text')!.replies).toEqual([{ author: 'Sam Example', body: 'Reply R1 to C1', at: '2026-11-16T17:20:20.863Z' }])
  })

  it('a comment whose anchor is gone becomes doc-level and keeps its quote', () => {
    const r = parseGdoc(fixture('spike-small.read_doc.json'))
    const t = r.threads.find((x) => x.body === 'Cut this whole claim')!
    expect(t.anchor).toEqual({ kind: 'doc', quote: 'pricing claim', why: 'ANCHOR_DELETED' })
    expect(r.threads[r.threads.length - 1]).toBe(t)        // doc-level threads sort last
    const real = parseGdoc(fixture('spike-deleted-anchor.read_doc.json'))
    expect(real.threads.find((x) => x.body === 'A: will lose its text')!.anchor).toMatchObject({ kind: 'doc', why: 'ANCHOR_DELETED' })
    expect(ptext(real.markdown)).toBe(real.text)
  })

  it('turns a tracked suggestion into quote → replacement on the original text', () => {
    const r = parseGdoc(fixture('spike-small.read_doc.json'))
    expect(r.suggestions).toEqual([{ sourceId: 'suggest.djlqpnuwyau1', author: 'Sam Example', from: 0, to: 6, del: 'Spike ', ins: 'Proof ', summary: 'Replace: “Spike” with “Proof”', multiBlock: false }])
  })

  it('accepts the bare documents.get body and a JSON string', () => {
    const raw = fixture('spike-small.read_doc.json') as { content: unknown }
    expect(parseGdoc(raw.content).markdown).toBe(parseGdoc(raw).markdown)
    expect(parseGdoc(JSON.stringify(raw)).markdown).toBe(parseGdoc(raw).markdown)
  })

  it('refuses something that is not a read_doc result', () => {
    expect(() => parseGdoc({ hello: 1 })).toThrow(/not a Google Docs read_doc result/)
  })
})

describe('parseGdoc edge cases (text must stay equal to ptext)', () => {
  const cases: Array<[string, Parameters<typeof body>[0]]> = [
    ['markdown metacharacters', [{ runs: ['Use *stars*, _under_, `ticks`, [brackets], <tags>, a\\b and ~tilde~ & AT&T &amp; literally.'] }]],
    ['line-start lookalikes', [{ runs: ['# not a heading'] }, { runs: ['- not a list'] }, { runs: ['1. not ordered'] }, { runs: ['---'] }]],
    ['styled runs with edge whitespace', [{ runs: ['a', { t: ' bold ', s: { bold: true } }, 'b', { t: 'it', s: { italic: true } }, { t: 'both', s: { bold: true, italic: true } }, { t: 'x`y', s: { weightedFontFamily: { fontFamily: 'Courier New' } } }, { t: 'gone', s: { strikethrough: true } }] }]],
    ['soft line breaks', [{ runs: ['one\u000btwo'] }, { runs: ['Head\u000bline'], style: 'HEADING_2' }]],
    ['unicode', [{ runs: ['Ñandú 🇨🇴 👩🏽‍💻 日本語 ﬁ é'] }]],
    ['empty paragraphs skipped', [{ runs: ['a'] }, { runs: [''] }, { runs: [''] }, { runs: ['b'] }]],
  ]
  for (const [name, paras] of cases) {
    it(name, () => {
      const r = parseGdoc(doc(body(paras)))
      expect(ptext(r.markdown)).toBe(r.text)
    })
  }

  it('maps a range that covers only proposed text to the doc', () => {
    const content = body([{ runs: ['keep ', { t: 'NEW', ins: ['s1'] }, ' end'] }])
    const r = parseGdoc(doc(content, { commentAnchors: { a1: { ranges: [{ startIndex: 6, endIndex: 9 }] } } }) as never)
    void r
    const withComment = parseGdoc({ content: { title: 'T', comments: [{ commentId: 'c', anchorId: 'a1', headPost: { content: 'on new text' }, plainTextQuote: 'NEW' }], tabs: [{ documentTab: { body: { content }, commentAnchors: { a1: { ranges: [{ startIndex: 6, endIndex: 9 }] } } } }] } })
    expect(withComment.threads[0]!.anchor).toEqual({ kind: 'doc', quote: 'NEW', why: 'IN_SUGGESTED_TEXT' })
    expect(withComment.suggestions[0]).toMatchObject({ from: 5, to: 5, del: '', ins: 'NEW', multiBlock: false })
    expect(withComment.text).toBe('keep  end')
  })

  it('a suggestion that inserts a whole paragraph is flagged multiBlock', () => {
    const content = body([{ runs: ['first'] }, { runs: [{ t: 'added paragraph', ins: ['s2'] }] }, { runs: ['last'] }])
    // the inserted paragraph's own newline is part of the insertion
    const p = content[2]!.paragraph!.elements![0]!.textRun!
    p.suggestedInsertionIds = ['s2']
    const r = parseGdoc(doc(content))
    expect(r.suggestions[0]).toMatchObject({ sourceId: 's2', ins: 'added paragraph', multiBlock: true })
    expect(ptext(r.markdown)).toBe(r.text)
  })

  it('table cells with several paragraphs, pipes and an empty cell', () => {
    const cell = (start: number, texts: string[]): { content: GStructural[]; next: number } => {
      let i = start + 1
      const content: GStructural[] = texts.map((t) => {
        const s = i
        i += t.length + 1
        return { startIndex: s, endIndex: i, paragraph: { elements: [{ startIndex: s, endIndex: i, textRun: { content: t + '\n' } }] } }
      })
      return { content, next: i }
    }
    const c1 = cell(3, ['A|B'])
    const c2 = cell(c1.next, ['line one', 'line two'])
    const r2s = c2.next + 1
    const c3 = cell(r2s, [''])
    const c4 = cell(c3.next, ['x'])
    const content: GStructural[] = [
      { endIndex: 1, sectionBreak: {} },
      { startIndex: 1, endIndex: c4.next + 1, table: { tableRows: [{ tableCells: [{ content: c1.content }, { content: c2.content }] }, { tableCells: [{ content: c3.content }, { content: c4.content }] }] } },
    ]
    const r = parseGdoc(doc(content))
    expect(r.markdown).toContain('| A\\|B | line one line two |')
    expect(ptext(r.markdown)).toBe(r.text)
  })
})

describe('helpers', () => {
  it('unescapeHtml', () => {
    expect(unescapeHtml('caf&#233; &amp; &lt;b&gt; &#x1F389; &quot;q&quot; &#39;s&#39; &bogus;')).toBe('café & <b> 🎉 "q" \'s\' &bogus;')
  })
  it('occurrenceAt counts overlapping hits like core/quote.ts', () => {
    expect(occurrenceAt('aaaa', 'aa', 0)).toBe(1)
    expect(occurrenceAt('aaaa', 'aa', 1)).toBe(2)
    expect(occurrenceAt('x pricing y pricing', 'pricing', 12)).toBe(2)
  })
  it('mapRange skips structural indices', () => {
    const m = new Map([[5, 0], [6, 1], [9, 2]])
    expect(mapRange(m, 5, 10)).toEqual({ from: 0, to: 3 })
    expect(mapRange(m, 7, 9)).toBeNull()
  })
})
