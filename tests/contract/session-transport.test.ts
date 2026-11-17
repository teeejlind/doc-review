// @vitest-environment jsdom
// tests/contract/session-transport.test.ts (integrator, day 0; CONTRACTS §12.0.5, §12.0.3, §8.3, §8.6, D32, D43).
//
// Two halves, both over tests/fakes/MockTransport.ts (in-process, over fakeApp):
//   A. MockTransport itself implements `Transport` (types.ts) faithfully: it adds X-MDR-Client, Authorization and (on
//      non-GET) X-MDR-Client-Id itself, returns non-2xx answers as { status, json } without throwing, and its
//      `events()` is a live EventSourceLike on the fake's SSE hub. Runs from day 0.
//   B. P2's real session (web/src/session/index.ts) over a recording MockTransport: origin-relative paths only, the
//      right routes for every DocSession call, a live SSE channel that brings foreign writes in, close() closes it.
//      P2's deliverable (§14 P2) is that this half passes; it switches itself on when P2 replaces the day-0 stub
//      (the `DAY0-STUB` marker leaves web/src/session/index.ts), so it can never silently pass on the stub.
// A mismatch between P2's session and the fake is a change request against the fake (§12.0.5), never a P2 edit to it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ulid } from 'ulid'
import * as S from '../../shared/schemas'
import { ID_RE } from '../../shared/ids'
import type {
  BrowserSseEvent, DocSession, DocSnapshot, EventSourceLike, OpKey, ReviewState, SessionEvent, Transport,
} from '../../shared/types'
import { REPO_ROOT, tmpRoot, type TmpRoot } from '../helpers/tmpRoot'
import { fakeSessionFixture, type FakeSessionFixture } from './targets'

const DOC = 'basic.md'
const P2_SESSION = join(REPO_ROOT, 'web', 'src', 'session', 'index.ts')
const P2_LANDED = !/^\s*\/\/\s*DAY0-STUB\b/m.test(readFileSync(P2_SESSION, 'utf8'))

