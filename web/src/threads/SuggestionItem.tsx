// web/src/threads/SuggestionItem.tsx (P3; CONTRACTS §6.3, §6.6–§6.8, §12.15 suggestionItem / accept / reject /
// cardAction, §13 rows 41, 72).
//
// One suggestion record inside a thread card: who, what kind, its hunks (deletions struck, insertions underlined,
// never colour alone), and its actions. Pending: Accept / Reject (disabled from the first click until the answer,
// §6.6). Stale: Accept greyed, Dismiss (a reject) and Copy replacement. Unplaced: "Shown as a diff" (SCHEMA,
// anchored at the run) or "Can't place this inline" (BASE_NOT_FOUND / ID_COLLISION), both still decidable through
// the server. Decided records collapse to one line.
import { useState } from 'react'
import { TESTID } from '../../../shared/constants'
import type { Suggestion, SuggestionSummary } from '../../../shared/types'
import { copyText } from './clipboard'
import { authorLabel } from './model'
import { useRail } from './context'
import { hunkViews, isCodeRecord, isTextless, labelOf, rowActions, rowState, stateLine, togetherLabel } from './suggestion-view'

export function SuggestionItem({ s, summary }: { s: Suggestion; summary: SuggestionSummary | undefined }) {
  const rail = useRail()
  const [copied, setCopied] = useState<boolean | null>(null)
  const state = rowState(s, summary)
  const line = stateLine(s, summary)
  const acts = rowActions(s)
  const busy = rail.inFlight.has(s.id)
  const err = rail.errors.get(s.id)
  const title = labelOf(s, summary)
  const together = togetherLabel(s, summary)
  const code = isCodeRecord(s)
  const label = `${title} suggested by ${authorLabel(s.by)}`
  const textless = isTextless(s)

  if (state === 'decided') {
    return (
      <div className="mdr-suggestion-row mdr-suggestion-row--decided" data-testid={TESTID.suggestionItem} data-suggestion={s.id} data-status={s.status}>
        <span className="mdr-suggestion-tag">{line?.tag}</span>
        <span className="mdr-suggestion-kind">{title}</span>
      </div>
    )
  }

  const copyReplacement = (): void => {
    void copyText(s.proposed).then((ok) => {
      setCopied(ok)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <div
      className="mdr-suggestion-row"
      data-testid={TESTID.suggestionItem}
      data-suggestion={s.id}
      data-status={s.status}
      data-state={state}
      data-by={s.by}
      role="group"
      aria-label={label}
    >
      <div className="mdr-suggestion-head">
        <span className="mdr-suggestion-kind" data-by={s.by}>
          {title}
        </span>
        {line ? <span className="mdr-suggestion-tag" data-state={state}>{line.tag}</span> : null}
      </div>
      {textless ? null : (
        <ul className={code || state === 'schema' ? 'mdr-hunks mdr-hunks--mono' : 'mdr-hunks'}>
          {hunkViews(s.hunks).map((h, i) => (
            <li key={i} className="mdr-hunk">
              {h.del ? (
                <del className="mdr-hunk-del" aria-label={`delete: ${h.del}`}>
                  {h.del}
                </del>
              ) : null}
              {h.del && h.ins ? <span className="mdr-hunk-arrow" aria-hidden="true"> → </span> : null}
              {h.ins ? (
                <ins className="mdr-hunk-ins" aria-label={`insert: ${h.ins}`}>
                  {h.ins}
                </ins>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {together ? <p className="mdr-suggestion-note">{together}</p> : null}
      {line?.text ? <p className="mdr-suggestion-note">{line.text}</p> : null}
      <div className="mdr-suggestion-actions">
        {acts.accept ? (
          <button
            type="button"
            className="mdr-button mdr-button--small mdr-button--accept"
            data-testid={TESTID.accept}
            aria-label={`Accept: ${label}`}
            disabled={busy || acts.accept === 'off' || rail.readOnly}
            onClick={() => rail.decide(s.id, 'accept')}
          >
            Accept
          </button>
        ) : null}
        {acts.reject ? (
          <button
            type="button"
            className="mdr-button mdr-button--small"
            data-testid={TESTID.reject}
            aria-label={`Reject: ${label}`}
            disabled={busy || rail.readOnly}
            onClick={() => rail.decide(s.id, 'reject')}
          >
            Reject
          </button>
        ) : null}
        {acts.dismiss ? (
          <button
            type="button"
            className="mdr-button mdr-button--small"
            data-testid={TESTID.cardAction}
            data-action="dismiss"
            aria-label={`Dismiss: ${label}`}
            disabled={busy || rail.readOnly}
            onClick={() => rail.decide(s.id, 'reject')}
          >
            Dismiss
          </button>
        ) : null}
        {acts.copyReplacement ? (
          <button
            type="button"
            className="mdr-button mdr-button--small mdr-button--quiet"
            data-testid={TESTID.cardAction}
            data-action="copy-replacement"
            aria-label={`${copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy replacement'}: ${label}`}
            onClick={copyReplacement}
          >
            {copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy replacement'}
          </button>
        ) : null}
      </div>
      {err ? (
        <p className="mdr-suggestion-error" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  )
}
