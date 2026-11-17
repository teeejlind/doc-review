// core/suggest/record.ts (P1). Claude CLI → canonical source-level suggestion record (CONTRACTS §6.1, §6.2, §6.7).
//
// A record is a block-run replacement: range (block index hint), base (exact source of the run, gaps between its
// blocks included, outer gaps excluded), proposed (exact replacement bytes in doc EOL) and display hunks (a diff of
// ptext(base) vs ptext(proposed), word-level). The server and CLI act on it without ProseMirror.
//
// - fromQuote (§6.2 step 1, §5.5): the source span [a, b) of the quote (exact, then whitespace-normalized); the run
//   is every block intersecting it; atom runs → UNANCHORABLE_TARGET. A source miss whose ptext search hits →
//   QUOTE_NOT_IN_SOURCE with `sourceQuote`; no hit at all → QUOTE_NOT_FOUND with up to 3 near-misses (similarity
//   ≥ 0.6, never applied). The store turns QUOTE_NOT_FOUND into QUOTE_IN_PENDING_SUGGESTION when the text occurs only
//   inside a pending suggestion's `proposed` (it alone has the review state), and runs the overlap check (step 2).
// - fromBlock (suggest_block): base = the block's source, proposed = the markdown in doc EOL; same atom refusal.
// - locate: `base` found exactly as a contiguous run (starting and ending on block boundaries), unique or nearest the
//   range hint (§6.7 step 1; computed on read, never logged).
// - applyToSource: one BlockOp at the located run through applyBlockOps. `verified` is the merge-hazard check (§6.2
//   step 3): splice verification passed, and no list-merge flip fired (a flip in the new blocks would change the
//   suggester's bytes; one in a neighbouring list would change a block outside the run).
// - rebase (§6.7 step 2): exact first; else candidate runs (the base's first or last block hash nearest the hint;
//   dmp match_main on the base's first 32 chars near the hint; the best run with similarity ≥ 0.6), each patched with
//   patch_make(base, proposed) at Match_Threshold 0.3, Patch_DeleteThreshold 0.3, Patch_Margin 8; the first candidate
//   whose patches all apply and whose result passes the merge-hazard check wins. Otherwise { stale }: MERGE_HAZARD when
//   a candidate patched cleanly but failed the hazard check, else BASE_GONE.
// `range.rev` is left as given (0 from fromQuote / fromBlock, the record's own from rebase): Loaded carries no rev, so
// the caller stamps the current rev.
import DiffMatchPatch from 'diff-match-patch'
import type { BlockOp, Hunk, QuoteCandidate, StaleReason, SuggestionBody } from '../../shared/types'
import { StoreError } from '../../shared/errors'
import { refOf } from '../../shared/ids'
import { similarity } from '../anchors'
import { isAtomBlock } from '../blocks'
import { convertEol } from '../eol'
import type { Md } from '../md/index'
import { ptextOf } from '../ptext'
import { findQuoteInPtext, findQuoteInSource, pickQuoteHit, quoteContext, sourceSpanOfPtext } from '../quote'
import { applyBlockOps } from '../splice/apply'
import { load, type Loaded } from '../splice/load'
import { wordSpans } from './words'

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 0

/** §6.7 patch settings. */
const patcher = new DiffMatchPatch()
patcher.Diff_Timeout = 0
patcher.Match_Threshold = 0.3
patcher.Patch_DeleteThreshold = 0.3
patcher.Patch_Margin = 8

/** Similarity floor for near-misses (§5.5) and for the rebase similarity candidate (§6.7). */
export const NEAR_MISS_SIMILARITY = 0.6
const MAX_NEAR_MISSES = 3
/** Blocks either side of the hint the rebase similarity scan looks at. */
const REBASE_SCAN_RADIUS = 12

function refuseAtoms(L: Loaded, start: number, end: number): void {
  for (let k = start; k < end; k++) {
    const b = L.blocks[k]!
    if (isAtomBlock(b)) {
      throw new StoreError('UNANCHORABLE_TARGET', `block ${b.ref} is an atom block (${b.kind}/${b.mdType}) and takes no inline suggestion`, {
        hint: 'atoms take no inline suggestion: use `comment --block bN` to ask, or `edit-block` to write it directly',
      })
    }
  }
}

