// web/src/threads/ConflictCard.tsx (P3; CONTRACTS §7.4, §12.14, §12.15 conflictCard / cardAction).
//
// A block that couldn't be saved as TJ has it, positioned at that block like a thread card (the bridge returns its
// rect for the conflict id). When the page has no block to sit beside (Claude deleted the block TJ was typing in, or
// the file was emptied), the card is `static`: in the rail header's flow, visible, never left hidden (QA3 rail-ui 13).
//   kind 'conflict'    the same block changed on disk while TJ edited it. Shows theirs (and who wrote it), mine and
//                      the original. Keep mine → resolveConflict(id, 'mine'); Take theirs → 'theirs'.
//   kind 'unsaveable'  the change can't be spliced in without touching its neighbours (D37). Copy markdown copies
//                      TJ's version; Discard my change → resolveConflict(id, 'theirs').
// Nothing is overwritten until TJ picks.
import { useState } from 'react'
import { TESTID } from '../../../shared/constants'
import type { BlockConflict } from '../../../shared/types'
import { copyText } from './clipboard'
import { useRail } from './context'
import { authorLabel } from './model'
import { useRailCard } from './useRailCard'

export function ConflictCard({ conflict, variant = 'rail' }: { conflict: BlockConflict; variant?: 'rail' | 'static' }) {
  const rail = useRail()
  const card = useRailCard(conflict.id, variant === 'rail')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<boolean | null>(null)
  const unsaveable = conflict.kind === 'unsaveable'
  const labelId = `mdr-conflict-label-${conflict.id}`

  const resolve = async (choice: 'mine' | 'theirs'): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await rail.bridge.resolveConflict(conflict.id, choice)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t resolve this block')
    } finally {
      setBusy(false)
    }
  }
  const copyMine = (): void => {
    void copyText(conflict.mine ?? '').then((ok) => {
      setCopied(ok)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <article
      ref={card.el}
      className={`mdr-card ${variant === 'static' ? 'mdr-card--static' : 'mdr-card--rail'} mdr-card--conflict`}
      data-testid={TESTID.conflictCard}
      data-conflict={conflict.id}
      data-kind={conflict.kind}
      data-active={String(card.active)}
      aria-current={card.active ? 'true' : undefined}
      aria-labelledby={labelId}
      tabIndex={0}
      {...card.handlers}
    >
      <div className="mdr-card-body" ref={card.body}>
        <div className="mdr-card-head">
          <span className="mdr-card-label mdr-conflict-title" id={labelId}>
            {unsaveable ? 'Couldn’t save this block' : 'This block changed in two places'}
          </span>
        </div>
        {unsaveable ? (
          <p className="mdr-card-meta">The file still has the earlier version of this block. The rest of the document keeps saving.</p>
        ) : (
          <p className="mdr-card-meta">{authorLabel(conflict.theirsBy)} changed it while you were editing. The file keeps their version until you pick.</p>
        )}
        <figure className="mdr-conflict-side" data-side="mine">
          <figcaption>Yours</figcaption>
          <pre>{conflict.mine ?? '(you deleted this block)'}</pre>
        </figure>
        {!unsaveable ? (
          <figure className="mdr-conflict-side" data-side="theirs">
            <figcaption>{authorLabel(conflict.theirsBy)}’s</figcaption>
            <pre>{conflict.theirs ?? '(deleted on disk)'}</pre>
          </figure>
        ) : null}
        {!unsaveable ? (
          <details className="mdr-conflict-base">
            <summary>Original</summary>
            <pre>{conflict.base}</pre>
          </details>
        ) : null}
        <div className="mdr-card-actions">
          {unsaveable ? (
            <>
              <button type="button" className="mdr-button mdr-button--small" data-testid={TESTID.cardAction} data-action="copy-markdown" aria-label={`${copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy markdown'}: your version of this block`} onClick={copyMine}>
                {copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy markdown'}
              </button>
              <button type="button" className="mdr-button mdr-button--small" data-testid={TESTID.cardAction} data-action="discard" aria-label="Discard my change to this block" disabled={busy} onClick={() => void resolve('theirs')}>
                Discard my change
              </button>
            </>
          ) : (
            <>
              <button type="button" className="mdr-button mdr-button--small mdr-button--primary" data-testid={TESTID.cardAction} data-action="keep-mine" aria-label="Keep mine: my version of this block" disabled={busy} onClick={() => void resolve('mine')}>
                Keep mine
              </button>
              <button type="button" className="mdr-button mdr-button--small" data-testid={TESTID.cardAction} data-action="take-theirs" aria-label={`Take theirs: ${authorLabel(conflict.theirsBy)}’s version of this block`} disabled={busy} onClick={() => void resolve('theirs')}>
                Take theirs
              </button>
            </>
          )}
        </div>
        {error ? (
          <p className="mdr-composer-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </article>
  )
}
