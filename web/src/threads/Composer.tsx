// web/src/threads/Composer.tsx (P3; CONTRACTS §11.4, §11.5, §12.15 cardReply / cardSubmit).
//
// The one text box every card uses: a new comment, a reply, a whole-doc comment, an edit. A textarea that grows
// with its text (CSS field-sizing, with a JS fallback), Cmd+Enter to post, Esc to cancel. The compact form (a card's
// reply box) is one line until it has focus or text, and only then shows its buttons.
//
// Nothing here focuses or scrolls on its own: the rail focuses composers with focus({ preventScroll: true }) after
// the layout frame that placed their card (§11.4).
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { CONSTANTS, TESTID } from '../../../shared/constants'

export interface ComposerProps {
  value: string
  onChange(v: string): void
  onSubmit(): void
  onCancel?: (() => void) | undefined
  /** Esc, when it should do something other than onCancel (a reply box: back to the document, text cleared or not). */
  onEscape?: (() => void) | undefined
  /** Accessible name of the textarea. */
  label: string
  placeholder: string
  submitLabel: string
  busy?: boolean | undefined
  error?: string | null | undefined
  /** One line, buttons hidden, until focused or non-empty (a card's reply box). */
  compact?: boolean
  disabled?: boolean
  textareaRef?: Ref<HTMLTextAreaElement>
  /** Extra data attribute on the wrapper (which composer this is). */
  kind?: 'new' | 'reply' | 'doc' | 'edit'
}

const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

/** Cmd+Enter (Ctrl+Enter off macOS) posts. */
export const isSubmitKey = (e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean =>
  e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey

export function Composer(p: ComposerProps) {
  const [focused, setFocused] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const open = !p.compact || focused || p.value !== ''
  const canSubmit = !p.busy && !p.disabled && p.value.trim() !== '' && p.value.length <= CONSTANTS.MAX_COMMENT_CHARS

  // Fallback autosize where field-sizing is unsupported (jsdom, older engines).
  useLayoutEffect(() => {
    const el = area.current
    if (!el || FIELD_SIZING) return
    el.style.height = 'auto'
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`
  }, [p.value, open])

  const setRef = (el: HTMLTextAreaElement | null): void => {
    area.current = el
    const r = p.textareaRef
    if (typeof r === 'function') r(el)
    else if (r) (r as { current: HTMLTextAreaElement | null }).current = el
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isSubmitKey(e)) {
      e.preventDefault()
      e.stopPropagation()
      if (canSubmit) p.onSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (p.onEscape) p.onEscape()
      else if (p.onCancel) p.onCancel()
      else e.currentTarget.blur()
    }
  }

  return (
    <div
      ref={wrap}
      className="mdr-composer"
      data-open={String(open)}
      data-kind={p.kind}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <textarea
        ref={setRef}
        className="mdr-composer-input"
        data-testid={TESTID.cardReply}
        aria-label={p.label}
        placeholder={p.placeholder}
        rows={1}
        value={p.value}
        disabled={p.disabled}
        maxLength={CONSTANTS.MAX_COMMENT_CHARS}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <div className="mdr-composer-actions">
          {p.onCancel ? (
            <button type="button" className="mdr-button mdr-button--quiet" aria-label="Cancel" onClick={p.onCancel}>
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="mdr-button mdr-button--primary"
            data-testid={TESTID.cardSubmit}
            aria-label={p.submitLabel}
            disabled={!canSubmit}
            onClick={() => canSubmit && p.onSubmit()}
          >
            {p.busy ? 'Posting…' : p.submitLabel}
          </button>
        </div>
      ) : null}
      {p.error ? (
        <p className="mdr-composer-error" role="alert">
          {p.error}
        </p>
      ) : null}
    </div>
  )
}
