// tests/corpus/harness.ts (P1). The S2 edit suite lifted onto the split API, with every corpus gate's check
// (CONTRACTS §3.4 corpus gates, D36, D37; spike/s2/src/harness.ts is the source of the edit classes).
//
// One edit = an edited PM doc plus the entries it touches and how its scope is measured. `evaluate` runs the whole
// pipeline on it (planSave → applyBlockOps → updateLoaded) and answers each gate:
//   G0  block-scoped under the D36 rule (out-of-block lines only from a recorded, adjacent, marker-only, necessary
//       list flip, reported in their own column), content round trip, re-save no-op
//   G1  applyBlockOps(planSave) === oracleSave wherever the oracle verifies
//   G2  updateLoaded(L, text, ops) deep-equals load(text) (entries by nodeEq, blocks by value)
//   G3  planSave(updateLoaded(..., liveNodes), sameDoc) === []
//   G7  nothing widened, nothing failed
// plus the S2 extras: table delimiter rows kept, a frontmatter field edit changes exactly one YAML line. The S2
// suggest-changes flow (suggestFlow) runs on the split pipeline too (the S2-b rerun, §3.2).
import DiffMatchPatch from 'diff-match-patch'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import {
  applySuggestions, enableSuggestChanges, revertSuggestions, suggestChanges, transformToSuggestionTransaction,
} from '@handlewithcare/prosemirror-suggest-changes'
import type { ApplyBlockOpsResult, BlockOp } from '../../shared/types'
import { SuggestionResidueError, type Md } from '../../core/md/index'
import { applyBlockOps, assembleOps } from '../../core/splice/apply'
import { contentNodes, nodeEq } from '../../core/splice/eq'
import { load, type Loaded } from '../../core/splice/load'
import { planSave } from '../../core/splice/plan'
import { listMarker, parseBlock, parseMdast, renderNode, swapListMarkers } from '../../core/splice/render'
import { updateLoaded } from '../../core/splice/update'
import { oracleSave } from './oracle-save'

const dmp = new DiffMatchPatch()

// ------------------------------------------------------------------ line diff (S2)

export interface LineDiff {
  /** 0-based original line numbers that were removed or modified */
  removed: number[]
  /** 0-based original line numbers before which new lines were inserted */
  insertedBefore: number[]
  addedLines: number
}

export function lineDiff(a: string, b: string): LineDiff {
  // a missing final EOL is not a change to the last line's content
  const eol = a.includes('\r\n') ? '\r\n' : '\n'
  if (a.length && !a.endsWith('\n')) a += eol
  if (b.length && !b.endsWith('\n')) b += eol
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b)
  const diffs = dmp.diff_main(chars1, chars2, false)
  dmp.diff_charsToLines_(diffs, lineArray)
  const removed: number[] = []
  const insertedBefore: number[] = []
  let line = 0
  let addedLines = 0
  for (const [op, text] of diffs) {
    const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    if (op === 0) line += n
    else if (op === -1) {
      for (let k = 0; k < n; k++) removed.push(line + k)
      line += n
    } else {
      insertedBefore.push(line)
      addedLines += n
    }
  }
  return { removed, insertedBefore, addedLines }
}

