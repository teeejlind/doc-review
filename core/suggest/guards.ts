// core/suggest/guards.ts (P2). Suggestion-mark guards and the id-scoped mark helpers the editor and
// core/suggest/{hydrate,extract} share (CONTRACTS §6.4, §6.5).
//
// - Mark helpers: which suggestion mark a node carries, the ids in a doc, their segments.
// - decideSuggestions: apply or revert the insertion / deletion / modification marks of a set of ids on a Transform.
//   Vendored from @handlewithcare/prosemirror-suggest-changes 0.1.8 (MIT, licence below; §0.2 item 7), because the
//   package's own applySuggestion / revertSuggestion apply EVERY id's modification marks (they pass `undefined` as
//   the id to their modification pass) and revertSuggestion returns early for a modification-only suggestion. Two
//   deliberate changes besides the id scoping: no "collapse a double space" rule (a revert must restore the base
//   bytes exactly, and an accept must equal parse(proposed)), and modifications are scoped to the same ids.
// - idGuard (I-ID): an appendTransaction plugin restoring the ids of pre-existing marks and re-marking new TJ marks
//   that picked up a Claude id.
// - foreignViolation / suggestModeViolation: the pure predicates behind the foreign-content filter (both modes) and
//   the D14 Suggesting-mode blocks. The editor runs them on the ORIGINAL user transaction, before
//   withSuggestChanges transforms it.
//
// ---------------------------------------------------------------------------------------------------------------
// Portions (decideSuggestions, findSuggestionMarkEnd) adapted from @handlewithcare/prosemirror-suggest-changes:
//
// MIT License
//
// Copyright (c) 2025 Handle with Care Collective
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ---------------------------------------------------------------------------------------------------------------
import { Fragment, type Mark, type MarkType, type Node as PMNode, type ResolvedPos, type Schema } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state'
import {
  AddMarkStep, AddNodeMarkStep, AttrStep, RemoveMarkStep, RemoveNodeMarkStep, ReplaceAroundStep, ReplaceStep,
  Transform, type Mapping, type Step,
} from '@milkdown/kit/prose/transform'
import type { SuggestionId } from '../../shared/types'
import { nodeEq } from '../splice/eq'

// =====================================================================================================
// Mark helpers
// =====================================================================================================

export type SuggestionKind = 'ins' | 'del' | 'mod'

export interface SuggestionMarkTypes {
  insertion: MarkType
  deletion: MarkType
  modification: MarkType
}

export function suggestionMarkTypes(schema: Schema): SuggestionMarkTypes {
  const { insertion, deletion, modification } = schema.marks
  if (!insertion || !deletion || !modification) throw new Error('core/suggest: the schema has no suggestion marks')
  return { insertion, deletion, modification }
}

/** The zero-width space suggest-changes inserts as a block-boundary marker. */
export const ZWSP = '​'

/** The id of a suggestion mark as a SuggestionId string (marks carry only `id`, §0.2 item 8). */
export function markIdOf(m: Mark): SuggestionId {
  return String(m.attrs.id) as SuggestionId
}

export function kindOf(m: Mark): SuggestionKind | null {
  const n = m.type.name
  return n === 'insertion' ? 'ins' : n === 'deletion' ? 'del' : n === 'modification' ? 'mod' : null
}

/** Every suggestion id present in `doc` (any mark kind, inline or node). */
export function suggestionIdsIn(doc: PMNode): Set<SuggestionId> {
  const out = new Set<SuggestionId>()
  doc.descendants((n) => {
    for (const m of n.marks) if (kindOf(m)) out.add(markIdOf(m))
    return true
  })
  return out
}

export interface SuggestionSegment {
  id: SuggestionId
  kind: SuggestionKind
  from: number
  to: number
  inline: boolean
  /** Text of an inline text node ('' for node marks and inline atoms). */
  text: string
  /** The node carrying the mark. */
  node: PMNode
  mark: Mark
}

/** One entry per node that carries a suggestion mark, in document order. */
export function suggestionSegments(doc: PMNode, from = 0, to = doc.content.size): SuggestionSegment[] {
  const out: SuggestionSegment[] = []
  doc.nodesBetween(from, to, (n, pos) => {
    for (const m of n.marks) {
      const kind = kindOf(m)
      if (!kind) continue
      out.push({
        id: markIdOf(m), kind, from: pos, to: pos + n.nodeSize, inline: n.isInline, text: n.isText ? (n.text ?? '') : '', node: n, mark: m,
      })
    }
    return true
  })
  return out
}

