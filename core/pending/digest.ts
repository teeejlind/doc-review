// core/pending/digest.ts (P4, pure). The `pending` digest with normative netting (CONTRACTS §9.6, D31, D33).
//
// P1's DocStore.agent.pending() gathers PendingInput under the lock (the full non-void log, the fold at the same seq,
// the current block map, and runText over objects it pre-read) and calls buildPending. Nothing here touches the
// filesystem or a clock.
//
// Window: since < seq <= cursor, since = review.cursors.claudeAck, cursor = review.seq.
// Included: TJ and external events, plus system events that touch Claude-authored items (suggestion.stale /
// suggestion.rebase on Claude's suggestions, thread.detach / thread.reattach on Claude's threads), which become
// notices. Claude's own events never appear.
//
// Netting:
// - Threads are listed when something nets to a change: messages flagged new / edited / deleted (a comment created
//   and deleted inside the window is omitted; edits net to the latest body, which the fold already holds), a net
//   resolve or reopen (omitted when the thread ends where it started), TJ suggestions at their final state
//   (created-then-withdrawn omitted), TJ decisions on Claude's suggestions at their final state (with decidedBy), and
//   a TJ detach. `messages` is the whole thread for context.
// - Edits: TJ doc.edit with source 'editor' or 'restore', and doc.external, as two lists that are never merged.
//   'accept' / 'undo-accept' doc.edits are excluded: the decision is reported on the suggestion's thread, so the
//   same text never appears twice. Changes are chained per list by hash (a link's before.hashes equals the chain's
//   last after.hashes, as a sequence) and a chain is dropped iff its first before.hashes equals its last
//   after.hashes. Text is never compared for netting (D33). Net text: a side that holds its whole run (no window)
//   is used as is; a windowed side is read through runText at its rev; a missing object falls back to the stored
//   window and marks the change partial. format 'diff' (unified, 3 lines of context) when before + after exceed
//   PENDING_DIFF_THRESHOLD, else 'full'.
// - Handoffs: every handoff.sent in the window, with its message.
import type {
  Anchor, AnchorView, Author, BlockChange, BlockInfo, BlockRef, BlockSide, BuildPending, CommentId, PendingActivity, PendingCounts,
  PendingEdit, PendingHunk, PendingInput, PendingNotice, PendingResult, PendingThread, SidecarEvent, SidecarEventOf, Suggestion,
  SuggestionId, SuggestionStatus, Thread, ThreadId,
} from '../../shared/types'
import { CONSTANTS } from '../../shared/constants'
import { refOf } from '../../shared/ids'
import { describeChange, hunkPlaces, hunksAreTextless } from '../suggest/describe'
import { unifiedDiff } from './unified'

const { PENDING_DIFF_THRESHOLD } = CONSTANTS

type ThreadStatus = Thread['status']

// ===================================================================================== state at `since`

/** Statuses and authorship as of a given seq, mirroring the fold's transitions (§4.5) for the fields netting needs. */
interface MiniState {
  threadStatus: Map<ThreadId, ThreadStatus>
  threadDetached: Map<ThreadId, boolean>
  threadBy: Map<ThreadId, Author>
  suggStatus: Map<SuggestionId, SuggestionStatus>
  suggBy: Map<SuggestionId, Author>
  suggThread: Map<SuggestionId, ThreadId>
  commentThread: Map<CommentId, ThreadId>
}

function emptyMini(): MiniState {
  return {
    threadStatus: new Map(), threadDetached: new Map(), threadBy: new Map(), suggStatus: new Map(), suggBy: new Map(),
    suggThread: new Map(), commentThread: new Map(),
  }
}