/** Index of the block containing source offset `offset` (a gap belongs to the next block; past the end → the last). */
export function blockAtSource(L: Pick<Loaded, 'blocks'>, offset: number): number {
  const k = L.blocks.findIndex((b) => b.end > offset)
  return k < 0 ? Math.max(0, L.blocks.length - 1) : k
}

/** The block indexes [start, end) intersecting the source span [a, b) (a point span: the block containing it). */
export function runFor(L: Pick<Loaded, 'blocks'>, a: number, b: number): { start: number; end: number } | null {
  let start = -1
  let end = -1
  L.blocks.forEach((blk, k) => {
    const hit = b > a ? blk.end > a && blk.start < b : blk.start <= a && a <= blk.end
    if (!hit) return
    if (start < 0) start = k
    end = k + 1
  })
  return start < 0 ? null : { start, end }
}

/**
 * Up to 3 near-misses for a quote that has no hit (§5.5: similarity ≥ 0.6, shown, never applied). `ranges` segments
 * `text` into blocks (source offsets for byte ops, ptext offsets for comments); the best window per block is found
 * with dmp bitap on the quote's head and scored by similarity over the quote's length.
 */
export function quoteNearMisses(
  text: string, ranges: ReadonlyArray<{ index: number; start: number; end: number }>, quote: string, lineOf: (index: number) => number,
): QuoteCandidate[] {
  if (!quote.trim()) return []
  const head = quote.slice(0, 32)
  const m = new DiffMatchPatch()
  m.Match_Threshold = 0.5
  m.Match_Distance = 1_000_000
  const found: Array<{ index: number; from: number; to: number; sim: number }> = []
  for (const r of ranges) {
    const seg = text.slice(r.start, r.end)
    if (!seg) continue
    let loc = -1
    try {
      loc = m.match_main(seg, head, 0)
    } catch {
      loc = -1
    }
    const starts = loc >= 0 ? [loc] : seg.length <= quote.length * 2 ? [0] : []
    for (const s0 of starts) {
      let best: { from: number; to: number; sim: number } | null = null
      for (const len of [quote.length, Math.round(quote.length * 0.9), Math.round(quote.length * 1.1)]) {
        const to = Math.min(seg.length, s0 + Math.max(1, len))
        const sim = similarity(seg.slice(s0, to), quote)
        if (!best || sim > best.sim) best = { from: s0, to, sim }
      }
      if (best && best.sim >= NEAR_MISS_SIMILARITY && best.sim < 1) found.push({ index: r.index, from: r.start + best.from, to: r.start + best.to, sim: best.sim })
    }
  }
  found.sort((a, b) => b.sim - a.sim || a.from - b.from)
  return found.slice(0, MAX_NEAR_MISSES).sort((a, b) => a.from - b.from).map((f, k) => ({
    occurrence: k + 1, block: refOf(f.index), line: lineOf(f.index), context: quoteContext(text, f.from, f.to),
    similarity: Math.round(f.sim * 1000) / 1000,
  }))
}

/**
 * The §5.5 miss ladder for a byte-changing quote with no source hit: QUOTE_NOT_IN_SOURCE when the ptext search hits
 * (with the exact source span behind the hit), else QUOTE_NOT_FOUND with near-misses over the source.
 */
export function sourceQuoteMiss(md: Md, L: Loaded, quote: string): never {
  const P = ptextOf(L.doc, L)
  const ph = findQuoteInPtext(md, P, quote)[0]
  if (ph) {
    const span = sourceSpanOfPtext(L.src, L.blocks, P, ph.from, ph.to)
    throw new StoreError('QUOTE_NOT_IN_SOURCE', 'the quote matches the rendered text but not the markdown source', {
      sourceQuote: L.src.slice(span.start, span.end), hint: 'retry once with the exact source bytes in sourceQuote',
    })
  }
  const candidates = quoteNearMisses(L.src, L.blocks.map((b) => ({ index: b.index, start: b.start, end: b.end })), quote, (i) => L.blocks[i]?.line ?? 1)
  throw new StoreError('QUOTE_NOT_FOUND', `quote not found in the markdown source: ${JSON.stringify(quote.slice(0, 80))}`, { candidates })
}