// =====================================================================================================
// decideSuggestions (vendored, id-scoped)
// =====================================================================================================

type MarkMatch = (m: Mark) => boolean

function matcher(ids: ReadonlySet<string> | null): MarkMatch {
  return ids === null ? () => true : (m) => ids.has(String(m.attrs.id))
}

/**
 * Upstream findSuggestionMarkEnd: the end of the run of `markType` (same id) starting at $pos, following it across a
 * block boundary when the next block starts with the same mark.
 */
export function findSuggestionMarkEnd($pos: ResolvedPos, markType: MarkType): number {
  const initial = ($pos.nodeAfter ?? $pos.nodeBefore)?.marks.find((m) => m.type === markType)
  if (!initial) return $pos.pos
  let afterPos = $pos.pos + ($pos.nodeAfter?.nodeSize ?? 0)
  for (;;) {
    const $after = $pos.doc.resolve(afterPos)
    // a following sibling block that carries the same mark as a node mark (a second list item TJ added to a list he
    // added) is part of the run: without this the run stopped between the two and the second one was left behind
    const sib = $after.depth >= 1 ? $after.nodeAfter : null
    if (sib && !sib.isInline && sib.marks.some((m) => m.type === markType && m.attrs.id === initial.attrs.id)) {
      afterPos += sib.nodeSize
      continue
    }
    if ($after.depth < 1 || ($after.nodeAfter && !markType.isInSet($after.marks()))) return $after.pos
    let afterParentPos = $after.after()
    let $afterParent = $pos.doc.resolve(afterParentPos)
    let nextParent = $afterParent.nodeAfter
    while ($afterParent.depth > 0 && !nextParent) {
      afterParentPos = $after.after($afterParent.depth)
      $afterParent = $pos.doc.resolve(afterParentPos)
      nextParent = $afterParent.nodeAfter
    }
    let cousinStart = afterParentPos + 1
    let cousin = nextParent?.firstChild ?? null
    while (cousin && !cousin.isLeaf && !markType.isInSet(cousin.marks)) {
      cousin = cousin.firstChild
      cousinStart++
    }
    const m = cousin?.marks.find((x) => x.type === markType)
    if (!cousin || !m || m.attrs.id !== initial.attrs.id) return $after.pos
    const $cousin = $pos.doc.resolve(cousinStart)
    // A table cell edge is never part of a run: one suggestion that changes two neighbouring cells (Claude's quote
    // across "| 12.0% | 9 mo |") marks both, and following the run across the edge deleted the cell boundary on Accept,
    // pulling the next cell's text into this one and leaving an empty last cell (11/13 trial bug).
    if (cellStart($after) !== cellStart($cousin)) return $after.pos
    afterPos = $cousin.pos + ($cousin.nodeAfter?.nodeSize ?? 0)
  }
}

/** The start of the innermost table cell (or header cell) around $p, or -1 outside a table. */
function cellStart($p: ResolvedPos): number {
  for (let d = $p.depth; d > 0; d--) {
    const name = $p.node(d).type.name
    if (name === 'table_cell' || name === 'table_header') return $p.before(d)
  }
  return -1
}

/** Upstream applySuggestionsToTransform with an id predicate (keep = mark removed, content kept; drop = content deleted). */
function insDelPass(node: PMNode, tr: Transform, keep: MarkType, drop: MarkType, match: MarkMatch): void {
  const keepIn = (marks: readonly Mark[]): Mark | undefined => marks.find((m) => m.type === keep && match(m))
  const dropIn = (marks: readonly Mark[]): Mark | undefined => marks.find((m) => m.type === drop && match(m))
  // `node` is tr.doc as it was when the pass started: map only through the steps this pass adds
  const first = tr.steps.length
  const map = (): Mapping => tr.mapping.slice(first)
  node.descendants((child, pos, parent, index) => {
    const isDrop = dropIn(child.marks)
    const isKeep = keepIn(child.marks)
    if (!isDrop && !isKeep) return true
    if (isDrop) {
      const { pos: from, deleted } = map().mapResult(pos)
      if (deleted) return false
      const to = findSuggestionMarkEnd(tr.doc.resolve(from + child.nodeSize), drop)
      tr.deleteRange(from, to)
      return false
    }
    const from = map().map(pos)
    const to = from + child.nodeSize
    if (child.isInline) {
      tr.removeMark(from, to, keep)
      const text = child.text ?? ''
      if (text === ZWSP) tr.delete(from, to)
      else if (child.isText && parent) {
        // The library's block-boundary markers sit at a textblock edge and can merge into the neighbouring marked
        // text ("​A new paragraph."): strip them there too, or they would leak into the doc (and the .md).
        if (index === parent.childCount - 1 && text.endsWith(ZWSP)) tr.delete(to - 1, to)
        if (index === 0 && text.startsWith(ZWSP)) tr.delete(from, from + 1)
      }
    } else {
      tr.removeNodeMark(from, keep)
    }
    return true
  })
}

