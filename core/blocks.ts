// core/blocks.ts (P1). The block map and the cross-revision block diff (CONTRACTS §3.3).
//
// - blockMap: one BlockInfo per load() entry (asserted 1:1): hash over the source slice, 1-based inclusive lines,
//   kind / mdType / fidelity from the entry, pStart / pEnd from ptext (§5.1), preview = first 80 chars of the block's
//   ptext, or of its source for atom blocks. `blockInfoOf` is the per-block half, shared with updateLoaded's
//   incremental map so the two can't drift.
// - diffBlocks: common prefix, common suffix, then LCS on hash over the middle; each unmatched run between matches is
//   one 'replace' (both sides non-empty, so a split is 1 → 2), else an 'insert' or a 'delete'.
import type { BlockInfo, BlockKind, MdType } from '../shared/types'
import { refOf } from '../shared/ids'
import { lineAt, lineStarts } from './eol'
import { blockHash } from './hash'
import type { Md } from './md/index'
import { ptextOf } from './ptext'
import type { Entry, Loaded } from './splice/load'

export type BlockDiffOp =
  | { op: 'equal'; a: number; b: number; n: number }
  | { op: 'replace' | 'insert' | 'delete'; a: number; an: number; b: number; bn: number }

/** §3.3 "Atom block" (the only definition, D44): kind 'raw' or 'frontmatter', or mdType 'thematicBreak'. */
export function isAtomBlock(b: { kind: BlockKind; mdType: MdType }): boolean {
  return b.kind === 'raw' || b.kind === 'frontmatter' || b.mdType === 'thematicBreak'
}

/**
 * One BlockInfo from its entry, source slice, 1-based inclusive lines, ptext range and the block's own ptext (its
 * segments joined by '\n', which is what the preview is cut from).
 */
export function blockInfoOf(
  e: Pick<Entry, 'kind' | 'mdType' | 'start' | 'end' | 'fidelity'>, index: number, slice: string,
  line: number, endLine: number, pStart: number, pEnd: number, blockPtext: string,
): BlockInfo {
  return {
    ref: refOf(index),
    index,
    kind: e.kind,
    mdType: e.mdType,
    start: e.start,
    end: e.end,
    line,
    endLine,
    hash: blockHash(slice),
    fidelity: e.fidelity,
    pStart,
    pEnd,
    preview: (isAtomBlock(e) ? slice : blockPtext).slice(0, 80),
  }
}

export function blockMap(_md: Md, L: Pick<Loaded, 'src' | 'entries' | 'doc'>): BlockInfo[] {
  const p = ptextOf(L.doc, L)
  if (p.blockRanges.length !== L.entries.length) throw new Error('blockMap: ptext block ranges are not 1:1 with entries')
  const starts = lineStarts(L.src)
  return L.entries.map((e, index) => {
    const r = p.blockRanges[index]!
    return blockInfoOf(
      e, index, L.src.slice(e.start, e.end),
      lineAt(starts, e.start), lineAt(starts, Math.max(e.start, e.end - 1)),
      r.pStart, r.pEnd, p.text.slice(r.pStart, r.pEnd),
    )
  })
}

/**
 * Align two hash sequences: common prefix, common suffix, then LCS on the middle. Returns, for every index of `a`,
 * the matching index in `b` or null. Shared by diffBlocks and the 3-way merge (§7.3 step 2).
 */
export function alignHashes(a: readonly string[], b: readonly string[]): Array<number | null> {
  const n = a.length
  const m = b.length
  const map = new Array<number | null>(n).fill(null)
  let pre = 0
  while (pre < n && pre < m && a[pre] === b[pre]) {
    map[pre] = pre
    pre++
  }
  let suf = 0
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) {
    map[n - 1 - suf] = m - 1 - suf
    suf++
  }
  const an = n - pre - suf
  const bn = m - pre - suf
  if (an > 0 && bn > 0) {
    const dp: Uint32Array[] = Array.from({ length: an + 1 }, () => new Uint32Array(bn + 1))
    for (let i = an - 1; i >= 0; i--) {
      const row = dp[i]!
      const next = dp[i + 1]!
      for (let j = bn - 1; j >= 0; j--) {
        row[j] = a[pre + i] === b[pre + j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < an && j < bn) {
      if (a[pre + i] === b[pre + j]) {
        map[pre + i] = pre + j
        i++
        j++
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
      else j++
    }
  }
  return map
}

export function diffBlocks(a: Pick<BlockInfo, 'hash'>[], b: Pick<BlockInfo, 'hash'>[]): BlockDiffOp[] {
  const map = alignHashes(a.map((x) => x.hash), b.map((x) => x.hash))
  const out: BlockDiffOp[] = []
  let i = 0
  let j = 0
  const gap = (ai: number, bj: number): void => {
    const an = ai - i
    const bn = bj - j
    if (an > 0 && bn > 0) out.push({ op: 'replace', a: i, an, b: j, bn })
    else if (an > 0) out.push({ op: 'delete', a: i, an, b: j, bn: 0 })
    else if (bn > 0) out.push({ op: 'insert', a: i, an: 0, b: j, bn })
  }
  while (i < a.length || j < b.length) {
    // next matched pair at or after (i, j)
    let k = i
    while (k < a.length && map[k] === null) k++
    if (k >= a.length) {
      gap(a.length, b.length)
      break
    }
    const mk = map[k]!
    gap(k, mk)
    i = k
    j = mk
    // extend the equal run
    let n = 0
    while (i + n < a.length && map[i + n] === j + n) n++
    out.push({ op: 'equal', a: i, b: j, n })
    i += n
    j += n
  }
  return out
}
