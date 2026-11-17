// core/bridge/import-plan.ts. What `mdr import-gdoc` posts for a parsed Google Doc (gdoc-read.ts): one plan step per
// Google comment thread and per suggested edit, each with the op to try first and the fallback if the store refuses
// it. Pure; the CLI runs the steps in order through the normal agent batch path.
//
// Every imported message is posted by Claude (the store has exactly two authors, TJ and Claude), so the original
// author is carried in the body: "Sam Smith: <comment>". A Google reply becomes a doc-review reply the same way.
import type { AgentOp } from '../../shared/types'
import { occurrenceAt, type GdocImport, type ImportSuggestion, type ImportThread } from './gdoc-read'

export const IMPORT_QUOTE_MAX = 10_000
const BODY_MAX = 20_000

export interface ImportStep {
  kind: 'thread' | 'suggestion'
  sourceId: string
  author: string
  /** First choice. */
  op: AgentOp
  /** If `op` is refused (quote not found, overlap, ...): a doc-level comment that keeps the quote. */
  fallback: AgentOp & { op: 'comment' }
  /** Replies to post on the created thread, in order (threads only). */
  replies: string[]
  /** Resolve the thread after the replies (only with includeResolved, for resolved Google threads). */
  resolve: boolean
  /** Why the step is doc-level from the start, when it is. */
  docWhy?: string
}

export interface ImportPlan {
  steps: ImportStep[]
  skipped: { resolvedThreads: number }
}

const clip = (s: string, n = BODY_MAX): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
/** “quote”, shortened for a body line. */
export const quoted = (q: string, n = 200): string => `“${(q.length > n ? q.slice(0, n - 1) + '…' : q).replace(/\s*\n\s*/g, ' ⏎ ')}”`

export function messageBody(author: string, body: string): string {
  const b = body.trim() === '' ? '(no text)' : body.trim()
  return clip(`${author}: ${b}`)
}

function threadStep(t: ImportThread, key: string, includeResolved: boolean): ImportStep {
  const head = messageBody(t.author, t.body)
  const quote = t.anchor.quote
  const docBody = clip(`${t.author} on ${quote ? quoted(quote) : 'the document'}: ${t.body.trim() || '(no text)'}`)
  const fallback = { op: 'comment' as const, doc: true as const, body: docBody, key: `${key}:doc` }
  const replies = t.replies.map((r) => messageBody(r.author, r.body))
  const resolve = includeResolved && t.resolved
  const base = { kind: 'thread' as const, sourceId: t.sourceId, author: t.author, fallback, replies, resolve }
  if (t.anchor.kind === 'doc') {
    const why = { NO_ANCHOR: 'the comment has no anchor in Google Docs', ANCHOR_DELETED: 'the text it was on has been deleted', IN_SUGGESTED_TEXT: 'it is on text that is only a suggested insertion', NO_TEXT: 'it is anchored on no text' }[t.anchor.why]
    return { ...base, op: fallback, docWhy: why }
  }
  if (t.anchor.quote.length > IMPORT_QUOTE_MAX) return { ...base, op: fallback, docWhy: 'the quote is too long to anchor' }
  return { ...base, op: { op: 'comment', quote: t.anchor.quote, occurrence: t.anchor.occurrence, body: head, key } }
}

/** Expand [from, to) to whole words inside its line, so the quote is distinctive and never empty. */
export function contextSpan(text: string, from: number, to: number): { a: number; b: number } {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1
  let lineEnd = text.indexOf('\n', to)
  if (lineEnd === -1) lineEnd = text.length
  let a = from
  let b = to
  const word = /[\p{L}\p{N}'’_-]/u
  // grow left to the start of the word touching `from`, then one more word if the span is still short
  const growLeft = (): void => {
    while (a > lineStart && /\s/.test(text[a - 1]!)) a--
    while (a > lineStart && word.test(text[a - 1]!)) a--
  }
  const growRight = (): void => {
    while (b < lineEnd && /\s/.test(text[b]!)) b++
    while (b < lineEnd && word.test(text[b]!)) b++
  }
  while (a > lineStart && word.test(text[a - 1]!)) a--
  while (b < lineEnd && word.test(text[b]!)) b++
  if (b - a < 12) {
    growLeft()
    growRight()
  }
  if (b === a) {
    growRight()
    if (b === a) growLeft()
  }
  return { a, b }
}

function suggestionStep(s: ImportSuggestion, text: string, key: string): ImportStep {
  const what = s.del && s.ins ? `replace ${quoted(s.del)} with ${quoted(s.ins)}` : s.del ? `delete ${quoted(s.del)}` : `insert ${quoted(s.ins)}`
  const reason = `${s.author} suggested this in Google Docs`
  const body = clip(`${s.author} suggested: ${what}${s.summary && s.multiBlock ? ` (${s.summary})` : ''}`)
  const fallback = { op: 'comment' as const, doc: true as const, body, key: `${key}:doc` }
  const base = { kind: 'suggestion' as const, sourceId: s.sourceId, author: s.author, fallback, replies: [], resolve: false }
  if (s.multiBlock) return { ...base, op: fallback, docWhy: 'it adds or removes a paragraph break' }
  const { a, b } = contextSpan(text, s.from, s.to)
  const quote = text.slice(a, b)
  if (!quote.trim()) return { ...base, op: fallback, docWhy: 'there is no text around it to anchor on' }
  const replace = text.slice(a, s.from) + s.ins + text.slice(s.to, b)
  return { ...base, op: { op: 'suggest', quote, replace, occurrence: occurrenceAt(text, quote, a), reason, key } }
}

export function planImport(imp: GdocImport, o: { includeResolved?: boolean; keyPrefix?: string } = {}): ImportPlan {
  const pre = o.keyPrefix ?? `gdoc:${imp.documentId ?? 'doc'}`
  const steps: ImportStep[] = []
  let resolvedSkipped = 0
  for (const t of imp.threads) {
    if (t.resolved && !o.includeResolved) {
      resolvedSkipped++
      continue
    }
    steps.push(threadStep(t, `${pre}:${t.sourceId}`, !!o.includeResolved))
  }
  for (const s of imp.suggestions) steps.push(suggestionStep(s, imp.text, `${pre}:${s.sourceId}`))
  return { steps, skipped: { resolvedThreads: resolvedSkipped } }
}
