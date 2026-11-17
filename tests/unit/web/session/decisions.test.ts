// tests/unit/web/session/decisions.test.ts (P2). Decisions through the queue and the undo path (CONTRACTS §6.6, §12.3,
// D26, §13 #40, #42, #48, #72, #79): an accept adopts the server text as the new base without touching the live doc
// when the editor applied it, and through the reload path when the suggestion was unplaced; reopen ids from the
// planner become their own requests answered before the save and never ride SaveRequest.suggestions; a bulk undo is
// ONE atomic bulk reopen; a refused undo re-applies; a closed suggestion raises DECISION_REVERTED.
import { afterEach, describe, expect, it } from 'vitest'
import type { BulkDecisionRequest, OpKey, SaveRequest, SessionNotice, SuggestionId } from '../../../../shared/types'
import { bodiesTo, fixture, TestPort, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'

let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

async function claudeSuggests(f: Fixture, quote: string, replace: string): Promise<SuggestionId> {
  const r = await f.agent([{ op: 'suggest', quote, replace }])
  return r.results[0]!.suggestion!
}

/** Paths of every write the transport sent, in order. */
const writes = (t: { requests: Array<{ method: string; path: string }> }): string[] =>
  t.requests.filter((r) => r.method !== 'GET').map((r) => r.path.split('?')[0]!)

describe('accept / reject (§6.6)', () => {
  it('accept: POST .../accept with an op_ key, the editor applies it, the base becomes the server text, nothing is re-saved', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const id = await claudeSuggests(fx, 'First paragraph', 'Opening paragraph')
    const port = await TestPort.create()
    const { session, internals, transport } = await fx.open({ port })
    port.onDecision = () => port.applyText(1, 'Opening paragraph here.')
    const r = await internals.decide(id, 'accept')
    expect(r).toEqual({ ok: true })
    const acc = transport.requestsTo(`/api/suggestions/${id}/accept`, 'POST')
    expect(acc).toHaveLength(1)
    expect((acc[0]!.body as { opKey: string }).opKey).toMatch(/^op_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(port.decisions).toEqual([{ ids: [id], decision: 'accept' }])
    expect(port.reloads).toHaveLength(0)
    expect(fx.root.read(DOC)).toContain('Opening paragraph here.')
    expect(internals.getLoaded()!.src).toBe(fx.root.read(DOC))
    expect(session.getSnapshot().markdown).toBe(fx.root.read(DOC))
    await session.flush()
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
  })

  it('accept of an unplaced suggestion adopts the server text through the reload path (§13 #72)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const id = await claudeSuggests(fx, 'Second paragraph', 'Middle paragraph')
    const port = await TestPort.create()
    port.placed = false
    const { internals } = await fx.open({ port })
    expect(await internals.decide(id, 'accept')).toEqual({ ok: true })
    expect(port.reloads.map((r) => r.reason)).toEqual(['decision'])
    expect(port.text(2)).toBe('Middle paragraph here.')
  })

  it('a double accept writes once: the second answer is a duplicate noop (§13 #40)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const id = await claudeSuggests(fx, 'Third paragraph', 'Last paragraph')
    const port = await TestPort.create()
    const { internals, transport } = await fx.open({ port })
    port.onDecision = () => port.applyText(3, 'Last paragraph here.')
    const [a, b] = await Promise.all([internals.decide(id, 'accept'), internals.decide(id, 'accept')])
    expect(a).toEqual({ ok: true })
    expect(b.ok).toBe(true)
    expect(transport.requestsTo(`/api/suggestions/${id}/accept`, 'POST')).toHaveLength(2)
    expect(port.decisions).toHaveLength(1 + (b.noop ? 0 : 1))
    expect(fx.root.read(DOC).match(/Last paragraph here\./g)).toHaveLength(1)
  })

  it('a decision on a closed suggestion is refused: DECISION_REVERTED notice, nothing applied (§13 #42)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const id = await claudeSuggests(fx, 'First paragraph', 'Withdrawn paragraph')
    const port = await TestPort.create()
    const { session, internals } = await fx.open({ port })
    const notices: SessionNotice[] = []
    session.onNotice((n) => notices.push(n))
    await fx.agent([{ op: 'withdraw', suggestion: id }])
    const r = await internals.decide(id, 'accept')
    expect(r).toEqual({ ok: false, code: 'SUGGESTION_CLOSED' })
    expect(port.decisions).toHaveLength(0)
    expect(notices.map((n) => n.code)).toEqual(['DECISION_REVERTED'])
  })

  it('reject: POST .../reject, the editor reverts, no doc fetch (no bytes changed)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const id = await claudeSuggests(fx, 'First paragraph', 'Rejected paragraph')
    const port = await TestPort.create()
    const { internals, transport } = await fx.open({ port })
    const before = transport.requestsTo('/api/doc', 'GET').length
    expect(await internals.decide(id, 'reject')).toEqual({ ok: true })
    expect(port.decisions).toEqual([{ ids: [id], decision: 'reject' }])
    expect(transport.requestsTo('/api/doc', 'GET')).toHaveLength(before)
    expect(fx.root.read(DOC)).toBe(MD)
  })
})

