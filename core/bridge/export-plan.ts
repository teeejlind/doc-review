// core/bridge/export-plan.ts. Open review threads → what a shared copy carries: Google Docs insertComment /
// addCommentReply requests (anchored by index on the NEW doc, read back after upload) and the per-thread messages the
// .docx writer anchors by ptext offset. Pure.
//
// Every comment on a Google Doc is posted as the connected user, so each message keeps its original author as a
// prefix ("TJ Lind: …", "Claude: …"). Pending suggestions travel as comments that say what they would change.
import type { Author, Hunk, Suggestion, Thread } from '../../shared/types'
import { occurrenceAt, type GdocImport } from './gdoc-read'
import { quoted } from './import-plan'

export interface ExportMessage { who: string; at?: string; body: string }

export interface ExportThread {
  id: string
  /** ptext span of the anchor in the current doc; null = doc-level (or detached). */
  span: { from: number; to: number } | null
  quote: string
  messages: ExportMessage[]
}

const OBJ = '￼'

function hunkLine(h: Pick<Hunk, 'del' | 'ins'>): string {
  if (h.del && h.ins) return `replace ${quoted(h.del, 120)} with ${quoted(h.ins, 120)}`
  if (h.del) return `delete ${quoted(h.del, 120)}`
  return `insert ${quoted(h.ins, 120)}`
}

/**
 * The open threads of a review, in document order, with their messages. `ptext` is the current doc's ptext (the
 * offsets thread.resolution uses). `human` is the display name for Author 'TJ'.
 */
export function exportThreads(threads: readonly Thread[], suggestions: readonly Suggestion[], ptext: string, human: string): ExportThread[] {
  const who = (a: Author): string => (a === 'TJ' ? human : 'Claude')
  const byId = new Map(suggestions.map((s) => [s.id, s]))
  const out: ExportThread[] = []
  for (const t of threads) {
    if (t.status !== 'open' || t.autoResolved) continue
    const messages: ExportMessage[] = []
    for (const s of t.suggestions.map((id) => byId.get(id)).filter((s): s is Suggestion => !!s && s.status === 'pending')) {
      const hunks = s.hunks.length ? s.hunks : [{ del: s.base, ins: s.proposed }]
      messages.push({ who: who(s.by), body: `Suggested edit: ${hunks.slice(0, 5).map(hunkLine).join('; ')}${hunks.length > 5 ? ` (+${hunks.length - 5} more)` : ''}` })
    }
    for (const m of t.messages) if (!m.deleted && m.body.trim()) messages.push({ who: who(m.by), at: m.at, body: m.body.trim() })
    if (!messages.length) continue
    const r = t.resolution
    const textual = t.anchor.kind === 'text' && !t.detached && r.from !== undefined && r.to !== undefined && r.to > r.from && (r.state === 'exact' || r.state === 'moved' || r.state === 'fuzzy')
    const span = textual ? { from: r.from!, to: r.to! } : null
    const quote = span ? ptext.slice(span.from, span.to) : t.lastAnchor.kind === 'text' ? t.lastAnchor.quote : ''
    out.push({ id: t.id, span, quote, messages })
  }
  out.sort((a, b) => (a.span?.from ?? Infinity) - (b.span?.from ?? Infinity))
  return out
}

/** Whitespace-collapsed copy of `s` with, per unit, its raw index. */
function collapse(s: string): { text: string; raw: number[] } {
  let text = ''
  const raw: number[] = []
  let inWs = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    const ws = /\s/.test(c)
    if (ws && inWs) continue
    text += ws ? ' ' : c
    raw.push(i)
    inWs = ws
  }
  return { text, raw }
}

function hits(text: string, q: string): number[] {
  const out: number[] = []
  if (!q) return out
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) out.push(i)
  return out
}

/**
 * Where `quote` (occurrence `occ` of `total` in a source text of length `srcLen`, at offset `srcFrom`) sits in
 * `target`. Same hit count → the same occurrence; otherwise the hit at the closest relative position. Exact first,
 * then whitespace-collapsed. null when it is not there.
 */