export const lineOf = (src: string, offset: number): number => {
  let n = 0
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

// ------------------------------------------------------------------ edit model

export type Scope =
  | { kind: 'block'; entry: number; emptied: boolean }  // word / field edits: inside the block's lines
  | { kind: 'local'; entry: number }                    // structural: the block plus the seam line either side
  | { kind: 'span'; entries: number[] }                 // join / move: the whole stretch, ± one line
  | { kind: 'each'; entries: number[] }                 // two distant blocks: each block, ± one line

export interface Edit { cls: string; doc: PMNode; scope: Scope; topType?: string }

export const mangle = (w: string): string => w.split('').reverse().join('').toLowerCase() + 'q'

export function entryIndexOf(L: Loaded, topIndex: number): number {
  let idx = 0
  for (let i = 0; i < L.entries.length; i++) {
    if (topIndex < idx + L.entries[i]!.nodes.length) return i
    idx += L.entries[i]!.nodes.length
  }
  return L.entries.length - 1
}

export type Target = 'paragraph' | 'list-paragraph' | 'table-cell' | 'heading' | 'blockquote-paragraph'

interface Hit { from: number; to: number; word: string; topIndex: number }

/** S2 findWord: a word (>=4 ascii letters) in a text node whose ancestors match the target. Middle candidate wins. */
export function findWord(doc: PMNode, target: Target): Hit | null {
  const hits: Hit[] = []
  const matches = (chain: string[]): boolean => {
    const top = chain[0]
    const parent = chain[chain.length - 1]
    switch (target) {
      case 'paragraph': return chain.length === 1 && top === 'paragraph'
      case 'heading': return top === 'heading'
      case 'list-paragraph': return (top === 'bullet_list' || top === 'ordered_list') && parent === 'paragraph'
      case 'table-cell': return top === 'table' && chain.includes('table_cell')
      case 'blockquote-paragraph': return top === 'blockquote' && parent === 'paragraph'
    }
  }
  doc.forEach((top, topOffset, topIndex) => {
    const walk = (node: PMNode, pos: number, chain: string[]): void => {
      node.forEach((child, off) => {
        const p = pos + 1 + off
        if (!child.isText) return walk(child, p, [...chain, child.type.name])
        if (!matches(chain)) return
        if (child.marks.some((m) => m.type.name === 'inlineCode' || m.type.name === 'link')) return
        const m = /\b[A-Za-z]{4,}\b/.exec(child.text!)
        if (m) hits.push({ from: p + m.index, to: p + m.index + m[0].length, word: m[0], topIndex })
      })
    }
    walk(top, topOffset, [top.type.name])
  })
  if (!hits.length) return null
  return hits[Math.floor(hits.length / 2)]!
}

const posOfTop = (doc: PMNode, i: number): number => {
  let p = 0
  for (let k = 0; k < i; k++) p += doc.child(k).nodeSize
  return p
}

export function wordEdit(md: Md, L: Loaded, target: Target): Edit | null {
  const hit = findWord(L.doc, target)
  if (!hit) return null
  const state = EditorState.create({ schema: md.schema, doc: L.doc })
  const doc = state.tr.insertText(mangle(hit.word), hit.from, hit.to).doc
  return { cls: target, doc, scope: { kind: 'block', entry: entryIndexOf(L, hit.topIndex), emptied: doc.child(hit.topIndex).content.size === 0 } }
}

/** S2 frontmatterEdit: append " (edited)" to the first `key: value` line of the frontmatter. */
export function frontmatterEdit(md: Md, L: Loaded): (Edit & { fmLine: number }) | null {
  let fmPos = -1
  let fm: PMNode | null = null
  L.doc.forEach((n, off) => {
    if (fm === null && n.type.name === 'frontmatter') {
      fm = n
      fmPos = off
    }
  })
  if (!fm) return null
  const node = fm as PMNode
  const lines = (node.attrs.value as string).split('\n')
  const k = lines.findIndex((l) => /^[A-Za-z_][\w-]*:\s+\S/.test(l) && !/^\s/.test(l))
  if (k < 0) return null
  lines[k] = lines[k]!.replace(/\r?$/, (cr) => ' (edited)' + cr)
  const state = EditorState.create({ schema: md.schema, doc: L.doc })
  const doc = state.tr.setNodeMarkup(fmPos, null, { ...node.attrs, value: lines.join('\n') }).doc
  return { cls: 'frontmatter-field', doc, scope: { kind: 'block', entry: 0, emptied: false }, fmLine: lineOf(L.src, L.entries[0]!.start) + 1 + k }
}

export type Structural = 'insert-paragraph' | 'delete-block' | 'split-paragraph'

export function structuralEdit(md: Md, L: Loaded, kind: Structural): (Edit & { entry: number }) | null {
  const hit = findWord(L.doc, 'paragraph')
  if (!hit) return null
  const state = EditorState.create({ schema: md.schema, doc: L.doc })
  const pos = posOfTop(L.doc, hit.topIndex)
  const top = L.doc.child(hit.topIndex)
  let tr = state.tr
  if (kind === 'insert-paragraph') tr = tr.insert(pos + top.nodeSize, md.schema.nodes.paragraph!.create(null, md.schema.text('A brand new paragraph.')))
  else if (kind === 'delete-block') tr = tr.delete(pos, pos + top.nodeSize)
  else tr = tr.split(hit.from)
  const entry = entryIndexOf(L, hit.topIndex)
  return { cls: kind, doc: tr.doc, scope: { kind: 'local', entry }, entry }
}

export type MultiKind = 'join-paragraphs' | 'move-block' | 'two-blocks'

export function multiEdit(md: Md, L: Loaded, kind: MultiKind): Edit | null {
  const paras: number[] = []
  L.doc.forEach((n, _o, i) => {
    if (n.type.name === 'paragraph' && n.textContent.trim()) paras.push(i)
  })
  const pairs = paras.filter((i) => paras.includes(i + 1))
  const state = EditorState.create({ schema: md.schema, doc: L.doc })
  let tr = state.tr
  if (kind === 'join-paragraphs') {
    if (!pairs.length) return null
    const i = pairs[Math.floor(pairs.length / 2)]!
    tr = tr.join(posOfTop(L.doc, i + 1))
    return { cls: kind, doc: tr.doc, scope: { kind: 'span', entries: [entryIndexOf(L, i), entryIndexOf(L, i + 1)] } }
  }
  if (kind === 'move-block') {
    if (paras.length < 2 || L.doc.childCount < 4) return null
    const i = paras[Math.floor(paras.length / 2)]!
    if (i + 2 >= L.doc.childCount) return null
    const node = L.doc.child(i)
    const dest = posOfTop(L.doc, i + 2) + L.doc.child(i + 2).nodeSize
    tr = tr.insert(dest, node).delete(posOfTop(L.doc, i), posOfTop(L.doc, i) + node.nodeSize)
    return { cls: kind, doc: tr.doc, scope: { kind: 'span', entries: [entryIndexOf(L, i), entryIndexOf(L, i + 1), entryIndexOf(L, i + 2)] } }
  }
  if (paras.length < 2) return null
  const a = paras[0]!
  const b = paras[paras.length - 1]!
  if (a === b) return null
  for (const i of [b, a]) {
    let hit: { from: number; to: number; w: string } | null = null
    L.doc.child(i).descendants((n, pos) => {
      if (hit || !n.isText || n.marks.length) return !hit
      const m = /\b[A-Za-z]{4,}\b/.exec(n.text!)
      if (m) hit = { from: posOfTop(L.doc, i) + 1 + pos + m.index, to: posOfTop(L.doc, i) + 1 + pos + m.index + m[0].length, w: m[0] }
      return false
    })
    if (!hit) return null
    const h = hit as { from: number; to: number; w: string }
    tr = tr.insertText(mangle(h.w), h.from, h.to)
  }
  return { cls: kind, doc: tr.doc, scope: { kind: 'each', entries: [entryIndexOf(L, a), entryIndexOf(L, b)] } }
}

export type SweepKind = 'replace-word' | 'delete-word' | 'bold-word'

/** S2 sweep: edit one word inside each of up to `max` evenly spaced top-level blocks. */
export function sweepEdits(md: Md, L: Loaded, max: number, kind: SweepKind): Edit[] {
  const cands: Array<{ topIndex: number; from: number; to: number; word: string; topType: string }> = []
  L.doc.forEach((top, off, topIndex) => {
    let found: { from: number; to: number; word: string } | null = null
    top.descendants((n, pos) => {
      if (found || !n.isText) return !found
      if (n.marks.some((m) => ['inlineCode', 'link', 'strong'].includes(m.type.name))) return false
      const m = /\b[A-Za-z]{4,}\b/.exec(n.text!)
      if (m) found = { from: off + 1 + pos + m.index, to: off + 1 + pos + m.index + m[0].length, word: m[0] }
      return false
    })
    if (found) cands.push({ topIndex, topType: top.type.name, ...(found as { from: number; to: number; word: string }) })
  })
  const step = Math.max(1, Math.floor(cands.length / max))
  const picked = cands.filter((_, i) => i % step === 0).slice(0, max)
  return picked.map((c) => {
    const state = EditorState.create({ schema: md.schema, doc: L.doc })
    let tr = state.tr
    if (kind === 'replace-word') tr = tr.insertText(mangle(c.word), c.from, c.to)
    else if (kind === 'delete-word') tr = tr.delete(c.from, c.to)
    else tr = tr.addMark(c.from, c.to, md.schema.marks.strong!.create({ marker: '*' }))
    return { cls: kind, doc: tr.doc, topType: c.topType, scope: { kind: 'block', entry: entryIndexOf(L, c.topIndex), emptied: tr.doc.child(c.topIndex).content.size === 0 } }
  })
}

// ------------------------------------------------------------------ the split pipeline

export interface Saved { ops: BlockOp[]; r: ApplyBlockOpsResult }

export function saveSplit(md: Md, L: Loaded, doc: PMNode): Saved {
  const ops = planSave(md, L, doc)
  return { ops, r: applyBlockOps(md, L, ops) }
}

// ------------------------------------------------------------------ canonical content (S2)

/**
 * What the edited doc means once written as markdown, independent of the splicer: each changed node through
 * Milkdown's own serialize -> parse (raw blocks as-is). Absorbs normalizations markdown forces on any writer.
 */
export function canonical(md: Md, L: Loaded, doc: PMNode): PMNode[] {
  const originals = contentNodes(L.doc)
  return contentNodes(doc).flatMap((n) =>
    n.type.name === 'raw_block' || originals.some((o) => nodeEq(o, n)) ? [n] : parseBlock(md, renderNode(md, n, L.eol), L.defs),
  )
}

const nodesEq = (a: readonly PMNode[], b: readonly PMNode[]): boolean => a.length === b.length && a.every((n, i) => nodeEq(n, b[i]!))

// ------------------------------------------------------------------ D36 flip checks

const LIST_NODES = new Set(['bullet_list', 'ordered_list'])
const listCount = (nodes: readonly PMNode[]): number => nodes.filter((n) => LIST_NODES.has(n.type.name)).length

/** The marker character offsets of a top-level list's items, from mdast (D36 rule (c)). */
export function markerOffsets(md: Md, text: string): Set<number> {
  const out = new Set<number>()
  const tree = parseMdast(md, text)
  const list = tree.children?.[0]
  if (!list || list.type !== 'list') return out
  for (const item of list.children ?? []) {
    let off = item.position!.start.offset
    if (list.ordered) while (/\d/.test(text[off]!)) off++
    out.add(off)
  }
  return out
}

export interface FlipVerdict { ok: boolean; why?: string; range: [number, number] }

/**
 * D36 rules (a)–(d) for one recorded flip of an untouched list: it sits right after the op's run (b), only its marker
 * bytes changed and the saved text holds the flipped list (c), and without flips the same ops parse to fewer
 * top-level lists than the intended doc (d). Rule (a) is the flip being in `r.flips`. `range` = the flipped list's
 * original byte range, the out-of-block changes this flip may explain.
 */
export function checkFlip(md: Md, L: Loaded, ops: readonly BlockOp[], flip: { op: number; entry: number }, text: string, intended: readonly PMNode[]): FlipVerdict {
  const e = L.entries[flip.entry]!
  const range: [number, number] = [e.start, e.end]
  const op = ops[flip.op]
  if (!op || op.before !== flip.entry) return { ok: false, why: `(b) flipped entry ${flip.entry} is not the block after op ${flip.op}`, range }
  const before = L.src.slice(e.start, e.end)
  const after = swapListMarkers(md, before)
  const markers = markerOffsets(md, before)
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i] && !markers.has(i)) return { ok: false, why: '(c) a non-marker byte changed', range }
  if (!text.includes(after)) return { ok: false, why: '(c) the flipped list is not in the saved text', range }
  const noFlip = assembleOps(md, L, ops, { flips: false }).text
  if (!(listCount(contentNodes(load(md, noFlip).doc)) < listCount(intended))) return { ok: false, why: '(d) the flip was not needed', range }
  return { ok: true, range }
}