/** Modification pass, scoped: apply (dir 1) drops the marks; revert (dir -1) also restores the previous values. */
function modificationPass(tr: Transform, dir: 1 | -1, match: MarkMatch): void {
  const schema = tr.doc.type.schema
  const { modification } = suggestionMarkTypes(schema)
  const targets: Array<{ pos: number; mods: Mark[] }> = []
  tr.doc.descendants((child, pos) => {
    const mods = child.marks.filter((m) => m.type === modification && match(m))
    if (mods.length) targets.push({ pos, mods })
    return true
  })
  for (const t of targets) {
    for (const m of t.mods) tr.removeNodeMark(t.pos, m)
    if (dir > 0) continue
    // node type first (a nodeType revert resets attrs to defaults), then attrs
    for (const m of t.mods) {
      if (m.attrs.type !== 'nodeType') continue
      const prev = schema.nodes[String(m.attrs.previousValue)]
      if (prev) tr.setNodeMarkup(t.pos, prev, null)
    }
    for (const m of t.mods) {
      if (m.attrs.type === 'attr' && typeof m.attrs.attrName === 'string') tr.setNodeAttribute(t.pos, m.attrs.attrName, m.attrs.previousValue)
    }
  }
}

/**
 * Apply ('apply': insertions kept, deletions removed, modifications kept) or revert ('revert': insertions removed,
 * deletions kept, modifications undone) the suggestion marks of `ids` (null = every id) onto `tr`. Returns `tr`.
 */
export function decideSuggestions<T extends Transform>(tr: T, ids: ReadonlySet<string> | null, dir: 'apply' | 'revert'): T {
  const { insertion, deletion } = suggestionMarkTypes(tr.doc.type.schema)
  const match = matcher(ids)
  if (dir === 'apply') insDelPass(tr.doc, tr, insertion, deletion, match)
  else insDelPass(tr.doc, tr, deletion, insertion, match)
  modificationPass(tr, dir === 'apply' ? 1 : -1, match)
  return tr
}

/** baseDoc(live): every suggestion reverted (§12.4 step 2). The Transform's mapping maps live → base positions. */
export function revertAll(doc: PMNode): Transform {
  return decideSuggestions(new Transform(doc), null, 'revert')
}

/** `doc` with only `apply` applied and every other suggestion reverted (§6.4 extract, liveMarkdown). */
export function onlyApplied(doc: PMNode, apply: ReadonlySet<string>): Transform {
  const tr = decideSuggestions(new Transform(doc), apply, 'apply')
  return decideSuggestions(tr, null, 'revert')
}

/**
 * Re-id the marks of some suggestions (every kind, inline and node; the other mark attrs stay). Mark steps move no
 * positions, so the segments read once up front stay valid for the whole pass.
 */
export function reassignIds<T extends Transform>(tr: T, ids: ReadonlyMap<SuggestionId, SuggestionId>): T {
  for (const seg of suggestionSegments(tr.doc)) {
    const to = ids.get(seg.id)
    if (to === undefined) continue
    const next = seg.mark.type.create({ ...seg.mark.attrs, id: to })
    if (seg.inline) {
      tr.removeMark(seg.from, seg.to, seg.mark)
      tr.addMark(seg.from, seg.to, next)
    } else {
      tr.removeNodeMark(seg.from, seg.mark)
      tr.addNodeMark(seg.from, next)
    }
  }
  return tr
}

// =====================================================================================================
// Changed ranges of a transform
// =====================================================================================================

export interface Range { from: number; to: number }

function mapFrom(mapping: Mapping, start: number, pos: number, assoc: -1 | 1): number {
  return mapping.slice(start).map(pos, assoc)
}

/**
 * The ranges of the FINAL doc a transform touched: inserted content and the targets of mark / attr steps, mapped to
 * tr.doc coordinates (pure deletions show up as empty ranges at the deletion point).
 */
