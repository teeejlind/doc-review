// web/src/rail/RailView.tsx (P3; CONTRACTS §6.3, §6.6, §6.8, §7.4, §11.3, §11.4, §11.5, §11.6, §12.9).
//
// The rail inside aside.mdr-rail: the header panel (its bottom is minTop), the positioned cards (threads, conflicts,
// the new-comment draft) placed only by the scheduler through refs, and the viewport extras:
//   - the floating Comment button (gutter; y clamped to the visible part of the selection; rAF on scroll),
//   - the whole-document comment dock (DocDock: fixed to the bottom of the viewport in the rail's column, always visible;
//     the rail keeps room under its last card for it, and the "down" pill sits above it),
//   - the off-screen pill (the active card's placement is outside the visible band: "↑ Comment" / "↓ Comment";
//     a click scrolls its anchor to 30%),
//   - the "+N above" chip (in the header's bottom slot) and the anchor ticks with their connectors.
// Positions are never React state, and nothing invalidates during render: the card set, the active card and
// pinExpanded invalidate from layout effects when they change.
//
// Activation (§11.4): a card-body pointer-down compensates (the card stays under the cursor, the doc scrolls); a
// pointer-down on a composer or control doesn't (the doc never scrolls; the composer gets focus({preventScroll})
// after the layout frame); a highlight click and keyboard focus activate in place; a click in the document's text
// deactivates. next/prev and the pill are the only card actions that scroll, putting the anchor 30% from the top.
//
// Shortcuts (§11.5), registered through bridge.registerShortcut inside the editor and on window outside it
// (events the editor handled arrive defaultPrevented and are ignored): Cmd+Opt+M comment, Cmd+Opt+] / [ next and
// previous, Cmd+Opt+A / R accept or reject the focused suggestion (else the active thread's first pending one).
//
// Narrow mode (§11.4, below NARROW_BREAKPOINT_PX): no scheduler and no layoutRail. The header items and the cards
// render in a bottom sheet (a portal into the shell's sheet host) as in-flow cards; a highlight tap, Comment,
// next/prev and the badge open it on their card. The floating button, pill, chip and ticks don't exist there.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CONSTANTS, TESTID } from '../../../shared/constants'
import { isAltGrChar, shortcut } from '../platform'
import type {
  BlockConflict, DocSession, EditorBridge, Mode, ReviewState, SelectionTarget, SessionEvent, SuggestionId, SuggestionSummary, Thread,
  ThreadId,
} from '../../../shared/types'
import { ConflictCard } from '../threads/ConflictCard'
import { RailContext, type Decision, type FocusReveal, type RailApi } from '../threads/context'
import { DraftCard, DRAFT_ID, type NewDraft } from '../threads/DraftCard'
import { actionFailure, postFailure } from '../threads/errors'
import { buildRailModel, navTarget, orderOf as threadOrder, pendingIdsOf, readingOrder, threadVisible, type RailModel } from '../threads/model'
import { createReadMarkers, type ReadMarkerOptions, type ReadMarkers } from '../threads/read-markers'
import { createSelectionWatch, type SelectionWatch } from '../threads/selection'
import { ThreadCard } from '../threads/ThreadCard'
import type { ToastInput } from '../shell/toast-store'
import { BottomSheet } from '../narrow/BottomSheet'
import type { CommandHub } from './commands'
import { anchorScrollTop, floatingButtonY, offscreenDirection, stripScrollTop, ticksFor } from './overlays'
import { DocDock } from './DocDock'
import { RailHeader, type DocDraft } from './RailHeader'
import { createRailScheduler, DEFAULT_COLLAPSED_HEIGHT, toContentY, type RailCardSpec, type RailFrame, type RailScheduler, type RailSchedulerOptions } from './scheduler'
import '../threads/threads.css'
import './rail.css'

export interface RailViewProps {
  bridge: EditorBridge
  session: DocSession
  /** #mdr-scroll */
  container: HTMLElement
  /** aside.mdr-rail (the element this renders into) */
  rail: HTMLElement
  /** The editor host: observed for content resizes; "editor has focus" and document clicks are read from it. */
  content?: HTMLElement | null
  onFrame?: (f: RailFrame) => void
  /** Test seams (raf, ResizeObserver, fonts, window). */
  schedulerOptions?: Partial<RailSchedulerOptions>
  /** Shared with the top bar's Comment button; created here when absent. */
  selection?: SelectionWatch
  /** The top bar's handle on the rail's verbs. */
  commands?: CommandHub
  /** Test seams for the read-marker controller. */
  readMarkerOptions?: Partial<ReadMarkerOptions>
  /** Below NARROW_BREAKPOINT_PX: no rail layout; the cards live in the bottom sheet (§11.4). */
  narrow?: boolean
  /** Where the bottom sheet renders in narrow mode (outside the hidden rail). */
  sheetHost?: HTMLElement | null
  /** Each frame whose every card is laid out or known unplaced (the mdr:ready mark, §11.7). */
  onLayoutComplete?: (complete: boolean) => void
  /** Where the rail's toasts go (Resolve → "Undo"). */
  onToast?: (t: ToastInput) => void
}

/** Fixed height of the floating Comment button (px; matches threads.css). */
export const FLOAT_BUTTON_HEIGHT = 30
/** Fixed height of the off-screen pill (px; matches threads.css). */
const PILL_HEIGHT = 30
/** How long a "Claude replied" click waits for Claude's message to reach the rail when none is unread yet (ms). */
const UNREAD_RETRY_MS = 3_000
/** Longest wait for the editor to report a click's selection before its active highlight follows anyway (ms). */
const EDITOR_CLICK_SYNC_FALLBACK_MS = 150
const PILL_EDGE = 10
/** The air kept between the dock and the last card (px). */
const DOCK_GAP = 8
/** How long "Posted" stays in the dock after a whole-document comment goes in (ms). */
const POSTED_MS = 2_000
/** Narrow mode: the least document the sheet leaves above it, for panes too short to leave more (px). */
const MIN_SHEET_STRIP = 72
const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_MAP: ReadonlyMap<string, string> = new Map()

const isThreadId = (id: string | null): id is ThreadId => id !== null && id.startsWith('t_') && id !== DRAFT_ID

/** Which composer a focused element is: a thread's reply box (the thread id), the new-comment draft, or the whole-doc dock. */
function composerKey(t: EventTarget | null): string | null {
  if (t instanceof HTMLTextAreaElement && t.dataset.testid === TESTID.docComposerInput) return 'doc'
  if (!(t instanceof HTMLTextAreaElement) || t.dataset.testid !== TESTID.cardReply) return null
  const kind = t.closest<HTMLElement>('.mdr-composer')?.dataset.kind
  if (kind === 'new') return DRAFT_ID
  if (kind === 'doc') return 'doc'
  if (kind !== 'reply') return null
  const id = t.closest<HTMLElement>(`[data-testid="${TESTID.card}"]`)?.dataset.thread
  return id && isThreadId(id) ? id : null
}

/** Threads that get a positioned card (kept for callers of the step-1 API). */
export function railThreads(review: Pick<ReviewState, 'threads' | 'suggestions'>): Thread[] {
  return buildRailModel(review, new Map(), false).positioned
}
export const orderOf = threadOrder

function useSessionValue<T>(session: DocSession, event: SessionEvent, get: () => T): T {
  const [v, setV] = useState(get)
  const getRef = useRef(get)
  getRef.current = get
  useEffect(() => {
    setV(getRef.current())
    return session.subscribe((what) => {
      if (what === event) setV(getRef.current())
    })
  }, [session, event])
  return v
}

const summaryKey = (m: ReadonlyMap<SuggestionId, SuggestionSummary>): string =>
  [...m.values()].map((s) => `${s.id}:${s.placed ? 1 : 0}:${s.unplaced ?? ''}:${s.kind}:${s.hunkCount}`).join('|')

/** The editor's placement report, refreshed when the review or the decorations change (never per keystroke). */
function useSummaries(bridge: EditorBridge, review: ReviewState): ReadonlyMap<SuggestionId, SuggestionSummary> {
  const [m, setM] = useState(() => bridge.getSuggestionSummaries())
  const key = useRef(summaryKey(m))
  const refresh = useCallback(() => {
    const n = bridge.getSuggestionSummaries()
    const k = summaryKey(n)
    if (k === key.current) return
    key.current = k
    setM(n)
  }, [bridge])
  useEffect(refresh, [review, refresh])
  useEffect(() => {
    let pending: number | null = null
    const off = bridge.onLayoutInvalidated((r) => {
      if ((r !== 'reload' && r !== 'decorations') || pending !== null) return
      pending = requestAnimationFrame(() => {
        pending = null
        refresh()
      })
    })
    return () => {
      off()
      if (pending !== null) cancelAnimationFrame(pending)
    }
  }, [bridge, refresh])
  return m
}

