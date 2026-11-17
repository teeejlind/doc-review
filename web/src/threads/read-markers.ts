// web/src/threads/read-markers.ts (P3; CONTRACTS §12.9, R2.7).
//
// When TJ has seen a thread. A card with unread Claude activity (thread.unread > 0) that stays at least
// READ_MARK_VISIBLE_RATIO visible for READ_MARK_DWELL_MS while the window has focus, or that gets activated, is
// marked read up to its latest seq through session.markRead (the session throttles the requests). Cursors are
// server-side, so a reload keeps the dot cleared.
//
// "Visible" is measured against the scroll container. For a card taller than the container, the ratio is taken
// against the container's height (a card that fills the viewport counts). A card folded into the "+N above" chip
// or not laid out (data-placed overflow / false) never counts. Each (thread, seq) is marked once: the dot only
// clears after the review state comes back, and nothing re-sends in between.
import { CONSTANTS } from '../../../shared/constants'
import type { ThreadId } from '../../../shared/types'

export interface IntersectionEntryLike {
  target: Element
  isIntersecting: boolean
  intersectionRect: { height: number }
  boundingClientRect: { height: number }
  rootBounds: { height: number } | null
}
export interface IntersectionObserverLike {
  observe(el: Element): void
  unobserve(el: Element): void
  disconnect(): void
}
export type IntersectionObserverCtor = new (
  cb: (entries: IntersectionEntryLike[]) => void,
  init: { root: Element | null; threshold: number[] },
) => IntersectionObserverLike

export interface ReadMarkerOptions {
  /** The scroll container (#mdr-scroll); the visibility root. */
  root: HTMLElement | null
  markRead(thread: ThreadId, upTo: number): void
  IntersectionObserver?: IntersectionObserverCtor | null
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
  hasFocus?: () => boolean
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  dwellMs?: number
  ratio?: number
}

export interface ThreadReadInfo {
  unread: number
  /** The seq to mark read up to (thread.lastSeq). */
  upTo: number
}

export interface ReadMarkers {
  /** Register (or re-point) a card; null unregisters. */
  observe(id: ThreadId, el: Element | null, info?: ThreadReadInfo): void
  /** The thread's unread count or latest seq changed. */
  update(id: ThreadId, info: ThreadReadInfo): void
  /** Activation marks read at once (§12.9). */
  activated(id: ThreadId): void
  destroy(): void
}

/** Visible fraction of a card, against the smaller of its own height and the root's. */
export function visibleRatio(e: Pick<IntersectionEntryLike, 'isIntersecting' | 'intersectionRect' | 'boundingClientRect' | 'rootBounds'>): number {
  if (!e.isIntersecting) return 0
  const h = Math.min(e.boundingClientRect.height, e.rootBounds?.height ?? Infinity)
  return h > 0 ? Math.min(1, e.intersectionRect.height / h) : 0
}

const countsAsShown = (el: Element): boolean => {
  const placed = (el as HTMLElement).dataset?.placed
  return placed !== 'overflow' && placed !== 'false'
}

interface Entry {
  el: Element
  info: ThreadReadInfo
  visible: boolean
  timer: unknown
}

export function createReadMarkers(o: ReadMarkerOptions): ReadMarkers {
  const dwell = o.dwellMs ?? CONSTANTS.READ_MARK_DWELL_MS
  const ratio = o.ratio ?? CONSTANTS.READ_MARK_VISIBLE_RATIO
  const setTimer = o.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const win = o.win === undefined ? (typeof window === 'undefined' ? null : window) : o.win
  const hasFocus = o.hasFocus ?? (() => (typeof document === 'undefined' ? true : document.hasFocus()))
  const IO = o.IntersectionObserver === undefined ? ((globalThis as { IntersectionObserver?: IntersectionObserverCtor }).IntersectionObserver ?? null) : o.IntersectionObserver

  const entries = new Map<ThreadId, Entry>()
  const byEl = new Map<Element, ThreadId>()
  /** The last upTo sent per thread. */
  const sent = new Map<ThreadId, number>()
  let focused = hasFocus()
  let destroyed = false

  const send = (id: ThreadId, e: Entry): void => {
    if (e.info.unread <= 0) return
    if ((sent.get(id) ?? -1) >= e.info.upTo) return
    sent.set(id, e.info.upTo)
    o.markRead(id, e.info.upTo)
  }
  const stop = (e: Entry): void => {
    if (e.timer !== null) clearTimer(e.timer)
    e.timer = null
  }
  const arm = (id: ThreadId, e: Entry): void => {
    stop(e)
    if (destroyed || !focused || !e.visible || e.info.unread <= 0 || (sent.get(id) ?? -1) >= e.info.upTo) return
    e.timer = setTimer(() => {
      e.timer = null
      if (destroyed || !focused || !e.visible || !countsAsShown(e.el)) return
      send(id, e)
    }, dwell)
  }

  const io: IntersectionObserverLike | null = IO
    ? new IO(
        (list) => {
          for (const x of list) {
            const id = byEl.get(x.target)
            const e = id ? entries.get(id) : undefined
            if (!id || !e) continue
            const v = visibleRatio(x) >= ratio
            if (v === e.visible) continue
            e.visible = v
            arm(id, e)
          }
        },
        { root: o.root, threshold: [0, 0.25, 0.5, 0.75, 1] },
      )
    : null

  const onFocus = (): void => {
    focused = true
    for (const [id, e] of entries) arm(id, e)
  }
  const onBlur = (): void => {
    focused = false
    for (const e of entries.values()) stop(e)
  }
  win?.addEventListener('focus', onFocus)
  win?.addEventListener('blur', onBlur)

  return {
    observe(id, el, info) {
      const prev = entries.get(id)
      if (prev && (!el || prev.el !== el)) {
        stop(prev)
        io?.unobserve(prev.el)
        byEl.delete(prev.el)
        entries.delete(id)
      }
      if (!el || entries.has(id)) return
      const e: Entry = { el, info: info ?? { unread: 0, upTo: 0 }, visible: false, timer: null }
      entries.set(id, e)
      byEl.set(el, id)
      io?.observe(el)
    },
    update(id, info) {
      const e = entries.get(id)
      if (!e) return
      const changed = e.info.unread !== info.unread || e.info.upTo !== info.upTo
      e.info = info
      if (changed) arm(id, e)
    },
    activated(id) {
      const e = entries.get(id)
      if (e) send(id, e)
    },
    destroy() {
      destroyed = true
      for (const e of entries.values()) stop(e)
      io?.disconnect()
      win?.removeEventListener('focus', onFocus)
      win?.removeEventListener('blur', onBlur)
      entries.clear()
      byEl.clear()
    },
  }
}
