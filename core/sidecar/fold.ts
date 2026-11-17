// core/sidecar/fold.ts (P1). The sidecar fold: pure, deterministic, incremental (CONTRACTS §4.5).
//
// fold(lines, init?) applies the §4.5 table in seq order. Void lines (wal.rev in voidRevs, filled by doc.abort) are
// skipped and their keys freed; the fold is two-pass over `lines`, so an abort voids lines that precede it in the same
// call. An incremental call cannot un-apply lines an earlier call already folded: when `needsFullRefold(init, lines)`
// is true the caller refolds the whole log from scratch (in practice the store only ever sees an abort for the WAL
// batch right before it, at open or in reconcile, so this is rare).
//
// Suggestion lines follow the §4.5 state machine: an illegal edge (a hand edit) is skipped with warning
// SIDECAR_INVALID_EVENT, and a repeat of the current state is a silent no-op. Writers refuse illegal edges before
// they reach the log (§4.4), so a clean log never trips either.
//
// Thread.resolution comes from the caller's `resolve`; Suggestion.located is the range hint here and the store
// overrides it with core/suggest/record.locate over the current Loaded (§4.5 "Derived values").
import type {
  Actor, Anchor, Author, CommentId, Cursors, Hash, HandoffRecord, IsoTime, Message, Resolution, ReviewPolicy, RevCause,
  SidecarEvent, StaleReason, StoreReviewState, Suggestion, SuggestionBody, SuggestionId, SuggestionStatus, TextAnchor,
  Thread, ThreadId, WaiterId, Warning,
} from '../../shared/types'
import { suggestionTransition, type SuggestionTransition } from './validate'

export interface ThreadFold {
  id: ThreadId
  kind: Thread['kind']
  status: Thread['status']
  anchor: Anchor
  /** ev.rev of the line that set `anchor` (anchor.update applies iff its rev >= this; ties go to the later seq). */
  anchorRev: number
  lastAnchor: Anchor
  detached: boolean
  createdBy: Author
  createdSeq: number
  lastSeq: number
  /** The root message (comment.add's comment, or suggestion.add's reason comment); null when there is none. */
  root: CommentId | null
  messages: Message[]
  suggestions: SuggestionId[]
}

export interface SuggestionFold extends SuggestionBody {
  id: SuggestionId
  thread: ThreadId
  by: Author
  status: SuggestionStatus
  anchor: TextAnchor
  createdSeq: number
  updatedSeq: number
  decidedBy?: Author
  decidedSeq?: number
  staleReason?: StaleReason
}

export interface FoldState {
  seq: number; rev: number; hash: Hash | null
  threads: Map<ThreadId, ThreadFold>; suggestions: Map<SuggestionId, SuggestionFold>
  keys: Map<string, number[]>              // idempotency key -> seqs of its (non-void) lines
  cursors: Cursors & { lastAckWaiter?: WaiterId }
  handoffs: Map<number, { at: IsoTime; message: string | null; delivery: string; consumedSeq?: number; round: number }>
  handoffRound: number                     // count of non-void handoff.sent lines so far (§9.10)
  policy: ReviewPolicy
  docLog: Array<{ seq: number; rev: number; type: 'doc.rev' | 'doc.edit' | 'doc.external'; by: Actor; cause?: RevCause }>
  tjSession: { baseRev: number; baseHash: Hash; lastRev: number; lastAt: IsoTime } | null
  voidRevs: Set<number>
  warnings: Warning[]
  /** P1 extension (optional, so §4.5's shape still type-checks): hash of every non-void doc.rev, for abort restores. */
  revHashes?: Map<number, Hash>
}

export function emptyFold(): FoldState {
  return {
    seq: 0, rev: 0, hash: null, threads: new Map(), suggestions: new Map(), keys: new Map(),
    cursors: { claudeAck: 0, tjRead: 0, tjReadByThread: {} }, handoffs: new Map(), handoffRound: 0,
    policy: { suggestOnly: false }, docLog: [], tjSession: null, voidRevs: new Set(), warnings: [], revHashes: new Map(),
  }
}

const TJ_SESSION_CAUSES: ReadonlySet<RevCause> = new Set(['save', 'merge', 'recreate'])

