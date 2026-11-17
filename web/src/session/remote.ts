// web/src/session/remote.ts (P2). Remote changes: reload preserving cursor and scroll (CONTRACTS §12.6).
//
// The session runs steps 1-3 and 6 (wait for the in-flight request, flush or fetch, the parity guard, the new base and
// the review refetch) and hands steps 4, 5 and 7 to the editor through EditorPort.applyReload. This module holds the
// pure parts both sides use:
//   - checkParity: load(md, text, { fidelityHints }) must reproduce snapshot.blocks on (hash, start, end), else the
//     page is read-only with CONTRACT_MISMATCH (G6 as a production guard);
//   - planMinimalReplace / buildMinimalReplaceTr: align old L.blocks to new ones by hash and replace only the live
//     top-level node ranges of changed runs, in ONE transaction with skip meta, addToHistory false and
//     mdr.origin 'reload'. Untouched blocks keep node identity, marks, decorations and undo history, and PM history
//     maps TJ's undo stack through the replace, so his undo never undoes Claude.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { suggestChangesKey } from '@handlewithcare/prosemirror-suggest-changes'
import { diffBlocks } from '../../../core/blocks'
import { nodeEq } from '../../../core/splice/eq'
import type { Loaded } from '../../../core/splice/load'
import type { BlockHash, BlockInfo, Fidelity } from '../../../shared/types'

// ------------------------------------------------------------------ parity (step 3)

export function fidelityHintsOf(blocks: readonly Pick<BlockInfo, 'hash' | 'fidelity'>[]): Map<BlockHash, Fidelity> {
  const m = new Map<BlockHash, Fidelity>()
  for (const b of blocks) m.set(b.hash, b.fidelity)
  return m
}

/** null when `L.blocks` reproduces the server's blocks on (hash, start, end); otherwise the first difference. */
export function checkParity(
  L: Pick<Loaded, 'blocks'>,
  server: readonly Pick<BlockInfo, 'hash' | 'start' | 'end'>[],
): { expected: string; actual: string } | null {
  const fmt = (b: Pick<BlockInfo, 'hash' | 'start' | 'end'> | undefined, i: number): string =>
    b ? `b${i + 1} ${b.hash}@${b.start}-${b.end}` : `b${i + 1} (none)`
  const n = Math.max(L.blocks.length, server.length)
  for (let i = 0; i < n; i++) {
    const a = server[i]
    const b = L.blocks[i]
    if (!a || !b || a.hash !== b.hash || a.start !== b.start || a.end !== b.end) {
      return { expected: `blocks ${fmt(a, i)} (${server.length} blocks)`, actual: `blocks ${fmt(b, i)} (${L.blocks.length} blocks)` }
    }
  }
  return null
}

// ------------------------------------------------------------------ minimal replace (step 5)

/** A live top-level node that maps to a base entry node (insertion-marked and empty typing paragraphs excluded). */
interface LiveTop {
  node: PMNode
  pos: number
}

const isInsertionMarked = (n: PMNode): boolean => n.marks.some((m) => m.type.name === 'insertion')
const isEmptyParagraph = (n: PMNode): boolean => n.type.name === 'paragraph' && n.content.size === 0

/** The live top-level nodes that stand for base entries, in order, with their positions. */
function liveTops(doc: PMNode): LiveTop[] {
  const out: LiveTop[] = []
  doc.forEach((node, pos) => {
    if (!isInsertionMarked(node) && !isEmptyParagraph(node)) out.push({ node, pos })
  })
  return out
}

export interface ReplaceRun {
  /** Live doc positions [from, to) to replace; from === to is an insertion. */
  from: number
  to: number
  nodes: PMNode[]
  /** Old base entry range [a, a + an) and new [b, b + bn). */
  a: number
  an: number
  b: number
  bn: number
}

export interface MinimalReplaceOptions {
  /** Base hashes whose live blocks keep TJ's text (held conflicts). */
  preserve?: ReadonlySet<BlockHash>
  /** Decides that the live nodes of a run already show the new content (default: pairwise nodeEq). */
  same?: (live: readonly PMNode[], next: readonly PMNode[]) => boolean
}

const pairwiseEq = (a: readonly PMNode[], b: readonly PMNode[]): boolean => a.length === b.length && a.every((n, i) => nodeEq(n, b[i]!))

/**
 * The changed runs between `prev` and `next` mapped onto the live doc. null when the live doc no longer lines up
 * with `prev` entry by entry (the caller replaces everything instead). Whole blocks TJ added or removed since `prev`
 * (Enter typed while a save was on the wire) don't break that: the entries before the first and after the last live
 * block that differs still line up, and only a run that needs one of the others, or spans TJ's new block, returns null.
 */
