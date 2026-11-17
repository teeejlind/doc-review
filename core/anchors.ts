// core/anchors.ts (P1). Anchor creation and resolution against ptext (CONTRACTS §5.2–§5.4, D7, D35, D45).
//
// - createAnchor / createBlockAnchor produce the canonical §5.2 shapes (long form over MAX_QUOTE_CHARS). Identical
//   inputs give byte-identical anchors (fixed key order: kind, quote, tail, span, prefix, suffix, hint). Callers trim
//   selection whitespace first (`trimSpan`), on both surfaces.
// - resolveAnchor runs the §5.3 ladder, first hit wins: (1) exact at the hint, (2) exact inside the hinted block,
//   (3) exact anywhere with context scoring (a full tie takes the first and is `ambiguous`, never detached), (4)
//   normalized exact, (5) fuzzy within the hinted block ±2 (comments only, `fuzzy: true`), (6) detached. Long anchors
//   resolve the head, then the tail exactly near head + span. Empty quotes search the prefix+suffix junction. Block
//   anchors: hash, frontmatter singleton, same-type preview similarity near the hint.
// - followBlockAnchor moves a block anchor across a 1:1 replace of its block (§5.4, D35).
// - refreshAnchor is the §5.4 logging rule: the anchor to store after a resolution, or null when nothing is logged.
// Everything is deterministic: no timeouts (dmp's Diff_Timeout is 0), no Intl, no Unicode normalization beyond §5.3.
import DiffMatchPatch from 'diff-match-patch'
import type {
  Anchor, BlockAnchor, BlockChange, BlockInfo, Resolution, ResolutionState, TextAnchor,
} from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import type { PText } from './ptext'

const { ANCHOR_CONTEXT_CHARS, LONG_QUOTE_EDGE_CHARS, MAX_QUOTE_CHARS } = CONSTANTS

/** §5.3 step 5: bitap threshold for quotes of up to 32 units, head/tail probe length and similarity floors. */
export const FUZZY = { SHORT_MAX: 32, MATCH_THRESHOLD: 0.25, EDGE: 24, SPAN_TOLERANCE: 0.25, MIN_SIMILARITY: 0.75, BLOCK_RADIUS: 2 } as const
/** §5.3 block-anchor step 3: preview similarity floor and index radius. */
export const BLOCK_FUZZY = { MIN_SIMILARITY: 0.6, RADIUS: 2 } as const

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 0
dmp.Match_Threshold = FUZZY.MATCH_THRESHOLD

// ------------------------------------------------------------------ creation

/** Shrink [from, to) past leading and trailing whitespace of the ptext (a collapsed span stays where it is). */
export function trimSpan(p: Pick<PText, 'text'>, from: number, to: number): { from: number; to: number } {
  let f = from
  let t = to
  while (f < t && /\s/.test(p.text[f]!)) f++
  while (t > f && /\s/.test(p.text[t - 1]!)) t--
  return { from: f, to: t }
}

export function createAnchor(p: PText, blocks: BlockInfo[], from: number, to: number, rev: number): TextAnchor {
  const n = to - from
  const span = p.text.slice(from, to)
  const at = p.blockAt(from)
  const hint = { rev, pos: from, block: at.index, blockHash: blocks[at.index]?.hash ?? '', offsetInBlock: at.offsetInBlock }
  const prefix = p.text.slice(Math.max(0, from - ANCHOR_CONTEXT_CHARS), from)
  const suffix = p.text.slice(to, to + ANCHOR_CONTEXT_CHARS)
  if (n > MAX_QUOTE_CHARS) {
    return {
      kind: 'text', quote: span.slice(0, LONG_QUOTE_EDGE_CHARS), tail: span.slice(n - LONG_QUOTE_EDGE_CHARS), span: n,
      prefix, suffix, hint,
    }
  }
  return { kind: 'text', quote: span, prefix, suffix, hint }
}

export function createBlockAnchor(blocks: BlockInfo[], index: number, rev: number): BlockAnchor {
  const b = blocks[index]
  if (!b) throw new RangeError(`createBlockAnchor: no block at index ${index}`)
  return { kind: 'block', hint: { rev, block: index, blockHash: b.hash, kind: b.kind, mdType: b.mdType }, preview: b.preview }
}

// ------------------------------------------------------------------ normalization (§5.3 step 4, shared with quote.ts)

