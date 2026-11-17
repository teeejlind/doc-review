// web/src/session/tabs.ts (P2). One editable tab per document (CONTRACTS §12.8, D19, §13 #61).
//
// A BroadcastChannel `mdr:<rootHash>:<file>` elects one editable leader: the first tab, which heartbeats every 2 s.
// Other tabs are read-only followers (TAB_NOT_LEADER) and show the `tab-not-leader` banner. takeOver() claims
// leadership with a higher term; the old leader hears the claim, flushes and goes read-only. If the leader is silent
// for 5 s (or says goodbye on close), the oldest live follower claims automatically.
//
// Ranking between two leaders that both think they won (simultaneous opens): higher term wins, then the older tab
// (smaller `since`), then the smaller id. A tab that loses steps down at once; a tab that wins re-asserts.
// Without BroadcastChannel (or in a private context that refuses it) the tab is simply the leader.

export interface ChannelLike {
  postMessage(m: unknown): void
  onmessage: ((e: { data: unknown }) => void) | null
  close(): void
}

export type TabRole = 'pending' | 'leader' | 'follower'

type TabMsg =
  | { t: 'query'; id: string }
  | { t: 'leader'; id: string; term: number; since: number }
  | { t: 'member'; id: string; since: number }
  | { t: 'claim'; id: string; term: number; since: number }
  | { t: 'release'; id: string }

export interface TabElectionOptions {
  channel: ChannelLike | null
  /** This tab's random id. */
  id: string
  /** When this tab opened (ms); older tabs win ties. */
  since: number
  now: () => number
  onChange: (role: TabRole, prev: TabRole) => void
  /** How long a new tab listens for a live leader before it claims (default 150 ms). */
  electionMs?: number
  heartbeatMs?: number
  leaderTimeoutMs?: number
}

export const TAB_HEARTBEAT_MS = 2_000
export const TAB_LEADER_TIMEOUT_MS = 5_000
export const TAB_ELECTION_MS = 150

export function tabChannelName(rootHash: string, file: string): string {
  return `mdr:${rootHash}:${file}`
}

export class TabElection {
  role: TabRole = 'pending'
  readonly ready: Promise<void>
  private resolveReady!: () => void
  private term = 0
  private maxTerm = 0
  private lastLeaderBeat = -Infinity
  private leaderId: string | null = null
  private readonly members = new Map<string, { since: number; at: number }>()
  private beat: ReturnType<typeof setInterval> | null = null
  private electTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(private readonly o: TabElectionOptions) {
    this.ready = new Promise((r) => (this.resolveReady = r))
  }

  private get heartbeatMs(): number {
    return this.o.heartbeatMs ?? TAB_HEARTBEAT_MS
  }
  private get timeoutMs(): number {
    return this.o.leaderTimeoutMs ?? TAB_LEADER_TIMEOUT_MS
  }

  start(): void {
    const ch = this.o.channel
    if (!ch) {
      this.setRole('leader')
      return
    }
    ch.onmessage = (e) => this.onMessage(e.data as TabMsg)
    this.post({ t: 'query', id: this.o.id })
    this.electTimer = setTimeout(() => {
      this.electTimer = null
      if (this.role === 'pending') this.becomeLeader(this.maxTerm, false)
    }, this.o.electionMs ?? TAB_ELECTION_MS)
    this.beat = setInterval(() => this.tick(), this.heartbeatMs)
  }

  /** §12.8 "Take over": claim leadership now, with a term above every term seen. */
  takeOver(): void {
    if (this.closed || this.role === 'leader') return
    this.becomeLeader(this.maxTerm + 1, true)
  }

  close(): void {
    if (this.closed) return
    if (this.role === 'leader') this.post({ t: 'release', id: this.o.id })
    this.closed = true
    if (this.beat) clearInterval(this.beat)
    if (this.electTimer) clearTimeout(this.electTimer)
    const ch = this.o.channel
    if (ch) {
      ch.onmessage = null
      try {
        ch.close()
      } catch {
        // already closed
      }
    }
    this.resolveReady()
  }

  // ------------------------------------------------------------------ internals

  private post(m: TabMsg): void {
    if (this.closed) return
    try {
      this.o.channel?.postMessage(m)
    } catch {
      // a closed or refused channel: behave as a lone tab
    }
  }

  private setRole(r: TabRole): void {
    if (this.role === r) return
    const prev = this.role
    this.role = r
    if (r !== 'pending') this.resolveReady()
    this.o.onChange(r, prev)
  }

  private becomeLeader(term: number, claim: boolean): void {
    this.term = term
    this.maxTerm = Math.max(this.maxTerm, term)
    this.leaderId = this.o.id
    this.setRole('leader')
    this.post(claim ? { t: 'claim', id: this.o.id, term, since: this.o.since } : this.heartbeat())
  }

  private heartbeat(): TabMsg {
    return { t: 'leader', id: this.o.id, term: this.term, since: this.o.since }
  }

  /** true when (term, since, id) a outranks b. */
  private static outranks(a: { term: number; since: number; id: string }, b: { term: number; since: number; id: string }): boolean {
    if (a.term !== b.term) return a.term > b.term
    if (a.since !== b.since) return a.since < b.since
    return a.id < b.id
  }

  private tick(): void {
    if (this.closed) return
    if (this.role === 'leader') {
      this.post(this.heartbeat())
      return
    }
    if (this.role === 'follower') {
      this.post({ t: 'member', id: this.o.id, since: this.o.since })
      if (this.o.now() - this.lastLeaderBeat > this.timeoutMs) this.claimIfOldest()
    }
  }

  private claimIfOldest(): void {
    const now = this.o.now()
    for (const [id, m] of this.members) {
      if (now - m.at > this.timeoutMs) {
        this.members.delete(id)
        continue
      }
      if (id === this.leaderId) continue
      if (m.since < this.o.since || (m.since === this.o.since && id < this.o.id)) return
    }
    this.becomeLeader(this.maxTerm + 1, true)
  }

  private onMessage(m: TabMsg): void {
    if (this.closed || !m || typeof m !== 'object' || m.id === this.o.id) return
    const now = this.o.now()
    switch (m.t) {
      case 'query':
        if (this.role === 'leader') this.post(this.heartbeat())
        else if (this.role === 'follower') this.post({ t: 'member', id: this.o.id, since: this.o.since })
        return
      case 'member':
        this.members.set(m.id, { since: m.since, at: now })
        return
      case 'leader':
      case 'claim': {
        this.maxTerm = Math.max(this.maxTerm, m.term)
        this.members.delete(m.id)
        if (this.role === 'leader') {
          const mine = { term: this.term, since: this.o.since, id: this.o.id }
          if (TabElection.outranks(m, mine)) {
            this.leaderId = m.id
            this.lastLeaderBeat = now
            this.setRole('follower')
          } else {
            this.post(this.heartbeat())
          }
          return
        }
        this.leaderId = m.id
        this.lastLeaderBeat = now
        if (this.role === 'pending') {
          if (this.electTimer) clearTimeout(this.electTimer)
          this.electTimer = null
          this.setRole('follower')
        }
        return
      }
      case 'release':
        if (this.role === 'follower' && m.id === this.leaderId) {
          this.leaderId = null
          this.lastLeaderBeat = -Infinity
          this.claimIfOldest()
        }
        return
    }
  }
}
