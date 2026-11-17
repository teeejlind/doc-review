// web/src/theme/quiet-chrome.ts (P3; CONTRACTS §12.2.4, R7.1).
//
// Quiet chrome: once typing has been continuous for QUIET_CHROME_AFTER_MS, --mdr-chrome-opacity on #mdr-app drops
// to QUIET_CHROME_OPACITY; it returns to 1 when the bridge reports typing false (TYPING_IDLE_MS idle or a pointer
// move), when the selection becomes a real range (TJ is about to comment), or on a pointer move P3 sees itself.
// P3's top-bar items and rail header read the token; P2 applies it to its format buttons and to the mode pill in
// Editing mode only. Nobody sets opacity on .mdr-topbar or #mdr-toolbar-host themselves.
//
// A collapsed-caret selection change does not count: every keystroke moves the caret, so "selection change" here
// means getSelectionTarget() turned non-null.
import { CONSTANTS } from '../../../shared/constants'
import type { EditorBridge, Unsubscribe } from '../../../shared/types'

export interface QuietChromeOptions {
  bridge: Pick<EditorBridge, 'onTypingActivity' | 'onSelectionChange' | 'getSelectionTarget'>
  /** Writes the state: the token on #mdr-app and data-quiet on the top bar. */
  apply(quiet: boolean): void
  /** Window for the pointer-move return (null = none). */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
  afterMs?: number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

export interface QuietChrome {
  isQuiet(): boolean
  destroy(): void
}

export function createQuietChrome(o: QuietChromeOptions): QuietChrome {
  const afterMs = o.afterMs ?? CONSTANTS.QUIET_CHROME_AFTER_MS
  const setTimer = o.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const win = o.win === undefined ? (typeof window === 'undefined' ? null : window) : o.win
  let typing = false
  let quiet = false
  let timer: unknown = null
  let destroyed = false

  const set = (q: boolean): void => {
    if (q === quiet || destroyed) return
    quiet = q
    o.apply(q)
  }
  const stop = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
    typing = false
    set(false)
  }

  const offs: Unsubscribe[] = [
    o.bridge.onTypingActivity((t) => {
      if (!t) return stop()
      if (typing) return
      typing = true
      timer = setTimer(() => {
        timer = null
        if (typing) set(true)
      }, afterMs)
    }),
    o.bridge.onSelectionChange(() => {
      if (o.bridge.getSelectionTarget() !== null) stop()
    }),
  ]
  const onPointer = (e: Event): void => {
    const p = e as PointerEvent
    // synthetic or zero-distance moves (a scroll under a still mouse) don't count
    if (quiet && (p.movementX !== 0 || p.movementY !== 0)) stop()
  }
  win?.addEventListener('pointermove', onPointer)
  o.apply(false)

  return {
    isQuiet: () => quiet,
    destroy() {
      if (timer !== null) clearTimer(timer)
      for (const off of offs) off()
      win?.removeEventListener('pointermove', onPointer)
      destroyed = true
    },
  }
}

/** The DOM side of quiet chrome: the token on #mdr-app (§12.2.2) and the top bar's data-quiet (§12.15). */
export function applyQuietChrome(app: HTMLElement | null, topbar: HTMLElement | null, quiet: boolean): void {
  app?.style.setProperty('--mdr-chrome-opacity', quiet ? String(CONSTANTS.QUIET_CHROME_OPACITY) : '1')
  if (topbar) topbar.dataset.quiet = String(quiet)
}
