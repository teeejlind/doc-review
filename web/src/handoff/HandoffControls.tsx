// web/src/handoff/HandoffControls.tsx (P3; CONTRACTS §8.5 badge table, §12.10, §11.5, §11.6, §12.15 send /
// claudeBadge / promptModal / toastAction).
//
// The top bar's Claude badge and Send to Claude button, the clipboard-refused modal, and the Send shortcuts:
// Cmd+Enter inside the editor (registered through the bridge with `when: 'not-in-code'`, so Cmd+Enter in a code block
// stays P2's "exit code block") and Cmd+Shift+Enter anywhere (the seam inside the editor, a window listener outside
// it; an event the editor already handled arrives defaultPrevented and is ignored).
// Pass 4 #29: once the browser has refused a clipboard write in a click (the Claude desktop Browser pane always does),
// the badge's Copy message becomes "Show message" and the modal drops its Copy button for the message selected in a
// read-only textarea ("press Cmd+C" / "Ctrl+C"), so nothing is offered that is known to fail.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { TESTID } from '../../../shared/constants'
import type { ClaudeActivity, DocSession, EditorBridge } from '../../../shared/types'
import { shortcut } from '../platform'
import { badgeCopy, badgeLabel, promptModalText } from './copy'
import type { HandoffController } from './controller'
import { copyShortcut } from './platform'
import './handoff.css'

export function useActivity(session: DocSession): ClaudeActivity {
  const [a, setA] = useState(() => session.getReview().activity)
  useEffect(() => {
    setA(session.getReview().activity)
    return session.subscribe((what) => {
      if (what === 'activity' || what === 'review') setA(session.getReview().activity)
    })
  }, [session])
  return a
}

export interface ClaudeBadgeProps {
  session: DocSession
  controller: HandoffController
  /** "Claude replied": activate the first unread card (the rail's command). */
  onShowUnread?: () => void
}

/** §8.5: a polite live region; the replied row is a button, the waiting-for-paste row offers Copy message. */
export function ClaudeBadge({ session, controller, onShowUnread }: ClaudeBadgeProps) {
  const activity = useActivity(session)
  const c = badgeCopy(activity)
  const refused = useSyncExternalStore(controller.subscribe, controller.getCopyRefused, controller.getCopyRefused)
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [activity.state, activity.delivery])
  const content = c ? (
    <>
      <span className="mdr-claude-badge-dot" data-pulse={c.pulse ? 'true' : 'false'} aria-hidden="true" />
      <span className="mdr-claude-badge-text">{c.text}</span>
      {c.count ? (
        <>
          {' '}
          <span className="mdr-claude-badge-count">{c.count}</span>
          <span className="mdr-visually-hidden"> unread</span>
        </>
      ) : null}
    </>
  ) : null
  return (
    <div className="mdr-claude-badge" data-testid={TESTID.claudeBadge} data-state={activity.state} role="status" aria-live="polite">
      {c && c.count !== null ? (
        <button type="button" className="mdr-claude-badge-main" data-testid={TESTID.badgeAction} data-action="show-unread" aria-label={c.count ? `${c.text} ${c.count} unread` : c.text} title={badgeLabel(c)} onClick={() => onShowUnread?.()}>
          {content}
        </button>
      ) : c ? (
        <span className="mdr-claude-badge-main" title={badgeLabel(c)}>{content}</span>
      ) : null}
      {c?.copyPrompt && refused ? (
        <button
          type="button"
          className="mdr-claude-badge-action"
          data-testid={TESTID.badgeAction}
          data-action="show-prompt"
          aria-label="Show message"
          title="Show the message to copy and paste into your Claude conversation"
          onClick={() => controller.showPrompt()}
        >
          Show message
        </button>
      ) : c?.copyPrompt ? (
        <button
          type="button"
          className="mdr-claude-badge-action"
          data-testid={TESTID.badgeAction}
          data-action="copy-prompt"
          aria-label={copied ? 'Copied' : 'Copy message'}
          title="Copy the message to paste into your Claude conversation"
          onClick={() => {
            // a refused write opens the dialog with the message selected (nothing else would tell the click failed)
            void controller.copyPrompt().then((ok) => (ok ? setCopied(true) : controller.showPrompt()))
          }}
        >
          {copied ? 'Copied' : 'Copy message'}
        </button>
      ) : null}
    </div>
  )
}