export function planMinimalReplace(liveDoc: PMNode, prev: Loaded, next: Loaded, o: MinimalReplaceOptions = {}): ReplaceRun[] | null {
  const tops = liveTops(liveDoc)
  // entry k of prev owns live tops [start[k], start[k] + prev.entries[k].nodes.length); undefined = not placeable
  const start: Array<number | undefined> = []
  let cursor = 0
  for (const e of prev.entries) {
    start.push(cursor)
    cursor += e.nodes.length
  }
  // prev's doc of an empty file holds one empty paragraph that liveTops skips: there are no entries then
  if (cursor !== tops.length) {
    if (prev.entries.length === 0) return null
    const flat = prev.entries.flatMap((e) => e.nodes)
    const most = Math.min(cursor, tops.length)
    let pre = 0
    while (pre < most && nodeEq(tops[pre]!.node, flat[pre]!)) pre++
    let suf = 0
    while (suf < most - pre && nodeEq(tops[tops.length - 1 - suf]!.node, flat[cursor - 1 - suf]!)) suf++
    prev.entries.forEach((e, k) => {
      const at = start[k]!
      start[k] = at + e.nodes.length <= pre ? at : at >= cursor - suf ? tops.length - (cursor - at) : undefined
    })
  }
  const same = o.same ?? pairwiseEq
  const preserve = o.preserve ?? new Set<BlockHash>()
  const runs: ReplaceRun[] = []
  const posBefore = (k: number): number | null => {
    // position where entry k starts in the live doc (or after the last entry's last node)
    if (k < prev.entries.length) {
      const at = start[k]
      if (at === undefined) return null
      const t = tops[at]
      if (t) return t.pos
    }
    const last = tops[tops.length - 1]
    return last ? last.pos + last.node.nodeSize : 0
  }
  for (const d of diffBlocks(prev.blocks, next.blocks)) {
    if (d.op === 'equal') continue
    const pairs: Array<{ a: number; an: number; b: number; bn: number }> =
      d.op === 'replace' && d.an === d.bn && preserve.size > 0
        ? Array.from({ length: d.an }, (_, k) => ({ a: d.a + k, an: 1, b: d.b + k, bn: 1 }))
        : [{ a: d.a, an: d.an, b: d.b, bn: d.bn }]
    for (const p of pairs) {
      if (prev.blocks.slice(p.a, p.a + p.an).some((b) => preserve.has(b.hash))) continue
      const nodes = next.entries.slice(p.b, p.b + p.bn).flatMap((e) => e.nodes)
      const from = posBefore(p.a)
      if (from === null) return null
      let to = from
      const live: PMNode[] = []
      if (p.an > 0) {
        const firstTop = start[p.a]
        const lastStart = start[p.a + p.an - 1]
        if (firstTop === undefined || lastStart === undefined) return null
        const lastTop = lastStart + prev.entries[p.a + p.an - 1]!.nodes.length - 1
        // the run's entries must still be adjacent: a block TJ added between them has nowhere to go
        if (lastTop - firstTop + 1 !== prev.entries.slice(p.a, p.a + p.an).reduce((n, e) => n + e.nodes.length, 0)) return null
        for (let t = firstTop; t <= lastTop; t++) live.push(tops[t]!.node)
        const last = tops[lastTop]
        to = last ? last.pos + last.node.nodeSize : from
        // insertion-marked tops between the run's first and last entry stay out of `live` but inside [from, to)
      }
      if (same(live, nodes)) continue
      runs.push({ from, to, nodes, ...p })
    }
  }
  return runs
}

export const RELOAD_ORIGIN = 'reload' as const

/**
 * One transaction replacing the runs (end of document first, so positions stay valid), with skip meta (I-SKIP),
 * addToHistory false and mdr.origin 'reload'. A selection inside a replaced run is restored by its text offset
 * into the run's first block (clamped); every other selection maps through the steps. Returns null when nothing
 * changes. `runs` null = replace the whole document.
 */
export function buildMinimalReplaceTr(state: EditorState, prev: Loaded | null, next: Loaded, o: MinimalReplaceOptions = {}): Transaction | null {
  const runs = prev ? planMinimalReplace(state.doc, prev, next, o) : null
  const tr = state.tr
  const sel = state.selection
  let restoreAt: { run: ReplaceRun; offset: number } | null = null
  if (runs === null) {
    const all = next.entries.flatMap((e) => e.nodes)
    tr.replaceWith(0, state.doc.content.size, all.length ? all : [state.schema.nodes.paragraph!.create()])
  } else {
    if (runs.length === 0) return null
    for (const r of runs) {
      if (r.from < r.to && sel.from >= r.from && sel.from <= r.to) {
        restoreAt = { run: r, offset: textLenBetween(state.doc, r.from, Math.min(sel.from, r.to)) }
      }
    }
    for (const r of [...runs].sort((x, y) => y.from - x.from)) {
      if (r.from === r.to) tr.insert(r.from, r.nodes)
      else if (r.nodes.length === 0) tr.delete(r.from, r.to)
      else tr.replaceWith(r.from, r.to, r.nodes)
    }
    if (restoreAt) {
      const startPos = tr.mapping.map(restoreAt.run.from, -1)
      const size = restoreAt.run.nodes.reduce((s, n) => s + n.nodeSize, 0)
      const pos = textOffsetToPos(tr.doc, startPos, startPos + size, restoreAt.offset)
      if (pos !== null) tr.setSelection(TextSelection.create(tr.doc, pos))
    }
  }
  tr.setMeta(suggestChangesKey, { skip: true })
  tr.setMeta('addToHistory', false)
  tr.setMeta('mdr', { origin: RELOAD_ORIGIN })
  return tr
}

/** Text characters (only) between two positions. */
function textLenBetween(doc: PMNode, from: number, to: number): number {
  let n = 0
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) n += Math.max(0, Math.min(to, pos + node.nodeSize) - Math.max(from, pos))
    return true
  })
  return n
}

/** The document position `offset` text characters into [from, to), clamped to the last text position; null if none. */
function textOffsetToPos(doc: PMNode, from: number, to: number, offset: number): number | null {
  let remaining = offset
  let found: number | null = null
  let lastText: number | null = null
  doc.nodesBetween(from, to, (n, pos) => {
    if (found !== null) return false
    if (n.isText) {
      const len = n.text?.length ?? 0
      if (remaining <= len) {
        found = pos + remaining
        return false
      }
      remaining -= len
      lastText = pos + len
    } else if (n.isTextblock && lastText === null) {
      lastText = pos + 1
    }
    return true
  })
  return found ?? lastText
}
