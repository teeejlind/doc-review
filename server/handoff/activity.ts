// server/handoff/activity.ts (P4). "What is Claude doing on this doc" per file (CONTRACTS §8.5 "Claude activity").
//
// Only content requests (AGENT_CONTENT_ROUTES: pending, snapshot, thread, history, batch) count as Claude working;
// control requests (status, open, policy, wait, consume, disarm, shutdown, arm) never move the state.
//
// | from                          | trigger                                                        | to             |
// | any                           | handoff.sent (not coalesced: a coalesced click appends nothing)| waiting-pickup |
// | waiting-pickup, idle, replied | handoff consumed (handoff.consumed, or a Claude ack), or a     | working        |
// |                               | content request                                                |                |
// | any                           | a commit with a Claude content event (comment.*, suggestion.*, | replied        |
// |                               | thread.resolve / thread.reopen). A Claude doc.edit alone is not|                |
// |                               | a reply (QA3): the page shows a "Claude changed N blocks" cue  |                |
// | working                       | a commit with a Claude ack and no content event                | idle           |
// | working                       | a `pending` read that came back empty ("nothing new"): the    | what it was    |
// |                               | state that read replaced (replied stays replied, else idle)    | before it      |
// | working                       | the turn ended: POST /api/agent/arm (the skill's end-of-turn   | what it was    |
// |                               | call) or a waiter connect, with no ack to say so (a read-only, | before it      |
// |                               | direct-edit or failed-batch turn; Pass 4 #14)                  |                |
// | working                       | idleMs with no content request                                 | idle           |
// | replied                       | a TJ read-marker covering every Claude content seq since the   | idle           |
// |                               | state began, or idleMs with no content request                 |                |
// | waiting-pickup (waiter|latched)| presence became `none`: nobody is listening, so no waiter can | waiting-pickup |
// |                               | be promised the handoff (Pass 4 #15)                           | (clipboard)    |
// `waiting-pickup` has no timeout. Events are processed once each, by seq.
import type { AgentRoute, ClaudeActivity, IsoTime, SidecarEvent, ThreadId } from '../../shared/types'

type Delivery = 'waiter' | 'latched' | 'clipboard'

interface FileState {
  activity: ClaudeActivity
  timer: ReturnType<typeof setTimeout> | null
  /** Claude content items since `replied` began: seq plus the thread when the event names one. */
  repliedItems: Array<{ seq: number; thread: ThreadId | null }>
  lastSeq: number
  /**
   * Set when a `pending` read moved the state to `working` (and only then): what that read replaced, so an empty
   * result can put it back. Any other transition or content request clears it.
   */
  undo: { activity: ClaudeActivity; items: FileState['repliedItems'] } | null
}

const iso = (ms = Date.now()): IsoTime => new Date(ms).toISOString()

/** A Claude event that is a reply TJ reads: markup, a resolve or a reopen (the `any → replied` edge). */
export function isClaudeContent(e: SidecarEvent): boolean {
  if (e.by !== 'Claude') return false
  return e.type.startsWith('comment.') || e.type.startsWith('suggestion.') || e.type === 'thread.resolve' || e.type === 'thread.reopen'
}

/** Anything Claude did to the doc's review state: a reply, or a direct edit (which is work, not a reply). */
export function isClaudeWork(e: SidecarEvent): boolean {
  return isClaudeContent(e) || (e.by === 'Claude' && e.type === 'doc.edit')
}

function threadOf(e: SidecarEvent): ThreadId | null {
  return 'thread' in e && typeof e.thread === 'string' ? (e.thread as ThreadId) : null
}

export interface ActivityTracker {
  get(file: string): ClaudeActivity
  /** A content request (pending, snapshot, thread, history, batch) for the doc. */
  contentRequest(file: string, route?: AgentRoute): void
  /**
   * The `pending` read that just moved the doc to `working` came back empty: Claude looked and found nothing, and the
   * skill ends the turn without an ack, so nothing else would clear the badge. Puts back what the read replaced
   * (`replied` stays `replied`); a no-op unless that read is still the latest thing Claude did.
   */
  emptyPending(file: string): void
  /**
   * Claude's turn is over (the skill's end-of-turn `arm`, or its waiter loop connecting). A turn that only read the doc,
   * edited it directly or sent a failed batch leaves no ack, so nothing else would clear "Claude is working". Puts back
   * what the turn's first `pending` read replaced when that is still known, else `idle`; a no-op unless `working`.
   */
  turnEnded(file: string): void
  /**
   * Nobody is listening any more (presence became `none`): a handoff still waiting for pickup is no longer queued for a
   * waiter, so the badge becomes the paste row. A no-op unless `waiting-pickup` with a `waiter` or `latched` delivery.
   */
  listenerGone(file: string): void
  /** Committed sidecar events for the doc, in seq order; already-seen seqs are ignored. */
  events(file: string, events: readonly SidecarEvent[]): void
  /** The current count of unread Claude items (refreshed asynchronously by the module). */
  setUnread(file: string, n: number): void
  close(): void
}

