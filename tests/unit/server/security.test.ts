// tests/unit/server/security.test.ts (P1). The §8.1 middleware on the real server (CONTRACTS §8.1, D4, D13, D32, D43):
// the Host × Origin matrix for GET, POST and /api/events; 421 / 401 / 403 / 426 / IDENTITY_IN_BODY; X-MDR-Client and
// X-MDR-Client-Id; body size and JSON; /__test/* behind the browser checks and mounted only under test hooks;
// X-MDR-Root-Hash on every response; the dev-origin allow-list.
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import { allowedOrigins, MAX_BODY_BYTES } from '../../../server/security'
import { rawRequest } from '../../helpers/webClient'
import { clientId, startSrv, type Srv } from './server-kit'

const DOC = '# Doc\n\nFirst paragraph.\n\nSecond paragraph.\n'

let srv: Srv
let noHooks: Srv
beforeAll(async () => {
  srv = await startSrv({ files: { 'doc.md': DOC } })
  noHooks = await startSrv({ files: { 'doc.md': DOC }, testHooks: false })
})
afterAll(async () => {
  await srv?.close()
  await noHooks?.close()
})

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; code?: string; rootHash: string | null }> {
  const r = await rawRequest('127.0.0.1', srv.port, method, path, {
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  })
  const rootHash = r.headers.get('x-mdr-root-hash')
  if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) {
    await r.body?.cancel()
    return { status: r.status, rootHash }
  }
  const text = await r.text()
  let code: string | undefined
  try {
    const j = JSON.parse(text) as { ok?: boolean; error?: { code: string } }
    if (j.ok === false) {
      expect(S.ApiErrorSchema.safeParse(j).success, text).toBe(true)
      code = j.error!.code
    }
  } catch {
    // not JSON
  }
  return { status: r.status, ...(code ? { code } : {}), rootHash }
}

