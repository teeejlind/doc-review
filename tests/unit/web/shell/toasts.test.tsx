// tests/unit/web/shell/toasts.test.tsx (P3; CONTRACTS §12.14 "Session notices", §6.5 / D14 editor notices,
// §12.15 toast / toastAction).
//
// The toast stack: one toast per code (a repeat replaces it and restarts its timer), at most three, timers by kind
// and action (paused under the pointer), and the wiring from session notices and editor notices, including
// SUGGEST_MODE_BLOCKED's "Switch to Editing".
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TESTID, TEST_ACTIONS } from '../../../../shared/constants'
import type { EditorBridge, EditorNotice, Mode, SessionNotice } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { createToastStore, defaultTimeout, editorNoticeToast, sessionNoticeToast, TOAST_MAX } from '../../../../web/src/shell/toast-store'
import { Toasts, useNoticeToasts } from '../../../../web/src/shell/Toasts'

afterEach(cleanup)

const toasts = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${TESTID.toast}"]`))

function manualTimers() {
  const timers = new Map<number, { cb: () => void; ms: number }>()
  let n = 0
  return {
    setTimer: (cb: () => void, ms: number): unknown => {
      timers.set(++n, { cb, ms })
      return n
    },
    clearTimer: (h: unknown): void => void timers.delete(h as number),
    fire(ms: number): void {
      for (const [k, t] of [...timers]) if (t.ms === ms) {
        timers.delete(k)
        t.cb()
      }
    },
    get pending() {
      return [...timers.values()].map((t) => t.ms)
    },
  }
}

describe('toast store', () => {
  it('one toast per code: a repeat replaces it in place', () => {
    const s = createToastStore()
    s.show({ code: 'A', kind: 'info', text: 'one' })
    s.show({ code: 'B', kind: 'info', text: 'two' })
    s.show({ code: 'A', kind: 'warn', text: 'three' })
    expect(s.list().map((t) => `${t.code}:${t.text}`)).toEqual(['A:three', 'B:two'])
  })

  it(`keeps at most ${TOAST_MAX}, dropping the oldest`, () => {
    const s = createToastStore()
    for (const c of ['A', 'B', 'C', 'D']) s.show({ code: c, kind: 'info', text: c })
    expect(s.list().map((t) => t.code)).toEqual(['B', 'C', 'D'])
  })

  it('default timeouts: info 5 s, warn/error 8 s, with an action 12 s; null stays', () => {
    expect(defaultTimeout({ kind: 'info' })).toBe(5_000)
    expect(defaultTimeout({ kind: 'warn' })).toBe(8_000)
    expect(defaultTimeout({ kind: 'error' })).toBe(8_000)
    expect(defaultTimeout({ kind: 'info', action: { label: 'x', run: () => undefined } })).toBe(12_000)
    const s = createToastStore()
    s.show({ code: 'X', kind: 'warn', text: 'x', timeoutMs: null })
    expect(s.list()[0]!.timeoutMs).toBeNull()
  })
})