function conflictOrder(c: BlockConflict, session: DocSession): number {
  const blocks = session.getSnapshot().blocks
  return blocks[c.currentIndex ?? c.baseIndex]?.pStart ?? 0
}

const DECISION_ERROR: Readonly<Record<string, string>> = {
  SUGGESTION_STALE: 'This change is out of date now.',
  SUGGESTION_CLOSED: 'This change was already decided.',
  SUGGESTION_NOT_FOUND: 'This change no longer exists.',
  READ_ONLY: 'This file is read-only right now.',
}

export function RailView(p: RailViewProps) {
  const { bridge, session, container, rail, content } = p
  const narrow = p.narrow === true
  const narrowRef = useRef(narrow)
  narrowRef.current = narrow
  const sheetHostRef = useRef(p.sheetHost ?? null)
  sheetHostRef.current = p.sheetHost ?? null
  const [sheetOpen, setSheetOpen] = useState(false)
  const sheetOpenRef = useRef(sheetOpen)
  sheetOpenRef.current = sheetOpen
  const sheetBody = useRef<HTMLDivElement>(null)
  const review = useSessionValue(session, 'review', () => session.getReview())
  const conflicts = useSessionValue(session, 'conflicts', () => session.getConflicts())
  const summaries = useSummaries(bridge, review)
  const [showResolved, setShowResolved] = useState(false)
  const showResolvedRef = useRef(showResolved)
  showResolvedRef.current = showResolved
  // Threads with a reply typed but not posted: they stay listed even when Claude resolves them under TJ (QA3 rail-ui 10)
  const [draftIds, setDraftIds] = useState<ReadonlySet<string>>(EMPTY_SET)
  const model = useMemo(
    () => buildRailModel(review, summaries, showResolved, { blockStart: (i) => session.getSnapshot().blocks[i]?.pStart, keepVisible: draftIds }),
    [review, summaries, showResolved, session, draftIds],
  )
  const readOnly = review.readOnly !== false
  // the empty-rail hint is written for the mode TJ is in
  const [mode, setMode] = useState<Mode>(() => bridge.getMode())
  useEffect(() => {
    setMode(bridge.getMode())
    return bridge.onModeChange(setMode)
  }, [bridge])

  const [draft, setDraft] = useState<NewDraft | null>(null)
  const [docDraft, setDocDraft] = useState<DocDraft | null>(null)
  const [posted, setPosted] = useState(false)
  const postedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [pins, setPins] = useState<ReadonlySet<string>>(EMPTY_SET)
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(EMPTY_SET)
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(EMPTY_MAP)
  const [policyBusy, setPolicyBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [scheduler, setScheduler] = useState<RailScheduler | null>(null)
  const [readMarkers, setReadMarkers] = useState<ReadMarkers | null>(null)

  const headerEl = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const floatBtn = useRef<HTMLButtonElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const dockEl = useRef<HTMLDivElement | null>(null)
  /** Room the rail keeps under its last card for the dock: its height (the strip under its box included) and a gap (px). */
  const dockReserve = useRef(0)
  const tickLayer = useRef<HTMLDivElement>(null)
  const draftArea = useRef<HTMLTextAreaElement | null>(null)
  const docArea = useRef<HTMLTextAreaElement | null>(null)
  const replies = useRef(new Map<ThreadId, HTMLTextAreaElement>())
  const pendingFocus = useRef<{ get: () => HTMLElement | null; reveal: FocusReveal; tries: number } | null>(null)
  const hovered = useRef<string | null>(null)
  const activeRef = useRef<string | null>(null)
  const schedulerRef = useRef<RailScheduler | null>(null)
  const readMarkersRef = useRef<ReadMarkers | null>(null)
  const modelRef = useRef<RailModel>(model)
  modelRef.current = model
  const draftRef = useRef<NewDraft | null>(draft)
  draftRef.current = draft
  const docDraftRef = useRef<DocDraft | null>(docDraft)
  docDraftRef.current = docDraft
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const inFlightRef = useRef(inFlight)
  inFlightRef.current = inFlight
  const reviewRef = useRef(review)
  reviewRef.current = review
  const onFrameRef = useRef(p.onFrame)
  onFrameRef.current = p.onFrame
  const onToastRef = useRef(p.onToast)
  onToastRef.current = p.onToast
  const notify = useCallback((t: ToastInput): void => onToastRef.current?.(t), [])
  const optsRef = useRef(p.schedulerOptions)
  const overlayUpdate = useRef<() => void>(() => undefined)

  // ------------------------------------------------------------------ the selection watch (shared or own)

  const ownWatch = useMemo(() => (p.selection ? null : createSelectionWatch({ bridge })), [p.selection, bridge])
  useEffect(() => () => ownWatch?.destroy(), [ownWatch])
  const watch = p.selection ?? ownWatch!

  // ------------------------------------------------------------------ card specs

  // A conflict is positioned only while the page has a block for it. One with none (Claude deleted the block TJ was
  // typing in) has no anchor to sit beside, and a positioned card without one stays hidden: it goes in the header.
  const [placeableKey, setPlaceableKey] = useState('')
  useEffect(() => {
    if (conflicts.length === 0) {
      setPlaceableKey('')
      return undefined
    }
    const ids = conflicts.map((c) => c.id)
    const read = (): void => {
      const rects = bridge.getAnchorRects(ids)
      setPlaceableKey(ids.filter((id) => rects.get(id)).join('|'))
    }
    read()
    return bridge.onLayoutInvalidated(read)
  }, [bridge, conflicts])
  const placeable = useMemo(() => new Set(placeableKey.split('|')), [placeableKey])
  const detachedConflicts = narrow ? [] : conflicts.filter((c) => !placeable.has(c.id))

  const draftKey = draft ? `${draft.anchorY}:${draft.order}` : ''
  const specs = useMemo<RailCardSpec[]>(() => {
    const out: RailCardSpec[] = model.positioned.map((t) => ({ id: t.id, order: threadOrder(t), ...(pins.has(t.id) ? { pinExpanded: true } : {}) }))
    for (const c of conflicts) if (placeable.has(c.id)) out.push({ id: c.id, order: conflictOrder(c, session), pinExpanded: true })
    const d = draftRef.current
    if (d) out.push({ id: DRAFT_ID, order: d.order, anchorY: d.anchorY, pinExpanded: true })
    return out
    // the draft enters through draftKey (its anchor), not its body
  }, [model.positioned, conflicts, placeable, pins, draftKey, session])
  const specsKey = specs.map((s) => `${s.id}:${s.order}:${s.pinExpanded ? 1 : 0}:${s.anchorY ?? ''}`).join('|')
  const specsRef = useRef<RailCardSpec[]>(specs)

  // ------------------------------------------------------------------ activation

  const setActive = useCallback((id: string | null, compensate: boolean) => {
    if (activeRef.current === id) return
    const prev = activeRef.current
    activeRef.current = id
    schedulerRef.current?.invalidate('activate', compensate && id !== null ? { compensate: true, cardId: id } : { compensate: false })
    setActiveId(id)
    if (isThreadId(id)) readMarkersRef.current?.activated(id)
    // an empty new-comment card goes away when TJ moves on (a typed one stays where it is)
    if (prev === DRAFT_ID && id !== DRAFT_ID) setDraft((d) => (d && !d.busy && d.body.trim() === '' ? null : d))
  }, [])
  const activate = useCallback((id: string, compensate: boolean) => setActive(id, compensate), [setActive])

  /** Focus `get()` with preventScroll once the next layout frame has placed it (§11.4). */
  const focusAfterLayout = useCallback((get: () => HTMLElement | null, reveal: FocusReveal = false) => {
    pendingFocus.current = { get, reveal, tries: 0 }
    // any reason but 'activate', which would drop a pending card-body compensation
    if (schedulerRef.current) {
      schedulerRef.current.invalidate('pin')
      return
    }
    // narrow mode: no layout frames; focus once React has rendered the card (a frame or two)
    const tryFocus = (): void => {
      const pf = pendingFocus.current
      if (!pf) return
      const el = pf.get()
      if (el) {
        pendingFocus.current = null
        el.focus({ preventScroll: true })
      } else if (++pf.tries <= 4) requestAnimationFrame(tryFocus)
      else pendingFocus.current = null
    }
    requestAnimationFrame(tryFocus)
  }, [])

  // ------------------------------------------------------------------ scheduler, read markers, frame hook

  /** The composer box last seen with the focus: how far below its card's top it sat, and how tall it was. */
  const composerBox = useRef<{ el: HTMLElement; offset: number; height: number } | null>(null)

  /**
   * The composer TJ is typing in: when its box grows or moves in its card (his typing, a Claude reply landing in the
   * thread), scroll just enough to keep the whole box in view, Reply/Comment and Cancel included (QA4 rail-ui 2). The
   * box is measured from its card's top, so neither a scroll nor the card sliding to its anchor (a click in a reply
   * box activates the card, and the doc never scrolls for that, §11.4; the slide takes several frames, and a frame
   * that lands mid-slide used to read the box as moved and pull it back) counts as the box moving. A box that is
   * wholly above the window never scrolls it.
   */
  const keepFocusedComposerInView = (): void => {
    const focused = container.ownerDocument.activeElement
    const box = focused instanceof HTMLElement ? focused.closest<HTMLElement>('.mdr-composer') : null
    const prev = composerBox.current
    if (!box || !rail.contains(box)) {
      composerBox.current = null
      return
    }
    const r = box.getBoundingClientRect()
    const card = box.closest<HTMLElement>('.mdr-card')
    const offset = card ? r.top - card.getBoundingClientRect().top : toContentY(r.top, container)
    composerBox.current = { el: box, offset, height: r.height }
    // The first frame that sees the box with the focus counts too: a click into a reply box opens it where it is, which can
    // be under the dock, with nothing else to move it until a newline makes it grow. A box that is not on the window at all
    // (a new-comment card at an off-screen selection) stays where it is, with the pill.
    const first = !prev || prev.el !== box
    if (!first && prev.offset === offset && prev.height === r.height) return
    // measured where the card is going, not where its slide has got to
    const ahead = slideLeft(card)
    // a box wholly above the window is one TJ scrolled away from: the pill brings him back, nothing scrolls on its own
    // (§11.4). A box the card's growth pushed down, or one hanging over an edge, is still brought into view.
    const c = container.getBoundingClientRect()
    if (r.bottom + ahead <= c.top || (first && r.top + ahead >= c.bottom)) return
    reveal(box, ahead)
  }

  /** How far a card still has to slide (px): the frame wrote its new transform, and the transition takes CARD_MOVE_MS. */
  function slideLeft(card: HTMLElement | null): number {
    const to = card && /translateY\((-?[\d.e+-]+)px\)/.exec(card.style.transform)
    const from = card && /^matrix\(.*,\s*([^,)\s]+)\)$/.exec(container.ownerDocument.defaultView?.getComputedStyle(card).transform ?? '')
    return to && from ? Number(to[1]) - Number(from[1]) : 0
  }

  /** Runs inside the scheduler's frame, after its writes: chip, ticks, pending focus, then the overlays. */
  const onRailFrame = (f: RailFrame): void => {
    // "+N above" (§11.1 step 6): one chip in the header's bottom slot
    const c = chip.current
    if (c) {
      const n = f.output.overflowAbove.length
      c.hidden = n === 0
      if (n) {
        c.textContent = `+${n} above`
        c.setAttribute('aria-label', n === 1 ? '1 more comment above: show it' : `${n} more comments above: show the nearest`)
      }
    }
    writeTicks(f)
    const pf = pendingFocus.current
    if (pf) {
      const el = pf.get()
      if (el) {
        pendingFocus.current = null
        el.focus({ preventScroll: true })
        // 'unless-above': a box TJ has scrolled past stays where it is (the pill is the way back); one pushed down is shown
        if (pf.reveal && !(pf.reveal === 'unless-above' && el.getBoundingClientRect().bottom <= container.getBoundingClientRect().top)) {
          reveal(pf.reveal === 'card' ? (el.closest<HTMLElement>('.mdr-card') ?? el) : el)
        }
      } else if (++pf.tries > 4) pendingFocus.current = null
    }
    keepFocusedComposerInView()
    overlayUpdate.current()
    const lc = onLayoutCompleteRef.current
    if (lc) lc(specsRef.current.every((s) => f.anchors.has(s.id) || f.unplaced.includes(s.id) || f.output.overflowAbove.includes(s.id)))
  }
  const onLayoutCompleteRef = useRef(p.onLayoutComplete)
  onLayoutCompleteRef.current = p.onLayoutComplete
  const onRailFrameRef = useRef(onRailFrame)
  onRailFrameRef.current = onRailFrame

  useLayoutEffect(() => {
    if (narrow) return undefined
    rail.style.setProperty('--shell-card-move', `${CONSTANTS.CARD_MOVE_MS}ms`)
    rail.style.setProperty('--shell-collapsed-height', `${DEFAULT_COLLAPSED_HEIGHT}px`)
    const s = createRailScheduler({
      bridge,
      container,
      rail,
      content: content ?? null,
      header: headerEl.current,
      getCards: () => specsRef.current,
      getActiveId: () => activeRef.current,
      getBottomReserve: () => dockReserve.current,
      onFrame: (f) => {
        onRailFrameRef.current(f)
        onFrameRef.current?.(f)
      },
      ...(optsRef.current ?? {}),
    })
    schedulerRef.current = s
    setScheduler(s)
    return () => {
      s.destroy()
      schedulerRef.current = null
      setScheduler(null)
    }
  }, [bridge, container, rail, content, narrow])

  const rmOpts = useRef(p.readMarkerOptions)
  useLayoutEffect(() => {
    const r = createReadMarkers({ root: container, markRead: (t, upTo) => session.markRead(t, upTo), ...(rmOpts.current ?? {}) })
    readMarkersRef.current = r
    setReadMarkers(r)
    return () => {
      r.destroy()
      readMarkersRef.current = null
      setReadMarkers(null)
    }
  }, [container, session])

  /**
   * The bottom of what the rail's cards can be seen in: the dock hangs over the foot of the rail's column, so the band
   * ends where its reserve begins (the ref is live: the dock's observer rewrites it as the dock grows while TJ types).
   * The document's own column is not under the dock. Narrow mode has no rail reserve; its scroll box pads instead.
   */
  function visibleBottom(c: DOMRect = container.getBoundingClientRect()): number {
    return c.bottom - dockReserve.current
  }

  /**
   * Scroll the container just enough to show `el`, like Google Docs does: an element hanging off the bottom (of the
   * band above the dock) comes up by its overhang plus a margin (the text TJ was reading stays where it was, give or
   * take the composer's height); one above the top, or taller than the band, has its top put at the margin (the
   * whole-doc composer lives at the top of the rail). It used to put the element's top at the top of the window every
   * time, so a word 90% down the window sent the document 700px up (QA3 rail-ui 7). `ahead` is how far `el` is still to
   * move (its card sliding), so it is measured where it will be.
   */
  function reveal(el: HTMLElement, ahead = 0): void {
    const r = el.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    const top = r.top + ahead
    const bottom = r.bottom + ahead
    const edge = visibleBottom(c)
    if (top >= c.top && bottom <= edge) return
    const margin = 16
    if (top < c.top || r.height + 2 * margin > edge - c.top) container.scrollTop = Math.max(0, toContentY(top, container, c.top) - margin)
    else container.scrollTop += bottom - edge + margin
  }

  function writeTicks(f: RailFrame): void {
    const layer = tickLayer.current
    if (!layer) return
    const want = new Map(ticksFor(f.output.placements, activeRef.current).map((t) => [t.id, t] as const))
    const have = new Map<string, HTMLElement>()
    for (const el of Array.from(layer.children) as HTMLElement[]) {
      const id = el.dataset.card ?? ''
      if (want.has(id)) have.set(id, el)
      else el.remove()
    }
    for (const t of want.values()) {
      let el = have.get(t.id)
      if (!el) {
        el = layer.ownerDocument.createElement('span')
        el.className = 'mdr-tick'
        el.dataset.card = t.id
        const line = layer.ownerDocument.createElement('span')
        line.className = 'mdr-tick-line'
        el.appendChild(line)
        layer.appendChild(el)
      }
      el.style.transform = `translateY(${t.anchorY - f.railTop}px)`
      // the connector runs from the tick to the card's first line
      const to = t.cardTop + 14 - t.anchorY
      const line = el.firstElementChild as HTMLElement
      line.style.top = `${Math.min(0, to)}px`
      line.style.height = `${Math.abs(to)}px`
      el.dataset.active = String(t.id === activeRef.current)
      el.dataset.hover = String(t.id === hovered.current)
    }
  }

  const hover = useCallback((id: string, on: boolean) => {
    hovered.current = on ? id : hovered.current === id ? null : hovered.current
    for (const el of Array.from(tickLayer.current?.children ?? []) as HTMLElement[]) if (el.dataset.card === id) el.dataset.hover = String(on)
  }, [])

  // ------------------------------------------------------------------ overlays: floating button, off-screen pill

  useLayoutEffect(() => {
    if (!scheduler) return undefined
    let pending: number | null = null
    const update = (): void => {
      const f = scheduler.lastFrame()
      if (!f) return
      const view = { top: container.scrollTop, bottom: container.scrollTop + container.clientHeight }
      // a card under the dock is as good as off screen: the pill's band ends at the dock's top
      const railView = { top: view.top, bottom: toContentY(visibleBottom(), container) }
      const btn = floatBtn.current
      if (btn) {
        const doc = container.ownerDocument
        const focused = !!content && content.contains(doc.activeElement)
        // an open YAML panel is node-selected, and its block target would float a Comment bubble over the panel (T2 polish #39)
        const onOpenPanel = !!content?.querySelector('.mdr-frontmatter.is-selected[data-expanded="true"]')
        const t = focused && !readOnlyRef.current && !onOpenPanel ? watch.get() : null
        const y = t ? floatingButtonY(t, view, FLOAT_BUTTON_HEIGHT) : null
        if (y === null || !t) btn.hidden = true
        else {
          btn.hidden = false
          btn.style.transform = `translateY(${y - f.railTop}px)`
          btn.dataset.kind = t.kind
          // visible text is the icon; the name says what a click does (§11.4: "Reply" inside a suggestion)
          btn.title = t.kind === 'inside-suggestion' ? 'Reply' : t.kind === 'block' ? 'Comment on block' : `Comment (${shortcut('Mod', 'Alt', 'M')})`
          btn.setAttribute('aria-label', t.kind === 'inside-suggestion' ? 'Reply to this suggestion' : t.kind === 'block' ? 'Comment on this block' : 'Comment on the selection')
        }
      }
      const pl = pill.current
      if (pl) {
        const a = activeRef.current
        const place = a ? f.output.placements.find((x) => x.id === a) : undefined
        const dir = place ? offscreenDirection(place, railView) : null
        if (!dir) pl.hidden = true
        else {
          pl.hidden = false
          pl.dataset.direction = dir
          const label = dir === 'up' ? '↑ Comment' : '↓ Comment'
          if (pl.textContent !== label) pl.textContent = label
          pl.setAttribute('aria-label', dir === 'up' ? 'The active comment is above: scroll to it' : 'The active comment is below: scroll to it')
          const c = container.getBoundingClientRect()
          const r = rail.getBoundingClientRect()
          pl.style.left = `${r.left + r.width / 2}px`
          // the "down" pill rides above the dock that hangs over the bottom of the rail's column
          const floor = Math.min(c.bottom, dockEl.current?.getBoundingClientRect().top ?? c.bottom)
          pl.style.top = `${dir === 'up' ? c.top + PILL_EDGE : floor - PILL_EDGE - PILL_HEIGHT}px`
        }
      }
    }
    const schedule = (): void => {
      if (pending !== null) return
      pending = requestAnimationFrame(() => {
        pending = null
        update()
      })
    }
    overlayUpdate.current = update
    container.addEventListener('scroll', schedule, { passive: true })
    const doc = container.ownerDocument
    doc.addEventListener('focusin', schedule)
    doc.addEventListener('focusout', schedule)
    const offSel = watch.subscribe(update)
    update()
    return () => {
      overlayUpdate.current = () => undefined
      if (pending !== null) cancelAnimationFrame(pending)
      container.removeEventListener('scroll', schedule)
      doc.removeEventListener('focusin', schedule)
      doc.removeEventListener('focusout', schedule)
      offSel()
    }
  }, [scheduler, container, rail, content, watch])

  // ------------------------------------------------------------------ the whole-document dock: position and room kept for it

  // The dock is fixed to the viewport. In the rail it takes the rail column's left edge and width (a resize moves both);
  // below the breakpoint it spans the window above the sheet's bar. Either way the document keeps room clear of it: the
  // rail grows under its last card (the scheduler's bottom reserve), the narrow scroll box pads and scroll-pads.
  const showDock = !readOnly
  useLayoutEffect(() => {
    const dock = dockEl.current
    const app = container.closest<HTMLElement>('.mdr-app') ?? container
    if (!dock) {
      if (dockReserve.current !== 0) {
        dockReserve.current = 0
        schedulerRef.current?.invalidate('dock')
      }
      return undefined
    }
    const win = container.ownerDocument.defaultView
    const place = (): void => {
      if (narrow) {
        const bar = sheetHostRef.current?.querySelector<HTMLElement>('.mdr-sheet-bar')
        dock.style.left = ''
        dock.style.width = ''
        dock.style.bottom = bar ? `${bar.offsetHeight + 1}px` : ''
      } else {
        const r = rail.getBoundingClientRect()
        dock.style.left = `${r.left}px`
        dock.style.width = `${r.width}px`
        dock.style.bottom = ''
      }
      const h = dock.offsetHeight
      const reserve = !narrow && h > 0 ? h + DOCK_GAP : 0
      if (reserve !== dockReserve.current) {
        dockReserve.current = reserve
        schedulerRef.current?.invalidate('dock')
      }
      if (narrow) app.style.setProperty('--shell-dock-h', `${h}px`)
      // the browser's own caret scroll while typing in a card keeps clear of the dock too (the narrow box has its own)
      else app.style.setProperty('--shell-dock-reserve', `${reserve}px`)
      overlayUpdate.current()
    }
    place()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    ro?.observe(dock)
    if (!narrow) ro?.observe(rail)
    win?.addEventListener('resize', place)
    return () => {
      ro?.disconnect()
      win?.removeEventListener('resize', place)
      app.style.removeProperty('--shell-dock-h')
      app.style.removeProperty('--shell-dock-reserve')
      dockReserve.current = 0
    }
  }, [container, rail, narrow, showDock, scheduler])

  // ------------------------------------------------------------------ typing in an off-screen composer never scrolls

  // §11.4: "Typing in the active card's composer while it is off-screen is still allowed; nothing scrolls on its own."
  // Chromium reveals the caret of an edited textarea by scrolling every scrollable ancestor. A key press or edit in
  // a rail composer that is entirely outside the visible band pins scrollTop for that edit. The reveal runs after the
  // input event inside the key's task, so it is undone on that keystroke's keyup, by a timeout after a key's default
  // action (a caret move fires no input), and by the scroll event before the next paint, whichever comes first.
  useEffect(() => {
    let guard: { top: number } | null = null
    let clear: number | null = null
    const arm = (e: Event): void => {
      const t = e.target
      if (!(t instanceof HTMLElement) || !t.matches('textarea, input')) return
      // while a guard holds, keep its scrollTop: a reveal that slipped in between two keys must not become the baseline
      if (!guard) {
        const r = t.getBoundingClientRect()
        const c = container.getBoundingClientRect()
        if (r.bottom > c.top && r.top < c.bottom) return
        guard = { top: container.scrollTop }
      }
      // a caret move reveals in the key's default action, after this listener and with no input event
      if (e.type === 'keydown') setTimeout(hold, 0)
      if (clear !== null) cancelAnimationFrame(clear)
      clear = requestAnimationFrame(() => {
        clear = requestAnimationFrame(() => {
          clear = null
          guard = null
        })
      })
    }
    const hold = (): void => {
      if (guard && container.scrollTop !== guard.top) container.scrollTop = guard.top
    }
    rail.addEventListener('keydown', arm, true)
    rail.addEventListener('beforeinput', arm, true)
    rail.addEventListener('input', hold, true)
    // Chromium reveals after dispatching input, still inside the key's task; keyup is the next task of that keystroke
    rail.addEventListener('keyup', hold, true)
    container.addEventListener('scroll', hold)
    return () => {
      rail.removeEventListener('keydown', arm, true)
      rail.removeEventListener('beforeinput', arm, true)
      rail.removeEventListener('input', hold, true)
      rail.removeEventListener('keyup', hold, true)
      container.removeEventListener('scroll', hold)
      if (clear !== null) cancelAnimationFrame(clear)
    }
  }, [container, rail])

  // ------------------------------------------------------------------ card set, active, pins → layout

  useLayoutEffect(() => {
    specsRef.current = specs
    scheduler?.invalidate('threads')
    // keyed on ids, orders, pins and draft anchor (specsKey), not on the array's identity
  }, [specsKey, scheduler])

  // Previous / Next in the top bar are live only while a comment is reachable (the positioned ones that are showing)
  const navReach = model.positioned.length
  useEffect(() => {
    p.commands?.setNavCount(navReach)
    return () => p.commands?.setNavCount(null)
  }, [p.commands, navReach])

  const positionedKey = model.positioned.map((t) => t.id).join('|')
  useEffect(() => {
    bridge.setVisibleThreads(modelRef.current.positioned.map((t) => t.id))
  }, [bridge, positionedKey])

  /**
   * Set by a click in the editor (a highlight click, or a click in the text that deactivates). The browser puts the
   * caret in the DOM on mousedown, but ProseMirror reads it only on a later selectionchange; a transaction
   * dispatched before that (setActiveThread's decoration update) writes ProseMirror's previous selection back over
   * the click, and the next keystroke lands there (on a fresh page, the doc start: typing replaces a frontmatter
   * block). So after an editor click the active highlight follows only once the bridge reports the editor's selection
   * changed (ProseMirror has the click), on the next task; a click that leaves the selection where it was reports
   * nothing, and then EDITOR_CLICK_SYNC_FALLBACK_MS ends the wait.
   */
  const editorClick = useRef(false)
  useLayoutEffect(() => {
    scheduler?.invalidate('active')
    const id = isThreadId(activeId) ? activeId : null
    if (!editorClick.current) {
      bridge.setActiveThread(id)
      return undefined
    }
    editorClick.current = false
    let done = false
    let next: ReturnType<typeof setTimeout> | null = null
    const run = (): void => {
      if (done) return
      done = true
      off()
      clearTimeout(fallback)
      bridge.setActiveThread(id)
    }
    // never dispatch from inside the editor's own transaction: the selection event fires during its apply
    const off = bridge.onSelectionChange(() => {
      next ??= setTimeout(run, 0)
    })
    const fallback = setTimeout(run, EDITOR_CLICK_SYNC_FALLBACK_MS)
    return () => {
      done = true
      off()
      clearTimeout(fallback)
      if (next !== null) clearTimeout(next)
    }
  }, [activeId, bridge, scheduler])

  // A card that left the rail (resolved and hidden, deleted, the draft posted) can't stay active.
  const hasDraft = draft !== null
  // the selected text stays highlighted while the new-comment box is open
  useEffect(() => {
    bridge.setDraftHighlight(hasDraft)
  }, [bridge, hasDraft])
  const present = useMemo(() => {
    const s = new Set<string>()
    for (const list of [model.positioned, model.docThreads, model.detached, model.unplaced]) for (const t of list) s.add(t.id)
    for (const c of conflicts) s.add(c.id)
    if (hasDraft) s.add(DRAFT_ID)
    return s
  }, [model, conflicts, hasDraft])
  const presentKey = [...present].join('|')
  const prevPresent = useRef<ReadonlySet<string>>(present)
  useEffect(() => {
    const a = activeRef.current
    if (a !== null && prevPresent.current.has(a) && !present.has(a)) setActive(null, false)
    prevPresent.current = present
  }, [presentKey])

  const setPin = useCallback((id: string, on: boolean) => {
    setPins((cur) => {
      if (cur.has(id) === on) return cur
      const n = new Set(cur)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  }, [])

  const registerReply = useCallback((id: ThreadId, el: HTMLTextAreaElement | null) => {
    if (el) replies.current.set(id, el)
    else replies.current.delete(id)
  }, [])

  /** Each mounted thread card's own "post my reply box" (Send to Claude posts what is typed first). */
  const posters = useRef(new Map<ThreadId, () => Promise<boolean>>())
  const registerPoster = useCallback((id: ThreadId, post: (() => Promise<boolean>) | null) => {
    if (post) posters.current.set(id, post)
    else posters.current.delete(id)
  }, [])

  /**
   * Hand the focus back to the document after a composer is posted or cancelled, so the next keystrokes land in the
   * text and not on <body>. After a post the selection collapses to its end: the text just commented on must not be
   * the thing the next keystroke replaces (QA3 rail-ui 9).
   */
  const returnToDoc = useCallback((o?: { collapse?: boolean }) => {
    if (o?.collapse) bridge.focusEditor({ collapse: 'end' })
    else bridge.focusEditor()
  }, [bridge])

  // Unsent replies live here, not in the card: crossing the breakpoint swaps the rail's cards for the sheet's, and a
  // remounted card starts from what was typed. (The new-comment and whole-doc drafts are state above already.)
  const replyDrafts = useRef(new Map<ThreadId, string>())
  const getReply = useCallback((id: ThreadId): string => replyDrafts.current.get(id) ?? '', [])
  const putReply = useCallback((id: ThreadId, body: string): void => {
    if (body === '') replyDrafts.current.delete(id)
    else replyDrafts.current.set(id, body)
    const has = body.trim() !== ''
    // only a box going empty ↔ non-empty changes the set (not every keystroke); an unchanged set bails out of the render
    setDraftIds((cur) => {
      if (cur.has(id) === has) return cur
      const n = new Set(cur)
      if (has) n.add(id)
      else n.delete(id)
      return n
    })
  }, [])

  // Which composer has the focus (a thread's id, DRAFT_ID or 'doc'), kept across the card remounting at the
  // breakpoint. Crossing it blurs the box twice over: the media query hides the rail before React swaps the cards,
  // and swapping removes the box. Neither is TJ moving on, so a box that is gone or no longer rendered keeps the
  // claim; one that is still on screen and lost the focus gives it up.
  const composerFocus = useRef<string | null>(null)
  useEffect(() => {
    const doc = container.ownerDocument
    const onIn = (e: FocusEvent): void => {
      composerFocus.current = composerKey(e.target)
    }
    const onOut = (e: FocusEvent): void => {
      const t = e.target
      const key = composerKey(t)
      if (key === null || !(t instanceof Element) || key !== composerFocus.current) return
      setTimeout(() => {
        if (t.isConnected && t.getClientRects().length > 0 && doc.activeElement !== t && composerFocus.current === key) composerFocus.current = null
      }, 0)
    }
    doc.addEventListener('focusin', onIn)
    doc.addEventListener('focusout', onOut)
    return () => {
      doc.removeEventListener('focusin', onIn)
      doc.removeEventListener('focusout', onOut)
    }
  }, [container])
  const lastNarrow = useRef(narrow)
  useLayoutEffect(() => {
    if (lastNarrow.current === narrow) return
    lastNarrow.current = narrow
    const key = composerFocus.current
    if (key === null) return
    // the composer TJ was typing in comes back under the caret, in the sheet (opened for it) or the rail; the whole-doc
    // dock is outside the sheet in both
    if (narrow && key !== 'doc') setSheetOpen(true)
    focusAfterLayout(() => {
      const el = key === 'doc' ? docArea.current : key === DRAFT_ID ? draftArea.current : (replies.current.get(key as ThreadId) ?? null)
      el?.setSelectionRange(el.value.length, el.value.length)
      return el
    })
  }, [narrow, focusAfterLayout])

  // ------------------------------------------------------------------ decisions

  const mark = useCallback((key: string, on: boolean): void => {
    const n = new Set(inFlightRef.current)
    if (on) n.add(key)
    else n.delete(key)
    inFlightRef.current = n
    setInFlight(n)
  }, [])
  const setError = useCallback((key: string, msg: string | null): void => {
    setErrors((cur) => {
      if (msg === null && !cur.has(key)) return cur
      const n = new Map(cur)
      if (msg === null) n.delete(key)
      else n.set(key, msg)
      return n
    })
  }, [])

  /**
   * A decision made on a card or from the header: the button that had the focus is about to go (or stays, a button),
   * and Cmd+Z / Cmd+Shift+Z and the mode keys need the document. Hand the focus back, without scrolling. A reply box
   * that has the focus keeps it.
   */
  const focusDocAfterDecision = useCallback((): void => {
    const doc = container.ownerDocument
    const a = doc.activeElement
    const inRail = !!a && (rail.contains(a) || !!sheetHostRef.current?.contains(a))
    if (a === null || a === doc.body || (inRail && !(a instanceof HTMLTextAreaElement))) bridge.focusEditor()
  }, [bridge, container, rail])

  const decide = useCallback(async (id: SuggestionId, d: Decision) => {
    if (inFlightRef.current.has(id)) return
    mark(id, true)
    setError(id, null)
    try {
      const r = d === 'accept' ? await bridge.accept(id) : await bridge.reject(id)
      if (!r.ok && !r.noop) setError(id, (r.code && DECISION_ERROR[r.code]) ?? `Couldn’t ${d}${r.code ? ` (${r.code})` : ''}.`)
      else focusDocAfterDecision()
    } catch (e) {
      setError(id, actionFailure(e, d))
    } finally {
      mark(id, false)
    }
  }, [bridge, mark, setError, focusDocAfterDecision])

  const acceptAllInThread = useCallback(async (t: Thread) => {
    const key = `thread:${t.id}`
    if (inFlightRef.current.has(key)) return
    const ids = pendingIdsOf(t, modelRef.current.suggestionsById)
    if (!ids.length) return
    mark(key, true)
    try {
      const r = await bridge.acceptAll({ ids })
      for (const x of r?.results ?? []) if (!x.ok) setError(x.id, (x.code && DECISION_ERROR[x.code]) ?? `Couldn’t accept${x.code ? ` (${x.code})` : ''}.`)
      focusDocAfterDecision()
    } catch (e) {
      setError(ids[0]!, actionFailure(e, 'accept'))
    } finally {
      mark(key, false)
    }
  }, [bridge, mark, setError, focusDocAfterDecision])

  const bulk = useCallback(async (d: Decision) => {
    setBulkBusy(true)
    try {
      await (d === 'accept' ? bridge.acceptAll({ by: 'Claude' }) : bridge.rejectAll({ by: 'Claude' }))
      focusDocAfterDecision()
    } catch {
      // per-id failures come back in the result; a transport failure leaves the cards as they were
    } finally {
      setBulkBusy(false)
    }
  }, [bridge, focusDocAfterDecision])

  const setPolicy = useCallback(async (claudeMayEdit: boolean) => {
    setPolicyBusy(true)
    try {
      await session.setPolicy({ suggestOnly: !claudeMayEdit })
    } catch {
      // the switch keeps showing the server's state (review.policy), which didn't change
    } finally {
      setPolicyBusy(false)
    }
  }, [session])

  /** Narrow mode: put the sheet away; focus goes back to the document when it was inside the sheet. */
  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    // closing hands focus back to the document when it was inside the sheet
    const host = sheetHostRef.current
    const inSheet = !!host?.contains(host.ownerDocument.activeElement)
    setActive(null, false)
    if (inSheet) bridge.focusEditor()
  }, [bridge, setActive])

  // ------------------------------------------------------------------ composers

  const openComposer = useCallback((t: Exclude<SelectionTarget, null> | 'doc') => {
    if (readOnlyRef.current) return
    if (t === 'doc') {
      // the dock is always on screen: open it where it is. Neither the document nor the rail scrolls. (Narrow: the open
      // sheet would cover it, so it goes away first.)
      if (narrowRef.current && sheetOpenRef.current) closeSheet()
      docArea.current?.focus({ preventScroll: true })
      return
    }
    if (narrowRef.current) setSheetOpen(true)
    if (t.kind === 'inside-suggestion') {
      setActive(t.thread, false)
      focusAfterLayout(() => replies.current.get(t.thread) ?? null)
      return
    }
    const order = t.kind === 'anchor' ? t.anchor.hint.pos : (session.getSnapshot().blocks[t.anchor.hint.block]?.pStart ?? 0)
    setDraft((d) => ({ anchor: t.anchor, anchorY: t.rect.top, order, body: d?.body ?? '', busy: false, error: null }))
    setActive(DRAFT_ID, false)
    // Comment is an explicit request for a composer: when any of the selection is on screen, the whole new-comment card
    // ends up in view too (rail mode; the sheet scrolls itself). A selection fully off screen keeps the pill instead.
    const onScreen = t.extent.bottom > container.scrollTop && t.extent.top < container.scrollTop + container.clientHeight
    focusAfterLayout(() => draftArea.current, onScreen ? 'card' : false)
  }, [focusAfterLayout, session, setActive, closeSheet])

  /** true = posted (or nothing to post). */
  const submitDraft = useCallback(async (): Promise<boolean> => {
    const d = draftRef.current
    if (!d || d.busy || !d.body.trim()) return true
    setDraft({ ...d, busy: true, error: null })
    try {
      const r = await session.createThread(d.anchor, d.body.trim())
      setDraft(null)
      setActive(r.thread.id, false)
      returnToDoc({ collapse: true })
      return true
    } catch (e) {
      setDraft((cur) => (cur ? { ...cur, busy: false, error: postFailure(e, 'comment') } : cur))
      return false
    }
  }, [session, setActive, returnToDoc])

  const cancelDraft = useCallback(() => {
    setDraft(null)
    if (activeRef.current === DRAFT_ID) setActive(null, false)
    returnToDoc()
  }, [setActive, returnToDoc])

  const submitDoc = useCallback(async (): Promise<boolean> => {
    const d = docDraftRef.current
    if (!d || d.busy || !d.body.trim()) return true
    setDocDraft({ ...d, busy: true, error: null })
    try {
      await session.createThread({ kind: 'doc' }, d.body.trim())
      // the box stays editable while the post is in flight: text typed since is the next comment, not the one that went in
      // The box still opens with the text that went in, so only what was added after it is kept.
      const cur = docDraftRef.current
      const typed = cur?.body.trimStart() ?? ''
      const rest = typed.startsWith(d.body.trim()) ? typed.slice(d.body.trim().length).trimStart() : typed
      if (cur && rest.trim() !== '') {
        setDocDraft({ ...cur, body: rest, busy: false, error: null })
        return true
      }
      setDocDraft(null)
      // the dock collapses and says so for a moment; the document stays where it is. The focus goes back to the text
      // only when the dock had it (a post from Send to Claude must not pull it off the Send button).
      const a = docArea.current
      if (a && a.ownerDocument.activeElement === a) {
        a.blur()
        returnToDoc()
      }
      setPosted(true)
      if (postedTimer.current !== null) clearTimeout(postedTimer.current)
      postedTimer.current = setTimeout(() => {
        postedTimer.current = null
        setPosted(false)
      }, POSTED_MS)
      return true
    } catch (e) {
      setDocDraft((cur) => (cur ? { ...cur, busy: false, error: postFailure(e, 'comment') } : cur))
      return false
    }
  }, [session, returnToDoc])
  useEffect(
    () => () => {
      if (postedTimer.current !== null) clearTimeout(postedTimer.current)
    },
    [],
  )

  // ------------------------------------------------------------------ Send to Claude: post what is typed first

  const hasUnsent = useCallback((): boolean => {
    if (draftRef.current?.body.trim() || docDraftRef.current?.body.trim()) return true
    for (const body of replyDrafts.current.values()) if (body.trim()) return true
    return false
  }, [])

  /** Every box with text, one after another (replies keep their order). false = at least one failed and keeps its text. */
  const postUnsent = useCallback(async (): Promise<boolean> => {
    let ok = true
    for (const [id, body] of [...replyDrafts.current]) {
      if (!body.trim()) continue
      const post = posters.current.get(id)
      if (post) ok = (await post()) && ok
      else {
        // a reply box whose card isn't on screen (its thread is resolved and hidden): post it straight to the session
        try {
          await session.reply(id, body.trim())
          putReply(id, '')
        } catch {
          ok = false
        }
      }
    }
    if (draftRef.current?.body.trim()) ok = (await submitDraft()) && ok
    if (docDraftRef.current?.body.trim()) ok = (await submitDoc()) && ok
    return ok
  }, [session, putReply, submitDraft, submitDoc])

  // ------------------------------------------------------------------ next / previous

  /** The card element for `id`: in the rail, or in the sheet in narrow mode. */
  const cardEl = useCallback((id: string): HTMLElement | null => {
    const root: ParentNode = (narrowRef.current ? sheetHostRef.current : null) ?? rail
    const sel = id.startsWith('t_') ? `[data-testid="${TESTID.card}"][data-thread="${id}"]` : `[data-testid="${TESTID.conflictCard}"][data-conflict="${id}"]`
    return root.querySelector<HTMLElement>(sel) ?? rail.querySelector<HTMLElement>(sel)
  }, [rail])

  /**
   * Narrow mode (§11.4): the sheet covers the lower part of the window, so the doc scrolls (only when it has to) to
   * keep content y `anchorY` in the strip above it. The strip is measured with the sheet at its max-height, so the
   * text stays in view however far the sheet grows while TJ reads or replies.
   */
  function liftAboveSheet(anchorY: number): void {
    const sheet = sheetHostRef.current?.querySelector<HTMLElement>(`[data-testid="${TESTID.sheet}"]`)
    const win = container.ownerDocument.defaultView
    if (!sheet || !win) return
    const maxH = parseFloat(win.getComputedStyle(sheet).maxHeight)
    const bottom = Number.isFinite(maxH) ? win.innerHeight - maxH : win.innerHeight * 0.28
    const strip = Math.max(MIN_SHEET_STRIP, bottom - container.getBoundingClientRect().top)
    const to = stripScrollTop(anchorY, container.scrollTop, strip)
    if (to !== container.scrollTop) container.scrollTop = to
  }

  /**
   * Take TJ to a card: scroll its anchor 30% from the top when it has one (§11.4's next/prev rule), activate it,
   * open the sheet in narrow mode, and focus the card once it is placed (a header card is revealed).
   */
  const goTo = useCallback((id: string, anchorY: number | null) => {
    if (anchorY !== null) {
      if (narrowRef.current) liftAboveSheet(anchorY)
      else container.scrollTop = anchorScrollTop(anchorY, container.clientHeight)
    }
    setActive(id, false)
    if (narrowRef.current) setSheetOpen(true)
    focusAfterLayout(() => cardEl(id), anchorY === null && !narrowRef.current)
  }, [container, cardEl, focusAfterLayout, setActive])

  const nav = useCallback((dir: 1 | -1) => {
    const m = modelRef.current
    const ids = m.positioned.map((t) => t.id)
    if (!ids.length) return
    const anchors = new Map<string, number>()
    for (const [id, r] of bridge.getAnchorRects(ids)) if (r) anchors.set(id, r.top)
    const orders = new Map<string, number>(m.positioned.map((t) => [t.id, threadOrder(t)]))
    const order = readingOrder(ids, anchors, orders)
    const view = { top: container.scrollTop, bottom: container.scrollTop + container.clientHeight }
    const a = activeRef.current
    const target = navTarget(order, a !== null && anchors.has(a) ? a : null, dir, anchors, view)
    if (!target) return
    goTo(target, anchors.get(target)!)
  }, [bridge, container, goTo])

  /**
   * A "Claude replied" click that found no unread card yet: the activity event can reach the page before the review
   * refresh carrying Claude's message, so the click is retried once on the next rail model, until this deadline.
   */
  const unreadRetryUntil = useRef(0)

  /** §8.5 "Claude replied": the first card with unread messages, in reading order (header lists first). */
  const firstUnread = useCallback((): boolean => {
    const m = modelRef.current
    const ids = m.positioned.map((t) => t.id)
    const anchors = new Map<string, number>()
    if (ids.length) for (const [id, r] of bridge.getAnchorRects(ids)) if (r) anchors.set(id, r.top)
    const orders = new Map<string, number>(m.positioned.map((t) => [t.id, threadOrder(t)]))
    const positioned = readingOrder(ids, anchors, orders)
    const byId = new Map(m.positioned.map((t) => [t.id as string, t]))
    const header = [...m.docThreads, ...m.unplaced, ...m.detached].find((t) => t.unread > 0)
    if (header) {
      goTo(header.id, null)
      return true
    }
    const first = positioned.find((id) => (byId.get(id)?.unread ?? 0) > 0)
    if (!first) {
      // Claude replied and then resolved its own thread: the unread sits in a card "Show resolved" is hiding, which
      // the badge counts but TJ can't see. Show them; the model change runs this again and opens the card (QA3 rail-ui 12).
      const hiddenUnread = reviewRef.current.threads.some((t) => t.unread > 0 && !threadVisible(t, m.suggestionsById, showResolvedRef.current))
      if (hiddenUnread) setShowResolved(true)
      return false
    }
    goTo(first, anchors.get(first) ?? null)
    return true
  }, [bridge, goTo])

  const showFirstUnread = useCallback(() => {
    unreadRetryUntil.current = firstUnread() ? 0 : Date.now() + UNREAD_RETRY_MS
  }, [firstUnread])

  useEffect(() => {
    if (unreadRetryUntil.current === 0) return
    if (Date.now() > unreadRetryUntil.current) {
      unreadRetryUntil.current = 0
      return
    }
    // wait for the layout frame that places the new card, then try once more
    const raf = optsRef.current?.raf ?? ((cb: () => void) => requestAnimationFrame(cb))
    const caf = optsRef.current?.caf ?? ((h: number) => cancelAnimationFrame(h))
    const h = raf(() => {
      if (unreadRetryUntil.current !== 0 && firstUnread()) unreadRetryUntil.current = 0
    })
    return () => caf(h)
  }, [model, firstUnread])

  /** §12.4 "Conflict (n)": the first conflict or unsaveable card, in document order. */
  const firstConflict = useCallback(() => {
    const list = [...session.getConflicts()].sort((a, b) => conflictOrder(a, session) - conflictOrder(b, session))
    const c = list[0]
    if (!c) return
    const r = bridge.getAnchorRects([c.id]).get(c.id)
    goTo(c.id, r ? r.top : null)
  }, [bridge, session, goTo])

  const decideFocused = useCallback((d: Decision): boolean => {
    const focusedItem = (container.ownerDocument.activeElement as Element | null)?.closest?.(`[data-testid="${TESTID.suggestionItem}"]`)
    let id = (focusedItem?.getAttribute('data-suggestion') ?? undefined) as SuggestionId | undefined
    if (!id) {
      const a = activeRef.current
      const t = a ? reviewRef.current.threads.find((x) => x.id === a) : undefined
      id = t ? pendingIdsOf(t, modelRef.current.suggestionsById)[0] : undefined
    }
    if (!id) return false
    void decide(id, d)
    return true
  }, [container, decide])

  // narrow mode: the active card scrolls into view inside the sheet (the sheet has its own scroll box), and the doc
  // scrolls only as far as it takes to keep the card's anchor in the strip above the sheet
  useLayoutEffect(() => {
    if (!narrow || !sheetOpen || !activeId) return
    const anchorY = activeId === DRAFT_ID ? draftRef.current?.anchorY : bridge.getAnchorRects([activeId]).get(activeId)?.top
    if (anchorY !== undefined) liftAboveSheet(anchorY)
    const body = sheetBody.current
    const el = body ? cardEl(activeId) : null
    if (!body || !el || !body.contains(el)) return
    const r = el.getBoundingClientRect()
    const b = body.getBoundingClientRect()
    if (r.top < b.top || r.bottom > b.bottom) body.scrollTop += r.top - b.top - 12
  }, [narrow, sheetOpen, activeId, cardEl, bridge])

  // ------------------------------------------------------------------ shortcuts and the top bar's commands

  const focusCard = useCallback((id: string) => focusAfterLayout(() => cardEl(id)), [focusAfterLayout, cardEl])
  const fns = useRef({ openComposer, nav, decideFocused, showFirstUnread, firstConflict, focusCard, hasUnsent, postUnsent })
  fns.current = { openComposer, nav, decideFocused, showFirstUnread, firstConflict, focusCard, hasUnsent, postUnsent }
  useEffect(() => {
    const commentFromEditor = (): boolean => {
      const t = bridge.getSelectionTarget() ?? bridge.getSelectionTarget({ collapsed: 'word' })
      fns.current.openComposer(t ?? 'doc')
      return true
    }
    const offs = [
      bridge.registerShortcut({ key: 'Mod-Alt-m', run: commentFromEditor }),
      bridge.registerShortcut({ key: 'Mod-Alt-]', run: () => (fns.current.nav(1), true) }),
      bridge.registerShortcut({ key: 'Mod-Alt-[', run: () => (fns.current.nav(-1), true) }),
      bridge.registerShortcut({ key: 'Mod-Alt-a', run: () => fns.current.decideFocused('accept') }),
      bridge.registerShortcut({ key: 'Mod-Alt-r', run: () => fns.current.decideFocused('reject') }),
    ]
    const win = container.ownerDocument.defaultView
    const onKey = (e: KeyboardEvent): void => {
      // the editor's keymap already ran (and handled) it
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey || isAltGrChar(e)) return
      let handled = false
      if (e.code === 'KeyM') {
        // outside the editor there is no selection to comment on: the whole-doc composer (§11.4)
        fns.current.openComposer('doc')
        handled = true
      } else if (e.code === 'BracketRight') {
        fns.current.nav(1)
        handled = true
      } else if (e.code === 'BracketLeft') {
        fns.current.nav(-1)
        handled = true
      } else if (e.code === 'KeyA') handled = fns.current.decideFocused('accept')
      else if (e.code === 'KeyR') handled = fns.current.decideFocused('reject')
      if (handled) e.preventDefault()
    }
    // narrow mode: Esc with the caret in the document puts the sheet away (the sheet handles Esc from inside itself).
    // Captured, because the editor answers Esc itself (it selects the parent node) and marks the event handled.
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || !narrowRef.current || !sheetOpenRef.current) return
      const t = e.target instanceof Element ? e.target : null
      const inDoc = !!t && (t === container.ownerDocument.body || (!!content?.contains(t) && !t.closest('input, textarea')))
      if (!inDoc) return
      e.preventDefault()
      e.stopPropagation()
      closeSheet()
    }
    win?.addEventListener('keydown', onKey)
    win?.addEventListener('keydown', onEsc, true)
    return () => {
      for (const off of offs) off()
      win?.removeEventListener('keydown', onKey)
      win?.removeEventListener('keydown', onEsc, true)
    }
  }, [bridge, container, content, closeSheet])

  useEffect(
    () =>
      p.commands?.bind({
        comment: (t) => fns.current.openComposer(t),
        nav: (d) => fns.current.nav(d),
        firstUnread: () => fns.current.showFirstUnread(),
        firstConflict: () => fns.current.firstConflict(),
        hasUnsent: () => fns.current.hasUnsent(),
        postUnsent: () => fns.current.postUnsent(),
      }),
    [p.commands],
  )

  // ------------------------------------------------------------------ highlight clicks; a click in the text deactivates

  useEffect(() => {
    let highlightClicked = false
    const offHl = bridge.onHighlightClick((id) => {
      highlightClicked = true
      if (activeRef.current !== id) editorClick.current = true
      setActive(id, false)
      // narrow mode: a highlight tap opens the sheet with that thread (§11.4). The caret stays in the document, so
      // the commented text can still be edited; Esc, a tap in the text or typing puts the sheet away.
      if (narrowRef.current) setSheetOpen(true)
    })
    if (!content) return offHl
    const onDown = (): void => {
      highlightClicked = false
    }
    const onClick = (): void => {
      if (highlightClicked) {
        highlightClicked = false
        return
      }
      if (activeRef.current !== null) editorClick.current = true
      setActive(null, false)
      // narrow mode: a tap in the text puts the open sheet away
      if (narrowRef.current) setSheetOpen(false)
    }
    // narrow mode: typing in the document puts the open sheet away too (it would cover the line being typed)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!narrowRef.current || !sheetOpenRef.current || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1 && e.key !== 'Enter' && e.key !== 'Backspace' && e.key !== 'Delete') return
      setSheetOpen(false)
      setActive(null, false)
    }
    content.addEventListener('pointerdown', onDown)
    content.addEventListener('click', onClick)
    content.addEventListener('keydown', onKeyDown)
    return () => {
      offHl()
      content.removeEventListener('pointerdown', onDown)
      content.removeEventListener('click', onClick)
      content.removeEventListener('keydown', onKeyDown)
    }
  }, [bridge, content, setActive])

  // ------------------------------------------------------------------ render

  const api = useMemo<RailApi>(
    () => ({
      session, bridge, scheduler, readMarkers, summaries, suggestionsById: model.suggestionsById, activeId, readOnly,
      activate, setPin, decide: (id, d) => void decide(id, d), acceptAllInThread: (t) => void acceptAllInThread(t), inFlight, errors,
      registerReply, getReply, putReply, registerPoster, returnToDoc, notify, hover, focusAfterLayout: (get, reveal) => focusAfterLayout(get, reveal),
    }),
    [session, bridge, scheduler, readMarkers, summaries, model.suggestionsById, activeId, readOnly, activate, setPin, decide, acceptAllInThread, inFlight, errors, registerReply, getReply, putReply, registerPoster, returnToDoc, notify, hover, focusAfterLayout],
  )

  const onChip = (): void => {
    const nearest = schedulerRef.current?.lastFrame()?.output.overflowAbove.at(-1)
    if (nearest) setActive(nearest, false)
  }
  const onPill = (): void => {
    const a = activeRef.current
    const y = a ? schedulerRef.current?.lastFrame()?.anchors.get(a) : undefined
    if (y !== undefined) container.scrollTop = anchorScrollTop(y, container.clientHeight)
    // The pill hides itself once the card is back in view, so a pill that has the focus (a keyboard press) would leave it on
    // <body> and the rest of a half-written reply would go nowhere: the caret goes back to the box he was typing in, else
    // to the card (Pass 4 rail-ui 11). A pointer press never takes the focus from the box (the button's mousedown is
    // default-prevented), which is already where it was.
    if (a !== null && pill.current && container.ownerDocument.activeElement === pill.current) {
      focusAfterLayout(() => {
        const box = a === DRAFT_ID ? draftArea.current : (replies.current.get(a as ThreadId) ?? null)
        if (box?.isConnected && box.value !== '') {
          box.setSelectionRange(box.value.length, box.value.length)
          return box
        }
        return cardEl(a)
      })
    }
  }

  const header = (
    <RailHeader
      headerRef={headerEl}
      docThreads={model.docThreads}
      detached={model.detached}
      unplaced={model.unplaced}
      unreadTotal={model.unreadTotal}
      pendingClaude={model.pendingClaude.length}
      showResolved={showResolved}
      resolvedCount={model.resolvedCount}
      claudeMayEdit={!review.policy.suggestOnly}
      policyBusy={policyBusy}
      bulkBusy={bulkBusy}
      readOnly={readOnly}
      conflicts={detachedConflicts.length ? detachedConflicts.map((c) => <ConflictCard key={c.id} conflict={c} variant="static" />) : undefined}
      hint={!readOnly && review.threads.length === 0 && draft === null}
      mode={mode}
      activeId={activeId}
      chipRef={chip}
      onDocComment={() => openComposer('doc')}
      onMarkAllRead={() => session.markRead(null, reviewRef.current.seq)}
      onBulk={(d) => void bulk(d)}
      onShowResolved={setShowResolved}
      onPolicy={(on) => void setPolicy(on)}
      onChip={onChip}
    />
  )
  const draftCard = draft ? (
    <DraftCard
      draft={draft}
      onChange={(body) => setDraft((d) => (d ? { ...d, body } : d))}
      onSubmit={() => void submitDraft()}
      onCancel={cancelDraft}
      textareaRef={draftArea}
    />
  ) : null

  const dock = showDock ? (
    <DocDock
      value={docDraft?.body ?? ''}
      busy={docDraft?.busy ?? false}
      error={docDraft?.error ?? null}
      posted={posted}
      narrow={narrow}
      // an emptied box is no draft at all (hasUnsent and Send to Claude look at the body); typing clears a post error
      onChange={(body) => setDocDraft((d) => (body === '' ? null : { body, busy: d?.busy ?? false, error: null }))}
      onPost={() => void submitDoc()}
      onEscape={() => returnToDoc()}
      dockRef={dockEl}
      textareaRef={docArea}
    />
  ) : null

  if (narrow) {
    const host = p.sheetHost
    return (
      <RailContext.Provider value={api}>
        {host && dock ? createPortal(dock, host) : null}
        {host
          ? createPortal(
              <BottomSheet
                open={sheetOpen}
                onOpenChange={(o) => (o ? setSheetOpen(true) : closeSheet())}
                count={model.positioned.length + model.docThreads.length}
                unread={model.unreadTotal}
                bodyRef={sheetBody}
              >
                {header}
                {conflicts.map((c) => (
                  <ConflictCard key={c.id} conflict={c} />
                ))}
                {draftCard}
                {model.positioned.length ? (
                  <section className="mdr-sheet-cards" aria-label="Comments in the document">
                    {model.positioned.map((t) => (
                      <ThreadCard key={t.id} thread={t} variant="static" fold />
                    ))}
                  </section>
                ) : null}
              </BottomSheet>,
              host,
            )
          : null}
      </RailContext.Provider>
    )
  }

  return (
    <RailContext.Provider value={api}>
      {header}
      <div className="mdr-ticks" ref={tickLayer} aria-hidden="true" />
      {scheduler ? model.positioned.map((t) => <ThreadCard key={t.id} thread={t} variant="rail" />) : null}
      {scheduler ? conflicts.filter((c) => placeable.has(c.id)).map((c) => <ConflictCard key={c.id} conflict={c} />) : null}
      {scheduler ? draftCard : null}
      <button
        type="button"
        className="mdr-float-comment"
        data-testid={TESTID.floatingComment}
        ref={floatBtn}
        hidden
        // keep the editor's focus and selection: the target is read on click
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const t = watch.refresh()
          if (t) openComposer(t)
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8 5.4v3.2M6.4 7h3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="mdr-offscreen-pill"
        data-testid={TESTID.offscreenPill}
        ref={pill}
        hidden
        // keep the focus where it is: the pill goes away when the card comes back, and so would the focus
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPill}
      />
      {dock}
    </RailContext.Provider>
  )
}