function applyMini(m: MiniState, e: SidecarEvent): void {
  switch (e.type) {
    case 'comment.add':
      if (!m.threadBy.has(e.thread)) m.threadBy.set(e.thread, e.by)
      m.threadStatus.set(e.thread, 'open')
      m.threadDetached.set(e.thread, false)
      m.commentThread.set(e.comment, e.thread)
      break
    case 'comment.reply':
      m.commentThread.set(e.comment, e.thread)
      break
    case 'thread.resolve':
      m.threadStatus.set(e.thread, 'resolved')
      break
    case 'thread.reopen':
      m.threadStatus.set(e.thread, 'open')
      break
    case 'thread.detach':
      m.threadDetached.set(e.thread, true)
      break
    case 'thread.reattach':
      m.threadDetached.set(e.thread, false)
      break
    case 'suggestion.add':
      m.suggStatus.set(e.suggestion, 'pending')
      m.suggBy.set(e.suggestion, e.by)
      m.suggThread.set(e.suggestion, e.thread)
      if (e.newThread) {
        if (!m.threadBy.has(e.thread)) m.threadBy.set(e.thread, e.by)
        m.threadDetached.set(e.thread, false)
      }
      m.threadStatus.set(e.thread, 'open')
      if (e.comment) m.commentThread.set(e.comment, e.thread)
      break
    case 'suggestion.accept':
      m.suggStatus.set(e.suggestion, 'accepted')
      break
    case 'suggestion.reject':
      m.suggStatus.set(e.suggestion, 'rejected')
      break
    case 'suggestion.reopen':
      m.suggStatus.set(e.suggestion, 'pending')
      break
    case 'suggestion.withdraw':
      m.suggStatus.set(e.suggestion, 'withdrawn')
      break
    case 'suggestion.stale':
      m.suggStatus.set(e.suggestion, 'stale')
      break
    case 'suggestion.rebase':
      m.suggStatus.set(e.suggestion, 'pending')
      break
    default:
      break
  }
}

function cloneMini(m: MiniState): MiniState {
  return {
    threadStatus: new Map(m.threadStatus), threadDetached: new Map(m.threadDetached), threadBy: new Map(m.threadBy),
    suggStatus: new Map(m.suggStatus), suggBy: new Map(m.suggBy), suggThread: new Map(m.suggThread),
    commentThread: new Map(m.commentThread),
  }
}

// ===================================================================================== per-thread accumulation

interface SuggAcc {
  created: boolean
  revised: boolean
  /** A TJ decision, reopen or withdraw touched it in the window. */
  decisionTouched: boolean
  withdrawnByTj: boolean
}

interface ThreadAcc {
  created: boolean
  newMsgs: Set<CommentId>
  editedMsgs: Set<CommentId>
  deletedMsgs: Set<CommentId>
  /** Created and deleted inside the window: omitted entirely. */
  vanished: Set<CommentId>
  resolveTouched: boolean
  /**
   * The thread's status just before TJ's first resolve/reopen in the window, Claude's own events in the window
   * included: "where Claude left it". Claude's resolve rides in the same batch as the ack of the read it answers, so
   * it sits after `since`; measuring from the state at `since` would net TJ's reopen of it to nothing.
   */
  resolveFrom: ThreadStatus | null
  tjDetached: boolean
  suggestions: Map<SuggestionId, SuggAcc>
}

const newThreadAcc = (): ThreadAcc => ({
  created: false, newMsgs: new Set(), editedMsgs: new Set(), deletedMsgs: new Set(), vanished: new Set(),
  resolveTouched: false, resolveFrom: null, tjDetached: false, suggestions: new Map(),
})

// ===================================================================================== edits

type EditEvent = SidecarEventOf<'doc.edit'> | SidecarEventOf<'doc.external'>

interface Link {
  fromRev: number
  toRev: number
  change: BlockChange
  source: 'editor' | 'restore' | null
  seq: number
}

const hashesOf = (s: BlockSide | null): readonly string[] => s?.hashes ?? []
const seqEq = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((h, i) => h === b[i])

/** Chain changes of one list by hash (§9.6): a change whose before.hashes equals a chain's last after.hashes extends it. */
function chainChanges(events: readonly EditEvent[]): { chains: Link[][]; opaque: SidecarEventOf<'doc.external'>[] } {
  const chains: Link[][] = []
  const opaque: SidecarEventOf<'doc.external'>[] = []
  for (const ev of events) {
    if (ev.type === 'doc.external' && ev.changes === null) {
      opaque.push(ev)
      continue
    }
    const changes = ev.changes ?? []
    const extendedThisEvent = new Set<Link[]>()
    for (const change of changes) {
      const link: Link = {
        fromRev: ev.fromRev, toRev: ev.toRev, change, seq: ev.seq,
        source: ev.type === 'doc.edit' ? (ev.source === 'restore' ? 'restore' : 'editor') : null,
      }
      const before = hashesOf(change.before)
      let target: Link[] | undefined
      if (before.length > 0) {
        for (let k = chains.length - 1; k >= 0; k--) {
          const ch = chains[k]!
          if (extendedThisEvent.has(ch)) continue
          const last = ch[ch.length - 1]!
          if (last.seq < ev.seq && seqEq(hashesOf(last.change.after), before)) {
            target = ch
            break
          }
        }
      }
      if (target) target.push(link)
      else {
        target = [link]
        chains.push(target)
      }
      extendedThisEvent.add(target)
    }
  }
  return { chains, opaque }
}

