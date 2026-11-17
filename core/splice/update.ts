// core/splice/update.ts (P1). updateLoaded: the post-save Loaded (CONTRACTS §3.4, gates G2 and G3).
//
// Incremental: only the changed region of the text is re-classified, and everything outside it is reused.
//  1. The changed range is the char-level common prefix / suffix of the old and new text. That covers whatever
//     applyBlockOps actually wrote (ops, recorded flips, widened neighbours), so `ops` is advisory only.
//  2. The region is the changed entries plus one unchanged margin entry on each side, re-classified with the same
//     classifier load() uses, the doc's EOL and the doc's defs as context. Its first and last entries must come back
//     with exactly the margins' extents, or the edit reached outside the region (a merge, a setext underline) and
//     the full load() runs instead.
//  3. The doc's definition set (raw `gap` entries and footnote definitions) must be unchanged: a changed set can
//     change how blocks far away parse, so it also falls back to load(). So does an EOL flip or an empty doc.
//  4. Entries before the region keep their objects and BlockInfo; entries after it keep their nodes and get shifted
//     offsets, lines, ptext ranges and indexes; region blocks get fresh BlockInfo from the same per-block code
//     blockMap uses (blockInfoOf + segmentsOf).
// Without `liveNodes` the result equals load(md, text) (G2, asserted over the corpus); the region usually hits the
// classification cache applyBlockOps' verification just filled, so a one-block op on a 10k-word doc costs a small
// region parse (< 5 ms, BUDGETS.md).
//
// `liveNodes` (G3): the editor's top-level content nodes, i.e. contentNodes(baseDoc) for the whole doc (or just the
// nodes of the rewritten region). A rewritten entry adopts the editor's node at the same position when it is nodeEq to
// the parsed one, or when the editor node's own rendering re-parses to the parsed one (a split paragraph's trailing
// space, which markdown drops). An immediate re-plan of the same doc then yields []. Positions are only trusted when
// the counts match exactly; otherwise liveNodes is ignored.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { BlockInfo, BlockOp } from '../../shared/types'
import { refOf } from '../../shared/ids'
import type { Md } from '../md/index'
import { blockInfoOf, blockMap } from '../blocks'
import { detectEol, lineAt, lineStarts } from '../eol'
import { segmentsOf } from '../ptext'
import { nodeEq } from './eq'
import { classifyText, defsOfEntries, load, loadRun, type Entry, type Loaded } from './load'
import { renderNode } from './render'

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let k = 0
  while (k < max && a.charCodeAt(k) === b.charCodeAt(k)) k++
  return k
}

function commonSuffixLen(a: string, b: string, max: number): number {
  let k = 0
  while (k < max && a.charCodeAt(a.length - 1 - k) === b.charCodeAt(b.length - 1 - k)) k++
  return k
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return n
}

/** The editor node `live` writes exactly what the file now holds for `parsed` (identity, or a canonical re-parse). */
function liveMatches(md: Md, live: PMNode, parsed: PMNode, defs: string, eol: Loaded['eol']): boolean {
  if (live === parsed || nodeEq(live, parsed)) return true
  try {
    const re = loadRun(md, renderNode(md, live, eol), defs, eol)
    return re.length === 1 && nodeEq(re[0]!, parsed)
  } catch {
    return false
  }
}

/** Replace entries[from..to)'s nodes with matching live nodes; `g0` = global content-node index of entries[from]. */
function adopt(md: Md, entries: Entry[], from: number, to: number, g0: number, live: readonly PMNode[], defs: string, eol: Loaded['eol']): boolean {
  let changed = false
  let g = g0
  for (let k = from; k < to; k++) {
    const e = entries[k]!
    let nodes: PMNode[] | null = null
    e.nodes.forEach((x, j) => {
      const y = live[g + j]
      if (y && y !== x && liveMatches(md, y, x, defs, eol)) (nodes ??= [...e.nodes])[j] = y
    })
    if (nodes) {
      entries[k] = { ...e, nodes, parsed: e.parsed ?? e.nodes }
      changed = true
    }
    g += e.nodes.length
  }
  return changed
}

const docOf = (md: Md, entries: readonly Entry[]): PMNode => {
  const all = entries.flatMap((e) => e.nodes)
  return md.schema.topNodeType.create(null, all.length ? all : [md.schema.nodes.paragraph!.create()])
}