export function touchedRanges(tr: Transform): Range[] {
  const out: Range[] = []
  tr.steps.forEach((step, i) => {
    const push = (from: number, to: number): void => {
      const a = mapFrom(tr.mapping, i + 1, from, -1)
      const b = mapFrom(tr.mapping, i + 1, to, 1)
      out.push({ from: Math.min(a, b), to: Math.max(a, b) })
    }
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) push(step.from, step.to)
    else if (step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep || step instanceof AttrStep) {
      const after = i + 1 < tr.docs.length ? tr.docs[i + 1]! : tr.doc
      const node = after.nodeAt(step.pos)
      push(step.pos, step.pos + (node?.nodeSize ?? 1))
    } else {
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => push(newStart, newEnd))
    }
  })
  return out
}

/** The new-doc ranges whose content has no pre-image (inserted by the transform), in tr.doc coordinates. */
export function insertedRanges(tr: Transform): Range[] {
  const out: Range[] = []
  tr.steps.forEach((step, i) => {
    step.getMap().forEach((_os, _oe, newStart, newEnd) => {
      if (newEnd <= newStart) return
      const a = mapFrom(tr.mapping, i + 1, newStart, 1)
      const b = mapFrom(tr.mapping, i + 1, newEnd, -1)
      if (b > a) out.push({ from: a, to: b })
    })
  })
  return out
}

function inRanges(rs: readonly Range[], pos: number): boolean {
  return rs.some((r) => pos >= r.from && pos < r.to)
}

// =====================================================================================================
// idGuard (I-ID, §6.5)
// =====================================================================================================

export interface IdGuardOptions {
  /** true when the id belongs to a TJ suggestion (browser-minted, or `by: 'TJ'` in the review state). */
  isTjOwned(id: SuggestionId): boolean
  /** Mints a fresh TJ id ('s_' + ULID). */
  mintId(): SuggestionId
  /** true for transactions the guard must leave alone (hydrate, decide, reload, history$, draft restore). */
  isProgrammatic?(tr: Transaction): boolean
}

export const idGuardKey = new PluginKey('mdr-id-guard')

export interface IdFix { from: number; to: number; type: MarkType; id: SuggestionId }

/**
 * The I-ID rules over one user transform (oldDoc → tr.doc), as re-mark fixes:
 * (1) a pre-existing suggestion mark keeps its original id;
 * (2) a newly added insertion/deletion mark carries a TJ-owned id (a Claude id is replaced with a fresh TJ id).
 * Only text inside the touched window (whole text nodes) is examined, so typing stays cheap.
 */
export function idFixes(oldDoc: PMNode, tr: Transform, o: Pick<IdGuardOptions, 'isTjOwned' | 'mintId'>): IdFix[] {
  if (tr.steps.length === 0) return []
  const doc = tr.doc
  const touched = touchedRanges(tr)
  if (!touched.length) return []
  const inserted = insertedRanges(tr)
  const inv = tr.mapping.invert()
  const fixes: IdFix[] = []
  let fresh: SuggestionId | null = null
  const freshId = (): SuggestionId => (fresh ??= o.mintId())
  const size = doc.content.size
  const seen = new Set<number>()
  for (const r of touched) {
    const from = Math.max(0, r.from - 1)
    const to = Math.min(size, r.to + 1)
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true
      if (seen.has(pos)) return false
      seen.add(pos)
      for (const m of node.marks) {
        const kind = kindOf(m)
        if (kind !== 'ins' && kind !== 'del') continue
        const id = markIdOf(m)
        let runStart = pos
        let runWant: SuggestionId | null = null
        const flush = (end: number): void => {
          if (runWant !== null && runWant !== id && end > runStart) fixes.push({ from: runStart, to: end, type: m.type, id: runWant })
        }
        for (let p = pos; p < pos + node.nodeSize; p++) {
          let want: SuggestionId
          if (inRanges(inserted, p)) {
            want = o.isTjOwned(id) ? id : freshId()
          } else {
            const q = inv.mapResult(p, 1)
            const oldNode = q.deleted ? null : oldDoc.nodeAt(q.pos)
            const oldMark = oldNode?.isText ? oldNode.marks.find((x) => x.type === m.type) : undefined
            want = oldMark ? markIdOf(oldMark) : o.isTjOwned(id) ? id : freshId()
          }
          if (want !== runWant) {
            flush(p)
            runStart = p
            runWant = want
          }
        }
        flush(pos + node.nodeSize)
      }
      return false
    })
  }
  return fixes
}

export function applyIdFixes<T extends Transform>(tr: T, fixes: readonly IdFix[]): T {
  for (const f of fixes) {
    tr.removeMark(f.from, f.to, f.type)
    tr.addMark(f.from, f.to, f.type.create({ id: f.id }))
  }
  return tr
}

