// web/src/narrow/BottomSheet.tsx (P3; CONTRACTS §11.4 "Narrow mode", §11.6, §12.15 sheet).
//
// Below 640 px the comments live in a sheet docked to the bottom of the window. Collapsed, it is one bar ("Comments",
// the count, an unread dot); a tap on the bar, a highlight tap, Comment or next/prev opens it. Open, it holds the
// rail header's items at the top (whole-doc comments, Accept all / Reject all from Claude, the toggles, Detached,
// unplaced) and the document's comment cards below, with the active one open. Esc or the bar closes it.
// `data-open` on mdr-sheet says which state it is in.
import { useId, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { TESTID } from '../../../shared/constants'
import './narrow.css'

export interface BottomSheetProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Open threads in the document (the bar's count). */
  count: number
  unread: number
  bodyRef?: Ref<HTMLDivElement>
  children: ReactNode
}

export function BottomSheet(p: BottomSheetProps) {
  const bodyId = useId()
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape' && p.open && !e.defaultPrevented) {
      e.preventDefault()
      p.onOpenChange(false)
    }
  }
  const label = p.count === 1 ? '1 comment' : `${p.count} comments`
  return (
    <section className="mdr-sheet" data-testid={TESTID.sheet} data-open={String(p.open)} aria-label="Comments" onKeyDown={onKeyDown}>
      <div className="mdr-sheet-bar">
        <button
          type="button"
          className="mdr-sheet-handle"
          data-testid={TESTID.sheetToggle}
          aria-expanded={p.open ? 'true' : 'false'}
          aria-controls={bodyId}
          aria-label={`Comments ${p.count}${p.unread ? `, ${p.unread} unread` : ''}`}
          title={`${p.open ? 'Close' : 'Open'} comments (${label}${p.unread ? `, ${p.unread} unread` : ''})`}
          onClick={() => p.onOpenChange(!p.open)}
        >
          <span className="mdr-sheet-grabber" aria-hidden="true" />
          <span className="mdr-sheet-title">Comments</span>{' '}
          <span className="mdr-sheet-count">{p.count}</span>
          {p.unread > 0 ? (
            <>
              <span className="mdr-unread-dot" aria-hidden="true" />
              <span className="mdr-visually-hidden">, {p.unread} unread</span>
            </>
          ) : null}
          <svg className="mdr-sheet-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="mdr-sheet-body" id={bodyId} ref={p.bodyRef} hidden={!p.open}>
        {p.children}
      </div>
    </section>
  )
}