describe('undo: reopen ids are queue items, never save fields (D26)', () => {
  it('a single undo sends POST .../reopen before the save is planned; the save carries no reopen', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const id = await claudeSuggests(fx, 'First paragraph', 'Opening paragraph')
    const port = await TestPort.create()
    const { session, internals, transport } = await fx.open({ port })
    port.onDecision = () => port.applyText(1, 'Opening paragraph here.')
    await internals.decide(id, 'accept')
    // TJ's undo: history restores the base text (a user transaction) and the journal names the id to reopen
    port.setText(1, 'First paragraph here.')
    port.plan = { ...port.plan, reopen: [{ ids: [id] }] }
    port.setText(3, 'Third paragraph, typed after the undo.')
    await session.flush()
    const w = writes(transport)
    const reopenAt = w.indexOf(`/api/suggestions/${id}/reopen`)
    expect(reopenAt).toBeGreaterThan(-1)
    expect(w.indexOf('/api/save')).toBeGreaterThan(reopenAt)
    for (const s of bodiesTo<SaveRequest>(transport, '/api/save')) {
      expect(JSON.stringify(s.suggestions ?? {})).not.toContain('reopen')
      // the reopened block is not re-sent as an edit: the base was adopted from the reopen
      expect(s.ops.flatMap((op) => op.blocks).join('\n')).not.toContain('First paragraph here.')
    }
    expect(fx.root.read(DOC)).toBe('# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph, typed after the undo.\n')
    const s = (await (await fx.fa.store(DOC)).review()).suggestions.find((x) => x.id === id)
    expect(s?.status).toBe('pending')
  })

  it('a bulk accept is one request and one editor entry; its undo is ONE atomic bulk reopen', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const a = await claudeSuggests(fx, 'First paragraph', 'Opening paragraph')
    const b = await claudeSuggests(fx, 'Third paragraph', 'Closing paragraph')
    const port = await TestPort.create()
    const { session, internals, transport } = await fx.open({ port })
    port.onDecision = () => {
      port.applyText(1, 'Opening paragraph here.')
      port.applyText(3, 'Closing paragraph here.')
    }
    const res = await internals.bulk({ decision: 'accept', by: 'Claude' })
    expect(res?.results.every((x) => x.ok)).toBe(true)
    const bulks = bodiesTo<BulkDecisionRequest>(transport, '/api/suggestions/bulk')
    expect(bulks).toHaveLength(1)
    expect(bulks[0]).toMatchObject({ decision: 'accept', authors: ['Claude'] })
    expect(port.decisions).toHaveLength(1)
    expect(new Set(port.decisions[0]!.ids)).toEqual(new Set([a, b]))
    const bulkKey = port.decisions[0]!.bulk as OpKey
    expect(bulkKey).toBe(bulks[0]!.opKey)
    expect(port.reloads).toHaveLength(0)

    // one undo of the compound entry
    port.setText(1, 'First paragraph here.')
    port.setText(3, 'Third paragraph here.')
    port.plan = { ...port.plan, reopen: [{ ids: [a, b], bulk: bulkKey }] }
    await session.flush()
    const all = bodiesTo<BulkDecisionRequest>(transport, '/api/suggestions/bulk')
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({ decision: 'reopen', authors: [], ids: [a, b] })
    expect(all[1]!.opKey).not.toBe(bulkKey)
    expect(transport.requests.filter((r) => /\/api\/suggestions\/s_[^/]+\/reopen/.test(r.path))).toHaveLength(0)
    expect(fx.root.read(DOC)).toBe(MD)
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
  })

  it('a refused bulk undo (409 SUGGESTION_CHANGED_SINCE) writes nothing and hands the group back to the editor (§13 #79)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const a = await claudeSuggests(fx, 'First paragraph', 'Opening paragraph')
    const b = await claudeSuggests(fx, 'Third paragraph', 'Closing paragraph')
    const port = await TestPort.create()
    const { session, internals, transport } = await fx.open({ port })
    port.onDecision = (o) => {
      if (o.decision === 'accept') {
        port.applyText(1, 'Opening paragraph here.')
        port.applyText(3, 'Closing paragraph here.')
      }
    }
    await internals.bulk({ decision: 'accept', ids: [a, b] })
    const bulkKey = port.decisions[0]!.bulk as OpKey
    // Claude edits one accepted text, so the undo can no longer splice back
    await fx.agent([{ op: 'replace_block', target: { quote: 'Closing paragraph here.' }, markdown: 'Closing, edited by Claude.' }])
    port.setText(1, 'First paragraph here.')
    port.plan = { ...port.plan, reopen: [{ ids: [a, b], bulk: bulkKey }] }
    const before = fx.root.read(DOC)
    await session.flush().catch(() => undefined)
    const reopen = transport.requestsTo('/api/suggestions/bulk', 'POST').at(-1)!
    expect(reopen.body).toMatchObject({ decision: 'reopen', ids: [a, b] })
    expect(reopen.status).toBe(409)
    expect(port.refusedReopens).toEqual([{ ids: [a, b], bulk: bulkKey }])
    // all-or-nothing: neither id was reopened, and the refused reopen wrote no bytes of its own
    const statuses = (await (await fx.fa.store(DOC)).review()).suggestions.filter((x) => x.id === a || x.id === b).map((x) => x.status)
    expect(statuses).toEqual(['accepted', 'accepted'])
    expect(before).toContain('Closing, edited by Claude.')
    expect(fx.root.read(DOC)).toContain('Closing, edited by Claude.')
  })
})
