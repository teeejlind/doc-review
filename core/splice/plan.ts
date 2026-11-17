// core/splice/plan.ts (P1). planSave: S2 save() split into run splices against L (CONTRACTS §3.4, gate G1).
//
// The S2 oracle's alignment and rendering, emitting ops instead of text (core/ can't import
// tests/corpus/oracle-save.ts, §2.3, so the shared pieces live here and in render.ts):
// - align L's top-level nodes with contentNodes(baseDoc) by an LCS on nodeEq (eq.ts, volatile attrs ignored);
// - an entry is kept only when all of its nodes matched, contiguously and in order;
// - every run between kept entries becomes one BlockOp whose `blocks` are the oracle's renderings: Milkdown's
//   serialization, 3-way region-spliced onto the original bytes when a node replaces a single-node semantic entry in
//   place (so untouched escapes, bullets and table pipes survive; FINDINGS failure categories 5 and 6).
// Seams and list-merge flips are applyBlockOps' job, exactly as the oracle's assembly does them, so
// applyBlockOps(L, planSave(L, doc)).text === oracleSave(L, doc).text wherever the oracle verifies (G1).
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { BlockOp } from '../../shared/types'
import type { Md } from '../md/index'
import { contentNodes, nodeEq } from './eq'
import type { Entry, Loaded } from './load'
import { assertNoSuggestionMarks, dmpPatch, parseBlock, regionSplice, renderNode } from './render'

/** LCS alignment of original vs new top-level nodes. Returns newIndex -> origIndex | -1 (the oracle's align()). */
export function alignNodes(orig: readonly PMNode[], next: readonly PMNode[]): number[] {
  const n = orig.length
  const m = next.length
  const map = new Array<number>(m).fill(-1)
  let pre = 0
  while (pre < n && pre < m && nodeEq(orig[pre]!, next[pre]!)) {
    map[pre] = pre
    pre++
  }
  let suf = 0
  while (suf < n - pre && suf < m - pre && nodeEq(orig[n - 1 - suf]!, next[m - 1 - suf]!)) {
    map[m - 1 - suf] = n - 1 - suf
    suf++
  }
  const a = orig.slice(pre, n - suf)
  const b = next.slice(pre, m - suf)
  if (a.length && b.length) {
    // nodeEq once per cell pair, cached: the DP and the walk both consult it
    const eq: Uint8Array[] = a.map((x) => {
      const row = new Uint8Array(b.length)
      for (let j = 0; j < b.length; j++) row[j] = nodeEq(x, b[j]!) ? 1 : 0
      return row
    })
    const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        dp[i]![j] = eq[i]![j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (eq[i]![j]) {
        map[pre + j] = pre + i
        i++
        j++
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
      else j++
    }
  }
  return map
}

/**
 * The oracle's renderReplacement: Milkdown's serialization of the node, 3-way patched onto the original source bytes
 * when it replaces a single-node semantic md entry in place (so untouched escapes, bullets and table pipes survive).
 * A candidate is accepted only if it parses to the same nodes as Milkdown's own serialization; else that is used.
 */
export function renderReplacement(md: Md, L: Pick<Loaded, 'src' | 'eol' | 'defs'>, node: PMNode, orig: Entry | undefined): string {
  const B = renderNode(md, node, L.eol)
  if (!orig || orig.kind !== 'md' || orig.nodes.length !== 1 || orig.fidelity === 'exact') return B
  const S = L.src.slice(orig.start, orig.end)
  const A = renderNode(md, orig.nodes[0]!, L.eol)
  const want = parseBlock(md, B, L.defs)
  const means = (R: string): boolean => {
    const got = parseBlock(md, R, L.defs)
    return got.length === want.length && got.every((n, i) => nodeEq(n, want[i]!))
  }
  for (const R of [regionSplice(A, B, S), dmpPatch(A, B, S)]) if (R !== null && means(R)) return R
  return B
}

export function planSave(md: Md, L: Loaded, baseDoc: PMNode): BlockOp[] {
  assertNoSuggestionMarks(baseDoc)
  const { entries, blocks } = L

  const origNodes: PMNode[] = []
  const firstOrigOf: number[] = [] // entry -> index of its first node in origNodes
  entries.forEach((e) => {
    firstOrigOf.push(origNodes.length)
    for (const n of e.nodes) origNodes.push(n)
  })
  const next = contentNodes(baseDoc)
  const map = alignNodes(origNodes, next)
  const newOfOrig = new Array<number>(origNodes.length).fill(-1)
  map.forEach((o, j) => {
    if (o >= 0) newOfOrig[o] = j
  })

  // an entry is kept only if all of its nodes matched, contiguously and in order
  const keptAt = new Map<number, number>()
  for (let ei = 0; ei < entries.length; ei++) {
    const cnt = entries[ei]!.nodes.length
    if (cnt === 0) continue
    const firstOrig = firstOrigOf[ei]!
    const j0 = newOfOrig[firstOrig]!
    if (j0 < 0) continue
    let ok = true
    for (let k = 0; k < cnt; k++) if (map[j0 + k] !== firstOrig + k) ok = false
    if (ok) keptAt.set(j0, ei)
  }

  const ops: BlockOp[] = []
  let prevKept = -1
  let pending: PMNode[] = []
  const flush = (nextKept: number): void => {
    const removed = entries.slice(prevKept + 1, nextKept)
    if (pending.length === 0 && removed.length === 0) return
    const inPlace = removed.length === pending.length
    ops.push({
      after: prevKept,
      before: nextKept,
      covers: blocks.slice(prevKept + 1, nextKept).map((b) => b.hash),
      blocks: pending.map((node, i) => renderReplacement(md, L, node, inPlace ? removed[i] : undefined)),
    })
  }

  for (let j = 0; j < next.length; ) {
    const ei = keptAt.get(j)
    if (ei === undefined) {
      pending.push(next[j]!)
      j++
      continue
    }
    flush(ei)
    prevKept = ei
    pending = []
    j += entries[ei]!.nodes.length
  }
  flush(entries.length)
  return ops
}