export function createActivityTracker(o: {
  idleMs: number
  onChange: (file: string, a: ClaudeActivity) => void
  startedAt?: number
}): ActivityTracker {
  const startedAt = iso(o.startedAt ?? Date.now())
  const files = new Map<string, FileState>()

  const st = (file: string): FileState => {
    let s = files.get(file)
    if (!s) {
      s = { activity: { file, state: 'idle', since: startedAt, unreadFromClaude: 0 }, timer: null, repliedItems: [], lastSeq: 0, undo: null }
      files.set(file, s)
    }
    return s
  }

  const armIdle = (file: string, s: FileState): void => {
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    if (s.activity.state !== 'working' && s.activity.state !== 'replied') return
    const t = setTimeout(() => {
      s.timer = null
      if (s.activity.state === 'working' || s.activity.state === 'replied') to(file, 'idle')
    }, o.idleMs)
    ;(t as { unref?: () => void }).unref?.()
    s.timer = t
  }

  const to = (file: string, state: ClaudeActivity['state'], extra: { delivery?: Delivery } = {}): void => {
    const s = st(file)
    const now = iso()
    const prev = s.activity
    const lastSeenAt = state === 'working' ? now : prev.lastSeenAt
    s.activity = {
      file, state, since: now, unreadFromClaude: prev.unreadFromClaude,
      ...(state === 'waiting-pickup' && extra.delivery ? { delivery: extra.delivery } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
    }
    if (state !== 'replied') s.repliedItems = []
    s.undo = null
    armIdle(file, s)
    o.onChange(file, s.activity)
  }

  /** `working` ends without an ack: back to what the turn's first `pending` read replaced (`replied` stays), else idle. */
  const settle = (file: string, s: FileState): void => {
    const u = s.undo
    if (!u || u.activity.state !== 'replied') {
      to(file, 'idle')
      return
    }
    s.undo = null
    s.activity = { ...u.activity, unreadFromClaude: s.activity.unreadFromClaude }
    s.repliedItems = u.items
    armIdle(file, s)
    o.onChange(file, s.activity)
  }

  return {
    get: (file) => ({ ...st(file).activity }),

    contentRequest(file, route) {
      const s = st(file)
      const cur = s.activity.state
      if (cur === 'waiting-pickup' || cur === 'idle' || cur === 'replied') {
        const undo = route === 'pending' ? { activity: s.activity, items: s.repliedItems } : null
        to(file, 'working')
        s.undo = undo
      } else {
        s.undo = null
        s.activity = { ...s.activity, lastSeenAt: iso() }
        armIdle(file, s)
      }
    },

    emptyPending(file) {
      const s = st(file)
      if (!s.undo || s.activity.state !== 'working') return
      settle(file, s)
    },

    turnEnded(file) {
      const s = st(file)
      if (s.activity.state === 'working') settle(file, s)
    },

    listenerGone(file) {
      const a = st(file).activity
      if (a.state === 'waiting-pickup' && a.delivery !== 'clipboard') to(file, 'waiting-pickup', { delivery: 'clipboard' })
    },

    events(file, events) {
      const s = st(file)
      const fresh = events.filter((e) => e.seq > s.lastSeq)
      if (!fresh.length) return
      s.lastSeq = Math.max(s.lastSeq, ...fresh.map((e) => e.seq))

      const sent = fresh.filter((e) => e.type === 'handoff.sent')
      if (sent.length) {
        const last = sent[sent.length - 1]!
        to(file, 'waiting-pickup', last.type === 'handoff.sent' ? { delivery: last.delivery } : {})
      }
      const consumed = fresh.some((e) => e.type === 'handoff.consumed' || (e.type === 'ack' && e.by === 'Claude'))
      if (consumed) {
        const cur = s.activity.state
        if (cur === 'waiting-pickup' || cur === 'idle' || cur === 'replied') to(file, 'working')
      }
      const content = fresh.filter(isClaudeContent)
      if (content.length) {
        if (s.activity.state !== 'replied') to(file, 'replied')
        else armIdle(file, s)
        for (const e of content) s.repliedItems.push({ seq: e.seq, thread: threadOf(e) })
      } else if (fresh.some((e) => e.type === 'ack' && e.by === 'Claude') && s.activity.state === 'working') {
        to(file, 'idle')
      }
      for (const e of fresh) {
        if (e.type !== 'read-marker' || e.by !== 'TJ' || s.activity.state !== 'replied') continue
        s.repliedItems = s.repliedItems.filter((it) => !(it.seq <= e.upTo && (e.thread === null || it.thread === e.thread)))
        if (!s.repliedItems.length) to(file, 'idle')
      }
    },

    setUnread(file, n) {
      const s = st(file)
      if (s.activity.unreadFromClaude === n) return
      s.activity = { ...s.activity, unreadFromClaude: n }
      o.onChange(file, s.activity)
    },

    close() {
      for (const s of files.values()) if (s.timer) clearTimeout(s.timer)
    },
  }
}
