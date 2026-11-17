// tests/unit/core/sidecar/fold.test.ts (P1). The §4.5 fold table row by row, the suggestion state machine as the fold
// applies it, WAL voiding (§4.6), policy and round (§9.10), derived values, and incremental-equals-full.
import { describe, expect, it } from 'vitest'
import {
  emptyFold, fold, handoffRecords, needsFullRefold, toReviewState, unconsumedHandoffSeqs, type FoldState,
} from '../../../../core/sidecar/fold'
import { roundSeqOf } from '../../../../core/sidecar/keys'
import type {
  Actor, Anchor, CommentId, Hash, SidecarEvent, SuggestionId, TextAnchor, ThreadId,
} from '../../../../shared/types'

const AT = '2026-10-15T17:00:00.000Z'
const H = (n: number): Hash => n.toString(16).padStart(64, '0')
const T1 = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3A1' as ThreadId
const T2 = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3A2' as ThreadId
const C1 = 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3B1' as CommentId
const C2 = 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3B2' as CommentId
const C3 = 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3B3' as CommentId
const C4 = 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3B4' as CommentId
const S1 = 's_01JAB3K9Q2T7V5X8Y0Z1W2E3C1' as SuggestionId
const anchor = (quote = 'q', rev = 1): TextAnchor => ({
  kind: 'text', quote, prefix: '', suffix: '', hint: { rev, pos: 0, block: 0, blockHash: '9f2c0d1e7a6b5c44', offsetInBlock: 0 },
})
const body = { range: { start: 0, end: 1, rev: 1 }, base: 'utilize', proposed: 'use', hunks: [{ del: 'utilize', ins: 'use', at: 0 }] }

/** A log builder: seqs and ids assigned in order; `rev` is the current doc rev unless a line overrides it. */
function log() {
  const lines: SidecarEvent[] = []
  let seq = 0
  let rev = 0
  const push = (e: Record<string, unknown>): SidecarEvent => {
    seq += 1
    const id = `e_01JAB3K9Q2T7V5X8Y0Z${String(seq).padStart(7, '0')}`
    const line = { seq, id, at: AT, rev, ...e } as unknown as SidecarEvent
    lines.push(line)
    return line
  }
  const b = {
    lines,
    push,
    rev(by: Actor, cause: string, o: { wal?: boolean; key?: string; hash?: Hash } = {}) {
      const prevRev = rev || null
      rev += 1
      const hash = o.hash ?? H(rev)
      return push({
        type: 'doc.rev', by, rev, prevRev, prevHash: prevRev === null ? null : H(prevRev), hash, bytes: 10, cause,
        ...(o.wal ? { wal: { rev, hash } } : {}), ...(o.key ? { key: o.key } : {}),
      })
    },
    /** Lines inside the WAL batch of the current rev. */
    wal(e: Record<string, unknown>) {
      return push({ ...e, wal: { rev, hash: H(rev) } })
    },
    get curRev() {
      return rev
    },
    set curRev(v: number) {
      rev = v
    },
  }
  return b
}

const review = (f: FoldState) => toReviewState(f, (a: Anchor) => (a.kind === 'doc' ? { state: 'doc' } : { state: 'exact' }), { file: 'x.md' })

