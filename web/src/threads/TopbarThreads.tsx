// web/src/threads/TopbarThreads.tsx (P3; CONTRACTS §11.4, §12.15 commentButton / navPrev / navNext, R2.1, R2.5).
//
// The top bar's comment controls: the Comment button (the always-present fallback to the floating one; enabled
// whenever the selection target is non-null, so it works for a selection scrolled fully off screen) and previous /
// next comment. A pointer-down on them never takes the editor's focus or selection.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { TESTID } from '../../../shared/constants'
import { shortcut } from '../platform'
import type { NavCount, RailCommands } from '../rail/commands'
import type { SelectionWatch } from './selection'

export interface TopbarThreadsProps {
  commands: RailCommands
  selection: SelectionWatch
  readOnly?: boolean
  /** How many comments next/prev can reach; at 0 they are disabled (QA3 rail-ui 15). Absent: always enabled. */
  navCount?: NavCount
}

const never = (): (() => void) => () => undefined
const unknown = (): null => null

const keepFocus = (e: { preventDefault(): void }): void => e.preventDefault()

export function TopbarThreads({ commands, selection, readOnly = false, navCount }: TopbarThreadsProps) {
  const [hasTarget, setHasTarget] = useState(() => selection.get() !== null)
  useEffect(() => {
    setHasTarget(selection.get() !== null)
    return selection.subscribe((t) => setHasTarget(t !== null))
  }, [selection])
  const label = hasTarget ? 'Comment on the selection' : 'Select text to comment on it'
  const reachable = useSyncExternalStore(navCount?.subscribe ?? never, navCount?.get ?? unknown, navCount?.get ?? unknown)
  const nothingToReach = reachable === 0
  return (
    <div className="mdr-topbar-group" role="group" aria-label="Comments">
      <button
        type="button"
        className="mdr-button mdr-button--small"
        data-testid={TESTID.commentButton}
        aria-label={label}
        title={`${label} (${shortcut('Mod', 'Alt', 'M')})`}
        disabled={!hasTarget || readOnly}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={() => {
          const t = selection.refresh()
          if (t) commands.comment(t)
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 5.5v3M6.5 7h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <span className="mdr-topbar-label">Comment</span>
      </button>
      <button
        type="button"
        className="mdr-icon-button"
        data-testid={TESTID.navPrev}
        aria-label="Previous comment"
        title={nothingToReach ? 'No comments yet' : `Previous comment (${shortcut('Mod', 'Alt', '[')})`}
        disabled={nothingToReach}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={() => commands.nav(-1)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="mdr-icon-button"
        data-testid={TESTID.navNext}
        aria-label="Next comment"
        title={nothingToReach ? 'No comments yet' : `Next comment (${shortcut('Mod', 'Alt', ']')})`}
        disabled={nothingToReach}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={() => commands.nav(1)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
}
