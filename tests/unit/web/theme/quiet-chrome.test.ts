// tests/unit/web/theme/quiet-chrome.test.ts (P3; CONTRACTS §12.2.4, R7.1).
import { describe, expect, it, vi } from 'vitest'
import { CONSTANTS } from '../../../../shared/constants'
import type { EditorBridge, SelectionTarget } from '../../../../shared/types'
import { applyQuietChrome, createQuietChrome } from '../../../../web/src/theme/quiet-chrome'

function harness() {
  const typing = new Set<(t: boolean) => void>()
  const sel = new Set<() => void>()
  let target: SelectionTarget = null
  const bridge: Pick<EditorBridge, 'onTypingActivity' | 'onSelectionChange' | 'getSelectionTarget'> = {
    onTypingActivity: (cb) => (typing.add(cb), () => typing.delete(cb)),
    onSelectionChange: (cb) => (sel.add(cb), () => sel.delete(cb)),
    getSelectionTarget: () => target,
  }
  const timers: Array<{ cb: () => void; ms: number; live: boolean }> = []
  const applied: boolean[] = []
  const win = new EventTarget() as unknown as Window
  const q = createQuietChrome({
    bridge,
    apply: (b) => applied.push(b),
    win,
    setTimer: (cb, ms) => {
      const t = { cb, ms, live: true }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { live: boolean }).live = false
    },
  })
  return {
    q, applied, timers, win,
    type: (t: boolean) => typing.forEach((cb) => cb(t)),
    select: (t: SelectionTarget) => {
      target = t
      sel.forEach((cb) => cb())
    },
    elapse: () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.cb())),
    move: (dx: number, dy: number) => {
      const e = new Event('pointermove') as Event & { movementX: number; movementY: number }
      Object.assign(e, { movementX: dx, movementY: dy })
      win.dispatchEvent(e)
    },
    subs: () => typing.size + sel.size,
  }
}

const rangeTarget = { kind: 'anchor', quote: 'x' } as unknown as SelectionTarget

describe('quiet chrome (§12.2.4)', () => {
  it('starts loud, fades once typing has been continuous for QUIET_CHROME_AFTER_MS, returns on typing false', () => {
    const h = harness()
    expect(h.applied).toEqual([false])
    h.type(true)
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]!.ms).toBe(CONSTANTS.QUIET_CHROME_AFTER_MS)
    expect(h.q.isQuiet()).toBe(false)
    h.elapse()
    expect(h.q.isQuiet()).toBe(true)
    expect(h.applied.at(-1)).toBe(true)
    h.type(false)
    expect(h.q.isQuiet()).toBe(false)
    expect(h.applied.at(-1)).toBe(false)
  })

  it('repeated typing reports do not restart the timer (continuous typing)', () => {
    const h = harness()
    h.type(true)
    h.type(true)
    h.type(true)
    expect(h.timers).toHaveLength(1)
  })

  it('typing that stops before the threshold never fades', () => {
    const h = harness()
    h.type(true)
    h.type(false)
    h.elapse()
    expect(h.q.isQuiet()).toBe(false)
    expect(h.applied).toEqual([false])
  })

  it('a range selection brings the chrome back; a collapsed caret move (every keystroke) does not', () => {
    const h = harness()
    h.type(true)
    h.elapse()
    h.select(null)
    expect(h.q.isQuiet()).toBe(true)
    h.select(rangeTarget)
    expect(h.q.isQuiet()).toBe(false)
  })

  it('a real pointer move brings it back; a zero-distance move does not', () => {
    const h = harness()
    h.type(true)
    h.elapse()
    h.move(0, 0)
    expect(h.q.isQuiet()).toBe(true)
    h.move(3, 1)
    expect(h.q.isQuiet()).toBe(false)
  })

  it('destroy unsubscribes and cancels the pending fade', () => {
    const h = harness()
    h.type(true)
    h.q.destroy()
    expect(h.subs()).toBe(0)
    expect(h.timers.every((t) => !t.live)).toBe(true)
  })

  it('applyQuietChrome writes the token on #mdr-app and data-quiet on the top bar', () => {
    const app = document.createElement('div')
    const bar = document.createElement('header')
    applyQuietChrome(app, bar, true)
    expect(app.style.getPropertyValue('--mdr-chrome-opacity')).toBe(String(CONSTANTS.QUIET_CHROME_OPACITY))
    expect(bar.dataset.quiet).toBe('true')
    applyQuietChrome(app, bar, false)
    expect(app.style.getPropertyValue('--mdr-chrome-opacity')).toBe('1')
    expect(bar.dataset.quiet).toBe('false')
    expect(bar.style.opacity).toBe('')
  })
})

describe('quiet chrome with real timers', () => {
  it('uses setTimeout by default', () => {
    vi.useFakeTimers()
    try {
      const typing = new Set<(t: boolean) => void>()
      const applied: boolean[] = []
      createQuietChrome({
        bridge: { onTypingActivity: (cb) => (typing.add(cb), () => typing.delete(cb)), onSelectionChange: () => () => undefined, getSelectionTarget: () => null },
        apply: (b) => applied.push(b),
        win: null,
      })
      typing.forEach((cb) => cb(true))
      vi.advanceTimersByTime(CONSTANTS.QUIET_CHROME_AFTER_MS - 1)
      expect(applied).toEqual([false])
      vi.advanceTimersByTime(1)
      expect(applied).toEqual([false, true])
    } finally {
      vi.useRealTimers()
    }
  })
})
