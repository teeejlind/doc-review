// web/src/rail/scheduler.ts (P3; CONTRACTS §11.3, §11.4).
//
// When the rail lays out. `invalidate(reason)` marks the rail dirty and ONE requestAnimationFrame runs the layout,
// however many sources fired in between. Dirty sources: bridge.onLayoutInvalidated, a ResizeObserver on every card
// (and on the editor content box and the rail header), window resize, document.fonts loadingdone / ready, and the
// rail's own activeId / thread-set / pinExpanded changes and the dock's height (the caller invalidates from an
// effect). Never on a React render and never on scroll: content coordinates don't change when the container
// scrolls, so there is no scroll listener at all.
//
// Each frame:
//   (the "+N above" chip no longer happens in practice: see step 2)
//   1. Read: bridge.getAnchorRects(ids) once (already content coordinates, §12.0.3: anchorY = rect.top as-is),
//      railTop (the rail's own top converted to content coordinates), minTop (the header's bottom, same space) and
//      any card height the ResizeObserver hasn't reported yet.
//   2. layoutRail (pure; core/rail/layout.ts).
//   3. Write through the card elements, never React state: style.transform = translateY(top − railTop),
//      data-collapsed, data-placed; the rail's min-height.
// Card-body activation (§11.4) passes `compensate: true`: the card's viewport y is recorded at invalidate time,
// and after the write the container scrolls by the difference so the card stays under the cursor (that one move
// skips the CSS transition). Composer, control and keyboard activation never compensate. A card's first placement,
// or its return from unplaced / overflow, is also instant (data-instant for one frame), so it never slides in.
import { CONSTANTS } from '../../../shared/constants'
import type { AnchorRect, EditorBridge, LayoutRail, RailCardInput, RailLayoutOutput, Unsubscribe } from '../../../shared/types'
import { layoutRail as defaultLayoutRail } from '../../../core/rail/layout'

export type RailInvalidateReason =
  | 'init'
  | 'bridge'
  | 'card-resize'
  | 'content-resize'
  | 'header-resize'
  | 'window-resize'
  | 'fonts'
  | 'active'
  | 'threads'
  | 'pin'
  | 'activate'
  | 'dock'

/** What the rail knows about a card before measuring it. */
export interface RailCardSpec {
  id: RailCardInput['id']
  /** Stable tiebreak: the anchor's ptext offset. */
  order: number
  pinExpanded?: boolean
  /**
   * Content-space anchor y supplied by the rail itself, for a card whose thread doesn't exist yet (the new-comment
   * draft: the selection's first line when it was opened). It is the fallback: the bridge's rect wins whenever it has
   * one (the draft's highlight is mapped through every edit, so an open draft follows its text when Claude's edit
   * moves the document); this y is only as fresh as the click.
   */
  anchorY?: number
}

export interface RailFrame {
  /** 1-based count of layout runs. */
  seq: number
  /** Why this frame ran (deduplicated, in first-seen order). */
  reasons: RailInvalidateReason[]
  railTop: number
  minTop: number
  output: RailLayoutOutput
  /** Card ids with no anchor rect this frame: not laid out, hidden. */
  unplaced: string[]
  /** anchorY of every laid-out card (content coordinates). */
  anchors: Map<string, number>
  /** The container's scrollTop after this frame's writes (compensation included). */
  scrollTop: number
}

/** Minimal ResizeObserver surface (jsdom has none; tests inject one). */
export interface ResizeObserverLike {
  observe(el: Element): void
  unobserve(el: Element): void
  disconnect(): void
}
export type ResizeObserverCtor = new (cb: (entries: ReadonlyArray<{ target: Element; borderBoxSize?: ReadonlyArray<{ blockSize: number }> }>) => void) => ResizeObserverLike

/** Minimal FontFaceSet surface. */
export interface FontsLike {
  addEventListener(type: 'loadingdone', cb: () => void): void
  removeEventListener(type: 'loadingdone', cb: () => void): void
  readonly ready: Promise<unknown>
}

