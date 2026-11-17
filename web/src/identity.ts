// web/src/identity.ts (generalization pass, 2026-10-16). Who the human is, for display only.
//
// The stored actor id stays 'TJ' (Author, sidecar `by: "TJ"`, every data-by attribute): it is the legacy id for "the
// human". What the page SHOWS is the display name the server injects as <meta name="mdr-user-name"> (node/identity.ts:
// MDR_USER_NAME > config.json > git user.name > macOS full name > OS user name > "You"); without the tag (a fake build,
// a unit test) the page says "You". <meta name="mdr-user-source"> names where it came from; <meta name="mdr-cmd"> is
// the command the copied prompt tells Claude to run.
//
// The tags are written when the page loads, but the server resolves the name per request, so `mdr config set name`
// applies there at once. refreshIdentity() re-reads GET /api/me and swaps the two tags (Pass 4 #13); watchIdentity()
// asks again whenever the person comes back to the page or Claude does something, and subscribeIdentity /
// identityVersion are the useSyncExternalStore pair that re-renders what shows a name.
import type { Actor, DocSession } from '../../shared/types'

export const DEFAULT_USER_NAME = 'You'
export const DEFAULT_AGENT_CMD = 'mdr'

function meta(name: string): string | null {
  if (typeof document === 'undefined') return null
  const v = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim()
  return v ? v : null
}

/** The human's display name (read per call: cheap, and a test can swap the tag). */
export function userName(): string {
  return meta('mdr-user-name') ?? DEFAULT_USER_NAME
}

/** The command a copied prompt names (MDR_CMD on the server, else "mdr"). */
export function agentCmd(): string {
  return meta('mdr-cmd') ?? DEFAULT_AGENT_CMD
}

/**
 * The name the copied prompt gives Claude: the display name, "the user" when it is only the default "You", and
 * undefined without the tags (the prompt builder then keeps its original "TJ").
 */
export function promptWho(): string | undefined {
  const name = meta('mdr-user-name')
  if (name === null) return undefined
  return meta('mdr-user-source') === 'default' ? 'the user' : name
}

/** `who` / `cmd` for buildClipboardPrompt, each only when its tag is there (absent, the builder's original text stands). */
export function promptIdentity(): { who?: string; cmd?: string } {
  const who = promptWho()
  const cmd = meta('mdr-cmd')
  return { ...(who !== undefined ? { who } : {}), ...(cmd !== null ? { cmd } : {}) }
}

/** The display label of an actor id: 'TJ' → the display name; Claude, external and system are labelled by their callers. */
export function personName(a: Actor | string): string {
  return a === 'TJ' ? userName() : a
}

// ---------------------------------------------------------------------------------------------------------------------
// keeping the tags current (Pass 4 #13)

export type IdentityFetch = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>

/** The least time between two asks while the page is busy (a review refresh, a presence change, a focus). */
export const IDENTITY_GAP_MS = 5_000

let version = 0
const listeners = new Set<() => void>()

/** useSyncExternalStore subscribe: called after the tags changed. */
export function subscribeIdentity(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** useSyncExternalStore snapshot: bumps whenever refreshIdentity changed a tag. */
export const identityVersion = (): number => version

function setMeta(name: string, content: string): boolean {
  const el = typeof document === 'undefined' ? null : document.querySelector(`meta[name="${name}"]`)
  if (!el || el.getAttribute('content') === content) return false
  el.setAttribute('content', content)
  return true
}

/**
 * Re-reads the display name from GET /api/me and swaps `mdr-user-name` / `mdr-user-source`. True when either changed
 * (and the subscribers were told). A page without the tags (a fake build, a unit test) or without a token has nothing to
 * refresh, and a server that is offline or restarting is asked again next time.
 */
export async function refreshIdentity(doFetch: IdentityFetch = (input, init) => fetch(input, init)): Promise<boolean> {
  const token = meta('mdr-token')
  if (token === null || meta('mdr-user-name') === null) return false
  let me: { displayName?: unknown; source?: unknown }
  try {
    const res = await doFetch('/api/me', { method: 'GET', headers: { 'X-MDR-Client': 'web', Authorization: `Bearer ${token}` }, credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) return false
    me = (await res.json()) as typeof me
  } catch {
    return false
  }
  if (typeof me.displayName !== 'string' || me.displayName === '' || typeof me.source !== 'string') return false
  const name = setMeta('mdr-user-name', me.displayName)
  const source = setMeta('mdr-user-source', me.source)
  if (!name && !source) return false
  version++
  for (const cb of [...listeners]) cb()
  return true
}

export interface IdentityWatchOptions {
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
  fetch?: IdentityFetch
  gapMs?: number
}

/**
 * Asks the server whether the name changed whenever the person returns to the page (focus, tab shown) and whenever
 * the session hears something new (a review refresh, presence, Claude's activity, a handoff), at most once per `gapMs`
 * (a request that arrives sooner is held until the gap is over). Returns the stop function.
 */
export function watchIdentity(session: Pick<DocSession, 'subscribe'>, o: IdentityWatchOptions = {}): () => void {
  const win = o.win ?? window
  const doc = o.doc ?? document
  const gap = o.gapMs ?? IDENTITY_GAP_MS
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const run = (): void => {
    timer = null
    last = Date.now()
    void refreshIdentity(o.fetch)
  }
  const ask = (): void => {
    if (stopped || timer !== null) return
    const wait = last + gap - Date.now()
    if (wait <= 0) run()
    else timer = setTimeout(run, wait)
  }
  const onShown = (): void => {
    if (doc.visibilityState === 'visible') ask()
  }
  win.addEventListener('focus', ask)
  doc.addEventListener('visibilitychange', onShown)
  const off = session.subscribe((what) => {
    if (what === 'review' || what === 'presence' || what === 'activity' || what === 'handoff') ask()
  })
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    win.removeEventListener('focus', ask)
    doc.removeEventListener('visibilitychange', onShown)
    off()
  }
}
