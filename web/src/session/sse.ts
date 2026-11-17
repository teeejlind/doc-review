// web/src/session/sse.ts (P2). The browser SSE stream with reconnect (CONTRACTS §8.6).
//
// One stream at a time. A dropped stream (onerror) is closed and reopened after a backoff (1, 2, 4, 8, 15, 30 s),
// with a fresh query built at reconnect time, so the session passes afterSeq / knownRev as of that moment and the
// server answers hello (+ resync when behind). Nothing relies on replay. close() stops for good.
import type { BrowserSseEvent, EventSourceLike, Transport } from '../../../shared/types'
import { backoffDelay } from './autosave'

export type SseHandlers = { [E in BrowserSseEvent['event']]?: (data: Extract<BrowserSseEvent, { event: E }>['data']) => void }

const EVENT_TYPES: ReadonlyArray<BrowserSseEvent['event']> = [
  'hello', 'doc-changed', 'sidecar-changed', 'presence', 'handoff', 'claude-activity', 'navigate', 'doc-removed', 'resync', 'server-shutdown',
]

export interface SseConnectionOptions {
  transport: Transport
  /** Built at every (re)connect. */
  path: () => string
  handlers: SseHandlers
  /** The stream dropped (before the reconnect delay). */
  onDrop?: (attempt: number) => void
  /** A stream was opened again after a drop. */
  onReconnect?: () => void
}

export class SseConnection {
  private es: EventSourceLike | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private closed = false
  private everOpened = false

  constructor(private readonly o: SseConnectionOptions) {}

  start(): void {
    if (this.closed || this.es) return
    let es: EventSourceLike
    try {
      es = this.o.transport.events(this.o.path())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.es = es
    const reconnected = this.everOpened
    this.everOpened = true
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        if (this.closed || this.es !== es) return
        let data: unknown
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }
        // a delivered event proves the stream is healthy: reset the backoff
        this.attempt = 0
        const h = this.o.handlers[type] as ((d: unknown) => void) | undefined
        h?.(data)
      })
    }
    es.onerror = () => {
      if (this.closed || this.es !== es) return
      this.es = null
      try {
        es.close()
      } catch {
        // already closed
      }
      this.o.onDrop?.(this.attempt)
      this.scheduleReconnect()
    }
    if (reconnected) this.o.onReconnect?.()
  }

  /** Drop the current stream and reconnect now (a hello with a new serverId, a manual retry). */
  reconnectNow(): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.es) {
      const es = this.es
      this.es = null
      es.close()
    }
    this.start()
  }

  get open(): boolean {
    return this.es !== null
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const es = this.es
    this.es = null
    es?.close()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return
    const delay = backoffDelay(this.attempt)
    this.attempt++
    this.timer = setTimeout(() => {
      this.timer = null
      this.start()
    }, delay)
  }
}