describe('Host × Origin matrix (§8.1 steps 1, 3)', () => {
  it('every combination for GET, POST and /api/events', async () => {
    const p = srv.port
    const hosts = [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, `other.example:${p}`]
    const origins: Array<string | undefined> = [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://127.0.0.1:${p + 1}`, undefined, 'null']
    const allowed = (o: string | undefined): boolean => o === `http://127.0.0.1:${p}` || o === `http://localhost:${p}`
    const cid = clientId()
    for (const host of hosts) {
      const hostOk = host.startsWith('127.0.0.1:') || host.startsWith('localhost:')
      for (const origin of origins) {
        const o = origin === undefined ? {} : { Origin: origin }
        const label = `${host} × ${origin ?? '(none)'}`
        // GET: an Origin is checked only when present
        const get = await call('GET', '/api/doc?file=doc.md', { Host: host, 'X-MDR-Client': 'web', Authorization: `Bearer ${srv.token}`, ...o })
        // POST: an allowed Origin is required
        const post = await call('POST', '/api/read-marker?file=doc.md', {
          Host: host, 'X-MDR-Client': 'web', Authorization: `Bearer ${srv.token}`, 'X-MDR-Client-Id': cid, ...o,
        }, { thread: null, upTo: 0 })
        // /api/events: ?t= and ?clientId= instead of headers; Origin checked when present
        const ev = await call('GET', `/api/events?file=doc.md&clientId=${cid}&t=${srv.token}`, { Host: host, ...o })
        if (!hostOk) {
          for (const r of [get, post, ev]) expect([r.status, r.code], label).toEqual([421, 'MISDIRECTED'])
        } else {
          expect(get.status, `GET ${label}`).toBe(origin === undefined || allowed(origin) ? 200 : 403)
          expect(post.status, `POST ${label}`).toBe(allowed(origin) ? 200 : 403)
          expect(ev.status, `events ${label}`).toBe(origin === undefined || allowed(origin) ? 200 : 403)
          for (const r of [get, post, ev]) if (r.status === 403) expect(r.code, label).toBe('FORBIDDEN_ORIGIN')
        }
        for (const r of [get, post, ev]) expect(r.rootHash, label).toBe(sha(srv.root))
      }
    }
  })

  it('the dev allow-list adds exactly the Vite origins under MDR_DEV_ORIGIN=1', () => {
    expect([...allowedOrigins({ port: 8301, devOrigin: false, vitePort: 5173 })].sort()).toEqual(['http://127.0.0.1:8301', 'http://localhost:8301'])
    expect([...allowedOrigins({ port: 8301, devOrigin: true, vitePort: 5180 })].sort()).toEqual([
      'http://127.0.0.1:5180', 'http://127.0.0.1:8301', 'http://localhost:5180', 'http://localhost:8301',
    ])
  })
})

describe('identity, token and client headers (§8.1 steps 2-6)', () => {
  const host = (): Record<string, string> => ({ Host: `127.0.0.1:${srv.port}` })
  const web = (extra: Record<string, string> = {}): Record<string, string> => ({ ...host(), 'X-MDR-Client': 'web', Authorization: `Bearer ${srv.token}`, ...extra })
  const agent = (extra: Record<string, string> = {}): Record<string, string> => ({ ...host(), 'X-MDR-Client': 'cli', 'X-MDR-Protocol': '2', Authorization: `Bearer ${srv.token}`, ...extra })
  const writeHeaders = (): Record<string, string> => web({ Origin: srv.origin, 'X-MDR-Client-Id': clientId() })

  it('401: no token or a wrong one, on browser, agent, events and test routes; never a default actor', async () => {
    expect((await call('GET', '/api/doc?file=doc.md', host())).code).toBe('UNAUTHORIZED')
    expect((await call('GET', '/api/doc?file=doc.md', web({ Authorization: 'Bearer nope' }))).code).toBe('UNAUTHORIZED')
    expect((await call('GET', '/api/agent/status?file=doc.md', agent({ Authorization: '' }))).code).toBe('UNAUTHORIZED')
    expect((await call('POST', '/api/agent/batch?file=doc.md', host(), { ops: [] })).code).toBe('UNAUTHORIZED')
    expect((await call('GET', `/api/events?file=doc.md&clientId=${clientId()}`, host())).code).toBe('UNAUTHORIZED')
    expect((await call('GET', `/api/events?file=doc.md&clientId=${clientId()}&t=nope`, host())).code).toBe('UNAUTHORIZED')
    expect((await call('POST', '/__test/splice-fault', { ...host(), Origin: srv.origin }, { blockHashes: [] })).code).toBe('UNAUTHORIZED')
    // the token in a header works for /api/events too
    expect((await call('GET', `/api/events?file=doc.md&clientId=${clientId()}`, { ...host(), Authorization: `Bearer ${srv.token}` })).status).toBe(200)
  })

  it('health is exempt from token and client headers, never from Host', async () => {
    expect((await call('GET', '/api/health', host())).status).toBe(200)
    expect((await call('GET', '/api/health', { Host: 'evil.example' })).status).toBe(421)
  })

  it('X-MDR-Client: web on browser routes, cli on agent routes (400 otherwise)', async () => {
    expect((await call('GET', '/api/doc?file=doc.md', { ...host(), Authorization: `Bearer ${srv.token}` })).code).toBe('BAD_REQUEST')
    expect((await call('GET', '/api/doc?file=doc.md', web({ 'X-MDR-Client': 'cli' }))).code).toBe('BAD_REQUEST')
    expect((await call('GET', '/api/agent/status?file=doc.md', agent({ 'X-MDR-Client': 'web' }))).code).toBe('BAD_REQUEST')
  })

  it('browser writes need X-MDR-Client-Id = k_<ULID> (D32); /api/events needs ?clientId=', async () => {
    const body = { thread: null, upTo: 0 }
    expect((await call('POST', '/api/read-marker?file=doc.md', web({ Origin: srv.origin }), body)).code).toBe('BAD_REQUEST')
    expect((await call('POST', '/api/read-marker?file=doc.md', web({ Origin: srv.origin, 'X-MDR-Client-Id': 'k_nope' }), body)).code).toBe('BAD_REQUEST')
    expect((await call('POST', '/api/read-marker?file=doc.md', writeHeaders(), body)).status).toBe(200)
    expect((await call('GET', `/api/events?file=doc.md&t=${srv.token}`, host())).code).toBe('BAD_REQUEST')
    expect((await call('GET', `/api/events?file=doc.md&clientId=k_bad&t=${srv.token}`, host())).code).toBe('BAD_REQUEST')
  })

  it('agent routes: any Origin (null included) → 403; a protocol mismatch → 426 with the restart hint', async () => {
    for (const origin of [srv.origin, 'null', 'http://evil.example']) {
      expect((await call('GET', '/api/agent/status?file=doc.md', agent({ Origin: origin }))).code).toBe('FORBIDDEN_ORIGIN')
    }
    const r = await rawRequest('127.0.0.1', srv.port, 'GET', '/api/agent/status?file=doc.md', { headers: agent({ 'X-MDR-Protocol': '1' }) })
    expect(r.status).toBe(426)
    const j = (await r.json()) as { error: { code: string; hint: string } }
    expect(j.error).toMatchObject({ code: 'PROTOCOL_MISMATCH' })
    expect(j.error.hint).toContain('--restart')
  })

  it('IDENTITY_IN_BODY for a top-level by / author / actor on both surfaces; bad JSON → 400; over the cap → 413', async () => {
    for (const k of ['by', 'author', 'actor']) {
      expect((await call('POST', '/api/read-marker?file=doc.md', writeHeaders(), { thread: null, upTo: 0, [k]: 'Claude' })).code).toBe('IDENTITY_IN_BODY')
      expect((await call('POST', '/api/agent/batch?file=doc.md', agent(), { ops: [], [k]: 'TJ' })).code).toBe('IDENTITY_IN_BODY')
    }
    // a nested `by` is data, not identity
    const nested = await call('POST', '/api/threads?file=doc.md', writeHeaders(), { opKey: `op_${'0'.repeat(26)}`, anchor: { kind: 'doc' }, anchorRev: 0, body: 'x', extra: { by: 'TJ' } })
    expect(nested.code).toBe('BAD_REQUEST') // the strict schema refuses `extra`, not the identity rule
    expect((await call('POST', '/api/read-marker?file=doc.md', writeHeaders(), '{nope')).code).toBe('BAD_REQUEST')
    const huge = '"' + 'x'.repeat(MAX_BODY_BYTES) + '"'
    expect((await call('POST', '/api/agent/batch?file=doc.md', agent(), huge)).code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('X-MDR-Root-Hash on every response: errors, static, unknown routes', async () => {
    for (const r of [
      await call('GET', '/api/health', { Host: 'evil.example' }),
      await call('GET', '/nope.js', host()),
      await call('GET', '/api/nope', web()),
      await call('GET', '/api/doc?file=missing.md', web()),
    ]) expect(r.rootHash).toBe(sha(srv.root))
    expect((await call('GET', '/api/nope', web())).status).toBe(404)
  })
})

describe('test hooks (§8.1 item 10, D51)', () => {
  it('/__test/splice-fault is mounted only under test hooks, and takes the browser-route checks', async () => {
    const r = await noHooks.web('POST', '/__test/splice-fault', { blockHashes: [] })
    expect(r.status).toBe(404)
    const ok = await srv.web('POST', '/__test/splice-fault', { blockHashes: [] })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ ok: true, blockHashes: [] })
    // no Origin → 403, no client id → 400
    expect((await call('POST', '/__test/splice-fault', { Host: `127.0.0.1:${srv.port}`, 'X-MDR-Client': 'web', Authorization: `Bearer ${srv.token}`, 'X-MDR-Client-Id': clientId() }, { blockHashes: [] })).code).toBe('FORBIDDEN_ORIGIN')
    expect((await call('POST', '/__test/splice-fault', { Host: `127.0.0.1:${srv.port}`, 'X-MDR-Client': 'web', Authorization: `Bearer ${srv.token}`, Origin: srv.origin }, { blockHashes: [] })).code).toBe('BAD_REQUEST')
    expect((await srv.web('POST', '/__test/splice-fault', { blockHashes: 'nope' })).status).toBe(400)
  })
})