/**
 * True when `lines` carries a doc.abort for a rev whose doc.rev `init` already applied: the incremental fold can't
 * un-apply those lines, so the caller must refold the whole log (§4.6 WAL void).
 */
export function needsFullRefold(init: FoldState | undefined, lines: readonly SidecarEvent[]): boolean {
  if (!init) return false
  for (const e of lines) {
    if (e.type !== 'doc.abort' || init.voidRevs.has(e.abortedRev)) continue
    if (init.docLog.some((d) => d.type === 'doc.rev' && d.rev === e.abortedRev)) return true
  }
  return false
}

function findMessage(f: FoldState, id: CommentId): { t: ThreadFold; m: Message } | null {
  for (const t of f.threads.values()) {
    const m = t.messages.find((x) => x.id === id)
    if (m) return { t, m }
  }
  return null
}

export function fold(lines: readonly SidecarEvent[], init?: FoldState): FoldState {
  const f: FoldState = init ? structuredClone(init) : emptyFold()
  for (const e of lines) if (e.type === 'doc.abort') f.voidRevs.add(e.abortedRev)
  const warn = (message: string, extra: Partial<Warning> = {}): void => {
    f.warnings.push({ code: 'SIDECAR_INVALID_EVENT', message, ...extra })
  }

  for (const e of lines) {
    if (e.seq > f.seq) f.seq = e.seq
    if (e.wal && f.voidRevs.has(e.wal.rev)) continue   // void: skipped, its key never counted
    if (e.key !== undefined) {
      const seqs = f.keys.get(e.key)
      if (seqs) seqs.push(e.seq)
      else f.keys.set(e.key, [e.seq])
    }
    const touch = (id: ThreadId): ThreadFold | undefined => {
      const t = f.threads.get(id)
      if (t) t.lastSeq = e.seq
      return t
    }
    const sugg = (id: SuggestionId, t: SuggestionTransition): SuggestionFold | undefined => {
      const s = f.suggestions.get(id)
      if (!s) {
        warn(`seq ${e.seq}: ${e.type} for unknown suggestion ${id}`, { suggestion: id })
        return undefined
      }
      const verdict = suggestionTransition(s, t, e.by as Author | 'system')
      if (verdict === 'duplicate') return undefined
      if (verdict !== 'ok') {
        warn(`seq ${e.seq}: illegal ${e.type} by ${e.by} on a ${s.status} suggestion ${id} (${verdict}; skipped)`, { suggestion: id })
        return undefined
      }
      s.updatedSeq = e.seq
      touch(s.thread)
      return s
    }

    switch (e.type) {
      case 'doc.rev': {
        const prevRev = f.rev
        const prevHash = f.hash
        f.rev = e.rev
        f.hash = e.hash
        f.docLog.push({ seq: e.seq, rev: e.rev, type: 'doc.rev', by: e.by, cause: e.cause })
        ;(f.revHashes ??= new Map()).set(e.rev, e.hash)
        if (e.by === 'TJ' && TJ_SESSION_CAUSES.has(e.cause)) {
          if (f.tjSession) {
            f.tjSession.lastRev = e.rev
            f.tjSession.lastAt = e.at
          } else f.tjSession = { baseRev: prevRev, baseHash: prevHash ?? e.prevHash ?? e.hash, lastRev: e.rev, lastAt: e.at }
        } else f.tjSession = null
        break
      }
      case 'doc.edit':
        f.docLog.push({ seq: e.seq, rev: e.toRev, type: 'doc.edit', by: e.by })
        if (e.by === 'TJ' && e.source === 'editor') f.tjSession = null
        break
      case 'doc.external':
        f.docLog.push({ seq: e.seq, rev: e.toRev, type: 'doc.external', by: e.by })
        break
      case 'doc.abort': {
        // two-pass: the aborted batch was skipped above, so rev/hash already name the previous non-void doc.rev;
        // this only matters when the voided doc.rev was folded by an earlier call (needsFullRefold says so)
        if (f.rev === e.abortedRev) {
          const prev = [...f.docLog].reverse().find((d) => d.type === 'doc.rev' && d.rev !== e.abortedRev && !f.voidRevs.has(d.rev))
          f.rev = prev ? prev.rev : 0
          f.hash = prev ? (f.revHashes?.get(prev.rev) ?? f.hash) : null
        }
        break
      }
      case 'comment.add': {
        if (f.threads.has(e.thread)) {
          warn(`seq ${e.seq}: duplicate thread id ${e.thread} (ignored)`, { thread: e.thread })
          break
        }
        f.threads.set(e.thread, {
          id: e.thread, kind: e.anchor.kind === 'doc' ? 'doc' : 'comment', status: 'open',
          anchor: e.anchor, anchorRev: e.rev, lastAnchor: e.anchor, detached: false,
          createdBy: e.by, createdSeq: e.seq, lastSeq: e.seq, root: e.comment,
          messages: [{ id: e.comment, by: e.by, at: e.at, body: e.body, seq: e.seq }], suggestions: [],
        })
        break
      }
      case 'comment.reply': {
        const t = touch(e.thread)
        if (!t) warn(`seq ${e.seq}: reply to unknown thread ${e.thread}`, { thread: e.thread })
        else t.messages.push({ id: e.comment, by: e.by, at: e.at, body: e.body, seq: e.seq })
        break
      }
      case 'comment.edit': {
        const hit = findMessage(f, e.comment)
        if (!hit) {
          warn(`seq ${e.seq}: comment.edit for unknown comment ${e.comment}`)
          break
        }
        hit.m.body = e.body
        hit.m.editedAt = e.at
        hit.t.lastSeq = e.seq
        break
      }
      case 'comment.delete': {
        const hit = findMessage(f, e.comment)
        if (!hit) {
          warn(`seq ${e.seq}: comment.delete for unknown comment ${e.comment}`)
          break
        }
        hit.m.deleted = true
        hit.m.body = ''
        hit.t.lastSeq = e.seq
        // a root with no live replies and no suggestions removes the thread, whichever message went last
        const t = hit.t
        const rootGone = t.root === null || t.messages.find((m) => m.id === t.root)?.deleted === true
        const liveReplies = t.messages.some((m) => m.id !== t.root && !m.deleted)
        if (rootGone && !liveReplies && t.suggestions.length === 0) f.threads.delete(t.id)
        break
      }
      case 'thread.resolve':
      case 'thread.reopen': {
        const t = touch(e.thread)
        if (t) t.status = e.type === 'thread.resolve' ? 'resolved' : 'open'
        else warn(`seq ${e.seq}: ${e.type} for unknown thread ${e.thread}`, { thread: e.thread })
        break
      }
      case 'thread.detach': {
        const t = touch(e.thread)
        if (t) t.detached = true
        else warn(`seq ${e.seq}: thread.detach for unknown thread ${e.thread}`, { thread: e.thread })
        break
      }
      case 'thread.reattach': {
        const t = touch(e.thread)
        if (!t) {
          warn(`seq ${e.seq}: thread.reattach for unknown thread ${e.thread}`, { thread: e.thread })
          break
        }
        t.detached = false
        t.anchor = e.anchor
        t.lastAnchor = e.anchor
        t.anchorRev = e.rev
        break
      }
      case 'anchor.update': {
        const t = f.threads.get(e.thread)
        if (!t || e.rev < t.anchorRev) break
        t.anchor = e.anchor
        t.anchorRev = e.rev
        if (!t.detached) t.lastAnchor = e.anchor
        break
      }
      case 'suggestion.add': {
        if (f.suggestions.has(e.suggestion)) {
          warn(`seq ${e.seq}: duplicate suggestion id ${e.suggestion} (ignored)`, { suggestion: e.suggestion })
          break
        }
        f.suggestions.set(e.suggestion, {
          id: e.suggestion, thread: e.thread, by: e.by, status: 'pending', anchor: e.anchor,
          range: { ...e.range }, base: e.base, proposed: e.proposed, hunks: e.hunks.map((h) => ({ ...h })),
          createdSeq: e.seq, updatedSeq: e.seq,
        })
        if (e.newThread && f.threads.has(e.thread)) {
          warn(`seq ${e.seq}: suggestion.add opens thread ${e.thread}, which already exists (attached instead)`, { thread: e.thread, suggestion: e.suggestion })
        }
        if (e.newThread && !f.threads.has(e.thread)) {
          const root = e.comment !== undefined && e.body !== undefined ? e.comment : null
          f.threads.set(e.thread, {
            id: e.thread, kind: 'suggestion', status: 'open', anchor: e.anchor, anchorRev: e.rev, lastAnchor: e.anchor,
            detached: false, createdBy: e.by, createdSeq: e.seq, lastSeq: e.seq, root,
            messages: root && e.body !== undefined ? [{ id: root, by: e.by, at: e.at, body: e.body, seq: e.seq }] : [],
            suggestions: [e.suggestion],
          })
        } else {
          const t = touch(e.thread)
          if (!t) warn(`seq ${e.seq}: suggestion for unknown thread ${e.thread}`, { thread: e.thread })
          else {
            t.suggestions.push(e.suggestion)
            t.status = 'open'
            if (e.comment !== undefined && e.body !== undefined) t.messages.push({ id: e.comment, by: e.by, at: e.at, body: e.body, seq: e.seq })
          }
        }
        break
      }
      case 'suggestion.update':
      case 'suggestion.rebase': {
        const s = sugg(e.suggestion, e.type)
        if (!s) break
        s.range = { ...e.range }
        s.base = e.base
        s.proposed = e.proposed
        s.hunks = e.hunks.map((h) => ({ ...h }))
        s.anchor = e.anchor
        if (e.type === 'suggestion.rebase' && s.status === 'stale') {
          s.status = 'pending'
          delete s.staleReason
        }
        break
      }
      case 'suggestion.accept':
      case 'suggestion.reject': {
        const s = sugg(e.suggestion, e.type)
        if (!s) break
        s.status = e.type === 'suggestion.accept' ? 'accepted' : 'rejected'
        s.decidedBy = e.by
        s.decidedSeq = e.seq
        delete s.staleReason
        break
      }
      case 'suggestion.reopen': {
        const s = sugg(e.suggestion, 'suggestion.reopen')
        if (!s) break
        s.status = 'pending'
        delete s.decidedBy
        delete s.decidedSeq
        break
      }
      case 'suggestion.withdraw': {
        const s = sugg(e.suggestion, 'suggestion.withdraw')
        if (s) s.status = 'withdrawn'
        break
      }
      case 'suggestion.stale': {
        const s = sugg(e.suggestion, 'suggestion.stale')
        if (!s) break
        s.status = 'stale'
        s.staleReason = e.reason
        break
      }
      case 'ack':
        f.cursors.claudeAck = Math.max(f.cursors.claudeAck, e.upTo)
        if (e.waiter !== undefined) f.cursors.lastAckWaiter = e.waiter
        else delete f.cursors.lastAckWaiter
        break
      case 'read-marker':
        if (e.thread === null) f.cursors.tjRead = Math.max(f.cursors.tjRead, e.upTo)
        else f.cursors.tjReadByThread[e.thread] = Math.max(f.cursors.tjReadByThread[e.thread] ?? 0, e.upTo)
        break
      case 'handoff.sent':
        f.handoffRound += 1
        f.handoffs.set(e.seq, { at: e.at, message: e.message, delivery: e.delivery, round: f.handoffRound })
        break
      case 'handoff.consumed':
        for (const s of e.handoffs) {
          const h = f.handoffs.get(s)
          if (h && h.consumedSeq === undefined) h.consumedSeq = e.seq
        }
        break
      case 'policy.set':
        f.policy = { suggestOnly: e.suggestOnly }
        break
      case 'doc.missing':
      case 'server.recovered':
      case 'log.repair':
        break
      default:
        warn(`seq ${(e as SidecarEvent).seq}: unknown event type (skipped)`)
    }
  }
  return f
}

