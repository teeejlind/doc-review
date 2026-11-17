// core/quote.ts (P1). Creation-time quote search for the CLI; never fuzzy (CONTRACTS §5.5, D45).
//
// - findQuoteInPtext (comment --quote): exact; then the quote parsed as inline markdown with the same parser
//   (`**12%** member` → `12% member`, inline HTML tags → U+FFFC like the doc's own), then exact; then normalized as in
//   §5.3 step 4. Stops at the first tier with a hit and returns every hit of that tier in doc order.
// - findQuoteInSource (suggest --quote and { quote } selectors, which change bytes): exact, then whitespace-normalized.
// - Both refuse a quote over MAX_QUOTE_CHARS with BAD_REQUEST (CLI quotes are never long-form, §5.2).
// - pickQuoteHit applies `occurrence` / `near` (a block index whose rev the caller already checked) the §5.5 way.
// - sourceSpanOfPtext maps a ptext hit to the source bytes behind it, for QUOTE_NOT_IN_SOURCE's `sourceQuote`.
import DiffMatchPatch from 'diff-match-patch'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { BlockInfo } from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { StoreError } from '../shared/errors'
import { normalizeForMatch, rawRange } from './anchors'
import type { Md } from './md/index'
import { segmentsOf, type PText } from './ptext'

export type QuoteHit = { from: number; to: number; tier: 'exact' | 'markdown' | 'normalized' }        // ptext
export type SourceHit = { start: number; end: number; tier: 'exact' | 'whitespace' }               // source

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 0

/** §5.2 / §5.5: CLI quotes are capped at MAX_QUOTE_CHARS. */
export function assertCliQuote(quote: string): void {
  if (quote.length > CONSTANTS.MAX_QUOTE_CHARS) {
    throw new StoreError('BAD_REQUEST', `quote is ${quote.length} characters; the limit is ${CONSTANTS.MAX_QUOTE_CHARS}`, {
      hint: 'quote a shorter span, or use --block bN --base-rev R',
    })
  }
}

function occurrences(text: string, q: string): number[] {
  const out: number[] = []
  if (!q) return out
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) out.push(i)
  return out
}

/** The ptext of `quote` parsed as markdown with the doc's parser (null when it parses to nothing). */
export function quotePtext(md: Md, quote: string): string | null {
  try {
    const doc = md.parseDoc(quote)
    const nodes: PMNode[] = []
    doc.forEach((n) => nodes.push(n))
    const segs = segmentsOf(nodes)
    return segs.length ? segs.join('\n') : null
  } catch {
    return null
  }
}

export function findQuoteInPtext(md: Md, p: PText, quote: string): QuoteHit[] {
  assertCliQuote(quote)
  if (!quote) return []
  // 1. exact
  const exact = occurrences(p.text, quote)
  if (exact.length) return exact.map((from) => ({ from, to: from + quote.length, tier: 'exact' as const }))
  // 2. the quote as inline markdown, then exact
  const parsed = quotePtext(md, quote)
  if (parsed !== null && parsed !== quote) {
    const hits = occurrences(p.text, parsed)
    if (hits.length) return hits.map((from) => ({ from, to: from + parsed.length, tier: 'markdown' as const }))
  }
  // 3. normalized (the quote as given, then its parsed form)
  const N = normalizeForMatch(p.text)
  for (const q of parsed !== null && parsed !== quote ? [quote, parsed] : [quote]) {
    const nq = normalizeForMatch(q).text
    const hits = occurrences(N.text, nq)
    if (hits.length) return hits.map((h) => ({ ...rawRange(N, h, h + nq.length), tier: 'normalized' as const }))
  }
  return []
}

/** Whitespace-only normalization: every whitespace run → one space, with the raw [start, end) of each unit. */
function collapseWhitespace(s: string): { text: string; start: number[]; end: number[] } {
  const out: string[] = []
  const start: number[] = []
  const end: number[] = []
  let inWs = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (/\s/.test(c)) {
      if (inWs) {
        end[end.length - 1] = i + 1
        continue
      }
      inWs = true
      out.push(' ')
    } else {
      inWs = false
      out.push(c)
    }
    start.push(i)
    end.push(i + 1)
  }
  return { text: out.join(''), start, end }
}

