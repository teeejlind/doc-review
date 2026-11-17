// Integrator (day 0): the server-side fakes behave to the contract in-process: FakeDocStore + fakeApp + handoffStub
// over MockTransport (CONTRACTS §2.2, §2.5, §8). The full route-by-route schema suite is tests/contract/
// api.contract.test.ts; this file pins the behaviour the e2e specs lean on (persistence, SSE order, echo ids, batch
// semantics, decisions, handoff latch and round, the §8.1 refusals).
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ulid } from 'ulid'
import type { z } from 'zod'
import * as S from '../../../shared/schemas'
import { buildClipboardPrompt } from '../../../shared/handoff-prompt'
import type {
  BatchResult, BrowserSseEvent, CreateThreadResponse, DecisionResult, DocSnapshot, HandoffResult, OpKey, ReviewState,
  SaveResponse, StatusResult,
} from '../../../shared/types'
import { createFakeApp, type FakeApp } from '../../fakes/fakeApp'
import { createMockTransport, type MockTransport } from '../../fakes/MockTransport'
import { tmpRoot, type TmpRoot } from '../../helpers/tmpRoot'
import { opsForText, testCore } from '../../helpers/webClient'
import { agentHeaders, browserHeaders } from '../../helpers/startServer'

const DOC = 'basic.md'
const PORT = 28_999
const opKey = (): OpKey => `op_${ulid()}`
const q = `file=${encodeURIComponent(DOC)}`
function issues(schema: z.ZodType, v: unknown): string[] {
  const r = schema.safeParse(v)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
}
const until = async (cond: () => boolean, ms = 5_000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('fakeApp over FakeDocStore (in-process)', () => {
  let root: TmpRoot
  let fake: FakeApp
  let t: MockTransport
  const agent = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const r = await fake.fetch(new Request(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { ...agentHeaders({ token: fake.token }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    return { status: r.status, json: await r.json() }
  }

  beforeAll(async () => {
    root = tmpRoot({ name: 'fakes-server', fixtures: [DOC, 'syn__bom-crlf.md', 'syn__duplicate-quotes.md'], files: { 'notes.txt': 'x\n' } })
    fake = await createFakeApp({ root: root.root, port: PORT, diskPollMs: 0 })
    t = createMockTransport({ app: fake, token: fake.token, port: PORT })
  }, 60_000)
  afterAll(async () => {
    t?.closeAll()
    await fake?.close()
    root?.cleanup()
  })

  it('health, doc and review are schema-valid; a read creates no sidecar', async () => {
    const h = await t.request('GET', '/api/health')
    expect(h.status).toBe(200)
    expect(issues(S.HealthSchema, h.json)).toEqual([])
    const d = await t.request('GET', `/api/doc?${q}`)
    expect(issues(S.DocSnapshotSchema, d.json)).toEqual([])
    expect((d.json as DocSnapshot).rev).toBe(0)
    const r = await t.request('GET', `/api/review?${q}`)
    expect(issues(S.ReviewStateSchema, r.json)).toEqual([])
    expect(existsSync(root.sidecarPath(DOC))).toBe(false)
  })

  it('§8.1 refusals', async () => {
    const raw = (path: string, init: RequestInit = {}) => fake.fetch(new Request(`http://127.0.0.1:${PORT}${path}`, init))
    expect((await raw(`/api/doc?${q}`)).status).toBe(401)
    expect((await raw(`/api/doc?${q}`, { headers: { ...browserHeaders({ token: 'nope', port: PORT }) } })).status).toBe(401)
    const misdirected = await fake.fetch(new Request(`http://127.0.0.1:${PORT + 1}/api/doc?${q}`, { headers: browserHeaders({ token: fake.token, port: PORT }) }))
    expect(misdirected.status).toBe(421)
    const withOrigin = await raw(`/api/agent/status?${q}`, { headers: { ...agentHeaders({ token: fake.token }), Origin: `http://127.0.0.1:${PORT}` } })
    expect(withOrigin.status).toBe(403)
    expect((await raw(`/api/agent/status?${q}`, { headers: agentHeaders({ token: fake.token, protocol: 1 }) })).status).toBe(426)
    const id = await t.request('POST', `/api/threads?${q}`, { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x', by: 'Claude' })
    expect(id.status).toBe(400)
    expect((id.json as { error: { code: string } }).error.code).toBe('IDENTITY_IN_BODY')
    const foreign = await raw(`/api/threads?${q}`, { method: 'POST', headers: { ...browserHeaders({ token: fake.token, port: 9 }), 'X-MDR-Client-Id': t.clientId }, body: '{}' })
    expect(foreign.status).toBe(403)
    const codes = async (file: string) => ((await t.request('GET', `/api/doc?file=${encodeURIComponent(file)}`)).json as { error: { code: string } }).error.code
    expect(await codes('nope.md')).toBe('FILE_NOT_FOUND')
    expect(await codes('notes.txt')).toBe('BAD_REQUEST')
    expect(await codes('../outside.md')).toBe('PATH_OUTSIDE_ROOT')
    expect(await codes('approvals/x.md')).toBe('PROTECTED_ROOT')
    expect((await raw('/api/health')).headers.get('x-mdr-root-hash')).toBe(fake.rootHash)
  })

  it('SSE: hello, then doc-changed before sidecar-changed with the writer client id (D32)', async () => {
    const es = t.events(`/api/events?${new URLSearchParams({ file: DOC, clientId: t.clientId, t: fake.token })}`)
    const got: BrowserSseEvent[] = []
    for (const type of ['hello', 'doc-changed', 'sidecar-changed'] as const) es.addEventListener(type, (e) => got.push({ event: type, data: JSON.parse(e.data) } as BrowserSseEvent))
    await until(() => got.some((e) => e.event === 'hello'))
    expect(issues(S.BrowserSseEventSchema, got[0])).toEqual([])
    const snap = (await t.request('GET', `/api/doc?${q}`)).json as DocSnapshot
    const next = snap.markdown.replace('We launch in Q3.', 'We launch in Q4.')
    const { ops, blockHashes, text } = await opsForText(snap.markdown, next)
    const c = await testCore()
    const save = await t.request('POST', `/api/save?${q}`, {
      clientId: t.clientId, saveId: 1, base: { rev: snap.rev, hash: snap.hash, blockHashes }, ops,
      expectHash: c.docHash(text, snap.bom), cause: 'edit', allowPartial: true,
    })
    expect(save.status).toBe(200)
    expect(issues(S.SaveResponseSchema, save.json)).toEqual([])
    const sr = save.json as SaveResponse
    expect(sr.applied).toBe('direct')
    expect(root.read(DOC)).toBe(next)
    await until(() => got.some((e) => e.event === 'sidecar-changed'))
    const kinds = got.filter((e) => e.event !== 'hello').map((e) => e.event)
    expect(kinds.indexOf('doc-changed')).toBeLessThan(kinds.indexOf('sidecar-changed'))
    const dc = got.find((e) => e.event === 'doc-changed')!
    expect(issues(S.BrowserSseEventSchema, dc)).toEqual([])
    expect((dc.data as { clientId?: string }).clientId).toBe(t.clientId)
    // a duplicate (same clientId, saveId) applies nothing
    const dup = await t.request('POST', `/api/save?${q}`, {
      clientId: t.clientId, saveId: 1, base: { rev: snap.rev, hash: snap.hash, blockHashes }, ops,
      expectHash: c.docHash(text, snap.bom), cause: 'edit', allowPartial: true,
    })
    expect((dup.json as SaveResponse).applied).toBe('duplicate')
    es.close()
  })

  it('agent batch: comment + suggest by quote; TJ accepts and the file gets exactly the proposed bytes', async () => {
    const b = await agent('POST', `/api/agent/batch?${q}`, {
      ops: [
        { op: 'comment', quote: 'Ship the explainer page', body: 'Which page?' },
        { op: 'suggest', quote: 'Publish the FAQ', replace: 'Publish the FAQ and the glossary', reason: 'Glossary too.' },
      ],
    })
    expect(b.status).toBe(200)
    expect(issues(S.BatchResultSchema, b.json)).toEqual([])
    const br = b.json as BatchResult
    expect(br.results.map((r) => r.op)).toEqual(['comment', 'suggest'])
    // a retried batch is a duplicate per op (§4.7)
    const again = await agent('POST', `/api/agent/batch?${q}`, {
      ops: [{ op: 'comment', quote: 'Ship the explainer page', body: 'Which page?' }],
    })
    expect((again.json as BatchResult).results[0]!.duplicate).toBe(true)
    const sid = br.results[1]!.suggestion!
    const acc = await t.request('POST', `/api/suggestions/${sid}/accept?${q}`, { opKey: opKey() })
    expect(acc.status).toBe(200)
    expect(issues(S.DecisionResultSchema, acc.json)).toEqual([])
    expect((acc.json as DecisionResult).status).toBe('accepted')
    expect(root.read(DOC)).toContain('- Publish the FAQ and the glossary\n')
    const rev = (await t.request('GET', `/api/review?${q}`)).json as ReviewState
    expect(rev.suggestions.find((s) => s.id === sid)!.status).toBe('accepted')
    // undo of the accept (D26)
    const reopen = await t.request('POST', `/api/suggestions/${sid}/reopen?${q}`, { opKey: opKey() })
    expect(reopen.status).toBe(200)
    expect(root.read(DOC)).toContain('- Publish the FAQ\n')
  })

  it('positional selectors are strict (D3): a stale rev is 409 STALE_REVISION with current', async () => {
    const st = (await agent('GET', `/api/agent/status?${q}`)).json as StatusResult
    expect(issues(S.StatusResultSchema, st)).toEqual([])
    const r = await agent('POST', `/api/agent/batch?${q}`, { ops: [{ op: 'replace_block', target: { ref: 'b2', rev: st.rev - 1 }, markdown: 'x' }] })
    expect(r.status).toBe(409)
    expect(issues(S.ApiErrorSchema, r.json)).toEqual([])
    expect((r.json as { error: { code: string }; current?: unknown }).error.code).toBe('STALE_REVISION')
    const ok = await agent('POST', `/api/agent/batch?${q}`, { ops: [{ op: 'replace_block', target: { ref: 'b2', rev: st.rev }, markdown: 'The notes carry a member rate of 11% paid monthly. We launch in Q4.' }] })
    expect(ok.status).toBe(200)
    expect(root.read(DOC)).toContain('member rate of 11%')
  })

  it('suggest-only (D39) refuses direct edits for the whole batch', async () => {
    await agent('POST', '/api/agent/policy', { file: DOC, suggestOnly: true })
    const st = (await agent('GET', `/api/agent/status?${q}`)).json as StatusResult
    const r = await agent('POST', `/api/agent/batch?${q}`, {
      ops: [{ op: 'comment', doc: true, body: 'fine' }, { op: 'delete_block', target: { ref: 'b1', rev: st.rev } }],
    })
    expect(r.status).toBe(403)
    expect((r.json as { error: { code: string; op?: number } }).error).toMatchObject({ code: 'SUGGEST_ONLY', op: 1 })
    expect((await t.request('POST', `/api/policy?${q}`, { suggestOnly: false })).status).toBe(200)
  })

  it('handoff: clipboard delivery, server round in the prompt, consumed by an ack (§8.5, §9.10, D46)', async () => {
    const h = await t.request('POST', `/api/handoff?${q}`, { opKey: opKey(), message: 'Tighten section 2', clientDecision: 'clipboard' })
    expect(h.status).toBe(200)
    expect(issues(S.HandoffResultSchema, h.json)).toEqual([])
    const hr = h.json as HandoffResult
    expect(hr.delivery).toBe('clipboard')
    expect(hr.coalesced).toBe(false)
    const store = await fake.store(DOC)
    const recs = await store.handoffs()
    expect(recs.at(-1)).toMatchObject({ seq: hr.seq, round: 1, consumed: false, message: 'Tighten section 2' })
    expect(hr.prompt).toBe(buildClipboardPrompt({ file: DOC, abs: store.abs, root: root.root, round: 1, counts: (await store.agent.pending()).counts }))
    // a second empty click coalesces into the unconsumed one
    const again = await t.request('POST', `/api/handoff?${q}`, { opKey: opKey(), clientDecision: 'waiter' })
    expect((again.json as HandoffResult).coalesced).toBe(true)
    const ack = await agent('POST', `/api/agent/batch?${q}`, { ops: [], ack: hr.seq })
    expect((ack.json as BatchResult).consumed).toEqual([hr.seq])
    expect((await store.handoffs({ unconsumed: true })).length).toBe(0)
  })

  it('a BOM + CRLF doc saves with a docHash expectHash (D40) and keeps its bytes outside the edit', async () => {
    const f = 'syn__bom-crlf.md'
    const fq = `file=${encodeURIComponent(f)}`
    const snap = (await t.request('GET', `/api/doc?${fq}`)).json as DocSnapshot
    expect(snap.bom).toBe(true)
    expect(snap.eol).toBe('\r\n')
    const next = snap.markdown.replace('Paragraph with', 'A paragraph with')
    const { ops, blockHashes, text } = await opsForText(snap.markdown, next)
    const c = await testCore()
    const save = await t.request('POST', `/api/save?${fq}`, {
      clientId: t.clientId, saveId: 7, base: { rev: snap.rev, hash: snap.hash, blockHashes }, ops,
      expectHash: c.docHash(text, true), cause: 'edit', allowPartial: true,
    })
    expect(save.status).toBe(200)
    const bytes = root.readBytes(f)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe(next)
  })

  it('threads: create, reply, resolve with schema-valid answers; read-marker range check', async () => {
    const snap = (await t.request('GET', `/api/doc?${q}`)).json as DocSnapshot
    const ct = await t.request('POST', `/api/threads?${q}`, { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: snap.rev, body: 'Doc-level note' })
    expect(issues(S.CreateThreadResponseSchema, ct.json)).toEqual([])
    const th = (ct.json as CreateThreadResponse).thread
    const rp = await t.request('POST', `/api/threads/${th.id}/replies?${q}`, { opKey: opKey(), body: 'Reply' })
    expect(issues(S.MessageResponseSchema, rp.json)).toEqual([])
    const rs = await t.request('POST', `/api/threads/${th.id}/resolve?${q}`, { opKey: opKey() })
    expect(issues(S.ThreadOpResponseSchema, rs.json)).toEqual([])
    const bad = await t.request('POST', `/api/read-marker?${q}`, { thread: null, upTo: 1_000_000 })
    expect((bad.json as { error: { code: string } }).error.code).toBe('ACK_OUT_OF_RANGE')
    const hist = await t.request('GET', `/api/history?${q}`)
    expect(issues(S.HistoryListSchema, hist.json)).toEqual([])
  })
})
