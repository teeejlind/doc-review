// web/src/shell/ready.ts (P3; CONTRACTS §11.7 "Cold open").
//
// The `mdr:ready` user-timing mark that p3-perf measures cold open by. P3 sets it in the first requestAnimationFrame
// after both
//   (a) P2's `mdr:editor-ready` mark (doc rendered from load(), suggestions hydrated, highlights placed), and
//   (b) P3's first completed rail layout with every placed card positioned (a frame in which every card is laid
//       out, folded into "+N above", or known to have no anchor).
// In narrow mode there is no rail layout, so (b) holds as soon as the editor exists. The check runs again inside the
// frame, so a relayout queued by the editor-ready decorations is waited for rather than raced.
//
// (a) is read from the performance timeline: an existing entry first, then a PerformanceObserver (buffered), with a
// per-frame poll where the observer is missing (jsdom).

export const READY_MARK = 'mdr:ready'
export const EDITOR_READY_MARK = 'mdr:editor-ready'

type PerfLike = Pick<Performance, 'mark' | 'getEntriesByName'>
type ObserverCtor = new (cb: (list: { getEntries(): ReadonlyArray<{ name: string }> }) => void) => { observe(o: { type: string; buffered?: boolean }): void; disconnect(): void }

export interface ReadyMarkOptions {
  perf?: PerfLike | null
  raf?: (cb: () => void) => number
  caf?: (h: number) => void
  PerformanceObserver?: ObserverCtor | null
  /** false in narrow mode (no rail layout to wait for). Read on every check. */
  needsRail: () => boolean
  /** Called once, right after the mark is set. */
  onReady?: (startTime: number) => void
}

export interface ReadyMark {
  /** The editor exists (createEditor resolved): start watching for mdr:editor-ready. */
  editorCreated(): void
  /** Every rail frame: did it lay out every card? */
  railFrame(complete: boolean): void
  /** Re-check (narrow mode switched). */
  check(): void
  readonly done: boolean
  destroy(): void
}

export function createReadyMark(o: ReadyMarkOptions): ReadyMark {
  const perf = o.perf === undefined ? (typeof performance === 'undefined' ? null : performance) : o.perf
  const raf = o.raf ?? ((cb: () => void) => requestAnimationFrame(cb))
  const caf = o.caf ?? ((h: number) => cancelAnimationFrame(h))
  const PO = o.PerformanceObserver === undefined ? ((globalThis as { PerformanceObserver?: ObserverCtor }).PerformanceObserver ?? null) : o.PerformanceObserver
  let editorCreated = false
  let editorReady = false
  let railComplete = false
  let done = false
  let destroyed = false
  let frame: number | null = null
  let poll: number | null = null
  let observer: InstanceType<ObserverCtor> | null = null

  const hasMark = (name: string): boolean => {
    try {
      return !!perf && perf.getEntriesByName(name, 'mark').length > 0
    } catch {
      return false
    }
  }

  const ok = (): boolean => editorReady && (railComplete || !o.needsRail())

  function check(): void {
    if (done || destroyed || frame !== null || !ok()) return
    frame = raf(() => {
      frame = null
      if (done || destroyed || !ok()) return
      done = true
      let t = 0
      try {
        const m = perf?.mark(READY_MARK) as { startTime?: number } | undefined
        t = m?.startTime ?? 0
      } catch {
        // a page without user timing still works; p3-perf runs where it exists
      }
      stopWatching()
      o.onReady?.(t)
    })
  }

  function sawEditorReady(): void {
    if (editorReady) return
    editorReady = true
    stopWatching()
    check()
  }

  function stopWatching(): void {
    observer?.disconnect()
    observer = null
    if (poll !== null) caf(poll)
    poll = null
  }

  function watch(): void {
    if (hasMark(EDITOR_READY_MARK)) return sawEditorReady()
    if (PO) {
      try {
        observer = new PO((list) => {
          if (list.getEntries().some((e) => e.name === EDITOR_READY_MARK)) sawEditorReady()
        })
        observer.observe({ type: 'mark', buffered: true })
        return
      } catch {
        observer = null
      }
    }
    const tick = (): void => {
      poll = null
      if (destroyed || editorReady) return
      if (hasMark(EDITOR_READY_MARK)) sawEditorReady()
      else poll = raf(tick)
    }
    poll = raf(tick)
  }

  return {
    editorCreated() {
      if (editorCreated || destroyed) return
      editorCreated = true
      watch()
    },
    railFrame(complete) {
      railComplete = complete
      if (complete) check()
    },
    check,
    get done() {
      return done
    },
    destroy() {
      destroyed = true
      stopWatching()
      if (frame !== null) caf(frame)
      frame = null
    },
  }
}