/** Current index of a run whose first hash is `hash`, nearest to `near`; null when no block carries it. */
function currentIndexOf(blocks: readonly BlockInfo[], hash: string | undefined, near: number): number | null {
  if (hash === undefined) return null
  let best: number | null = null
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.hash !== hash) continue
    if (best === null || Math.abs(i - near) < Math.abs(best - near)) best = i
  }
  return best
}

type EditBlock = PendingEdit['blocks'][number]

function netChains(input: PendingInput, events: readonly EditEvent[], by: 'TJ' | 'external'): { edit: PendingEdit | null; count: number } {
  const { chains, opaque } = chainChanges(events)
  const blocks: Array<{ order: number; block: EditBlock }> = []
  const sources = new Set<'editor' | 'restore'>()
  let fromRev = Infinity
  let toRev = -Infinity
  let count = 0

  for (const chain of chains) {
    const first = chain[0]!
    const last = chain[chain.length - 1]!
    const before = first.change.before
    const after = last.change.after
    if (seqEq(hashesOf(before), hashesOf(after))) continue // nets to nothing (insert-then-delete included)
    let partial = false
    const full = (side: BlockSide | null, rev: number): string | null => {
      if (!side) return null
      if (!side.window && !side.truncated) return side.md
      const t = input.runText(rev, side.start, side.end)
      if (t !== null) return t
      partial = true
      return side.md
    }
    const beforeText = full(before, first.fromRev)
    const afterText = full(after, last.toRev)
    const op: EditBlock['op'] = before === null ? 'insert' : after === null ? 'delete' : 'replace'
    const cur = after ? currentIndexOf(input.blocks, after.hashes[0], after.index) : null
    const ref: BlockRef | null = cur === null ? null : refOf(cur)
    const line = cur === null ? null : (input.blocks[cur]?.line ?? null)
    const size = (beforeText?.length ?? 0) + (afterText?.length ?? 0)
    const change: EditBlock['change'] = size > PENDING_DIFF_THRESHOLD
      ? { format: 'diff', diff: unifiedDiff(beforeText ?? '', afterText ?? ''), ...(partial ? { partial: true as const } : {}) }
      : { format: 'full', before: beforeText, after: afterText, ...(partial ? { partial: true as const } : {}) }
    blocks.push({ order: cur ?? before?.index ?? after?.index ?? 0, block: { op, block: ref, line, change } })
    for (const l of chain) if (l.source) sources.add(l.source)
    fromRev = Math.min(fromRev, first.fromRev)
    toRev = Math.max(toRev, last.toRev)
    count += Math.max(1, hashesOf(before).length, hashesOf(after).length)
  }
  for (const ev of opaque) {
    blocks.push({ order: Number.MAX_SAFE_INTEGER, block: { op: 'replace', block: null, line: null, change: { format: 'full', before: null, after: null, partial: true } } })
    fromRev = Math.min(fromRev, ev.fromRev)
    toRev = Math.max(toRev, ev.toRev)
    count += 1
  }
  if (!blocks.length) return { edit: null, count: 0 }
  blocks.sort((a, b) => a.order - b.order)
  const order: Array<'editor' | 'restore'> = ['editor', 'restore']
  return {
    edit: {
      by, sources: by === 'TJ' ? order.filter((s) => sources.has(s)) : [], fromRev, toRev, blocks: blocks.map((b) => b.block),
    },
    count,
  }
}

// ===================================================================================== views

const quoteOf = (a: Anchor): string => (a.kind === 'doc' ? '' : a.kind === 'text' ? (a.tail !== undefined ? `${a.quote} … ${a.tail}` : a.quote) : a.preview)

