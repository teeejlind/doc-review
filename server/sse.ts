// server/sse.ts (P1). Server-sent event streams, the root-wide browser client registry and the store → SSE mapping
// (CONTRACTS §8.6, §8.7 "Long-lived streams", D32).
//
// - openStream: one text/event-stream Response with a `: hb` comment every heartbeatMs (SSE_HEARTBEAT_MS, or
//   MDR_TEST_HEARTBEAT_MS under test hooks); the waiter stream (§8.7, the handoff module) can use it too. The stream
//   has no end of its own: it lives until the client goes away or the server closes it (the socket timeout is off for
//   SSE routes, server/app.ts).
// - SseHub: every connected browser client, file channels and root channels alike, ordered by last activity (connect,
//   or any TJ request carrying its clientId; ties go to the newest connection), which POST /api/agent/open needs.
//   broadcast(file) reaches one file's channel; broadcastAll reaches everyone (navigate, server-shutdown).
// - storeChangeEvents: a committed StoreChange → the browser events, in order: doc-changed (with the commit's clientId
//   and saveId for echo suppression, and the markdown when ≤ SSE_MARKDOWN_MAX_BYTES), sidecar-changed (types in first-
//   appearance order, clientId), doc-removed. The app calls it synchronously from the store's change listener, which
//   the store runs after releasing the lock, in commit order (doc before sidecar), so every client sees one queue per
//   doc in seq order.
// GET /api/events itself (hello, resync, the BEACON_GRACE_MS flush timer) is server/routes/read.ts.
import type { BrowserSseEvent, ClientId, EventType, Hash, StoreChange } from '../shared/types'
import { CONSTANTS } from '../shared/constants'

export interface SseClient {
  readonly id: number
  /** null = a root channel (an empty-state tab). */
  readonly file: string | null
  readonly clientId: ClientId | null
  lastActive: number
  readonly closed: boolean
  /** One `event:` / `data:` (/ `id:`) frame; `data` is JSON-serialized. */
  send(event: string, data: unknown, id?: string): void
  comment(text: string): void
  close(): void
}

let nextId = 1
const enc = new TextEncoder()

/** A text/event-stream Response plus its writer. `onClose` runs once, on close() or client disconnect. */
export function openStream(o: {
  heartbeatMs: number
  file?: string | null
  clientId?: ClientId | null
  headers?: Record<string, string>
  onClose?: (cl: SseClient) => void
}): { response: Response; client: SseClient } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  let hb: ReturnType<typeof setInterval> | null = null
  const write = (s: string): void => {
    if (closed) return
    try {
      controller.enqueue(enc.encode(s))
    } catch {
      finish()
    }
  }
  const finish = (): void => {
    if (closed) return
    closed = true
    if (hb) clearInterval(hb)
    try {
      controller.close()
    } catch {
      // already closed by the reader
    }
    o.onClose?.(client)
  }
  const client: SseClient = {
    id: nextId++,
    file: o.file ?? null,
    clientId: o.clientId ?? null,
    lastActive: Date.now(),
    get closed() {
      return closed
    },
    send(event, data, id) {
      write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    comment(text) {
      write(`: ${text}\n\n`)
    },
    close: () => finish(),
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      hb = setInterval(() => client.comment('hb'), o.heartbeatMs)
      ;(hb as { unref?: () => void }).unref?.()
    },
    cancel() {
      finish()
    },
  })
  const response = new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(o.headers ?? {}),
    },
  })
  return { response, client }
}

export interface SseHub {
  /** Opens a browser stream and registers it (§8.6 channels). */
  open(o: { file: string | null; clientId: ClientId | null; headers?: Record<string, string>; onClose?: (cl: SseClient) => void }): { response: Response; client: SseClient }
  /** Every client of `file`'s channel. */
  broadcast(file: string, e: BrowserSseEvent, id?: string): void
  /** Every client, file and root channels alike (navigate, server-shutdown). */
  broadcastAll(e: BrowserSseEvent): void
  /** Registered clients, most recently active first; `file` filters to one channel (null = root channels). */
  clients(file?: string | null): SseClient[]
  /** The most recently active client on any channel (§8.4 open), or null. */
  mostRecent(): SseClient | null
  /** Any TJ request carrying this client id counts as activity (§8.4 open). */
  touch(clientId: ClientId): void
  closeAll(): void
}

const byActivity = (a: SseClient, b: SseClient): number => b.lastActive - a.lastActive || b.id - a.id

export function createSseHub(o: { heartbeatMs: number }): SseHub {
  const live = new Set<SseClient>()
  return {
    open(x) {
      const s = openStream({
        heartbeatMs: o.heartbeatMs, file: x.file, clientId: x.clientId, ...(x.headers ? { headers: x.headers } : {}),
        onClose: (cl) => {
          live.delete(cl)
          x.onClose?.(cl)
        },
      })
      live.add(s.client)
      return s
    },
    broadcast(file, e, id) {
      for (const cl of [...live]) if (cl.file === file) cl.send(e.event, e.data, id)
    },
    broadcastAll(e) {
      for (const cl of [...live]) cl.send(e.event, e.data)
    },
    clients(file) {
      const all = [...live].sort(byActivity)
      return file === undefined ? all : all.filter((cl) => cl.file === file)
    },
    mostRecent() {
      return [...live].sort(byActivity)[0] ?? null
    },
    touch(clientId) {
      const now = Date.now()
      for (const cl of live) if (cl.clientId === clientId) cl.lastActive = now
    },
    closeAll() {
      for (const cl of [...live]) cl.close()
      live.clear()
    },
  }
}

/** One browser event plus its `id:` (`${rev}.${seq}`, §8.6). */
export interface IdentifiedEvent {
  e: BrowserSseEvent
  id?: string
}

/**
 * A committed StoreChange → the browser events for `file`. `cursor` is where the log stands after the change (for ids:
 * a doc change carries its own rev, a sidecar change its own seq), and `textAt` the decoded text of a doc hash (the
 * store's current doc or its object), so doc-changed carries the markdown of exactly the rev it announces.
 */
export function storeChangeEvents(
  file: string,
  ch: StoreChange,
  cursor: { rev: number; seq: number },
  textAt: (hash: Hash) => string | null,
): IdentifiedEvent[] {
  if (ch.kind === 'doc') {
    const text = textAt(ch.hash)
    const markdown = text !== null && Buffer.byteLength(text, 'utf8') <= CONSTANTS.SSE_MARKDOWN_MAX_BYTES ? text : undefined
    return [{
      id: `${ch.rev}.${cursor.seq}`,
      e: {
        event: 'doc-changed',
        data: {
          file, rev: ch.rev, prevRev: ch.prevRev, hash: ch.hash, by: ch.by, cause: ch.cause,
          ...(ch.clientId ? { clientId: ch.clientId } : {}),
          ...(ch.saveId !== undefined ? { saveId: ch.saveId } : {}),
          changes: ch.changes,
          ...(markdown !== undefined ? { markdown } : {}),
        },
      },
    }]
  }
  if (ch.kind === 'sidecar') {
    const types: EventType[] = []
    for (const ev of ch.events) if (!types.includes(ev.type)) types.push(ev.type)
    return [{
      id: `${cursor.rev}.${ch.seq}`,
      e: { event: 'sidecar-changed', data: { file, fromSeq: ch.fromSeq, seq: ch.seq, types, ...(ch.clientId ? { clientId: ch.clientId } : {}) } },
    }]
  }
  return [{ e: { event: 'doc-removed', data: { file } } }]
}
