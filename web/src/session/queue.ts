// web/src/session/queue.ts (P2). The write queue (CONTRACTS §12.3).
//
// One FIFO for every write, one request in flight. Items: save (including recreate and Keep-mine saves), threadOp,
// decision, reopen, bulk (including bulk reopen), handoff, restore, policy, readMarker (coalesced), plus the
// session's own `reload` (a §12.6 reload runs in the queue so it waits for the in-flight request, step 1).
// The pagehide keepalive save and POST /api/flush bypass the queue (the page is going away).
//
// - A thread op, decision, handoff or restore enqueued while the editor is dirty flushes a save first (`flushFirst`),
//   so an anchor or decision never refers to text the server lacks.
// - Coalescing: an item enqueued with the key of an item still waiting (not in flight) merges into it and shares its
//   promise. Saves coalesce on 'save' (the plan is computed at send time, so one waiting save covers everything);
//   read markers coalesce per thread with the higher upTo.
// - `front` puts an item at the head (the planner's reopen items, which must be answered before the save, §6.6).
// - Discrete ops get their opKey at user-action time (the caller mints it before enqueueing); retries reuse it.

export type QueueKind =
  | 'save' | 'threadOp' | 'decision' | 'reopen' | 'bulk' | 'handoff' | 'restore' | 'policy' | 'readMarker' | 'reload'

/** The kinds that flush a dirty editor before they run (§12.3). */
export const FLUSH_FIRST_KINDS: ReadonlySet<QueueKind> = new Set<QueueKind>(['threadOp', 'decision', 'bulk', 'handoff', 'restore'])

interface Item {
  kind: QueueKind
  key: string | undefined
  run: () => Promise<unknown>
  merge: ((next: () => Promise<unknown>) => void) | undefined
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  promise: Promise<unknown>
  flushFirst: boolean
}

export interface EnqueueOptions {
  /** Merge with a waiting item of the same key. */
  coalesce?: string
  /** Called on the waiting item when a later enqueue merges into it; receives the later run function. */
  merge?: (laterRun: () => Promise<unknown>) => void
  /** Run before everything else that waits. */
  front?: boolean
  /** Override FLUSH_FIRST_KINDS. */
  flushFirst?: boolean
}

export interface WriteQueueOptions {
  /** Runs a save first if the editor is dirty (errors are swallowed: the item still runs). */
  flushFirst: () => Promise<void>
  /** Called whenever the queue drains. */
  onIdle?: () => void
}

export class WriteQueue {
  private readonly items: Item[] = []
  private running: Item | null = null
  private idleWaiters: Array<() => void> = []
  private closed = false

  constructor(private readonly o: WriteQueueOptions) {}

  enqueue<T>(kind: QueueKind, run: () => Promise<T>, eo: EnqueueOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('mdr session: the write queue is closed'))
    if (eo.coalesce !== undefined) {
      const waiting = this.items.find((x) => x.key === eo.coalesce)
      if (waiting) {
        waiting.merge?.(run as () => Promise<unknown>)
        return waiting.promise as Promise<T>
      }
    }
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    const item: Item = {
      kind,
      key: eo.coalesce,
      run: run as () => Promise<unknown>,
      merge: eo.merge,
      resolve,
      reject,
      promise,
      flushFirst: eo.flushFirst ?? FLUSH_FIRST_KINDS.has(kind),
    }
    if (eo.front) this.items.unshift(item)
    else this.items.push(item)
    void this.pump()
    return promise as Promise<T>
  }

  /** true while an item is in flight or waiting. */
  get busy(): boolean {
    return this.running !== null || this.items.length > 0
  }

  /** Kind of the item in flight, if any. */
  get inFlight(): QueueKind | null {
    return this.running?.kind ?? null
  }

  has(kind: QueueKind): boolean {
    return this.running?.kind === kind || this.items.some((x) => x.kind === kind)
  }

  /** Resolves when nothing is in flight or waiting. */
  idle(): Promise<void> {
    if (!this.busy) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  /** Rejects everything still waiting; the item in flight finishes on its own. */
  close(): void {
    this.closed = true
    const err = new Error('mdr session: closed')
    for (const it of this.items.splice(0)) it.reject(err)
  }

  private async pump(): Promise<void> {
    if (this.running) return
    const item = this.items.shift()
    if (!item) {
      const w = this.idleWaiters
      this.idleWaiters = []
      for (const r of w) r()
      this.o.onIdle?.()
      return
    }
    this.running = item
    try {
      if (item.flushFirst) {
        try {
          await this.o.flushFirst()
        } catch {
          // the item still runs; a failed flush already set the save state
        }
      }
      item.resolve(await item.run())
    } catch (e) {
      item.reject(e)
    } finally {
      this.running = null
      void this.pump()
    }
  }
}
