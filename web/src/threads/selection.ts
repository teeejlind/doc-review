// web/src/threads/selection.ts (P3; CONTRACTS §11.4, §12.1).
//
// One reader of bridge.getSelectionTarget() for the page. The floating Comment button and the top bar's Comment
// button both need the current target; asking the bridge from each on every selection change would compute anchors
// twice per keystroke. This watches bridge.onSelectionChange, reads the target once per animation frame (a burst of
// selection changes costs one read), caches it, and notifies subscribers.
import type { EditorBridge, SelectionTarget, Unsubscribe } from '../../../shared/types'

export interface SelectionWatch {
  /** The cached target (read on first use). */
  get(): SelectionTarget
  /** Read now (a click handler about to act on it). */
  refresh(): SelectionTarget
  subscribe(cb: (t: SelectionTarget) => void): Unsubscribe
  destroy(): void
}

export interface SelectionWatchOptions {
  bridge: Pick<EditorBridge, 'getSelectionTarget' | 'onSelectionChange'>
  raf?: (cb: () => void) => number
  caf?: (h: number) => void
}

export function createSelectionWatch(o: SelectionWatchOptions): SelectionWatch {
  const raf = o.raf ?? ((cb: () => void) => requestAnimationFrame(cb))
  const caf = o.caf ?? ((h: number) => cancelAnimationFrame(h))
  const subs = new Set<(t: SelectionTarget) => void>()
  let target: SelectionTarget = null
  let read = false
  let pending: number | null = null
  let destroyed = false

  const refresh = (): SelectionTarget => {
    target = o.bridge.getSelectionTarget()
    read = true
    return target
  }
  const off = o.bridge.onSelectionChange(() => {
    if (destroyed || pending !== null) return
    pending = raf(() => {
      pending = null
      if (destroyed) return
      const t = refresh()
      for (const cb of [...subs]) cb(t)
    })
  })

  return {
    get: () => (read ? target : refresh()),
    refresh,
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    destroy() {
      destroyed = true
      if (pending !== null) caf(pending)
      off()
      subs.clear()
    },
  }
}