const ZERO_WIDTH = new Set(['​', '‌', '‍', '⁠', '﻿'])
const QUOTES: Readonly<Record<string, string>> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
}

/** Normalized text plus, per normalized unit, the raw [start, end) it stands for. */
export interface Normalized { text: string; start: number[]; end: number[] }

/**
 * §5.3 step 4: strip zero-width characters, collapse every whitespace run (NBSP included) to one space, curly quotes →
 * straight. Offsets map back to raw through `start` / `end`.
 */
export function normalizeForMatch(s: string): Normalized {
  const out: string[] = []
  const start: number[] = []
  const end: number[] = []
  let inWs = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (ZERO_WIDTH.has(c)) continue
    if (/\s/.test(c)) {
      if (inWs) {
        end[end.length - 1] = i + 1
        continue
      }
      inWs = true
      out.push(' ')
      start.push(i)
      end.push(i + 1)
      continue
    }
    inWs = false
    out.push(QUOTES[c] ?? c)
    start.push(i)
    end.push(i + 1)
  }
  return { text: out.join(''), start, end }
}

/** Raw [from, to) of the normalized match [nf, nt). */
export function rawRange(N: Normalized, nf: number, nt: number): { from: number; to: number } {
  if (nt <= nf) {
    const at = nf < N.start.length ? N.start[nf]! : (N.end[N.end.length - 1] ?? 0)
    return { from: at, to: at }
  }
  return { from: N.start[nf]!, to: N.end[nt - 1]! }
}

/** First normalized index whose raw start is >= `raw` (N.start is sorted). */
function normIndexOf(N: Normalized, raw: number): number {
  let lo = 0
  let hi = N.start.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (N.start[mid]! < raw) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ------------------------------------------------------------------ similarity

/** Levenshtein distance; exact DP for short strings, dmp's diff (deterministic, no timeout) for long ones. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  if (a.length * b.length <= 250_000) {
    let prev = new Array<number>(b.length + 1)
    let cur = new Array<number>(b.length + 1)
    for (let j = 0; j <= b.length; j++) prev[j] = j
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i
      const ca = a.charCodeAt(i - 1)
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ca === b.charCodeAt(j - 1) ? 0 : 1))
      }
      ;[prev, cur] = [cur, prev]
    }
    return prev[b.length]!
  }
  return dmp.diff_levenshtein(dmp.diff_main(a, b, false))
}

/** 1 − levenshtein / maxLen (1 for two empty strings). */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max
}

// ------------------------------------------------------------------ resolution helpers

function occurrences(text: string, q: string, from = 0, to = text.length): number[] {
  const out: number[] = []
  if (!q) return out
  for (let i = text.indexOf(q, from); i !== -1 && i + q.length <= to; i = text.indexOf(q, i + 1)) out.push(i)
  return out
}

function commonSuffixLen(a: string, b: string): number {
  let k = 0
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++
  return k
}
function commonPrefixLen(a: string, b: string): number {
  let k = 0
  while (k < a.length && k < b.length && a[k] === b[k]) k++
  return k
}

/** §5.3 context score: commonSuffix(textBefore, prefix) + commonPrefix(textAfter, suffix). */
function score(text: string, i: number, len: number, prefix: string, suffix: string): number {
  return commonSuffixLen(text.slice(Math.max(0, i - prefix.length), i), prefix)
    + commonPrefixLen(text.slice(i + len, i + len + suffix.length), suffix)
}

/** Best candidate: highest score, then nearest `near`; a full tie takes the first in doc order and is ambiguous. */
function pick(text: string, hits: readonly number[], len: number, prefix: string, suffix: string, near: number): { at: number; ambiguous: boolean } {
  let best: number[] = []
  let bestScore = -1
  for (const h of hits) {
    const s = score(text, h, len, prefix, suffix)
    if (s > bestScore) {
      bestScore = s
      best = [h]
    } else if (s === bestScore) best.push(h)
  }
  let nearest: number[] = []
  let bestDist = Infinity
  for (const h of best) {
    const d = Math.abs(h - near)
    if (d < bestDist) {
      bestDist = d
      nearest = [h]
    } else if (d === bestDist) nearest.push(h)
  }
  return { at: nearest[0]!, ambiguous: nearest.length > 1 }
}