describe('fold: doc lines and the TJ session (§4.5, §7.1)', () => {
  it('doc.rev sets rev/hash and pushes docLog; a TJ save opens the session, more saves extend it, another actor closes it', () => {
    const L = log()
    L.rev('system', 'baseline')
    L.rev('TJ', 'save')
    let f = fold(L.lines)
    expect(f).toMatchObject({ rev: 2, hash: H(2), tjSession: { baseRev: 1, baseHash: H(1), lastRev: 2 } })
    L.rev('TJ', 'merge')
    L.rev('TJ', 'recreate')
    f = fold(L.lines)
    expect(f.tjSession).toMatchObject({ baseRev: 1, lastRev: 4 })
    L.rev('Claude', 'cli')
    f = fold(L.lines)
    expect(f.tjSession).toBeNull()
    expect(f.docLog.map((d) => [d.rev, d.by, d.cause])).toEqual([[1, 'system', 'baseline'], [2, 'TJ', 'save'], [3, 'TJ', 'merge'], [4, 'TJ', 'recreate'], [5, 'Claude', 'cli']])
  })

  it('a TJ accept / undo-accept / restore doc.rev closes the session; a TJ editor doc.edit closes it too', () => {
    for (const cause of ['accept', 'undo-accept', 'restore']) {
      const L = log()
      L.rev('system', 'baseline')
      L.rev('TJ', 'save')
      L.rev('TJ', cause)
      expect(fold(L.lines).tjSession, cause).toBeNull()
    }
    const L = log()
    L.rev('system', 'baseline')
    L.rev('TJ', 'save')
    L.push({ type: 'doc.edit', by: 'TJ', source: 'editor', fromRev: 1, toRev: 2, changes: [] })
    const f = fold(L.lines)
    expect(f.tjSession).toBeNull()
    expect(f.docLog.at(-1)).toMatchObject({ type: 'doc.edit', rev: 2, by: 'TJ' })
  })

  it('doc.external goes to the docLog', () => {
    const L = log()
    L.rev('system', 'baseline')
    L.rev('external', 'external')
    L.push({ type: 'doc.external', by: 'external', fromRev: 1, toRev: 2, changes: null })
    expect(fold(L.lines).docLog.at(-1)).toMatchObject({ type: 'doc.external', rev: 2, by: 'external' })
  })
})

describe('fold: WAL voiding (§4.6)', () => {
  function crashed() {
    const L = log()
    L.rev('system', 'baseline')
    L.rev('Claude', 'cli', { wal: true, key: 'cli:abc' })
    L.wal({ type: 'comment.add', by: 'Claude', key: 'cli:abc', thread: T1, comment: C1, anchor: anchor(), body: 'voided' })
    return L
  }
  it('a doc.abort voids every line of its batch: skipped, keys freed, rev/hash back to the previous doc.rev', () => {
    const L = crashed()
    L.curRev = 1
    L.push({ type: 'doc.abort', by: 'system', abortedRev: 2, reason: 'not-landed' })
    L.push({ type: 'server.recovered', by: 'system', what: 'wal', detail: 'rev 2' })
    const f = fold(L.lines)
    expect(f.voidRevs.has(2)).toBe(true)
    expect(f).toMatchObject({ rev: 1, hash: H(1), seq: 5 })
    expect(f.threads.size).toBe(0)
    expect(f.keys.has('cli:abc')).toBe(false)
    expect(f.docLog.map((d) => d.rev)).toEqual([1])
  })

  it('needsFullRefold flags an abort for a batch an earlier incremental call already folded; refolding gives the voided state', () => {
    const L = crashed()
    const before = fold(L.lines)
    expect(before.threads.size).toBe(1)
    L.curRev = 1
    const abort = L.push({ type: 'doc.abort', by: 'system', abortedRev: 2, reason: 'not-landed' })
    expect(needsFullRefold(before, [abort])).toBe(true)
    expect(needsFullRefold(undefined, [abort])).toBe(false)
    expect(needsFullRefold(fold(L.lines), [])).toBe(false)
    const full = fold(L.lines)
    expect(full.threads.size).toBe(0)
    // even the incremental call restores rev and hash (what it can't do is drop the folded thread and key)
    const inc = fold([abort], before)
    expect(inc).toMatchObject({ rev: 1, hash: H(1) })
  })
})

