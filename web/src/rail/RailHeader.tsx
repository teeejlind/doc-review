// web/src/rail/RailHeader.tsx (P3; CONTRACTS §6.3, §6.6, §6.8, §9.9.1, §11.4 "Rail header panel", §12.9, §12.15
// railHeader / docComment / showResolved / acceptAllClaude / rejectAllClaude / policyToggle / unread /
// unplacedSection / detachedSection / overflowChip, §13 rows 26, 37, 38).
//
// The panel at the top of the rail; its bottom edge is minTop, so positioned cards never ride over it. It is quiet
// (QA3): one row with "Comment on document", the "+N above" chip and a settings button; nothing else unless it has
// something to say. It holds:
//   - "Comment on document" (it puts the caret in the dock at the bottom of the viewport: DocDock), and the doc's threads;
//   - the settings button, which opens the show-resolved switch and the "Claude may edit directly" policy switch
//     (checked = suggestOnly false), each with a one-line explanation;
//   - only while there is something to act on: the unread count (click: mark everything read, the doc-level read
//     marker) and Accept all / Reject all from Claude (one bulk request each, one undo step);
//   - "Can't place inline" suggestion threads (BASE_NOT_FOUND / ID_COLLISION) and Detached threads with their
//     original quotes, each as a two-line preview that opens when activated;
//   - the "+N above" chip at the right end of the first row, written by the rail each layout frame (the row has a
//     fixed height, so showing the chip can't move minTop and re-trigger itself).
// The header's height is minTop, so it stays short: the doc and Detached lists fold to one title line (open on a
// click or while they hold the active card; Detached starts open on a read-only
// file, whose threads all land there). The unplaced list starts open: every item in it wants a decision.
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'
import { TESTID } from '../../../shared/constants'
import type { Mode, Thread } from '../../../shared/types'
import { ThreadCard } from '../threads/ThreadCard'

/** The whole-document comment typed in the dock and not yet posted (RailView holds it; null = nothing typed). */
export interface DocDraft {
  body: string
  busy: boolean
  error: string | null
}

export interface RailHeaderProps {
  headerRef: Ref<HTMLDivElement>
  docThreads: Thread[]
  detached: Thread[]
  unplaced: Thread[]
  unreadTotal: number
  pendingClaude: number
  showResolved: boolean
  /** How many resolved threads the toggle hides (shown in its label, so a resolved comment can be found again). */
  resolvedCount: number
  /** Claude may edit directly = !policy.suggestOnly. */
  claudeMayEdit: boolean
  policyBusy: boolean
  bulkBusy: boolean
  readOnly: boolean
  /** Conflict cards the page has no block for (static, in flow): each wants a decision, so they sit at the top. */
  conflicts?: ReactNode
  /** No comments yet on a document TJ can edit: say what to do (QA3 rail-ui 15). */
  hint: boolean
  /** The mode the hint is written for: Suggesting says what his edits become, not how to switch to it. */
  mode: Mode
  /** The active card's id (a folded list holding it opens). */
  activeId: string | null
  chipRef: Ref<HTMLButtonElement>
  onDocComment(): void
  onMarkAllRead(): void
  onBulk(decision: 'accept' | 'reject'): void
  onShowResolved(on: boolean): void
  onPolicy(claudeMayEdit: boolean): void
  onChip(): void
}