const TERMINAL: ReadonlySet<SuggestionStatus> = new Set(['accepted', 'rejected', 'withdrawn'])

/** A suggestion thread's suggestions when every one of them is decided (accepted, rejected or withdrawn); else null. */
export function decidedSuggestions(f: FoldState, t: ThreadFold): SuggestionFold[] | null {
  if (t.kind !== 'suggestion') return null
  const ss = t.suggestions.map((id) => f.suggestions.get(id)).filter((s): s is SuggestionFold => s !== undefined)
  return ss.length > 0 && ss.every((s) => TERMINAL.has(s.status)) ? ss : null
}

/**
 * A suggestion thread closes once its suggestions are all decided; what was said before the last decision is settled
 * with it, so only a reply after that decision keeps (or puts) it back open. Derived, never stored: `status` stays
 * 'open' in the fold, so every reader that counts or filters threads asks here (QA3 R1: `mdr status` counted an
 * accepted suggestion as open).
 */
export function isAutoResolved(f: FoldState, t: ThreadFold): boolean {
  const ss = decidedSuggestions(f, t)
  if (!ss) return false
  const lastDecision = ss.reduce((n, s) => Math.max(n, s.decidedSeq ?? s.updatedSeq), 0)
  return !t.messages.some((m) => m.id !== t.root && !m.deleted && m.seq > lastDecision)
}

