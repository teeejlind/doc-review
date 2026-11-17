// web/src/shell/SaveChip.tsx (P3; CONTRACTS §12.4 save state machine and labels, §12.15 saveChip).
//
// The top bar's save chip: one label per SaveState (`data-state` = the state), and the two actions §12.4 names:
// "Couldn't save: Retry" and a click on the Offline label call session.retrySave(); "Conflict (n)" takes TJ to the
// first conflict card. Passive states render a plain span; actionable ones a button.
//
// Screen readers: the chip flips between Saving… and Saved every few seconds while TJ types, so it is not a live
// region itself. A separate polite live region speaks only the states that need TJ (offline, conflict, error,
// read-only), once per change.
import { useEffect, useState } from 'react'
import { TESTID } from '../../../shared/constants'
import type { DocSession, ReadOnlyCode, SaveState } from '../../../shared/types'

/** The short reason after "Read-only: " (the full message is the title). */
export const READ_ONLY_REASON: Readonly<Record<ReadOnlyCode, string>> = {
  NOT_UTF8: 'not UTF-8',
  TOO_LARGE: 'file too large',
  SIDECAR_CORRUPT: 'review data damaged',
  SIDECAR_SCHEMA_UNSUPPORTED: 'review data from a newer mdr',
  CONTRACT_MISMATCH: 'page out of date',
  DOC_GONE: 'file moved or deleted',
  TAB_NOT_LEADER: 'open in another tab',
}

export interface SaveChipView {
  label: string
  /** retry: session.retrySave(); conflict: show the first conflict card. */
  action: 'retry' | 'conflict' | null
  title: string
  /** Visible code next to the label (the error state shows its code, §12.4). */
  code: string | null
  tone: 'quiet' | 'busy' | 'warn' | 'danger'
  /** What the live region says (null for the routine states). */
  announce: string | null
}

const time = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** §12.4 labels: Saved · Saving… · Offline: changes kept on this device · Conflict (n) · Couldn't save: Retry · Read-only: <reason>. */
export function saveChipView(s: SaveState): SaveChipView {
  switch (s.state) {
    case 'saved': {
      const at = time(s.at)
      return { label: 'Saved', action: null, title: at ? `All changes saved at ${at}` : 'All changes saved', code: null, tone: 'quiet', announce: null }
    }
    case 'unsaved':
    case 'saving':
      // 'unsaved' is the autosave debounce (600 ms at most), so it reads the same as the save it is about to be
      return { label: 'Saving…', action: null, title: 'Saving your changes', code: null, tone: 'busy', announce: null }
    case 'offline': {
      const at = time(s.retryAt)
      return {
        label: 'Offline: changes kept on this device',
        action: 'retry',
        title: `${at ? `Retrying at ${at}. ` : ''}Click to retry now.`,
        code: null,
        tone: 'warn',
        announce: 'Offline: changes kept on this device',
      }
    }
    case 'conflict':
      return {
        label: `Conflict (${s.count})`,
        action: 'conflict',
        title: s.count === 1 ? 'One block needs a decision: show it' : `${s.count} blocks need a decision: show the first`,
        code: null,
        tone: 'danger',
        announce: `Conflict: ${s.count} ${s.count === 1 ? 'block needs' : 'blocks need'} a decision`,
      }
    case 'error':
      if (s.code === 'IO_ERROR') {
        // QA3: a reachable server that can't write the file says so in words
        return { label: 'Couldn’t save: server can’t write this file', action: 'retry', title: `${s.message} Click to retry.`, code: s.code, tone: 'danger', announce: 'Couldn’t save: the server can’t write this file' }
      }
      return { label: 'Couldn’t save: Retry', action: 'retry', title: `${s.message} (${s.code}). Click to retry.`, code: s.code, tone: 'danger', announce: `Couldn’t save (${s.code})` }
    case 'readonly': {
      const reason = READ_ONLY_REASON[s.code] ?? s.code
      return { label: `Read-only: ${reason}`, action: null, title: s.message, code: null, tone: 'warn', announce: `Read-only: ${reason}` }
    }
  }
}

export function useSaveState(session: DocSession): SaveState {
  const [s, setS] = useState(() => session.getSaveState())
  useEffect(() => {
    setS(session.getSaveState())
    return session.subscribe((what) => {
      if (what === 'save') setS(session.getSaveState())
    })
  }, [session])
  return s
}

export interface SaveChipProps {
  session: DocSession
  /** "Conflict (n)": show the first conflict card (the rail's command). */
  onConflict?: () => void
}

export function SaveChip({ session, onConflict }: SaveChipProps) {
  const s = useSaveState(session)
  // Cmd+S: nothing to confirm, saving is automatic, but the browser's Save Page dialog must not open; flush now so the chip says Saved
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.key.toLowerCase() !== 's' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      e.preventDefault()
      void session.flush()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])
  const v = saveChipView(s)
  const common = {
    className: 'mdr-save-chip',
    'data-testid': TESTID.saveChip,
    'data-state': s.state,
    'data-tone': v.tone,
    title: v.title,
  }
  const body = (
    <>
      <span className="mdr-save-chip-dot" aria-hidden="true" />
      <span className="mdr-save-chip-label">{v.label}</span>
      {v.code ? (
        <>
          {' '}
          <span className="mdr-save-chip-code">{v.code}</span>
        </>
      ) : null}
    </>
  )
  return (
    <>
      {v.action ? (
        <button
          type="button"
          {...common}
          aria-label={v.code ? `${v.label} ${v.code}` : v.label}
          onClick={() => {
            if (v.action === 'retry') session.retrySave()
            else onConflict?.()
          }}
        >
          {body}
        </button>
      ) : (
        <span {...common}>{body}</span>
      )}
      <span className="mdr-visually-hidden" aria-live="polite">
        {v.announce ?? ''}
      </span>
    </>
  )
}
