// web/src/threads/RecoveredCard.tsx (P3; CONTRACTS §12.4, §12.5, §12.14, §12.15 recoveredCard / cardAction).
//
// TJ's local copy, kept when a save couldn't be merged ('merge-failed': Copy, Keep mine, Dismiss) or a draft
// couldn't be restored ('schema-invalid': Copy, Dismiss; it can't be loaded). It renders in the banner slot, outside
// the scroll container, so it is on screen wherever TJ is in the document and never moves the rail.
// Copy calls session.copyRecoveredDraft() inside the click (the clipboard needs the gesture).
import { useEffect, useState } from 'react'
import { TESTID } from '../../../shared/constants'
import type { DocSession, RecoveredDraft } from '../../../shared/types'

export const RECOVERED_TITLE: Readonly<Record<RecoveredDraft['reason'], string>> = {
  'merge-failed': 'Couldn’t merge: your copy is kept',
  'schema-invalid': 'Couldn’t restore your unsaved edits',
}

const RECOVERED_TEXT: Readonly<Record<RecoveredDraft['reason'], string>> = {
  'merge-failed': 'The file changed in a way your edits couldn’t be merged into. Keep mine puts your copy back in the editor and saves it.',
  'schema-invalid': 'Your unsaved edits from last time couldn’t be loaded into the editor. Copy them to keep them.',
}

export function useRecoveredDraft(session: DocSession): RecoveredDraft | null {
  const [draft, setDraft] = useState(() => session.getRecoveredDraft())
  useEffect(() => {
    setDraft(session.getRecoveredDraft())
    return session.subscribe((what) => {
      if (what === 'recovered') setDraft(session.getRecoveredDraft())
    })
  }, [session])
  return draft
}

export function RecoveredCard({ draft, session }: { draft: RecoveredDraft; session: DocSession }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const preview = draft.markdown.length > 240 ? `${draft.markdown.slice(0, 240)}…` : draft.markdown
  const copy = (): void => {
    // inside the gesture: the session writes the clipboard before its first await
    void session.copyRecoveredDraft().then(setCopied, () => setCopied(false))
  }
  const keep = (): void => {
    setBusy(true)
    void session.keepRecoveredDraft().finally(() => setBusy(false))
  }
  return (
    <section className="mdr-recovered" data-testid={TESTID.recoveredCard} data-kind={draft.reason} role="alert" aria-labelledby="mdr-recovered-title">
      <div className="mdr-recovered-text">
        <h2 className="mdr-recovered-title" id="mdr-recovered-title">
          {RECOVERED_TITLE[draft.reason]}
        </h2>
        <p className="mdr-recovered-detail">{RECOVERED_TEXT[draft.reason]}</p>
        {preview ? <pre className="mdr-recovered-preview">{preview}</pre> : null}
      </div>
      <div className="mdr-recovered-actions">
        <button type="button" className="mdr-button mdr-button--small" data-testid={TESTID.cardAction} data-action="copy" aria-label={`${copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy'}: your copy, as markdown`} onClick={copy}>
          {copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy'}
        </button>
        {draft.reason === 'merge-failed' ? (
          <button type="button" className="mdr-button mdr-button--small mdr-button--primary" data-testid={TESTID.cardAction} data-action="keep-mine" aria-label="Keep mine: load my copy into the editor" disabled={busy} onClick={keep}>
            Keep mine
          </button>
        ) : null}
        <button type="button" className="mdr-button mdr-button--small mdr-button--quiet" data-testid={TESTID.cardAction} data-action="dismiss" aria-label="Dismiss my copy" onClick={() => session.discardRecoveredDraft()}>
          Dismiss
        </button>
      </div>
    </section>
  )
}
