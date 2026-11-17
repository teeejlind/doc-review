// web/src/session/readMarkers.ts (P2). Read-marker throttle (CONTRACTS §12.9).
//
// P3 calls session.markRead(thread, maxSeqOfThread) when a card has been visible long enough or the thread is
// activated; the session sends at most one marker per READ_MARK_THROTTLE_MS per thread (null = the doc-level marker).
// A call inside the window is not dropped: the highest upTo is kept and sent when the window ends. A marker at or
// below what the server already records is never sent.
import { CONSTANTS } from '../../../shared/types'
import type { ThreadId } from '../../../shared/types'

type Key = ThreadId | null

interface Slot {
  lastSent: number
  pending: number | null
  timer: ReturnType<typeof setTimeout> | null
}

export class ReadMarkerThrottle {
  private readonly slots = new Map<string, Slot>()
  private closed = false

  constructor(
    private readonly o: {
      send: (thread: Key, upTo: number) => void
      /** The cursor the server already holds for this key (from the review state). */
      known: (thread: Key) => number
      now: () => number
      throttleMs?: number
    },
  ) {}

  private get windowMs(): number {
    return this.o.throttleMs ?? CONSTANTS.READ_MARK_THROTTLE_MS
  }

  mark(thread: Key, upTo: number): void {
    if (this.closed || !Number.isInteger(upTo) || upTo <= 0) return
    const k = thread ?? ''
    let slot = this.slots.get(k)
    if (!slot) this.slots.set(k, (slot = { lastSent: -Infinity, pending: null, timer: null }))
    const already = Math.max(this.o.known(thread), slot.pending ?? 0)
    if (upTo <= already && slot.pending === null) return
    const now = this.o.now()
    if (now - slot.lastSent >= this.windowMs && slot.timer === null) {
      if (upTo <= this.o.known(thread)) return
      slot.lastSent = now
      this.o.send(thread, upTo)
      return
    }
    slot.pending = Math.max(slot.pending ?? 0, upTo)
    if (slot.timer === null) {
      const s = slot
      const wait = Math.max(0, s.lastSent + this.windowMs - now)
      s.timer = setTimeout(() => {
        s.timer = null
        const p = s.pending
        s.pending = null
        if (this.closed || p === null || p <= this.o.known(thread)) return
        s.lastSent = this.o.now()
        this.o.send(thread, p)
      }, wait)
    }
  }

  close(): void {
    this.closed = true
    for (const s of this.slots.values()) if (s.timer) clearTimeout(s.timer)
    this.slots.clear()
  }
}
