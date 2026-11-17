// tests/unit/core/pending/digest.test.ts (P4; CONTRACTS §9.6, D33, §13 #86).
//
// buildPending over hand-built logs, folded with the sidecar fold so `review` is what the store would pass:
// create+delete omitted, resolve/reopen net, block chains netted by hash, windowed sides diffed through runText,
// `partial` when an object is gone, TJ vs external kept apart, accept/undo-accept edits excluded, sources, counts.
import { describe, expect, it } from 'vitest'
import type {
  Anchor, BlockChange, BlockInfo, BlockSide, PendingInput, PendingResult, Resolution, SidecarEvent, TextAnchor,
} from '../../../../shared/types'
import { CONSTANTS } from '../../../../shared/constants'
import * as S from '../../../../shared/schemas'
import { buildPending } from '../../../../core/pending/digest'
import { fold, toReviewState } from '../../../../core/sidecar/fold'

const id = (p: string, n: number): string => `${p}_${String(n).padStart(26, '0')}`
const T = (n: number) => id('t', n) as `t_${string}`
const C = (n: number) => id('c', n) as `c_${string}`
const SG = (n: number) => id('s', n) as `s_${string}`

class Log {
  events: SidecarEvent[] = []
  seq = 0
  rev = 1
  add(type: SidecarEvent['type'], by: SidecarEvent['by'], rest: Record<string, unknown>): number {
    this.seq++
    this.events.push({ seq: this.seq, id: id('e', this.seq), type, by, at: `2026-10-15T17:00:${String(this.seq % 60).padStart(2, '0')}.000Z`, rev: this.rev, ...rest } as unknown as SidecarEvent)
    return this.seq
  }
}

const TEXT_ANCHOR: TextAnchor = {
  kind: 'text', quote: 'member rate', prefix: 'the ', suffix: ' of 12%', hint: { rev: 1, pos: 4, block: 0, blockHash: '0123456789abcdef', offsetInBlock: 4 },
}
const DOC_ANCHOR: Anchor = { kind: 'doc' }

function blocksOf(hashes: string[]): BlockInfo[] {
  return hashes.map((hash, i) => ({
    ref: `b${i + 1}` as `b${number}`, index: i, kind: 'md', mdType: 'paragraph', start: i * 10, end: i * 10 + 8, line: i * 2 + 1,
    endLine: i * 2 + 1, hash, fidelity: 'exact', pStart: 0, pEnd: 0, preview: '',
  }))
}

function side(index: number, hashes: string[], md: string, extra: Partial<BlockSide> = {}): BlockSide {
  return { index, count: hashes.length, hashes, start: index * 10, end: index * 10 + md.length, md, ...extra }
}
const replace = (b: BlockSide, a: BlockSide): BlockChange => ({ op: 'replace', before: b, after: a })
const insert = (a: BlockSide): BlockChange => ({ op: 'insert', before: null, after: a })
const del = (b: BlockSide): BlockChange => ({ op: 'delete', before: b, after: null })

function run(log: Log, o: { ack?: number; blocks?: BlockInfo[]; runText?: PendingInput['runText'] } = {}): PendingResult {
  const events = [...log.events]
  const f = fold(events)
  if (o.ack !== undefined) f.cursors.claudeAck = o.ack
  const resolve = (a: Anchor): Resolution => (a.kind === 'doc' ? { state: 'doc' } : { state: 'exact', block: 0, from: 4, to: 15 })
  const review = toReviewState(f, resolve, { file: 'doc.md' })
  const res = buildPending({
    file: 'doc.md', abs: '/abs/doc.md', rev: f.rev, hash: 'a'.repeat(64), via: 'server', events, review,
    blocks: o.blocks ?? blocksOf(['1111111111111111', '2222222222222222', '3333333333333333']),
    runText: o.runText ?? (() => null),
  })
  const parsed = S.PendingResultSchema.safeParse(res)
  expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues.slice(0, 3))).toBe(true)
  return res
}

