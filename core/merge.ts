// core/merge.ts (P1). Block-level 3-way merge, server-side (CONTRACTS §7.3, R4.4).
//
// 1. Fast path: the base block hashes equal the current ones → the ops apply as they are.
// 2. Align baseHashes to current.blocks by hash (prefix, suffix, LCS; core/blocks alignHashes) → map(i) → j | null.
// 3. Each op with covered blocks:
//    - every covered base block maps, to consecutive current indices j0..jk → retarget (after' = j0 − 1,
//      before' = jk + 1, same covers, same blocks). The neighbours' state doesn't matter, so Claude editing the block
//      next to TJ's never conflicts (row 10).
//    - else, the op's blocks equal the current text of the region where the covered blocks were → drop (both sides
//      made the same change).
//    - else → one BlockConflict per op (`conflict:` + covers[0]): base from `baseText` ('' when GC'd), mine = the op's
//      blocks joined by a blank line (null = TJ deleted it), theirs = the current text between the images of the
//      op's neighbours (null = deleted on disk), theirsBy / theirsRev from `theirsBy`.
// 4. Each pure insertion: after map(after); else before map(before); else after the nearest preceding mapped block;
//    else at BOF. Insertions never conflict.
// The caller applies `mapped` with applyBlockOps(current, mapped) (step 5): seams come from the current gaps.
//
// `mapped` is sorted by `after` and never overlaps (applyBlockOps' precondition). Two outputs can only touch when
// their base neighbours moved together: an insertion landing against (or, once its anchor was rewritten, inside) a
// retargeted run, or two runs whose untouched separator the other side deleted. Touching outputs are folded into one
// op over the union of their covered blocks, blocks in order (an insertion inside a run lands after the run).
import type { Actor, BlockConflict, BlockHash, BlockOp } from '../shared/types'
import { alignHashes } from './blocks'
import type { Loaded } from './splice/load'

export interface MergeInput { baseHashes: BlockHash[]; current: Loaded; ops: BlockOp[]; theirsBy: (currentIndex: number) => { by: Actor; rev: number } }
export interface MergeOutput { mapped: BlockOp[]; conflicts: BlockConflict[]; dropped: number[] }

export function merge3way(i: MergeInput, baseText: (index: number) => string | null): MergeOutput {
  const cur = i.current
  const curHashes = cur.blocks.map((b) => b.hash)
  const fast = i.baseHashes.length === curHashes.length && i.baseHashes.every((h, k) => h === curHashes[k])
  if (fast) return { mapped: i.ops.map((o) => ({ ...o, covers: [...o.covers], blocks: [...o.blocks] })), conflicts: [], dropped: [] }

  const map = alignHashes(i.baseHashes, curHashes)
  const nBase = i.baseHashes.length
  const n = curHashes.length
  const blank = cur.eol + cur.eol
  const img = (b: number): number | null => (b >= 0 && b < nBase ? (map[b] ?? null) : null)
  /** Current index of the nearest mapped base block at or before `b` (-1 = BOF). */
  const leftImage = (b: number): number => {
    for (let k = Math.min(b, nBase - 1); k >= 0; k--) {
      const j = map[k]
      if (j !== null && j !== undefined) return j
    }
    return -1
  }
  /** Current index of the nearest mapped base block at or after `b` (n = EOF). */
  const rightImage = (b: number): number => {
    for (let k = Math.max(b, 0); k < nBase; k++) {
      const j = map[k]
      if (j !== null && j !== undefined) return j
    }
    return n
  }
  const regionBlocks = (from: number, to: number): string[] => cur.blocks.slice(from, Math.max(from, to)).map((b) => cur.src.slice(b.start, b.end))
  const regionText = (from: number, to: number): string | null =>
    to > from ? cur.src.slice(cur.blocks[from]!.start, cur.blocks[to - 1]!.end) : null

  const mapped: BlockOp[] = []
  const conflicts: BlockConflict[] = []
  const dropped: number[] = []

  i.ops.forEach((op, k) => {
    if (op.covers.length === 0) {
      // step 4: insertions never conflict
      let at: number
      const a = img(op.after)
      const b = img(op.before)
      if (op.after === -1) at = -1
      else if (a !== null) at = a
      else if (b !== null) at = b - 1
      else at = leftImage(op.after)
      mapped.push({ after: at, before: at + 1, covers: [], blocks: [...op.blocks] })
      return
    }
    const js = op.covers.map((_, c) => img(op.after + 1 + c))
    const consecutive = js.every((j, c) => j !== null && (c === 0 || j === js[c - 1]! + 1))
    if (consecutive) {
      const j0 = js[0]!
      const jk = js[js.length - 1]!
      mapped.push({ after: j0 - 1, before: jk + 1, covers: [...op.covers], blocks: [...op.blocks] })
      return
    }
    // where the covered blocks were: strictly between the images of the op's untouched neighbours
    const left = leftImage(op.after)
    const right = rightImage(op.before)
    const theirs = regionText(left + 1, right)
    const mine = op.blocks.length ? op.blocks.join(blank) : null
    const theirBlocks = regionBlocks(left + 1, right)
    const same = mine === theirs || (op.blocks.length > 0 && op.blocks.length === theirBlocks.length && op.blocks.every((b, c) => b === theirBlocks[c]))
    if (same) {
      dropped.push(k)
      return
    }
    const base = op.covers.map((_, c) => baseText(op.after + 1 + c) ?? '').join(blank)
    const currentIndex = right > left + 1 ? left + 1 : null
    const who = i.theirsBy(currentIndex ?? Math.max(0, Math.min(left + 1, n - 1)))
    conflicts.push({
      kind: 'conflict', id: `conflict:${op.covers[0]!}`, baseIndex: op.after + 1, currentIndex,
      base, mine, theirs, theirsBy: who.by, theirsRev: who.rev,
    })
  })

  // keep `mapped` sorted and non-overlapping (stable: insertions at one spot keep their op order)
  const order = mapped.map((op, k) => ({ op, k }))
  order.sort((x, y) => x.op.after - y.op.after || x.op.before - y.op.before || x.k - y.k)
  const out: BlockOp[] = []
  for (const { op } of order) {
    const prev = out[out.length - 1]
    if (prev && prev.before > op.after) {
      out[out.length - 1] = {
        after: prev.after,
        before: Math.max(prev.before, op.before),
        covers: [...prev.covers, ...op.covers],
        blocks: [...prev.blocks, ...op.blocks],
      }
      continue
    }
    out.push(op)
  }
  return { mapped: out, conflicts, dropped }
}