export interface RailSchedulerOptions {
  bridge: Pick<EditorBridge, 'getAnchorRects' | 'onLayoutInvalidated'>
  /** #mdr-scroll: the single scroll container and the AnchorRect origin. */
  container: HTMLElement
  /** aside.mdr-rail: cards are positioned inside it. */
  rail: HTMLElement
  /** The editor content box (ResizeObserver). */
  content?: HTMLElement | null
  /** The rail header panel; minTop = its bottom in content coordinates (railTop without one). */
  header?: HTMLElement | null
  getCards(): readonly RailCardSpec[]
  getActiveId(): string | null
  /** Room kept under the last card (px): the whole-document dock hangs over the bottom of the rail's column. Default 0. */
  getBottomReserve?(): number
  /** After each frame's writes. Never calls back into layout synchronously. */
  onFrame?(frame: RailFrame): void
  layout?: LayoutRail
  /** Collapsed height for cards that register no collapsed element (px). */
  collapsedHeight?: number
  gap?: number
  collapseDisplacement?: number
  cluster?: { maxAnchorGap: number; minRun: number }
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
  raf?: (cb: () => void) => number
  caf?: (handle: number) => void
  ResizeObserver?: ResizeObserverCtor | null
  fonts?: FontsLike | null
}

export interface RailScheduler {
  invalidate(reason: RailInvalidateReason, o?: { compensate?: boolean; cardId?: string }): void
  /**
   * Ref callback for a card. `el` is the element the scheduler positions (null unregisters). `full` is the element
   * whose height is the card's FULL height (it must not be clipped when the card collapses; defaults to `el`);
   * `collapsed` is the one-line preview whose height is the collapsed height (defaults to `collapsedHeight`).
   */
  registerCard(id: string, el: HTMLElement | null, parts?: { full?: Element | null; collapsed?: Element | null }): void
  /** Layout runs so far. */
  readonly frameCount: number
  isDirty(): boolean
  /** Run the pending frame now, if any (tests, and the mdr:ready mark). */
  flush(): void
  lastFrame(): RailFrame | null
  destroy(): void
}

export const DEFAULT_COLLAPSED_HEIGHT = 40

/** Content-space y of an element's edge: r − C.top + scrollTop − clientTop (§12.0.3, §11.3). */
export function toContentY(clientY: number, container: HTMLElement, containerTop = container.getBoundingClientRect().top): number {
  return clientY - containerTop + container.scrollTop - container.clientTop
}

/**
 * §11.4 card-body click: the scrollTop that keeps the card's viewport y where it was before it moved to `contentTop`.
 * viewport y after = containerTop + clientTop + contentTop − scrollTop; solve for scrollTop.
 */
export function compensatedScrollTop(o: { viewportTopBefore: number; contentTop: number; containerTop: number; clientTop: number }): number {
  return o.containerTop + o.clientTop + o.contentTop - o.viewportTopBefore
}

interface CardEntry {
  el: HTMLElement
  full: Element
  collapsed: Element | null
}