describe('window, cursor and empty', () => {
  it('nothing after the ack → empty, since = ack, cursor = seq', () => {
    const log = new Log()
    log.add('comment.add', 'TJ', { thread: T(1), comment: C(1), anchor: DOC_ANCHOR, body: 'hi' })
    const r = run(log, { ack: 1 })
    expect(r).toMatchObject({ since: 1, cursor: 1, empty: true, threads: [], edits: [], external: [], handoffs: [], notices: [] })
    expect(r.counts).toEqual({ threads: 0, messages: 0, suggestions: 0, decisions: 0, resolves: 0, edits: 0, external: 0, notices: 0, handoffs: 0 })
  })

  it('handoffs in the window are listed with their message; earlier ones are not', () => {
    const log = new Log()
    log.add('handoff.sent', 'TJ', { message: 'old', delivery: 'waiter' })
    const s2 = log.add('handoff.sent', 'TJ', { message: 'Tighten section 2', delivery: 'clipboard' })
    const s3 = log.add('handoff.sent', 'TJ', { message: null, delivery: 'latched' })
    const r = run(log, { ack: 1 })
    expect(r.handoffs).toEqual([
      { seq: s2, at: log.events[1]!.at, message: 'Tighten section 2' },
      { seq: s3, at: log.events[2]!.at, message: null },
    ])
    expect(r.counts.handoffs).toBe(2)
    expect(r.empty).toBe(false)
  })
})

