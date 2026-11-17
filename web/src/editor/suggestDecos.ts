// web/src/editor/suggestDecos.ts (P2). Our own suggestion decorations (CONTRACTS §0.2 item 7, §6.3, §12.1, §12.15).
//
// suggest-changes 0.1.8 doesn't export its decoration helpers, and marks carry only `id`, so the author colour comes
// from `id → Suggestion.by` here. Every text node with an insertion / deletion mark gets an inline decoration
//   class="mdr-sugg mdr-sugg--ins|del mdr-sugg--tj|claude"  data-testid="mdr-suggestion"
//   data-suggestion=<id>  data-kind="ins"|"del"  data-by="TJ"|"Claude"
// (node marks on a whole block get the same attributes as a node decoration; modification marks get
// class="mdr-sugg mdr-sugg--mod" and data-suggestion only). Insertions are underlined and deletions struck through in
// editor.css, so the cue is never colour alone (R7.4).
//
// What the marks say and what the page shows are two things. The doc keeps suggest-changes' shape (a change is "old
// copy struck, new copy inserted"), so accepting and rejecting stay the library's, but a copy that shows nothing the
// other copy doesn't is not drawn (Pass 4 #22 and the list lift / merge leftover):
//   - format-only: Bold over "new lender programs" is that text struck and the same text inserted in bold. The struck
//     copy is hidden (class mdr-sugg--shadow) and the inserted one is drawn as a format change (mdr-sugg--fmt, or
//     mdr-sugg--mod for a block), so the page shows the formatting and not a delete and a retype of the same words.
//   - swapped blocks: a list lift or merge swaps the whole top-level list for its new form. Textblocks that read the
//     same in both copies show once, as plain text; only the items that differ are struck and green. See swapPlan.
//
// Typing stays cheap: on a doc change the set is mapped and only the touched top-level blocks are recomputed. A
// `rebuild` meta (the review changed who owns which id) recomputes everything, and so does a doc that holds a swap.
import type { Mark, Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Author, SuggestionId } from '../../../shared/types'
import { kindOf, markIdOf, touchedRanges, ZWSP } from '../../../core/suggest/guards'
import { TESTID } from '../../../shared/constants'

export interface SuggestDecoState {
  set: DecorationSet
  /** Ids drawn through a swap plan: their block-level marks have no decoration of their own (see decosIn). */
  swapped: ReadonlySet<SuggestionId>
  /** The top-level block ranges those runs sit in (doc positions). */
  spans: Array<{ from: number; to: number }>
}

export const suggestDecoKey = new PluginKey<SuggestDecoState>('mdr-suggest-decos')

export interface SuggestDecoOptions {
  byOf(id: SuggestionId): Author
  /** The suggestions of the active thread: their marks get data-active (the card ↔ text link, R2.5). */
  isActive?(id: SuggestionId): boolean
}

const OBJ = '￼'
/** Attributes a re-created block may carry differently without reading differently (a list's looseness, ordered labels). */
const NOT_CONTENT: ReadonlySet<string> = new Set(['id', 'label', 'spread'])
/** Blocks a swap plan won't take apart: it can say which items read the same, not which cells or atoms do. */
const TABLE_OR_ATOM: ReadonlySet<string> = new Set(['table', 'table_row', 'table_header_row', 'table_cell', 'table_header', 'hr', 'raw_block', 'frontmatter'])

/** A node's marks other than the suggestion marks, as one string (equal strings = the same formatting). */
function markKey(marks: readonly Mark[]): string {
  return marks.filter((m) => kindOf(m) === null).map((m) => JSON.stringify(m.toJSON())).sort().join('|')
}

const noZw = (s: string): string => s.split(ZWSP).join('')

// =====================================================================================================
// Format-only changes (one textblock)
// =====================================================================================================

/**
 * The suggestions in `tb` whose struck text and inserted text read the same but carry different marks: a bold, italic,
 * code or link toggle, which suggest-changes tracks as "this text deleted, the same text inserted with the mark".
 */
function formatOnlyIds(tb: PMNode): Set<SuggestionId> | null {
  const runs = new Map<SuggestionId, { del: Array<[string, string]>; ins: Array<[string, string]> }>()
  tb.forEach((c) => {
    if (!c.isText) return
    for (const m of c.marks) {
      const kind = kindOf(m)
      if (kind !== 'ins' && kind !== 'del') continue
      const id = markIdOf(m)
      const e = runs.get(id) ?? { del: [], ins: [] }
      e[kind].push([noZw(c.text ?? ''), markKey(c.marks)])
      runs.set(id, e)
    }
  })
  let out: Set<SuggestionId> | null = null
  for (const [id, e] of runs) {
    const del = e.del.map((r) => r[0]).join('')
    if (!del.trim() || del !== e.ins.map((r) => r[0]).join('')) continue
    const keys = (rs: Array<[string, string]>): string[] => rs.flatMap(([t, k]) => Array.from({ length: t.length }, () => k))
    const a = keys(e.del)
    const b = keys(e.ins)
    if (a.some((k, i) => k !== b[i])) (out ??= new Set()).add(id)
  }
  return out
}