describe('fold: comments and threads', () => {
  it('comment.add creates a thread (doc anchor → kind doc) with its root message; a duplicate id is a warning', () => {
    const L = log()
    L.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: { kind: 'doc' }, body: 'whole doc' })
    L.push({ type: 'comment.add', by: 'Claude', thread: T1, comment: C2, anchor: anchor(), body: 'dup' })
    const f = fold(L.lines)
    expect(f.threads.get(T1)).toMatchObject({ kind: 'doc', status: 'open', createdBy: 'TJ', root: C1, createdSeq: 1, lastSeq: 1 })
    expect(f.threads.get(T1)!.messages).toHaveLength(1)
    expect(f.warnings.map((w) => w.code)).toEqual(['SIDECAR_INVALID_EVENT'])
  })

  it('reply appends and bumps lastSeq; edit sets body + editedAt; delete hides the body', () => {
    const L = log()
    L.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: anchor(), body: 'root' })
    L.push({ type: 'comment.reply', by: 'Claude', thread: T1, comment: C2, body: 'reply' })
    L.push({ type: 'comment.edit', by: 'Claude', comment: C2, body: 'edited' })
    L.push({ type: 'comment.reply', by: 'TJ', thread: T1, comment: C3, body: 'gone soon' })
    L.push({ type: 'comment.delete', by: 'TJ', comment: C3 })
    const t = fold(L.lines).threads.get(T1)!
    expect(t.lastSeq).toBe(5)
    expect(t.messages.map((m) => [m.id, m.body, !!m.deleted])).toEqual([[C1, 'root', false], [C2, 'edited', false], [C3, '', true]])
    expect(t.messages[1]!.editedAt).toBe(AT)
  })

  it('deleting the root with no live replies and no suggestions removes the thread; with a live reply it stays until that goes too', () => {
    const L = log()
    L.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: anchor(), body: 'root' })
    L.push({ type: 'comment.delete', by: 'TJ', comment: C1 })
    expect(fold(L.lines).threads.has(T1)).toBe(false)

    const M = log()
    M.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: anchor(), body: 'root' })
    M.push({ type: 'comment.reply', by: 'Claude', thread: T1, comment: C2, body: 'reply' })
    M.push({ type: 'comment.delete', by: 'TJ', comment: C1 })
    expect(fold(M.lines).threads.has(T1)).toBe(true)
    M.push({ type: 'comment.delete', by: 'Claude', comment: C2 })
    expect(fold(M.lines).threads.has(T1)).toBe(false)
  })

  it('resolve / reopen set status; detach / reattach flip detached, reattach sets anchor and lastAnchor', () => {
    const L = log()
    L.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: anchor('old'), body: 'root' })
    L.push({ type: 'thread.resolve', by: 'Claude', thread: T1 })
    expect(fold(L.lines).threads.get(T1)!.status).toBe('resolved')
    L.push({ type: 'thread.reopen', by: 'TJ', thread: T1 })
    L.push({ type: 'thread.detach', by: 'system', thread: T1, cause: 'unresolvable' })
    let t = fold(L.lines).threads.get(T1)!
    expect(t).toMatchObject({ status: 'open', detached: true })
    expect((t.lastAnchor as TextAnchor).quote).toBe('old')
    L.push({ type: 'thread.reattach', by: 'system', thread: T1, anchor: anchor('new') })
    t = fold(L.lines).threads.get(T1)!
    expect(t.detached).toBe(false)
    expect((t.anchor as TextAnchor).quote).toBe('new')
    expect((t.lastAnchor as TextAnchor).quote).toBe('new')
  })

  it('anchor.update applies iff ev.rev >= the anchor rev; ties go to the later seq; an older rev is ignored', () => {
    const L = log()
    L.curRev = 5
    L.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: anchor('a', 5), body: 'root' })
    L.curRev = 5
    L.push({ type: 'anchor.update', by: 'TJ', thread: T1, anchor: anchor('tie', 5) })
    L.curRev = 4
    L.push({ type: 'anchor.update', by: 'system', thread: T1, anchor: anchor('older', 4) })
    L.curRev = 7
    L.push({ type: 'anchor.update', by: 'system', thread: T1, anchor: anchor('newer', 7) })
    const quotes: string[] = []
    let f = emptyFold()
    for (const line of L.lines) {
      f = fold([line], f)
      quotes.push((f.threads.get(T1)!.anchor as TextAnchor).quote)
    }
    expect(quotes).toEqual(['a', 'tie', 'tie', 'newer'])
  })
})