export function fromQuote(md: Md, L: Loaded, q: { quote: string; replace: string; occurrence?: number; near?: number }): SuggestionBody {
  const hits = findQuoteInSource(L.src, q.quote)
  if (!hits.length) sourceQuoteMiss(md, L, q.quote)
  const withBlocks = hits.map((h) => ({ ...h, block: blockAtSource(L, h.start) }))
  const picked = pickQuoteHit(withBlocks, {
    ...(q.occurrence !== undefined ? { occurrence: q.occurrence } : {}),
    ...(q.near !== undefined ? { near: q.near } : {}),
  })
  if (picked === null) {
    throw new StoreError('QUOTE_NOT_FOUND', `occurrence ${q.occurrence ?? 1} of the quote does not exist (${hits.length} found)`, { candidates: [] })
  }
  if (picked === 'ambiguous') {
    const candidates: QuoteCandidate[] = withBlocks.map((h, k) => ({
      occurrence: k + 1, block: refOf(h.block), line: L.blocks[h.block]?.line ?? 1, context: quoteContext(L.src, h.start, h.end),
    }))
    throw new StoreError('QUOTE_AMBIGUOUS', `quote matches ${hits.length} places`, { hint: 'pass --occurrence N, or --near bN --base-rev R', candidates })
  }
  const hit = picked.hit
  const run = runFor(L, hit.start, hit.end)
  if (!run) throw new StoreError('QUOTE_NOT_FOUND', 'the quote lies outside every block', { candidates: [] })
  refuseAtoms(L, run.start, run.end)
  const s0 = L.blocks[run.start]!.start
  const s1 = L.blocks[run.end - 1]!.end
  const a = Math.max(hit.start, s0)
  const b = Math.min(hit.end, s1)
  const base = L.src.slice(s0, s1)
  const proposed = base.slice(0, a - s0) + convertEol(q.replace, L.eol) + base.slice(b - s0)
  return { range: { start: run.start, end: run.end, rev: 0 }, base, proposed, hunks: hunksOf(md, { base, proposed }, L.blocks[run.start]!.pStart) }
}

export function fromBlock(md: Md, L: Loaded, target: number, markdown: string): SuggestionBody {
  const b = L.blocks[target]
  if (!b) throw new StoreError('BLOCK_NOT_FOUND', `no block at index ${target}`)
  refuseAtoms(L, target, target + 1)
  const base = L.src.slice(b.start, b.end)
  const proposed = convertEol(markdown, L.eol)
  return { range: { start: target, end: target + 1, rev: 0 }, base, proposed, hunks: hunksOf(md, { base, proposed }, b.pStart) }
}

/** Every exact run of `base` in L (block-aligned at both ends), in doc order. */
function exactRuns(L: Pick<Loaded, 'src' | 'blocks'>, base: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = []
  if (base === '') return found
  const starts = new Map<number, number>()
  L.blocks.forEach((b, k) => starts.set(b.start, k))
  for (let at = L.src.indexOf(base); at !== -1; at = L.src.indexOf(base, at + 1)) {
    const k = starts.get(at)
    if (k === undefined) continue
    const endOff = at + base.length
    for (let e = k; e < L.blocks.length; e++) {
      if (L.blocks[e]!.end === endOff) {
        found.push({ start: k, end: e + 1 })
        break
      }
      if (L.blocks[e]!.end > endOff) break
    }
  }
  return found
}

export function locate(L: Pick<Loaded, 'src' | 'blocks'>, s: Pick<SuggestionBody, 'base' | 'range'>): { start: number; end: number } | null {
  const found = exactRuns(L, s.base)
  if (!found.length) return null
  return found.reduce((best, r) => (Math.abs(r.start - s.range.start) < Math.abs(best.start - s.range.start) ? r : best))
}

