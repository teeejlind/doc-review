// core/suggest/extract.ts (P2). TJ's Suggesting-mode edits → sidecar records (CONTRACTS §6.4, gate G5).
//
// extract(state, id): the doc with only `id` applied (every other suggestion reverted) is planned against the base
// with planSave, so the run is exactly the base blocks the change touches and `proposed` is rendered the way an
// Editing-mode save would write it (3-way patched onto the original bytes for in-place edits, S2 renderReplacement).
// `base` is the byte-exact source slice of the run. A pure insertion widens the run to a non-atom neighbour block
// (§6.1: base = neighbour, proposed = neighbour + gap + new block). The anchor sits on the first display hunk.
//
// tjSuggestionDiff(state, review): the upsert / withdraw / reopen sets for one autosave plan. The upsert throttle
// (SUGGESTION_UPSERT_STABLE_MS, D22) and the reopen grouping by the decision journal are the editor's (EditorPort);
// this function only says what differs from the review state.
import type { EditorState } from '@milkdown/kit/prose/state'
import type { ReviewState, SuggestionId, TextAnchor, TjSuggestionUpsert } from '../../shared/types'
import { createAnchor } from '../anchors'
import { isAtomBlock } from '../blocks'
import type { Md } from '../md/index'
import { ptextOf, type PText } from '../ptext'
import { contentNodes, nodeEq } from '../splice/eq'
import type { Loaded } from '../splice/load'
import { planSave } from '../splice/plan'
import { changedSpan, hunksOf } from './record'
import { changePhrase } from './describe'
import { phraseSpan } from './words'
import { onlyApplied, suggestionIdsIn } from './guards'

export interface ExtractCtx {
  md: Md
  loaded: Loaded
  /** The base rev `loaded` was loaded at, for the anchor hint (default 0; the server re-resolves anyway). */
  rev?: number
}

const ptextCache = new WeakMap<Loaded, PText>()
function basePtext(L: Loaded): PText {
  let p = ptextCache.get(L)
  if (!p) ptextCache.set(L, (p = ptextOf(L.doc, L)))
  return p
}

const blockSource = (L: Loaded, k: number): string => {
  const b = L.blocks[k]
  return b ? L.src.slice(b.start, b.end) : ''
}

/** The longest first line a card quotes for a change to a whole block (a heading, a quote), cut at a word. */
const FIRST_LINE_CHARS = 90

/** The anchor on the phrase a record's display hunks change (first hunk to last; the word beside a pure insertion). */
export function anchorForRecord(md: Md, L: Loaded, run: { start: number; end: number }, base: string, proposed: string, rev: number): TextAnchor {
  const p = basePtext(L)
  const startBlock = L.blocks[run.start]
  const at = startBlock?.pStart ?? 0
  const hunks = hunksOf(md, { base, proposed }, at)
  const span = phraseSpan(hunks, p.text)
  if (span) return createAnchor(p, L.blocks, span.from, span.to, rev)
  // no ptext difference (a mark-only, list or block-type change): the words it is about, else the run's first line
  const from = startBlock?.pStart ?? 0
  const to = Math.max(from, L.blocks[run.end - 1]?.pEnd ?? from)
  const phrase = changePhrase(base, proposed)
  let a = from
  let b = to
  const hits: number[] = []
  if (phrase) for (let i = p.text.indexOf(phrase, from); i >= 0 && i + phrase.length <= to; i = p.text.indexOf(phrase, i + 1)) hits.push(i)
  if (phrase && hits.length) {
    // the occurrence the change sits at: as many phrases in the run's text before it as in the source before the change
    let before = 0
    for (let i = base.indexOf(phrase); i >= 0 && i < changedSpan({ base, proposed })[0]; i = base.indexOf(phrase, i + 1)) before++
    a = hits[Math.min(before, hits.length - 1)]!
    b = a + phrase.length
  } else {
    const nl = p.text.indexOf('\n', from)
    if (nl >= 0 && nl < b) b = nl
  }
  if (b - a > FIRST_LINE_CHARS) {
    const cut = p.text.lastIndexOf(' ', a + FIRST_LINE_CHARS)
    b = cut > a + FIRST_LINE_CHARS / 2 ? cut : a + FIRST_LINE_CHARS
  }
  return createAnchor(p, L.blocks, a, Math.max(a, b), rev)
}