describe('<Toasts>', () => {
  it('renders data-code / data-kind inside one polite live region; auto-dismisses; pauses under the pointer', () => {
    const s = createToastStore()
    const t = manualTimers()
    const { container } = render(<Toasts store={s} setTimer={t.setTimer} clearTimer={t.clearTimer} />)
    const region = container.querySelector('.mdr-toasts') as HTMLElement
    expect(region.getAttribute('aria-live')).toBe('polite')
    act(() => void s.show({ code: 'DRAFT_RECOVERED', kind: 'info', text: 'Recovered unsaved edits' }))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.dataset.code).toBe('DRAFT_RECOVERED')
    expect(toasts()[0]!.dataset.kind).toBe('info')
    expect(t.pending).toEqual([5_000])
    // hovering pauses: the timer is cleared, and leaving restarts it
    act(() => void fireEvent.pointerEnter(toasts()[0]!))
    expect(t.pending).toEqual([])
    act(() => void fireEvent.pointerLeave(toasts()[0]!))
    expect(t.pending).toEqual([5_000])
    act(() => t.fire(5_000))
    expect(toasts()).toHaveLength(0)
  })

  it('the dismiss button removes it; a sticky toast has no timer', () => {
    const s = createToastStore()
    const t = manualTimers()
    render(<Toasts store={s} setTimer={t.setTimer} clearTimer={t.clearTimer} />)
    act(() => void s.show({ code: 'HANDOFF_MISMATCH', kind: 'warn', text: 'gone', timeoutMs: null }))
    expect(t.pending).toEqual([])
    const close = toasts()[0]!.querySelector('button[aria-label="Dismiss notification"]') as HTMLButtonElement
    act(() => close.click())
    expect(toasts()).toHaveLength(0)
  })

  it('an action runs inside its click and the toast closes (unless keepOpen)', () => {
    const s = createToastStore()
    const run = vi.fn()
    render(<Toasts store={s} />)
    act(() => void s.show({ code: 'X', kind: 'info', text: 'x', action: { label: 'Do it', run, id: 'switch-to-editing' } }))
    const btn = document.querySelector(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement
    expect(btn.dataset.action).toBe('switch-to-editing')
    act(() => btn.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(toasts()).toHaveLength(0)
    act(() => void s.show({ code: 'Y', kind: 'info', text: 'y', action: { label: 'Keep', run, keepOpen: true } }))
    act(() => (document.querySelector(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement).click())
    expect(toasts()).toHaveLength(1)
    // an action outside the closed set carries no data-action
    expect((document.querySelector(`[data-testid="${TESTID.toastAction}"]`) as HTMLElement).hasAttribute('data-action')).toBe(false)
  })
})

describe('notices → toasts (§12.14, D14)', () => {
  const editorStub = () => {
    const subs = new Set<(n: EditorNotice) => void>()
    let mode: Mode = 'suggesting'
    const bridge = {
      onNotice: (cb: (n: EditorNotice) => void) => (subs.add(cb), () => subs.delete(cb)),
      setMode: vi.fn((m: Mode) => void (mode = m)),
    } as unknown as EditorBridge
    return { bridge, emit: (n: EditorNotice) => subs.forEach((cb) => cb(n)), get mode() { return mode } }
  }

  function Harness({ store, session, bridge }: { store: ReturnType<typeof createToastStore>; session: ReturnType<typeof createFakeDocSession>; bridge: EditorBridge | null }) {
    useNoticeToasts(store, session, bridge)
    return <Toasts store={store} />
  }

  it('every SessionNotice code shows as a toast with its text and optional action', () => {
    const store = createToastStore()
    const session = createFakeDocSession()
    render(<Harness store={store} session={session} bridge={null} />)
    const notices: SessionNotice[] = [
      { kind: 'info', code: 'DRAFT_RECOVERED', text: 'Recovered unsaved edits' },
      { kind: 'warn', code: 'DECISION_REVERTED', text: 'That change was already decided; your view was put back.' },
      { kind: 'error', code: 'RECREATE_FAILED', text: 'Couldn’t recreate the file.' },
    ]
    for (const n of notices) act(() => session.emit({ notice: n }))
    expect(toasts().map((t) => `${t.dataset.code}:${t.dataset.kind}`)).toEqual(['DRAFT_RECOVERED:info', 'DECISION_REVERTED:warn', 'RECREATE_FAILED:error'])
    const run = vi.fn()
    act(() => session.emit({ notice: { kind: 'info', code: 'POLICY_CHANGED', text: 'Claude may now only suggest.', action: { label: 'Undo', run } } }))
    const t = toasts().find((x) => x.dataset.code === 'POLICY_CHANGED')!
    expect(t.textContent).toContain('Claude may now only suggest.')
    act(() => (t.querySelector(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement).click())
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('CLAUDE_EDITED ("Claude changed 1 block.") offers View history, which the shell wires to the history panel (QA3)', () => {
    const store = createToastStore()
    const session = createFakeDocSession()
    const openHistory = vi.fn()
    function WithHistory() {
      useNoticeToasts(store, session, null, { onViewHistory: openHistory })
      return <Toasts store={store} />
    }
    render(<WithHistory />)
    act(() => session.emit({ notice: { kind: 'info', code: 'CLAUDE_EDITED', text: 'Claude changed 1 block.' } }))
    const t = toasts()[0]!
    expect(t.dataset.code).toBe('CLAUDE_EDITED')
    expect(t.textContent).toContain('Claude changed 1 block.')
    const btn = t.querySelector(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement
    expect(btn.textContent).toBe('View history')
    act(() => btn.click())
    expect(openHistory).toHaveBeenCalledTimes(1)
    expect(toasts()).toHaveLength(0)
  })

  it('CLAUDE_EDITED with no history panel to open is a plain toast', () => {
    const store = createToastStore()
    const session = createFakeDocSession()
    render(<Harness store={store} session={session} bridge={null} />)
    act(() => session.emit({ notice: { kind: 'info', code: 'CLAUDE_EDITED', text: 'Claude changed 2 blocks.' } }))
    expect(toasts()[0]!.querySelector(`[data-testid="${TESTID.toastAction}"]`)).toBeNull()
  })

  it('SUGGEST_MODE_BLOCKED offers "Switch to Editing" (data-action switch-to-editing) → bridge.setMode("editing")', () => {
    const store = createToastStore()
    const session = createFakeDocSession()
    const ed = editorStub()
    render(<Harness store={store} session={session} bridge={ed.bridge} />)
    act(() => ed.emit({ kind: 'warn', code: 'SUGGEST_MODE_BLOCKED', text: 'Code blocks can’t be tracked in Suggesting mode.' }))
    const t = toasts()[0]!
    expect(t.dataset.code).toBe('SUGGEST_MODE_BLOCKED')
    const btn = t.querySelector(`[data-testid="${TESTID.toastAction}"]`) as HTMLButtonElement
    expect(btn.textContent).toBe('Switch to Editing')
    expect(btn.dataset.action).toBe('switch-to-editing')
    expect(TEST_ACTIONS.toastAction).toContain(btn.dataset.action)
    act(() => btn.click())
    expect(ed.bridge.setMode).toHaveBeenCalledWith('editing')
    expect(toasts()).toHaveLength(0)
  })

  it('a guard firing on every keystroke shows one toast', () => {
    const store = createToastStore()
    const ed = editorStub()
    render(<Harness store={store} session={createFakeDocSession()} bridge={ed.bridge} />)
    for (let i = 0; i < 5; i++) act(() => ed.emit({ kind: 'info', code: 'FOREIGN_SUGGESTION', text: 'That’s Claude’s suggestion. Accept, reject, or reply on its card.' }))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.dataset.code).toBe('FOREIGN_SUGGESTION')
  })

  it('P2’s own action for SUGGEST_MODE_BLOCKED is used when it sends one', () => {
    const run = vi.fn()
    const t = editorNoticeToast({ kind: 'warn', code: 'SUGGEST_MODE_BLOCKED', text: 'x', action: { label: 'Switch to Editing', run } }, { setMode: vi.fn() })
    t.action!.run()
    expect(run).toHaveBeenCalledTimes(1)
    expect(t.action!.id).toBe('switch-to-editing')
    expect(sessionNoticeToast({ kind: 'info', code: 'DRAFT_RECOVERED', text: 'Recovered unsaved edits' })).toEqual({ code: 'DRAFT_RECOVERED', kind: 'info', text: 'Recovered unsaved edits' })
  })
})