/** The hinted block: the block with `blockHash` nearest `block`, else index `block` when it exists. */
function hintedBlock(blocks: readonly BlockInfo[], blockHash: string, block: number): number | null {
  let best: number | null = null
  for (const b of blocks) {
    if (b.hash !== blockHash) continue
    if (best === null || Math.abs(b.index - block) < Math.abs(best - block)) best = b.index
  }
  if (best !== null) return best
  return block >= 0 && block < blocks.length ? block : null
}

type Hit = { state: 'exact' | 'moved' | 'fuzzy'; from: number; to: number; ambiguous: boolean }
interface Ctx { prefix: string; suffix: string; hint: TextAnchor['hint'] }

/** §5.3 steps 1–3 for a non-empty quote. */
function resolveExact(p: PText, blocks: readonly BlockInfo[], quote: string, a: Ctx): Hit | null {
  const { text } = p
  const bi = hintedBlock(blocks, a.hint.blockHash, a.hint.block)
  const range = bi !== null ? p.blockRanges[bi] : undefined
  if (range) {
    // 1. exact at the hint
    const start = range.pStart + a.hint.offsetInBlock
    const inBlock = occurrences(text, quote, range.pStart, range.pEnd)
    if (text.startsWith(quote, start)) {
      // the block changed (its hash is gone) and the quote repeats in it (a table column, a list): the offset can land
      // on a same-shaped sibling after a row was added above, so a better-scoring occurrence beats the bare hint
      if (inBlock.length > 1 && bi !== null && blocks[bi]?.hash !== a.hint.blockHash) {
        const { at } = pick(text, inBlock, quote.length, a.prefix, a.suffix, start)
        if (at !== start) return { state: 'moved', from: at, to: at + quote.length, ambiguous: false }
      }
      return { state: 'exact', from: start, to: start + quote.length, ambiguous: false }
    }
    // 2. exact inside the hinted block: best context, ties to the nearest offset
    if (inBlock.length) {
      const { at } = pick(text, inBlock, quote.length, a.prefix, a.suffix, start)
      return { state: 'moved', from: at, to: at + quote.length, ambiguous: false }
    }
  }
  // 3. exact anywhere
  const all = occurrences(text, quote)
  if (!all.length) return null
  if (all.length === 1) return { state: 'moved', from: all[0]!, to: all[0]! + quote.length, ambiguous: false }
  const { at, ambiguous } = pick(text, all, quote.length, a.prefix, a.suffix, a.hint.pos)
  return { state: 'moved', from: at, to: at + quote.length, ambiguous }
}

/** §5.3 step 4: normalized exact, hinted block first, same scoring; offsets map back to raw. */
function resolveNormalized(p: PText, blocks: readonly BlockInfo[], quote: string, a: Ctx, N: Normalized): Hit | null {
  const nq = normalizeForMatch(quote).text
  if (!nq) return null
  const np = normalizeForMatch(a.prefix).text
  const ns = normalizeForMatch(a.suffix).text
  const all = occurrences(N.text, nq)
  if (!all.length) return null
  const bi = hintedBlock(blocks, a.hint.blockHash, a.hint.block)
  const range = bi !== null ? p.blockRanges[bi] : undefined
  const done = (nf: number, ambiguous: boolean): Hit => ({ state: 'moved', ...rawRange(N, nf, nf + nq.length), ambiguous })
  if (range) {
    const lo = normIndexOf(N, range.pStart)
    const hi = normIndexOf(N, range.pEnd)
    const inBlock = all.filter((h) => h >= lo && h + nq.length <= hi)
    if (inBlock.length) return done(pick(N.text, inBlock, nq.length, np, ns, normIndexOf(N, range.pStart + a.hint.offsetInBlock)).at, false)
  }
  if (all.length === 1) return done(all[0]!, false)
  const { at, ambiguous } = pick(N.text, all, nq.length, np, ns, normIndexOf(N, a.hint.pos))
  return done(at, ambiguous)
}