// ------------------------------------------------------------------ evaluate one edit

export interface EvalResult {
  cls: string
  topType?: string
  /** G0: every changed byte inside the edit's region, or explained by a valid flip */
  scoped: boolean
  /** flipped lists needed to explain the bytes (the G0 flip column; each passed D36 rules (b)-(d)) */
  flipHits: number
  /** the saved file re-parses to the edited doc (canonically) and verified */
  contentOk: boolean
  /** saving the saved file again is a no-op */
  resaveOk: boolean
  /** G1: equal to the oracle (null = the oracle itself did not verify, so there is nothing to compare) */
  g1: boolean | null
  g2: boolean
  g3: boolean
  /** G7: nothing widened, nothing failed */
  g7: boolean
  linesTouched: number
  method: 'exact' | '3way' | 'full'
  flips: number
  detail?: string
  text: string
  ops: BlockOp[]
  r: ApplyBlockOpsResult
}

/**
 * The original byte regions an edit may change (closed intervals over L.src offsets). Inter-block whitespace belongs
 * to no block (§3.3), so a structural edit's region is the touched run plus the gaps on both sides (the seams the
 * §3.4 rules choose); a word or field edit's is the block's own bytes, or the block plus its gaps when the edit
 * emptied (deleted) it.
 */
export function scopeRegions(L: Loaded, s: Scope): Array<[number, number]> {
  const E = L.entries
  const n = E.length
  const outer = (i: number, j: number): [number, number] => [i > 0 ? E[i - 1]!.end : 0, j < n - 1 ? E[j + 1]!.start : L.src.length]
  const own = (i: number): [number, number] => [E[i]!.start, E[i]!.end]
  if (s.kind === 'block') return [s.emptied ? outer(s.entry, s.entry) : own(s.entry)]
  if (s.kind === 'local') return [outer(s.entry, s.entry)]
  if (s.kind === 'span') return [outer(Math.min(...s.entries), Math.max(...s.entries))]
  return s.entries.map(own)
}

