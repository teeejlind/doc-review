// web/src/rail/overlays.ts (P3, pure; CONTRACTS §11.4).
//
// Geometry for the rail's viewport-relative extras, all in scroll-container content coordinates (§12.0.3):
//   - the floating Comment button's y (R2.1 "the button always visible"),
//   - whether the active card is off-screen and which edge its pill pins to,
//   - the scrollTop that puts an anchor 30% from the top (next/prev and the pill),
//   - anchor ticks (a card displaced more than TICK_DISPLACEMENT from its anchor).

/** Space between the floating button and the visible band's edges (px). */
export const FLOAT_EDGE = 8
/** A card displaced more than this from its anchor shows a gutter tick at anchorY (px). */
export const TICK_DISPLACEMENT = 24
/** next/prev and the off-screen pill scroll the anchor to this fraction of the viewport height. */
export const ANCHOR_VIEW_FRACTION = 0.3

export interface View {
  /** container.scrollTop */
  top: number
  /** container.scrollTop + container.clientHeight */
  bottom: number
}

/**
 * §11.4: `clamp(target.rect.top, viewTop + 8, min(target.extent.bottom, viewBottom) - 8 - buttonHeight)`, so the
 * button starts level with the selection's first line and rides the visible edge while any of the selection is on
 * screen. null (hidden) when the whole selection is off screen. When the visible sliver is thinner than the button,
 * the lower bound wins so the button stays on screen.
 */
export function floatingButtonY(
  target: { rect: { top: number }; extent: { top: number; bottom: number } },
  view: View,
  buttonHeight: number,
): number | null {
  if (target.extent.bottom < view.top || target.extent.top > view.bottom) return null
  const lo = view.top + FLOAT_EDGE
  const hi = Math.min(target.extent.bottom, view.bottom) - FLOAT_EDGE - buttonHeight
  return Math.max(lo, Math.min(target.rect.top, hi))
}

/** Which viewport edge the off-screen pill pins to, or null while any of the card is in the visible band. */
export function offscreenDirection(card: { top: number; height: number }, view: View): 'up' | 'down' | null {
  if (card.top + card.height <= view.top) return 'up'
  if (card.top >= view.bottom) return 'down'
  return null
}

/** The scrollTop that puts content y `anchorY` 30% from the top of a `clientHeight` viewport (never below 0). */
export function anchorScrollTop(anchorY: number, clientHeight: number): number {
  return Math.max(0, Math.round(anchorY - clientHeight * ANCHOR_VIEW_FRACTION))
}

/** Narrow mode: the anchor's first line keeps at least this much room above the top of the visible document (px). */
export const SHEET_STRIP_EDGE = 12
/** Narrow mode: ... and this much (one line plus air) between its top and the sheet (px). */
export const SHEET_STRIP_LINE = 40

/**
 * Narrow mode (§11.4): the sheet covers the bottom of the window, so the active anchor has to sit in the `strip` of
 * document above it (`strip` = the visible height left when the sheet is at its tallest). The scrollTop that keeps
 * content y `anchorY` there: unchanged while it already is, else the anchor at 30% of the strip (never below 0).
 */
export function stripScrollTop(anchorY: number, scrollTop: number, strip: number): number {
  const at = anchorY - scrollTop
  if (at >= SHEET_STRIP_EDGE && at <= strip - SHEET_STRIP_LINE) return scrollTop
  return Math.max(0, Math.round(anchorY - strip * ANCHOR_VIEW_FRACTION))
}

export interface TickSpec {
  id: string
  anchorY: number
  /** The card's top (content y): the connector runs from the tick to it. */
  cardTop: number
}

/**
 * Ticks for placements displaced more than TICK_DISPLACEMENT from their anchors, plus the active card's always
 * (TJ, 2026-11-16). The active card sits level with its line, so it is never displaced; without a tick of its own,
 * the only tick beside a tall active card was the next card's, pushed below it, which read as the active card's tick
 * sitting halfway down the card next to an unrelated paragraph. Every tick is level with its card's first anchor line.
 */
export function ticksFor(placements: ReadonlyArray<{ id: string; top: number; displacement: number }>, activeId: string | null = null): TickSpec[] {
  const out: TickSpec[] = []
  for (const p of placements) {
    if (p.id === activeId || Math.abs(p.displacement) > TICK_DISPLACEMENT) out.push({ id: p.id, anchorY: p.top - p.displacement, cardTop: p.top })
  }
  return out
}
