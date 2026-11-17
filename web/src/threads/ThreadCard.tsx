// web/src/threads/ThreadCard.tsx (P3; CONTRACTS §5.2, §6.8, §11.4, §11.6, §12.9, §12.15 card / message / cardEdit /
// cardDelete / cardResolve / cardReopen / acceptAllThread / unread, R2.3, R2.7).
//
// A thread card: author, the anchored quote (head … tail for a long anchor), its messages (TJ's own can be edited
// or deleted), its suggestion records, Accept all in thread, and a reply box. `variant` says where it lives:
//   'rail'   positioned next to its anchor by the scheduler (data-collapsed and the transform are the scheduler's);
//   'static' in the rail header's flow: whole-doc comments, Detached (with the original quote) and unplaced
//            suggestion threads. `fold` shows a static card as a two-line preview until it is active.
// A resolved thread shows a Reopen button; a resolved thread that still has live suggestions stays here, tagged
// "Resolved", with its suggestions actionable (§6.8).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TESTID } from '../../../shared/constants'
import type { CommentId, Thread } from '../../../shared/types'
import { fullWhenLabel, whenLabel } from '../history/diff-view'
import { Composer } from './Composer'
import { useRail } from './context'
import { authorLabel, isLive, isResolved, pendingIdsOf, suggestionsOf } from './model'
import { CommentBody } from './commentBody'
import { opFailure, postFailure, saveFailure } from './errors'
import { quoteDisplay } from './quote'
import { SuggestionItem } from './SuggestionItem'
import { titleOf } from './suggestion-view'
import { useRailCard } from './useRailCard'

export interface ThreadCardProps {
  thread: Thread
  variant: 'rail' | 'static'
  /** Static cards: a two-line preview until active (Detached, unplaced). */
  fold?: boolean
  /** Detached cards quote the last anchor that resolved (§5.4). */
  quoteFrom?: 'anchor' | 'lastAnchor'
}

interface EditState {
  id: CommentId
  body: string
  busy: boolean
  error: string | null
}

/** When a message was written: "Today, 1:39 PM" (a stable label: nothing to refresh), the full date as its tooltip. */
function MessageTime({ at, className }: { at: string; className: string }) {
  const label = whenLabel(at)
  if (!label) return null
  return (
    <time className={className} dateTime={at} title={fullWhenLabel(at)}>
      {label}
    </time>
  )
}

/** Edit opens a box that already has the caret, after the text (a stable callback ref: it runs once, on mount). */
const focusAtEnd = (el: HTMLTextAreaElement | null): void => {
  if (!el) return
  el.focus({ preventScroll: true })
  el.setSelectionRange(el.value.length, el.value.length)
}