export function RailHeader(p: RailHeaderProps) {
  const noBulk = p.bulkBusy || p.readOnly
  const showBulk = p.pendingClaude > 0 && !p.readOnly
  const showStatusRow = p.unreadTotal > 0 || showBulk
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsId = useId()
  const gear = useRef<HTMLButtonElement>(null)
  const docButton = useRef<HTMLButtonElement>(null)
  // a bulk decision takes its own row away; the focus goes back to the header's first button, not to the page
  const refocus = useRef(false)
  useEffect(() => {
    if (showBulk || !refocus.current) return
    refocus.current = false
    if (document.activeElement === document.body || document.activeElement === null) docButton.current?.focus({ preventScroll: true })
  }, [showBulk])
  const closeSettings = (): void => {
    setSettingsOpen(false)
    gear.current?.focus({ preventScroll: true })
  }
  return (
    <div className="mdr-rail-header" data-testid={TESTID.railHeader} ref={p.headerRef}>
      <div className="mdr-rail-head-row mdr-rail-head-row--main">
        <button type="button" ref={docButton} className="mdr-button mdr-button--small mdr-doc-comment" data-testid={TESTID.docComment} aria-label="Comment on document" title="Comment on the whole document" disabled={p.readOnly} onClick={p.onDocComment}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          <span>
            Comment<span className="mdr-rail-long"> on document</span>
          </span>
        </button>
        <button type="button" className="mdr-overflow-chip" data-testid={TESTID.overflowChip} ref={p.chipRef} hidden onClick={p.onChip} />
        <button
          type="button"
          ref={gear}
          className="mdr-icon-button mdr-rail-settings-button"
          data-testid={TESTID.railSettings}
          aria-label="Review settings"
          aria-expanded={settingsOpen ? 'true' : 'false'}
          aria-controls={settingsId}
          title="Review settings"
          onClick={() => setSettingsOpen(!settingsOpen)}
          // focus stays on the gear after it opens the popover, so Escape here closes it too (T2 polish #38)
          onKeyDown={(e) => {
            if (e.key === 'Escape' && settingsOpen) {
              e.preventDefault()
              e.stopPropagation()
              closeSettings()
            }
          }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M2.5 5h5.4M12.1 5h1.4M2.5 11h1.4M8.1 11h5.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="10" cy="5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="6" cy="11" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      <div
        className="mdr-rail-settings"
        id={settingsId}
        role="group"
        aria-label="Review settings"
        hidden={!settingsOpen}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            closeSettings()
          }
        }}
      >
        <Setting
          testid={TESTID.showResolved}
          label={p.resolvedCount > 0 ? `Show resolved (${p.resolvedCount})` : 'Show resolved'}
          hint="Also list resolved comments and decided suggestions."
          checked={p.showResolved}
          onChange={p.onShowResolved}
        />
        <Setting
          testid={TESTID.policyToggle}
          label="Claude may edit directly"
          hint={POLICY_HELP}
          tooltip
          checked={p.claudeMayEdit}
          disabled={p.policyBusy || p.readOnly}
          onChange={p.onPolicy}
        />
      </div>
      {showStatusRow ? (
        <div className="mdr-rail-head-row mdr-rail-head-row--status">
          {p.unreadTotal > 0 ? (
            <button type="button" className="mdr-unread-count" data-testid={TESTID.unread} data-count={p.unreadTotal} aria-label={`${p.unreadTotal} unread from Claude. Mark all read`} onClick={p.onMarkAllRead}>
              <span className="mdr-unread-count-dot" aria-hidden="true" />
              {p.unreadTotal} unread
            </button>
          ) : null}
          {showBulk ? (
            <>
              <button
                type="button"
                className="mdr-link-button"
                data-testid={TESTID.acceptAllClaude}
                aria-disabled={noBulk ? 'true' : 'false'}
                aria-label={`Accept all from Claude (${p.pendingClaude})`}
                title="Accept every pending suggestion from Claude"
                onClick={() => {
                  if (noBulk) return
                  refocus.current = true
                  p.onBulk('accept')
                }}
              >
                Accept all from Claude ({p.pendingClaude})
              </button>
              <button
                type="button"
                className="mdr-link-button"
                data-testid={TESTID.rejectAllClaude}
                aria-disabled={noBulk ? 'true' : 'false'}
                aria-label={`Reject all from Claude (${p.pendingClaude})`}
                title="Reject every pending suggestion from Claude"
                onClick={() => {
                  if (noBulk) return
                  refocus.current = true
                  p.onBulk('reject')
                }}
              >
                Reject all
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {p.conflicts ? <div className="mdr-rail-conflicts">{p.conflicts}</div> : null}

      {p.hint ? (
        <p className="mdr-rail-hint" role="note">
          Select text to comment. {p.mode === 'suggesting' ? 'Your edits are tracked as suggestions.' : 'Switch to Suggesting to propose edits.'} Click Send to Claude
          when you’re done.
        </p>
      ) : null}

      {p.docThreads.length ? (
        <Fold
          label="Comments on the document"
          title={`On the document${p.docThreads.length ? ` (${p.docThreads.length})` : ''}`}
          unread={p.docThreads.reduce((n, t) => n + Math.max(0, t.unread), 0)}
          forceOpen={p.docThreads.some((t) => t.id === p.activeId)}
          defaultOpen={false}
        >
          {p.docThreads.map((t) => (
            <ThreadCard key={t.id} thread={t} variant="static" />
          ))}
        </Fold>
      ) : null}

      {p.unplaced.length ? (
        <Fold
          testid={TESTID.unplacedSection}
          label="Suggestions that can't be placed inline"
          title={`Can’t place inline (${p.unplaced.length})`}
          unread={p.unplaced.reduce((n, t) => n + Math.max(0, t.unread), 0)}
          forceOpen={p.unplaced.some((t) => t.id === p.activeId)}
          defaultOpen
        >
          {p.unplaced.map((t) => (
            <ThreadCard key={t.id} thread={t} variant="static" fold />
          ))}
        </Fold>
      ) : null}

      {p.detached.length ? (
        <Fold
          testid={TESTID.detachedSection}
          label="Detached comments"
          title={`Detached (${p.detached.length})`}
          unread={p.detached.reduce((n, t) => n + Math.max(0, t.unread), 0)}
          forceOpen={p.detached.some((t) => t.id === p.activeId)}
          defaultOpen={p.readOnly}
        >
          <p className="mdr-rail-section-note">The text these were on is gone. Each keeps its original quote.</p>
          {p.detached.map((t) => (
            <ThreadCard key={t.id} thread={t} variant="static" fold quoteFrom="lastAnchor" />
          ))}
        </Fold>
      ) : null}
    </div>
  )
}

/** A header list that folds to its title line. `forceOpen` keeps it open (an active card inside). */
function Fold(p: { testid?: string; label: string; title: string; unread: number; forceOpen: boolean; defaultOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(p.defaultOpen)
  const shown = open || p.forceOpen
  return (
    <section className="mdr-rail-section" data-testid={p.testid} data-open={String(shown)} aria-label={p.label}>
      <h2 className="mdr-rail-section-title">
        <button
          type="button"
          className="mdr-fold-button"
          aria-expanded={shown ? 'true' : 'false'}
          aria-label={`${p.title}${p.unread > 0 && !shown ? `, ${p.unread} unread` : ''}`}
          onClick={() => setOpen(!shown)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {p.title}
          {p.unread > 0 && !shown ? <span className="mdr-unread-dot" role="img" aria-label={`${p.unread} unread`} /> : null}
        </button>
      </h2>
      {shown ? p.children : null}
    </section>
  )
}

/** What the policy switch does in each state (it is on for every new document, so a first-timer needs to be told). */
const POLICY_HELP = 'On: Claude can change the text itself. Off: Claude can only suggest changes for you to accept.'

/** A switch with its one-line explanation (the switch's description, so a screen reader reads it too; `tooltip` repeats it as the hover title). */
function Setting(p: { testid: string; label: string; hint: string; tooltip?: boolean; checked: boolean; disabled?: boolean; onChange(on: boolean): void }) {
  const hintId = useId()
  return (
    <div className="mdr-rail-setting">
      <button
        type="button"
        role="switch"
        className="mdr-switch"
        data-testid={p.testid}
        aria-checked={p.checked ? 'true' : 'false'}
        aria-label={p.label}
        aria-describedby={hintId}
        {...(p.tooltip ? { title: p.hint } : {})}
        disabled={p.disabled}
        onClick={() => p.onChange(!p.checked)}
      >
        <span className="mdr-switch-track" aria-hidden="true">
          <span className="mdr-switch-thumb" />
        </span>
        <span className="mdr-switch-label">{p.label}</span>
      </button>
      <p className="mdr-rail-setting-hint" id={hintId}>
        {p.hint}
      </p>
    </div>
  )
}
