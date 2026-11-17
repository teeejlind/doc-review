// tests/fakes/MockTransport.ts (integrator, day 0; CONTRACTS §2.2 "Transport", §12.0.5, D32, D43).
//
// The `Transport` (types.ts) P2's session consumes, implemented in-process over fakeApp (or any `{ fetch }`): no
// sockets, same headers the default browser transport sends. `request` adds X-MDR-Client: web, Authorization and, on
// non-GET, the page's Origin and X-MDR-Client-Id; it resolves `{ status, json }` for every HTTP answer and rejects only
// on a (simulated) network failure, like fetch. `events` returns a live EventSourceLike over the SSE response body.
//
// Scripting for P2's safety-state tests (§12.14): `intercept` answers a request instead of the app (or lets it
// through), `failNext` fakes a network error or a status, `emit` pushes a synthetic SSE event to open streams, and
// `dropStreams` ends every stream with onerror (a server restart). Every request and stream is recorded.
import { ulid } from 'ulid'
import type { BrowserSseEvent, ClientId, EventSourceLike, Transport } from '../../shared/types'
import { readSse } from '../helpers/sse'

export interface MockTransportOptions {
  /** fakeApp (createFakeApp) or anything with a fetch(Request). */
  app: { fetch(req: Request): Promise<Response> | Response }
  token: string
  port: number
  /** The page's X-MDR-Client-Id. Default: a fresh k_ id. */
  clientId?: ClientId
  /** The page origin ('127.0.0.1' default, or 'localhost' as for an old-style link, D13). */
  host?: '127.0.0.1' | 'localhost'
}

export interface RecordedRequest {
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  body: unknown
  keepalive: boolean
  headers: Record<string, string>
  status?: number
}

/** Return a response to answer instead of the app; `undefined` lets the request through. */
export type Interceptor = (req: RecordedRequest) => { status: number; json: unknown } | 'network-error' | undefined | Promise<{ status: number; json: unknown } | 'network-error' | undefined>

class MockEventSource implements EventSourceLike {
  onerror: ((e: unknown) => void) | null = null
  readonly path: string
  closed = false
  private readonly listeners = new Map<string, Set<(e: { data: string; lastEventId: string }) => void>>()
  private readonly ac = new AbortController()
  lastEventId = ''

  constructor(path: string, private readonly owner: MockTransport) {
    this.path = path
  }

  addEventListener(type: string, cb: (e: { data: string; lastEventId: string }) => void): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(cb)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.ac.abort()
    this.owner.forget(this)
  }

  /** Deliver one event to listeners of its type (and 'message' listeners for unnamed events). */
  dispatch(type: string, data: string, id?: string): void {
    if (this.closed) return
    if (id !== undefined) this.lastEventId = id
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb({ data, lastEventId: this.lastEventId })
  }

  /** End the stream as a dropped connection: onerror, then closed (no auto-reconnect; the session reconnects). */
  fail(e: unknown = new Error('stream dropped')): void {
    if (this.closed) return
    this.closed = true
    this.ac.abort()
    this.owner.forget(this)
    this.onerror?.(e)
  }

  async run(fetchIt: () => Promise<Response>): Promise<void> {
    let res: Response
    try {
      res = await fetchIt()
    } catch (e) {
      this.fail(e)
      return
    }
    if (!res.ok || !res.body) {
      this.fail(new Error(`SSE ${this.path} answered ${res.status}`))
      return
    }
    try {
      for await (const f of readSse(res.body, this.ac.signal)) {
        if (this.closed) break
        if (f.kind === 'message') this.dispatch(f.message.event, f.message.data, f.message.id)
      }
      if (!this.closed) this.fail(new Error('stream ended'))
    } catch (e) {
      if (!this.closed) this.fail(e)
    }
  }

  get signal(): AbortSignal {
    return this.ac.signal
  }
}

export class MockTransport implements Transport {
  readonly clientId: ClientId
  readonly origin: string
  readonly requests: RecordedRequest[] = []
  readonly streams: Array<{ path: string; source: EventSourceLike; closed: () => boolean }> = []
  private readonly open = new Set<MockEventSource>()
  private readonly interceptors: Interceptor[] = []
  private readonly failures: Array<'network-error' | number> = []