/**
 * True when `text` is `src` with every region replaced by arbitrary text: the unchanged segments between the
 * (merged, closed) regions appear in `text` in order, the first anchored at the start and the last at the end. Greedy
 * leftmost placement of the middle segments decides it exactly, and no diff alignment is involved, so an edit whose
 * bytes could be explained several ways (deleting one of two identical blocks) is judged by whether ANY explanation
 * stays inside the regions.
 */
export function fitsRegions(src: string, text: string, regions: ReadonlyArray<readonly [number, number]>): boolean {
  const rs = [...regions].sort((x, y) => x[0] - y[0])
  const merged: Array<[number, number]> = []
  for (const [a, b] of rs) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  if (!merged.length) return text === src
  const segs: string[] = []
  let prev = 0
  for (const [a, b] of merged) {
    segs.push(src.slice(prev, a))
    prev = b
  }
  segs.push(src.slice(prev))
  const first = segs[0]!
  const last = segs[segs.length - 1]!
  if (!text.startsWith(first) || !text.endsWith(last)) return false
  const limit = text.length - last.length
  let pos = first.length
  if (limit < pos) return false
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i]!
    if (!seg) continue
    const at = text.indexOf(seg, pos)
    if (at < 0 || at + seg.length > limit) return false
    pos = at + seg.length
  }
  return true
}

