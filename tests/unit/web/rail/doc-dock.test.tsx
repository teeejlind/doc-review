// tests/unit/web/rail/doc-dock.test.tsx (Trial, TJ 2026-10-24; CONTRACTS §11.4 "Whole-document comment dock").
//
// The dock's keys and states without a layout engine: Enter posts, Cmd+Enter / Ctrl+Enter / Shift+Enter are newlines,
// Cmd/Ctrl+Shift+Enter is left to Send to Claude, Enter during composition never posts, Esc collapses and keeps the draft, and the hint follows the platform. The page,
// the sidecar and the real caret are tests/e2e/t2-rail-doc-composer.spec.ts.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import { DocDock, dockHint, isMacPlatform } from '../../../../web/src/rail/DocDock'

afterEach(cleanup)

function Harness(p: { onPost?: () => void; onEscape?: () => void; busy?: boolean; error?: string | null; initial?: string }) {
  const [v, setV] = useState(p.initial ?? '')
  return (
    <DocDock
      value={v}
      busy={p.busy ?? false}
      error={p.error ?? null}
      posted={false}
      narrow={false}
      onChange={setV}
      onPost={p.onPost ?? (() => undefined)}
      onEscape={p.onEscape ?? (() => undefined)}
      dockRef={null}
      textareaRef={null}
    />
  )
}

const input = (c: HTMLElement): HTMLTextAreaElement => c.querySelector<HTMLTextAreaElement>(`[data-testid="${TESTID.docComposerInput}"]`)!
const dockOf = (c: HTMLElement): HTMLElement => c.querySelector<HTMLElement>(`[data-testid="${TESTID.docComposer}"]`)!
const post = (c: HTMLElement): HTMLButtonElement | null => c.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.docComposerPost}"]`)
const type = (el: HTMLElement, value: string): void => {
  fireEvent.change(el, { target: { value } })
}
/** fireEvent answers false when the handler called preventDefault. */
const key = (el: HTMLElement, k: string, init: KeyboardEventInit & { keyCode?: number } = {}): boolean => fireEvent.keyDown(el, { key: k, ...init })

describe('the dock’s keys', () => {
  it('Enter posts a non-empty draft and keeps the browser from adding a newline', () => {
    const onPost = vi.fn()
    const { container } = render(<Harness onPost={onPost} />)
    act(() => input(container).focus())
    type(input(container), 'A note')
    expect(key(input(container), 'Enter')).toBe(false)
    expect(onPost).toHaveBeenCalledTimes(1)
  })

  it('Enter on an empty or whitespace-only box posts nothing', () => {
    const onPost = vi.fn()
    const { container } = render(<Harness onPost={onPost} />)
    act(() => input(container).focus())
    key(input(container), 'Enter')
    type(input(container), '  \n ')
    key(input(container), 'Enter')
    expect(onPost).not.toHaveBeenCalled()
    expect(post(container)!.disabled).toBe(true)
  })

  it('Enter while a post is in flight posts nothing more', () => {
    const onPost = vi.fn()
    const { container } = render(<Harness onPost={onPost} busy initial="Already going" />)
    act(() => input(container).focus())
    key(input(container), 'Enter')
    expect(onPost).not.toHaveBeenCalled()
    expect(post(container)!.textContent).toBe('Posting…')
  })

  it('Shift+Enter is left to the textarea (a newline), and posts nothing', () => {
    const onPost = vi.fn()
    const { container } = render(<Harness onPost={onPost} initial="x" />)
    act(() => input(container).focus())
    expect(key(input(container), 'Enter', { shiftKey: true })).toBe(true)
    expect(onPost).not.toHaveBeenCalled()
  })

  for (const [name, init] of [['Cmd+Enter', { metaKey: true }], ['Ctrl+Enter', { ctrlKey: true }]] as const) {
    it(`${name} puts a newline at the caret, not at the end, and posts nothing`, () => {
      const onPost = vi.fn()
      const { container } = render(<Harness onPost={onPost} initial="ab" />)
      const el = input(container)
      act(() => el.focus())
      el.setSelectionRange(1, 1)
      expect(key(el, 'Enter', init)).toBe(false)
      expect(el.value).toBe('a\nb')
      expect(onPost).not.toHaveBeenCalled()
    })
  }

  for (const [name, init] of [['Cmd+Shift+Enter', { metaKey: true, shiftKey: true }], ['Ctrl+Shift+Enter', { ctrlKey: true, shiftKey: true }]] as const) {
    it(`${name} is Send to Claude’s chord: no newline, not prevented, and it reaches the window`, () => {
      const onPost = vi.fn()
      const { container } = render(<Harness onPost={onPost} initial="ab" />)
      const el = input(container)
      act(() => el.focus())
      el.setSelectionRange(1, 1)
      const reached = vi.fn()
      window.addEventListener('keydown', reached)
      try {
        expect(key(el, 'Enter', init)).toBe(true)
      } finally {
        window.removeEventListener('keydown', reached)
      }
      expect(reached).toHaveBeenCalledTimes(1)
      expect(el.value).toBe('ab')
      expect(onPost).not.toHaveBeenCalled()
    })
  }

  it('Cmd+Enter replaces a selection with the newline', () => {
    const { container } = render(<Harness initial="abcd" />)
    const el = input(container)
    act(() => el.focus())
    el.setSelectionRange(1, 3)
    key(el, 'Enter', { metaKey: true })
    expect(el.value).toBe('a\nd')
  })

  it('Enter during IME composition never posts (isComposing, and the keyCode 229 Safari sends)', () => {
    const onPost = vi.fn()
    const { container } = render(<Harness onPost={onPost} initial="にほん" />)
    act(() => input(container).focus())
    // not prevented either: the browser needs it to pick the candidate
    expect(key(input(container), 'Enter', { isComposing: true })).toBe(true)
    expect(key(input(container), 'Enter', { keyCode: 229 })).toBe(true)
    expect(onPost).not.toHaveBeenCalled()
  })

  it('Esc collapses a dock that holds text, keeps the text, blurs and tells the rail', () => {
    const onEscape = vi.fn()
    const { container } = render(<Harness onEscape={onEscape} />)
    const el = input(container)
    act(() => el.focus())
    type(el, 'Not finished')
    expect(dockOf(container).dataset.open).toBe('true')
    expect(post(container)).not.toBeNull()
    expect(key(el, 'Escape')).toBe(false)
    expect(dockOf(container).dataset.open).toBe('false')
    expect(post(container)).toBeNull()
    expect(el.value).toBe('Not finished')
    expect(document.activeElement).not.toBe(el)
    expect(onEscape).toHaveBeenCalledTimes(1)
    // focusing it again opens it, draft and all
    act(() => el.focus())
    expect(dockOf(container).dataset.open).toBe('true')
    expect(el.value).toBe('Not finished')
  })
})

