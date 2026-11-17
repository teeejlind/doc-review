// tests/contract/api.contract.test.ts (integrator, day 0; CONTRACTS §1.3, §2.5, §8).
//
// Every REST route and the browser SSE `hello`, validated against shared/schemas.ts. THE SAME SUITE runs against two
// targets over real HTTP on 127.0.0.1:
//   - fake: tests/fakes/fakeApp.ts (Hono over FakeDocStore), served with @hono/node-server. Always on: the fakes pass
//     the whole suite from day 0.
//   - real: P1's server/index.ts startServer, in-process. Gated by the milestones merged to main
//     (eslint.config.js MERGED_MILESTONES, appended by the integrator in each merge commit): health always, the read
//     half from M1, everything from M2 (§2.5 gates).
// Both targets get a fresh tmp root with copies of the committed fixtures. Requests carry exactly the §8.1 headers:
// browser routes X-MDR-Client: web + Authorization + (non-GET) the server's own Origin and X-MDR-Client-Id; agent
// routes X-MDR-Client: cli + X-MDR-Protocol: 2 + Authorization and no Origin.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ulid } from 'ulid'
import * as S from '../../shared/schemas'
import { ERROR_TABLE, PROTOCOL } from '../../shared/types'
import type {
  Anchor, BatchResult, BrowserSseEvent, ClientId, CreateThreadResponse, DocSnapshot, ErrorCode, MessageResponse, OpKey,
  ReviewState, SaveResponse, ThreadOpResponse,
} from '../../shared/types'
import { fixtureBytes, fixtureText } from '../fixtures/index'
import { readSse } from '../helpers/sse'
import { REPO_ROOT, tmpRoot, type TmpRoot } from '../helpers/tmpRoot'
import { opsForText, rawRequest, testCore } from '../helpers/webClient'
import { startFakeTarget } from './targets'

const DOC = 'basic.md'
const BOM_DOC = 'syn__bom-crlf.md'
const FIXTURES = [DOC, BOM_DOC, 'syn__duplicate-quotes.md']
/** §6.6 Bulk (P2 merge): two Claude records on one list block, so the second's base is gone once the first applies. */
const LIST_DOC = 'bulk-list.md'
const LIST_TEXT = '# Plan\n\n- Ship the explainer page\n- Draft the launch email\n- Book the review call\n\nClosing paragraph.\n'
const EXTRA_FILES = { 'notes.txt': 'not markdown\n', [LIST_DOC]: LIST_TEXT }

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')
const opKey = (): OpKey => `op_${ulid()}`
const clientId = (): ClientId => `k_${ulid()}`

// ---------------------------------------------------------------- milestone gating for the real server

function mergedMilestones(): string[] {
  const src = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8')
  const m = /export const MERGED_MILESTONES\s*=\s*\[([^\]]*)\]/.exec(src)
  if (!m) throw new Error('eslint.config.js: MERGED_MILESTONES not found')
  return [...m[1]!.matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]!)
}
const MERGED = new Set(mergedMilestones())

// ---------------------------------------------------------------- targets

export interface ApiTarget {
  name: 'fake' | 'real'
  root: TmpRoot
  port: number
  token: string
  close(): Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(port))
    })
  })
}

async function startRealTarget(): Promise<ApiTarget> {
  const root = tmpRoot({ name: 'api-contract-real', fixtures: FIXTURES, files: EXTRA_FILES })
  const port = await freePort()
  const { startServer } = await import('../../server/index')
  let s: Awaited<ReturnType<typeof startServer>>
  try {
    s = await startServer({ root: root.root, port, testHooks: true })
  } catch (e) {
    root.cleanup()
    throw e
  }
  return {
    name: 'real',
    root,
    port,
    token: s.marker.token,
    close: async () => {
      await s.close('stop')
      root.cleanup()
    },
  }
}

interface Scope {
  read: boolean
  write: boolean
}
const TARGETS: Array<{ name: 'fake' | 'real'; scope: Scope; start: () => Promise<ApiTarget> }> = [
  {
    name: 'fake',
    scope: { read: true, write: true },
    start: async () => {
      const root = tmpRoot({ name: 'api-contract-fake', fixtures: FIXTURES, files: EXTRA_FILES })
      try {
        const port = await freePort()
        const t = await startFakeTarget({ root: root.root, port })
        return { name: 'fake', root, port, token: t.token, close: async () => { await t.close(); root.cleanup() } }
      } catch (e) {
        root.cleanup()
        throw e
      }
    },
  },
  {
    name: 'real',
    scope: { read: MERGED.has('M1') || MERGED.has('M2'), write: MERGED.has('M2') },
    start: startRealTarget,
  },
]

