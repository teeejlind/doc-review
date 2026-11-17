// tests/unit/web/threads/model.test.ts (P3; CONTRACTS §6.3, §6.8, §11.4, §12.9, §13 rows 26, 37, 84).
//
// Where each thread shows (positioned, doc, Detached, unplaced), the show-resolved rule (a resolved thread with a
// live suggestion stays), the unread total, pending-from-Claude, and next/prev order.
import { describe, expect, it } from 'vitest'
import type { Suggestion, SuggestionId, SuggestionSummary, Thread } from '../../../../shared/types'
import { buildRailModel, isResolved, navTarget, pendingIdsOf, readingOrder, threadVisible } from '../../../../web/src/threads/model'
import { thread } from '../shell/helpers'

const sid = (n: number): SuggestionId => `s_${String(n).padStart(26, '0')}`

function suggestion(n: number, t: Thread, o: Partial<Suggestion> = {}): Suggestion {
  return {
    id: sid(n), thread: t.id, by: 'Claude', status: 'pending', anchor: t.anchor.kind === 'text' ? t.anchor : (thread(99, { block: 0 }).anchor as never),
    createdSeq: n, updatedSeq: n, range: { start: 1, end: 2, rev: 0 }, base: 'old', proposed: 'new', hunks: [{ del: 'old', ins: 'new', at: 0 }],
    located: { start: 1, end: 2 }, ...o,
  }
}

const summary = (s: Suggestion, o: Partial<SuggestionSummary> = {}): SuggestionSummary => ({
  id: s.id, by: s.by, kind: 'replace', deletedText: 'old', insertedText: 'new', hunkCount: 1, placed: true, ...o,
})