export function toReviewState(f: FoldState, resolve: (a: Anchor) => Resolution, extras: { file: string }): StoreReviewState {
  const readUpTo = (t: ThreadId): number => Math.max(f.cursors.tjRead, f.cursors.tjReadByThread[t] ?? 0)
  const threads: Thread[] = [...f.threads.values()].map((t) => {
    const ss = t.suggestions.map((id) => f.suggestions.get(id)).filter((s): s is SuggestionFold => s !== undefined)
    const r = readUpTo(t.id)
    // a suggestion and the reason it came with are one event (the same seq), so they count once
    const unreadSeqs = new Set<number>()
    for (const m of t.messages) if (m.by === 'Claude' && !m.deleted && m.seq > r) unreadSeqs.add(m.seq)
    for (const s of ss) if (s.by === 'Claude' && s.createdSeq > r) unreadSeqs.add(s.createdSeq)
    const unread = unreadSeqs.size
    return {
      id: t.id, kind: t.kind, status: t.status,
      autoResolved: isAutoResolved(f, t),
      anchor: t.anchor, lastAnchor: t.lastAnchor,
      resolution: t.detached ? { state: 'detached' } : resolve(t.anchor),
      detached: t.detached, createdBy: t.createdBy, createdSeq: t.createdSeq, lastSeq: t.lastSeq,
      messages: t.messages.map((m) => ({ ...m })), suggestions: [...t.suggestions], unread,
    }
  })
  const suggestions: Suggestion[] = [...f.suggestions.values()].map((s) => ({
    ...s, range: { ...s.range }, hunks: s.hunks.map((h) => ({ ...h })),
    located: s.status === 'pending' ? { start: s.range.start, end: s.range.end } : null,
  }))
  return {
    ok: true, file: extras.file, rev: f.rev, seq: f.seq, threads, suggestions,
    cursors: { claudeAck: f.cursors.claudeAck, tjRead: f.cursors.tjRead, tjReadByThread: { ...f.cursors.tjReadByThread } },
    undeliveredHandoffs: unconsumedHandoffSeqs(f),
    policy: { ...f.policy }, warnings: f.warnings.map((w) => ({ ...w })), readOnly: false,
  }
}

function isConsumed(f: FoldState, seq: number): boolean {
  const h = f.handoffs.get(seq)
  return !!h && (h.consumedSeq !== undefined || seq <= f.cursors.claudeAck)
}

/** Unconsumed handoff seqs, oldest first (§8.5: consumed = a handoff.consumed covers it, or ack upTo >= seq). */
export function unconsumedHandoffSeqs(f: FoldState): number[] {
  return [...f.handoffs.keys()].sort((a, b) => a - b).filter((s) => !isConsumed(f, s))
}

/** DocStore.handoffs() projection (§3.9, D46): every non-void handoff.sent, oldest first. */
export function handoffRecords(f: FoldState, o?: { unconsumed?: boolean }): HandoffRecord[] {
  const out: HandoffRecord[] = [...f.handoffs.entries()].sort(([a], [b]) => a - b).map(([seq, h]) => ({
    seq, at: h.at, message: h.message, delivery: h.delivery as HandoffRecord['delivery'], round: h.round,
    consumed: isConsumed(f, seq),
  }))
  return o?.unconsumed ? out.filter((h) => !h.consumed) : out
}