describe('threads and messages', () => {
  it('a TJ thread created in the window is listed whole, its root flagged new', () => {
    const log = new Log()
    log.add('comment.add', 'TJ', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Is 12% current?' })
    const r = run(log)
    expect(r.threads).toHaveLength(1)
    expect(r.threads[0]).toMatchObject({
      id: T(1), kind: 'comment', status: 'open', activity: ['created'],
      anchor: { state: 'ok', block: 'b1', line: 1, quote: 'member rate' },
      messages: [{ id: C(1), by: 'TJ', body: 'Is 12% current?', new: true }], suggestions: [],
    })
    expect(r.counts).toMatchObject({ threads: 1, messages: 1 })
  })

  it('the whole thread is context: Claude\'s earlier message unflagged, TJ\'s reply new', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Should this be 11%?' })
    log.add('comment.reply', 'TJ', { thread: T(1), comment: C(2), body: 'No, 12 is right' })
    const r = run(log, { ack: 1 })
    expect(r.threads[0]!.activity).toEqual(['replied'])
    expect(r.threads[0]!.messages).toEqual([
      { id: C(1), by: 'Claude', at: log.events[0]!.at, body: 'Should this be 11%?' },
      { id: C(2), by: 'TJ', at: log.events[1]!.at, body: 'No, 12 is right', new: true },
    ])
  })

  it('a reply created and deleted inside the window is omitted, and a thread with nothing left is not listed', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Q?' })
    log.add('comment.reply', 'TJ', { thread: T(1), comment: C(2), body: 'oops' })
    log.add('comment.delete', 'TJ', { comment: C(2) })
    const r = run(log, { ack: 1 })
    expect(r.threads).toEqual([])
    expect(r.empty).toBe(true)
  })

  it('a TJ root comment created and deleted in the window: the fold drops the thread, pending lists nothing', () => {
    const log = new Log()
    log.add('comment.add', 'TJ', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'never mind' })
    log.add('comment.delete', 'TJ', { comment: C(1) })
    expect(run(log).threads).toEqual([])
  })

  it('TJ deleting an already-acked comment that was its thread\'s only message is listed (QA confirmed 33): the fold drops the thread, pending still reports it', () => {
    const log = new Log()
    log.add('comment.add', 'TJ', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Y1 only message' })
    log.add('comment.delete', 'TJ', { comment: C(1) })
    const r = run(log, { ack: 1 })
    expect(r.empty).toBe(false)
    expect(r.threads).toEqual([{
      id: T(1), kind: 'comment', status: 'open', activity: ['deleted'],
      anchor: { state: 'detached', block: null, line: null, quote: 'member rate' },
      messages: [{ id: C(1), by: 'TJ', at: log.events[0]!.at, body: '', deleted: true }],
      suggestions: [],
    }])
    expect(r.counts.threads).toBe(1)
    expect(r.counts.messages).toBe(0)
  })

  it('a doc-level thread retracted the same way lists only the messages deleted in the window', () => {
    const log = new Log()
    log.add('comment.add', 'TJ', { thread: T(1), comment: C(1), anchor: DOC_ANCHOR, body: 'Overall?' })
    log.add('comment.reply', 'TJ', { thread: T(1), comment: C(2), body: 'And the tone?' })
    log.add('comment.delete', 'TJ', { comment: C(2) })
    log.add('comment.delete', 'TJ', { comment: C(1) })
    const r = run(log, { ack: 3 })
    expect(r.threads).toHaveLength(1)
    expect(r.threads[0]).toMatchObject({ id: T(1), kind: 'doc', activity: ['deleted'], anchor: { state: 'doc', quote: '' } })
    expect(r.threads[0]!.messages.map((m) => [m.id, m.deleted])).toEqual([[C(1), true]])
  })

  it('a retracted thread is not news when the deletion predates the window, nor when it was created and deleted inside it', () => {
    const log = new Log()
    log.add('comment.add', 'TJ', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'gone before the ack' })
    log.add('comment.delete', 'TJ', { comment: C(1) })
    expect(run(log, { ack: 2 }).empty).toBe(true)
    expect(run(log, { ack: 0 }).threads).toEqual([])
  })

  it('edits net to the latest body: a new reply edited in the window stays new (not edited)', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Q?' })
    log.add('comment.reply', 'TJ', { thread: T(1), comment: C(2), body: 'draft' })
    log.add('comment.edit', 'TJ', { comment: C(2), body: 'final answer' })
    const m = run(log, { ack: 1 }).threads[0]!.messages[1]!
    expect(m).toMatchObject({ id: C(2), body: 'final answer', new: true })
    expect(m.edited).toBeUndefined()
  })

  it('an edit or delete of an older TJ message is flagged edited / deleted', () => {
    const log = new Log()
    log.add('comment.add', 'TJ', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'first' })
    log.add('comment.reply', 'TJ', { thread: T(1), comment: C(2), body: 'second' })
    log.add('comment.reply', 'Claude', { thread: T(1), comment: C(3), body: 'ok' })
    log.add('comment.edit', 'TJ', { comment: C(1), body: 'first, edited' })
    log.add('comment.delete', 'TJ', { comment: C(2) })
    const r = run(log, { ack: 3 })
    expect(r.threads[0]!.activity).toEqual(['edited', 'deleted'])
    expect(r.threads[0]!.messages.map((m) => [m.id, m.body, m.edited ?? false, m.deleted ?? false])).toEqual([
      [C(1), 'first, edited', true, false],
      [C(2), '', false, true],
      [C(3), 'ok', false, false],
    ])
    expect(r.counts.messages).toBe(1)
  })

  it('resolve then reopen in the window nets to nothing; a lone resolve is reported once', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Q?' })
    log.add('comment.add', 'Claude', { thread: T(2), comment: C(2), anchor: TEXT_ANCHOR, body: 'Q2?' })
    log.add('thread.resolve', 'TJ', { thread: T(1) })
    log.add('thread.reopen', 'TJ', { thread: T(1) })
    log.add('thread.resolve', 'TJ', { thread: T(2) })
    const r = run(log, { ack: 2 })
    expect(r.threads.map((t) => [t.id, t.status, t.activity])).toEqual([[T(2), 'resolved', ['resolved']]])
    expect(r.counts.resolves).toBe(1)
  })

  it('a reopen of a thread resolved before the window is reported as reopened', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Q?' })
    log.add('thread.resolve', 'Claude', { thread: T(1) })
    log.add('thread.reopen', 'TJ', { thread: T(1) })
    expect(run(log, { ack: 2 }).threads[0]!.activity).toEqual(['reopened'])
  })

  it('a reopen of a thread Claude resolved in the same batch as its ack is reported (QA3: the baseline is where Claude left it)', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Is 12% still current?' })
    const reply = log.add('comment.reply', 'TJ', { thread: T(1), comment: C(2), body: 'Yes it is.' })
    // the skill's standard loop: one batch with the resolve and the ack of the pending read that ended at `reply`
    log.add('thread.resolve', 'Claude', { thread: T(1) })
    log.add('ack', 'Claude', { upTo: reply })
    log.add('thread.reopen', 'TJ', { thread: T(1) })
    const r = run(log, { ack: reply })
    expect(r.empty).toBe(false)
    expect(r.threads.map((t) => [t.id, t.status, t.activity])).toEqual([[T(1), 'open', ['reopened']]])
    expect(r.counts.resolves).toBe(1)
  })

  it('TJ resolving a thread again after Claude reopened it is reported as resolved', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Q?' })
    const first = log.add('thread.resolve', 'TJ', { thread: T(1) })
    log.add('thread.reopen', 'Claude', { thread: T(1) })
    log.add('thread.resolve', 'TJ', { thread: T(1) })
    // acked past TJ's first resolve: Claude reopened, TJ resolved again, so Claude has news
    expect(run(log, { ack: first }).threads.map((t) => [t.id, t.status, t.activity])).toEqual([[T(1), 'resolved', ['resolved']]])
  })

  it('Claude putting a thread back right after TJ toggled it leaves nothing to report', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Q?' })
    log.add('thread.resolve', 'TJ', { thread: T(1) })
    log.add('thread.reopen', 'Claude', { thread: T(1) })
    expect(run(log, { ack: 1 }).empty).toBe(true)
  })

  it('Claude\'s own events never appear', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'mine' })
    log.add('comment.reply', 'Claude', { thread: T(1), comment: C(2), body: 'also mine' })
    log.add('thread.resolve', 'Claude', { thread: T(1) })
    const r = run(log)
    expect(r.empty).toBe(true)
  })

  it('TJ detaching a thread (deleted its text) is listed as detached', () => {
    const log = new Log()
    log.add('comment.add', 'Claude', { thread: T(1), comment: C(1), anchor: TEXT_ANCHOR, body: 'Q?' })
    log.add('thread.detach', 'TJ', { thread: T(1), cause: 'deleted' })
    const r = run(log, { ack: 1 })
    expect(r.threads[0]).toMatchObject({ activity: ['detached'], anchor: { state: 'detached', block: null, line: null } })
  })
})