export function locate(target: string, quote: string, o: { occ: number; total: number; srcFrom: number; srcLen: number }): { from: number; to: number } | null {
  const pick = (hs: number[]): number => {
    if (hs.length === o.total) return hs[o.occ - 1]!
    const want = o.srcLen ? o.srcFrom / o.srcLen : 0
    let best = hs[0]!
    for (const h of hs) if (Math.abs(h / Math.max(1, target.length) - want) < Math.abs(best / Math.max(1, target.length) - want)) best = h
    return best
  }
  const ex = hits(target, quote)
  if (ex.length) {
    const h = pick(ex)
    return { from: h, to: h + quote.length }
  }
  const T = collapse(target)
  const Q = collapse(quote).text.trim()
  const cs = hits(T.text, Q)
  if (!cs.length) return null
  const h = pick(cs)
  return { from: T.raw[h]!, to: T.raw[h + Q.length - 1]! + 1 }
}

export interface PlacedComment {
  thread: string
  startIndex: number
  endIndex: number
  quote: string
  /** The thread's quote could not be found in the Google Doc: anchored on the doc's first line instead. */
  general?: true
  replies: string[]
}

export interface GdocCommentPlan {
  requests: Array<{ insertComment: { content: string; range: { startIndex: number; endIndex: number } } }>
  placed: PlacedComment[]
}

const line = (m: ExportMessage): string => `${m.who}: ${m.body}`
const MAX = 30_000

/** insertComment requests for the threads, on the NEW Google Doc that was created from the exported markdown. */
export function planGdocComments(threads: readonly ExportThread[], g: GdocImport, ptext: string): GdocCommentPlan {
  const text = g.text
  const toG = (from: number, to: number): { startIndex: number; endIndex: number } | null => {
    let a = from
    let b = to
    while (a < b && g.gindex[a] === -1) a++
    while (b > a && g.gindex[b - 1] === -1) b--
    if (a >= b) return null
    return { startIndex: g.gindex[a]!, endIndex: g.gindex[b - 1]! + 1 }
  }
  // the fallback anchor for general comments: the doc's first line
  const firstLine = (() => {
    const s = text.search(/\S/)
    if (s < 0) return null
    let e = text.indexOf('\n', s)
    if (e < 0) e = text.length
    return toG(s, Math.min(e, s + 120))
  })()
  const requests: GdocCommentPlan['requests'] = []
  const placed: PlacedComment[] = []
  for (const t of threads) {
    let range: { startIndex: number; endIndex: number } | null = null
    const q = t.quote.replaceAll(OBJ, '').trim() ? t.quote : ''
    if (t.span && q) {
      const occ = occurrenceAt(ptext, t.quote, t.span.from)
      const total = hits(ptext, t.quote).length
      const at = locate(text, t.quote, { occ, total, srcFrom: t.span.from, srcLen: ptext.length })
      if (at) range = toG(at.from, at.to)
    }
    const general = !range
    if (!range) range = firstLine
    if (!range) continue
    const [head, ...rest] = t.messages
    let content = line(head!)
    if (general) content = `(General comment${t.quote ? ` on ${quoted(t.quote, 120)}` : ''}) ${content}`
    requests.push({ insertComment: { content: content.slice(0, MAX), range } })
    placed.push({ thread: t.id, ...range, quote: general ? '' : t.quote, ...(general ? { general: true as const } : {}), replies: rest.map((m) => line(m).slice(0, MAX)) })
  }
  return { requests, placed }
}

/** addCommentReply requests, given the commentIds Google returned for the insertComment requests, in order. */
export function planGdocReplies(placed: readonly PlacedComment[], commentIds: readonly string[]): Array<{ addCommentReply: { commentId: string; post: { content: string } } }> {
  if (commentIds.length !== placed.length) throw new Error(`expected ${placed.length} comment ids (one per insertComment request, in order), got ${commentIds.length}`)
  const out: Array<{ addCommentReply: { commentId: string; post: { content: string } } }> = []
  placed.forEach((p, i) => {
    for (const r of p.replies) out.push({ addCommentReply: { commentId: commentIds[i]!, post: { content: r } } })
  })
  return out
}
