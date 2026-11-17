// tests/unit/core/sidecar/day0-sidecar.test.ts (integrator, day 0; P1 owns it from M0).
//
// The day-0 sidecar parse (§4.1, §4.6), fold (§4.5), keys (§4.7) and the suggestion state machine.
import { describe, expect, it } from 'vitest'
import { fold, handoffRecords, toReviewState } from '../../../../core/sidecar/fold'
import { canonicalJSON, cliKey } from '../../../../core/sidecar/keys'
import { parseSidecar } from '../../../../core/sidecar/parse'
import { suggestionTransition } from '../../../../core/sidecar/validate'
import type { AgentOp, SidecarEvent } from '../../../../shared/types'

const HEADER = '{"type":"header","schema":"mdr.sidecar/2","docId":"d_01JAB3K9Q2T7V5X8Y0Z1W2E3R4","file":"PLAN.md","createdAt":"2026-10-15T17:00:00.000Z","createdBy":"mdr/2.0.0-dev"}'
const T = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R7'
const S = 's_01JAC3K9Q2T7V5X8Y0Z1W2E3R9'
const anchor = { kind: 'text', quote: 'q', prefix: '', suffix: '', hint: { rev: 1, pos: 0, block: 0, blockHash: '9f2c0d1e7a6b5c44', offsetInBlock: 0 } } as const
const HASH = 'ab4d6f8a0c2e4a6c8e0a2c4e6a8c0e2a4c6e8a0c2e4a6c8e0a2c4e6a8c0e2a4c'

