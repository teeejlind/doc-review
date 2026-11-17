// tests/unit/core/quote/quote.test.ts (P1; CONTRACTS §5.5 creation-time quote search, D45 CLI cap).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { OBJ, ptextOf } from '../../../../core/ptext'
import {
  assertCliQuote, findQuoteInPtext, findQuoteInSource, pickQuoteHit, quoteContext, quotePtext, sourceSpanOfPtext,
} from '../../../../core/quote'
import { load } from '../../../../core/splice/load'
import { isStoreError } from '../../../../shared/errors'
import { CONSTANTS } from '../../../../shared/types'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const loadP = (src: string) => {
  const L = load(md, src)
  return { L, p: ptextOf(L.doc, L) }
}

describe('findQuoteInPtext: exact, then markdown, then normalized; first tier with a hit wins', () => {
  const SRC = 'The **12%** member applies.\n\nSay “hi” to  the team, a <span>tagged</span> word.\n'

  it('exact', () => {
    const { p } = loadP(SRC)
    expect(findQuoteInPtext(md, p, '12% member')).toEqual([{ from: 4, to: 14, tier: 'exact' }])
  })

  it('markdown: the quote parsed with the doc parser (`**12%** member` → `12% member`)', () => {
    const { p } = loadP(SRC)
    expect(findQuoteInPtext(md, p, '**12%** member')).toEqual([{ from: 4, to: 14, tier: 'markdown' }])
    expect(quotePtext(md, '**12%** member')).toBe('12% member')
  })

  it('markdown: a quote crossing inline HTML misses exact and hits as markdown (tags become U+FFFC)', () => {
    const { p } = loadP(SRC)
    const hits = findQuoteInPtext(md, p, 'a <span>tagged</span> word')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.tier).toBe('markdown')
    expect(p.text.slice(hits[0]!.from, hits[0]!.to)).toBe(`a ${OBJ}tagged${OBJ} word`)
  })

  it('normalized: curly vs straight quotes and collapsed whitespace, offsets in raw ptext', () => {
    const { p } = loadP(SRC)
    const hits = findQuoteInPtext(md, p, 'Say "hi" to the team')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.tier).toBe('normalized')
    expect(p.text.slice(hits[0]!.from, hits[0]!.to)).toBe('Say “hi” to  the team')
  })

  it('every occurrence of the winning tier, in doc order; no hit is []', () => {
    const { p } = loadP('a cat\n\nanother cat\n')
    expect(findQuoteInPtext(md, p, 'cat').map((h) => h.from)).toEqual([2, 14])
    expect(findQuoteInPtext(md, p, 'dog')).toEqual([])
    expect(findQuoteInPtext(md, p, '')).toEqual([])
  })
})

describe('findQuoteInSource: exact, then whitespace-normalized', () => {
  it('exact and whitespace tiers, with source offsets', () => {
    const src = 'Line one\nwraps here.\n\n**Bold** text.\n'
    expect(findQuoteInSource(src, '**Bold**')).toEqual([{ start: 22, end: 30, tier: 'exact' }])
    const ws = findQuoteInSource(src, 'one wraps')
    expect(ws).toEqual([{ start: 5, end: 14, tier: 'whitespace' }])
    expect(src.slice(5, 14)).toBe('one\nwraps')
    expect(findQuoteInSource(src, '   ')).toEqual([])
  })
})

describe('the CLI quote cap (§5.2, D45)', () => {
  it('a quote over MAX_QUOTE_CHARS is BAD_REQUEST with the --block hint, on both searches', () => {
    const { p } = loadP('x\n')
    const long = 'a'.repeat(CONSTANTS.MAX_QUOTE_CHARS + 1)
    for (const f of [() => findQuoteInPtext(md, p, long), () => findQuoteInSource('x', long), () => assertCliQuote(long)]) {
      let err: unknown = null
      try {
        f()
      } catch (e) {
        err = e
      }
      expect(isStoreError(err) && err.code === 'BAD_REQUEST').toBe(true)
      expect((err as { body: { hint?: string } }).body.hint).toContain('--block bN --base-rev R')
    }
    expect(() => assertCliQuote('a'.repeat(CONSTANTS.MAX_QUOTE_CHARS))).not.toThrow()
  })
})

describe('pickQuoteHit (§5.5 outcomes)', () => {
  const hits = [{ block: 1, id: 'a' }, { block: 3, id: 'b' }, { block: 3, id: 'c' }, { block: 6, id: 'd' }]

  it('one hit wins; several without occurrence / near are ambiguous; none is null', () => {
    expect(pickQuoteHit([hits[0]!])).toEqual({ hit: hits[0], index: 0 })
    expect(pickQuoteHit(hits)).toBe('ambiguous')
    expect(pickQuoteHit([])).toBeNull()
  })

  it('occurrence is 1-based; out of range is null', () => {
    expect(pickQuoteHit(hits, { occurrence: 2 })).toEqual({ hit: hits[1], index: 1 })
    expect(pickQuoteHit(hits, { occurrence: 9 })).toBeNull()
  })

  it('near: a hit in that block (the earliest), else the nearest block, ties to the earlier', () => {
    expect(pickQuoteHit(hits, { near: 3 })).toEqual({ hit: hits[1], index: 1 })
    expect(pickQuoteHit(hits, { near: 5 })).toEqual({ hit: hits[3], index: 3 })
    expect(pickQuoteHit(hits, { near: 2 })).toEqual({ hit: hits[0], index: 0 })
  })
})

describe('QUOTE_NOT_IN_SOURCE support', () => {
  it('sourceSpanOfPtext maps a ptext hit to the exact source bytes behind it, markup included', () => {
    const src = 'Intro.\n\nThe **12%** member applies.\n'
    const { L, p } = loadP(src)
    expect(findQuoteInSource(src, '12% member')).toEqual([])
    const hit = findQuoteInPtext(md, p, '12% member')[0]!
    const span = sourceSpanOfPtext(src, L.blocks, p, hit.from, hit.to)
    expect(src.slice(span.start, span.end)).toBe('**12%** member')
    // and it is findable in source, so the retry succeeds
    expect(findQuoteInSource(src, src.slice(span.start, span.end))).toHaveLength(1)
  })

  it('escapes and links map back too', () => {
    const src = 'Price \\~40 per [unit](https://x.example) today.\n'
    const { L, p } = loadP(src)
    const hit = findQuoteInPtext(md, p, '~40 per unit')[0]!
    const span = sourceSpanOfPtext(src, L.blocks, p, hit.from, hit.to)
    expect(src.slice(span.start, span.end)).toBe('\\~40 per [unit](https://x.example)')
  })

  it('quoteContext wraps the match', () => {
    expect(quoteContext('alpha beta\ngamma delta', 6, 10, 6)).toBe('alpha ⟦beta⟧ gamma')
  })
})