const opKey = (): OpKey => `op_${ulid()}`
function issues(schema: z.ZodType, v: unknown): string[] {
  const r = schema.safeParse(v)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
}
const until = async (cond: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Wraps a Transport, recording every request and stream (and whether each stream was closed). */
interface Recorded {
  requests: Array<{ method: string; path: string; body: unknown; keepalive: boolean }>
  streams: Array<{ path: string; closed: boolean }>
}
function recording(inner: Transport): { transport: Transport; log: Recorded } {
  const log: Recorded = { requests: [], streams: [] }
  const transport: Transport = {
    request(method, path, body, o) {
      log.requests.push({ method, path, body, keepalive: o?.keepalive === true })
      return inner.request(method, path, body, o)
    },
    events(pathWithQuery) {
      const rec = { path: pathWithQuery, closed: false }
      log.streams.push(rec)
      const es = inner.events(pathWithQuery)
      const wrapped: EventSourceLike = {
        addEventListener: (type, cb) => es.addEventListener(type, cb),
        close: () => {
          rec.closed = true
          es.close()
        },
        get onerror() {
          return es.onerror
        },
        set onerror(v) {
          es.onerror = v
        },
      }
      return wrapped
    },
  }
  return { transport, log }
}

/** Collect SSE events of the given types from an EventSourceLike. */
function collect(es: EventSourceLike, types: readonly BrowserSseEvent['event'][]): BrowserSseEvent[] {
  const out: BrowserSseEvent[] = []
  for (const type of types) es.addEventListener(type, (e) => out.push({ event: type, data: JSON.parse(e.data) } as BrowserSseEvent))
  return out
}

// =====================================================================================
// A. MockTransport implements Transport
// =====================================================================================

describe('MockTransport implements Transport over fakeApp (§12.0.5)', () => {
  let root: TmpRoot
  let fx: FakeSessionFixture
  beforeAll(async () => {
    root = tmpRoot({ name: 'session-transport-a', fixtures: [DOC] })
    fx = await fakeSessionFixture({ root: root.root, file: DOC })
  })
  afterAll(async () => {
    await fx?.close()
    root?.cleanup()
  })

  it('GET /api/doc and /api/review answer 200 with valid bodies (auth added by the transport)', async () => {
    const t = fx.transport()
    const doc = await t.request('GET', `/api/doc?file=${encodeURIComponent(DOC)}`)
    expect(doc.status).toBe(200)
    expect(issues(S.DocSnapshotSchema, doc.json)).toEqual([])
    expect((doc.json as DocSnapshot).file).toBe(DOC)
    const review = await t.request('GET', `/api/review?file=${encodeURIComponent(DOC)}`)
    expect(review.status).toBe(200)
    expect(issues(S.ReviewStateSchema, review.json)).toEqual([])
  })

  it('a non-GET request passes the browser-route checks (Origin and X-MDR-Client-Id added by the transport)', async () => {
    const t = fx.transport()
    const r = await t.request('POST', `/api/threads?file=${encodeURIComponent(DOC)}`, { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'Via the transport.' })
    expect(r.status).toBe(200)
    expect(issues(S.CreateThreadResponseSchema, r.json)).toEqual([])
  })

  it('a non-2xx answer resolves as { status, json: ApiError }, never throws', async () => {
    const t = fx.transport()
    const r = await t.request('GET', '/api/doc?file=nope.md')
    expect(r.status).toBe(404)
    expect(issues(S.ApiErrorSchema, r.json)).toEqual([])
    expect((r.json as { error: { code: string } }).error.code).toBe('FILE_NOT_FOUND')
  })

  it('events() is live: hello first, then sidecar-changed for a write made through another client, with no client id', async () => {
    const t = fx.transport()
    const es = t.events(`/api/events?${new URLSearchParams({ file: DOC, clientId: fx.clientId, t: fx.token }).toString()}`)
    const got = collect(es, ['hello', 'sidecar-changed', 'doc-changed'])
    try {
      await until(() => got.some((e) => e.event === 'hello'), 5_000, 'hello')
      expect(issues(S.BrowserSseEventSchema, got[0])).toEqual([])
      await fx.agentComment('A Claude note.')
      await until(() => got.some((e) => e.event === 'sidecar-changed'), 5_000, 'sidecar-changed')
      const sc = got.find((e) => e.event === 'sidecar-changed')!
      expect(issues(S.BrowserSseEventSchema, sc)).toEqual([])
      expect((sc.data as { clientId?: string }).clientId).toBeUndefined()
    } finally {
      es.close()
    }
  })

  it('a write through the transport echoes its own X-MDR-Client-Id on sidecar-changed (D32)', async () => {
    const t = fx.transport()
    const es = t.events(`/api/events?${new URLSearchParams({ file: DOC, clientId: fx.clientId, t: fx.token }).toString()}`)
    const got = collect(es, ['hello', 'sidecar-changed'])
    try {
      await until(() => got.some((e) => e.event === 'hello'), 5_000, 'hello')
      const r = await t.request('POST', `/api/threads?file=${encodeURIComponent(DOC)}`, { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'Echo.' })
      expect(r.status).toBe(200)
      await until(() => got.some((e) => e.event === 'sidecar-changed'), 5_000, 'sidecar-changed')
      expect(got.find((e) => e.event === 'sidecar-changed')).toMatchObject({ data: { clientId: fx.clientId } })
    } finally {
      es.close()
    }
  })
})

// =====================================================================================
// B. P2's session over MockTransport
// =====================================================================================

describe.skipIf(!P2_LANDED)("P2's session over MockTransport (§12.0.5; on once P2 replaces the day-0 stub)", () => {
  let root: TmpRoot
  let fx: FakeSessionFixture
  let session: DocSession
  let log: Recorded
  const events: SessionEvent[] = []

  beforeAll(async () => {
    root = tmpRoot({ name: 'session-transport-b', fixtures: [DOC] })
    fx = await fakeSessionFixture({ root: root.root, file: DOC })
    const rec = recording(fx.transport())
    log = rec.log
    const { openDocSession } = await import('../../web/src/session/index')
    session = await openDocSession({ boot: fx.boot, file: DOC, transport: rec.transport })
    session.subscribe((what) => events.push(what))
  }, 60_000)
  afterAll(async () => {
    await fx?.close()
    root?.cleanup()
  })

  it('opens with GET /api/doc and /api/review and one SSE stream on /api/events with file and clientId', () => {
    const paths = log.requests.filter((r) => r.method === 'GET').map((r) => r.path.split('?')[0])
    expect(paths).toContain('/api/doc')
    expect(paths).toContain('/api/review')
    expect(log.streams.length).toBeGreaterThanOrEqual(1)
    const q = new URLSearchParams(log.streams[0]!.path.split('?')[1] ?? '')
    expect(log.streams[0]!.path.startsWith('/api/events?')).toBe(true)
    expect(q.get('file')).toBe(DOC)
    expect(q.get('clientId') ?? '').toMatch(ID_RE.clientId)
  })

  it('exposes the snapshot and review it fetched; save state starts saved', async () => {
    const doc = await fx.transport().request('GET', `/api/doc?file=${encodeURIComponent(DOC)}`)
    expect(session.getSnapshot()).toEqual(doc.json)
    expect(session.file).toBe(DOC)
    expect(session.root).toBe(fx.boot.root)
    expect(issues(S.ReviewStateSchema, session.getReview())).toEqual([])
    expect(session.getSaveState().state).toBe('saved')
    expect(session.getBanner()).toBeNull()
  })

  it('maps thread calls to their routes with fresh op_ keys', async () => {
    const c = await session.createThread({ kind: 'doc' }, 'From the session.')
    expect(issues(S.CreateThreadResponseSchema, c)).toEqual([])
    const id = c.thread.id
    const m = await session.reply(id, 'A reply.')
    await session.editComment(m.message.id, 'Edited reply.')
    await session.resolve(id)
    await session.reopen(id)
    await session.deleteComment(m.message.id)
    const posts = log.requests.filter((r) => r.method !== 'GET')
    const route = (re: RegExp) => posts.find((r) => re.test(r.path.split('?')[0]!))
    expect(route(/^\/api\/threads$/)?.method).toBe('POST')
    expect(route(new RegExp(`^/api/threads/${id}/replies$`))?.method).toBe('POST')
    expect(route(new RegExp(`^/api/comments/${m.message.id}$`))?.method).toBe('PATCH')
    expect(route(new RegExp(`^/api/threads/${id}/resolve$`))?.method).toBe('POST')
    expect(route(new RegExp(`^/api/threads/${id}/reopen$`))?.method).toBe('POST')
    expect(route(new RegExp(`^/api/comments/${m.message.id}/delete$`))?.method).toBe('POST')
    for (const p of posts) {
      const k = (p.body as { opKey?: string } | undefined)?.opKey
      if (k !== undefined) expect(k).toMatch(ID_RE.opKey)
    }
    await until(() => session.getReview().threads.some((t) => t.id === id), 5_000, 'review refresh')
  })

  it('setPolicy → POST /api/policy; history.list → GET /api/history', async () => {
    await session.setPolicy({ suggestOnly: true })
    expect(log.requests.find((r) => r.path.startsWith('/api/policy?'))).toMatchObject({ method: 'POST', body: { suggestOnly: true } })
    const h = await session.history.list()
    expect(issues(S.HistoryListSchema, h)).toEqual([])
    expect(log.requests.some((r) => r.method === 'GET' && r.path.startsWith('/api/history?'))).toBe(true)
    await session.setPolicy({ suggestOnly: false })
  })

  it('a foreign write arrives over SSE: subscribers hear "review" and getReview() holds it', async () => {
    const before = session.getReview().seq
    const seen = events.length
    await fx.agentComment('Claude wrote this from the CLI.')
    await until(() => session.getReview().seq > before, 5_000, 'foreign review refresh')
    expect(events.slice(seen)).toContain('review')
    expect(session.getReview().threads.some((t) => t.messages.some((m) => m.body === 'Claude wrote this from the CLI.'))).toBe(true)
  })

  it('handoff → POST /api/handoff and a HandoffOutcome', async () => {
    const out = await session.handoff('Over to you.')
    expect(issues(S.HandoffOutcomeSchema, out)).toEqual([])
    expect(log.requests.find((r) => r.path.startsWith('/api/handoff?'))).toMatchObject({ method: 'POST' })
  })

  it('flush() resolves with the current rev when clean', async () => {
    const r = await session.flush()
    expect(r.rev).toBe(session.getSnapshot().rev)
  })

  it('every request is origin-relative: a path, never a scheme or host (D43)', () => {
    for (const p of [...log.requests.map((r) => r.path), ...log.streams.map((s) => s.path)]) {
      expect(p.startsWith('/'), p).toBe(true)
      expect(p.startsWith('//'), p).toBe(false)
      expect(p).not.toMatch(/^[a-z][a-z0-9+.-]*:/i)
    }
  })

  it('close() closes the SSE stream', async () => {
    await session.close()
    expect(log.streams.every((s) => s.closed)).toBe(true)
  })

  it('the snapshot and review shapes never drift from the schemas', () => {
    expect(issues(S.DocSnapshotSchema, session.getSnapshot() as DocSnapshot)).toEqual([])
    expect(issues(S.ReviewStateSchema, session.getReview() as ReviewState)).toEqual([])
  })
})