describe('buildRailModel', () => {
  it('sorts threads into positioned, doc, Detached and unplaced; counts unread and pending Claude suggestions', () => {
    const open = { ...thread(1, { block: 1 }), unread: 2 }
    const doc = { ...thread(2, { block: 0 }), anchor: { kind: 'doc' as const }, unread: 1 }
    const detached = thread(3, { block: 3, detached: true })
    const sugT = { ...thread(4, { block: 4 }), kind: 'suggestion' as const }
    const s4 = suggestion(4, sugT)
    sugT.suggestions = [s4.id]
    const lost = { ...thread(5, { block: 5 }), kind: 'suggestion' as const }
    const s5 = suggestion(5, lost)
    lost.suggestions = [s5.id]
    const schema = { ...thread(6, { block: 6 }), kind: 'suggestion' as const }
    const s6 = suggestion(6, schema, { by: 'TJ' })
    schema.suggestions = [s6.id]
    const summaries = new Map([
      [s4.id, summary(s4)],
      [s5.id, summary(s5, { placed: false, unplaced: 'BASE_NOT_FOUND' })],
      [s6.id, summary(s6, { placed: false, unplaced: 'SCHEMA' })],
    ])
    const m = buildRailModel({ threads: [open, doc, detached, sugT, lost, schema], suggestions: [s4, s5, s6] }, summaries, false)
    expect(m.positioned.map((t) => t.id)).toEqual([open.id, sugT.id, schema.id]) // SCHEMA stays anchored ("Shown as a diff")
    expect(m.docThreads.map((t) => t.id)).toEqual([doc.id])
    expect(m.detached.map((t) => t.id)).toEqual([detached.id])
    expect(m.unplaced.map((t) => t.id)).toEqual([lost.id]) // BASE_NOT_FOUND goes to the header
    expect(m.unreadTotal).toBe(3)
    expect(m.pendingClaude).toEqual([s4.id, s5.id]) // TJ's own suggestion isn't "from Claude"
  })

  it('a comment thread with an unplaced suggestion keeps its card (its highlight still anchors it)', () => {
    const t = thread(1, { block: 1 })
    const s = suggestion(1, t)
    t.suggestions = [s.id]
    const m = buildRailModel({ threads: [t], suggestions: [s] }, new Map([[s.id, summary(s, { placed: false, unplaced: 'ID_COLLISION' })]]), false)
    expect(m.positioned).toHaveLength(1)
    expect(m.unplaced).toHaveLength(0)
  })

  it('show-resolved: resolved and auto-resolved threads hide unless the toggle is on or a suggestion is still live (§6.8, row 84)', () => {
    const resolved = thread(1, { block: 1, status: 'resolved' })
    const auto = { ...thread(2, { block: 2 }), autoResolved: true }
    const withPending = thread(3, { block: 3, status: 'resolved' })
    const sp = suggestion(3, withPending)
    withPending.suggestions = [sp.id]
    const withStale = thread(4, { block: 4, status: 'resolved' })
    const ss = suggestion(4, withStale, { status: 'stale', staleReason: 'BASE_GONE' })
    withStale.suggestions = [ss.id]
    const allDecided = thread(5, { block: 5, status: 'resolved' })
    const sd = suggestion(5, allDecided, { status: 'accepted' })
    allDecided.suggestions = [sd.id]
    const review = { threads: [resolved, auto, withPending, withStale, allDecided], suggestions: [sp, ss, sd] }
    expect(buildRailModel(review, new Map(), false).positioned.map((t) => t.id)).toEqual([withPending.id, withStale.id])
    expect(buildRailModel(review, new Map(), true).positioned).toHaveLength(5)
    const byId = new Map([sp, ss, sd].map((s) => [s.id, s] as const))
    expect(threadVisible(allDecided, byId, false)).toBe(false)
    expect(isResolved(auto)).toBe(true)
  })

  it('resolved doc and Detached threads follow the same rule', () => {
    const doc = { ...thread(1, { block: 0, status: 'resolved' }), anchor: { kind: 'doc' as const } }
    const det = thread(2, { block: 2, detached: true, status: 'resolved' })
    expect(buildRailModel({ threads: [doc, det], suggestions: [] }, new Map(), false)).toMatchObject({ docThreads: [], detached: [] })
    const shown = buildRailModel({ threads: [doc, det], suggestions: [] }, new Map(), true)
    expect([shown.docThreads.length, shown.detached.length]).toEqual([1, 1])
  })

  it('a read-only NOT_UTF8 / TOO_LARGE fold (every text anchor detached) lists every thread in Detached (row 26)', () => {
    const threads = [1, 2, 3].map((n) => thread(n, { block: n, detached: true }))
    const m = buildRailModel({ threads, suggestions: [] }, new Map(), false)
    expect(m.detached).toHaveLength(3)
    expect(m.positioned).toHaveLength(0)
  })

  it('pendingIdsOf lists only pending suggestions, in thread order', () => {
    const t = thread(1, { block: 1 })
    const a = suggestion(1, t)
    const b = suggestion(2, t, { status: 'stale' })
    const c = suggestion(3, t)
    t.suggestions = [c.id, a.id, b.id]
    expect(pendingIdsOf(t, new Map([a, b, c].map((s) => [s.id, s] as const)))).toEqual([c.id, a.id])
  })
})

describe('next / previous (§11.4)', () => {
  const anchors = new Map([
    ['a', 100],
    ['b', 400],
    ['c', 900],
  ])
  const order = ['a', 'b', 'c']

  it('steps from the active thread, wrapping at both ends', () => {
    expect(navTarget(order, 'a', 1, anchors, { top: 0, bottom: 800 })).toBe('b')
    expect(navTarget(order, 'c', 1, anchors, { top: 0, bottom: 800 })).toBe('a')
    expect(navTarget(order, 'a', -1, anchors, { top: 0, bottom: 800 })).toBe('c')
  })

  it('without an active thread: next = first anchor at or below the viewport top, prev = last above its bottom', () => {
    expect(navTarget(order, null, 1, anchors, { top: 300, bottom: 1100 })).toBe('b')
    expect(navTarget(order, null, -1, anchors, { top: 300, bottom: 800 })).toBe('b')
    expect(navTarget(order, null, 1, anchors, { top: 2000, bottom: 2800 })).toBe('a')
    expect(navTarget([], null, 1, anchors, { top: 0, bottom: 800 })).toBeNull()
  })

  it('readingOrder sorts by anchor y, then order, and drops threads without a rect', () => {
    const ids = ['t_c', 't_a', 't_b', 't_x'] as const
    const ys = new Map([
      ['t_a', 10],
      ['t_b', 10],
      ['t_c', 5],
    ])
    expect(readingOrder([...ids], ys, new Map([['t_a', 2], ['t_b', 1]]))).toEqual(['t_c', 't_b', 't_a'])
  })
})