describe('fold: suggestions and the state machine (§4.5)', () => {
  function withSuggestion(by: 'TJ' | 'Claude' = 'Claude') {
    const L = log()
    L.curRev = 1
    L.push({ type: 'suggestion.add', by, thread: T2, newThread: true, suggestion: S1, comment: C2, body: 'reason', anchor: anchor(), ...body })
    return L
  }

  it('suggestion.add newThread creates a suggestion thread with the reason as root; attaching to an existing thread reopens it', () => {
    let f = fold(withSuggestion().lines)
    expect(f.threads.get(T2)).toMatchObject({ kind: 'suggestion', root: C2, suggestions: [S1] })
    expect(f.suggestions.get(S1)).toMatchObject({ status: 'pending', by: 'Claude', thread: T2 })

    const L = log()
    L.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: anchor(), body: 'root' })
    L.push({ type: 'thread.resolve', by: 'TJ', thread: T1 })
    L.push({ type: 'suggestion.add', by: 'Claude', thread: T1, newThread: false, suggestion: S1, anchor: anchor(), ...body })
    f = fold(L.lines)
    expect(f.threads.get(T1)).toMatchObject({ status: 'open', suggestions: [S1] })
  })

  it('update / rebase replace the body; rebase brings a stale suggestion back to pending', () => {
    const L = withSuggestion('TJ')
    L.push({ type: 'suggestion.update', by: 'TJ', suggestion: S1, anchor: anchor('u'), ...body, proposed: 'v2' })
    expect(fold(L.lines).suggestions.get(S1)!.proposed).toBe('v2')
    L.push({ type: 'suggestion.stale', by: 'system', suggestion: S1, reason: 'BASE_GONE' })
    expect(fold(L.lines).suggestions.get(S1)).toMatchObject({ status: 'stale', staleReason: 'BASE_GONE' })
    L.push({ type: 'suggestion.rebase', by: 'system', suggestion: S1, anchor: anchor('r'), ...body, proposed: 'v3' })
    const s = fold(L.lines).suggestions.get(S1)!
    expect(s).toMatchObject({ status: 'pending', proposed: 'v3' })
    expect(s.staleReason).toBeUndefined()
  })

  it('accept / reject record decidedBy and decidedSeq; reopen goes back to pending; withdraw is terminal', () => {
    const L = withSuggestion()
    L.push({ type: 'suggestion.accept', by: 'TJ', suggestion: S1, resultRev: 2 })
    expect(fold(L.lines).suggestions.get(S1)).toMatchObject({ status: 'accepted', decidedBy: 'TJ', decidedSeq: 2 })
    L.push({ type: 'suggestion.reopen', by: 'TJ', suggestion: S1, resultRev: 3 })
    let s = fold(L.lines).suggestions.get(S1)!
    expect(s.status).toBe('pending')
    expect(s.decidedBy).toBeUndefined()
    L.push({ type: 'suggestion.reject', by: 'TJ', suggestion: S1 })
    expect(fold(L.lines).suggestions.get(S1)!.status).toBe('rejected')
    L.push({ type: 'suggestion.reopen', by: 'TJ', suggestion: S1, resultRev: null })
    L.push({ type: 'suggestion.withdraw', by: 'Claude', suggestion: S1 })
    s = fold(L.lines).suggestions.get(S1)!
    expect(s.status).toBe('withdrawn')
  })

  it('stale → reject (TJ) and stale → withdraw (author) are legal', () => {
    const L = withSuggestion()
    L.push({ type: 'suggestion.stale', by: 'system', suggestion: S1, reason: 'AMBIGUOUS' })
    L.push({ type: 'suggestion.reject', by: 'TJ', suggestion: S1 })
    expect(fold(L.lines).suggestions.get(S1)!.status).toBe('rejected')
    const M = withSuggestion()
    M.push({ type: 'suggestion.stale', by: 'system', suggestion: S1, reason: 'OVERLAP' })
    M.push({ type: 'suggestion.withdraw', by: 'Claude', suggestion: S1 })
    expect(fold(M.lines).suggestions.get(S1)!.status).toBe('withdrawn')
  })

  it('illegal edges from a hand edit are skipped with a warning; repeats are silent no-ops', () => {
    const cases: Array<[string, Record<string, unknown>[], string]> = [
      ['Claude accepts its own suggestion', [{ type: 'suggestion.accept', by: 'Claude', suggestion: S1, resultRev: 2 }], 'pending'],
      ['accept after withdraw', [{ type: 'suggestion.withdraw', by: 'Claude', suggestion: S1 }, { type: 'suggestion.accept', by: 'TJ', suggestion: S1, resultRev: 2 }], 'withdrawn'],
      ['accept a stale suggestion', [{ type: 'suggestion.stale', by: 'system', suggestion: S1, reason: 'BASE_GONE' }, { type: 'suggestion.accept', by: 'TJ', suggestion: S1, resultRev: 2 }], 'stale'],
      ['TJ withdraws Claude\'s suggestion', [{ type: 'suggestion.withdraw', by: 'TJ', suggestion: S1 }], 'pending'],
      ['reopen a pending suggestion', [{ type: 'suggestion.reopen', by: 'TJ', suggestion: S1, resultRev: null }], 'pending'],
    ]
    for (const [name, extra, status] of cases) {
      const L = withSuggestion()
      for (const e of extra) L.push(e)
      const f = fold(L.lines)
      expect(f.suggestions.get(S1)!.status, name).toBe(status)
    }
    const W = withSuggestion()
    W.push({ type: 'suggestion.accept', by: 'Claude', suggestion: S1, resultRev: 2 })
    expect(fold(W.lines).warnings.map((w) => w.code)).toEqual(['SIDECAR_INVALID_EVENT'])
    const D = withSuggestion()
    D.push({ type: 'suggestion.accept', by: 'TJ', suggestion: S1, resultRev: 2 })
    D.push({ type: 'suggestion.accept', by: 'TJ', suggestion: S1, resultRev: 2 })
    const fd = fold(D.lines)
    expect(fd.warnings).toEqual([])
    expect(fd.suggestions.get(S1)!.decidedSeq).toBe(2)
  })

  it('a decision on an unknown suggestion is a warning', () => {
    const L = log()
    L.push({ type: 'suggestion.reject', by: 'TJ', suggestion: S1 })
    expect(fold(L.lines).warnings).toHaveLength(1)
  })
})