// =====================================================================================================
// Swapped blocks (a list lift or merge, a block turned into another)
// =====================================================================================================

type Role = 'keep' | 'hide' | 'fmt' | 'changed'

/** A block carrying a block-level insertion or deletion mark: one copy of a swapped run. */
interface Root { pos: number; node: PMNode; kind: 'ins' | 'del' }

function blockRoots(doc: PMNode): Map<SuggestionId, Root[]> {
  const out = new Map<SuggestionId, Root[]>()
  doc.descendants((node, pos) => {
    if (node.isInline) return false
    for (const m of node.marks) {
      const kind = kindOf(m)
      if (kind !== 'ins' && kind !== 'del') continue
      const id = markIdOf(m)
      const list = out.get(id) ?? []
      list.push({ pos, node, kind })
      out.set(id, list)
      return false
    }
    return true
  })
  return out
}

/** A textblock of a swapped copy: where it sits (`path`), what it says (`text`) and how (`content`, with its marks). */
interface Unit { pos: number; path: string; text: string; content: string }

function sigOf(n: PMNode): string {
  const attrs = Object.keys(n.attrs).filter((k) => !NOT_CONTENT.has(k)).sort().map((k) => `${k}=${JSON.stringify(n.attrs[k])}`).join(',')
  return `${n.type.name}(${attrs})`
}

/** The textblocks of the roots, in order; null when a root holds anything a swap plan can't read (see TABLE_OR_ATOM). */
function unitsOf(roots: readonly Root[]): Unit[] | null {
  const out: Unit[] = []
  let ok = true
  const visit = (node: PMNode, pos: number, path: string, top: boolean): void => {
    if (!ok) return
    if (TABLE_OR_ATOM.has(node.type.name) || (node.isLeaf && !node.isTextblock) || (!top && node.marks.some((m) => kindOf(m) !== null))) {
      ok = false
      return
    }
    const here = `${path}>${sigOf(node)}`
    if (node.isTextblock) {
      let text = ''
      let content = ''
      node.forEach((c) => {
        if (c.marks.some((m) => kindOf(m) !== null)) ok = false
        if (c.isText) {
          const t = noZw(c.text ?? '')
          text += t
          content += `${t}\u0000${markKey(c.marks)}\u0001`
        } else {
          text += OBJ
          content += `${OBJ}${JSON.stringify(c.toJSON())}\u0001`
        }
      })
      out.push({ pos, path: here, text, content })
      return
    }
    node.forEach((c, off) => visit(c, pos + 1 + off, here, false))
  }
  for (const r of roots) visit(r.node, r.pos, '', true)
  return ok ? out : null
}

/** Index pairs of equal keys in `a` and `b`, in order: the common prefix and suffix, then a longest common subsequence. */
function matchKeys(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const head: Array<[number, number]> = []
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) head.push([lo, lo++])
  let ea = a.length
  let eb = b.length
  const tail: Array<[number, number]> = []
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) tail.push([--ea, --eb])
  const mid: Array<[number, number]> = []
  const n = ea - lo
  const m = eb - lo
  if (n > 0 && m > 0 && n * m <= 250_000) {
    const w = m + 1
    const len = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        len[i * w + j] = a[lo + i] === b[lo + j] ? len[(i + 1) * w + j + 1]! + 1 : Math.max(len[(i + 1) * w + j]!, len[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[lo + i] === b[lo + j]) mid.push([lo + i++, lo + j++])
      else if (len[(i + 1) * w + j]! >= len[i * w + j + 1]!) i++
      else j++
    }
  }
  return [...head, ...mid, ...tail.reverse()]
}

/**
 * Which copy of each textblock the page draws, for one swapped run (`x` = the struck copy, `y` = the inserted one):
 * - the same place, words and marks in both: drawn once, plain. Before the first difference that is the struck copy's
 *   place (the inserted copy is hidden), after it the inserted copy's, so the reading order stays the document's;
 * - the same words in another form (a paragraph that became a heading or a list item): the struck copy is hidden and
 *   the inserted one is drawn as a format change;
 * - the rest: struck and green, as any tracked change.
 * null when no textblock reads the same: nothing to take out, the marks draw themselves.
 */
