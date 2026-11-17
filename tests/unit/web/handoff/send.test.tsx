// tests/unit/web/handoff/send.test.tsx (P3; CONTRACTS §8.5, §11.5, §12.10, §12.15 send / claudeBadge / toast /
// toastAction / promptModal).
//
// Send to Claude end to end against the scripted FakeDocSession: handoff() is called synchronously inside the click
// (the clipboard write happens before any await), the toast follows what actually happened, the mismatch and
// undelivered toasts copy HandoffResult.prompt in their own click, a refused clipboard opens the modal, an
// unreachable server says so without claiming a copy, and the badge follows the §8.5 table as a live region.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TESTID, TEST_ACTIONS } from '../../../../shared/constants'
import type { ClaudeActivity, EditorBridge, Presence, ShortcutBinding, Thread } from '../../../../shared/types'
import { createFakeDocSession, type FakeDocSession, type FakeDocSessionOptions } from '../../../fakes/FakeDocSession'
import { thread } from '../shell/helpers'
import { COPIED_TEXT, createHandoffController, isUnreachable, type HandoffController } from '../../../../web/src/handoff/controller'
import { HANDOFF_TEXT } from '../../../../web/src/handoff/copy'
import { ClaudeBadge, PromptModal, SendButton } from '../../../../web/src/handoff/HandoffControls'
import { createToastStore, type ToastStore } from '../../../../web/src/shell/toast-store'
import { Toasts } from '../../../../web/src/shell/Toasts'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const FILE = 'notes/plan.md'

function clip(o: { refuse?: boolean } = {}) {
  const writes: string[] = []
  return {
    writes,
    clipboard: {
      writeText: vi.fn((s: string) => {
        if (o.refuse) return Promise.reject(new DOMException('denied', 'NotAllowedError'))
        writes.push(s)
        return Promise.resolve()
      }),
    },
  }
}

function setup(o: { presence?: Presence; refuse?: boolean; handoffResult?: FakeDocSessionOptions['handoffResult']; threads?: Thread[]; storage?: Pick<Storage, 'getItem' | 'setItem'> | null } = {}) {
  const c = clip({ refuse: o.refuse ?? false })
  const session: FakeDocSession = createFakeDocSession({
    file: FILE,
    root: '/work',
    review: { presence: o.presence ?? { waiter: 'connected' }, ...(o.threads ? { threads: o.threads } : {}) },
    clipboard: c.clipboard,
    ...(o.handoffResult ? { handoffResult: o.handoffResult } : {}),
  })
  const toasts: ToastStore = createToastStore()
  const controller: HandoffController = createHandoffController({ session, toasts, clipboard: c.clipboard, ...(o.storage !== undefined ? { storage: o.storage } : {}) })
  const shortcuts: ShortcutBinding[] = []
  const bridge = { registerShortcut: (b: ShortcutBinding) => (shortcuts.push(b), () => shortcuts.splice(shortcuts.indexOf(b), 1)) } as unknown as EditorBridge
  const ui = render(
    <>
      <ClaudeBadge session={session} controller={controller} onShowUnread={() => undefined} />
      <SendButton controller={controller} bridge={bridge} />
      <Toasts store={toasts} />
      <PromptModal controller={controller} />
    </>,
  )
  return { session, toasts, controller, c, shortcuts, ui }
}

const q = (sel: string): HTMLElement | null => document.querySelector(sel)
const toastEl = (): HTMLElement | null => q(`[data-testid="${TESTID.toast}"]`)
const sendBtn = (): HTMLButtonElement => q(`[data-testid="${TESTID.send}"]`) as HTMLButtonElement

describe('Send to Claude: the button (QA3 theme-polish)', () => {
  it('"Send to Claude" is one label next to the icon, so a flex gap never opens up inside it', () => {
    setup()
    const items = Array.from(sendBtn().childNodes).filter((n) => n.nodeType === 1 || (n.textContent ?? '').trim() !== '')
    expect(items.map((n) => n.nodeName.toLowerCase())).toEqual(['svg', 'span'])
    expect(sendBtn().textContent).toBe('Send to Claude')
  })
})