describe('the dock’s states', () => {
  it('is one line (collapsed) until it has focus or text', () => {
    const { container } = render(<Harness />)
    expect(dockOf(container).dataset.open).toBe('false')
    expect(input(container).placeholder).toBe('Comment on the document…')
    act(() => input(container).focus())
    expect(dockOf(container).dataset.open).toBe('true')
    expect(container.querySelector('.mdr-dock-hint')).not.toBeNull()
    act(() => input(container).blur())
    expect(dockOf(container).dataset.open).toBe('false')
    // text keeps it open without focus
    cleanup()
    const held = render(<Harness initial="held" />)
    expect(dockOf(held.container).dataset.open).toBe('true')
  })

  it('shows a post error inline and keeps the text', () => {
    const { container } = render(<Harness initial="kept" error="Couldn’t post that comment." />)
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Couldn’t post that comment.')
    expect(input(container).value).toBe('kept')
  })

  it('the Post button posts a non-empty draft', () => {
    const onPost = vi.fn()
    const { container } = render(<Harness onPost={onPost} initial="go" />)
    act(() => post(container)!.click())
    expect(onPost).toHaveBeenCalledTimes(1)
  })
})

describe('the hint follows the platform', () => {
  const platform = (p: string, ua = ''): void => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => p })
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua })
  }
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).platform
    delete (navigator as unknown as Record<string, unknown>).userAgent
  })

  it('macOS: ⌘↩', () => {
    platform('MacIntel')
    expect(isMacPlatform()).toBe(true)
    const { container } = render(<Harness initial="x" />)
    expect(container.querySelector('.mdr-dock-hint')!.textContent).toBe('Enter to post · ⌘↩ new line')
  })

  it('Windows: Ctrl+Enter (read from navigator.platform, else the user agent)', () => {
    platform('Win32')
    expect(isMacPlatform()).toBe(false)
    const a = render(<Harness initial="x" />)
    expect(a.container.querySelector('.mdr-dock-hint')!.textContent).toBe('Enter to post · Ctrl+Enter new line')
    cleanup()
    platform('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(isMacPlatform()).toBe(false)
    expect(dockHint(isMacPlatform())).toBe('Enter to post · Ctrl+Enter new line')
  })
})