function assignRoles(x: readonly Unit[], y: readonly Unit[]): Map<number, Role> | null {
  const key = (u: Unit): string => `${u.path}\u0002${u.content}`
  const pairs = matchKeys(x.map(key), y.map(key))
  const roles = new Map<number, Role>()
  const usedX = new Set<number>()
  const usedY = new Set<number>()
  pairs.forEach(([i, j], k) => {
    const prefix = i === k && j === k
    roles.set(x[i]!.pos, prefix ? 'keep' : 'hide')
    roles.set(y[j]!.pos, prefix ? 'hide' : 'keep')
    usedX.add(i)
    usedY.add(j)
  })
  let from = 0
  let fmt = 0
  x.forEach((u, i) => {
    if (usedX.has(i) || !u.text.trim()) return
    for (let j = from; j < y.length; j++) {
      if (usedY.has(j) || y[j]!.text !== u.text) continue
      roles.set(u.pos, 'hide')
      roles.set(y[j]!.pos, 'fmt')
      usedY.add(j)
      from = j + 1
      fmt++
      break
    }
  })
  if (!pairs.length && !fmt) return null
  for (const u of [...x, ...y]) if (!roles.has(u.pos)) roles.set(u.pos, 'changed')
  return roles
}

interface SwapPlan {
  roots: Root[]
  roles: Map<number, Role>
}

/** The ids drawn through assignRoles: those with a struck run and an inserted run in which some textblock reads the same. */
function swapPlan(roots: Map<SuggestionId, Root[]>): Map<SuggestionId, SwapPlan> {
  const out = new Map<SuggestionId, SwapPlan>()
  for (const [id, rs] of roots) {
    const xs = rs.filter((r) => r.kind === 'del')
    const ys = rs.filter((r) => r.kind === 'ins')
    if (!xs.length || !ys.length) continue
    const x = unitsOf(xs)
    const y = unitsOf(ys)
    const roles = x && y ? assignRoles(x, y) : null
    if (roles) out.set(id, { roots: rs, roles })
  }
  return out
}

// =====================================================================================================
// Decorations
// =====================================================================================================

type Active = (id: SuggestionId) => boolean

function blockAttrs(id: SuggestionId, kind: 'ins' | 'del', by: Author, active: boolean): { class: string; [attr: string]: string } {
  return {
    class: `mdr-sugg mdr-sugg--${kind} mdr-sugg--${by === 'Claude' ? 'claude' : 'tj'}${active ? ' mdr-sugg--active' : ''}`,
    'data-testid': TESTID.suggestion,
    'data-suggestion': id,
    'data-kind': kind,
    'data-by': by,
    ...(active ? { 'data-active': 'true' } : {}),
  }
}

/** The decorations of a swapped run: each root keeps its data attributes, the textblocks are drawn by role. */
function swapDecos(id: SuggestionId, plan: SwapPlan, byOf: (id: SuggestionId) => Author, active: boolean): Decoration[] {
  const out: Decoration[] = []
  const by = byOf(id)
  const uniform = new Map<number, Role | 'mixed'>()
  const roleOf = (node: PMNode, pos: number): Role | 'mixed' => {
    const known = uniform.get(pos)
    if (known) return known
    let r: Role | 'mixed' | null = null
    if (node.isTextblock) r = plan.roles.get(pos) ?? 'keep'
    else node.forEach((c, off) => {
      const x = roleOf(c, pos + 1 + off)
      r = r === null ? x : r === x ? r : 'mixed'
    })
    uniform.set(pos, r ?? 'keep')
    return r ?? 'keep'
  }
  for (const root of plan.roots) {
    const end = root.pos + root.node.nodeSize
    out.push(Decoration.node(root.pos, end, { class: 'mdr-sugg mdr-sugg--swap', 'data-suggestion': id, 'data-kind': root.kind, 'data-by': by }, { suggestion: id }))
    // the highest node whose textblocks are all drawn the same way carries the decoration
    const paint = (node: PMNode, pos: number): void => {
      const r = roleOf(node, pos)
      if (r === 'mixed') {
        node.forEach((c, off) => paint(c, pos + 1 + off))
        return
      }
      const to = pos + node.nodeSize
      if (r === 'hide') out.push(Decoration.node(pos, to, { class: 'mdr-sugg--shadow' }, { suggestion: id }))
      else if (r === 'changed') out.push(Decoration.node(pos, to, blockAttrs(id, root.kind, by, active), { suggestion: id }))
      else if (r === 'fmt') {
        out.push(Decoration.node(pos, to, { class: `mdr-sugg mdr-sugg--mod${active ? ' mdr-sugg--active' : ''}`, 'data-suggestion': id, ...(active ? { 'data-active': 'true' } : {}) }, { suggestion: id }))
      }
    }
    paint(root.node, root.pos)
  }
  return out
}

