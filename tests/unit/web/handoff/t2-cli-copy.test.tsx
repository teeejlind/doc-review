// tests/unit/web/handoff/t2-cli-copy.test.tsx (fix pass T2 cli; QA_FINDINGS Pass 4 #29; CONTRACTS §12.10 step 5).
//
// The Claude desktop Browser pane refuses every clipboard write (navigator.clipboard.writeText rejects, execCommand
// returns false), so Send with nobody listening always ended in a dialog whose Copy button failed too. Once a write inside
// a click has been refused the page remembers it: the dialog shows the message selected in a read-only textarea with
// "press Cmd+C" (Ctrl+C off macOS) and no Copy button; the toasts' and the badge's Copy prompt become "Show message".
// A later write that works puts the Copy buttons back. A waiter that is connected never touches the clipboard at all.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TESTID, TEST_ACTIONS } from '../../../../shared/constants'
import type { ClaudeActivity, Presence } from '../../../../shared/types'
import { createFakeDocSession, type FakeDocSession, type FakeDocSessionOptions } from '../../../fakes/FakeDocSession'
import { COPIED_TEXT, createHandoffController, type HandoffController } from '../../../../web/src/handoff/controller'
import { copyShortcut, isApplePlatform } from '../../../../web/src/handoff/platform'
import { promptModalText } from '../../../../web/src/handoff/copy'
import { ClaudeBadge, PromptModal, SendButton } from '../../../../web/src/handoff/HandoffControls'
import { createToastStore, type ToastStore } from '../../../../web/src/shell/toast-store'
import { Toasts } from '../../../../web/src/shell/Toasts'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  delete (navigator as unknown as Record<string, unknown>).platform
})

const FILE = 'notes/plan.md'

/** A clipboard whose writes the test can refuse and allow again. */
function clip(refuse: boolean) {
  const writes: string[] = []
  const state = { refuse }
  return {
    writes,
    state,
    clipboard: {
      writeText: vi.fn((s: string) => {
        if (state.refuse) return Promise.reject(new DOMException('denied', 'NotAllowedError'))
        writes.push(s)
        return Promise.resolve()
      }),
    },
  }
}

function setup(o: { presence?: Presence; refuse?: boolean; handoffResult?: FakeDocSessionOptions['handoffResult'] } = {}) {
  const c = clip(o.refuse ?? true)
  const session: FakeDocSession = createFakeDocSession({
    file: FILE,
    root: '/work',
    review: { presence: o.presence ?? { waiter: 'none' } },
    clipboard: c.clipboard,
    ...(o.handoffResult ? { handoffResult: o.handoffResult } : {}),
  })
  const toasts: ToastStore = createToastStore()
  const controller: HandoffController = createHandoffController({ session, toasts, clipboard: c.clipboard, storage: null })
  render(
    <>
      <ClaudeBadge session={session} controller={controller} />
      <SendButton controller={controller} bridge={null} />
      <Toasts store={toasts} />
      <PromptModal controller={controller} />
    </>,
  )
  return { session, toasts, controller, c }
}

const q = (sel: string): HTMLElement | null => document.querySelector(sel)
const modalEl = (): HTMLElement | null => q(`[data-testid="${TESTID.promptModal}"]`)
const sendBtn = (): HTMLButtonElement => q(`[data-testid="${TESTID.send}"]`) as HTMLButtonElement
const badge = (): HTMLElement => q(`[data-testid="${TESTID.claudeBadge}"]`)!
const badgeBtn = (): HTMLButtonElement | null => badge().querySelector(`[data-testid="${TESTID.badgeAction}"]`)
const activity = (state: ClaudeActivity['state'], o: Partial<ClaudeActivity> = {}): ClaudeActivity => ({ file: FILE, state, since: '2026-10-24T12:00:00.000Z', unreadFromClaude: 0, ...o })
const stagePlatform = (platform: string): void => {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
}

