// tests/unit/core/sidecar/parse-keys.test.ts (P1). Sidecar parse (§4.1, §4.5 tolerance, §4.6 torn tail and mid-file
// corruption) and idempotency keys (§4.7).
import { describe, expect, it } from 'vitest'
import { fold } from '../../../../core/sidecar/fold'
import { canonicalJSON, cliKey, roundSeqOf, saveKey, tjKey } from '../../../../core/sidecar/keys'
import { parseSidecar } from '../../../../core/sidecar/parse'
import { checkStoredEvent } from '../../../../core/sidecar/validate'
import type { AgentOp, SidecarEvent } from '../../../../shared/types'
import { CONSTANTS } from '../../../../shared/types'

const HEADER = { type: 'header', schema: 'mdr.sidecar/2', docId: 'd_01JAB3K9Q2T7V5X8Y0Z1W2E3R4', file: 'PLAN.md', createdAt: '2026-10-15T17:00:00.000Z', createdBy: 'mdr/2.0.0-dev' }
const AT = '2026-10-15T17:00:00.000Z'
const T = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R7'
/** A read-marker line by default; any `type` in `extra` replaces the read-marker payload entirely. */
const ev = (seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  seq, id: `e_01JAB3K9Q2T7V5X8Y0Z${String(seq).padStart(7, '0')}`, by: 'TJ', at: AT, rev: 0,
  ...('type' in extra ? {} : { type: 'read-marker', thread: null, upTo: 0 }), ...extra,
})
const text = (...lines: Array<Record<string, unknown> | string>): string =>
  lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'