  constructor(private readonly o: MockTransportOptions) {
    this.clientId = o.clientId ?? (`k_${ulid()}` as ClientId)
    this.origin = `http://${o.host ?? '127.0.0.1'}:${o.port}`
  }

  private url(path: string): string {
    if (!path.startsWith('/')) throw new TypeError(`MockTransport: path must start with '/', got ${path}`)
    return `http://127.0.0.1:${this.o.port}${path}`
  }

  async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, o?: { keepalive?: boolean }): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { 'X-MDR-Client': 'web', Authorization: `Bearer ${this.o.token}` }
    if (method !== 'GET') {
      headers.Origin = this.origin
      headers['X-MDR-Client-Id'] = this.clientId
      headers['Content-Type'] = 'application/json'
    }
    const rec: RecordedRequest = { method, path, body, keepalive: o?.keepalive === true, headers }
    this.requests.push(rec)
    const failure = this.failures.shift()
    if (failure === 'network-error') throw new TypeError('fetch failed (MockTransport.failNext)')
    if (typeof failure === 'number') {
      rec.status = failure
      return { status: failure, json: { ok: false, error: { code: failure >= 500 ? 'INTERNAL' : 'BAD_REQUEST', message: `MockTransport.failNext(${failure})` } } }
    }
    for (const ic of this.interceptors) {
      const r = await ic(rec)
      if (r === 'network-error') throw new TypeError('fetch failed (MockTransport.intercept)')
      if (r !== undefined) {
        rec.status = r.status
        return r
      }
    }
    const res = await this.o.app.fetch(new Request(this.url(path), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    rec.status = res.status
    const text = await res.text()
    let json: unknown = undefined
    if (text !== '') {
      try {
        json = JSON.parse(text)
      } catch {
        json = text
      }
    }
    return { status: res.status, json }
  }

  events(pathWithQuery: string): EventSourceLike {
    const es = new MockEventSource(pathWithQuery, this)
    this.open.add(es)
    this.streams.push({ path: pathWithQuery, source: es, closed: () => es.closed })
    // EventSource sends no custom headers: the token and client id ride the query (§8.1); Origin is the page's
    void es.run(() => Promise.resolve(this.o.app.fetch(new Request(this.url(pathWithQuery), {
      headers: { Origin: this.origin, Accept: 'text/event-stream' },
      signal: es.signal,
    }))))
    return es
  }

  /** @internal */
  forget(es: MockEventSource): void {
    this.open.delete(es)
  }

  // ------------------------------------------------------------------ scripting

  /** Answer matching requests yourself; return undefined to pass through. Returns a remover. */
  intercept(fn: Interceptor): () => void {
    this.interceptors.push(fn)
    return () => {
      const i = this.interceptors.indexOf(fn)
      if (i >= 0) this.interceptors.splice(i, 1)
    }
  }

  /** The next request (only) fails: a network error (fetch rejects) or an HTTP status with an ApiError body. */
  failNext(f: 'network-error' | number, times = 1): void {
    for (let k = 0; k < times; k++) this.failures.push(f)
  }

  /** Push a synthetic browser SSE event to every open stream (or those whose path matches `pathIncludes`). */
  emit(e: BrowserSseEvent, o: { pathIncludes?: string; id?: string } = {}): void {
    for (const es of [...this.open]) {
      if (o.pathIncludes && !es.path.includes(o.pathIncludes)) continue
      es.dispatch(e.event, JSON.stringify(e.data), o.id)
    }
  }

  /** End every open stream as dropped (onerror fires; no auto-reconnect). */
  dropStreams(): void {
    for (const es of [...this.open]) es.fail(new Error('MockTransport.dropStreams'))
  }

  openStreamCount(): number {
    return this.open.size
  }

  /** Requests to a path (prefix before '?'), optionally by method. */
  requestsTo(path: string, method?: RecordedRequest['method']): RecordedRequest[] {
    return this.requests.filter((r) => r.path.split('?')[0] === path && (method === undefined || r.method === method))
  }

  closeAll(): void {
    for (const es of [...this.open]) es.close()
  }
}

export function createMockTransport(o: MockTransportOptions): MockTransport {
  return new MockTransport(o)
}