describe('the copy shortcut, named through one helper', () => {
  it('Cmd+C on macOS and iOS, Ctrl+C everywhere else (Windows, Linux), by navigator.platform then userAgent', () => {
    expect(copyShortcut({ platform: 'MacIntel', userAgent: '' })).toBe('Cmd+C')
    expect(copyShortcut({ platform: 'iPhone', userAgent: '' })).toBe('Cmd+C')
    expect(copyShortcut({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('Ctrl+C')
    expect(copyShortcut({ platform: 'Linux x86_64', userAgent: '' })).toBe('Ctrl+C')
    // no platform string: the user agent decides
    expect(copyShortcut({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe('Cmd+C')
    expect(copyShortcut({ platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('Ctrl+C')
    expect(isApplePlatform({ platform: 'Win32', userAgent: '' })).toBe(false)
  })

  it('read per call from the page’s own navigator, so a staged platform shows up in the dialog text', () => {
    stagePlatform('Win32')
    expect(copyShortcut()).toBe('Ctrl+C')
    stagePlatform('MacIntel')
    expect(copyShortcut()).toBe('Cmd+C')
    expect(promptModalText(true, copyShortcut())).toContain('press Cmd+C,')
  })
})

describe('Send with nobody listening in a browser that refuses every write (the desktop Browser pane)', () => {
  it('Mac: the dialog opens with the message selected and "press Cmd+C"; there is no Copy button to fail', async () => {
    stagePlatform('MacIntel')
    const s = setup()
    act(() => sendBtn().click())
    await waitFor(() => expect(modalEl()).not.toBeNull())
    const modal = modalEl()!
    expect(modal.dataset.copy).toBe('manual')
    expect(modal.querySelector('.mdr-modal-text')!.textContent).toContain('press Cmd+C,')
    expect(modal.querySelector('.mdr-modal-text')!.textContent).not.toContain('Ctrl')
    const area = modal.querySelector('textarea') as HTMLTextAreaElement
    expect(area.readOnly).toBe(true)
    expect(area.value).toContain(FILE)
    expect(document.activeElement).toBe(area)
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe(area.value)
    expect(modal.querySelector('[data-action="copy-prompt"]')).toBeNull()
    expect(modal.getAttribute('aria-modal')).toBe('true')
    // the instruction is what the textarea is described by, so focusing it reads the shortcut
    expect(area.getAttribute('aria-describedby')).toBe(modal.querySelector('.mdr-modal-text')!.id)
    // one write was tried (the click's own); the dialog never tries another
    expect(s.c.clipboard.writeText).toHaveBeenCalledTimes(1)
  })

  it('Windows: the same dialog says Ctrl+C', async () => {
    stagePlatform('Win32')
    setup()
    act(() => sendBtn().click())
    await waitFor(() => expect(modalEl()).not.toBeNull())
    expect(modalEl()!.querySelector('.mdr-modal-text')!.textContent).toBe(
      'Claude isn’t listening, and this page can’t copy to your clipboard. The message below is selected: press Ctrl+C, then paste it into your Claude conversation.',
    )
  })

  it('Escape and Close dismiss it, and the focus goes back to where it was', async () => {
    setup()
    sendBtn().focus()
    act(() => sendBtn().click())
    await waitFor(() => expect(modalEl()).not.toBeNull())
    act(() => void modalEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(modalEl()).toBeNull()
    expect(document.activeElement).toBe(sendBtn())
  })

  it('Tab stays inside the dialog: the textarea and Close are the whole loop', async () => {
    setup()
    act(() => sendBtn().click())
    await waitFor(() => expect(modalEl()).not.toBeNull())
    const close = modalEl()!.querySelector('button') as HTMLButtonElement
    close.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => void close.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(modalEl()!.querySelector('textarea'))
  })

  it('the paste row of the badge then says "Show message" (it would fail), and opens the same dialog without trying a write', async () => {
    const s = setup()
    act(() => sendBtn().click())
    await waitFor(() => expect(modalEl()).not.toBeNull())
    act(() => s.controller.closeModal())
    act(() => s.session.emit({ activity: activity('waiting-pickup', { delivery: 'clipboard' }) }))
    expect(badge().textContent).toContain('Waiting for you to paste it into Claude')
    const btn = badgeBtn()!
    expect(btn.dataset.action).toBe('show-prompt')
    expect(TEST_ACTIONS.badgeAction).toContain('show-prompt')
    expect(btn.textContent).toBe('Show message')
    const writes = s.c.clipboard.writeText.mock.calls.length
    act(() => btn.click())
    expect(modalEl()?.dataset.copy).toBe('manual')
    expect(s.c.clipboard.writeText.mock.calls.length).toBe(writes)
  })

  it('a later write that works (the browser allowed it this time) puts the Copy buttons back', async () => {
    const s = setup()
    act(() => sendBtn().click())
    await waitFor(() => expect(s.controller.getCopyRefused()).toBe(true))
    act(() => s.controller.closeModal())
    s.c.state.refuse = false
    act(() => sendBtn().click())
    await waitFor(() => expect(s.toasts.list().some((t) => t.code === 'HANDOFF_COPIED')).toBe(true))
    expect(s.controller.getCopyRefused()).toBe(false)
    expect(modalEl()).toBeNull()
    act(() => s.session.emit({ activity: activity('waiting-pickup', { delivery: 'clipboard' }) }))
    expect(badgeBtn()!.dataset.action).toBe('copy-prompt')
  })
})

describe('the Copy buttons that are not known to fail yet', () => {
  it('the badge’s Copy prompt is refused: the dialog opens at once in manual mode (a failed click is never silent)', async () => {
    const s = setup({ refuse: true, presence: { waiter: 'connected' } })
    // a waiter was connected, so Send copied nothing and nothing is known yet
    expect(s.controller.getCopyRefused()).toBe(false)
    act(() => s.session.emit({ activity: activity('waiting-pickup', { delivery: 'clipboard' }) }))
    const btn = badgeBtn()!
    expect(btn.dataset.action).toBe('copy-prompt')
    await act(async () => btn.click())
    await waitFor(() => expect(modalEl()).not.toBeNull())
    expect(modalEl()!.dataset.copy).toBe('manual')
    expect(s.controller.getCopyRefused()).toBe(true)
    expect(badgeBtn()!.dataset.action).toBe('show-prompt')
  })

  it('a toast’s Copy prompt that is refused turns into the dialog; the next such toast says "Show message"', async () => {
    const s = setup({ refuse: true, presence: { waiter: 'connected' }, handoffResult: { delivery: 'clipboard', prompt: 'SERVER PROMPT (round 4)' } })
    act(() => sendBtn().click())
    await waitFor(() => expect(s.toasts.list().some((t) => t.code === 'HANDOFF_MISMATCH')).toBe(true))
    const btn = q(`[data-code="HANDOFF_MISMATCH"] [data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement
    expect(btn.dataset.action).toBe('copy-prompt')
    await act(async () => btn.click())
    await waitFor(() => expect(modalEl()).not.toBeNull())
    expect(modalEl()!.dataset.copy).toBe('manual')
    expect((modalEl()!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('SERVER PROMPT (round 4)')
    expect(q('[data-code="HANDOFF_MISMATCH"]')).toBeNull()
    act(() => s.controller.closeModal())
    // Claude didn't pick it up: the toast no longer offers a Copy that is known to fail
    act(() => s.session.emit({ handoff: { file: FILE, seq: 9, state: 'undelivered', delivery: 'clipboard' } }))
    await waitFor(() => expect(q('[data-code="HANDOFF_UNDELIVERED"]')).not.toBeNull())
    const show = q(`[data-code="HANDOFF_UNDELIVERED"] [data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement
    expect(show.dataset.action).toBe('show-prompt')
    expect(show.textContent).toBe('Show message')
    const writes = s.c.clipboard.writeText.mock.calls.length
    act(() => show.click())
    expect(modalEl()?.dataset.copy).toBe('manual')
    expect((modalEl()!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('SERVER PROMPT (round 4)')
    expect(s.c.clipboard.writeText.mock.calls.length).toBe(writes)
    expect(q('[data-code="HANDOFF_UNDELIVERED"]')).toBeNull()
  })

  it('a toast’s Copy prompt that works still toasts the copy and leaves the page unmarked', async () => {
    const s = setup({ refuse: false, presence: { waiter: 'connected' }, handoffResult: { delivery: 'clipboard', prompt: 'SERVER PROMPT' } })
    act(() => sendBtn().click())
    await waitFor(() => expect(s.toasts.list().some((t) => t.code === 'HANDOFF_MISMATCH')).toBe(true))
    await act(async () => (q(`[data-code="HANDOFF_MISMATCH"] [data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement).click())
    await waitFor(() => expect(q('[data-code="HANDOFF_MISMATCH"]')!.textContent).toContain(COPIED_TEXT))
    expect(s.c.writes).toEqual(['SERVER PROMPT'])
    expect(s.controller.getCopyRefused()).toBe(false)
  })
})

describe('with Claude’s waiter connected', () => {
  it('Send hands over without a clipboard write, a dialog or a Copy button; nothing is marked refused', async () => {
    const s = setup({ presence: { waiter: 'connected' } })
    act(() => sendBtn().click())
    await waitFor(() => expect(s.toasts.list().some((t) => t.code === 'HANDOFF_SENT')).toBe(true))
    expect(s.c.clipboard.writeText).not.toHaveBeenCalled()
    expect(modalEl()).toBeNull()
    expect(s.controller.getCopyRefused()).toBe(false)
    expect(q(`[data-testid="${TESTID.toastAction}"]`)).toBeNull()
  })

  it('the same Send after the page learned the clipboard is blocked still just sends (no dialog, no write)', async () => {
    const s = setup({ presence: { waiter: 'none' } })
    act(() => sendBtn().click())
    await waitFor(() => expect(s.controller.getCopyRefused()).toBe(true))
    act(() => s.controller.closeModal())
    act(() => s.session.emit({ presence: { waiter: 'connected' } }))
    const before = s.c.clipboard.writeText.mock.calls.length
    act(() => sendBtn().click())
    await waitFor(() => expect(s.toasts.list().some((t) => t.code === 'HANDOFF_SENT')).toBe(true))
    expect(s.c.clipboard.writeText.mock.calls.length).toBe(before)
    expect(modalEl()).toBeNull()
  })
})
