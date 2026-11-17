// server/handoff/presence.ts (P4). Waiter presence per doc (CONTRACTS §8.5 "Presence", D48).
//
//   connected  a waiter stream is open
//   grace      the stream closed without delivering < graceMs ago, or POST /api/agent/arm arrived < graceMs ago with
//              no stream open (a later arm extends graceUntil); graceUntil passes with no connect → none
//   turn       the stream closed right after delivering a handoff: Claude's turn is running. Bounded (D48): it ends on
//              a connect (→ connected), an arm (→ grace), a disarm (→ none), or turnIdleMs with no agent request of
//              any kind for the doc (→ none)
//   none       anything else; only `none` makes the browser copy a prompt
//
// Every transition calls onChange(file, presence) once; the module broadcasts it as SSE `presence`.
import type { IsoTime, Presence, WaiterId } from '../../shared/types'

type State =
  | { kind: 'connected'; waiterId: WaiterId; since: number }
  | { kind: 'grace'; until: number; since: number; waiterId?: WaiterId }
  | { kind: 'turn'; since: number; waiterId?: WaiterId }
  | { kind: 'none'; since: number }

interface FileState {
  state: State
  lastAgentAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const iso = (ms: number): IsoTime => new Date(ms).toISOString()

export interface PresenceTracker {
  get(file: string): Presence
  /** When the doc's presence last became `none` (ms), or null when it isn't `none`. */
  noneSince(file: string): number | null
  connected(file: string, waiterId: WaiterId): void
  /** The live stream closed without delivering (re-arm gap, dropped socket, restart). */
  dropped(file: string, waiterId: WaiterId): void
  /** A handoff was delivered on the live stream: the loop is exiting and Claude's turn starts. */
  delivered(file: string, waiterId: WaiterId): void
  armed(file: string): void
  disarmed(file: string): void
  /** Any /api/agent/* request for the doc (content or control): keeps a `turn` alive. */
  agentRequest(file: string): void
  close(): void
}

export function createPresenceTracker(o: {
  graceMs: number
  turnIdleMs: number
  onChange: (file: string, p: Presence) => void
  startedAt?: number
  /**
   * Restart grace (§8.5 "grace: ... a restart"): until this time (ms), a doc with no presence history starts in
   * `grace` instead of `none`, because a loop attached to the previous server process is reconnecting (its `wait`
   * retries within 0.5–10 s). The module sets it when a predecessor's marker survived (restart, signal or crash).
   */
  initialGraceUntil?: number
}): PresenceTracker {
  const startedAt = o.startedAt ?? Date.now()
  const initialGraceUntil = o.initialGraceUntil ?? 0
  const files = new Map<string, FileState>()

  const st = (file: string): FileState => {
    let s = files.get(file)
    if (!s) {
      const graced = Date.now() < initialGraceUntil
      s = { state: graced ? { kind: 'grace', until: initialGraceUntil, since: startedAt } : { kind: 'none', since: startedAt }, lastAgentAt: 0, timer: null }
      files.set(file, s)
      if (graced) schedule(file, s)
    }
    return s
  }

  const view = (s: State): Presence => {
    switch (s.kind) {
      case 'connected':
        return { waiter: 'connected', waiterId: s.waiterId, since: iso(s.since) }
      case 'grace':
        return { waiter: 'grace', ...(s.waiterId ? { waiterId: s.waiterId } : {}), since: iso(s.since), graceUntil: iso(s.until) }
      case 'turn':
        return { waiter: 'turn', ...(s.waiterId ? { waiterId: s.waiterId } : {}), since: iso(s.since) }
      case 'none':
        return { waiter: 'none' }
    }
  }

  const clearTimer = (s: FileState): void => {
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
  }

  const schedule = (file: string, s: FileState): void => {
    clearTimer(s)
    let at: number | null = null
    if (s.state.kind === 'grace') at = s.state.until
    else if (s.state.kind === 'turn') at = Math.max(s.lastAgentAt, s.state.since) + o.turnIdleMs
    if (at === null) return
    const t = setTimeout(() => {
      s.timer = null
      const now = Date.now()
      if (s.state.kind === 'grace' && now >= s.state.until) set(file, { kind: 'none', since: now })
      else if (s.state.kind === 'turn' && now >= Math.max(s.lastAgentAt, s.state.since) + o.turnIdleMs) set(file, { kind: 'none', since: now })
      else schedule(file, s)
    }, Math.max(0, at - Date.now()))
    ;(t as { unref?: () => void }).unref?.()
    s.timer = t
  }

  const set = (file: string, next: State): void => {
    const s = st(file)
    const before = JSON.stringify(view(s.state))
    s.state = next
    schedule(file, s)
    const p = view(next)
    if (JSON.stringify(p) !== before) o.onChange(file, p)
  }

  return {
    get: (file) => view(st(file).state),
    noneSince: (file) => {
      const s = st(file).state
      return s.kind === 'none' ? s.since : null
    },
    connected(file, waiterId) {
      const s = st(file)
      if (s.state.kind === 'connected' && s.state.waiterId === waiterId) return
      set(file, { kind: 'connected', waiterId, since: Date.now() })
    },
    dropped(file, waiterId) {
      const now = Date.now()
      set(file, { kind: 'grace', until: now + o.graceMs, since: now, waiterId })
    },
    delivered(file, waiterId) {
      const s = st(file)
      const now = Date.now()
      s.lastAgentAt = now
      set(file, { kind: 'turn', since: now, waiterId })
    },
    armed(file) {
      const s = st(file)
      if (s.state.kind === 'connected') return
      const now = Date.now()
      const since = s.state.kind === 'grace' ? s.state.since : now
      set(file, { kind: 'grace', until: now + o.graceMs, since })
    },
    disarmed(file) {
      const s = st(file)
      if (s.state.kind === 'none') return
      set(file, { kind: 'none', since: Date.now() })
    },
    agentRequest(file) {
      const s = st(file)
      s.lastAgentAt = Date.now()
      if (s.state.kind === 'turn') schedule(file, s)
    },
    close() {
      for (const s of files.values()) clearTimer(s)
    },
  }
}
