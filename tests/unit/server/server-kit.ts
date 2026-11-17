// tests/unit/server/server-kit.ts (P1). Shared setup for the M2 server suites: a realpath'd tmp root with the given
// files, the real startServer in-process (test hooks on by default), raw browser / agent requests with exactly the
// §8.1 headers, and an SSE recorder that keeps reading a stream in the background so a test can act and then wait for
// the events it expects.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { realId } from '../../../node/root'
import { internalsOf, startServer } from '../../../server/index'
import type { ServerApp } from '../../../server/app'
import type { BrowserSseEvent, ClientId, OpKey, RunningServer, SidecarEvent, SidecarHeader } from '../../../shared/types'
import { PROTOCOL } from '../../../shared/types'
import { readSse } from '../../helpers/sse'

export const opKey = (): OpKey => `op_${ulid()}`
export const clientId = (): ClientId => `k_${ulid()}`

export function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => done(port))
    })
  })
}

export interface Res<T = unknown> {
  status: number
  headers: Headers
  json: T
}

export interface Srv {
  root: string
  port: number
  token: string
  origin: string
  server: RunningServer
  app: ServerApp
  path(rel: string): string
  read(rel: string): string
  write(rel: string, content: string | Buffer): void
  /** Sidecar lines (header first); [] when absent. */
  sidecar(rel: string): Array<SidecarHeader | SidecarEvent>
  events(rel: string): SidecarEvent[]
  /** A browser request with the §8.1 headers (Origin + X-MDR-Client-Id on non-GET). */
  web<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, o?: { clientId?: ClientId; headers?: Record<string, string> }): Promise<Res<T>>
  /** An agent request (X-MDR-Client: cli, protocol, token, no Origin). */
  agent<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res<T>>
  /** A browser SSE stream (`file` null = the root channel), recorded in the background. */
  sse(file: string | null, o?: { clientId?: ClientId; afterSeq?: number; knownRev?: number }): Promise<Recorder>
  close(): Promise<void>
}

export interface Recorder {
  readonly clientId: ClientId
  readonly events: BrowserSseEvent[]
  /** Resolves with the events once `pred` holds (checked on every event), rejects after `timeoutMs`. */
  until(pred: (events: BrowserSseEvent[]) => boolean, timeoutMs?: number): Promise<BrowserSseEvent[]>
  /** Events of one type. */
  of<K extends BrowserSseEvent['event']>(event: K): Array<Extract<BrowserSseEvent, { event: K }>>
  close(): void
}