describe('fold: cursors, handoffs, policy, keys', () => {
  it('ack: claudeAck = max, lastAckWaiter follows the latest ack; every handoff ≤ upTo counts as consumed', () => {
    const L = log()
    L.push({ type: 'handoff.sent', by: 'TJ', message: 'one', delivery: 'waiter' })
    L.push({ type: 'handoff.sent', by: 'TJ', message: null, delivery: 'clipboard' })
    L.push({ type: 'ack', by: 'Claude', upTo: 1, waiter: 'w_abc' })
    let f = fold(L.lines)
    expect(f.cursors).toMatchObject({ claudeAck: 1, lastAckWaiter: 'w_abc' })
    expect(unconsumedHandoffSeqs(f)).toEqual([2])
    L.push({ type: 'ack', by: 'Claude', upTo: 0 })
    f = fold(L.lines)
    expect(f.cursors.claudeAck).toBe(1)
    expect(f.cursors.lastAckWaiter).toBeUndefined()
  })

  it('read-marker: null → tjRead, a thread → tjReadByThread, both monotone', () => {
    const L = log()
    L.push({ type: 'read-marker', by: 'TJ', thread: null, upTo: 5 })
    L.push({ type: 'read-marker', by: 'TJ', thread: null, upTo: 3 })
    L.push({ type: 'read-marker', by: 'TJ', thread: T1, upTo: 9 })
    L.push({ type: 'read-marker', by: 'TJ', thread: T1, upTo: 2 })
    expect(fold(L.lines).cursors).toMatchObject({ tjRead: 5, tjReadByThread: { [T1]: 9 } })
  })

  it('handoff.sent counts rounds over every non-void line, consumed or not; handoff.consumed marks seqs; roundSeqOf names the latest', () => {
    const L = log()
    L.push({ type: 'handoff.sent', by: 'TJ', message: 'a', delivery: 'waiter' })
    L.push({ type: 'handoff.consumed', by: 'Claude', handoffs: [1], via: 'waiter', waiter: 'w_x' })
    L.push({ type: 'handoff.sent', by: 'TJ', message: 'b', delivery: 'latched' })
    const f = fold(L.lines)
    expect(f.handoffRound).toBe(2)
    expect(handoffRecords(f)).toEqual([
      { seq: 1, at: AT, message: 'a', delivery: 'waiter', round: 1, consumed: true },
      { seq: 3, at: AT, message: 'b', delivery: 'latched', round: 2, consumed: false },
    ])
    expect(handoffRecords(f, { unconsumed: true }).map((h) => h.seq)).toEqual([3])
    expect(roundSeqOf(f)).toBe(3)
    expect(roundSeqOf(emptyFold())).toBe(0)
  })

  it('a voided handoff.sent does not count toward the round', () => {
    const L = log()
    L.rev('system', 'baseline')
    L.rev('TJ', 'save', { wal: true })
    L.wal({ type: 'handoff.sent', by: 'TJ', message: 'void', delivery: 'waiter' })
    L.curRev = 1
    L.push({ type: 'doc.abort', by: 'system', abortedRev: 2, reason: 'not-landed' })
    L.push({ type: 'handoff.sent', by: 'TJ', message: 'real', delivery: 'waiter' })
    const f = fold(L.lines)
    expect(handoffRecords(f).map((h) => [h.message, h.round])).toEqual([['real', 1]])
  })

  it('policy.set flips suggestOnly (initially false)', () => {
    const L = log()
    expect(fold(L.lines).policy).toEqual({ suggestOnly: false })
    L.push({ type: 'policy.set', by: 'Claude', suggestOnly: true })
    expect(fold(L.lines).policy).toEqual({ suggestOnly: true })
    L.push({ type: 'policy.set', by: 'TJ', suggestOnly: false })
    expect(fold(L.lines).policy).toEqual({ suggestOnly: false })
  })

  it('keys collect the seqs of every non-void line carrying them', () => {
    const L = log()
    L.rev('system', 'baseline')
    L.rev('TJ', 'save', { key: 'save:k_1:1' })
    L.push({ type: 'anchor.update', by: 'TJ', key: 'save:k_1:1', thread: T1, anchor: anchor() })
    L.push({ type: 'comment.add', by: 'TJ', key: 'tj:op_1', thread: T1, comment: C1, anchor: anchor(), body: 'x' })
    const f = fold(L.lines)
    expect(f.keys.get('save:k_1:1')).toEqual([2, 3])
    expect(f.keys.get('tj:op_1')).toEqual([4])
  })
})

