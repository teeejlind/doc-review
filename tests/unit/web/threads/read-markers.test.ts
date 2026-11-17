// tests/unit/web/threads/read-markers.test.ts (P3; CONTRACTS §12.9, R2.7).
//
// A card with unread Claude activity is marked read after READ_MARK_DWELL_MS at >= READ_MARK_VISIBLE_RATIO visible
// with the window focused, or at once on activation; once per (thread, seq); never for a card folded into the
// "+N above" chip.
import { describe, expect, it } from 'vitest'
import { CONSTANTS } from '../../../../shared/constants'
import type { ThreadId } from '../../../../shared/types'
import { createReadMarkers, visibleRatio, type IntersectionEntryLike, type IntersectionObserverCtor } from '../../../../web/src/threads/read-markers'

const T1 = 't_1' as ThreadId
const T2 = 't_2' as ThreadId

function harness() {
  let now = 0
  const timers: Array<{ at: number; cb: () => void; id: number }> = []
  let seq = 0
  const marks: Array<[ThreadId, number]> = []
  let ioCb: ((e: IntersectionEntryLike[]) => void) | null = null
  const observed = new Set<Element>()
  const IO = class {
    constructor(cb: (e: IntersectionEntryLike[]) => void) {
      ioCb = cb
    }
    observe(el: Element) {
      observed.add(el)
    }
    unobserve(el: Element) {
      observed.delete(el)
    }
    disconnect() {
      observed.clear()
    }
  } as unknown as IntersectionObserverCtor
  const listeners = new Map<string, () => void>()
  let focused = true
  const rm = createReadMarkers({
    root: null,
    markRead: (t, up) => marks.push([t, up]),
    IntersectionObserver: IO,
    win: { addEventListener: (t: string, cb: () => void) => listeners.set(t, cb), removeEventListener: (t: string) => listeners.delete(t) } as never,
    hasFocus: () => focused,
    setTimer: (cb, ms) => {
      const id = ++seq
      timers.push({ at: now + ms, cb, id })
      return id
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  const card = (placed = 'true'): HTMLElement => {
    const el = document.createElement('article')
    el.dataset.placed = placed
    return el
  }
  const show = (el: Element, ratio: number, height = 100): void =>
    ioCb!([{ target: el, isIntersecting: ratio > 0, intersectionRect: { height: height * ratio }, boundingClientRect: { height }, rootBounds: { height: 800 } }])
  const advance = (ms: number): void => {
    now += ms
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1)
      t.cb()
    }
  }
  return {
    rm, marks, card, show, advance, observed,
    blur: () => { focused = false; listeners.get('blur')?.() },
    focus: () => { focused = true; listeners.get('focus')?.() },
  }
}

describe('read markers (§12.9)', () => {
  it('marks read after the dwell at >= 50% visible, up to the thread’s latest seq', () => {
    const h = harness()
    const el = h.card()
    h.rm.observe(T1, el, { unread: 2, upTo: 40 })
    h.show(el, 0.6)
    h.advance(CONSTANTS.READ_MARK_DWELL_MS - 1)
    expect(h.marks).toEqual([])
    h.advance(1)
    expect(h.marks).toEqual([[T1, 40]])
  })

  it('less than 50% visible, or leaving before the dwell ends, marks nothing', () => {
    const h = harness()
    const el = h.card()
    h.rm.observe(T1, el, { unread: 1, upTo: 10 })
    h.show(el, 0.4)
    h.advance(5000)
    expect(h.marks).toEqual([])
    h.show(el, 0.9)
    h.advance(1000)
    h.show(el, 0)
    h.advance(5000)
    expect(h.marks).toEqual([])
  })

  it('needs window focus: a blur cancels the dwell, a focus restarts it', () => {
    const h = harness()
    const el = h.card()
    h.rm.observe(T1, el, { unread: 1, upTo: 10 })
    h.show(el, 1)
    h.advance(1000)
    h.blur()
    h.advance(5000)
    expect(h.marks).toEqual([])
    h.focus()
    h.advance(CONSTANTS.READ_MARK_DWELL_MS)
    expect(h.marks).toEqual([[T1, 10]])
  })

  it('a card taller than the viewport counts when it fills the viewport', () => {
    expect(visibleRatio({ isIntersecting: true, intersectionRect: { height: 800 }, boundingClientRect: { height: 3000 }, rootBounds: { height: 800 } })).toBe(1)
  })

  it('a card folded into the "+N above" chip or not laid out never counts', () => {
    const h = harness()
    const el = h.card('overflow')
    h.rm.observe(T1, el, { unread: 1, upTo: 10 })
    h.show(el, 1)
    h.advance(5000)
    expect(h.marks).toEqual([])
  })

  it('marks each (thread, seq) once; a newer Claude reply arms it again', () => {
    const h = harness()
    const el = h.card()
    h.rm.observe(T1, el, { unread: 1, upTo: 10 })
    h.show(el, 1)
    h.advance(2000)
    // the review hasn't come back yet: same unread, same seq
    h.rm.update(T1, { unread: 1, upTo: 10 })
    h.advance(5000)
    expect(h.marks).toEqual([[T1, 10]])
    h.rm.update(T1, { unread: 0, upTo: 10 })
    h.rm.update(T1, { unread: 1, upTo: 12 })
    h.advance(CONSTANTS.READ_MARK_DWELL_MS)
    expect(h.marks).toEqual([[T1, 10], [T1, 12]])
  })

  it('activation marks read at once; threads with nothing unread are never marked', () => {
    const h = harness()
    h.rm.observe(T1, h.card(), { unread: 3, upTo: 7 })
    h.rm.observe(T2, h.card(), { unread: 0, upTo: 9 })
    h.rm.activated(T2)
    h.rm.activated(T1)
    h.rm.activated(T1)
    expect(h.marks).toEqual([[T1, 7]])
  })

  it('unobserving stops tracking the element', () => {
    const h = harness()
    const el = h.card()
    h.rm.observe(T1, el, { unread: 1, upTo: 1 })
    expect(h.observed.has(el)).toBe(true)
    h.rm.observe(T1, null)
    expect(h.observed.has(el)).toBe(false)
  })
})