/** §5.3 step 5: fuzzy within the hinted block ±2 blocks. */
function resolveFuzzy(p: PText, blocks: readonly BlockInfo[], quote: string, a: Ctx): Hit | null {
  const n = p.blockRanges.length
  if (!n) return null
  const hb = hintedBlock(blocks, a.hint.blockHash, a.hint.block) ?? Math.max(0, Math.min(n - 1, a.hint.block))
  const lo = p.blockRanges[Math.max(0, hb - FUZZY.BLOCK_RADIUS)]!.pStart
  const hi = p.blockRanges[Math.min(n - 1, hb + FUZZY.BLOCK_RADIUS)]!.pEnd
  const win = p.text.slice(lo, hi)
  if (!win) return null
  const hbRange = p.blockRanges[hb]!
  const loc = Math.max(0, Math.min(win.length, hbRange.pStart + a.hint.offsetInBlock - lo))
  dmp.Match_Distance = Math.max(1000, win.length)
  const len = quote.length
  if (len <= FUZZY.SHORT_MAX) {
    const at = dmp.match_main(win, quote, loc)
    if (at < 0) return null
    // the matched length can differ from the quote's: take the end with the best similarity, ties to the quote length
    let bestTo = Math.min(win.length, at + len)
    let bestSim = -1
    const minL = Math.max(1, Math.round(len * (1 - FUZZY.SPAN_TOLERANCE)))
    const maxL = Math.round(len * (1 + FUZZY.SPAN_TOLERANCE))
    for (let l = minL; l <= maxL && at + l <= win.length; l++) {
      const s = similarity(win.slice(at, at + l), quote)
      if (s > bestSim || (s === bestSim && Math.abs(l - len) < Math.abs(bestTo - at - len))) {
        bestSim = s
        bestTo = at + l
      }
    }
    return { state: 'fuzzy', from: lo + at, to: lo + bestTo, ambiguous: false }
  }
  const head = quote.slice(0, FUZZY.EDGE)
  const tail = quote.slice(len - FUZZY.EDGE)
  const hs = dmp.match_main(win, head, loc)
  if (hs < 0) return null
  const ts = dmp.match_main(win, tail, Math.min(win.length, hs + len - FUZZY.EDGE))
  if (ts < 0) return null
  const to = ts + FUZZY.EDGE
  const spanLen = to - hs
  if (spanLen < len * (1 - FUZZY.SPAN_TOLERANCE) || spanLen > len * (1 + FUZZY.SPAN_TOLERANCE)) return null
  if (similarity(win.slice(hs, to), quote) < FUZZY.MIN_SIMILARITY) return null
  return { state: 'fuzzy', from: lo + hs, to: lo + to, ambiguous: false }
}