export function findQuoteInSource(src: string, quote: string): SourceHit[] {
  assertCliQuote(quote)
  if (!quote) return []
  const exact = occurrences(src, quote)
  if (exact.length) return exact.map((start) => ({ start, end: start + quote.length, tier: 'exact' as const }))
  const W = collapseWhitespace(src)
  const wq = collapseWhitespace(quote).text
  if (!wq.trim()) return []
  return occurrences(W.text, wq).map((h) => ({ start: W.start[h]!, end: W.end[h + wq.length - 1]!, tier: 'whitespace' as const }))
}

/**
 * §5.5 hit selection over hits in doc order, each with the index of the block it starts in. `occurrence` is 1-based;
 * `near` is a block index (already rev-checked by the caller): a hit in that block wins (the earliest), else the hit
 * nearest the block (ties: the earlier one). Without either, more than one hit is 'ambiguous'.
 */
export function pickQuoteHit<T extends { block: number }>(
  hits: readonly T[], o: { occurrence?: number; near?: number } = {},
): { hit: T; index: number } | 'ambiguous' | null {
  if (!hits.length) return null
  if (o.occurrence !== undefined) {
    const h = hits[o.occurrence - 1]
    return h ? { hit: h, index: o.occurrence - 1 } : null
  }
  if (o.near !== undefined) {
    let best = 0
    for (let i = 1; i < hits.length; i++) {
      const d = Math.abs(hits[i]!.block - o.near)
      const bd = Math.abs(hits[best]!.block - o.near)
      if (d < bd) best = i
    }
    return { hit: hits[best]!, index: best }
  }
  return hits.length === 1 ? { hit: hits[0]!, index: 0 } : 'ambiguous'
}

/** `before ⟦match⟧ after` with ~40 chars each side, for QuoteCandidate.context. */
export function quoteContext(text: string, from: number, to: number, radius = 40): string {
  const flat = (s: string): string => s.replace(/\s+/g, ' ')
  return `${flat(text.slice(Math.max(0, from - radius), from))}⟦${flat(text.slice(from, to))}⟧${flat(text.slice(to, to + radius))}`
}

type Diff = [number, string]

/** Text-1 offset → text-2 offset, before any insertion at that point (so leading markup is included). */
function leftIndex(diffs: readonly Diff[], loc: number): number {
  let c1 = 0
  let c2 = 0
  for (const [op, t] of diffs) {
    if (op === 1) {
      if (c1 === loc) return c2
      c2 += t.length
      continue
    }
    if (loc < c1 + t.length) return op === 0 ? c2 + (loc - c1) : c2
    c1 += t.length
    if (op === 0) c2 += t.length
  }
  return c2 + (loc - c1)
}

/** Text-1 offset → text-2 offset, after any insertion at that point (so trailing markup is included). */
function rightIndex(diffs: readonly Diff[], loc: number): number {
  let c1 = 0
  let c2 = 0
  for (const [op, t] of diffs) {
    if (op === 1) {
      if (c1 > loc) break
      c2 += t.length
      continue
    }
    if (c1 >= loc) break
    if (loc < c1 + t.length) return op === 0 ? c2 + (loc - c1) : c2
    c1 += t.length
    if (op === 0) c2 += t.length
  }
  return c2 + Math.max(0, loc - c1)
}

/**
 * The source span behind the ptext span [from, to): each end is mapped inside its own block through a character diff
 * of the block's ptext against its source, the start before and the end after surrounding markup. Used for
 * QUOTE_NOT_IN_SOURCE's `sourceQuote` (§5.5), so Claude can retry once with the right bytes.
 */
export function sourceSpanOfPtext(src: string, blocks: readonly Pick<BlockInfo, 'start' | 'end' | 'pStart' | 'pEnd'>[], p: PText, from: number, to: number): { start: number; end: number } {
  const map = (offset: number, side: 'left' | 'right'): number => {
    const { index } = p.blockAt(offset)
    const b = blocks[index]
    if (!b) return side === 'left' ? 0 : src.length
    const local = Math.max(0, Math.min(offset - b.pStart, b.pEnd - b.pStart))
    const diffs = dmp.diff_main(p.text.slice(b.pStart, b.pEnd), src.slice(b.start, b.end), false) as Diff[]
    return b.start + (side === 'left' ? leftIndex(diffs, local) : rightIndex(diffs, local))
  }
  const start = map(from, 'left')
  const end = Math.max(start, map(to, 'right'))
  return { start, end }
}