export function sameLoaded(a: Loaded, b: Loaded): string | null {
  if (a.src !== b.src) return 'src differs'
  if (a.eol !== b.eol) return 'eol differs'
  if (a.defs !== b.defs) return 'defs differ'
  if (JSON.stringify(a.gaps) !== JSON.stringify(b.gaps)) return 'gaps differ'
  if (JSON.stringify(a.blocks) !== JSON.stringify(b.blocks)) {
    const i = a.blocks.findIndex((x, k) => JSON.stringify(x) !== JSON.stringify(b.blocks[k]))
    return `blocks differ at ${i}: ${JSON.stringify(a.blocks[i])} vs ${JSON.stringify(b.blocks[i])}`
  }
  if (a.entries.length !== b.entries.length) return `entries ${a.entries.length} vs ${b.entries.length}`
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i]!
    const y = b.entries[i]!
    if (x.start !== y.start || x.end !== y.end || x.kind !== y.kind || x.mdType !== y.mdType || x.fidelity !== y.fidelity) return `entry ${i} differs`
    if (!nodesEq(x.nodes, y.nodes)) return `entry ${i} nodes differ`
  }
  if (!nodesEq(contentNodes(a.doc), contentNodes(b.doc))) return 'doc differs'
  return null
}

export function evaluate(md: Md, L: Loaded, e: Edit, o: { oracle?: boolean } = {}): EvalResult {
  const { ops, r } = saveSplit(md, L, e.doc)
  const text = r.text
  const L2 = load(md, text)
  const intended = canonical(md, L, e.doc)
  const contentOk = r.verified && nodesEq(contentNodes(L2.doc), intended)
  const resaveOk = planSave(md, L2, L2.doc).length === 0

  // G0 with the D36 rule, by bytes: the saved text is the source with only the edit's region(s) rewritten; failing
  // that, with the lists whose recorded flips pass rules (b)-(d) rewritten too (each such list is a flip hit)
  const d = lineDiff(L.src, text)
  const regions = scopeRegions(L, e.scope)
  let scoped = fitsRegions(L.src, text, regions)
  let flipHits = 0
  const flipChecks = r.flips.filter((f) => f.entry !== null).map((f) => checkFlip(md, L, ops, f as { op: number; entry: number }, text, contentNodes(e.doc)))
  if (!scoped && flipChecks.length) {
    const good = flipChecks.filter((c) => c.ok)
    scoped = good.length === flipChecks.length && fitsRegions(L.src, text, [...regions, ...good.map((c) => c.range)])
    if (scoped) flipHits = good.length
  }

  let g1: boolean | null = null
  if (o.oracle !== false) {
    const oracle = oracleSave(md, L, e.doc)
    g1 = oracle.stats.verified ? r.verified && oracle.text === text : null
  }
  const why2 = sameLoaded(updateLoaded(md, L, text, ops), L2)
  const g3 = planSave(md, updateLoaded(md, L, text, ops, contentNodes(e.doc)), e.doc).length === 0
  const g7 = r.widened.length === 0 && r.failed.length === 0

  const entry = e.scope.kind === 'block' || e.scope.kind === 'local' ? L.entries[e.scope.entry] : undefined
  const method: EvalResult['method'] = entry?.fidelity === 'exact' ? 'exact' : ops.some((op) => op.covers.length === op.blocks.length && op.blocks.some((b, i) => {
    const orig = L.entries[op.after + 1 + i]
    return orig !== undefined && orig.kind === 'md' && b !== renderNode(md, orig.nodes[0]!, L.eol)
  })) ? '3way' : 'full'

  const problems: string[] = []
  if (!scoped) problems.push(`out of scope: removed lines ${d.removed.slice(0, 8)}, inserted before ${d.insertedBefore.slice(0, 8)}, flips=${JSON.stringify(r.flips)} ${flipChecks.filter((c) => !c.ok).map((c) => c.why).join('; ')}`)
  if (!contentOk) problems.push(`content (verified=${r.verified})`)
  if (!resaveOk) problems.push('resave')
  if (g1 === false) problems.push('differs from the oracle')
  if (why2) problems.push(`G2: ${why2}`)
  if (!g3) problems.push('G3 re-plan not empty')
  if (!g7) problems.push(`G7 widened=${JSON.stringify(r.widened)} failed=${JSON.stringify(r.failed)}`)
  return {
    cls: e.cls, ...(e.topType !== undefined ? { topType: e.topType } : {}), scoped, flipHits, contentOk, resaveOk, g1, g2: why2 === null, g3, g7,
    linesTouched: d.removed.length, method, flips: r.flips.length, ...(problems.length ? { detail: problems.join(' | ') } : {}), text, ops, r,
  }
}

