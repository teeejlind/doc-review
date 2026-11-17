// web/src/threads/DraftCard.tsx (P3; CONTRACTS §11.4, R2.1).
//
// The new-comment card: opened by the floating Comment button, the top bar's Comment button or Cmd+Opt+M on a
// selection (any length; a long anchor shows head … tail, §5.2). It sits level with the selection's first line
// (the rail passes that y to the scheduler, since no thread or highlight exists yet), is always expanded, and posts
// with session.createThread(anchor, body).
import type { Ref } from 'react'
import { TESTID } from '../../../shared/constants'
import type { BlockAnchor, TextAnchor } from '../../../shared/types'
import { userName } from '../identity'
import { Composer } from './Composer'
import { quoteDisplay } from './quote'
import { useRailCard } from './useRailCard'

/** The draft's id in the rail (a ThreadId-shaped key that no real thread can have). */
export const DRAFT_ID = 't_draft' as const

export interface NewDraft {
  anchor: TextAnchor | BlockAnchor
  /** Content y of the selection's first line. */
  anchorY: number
  /** ptext offset (or block start) for the layout tiebreak. */
  order: number
  body: string
  busy: boolean
  error: string | null
}

export interface DraftCardProps {
  draft: NewDraft
  onChange(body: string): void
  onSubmit(): void
  onCancel(): void
  textareaRef?: Ref<HTMLTextAreaElement>
}

export function DraftCard({ draft, onChange, onSubmit, onCancel, textareaRef }: DraftCardProps) {
  const card = useRailCard(DRAFT_ID, true)
  const quote = quoteDisplay(draft.anchor)
  return (
    <article
      ref={card.el}
      className="mdr-card mdr-card--rail mdr-card--draft"
      data-testid={TESTID.card}
      data-draft="true"
      data-active={String(card.active)}
      aria-current={card.active ? 'true' : undefined}
      aria-label="New comment"
      tabIndex={-1}
      {...card.handlers}
    >
      <div className="mdr-card-body" ref={card.body}>
        <div className="mdr-card-head">
          <span className="mdr-card-label">
            <span className="mdr-card-author" data-by="TJ">
              {userName()}
            </span>
            <span className="mdr-card-preview">New comment</span>
          </span>
        </div>
        {quote ? <blockquote className="mdr-card-quote">{quote}</blockquote> : null}
        <Composer
          kind="new"
          value={draft.body}
          onChange={onChange}
          onSubmit={onSubmit}
          onCancel={onCancel}
          label={quote ? `Comment on “${quote.slice(0, 60)}”` : 'New comment'}
          placeholder="Comment…"
          submitLabel="Comment"
          busy={draft.busy}
          error={draft.error}
          {...(textareaRef ? { textareaRef } : {})}
        />
      </div>
    </article>
  )
}