const SUGG_BODY = { range: { start: 0, end: 1, rev: 1 }, base: 'Please utilize it.', proposed: 'Please use it.', hunks: [{ del: 'utilize', ins: 'use', at: 5 }] }

describe('suggestions and decisions', () => {
  it('a TJ suggestion created in the window: suggested, new, final state', () => {
    const log = new Log()
    log.add('suggestion.add', 'TJ', { thread: T(1), newThread: true, suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    const r = run(log)
    expect(r.threads[0]).toMatchObject({ kind: 'suggestion', activity: ['suggested'] })
    expect(r.threads[0]!.suggestions).toEqual([
      { id: SG(1), by: 'TJ', status: 'pending', new: true, block: 'b1', line: 1, hunks: [{ del: 'utilize', ins: 'use' }] },
    ])
    expect(r.counts).toMatchObject({ threads: 1, suggestions: 1, messages: 0 })
  })

  it('an insertion says where it goes; a table cell says which one (QA confirmed 20)', () => {
    const log = new Log()
    const base = 'We launch in Q3 with the member rate set.'
    log.add('suggestion.add', 'TJ', { thread: T(1), newThread: true, suggestion: SG(1), anchor: TEXT_ANCHOR, range: SUGG_BODY.range, base, proposed: 'We launch in Q3 2026 with the member rate set.', hunks: [{ del: '', ins: '2026 ', at: 15 }] })
    const table = '| Deal | Rate |\n|------|------|\n| ARV  | 9.0% |\n| BAR  |  |'
    log.add('suggestion.add', 'TJ', { thread: T(2), newThread: true, suggestion: SG(2), anchor: TEXT_ANCHOR, range: SUGG_BODY.range, base: table, proposed: table.replace('| BAR  |  |', '| BAR  | 5 |'), hunks: [{ del: '', ins: '5', at: 40 }] })
    const r = run(log)
    expect(r.threads[0]!.suggestions[0]!.hunks).toEqual([{ del: '', ins: '2026 ', before: 'We launch in Q3 ', after: 'with the member rate set.' }])
    const cell = r.threads[1]!.suggestions[0]!.hunks[0]!
    expect(cell).toMatchObject({ del: '', ins: '5', cell: 'row “BAR”, column “Rate”' })
    expect(cell.before).toContain('| BAR')
    expect(r.threads[0]!.suggestions[0]!.change).toBeUndefined()
  })

  it('bold, a heading, a checkbox and a split come with a change note instead of an empty hunks list (QA confirmed 20)', () => {
    const log = new Log()
    const add = (n: number, base: string, proposed: string, hunks: Array<{ del: string; ins: string; at: number }> = []): void => {
      log.add('suggestion.add', 'TJ', { thread: T(n), newThread: true, suggestion: SG(n), anchor: TEXT_ANCHOR, range: SUGG_BODY.range, base, proposed, hunks })
    }
    add(1, 'the member rate', 'the **member** rate')
    add(2, 'Second paragraph.', '## Second paragraph.')
    add(3, '- [ ] Todo one\n- [x] Todo two', '- [x] Todo one\n- [x] Todo two')
    add(4, 'Second paragraph to split here.', 'Second paragraph\n\nto split here.', [{ del: ' ', ins: '\n', at: 16 }])
    const r = run(log)
    expect(r.threads.map((t) => t.suggestions[0]!.change)).toEqual([
      { kind: 'format', detail: 'Bold: member' },
      { kind: 'structure', detail: 'Heading 2' },
      { kind: 'structure', detail: 'Checked: Todo one' },
      { kind: 'structure', detail: 'Split paragraph' },
    ])
    expect(r.threads[0]!.suggestions[0]!.hunks).toEqual([])
  })

  it('a TJ suggestion created then withdrawn in the window is omitted', () => {
    const log = new Log()
    log.add('suggestion.add', 'TJ', { thread: T(1), newThread: true, suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.update', 'TJ', { suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY, proposed: 'x' })
    log.add('suggestion.withdraw', 'TJ', { suggestion: SG(1) })
    const r = run(log)
    expect(r.threads).toEqual([])
    expect(r.counts.suggestions).toBe(0)
  })

  it('an older TJ suggestion revised in the window → revised; withdrawn → withdrawn', () => {
    const log = new Log()
    log.add('suggestion.add', 'TJ', { thread: T(1), newThread: true, suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.add', 'TJ', { thread: T(2), newThread: true, suggestion: SG(2), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.update', 'TJ', { suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY, proposed: 'Earn net returns.' })
    log.add('suggestion.withdraw', 'TJ', { suggestion: SG(2) })
    const r = run(log, { ack: 2 })
    expect(r.threads.map((t) => [t.id, t.activity, t.suggestions[0]!.status])).toEqual([
      [T(1), ['revised'], 'pending'],
      [T(2), ['withdrawn'], 'withdrawn'],
    ])
  })

  it('TJ\'s decision on a Claude suggestion is reported once with decidedBy; accept-then-reopen nets away', () => {
    const log = new Log()
    log.add('suggestion.add', 'Claude', { thread: T(1), newThread: true, suggestion: SG(1), comment: C(1), body: 'House style: plain words.', anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.add', 'Claude', { thread: T(2), newThread: true, suggestion: SG(2), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.accept', 'TJ', { suggestion: SG(1), resultRev: 2 })
    log.add('suggestion.accept', 'TJ', { suggestion: SG(2), resultRev: 3 })
    log.add('suggestion.reopen', 'TJ', { suggestion: SG(2), resultRev: 4 })
    const r = run(log, { ack: 2 })
    expect(r.threads).toHaveLength(1)
    expect(r.threads[0]).toMatchObject({ id: T(1), activity: ['accepted'], messages: [{ id: C(1), by: 'Claude', body: 'House style: plain words.' }] })
    expect(r.threads[0]!.suggestions).toEqual([
      { id: SG(1), by: 'Claude', status: 'accepted', decidedBy: 'TJ', block: 'b1', line: 1, hunks: [{ del: 'utilize', ins: 'use' }] },
    ])
    expect(r.counts).toMatchObject({ threads: 1, decisions: 1, suggestions: 0 })
  })

  it('a thread whose suggestions are all decided reads resolved, not open (TJ hands-on 2026-10-16, unverified 32)', () => {
    const log = new Log()
    log.add('suggestion.add', 'Claude', { thread: T(1), newThread: true, suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.reject', 'TJ', { suggestion: SG(1) })
    const r = run(log, { ack: 0 })
    expect(r.threads.map((t) => [t.id, t.status, t.activity])).toEqual([[T(1), 'resolved', ['rejected']]])
  })

  it('a reopen (undo) of a decision made before the window is reopened-suggestion', () => {
    const log = new Log()
    log.add('suggestion.add', 'Claude', { thread: T(1), newThread: true, suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.reject', 'TJ', { suggestion: SG(1) })
    log.add('suggestion.reopen', 'TJ', { suggestion: SG(1), resultRev: null })
    const r = run(log, { ack: 2 })
    expect(r.threads[0]!.activity).toEqual(['reopened-suggestion'])
    expect(r.threads[0]!.suggestions[0]).toMatchObject({ status: 'pending' })
  })

  it('system staling a Claude suggestion is a notice; system events on TJ\'s items are not', () => {
    const log = new Log()
    log.add('suggestion.add', 'Claude', { thread: T(1), newThread: true, suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.add', 'TJ', { thread: T(2), newThread: true, suggestion: SG(2), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('comment.add', 'Claude', { thread: T(3), comment: C(3), anchor: TEXT_ANCHOR, body: 'Q' })
    log.add('comment.add', 'TJ', { thread: T(4), comment: C(4), anchor: TEXT_ANCHOR, body: 'Q' })
    log.add('suggestion.stale', 'system', { suggestion: SG(1), reason: 'BASE_GONE' })
    log.add('suggestion.stale', 'system', { suggestion: SG(2), reason: 'BASE_GONE' })
    log.add('thread.detach', 'system', { thread: T(3), cause: 'unresolvable' })
    log.add('thread.detach', 'system', { thread: T(4), cause: 'unresolvable' })
    const r = run(log, { ack: 4 })
    expect(r.notices).toEqual([
      { type: 'suggestion.stale', suggestion: SG(1), thread: T(1), reason: 'BASE_GONE' },
      { type: 'thread.detach', thread: T(3), reason: 'unresolvable' },
    ])
    expect(r.threads).toEqual([])
    expect(r.counts.notices).toBe(2)
  })
})

describe('edits: chains netted by hash (D33)', () => {
  const H = (c: string): string => c.repeat(16)

  it('a one-link chain uses md directly', () => {
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [replace(side(0, [H('a')], 'We launch in Q3.'), side(0, [H('1')], 'We launch in Q4.'))] })
    const r = run(log, { blocks: blocksOf([H('1'), H('2')]) })
    expect(r.edits).toEqual([{
      by: 'TJ', sources: ['editor'], fromRev: 1, toRev: 2,
      blocks: [{ op: 'replace', block: 'b1', line: 1, change: { format: 'full', before: 'We launch in Q3.', after: 'We launch in Q4.' } }],
    }])
    expect(r.external).toEqual([])
    expect(r.counts.edits).toBe(1)
  })

  it('follows after.hashes → before.hashes across events: a→b→c nets to a→c, and a→b→a is dropped', () => {
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [
      replace(side(0, [H('a')], 'A0'), side(0, [H('b')], 'A1')),
      replace(side(2, [H('x')], 'X0'), side(2, [H('y')], 'X1')),
    ] })
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 3, toRev: 4, changes: [
      replace(side(0, [H('b')], 'A1'), side(0, [H('c')], 'A2')),
      replace(side(2, [H('y')], 'X1'), side(2, [H('x')], 'X0')),
    ] })
    const r = run(log, { blocks: blocksOf([H('c'), H('2'), H('x')]) })
    expect(r.edits[0]!.blocks).toEqual([{ op: 'replace', block: 'b1', line: 1, change: { format: 'full', before: 'A0', after: 'A2' } }])
    expect(r.edits[0]).toMatchObject({ fromRev: 1, toRev: 4 })
    expect(r.counts.edits).toBe(1)
  })

  it('insert-then-delete nets to nothing (both ends empty)', () => {
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [insert(side(1, [H('n')], 'New para.'))] })
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 2, toRev: 3, changes: [del(side(1, [H('n')], 'New para.'))] })
    const r = run(log)
    expect(r.edits).toEqual([])
    expect(r.counts.edits).toBe(0)
    expect(r.empty).toBe(true)
  })

  it('insert then edit → one insert with the final text; replace then delete → one delete of the original', () => {
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [
      insert(side(1, [H('n')], 'New.')),
      replace(side(2, [H('p')], 'Old text.'), side(3, [H('q')], 'Mid text.')),
    ] })
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 2, toRev: 3, changes: [
      replace(side(1, [H('n')], 'New.'), side(1, [H('m')], 'New, longer.')),
      del(side(3, [H('q')], 'Mid text.')),
    ] })
    const r = run(log, { blocks: blocksOf([H('0'), H('m')]) })
    expect(r.edits[0]!.blocks).toEqual([
      { op: 'insert', block: 'b2', line: 3, change: { format: 'full', before: null, after: 'New, longer.' } },
      { op: 'delete', block: null, line: null, change: { format: 'full', before: 'Old text.', after: null } },
    ])
  })

  it('netting never compares text: equal md with different hashes is kept, equal hashes with different md is dropped', () => {
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [replace(side(0, [H('a')], 'same'), side(0, [H('b')], 'same'))] })
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 2, toRev: 3, changes: [replace(side(2, [H('c')], 'one'), side(2, [H('d')], 'two'))] })
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 3, toRev: 4, changes: [replace(side(2, [H('d')], 'two'), side(2, [H('c')], 'three?'))] })
    const r = run(log)
    expect(r.edits[0]!.blocks).toHaveLength(1)
    expect(r.edits[0]!.blocks[0]!.change).toEqual({ format: 'full', before: 'same', after: 'same' })
  })

  it('counts changed blocks: a 1 → 2 split counts 2', () => {
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [replace(side(0, [H('a')], 'A. B.'), side(0, [H('b'), H('c')], 'A.\n\nB.'))] })
    expect(run(log).counts.edits).toBe(2)
  })

  it('windowed sides are diffed through runText at their revs; format diff past PENDING_DIFF_THRESHOLD', () => {
    const big0 = 'x'.repeat(5000) + ' alpha ' + 'y'.repeat(1000)
    const big1 = 'x'.repeat(5000) + ' beta ' + 'y'.repeat(1000)
    const win0 = big0.slice(4700, 5307)
    const win1 = big1.slice(4700, 5306)
    const calls: Array<[number, number, number]> = []
    const runText = (rev: number, start: number, end: number): string | null => {
      calls.push([rev, start, end])
      return rev === 1 ? big0.slice(start - 100, end - 100) : rev === 2 ? big1.slice(start - 100, end - 100) : null
    }
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [replace(
      side(0, [H('a')], win0, { start: 100, end: 100 + big0.length, window: { offset: 4700, total: big0.length } }),
      side(0, [H('b')], win1, { start: 100, end: 100 + big1.length, window: { offset: 4700, total: big1.length } }),
    )] })
    const r = run(log, { blocks: blocksOf([H('b')]), runText })
    expect(calls).toEqual([[1, 100, 100 + big0.length], [2, 100, 100 + big1.length]])
    const ch = r.edits[0]!.blocks[0]!.change
    expect(ch.format).toBe('diff')
    if (ch.format === 'diff') {
      expect(ch.diff).toContain('-' + big0)
      expect(ch.diff).toContain('+' + big1)
      expect(ch.partial).toBeUndefined()
    }
  })

  it('an object gone (runText null) falls back to the stored windows and marks partial', () => {
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [replace(
      side(0, [H('a')], '…window before…', { window: { offset: 4700, total: 6000 } }),
      side(0, [H('b')], '…window after…', { window: { offset: 4700, total: 6000 } }),
    )] })
    const ch = run(log, { blocks: blocksOf([H('b')]) }).edits[0]!.blocks[0]!.change
    expect(ch).toEqual({ format: 'full', before: '…window before…', after: '…window after…', partial: true })
  })

  it('TJ and external are separate lists, never merged or chained across', () => {
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [replace(side(0, [H('a')], 'A0'), side(0, [H('b')], 'A1'))] })
    log.add('doc.external', 'external', { fromRev: 2, toRev: 3, changes: [replace(side(0, [H('b')], 'A1'), side(0, [H('a')], 'A0'))] })
    log.add('doc.external', 'external', { fromRev: 3, toRev: 4, changes: null })
    const r = run(log, { blocks: blocksOf([H('a')]) })
    expect(r.edits).toHaveLength(1)
    expect(r.edits[0]!.blocks[0]!.change).toEqual({ format: 'full', before: 'A0', after: 'A1' })
    expect(r.external).toHaveLength(1)
    expect(r.external[0]).toMatchObject({ by: 'external', sources: [], fromRev: 2, toRev: 4 })
    expect(r.external[0]!.blocks).toEqual([
      { op: 'replace', block: 'b1', line: 1, change: { format: 'full', before: 'A1', after: 'A0' } },
      { op: 'replace', block: null, line: null, change: { format: 'full', before: null, after: null, partial: true } },
    ])
    expect(r.counts).toMatchObject({ edits: 1, external: 2 })
  })

  it('accept and undo-accept doc.edits are excluded; Claude\'s cli edits too; restore is a source', () => {
    const log = new Log()
    log.add('suggestion.add', 'Claude', { thread: T(1), newThread: true, suggestion: SG(1), anchor: TEXT_ANCHOR, ...SUGG_BODY })
    log.add('suggestion.accept', 'TJ', { suggestion: SG(1), resultRev: 2 })
    log.add('doc.edit', 'TJ', { source: 'accept', fromRev: 1, toRev: 2, changes: [replace(side(0, [H('a')], 'Please utilize it.'), side(0, [H('b')], 'Please use it.'))], cause: { type: 'suggestion.accept', id: SG(1) } })
    log.add('doc.edit', 'Claude', { source: 'cli', fromRev: 2, toRev: 3, changes: [replace(side(1, [H('c')], 'C0'), side(1, [H('d')], 'C1'))] })
    log.add('doc.edit', 'TJ', { source: 'undo-accept', fromRev: 3, toRev: 4, changes: [replace(side(0, [H('b')], 'x'), side(0, [H('a')], 'y'))] })
    log.add('doc.edit', 'TJ', { source: 'restore', fromRev: 4, toRev: 5, changes: [replace(side(2, [H('e')], 'E0'), side(2, [H('f')], 'E1'))], cause: { type: 'restore', id: 'v3' } })
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 5, toRev: 6, changes: [replace(side(1, [H('d')], 'C1'), side(1, [H('g')], 'C2'))] })
    const r = run(log, { ack: 1, blocks: blocksOf([H('a'), H('g'), H('f')]) })
    expect(r.edits).toHaveLength(1)
    expect(r.edits[0]!.sources).toEqual(['editor', 'restore'])
    expect(r.edits[0]!.blocks.map((b) => b.change)).toEqual([
      { format: 'full', before: 'C1', after: 'C2' },
      { format: 'full', before: 'E0', after: 'E1' },
    ])
    // the accept appears exactly once: as the decision on its thread
    expect(r.threads.map((t) => t.activity)).toEqual([['accepted']])
    expect(r.counts).toMatchObject({ decisions: 1, edits: 2 })
  })

  it('a long single-link replace is a diff when before + after exceed the threshold', () => {
    const a = 'p'.repeat(700)
    const b = 'q'.repeat(700)
    const log = new Log()
    log.add('doc.edit', 'TJ', { source: 'editor', fromRev: 1, toRev: 2, changes: [replace(side(0, [H('a')], a), side(0, [H('b')], b))] })
    const ch = run(log, { blocks: blocksOf([H('b')]) }).edits[0]!.blocks[0]!.change
    expect(ch.format).toBe('diff')
    expect(CONSTANTS.PENDING_DIFF_THRESHOLD).toBe(1200)
  })
})
