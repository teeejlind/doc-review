// web/src/editor/selection.ts (P2). getSelectionTarget (CONTRACTS §12.1, §5.2, §13 rows 80 and 90).
//
// - Live positions map to base positions through baseDoc(live) (every suggestion reverted): `from` biased forward,
//   `to` backward, so inserted text drops out and deletion-marked (base) text counts.
// - A non-empty base span → kind 'anchor' over it, trimmed of surrounding whitespace, through createAnchor (long
//   form past MAX_QUOTE_CHARS, never refused for length). An empty base span over inserted text → 'inside-suggestion'
//   for the suggestion owning the first inserted character. Only atom blocks → kind 'block' for the first atom.
// - rect = the selection's first line, extent = top of the first line to the bottom of the last, content coordinates.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { NodeSelection, type EditorState } from '@milkdown/kit/prose/state'
import { CellSelection } from '@milkdown/kit/prose/tables'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { BlockInfo, ReviewState, SelectionTarget, SuggestionId, ThreadId } from '../../../shared/types'
import { createAnchor, createBlockAnchor } from '../../../core/anchors'
import { ptextOf, type PText } from '../../../core/ptext'
import { ATOM_BLOCK_NODES } from '../../../core/ptext'
import type { Loaded } from '../../../core/splice/load'
import { alignLive, type LiveAlignment } from '../../../core/suggest/hydrate'
import { kindOf, markIdOf } from '../../../core/suggest/guards'
import { coordsAt, nodeBox, toContent, type ClientBox } from './rects'

/** First ptext offset at or after `pos` (dir 1), or at or before it (dir -1); null when there is none. */
export function offsetNear(p: PText, doc: PMNode, pos: number, dir: 1 | -1): number | null {
  const size = doc.content.size
  for (let q = pos; q >= 0 && q <= size; q += dir) {
    const o = p.toOffset(q)
    if (o !== null) return o
  }
  return null
}

function isSpace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c)
}

/** The word at a collapsed caret, as live positions inside its textblock. */
function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const $p = state.doc.resolve(pos)
  if (!$p.parent.isTextblock) return null
  const start = $p.start()
  const text = $p.parent.textBetween(0, $p.parent.content.size, undefined, '￼')
  const off = pos - start
  const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_'’-]/u.test(c)
  let a = off
  let b = off
  while (a > 0 && isWord(text[a - 1])) a--
  while (b < text.length && isWord(text[b])) b++
  if (a === b) return null
  return { from: start + a, to: start + b }
}

/** The suggestion id of the first insertion-marked node at or after `pos` within [pos, to]. */
function insertionAt(doc: PMNode, from: number, to: number): SuggestionId | null {
  let id: SuggestionId | null = null
  doc.nodesBetween(from, Math.max(to, from + 1), (n) => {
    if (id) return false
    const m = n.marks.find((x) => kindOf(x) === 'ins')
    if (m) id = markIdOf(m)
    return !id
  })
  return id
}

export interface SelectionCtx {
  view: EditorView
  scrollContainer: HTMLElement
  L: Loaded
  rev: number
  review: ReviewState
  alignment?: LiveAlignment
}

function boxes(view: EditorView, from: number, to: number): { first: ClientBox; last: ClientBox } | null {
  // a real DOM range gives per-line rects; coordsAtPos is the fallback
  try {
    const a = view.domAtPos(from)
    const b = view.domAtPos(to)
    const range = document.createRange()
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0)
    if (rects.length) {
      const f = rects[0]!
      let bottom = f.bottom
      for (const r of rects) bottom = Math.max(bottom, r.bottom)
      return { first: { top: f.top, bottom: f.bottom, left: f.left }, last: { top: rects[rects.length - 1]!.top, bottom, left: f.left } }
    }
  } catch {
    // jsdom: no layout
  }
  const f = coordsAt(view, from, 1)
  const l = coordsAt(view, to, -1)
  if (!f || !l) return null
  return { first: f, last: l }
}

function rectsFor(ctx: SelectionCtx, from: number, to: number): { rect: { top: number; bottom: number; left: number }; extent: { top: number; bottom: number } } {
  const b = boxes(ctx.view, from, to)
  if (!b) return { rect: { top: 0, bottom: 0, left: 0 }, extent: { top: 0, bottom: 0 } }
  const rect = toContent(ctx.scrollContainer, b.first)
  const last = toContent(ctx.scrollContainer, b.last)
  return { rect, extent: { top: rect.top, bottom: Math.max(rect.bottom, last.bottom) } }
}

export function selectionTarget(ctx: SelectionCtx, o: { collapsed?: 'none' | 'word' } = {}): SelectionTarget {
  const state = ctx.view.state
  const sel = state.selection
  let from = sel.from
  let to = sel.to
  // a selection of table cells (a drag across them, or shift-click) is several ranges; `from` / `to` are the first cell's
  if (sel instanceof CellSelection) {
    from = Math.min(...sel.ranges.map((r) => r.$from.pos))
    to = Math.max(...sel.ranges.map((r) => r.$to.pos))
  }
  if (sel.empty) {
    if (o.collapsed !== 'word') return null
    const w = wordAt(state, from)
    if (!w) return null
    from = w.from
    to = w.to
  }
  const al = ctx.alignment ?? alignLive(state.doc, ctx.L)
  // only atom blocks selected → a block anchor for the first atom
  const tops: Array<{ node: PMNode; pos: number; index: number }> = []
  state.doc.forEach((node, pos, index) => {
    if (pos < to && pos + node.nodeSize > from) tops.push({ node, pos, index })
  })
  const nodeSel = sel instanceof NodeSelection ? sel.node : null
  const atomOnly = (nodeSel && ATOM_BLOCK_NODES.has(nodeSel.type.name)) ||
    (tops.length > 0 && tops.every((t) => ATOM_BLOCK_NODES.has(t.node.type.name)))
  if (atomOnly) {
    const first = nodeSel ? { pos: sel.from } : tops[0]!
    const entry = al.entries?.findIndex((e) => e.from === first.pos) ?? -1
    if (entry < 0) return null
    const box = nodeBox(ctx.view, first.pos)
    const rect = box ? toContent(ctx.scrollContainer, box) : { top: 0, bottom: 0, left: 0 }
    return { kind: 'block', anchor: createBlockAnchor(ctx.L.blocks, entry, ctx.rev), rect, extent: { top: rect.top, bottom: rect.bottom } }
  }
  const base = al.revert.doc
  const p = ptextOf(base, ctx.L)
  const bFrom = al.revert.mapping.map(from, 1)
  const bTo = al.revert.mapping.map(to, -1)
  let o1 = offsetNear(p, base, bFrom, 1)
  let o2 = offsetNear(p, base, bTo, -1)
  if (o1 !== null && o2 !== null) {
    while (o1 < o2 && isSpace(p.text[o1])) o1++
    while (o2 > o1 && isSpace(p.text[o2 - 1])) o2--
  }
  const r = rectsFor(ctx, from, to)
  if (o1 === null || o2 === null || o2 <= o1) {
    const id = insertionAt(state.doc, from, to)
    if (!id) return null
    const thread = ctx.review.suggestions.find((s) => s.id === id)?.thread
    if (!thread) return null
    return { kind: 'inside-suggestion', suggestion: id, thread: thread as ThreadId, ...r }
  }
  const anchor = createAnchor(p, ctx.L.blocks as BlockInfo[], o1, o2, ctx.rev)
  return { kind: 'anchor', anchor, quote: anchor.quote, ...r }
}
