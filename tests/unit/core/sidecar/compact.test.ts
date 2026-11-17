// tests/unit/core/sidecar/compact.test.ts (P1). `mdr doctor --compact` over a log (CONTRACTS §4.8, D22): doc.rev
// retention (last 200, history refs, doc.edit/doc.external refs, an open TJ session, Claude's ack and everything after
// it), superseded suggestion bodies older than the ack, seqs preserved, the compacted header, and the guarantee that
// the folded review state and pending's window are equal before and after.
import { describe, expect, it } from 'vitest'
import { COMPACT_KEEP_REVS, compactLines } from '../../../../core/sidecar/compact'
import { fold, toReviewState } from '../../../../core/sidecar/fold'
import type { Hash, SidecarEvent, SidecarHeader, SuggestionId, TextAnchor, ThreadId } from '../../../../shared/types'

const AT = '2026-10-15T17:00:00.000Z'
const H = (n: number): Hash => n.toString(16).padStart(64, '0')
const HEADER: SidecarHeader = { type: 'header', schema: 'mdr.sidecar/2', docId: 'd_01JAB3K9Q2T7V5X8Y0Z1W2E3R4', file: 'x.md', createdAt: AT, createdBy: 'mdr/2.0.0-dev' }
const anchor: TextAnchor = { kind: 'text', quote: 'q', prefix: '', suffix: '', hint: { rev: 1, pos: 0, block: 0, blockHash: '9f2c0d1e7a6b5c44', offsetInBlock: 0 } }
const S1 = 's_01JAB3K9Q2T7V5X8Y0Z1W2E3C1' as SuggestionId
const S2 = 's_01JAB3K9Q2T7V5X8Y0Z1W2E3C2' as SuggestionId
const T1 = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3A1' as ThreadId
const T2 = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3A2' as ThreadId

function build(): { events: SidecarEvent[]; ackSeq: number } {
  const events: SidecarEvent[] = []
  let seq = 0
  let rev = 0
  const push = (e: Record<string, unknown>): SidecarEvent => {
    seq += 1
    const line = { seq, id: `e_01JAB3K9Q2T7V5X8Y0Z${String(seq).padStart(7, '0')}`, at: AT, rev, ...e } as unknown as SidecarEvent
    events.push(line)
    return line
  }
  const docRev = (by: string, cause: string): void => {
    const prev = rev || null
    rev += 1
    push({ type: 'doc.rev', by, rev, prevRev: prev, prevHash: prev === null ? null : H(prev), hash: H(rev), bytes: 10, cause })
  }
  docRev('system', 'baseline')
  push({ type: 'suggestion.add', by: 'TJ', thread: T1, newThread: true, suggestion: S1, anchor, range: { start: 0, end: 1, rev }, base: 'a', proposed: 'b', hunks: [{ del: 'a', ins: 'b', at: 0 }] })
  push({ type: 'suggestion.add', by: 'Claude', thread: T2, newThread: true, suggestion: S2, anchor, range: { start: 1, end: 2, rev }, base: 'c', proposed: 'd', hunks: [] })
  // 250 TJ saves, a session flush every 25 saves
  let base = rev
  for (let k = 1; k <= 250; k++) {
    docRev('TJ', 'save')
    if (k % 25 === 0) {
      push({ type: 'doc.edit', by: 'TJ', source: 'editor', fromRev: base, toRev: rev, changes: [] })
      base = rev
    }
    if (k === 100) {
      for (let u = 0; u < 5; u++) push({ type: 'suggestion.update', by: 'TJ', suggestion: S1, anchor, range: { start: 0, end: 1, rev }, base: 'a', proposed: `b${u}`, hunks: [] })
      push({ type: 'suggestion.stale', by: 'system', suggestion: S2, reason: 'BASE_GONE' })
      push({ type: 'suggestion.rebase', by: 'system', suggestion: S2, anchor, range: { start: 1, end: 2, rev }, base: 'c2', proposed: 'd2', hunks: [] })
      push({ type: 'suggestion.rebase', by: 'system', suggestion: S2, anchor, range: { start: 1, end: 2, rev }, base: 'c3', proposed: 'd3', hunks: [] })
    }
  }
  const ack = push({ type: 'ack', by: 'Claude', upTo: seq })
  // after the ack: one more update (must survive) and an open TJ session
  push({ type: 'suggestion.update', by: 'TJ', suggestion: S1, anchor, range: { start: 0, end: 1, rev }, base: 'a', proposed: 'final', hunks: [] })
  docRev('TJ', 'save')
  docRev('TJ', 'save')
  return { events, ackSeq: ack.seq }
}

const digest = (evs: SidecarEvent[]): unknown => {
  const f = fold(evs)
  const r = toReviewState(f, () => ({ state: 'detached' }), { file: 'x.md' })
  return { rev: r.rev, seq: r.seq, threads: r.threads, suggestions: r.suggestions, cursors: r.cursors, policy: r.policy, hash: f.hash, session: f.tjSession }
}

describe('compactLines (§4.8)', () => {
  it('drops old doc.revs and superseded suggestion bodies, keeps seqs, and folds to the same state', () => {
    const { events, ackSeq } = build()
    const out = compactLines({ header: HEADER, events, historyRevs: new Set([3, 7]), now: AT })
    expect(out.dropped).toBeGreaterThan(0)
    expect(out.header.compacted).toEqual({ at: AT, droppedLines: out.dropped })
    expect(digest(out.events)).toEqual(digest(events))
    // seqs preserved, strictly increasing
    const seqs = out.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    for (const e of out.events) expect(events.find((x) => x.seq === e.seq)).toEqual(e)
    const revsKept = new Set(out.events.filter((e) => e.type === 'doc.rev').map((e) => e.rev))
    const maxRev = Math.max(...events.filter((e) => e.type === 'doc.rev').map((e) => e.rev))
    for (let r = maxRev - COMPACT_KEEP_REVS + 1; r <= maxRev; r++) expect(revsKept.has(r)).toBe(true)
    expect(revsKept.has(3) && revsKept.has(7)).toBe(true) // history refs
    for (const e of events) if (e.type === 'doc.edit') expect(revsKept.has(e.fromRev) && revsKept.has(e.toRev)).toBe(true)
    // pending's window (everything after the ack) is untouched
    expect(out.events.filter((e) => e.seq > ackSeq)).toEqual(events.filter((e) => e.seq > ackSeq))
    // every pre-ack update of S1 is superseded (the last one by the post-ack update), so only the post-ack one stays
    const s1Updates = out.events.filter((e) => e.type === 'suggestion.update').map((e) => (e as { proposed: string }).proposed)
    expect(s1Updates).toEqual(['final'])
    // S2: the stale → rebase edge is kept (dropping it would leave S2 stale); the superseded rebase while pending goes
    expect(out.events.filter((e) => e.type === 'suggestion.rebase').map((e) => (e as { base: string }).base)).toEqual(['c3'])
  })

  it('a compacted log compacts again without dropping anything new', () => {
    const { events } = build()
    const once = compactLines({ header: HEADER, events, historyRevs: new Set(), now: AT })
    const twice = compactLines({ header: once.header, events: once.events, historyRevs: new Set(), now: AT })
    expect(twice.dropped).toBe(0)
    expect(twice.events).toEqual(once.events)
  })
})