export function extract(state: EditorState, id: SuggestionId, ctx: ExtractCtx): TjSuggestionUpsert | null {
  const { md, loaded: L } = ctx
  const only = onlyApplied(state.doc, new Set([id])).doc
  const ops = planSave(md, L, only)
  if (ops.length === 0) return null
  let start = ops[0]!.after + 1
  let end = ops[ops.length - 1]!.before
  const parts: Array<{ src: string; base: number | null }> = []
  let k = start
  for (const op of ops) {
    for (; k <= op.after; k++) parts.push({ src: blockSource(L, k), base: k })
    const inPlace = op.covers.length === op.blocks.length
    op.blocks.forEach((b, j) => parts.push({ src: b, base: inPlace ? op.after + 1 + j : null }))
    k = op.before
  }
  if (start === end) {
    // a pure insertion: anchor it to a non-atom neighbour (§6.1)
    const prev = L.blocks[start - 1]
    const next = L.blocks[end]
    if (prev && !isAtomBlock(prev)) {
      parts.unshift({ src: blockSource(L, start - 1), base: start - 1 })
      start -= 1
    } else if (next && !isAtomBlock(next)) {
      parts.push({ src: blockSource(L, end), base: end })
      end += 1
    } else {
      return null
    }
  }
  // atoms take no inline suggestion (§6.2); the D14 filter keeps them out, this is defence in depth
  for (let i = start; i < end; i++) if (isAtomBlock(L.blocks[i]!)) return null
  const blank = L.eol + L.eol
  let proposed = ''
  parts.forEach((p, i) => {
    if (i > 0) {
      const prev = parts[i - 1]!
      proposed += prev.base !== null && p.base === prev.base + 1 ? (L.gaps[p.base] ?? blank) : blank
    }
    proposed += p.src
  })
  const base = L.src.slice(L.blocks[start]!.start, L.blocks[end - 1]!.end)
  if (base === proposed) return null
  const range = { start, end }
  return { id, range, base, proposed, anchor: anchorForRecord(md, L, range, base, proposed, ctx.rev ?? 0) }
}

/** Do two `proposed` texts parse to the same nodes? (The comparison is semantic, so a reload never re-upserts.) */
export function sameProposal(md: Md, a: string, b: string): boolean {
  if (a === b) return true
  try {
    const x = contentNodes(md.parseDoc(a))
    const y = contentNodes(md.parseDoc(b))
    return x.length === y.length && x.every((n, i) => nodeEq(n, y[i]!))
  } catch {
    return false
  }
}

export interface DiffCtx extends ExtractCtx {
  /** Memoized extract (the editor caches per id and marks version); defaults to extract(). */
  extractFn?: (id: SuggestionId) => TjSuggestionUpsert | null
}

export function tjSuggestionDiff(state: EditorState, review: ReviewState, ctx: DiffCtx):
  { upsert: TjSuggestionUpsert[]; withdraw: SuggestionId[]; reopen: SuggestionId[] } {
  const byId = new Map(review.suggestions.map((s) => [s.id, s]))
  const present = suggestionIdsIn(state.doc)
  const upsert: TjSuggestionUpsert[] = []
  const reopen: SuggestionId[] = []
  const run = ctx.extractFn ?? ((id: SuggestionId) => extract(state, id, ctx))
  for (const id of present) {
    const rec = byId.get(id)
    if (rec?.by === 'Claude') continue
    if (rec && (rec.status === 'accepted' || rec.status === 'rejected')) {
      // marks present again after a decision: an undo (§6.6); only TJ's own decisions can be reopened
      if (rec.decidedBy === 'TJ' || rec.decidedBy === undefined) reopen.push(id)
      continue
    }
    if (rec && rec.status !== 'pending') continue
    const u = run(id)
    if (!u) continue
    if (!rec || rec.base !== u.base || !sameProposal(ctx.md, rec.proposed, u.proposed)) upsert.push(u)
  }
  const withdraw: SuggestionId[] = []
  for (const s of review.suggestions) {
    if (s.by === 'TJ' && (s.status === 'pending' || s.status === 'stale') && !present.has(s.id)) withdraw.push(s.id)
  }
  return { upsert, withdraw, reopen }
}
