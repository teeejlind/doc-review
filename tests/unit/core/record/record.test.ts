// tests/unit/core/record/record.test.ts (P1). core/suggest/record.ts (CONTRACTS §6.1, §6.2, §6.7): fromQuote over
// whitespace-normalized source and its miss ladder, the atom refusal, locate nearest the hint, applyToSource as the
// merge-hazard check, and rebase / stale (exact relocation, a patch re-applied to an edited run, BASE_GONE,
// MERGE_HAZARD).
import { beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { load } from '../../../../core/splice/load'
import { applyToSource, changedSpan, fromBlock, fromQuote, locate, quoteNearMisses, rebase, spansOverlap } from '../../../../core/suggest/record'
import type { SuggestionBody } from '../../../../shared/types'

let md: Md
beforeAll(async () => {
  md = await createMd()
})

const DOC = '# Title\n\nThe notes carry a member rate of 12% paid monthly.\n\nWe launch in Q3.\n\nLast line.\n'

describe('fromQuote / fromBlock (§6.2)', () => {
  it('the run around the source span; a whitespace-normalized hit maps back to the raw bytes', () => {
    const L = load(md, 'Alpha beta\ngamma delta.\n\nNext.\n')
    const s = fromQuote(md, L, { quote: 'beta gamma', replace: 'BETA GAMMA' })
    expect(s.base).toBe('Alpha beta\ngamma delta.')
    expect(s.proposed).toBe('Alpha BETA GAMMA delta.')
    expect(s.range).toEqual({ start: 0, end: 1, rev: 0 })
  })

  it('QUOTE_NOT_IN_SOURCE with sourceQuote when only the rendered text matches; QUOTE_NOT_FOUND with near-misses', () => {
    const L = load(md, 'A **bold** claim here.\n\nAnother sentence entirely.\n')
    expect(() => fromQuote(md, L, { quote: 'bold claim', replace: 'x' })).toThrow(expect.objectContaining({ code: 'QUOTE_NOT_IN_SOURCE', body: expect.objectContaining({ sourceQuote: '**bold** claim' }) }))
    try {
      fromQuote(md, L, { quote: 'Another sentense entirely', replace: 'x' })
      expect.unreachable()
    } catch (e) {
      expect(e).toMatchObject({ code: 'QUOTE_NOT_FOUND' })
      expect((e as { body: { candidates: Array<{ block: string }> } }).body.candidates[0]).toMatchObject({ block: 'b2' })
    }
  })

  it('atom runs are refused (UNANCHORABLE_TARGET); code and table text are not', () => {
    const L = load(md, '---\ntitle: x\n---\n\n```js\nlet a = 1\n```\n\n| a |\n|---|\n| 1 |\n')
    expect(() => fromQuote(md, L, { quote: 'title: x', replace: 'title: y' })).toThrow(expect.objectContaining({ code: 'UNANCHORABLE_TARGET' }))
    expect(fromQuote(md, L, { quote: 'let a = 1', replace: 'let a = 2' }).proposed).toBe('```js\nlet a = 2\n```')
    expect(fromBlock(md, L, 2, '| a |\n|---|\n| 1 |\n| 2 |').base).toBe('| a |\n|---|\n| 1 |')
  })
})

describe('locate / applyToSource', () => {
  it('locate finds the exact run nearest the hint; applyToSource writes exactly proposed', () => {
    const text = 'Same.\n\nOther.\n\nSame.\n'
    const L = load(md, text)
    const body: SuggestionBody = { range: { start: 2, end: 3, rev: 1 }, base: 'Same.', proposed: 'Changed.', hunks: [] }
    expect(locate(L, body)).toEqual({ start: 2, end: 3 })
    expect(locate(L, { ...body, range: { start: 0, end: 1, rev: 1 } })).toEqual({ start: 0, end: 1 })
    expect(applyToSource(md, L, body)).toMatchObject({ text: 'Same.\n\nOther.\n\nChanged.\n', verified: true })
  })

  it('a proposed new list item next to a same-marker list is a merge hazard (verified: false)', () => {
    const L = load(md, '- a\n- b\n\nPara.\n')
    const body: SuggestionBody = { range: { start: 1, end: 2, rev: 1 }, base: 'Para.', proposed: '- c', hunks: [] }
    expect(applyToSource(md, L, body).verified).toBe(false)
  })
})

describe('rebase / stale (§6.7)', () => {
  const s: SuggestionBody = {
    range: { start: 1, end: 2, rev: 1 },
    base: 'The notes carry a member rate of 12% paid monthly.',
    proposed: 'The notes carry a member rate of 11% paid monthly.',
    hunks: [],
  }

  it('the exact base moved: the range follows, base and proposed unchanged', () => {
    const L = load(md, '# Title\n\nNew para.\n\n' + DOC.slice('# Title\n\n'.length))
    const r = rebase(md, L, s)
    expect(r).toMatchObject({ range: { start: 2, end: 3 }, base: s.base, proposed: s.proposed })
  })

  it('the run was edited elsewhere: patch_make(base, proposed) re-applies onto the candidate (hash miss → match_main / similarity)', () => {
    const L = load(md, DOC.replace('paid monthly', 'paid every month'))
    const r = rebase(md, L, s)
    expect('stale' in r).toBe(false)
    const b = r as SuggestionBody
    expect(b.base).toBe('The notes carry a member rate of 12% paid every month.')
    expect(b.proposed).toBe('The notes carry a member rate of 11% paid every month.')
    expect(b.range).toEqual({ start: 1, end: 2, rev: 1 })
    expect(b.hunks).toEqual([expect.objectContaining({ del: '12%', ins: '11%' })])
    expect(applyToSource(md, L, b).text).toBe(DOC.replace('paid monthly', 'paid every month').replace('12%', '11%'))
  })

  it('the base is gone → { stale: BASE_GONE }', () => {
    const L = load(md, '# Title\n\nSomething completely different.\n\nLast line.\n')
    expect(rebase(md, L, s)).toEqual({ stale: 'BASE_GONE' })
  })

  it('a patch that applies but merges into a neighbour → { stale: MERGE_HAZARD }', () => {
    const base = 'Para one.'
    const body: SuggestionBody = { range: { start: 1, end: 2, rev: 1 }, base, proposed: '- c', hunks: [] }
    const L = load(md, '- a\n- b\n\nPara one!\n\nEnd.\n')
    expect(rebase(md, L, body)).toEqual({ stale: 'MERGE_HAZARD' })
  })
})

describe('overlap helpers (§6.2 step 2) and near-misses (§5.5)', () => {
  it('changedSpan trims the common prefix and suffix; point spans touch the ranges they sit on', () => {
    expect(changedSpan({ base: 'abcXYZdef', proposed: 'abc123def' })).toEqual([3, 6])
    expect(changedSpan({ base: 'abcdef', proposed: 'abcNEWdef' })).toEqual([3, 3])
    expect(spansOverlap([3, 6], [5, 9])).toBe(true)
    expect(spansOverlap([3, 6], [6, 9])).toBe(false)
    expect(spansOverlap([3, 3], [3, 6])).toBe(true)
  })

  it('quoteNearMisses: at most 3, similarity >= 0.6, never an exact hit', () => {
    const text = 'the member rate is 12%\nthe member rates are 11%\nunrelated words here'
    const ranges = [{ index: 0, start: 0, end: 22 }, { index: 1, start: 23, end: 47 }, { index: 2, start: 48, end: text.length }]
    const c = quoteNearMisses(text, ranges, 'the member rote is', (i) => i + 1)
    expect(c.length).toBeGreaterThan(0)
    expect(c.length).toBeLessThanOrEqual(3)
    expect(c.every((x) => (x.similarity ?? 0) >= 0.6 && (x.similarity ?? 0) < 1)).toBe(true)
    expect(c[0]).toMatchObject({ block: 'b1', occurrence: 1 })
  })
})
