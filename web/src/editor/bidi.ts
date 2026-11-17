// web/src/editor/bidi.ts (P2; QA round 3, theme-polish). Right-to-left text.
//
// Top-level paragraphs and headings, and every list and quote, carry dir="auto": the browser reads the block's first
// strong character and sets its direction, so an Arabic or Hebrew heading, paragraph, bullet list or quote reads right
// to left and aligns right, while the English blocks next to it stay as they were. The blocks inside a list or a quote
// have no dir of their own on purpose: an element with dir="auto" skips its descendants that have a dir attribute when
// it looks for its first strong character, so a list whose items said "auto" would find no text and stay left to right
// (the markers would land outside it). They inherit from the list or quote, which reads them. Code blocks and tables
// are left alone (code is always left to right). The attribute is a node decoration: nothing about it reaches the
// markdown or the schema.
//
// Typing stays cheap, as in suggestDecos.ts: on a doc change the set is mapped and only the touched top-level blocks
// are recomputed (dir="auto" does not depend on the text, so most edits add nothing).
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { touchedRanges } from '../../../core/suggest/guards'

export const bidiKey = new PluginKey<DecorationSet>('mdr-bidi')

/** Containers that read their own direction (their text decides); the blocks inside them inherit it. */
const CONTAINERS = new Set(['blockquote', 'bullet_list', 'ordered_list'])
/** Textblocks that read their own direction when nothing above them does (top level only). */
const TEXTBLOCKS = new Set(['paragraph', 'heading'])

function decosIn(doc: PMNode, from: number, to: number): Decoration[] {
  const out: Decoration[] = []
  doc.nodesBetween(from, to, (node, pos, parent) => {
    const name = node.type.name
    if (name === 'code_block' || name === 'table') return false
    if (CONTAINERS.has(name) || (TEXTBLOCKS.has(name) && parent === doc)) out.push(Decoration.node(pos, pos + node.nodeSize, { dir: 'auto' }))
    return true
  })
  return out
}

/** The top-level block range [from, to) around a position. */
function topRange(doc: PMNode, pos: number): { from: number; to: number } {
  const p = Math.max(0, Math.min(pos, doc.content.size))
  const $p = doc.resolve(p)
  if ($p.depth === 0) {
    const after = $p.nodeAfter
    const before = $p.nodeBefore
    if (after) return { from: p, to: p + after.nodeSize }
    if (before) return { from: p - before.nodeSize, to: p }
    return { from: p, to: p }
  }
  return { from: $p.before(1), to: $p.after(1) }
}

export function bidiPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: bidiKey,
    state: {
      init: (_c, state: EditorState) => DecorationSet.create(state.doc, decosIn(state.doc, 0, state.doc.content.size)),
      apply(tr, set) {
        if (!tr.docChanged) return set
        let next = set.map(tr.mapping, tr.doc)
        const ranges = touchedRanges(tr)
        if (!ranges.length) return next
        let from = Infinity
        let to = -Infinity
        for (const r of ranges) {
          from = Math.min(from, topRange(tr.doc, r.from).from)
          to = Math.max(to, topRange(tr.doc, r.to).to)
        }
        if (!(to >= from)) return next
        next = next.remove(next.find(from, to).filter((d) => d.to > from && d.from < to))
        return next.add(tr.doc, decosIn(tr.doc, from, to))
      },
    },
    props: {
      decorations: (state) => bidiKey.getState(state) ?? DecorationSet.empty,
    },
  })
}