/** The incremental path, or null when it can't prove the result equals load(md, text). */
function incremental(md: Md, L: Loaded, T: string, live: readonly PMNode[] | undefined): Loaded | null {
  const S = L.src
  const n = L.entries.length
  if (n === 0 || detectEol(T) !== L.eol) return null
  // the reused block map must have the plain ptext layout (every block has a segment, one separator between)
  for (let k = 0; k < n; k++) {
    const b = L.blocks[k]
    if (!b || b.pStart !== (k === 0 ? 0 : L.blocks[k - 1]!.pEnd + 1)) return null
  }
  if (defsOfEntries(S, L.entries) !== L.defs) return null

  const p = commonPrefixLen(S, T)
  const q = commonSuffixLen(S, T, Math.min(S.length, T.length) - p)
  const delta = T.length - S.length

  // first entry the change can touch (an entry ending exactly at p may have been extended) and the last one
  let fc = 0
  while (fc < n && L.entries[fc]!.end < p) fc++
  let lc = n - 1
  while (lc >= 0 && L.entries[lc]!.start > S.length - q) lc--
  const a = fc - 1
  const b = lc + 1
  const rs = a >= 0 ? L.entries[a]!.start : 0
  const reS = b < n ? L.entries[b]!.end : S.length
  if (rs > p || reS < S.length - q) return null
  const RT = T.slice(rs, reS + delta)

  const R = classifyText(md, RT, L.defs ? { eol: L.eol, context: L.defs, defs: L.defs } : { eol: L.eol, defs: '' })
  const m = R.entries.length
  const left = a >= 0 ? 1 : 0
  const right = b < n ? 1 : 0
  if (m < left + right) return null
  if (left) {
    const e0 = R.entries[0]!
    if (e0.start !== 0 || e0.end !== L.entries[a]!.end - rs) return null
  }
  if (right) {
    const el = R.entries[m - 1]!
    if (el.start !== L.entries[b]!.start + delta - rs || el.end !== RT.length) return null
  } else if (m && R.entries[m - 1]!.end > RT.length) return null

  const inner = R.entries.slice(left, m - right).map((e) => ({ ...e, start: e.start + rs, end: e.end + rs }))
  const suffix = L.entries.slice(b).map((e) => (delta ? { ...e, start: e.start + delta, end: e.end + delta } : e))
  const entries: Entry[] = [...L.entries.slice(0, a + 1), ...inner, ...suffix]
  const gaps = [...L.gaps.slice(0, a + 1), ...R.gaps.slice(left, right ? m : m + 1), ...(right ? L.gaps.slice(b + 1) : [])]
  if (defsOfEntries(T, entries) !== L.defs) return null

  const firstInner = a + 1
  if (live && inner.length) {
    const total = entries.reduce((s, e) => s + e.nodes.length, 0)
    const innerCount = inner.reduce((s, e) => s + e.nodes.length, 0)
    if (live.length === total) {
      let g0 = 0
      for (let k = 0; k < firstInner; k++) g0 += entries[k]!.nodes.length
      adopt(md, entries, firstInner, firstInner + inner.length, g0, live, L.defs, L.eol)
    } else if (live.length === innerCount) {
      adopt(md, entries, firstInner, firstInner + inner.length, 0, live, L.defs, L.eol)
    }
  }

  // block map: prefix reused, region fresh, suffix shifted
  const blocks: BlockInfo[] = L.blocks.slice(0, a + 1)
  const baseLine = a >= 0 ? L.blocks[a]!.line : 1
  const localStarts = lineStarts(RT)
  let lastEnd = a >= 0 ? L.blocks[a]!.pEnd : -1
  for (let j = 0; j < inner.length; j++) {
    const e = entries[firstInner + j]!
    const segs = segmentsOf(e.nodes)
    if (!segs.length) return null
    const bt = segs.join('\n')
    const pStart = lastEnd < 0 ? 0 : lastEnd + 1
    const pEnd = pStart + bt.length
    lastEnd = pEnd
    const relS = e.start - rs
    const line = baseLine + lineAt(localStarts, relS) - 1
    const endLine = baseLine + lineAt(localStarts, Math.max(relS, e.end - rs - 1)) - 1
    blocks.push(blockInfoOf(e, firstInner + j, T.slice(e.start, e.end), line, endLine, pStart, pEnd, bt))
  }
  if (right) {
    const idxDelta = firstInner + inner.length - b
    const pDelta = (lastEnd < 0 ? 0 : lastEnd + 1) - L.blocks[b]!.pStart
    const lineDelta = countNewlines(RT) - countNewlines(S.slice(rs, reS))
    for (let k = b; k < n; k++) {
      const blk = L.blocks[k]!
      if (!idxDelta && !delta && !pDelta && !lineDelta) {
        blocks.push(blk)
        continue
      }
      const index = k + idxDelta
      blocks.push({
        ...blk, ref: refOf(index), index, start: blk.start + delta, end: blk.end + delta,
        line: blk.line + lineDelta, endLine: blk.endLine + lineDelta, pStart: blk.pStart + pDelta, pEnd: blk.pEnd + pDelta,
      })
    }
  }

  return { src: T, eol: L.eol, entries, gaps, doc: docOf(md, entries), defs: L.defs, blocks }
}

/** Post-save Loaded; reuses the editor's own nodes for written blocks so an immediate re-plan yields []. */
export function updateLoaded(md: Md, L: Loaded, text: string, _ops: BlockOp[], liveNodes?: readonly PMNode[]): Loaded {
  if (text === L.src) return L
  const inc = incremental(md, L, text, liveNodes)
  if (inc) return inc
  const full = load(md, text)
  if (!liveNodes) return full
  const total = full.entries.reduce((s, e) => s + e.nodes.length, 0)
  if (liveNodes.length !== total) return full
  const entries = [...full.entries]
  if (!adopt(md, entries, 0, entries.length, 0, liveNodes, full.defs, full.eol)) return full
  const next: Loaded = { ...full, entries, doc: docOf(md, entries) }
  next.blocks = blockMap(md, next)
  return next
}