describe('toReviewState: derived values', () => {
  it('autoResolved: a suggestion thread with every suggestion terminal and no replies', () => {
    const L = log()
    L.push({ type: 'suggestion.add', by: 'Claude', thread: T2, newThread: true, suggestion: S1, anchor: anchor(), ...body })
    expect(review(fold(L.lines)).threads[0]!.autoResolved).toBe(false)
    L.push({ type: 'suggestion.reject', by: 'TJ', suggestion: S1 })
    expect(review(fold(L.lines)).threads[0]!.autoResolved).toBe(true)
    L.push({ type: 'comment.reply', by: 'TJ', thread: T2, comment: C3, body: 'but why' })
    expect(review(fold(L.lines)).threads[0]!.autoResolved).toBe(false)
  })

  it('autoResolved: replies made before the last decision don\'t keep the thread open; one after it does (QA1)', () => {
    const L = log()
    L.push({ type: 'suggestion.add', by: 'Claude', thread: T2, newThread: true, suggestion: S1, anchor: anchor(), ...body })
    L.push({ type: 'comment.reply', by: 'TJ', thread: T2, comment: C3, body: 'why weekly?' })
    expect(review(fold(L.lines)).threads[0]!.autoResolved).toBe(false)
    L.push({ type: 'suggestion.accept', by: 'TJ', suggestion: S1, resultRev: 1 })
    expect(review(fold(L.lines)).threads[0]!.autoResolved).toBe(true)
    L.push({ type: 'comment.reply', by: 'Claude', thread: T2, comment: C4, body: 'because the plan changed' })
    expect(review(fold(L.lines)).threads[0]!.autoResolved).toBe(false)
  })

  it('unread counts Claude messages and suggestions above max(tjRead, tjReadByThread[t])', () => {
    const L = log()
    L.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: anchor(), body: 'root' })
    L.push({ type: 'comment.reply', by: 'Claude', thread: T1, comment: C2, body: 'one' })
    L.push({ type: 'suggestion.add', by: 'Claude', thread: T1, newThread: false, suggestion: S1, anchor: anchor(), ...body })
    expect(review(fold(L.lines)).threads[0]!.unread).toBe(2)
    L.push({ type: 'read-marker', by: 'TJ', thread: T1, upTo: 2 })
    expect(review(fold(L.lines)).threads[0]!.unread).toBe(1)
    L.push({ type: 'read-marker', by: 'TJ', thread: null, upTo: 3 })
    expect(review(fold(L.lines)).threads[0]!.unread).toBe(0)
  })

  it('unread counts a Claude suggestion with its reason once (QA1: unverified 20, 30)', () => {
    const L = log()
    L.push({ type: 'suggestion.add', by: 'Claude', thread: T2, newThread: true, suggestion: S1, comment: C3, anchor: anchor(), ...body, body: 'Because.' } as never)
    expect(review(fold(L.lines)).threads[0]!.unread).toBe(1)
    L.push({ type: 'comment.reply', by: 'Claude', thread: T2, comment: C4, body: 'And another thing.' })
    expect(review(fold(L.lines)).threads[0]!.unread).toBe(2)
  })

  it('a detached thread resolves detached without asking the resolver; doc anchors resolve doc', () => {
    const L = log()
    L.push({ type: 'comment.add', by: 'TJ', thread: T1, comment: C1, anchor: anchor(), body: 'x' })
    L.push({ type: 'thread.detach', by: 'TJ', thread: T1, cause: 'deleted' })
    L.push({ type: 'comment.add', by: 'TJ', thread: T2, comment: C2, anchor: { kind: 'doc' }, body: 'y' })
    const r = review(fold(L.lines))
    expect(r.threads.map((t) => t.resolution.state)).toEqual(['detached', 'doc'])
    expect(r.undeliveredHandoffs).toEqual([])
  })
})

