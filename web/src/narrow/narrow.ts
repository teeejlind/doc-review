// web/src/narrow/narrow.ts (P3; CONTRACTS §11.4 "Narrow mode"). Below NARROW_BREAKPOINT_PX (640 px) of window width
// there is no rail and no layoutRail: comments live in a bottom sheet. The CSS hides the rail at the same width
// (max-width: 639.98px), so the two agree to the pixel.
import { useEffect, useState } from 'react'
import { CONSTANTS } from '../../../shared/constants'
import type { Unsubscribe } from '../../../shared/types'

export const NARROW_QUERY = `(max-width: ${CONSTANTS.NARROW_BREAKPOINT_PX - 0.02}px)`

/** true below the breakpoint: 639 px is narrow, 640 px is not. */
export const isNarrowWidth = (width: number): boolean => width < CONSTANTS.NARROW_BREAKPOINT_PX

type WinLike = Pick<Window, 'innerWidth' | 'addEventListener' | 'removeEventListener'> & { matchMedia?: Window['matchMedia'] }

export interface NarrowWatch {
  get(): boolean
  subscribe(cb: (narrow: boolean) => void): Unsubscribe
  destroy(): void
}

/** Follows the window width through matchMedia when there is one, else window resize (jsdom). */
export function createNarrowWatch(win: WinLike | null = typeof window === 'undefined' ? null : window): NarrowWatch {
  const subs = new Set<(n: boolean) => void>()
  const mql = win && typeof win.matchMedia === 'function' ? win.matchMedia(NARROW_QUERY) : null
  const read = (): boolean => (mql ? mql.matches : win ? isNarrowWidth(win.innerWidth) : false)
  let cur = read()
  const check = (): void => {
    const n = read()
    if (n === cur) return
    cur = n
    for (const cb of [...subs]) cb(n)
  }
  if (mql) mql.addEventListener('change', check)
  win?.addEventListener('resize', check)
  return {
    get: () => cur,
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    destroy() {
      mql?.removeEventListener('change', check)
      win?.removeEventListener('resize', check)
      subs.clear()
    },
  }
}

export function useNarrow(win?: WinLike | null): boolean {
  const w = win === undefined ? (typeof window === 'undefined' ? null : window) : win
  const [narrow, setNarrow] = useState(() => {
    const probe = createNarrowWatch(w)
    const n = probe.get()
    probe.destroy()
    return n
  })
  useEffect(() => {
    const watch = createNarrowWatch(w)
    setNarrow(watch.get())
    watch.subscribe(setNarrow)
    return () => watch.destroy()
  }, [w])
  return narrow
}
