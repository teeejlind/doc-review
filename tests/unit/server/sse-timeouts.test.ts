// tests/unit/server/sse-timeouts.test.ts (P1; CONTRACTS §8.7 "Long-lived streams", §9.8.3, row 82). The server's
// timeout settings for the two SSE routes: requestTimeout 0 and no server-wide socket timeout, headersTimeout left at
// Node's default; GET /api/events and GET /api/agent/wait turn their own socket's timeout off even when the server
// has one; and a stream on each route stays open, heartbeating every SSE_HEARTBEAT_MS, through 60 minutes of fake time.
import { createServer, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { configureHttpServer, internalsOf } from '../../../server/index'
import { CONSTANTS } from '../../../shared/types'
import { rawRequest } from '../../helpers/webClient'
import { clientId, inProcessApp, startSrv, type InProc, type Srv } from './server-kit'

const DOC = '# Doc\n\nBody.\n'
const WAITER = 'w_0123456789abcdef'

describe('server settings (§8.7)', () => {
  it('configureHttpServer: requestTimeout 0, no socket timeout, headersTimeout at its default', () => {
    const fresh = createServer()
    const s = configureHttpServer(createServer())
    expect(s.requestTimeout).toBe(0)
    expect(s.timeout).toBe(0)
    expect(s.headersTimeout).toBe(fresh.headersTimeout)
    expect(s.headersTimeout).toBeGreaterThan(0)
  })
})

describe('the running server', () => {
  let srv: Srv
  beforeAll(async () => {
    srv = await startSrv({ files: { 'doc.md': DOC } })
  })
  afterAll(async () => {
    await srv?.close()
  })

  it('startServer binds with requestTimeout 0', () => {
    const { server } = internalsOf(srv.server)!
    expect(server.requestTimeout).toBe(0)
    expect(server.timeout).toBe(0)
  })

  it('both SSE routes turn their socket timeout off; other routes keep the server default', async () => {
    const { server } = internalsOf(srv.server)!
    const sockets = new Map<string, Socket>()
    const onRequest = (req: IncomingMessage): void => {
      sockets.set((req.url ?? '').split('?')[0]!, req.socket)
    }
    server.on('request', onRequest)
    // a server-wide socket timeout, to show the SSE routes override it for themselves
    server.setTimeout(120_000)
    try {
      const host = { Host: `127.0.0.1:${srv.port}` }
      const ev = await rawRequest('127.0.0.1', srv.port, 'GET', `/api/events?file=doc.md&clientId=${clientId()}&t=${srv.token}`, { headers: host })
      const wait = await rawRequest('127.0.0.1', srv.port, 'GET', `/api/agent/wait?file=doc.md&waiter=${WAITER}&gen=1`, {
        headers: { ...host, 'X-MDR-Client': 'cli', 'X-MDR-Protocol': '2', Authorization: `Bearer ${srv.token}` },
      })
      const doc = await rawRequest('127.0.0.1', srv.port, 'GET', '/api/doc?file=doc.md', {
        headers: { ...host, 'X-MDR-Client': 'web', Authorization: `Bearer ${srv.token}`, Connection: 'close' },
      })
      expect([ev.status, wait.status, doc.status]).toEqual([200, 200, 200])
      expect(sockets.get('/api/events')!.timeout).toBe(0)
      expect(sockets.get('/api/agent/wait')!.timeout).toBe(0)
      expect(sockets.get('/api/doc')!.timeout).toBe(120_000)
      await ev.body?.cancel()
      await wait.body?.cancel()
      await doc.text()
    } finally {
      server.setTimeout(0)
      server.off('request', onRequest)
    }
  })
})

describe('60 minutes of fake time', () => {
  let ip: InProc
  beforeAll(async () => {
    ip = await inProcessApp({ files: { 'doc.md': DOC } })
    // open the store with real timers; the streams below then need none but the heartbeat
    expect((await ip.req('GET', '/api/doc?file=doc.md')).status).toBe(200)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  afterAll(async () => {
    await ip?.close()
  })

  async function holdOpen(path: string): Promise<{ heartbeats: number; ended: boolean; firstEvent: string | null }> {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    const r = await ip.req('GET', path)
    expect(r.status).toBe(200)
    const reader = r.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let ended = false
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
      }
      ended = true
    })()
    for (let minute = 0; minute < 60; minute++) await vi.advanceTimersByTimeAsync(60_000)
    const heartbeats = buf.split(': hb\n\n').length - 1
    const firstEvent = /event: ([a-z-]+)/.exec(buf)?.[1] ?? null
    const openAfterAnHour = !ended
    await reader.cancel()
    return { heartbeats, ended: !openAfterAnHour, firstEvent }
  }

  it('GET /api/events stays open and heartbeats every SSE_HEARTBEAT_MS', async () => {
    const r = await holdOpen(`/api/events?file=doc.md&clientId=${clientId()}&t=${ip.token}`)
    expect(r.firstEvent).toBe('hello')
    expect(r.ended).toBe(false)
    expect(r.heartbeats).toBe((60 * 60_000) / CONSTANTS.SSE_HEARTBEAT_MS)
  })

  it('GET /api/agent/wait stays open and heartbeats too', async () => {
    const r = await holdOpen(`/api/agent/wait?file=doc.md&waiter=${WAITER}&gen=1`)
    expect(r.firstEvent).toBe('armed')
    expect(r.ended).toBe(false)
    expect(r.heartbeats).toBeGreaterThanOrEqual((60 * 60_000) / CONSTANTS.SSE_HEARTBEAT_MS - 1)
  })
})