function anchorView(t: Thread, blocks: readonly BlockInfo[]): AnchorView {
  const a = t.anchor
  if (a.kind === 'doc') return { state: 'doc', block: null, line: null, quote: '' }
  const r = t.detached ? { state: 'detached' as const } : t.resolution
  const state: AnchorView['state'] = r.state === 'exact' || r.state === 'moved' ? 'ok' : r.state === 'fuzzy' ? 'fuzzy' : r.state === 'doc' ? 'doc' : 'detached'
  const block = state === 'detached' ? null : (r.block ?? null)
  const quote = quoteOf(a)
  return {
    state, block: block === null ? null : refOf(block), line: block === null ? null : (blocks[block]?.line ?? null), quote,
    ...('ambiguous' in r && r.ambiguous ? { ambiguous: true as const } : {}),
  }
}

function suggestionWhere(s: Suggestion, t: Thread, blocks: readonly BlockInfo[]): { block: BlockRef | null; line: number | null } {
  const idx = s.located ? s.located.start : t.kind === 'suggestion' && !t.detached ? (t.resolution.block ?? null) : null
  if (idx === null || idx < 0 || idx >= blocks.length) return { block: null, line: null }
  return { block: refOf(idx), line: blocks[idx]!.line }
}

type PendingSugg = PendingThread['suggestions'][number]

/**
 * A suggestion's hunks and, when they carry no text, its change note (QA round 1, confirmed 20): where an insertion
 * goes (the source on both sides, the table cell) and what a mark-only or structure-only change is, so Claude can act
 * without a second call.
 */
function hunkFields(s: Suggestion): Pick<PendingSugg, 'hunks' | 'change'> {
  const places = hunkPlaces(s.base, s.proposed, s.hunks)
  const hunks: PendingHunk[] = s.hunks.map((h, i) => {
    const p = places[i]
    if (!p) return { del: h.del, ins: h.ins }
    const out: PendingHunk = { del: h.del, ins: h.ins }
    if (h.del.trim() === '') {
      out.before = p.before
      out.after = p.after
    }
    if (p.cell) out.cell = p.cell
    return out
  })
  const note = hunksAreTextless(s.hunks) ? describeChange(s.base, s.proposed) : null
  return note ? { hunks, change: note } : { hunks }
}

const ACTIVITY_ORDER: readonly PendingActivity[] = [
  'created', 'replied', 'edited', 'deleted', 'resolved', 'reopened', 'suggested', 'revised', 'accepted', 'rejected',
  'withdrawn', 'reopened-suggestion', 'detached', 'reattached',
]

// ===================================================================================== the digest

