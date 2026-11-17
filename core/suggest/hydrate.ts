// core/suggest/hydrate.ts (P2). Canonical record → editor suggestion marks (CONTRACTS §6.3).
//
// 1. Locate the base run (exact source, nearest `located ?? range`) and the live doc range standing for it. The live
//    doc is mapped through baseDoc(live) (every suggestion reverted), so other pending suggestions and TJ's split
//    paragraphs don't break the alignment. A run whose base form differs from the loaded nodes (TJ has unsaved edits
//    there) is not placed now: BASE_NOT_FOUND until the next save or record change.
// 2. P = the classifying parse of `proposed` (loadRun, so raw blocks come back as the server sees them).
// 3. Same block count and per-block structure → a word diff per textblock (inline atoms as U+FFFC; a mark change
//    is a replace of that run) → ReplaceSteps at live positions. Otherwise the base and proposed blocks are diffed
//    child by child (diffBlocks: equal blocks matched, containers of the same type entered, so a list item or
//    blockquote line added or removed marks only that child); if that tracks to something that doesn't revert to the
//    base and accept to the proposal exactly, or cannot be placed, one ReplaceStep over the whole live run.
// 4. tr = transformToSuggestionTransaction(plain, state, () => s.id), selection kept where TJ had it. The library
//    adopts the id of any suggestion mark next to a step and inserts after a neighbouring deletion, so when other
//    suggestions are in the doc it tracks the change on a copy without their marks (same positions) and replays
//    its steps on the live doc: s.id alone, placed as if the doc held nothing else.
// 5. Skip meta, addToHistory false, mdr { origin: 'hydrate', id } (transformToSuggestionTransaction copies the plain
//    transaction's meta, so the meta goes on the result).
// 6. Id check (§6.5 I-ID rule 3): every mark the transaction added carries s.id and every pre-existing mark keeps
//    its id; otherwise ID_COLLISION. Text inside code_block, table structure, atoms, or a transform the schema
//    refuses → SCHEMA ("Shown as a diff").
import DiffMatchPatch from 'diff-match-patch'
import { Fragment, Slice, type Mark, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Transform } from '@milkdown/kit/prose/transform'
import { suggestChangesKey, transformToSuggestionTransaction } from '@handlewithcare/prosemirror-suggest-changes'
import type { Suggestion, SuggestionId } from '../../shared/types'
import type { Md } from '../md/index'
import { VOLATILE_ATTRS, docsEquivalent, nodeEq } from '../splice/eq'
import { loadRun, type Loaded } from '../splice/load'
import { locate } from './record'
import { wordSpans } from './words'
import { kindOf, markIdOf, onlyApplied, revertAll, suggestionSegments } from './guards'

export type Unplaced = 'BASE_NOT_FOUND' | 'ID_COLLISION' | 'SCHEMA'

const dmp = new DiffMatchPatch()
const OBJ = '￼'

// =====================================================================================================
// Live ↔ base alignment (shared with the editor)
// =====================================================================================================

export interface LiveAlignment {
  /** baseDoc(live) and the live → base mapping. */
  revert: Transform
  /** Per load() entry: its range in the base doc and in the live doc. null when the doc no longer lines up with L. */
  entries: Array<{ baseFrom: number; baseTo: number; from: number; to: number }> | null
}

/**
 * Align a live doc with the loaded base: baseDoc(live)'s content nodes (empty typing paragraphs skipped) are matched
 * 1:1 with L's entry nodes by count, then each entry's base range is mapped back to live positions (after
 * insertions that precede it, before insertions that follow it).
 */
