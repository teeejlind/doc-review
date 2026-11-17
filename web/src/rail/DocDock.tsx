// web/src/rail/DocDock.tsx (Trial, TJ 2026-10-24; CONTRACTS §11.4 "Whole-document comment dock", §12.15 docComposer*).
//
// The whole-document comment box, docked to the bottom of the viewport in the rail's column (full width below the
// breakpoint), so a general comment can be written while the part of the document it is about stays in view. Chat
// keys, for this box only: Enter posts; Cmd+Enter (Ctrl+Enter off macOS) and Shift+Enter put a newline in. Cmd+Shift+Enter
// (Ctrl+Shift+Enter) is Send to Claude, as everywhere, and is left alone here. Reply boxes and the selection's
// new-comment box keep Cmd+Enter to post (threads/Composer.tsx).
//
// Collapsed it is one line; focus, or text in it, opens it into an autosizing box (it stops growing at 40% of the
// window and scrolls inside) with a hint row and Post. Esc collapses it and keeps the draft. The draft itself lives
// in RailView (so it outlives this component remounting at the breakpoint); the position, the reserved room under the
// last card and the focus hand-back also live there. Nothing in here focuses or scrolls on its own.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { CONSTANTS, TESTID } from '../../../shared/constants'

export interface DocDockProps {
  value: string
  busy: boolean
  error: string | null
  /** A comment just went in: "Posted" shows for a moment (RailView times it). */
  posted: boolean
  /** Below the breakpoint: full width above the sheet's bar. */
  narrow: boolean
  onChange(v: string): void
  onPost(): void
  /** Esc, after the dock has collapsed itself: where the focus goes (back to the document). */
  onEscape(): void
  dockRef: Ref<HTMLDivElement>
  textareaRef: Ref<HTMLTextAreaElement>
}

const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

/** Read when rendered, not at import, so a platform switch (tests, a remote session) is honoured. */
export const isMacPlatform = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** The hint row's words; the newline chord is the one this platform's text boxes don't give for free. */
export const dockHint = (mac: boolean): string => `Enter to post · ${mac ? '⌘↩' : 'Ctrl+Enter'} new line`

/** Enter during IME composition picks a candidate; it never posts (keyCode 229 is Safari's composing Enter). */
const composing = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => e.nativeEvent.isComposing || e.keyCode === 229

/** A newline at the caret, through the browser's own edit when it has one so Cmd+Z still undoes it. */
function insertNewline(el: HTMLTextAreaElement, set: (v: string) => void): void {
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, '\n')) return
  const { selectionStart: from, selectionEnd: to, value } = el
  set(`${value.slice(0, from)}\n${value.slice(to)}`)
  // the controlled value is written on the next render; the caret goes after the new line once it has
  requestAnimationFrame(() => el.setSelectionRange(from + 1, from + 1))
}

export function DocDock(p: DocDockProps) {
  const [focused, setFocused] = useState(false)
  // Esc collapses a dock that holds text; the next focus opens it again
  const [escaped, setEscaped] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const hasText = p.value !== ''
  const open = focused || (hasText && !escaped)
  const canPost = !p.busy && p.value.trim() !== '' && p.value.length <= CONSTANTS.MAX_COMMENT_CHARS

  // Fallback autosize where field-sizing is unsupported (jsdom, older engines); the CSS caps the height at 40vh.
  useLayoutEffect(() => {
    const el = area.current
    if (!el || FIELD_SIZING) return
    el.style.height = 'auto'
    if (open && el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`
  }, [p.value, open])

  const setRef = (el: HTMLTextAreaElement | null): void => {
    area.current = el
    const r = p.textareaRef
    if (typeof r === 'function') r(el)
    else if (r) (r as { current: HTMLTextAreaElement | null }).current = el
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setEscaped(true)
      e.currentTarget.blur()
      p.onEscape()
      return
    }
    if (e.key !== 'Enter' || composing(e)) return
    if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl+Shift+Enter is Send to Claude, anywhere (HandoffControls' window listener): left alone, it bubbles there
      if (e.shiftKey) return
      // browsers give Cmd/Ctrl+Enter no newline of their own
      e.preventDefault()
      e.stopPropagation()
      insertNewline(e.currentTarget, p.onChange)
    } else if (!e.shiftKey && !e.altKey) {
      // Shift+Enter keeps the textarea's own newline
      e.preventDefault()
      e.stopPropagation()
      if (canPost) p.onPost()
    }
  }

  return (
    <div
      ref={(el) => {
        wrap.current = el
        const r = p.dockRef
        if (typeof r === 'function') r(el)
        else if (r) (r as { current: HTMLDivElement | null }).current = el
      }}
      className="mdr-dock"
      data-testid={TESTID.docComposer}
      data-open={String(open)}
      data-posted={String(p.posted)}
      data-narrow={String(p.narrow)}
      onFocus={() => {
        setFocused(true)
        setEscaped(false)
      }}
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <div className="mdr-dock-card">
        <div className="mdr-dock-row">
          <textarea
            ref={setRef}
            className="mdr-dock-input"
            data-testid={TESTID.docComposerInput}
            aria-label="Comment on the whole document"
            placeholder="Comment on the document…"
            rows={1}
            value={p.value}
            maxLength={CONSTANTS.MAX_COMMENT_CHARS}
            onChange={(e) => p.onChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* one line, so the dock doesn't change height when it appears or goes */}
          <span className="mdr-dock-posted" role="status" aria-live="polite">
            {p.posted ? 'Posted' : ''}
          </span>
        </div>
        {open ? (
          <div className="mdr-dock-foot">
            <span className="mdr-dock-hint">{dockHint(isMacPlatform())}</span>
            <button
              type="button"
              className="mdr-button mdr-button--primary"
              data-testid={TESTID.docComposerPost}
              aria-label="Post comment"
              disabled={!canPost}
              onClick={() => canPost && p.onPost()}
            >
              {p.busy ? 'Posting…' : 'Post'}
            </button>
          </div>
        ) : null}
        {p.error ? (
          <p className="mdr-composer-error" role="alert">
            {p.error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
