// tests/unit/web/rail/scheduler.test.ts (P3; CONTRACTS §11.3, §11.4).
//
// The rail scheduler: one layout per frame however many sources fire; never on scroll (no listener, and scrolling
// changes no card's top − anchorY); reads in content coordinates (railTop, minTop) and writes transforms relative to
// railTop; heights from the ResizeObserver cache; card-body compensation keeps the card under the cursor while
// composer/control activation never scrolls.
import { describe, expect, it, vi } from 'vitest'
import type { AnchorRect, EditorBridge, RailLayoutInput } from '../../../../shared/types'
import { CONSTANTS } from '../../../../shared/constants'
import { layoutRail } from '../../../../core/rail/layout'
import {
  compensatedScrollTop, createRailScheduler, DEFAULT_COLLAPSED_HEIGHT, type FontsLike, type RailCardSpec, type RailSchedulerOptions,
  type ResizeObserverCtor,
} from '../../../../web/src/rail/scheduler'

// ------------------------------------------------------------------ harness

type Box = { top: number; height: number }

/** Stubs getBoundingClientRect with a mutable box (client coordinates). */
function boxed(el: HTMLElement, box: Box): Box {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: box.top, bottom: box.top + box.height, height: box.height, left: 0, right: 300, width: 300, x: 0, y: box.top, toJSON: () => ({}) }),
  })
  return box
}

class FakeRO {
  static all: FakeRO[] = []
  observed = new Set<Element>()
  constructor(public cb: (entries: Array<{ target: Element; borderBoxSize?: Array<{ blockSize: number }> }>) => void) {
    FakeRO.all.push(this)
  }
  observe(el: Element): void {
    this.observed.add(el)
  }
  unobserve(el: Element): void {
    this.observed.delete(el)
  }
  disconnect(): void {
    this.observed.clear()
  }
  fire(target: Element, blockSize: number): void {
    this.cb([{ target, borderBoxSize: [{ blockSize }] }])
  }
}

function setup(o: {
  anchors?: Record<string, number | null>
  cards?: RailCardSpec[]
  active?: string | null
  containerTop?: number
  railTop?: number
  headerHeight?: number | null
  extra?: Partial<RailSchedulerOptions>
} = {}) {
  FakeRO.all = []
  const frames: Array<() => void> = []
  const raf = vi.fn((cb: () => void) => frames.push(cb))
  const caf = vi.fn()
  const runFrame = (): void => {
    const q = frames.splice(0)
    for (const f of q) f()
  }
  const container = document.createElement('div')
  const rail = document.createElement('aside')
  const header = document.createElement('div')
  const content = document.createElement('div')
  container.append(rail, content)
  rail.append(header)
  document.body.append(container)
  const cBox = boxed(container, { top: o.containerTop ?? 50, height: 800 })
  // the rail and header move with scroll in client space: client top = containerTop + contentTop − scrollTop
  const railContentTop = o.railTop ?? 0
  Object.defineProperty(rail, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const t = cBox.top + railContentTop - container.scrollTop
      return { top: t, bottom: t + 2000, height: 2000, left: 0, right: 300, width: 300, x: 0, y: t, toJSON: () => ({}) }
    },
  })
  const hh = o.headerHeight === undefined ? 40 : o.headerHeight
  Object.defineProperty(header, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const t = cBox.top + railContentTop - container.scrollTop
      return { top: t, bottom: t + (hh ?? 0), height: hh ?? 0, left: 0, right: 300, width: 300, x: 0, y: t, toJSON: () => ({}) }
    },
  })

  const anchors: Record<string, number | null> = { ...(o.anchors ?? {}) }
  const layoutCbs = new Set<(r: 'doc' | 'decorations' | 'reload' | 'mode' | 'resize') => void>()
  const getAnchorRects = vi.fn((ids: readonly string[]) => {
    const m = new Map<string, AnchorRect | null>()
    for (const id of ids) {
      const y = anchors[id]
      m.set(id, y === null || y === undefined ? null : { top: y, bottom: y + 24, left: 0 })
    }
    return m
  })
  const bridge: Pick<EditorBridge, 'getAnchorRects' | 'onLayoutInvalidated'> = {
    getAnchorRects,
    onLayoutInvalidated(cb) {
      layoutCbs.add(cb)
      return () => layoutCbs.delete(cb)
    },
  }
  let cards = o.cards ?? Object.keys(anchors).map((id, i) => ({ id: id as RailCardSpec['id'], order: i }))
  let active = o.active ?? null
  const fontListeners = new Set<() => void>()
  let resolveReady: () => void = () => undefined
  const fonts: FontsLike = {
    addEventListener: (_t, cb) => fontListeners.add(cb),
    removeEventListener: (_t, cb) => fontListeners.delete(cb),
    ready: new Promise<void>((r) => (resolveReady = r)),
  }
  const layout = vi.fn((input: RailLayoutInput) => layoutRail(input))
  const onFrame = vi.fn()
  const win = new EventTarget() as unknown as Window
  const s = createRailScheduler({
    bridge, container, rail, header: hh === null ? null : header, content,
    getCards: () => cards, getActiveId: () => active,
    raf, caf, ResizeObserver: FakeRO as unknown as ResizeObserverCtor, fonts, win, layout, onFrame,
    ...(o.extra ?? {}),
  })
  const ro = FakeRO.all[0]!

  /** A card element with full and collapsed parts, registered and measured. */
  const addCard = (id: string, full = 100, collapsed = 30) => {
    const el = document.createElement('article')
    const body = document.createElement('div')
    const head = document.createElement('div')
    el.append(head, body)
    rail.append(el)
    boxed(body, { top: 0, height: full })
    boxed(head, { top: 0, height: collapsed })
    // the card's client rect follows its transform
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform)
        const t = cBox.top + railContentTop - container.scrollTop + (m ? Number(m[1]) : 0)
        return { top: t, bottom: t + full, height: full, left: 0, right: 300, width: 300, x: 0, y: t, toJSON: () => ({}) }
      },
    })
    s.registerCard(id, el, { full: body, collapsed: head })
    return { el, body, head }
  }

  return {
    s, raf, caf, frames, runFrame, container, rail, header, content, ro, bridge, getAnchorRects, layoutCbs, fontListeners,
    resolveReady: () => resolveReady(), layout, onFrame, win, anchors, addCard,
    setCards: (c: RailCardSpec[]) => (cards = c),
    setActive: (a: string | null) => (active = a),
    cBox,
  }
}