const SURVIVE_MIN = 0.4
const WORD_CHAR = /[\p{L}\p{N}\p{M}_%$'’-]/u

/**
 * Partial survival (R2.4: "orphaned only when its text is genuinely deleted"). The quote and its stored context are
 * diffed against the hinted block and its neighbours; the quote's span is mapped through the diff, and it stays
 * attached when at least SURVIVE_MIN of its characters are still there (a changed first or last word, an accepted
 * suggestion at the sentence's edge, half a sentence cut). The span is snapped outward to whole words.
 */
function resolveDiff(p: PText, quote: string, a: Ctx): Hit | null {
  const n = p.blockRanges.length
  if (!n || !quote || quote.includes('\n')) return null
  const hb = Math.max(0, Math.min(n - 1, a.hint.block))
  // the context is only used inside the block: what lies past a block separator is another block's text
  const before = a.prefix.slice(a.prefix.lastIndexOf('\n') + 1)
  const nl = a.suffix.indexOf('\n')
  const after = nl < 0 ? a.suffix : a.suffix.slice(0, nl)
  const old = before + quote + after
  const qs = before.length
  const qe = qs + quote.length
  let best: { from: number; to: number; kept: number } | null = null
  for (let b = Math.max(0, hb - 1); b <= Math.min(n - 1, hb + 1); b++) {
    const lo = p.blockRanges[b]!.pStart
    const win = p.text.slice(lo, p.blockRanges[b]!.pEnd)
    if (!win) continue
    const diffs = dmp.diff_main(old, win, false)
    dmp.diff_cleanupSemantic(diffs)
    let ia = 0
    let kept = 0
    for (const [op, t] of diffs) {
      if (op === 0) kept += Math.max(0, Math.min(ia + t.length, qe) - Math.max(ia, qs))
      if (op <= 0) ia += t.length
    }
    if (kept / quote.length < SURVIVE_MIN || (best && kept <= best.kept)) continue
    let s = dmp.diff_xIndex(diffs, qs)
    let e = dmp.diff_xIndex(diffs, qe)
    if (e <= s) continue
    while (s > 0 && WORD_CHAR.test(win[s - 1]!) && WORD_CHAR.test(win[s]!)) s--
    while (e < win.length && WORD_CHAR.test(win[e - 1]!) && WORD_CHAR.test(win[e]!)) e++
    const t = trimSpan(p, lo + s, lo + e)
    if (t.to > t.from) best = { from: t.from, to: t.to, kept }
  }
  return best ? { state: 'fuzzy', from: best.from, to: best.to, ambiguous: false } : null
}

/** Empty quote (suggestion insertion point): the prefix + suffix junction, exact then normalized, scored the same way. */
function resolveJunction(p: PText, a: Ctx, N: () => Normalized): Hit | null {
  const needle = a.prefix + a.suffix
  if (!needle) {
    const pos = Math.max(0, Math.min(p.text.length, a.hint.pos))
    return { state: pos === a.hint.pos ? 'exact' : 'moved', from: pos, to: pos, ambiguous: false }
  }
  const hits = occurrences(p.text, needle)
  if (hits.length) {
    const want = a.hint.pos - a.prefix.length
    if (hits.includes(want)) return { state: 'exact', from: a.hint.pos, to: a.hint.pos, ambiguous: false }
    const { at, ambiguous } = pick(p.text, hits, needle.length, '', '', want)
    const pos = at + a.prefix.length
    return { state: 'moved', from: pos, to: pos, ambiguous }
  }
  const n = N()
  const np = normalizeForMatch(a.prefix).text
  const nn = np + normalizeForMatch(a.suffix).text
  const nh = occurrences(n.text, nn)
  if (!nh.length) return null
  const { at, ambiguous } = pick(n.text, nh, nn.length, '', '', normIndexOf(n, a.hint.pos - a.prefix.length))
  const pos = rawRange(n, at + np.length, at + np.length).from
  return { state: 'moved', from: pos, to: pos, ambiguous }
}

const RANK: Record<ResolutionState, number> = { exact: 0, moved: 1, fuzzy: 2, detached: 3, doc: 0 }
const worse = (x: Hit['state'], y: Hit['state']): Hit['state'] => (RANK[x] >= RANK[y] ? x : y)

function toResolution(p: PText, r: Hit): Resolution {
  const out: Resolution = { state: r.state, from: r.from, to: r.to, block: p.blockAt(r.from).index }
  if (r.ambiguous) out.ambiguous = true
  return out
}

function resolveBlock(blocks: readonly BlockInfo[], a: BlockAnchor, o?: { preview?: (index: number) => string }): Resolution {
  // 1. the block with the hinted hash, nearest the hinted index
  let best: number | null = null
  for (const b of blocks) {
    if (b.hash !== a.hint.blockHash) continue
    if (best === null || Math.abs(b.index - a.hint.block) < Math.abs(best - a.hint.block)) best = b.index
  }
  if (best !== null) return { state: best === a.hint.block ? 'exact' : 'moved', block: best }
  // 2. the frontmatter singleton
  if (a.hint.kind === 'frontmatter') {
    const fm = blocks.filter((b) => b.kind === 'frontmatter')
    if (fm.length === 1) return { state: 'moved', block: fm[0]!.index }
  }
  // 3. same kind and mdType within ±2 of the hint, preview similarity >= 0.6, best first, ties to the nearest index
  const preview = o?.preview ?? ((i: number) => blocks[i]?.preview ?? '')
  let pickI: number | null = null
  let pickSim = -1
  for (let i = Math.max(0, a.hint.block - BLOCK_FUZZY.RADIUS); i <= Math.min(blocks.length - 1, a.hint.block + BLOCK_FUZZY.RADIUS); i++) {
    const b = blocks[i]!
    if (b.kind !== a.hint.kind || b.mdType !== a.hint.mdType) continue
    const s = similarity(preview(i), a.preview)
    if (s < BLOCK_FUZZY.MIN_SIMILARITY) continue
    if (s > pickSim || (s === pickSim && pickI !== null && Math.abs(i - a.hint.block) < Math.abs(pickI - a.hint.block))) {
      pickSim = s
      pickI = i
    }
  }
  if (pickI !== null) return { state: 'fuzzy', block: pickI }
  return { state: 'detached' }
}

// ------------------------------------------------------------------ public API

export function resolveAnchor(
  p: PText, blocks: BlockInfo[], a: Anchor, o?: { fuzzy?: boolean; preview?: (index: number) => string },
): Resolution {
  if (a.kind === 'doc') return { state: 'doc' }
  if (a.kind === 'block') return resolveBlock(blocks, a, o)

  let normalized: Normalized | null = null
  const N = (): Normalized => (normalized ??= normalizeForMatch(p.text))
  const long = a.tail !== undefined && a.span !== undefined
  // a long anchor's suffix follows the tail, not the head, so the head is scored on its prefix alone
  const ctx: Ctx = { prefix: a.prefix, suffix: long ? '' : a.suffix, hint: a.hint }

  let head: Hit | null
  if (a.quote === '') head = resolveJunction(p, ctx, N)
  else head = resolveExact(p, blocks, a.quote, ctx) ?? resolveNormalized(p, blocks, a.quote, ctx, N()) ?? (o?.fuzzy ? (resolveFuzzy(p, blocks, a.quote, ctx) ?? resolveDiff(p, a.quote, ctx)) : null)
  if (!head) return { state: 'detached' }
  if (!long) return toResolution(p, head)

  // long anchor (D45): the tail exactly (raw, then normalized) in [head.from + 0.75·span − tail.length, head.from + 1.25·span]
  const span = a.span!
  const tail = a.tail!
  const winStart = Math.max(0, Math.floor(head.from + 0.75 * span - tail.length))
  const winEnd = Math.min(p.text.length, Math.ceil(head.from + 1.25 * span))
  const target = head.from + span
  let tailHit: { to: number; state: 'exact' | 'moved' } | null = null
  const raw = occurrences(p.text, tail, winStart, winEnd)
  if (raw.length) {
    let at = raw[0]!
    for (const h of raw) if (Math.abs(h + tail.length - target) < Math.abs(at + tail.length - target)) at = h
    tailHit = { to: at + tail.length, state: at + tail.length === target ? 'exact' : 'moved' }
  } else {
    const n = N()
    const nt = normalizeForMatch(tail).text
    const lo = normIndexOf(n, winStart)
    const hi = normIndexOf(n, winEnd)
    const hits = nt ? occurrences(n.text, nt, lo, hi) : []
    if (hits.length) {
      let best: { to: number } | null = null
      for (const h of hits) {
        const to = rawRange(n, h, h + nt.length).to
        if (!best || Math.abs(to - target) < Math.abs(best.to - target)) best = { to }
      }
      tailHit = { to: best!.to, state: 'moved' }
    }
  }
  if (!tailHit) return { state: 'detached' }
  return toResolution(p, { state: worse(head.state, tailHit.state), from: head.from, to: tailHit.to, ambiguous: head.ambiguous })
}

/**
 * §5.4 / D35: a block anchor follows a 1:1 replace of its block. Returns the anchor re-created on the replacement,
 * or null when no change replaced exactly that one block with exactly one block.
 */
export function followBlockAnchor(a: BlockAnchor, changes: readonly BlockChange[], blocks: BlockInfo[], rev: number): BlockAnchor | null {
  for (const c of changes) {
    if (c.op !== 'replace' || !c.before || !c.after) continue
    if (c.before.count !== 1 || c.after.count !== 1) continue
    if (!c.before.hashes.includes(a.hint.blockHash)) continue
    if (!blocks[c.after.index]) continue
    return createBlockAnchor(blocks, c.after.index, rev)
  }
  return null
}

/**
 * §5.4 logging rule (D7): what to store after resolving `a` at `rev`, or null when nothing is logged. A fuzzy text
 * resolution is re-created over the resolved span (a fuzzy block one over the resolved block); an exact or moved text
 * resolution is refreshed only when its quote occurs more than once in the ptext and the re-created anchor differs
 * from the stored one in prefix, suffix, hint.block or hint.blockHash. Plain moves of a unique quote are never logged.
 */
export function refreshAnchor(p: PText, blocks: BlockInfo[], a: Anchor, r: Resolution, rev: number): Anchor | null {
  if (a.kind === 'doc' || r.state === 'detached' || r.state === 'doc') return null
  if (a.kind === 'block') return r.state === 'fuzzy' && r.block !== undefined ? createBlockAnchor(blocks, r.block, rev) : null
  if (r.from === undefined || r.to === undefined) return null
  const fresh = createAnchor(p, blocks, r.from, r.to, rev)
  if (r.state === 'fuzzy') return fresh
  if (!a.quote || occurrences(p.text, a.quote).length < 2) return null
  const differs = fresh.prefix !== a.prefix || fresh.suffix !== a.suffix
    || fresh.hint.block !== a.hint.block || fresh.hint.blockHash !== a.hint.blockHash
  return differs ? fresh : null
}