/** S2 table extra: every delimiter/alignment row of the original survives a cell edit. */
export function delimiterRowsKept(src: string, text: string): boolean {
  const delim = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/
  const before = src.split(/\r?\n/).filter((l) => delim.test(l))
  const after = new Set(text.split(/\r?\n/).filter((l) => delim.test(l)))
  return before.every((l) => after.has(l))
}

/** S2 frontmatter extra: the field edit changed exactly that YAML line. */
export function onlyLineChanged(src: string, text: string, line: number): boolean {
  const d = lineDiff(src, text)
  return d.removed.length === 1 && d.removed[0] === line && d.addedLines === 1
}

/** Same-marker list adjacencies a deletion of entry `k` creates (0 or 1), for the corpus G0-flip count. */
export function createdAdjacency(md: Md, L: Loaded, k: number): number {
  const a = L.entries[k - 1]
  const b = L.entries[k + 1]
  if (!a || !b) return 0
  const lm = listMarker(md, L.src.slice(a.start, a.end))
  const rm = listMarker(md, L.src.slice(b.start, b.end))
  return lm && rm && lm.kind === rm.kind && lm.ch === rm.ch ? 1 : 0
}

// ------------------------------------------------------------------ suggest-changes flow (S2 (d), split pipeline)

export interface SuggestResult {
  applicable: boolean
  marksAppear: boolean
  baseSaveClean: boolean
  residueGuardFires: boolean
  applyMatchesDirectEdit: boolean
  applySaveBlockScoped: boolean
  applySaveNoResidue: boolean
  revertRestoresOriginal: boolean
  revertSaveByteIdentical: boolean
  splitSuggestionRoundTrip: boolean
  detail?: string
}