const ty = (el: HTMLElement): number => Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? NaN)

// ------------------------------------------------------------------ coalescing and sources

describe('rail scheduler: when it runs (§11.3)', () => {
  it('one requestAnimationFrame and one layout per frame, however many invalidations arrive', () => {
    const h = setup({ anchors: { t_a: 100, t_b: 300 } })
    h.addCard('t_a')
    h.addCard('t_b')
    expect(h.raf).toHaveBeenCalledTimes(1)
    h.s.invalidate('active')
    h.s.invalidate('threads')
    h.s.invalidate('pin')
    h.s.invalidate('active')
    h.layoutCbs.forEach((cb) => cb('doc'))
    h.win.dispatchEvent(new Event('resize'))
    expect(h.raf).toHaveBeenCalledTimes(1)
    h.runFrame()
    expect(h.s.frameCount).toBe(1)
    expect(h.layout).toHaveBeenCalledTimes(1)
    expect(h.getAnchorRects).toHaveBeenCalledTimes(1)
    expect(h.onFrame.mock.calls[0]![0].reasons).toEqual(['init', 'threads', 'active', 'pin', 'bridge', 'window-resize'])
    // nothing dirty → no further frame
    h.runFrame()
    expect(h.s.frameCount).toBe(1)
    expect(h.raf).toHaveBeenCalledTimes(1)
  })

  it('every §11.3 source schedules a frame: bridge, card / content / header resize, window resize, fonts', async () => {
    const h = setup({ anchors: { t_a: 100 } })
    const { body } = h.addCard('t_a')
    h.runFrame()
    const runs = (): number => h.s.frameCount
    const expectFrame = (label: string, fire: () => void): void => {
      const before = runs()
      fire()
      h.runFrame()
      expect(runs(), label).toBe(before + 1)
    }
    expectFrame('bridge', () => h.layoutCbs.forEach((cb) => cb('decorations')))
    expectFrame('card resize', () => h.ro.fire(body, 140))
    expectFrame('content resize', () => h.ro.fire(h.content, 999))
    expectFrame('header resize', () => h.ro.fire(h.header, 64))
    expectFrame('window resize', () => h.win.dispatchEvent(new Event('resize')))
    expectFrame('fonts loadingdone', () => h.fontListeners.forEach((cb) => cb()))
    const before = runs()
    h.resolveReady()
    await Promise.resolve()
    await Promise.resolve()
    h.runFrame()
    expect(runs(), 'fonts ready').toBe(before + 1)
    expect(h.ro.observed.has(h.content)).toBe(true)
    expect(h.ro.observed.has(h.header)).toBe(true)
  })

  it('a ResizeObserver report with an unchanged height schedules nothing', () => {
    const h = setup({ anchors: { t_a: 100 } })
    const { body } = h.addCard('t_a', 100)
    h.ro.fire(body, 100)
    h.runFrame()
    const n = h.s.frameCount
    h.ro.fire(body, 100)
    h.runFrame()
    expect(h.s.frameCount).toBe(n)
  })

  it('never on scroll: no listener, no frame, and every card keeps top − anchorY', () => {
    const spy = vi.spyOn(EventTarget.prototype, 'addEventListener')
    const h = setup({ anchors: { t_a: 100, t_b: 140, t_c: 900 }, active: 't_b' })
    const cards = ['t_a', 't_b', 't_c'].map((id) => h.addCard(id).el)
    expect(spy.mock.calls.map((c) => c[0])).not.toContain('scroll')
    spy.mockRestore()
    h.runFrame()
    const before = cards.map((el) => ty(el))
    const rafCalls = h.raf.mock.calls.length
    h.container.scrollTop = 500
    h.container.dispatchEvent(new Event('scroll'))
    h.win.dispatchEvent(new Event('scroll'))
    h.runFrame()
    expect(h.raf.mock.calls.length).toBe(rafCalls)
    expect(h.s.frameCount).toBe(1)
    // and a relayout after scrolling yields the same positions (content coordinates are scroll-independent)
    h.s.invalidate('active')
    h.runFrame()
    expect(cards.map((el) => ty(el))).toEqual(before)
    expect(h.s.lastFrame()!.railTop).toBe(0)
  })

  it('registering the same element twice does not re-invalidate; unregistering does', () => {
    const h = setup({ anchors: { t_a: 100 } })
    const { el, body, head } = h.addCard('t_a')
    h.runFrame()
    h.s.registerCard('t_a', el, { full: body, collapsed: head })
    expect(h.s.isDirty()).toBe(false)
    h.s.registerCard('t_a', null)
    expect(h.s.isDirty()).toBe(true)
    expect(h.ro.observed.has(body)).toBe(false)
  })

  it('destroy cancels the pending frame and detaches every source', () => {
    const h = setup({ anchors: { t_a: 100 } })
    h.addCard('t_a')
    h.s.destroy()
    expect(h.caf).toHaveBeenCalled()
    h.runFrame()
    h.win.dispatchEvent(new Event('resize'))
    h.layoutCbs.forEach((cb) => cb('doc'))
    h.fontListeners.forEach((cb) => cb())
    h.runFrame()
    expect(h.s.frameCount).toBe(0)
    expect(h.layoutCbs.size).toBe(0)
    expect(h.fontListeners.size).toBe(0)
  })

  it('flush runs the pending frame synchronously', () => {
    const h = setup({ anchors: { t_a: 100 } })
    h.addCard('t_a')
    h.s.flush()
    expect(h.s.frameCount).toBe(1)
    expect(h.caf).toHaveBeenCalled()
    h.s.flush()
    expect(h.s.frameCount).toBe(1)
  })
})