/** The single op that splices `s.proposed` over the run at `at` (§6.6: exactly the suggester's bytes). */
function opAt(L: Loaded, at: { start: number; end: number }, proposed: string): BlockOp {
  return {
    after: at.start - 1,
    before: at.end,
    covers: L.blocks.slice(at.start, at.end).map((b) => b.hash),
    blocks: proposed === '' ? [] : [proposed],
  }
}

export function applyToSource(md: Md, L: Loaded, s: SuggestionBody): { text: string; ops: BlockOp[]; verified: boolean } {
  const at = locate(L, s)
  if (!at) throw new StoreError('SUGGESTION_STALE', 'the suggestion base is no longer in the document')
  const ops = [opAt(L, at, s.proposed)]
  const r = applyBlockOps(md, L, ops)
  return { text: r.text, ops, verified: r.verified && r.flips.length === 0 }
}

/** dmp similarity over long runs (deterministic, no timeout). */
function runSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  if (a.length * b.length <= 250_000) return similarity(a, b)
  return 1 - dmp.diff_levenshtein(dmp.diff_main(a, b, false)) / max
}

export function rebase(md: Md, L: Loaded, s: SuggestionBody): SuggestionBody | { stale: StaleReason } {
  const n = L.blocks.length
  const exact = locate(L, s)
  if (exact) {
    return { range: { start: exact.start, end: exact.end, rev: s.range.rev }, base: s.base, proposed: s.proposed, hunks: hunksOf(md, s, L.blocks[exact.start]!.pStart) }
  }
  if (s.base === '' || n === 0) return { stale: 'BASE_GONE' }
  const B = load(md, s.base)
  const count = Math.max(1, B.blocks.length)
  const hint = Math.max(0, Math.min(n - 1, s.range.start))
  const runAt = (start: number): { start: number; end: number } => {
    const st = Math.max(0, Math.min(start, n - 1))
    return { start: st, end: Math.min(n, st + count) }
  }
  const nearest = (hash: string | undefined): number | null => {
    if (hash === undefined) return null
    let best: number | null = null
    L.blocks.forEach((b, k) => {
      if (b.hash === hash && (best === null || Math.abs(k - hint) < Math.abs(best - hint))) best = k
    })
    return best
  }

  const candidates: Array<{ start: number; end: number }> = []
  const add = (c: { start: number; end: number } | null): void => {
    if (c && c.end > c.start && !candidates.some((x) => x.start === c.start && x.end === c.end)) candidates.push(c)
  }
  // (a) the base's first or last block hash, nearest the hint
  const first = nearest(B.blocks[0]?.hash)
  if (first !== null) add(runAt(first))
  const last = nearest(B.blocks[B.blocks.length - 1]?.hash)
  if (last !== null) add({ start: Math.max(0, last - count + 1), end: last + 1 })
  // (b) dmp match_main on the base's first 32 chars near the hint
  if (!candidates.length) {
    const m = new DiffMatchPatch()
    m.Match_Threshold = 0.5
    let loc = -1
    try {
      loc = m.match_main(L.src, s.base.slice(0, 32), L.blocks[hint]!.start)
    } catch {
      loc = -1
    }
    if (loc >= 0) add(runAt(blockAtSource(L, loc)))
  }
  // (c) the best run with similarity >= 0.6 near the hint
  {
    let best: { start: number; end: number; sim: number } | null = null
    for (let st = Math.max(0, hint - REBASE_SCAN_RADIUS); st <= Math.min(n - 1, hint + REBASE_SCAN_RADIUS); st++) {
      const r = runAt(st)
      const text = L.src.slice(L.blocks[r.start]!.start, L.blocks[r.end - 1]!.end)
      const sim = runSimilarity(text, s.base)
      if (sim >= NEAR_MISS_SIMILARITY && (!best || sim > best.sim || (sim === best.sim && Math.abs(st - hint) < Math.abs(best.start - hint)))) {
        best = { ...r, sim }
      }
    }
    if (best) add({ start: best.start, end: best.end })
  }

  let hazard = false
  const patches = patcher.patch_make(s.base, s.proposed)
  for (const c of candidates) {
    if (L.blocks.slice(c.start, c.end).some((b) => isAtomBlock(b))) continue
    const base = L.src.slice(L.blocks[c.start]!.start, L.blocks[c.end - 1]!.end)
    const [patched, applied] = patcher.patch_apply(patches, base) as [string, boolean[]]
    if (!applied.every(Boolean)) continue
    const proposed = convertEol(patched, L.eol)
    if (proposed === base) continue
    const body: SuggestionBody = {
      range: { start: c.start, end: c.end, rev: s.range.rev }, base, proposed, hunks: hunksOf(md, { base, proposed }, L.blocks[c.start]!.pStart),
    }
    try {
      if (applyToSource(md, L, body).verified) return body
      hazard = true
    } catch {
      hazard = true
    }
  }
  return { stale: hazard ? 'MERGE_HAZARD' : 'BASE_GONE' }
}