export function alignLive(liveDoc: PMNode, L: Pick<Loaded, 'entries'>, revert: Transform = revertAll(liveDoc)): LiveAlignment {
  const base = revert.doc
  const tops: Array<{ pos: number; size: number }> = []
  base.forEach((n, pos) => {
    if (!(n.type.name === 'paragraph' && n.content.size === 0)) tops.push({ pos, size: n.nodeSize })
  })
  const need = L.entries.reduce((s, e) => s + e.nodes.length, 0)
  if (need !== tops.length) return { revert, entries: null }
  const inv = revert.mapping.invert()
  const out: NonNullable<LiveAlignment['entries']> = []
  let t = 0
  for (const e of L.entries) {
    if (e.nodes.length === 0) {
      const at = tops[t]?.pos ?? base.content.size
      out.push({ baseFrom: at, baseTo: at, from: inv.map(at, 1), to: inv.map(at, 1) })
      continue
    }
    const first = tops[t]!
    const last = tops[t + e.nodes.length - 1]!
    t += e.nodes.length
    const baseFrom = first.pos
    const baseTo = last.pos + last.size
    out.push({ baseFrom, baseTo, from: inv.map(baseFrom, 1), to: inv.map(baseTo, -1) })
  }
  return { revert, entries: out }
}

/** Top-level nodes of `doc` whose start lies in [from, to). */
function topNodesIn(doc: PMNode, from: number, to: number): PMNode[] {
  const out: PMNode[] = []
  doc.forEach((n, pos) => {
    if (pos >= from && pos < to) out.push(n)
  })
  return out
}

// =====================================================================================================
// Structure comparison and inline diff
// =====================================================================================================

function attrsEq(a: PMNode, b: PMNode): boolean {
  const skip = VOLATILE_ATTRS[a.type.name] ?? []
  for (const k of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if (skip.includes(k)) continue
    if (JSON.stringify(a.attrs[k]) !== JSON.stringify(b.attrs[k])) return false
  }
  return true
}

/** Same node types and attrs down to the textblocks (whose inline content may differ). Atoms must be nodeEq. */
export function sameStructure(a: readonly PMNode[], b: readonly PMNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.type !== y.type || !attrsEq(x, y)) return false
    if (x.isTextblock) continue
    if (x.isLeaf) {
      if (!nodeEq(x, y)) return false
      continue
    }
    const xs: PMNode[] = []
    const ys: PMNode[] = []
    x.forEach((c) => xs.push(c))
    y.forEach((c) => ys.push(c))
    if (!sameStructure(xs, ys)) return false
  }
  return true
}

interface InlineUnits { str: string; keys: string[] }

function markKey(marks: readonly Mark[]): string {
  return marks.filter((m) => kindOf(m) === null).map((m) => JSON.stringify(m.toJSON())).sort().join('|')
}

/** One unit per inline position: text chars, and U+FFFC for inline leaves (keyed by their JSON). */
function inlineUnits(tb: PMNode): InlineUnits {
  let str = ''
  const keys: string[] = []
  tb.forEach((child) => {
    if (child.isText) {
      const t = child.text ?? ''
      const mk = markKey(child.marks)
      str += t
      for (let i = 0; i < t.length; i++) keys.push(`${t[i]}\u0000${mk}`)
    } else {
      str += OBJ
      keys.push(`${OBJ}\u0000${JSON.stringify({ ...child.toJSON(), marks: undefined })}\u0000${markKey(child.marks)}`)
    }
  })
  return { str, keys }
}

interface InlineChange { a0: number; a1: number; b0: number; b1: number }

/** Word diff of two textblocks' inline units; equal text with different marks or atoms counts as a replace. */
export function inlineDiff(a: PMNode, b: PMNode): InlineChange[] {
  const A = inlineUnits(a)
  const B = inlineUnits(b)
  if (A.keys.length === B.keys.length && A.keys.every((k, i) => k === B.keys[i])) return []
  // whole words (words.ts); the units' keys make a mark or atom change a replace of its word
  return wordSpans(A.str, B.str, A.keys, B.keys).map((s) => ({ a0: s.a0, a1: s.a1, b0: s.b0, b1: s.b1 }))
}

