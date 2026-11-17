// web/src/editor/ownInsertion.ts (QA round 3). Suggesting mode: structural edits inside TJ's own pending insertion.
//
// Text TJ added in Suggesting mode is not in the base, so editing it is not a new change to track: it is the same
// insertion, reshaped. suggest-changes tracks every structural step as "old structure deleted, new structure
// inserted", which over an insertion leaves the base with a stray block boundary, and the editor's base guard
// (baseChangedBy) refused the edit with "can't be tracked over a pending suggestion" although no other suggestion
// was there: Enter then Backspace, Enter inside a list he just typed, Enter twice to leave it, the bullet button on a
// paragraph he just opened, a heading or list pasted into one (QA3).
//
// Such a transaction is applied as it is, and everything it creates joins the insertion: new text gets the
// insertion mark, new wrapper nodes (list, item, quote) get it as a node mark, and a new empty textblock gets the
// library's zero-width marker so the next keystroke there extends the same suggestion. inputRules.ts does the same
// for `- `, `1. `, `> ` and `# ` on an own-insertion paragraph. The base guard still runs on the result.
import type { Mark, Node as PMNode } from '@milkdown/kit/prose/model'
import { joinBackward } from '@milkdown/kit/prose/commands'
import { TextSelection, type Command, type Transaction } from '@milkdown/kit/prose/state'
import { ReplaceAroundStep, ReplaceStep } from '@milkdown/kit/prose/transform'
import { suggestChangesKey } from '@handlewithcare/prosemirror-suggest-changes'
import { insertedRanges, markIdOf, suggestionMarkTypes, touchedRanges, ZWSP } from '../../../core/suggest/guards'

/** The insertion id when every inline child of the textblock around `pos` carries the same insertion mark, else null. */
export function ownTextblockId(doc: PMNode, pos: number): string | null {
  const $p = doc.resolve(pos)
  const parent = $p.parent
  if (!parent.isTextblock || parent.childCount === 0) return null
  const { insertion } = suggestionMarkTypes(doc.type.schema)
  let id: string | null = null
  let all = true
  parent.forEach((child) => {
    const m = insertion.isInSet(child.marks)
    if (!m || (id !== null && markIdOf(m) !== id)) all = false
    else id ??= markIdOf(m)
  })
  return all ? id : null
}

/**
 * The single TJ insertion id a user transaction is confined to, or null. Every Replace / ReplaceAround step must
 * touch only that insertion: the inline content it replaces carries its insertion mark, a container it removes or
 * rewraps whole carries it as a node mark, and a step that replaces no content at all (a split, a pure insertion)
 * sits inside a textblock that is wholly that insertion. Any other step type, a struck or modified node in range,
 * or a second id -> null (the library tracks the edit as before).
 */
export function ownInsertionScope(tr: Transaction, isOwn: (id: string) => boolean): string | null {
  if (!tr.docChanged || tr.steps.length === 0) return null
  const meta = tr.getMeta(suggestChangesKey) as Record<string, unknown> | undefined
  if (meta && 'skip' in meta) return null
  let id: string | null = null
  const take = (x: string | null): boolean => {
    if (x === null || !isOwn(x)) return false
    id ??= x
    return id === x
  }
  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i]!
    const doc = tr.docs[i]!
    if (!(step instanceof ReplaceStep) && !(step instanceof ReplaceAroundStep)) return null
    const { from, to } = step as unknown as { from: number; to: number }
    const { insertion, deletion, modification } = suggestionMarkTypes(doc.type.schema)
    if (from === to) {
      if (!take(ownTextblockId(doc, from))) return null
      continue
    }
    let ok = true
    let saw = false
    doc.nodesBetween(from, to, (n, pos) => {
      if (!ok) return false
      if (n.marks.some((m: Mark) => m.type === deletion || m.type === modification)) {
        ok = false
        return false
      }
      if (n.isInline) {
        const m = insertion.isInSet(n.marks)
        if (!m || !take(markIdOf(m))) ok = false
        saw = true
        return false
      }
      const whole = pos >= from && pos + n.nodeSize <= to
      if (whole && n.isTextblock && n.content.size === 0) {
        // an empty block removed or moved whole holds nothing of anyone's (a trimmed marker's block)
        saw = true
        return false
      }
      if (whole && !n.isTextblock) {
        const m = insertion.isInSet(n.marks)
        if (m) {
          if (!take(markIdOf(m))) ok = false
          saw = true
          return false
        }
      }
      return true
    })
    if (!ok) return null
    // only block boundaries in range (a join, a lift, a block pasted after the caret's block): one side an empty
    // block (joining it moves nothing), or each side the insertion's textblock or a position between blocks, with at
    // least one of them the insertion's
    if (!saw) {
      const side = (pos: number): 'empty' | 'between' | string | null => {
        const p = doc.resolve(pos).parent
        if (!p.isTextblock) return 'between'
        return p.content.size === 0 ? 'empty' : ownTextblockId(doc, pos)
      }
      const a = side(from)
      const b = side(to)
      if (a !== 'empty' && b !== 'empty') {
        if (a === null || b === null || (a === 'between' && b === 'between')) return null
        if (a !== 'between' && !take(a)) return null
        if (b !== 'between' && !take(b)) return null
      }
    }
  }
  return id
}