/** The I-ID appendTransaction plugin (§6.5). Rule (3), hydrate adds only s.id, is hydrate's own check. */
export function idGuard(o: IdGuardOptions): Plugin {
  return new Plugin({
    key: idGuardKey,
    appendTransaction(trs, oldState, newState) {
      const user = trs.some((t) => t.docChanged && !(o.isProgrammatic?.(t) ?? false) && !t.getMeta(idGuardKey))
      if (!user) return null
      // one combined transform over every applied transaction, from oldState.doc
      const combined = new Transform(oldState.doc)
      try {
        for (const t of trs) for (const s of t.steps) combined.step(s as Step)
      } catch {
        return null
      }
      if (!combined.doc.eq(newState.doc)) return null
      const fixes = idFixes(oldState.doc, combined, o)
      if (!fixes.length) return null
      const tr = applyIdFixes(newState.tr, fixes)
      tr.setMeta(idGuardKey, true)
      return tr
    },
  })
}

// =====================================================================================================
// retypeGuard (Pass 4 #34): a deletion typed straight back is no suggestion
// =====================================================================================================

export interface RetypeGuardOptions {
  /** true when the id belongs to a TJ suggestion (a Claude suggestion is never cancelled here). */
  isTjOwned(id: SuggestionId): boolean
  /** The guard only runs while this is true (Suggesting mode). */
  enabled(): boolean
  /** true for transactions the guard must leave alone (hydrate, decide, reload, history$, draft restore). */
  isProgrammatic?(tr: Transaction): boolean
}

export const retypeGuardKey = new PluginKey('mdr-retype-guard')

/** A struck run and an inserted run of one suggestion that say the same thing: `del` keeps its text, `ins` goes. */
export interface Retype { del: Range; ins: Range; id: SuggestionId }

/** The non-suggestion marks of a node as one string (equal strings: the same formatting). */
function formatKey(marks: readonly Mark[]): string {
  return marks.filter((m) => kindOf(m) === null).map((m) => JSON.stringify(m.toJSON())).sort().join('|')
}

/**
 * Suggestions in the textblocks around `ranges` whose struck text and inserted text are the same words in the same
 * formatting, side by side: select "some", Backspace, type "some" (the library gives the typed text the id of the strike
 * beside it). Nothing changes if both go, and the planner saw nothing to save: no card, no record, marks nobody could
 * accept or reject (Pass 4 #34). Only the exact case: one struck run and one inserted run in the textblock, touching,
 * equal in text and marks. A partial match (a longer word typed over a shorter one) is a real change.
 */
export function retypesIn(doc: PMNode, ranges: readonly Range[], isTjOwned: (id: SuggestionId) => boolean): Retype[] {
  const out: Retype[] = []
  const seen = new Set<number>()
  const size = doc.content.size
  for (const r of ranges) {
    doc.nodesBetween(Math.max(0, r.from - 1), Math.min(size, r.to + 1), (node, pos) => {
      if (!node.isTextblock) return true
      if (seen.has(pos)) return false
      seen.add(pos)
      const runs = new Map<SuggestionId, { del: Array<{ from: number; to: number; text: string; fmt: string }>; ins: Array<{ from: number; to: number; text: string; fmt: string }> }>()
      node.forEach((c, off) => {
        if (!c.isText) return
        for (const m of c.marks) {
          const kind = kindOf(m)
          if (kind !== 'ins' && kind !== 'del') continue
          const id = markIdOf(m)
          const e = runs.get(id) ?? { del: [], ins: [] }
          // (a run is a list of pieces: neighbouring text nodes differ in formatting)
          const from = pos + 1 + off
          e[kind].push({ from, to: from + c.nodeSize, text: c.text ?? '', fmt: formatKey(c.marks) })
          runs.set(id, e)
        }
      })
      for (const [id, e] of runs) {
        if (!isTjOwned(id) || !e.del.length || !e.ins.length) continue
        const piece = (list: typeof e.del): { from: number; to: number } | null => {
          // one run: every piece touches the next
          for (let i = 1; i < list.length; i++) if (list[i - 1]!.to !== list[i]!.from) return null
          return { from: list[0]!.from, to: list[list.length - 1]!.to }
        }
        const d = piece(e.del)
        const i = piece(e.ins)
        if (!d || !i || !(d.to === i.from || i.to === d.from)) continue
        const units = (list: typeof e.del): string[] => list.flatMap((p) => Array.from({ length: p.text.length }, (_, k) => `${p.text[k]}\u0000${p.fmt}`))
        const a = units(e.del)
        const b = units(e.ins)
        if (a.length === 0 || a.length !== b.length || a.some((u, k) => u !== b[k])) continue
        out.push({ id, del: d, ins: i })
      }
      return false
    })
  }
  return out
}