describe('Send to Claude: the toast follows what actually happened (§12.10)', () => {
  it('waiter connected: handoff() runs synchronously in the click, nothing copied, "Sent to Claude."', async () => {
    const s = setup({ presence: { waiter: 'connected' } })
    act(() => sendBtn().click())
    // called inside the click, before any await
    expect(s.session.calls.filter((x) => x.method === 'handoff')).toHaveLength(1)
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_SENT'))
    expect(toastEl()!.textContent).toContain(HANDOFF_TEXT.sent)
    expect(s.c.writes).toEqual([])
    expect(q(`[data-testid="${TESTID.toastAction}"]`)).toBeNull()
  })

  it('QA3: nothing new since Claude\'s last ack: "Nothing new to send yet…", no badge, no modal, even when the prompt was just copied', async () => {
    const s = setup({ presence: { waiter: 'none' }, refuse: true, handoffResult: { nothingNew: true } })
    act(() => sendBtn().click())
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_NOTHING_NEW'))
    expect(toastEl()!.textContent).toContain(HANDOFF_TEXT.nothingNew)
    expect(q(`[data-testid="${TESTID.promptModal}"]`)).toBeNull()
    expect(q(`[data-testid="${TESTID.toastAction}"]`)).toBeNull()
    expect(q(`[data-testid="${TESTID.claudeBadge}"]`)?.getAttribute('data-state')).toBe('idle')
  })

  it('grace / turn: latched, nothing copied', async () => {
    for (const waiter of ['grace', 'turn'] as const) {
      const s = setup({ presence: { waiter } })
      act(() => sendBtn().click())
      await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_LATCHED'))
      expect(toastEl()!.textContent).toContain(HANDOFF_TEXT.latched)
      expect(s.c.writes).toEqual([])
      cleanup()
    }
  })

  it('no waiter: the session copies inside the gesture, the toast says the prompt was copied', async () => {
    const s = setup({ presence: { waiter: 'none' } })
    act(() => sendBtn().click())
    // the write happened synchronously inside the click
    expect(s.c.clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(s.c.writes[0]).toContain(FILE)
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_COPIED'))
    expect(toastEl()!.textContent).toContain(HANDOFF_TEXT.copied)
    expect(q(`[data-testid="${TESTID.promptModal}"]`)).toBeNull()
  })

  it('no waiter and the clipboard refused in the click: the modal shows the server prompt selected, with no Copy button that would fail (Pass 4 #29)', async () => {
    const s = setup({ presence: { waiter: 'none' }, refuse: true })
    act(() => sendBtn().click())
    await waitFor(() => expect(q(`[data-testid="${TESTID.promptModal}"]`)).not.toBeNull())
    const modal = q(`[data-testid="${TESTID.promptModal}"]`)!
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(modal.getAttribute('aria-modal')).toBe('true')
    const area = modal.querySelector('textarea') as HTMLTextAreaElement
    expect(area.value).toContain(FILE)
    expect(toastEl()).toBeNull()
    // QA3: plain words for a colleague, no product code name or plumbing; the shortcut is named (jsdom is not a Mac: Ctrl)
    expect(modal.querySelector('.mdr-modal-text')!.textContent).toBe(
      'Claude isn’t listening, and this page can’t copy to your clipboard. The message below is selected: press Ctrl+C, then paste it into your Claude conversation.',
    )
    // (the prompt in the textarea is for Claude to read, and does name `mdr`)
    expect(`${modal.querySelector('.mdr-modal-title')!.textContent} ${modal.querySelector('.mdr-modal-text')!.textContent}`).not.toMatch(/waiter|\bmdr\b|session|the chat/i)
    // the message is selected and has the focus, so the person's own Ctrl/Cmd+C copies it
    expect(document.activeElement).toBe(area)
    expect([area.selectionStart, area.selectionEnd]).toEqual([0, area.value.length])
    expect(area.readOnly).toBe(true)
    expect(modal.querySelector(`[data-testid="${TESTID.toastAction}"]`)).toBeNull()
    expect(s.controller.getCopyRefused()).toBe(true)
    // Close is all that is left to click
    expect(Array.from(modal.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Close'])
    act(() => (modal.querySelector('button') as HTMLButtonElement).click())
    expect(q(`[data-testid="${TESTID.promptModal}"]`)).toBeNull()
  })

  it('the modal’s Copy button stays while a Copy might still work: the draft was posted first, so the click’s own write never ran', async () => {
    const c = clip()
    const session = createFakeDocSession({ file: FILE, root: '/work', review: { presence: { waiter: 'none' } }, clipboard: c.clipboard })
    const toasts = createToastStore()
    const controller = createHandoffController({ session, toasts, clipboard: c.clipboard, unsent: { has: () => true, post: async () => true } })
    render(
      <>
        <PromptModal controller={controller} />
        <Toasts store={toasts} />
      </>,
    )
    // the write after the post is refused (the gesture was spent), a later one in a fresh click works
    c.clipboard.writeText.mockImplementationOnce(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    act(() => controller.send())
    await waitFor(() => expect(q(`[data-testid="${TESTID.promptModal}"]`)).not.toBeNull())
    expect(controller.getCopyRefused()).toBe(false)
    const modal = q(`[data-testid="${TESTID.promptModal}"]`)!
    expect(modal.querySelector('.mdr-modal-text')!.textContent).toBe(
      'Claude isn’t listening, and your browser didn’t allow copying. Copy this message, then paste it into your Claude conversation.',
    )
    const copy = modal.querySelector(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement
    expect(copy.dataset.action).toBe('copy-prompt')
    expect(TEST_ACTIONS.toastAction).toContain(copy.dataset.action)
    expect(document.activeElement).toBe(copy)
    await act(async () => copy.click())
    await waitFor(() => expect(q(`[data-testid="${TESTID.promptModal}"]`)).toBeNull())
    expect(c.writes.length).toBe(1)
    expect(controller.getCopyRefused()).toBe(false)
    // a copy that worked says so
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_COPIED'))
    expect(toastEl()!.textContent).toContain(COPIED_TEXT)
    controller.destroy()
  })

  it('the mismatch case: the waiter died, nothing copied; Copy message copies HandoffResult.prompt in its own click', async () => {
    const s = setup({ presence: { waiter: 'connected' }, handoffResult: { delivery: 'clipboard', prompt: 'SERVER PROMPT (round 4)' } })
    act(() => sendBtn().click())
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_MISMATCH'))
    expect(toastEl()!.textContent).toContain(HANDOFF_TEXT.mismatch)
    expect(toastEl()!.textContent!.toLowerCase()).not.toContain('copied')
    expect(s.c.writes).toEqual([])
    const btn = q(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement
    expect(btn.dataset.action).toBe('copy-prompt')
    act(() => btn.click())
    // the write ran inside the click
    expect(s.c.writes).toEqual(['SERVER PROMPT (round 4)'])
    await waitFor(() => expect(toastEl()!.textContent).toContain(COPIED_TEXT))
  })

  it('SSE handoff undelivered → "Claude didn’t pick this up" with Copy message (the latest prompt); consumed clears it', async () => {
    const s = setup({ presence: { waiter: 'connected' }, handoffResult: { delivery: 'waiter', prompt: 'LATEST PROMPT' } })
    act(() => sendBtn().click())
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_SENT'))
    act(() => s.session.emit({ handoff: { file: FILE, seq: 7, state: 'undelivered', delivery: 'waiter' } }))
    const undelivered = (): HTMLElement | null => q(`[data-testid="${TESTID.toast}"][data-code="HANDOFF_UNDELIVERED"]`)
    await waitFor(() => expect(undelivered()).not.toBeNull())
    expect(undelivered()!.textContent).toContain(HANDOFF_TEXT.undelivered)
    // the same seq again does not raise a second toast
    act(() => s.session.emit({ handoff: { file: FILE, seq: 7, state: 'undelivered', delivery: 'waiter' } }))
    expect(document.querySelectorAll(`[data-code="HANDOFF_UNDELIVERED"]`)).toHaveLength(1)
    act(() => (undelivered()!.querySelector(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement).click())
    expect(s.c.writes).toEqual(['LATEST PROMPT'])
    act(() => s.session.emit({ handoff: { file: FILE, seq: 7, state: 'consumed', delivery: 'waiter' } }))
    await waitFor(() => expect(undelivered()).toBeNull())
  })

  it('server unreachable after an in-gesture copy: "…Prompt copied." with no button', async () => {
    const s = setup({ presence: { waiter: 'none' } })
    s.session.handoff = () => {
      void s.c.clipboard.writeText('round-less prompt')
      return Promise.reject(Object.assign(new TypeError('Failed to fetch'), { copied: true }))
    }
    act(() => sendBtn().click())
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_OFFLINE'))
    expect(toastEl()!.textContent).toContain(HANDOFF_TEXT.offlineCopied)
    expect(q(`[data-testid="${TESTID.toastAction}"]`)).toBeNull()
  })

  it('server unreachable with nothing copied: no "copied"; Copy message builds the round-less prompt in its click', async () => {
    const s = setup({ presence: { waiter: 'connected' } })
    s.session.handoff = () => Promise.reject(new TypeError('Failed to fetch'))
    act(() => sendBtn().click())
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_OFFLINE'))
    expect(toastEl()!.querySelector('.mdr-toast-text')!.textContent).toBe(HANDOFF_TEXT.offline)
    const btn = q(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement
    act(() => btn.click())
    expect(s.session.calls.map((x) => x.method)).toContain('copyPrompt')
    expect(s.c.writes).toHaveLength(1)
    expect(s.c.writes[0]).toContain(FILE)
  })

  it('a 4xx refusal says what the server said', async () => {
    const s = setup()
    s.session.handoff = () => Promise.reject(Object.assign(new Error('This file is read-only right now.'), { code: 'READ_ONLY', status: 422 }))
    act(() => sendBtn().click())
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_FAILED'))
    expect(toastEl()!.textContent).toContain('Couldn’t send to Claude: This file is read-only right now.')
  })

  it('isUnreachable: network errors and 5xx yes, a coded 4xx no', () => {
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(true)
    expect(isUnreachable({ code: 'INTERNAL', status: 500 })).toBe(true)
    expect(isUnreachable({ code: 'SERVER_UNREACHABLE' })).toBe(true)
    expect(isUnreachable(Object.assign(new Error('x'), { code: 'READ_ONLY', status: 422 }))).toBe(false)
  })
})

describe('Send shortcuts (§11.5)', () => {
  it('registers Cmd+Enter (not in code) and Cmd+Shift+Enter through the seam; both send', async () => {
    const s = setup()
    const keys = s.shortcuts.map((b) => `${b.key}:${b.when ?? 'always'}`)
    expect(keys).toEqual(['Mod-Enter:not-in-code', 'Mod-Shift-Enter:always'])
    act(() => void s.shortcuts[0]!.run())
    expect(s.session.calls.filter((x) => x.method === 'handoff')).toHaveLength(1)
  })

  it('Cmd+Shift+Enter outside the editor sends; an event the editor handled (defaultPrevented) does not', () => {
    const s = setup()
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })))
    expect(s.session.calls.filter((x) => x.method === 'handoff')).toHaveLength(1)
    const handled = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
    handled.preventDefault()
    act(() => void window.dispatchEvent(handled))
    expect(s.session.calls.filter((x) => x.method === 'handoff')).toHaveLength(1)
    // plain Cmd+Enter outside the editor is not Send
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })))
    expect(s.session.calls.filter((x) => x.method === 'handoff')).toHaveLength(1)
  })
})

