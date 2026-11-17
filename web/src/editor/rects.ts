// web/src/editor/rects.ts (P2). Scroll-container content coordinates (CONTRACTS §12.0.3, normative).
//
// For a client rect r and C = scrollContainer.getBoundingClientRect():
//   top = r.top - C.top + scrollTop - clientTop, bottom likewise, left = r.left - C.left + scrollLeft - clientLeft.
// These values don't change when the container scrolls. P2 converts; P3 uses AnchorRects as-is.
import type { EditorView } from '@milkdown/kit/prose/view'
import type { AnchorRect } from '../../../shared/types'
import { unstickBox } from './stickyHeader'

export interface ClientBox { top: number; bottom: number; left: number }

export function toContent(sc: HTMLElement, box: ClientBox): AnchorRect {
  // a box in a pinned table header row counts at the row's unpinned place (stickyHeader.ts)
  const r = unstickBox(sc, box)
  const c = sc.getBoundingClientRect()
  return {
    top: r.top - c.top + sc.scrollTop - sc.clientTop,
    bottom: r.bottom - c.top + sc.scrollTop - sc.clientTop,
    left: r.left - c.left + sc.scrollLeft - sc.clientLeft,
  }
}

/** The first client rect of an element (its first line for inline content), or its bounding box. */
export function elementBox(el: Element): ClientBox {
  const rects = typeof el.getClientRects === 'function' ? el.getClientRects() : null
  const first = rects && rects.length ? rects[0]! : el.getBoundingClientRect()
  return { top: first.top, bottom: first.bottom, left: first.left }
}

/** view.coordsAtPos with a guard (jsdom has no layout and throws for text ranges). */
export function coordsAt(view: EditorView, pos: number, side: -1 | 1 = 1): ClientBox | null {
  try {
    const c = view.coordsAtPos(Math.max(0, Math.min(pos, view.state.doc.content.size)), side)
    return { top: c.top, bottom: c.bottom, left: c.left }
  } catch {
    return null
  }
}

/** The DOM box of the top-level node at `pos` (a block anchor, an unplaced suggestion's first block). */
export function nodeBox(view: EditorView, pos: number): ClientBox | null {
  try {
    const dom = view.nodeDOM(pos)
    if (dom && dom.nodeType === 1) return elementBox(dom as Element)
  } catch {
    // fall through
  }
  return coordsAt(view, pos + 1)
}