/** The textblocks overlapping [from, to] of `doc` (an empty range finds the textblock around it). */
function textblocksAround(doc: PMNode, from: number, to: number, out: Map<number, PMNode>): void {
  const size = doc.content.size
  const a = Math.max(0, Math.min(from, size))
  const b = Math.max(a, Math.min(to, size))
  const $a = doc.resolve(a)
  if ($a.parent.isTextblock) out.set($a.before(), $a.parent)
  const $b = doc.resolve(b)
  if ($b.parent.isTextblock) out.set($b.before(), $b.parent)
  doc.nodesBetween(a, b, (n, pos) => {
    if (n.isTextblock) {
      out.set(pos, n)
      return false
    }
    return true
  })
}

/**
 * Apply `tr` as it is (no tracking), with everything it created joined to insertion `id`. Returns the same
 * transaction, carrying the skip meta.
 */
export function joinOwnInsertion(tr: Transaction, id: string): Transaction {
  const { insertion } = suggestionMarkTypes(tr.doc.type.schema)
  const mark = insertion.create({ id })
  const touched = touchedRanges(tr)
  // new content: inline text gets the mark, new containers (not textblocks) get it as a node mark
  for (const r of insertedRanges(tr)) {
    const containers: number[] = []
    tr.doc.nodesBetween(r.from, r.to, (n, pos) => {
      if (pos >= r.from && pos < r.to && !n.isInline && !n.isTextblock && !insertion.isInSet(n.marks)) containers.push(pos)
      return true
    })
    for (const pos of containers) tr.addNodeMark(pos, mark)
    tr.addMark(r.from, r.to, mark)
  }
  // a textblock the edit left empty gets the zero-width marker, so it reverts with the insertion and typing there
  // extends it (the selection maps past it: a caret at the block's start ends up after the marker)
  const blocks = new Map<number, PMNode>()
  for (const r of touched) textblocksAround(tr.doc, r.from, r.to, blocks)
  const empties = [...blocks].filter(([, n]) => n.content.size === 0 && !n.type.spec.code).map(([pos]) => pos).sort((x, y) => y - x)
  for (const pos of empties) tr.insert(pos + 1, tr.doc.type.schema.text(ZWSP, [mark]))
  return tr.setMeta(suggestChangesKey, { skip: true })
}

/**
 * Backspace at the start of a block TJ opened with Enter (its leading marker already trimmed): join it back, and drop
 * the other half of the split's marker pair that the join leaves right before the caret.
 */
export const joinOwnSplit: Command = (state, dispatch) => {
  let joined: Transaction | null = null
  if (!joinBackward(state, (t) => (joined = t))) return false
  if (!dispatch) return true
  const tr = joined as unknown as Transaction
  const $c = tr.selection.$from
  const before = $c.nodeBefore
  const { insertion } = suggestionMarkTypes(state.schema)
  if (before?.isText && before.text!.endsWith(ZWSP) && insertion.isInSet(before.marks)) tr.delete($c.pos - 1, $c.pos)
  dispatch(tr)
  return true
}

/**
 * Backspace at the start of a block TJ's own insertion made (the lifted block of a list item or quote), when the block
 * before it is struck whole: the join goes to the last unstruck textblock before the struck run. Left to joinBackward
 * the block would merge into the struck copy and vanish, and Accept wrote nothing where Editing mode joins the text
 * onto the line above (Pass 4 #6). The moved text keeps the insertion's id, so it is still one suggestion.
 */
export const joinAcrossStruck: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0 || !$from.parent.isTextblock || $from.parent.type.spec.code || $from.depth < 1) return false
  const { insertion, deletion } = suggestionMarkTypes(state.schema)
  const block = $from.parent
  const mark = insertion.isInSet(block.marks)
  const id = mark ? markIdOf(mark) : ownTextblockId(state.doc, $from.pos)
  if (!id) return false
  const container = $from.node($from.depth - 1)
  let i = $from.index($from.depth - 1) - 1
  if (i < 0 || !deletion.isInSet(container.child(i).marks)) return false
  while (i >= 0 && deletion.isInSet(container.child(i).marks)) i--
  const target = i >= 0 ? container.child(i) : null
  if (!target?.isTextblock || target.type.spec.code) return false
  if (!dispatch) return true
  let start = $from.start($from.depth - 1)
  for (let k = 0; k < i; k++) start += container.child(k).nodeSize
  const end = start + target.nodeSize - 1
  const m = insertion.create({ id })
  const moved: PMNode[] = []
  block.forEach((c) => moved.push(c.isText ? c.mark(m.addToSet(c.marks)) : c))
  const tr = state.tr.delete($from.before(), $from.after()).insert(end, moved)
  tr.setSelection(TextSelection.create(tr.doc, end))
  dispatch(tr.setMeta(suggestChangesKey, { skip: true }).scrollIntoView())
  return true
}