/** The Pass 4 #34 appendTransaction plugin: takes the struck run's mark off and the retyped copy away, in the same undo event. */
export function retypeGuard(o: RetypeGuardOptions): Plugin {
  return new Plugin({
    key: retypeGuardKey,
    appendTransaction(trs, oldState, newState) {
      if (!o.enabled()) return null
      const user = trs.some((t) => t.docChanged && !(o.isProgrammatic?.(t) ?? false) && !t.getMeta(retypeGuardKey))
      if (!user) return null
      const combined = new Transform(oldState.doc)
      try {
        for (const t of trs) for (const s of t.steps) combined.step(s as Step)
      } catch {
        return null
      }
      if (!combined.doc.eq(newState.doc)) return null
      const found = retypesIn(newState.doc, touchedRanges(combined), o.isTjOwned)
      if (!found.length) return null
      const { deletion } = suggestionMarkTypes(newState.schema)
      const tr = newState.tr
      // last first, so each pair's positions are still good when it is its turn
      for (const f of found.sort((x, y) => Math.max(y.del.to, y.ins.to) - Math.max(x.del.to, x.ins.to))) {
        tr.removeMark(f.del.from, f.del.to, deletion)
        tr.delete(f.ins.from, f.ins.to)
      }
      tr.setMeta(retypeGuardKey, true)
      return tr
    },
  })
}

// =====================================================================================================
// Foreign-content filter and D14 Suggesting-mode blocks (pure predicates)
// =====================================================================================================

/** The range a step changes in the doc it applies to; null for steps with no positional effect. */
function stepRange(step: Step, doc: PMNode): Range | null {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep || step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    const s = step as unknown as { from: number; to: number }
    return { from: s.from, to: s.to }
  }
  if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
    const pos = (step as unknown as { pos: number }).pos
    const n = doc.nodeAt(pos)
    return { from: pos, to: pos + (n?.nodeSize ?? 1) }
  }
  return null
}

/** Does a node carrying a foreign suggestion mark overlap (from, to), or hold the point strictly inside it? */
function hitsForeign(doc: PMNode, r: Range, isForeign: (id: SuggestionId) => boolean): boolean {
  const foreignMark = (marks: readonly Mark[]): boolean => marks.some((m) => kindOf(m) !== null && isForeign(markIdOf(m)))
  const size = doc.content.size
  // ancestors carrying a node mark (a whole block inserted by Claude)
  const $from = doc.resolve(Math.min(Math.max(r.from, 0), size))
  for (let d = 1; d <= $from.depth; d++) {
    const n = $from.node(d)
    const start = $from.before(d)
    if (foreignMark(n.marks) && r.from > start && r.to < start + n.nodeSize) return true
  }
  if (r.from === r.to) {
    const $p = doc.resolve(r.from)
    const before = $p.nodeBefore
    const after = $p.nodeAfter
    if (!before || !after) return false
    for (const m of after.marks) {
      if (!kindOf(m) || !isForeign(markIdOf(m))) continue
      if (before.marks.some((x) => x.type === m.type && markIdOf(x) === markIdOf(m))) return true
    }
    return false
  }
  let hit = false
  doc.nodesBetween(r.from, r.to, (n, pos) => {
    if (hit) return false
    if (n.marks.length) {
      const a = Math.max(pos, r.from)
      const b = Math.min(pos + n.nodeSize, r.to)
      if (b > a && foreignMark(n.marks)) hit = true
    }
    return !hit
  })
  return hit
}

/**
 * Foreign content is read-only in both modes (§6.5): true when a user step's changed range intersects a mark whose
 * id belongs to Claude. Abutment is allowed (I-ID handles the ids).
 */
export function foreignViolation(tr: Transform, isForeign: (id: SuggestionId) => boolean): boolean {
  for (let i = 0; i < tr.steps.length; i++) {
    const doc = tr.docs[i]!
    const r = stepRange(tr.steps[i]!, doc)
    if (r && hitsForeign(doc, r, isForeign)) return true
  }
  return false
}

const TABLE_NODES = ['table_header_row', 'table_row', 'table_header', 'table_cell']
const ATOM_NODES = ['frontmatter', 'raw_block', 'hr']