describe('Claude badge (§8.5): a polite live region following ClaudeActivity', () => {
  const activity = (state: ClaudeActivity['state'], o: Partial<ClaudeActivity> = {}): ClaudeActivity => ({ file: FILE, state, since: '2026-10-15T12:00:00.000Z', unreadFromClaude: 0, ...o })
  const badge = (): HTMLElement => q(`[data-testid="${TESTID.claudeBadge}"]`)!

  it('idle: present and empty; each state shows its copy; data-state mirrors the state', () => {
    const s = setup()
    expect(badge().getAttribute('role')).toBe('status')
    expect(badge().getAttribute('aria-live')).toBe('polite')
    expect(badge().dataset.state).toBe('idle')
    expect(badge().textContent).toBe('')
    act(() => s.session.emit({ activity: activity('waiting-pickup', { delivery: 'waiter' }) }))
    expect(badge().dataset.state).toBe('waiting-pickup')
    expect(badge().textContent).toBe('Sent to Claude')
    act(() => s.session.emit({ activity: activity('waiting-pickup', { delivery: 'latched' }) }))
    expect(badge().textContent).toBe('Queued for Claude')
    act(() => s.session.emit({ activity: activity('working') }))
    expect(badge().textContent).toBe('Claude is working')
    expect(badge().querySelector('[data-pulse="true"]')).not.toBeNull()
    act(() => s.session.emit({ activity: activity('idle') }))
    expect(badge().textContent).toBe('')
  })

  it('waiting for the paste: Copy message copies inside its click', async () => {
    const s = setup({ presence: { waiter: 'none' } })
    act(() => s.session.emit({ activity: activity('waiting-pickup', { delivery: 'clipboard' }) }))
    expect(badge().textContent).toContain('Waiting for you to paste it into Claude')
    const btn = badge().querySelector('button') as HTMLButtonElement
    expect(btn.textContent).toBe('Copy message')
    act(() => btn.click())
    expect(s.c.writes).toHaveLength(1)
    await waitFor(() => expect(btn.textContent).toBe('Copied'))
  })

  it('replied: the count, and a click asks for the first unread card', () => {
    const onShowUnread = vi.fn()
    const session = createFakeDocSession({ file: FILE })
    const controller = createHandoffController({ session, toasts: createToastStore(), clipboard: null })
    render(<ClaudeBadge session={session} controller={controller} onShowUnread={onShowUnread} />)
    act(() => session.emit({ activity: activity('replied', { unreadFromClaude: 2 }) }))
    const btn = badge().querySelector('button') as HTMLButtonElement
    // the visible text is part of the accessible name (WCAG 2.5.3); the title says what a click does
    expect(btn.textContent).toBe('Claude replied 2 unread')
    expect(btn.getAttribute('title')).toBe('Claude replied, 2 unread. Show the first')
    act(() => btn.click())
    expect(onShowUnread).toHaveBeenCalledTimes(1)
  })
})