export async function startSrv(o: { files?: Record<string, string | Buffer>; testHooks?: boolean; prefix?: string } = {}): Promise<Srv> {
  const root = realId(mkdtempSync(join(tmpdir(), o.prefix ?? 'mdr-srv-m2-')))
  for (const [rel, content] of Object.entries(o.files ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  const port = await freePort()
  const server = await startServer({ root, port, testHooks: o.testHooks ?? true })
  const app = internalsOf(server)!.app
  const token = server.marker.token
  const origin = `http://127.0.0.1:${port}`
  const defaultClient = clientId()
  const recorders = new Set<Recorder>()

  async function send<T>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Res<T>> {
    const r = await fetch(origin + path, {
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
    return { status: r.status, headers: r.headers, json: json as T }
  }

  const srv: Srv = {
    root, port, token, origin, server, app,
    path: (rel) => join(root, rel),
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    write: (rel, content) => writeFileSync(join(root, rel), content),
    sidecar(rel) {
      try {
        return readFileSync(join(root, rel) + '.review.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SidecarHeader | SidecarEvent)
      } catch {
        return []
      }
    },
    events: (rel) => srv.sidecar(rel).filter((l): l is SidecarEvent => (l as { type: string }).type !== 'header'),
    web(method, path, body, wo = {}) {
      const h: Record<string, string> = { 'X-MDR-Client': 'web', Authorization: `Bearer ${token}` }
      if (method !== 'GET') {
        h.Origin = origin
        h['X-MDR-Client-Id'] = wo.clientId ?? defaultClient
      }
      return send(method, path, { ...h, ...(wo.headers ?? {}) }, body)
    },
    agent(method, path, body) {
      return send(method, path, { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(PROTOCOL), Authorization: `Bearer ${token}` }, body)
    },
    async sse(file, so = {}) {
      const id = so.clientId ?? clientId()
      const q = new URLSearchParams({ clientId: id, t: token })
      if (file !== null) q.set('file', file)
      if (so.afterSeq !== undefined) q.set('afterSeq', String(so.afterSeq))
      if (so.knownRev !== undefined) q.set('knownRev', String(so.knownRev))
      const ac = new AbortController()
      const r = await fetch(`${origin}/api/events?${q.toString()}`, { headers: { Accept: 'text/event-stream' }, signal: ac.signal })
      if (r.status !== 200 || !r.body) throw new Error(`SSE ${file}: ${r.status} ${await r.text()}`)
      const events: BrowserSseEvent[] = []
      const wake = new Set<() => void>()
      const body = r.body
      void (async () => {
        try {
          for await (const f of readSse(body, ac.signal)) {
            if (f.kind !== 'message') continue
            events.push({ event: f.message.event, data: JSON.parse(f.message.data), ...(f.message.id ? { id: f.message.id } : {}) } as BrowserSseEvent)
            for (const w of [...wake]) w()
          }
        } catch {
          // aborted
        }
      })()
      const rec: Recorder = {
        clientId: id,
        events,
        until(pred, timeoutMs = 5_000) {
          return new Promise((resolve, reject) => {
            const check = (): boolean => {
              if (!pred(events)) return false
              wake.delete(check as () => void)
              clearTimeout(t)
              resolve(events)
              return true
            }
            const t = setTimeout(() => {
              wake.delete(check as () => void)
              reject(new Error(`SSE ${file}: timed out; got ${JSON.stringify(events.map((e) => e.event))}`))
            }, timeoutMs)
            if (!check()) wake.add(check as () => void)
          })
        },
        of: (event) => events.filter((e) => e.event === event) as never,
        close: () => {
          ac.abort()
          recorders.delete(rec)
        },
      }
      recorders.add(rec)
      // the hello (file channels) or the registration (root channel) has happened once the stream answered
      if (file !== null) await rec.until((es) => es.some((e) => e.event === 'hello'))
      return rec
    },
    async close() {
      for (const r of [...recorders]) r.close()
      await server.close('stop')
      rmSync(root, { recursive: true, force: true })
    },
  }
  return srv
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- in-process app (no socket)

export interface InProc {
  root: string
  port: number
  token: string
  app: ServerApp
  /** app.fetch with the Host header and the §8.1 headers of the surface the path belongs to. */
  req(method: string, path: string, body?: unknown, o?: { clientId?: ClientId }): Promise<Response>
  json<T = unknown>(method: string, path: string, body?: unknown, o?: { clientId?: ClientId }): Promise<{ status: number; json: T }>
  sidecar(rel: string): Array<SidecarHeader | SidecarEvent>
  close(): Promise<void>
}

/** createServerApp over a tmp root, driven through app.fetch (fake timers work; no socket timeouts apply). */
export async function inProcessApp(o: {
  files: Record<string, string>
  appOptions?: Partial<import('../../../server/app').AppOptions>
}): Promise<InProc> {
  const { createServerApp } = await import('../../../server/app')
  const { rootHashOf } = await import('../../../node/root')
  const root = realId(mkdtempSync(join(tmpdir(), 'mdr-inproc-')))
  for (const [rel, content] of Object.entries(o.files)) writeFileSync(join(root, rel), content)
  const port = 8399
  const token = 'a'.repeat(64)
  const app = createServerApp({
    root, rootHash: rootHashOf(root), port, pid: process.pid, serverId: 'srv_test', startedAt: new Date().toISOString(), token,
    schemaFingerprint: '0123456789abcdef', protocol: PROTOCOL, testHooks: false, devOrigin: false, vitePort: 5173,
    heartbeatMs: 15_000, ...(o.appOptions ?? {}),
  })
  const origin = `http://127.0.0.1:${port}`
  const defaultClient = clientId()
  const req = (method: string, path: string, body?: unknown, ro: { clientId?: ClientId } = {}): Promise<Response> => {
    const agent = path.startsWith('/api/agent/')
    const headers: Record<string, string> = agent
      ? { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(PROTOCOL), Authorization: `Bearer ${token}` }
      : { 'X-MDR-Client': 'web', Authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { Origin: origin, 'X-MDR-Client-Id': ro.clientId ?? defaultClient }) }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return Promise.resolve(app.app.fetch(new Request(origin + path, {
      method, headers: { Host: `127.0.0.1:${port}`, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })))
  }
  return {
    root, port, token, app, req,
    async json(method, path, body, jo) {
      const r = await req(method, path, body, jo)
      return { status: r.status, json: (await r.json()) as never }
    },
    sidecar(rel) {
      try {
        return readFileSync(join(root, rel) + '.review.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SidecarHeader | SidecarEvent)
      } catch {
        return []
      }
    },
    async close() {
      await app.close('stop')
      rmSync(root, { recursive: true, force: true })
    },
  }
}