describe('fold: determinism and incrementality', () => {
  function bigLog() {
    const L = log()
    L.rev('system', 'baseline')
    L.push({ type: 'comment.add', by: 'TJ', key: 'tj:op_a', thread: T1, comment: C1, anchor: anchor(), body: 'root' })
    L.rev('TJ', 'save', { key: 'save:k_1:1' })
    L.push({ type: 'comment.reply', by: 'Claude', thread: T1, comment: C2, body: 'r' })
    L.push({ type: 'suggestion.add', by: 'Claude', thread: T2, newThread: true, suggestion: S1, comment: C3, body: 'why', anchor: anchor(), ...body })
    L.push({ type: 'handoff.sent', by: 'TJ', message: 'go', delivery: 'waiter' })
    L.rev('TJ', 'save', { key: 'save:k_1:2' })
    L.push({ type: 'doc.edit', by: 'TJ', source: 'editor', fromRev: 1, toRev: 3, changes: [] })
    L.push({ type: 'suggestion.accept', by: 'TJ', suggestion: S1, resultRev: 4 })
    L.push({ type: 'ack', by: 'Claude', upTo: 6 })
    L.push({ type: 'policy.set', by: 'Claude', suggestOnly: true })
    L.push({ type: 'read-marker', by: 'TJ', thread: null, upTo: 4 })
    return L.lines
  }

  it('fold(b, fold(a)) equals fold(a ++ b) at every split point, and never mutates init', () => {
    const lines = bigLog()
    const full = fold(lines)
    for (let k = 0; k <= lines.length; k++) {
      const a = fold(lines.slice(0, k))
      const snapshot = structuredClone(a)
      const inc = fold(lines.slice(k), a)
      expect(inc, `split ${k}`).toEqual(full)
      expect(a).toEqual(snapshot)
    }
  })

  it('is deterministic', () => {
    expect(fold(bigLog())).toEqual(fold(bigLog()))
  })
})