export function ThreadCard({ thread, variant, fold = false, quoteFrom = 'anchor' }: ThreadCardProps) {
  const rail = useRail()
  const id = thread.id
  const card = useRailCard(id, variant === 'rail')
  const { session, setPin, readMarkers, registerReply, registerPoster, returnToDoc } = rail
  const replyEl = useRef<HTMLTextAreaElement | null>(null)
  const [reply, setReplyState] = useState(() => rail.getReply(id))
  const setReply = (body: string): void => {
    setReplyState(body)
    rail.putReply(id, body)
  }
  const [replyBusy, setReplyBusy] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [opBusy, setOpBusy] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)

  const suggestions = suggestionsOf(thread, rail.suggestionsById)
  const pending = pendingIdsOf(thread, rail.suggestionsById)
  const hasLive = suggestions.some(isLive)
  const resolved = isResolved(thread)
  const deciding = suggestions.some((s) => rail.inFlight.has(s.id)) || rail.inFlight.has(`thread:${id}`)
  const pinned = card.focusWithin || reply.trim() !== '' || editing !== null || deciding
  const folded = variant === 'static' && fold && !card.active && !pinned

  // Claude (or another tab) changed this thread under a reply box TJ is typing in (a new message, a resolve, a suggestion):
  // the card grows below its pinned top, which can push the box off the bottom of the window with the caret in it. Scroll
  // the least that brings it back; a box that is still on screen doesn't move the page (QA3 rail-ui 6), and neither does
  // one TJ has scrolled away from, above the window (Pass 4 rail-ui, with the pill to take him back).
  const shape = `${thread.messages.length}:${thread.status}:${thread.suggestions.length}`
  const seenShape = useRef(shape)
  useEffect(() => {
    const changed = shape !== seenShape.current
    seenShape.current = shape
    if (changed && variant === 'rail' && card.focusWithin && replyEl.current && document.activeElement === replyEl.current) {
      rail.focusAfterLayout(() => replyEl.current, 'unless-above')
    }
  }, [shape, variant, card.focusWithin, rail])

  // pinExpanded (§11.1): a focused composer, an unsent reply, an edit, a decision in flight
  useEffect(() => {
    if (variant === 'rail') setPin(id, pinned)
  }, [variant, setPin, id, pinned])
  useEffect(() => () => setPin(id, false), [setPin, id])

  // read markers (§12.9)
  useLayoutEffect(() => {
    if (!readMarkers) return undefined
    readMarkers.observe(id, card.el.current, { unread: thread.unread, upTo: thread.lastSeq })
    return () => readMarkers.observe(id, null)
    // registration follows the element; the counts follow below
  }, [readMarkers, id])
  useEffect(() => {
    readMarkers?.update(id, { unread: thread.unread, upTo: thread.lastSeq })
  }, [readMarkers, id, thread.unread, thread.lastSeq])

  const first = thread.messages[0]
  const author = first?.by ?? thread.createdBy
  const anchor = quoteFrom === 'lastAnchor' ? thread.lastAnchor : thread.anchor
  const quote = quoteDisplay(anchor)
  // a suggestion thread with no comment text previews what it does ("Bold: member"), not the quote it sits on
  const lead = suggestions.find(isLive) ?? suggestions[0]
  // A folded card shows the LATEST message and how many replies sit behind it, so a reply from Claude is never
  // hidden behind TJ's first line (QA3 rail-ui 1). A deleted message is skipped; the first one is the fallback.
  const live = thread.messages.filter((m) => !m.deleted)
  const shown = live.length ? live[live.length - 1]! : first
  const replyCount = Math.max(0, live.length - 1)
  // the head keeps naming who started the thread; when the latest message is by someone else, the preview says who ("Claude: …")
  const body = shown ? (shown.deleted ? 'Comment deleted' : shown.body) : null
  const preview = body !== null ? (shown && !shown.deleted && shown.by !== author ? `${authorLabel(shown.by)}: ${body}` : body) : lead ? titleOf(lead, rail.summaries.get(lead.id)) : quote
  const labelId = `mdr-card-label-${id}`

  const run = async (f: () => Promise<unknown>): Promise<void> => {
    setOpBusy(true)
    setOpError(null)
    try {
      await f()
    } catch (e) {
      setOpError(opFailure(e))
    } finally {
      setOpBusy(false)
    }
  }

  /** Resolving drops the card out of sight: say so, and offer to take it back (QA3 rail-ui 16). */
  const resolveWithUndo = async (): Promise<void> => {
    await session.resolve(id)
    rail.notify({
      code: 'THREAD_RESOLVED',
      kind: 'info',
      text: thread.kind === 'comment' ? 'Comment resolved.' : 'Thread resolved.',
      action: { label: 'Undo', run: () => session.reopen(id) },
    })
  }

  /** Post the reply box. `keepCaret`: a click on Reply moved the focus to the button, so the caret goes back to the box. */
  const sendReply = async (o: { keepCaret?: boolean } = {}): Promise<boolean> => {
    const body = reply.trim()
    if (!body) return true
    setReplyBusy(true)
    setReplyError(null)
    try {
      await session.reply(id, body)
      setReply('')
      // A click on Reply leaves the focus on the button, or nowhere once Chrome sees it disabled for the post: the caret goes
      // back into the box, unless TJ has already moved on to something else.
      const box = replyEl.current
      const a = document.activeElement
      if (o.keepCaret && box?.isConnected && a !== box && (a === null || a === document.body || card.el.current?.contains(a))) box.focus({ preventScroll: true })
      return true
    } catch (e) {
      setReplyError(postFailure(e, 'reply'))
      return false
    } finally {
      setReplyBusy(false)
    }
  }
  // Send to Claude posts what is typed first (QA3 rail-ui 5): the rail asks each card to post its own reply box
  const sendRef = useRef(sendReply)
  sendRef.current = sendReply
  useEffect(() => {
    registerPoster(id, () => sendRef.current())
    return () => registerPoster(id, null)
  }, [registerPoster, id])

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    const body = editing.body.trim()
    if (!body) return
    setEditing({ ...editing, busy: true, error: null })
    try {
      await session.editComment(editing.id, body)
      setEditing(null)
    } catch (e) {
      setEditing((cur) => (cur ? { ...cur, busy: false, error: saveFailure(e) } : cur))
    }
  }

  const className = ['mdr-card', variant === 'static' ? 'mdr-card--static' : 'mdr-card--rail', resolved ? 'mdr-card--resolved' : ''].filter(Boolean).join(' ')

  return (
    <article
      ref={card.el}
      className={className}
      data-testid={TESTID.card}
      data-thread={id}
      data-active={String(card.active)}
      data-kind={thread.kind}
      {...(variant === 'static' ? { 'data-collapsed': String(folded) } : {})}
      aria-current={card.active ? 'true' : undefined}
      aria-labelledby={labelId}
      tabIndex={0}
      {...card.handlers}
    >
      <div className="mdr-card-body" ref={card.body}>
        <div className="mdr-card-head">
          <span className="mdr-card-label" id={labelId}>
            <span className="mdr-card-author" data-by={author}>
              {authorLabel(author)}
            </span>
            <span className="mdr-card-preview">{preview}</span>
            {replyCount > 0 ? (
              <span className="mdr-card-replies" data-count={replyCount}>
                {replyCount === 1 ? '1 reply' : `${replyCount} replies`}
              </span>
            ) : null}
            {quote ? <span className="mdr-visually-hidden">, on “{quote}”</span> : null}
          </span>
          {first?.at ? <MessageTime at={first.at} className="mdr-card-time" /> : null}
          {thread.unread > 0 ? (
            <span className="mdr-unread-dot" data-testid={TESTID.unread} data-count={thread.unread} role="img" aria-label={`${thread.unread} unread from Claude`} />
          ) : null}
          {resolved ? <span className="mdr-card-tag">Resolved</span> : null}
          {!rail.readOnly && thread.status === 'open' && !thread.autoResolved && pending.length === 0 ? (
            <button type="button" className="mdr-icon-button" data-testid={TESTID.cardResolve} aria-label="Resolve thread" title="Resolve" disabled={opBusy} onClick={() => void run(resolveWithUndo)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          {!rail.readOnly && thread.status === 'resolved' ? (
            <button type="button" className="mdr-button mdr-button--small mdr-button--quiet" data-testid={TESTID.cardReopen} aria-label="Reopen thread" disabled={opBusy} onClick={() => void run(() => session.reopen(id))}>
              Reopen
            </button>
          ) : null}
        </div>
        {quote ? <blockquote className="mdr-card-quote">{quote}</blockquote> : null}
        {thread.messages.map((m, i) => (
          <div key={m.id} className="mdr-message" data-testid={TESTID.message} data-comment={m.id} data-by={m.by}>
            {i > 0 ? (
              <div className="mdr-message-head">
                <div className="mdr-message-author" data-by={m.by}>
                  {authorLabel(m.by)}
                </div>
                <MessageTime at={m.at} className="mdr-message-time" />
              </div>
            ) : null}
            {editing?.id === m.id ? (
              <Composer
                kind="edit"
                value={editing.body}
                onChange={(body) => setEditing({ ...editing, body })}
                onSubmit={() => void saveEdit()}
                onCancel={() => setEditing(null)}
                label="Edit comment"
                placeholder="Edit comment"
                submitLabel="Save"
                busy={editing.busy}
                error={editing.error}
                textareaRef={focusAtEnd}
              />
            ) : (
              <p className="mdr-message-body">
                {m.deleted ? <em className="mdr-message-deleted">Comment deleted</em> : <CommentBody text={m.body} />}
                {m.editedAt && !m.deleted ? <span className="mdr-message-edited"> (edited)</span> : null}
              </p>
            )}
            {m.by === 'TJ' && !m.deleted && editing?.id !== m.id && !rail.readOnly ? (
              <div className="mdr-message-actions">
                <button type="button" className="mdr-link-button" data-testid={TESTID.cardEdit} aria-label="Edit comment" onClick={() => setEditing({ id: m.id, body: m.body, busy: false, error: null })}>
                  Edit
                </button>
                <button type="button" className="mdr-link-button" data-testid={TESTID.cardDelete} aria-label="Delete comment" disabled={opBusy} onClick={() => void run(() => session.deleteComment(m.id))}>
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        ))}
        {suggestions.length > 0 ? (
          <div className="mdr-suggestions">
            {suggestions.map((s) => (
              <SuggestionItem key={s.id} s={s} summary={rail.summaries.get(s.id)} />
            ))}
          </div>
        ) : null}
        {pending.length > 1 ? (
          <button
            type="button"
            className="mdr-button mdr-button--small mdr-accept-all"
            data-testid={TESTID.acceptAllThread}
            aria-label={`Accept all in thread (${pending.length})`}
            disabled={deciding || rail.readOnly}
            onClick={() => rail.acceptAllInThread(thread)}
          >
            Accept all in thread ({pending.length})
          </button>
        ) : null}
        {resolved && hasLive ? <p className="mdr-card-meta">Resolved with changes still open.</p> : null}
        {opError ? (
          <p className="mdr-composer-error" role="alert">
            {opError}
          </p>
        ) : null}
        {!rail.readOnly ? (
          <Composer
            kind="reply"
            compact
            value={reply}
            onChange={setReply}
            onSubmit={() => void sendReply({ keepCaret: true })}
            onCancel={
              reply
                ? () => {
                    setReply('')
                    returnToDoc()
                  }
                : undefined
            }
            onEscape={() => {
              if (reply) setReply('')
              returnToDoc()
            }}
            label={`Reply to ${authorLabel(author)}`}
            placeholder={resolved ? 'Reply to reopen…' : 'Reply…'}
            submitLabel="Reply"
            busy={replyBusy}
            error={replyError}
            textareaRef={(el) => {
              replyEl.current = el
              registerReply(id, el)
            }}
          />
        ) : null}
      </div>
    </article>
  )
}
