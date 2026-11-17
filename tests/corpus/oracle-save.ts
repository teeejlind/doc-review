// tests/corpus/oracle-save.ts (P1; S2's save() kept verbatim on day 0 as the corpus oracle, CONTRACTS §0.2 item 3).
//
// Gate G1: applyBlockOps(L, planSave(L, doc)).text === oracleSave(md, L, doc).text over the whole S2 edit suite
// plus the sweep. This file is the reference, not production code: nothing under core/, node/, server/ or web/
// imports it. Align old and new top-level nodes with an LCS on nodeEq; unchanged blocks keep their bytes,
// in-place changes re-render (3-way patched onto the original bytes for semantic blocks), inserts serialize,
// deletes drop; original gaps are reused, fresh seams get a blank line and list-merge protection; the output is
// re-parsed and verified.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { Md } from '../../core/md/index'
import { load, type Entry, type Loaded } from '../../core/splice/load'
import { contentNodes, nodeEq } from '../../core/splice/eq'
import {
  assertNoSuggestionMarks, dmpPatch, listMarker, parseBlock, regionSplice, renderNode, swapListMarkers,
} from '../../core/splice/render'

export interface SaveStats {
  kept: number
  replacedInPlace: number
  inserted: number
  deleted: number
  patched3way: number
  patchRejected: number
  listMarkerSwaps: number
  /** the saved text re-parses to the intended document */
  verified: boolean
}

/** LCS alignment of original vs new top-level nodes. Returns newIndex -> origIndex | -1. */
export function align(orig: PMNode[], next: PMNode[]): number[] {
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
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        dp[i]![j] = nodeEq(a[i]!, b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (nodeEq(a[i]!, b[j]!)) {
        map[pre + j] = pre + i
        i++
        j++
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
      else j++
    }
  }
  return map
}

type Piece = { text: string; nodes: PMNode[]; expected: PMNode[]; fresh: boolean }

