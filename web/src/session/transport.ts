// web/src/session/transport.ts (P2). The default `Transport` (CONTRACTS §12.0.5, §8.1, D32, D43).
//
// fetch + EventSource with ORIGIN-RELATIVE paths only: a page opened at http://localhost:<port>/ talks to localhost
// and one at 127.0.0.1 talks to 127.0.0.1, so every request is same-origin and the server needs no CORS (it sends
// none). The port from the bootstrap is informational and is never used to build a URL. `request` adds
// X-MDR-Client: web and Authorization on every call, and X-MDR-Client-Id on non-GET calls; the browser adds Origin
// itself. EventSource can't set headers, so the token and client id ride the query the session builds (§8.1).
import type { ClientId, EventSourceLike, Transport } from '../../../shared/types'

/** The session reads the transport's own client id when it has one, so echo rule 1 (§8.6) matches X-MDR-Client-Id. */
export interface TransportWithClientId extends Transport {
  readonly clientId: ClientId
}

export interface DefaultTransportOptions {
  token: string
  clientId: ClientId
  /** Injected in unit tests; defaults to the global fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Injected in unit tests; defaults to the global EventSource. */
  EventSource?: new (url: string) => {
    addEventListener(type: string, cb: (e: MessageEvent) => void): void
    close(): void
    onerror: ((e: Event) => void) | null
  }
}

/** Throws unless `path` is an origin-relative path ('/api/...'): never a scheme, a host, or a protocol-relative '//'. */
export function assertOriginRelative(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new TypeError(`mdr transport: request paths must be origin-relative ('/api/...'), got ${JSON.stringify(path)}`)
  }
}

export function createDefaultTransport(o: DefaultTransportOptions): TransportWithClientId {
  const doFetch = o.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
  return {
    clientId: o.clientId,
    async request(method, path, body, ro) {
      assertOriginRelative(path)
      const headers: Record<string, string> = { 'X-MDR-Client': 'web', Authorization: `Bearer ${o.token}` }
      if (method !== 'GET') {
        headers['X-MDR-Client-Id'] = o.clientId
        headers['Content-Type'] = 'application/json'
      }
      const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' }
      if (body !== undefined) init.body = JSON.stringify(body)
      if (ro?.keepalive) init.keepalive = true
      // a rejection here is a network failure; the session maps it to SERVER_UNREACHABLE
      const res = await doFetch(path, init)
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
    },
    events(pathWithQuery) {
      assertOriginRelative(pathWithQuery)
      const ES = o.EventSource ?? (globalThis as { EventSource?: DefaultTransportOptions['EventSource'] }).EventSource
      if (!ES) throw new TypeError('mdr transport: EventSource is not available in this environment')
      const es = new ES(pathWithQuery)
      let onerror: ((e: unknown) => void) | null = null
      const wrapped: EventSourceLike = {
        addEventListener: (type, cb) => es.addEventListener(type, (e: MessageEvent) => cb({ data: String(e.data), lastEventId: e.lastEventId })),
        close: () => es.close(),
        get onerror() {
          return onerror
        },
        set onerror(fn) {
          onerror = fn
          es.onerror = fn ? (e: Event) => fn(e) : null
        },
      }
      return wrapped
    },
  }
}
