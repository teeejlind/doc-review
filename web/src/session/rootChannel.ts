// web/src/session/rootChannel.ts (P2). connectRootChannel: the SSE channel of an empty-state tab (CONTRACTS §12.0.1,
// §8.6). No session and no editor exist; the root channel (no `file`) carries only `navigate` and `server-shutdown`
// and registers the tab in the root-wide client registry `mdr open` uses (§8.4). It reconnects like the file stream.
import { ulid } from 'ulid'
import type { ClientId, ConnectRootChannel, RootChannel } from '../../../shared/types'
import { SseConnection } from './sse'
import { createDefaultTransport } from './transport'

export const connectRootChannel: ConnectRootChannel = (boot, transport): RootChannel => {
  const own = (transport as { clientId?: unknown } | undefined)?.clientId
  const clientId: ClientId = typeof own === 'string' && own.startsWith('k_') ? (own as ClientId) : (`k_${ulid()}` as ClientId)
  const t = transport ?? createDefaultTransport({ token: boot.token, clientId })
  const subs = new Set<(file: string) => void>()
  const sse = new SseConnection({
    transport: t,
    path: () => `/api/events?${new URLSearchParams({ clientId, t: boot.token }).toString()}`,
    handlers: {
      navigate: (d) => {
        for (const cb of [...subs]) cb(d.file)
      },
    },
  })
  sse.start()
  return {
    onNavigate(cb) {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    close() {
      subs.clear()
      sse.close()
    },
  }
}