export type SuggestBlockReason =
  | 'code-block' | 'table-structure' | 'table' | 'frontmatter' | 'raw-block' | 'inline-html' | 'atom-block' | 'task-toggle'
  | 'base-changed' | 'untrackable'

function fragmentNodeNames(content: { forEach(f: (n: PMNode) => void): void }, out: Set<string>): void {
  content.forEach((n) => {
    out.add(n.type.name)
    if (!n.isLeaf) fragmentNodeNames(n.content, out)
  })
}

/** Can the node at `pos` carry a suggestion node mark in its parent? (list_item inside a list can since S2-b; kept as a check.) */
function parentAllowsModification(doc: PMNode, pos: number): boolean {
  const { modification } = suggestionMarkTypes(doc.type.schema)
  return doc.resolve(pos).parent.type.allowsMarkType(modification)
}

/**
 * D14 (§6.5): the first Suggesting-mode block a user transform hits, or null. Checked on the ORIGINAL user
 * transaction: text steps inside code_block, table structure, a whole-table insert or delete, frontmatter /
 * raw_block / inline html value changes, atom block inserts and deletes. A task-checkbox toggle is blocked only if
 * the schema can't carry the modification mark on list_item (§6.5 last bullet; it can since S2-b).
 */
/**
 * Does the transaction leave a table it touches with no text (every cell emptied or struck)? In Suggesting mode that is
 * a whole-table delete (select all, then Delete): the suggestion's proposed text drops the table, which the server
 * refuses as a structure change (422 UNANCHORABLE_TARGET), so the editor blocks it first (CONTRACTS §13 #47, QA3).
 */
function emptiesTable(tr: Transform): boolean {
  if (!tr.steps.length) return false
  const { deletion } = suggestionMarkTypes(tr.doc.type.schema)
  const live = (n: PMNode): boolean => {
    let any = false
    n.descendants((c) => {
      if (any) return false
      if (c.isText && !deletion.isInSet(c.marks) && /[^\s\u200b]/.test(c.text ?? '')) any = true
      return !any
    })
    return any
  }
  const seen = new Set<number>()
  for (let i = 0; i < tr.steps.length; i++) {
    const r = stepRange(tr.steps[i]!, tr.docs[i]!)
    if (!r) continue
    const doc = tr.docs[i]!
    let hit = false
    doc.nodesBetween(r.from, r.to, (n, pos) => {
      if (hit) return false
      if (n.type.name !== 'table') return true
      const m = tr.mapping.slice(i).mapResult(pos, 1)
      if (m.deleted || seen.has(m.pos)) return false
      seen.add(m.pos)
      const after = tr.doc.nodeAt(m.pos)
      if (after?.type.name === 'table' && live(n) && !live(after)) hit = true
      return false
    })
    if (hit) return true
  }
  return false
}

export function suggestModeViolation(tr: Transform): SuggestBlockReason | null {
  if (emptiesTable(tr)) return 'table'
  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i]!
    const doc = tr.docs[i]!
    if (step instanceof AttrStep) {
      const n = doc.nodeAt(step.pos)
      if (!n) continue
      const name = n.type.name
      if (name === 'code_block' && step.attr === 'language') continue
      if (name === 'list_item' && step.attr === 'checked') {
        if (!parentAllowsModification(doc, step.pos)) return 'task-toggle'
        continue
      }
      if (name === 'html') return 'inline-html'
      if (name === 'raw_block') return 'raw-block'
      if (name === 'frontmatter') return 'frontmatter'
      if (name === 'table' || TABLE_NODES.includes(name)) return 'table-structure'
      continue
    }
    if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) continue
    const { from, to } = step as unknown as { from: number; to: number }
    const $from = doc.resolve(from)
    const $to = doc.resolve(to)
    for (const $p of [$from, $to]) {
      for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'code_block') return 'code-block'
    }
    const removed = new Set<string>()
    if (to > from) fragmentNodeNames(doc.slice(from, to).content, removed)
    const inserted = new Set<string>()
    fragmentNodeNames(step.slice.content, inserted)
    const schema = doc.type.schema
    const sameTextblock = $from.parent === $to.parent && $from.parent.isTextblock
    if (sameTextblock && step instanceof ReplaceStep && [...inserted].every((n) => schema.nodes[n]?.isInline)) continue
    const all = new Set([...removed, ...inserted])
    if (all.has('code_block')) return 'code-block'
    if (all.has('table')) return 'table'
    for (const n of TABLE_NODES) if (all.has(n)) return 'table-structure'
    if (all.has('frontmatter')) return 'frontmatter'
    if (all.has('raw_block')) return 'raw-block'
    for (const n of ATOM_NODES) if (all.has(n)) return 'atom-block'
    for (const $p of [$from, $to]) {
      for (let d = $p.depth; d > 0; d--) {
        const name = $p.node(d).type.name
        if (name === 'table_cell' || name === 'table_header') {
          if (!sameTextblock) return 'table-structure'
          break
        }
      }
    }
  }
  return null
}