export function oracleSave(md: Md, L: Loaded, newDoc: PMNode): { text: string; stats: SaveStats } {
  assertNoSuggestionMarks(newDoc)
  const { eol, entries, gaps, src, defs } = L
  const stats: SaveStats = {
    kept: 0, replacedInPlace: 0, inserted: 0, deleted: 0, patched3way: 0, patchRejected: 0, listMarkerSwaps: 0, verified: false,
  }

  const origNodes: PMNode[] = []
  const owner: number[] = []
  entries.forEach((e, ei) => e.nodes.forEach((n) => (origNodes.push(n), owner.push(ei))))
  const next = contentNodes(newDoc)
  const map = align(origNodes, next)

  // an entry is kept only if all of its nodes matched, contiguously and in order
  const keptAt = new Map<number, number>()
  for (let ei = 0; ei < entries.length; ei++) {
    const firstOrig = owner.indexOf(ei)
    const cnt = entries[ei]!.nodes.length
    const j0 = map.indexOf(firstOrig)
    if (j0 < 0) continue
    let ok = true
    for (let k = 0; k < cnt; k++) if (map[j0 + k] !== firstOrig + k) ok = false
    if (ok) keptAt.set(j0, ei)
  }

  const blank = eol + eol
  const hasBlank = (g: string) => /\r?\n[ \t]*\r?\n/.test(g)
  const sep = (...candidates: string[]) => candidates.find(hasBlank) ?? blank

  const renderReplacement = (node: PMNode, orig: Entry | undefined): string => {
    const B = renderNode(md, node, eol)
    if (!orig || orig.kind !== 'md' || orig.nodes.length !== 1 || orig.fidelity === 'exact') return B
    // Milkdown's serialization of the original (A) differs from its source bytes (S). Both A and B
    // are Milkdown output, so they differ only around the edit: replay that region onto S so the
    // untouched formatting inside the block (escapes, bullets, table pipes, hard breaks) survives.
    const S = src.slice(orig.start, orig.end)
    const A = renderNode(md, orig.nodes[0]!, eol)
    const want = parseBlock(md, B, defs)
    const means = (R: string) => {
      const got = parseBlock(md, R, defs)
      return got.length === want.length && got.every((n, i) => nodeEq(n, want[i]!))
    }
    for (const R of [regionSplice(A, B, S), dmpPatch(A, B, S)]) {
      if (R !== null && means(R)) {
        stats.patched3way++
        return R
      }
    }
    stats.patchRejected++
    return B
  }

  // Emit a sequence of (separator, piece). `seams[k]` is the separator before pieces[k].
  const pieces: Piece[] = []
  const seams: string[] = []
  const fresh: boolean[] = [] // seam k was created by the edit (not original adjacency)

  let prevKept = -1
  let pending: PMNode[] = []
  const flush = (nextKept: number) => {
    const removed: Entry[] = []
    for (let k = prevKept + 1; k < nextKept; k++) removed.push(entries[k]!)
    const atStart = prevKept === -1
    const atEnd = nextKept === entries.length
    stats.deleted += Math.max(0, removed.length - pending.length)
    if (pending.length === 0) {
      if (removed.length === 0) {
        seams.push(gaps[nextKept]!)
        fresh.push(false)
      } else {
        // pure deletion: one separator; a seam between newly adjacent blocks needs a blank line
        seams.push(atStart ? gaps[0]! : atEnd ? gaps[nextKept]! : sep(gaps[nextKept]!, gaps[prevKept + 1]!))
        fresh.push(!atStart && !atEnd)
      }
      return
    }
    if (removed.length === pending.length) {
      // in-place replacement: reuse every original gap exactly
      pending.forEach((node, i) => {
        seams.push(gaps[prevKept + 1 + i]!)
        fresh.push(false)
        const text = renderReplacement(node, removed[i])
        pieces.push({ text, nodes: [node], expected: parseBlock(md, text, defs), fresh: true })
        stats.replacedInPlace++
      })
      seams.push(gaps[nextKept]!)
      fresh.push(false)
      return
    }
    // insertion / split / merge: reuse original gaps where they exist, blank lines around new blocks
    pending.forEach((node, i) => {
      if (i === 0) seams.push(atStart ? gaps[0]! : removed.length ? sep(gaps[prevKept + 1]!) : blank)
      else seams.push(removed[i] ? sep(gaps[prevKept + 1 + i]!) : blank)
      fresh.push(!(i === 0 && atStart))
      const text = renderReplacement(node, undefined)
      pieces.push({ text, nodes: [node], expected: parseBlock(md, text, defs), fresh: true })
      stats.inserted++
    })
    // at the end keep the file's own trailing text; an empty file gains a final EOL
    seams.push(atEnd ? gaps[nextKept]! || (entries.length === 0 ? eol : '') : sep(gaps[nextKept]!))
    fresh.push(!atEnd)
  }

  for (let j = 0; j < next.length; ) {
    const ei = keptAt.get(j)
    if (ei === undefined) {
      pending.push(next[j]!)
      j++
      continue
    }
    flush(ei)
    const e = entries[ei]!
    pieces.push({ text: src.slice(e.start, e.end), nodes: e.nodes, expected: e.nodes, fresh: false })
    stats.kept++
    prevKept = ei
    pending = []
    j += e.nodes.length
  }
  flush(entries.length)
  // seams.length === pieces.length + 1 (leading ... trailing)

  // list-merge protection: two lists with the same marker separated only by blank lines are ONE
  // list in CommonMark. Where an edit made two lists adjacent, flip the right one's markers
  // (what remark-stringify's bulletOther/bulletOrderedOther does for whole-doc serialization).
  for (let k = 1; k < pieces.length; k++) {
    if (!fresh[k] && !pieces[k]!.fresh && !pieces[k - 1]!.fresh) continue
    const lm = listMarker(md, pieces[k - 1]!.text)
    const rm = listMarker(md, pieces[k]!.text)
    if (lm && rm && lm.kind === rm.kind && lm.ch === rm.ch) {
      pieces[k]!.text = swapListMarkers(md, pieces[k]!.text)
      stats.listMarkerSwaps++
    }
  }

  let out = ''
  pieces.forEach((p, k) => {
    out += seams[k]! + p.text
  })
  out += seams[pieces.length] ?? ''

  // verification: the saved text must re-parse to the intended document
  const expected = pieces.flatMap((p) => p.expected)
  const reloaded = load(md, out)
  const got = contentNodes(reloaded.doc)
  stats.verified = got.length === expected.length && got.every((n, i) => nodeEq(n, expected[i]!))
  return { text: out, stats }
}

/** S2's name, for corpus code ported from the spike harness. */
export const save = oracleSave
