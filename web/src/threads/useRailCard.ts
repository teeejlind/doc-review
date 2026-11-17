// web/src/threads/useRailCard.ts (P3; CONTRACTS §11.3, §11.4, §11.6).
//
// What every card element shares, whether the scheduler positions it (thread, conflict and draft cards in the
// rail) or it sits in the rail header's flow (doc, Detached and unplaced cards):
//   - registration with the scheduler (positioned cards only): the article is moved, the body is measured;
//   - activation (§11.4): a pointer-down on the card's body compensates (the card stays under the cursor and the doc
//     scrolls); on a composer or any focusable control it doesn't (the doc never scrolls, the card moves); keyboard
//     focus activates in place;
//   - focus-within, which the card turns into pinExpanded;
//   - hover, for the anchor tick's connector.
import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from 'react'
import { useRail } from './context'

/** Controls whose pointer-down activates a card without compensation scroll (§11.4 composer exemption). */
export const CONTROL_SELECTOR =
  'button, a[href], input, textarea, select, summary, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="button"], [role="switch"]'

export function useRailCard(id: string, positioned: boolean) {
  const rail = useRail()
  const el = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [focusWithin, setFocusWithin] = useState(false)
  const { scheduler, activate, hover, focusAfterLayout } = rail

  useLayoutEffect(() => {
    if (!positioned || !scheduler) return undefined
    scheduler.registerCard(id, el.current, { full: body.current })
    return () => scheduler.registerCard(id, null)
  }, [scheduler, id, positioned])

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.button > 0) return // primary button only (jsdom's synthetic events carry none)
      const target = e.target instanceof Element ? e.target : null
      const control = target?.closest(CONTROL_SELECTOR) ?? null
      activate(id, positioned && !control)
      // composer exemption (§11.4): the card moves to its anchor without scrolling the doc, then the composer is
      // focused with preventScroll after that layout frame
      if (control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement) focusAfterLayout(() => (control.isConnected ? control : null))
    },
    [activate, focusAfterLayout, id, positioned],
  )
  const onFocus = useCallback(() => {
    setFocusWithin(true)
    activate(id, false)
  }, [activate, id])
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    if (!el.current?.contains(e.relatedTarget as Node | null)) setFocusWithin(false)
  }, [])
  const onPointerEnter = useCallback(() => hover(id, true), [hover, id])
  const onPointerLeave = useCallback(() => hover(id, false), [hover, id])

  return {
    el,
    body,
    focusWithin,
    active: rail.activeId === id,
    handlers: { onPointerDown, onFocus, onBlur, onPointerEnter, onPointerLeave },
  }
}
