// web/src/session/env.ts (P2). The browser facilities the session uses, behind one seam so unit tests can swap them.
// Every default guards for absence (jsdom, private windows, previews): no IndexedDB → memory drafts, no
// BroadcastChannel → a lone leader tab, no requestIdleCallback → a short timeout, no clipboard → copy refused.
import type { ChannelLike } from './tabs'
import { idbDraftStore, type DraftStore } from './drafts'

export interface ClipboardLike {
  writeText(s: string): Promise<void>
}

export interface SessionEnv {
  now(): number
  /** requestIdleCallback with a timeout, or a short setTimeout. */
  idle(fn: () => void): void
  clipboard(): ClipboardLike | null
  channel(name: string): ChannelLike | null
  drafts: DraftStore
  /** For pagehide / beforeunload / blur listeners; null outside a browser window. */
  window: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
  /** For visibilitychange; null outside a browser document. */
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null
  /** location.reload() (the contract-mismatch Reload). */
  reloadPage(): void
  /** localStorage-backed per-file preferences (the mode); null when storage throws. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
}

function safeStorage(): SessionEnv['storage'] {
  try {
    const s = globalThis.localStorage
    if (!s) return null
    return {
      getItem: (k) => {
        try {
          return s.getItem(k)
        } catch {
          return null
        }
      },
      setItem: (k, v) => {
        try {
          s.setItem(k, v)
        } catch {
          // quota or blocked storage: the preference is a convenience
        }
      },
    }
  } catch {
    return null
  }
}

export function defaultEnv(): SessionEnv {
  const g = globalThis as {
    requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number
    BroadcastChannel?: new (name: string) => ChannelLike
    navigator?: { clipboard?: ClipboardLike }
    window?: Window
    document?: Document
    location?: Location
  }
  return {
    now: () => Date.now(),
    idle: (fn) => {
      if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(fn, { timeout: 200 })
      else setTimeout(fn, 1)
    },
    clipboard: () => g.navigator?.clipboard ?? null,
    channel: (name) => {
      if (typeof g.BroadcastChannel !== 'function') return null
      try {
        return new g.BroadcastChannel(name)
      } catch {
        return null
      }
    },
    drafts: idbDraftStore(),
    window: typeof g.window !== 'undefined' && typeof g.window.addEventListener === 'function' ? g.window : null,
    document: typeof g.document !== 'undefined' && typeof g.document.addEventListener === 'function' ? g.document : null,
    reloadPage: () => g.location?.reload(),
    storage: safeStorage(),
  }
}