export interface SendButtonProps {
  controller: HandoffController
  bridge: EditorBridge | null
}

export function SendButton({ controller, bridge }: SendButtonProps) {
  const pending = useSyncExternalStore(controller.subscribe, () => controller.pending, () => controller.pending)
  // §11.5: Cmd+Enter in the editor (outside code blocks), Cmd+Shift+Enter anywhere
  useEffect(() => {
    const offs = bridge
      ? [
          bridge.registerShortcut({ key: 'Mod-Enter', when: 'not-in-code', run: () => (controller.send(), true) }),
          bridge.registerShortcut({ key: 'Mod-Shift-Enter', run: () => (controller.send(), true) }),
        ]
      : []
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return
      e.preventDefault()
      controller.send()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      for (const off of offs) off()
      window.removeEventListener('keydown', onKey)
    }
  }, [bridge, controller])
  return (
    <button
      type="button"
      className="mdr-button mdr-button--primary mdr-send"
      data-testid={TESTID.send}
      data-busy={pending > 0 ? 'true' : 'false'}
      aria-label="Send to Claude"
      title={`Send to Claude (${shortcut('Mod', 'Enter')} in the document, ${shortcut('Mod', 'Shift', 'Enter')} anywhere)`}
      // keep the editor's selection and focus: the click needs no focus of its own
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => controller.send()}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M2.5 8h9M8 3.5L12.5 8 8 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* one flex item: "Send" and " to Claude" as two items would sit a flex gap apart */}
      <span className="mdr-send-label">
        Send<span className="mdr-topbar-label"> to Claude</span>
      </span>
    </button>
  )
}

/**
 * §12.10 step 5: the clipboard write was refused. While a Copy might still work (the draft was posted first, so the
 * click's own write never ran in the gesture) the prompt is shown with a Copy button (a fresh gesture); once a write
 * inside a click was refused (Pass 4 #29) there is no button, only the message selected for the person's own copy.
 */
export function PromptModal({ controller }: { controller: HandoffController }) {
  const prompt = useSyncExternalStore(controller.subscribe, controller.getModal, controller.getModal)
  const manual = useSyncExternalStore(controller.subscribe, controller.getCopyRefused, controller.getCopyRefused)
  const titleId = useId()
  const textId = useId()
  const copyBtn = useRef<HTMLButtonElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const returnTo = useRef<Element | null>(null)
  const open = prompt !== null
  useEffect(() => {
    if (!open) return undefined
    returnTo.current = document.activeElement
    return () => {
      const el = returnTo.current
      if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true })
    }
  }, [open])
  // focus lands on what the person needs next: the Copy button, or (nothing to click) the message, selected for Cmd+C
  useEffect(() => {
    if (!open) return
    const el = area.current
    if (manual && el) {
      el.focus({ preventScroll: true })
      el.select()
    } else copyBtn.current?.focus({ preventScroll: true })
  }, [open, manual])
  if (!open) return null
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      controller.closeModal()
      return
    }
    if (e.key !== 'Tab') return
    // keep Tab inside the dialog
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('textarea, button'))
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last?.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first?.focus()
    }
  }
  return (
    <div className="mdr-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && controller.closeModal()}>
      <div className="mdr-modal" data-testid={TESTID.promptModal} data-copy={manual ? 'manual' : 'button'} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h2 className="mdr-modal-title" id={titleId}>
          Copy the message for Claude
        </h2>
        {/* a polite live region: the Copy button going away (the browser refused) is announced */}
        <p className="mdr-modal-text" id={textId} role="status">
          {promptModalText(manual, copyShortcut())}
        </p>
        <textarea
          ref={area}
          className="mdr-modal-prompt"
          readOnly
          value={prompt}
          aria-label="Message for Claude"
          aria-describedby={textId}
          rows={Math.min(10, Math.max(4, prompt.split('\n').length))}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="mdr-modal-actions">
          <button type="button" className="mdr-button" aria-label="Close" onClick={() => controller.closeModal()}>
            Close
          </button>
          {manual ? null : (
            <button
              type="button"
              ref={copyBtn}
              className="mdr-button mdr-button--primary"
              data-testid={TESTID.toastAction}
              data-action="copy-prompt"
              aria-label="Copy message"
              onClick={() => void controller.copyFromModal()}
            >
              Copy message
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