export const buildPending: BuildPending = (input: PendingInput): PendingResult => {
  const since = input.review.cursors.claudeAck
  const cursor = input.review.seq
  const events = [...input.events].sort((a, b) => a.seq - b.seq)

  // state at `since`, and authorship / ownership maps over the whole log (ids never move between threads)
  const atSince = emptyMini()
  const all = emptyMini()
  // what a thread the fold removed (its last live message was deleted) still needs: its messages and last anchor
  const msgFacts = new Map<CommentId, { thread: ThreadId; by: Author; at: string }>()
  const anchorOf = new Map<ThreadId, Anchor>()
  const createdSeqOf = new Map<ThreadId, number>()
  for (const e of events) {
    if (e.seq > cursor) break
    if (e.seq <= since) applyMini(atSince, e)
    applyMini(all, e)
    if (e.type === 'comment.add' || e.type === 'comment.reply') msgFacts.set(e.comment, { thread: e.thread, by: e.by, at: e.at })
    if (e.type === 'comment.add' || e.type === 'anchor.update' || e.type === 'thread.reattach') anchorOf.set(e.thread, e.anchor)
    if (e.type === 'comment.add' && !createdSeqOf.has(e.thread)) createdSeqOf.set(e.thread, e.seq)
  }
  const sinceState = cloneMini(atSince)

  const reviewThreads = new Map(input.review.threads.map((t) => [t.id, t]))
  const reviewSuggs = new Map(input.review.suggestions.map((s) => [s.id, s]))
  const isClaudeThread = (id: ThreadId): boolean => (reviewThreads.get(id)?.createdBy ?? all.threadBy.get(id)) === 'Claude'
  const isClaudeSugg = (id: SuggestionId): boolean => (reviewSuggs.get(id)?.by ?? all.suggBy.get(id)) === 'Claude'

  const accs = new Map<ThreadId, ThreadAcc>()
  const acc = (id: ThreadId): ThreadAcc => {
    let a = accs.get(id)
    if (!a) {
      a = newThreadAcc()
      accs.set(id, a)
    }
    return a
  }
  const suggAcc = (t: ThreadAcc, id: SuggestionId): SuggAcc => {
    let s = t.suggestions.get(id)
    if (!s) {
      s = { created: false, revised: false, decisionTouched: false, withdrawnByTj: false }
      t.suggestions.set(id, s)
    }
    return s
  }

  const handoffs: PendingResult['handoffs'] = []
  // thread statuses as the window unfolds, every actor included (resolve/reopen netting starts from here)
  const running = cloneMini(atSince)
  const tjEdits: EditEvent[] = []
  const extEdits: EditEvent[] = []
  const noticeSugg = new Map<SuggestionId, SidecarEventOf<'suggestion.stale'> | SidecarEventOf<'suggestion.rebase'>>()
  const noticeThread = new Map<ThreadId, SidecarEventOf<'thread.detach'> | SidecarEventOf<'thread.reattach'>>()

  for (const e of events) {
    if (e.seq <= since) continue
    if (e.seq > cursor) break
    if ((e.type === 'thread.resolve' || e.type === 'thread.reopen') && e.by === 'TJ') {
      const a = acc(e.thread)
      if (a.resolveFrom === null) a.resolveFrom = running.threadStatus.get(e.thread) ?? 'open'
    }
    applyMini(running, e)
    if (e.by === 'Claude') continue
    switch (e.type) {
      case 'comment.add': {
        if (e.by !== 'TJ') break
        const a = acc(e.thread)
        a.created = true
        a.newMsgs.add(e.comment)
        break
      }
      case 'comment.reply': {
        if (e.by !== 'TJ') break
        acc(e.thread).newMsgs.add(e.comment)
        break
      }
      case 'comment.edit': {
        if (e.by !== 'TJ') break
        const tid = all.commentThread.get(e.comment)
        if (!tid) break
        const a = acc(tid)
        if (!a.newMsgs.has(e.comment)) a.editedMsgs.add(e.comment)
        break
      }
      case 'comment.delete': {
        if (e.by !== 'TJ') break
        const tid = all.commentThread.get(e.comment)
        if (!tid) break
        const a = acc(tid)
        if (a.newMsgs.delete(e.comment)) a.vanished.add(e.comment)
        else {
          a.editedMsgs.delete(e.comment)
          a.deletedMsgs.add(e.comment)
        }
        break
      }
      case 'thread.resolve':
      case 'thread.reopen':
        if (e.by === 'TJ') acc(e.thread).resolveTouched = true
        break
      case 'thread.detach':
        if (e.by === 'TJ') acc(e.thread).tjDetached = true
        else if (isClaudeThread(e.thread)) noticeThread.set(e.thread, e)
        break
      case 'thread.reattach':
        if (isClaudeThread(e.thread)) noticeThread.set(e.thread, e)
        break
      case 'suggestion.add': {
        if (e.by !== 'TJ') break
        const a = acc(e.thread)
        if (e.newThread) a.created = true
        suggAcc(a, e.suggestion).created = true
        break
      }
      case 'suggestion.update': {
        if (e.by !== 'TJ') break
        const tid = all.suggThread.get(e.suggestion)
        if (!tid) break
        const s = suggAcc(acc(tid), e.suggestion)
        if (!s.created) s.revised = true
        break
      }
      case 'suggestion.accept':
      case 'suggestion.reject':
      case 'suggestion.reopen': {
        if (e.by !== 'TJ') break
        const tid = all.suggThread.get(e.suggestion)
        if (tid) suggAcc(acc(tid), e.suggestion).decisionTouched = true
        break
      }
      case 'suggestion.withdraw': {
        if (e.by !== 'TJ') break
        const tid = all.suggThread.get(e.suggestion)
        if (!tid) break
        const s = suggAcc(acc(tid), e.suggestion)
        s.withdrawnByTj = true
        s.decisionTouched = true
        break
      }
      case 'suggestion.stale':
      case 'suggestion.rebase':
        if (isClaudeSugg(e.suggestion)) noticeSugg.set(e.suggestion, e)
        break
      case 'doc.edit':
        if (e.by === 'TJ' && (e.source === 'editor' || e.source === 'restore')) tjEdits.push(e)
        break
      case 'doc.external':
        extEdits.push(e)
        break
      case 'handoff.sent':
        handoffs.push({ seq: e.seq, at: e.at, message: e.message })
        break
      default:
        break
    }
  }

  // ---------------------------------------------------------------- threads
  const counts: PendingCounts = { threads: 0, messages: 0, suggestions: 0, decisions: 0, resolves: 0, edits: 0, external: 0, notices: 0, handoffs: 0 }
  const threads: PendingThread[] = []
  const createdSeq = (id: ThreadId): number => reviewThreads.get(id)?.createdSeq ?? createdSeqOf.get(id) ?? 0
  const threadOrder = [...accs.keys()].sort((a, b) => createdSeq(a) - createdSeq(b))
  for (const tid of threadOrder) {
    const a = accs.get(tid)!
    const t = reviewThreads.get(tid)
    if (!t) {
      // the fold removed it: TJ deleted its last live message. A comment Claude may already have read and acted on is
      // still news (§9.6: any in-window activity lists the thread), so report it from the log; one created and
      // deleted inside the window never reaches deletedMsgs and stays omitted.
      if (!a.deletedMsgs.size) continue
      const anchor = anchorOf.get(tid) ?? { kind: 'doc' as const }
      const gone: PendingThread['messages'] = []
      for (const [cid, f] of msgFacts) if (f.thread === tid && a.deletedMsgs.has(cid)) gone.push({ id: cid, by: f.by, at: f.at, body: '', deleted: true })
      if (!gone.length) continue
      threads.push({
        id: tid, kind: anchor.kind === 'doc' ? 'doc' : 'comment', status: all.threadStatus.get(tid) ?? 'open',
        anchor: anchor.kind === 'doc' ? { state: 'doc', block: null, line: null, quote: '' } : { state: 'detached', block: null, line: null, quote: quoteOf(anchor) },
        activity: ['deleted'], messages: gone, suggestions: [],
      })
      counts.threads++
      continue
    }
    const activity = new Set<PendingActivity>()
    const rootId = t.messages[0]?.id
    if (a.created && t.kind !== 'suggestion') activity.add('created')
    for (const id of a.newMsgs) if (!(a.created && id === rootId)) activity.add('replied')
    if (a.editedMsgs.size) activity.add('edited')
    if (a.deletedMsgs.size) activity.add('deleted')
    let resolves = 0
    if (a.resolveTouched) {
      const start: ThreadStatus = a.created ? 'open' : (a.resolveFrom ?? sinceState.threadStatus.get(tid) ?? 'open')
      if (start !== t.status) {
        activity.add(t.status === 'resolved' ? 'resolved' : 'reopened')
        resolves = 1
      }
    }
    if (a.tjDetached && t.detached) activity.add('detached')

    const messages: PendingThread['messages'] = []
    let msgCount = 0
    for (const m of t.messages) {
      if (a.vanished.has(m.id)) continue
      const isNew = a.newMsgs.has(m.id)
      const edited = a.editedMsgs.has(m.id)
      const deleted = a.deletedMsgs.has(m.id)
      if (m.deleted && !deleted) continue
      messages.push({
        id: m.id, by: m.by, at: m.at, body: m.deleted ? '' : m.body,
        ...(isNew ? { new: true as const } : {}), ...(edited && !isNew ? { edited: true as const } : {}), ...(deleted ? { deleted: true as const } : {}),
      })
      if ((isNew || edited) && !m.deleted) msgCount++
    }

    const suggestions: PendingThread['suggestions'] = []
    let suggCount = 0
    let decisionCount = 0
    const suggOrder = [...a.suggestions.keys()].sort((x, y) => (reviewSuggs.get(x)?.createdSeq ?? 0) - (reviewSuggs.get(y)?.createdSeq ?? 0))
    for (const sid of suggOrder) {
      const sa = a.suggestions.get(sid)!
      const s = reviewSuggs.get(sid)
      if (!s) continue
      const start = sinceState.suggStatus.get(sid)
      const where = suggestionWhere(s, t, input.blocks)
      const shown = hunkFields(s)
      if (s.by === 'TJ') {
        if (sa.created && s.status === 'withdrawn') continue // created then withdrawn: nothing to report
        const changedState = !sa.created && start !== undefined && start !== s.status
        if (!sa.created && !sa.revised && !changedState) continue
        if (sa.created) activity.add('suggested')
        else if (sa.revised && s.status === 'pending') activity.add('revised')
        if (!sa.created && changedState) {
          if (s.status === 'withdrawn') activity.add('withdrawn')
          else if (s.status === 'accepted') activity.add('accepted')
          else if (s.status === 'rejected') activity.add('rejected')
          else if (s.status === 'pending' && (start === 'accepted' || start === 'rejected')) activity.add('reopened-suggestion')
        }
        suggestions.push({
          id: sid, by: 'TJ', status: s.status, ...(sa.created ? { new: true as const } : {}),
          ...(s.decidedBy ? { decidedBy: s.decidedBy } : {}), block: where.block, line: where.line, ...shown,
        })
        suggCount++
      } else {
        // Claude's suggestion: only TJ's net decision is news
        if (!sa.decisionTouched || start === s.status) continue
        if (s.status === 'accepted') activity.add('accepted')
        else if (s.status === 'rejected') activity.add('rejected')
        else if (s.status === 'pending' && (start === 'accepted' || start === 'rejected')) activity.add('reopened-suggestion')
        else continue
        suggestions.push({
          id: sid, by: 'Claude', status: s.status, ...(s.decidedBy ? { decidedBy: s.decidedBy } : {}), block: where.block, line: where.line, ...shown,
        })
        decisionCount++
      }
    }

    const flagged = messages.some((m) => m.new || m.edited || m.deleted)
    if (!activity.size && !flagged && !suggestions.length) continue
    threads.push({
      // a suggestion thread whose suggestions are all decided is closed, whatever its stored status (the fold derives it)
      id: tid, kind: t.kind, status: t.autoResolved ? 'resolved' : t.status, anchor: anchorView(t, input.blocks),
      activity: ACTIVITY_ORDER.filter((x) => activity.has(x)), messages, suggestions,
    })
    counts.threads++
    counts.messages += msgCount
    counts.suggestions += suggCount
    counts.decisions += decisionCount
    counts.resolves += resolves
  }

  // ---------------------------------------------------------------- notices (system events on Claude's items)
  const notices: PendingNotice[] = []
  for (const [sid, e] of noticeSugg) {
    const s = reviewSuggs.get(sid)
    if (!s) continue
    const thread = s.thread
    if (e.type === 'suggestion.stale') {
      if (s.status !== 'stale') continue // rebased or decided since: the stale state didn't stick
      notices.push({ type: 'suggestion.stale', suggestion: sid, thread, reason: e.reason })
    } else {
      if (s.status !== 'pending') continue
      notices.push({ type: 'suggestion.rebase', suggestion: sid, thread, reason: 'rebased onto the current text' })
    }
  }
  for (const [tid, e] of noticeThread) {
    const t = reviewThreads.get(tid)
    if (!t) continue
    const start = sinceState.threadDetached.get(tid) ?? false
    if (start === t.detached) continue
    if (e.type === 'thread.detach') notices.push({ type: 'thread.detach', thread: tid, reason: e.cause })
    else notices.push({ type: 'thread.reattach', thread: tid, reason: 'reattached' })
  }
  counts.notices = notices.length

  // ---------------------------------------------------------------- edits
  const tj = netChains(input, tjEdits, 'TJ')
  const ext = netChains(input, extEdits, 'external')
  const edits = tj.edit ? [tj.edit] : []
  const external = ext.edit ? [ext.edit] : []
  counts.edits = tj.count
  counts.external = ext.count
  counts.handoffs = handoffs.length

  return {
    ok: true,
    via: input.via,
    file: input.file,
    abs: input.abs,
    rev: input.rev,
    hash: input.hash,
    since,
    cursor,
    empty: !handoffs.length && !threads.length && !edits.length && !external.length && !notices.length,
    handoffs,
    threads,
    edits,
    external,
    notices,
    counts,
    warnings: [],
  }
}