/** Textblock pairs of two same-structure node lists, with each base textblock's content start (base positions). */
function textblockPairs(base: readonly PMNode[], baseStart: number, prop: readonly PMNode[]): Array<{ b: PMNode; at: number; p: PMNode }> {
  const out: Array<{ b: PMNode; at: number; p: PMNode }> = []
  let pos = baseStart
  base.forEach((b, i) => {
    const p = prop[i]!
    if (b.isTextblock) out.push({ b, at: pos + 1, p })
    else if (!b.isLeaf) {
      const bs: PMNode[] = []
      const ps: PMNode[] = []
      b.forEach((c) => bs.push(c))
      p.forEach((c) => ps.push(c))
      out.push(...textblockPairs(bs, pos + 1, ps))
    }
    pos += b.nodeSize
  })
  return out
}

function containsType(nodes: readonly PMNode[], names: ReadonlySet<string>): boolean {
  let hit = false
  for (const n of nodes) {
    if (names.has(n.type.name)) return true
    n.descendants((c) => {
      if (names.has(c.type.name)) hit = true
      return !hit
    })
    if (hit) return true
  }
  return false
}

const TABLE_NODES: ReadonlySet<string> = new Set(['table', 'table_row', 'table_header_row', 'table_cell', 'table_header'])
const TABLE_OR_ATOM = new Set(['table', 'table_row', 'table_header_row', 'table_cell', 'table_header', 'hr', 'raw_block', 'frontmatter'])

// =====================================================================================================
// Child-level block diff (a run whose block structure changed)
// =====================================================================================================

/**
 * An edit in base positions: [a0, a1) of the base doc becomes `content`. `block`: whole blocks are replaced or removed
 * (not words inside a textblock), so another suggestion's marks inside the range would go with them.
 */
interface BaseEdit { a0: number; a1: number; content: Fragment; block?: true }

function childrenOf(n: PMNode): PMNode[] {
  const out: PMNode[] = []
  n.forEach((c) => out.push(c))
  return out
}

/** Equal keys ⇔ nodeEq (volatile attrs left out), so blocks can be matched by string. */
function blockKey(n: PMNode): string {
  if (n.isText) return `"${n.text ?? ''}"${markKey(n.marks)}`
  const skip = VOLATILE_ATTRS[n.type.name] ?? []
  const attrs = Object.keys(n.attrs).filter((k) => !skip.includes(k)).sort().map((k) => `${k}=${JSON.stringify(n.attrs[k])}`).join(',')
  return `<${n.type.name} ${attrs}${markKey(n.marks)}>${childrenOf(n).map(blockKey).join('')}</>`
}