export function createRailScheduler(o: RailSchedulerOptions): RailScheduler {
  const layout = o.layout ?? defaultLayoutRail
  const gap = o.gap ?? CONSTANTS.RAIL_GAP
  const collapseDisplacement = o.collapseDisplacement ?? CONSTANTS.RAIL_COLLAPSE_DISPLACEMENT
  const cluster = o.cluster ?? { maxAnchorGap: CONSTANTS.RAIL_CLUSTER_MAX_ANCHOR_GAP, minRun: CONSTANTS.RAIL_CLUSTER_MIN_RUN }
  const defaultCollapsed = o.collapsedHeight ?? DEFAULT_COLLAPSED_HEIGHT
  const win = o.win === undefined ? (typeof window === 'undefined' ? null : window) : o.win
  const raf = o.raf ?? ((cb: () => void) => requestAnimationFrame(cb))
  const caf = o.caf ?? ((h: number) => cancelAnimationFrame(h))
  const RO = o.ResizeObserver === undefined ? ((globalThis as { ResizeObserver?: ResizeObserverCtor }).ResizeObserver ?? null) : o.ResizeObserver
  const fonts = o.fonts === undefined ? ((typeof document !== 'undefined' ? (document as { fonts?: FontsLike }).fonts : undefined) ?? null) : o.fonts

  const cards = new Map<string, CardEntry>()
  const byTarget = new Map<Element, { id: string; role: 'full' | 'collapsed' }>()
  const heights = new Map<string, { full?: number; collapsed?: number }>()
  let pending: number | null = null
  let dirty = false
  let reasons: RailInvalidateReason[] = []
  let compensation: { id: string; viewportTopBefore: number } | null = null
  /** Cards written with data-instant this frame (first placement, back from hidden, compensated); cleared next frame. */
  let instant: HTMLElement[] = []
  let frameCount = 0
  let last: RailFrame | null = null
  let destroyed = false
  const offs: Unsubscribe[] = []

  const ro: ResizeObserverLike | null = RO
    ? new RO((entries) => {
        let changed = false
        for (const e of entries) {
          const t = byTarget.get(e.target)
          if (t) {
            const h = e.borderBoxSize?.[0]?.blockSize ?? e.target.getBoundingClientRect().height
            const cur = heights.get(t.id) ?? {}
            if (cur[t.role] !== h) {
              heights.set(t.id, { ...cur, [t.role]: h })
              changed = true
            }
          } else if (e.target === o.header) invalidate('header-resize')
          else if (e.target === o.content) invalidate('content-resize')
        }
        if (changed) invalidate('card-resize')
      })
    : null

  function invalidate(reason: RailInvalidateReason, opt?: { compensate?: boolean; cardId?: string }): void {
    if (destroyed) return
    if (opt?.compensate && opt.cardId) {
      const c = cards.get(opt.cardId)
      if (c) compensation = { id: opt.cardId, viewportTopBefore: c.el.getBoundingClientRect().top }
    } else if (reason === 'activate') compensation = null
    if (!reasons.includes(reason)) reasons.push(reason)
    dirty = true
    if (pending === null) pending = raf(frame)
  }

  function measure(id: string, entry: CardEntry): { full: number; collapsed: number } {
    const h = heights.get(id) ?? {}
    const full = h.full ?? entry.full.getBoundingClientRect().height
    const collapsed = entry.collapsed ? (h.collapsed ?? entry.collapsed.getBoundingClientRect().height) : defaultCollapsed
    if (h.full === undefined || (entry.collapsed && h.collapsed === undefined)) heights.set(id, { full, ...(entry.collapsed ? { collapsed } : {}) })
    return { full, collapsed }
  }

  function frame(): void {
    pending = null
    if (destroyed || !dirty) return
    dirty = false
    const why = reasons
    reasons = []
    for (const el of instant) delete el.dataset.instant
    instant = []

    // ---- 1. read
    const { container, rail } = o
    const cRect = container.getBoundingClientRect()
    const railTop = toContentY(rail.getBoundingClientRect().top, container, cRect.top)
    const minTop = o.header ? toContentY(o.header.getBoundingClientRect().bottom, container, cRect.top) : railTop
    const specs = o.getCards().filter((s) => cards.has(s.id))
    const asked = specs.map((s) => s.id)
    const rects: Map<string, AnchorRect | null> = asked.length ? o.bridge.getAnchorRects(asked) : new Map()
    const inputs: RailCardInput[] = []
    const unplaced: string[] = []
    const anchors = new Map<string, number>()
    for (const s of specs) {
      const y = rects.get(s.id)?.top ?? s.anchorY
      if (y === undefined || !Number.isFinite(y)) {
        unplaced.push(s.id)
        continue
      }
      const m = measure(s.id, cards.get(s.id)!)
      anchors.set(s.id, y)
      inputs.push({ id: s.id as RailCardInput['id'], anchorY: y, order: s.order, height: m.full, collapsedHeight: m.collapsed, ...(s.pinExpanded ? { pinExpanded: true } : {}) })
    }

    // ---- 2. layout
    const activeId = o.getActiveId()
    const pinned = activeId !== null && anchors.has(activeId) ? activeId : null
    let output = layout({ cards: inputs, activeId: pinned, gap, minTop, collapseDisplacement, cluster })
    // The engine pins the active card level with its anchor and folds the cards above it behind a "+N above" chip when
    // they can't fit between the header and that anchor, which is a crowded line near the top of the document. Hidden
    // comments are the opposite of the rail's job, so then the active card gives up its pin instead: it stays open
    // (pinExpanded) and the whole cluster packs down from the header, every card placed, in document order. The
    // connector and tick show which text each card belongs to, as for any displaced card (QA3 rail-ui 3 / 11).
    if (pinned !== null && output.overflowAbove.length > 0) {
      output = layout({
        cards: inputs.map((c) => (c.id === pinned ? { ...c, pinExpanded: true } : c)),
        activeId: null,
        gap,
        minTop,
        collapseDisplacement,
        cluster,
      })
    }

    // ---- 3. write
    // each card's free space below it, for the hover overlay (a collapsed card opens into that space, never over the next card)
    const placed = output.placements
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!
      const next = placed[i + 1]
      cards.get(p.id)!.el.style.setProperty('--shell-room', next ? `${Math.max(0, next.top - (p.top + p.height) - gap)}px` : '9999px')
    }
    for (const p of output.placements) {
      const c = cards.get(p.id)!
      // a card's first placement (or its return from hidden) jumps into place instead of sliding in from y 0
      if (c.el.dataset.placed !== 'true') {
        c.el.dataset.instant = 'true'
        instant.push(c.el)
      }
      c.el.style.transform = `translateY(${p.top - railTop}px)`
      c.el.dataset.collapsed = String(p.collapsed)
      c.el.dataset.placed = 'true'
    }
    for (const id of output.overflowAbove) {
      const c = cards.get(id)!
      c.el.dataset.placed = 'overflow'
      c.el.style.transform = `translateY(${minTop - railTop}px)`
    }
    for (const id of unplaced) cards.get(id)!.el.dataset.placed = 'false'
    rail.style.minHeight = `${Math.max(0, output.height - railTop + (o.getBottomReserve?.() ?? 0), minTop - railTop)}px`

    let scrollTop = container.scrollTop
    const comp = compensation
    compensation = null
    if (comp) {
      const p = output.placements.find((x) => x.id === comp.id)
      const c = cards.get(comp.id)
      if (p && c) {
        c.el.dataset.instant = 'true'
        instant.push(c.el)
        const next = compensatedScrollTop({ viewportTopBefore: comp.viewportTopBefore, contentTop: p.top, containerTop: cRect.top, clientTop: container.clientTop })
        if (next !== scrollTop) {
          container.scrollTop = next
          scrollTop = container.scrollTop
        }
      }
    }

    frameCount++
    last = { seq: frameCount, reasons: why, railTop, minTop, output, unplaced, anchors, scrollTop }
    o.onFrame?.(last)
  }

  // ---- sources
  offs.push(o.bridge.onLayoutInvalidated(() => invalidate('bridge')))
  if (ro) {
    if (o.content) ro.observe(o.content)
    if (o.header) ro.observe(o.header)
  }
  const onResize = (): void => invalidate('window-resize')
  win?.addEventListener('resize', onResize)
  const onFonts = (): void => invalidate('fonts')
  if (fonts) {
    fonts.addEventListener('loadingdone', onFonts)
    void fonts.ready.then(onFonts, () => undefined)
  }
  invalidate('init')

  return {
    invalidate,
    registerCard(id, el, parts) {
      const prev = cards.get(id)
      if (prev && (!el || prev.el !== el || prev.full !== (parts?.full ?? el) || prev.collapsed !== (parts?.collapsed ?? null))) {
        for (const t of [prev.full, prev.collapsed]) {
          if (!t) continue
          ro?.unobserve(t)
          byTarget.delete(t)
        }
        cards.delete(id)
        heights.delete(id)
      }
      if (!el) {
        invalidate('threads')
        return
      }
      if (cards.get(id)) return
      const entry: CardEntry = { el, full: parts?.full ?? el, collapsed: parts?.collapsed ?? null }
      cards.set(id, entry)
      byTarget.set(entry.full, { id, role: 'full' })
      if (entry.collapsed) byTarget.set(entry.collapsed, { id, role: 'collapsed' })
      ro?.observe(entry.full)
      if (entry.collapsed) ro?.observe(entry.collapsed)
      invalidate('threads')
    },
    get frameCount() {
      return frameCount
    },
    isDirty: () => dirty,
    flush() {
      if (!dirty) return
      if (pending !== null) caf(pending)
      frame()
    },
    lastFrame: () => last,
    destroy() {
      destroyed = true
      if (pending !== null) caf(pending)
      pending = null
      for (const off of offs) off()
      ro?.disconnect()
      win?.removeEventListener('resize', onResize)
      fonts?.removeEventListener('loadingdone', onFonts)
      cards.clear()
      byTarget.clear()
    },
  }
}