describe('QA3: a comment says Claude can\'t see it until Send (the one-time hint)', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } => {
    const data = new Map<string, string>()
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  }
  const withMessage = (s: ReturnType<typeof setup>, t: Thread): void => {
    const r = s.session.getReview()
    act(() => s.session.emit({ review: { ...r, threads: [...r.threads, t] } }))
  }
  const hint = (): HTMLElement | null => q(`[data-testid="${TESTID.toast}"][data-code="HANDOFF_HINT"]`)

  it('the first comment you post: "Saved. Claude sees this when you click Send to Claude."', async () => {
    const s = setup({ storage: memory() })
    expect(hint()).toBeNull()
    withMessage(s, thread(1, { block: 1, by: 'TJ' }))
    await waitFor(() => expect(hint()).not.toBeNull())
    expect(hint()!.textContent).toContain('Saved. Claude sees this when you click Send to Claude.')
    expect(HANDOFF_TEXT.hint).toBe('Saved. Claude sees this when you click Send to Claude.')
  })

  it('once: the next comment says nothing, and neither does a reload (the flag is remembered)', async () => {
    const storage = memory()
    const s = setup({ storage })
    withMessage(s, thread(1, { block: 1, by: 'TJ' }))
    await waitFor(() => expect(hint()).not.toBeNull())
    act(() => s.toasts.dismissCode('HANDOFF_HINT'))
    withMessage(s, thread(2, { block: 2, by: 'TJ' }))
    expect(hint()).toBeNull()
    cleanup()
    const again = setup({ storage })
    withMessage(again, thread(3, { block: 3, by: 'TJ' }))
    expect(hint()).toBeNull()
  })

  it('not for what is already there on load, for Claude\'s comments, or after you have used Send', async () => {
    const s = setup({ storage: memory(), threads: [thread(1, { block: 1, by: 'TJ' })] })
    withMessage(s, thread(2, { block: 2, by: 'Claude' }))
    expect(hint()).toBeNull()
    cleanup()
    const sent = setup({ storage: memory(), presence: { waiter: 'connected' } })
    act(() => sendBtn().click())
    await waitFor(() => expect(toastEl()?.dataset.code).toBe('HANDOFF_SENT'))
    withMessage(sent, thread(1, { block: 1, by: 'TJ' }))
    expect(hint()).toBeNull()
  })

  it('no storage (private window, blocked site data): still shows, once per page', async () => {
    const s = setup({ storage: null })
    withMessage(s, thread(1, { block: 1, by: 'TJ' }))
    await waitFor(() => expect(hint()).not.toBeNull())
    act(() => s.toasts.dismissCode('HANDOFF_HINT'))
    withMessage(s, thread(2, { block: 2, by: 'TJ' }))
    expect(hint()).toBeNull()
  })
})