// ------------------------------------------------------------------ the frame: read, layout, write

describe('rail scheduler: each frame (§11.3)', () => {
  it('reads railTop and minTop in content coordinates and writes translateY(top − railTop)', () => {
    // container at client y 50, scrolled 200; the rail starts at content y 120 and its header is 40 tall
    const h = setup({ anchors: { t_a: 300, t_b: 140 }, containerTop: 50, railTop: 120, headerHeight: 40 })
    h.container.scrollTop = 200
    const a = h.addCard('t_a', 100).el
    const b = h.addCard('t_b', 100).el
    h.runFrame()
    const f = h.s.lastFrame()!
    expect(f.railTop).toBe(120)
    expect(f.minTop).toBe(160)
    // no active: forward from minTop. t_b (anchor 140) → 160; t_a (anchor 300) → max(300, 160 + 100 + 8) = 300
    expect(ty(b)).toBe(160 - 120)
    expect(ty(a)).toBe(300 - 120)
    expect(a.dataset.placed).toBe('true')
    expect(a.dataset.collapsed).toBe('false')
    expect(h.rail.style.minHeight).toBe(`${400 - 120}px`)
  })

  it('a card with its own anchorY (the new-comment draft) follows the bridge’s rect when there is one, and falls back to that y when there is none', () => {
    // the draft's highlight moves with the text when an edit lands above it (Pass 4 rail-ui 10); anchorY is its y at click time
    const h = setup({ anchors: { t_draft: 520 }, cards: [{ id: 't_draft', order: 0, anchorY: 300, pinExpanded: true }], containerTop: 50, railTop: 120, headerHeight: 40 })
    const { el } = h.addCard('t_draft', 100)
    h.runFrame()
    expect(h.s.lastFrame()!.anchors.get('t_draft')).toBe(520)
    expect(ty(el)).toBe(520 - 120)
    // the highlight is gone (the selection was deleted): the y it was opened at
    h.anchors.t_draft = null
    h.layoutCbs.forEach((cb) => cb('doc'))
    h.runFrame()
    expect(h.s.lastFrame()!.anchors.get('t_draft')).toBe(300)
    expect(ty(el)).toBe(300 - 120)
  })

  it('keeps the whole-document dock’s room under the last card, and follows it when it changes', () => {
    let reserve = 70
    const h = setup({ anchors: { t_a: 300 }, containerTop: 50, railTop: 120, headerHeight: 40, extra: { getBottomReserve: () => reserve } })
    h.addCard('t_a', 100)
    h.runFrame()
    // the card ends at content y 400; the rail ends 70 px below it
    expect(h.rail.style.minHeight).toBe(`${400 - 120 + 70}px`)
    reserve = 0
    h.s.invalidate('dock')
    h.runFrame()
    expect(h.s.lastFrame()!.reasons).toEqual(['dock'])
    expect(h.rail.style.minHeight).toBe(`${400 - 120}px`)
  })

  it('feeds layoutRail the anchor rects as-is, the ResizeObserver heights and the contract constants', () => {
    const h = setup({ anchors: { t_a: 100, t_b: 500 }, cards: [{ id: 't_a', order: 3 }, { id: 't_b', order: 9, pinExpanded: true }], active: 't_b', headerHeight: null })
    const a = h.addCard('t_a', 120, 32)
    h.addCard('t_b', 90, 28)
    h.ro.fire(a.body, 150)
    h.runFrame()
    const input = h.layout.mock.calls.at(-1)![0]
    expect(input).toEqual({
      cards: [
        { id: 't_a', anchorY: 100, order: 3, height: 150, collapsedHeight: 32 },
        { id: 't_b', anchorY: 500, order: 9, height: 90, collapsedHeight: 28, pinExpanded: true },
      ],
      activeId: 't_b',
      gap: CONSTANTS.RAIL_GAP,
      minTop: 0,
      collapseDisplacement: CONSTANTS.RAIL_COLLAPSE_DISPLACEMENT,
      cluster: { maxAnchorGap: CONSTANTS.RAIL_CLUSTER_MAX_ANCHOR_GAP, minRun: CONSTANTS.RAIL_CLUSTER_MIN_RUN },
    })
    expect(h.getAnchorRects).toHaveBeenCalledWith(['t_a', 't_b'])
  })

  it('a card registered without a collapsed part uses the default collapsed height', () => {
    const h = setup({ anchors: { t_a: 100 } })
    const el = document.createElement('article')
    boxed(el, { top: 0, height: 77 })
    h.s.registerCard('t_a', el)
    h.runFrame()
    expect(h.layout.mock.calls.at(-1)![0].cards[0]).toMatchObject({ height: 77, collapsedHeight: DEFAULT_COLLAPSED_HEIGHT })
  })

  it('cards without an anchor rect are not laid out and are marked unplaced', () => {
    const anchors = { t_0: 0, t_1: 10, t_x: null, t_2: 20 }
    const h = setup({ anchors, active: 't_2', headerHeight: 0 })
    const els = Object.fromEntries(Object.keys(anchors).map((id) => [id, h.addCard(id, 80, 30).el]))
    h.runFrame()
    const f = h.s.lastFrame()!
    expect(f.unplaced).toEqual(['t_x'])
    expect(els.t_x!.dataset.placed).toBe('false')
    expect(els.t_2!.dataset.placed).toBe('true')
  })

  it('cards that can’t fit above the active one are not hidden: the active card gives up its pin and the cluster packs down from the header (QA3 rail-ui 3 / 11)', () => {
    // active at 60, five cards crammed above it under a 40 px header: pinned, some would overflow behind a chip
    const anchors = { t_0: 0, t_1: 10, t_2: 20, t_3: 30, t_4: 40, t_5: 60 }
    const h = setup({ anchors, active: 't_5', headerHeight: 40 })
    const els = Object.fromEntries(Object.keys(anchors).map((id) => [id, h.addCard(id, 80, 30).el]))
    h.runFrame()
    const f = h.s.lastFrame()!
    // the engine was asked twice: pinned first, then unpinned (the active card kept open)
    expect(h.layout.mock.calls.length).toBeGreaterThanOrEqual(2)
    const last = h.layout.mock.calls.at(-1)![0]
    expect(last.activeId).toBeNull()
    expect(last.cards.find((c) => c.id === 't_5')).toMatchObject({ pinExpanded: true })
    // nothing folds behind a chip: every card is placed, in anchor order, none above the header
    expect(f.output.overflowAbove).toEqual([])
    for (const id of Object.keys(anchors)) expect(els[id]!.dataset.placed).toBe('true')
    const tops = Object.keys(anchors).map((id) => ty(els[id]!))
    expect(tops).toEqual([...tops].sort((a, b) => a - b))
    expect(tops[0]).toBeGreaterThanOrEqual(0)
    // the active card stays open, below its anchor
    expect(els.t_5!.dataset.collapsed).toBe('false')
    expect(ty(els.t_5!)).toBeGreaterThan(60)
  })

  it('writes each card’s free space below it as --shell-room, so a hover overlay opens only into free space (QA3 rail-ui 8)', () => {
    // three collapsed cards 48 px apart (30 + the gap), then a loose one far below
    const anchors = { t_0: 100, t_1: 110, t_2: 120, t_3: 600 }
    const h = setup({ anchors, headerHeight: 0 })
    const els = Object.fromEntries(Object.keys(anchors).map((id) => [id, h.addCard(id, 90, 30).el]))
    h.runFrame()
    const room = (id: string): string => els[id]!.style.getPropertyValue('--shell-room')
    expect(room('t_0')).toBe('0px')
    expect(room('t_1')).toBe('0px')
    // below the last cluster card there is real space before the loose card
    expect(parseFloat(room('t_2'))).toBeGreaterThan(300)
    // the last card has nothing below it
    expect(room('t_3')).toBe('9999px')
  })

  it('a pinned active card that fits is still pinned (one layout call, nothing changes)', () => {
    const h = setup({ anchors: { t_0: 100, t_1: 400 }, active: 't_1', headerHeight: 40 })
    const els = [h.addCard('t_0', 80, 30).el, h.addCard('t_1', 80, 30).el]
    h.runFrame()
    expect(h.layout.mock.calls.at(-1)![0].activeId).toBe('t_1')
    expect(ty(els[1]!)).toBe(400)
  })

  it('a first placement (and a return from hidden) is instant; an ordinary move animates', () => {
    const h = setup({ anchors: { t_a: 100, t_b: 300 }, headerHeight: 0 })
    const a = h.addCard('t_a', 100).el
    const b = h.addCard('t_b', 100).el
    h.runFrame()
    expect(a.dataset.instant).toBe('true')
    expect(b.dataset.instant).toBe('true')
    h.anchors.t_a = 150
    h.s.invalidate('bridge')
    h.runFrame()
    expect(ty(a)).toBe(150)
    expect(a.dataset.instant).toBeUndefined()
    expect(b.dataset.instant).toBeUndefined()
    h.anchors.t_b = null
    h.s.invalidate('bridge')
    h.runFrame()
    expect(b.dataset.placed).toBe('false')
    h.anchors.t_b = 320
    h.s.invalidate('bridge')
    h.runFrame()
    expect(b.dataset.placed).toBe('true')
    expect(b.dataset.instant).toBe('true')
    expect(a.dataset.instant).toBeUndefined()
  })

  it('an active id that is unplaced this frame lays out as no active card', () => {
    const h = setup({ anchors: { t_a: 100, t_b: null }, active: 't_b' })
    h.addCard('t_a')
    h.addCard('t_b')
    h.runFrame()
    expect(h.layout.mock.calls.at(-1)![0].activeId).toBeNull()
  })

  it('a growing active card (a long reply) moves nothing above it', () => {
    const h = setup({ anchors: { t_a: 100, t_b: 200, t_c: 400 }, active: 't_b', headerHeight: 0 })
    const a = h.addCard('t_a', 60).el
    const b = h.addCard('t_b', 100)
    const c = h.addCard('t_c', 60).el
    h.runFrame()
    const [ta, tb, tc] = [ty(a), ty(b.el), ty(c)]
    h.ro.fire(b.body, 100 + 15 * 24)
    h.runFrame()
    expect(ty(a)).toBe(ta)
    expect(ty(b.el)).toBe(tb)
    expect(ty(c)).toBeGreaterThan(tc)
    expect(h.container.scrollTop).toBe(0)
  })
})

