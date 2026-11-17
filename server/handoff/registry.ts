// server/handoff/registry.ts (P4). Waiter streams and the one-live-waiter-per-doc registry (CONTRACTS §8.7, D21).
//
// A waiter stream is a text/event-stream body written by hand: `event:` / `data:` frames for WaiterSseEvent and a
// `: hb` comment every heartbeat. It notices the client going away through the ReadableStream's cancel(), which both
// @hono/node-server (socket closed) and an in-process reader (reader.cancel()) trigger.
//
// Registration (D21), per doc:
// - no live waiter → registered;
// - a different waiter id → the old stream gets superseded { by: new id, reason: 'newer-waiter' } and is closed;
// - the same id with a higher gen → the old stream gets superseded { by: id, reason: 'replaced' } and is closed;
// - the same id and the same gen → a self-reconnect after a drop: the old (half-open) stream is closed silently;
// - the same id with a lower gen → refused at once: the NEW stream gets superseded { by: id, reason: 'replaced' }.
import type { WaiterId, WaiterSseEvent } from '../../shared/types'

const enc = new TextEncoder()

export type CloseCause = 'client' | 'superseded' | 'replaced-silently' | 'disarmed' | 'shutdown' | 'refused' | 'delivered-detach'

export interface WaiterConn {
  readonly id: WaiterId
  readonly gen: number
  readonly file: string
  readonly openedAt: number
  /** A handoff was pushed on this connection (the `wait` exits on it). */
  delivered: boolean
  readonly closed: boolean
  send(e: WaiterSseEvent): void
  comment(text: string): void
  /** Close from the server side. The registry's onClose sees `cause`. */
  close(cause: CloseCause): void
  /** Resolves once the consumer has pulled everything queued so far (bounded by timeoutMs), so a last event isn't lost. */
  drained(timeoutMs: number): Promise<void>
}

export interface WaiterStream {
  conn: WaiterConn
  body: ReadableStream<Uint8Array>
}

/** One waiter stream. `onClose(conn, cause)` runs exactly once: on close() or when the client goes away ('client'). */
export function openWaiterStream(o: {
  id: WaiterId
  gen: number
  file: string
  heartbeatMs: number
  onClose: (conn: WaiterConn, cause: CloseCause) => void
}): WaiterStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  let hb: ReturnType<typeof setInterval> | null = null
  const finish = (cause: CloseCause, closeController: boolean): void => {
    if (closed) return
    closed = true
    if (hb) clearInterval(hb)
    if (closeController) {
      try {
        controller.close()
      } catch {
        // the reader already went away
      }
    }
    o.onClose(conn, cause)
  }
  const write = (s: string): void => {
    if (closed) return
    try {
      controller.enqueue(enc.encode(s))
    } catch {
      finish('client', false)
    }
  }
  const conn: WaiterConn = {
    id: o.id,
    gen: o.gen,
    file: o.file,
    openedAt: Date.now(),
    delivered: false,
    get closed() {
      return closed
    },
    send(e) {
      write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    },
    comment(text) {
      write(`: ${text}\n\n`)
    },
    close(cause) {
      finish(cause, true)
    },
    async drained(timeoutMs) {
      const t0 = Date.now()
      while (!closed && (controller.desiredSize ?? 1) < 1 && Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5))
      }
    },
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      hb = setInterval(() => conn.comment('hb'), o.heartbeatMs)
      ;(hb as { unref?: () => void }).unref?.()
    },
    cancel() {
      finish('client', false)
    },
  })
  return { conn, body }
}

export type RegisterOutcome =
  | { accepted: true; replaced: WaiterConn | null; how: 'new' | 'newer-waiter' | 'replaced' | 'self-reconnect' }
  | { accepted: false; live: WaiterConn }

/** The live waiter per doc (D21). The caller handles presence; this only decides and notifies the losing stream. */
export class WaiterRegistry {
  private readonly live = new Map<string, WaiterConn>()

  get(file: string): WaiterConn | null {
    const c = this.live.get(file)
    return c && !c.closed ? c : null
  }

  register(conn: WaiterConn): RegisterOutcome {
    const old = this.get(conn.file)
    if (!old) {
      this.live.set(conn.file, conn)
      return { accepted: true, replaced: null, how: 'new' }
    }
    if (old.id === conn.id && conn.gen < old.gen) {
      conn.send({ event: 'superseded', data: { by: old.id, reason: 'replaced' } })
      conn.close('refused')
      return { accepted: false, live: old }
    }
    this.live.set(conn.file, conn)
    if (old.id !== conn.id) {
      old.send({ event: 'superseded', data: { by: conn.id, reason: 'newer-waiter' } })
      old.close('superseded')
      return { accepted: true, replaced: old, how: 'newer-waiter' }
    }
    if (conn.gen > old.gen) {
      old.send({ event: 'superseded', data: { by: conn.id, reason: 'replaced' } })
      old.close('superseded')
      return { accepted: true, replaced: old, how: 'replaced' }
    }
    old.close('replaced-silently')
    return { accepted: true, replaced: old, how: 'self-reconnect' }
  }

  /** Forget `conn` if it is the live one (it closed, delivered or was disarmed). Returns true when it was. */
  release(conn: WaiterConn): boolean {
    if (this.live.get(conn.file) !== conn) return false
    this.live.delete(conn.file)
    return true
  }

  all(): WaiterConn[] {
    return [...this.live.values()].filter((c) => !c.closed)
  }
}
