// tests/unit/core/bridge/import-plan.test.ts. What import-gdoc posts for a parsed Google Doc (core/bridge/import-plan.ts).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGdoc } from '../../../../core/bridge/gdoc-read'
import { contextSpan, messageBody, planImport } from '../../../../core/bridge/import-plan'

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../fixtures/gdocs/${name}`, import.meta.url), 'utf8'))

describe('planImport', () => {
  it('one step per open thread and per suggestion; resolved threads skipped unless asked', () => {
    const imp = parseGdoc(fixture('spike-small.read_doc.json'))
    const plan = planImport(imp)
    expect(plan.skipped.resolvedThreads).toBe(1)
    expect(plan.steps.map((s) => s.kind)).toEqual(['thread', 'thread', 'thread', 'thread', 'thread', 'suggestion'])
    const c2 = plan.steps.find((s) => s.sourceId === 'doco.C2')!
    expect(c2.op).toEqual({ op: 'comment', quote: 'pricing claim', occurrence: 2, body: 'Pat Author: C2 on SECOND pricing claim', key: 'gdoc:spike-small:doco.C2' })
    const c1 = plan.steps.find((s) => s.sourceId === 'doco.C1')!
    expect(c1.replies).toEqual(['Sam Example: Reply R1 to C1'])
    const c6 = plan.steps.find((s) => s.sourceId === 'doco.C6')!
    expect(c6.op).toBe(c6.fallback)
    expect(c6.op).toMatchObject({ op: 'comment', doc: true, body: 'Sam Example on “pricing claim”: Cut this whole claim' })
    expect(c6.docWhy).toBe('the text it was on has been deleted')
    const s = plan.steps.find((x) => x.kind === 'suggestion')!
    expect(s.op).toEqual({ op: 'suggest', quote: 'Spike heading', replace: 'Proof heading', occurrence: 1, reason: 'Sam Example suggested this in Google Docs', key: 'gdoc:spike-small:suggest.djlqpnuwyau1' })
    expect(s.fallback.body).toBe('Sam Example suggested: replace “Spike ” with “Proof ”')

    const all = planImport(imp, { includeResolved: true })
    const c5 = all.steps.find((x) => x.sourceId === 'doco.C5')!
    expect(c5).toMatchObject({ resolve: true, replies: ['Pat Author: Done, resolving'] })
    expect(c5.op).toMatchObject({ quote: 'Numbered one\nNumbered two' })
  })

  it('the live round trip imports every comment anchored, with its reply', () => {
    const plan = planImport(parseGdoc(fixture('export-brief-commented.read_doc.json')))
    expect(plan.steps).toHaveLength(8)
    expect(plan.steps.every((s) => s.op.op === 'comment' && !('doc' in s.op))).toBe(true)
    expect(plan.steps.find((s) => 'quote' in s.op && s.op.quote === '12% member price')!.op).toMatchObject({ occurrence: 2 })
    expect(plan.steps.reduce((n, s) => n + s.replies.length, 0)).toBe(2)
  })

  it('paragraph-level suggestions become comments from the start', () => {
    const imp = {
      title: 'T', markdown: '', text: 'a\nb', threads: [], notes: [], gindex: [],
      suggestions: [{ sourceId: 's', author: 'Sam', from: 1, to: 1, del: '', ins: 'new para', multiBlock: true, summary: 'Insert: “new para”' }],
    }
    const st = planImport(imp).steps[0]!
    expect(st.op).toBe(st.fallback)
    expect(st.fallback.body).toBe('Sam suggested: insert “new para” (Insert: “new para”)')
  })
})

describe('contextSpan', () => {
  it('grows to whole words, at least ~12 characters, never past the line', () => {
    const t = 'first line\nThe quick brown fox jumps\nlast'
    const at = t.indexOf('brown')
    expect(t.slice(...Object.values(contextSpan(t, at, at + 5)) as [number, number])).toBe('quick brown fox')
    const ins = t.indexOf(' jumps')
    expect(t.slice(...Object.values(contextSpan(t, ins, ins)) as [number, number])).toBe('brown fox jumps')
    expect(contextSpan('x', 0, 1)).toEqual({ a: 0, b: 1 })
  })
})

describe('messageBody', () => {
  it('carries the author and never posts an empty body', () => {
    expect(messageBody('Sam', '  ok ')).toBe('Sam: ok')
    expect(messageBody('Sam', '')).toBe('Sam: (no text)')
    expect(messageBody('R', 'x'.repeat(30_000)).length).toBe(20_000)
  })
})
