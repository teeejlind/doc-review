// tests/fakes/web-session.ts (integrator, day 0; CONTRACTS §2.4 item 6, §12.0.2, §12.0.3, §12.0.5, D43).
//
// The same exports as P2's web/src/session/index.ts, over the fake session. vite.config.ts aliases P2's module to this
// file when the page is built with MDR_FAKE_EDITOR=1, so P3's real shell (main.tsx / App.tsx) runs before P2 lands.
// Browser-safe. `readBootstrap` is a faithful reader of the §12.0.2 meta tags; `openDocSession` returns a LIVE fake
// session (snapshot, review and the browser SSE stream from whatever server served the page: startFakeServer or the
// real one); `connectRootChannel` opens the root SSE channel and surfaces `navigate` only. The default transport is
// fetch + EventSource with origin-relative paths (D43). With the test-hooks meta, window.__mdrFake.session exposes the
// session so specs can `emit(...)` banners, recovered drafts and notices.
import { ulid } from 'ulid'
import type {
  ClientId, ConnectRootChannel, ErrorCode, EventSourceLike, OpenDocSession, ReadBootstrap, RootChannel, SessionBootstrap,
  Transport,
} from '../../shared/types'
import { openFakeDocSession, type FakeDocSession } from './FakeDocSession'

const meta = (doc: Document, name: string): string | null => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null

/** §12.0.2. Throws when mdr-token or mdr-root is missing. */
export const readBootstrap: ReadBootstrap = (doc: Document): SessionBootstrap => {
  const token = meta(doc, 'mdr-token')
  const root = meta(doc, 'mdr-root')
  if (!token || !root) throw new Error('This page must be opened from `mdr open` (mdr-token / mdr-root meta missing)')
  const file = meta(doc, 'mdr-file')
  const fileError = meta(doc, 'mdr-file-error')
  return {
    token,
    root,
    rootHash: meta(doc, 'mdr-root-hash') ?? '',
    port: Number(meta(doc, 'mdr-port') ?? 0),
    file: file ? file : null,
    fileError: fileError ? (fileError as ErrorCode) : null,
    version: meta(doc, 'mdr-version') ?? '',
    protocol: Number(meta(doc, 'mdr-protocol') ?? 0),
    schemaFingerprint: meta(doc, 'mdr-fingerprint') ?? '',
    testHooks: meta(doc, 'mdr-test-hooks') === '1',
  }
}

/** The default browser transport (§12.0.5): origin-relative fetch and EventSource; auth headers added here. */
export function createFetchTransport(boot: SessionBootstrap, clientId: ClientId = `k_${ulid()}` as ClientId): Transport & { clientId: ClientId } {
  return {
    clientId,
    async request(method, path, body, o) {
      const headers: Record<string, string> = { 'X-MDR-Client': 'web', Authorization: `Bearer ${boot.token}` }
      if (method !== 'GET') {
        headers['X-MDR-Client-Id'] = clientId
        headers['Content-Type'] = 'application/json'
      }
      const r = await fetch(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(o?.keepalive ? { keepalive: true } : {}),
      })
      const text = await r.text()
      let json: unknown = undefined
      try {
        json = text === '' ? undefined : JSON.parse(text)
      } catch {
        json = text
      }
      return { status: r.status, json }
    },
    events(pathWithQuery): EventSourceLike {
      return new EventSource(pathWithQuery) as unknown as EventSourceLike
    },
  }
}

function exposeSession(boot: SessionBootstrap, session: FakeDocSession): void {
  if (!boot.testHooks || typeof window === 'undefined') return
  const w = window as unknown as { __mdrFake?: Record<string, unknown> }
  w.__mdrFake = { ...(w.__mdrFake ?? {}), session }
}

export const openDocSession: OpenDocSession = async ({ boot, file, transport }) => {
  const t = transport ?? createFetchTransport(boot)
  const session = await openFakeDocSession({ boot, file, transport: t })
  exposeSession(boot, session)
  return session
}

export const connectRootChannel: ConnectRootChannel = (boot, transport): RootChannel => {
  const clientId = (transport as { clientId?: ClientId } | undefined)?.clientId ?? (`k_${ulid()}` as ClientId)
  const t = transport ?? createFetchTransport(boot, clientId)
  const subs = new Set<(file: string) => void>()
  const es = t.events(`/api/events?${new URLSearchParams({ clientId, t: boot.token }).toString()}`)
  es.addEventListener('navigate', (e) => {
    const f = (JSON.parse(e.data) as { file: string }).file
    for (const cb of [...subs]) cb(f)
  })
  return {
    onNavigate(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    close() {
      es.close()
    },
  }
}