/** Notice text for a D14 block (the toast is P3's; the "Switch to Editing" action is the editor's). */
export const SUGGEST_BLOCK_TEXT: Readonly<Record<SuggestBlockReason, string>> = {
  'code-block': "Code blocks can't be edited in Suggesting mode.",
  'table-structure': "Table structure can't be changed in Suggesting mode.",
  table: "Tables can't be added or removed in Suggesting mode.",
  frontmatter: "The YAML header can't be edited in Suggesting mode.",
  'raw-block': "Raw source blocks can't be edited in Suggesting mode.",
  'inline-html': "Inline HTML can't be edited in Suggesting mode.",
  'atom-block': "Rules and source blocks can't be added or removed in Suggesting mode.",
  'task-toggle': "Checkboxes can't be toggled in Suggesting mode yet.",
  'base-changed': "That edit can't be tracked over a pending suggestion there. Accept or reject it first, or switch to Editing.",
  // the same refusal with no pending suggestion in the doc (Shift+Tab on a middle nested list item): blaming one misled
  untrackable: "That change can't be tracked as a suggestion. Switch to Editing to make it.",
}

/**
 * Did a transaction change the base (every suggestion reverted) of the top-level blocks it touched? A Suggesting-mode
 * transaction never may: its whole effect is suggestion marks, so the original text it leaves for the save planner is
 * the one it found. Compared over the changed top-level run only (untouched blocks are shared by reference), so the
 * cost follows the edit, not the document. This is the safety net under withSuggestChanges: a structural edit over a
 * pending list-item split (suggest-changes' zero-width markers) came back with the split's item boundary left in the
 * deleted copy, so reverting it produced an empty list item and the planner wrote it to disk.
 */
export function baseChangedBy(before: PMNode, after: PMNode): boolean {
  const a = before.content
  const b = after.content
  let i = 0
  while (i < a.childCount && i < b.childCount && a.child(i) === b.child(i)) i++
  let ja = a.childCount
  let jb = b.childCount
  while (ja > i && jb > i && a.child(ja - 1) === b.child(jb - 1)) {
    ja--
    jb--
  }
  if (i === ja && i === jb) return false
  // plus one untouched neighbour on each side (the same node on both sides): a split's zero-width marker pair spans
  // two adjacent blocks, and an edit that removes one marker changes how the untouched block beside it reverts
  if (i > 0) i--
  if (ja < a.childCount) {
    ja++
    jb++
  }
  const run = (f: Fragment, from: number, to: number): PMNode[] => {
    const out: PMNode[] = []
    for (let k = from; k < to; k++) out.push(f.child(k))
    return out
  }
  const baseOf = (nodes: PMNode[]): PMNode[] => {
    const d = revertAll(before.type.create(before.attrs, Fragment.fromArray(nodes))).doc
    return run(d.content, 0, d.childCount)
  }
  const x = baseOf(run(a, i, ja))
  const y = baseOf(run(b, i, jb))
  return x.length !== y.length || x.some((n, k) => !nodeEq(n, y[k]!))
}

// =====================================================================================================
// Programmatic-origin helpers
// =====================================================================================================

/** mdr.origin values: everything that is not TJ typing (§12.4 dirty rule, §6.5 exemptions). */
export type MdrOrigin =
  | 'hydrate' | 'decide' | 'reload' | 'restore-draft' | 'keep-mine' | 'take-theirs' | 'unmark' | 'install' | 'raw-commit' | 'revive'
  | 'refused'

export interface MdrMeta {
  origin: MdrOrigin
  id?: SuggestionId
  ids?: SuggestionId[]
  decision?: 'accept' | 'reject'
  bulk?: string
}

export function mdrMeta(tr: Transaction): MdrMeta | undefined {
  return tr.getMeta('mdr') as MdrMeta | undefined
}

/** history$ (undo/redo) or any mdr origin: not a user edit for the guards. */
export function isProgrammaticTr(tr: Transaction): boolean {
  return !!tr.getMeta('history$') || mdrMeta(tr) !== undefined
}