/**
 * Display hunks: a word-level diff (words.ts) of ptext(base) vs ptext(proposed); `at` = base ptext offset of the run.
 * Whitespace-only hunks are left out when a real change is present.
 */
export function hunksOf(md: Md, s: Pick<SuggestionBody, 'base' | 'proposed'>, at: number): Hunk[] {
  const pt = (text: string): string => {
    if (text === '') return ''
    const L = load(md, text)
    return ptextOf(L.doc, L).text
  }
  const a = pt(s.base)
  const b = pt(s.proposed)
  const hunks: Hunk[] = wordSpans(a, b).map((s) => trimShared({ del: a.slice(s.a0, s.a1), ins: b.slice(s.b0, s.b1), at: at + s.a0 }))
  const real = hunks.filter((h) => h.del.trim() !== '' || h.ins.trim() !== '')
  return real.length ? real : hunks
}

/** A replace whose two sides both start (or end) with whitespace shows without it: the spacing change isn't the point. */
function trimShared(h: Hunk): Hunk {
  if (!h.del || !h.ins) return h
  let { del, ins, at } = h
  const lead = (s: string): number => s.length - s.trimStart().length
  if (lead(del) > 0 && lead(ins) > 0 && del.trim() !== '' && ins.trim() !== '') {
    at += lead(del)
    del = del.trimStart()
    ins = ins.trimStart()
  }
  if (del.trim() !== '' && ins.trim() !== '' && del.length - del.trimEnd().length > 0 && ins.length - ins.trimEnd().length > 0) {
    del = del.trimEnd()
    ins = ins.trimEnd()
  }
  return { del, ins, at }
}

// ------------------------------------------------------------------ overlap (§6.2 step 2)

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let k = 0
  while (k < max && a[k] === b[k]) k++
  return k
}

/** Source span a record changes, relative to its run start: [prefix, base.length − suffix). Empty = a pure insert. */
export function changedSpan(s: Pick<SuggestionBody, 'base' | 'proposed'>): [number, number] {
  const p = commonPrefixLen(s.base, s.proposed)
  let sfx = 0
  while (sfx < s.base.length - p && sfx < s.proposed.length - p && s.base[s.base.length - 1 - sfx] === s.proposed[s.proposed.length - 1 - sfx]) sfx++
  return [p, s.base.length - sfx]
}

/** Two changed spans intersect (a point span touches a range it lies in or on). */
export function spansOverlap(a: [number, number], b: [number, number]): boolean {
  const aEmpty = a[0] >= a[1]
  const bEmpty = b[0] >= b[1]
  if (aEmpty && bEmpty) return a[0] === b[0]
  if (aEmpty) return a[0] >= b[0] && a[0] <= b[1]
  if (bEmpty) return b[0] >= a[0] && b[0] <= a[1]
  return a[0] < b[1] && b[0] < a[1]
}