function decosIn(doc: PMNode, from: number, to: number, byOf: (id: SuggestionId) => Author, isActive: Active = () => false, swapped: ReadonlySet<SuggestionId> = new Set()): Decoration[] {
  const out: Decoration[] = []
  const block: { fmt: Set<SuggestionId> | null } = { fmt: null }
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) block.fmt = formatOnlyIds(node)
    for (const m of node.marks) {
      const kind = kindOf(m)
      if (!kind) continue
      const id = markIdOf(m)
      const active = isActive(id)
      if (kind === 'mod') {
        if (!node.isInline) out.push(Decoration.node(pos, pos + node.nodeSize, { class: `mdr-sugg mdr-sugg--mod${active ? ' mdr-sugg--active' : ''}`, 'data-suggestion': id, ...(active ? { 'data-active': 'true' } : {}) }))
        continue
      }
      // a swapped run's blocks are drawn by swapDecos
      if (!node.isInline && swapped.has(id)) continue
      const by = byOf(id)
      const attrs = blockAttrs(id, kind, by, active)
      if (node.isInline && block.fmt?.has(id)) {
        // a format-only change: the struck copy hides, the inserted copy is the new formatting
        if (kind === 'del') attrs.class += ' mdr-sugg--shadow'
        else attrs.class = attrs.class.replace('mdr-sugg--ins', 'mdr-sugg--fmt')
        if (kind === 'del') attrs['aria-hidden'] = 'true'
      }
      if (node.isInline) out.push(Decoration.inline(pos, pos + node.nodeSize, attrs, { suggestion: id }))
      else out.push(Decoration.node(pos, pos + node.nodeSize, attrs, { suggestion: id }))
    }
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

/** Does any block in [from, to) carry a block-level insertion or deletion (a root of a possible swap)? */
function hasBlockRoot(doc: PMNode, from: number, to: number): boolean {
  let hit = false
  doc.nodesBetween(from, to, (node) => {
    if (hit) return false
    if (!node.isInline && node.marks.some((m) => kindOf(m) === 'ins' || kindOf(m) === 'del')) hit = true
    return !hit
  })
  return hit
}

function buildAll(doc: PMNode, o: SuggestDecoOptions, plan: Map<SuggestionId, SwapPlan>): SuggestDecoState {
  const isActive = o.isActive ?? (() => false)
  const swapped = new Set(plan.keys())
  const decos = decosIn(doc, 0, doc.content.size, o.byOf, isActive, swapped)
  for (const [id, p] of plan) decos.push(...swapDecos(id, p, o.byOf, isActive(id)))
  return { set: DecorationSet.create(doc, decos), swapped, spans: spansOf(doc, plan) }
}

/** The top-level block ranges the swapped runs sit in, so a later edit elsewhere can leave them alone. */
function spansOf(doc: PMNode, plan: Map<SuggestionId, SwapPlan>): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  for (const p of plan.values()) for (const r of p.roots) out.push(topRange(doc, r.pos))
  return out
}

export function suggestDecoPlugin(o: SuggestDecoOptions): Plugin<SuggestDecoState> {
  const isActive = o.isActive ?? (() => false)
  return new Plugin<SuggestDecoState>({
    key: suggestDecoKey,
    state: {
      init: (_c, state: EditorState) => buildAll(state.doc, o, swapPlan(blockRoots(state.doc))),
      apply(tr, prev, _old, state) {
        if (tr.getMeta(suggestDecoKey) === 'rebuild') return buildAll(state.doc, o, swapPlan(blockRoots(state.doc)))
        if (!tr.docChanged && !tr.steps.length) return prev
        let next = prev.set.map(tr.mapping, tr.doc)
        const spans = prev.spans.map((s) => ({ from: tr.mapping.map(s.from, 1), to: tr.mapping.map(s.to, -1) }))
        const ranges = touchedRanges(tr)
        if (!ranges.length) return { ...prev, set: next, spans }
        let from = Infinity
        let to = -Infinity
        for (const r of ranges) {
          const a = topRange(tr.doc, r.from)
          const b = topRange(tr.doc, r.to)
          from = Math.min(from, a.from)
          to = Math.max(to, b.to)
        }
        if (!(to >= from)) return { ...prev, set: next, spans }
        // A swapped run is drawn as a whole, so an edit inside one (or one that makes a block-level change) redraws
        // every swap in the doc; an edit elsewhere leaves them alone.
        if (spans.some((s) => s.from < to && s.to > from) || hasBlockRoot(tr.doc, from, to)) {
          const plan = swapPlan(blockRoots(tr.doc))
          if (plan.size > 0 || prev.swapped.size > 0) return buildAll(tr.doc, o, plan)
        }
        // (find() also returns decorations that only touch [from, to): a neighbouring block's node decoration stays)
        next = next.remove(next.find(from, to).filter((d) => d.to > from && d.from < to))
        return { set: next.add(tr.doc, decosIn(tr.doc, from, to, o.byOf, isActive, prev.swapped)), swapped: prev.swapped, spans }
      },
    },
    props: {
      decorations: (state) => suggestDecoKey.getState(state)?.set ?? DecorationSet.empty,
    },
  })
}