const at = '2026-10-15T17:00:00.000Z'
const id = (n: number) => `e_01JAB3K9Q2T7V5X8Y0Z1W2E${String(n).padStart(3, '0')}`.replace(/[ILOU]/g, 'X')
const lines: SidecarEvent[] = [
  { seq: 1, id: id(1) as `e_${string}`, type: 'doc.rev', by: 'system', at, rev: 1, prevRev: null, prevHash: null, hash: HASH, bytes: 10, cause: 'baseline' },
  { seq: 2, id: id(2) as `e_${string}`, type: 'comment.add', by: 'TJ', at, rev: 1, key: 'tj:op_1', thread: T, comment: 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8', anchor, body: 'Is 12% current?' },
  { seq: 3, id: id(3) as `e_${string}`, type: 'comment.reply', by: 'Claude', at, rev: 1, thread: T, comment: 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3R9', body: 'Yes.' },
  {
    seq: 4, id: id(4) as `e_${string}`, type: 'suggestion.add', by: 'Claude', at, rev: 1, thread: 't_01JAC3K9Q2T7V5X8Y0Z1W2E3R7', newThread: true,
    suggestion: S, comment: 'c_01JAC3K9Q2T7V5X8Y0Z1W2E3R8', body: 'Plain words.', anchor, range: { start: 0, end: 1, rev: 1 },
    base: 'utilize', proposed: 'use', hunks: [{ del: 'utilize', ins: 'use', at: 0 }],
  },
  { seq: 5, id: id(5) as `e_${string}`, type: 'handoff.sent', by: 'TJ', at, rev: 1, message: 'go', delivery: 'waiter' },
  { seq: 6, id: id(6) as `e_${string}`, type: 'suggestion.accept', by: 'TJ', at, rev: 1, suggestion: S, resultRev: 2 },
  { seq: 7, id: id(7) as `e_${string}`, type: 'policy.set', by: 'Claude', at, rev: 1, suggestOnly: true },
]

describe('parseSidecar (day 0)', () => {
  const text = [HEADER, ...lines.map((l) => JSON.stringify(l))].join('\n') + '\n'

  it('parses the header and every valid line', () => {
    const p = parseSidecar(text)
    expect(p.header?.docId).toBe('d_01JAB3K9Q2T7V5X8Y0Z1W2E3R4')
    expect(p.events).toHaveLength(lines.length)
    expect(p.corrupt).toBeNull()
    expect(p.tornTail).toBe(false)
    expect(p.validLength).toBe(text.length)
  })

  it('ignores a torn tail', () => {
    const p = parseSidecar(text + '{"seq":8,"type":"ack"')
    expect(p.tornTail).toBe(true)
    expect(p.events).toHaveLength(lines.length)
    expect(p.validLength).toBe(text.length)
  })

  it('reports mid-file corruption with the valid prefix', () => {
    const parts = text.split('\n')
    parts.splice(3, 0, '{not json')
    const p = parseSidecar(parts.join('\n'))
    expect(p.corrupt?.line).toBe(4)
    expect(p.events).toHaveLength(2)
  })

  it('refuses another schema and skips unknown types with a warning', () => {
    expect(parseSidecar(HEADER.replace('mdr.sidecar/2', 'mdr.sidecar/3') + '\n').schemaUnsupported).toBe('mdr.sidecar/3')
    const p = parseSidecar(HEADER + '\n{"seq":1,"type":"future.thing","by":"TJ"}\n')
    expect(p.events).toHaveLength(0)
    expect(p.warnings[0]?.code).toBe('SIDECAR_INVALID_EVENT')
  })
})

describe('fold / toReviewState (day 0)', () => {
  it('folds threads, suggestions, handoffs, policy and keys', () => {
    const f = fold(lines)
    expect(f.seq).toBe(7)
    expect(f.rev).toBe(1)
    expect(f.keys.get('tj:op_1')).toEqual([2])
    expect(f.policy.suggestOnly).toBe(true)
    expect(f.suggestions.get(S)?.status).toBe('accepted')
    expect(f.suggestions.get(S)?.decidedBy).toBe('TJ')
    expect(handoffRecords(f)).toEqual([{ seq: 5, at, message: 'go', delivery: 'waiter', round: 1, consumed: false }])
    const r = toReviewState(f, () => ({ state: 'exact' }), { file: 'PLAN.md' })
    expect(r.threads).toHaveLength(2)
    expect(r.threads[0]!.unread).toBe(1)
    expect(r.threads[1]!.kind).toBe('suggestion')
    expect(r.threads[1]!.autoResolved).toBe(true)
    expect(r.undeliveredHandoffs).toEqual([5])
  })

  it('is incremental: fold(b, fold(a)) equals fold(a ++ b), and never mutates its init', () => {
    const a = fold(lines.slice(0, 3))
    const before = JSON.stringify([...a.threads.values()])
    const both = fold(lines.slice(3), a)
    expect(JSON.stringify([...a.threads.values()])).toBe(before)
    expect(toReviewState(both, () => ({ state: 'exact' }), { file: 'x' })).toEqual(toReviewState(fold(lines), () => ({ state: 'exact' }), { file: 'x' }))
  })

  it('an ack covers handoffs', () => {
    const f = fold([...lines, { seq: 8, id: id(8) as `e_${string}`, type: 'ack', by: 'Claude', at, rev: 1, upTo: 7 }])
    expect(f.cursors.claudeAck).toBe(7)
    expect(handoffRecords(f, { unconsumed: true })).toEqual([])
  })
})

describe('keys and transitions (day 0)', () => {
  const op: AgentOp = { op: 'reply', thread: T, body: 'Yes.' }

  it('cliKey is deterministic, round-scoped and honours op.key', () => {
    const k = cliKey('PLAN.md', 5, op)
    expect(k).toMatch(/^cli:[0-9a-f]{32}$/)
    expect(cliKey('PLAN.md', 5, { body: 'Yes.', thread: T, op: 'reply' })).toBe(k)
    expect(cliKey('PLAN.md', 6, op)).not.toBe(k)
    expect(cliKey('PLAN.md', 5, { ...op, key: 'mine' })).toBe('mine')
    expect(canonicalJSON({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}')
  })

  it('suggestion state machine', () => {
    const pending = { status: 'pending' as const, by: 'Claude' as const }
    expect(suggestionTransition(pending, 'suggestion.accept', 'TJ')).toBe('ok')
    expect(suggestionTransition(pending, 'suggestion.accept', 'Claude')).toBe('NOT_AUTHOR')
    expect(suggestionTransition({ ...pending, status: 'accepted', decidedBy: 'TJ' }, 'suggestion.accept', 'TJ')).toBe('duplicate')
    expect(suggestionTransition({ ...pending, status: 'accepted', decidedBy: 'TJ' }, 'suggestion.reject', 'TJ')).toBe('SUGGESTION_CLOSED')
    expect(suggestionTransition({ ...pending, status: 'accepted', decidedBy: 'TJ' }, 'suggestion.reopen', 'TJ')).toBe('ok')
    expect(suggestionTransition({ ...pending, status: 'stale' }, 'suggestion.accept', 'TJ')).toBe('SUGGESTION_STALE')
    expect(suggestionTransition({ ...pending, status: 'stale' }, 'suggestion.reject', 'TJ')).toBe('ok')
    expect(suggestionTransition(pending, 'suggestion.withdraw', 'TJ')).toBe('NOT_AUTHOR')
  })
})