// ---------------------------------------------------------------- the suite

for (const def of TARGETS) {
  describe(`API contract: ${def.name}`, () => {
    let t: ApiTarget
    let cid: ClientId
    beforeAll(async () => {
      t = await def.start()
      cid = clientId()
    }, 60_000)
    afterAll(async () => {
      await t?.close()
    })

    const origin = () => `http://127.0.0.1:${t.port}`
    const fq = (file = DOC) => `file=${encodeURIComponent(file)}`

    interface Res {
      status: number
      headers: Headers
      json: unknown
    }
    async function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
      const r = await fetch(origin() + path, {
        method,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      })
      const text = await r.text()
      let json: unknown = text
      try {
        json = text === '' ? undefined : JSON.parse(text)
      } catch {
        // keep the text
      }
      return { status: r.status, headers: r.headers, json }
    }
    const webHeaders = (method: string): Record<string, string> => ({
      'X-MDR-Client': 'web',
      Authorization: `Bearer ${t.token}`,
      ...(method === 'GET' ? {} : { Origin: origin(), 'X-MDR-Client-Id': cid }),
    })
    const agentHeaders = (): Record<string, string> => ({
      'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(PROTOCOL), Authorization: `Bearer ${t.token}`,
    })
    const web = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => send(method, path, webHeaders(method), body)
    const agent = (method: 'GET' | 'POST', path: string, body?: unknown) => send(method, path, agentHeaders(), body)

    function issues(schema: z.ZodType, v: unknown): string[] {
      const r = schema.safeParse(v)
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    }
    function ok<T>(r: Res, schema: z.ZodType): T {
      expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200)
      expect(r.headers.get('x-mdr-root-hash')).toBe(sha(t.root.root))
      expect(issues(schema, r.json)).toEqual([])
      return r.json as T
    }
    function err(r: Res, code: ErrorCode): { error: { code: ErrorCode; op?: number } ; current?: DocSnapshot; review?: ReviewState } {
      expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(ERROR_TABLE[code].http)
      expect(issues(S.ApiErrorSchema, r.json)).toEqual([])
      expect((r.json as { error: { code: string } }).error.code).toBe(code)
      expect(r.headers.get('x-mdr-root-hash')).toBe(sha(t.root.root))
      return r.json as { error: { code: ErrorCode } }
    }

    /** First SSE events of a stream until `stop` says so (or `limit` events). */
    async function sse(path: string, stop: (e: BrowserSseEvent[]) => boolean, during?: () => Promise<void>, timeoutMs = 10_000): Promise<{ status: number; events: BrowserSseEvent[] }> {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const events: BrowserSseEvent[] = []
      let status = 0
      try {
        const r = await fetch(origin() + path, { headers: { Origin: origin(), Accept: 'text/event-stream' }, signal: ac.signal })
        status = r.status
        if (!r.ok || !r.body) return { status, events }
        let started = false
        for await (const f of readSse(r.body, ac.signal)) {
          if (f.kind !== 'message') continue
          events.push({ event: f.message.event, data: JSON.parse(f.message.data) } as BrowserSseEvent)
          if (!started && during) {
            started = true
            void during()
          }
          if (stop(events)) break
        }
      } catch (e) {
        if (!ac.signal.aborted) throw e
      } finally {
        clearTimeout(timer)
        ac.abort()
      }
      return { status, events }
    }

    // =========================================================== health (every target, from M0)

    it('GET /api/health → Health, no token or client headers needed', async () => {
      const h = ok<{ root: string; rootHash: string; port: number; protocol: number }>(await send('GET', '/api/health', {}), S.HealthSchema)
      expect(h).toMatchObject({ root: t.root.root, rootHash: sha(t.root.root), port: t.port, protocol: PROTOCOL })
    })

    it('Host (§8.1 step 1, every request incl. health): anything but 127.0.0.1:<port> or localhost:<port> → MISDIRECTED', async () => {
      for (const host of [`evil.example:${t.port}`, `[::1]:${t.port}`, `127.0.0.1:${t.port + 1}`]) {
        const r = await rawRequest('127.0.0.1', t.port, 'GET', '/api/health', { headers: { Host: host } })
        expect(r.status, host).toBe(421)
        expect(issues(S.ApiErrorSchema, await r.json())).toEqual([])
      }
      const okHost = await rawRequest('127.0.0.1', t.port, 'GET', '/api/health', { headers: { Host: `localhost:${t.port}` } })
      expect(okHost.status).toBe(200)
    })

    // =========================================================== read half (M1 on the real server)

    describe.skipIf(!def.scope.read)('read routes', () => {
      it('GET /api/doc → DocSnapshot: decoded text, raw-byte hash, block map', async () => {
        const snap = ok<DocSnapshot>(await web('GET', `/api/doc?${fq()}`), S.DocSnapshotSchema)
        expect(snap).toMatchObject({ file: DOC, abs: t.root.path(DOC), markdown: fixtureText(DOC), bom: false, eol: '\n', readOnly: false })
        expect(snap.hash).toBe(sha(fixtureBytes(DOC)))
        expect(snap.size).toBe(fixtureBytes(DOC).length)
        expect(snap.blocks.length).toBeGreaterThan(0)
        expect(snap.blocks.map((b) => b.ref)).toEqual(snap.blocks.map((_, i) => `b${i + 1}`))
      })

      it('GET /api/doc on a BOM + CRLF file: bom true, eol CRLF, markdown without the BOM, hash over the raw bytes (D40)', async () => {
        const snap = ok<DocSnapshot>(await web('GET', `/api/doc?${fq(BOM_DOC)}`), S.DocSnapshotSchema)
        expect(snap).toMatchObject({ bom: true, eol: '\r\n', markdown: fixtureText(BOM_DOC) })
        expect(snap.markdown.charCodeAt(0)).not.toBe(0xfeff)
        expect(snap.hash).toBe(sha(fixtureBytes(BOM_DOC)))
      })

      it('GET /api/review → ReviewState, always 200, presence and activity overlaid', async () => {
        const r = ok<ReviewState>(await web('GET', `/api/review?${fq()}`), S.ReviewStateSchema)
        expect(r).toMatchObject({ ok: true, file: DOC, readOnly: false })
        expect(['connected', 'grace', 'turn', 'none']).toContain(r.presence.waiter)
      })

      it('GET /api/history → HistoryList', async () => {
        ok(await web('GET', `/api/history?${fq()}&limit=10`), S.HistoryListSchema)
      })

      it('file validation (§8.1 step 7): missing → FILE_NOT_FOUND, outside → PATH_OUTSIDE_ROOT, not .md → BAD_REQUEST', async () => {
        err(await web('GET', `/api/doc?${fq('nope.md')}`), 'FILE_NOT_FOUND')
        err(await web('GET', `/api/doc?${fq('../outside.md')}`), 'PATH_OUTSIDE_ROOT')
        err(await web('GET', `/api/doc?${fq('notes.txt')}`), 'BAD_REQUEST')
        err(await web('GET', `/api/review?${fq('nope.md')}`), 'FILE_NOT_FOUND')
      })

      it('token (§8.1 step 5): missing or wrong → UNAUTHORIZED on browser and agent routes; never a default actor', async () => {
        err(await send('GET', `/api/doc?${fq()}`, { 'X-MDR-Client': 'web' }), 'UNAUTHORIZED')
        err(await send('GET', `/api/doc?${fq()}`, { 'X-MDR-Client': 'web', Authorization: 'Bearer wrong' }), 'UNAUTHORIZED')
        err(await send('GET', `/api/agent/status?${fq()}`, { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': '2' }), 'UNAUTHORIZED')
      })

      it('agent routes (§8.1 step 4): an Origin → FORBIDDEN_ORIGIN; protocol ≠ 2 → PROTOCOL_MISMATCH', async () => {
        err(await send('GET', `/api/agent/status?${fq()}`, { ...agentHeaders(), Origin: origin() }), 'FORBIDDEN_ORIGIN')
        err(await send('GET', `/api/agent/status?${fq()}`, { ...agentHeaders(), 'X-MDR-Protocol': '1' }), 'PROTOCOL_MISMATCH')
      })

      it('GET /api/agent/status → StatusResult (via server)', async () => {
        const s = ok<{ via: string; file: string; server: { state: string } }>(await agent('GET', `/api/agent/status?${fq()}`), S.StatusResultSchema)
        expect(s).toMatchObject({ via: 'server', file: DOC, server: { state: 'up' } })
      })

      it('GET /api/agent/snapshot?md=1 → AgentSnapshot with block markdown', async () => {
        const s = ok<{ blocks: Array<{ md?: string; ref: string }> }>(await agent('GET', `/api/agent/snapshot?${fq()}&md=1`), S.AgentSnapshotSchema)
        expect(s.blocks.length).toBeGreaterThan(0)
        expect(s.blocks.every((b) => typeof b.md === 'string')).toBe(true)
        const all = s.blocks.map((b) => b.md).join('')
        expect(fixtureText(DOC).replace(/\s+/g, '')).toContain(all.replace(/\s+/g, '').slice(0, 20))
      })

      it('GET /api/agent/pending → PendingResult; GET /api/agent/thread for an unknown id → THREAD_NOT_FOUND', async () => {
        ok(await agent('GET', `/api/agent/pending?${fq()}`), S.PendingResultSchema)
        err(await agent('GET', `/api/agent/thread?${fq()}&id=t_${ulid()}`), 'THREAD_NOT_FOUND')
      })

      it('GET /api/agent/history → HistoryList', async () => {
        ok(await agent('GET', `/api/agent/history?${fq()}&limit=5`), S.HistoryListSchema)
      })

      it('GET /api/events?file= → a `hello` first (§8.6), valid BrowserSseEvent', async () => {
        const q = new URLSearchParams({ file: DOC, clientId: cid, t: t.token })
        const { status, events } = await sse(`/api/events?${q.toString()}`, (e) => e.length >= 1)
        expect(status).toBe(200)
        expect(events[0]?.event).toBe('hello')
        expect(issues(S.BrowserSseEventSchema, events[0])).toEqual([])
        expect(events[0]).toMatchObject({ data: { file: DOC, protocol: PROTOCOL } })
      })

      it('GET /api/events without a token → UNAUTHORIZED', async () => {
        const r = await fetch(`${origin()}/api/events?${new URLSearchParams({ file: DOC, clientId: cid }).toString()}`)
        expect(r.status).toBe(401)
        await r.body?.cancel()
      })
    })

    // =========================================================== write half (M2 on the real server)

    describe.skipIf(!def.scope.write)('write routes', () => {
      it('browser non-GET (§8.1 step 3): no Origin or a foreign one → FORBIDDEN_ORIGIN; no client id → BAD_REQUEST', async () => {
        const body = { thread: null, upTo: 0 }
        const base = { 'X-MDR-Client': 'web', Authorization: `Bearer ${t.token}`, 'X-MDR-Client-Id': cid }
        err(await send('POST', `/api/read-marker?${fq()}`, base, body), 'FORBIDDEN_ORIGIN')
        err(await send('POST', `/api/read-marker?${fq()}`, { ...base, Origin: 'http://evil.example' }, body), 'FORBIDDEN_ORIGIN')
        err(await send('POST', `/api/read-marker?${fq()}`, { ...base, Origin: `http://127.0.0.1:${t.port + 1}` }, body), 'FORBIDDEN_ORIGIN')
        err(await send('POST', `/api/read-marker?${fq()}`, { 'X-MDR-Client': 'web', Authorization: `Bearer ${t.token}`, Origin: origin() }, body), 'BAD_REQUEST')
        // localhost:<port> is on the allow-list (D13)
        const lh = await send('POST', `/api/read-marker?${fq()}`, { ...base, Origin: `http://localhost:${t.port}` }, body)
        expect(lh.status).toBe(200)
      })

      it('identity in the body (§8.1 step 6) → IDENTITY_IN_BODY', async () => {
        for (const key of ['by', 'author', 'actor']) {
          err(await web('POST', `/api/threads?${fq()}`, { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x', [key]: 'Claude' }), 'IDENTITY_IN_BODY')
        }
        err(await agent('POST', `/api/agent/batch?${fq()}`, { ops: [], by: 'TJ' }), 'IDENTITY_IN_BODY')
      })

      it('thread lifecycle: create (idempotent by opKey), reply, edit, resolve, reopen, delete', async () => {
        const k = opKey()
        const req = { opKey: k, anchor: { kind: 'doc' } as Anchor, anchorRev: 0, body: 'A whole-doc note.' }
        const c1 = ok<CreateThreadResponse>(await web('POST', `/api/threads?${fq()}`, req), S.CreateThreadResponseSchema)
        expect(c1.thread).toMatchObject({ kind: 'doc', status: 'open', createdBy: 'TJ' })
        const c2 = ok<CreateThreadResponse>(await web('POST', `/api/threads?${fq()}`, req), S.CreateThreadResponseSchema)
        expect(c2.duplicate).toBe(true)
        expect(c2.thread.id).toBe(c1.thread.id)
        const id = c1.thread.id
        const rep = ok<MessageResponse>(await web('POST', `/api/threads/${id}/replies?${fq()}`, { opKey: opKey(), body: 'Second thought.' }), S.MessageResponseSchema)
        expect(rep.message).toMatchObject({ by: 'TJ', body: 'Second thought.' })
        const ed = ok<MessageResponse>(await web('PATCH', `/api/comments/${rep.message.id}?${fq()}`, { opKey: opKey(), body: 'Edited.' }), S.MessageResponseSchema)
        expect(ed.message.body).toBe('Edited.')
        const res = ok<ThreadOpResponse>(await web('POST', `/api/threads/${id}/resolve?${fq()}`, { opKey: opKey() }), S.ThreadOpResponseSchema)
        expect(res.thread.status).toBe('resolved')
        const reo = ok<ThreadOpResponse>(await web('POST', `/api/threads/${id}/reopen?${fq()}`, { opKey: opKey() }), S.ThreadOpResponseSchema)
        expect(reo.thread.status).toBe('open')
        ok(await web('POST', `/api/comments/${rep.message.id}/delete?${fq()}`, { opKey: opKey() }), S.SeqResponseSchema)
        const review = ok<ReviewState>(await web('GET', `/api/review?${fq()}`), S.ReviewStateSchema)
        expect(review.threads.find((x) => x.id === id)?.messages.find((m) => m.id === rep.message.id)).toMatchObject({ deleted: true })
        err(await web('POST', `/api/threads/t_${ulid()}/replies?${fq()}`, { opKey: opKey(), body: 'x' }), 'THREAD_NOT_FOUND')
        err(await web('POST', `/api/threads?${fq()}`, { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: '   ' }), 'BAD_REQUEST')
      })

      it('a text-anchored thread round-trips its anchor (created with core, §5.2)', async () => {
        const snap = ok<DocSnapshot>(await web('GET', `/api/doc?${fq()}`), S.DocSnapshotSchema)
        const c = await testCore()
        const L = c.load(c.md, snap.markdown)
        const { ptextOf } = await import('../../core/ptext')
        const { createAnchor } = await import('../../core/anchors')
        const p = ptextOf(L.doc, L)
        const word = p.text.split(/\s+/).find((w) => w.length >= 5)!
        const from = p.text.indexOf(word)
        const anchor = createAnchor(p, L.blocks, from, from + word.length, snap.rev)
        const r = ok<CreateThreadResponse>(await web('POST', `/api/threads?${fq()}`, { opKey: opKey(), anchor, anchorRev: snap.rev, body: 'On this word.' }), S.CreateThreadResponseSchema)
        expect(r.thread.anchor).toEqual(anchor)
        expect(r.thread.kind).toBe('comment')
      })

      it('POST /api/save: a one-word edit applies direct with the client hash; a retry is a duplicate; a stale strict save is 409 with current + review', async () => {
        const snap = ok<DocSnapshot>(await web('GET', `/api/doc?${fq()}`), S.DocSnapshotSchema)
        const word = snap.markdown.split(/\s+/).find((w) => /^[A-Za-z]{4,}$/.test(w))!
        const next = snap.markdown.replace(word, `${word}x`)
        const { ops, blockHashes, text } = await opsForText(snap.markdown, next)
        expect(text).toBe(next)
        const c = await testCore()
        const req = {
          clientId: cid, saveId: 1, base: { rev: snap.rev, hash: snap.hash, blockHashes }, ops,
          expectHash: c.docHash(next, snap.bom), cause: 'edit', allowPartial: true,
        }
        expect(issues(S.SaveRequestSchema, req)).toEqual([])
        const r1 = ok<SaveResponse>(await web('POST', `/api/save?${fq()}`, req), S.SaveResponseSchema)
        expect(r1).toMatchObject({ applied: 'direct', hash: c.docHash(next, snap.bom), conflicts: [], unsaveable: [] })
        expect(r1.rev).toBeGreaterThan(snap.rev)
        const after = ok<DocSnapshot>(await web('GET', `/api/doc?${fq()}`), S.DocSnapshotSchema)
        expect(after).toMatchObject({ markdown: next, rev: r1.rev, hash: r1.hash })
        const r2 = ok<SaveResponse>(await web('POST', `/api/save?${fq()}`, req), S.SaveResponseSchema)
        expect(r2.applied).toBe('duplicate')
        // the same edit again against the old base, strict: the block changed on disk since base → 409
        const stale = await web('POST', `/api/save?${fq()}`, {
          ...req, saveId: 2, ops: (await opsForText(snap.markdown, snap.markdown.replace(word, `${word}y`))).ops,
          expectHash: c.docHash(snap.markdown.replace(word, `${word}y`), snap.bom), allowPartial: false,
        })
        expect([409]).toContain(stale.status)
        const e = err(stale, (stale.json as { error: { code: ErrorCode } }).error.code)
        expect(['STALE_REVISION', 'CONFLICT']).toContain(e.error.code)
        expect(issues(S.DocSnapshotSchema, e.current)).toEqual([])
        expect(issues(S.ReviewStateSchema, e.review)).toEqual([])
      })

      it('agent batch: comment and suggest by quote; TJ accepts (idempotent); the opposite decision is SUGGESTION_CLOSED', async () => {
        const snap = ok<DocSnapshot>(await web('GET', `/api/doc?${fq()}`), S.DocSnapshotSchema)
        const words = snap.markdown.split(/\s+/).filter((w) => /^[A-Za-z]{5,}$/.test(w))
        const unique = words.find((w) => snap.markdown.split(w).length === 2)!
        const b1 = ok<BatchResult>(await agent('POST', `/api/agent/batch?${fq()}`, { ops: [{ op: 'comment', quote: unique, body: 'Why this word?' }] }), S.BatchResultSchema)
        expect(b1).toMatchObject({ via: 'server', file: DOC, noop: false })
        expect(b1.results[0]).toMatchObject({ i: 0, op: 'comment' })
        expect(b1.results[0]!.thread).toMatch(/^t_/)
        const b2 = ok<BatchResult>(await agent('POST', `/api/agent/batch?${fq()}`, { ops: [{ op: 'suggest', quote: unique, replace: unique.toUpperCase(), reason: 'Shout it.' }] }), S.BatchResultSchema)
        const sid = b2.results[0]!.suggestion!
        expect(sid).toMatch(/^s_/)
        const rv = ok<ReviewState>(await web('GET', `/api/review?${fq()}`), S.ReviewStateSchema)
        expect(rv.suggestions.find((s) => s.id === sid)).toMatchObject({ by: 'Claude', status: 'pending' })
        const a1 = ok(await web('POST', `/api/suggestions/${sid}/accept?${fq()}`, { opKey: opKey() }), S.DecisionResultSchema)
        expect(a1).toMatchObject({ suggestion: sid, status: 'accepted' })
        const doc2 = ok<DocSnapshot>(await web('GET', `/api/doc?${fq()}`), S.DocSnapshotSchema)
        expect(doc2.markdown).toContain(unique.toUpperCase())
        const a2 = ok(await web('POST', `/api/suggestions/${sid}/accept?${fq()}`, { opKey: opKey() }), S.DecisionResultSchema)
        expect(a2).toMatchObject({ duplicate: true })
        err(await web('POST', `/api/suggestions/${sid}/reject?${fq()}`, { opKey: opKey() }), 'SUGGESTION_CLOSED')
        err(await web('POST', `/api/suggestions/s_${ulid()}/accept?${fq()}`, { opKey: opKey() }), 'SUGGESTION_NOT_FOUND')
      })

      it('agent batch errors carry error.op; QUOTE_NOT_FOUND and QUOTE_AMBIGUOUS (with candidates)', async () => {
        const nf = err(await agent('POST', `/api/agent/batch?${fq()}`, { ops: [{ op: 'comment', quote: 'zzz-not-in-the-doc-zzz', body: 'x' }] }), 'QUOTE_NOT_FOUND')
        expect(nf.error.op).toBe(0)
        const dup = 'syn__duplicate-quotes.md'
        const text = fixtureText(dup)
        const words = text.split(/\s+/).filter((w) => /^[A-Za-z]{4,}$/.test(w))
        const twice = words.find((w) => text.split(w).length - 1 >= 2)!
        const amb = err(await agent('POST', `/api/agent/batch?${fq(dup)}`, { ops: [{ op: 'comment', quote: twice, body: 'x' }] }), 'QUOTE_AMBIGUOUS')
        expect(amb.error.op).toBe(0)
        expect(((amb as unknown as { error: { candidates: unknown[] } }).error.candidates ?? []).length).toBeGreaterThanOrEqual(2)
      })

      it('bulk reject → BulkDecisionResult; policy → SeqResponse and SUGGEST_ONLY on a Claude direct edit; agent policy', async () => {
        const snap = ok<DocSnapshot>(await web('GET', `/api/doc?${fq()}`), S.DocSnapshotSchema)
        const words = snap.markdown.split(/\s+/).filter((w) => /^[a-z]{4,}$/.test(w))
        const unique = words.find((w) => snap.markdown.split(w).length === 2)!
        ok(await agent('POST', `/api/agent/batch?${fq()}`, { ops: [{ op: 'suggest', quote: unique, replace: `${unique}!` }] }), S.BatchResultSchema)
        const bulk = ok<{ results: Array<{ ok: boolean }> }>(await web('POST', `/api/suggestions/bulk?${fq()}`, { opKey: opKey(), decision: 'reject', authors: ['Claude'] }), S.BulkDecisionResultSchema)
        expect(bulk.results.length).toBeGreaterThanOrEqual(1)
        expect(bulk.results.every((r) => r.ok)).toBe(true)

        ok(await web('POST', `/api/policy?${fq()}`, { suggestOnly: true }), S.SeqResponseSchema)
        const rv = ok<ReviewState>(await web('GET', `/api/review?${fq()}`), S.ReviewStateSchema)
        expect(rv.policy).toEqual({ suggestOnly: true })
        const first = ok<{ blocks: Array<{ ref: string }>; rev: number }>(await agent('GET', `/api/agent/snapshot?${fq()}`), S.AgentSnapshotSchema)
        err(await agent('POST', `/api/agent/batch?${fq()}`, { ops: [{ op: 'replace_block', target: { ref: first.blocks[0]!.ref, rev: first.rev }, markdown: '# Replaced' }] }), 'SUGGEST_ONLY')
        const ap = await agent('POST', '/api/agent/policy', { file: DOC, suggestOnly: false })
        expect(ap.status).toBe(200)
        expect(ap.json).toMatchObject({ ok: true, suggestOnly: false })
        expect(typeof (ap.json as { seq: unknown }).seq).toBe('number')
      })

      it('bulk accept of two records on one block (§6.6, P2 merge): the second is rebased onto the first, one commit; the bulk reopen restores the bytes', async () => {
        const f = fq(LIST_DOC)
        // two batches: one batch may not suggest twice on a block (BATCH_SELF_CONFLICT)
        const ids = []
        for (const [quote, replace] of [['explainer', 'EXPLAINER'], ['launch', 'LAUNCH']] as const) {
          const b = ok<BatchResult>(await agent('POST', `/api/agent/batch?${f}`, { ops: [{ op: 'suggest', quote, replace }] }), S.BatchResultSchema)
          ids.push(b.results[0]!.suggestion!)
        }
        expect(ids).toHaveLength(2)
        const before = ok<DocSnapshot>(await web('GET', `/api/doc?${f}`), S.DocSnapshotSchema)
        expect(before.markdown).toBe(LIST_TEXT)
        const acc = ok<{ rev: number; results: Array<{ id: string; ok: boolean; code?: string }> }>(
          await web('POST', `/api/suggestions/bulk?${f}`, { opKey: opKey(), decision: 'accept', authors: ['TJ', 'Claude'], ids }), S.BulkDecisionResultSchema)
        expect(acc.results).toEqual(ids.map((id) => ({ id, ok: true })))
        expect(acc.rev).toBe(before.rev + 1)
        const after = ok<DocSnapshot>(await web('GET', `/api/doc?${f}`), S.DocSnapshotSchema)
        expect(after.markdown).toBe(LIST_TEXT.replace('explainer', 'EXPLAINER').replace('launch', 'LAUNCH'))
        const rv = ok<ReviewState>(await web('GET', `/api/review?${f}`), S.ReviewStateSchema)
        expect(ids.map((id) => rv.suggestions.find((s) => s.id === id)?.status)).toEqual(['accepted', 'accepted'])
        // D26: one atomic undo of both, back to the original bytes; both records pending again
        ok(await web('POST', `/api/suggestions/bulk?${f}`, { opKey: opKey(), decision: 'reopen', authors: [], ids }), S.BulkDecisionResultSchema)
        const undone = ok<DocSnapshot>(await web('GET', `/api/doc?${f}`), S.DocSnapshotSchema)
        expect(undone.markdown).toBe(LIST_TEXT)
        const rv2 = ok<ReviewState>(await web('GET', `/api/review?${f}`), S.ReviewStateSchema)
        expect(ids.map((id) => rv2.suggestions.find((s) => s.id === id)?.status)).toEqual(['pending', 'pending'])
        // redo: the same bulk again writes both once more
        const redo = ok<{ results: Array<{ id: string; ok: boolean }> }>(
          await web('POST', `/api/suggestions/bulk?${f}`, { opKey: opKey(), decision: 'accept', authors: ['TJ', 'Claude'], ids }), S.BulkDecisionResultSchema)
        expect(redo.results).toEqual(ids.map((id) => ({ id, ok: true })))
        expect(ok<DocSnapshot>(await web('GET', `/api/doc?${f}`), S.DocSnapshotSchema).markdown).toBe(after.markdown)
      })

      it('read marker → SeqResponse; upTo beyond the log → ACK_OUT_OF_RANGE', async () => {
        const rv = ok<ReviewState>(await web('GET', `/api/review?${fq()}`), S.ReviewStateSchema)
        ok(await web('POST', `/api/read-marker?${fq()}`, { thread: null, upTo: rv.seq }), S.SeqResponseSchema)
        err(await web('POST', `/api/read-marker?${fq()}`, { thread: null, upTo: rv.seq + 1000 }), 'ACK_OUT_OF_RANGE')
      })

      it('handoff with clientDecision clipboard → HandoffResult delivery clipboard and a pointer-only prompt; flush → { ok: true }', async () => {
        const h = ok<{ delivery: string; prompt: string }>(await web('POST', `/api/handoff?${fq()}`, { opKey: opKey(), clientDecision: 'clipboard' }), S.HandoffResultSchema)
        expect(h.delivery).toBe('clipboard')
        expect(h.prompt).toContain('mdr pending')
        const f = await web('POST', `/api/flush?${fq()}`, { clientId: cid, reason: 'beacon' })
        expect(f.status).toBe(200)
        expect(f.json).toEqual({ ok: true })
      })

      it('POST /api/agent/open → { ok, connectedTabs, navigated }', async () => {
        const r = await agent('POST', '/api/agent/open', { file: DOC })
        expect(r.status).toBe(200)
        expect(r.json).toMatchObject({ ok: true })
        expect(typeof (r.json as { connectedTabs: unknown }).connectedTabs).toBe('number')
        expect(typeof (r.json as { navigated: unknown }).navigated).toBe('boolean')
      })

      it('SSE: a browser write emits sidecar-changed carrying that request\'s client id (D32 echo)', async () => {
        const q = new URLSearchParams({ file: DOC, clientId: cid, t: t.token })
        const { events } = await sse(
          `/api/events?${q.toString()}`,
          (e) => e.some((x) => x.event === 'sidecar-changed'),
          async () => {
            await web('POST', `/api/threads?${fq()}`, { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'Echo me.' })
          },
        )
        const sc = events.find((e) => e.event === 'sidecar-changed')
        expect(sc, JSON.stringify(events)).toBeDefined()
        expect(issues(S.BrowserSseEventSchema, sc)).toEqual([])
        expect(sc).toMatchObject({ data: { file: DOC, clientId: cid } })
        for (const e of events) expect(issues(S.BrowserSseEventSchema, e)).toEqual([])
      })
    })
  })
}