// ------------------------------------------------------------------ §11.4 activation scroll

describe('rail scheduler: activation and compensation (§11.4)', () => {
  it('compensatedScrollTop keeps the viewport y', () => {
    // card was at viewport 300; it moves to content top 900 in a container at client 50; scrollTop must be 650
    expect(compensatedScrollTop({ viewportTopBefore: 300, contentTop: 900, containerTop: 50, clientTop: 0 })).toBe(650)
    // and the resulting viewport y is the old one: 50 + 0 + 900 − 650 = 300
    expect(50 + 0 + 900 - 650).toBe(300)
    expect(compensatedScrollTop({ viewportTopBefore: 120, contentTop: 100, containerTop: 20, clientTop: 2 })).toBe(2)
  })

  it('a card-body click keeps the card under the cursor: the doc scrolls, the card does not move on screen', () => {
    // t_b is displaced far below its anchor by a tall t_a; activating t_b pins it to its anchor
    const h = setup({ anchors: { t_a: 100, t_b: 120 }, headerHeight: 0, containerTop: 50 })
    h.addCard('t_a', 600)
    const b = h.addCard('t_b', 80).el
    h.runFrame()
    h.container.scrollTop = 400
    const viewportBefore = b.getBoundingClientRect().top
    expect(ty(b)).toBe(708) // 100 + 600 + 8
    h.setActive('t_b')
    h.s.invalidate('activate', { compensate: true, cardId: 't_b' })
    h.runFrame()
    expect(ty(b)).toBe(120)
    expect(b.getBoundingClientRect().top).toBe(viewportBefore)
    expect(h.container.scrollTop).toBe(400 - (708 - 120))
    expect(b.dataset.instant).toBe('true')
    // the instant flag lasts one frame
    h.s.invalidate('active')
    h.runFrame()
    expect(b.dataset.instant).toBeUndefined()
    expect(h.container.scrollTop).toBe(400 - (708 - 120))
  })

  it('composer / control / keyboard activation never scrolls the doc (the card moves instead)', () => {
    const h = setup({ anchors: { t_a: 100, t_b: 120 }, headerHeight: 0 })
    h.addCard('t_a', 600)
    const b = h.addCard('t_b', 80).el
    h.runFrame()
    h.container.scrollTop = 400
    h.setActive('t_b')
    h.s.invalidate('activate', { compensate: false, cardId: 't_b' })
    h.runFrame()
    expect(ty(b)).toBe(120)
    expect(h.container.scrollTop).toBe(400)
    expect(b.dataset.instant).toBeUndefined() // it moves on screen, animated
  })

  it('a later non-compensating activation cancels a pending compensation', () => {
    const h = setup({ anchors: { t_a: 100, t_b: 120 }, headerHeight: 0 })
    h.addCard('t_a', 600)
    h.addCard('t_b', 80)
    h.runFrame()
    h.container.scrollTop = 400
    h.setActive('t_b')
    h.s.invalidate('activate', { compensate: true, cardId: 't_b' })
    h.s.invalidate('activate', { compensate: false, cardId: 't_b' })
    h.runFrame()
    expect(h.container.scrollTop).toBe(400)
  })
})