describe('parseSidecar', () => {
  it('empty text: no header, nothing folded', () => {
    expect(parseSidecar('')).toMatchObject({ header: null, events: [], lines: 0, tornTail: false, corrupt: null })
  })

  it('parses the header and every line; validLength/validBytes point after the last good line (UTF-8 aware)', () => {
    const t = text(HEADER, ev(1), ev(2, { type: 'comment.add', thread: T, comment: 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8', anchor: { kind: 'doc' }, body: 'naïve — ok 👍' }))
    const p = parseSidecar(t)
    expect(p.header).toMatchObject({ docId: HEADER.docId })
    expect(p.events.map((e) => e.seq)).toEqual([1, 2])
    expect(p.validLength).toBe(t.length)
    expect(p.validBytes).toBe(Buffer.byteLength(t, 'utf8'))
    expect(p.lastSeq).toBe(2)
  })

  it('a final line without \\n is a torn tail: ignored, and the valid boundary stops before it', () => {
    const good = text(HEADER, ev(1))
    const p = parseSidecar(good + JSON.stringify(ev(2)).slice(0, 20))
    expect(p).toMatchObject({ tornTail: true, corrupt: null })
    expect(p.events).toHaveLength(1)
    expect(p.validBytes).toBe(Buffer.byteLength(good))
  })

  it('a complete final line with bad JSON is also a torn tail', () => {
    const good = text(HEADER, ev(1))
    const p = parseSidecar(good + '{"seq":2,"id":\n')
    expect(p).toMatchObject({ tornTail: true, corrupt: null })
    expect(p.validBytes).toBe(Buffer.byteLength(good))
  })

  it('bad JSON before the last line is mid-file corruption: corrupt { line }, events = the valid prefix', () => {
    const p = parseSidecar(text(HEADER, ev(1), '{nope', ev(3)))
    expect(p.corrupt).toEqual({ line: 3, reason: 'bad JSON' })
    expect(p.events.map((e) => e.seq)).toEqual([1])
  })

  it('a duplicate or decreasing seq is corrupt', () => {
    expect(parseSidecar(text(HEADER, ev(1), ev(1))).corrupt?.line).toBe(3)
    expect(parseSidecar(text(HEADER, ev(2), ev(1))).corrupt?.line).toBe(3)
  })

  it('a schema-invalid line of a known type is corrupt; an unknown type or a disallowed actor is skipped with a warning', () => {
    const invalid = parseSidecar(text(HEADER, ev(1, { type: 'comment.add', body: 'no thread' }), ev(2)))
    expect(invalid.corrupt?.line).toBe(2)
    const skipped = parseSidecar(text(HEADER, ev(1), { seq: 2, type: 'future.thing', by: 'TJ' }, ev(3, { type: 'ack', by: 'TJ', upTo: 0 }), ev(4)))
    expect(skipped.corrupt).toBeNull()
    expect(skipped.events.map((e) => e.seq)).toEqual([1, 4])
    expect(skipped.warnings.map((w) => [w.code, w.line])).toEqual([['SIDECAR_INVALID_EVENT', 3], ['SIDECAR_INVALID_EVENT', 4]])
  })

  it('a skipped line still takes part in seq ordering: no false gap, and a decreasing seq on it is corrupt', () => {
    const p = parseSidecar(text(HEADER, ev(1), { seq: 2, type: 'future.thing', by: 'TJ' }, ev(3)))
    expect(p.seqGaps).toEqual([])
    expect(parseSidecar(text(HEADER, ev(2), { seq: 1, type: 'future.thing', by: 'TJ' })).corrupt?.line).toBe(3)
  })

  it('a seq gap warns SIDECAR_SEQ_GAP unless the header says compacted', () => {
    const plain = parseSidecar(text(HEADER, ev(1), ev(5)))
    expect(plain.seqGaps).toEqual([5])
    expect(plain.warnings.map((w) => w.code)).toEqual(['SIDECAR_SEQ_GAP'])
    const compacted = parseSidecar(text({ ...HEADER, compacted: { at: AT, droppedLines: 3 } }, ev(1), ev(5)))
    expect(compacted.seqGaps).toEqual([5])
    expect(compacted.warnings).toEqual([])
  })

  it('another schema → schemaUnsupported, nothing folded; a non-header first line → corrupt line 1', () => {
    const p = parseSidecar(text({ ...HEADER, schema: 'mdr.sidecar/3' }, ev(1)))
    expect(p.schemaUnsupported).toBe('mdr.sidecar/3')
    expect(p.events).toEqual([])
    expect(parseSidecar(text(ev(1))).corrupt).toEqual({ line: 1, reason: 'invalid header' })
  })

  it('a line over MAX_LINE_BYTES is corrupt', () => {
    const big = ev(2, { type: 'comment.add', thread: T, comment: 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8', anchor: { kind: 'doc' }, body: 'x'.repeat(CONSTANTS.MAX_LINE_BYTES) })
    const p = parseSidecar(text(HEADER, ev(1), big, ev(3)))
    expect(p.corrupt).toMatchObject({ line: 3 })
  })

  it('the §4.3 example lines validate as stored events', () => {
    const r = checkStoredEvent({ seq: 17, id: 'e_01JAG3K9Q2T7V5X8Y0Z1W2E3R5', type: 'policy.set', by: 'Claude', at: AT, rev: 9, suggestOnly: true })
    expect(r.ok).toBe(true)
  })
})

describe('keys (§4.7)', () => {
  const op: AgentOp = { op: 'comment', quote: 'member rate', body: 'Is this current?' }

  it('cliKey: deterministic, 32 hex chars after cli:, and stable across processes (golden value)', () => {
    const k = cliKey('PLAN.md', 0, op)
    expect(k).toMatch(/^cli:[0-9a-f]{32}$/)
    expect(cliKey('PLAN.md', 0, op)).toBe(k)
    // sha256("PLAN.md\0" + "0\0" + canonicalJSON(op)).slice(0, 32), computed independently with node:crypto; pinned so
    // a restart (or another machine) derives the same key
    expect(k).toBe('cli:2f396fe39bd95ec152ad6d416f6826a0')
  })

  it('same round → same key (duplicate); a later round → a new key; op.key wins', () => {
    const r1 = cliKey('PLAN.md', 12, op)
    expect(cliKey('PLAN.md', 12, { ...op })).toBe(r1)
    expect(cliKey('PLAN.md', 20, op)).not.toBe(r1)
    expect(cliKey('OTHER.md', 12, op)).not.toBe(r1)
    expect(cliKey('PLAN.md', 12, { ...op, key: 'mine' })).toBe('mine')
  })

  it('canonicalJSON sorts keys at every depth and drops undefined, so field order never changes a key', () => {
    expect(canonicalJSON({ b: 1, a: { d: undefined, c: [1, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[1,{"y":2,"z":1}]},"b":1}')
    const a: AgentOp = { op: 'suggest', quote: 'x', replace: 'y', reason: 'r' }
    const b = { reason: 'r', replace: 'y', quote: 'x', op: 'suggest', occurrence: undefined } as unknown as AgentOp
    expect(cliKey('d.md', 3, a)).toBe(cliKey('d.md', 3, b))
  })

  it('roundSeqOf follows the latest non-void handoff.sent, so the key changes when TJ sends again', () => {
    const lines: SidecarEvent[] = [
      { seq: 1, id: 'e_01JAB3K9Q2T7V5X8Y0Z0000001', type: 'handoff.sent', by: 'TJ', at: AT, rev: 0, message: null, delivery: 'waiter' },
    ]
    const f1 = fold(lines)
    const k1 = cliKey('d.md', roundSeqOf(f1), op)
    const f2 = fold([{ seq: 2, id: 'e_01JAB3K9Q2T7V5X8Y0Z0000002', type: 'handoff.sent', by: 'TJ', at: AT, rev: 0, message: 'again', delivery: 'waiter' }], f1)
    expect(roundSeqOf(f2)).toBe(2)
    expect(cliKey('d.md', roundSeqOf(f2), op)).not.toBe(k1)
  })

  it('browser keys', () => {
    expect(tjKey('op_01JAB3K9Q2T7V5X8Y0Z1W2E3R6')).toBe('tj:op_01JAB3K9Q2T7V5X8Y0Z1W2E3R6')
    expect(saveKey('k_01JAD3K9Q2T7V5X8Y0Z1W2E3R1', 41)).toBe('save:k_01JAD3K9Q2T7V5X8Y0Z1W2E3R1:41')
  })
})