/** Index pairs of equal blocks in `a` and `b`, in order: common prefix and suffix, then a longest common subsequence. */
function matchBlocks(a: readonly PMNode[], b: readonly PMNode[]): Array<[number, number]> {
  const ka = a.map(blockKey)
  const kb = b.map(blockKey)
  const head: Array<[number, number]> = []
  let lo = 0
  while (lo < ka.length && lo < kb.length && ka[lo] === kb[lo]) head.push([lo, lo++])
  let ea = ka.length
  let eb = kb.length
  const tail: Array<[number, number]> = []
  while (ea > lo && eb > lo && ka[ea - 1] === kb[eb - 1]) tail.push([--ea, --eb])
  const mid: Array<[number, number]> = []
  const n = ea - lo
  const m = eb - lo
  if (n > 0 && m > 0 && n * m <= 1_000_000) {
    const w = m + 1
    const len = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        len[i * w + j] = ka[lo + i] === kb[lo + j] ? len[(i + 1) * w + j + 1]! + 1 : Math.max(len[(i + 1) * w + j]!, len[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (ka[lo + i] === kb[lo + j]) mid.push([lo + i++, lo + j++])
      else if (len[(i + 1) * w + j]! >= len[i * w + j + 1]!) i++
      else j++
    }
  }
  return [...head, ...mid, ...tail.reverse()]
}

/**
 * The edits turning the sibling blocks `base` (the first at base position `at`) into `prop`. Equal blocks are left
 * alone; a run of changed blocks paired one to one is refined (same type and attrs: a textblock gets a word diff, a
 * container is entered); anything else is replaced as a block range. false when the change needs a table or an atom
 * rebuilt, which a suggestion cannot express.
 */
function diffBlocks(base: readonly PMNode[], at: number, prop: readonly PMNode[], out: BaseEdit[]): boolean {
  const starts: number[] = []
  let end = at
  for (const n of base) {
    starts.push(end)
    end += n.nodeSize
  }
  const gap = (i0: number, i1: number, j0: number, j1: number): boolean => {
    if (i0 === i1 && j0 === j1) return true
    const old = base.slice(i0, i1)
    const next = prop.slice(j0, j1)
    if (old.length === next.length) return old.every((b, k) => refine(b, starts[i0 + k]!, next[k]!, out))
    if (containsType(old, TABLE_OR_ATOM) || containsType(next, TABLE_OR_ATOM)) return false
    const a0 = i0 < base.length ? starts[i0]! : end
    const a1 = i1 > i0 ? starts[i1 - 1]! + base[i1 - 1]!.nodeSize : a0
    out.push({ a0, a1, content: Fragment.fromArray([...next]), block: true })
    return true
  }
  let i = 0
  let j = 0
  for (const [mi, mj] of matchBlocks(base, prop)) {
    if (!gap(i, mi, j, mj)) return false
    i = mi + 1
    j = mj + 1
  }
  return gap(i, base.length, j, prop.length)
}

/** The edits turning the block `b` (at base position `at`) into `p`. */
function refine(b: PMNode, at: number, p: PMNode, out: BaseEdit[]): boolean {
  if (b.type === p.type && attrsEq(b, p)) {
    if (b.isTextblock) {
      const changes = inlineDiff(b, p)
      if (changes.length && b.type.name === 'code_block') return false
      for (const c of changes) out.push({ a0: at + 1 + c.a0, a1: at + 1 + c.a1, content: p.content.cut(c.b0, c.b1) })
      return true
    }
    if (!b.isLeaf) return diffBlocks(childrenOf(b), at + 1, childrenOf(p), out)
    if (nodeEq(b, p)) return true
  }
  if (containsType([b], TABLE_OR_ATOM) || containsType([p], TABLE_OR_ATOM)) return false
  out.push({ a0: at, a1: at + b.nodeSize, content: Fragment.from(p), block: true })
  return true
}

/**
 * `doc` with every suggestion mark removed, positions unchanged. transformToSuggestionTransaction reuses the id of a
 * mark next to a step (and puts an insertion after a neighbouring deletion), which would hand a Claude suggestion the
 * id, or the place, of the one beside it.
 */
function withoutSuggestionMarks(doc: PMNode): PMNode {
  const strip = (n: PMNode): PMNode => {
    const marks = n.marks.filter((m) => kindOf(m) === null)
    let changed = marks.length !== n.marks.length
    if (n.isText) return changed ? n.mark(marks) : n
    const kids: PMNode[] = []
    n.forEach((c) => {
      const k = strip(c)
      if (k !== c) changed = true
      kids.push(k)
    })
    return changed ? n.type.create(n.attrs, Fragment.fromArray(kids), marks) : n
  }
  return strip(doc)
}

// =====================================================================================================
// Id check (§6.5 I-ID rule 3)
// =====================================================================================================

export function hydrateIdCheck(oldDoc: PMNode, tr: Transform, id: SuggestionId): boolean {
  const inv = tr.mapping.invert()
  let ok = true
  tr.doc.descendants((n, pos) => {
    if (!ok) return false
    for (const m of n.marks) {
      if (!kindOf(m)) continue
      const mid = markIdOf(m)
      if (mid === id) continue
      // a mark of another id must stand on content that already carried it, char by char for text
      const len = n.isText ? (n.text?.length ?? 0) : 1
      for (let k = 0; k < len; k++) {
        const q = inv.mapResult(pos + k, 1)
        const old = q.deleted ? null : oldDoc.nodeAt(q.pos)
        if (!old || !old.marks.some((x) => x.type === m.type && markIdOf(x) === mid)) {
          ok = false
          return false
        }
      }
    }
    return true
  })
  if (!ok) return false
  for (const seg of suggestionSegments(oldDoc)) {
    if (seg.id === id) continue
    const r = tr.mapping.mapResult(seg.from, 1)
    if (r.deleted) return false
    const n = tr.doc.nodeAt(r.pos)
    if (!n || !n.marks.some((x) => x.type === seg.mark.type && markIdOf(x) === seg.id)) return false
  }
  return true
}

// =====================================================================================================
// hydrate
// =====================================================================================================

export function hydrate(state: EditorState, s: Suggestion, ctx: { md: Md; loaded: Loaded; alignment?: LiveAlignment }):
  { tr: Transaction } | { unplaced: Unplaced } {
  const L = ctx.loaded
  const hint = s.located ? { ...s, range: { ...s.range, start: s.located.start } } : s
  const run = locate(L, hint)
  if (!run) return { unplaced: 'BASE_NOT_FOUND' }
  const al = ctx.alignment ?? alignLive(state.doc, L)
  if (!al.entries) return { unplaced: 'BASE_NOT_FOUND' }
  const first = al.entries[run.start]
  const last = al.entries[run.end - 1]
  if (!first || !last) return { unplaced: 'BASE_NOT_FOUND' }
  const baseNodes = L.entries.slice(run.start, run.end).flatMap((e) => e.nodes)
  // the run's base form in the live doc must still be what was loaded (no unsaved edits in it)
  const liveBase = topNodesIn(al.revert.doc, first.baseFrom, last.baseTo)
  if (liveBase.length !== baseNodes.length || !liveBase.every((n, i) => nodeEq(n, baseNodes[i]!))) return { unplaced: 'BASE_NOT_FOUND' }

  let P: PMNode[]
  try {
    P = s.proposed === '' ? [] : loadRun(ctx.md, s.proposed, L.defs, L.eol)
  } catch {
    return { unplaced: 'SCHEMA' }
  }
  const inv = al.revert.mapping.invert()
  // the change is tracked against a doc without other suggestions' marks (see step 4)
  const tracking = al.revert.steps.length ? EditorState.create({ doc: withoutSuggestionMarks(state.doc) }) : state
  /** Base-position edits → live positions, last first so each step leaves the earlier positions alone. */
  const live = (edits: readonly BaseEdit[]) =>
    edits.map((e) => {
      const from = inv.map(e.a0, 1)
      return { from, to: e.a1 > e.a0 ? Math.max(from, inv.map(e.a1, -1)) : from, content: e.content, block: e.block }
    })
  const apply = (plain: Transaction, edits: readonly BaseEdit[]): void => {
    for (const e of live(edits).sort((x, y) => y.from - x.from)) plain.replace(e.from, e.to, new Slice(e.content, 0, 0))
  }
  if (sameStructure(baseNodes, P)) {
    const edits: BaseEdit[] = []
    for (const { b, at, p } of textblockPairs(baseNodes, first.baseFrom, P)) {
      const changes = inlineDiff(b, p)
      if (!changes.length) continue
      if (b.type.name === 'code_block') return { unplaced: 'SCHEMA' }
      for (const c of changes) edits.push({ a0: at + c.a0, a1: at + c.a1, content: p.content.cut(c.b0, c.b1) })
    }
    if (!containsType(baseNodes, TABLE_NODES)) return finish(tracking.tr, (plain) => apply(plain, edits))
    // Edits in neighbouring table cells (Claude's quote across "| 12.0% | 9 mo |"): the library puts an insertion after
    // the deletion run at its spot, and a run of the same id that starts the next cell counts as one with it, so
    // applied last-first, cell 2's "13.0%" landed in cell 3 and Accept merged the two cells (11/13 trial bug). Applied
    // first-to-last, each cell's insertion is placed before the next cell is touched. Verified like a structural
    // change; one that still doesn't round-trip is a "Shown as a diff" card (the server's accept is exact).
    const expected = new Transform(al.revert.doc).replaceWith(first.baseFrom, last.baseTo, Fragment.fromArray(P))
    return finish(tracking.tr, (plain) => {
      for (const e of live(edits).sort((x, y) => x.from - y.from)) {
        plain.replace(plain.mapping.map(e.from, 1), plain.mapping.map(e.to, -1), new Slice(e.content, 0, 0))
      }
    }, (tr) => docsEquivalent(revertAll(tr.doc).doc, al.revert.doc) && docsEquivalent(onlyApplied(tr.doc, new Set([s.id])).doc, expected.doc))
  }
  // the block structure changed: first child by child, then (if that can't be placed or doesn't round-trip) the whole run
  const edits: BaseEdit[] = []
  // (a replaced or removed block that holds another suggestion's marks is not placed: the marks would go with it)
  if (diffBlocks(baseNodes, first.baseFrom, P, edits) && edits.length && !live(edits).some((e) => e.block && e.to > e.from && suggestionSegments(state.doc, e.from, e.to).length > 0)) {
    const expected = new Transform(al.revert.doc)
    if (P.length === 0) expected.delete(first.baseFrom, last.baseTo)
    else expected.replaceWith(first.baseFrom, last.baseTo, Fragment.fromArray(P))
    const fine = finish(tracking.tr, (plain) => apply(plain, edits), (tr) =>
      docsEquivalent(revertAll(tr.doc).doc, al.revert.doc) && docsEquivalent(onlyApplied(tr.doc, new Set([s.id])).doc, expected.doc))
    if ('tr' in fine) return fine
  }
  if (containsType(baseNodes, TABLE_OR_ATOM) || containsType(P, TABLE_OR_ATOM)) return { unplaced: 'SCHEMA' }
  if (suggestionSegments(state.doc, first.from, last.to).length > 0) return { unplaced: 'ID_COLLISION' }
  return finish(tracking.tr, (plain) => {
    if (P.length === 0) plain.delete(first.from, last.to)
    else plain.replaceWith(first.from, last.to, Fragment.fromArray(P))
  })

  /** Track `plain` (filled by `fill`) as a suggestion with id s.id; `verify` can still reject the result. */
  function finish(plain: Transaction, fill: (plain: Transaction) => void, verify?: (tr: Transaction) => boolean):
    { tr: Transaction } | { unplaced: Unplaced } {
    fill(plain)
    if (!plain.docChanged) return { unplaced: 'SCHEMA' }
    let tr: Transaction
    try {
      const tracked = transformToSuggestionTransaction(plain, tracking, () => s.id)
      if (tracking === state) tr = tracked
      else {
        tr = state.tr
        for (const step of tracked.steps) tr.step(step)
      }
      tr.doc.check()
    } catch {
      return { unplaced: 'SCHEMA' }
    }
    // the library may move the caret next to its marks; hydration never moves TJ's selection
    try {
      tr.setSelection(state.selection.map(tr.doc, tr.mapping))
    } catch {
      // selection that can't be mapped (it never happens for text selections): leave the library's
    }
    tr.setMeta(suggestChangesKey, { skip: true })
    tr.setMeta('addToHistory', false)
    tr.setMeta('mdr', { origin: 'hydrate', id: s.id })
    if (!hydrateIdCheck(state.doc, tr, s.id)) return { unplaced: 'ID_COLLISION' }
    if (verify && !verify(tr)) return { unplaced: 'SCHEMA' }
    return { tr }
  }
}