function marksIn(doc: PMNode): Set<string> {
  const s = new Set<string>()
  doc.descendants((n) => {
    n.marks.forEach((m) => s.add(m.type.name))
    return true
  })
  return s
}

/** The .md always holds the doc with pending suggestions reverted (R5.2). */
export function baseDoc(state: EditorState): PMNode {
  let base = state.doc
  revertSuggestions(state, (tr) => {
    base = tr.doc
  })
  return base
}

const docsEq = (a: PMNode, b: PMNode): boolean => nodesEq(contentNodes(a), contentNodes(b))
const saveText = (md: Md, L: Loaded, doc: PMNode): string => saveSplit(md, L, doc).r.text

export function suggestFlow(md: Md, L: Loaded): SuggestResult {
  const src = L.src
  const hit = findWord(L.doc, 'paragraph') ?? findWord(L.doc, 'list-paragraph')
  const r: SuggestResult = {
    applicable: !!hit, marksAppear: false, baseSaveClean: false, residueGuardFires: false, applyMatchesDirectEdit: false,
    applySaveBlockScoped: false, applySaveNoResidue: false, revertRestoresOriginal: false, revertSaveByteIdentical: false,
    splitSuggestionRoundTrip: false,
  }
  if (!hit) return r
  let state = EditorState.create({ schema: md.schema, doc: L.doc, plugins: [suggestChanges()] })
  enableSuggestChanges(state, (tr) => {
    state = state.apply(tr)
  })

  const replacement = mangle(hit.word)
  const plain = state.tr.insertText(replacement, hit.from, hit.to)
  const directDoc = plain.doc
  state = state.apply(transformToSuggestionTransaction(plain, state))

  const marks = marksIn(state.doc)
  r.marksAppear = marks.has('insertion') && marks.has('deletion')
  let delText = ''
  let insText = ''
  state.doc.descendants((n) => {
    if (n.isText) {
      if (n.marks.some((m) => m.type.name === 'deletion')) delText += n.text
      if (n.marks.some((m) => m.type.name === 'insertion')) insText += n.text
    }
    return true
  })
  if (delText !== hit.word || insText !== replacement) r.detail = `del=${JSON.stringify(delText)} ins=${JSON.stringify(insText)}`

  r.baseSaveClean = saveText(md, L, baseDoc(state)) === src
  try {
    planSave(md, L, state.doc)
  } catch (e) {
    r.residueGuardFires = e instanceof SuggestionResidueError
  }

  let applied = state
  applySuggestions(applied, (tr) => {
    applied = applied.apply(tr)
  })
  r.applyMatchesDirectEdit = docsEq(applied.doc, directDoc) && marksIn(applied.doc).size === marksIn(directDoc).size
  const appliedSave = saveText(md, L, applied.doc)
  const ev = evaluate(md, L, { cls: 'suggest-apply', doc: applied.doc, scope: { kind: 'block', entry: entryIndexOf(L, hit.topIndex), emptied: false } }, { oracle: false })
  r.applySaveBlockScoped = ev.scoped && ev.contentOk
  r.applySaveNoResidue = appliedSave === saveText(md, L, directDoc) && appliedSave.includes(replacement)

  let reverted = state
  revertSuggestions(reverted, (tr) => {
    reverted = reverted.apply(tr)
  })
  r.revertRestoresOriginal = docsEq(reverted.doc, L.doc) && !marksIn(reverted.doc).has('insertion') && !marksIn(reverted.doc).has('deletion')
  r.revertSaveByteIdentical = saveText(md, L, reverted.doc) === src

  let s2 = EditorState.create({ schema: md.schema, doc: L.doc, plugins: [suggestChanges()] })
  enableSuggestChanges(s2, (tr) => {
    s2 = s2.apply(tr)
  })
  const splitPlain = s2.tr.setSelection(TextSelection.create(s2.doc, hit.from)).split(hit.from)
  const splitDirect = splitPlain.doc
  s2 = s2.apply(transformToSuggestionTransaction(splitPlain, s2))
  let s2a = s2
  applySuggestions(s2a, (tr) => {
    s2a = s2a.apply(tr)
  })
  let s2r = s2
  revertSuggestions(s2r, (tr) => {
    s2r = s2r.apply(tr)
  })
  const acceptOk = docsEq(s2a.doc, splitDirect)
  const rejectOk = docsEq(s2r.doc, L.doc) && saveText(md, L, s2r.doc) === src
  const baseOk = saveText(md, L, baseDoc(s2)) === src
  r.splitSuggestionRoundTrip = acceptOk && rejectOk && baseOk
  if (!r.splitSuggestionRoundTrip) r.detail = `${r.detail ?? ''} split accept=${acceptOk} reject=${rejectOk} base=${baseOk}`
  return r
}
