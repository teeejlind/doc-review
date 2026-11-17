// core/sidecar/compact.ts (P1). `mdr doctor --compact` over a parsed sidecar: pure (CONTRACTS §4.8, D22).
//
// Every event is kept verbatim except:
// - doc.rev lines: only the last COMPACT_KEEP_REVS revs survive, plus every rev referenced by a history version, by any
//   doc.edit / doc.external fromRev / toRev, by an open TJ session (base through last) and by Claude's ack (the rev
//   in effect at the ack, and every doc.rev after it, so `pending`'s window is untouched).
// - suggestion.update / suggestion.rebase lines older than Claude's ack seq and superseded by a later update or rebase
//   of the same suggestion. (The contract also names a later terminal event as superseding; dropping an update that
//   only a terminal event follows would change the folded body of a decided suggestion, which the before/after
//   equality forbids, so only a later full body supersedes. A rebase that moved the suggestion out of `stale` is
//   dropped only when the line that supersedes it is itself legal from `stale`.)
// Dropped lines free their keys. Seqs are preserved (gaps become legal through the new header's `compacted`).
// Safety net: the fold before and after must give the same review state (threads, suggestions, cursors, policy, rev,
// seq, handoffs); if a hand-edited log makes them differ, suggestion lines are kept, and if they still differ, nothing
// is dropped.
import type { IsoTime, SidecarEvent, SidecarHeader, SuggestionId, SuggestionStatus } from '../../shared/types'
import { fold, toReviewState, unconsumedHandoffSeqs, type FoldState } from './fold'

export const COMPACT_KEEP_REVS = 200

export interface CompactInput {
  header: SidecarHeader
  /** Parsed, valid events in seq order (no torn tail, no corruption). */
  events: readonly SidecarEvent[]
  /** Revs a history version references (its `rev` and both ends of `revs`). */
  historyRevs: ReadonlySet<number>
  now: IsoTime
}
export interface CompactOutput { header: SidecarHeader; events: SidecarEvent[]; dropped: number }

function digest(f: FoldState): string {
  const r = toReviewState(f, () => ({ state: 'detached' }), { file: '' })
  return JSON.stringify({ rev: r.rev, seq: r.seq, threads: r.threads, suggestions: r.suggestions, cursors: r.cursors, policy: r.policy, handoffs: unconsumedHandoffSeqs(f), hash: f.hash, round: f.handoffRound })
}

export function compactLines(i: CompactInput): CompactOutput {
  const events = [...i.events]
  const f = fold(events)
  const ack = f.cursors.claudeAck

  // ---- doc.rev retention
  const keepRevs = new Set<number>(i.historyRevs)
  const allRevs = events.filter((e) => e.type === 'doc.rev').map((e) => e.rev)
  for (const r of [...new Set(allRevs)].sort((a, b) => b - a).slice(0, COMPACT_KEEP_REVS)) keepRevs.add(r)
  let ackRev = 0
  for (const e of events) {
    if (e.type === 'doc.edit' || e.type === 'doc.external') {
      keepRevs.add(e.fromRev)
      keepRevs.add(e.toRev)
    }
    if (e.seq <= ack) ackRev = e.rev
  }
  keepRevs.add(ackRev)
  if (f.tjSession) for (const r of allRevs) if (r >= f.tjSession.baseRev && r <= f.tjSession.lastRev) keepRevs.add(r)
  const dropRev = (e: SidecarEvent): boolean => e.type === 'doc.rev' && e.seq <= ack && !keepRevs.has(e.rev)

  // ---- superseded suggestion bodies
  const dropSugg = new Set<number>()
  {
    const status = new Map<SuggestionId, SuggestionStatus>()
    const pendingBody = new Map<SuggestionId, { seq: number; fromStale: boolean }>()
    for (const e of events) {
      if (e.wal && f.voidRevs.has(e.wal.rev)) continue
      switch (e.type) {
        case 'suggestion.add':
          status.set(e.suggestion, 'pending')
          break
        case 'suggestion.update':
        case 'suggestion.rebase': {
          const before = status.get(e.suggestion)
          const prev = pendingBody.get(e.suggestion)
          // a later full body supersedes `prev` if it is legal where prev would have left the suggestion
          if (prev && prev.seq <= ack) {
            const legalFromStale = e.type === 'suggestion.rebase'
            if (!prev.fromStale || legalFromStale) dropSugg.add(prev.seq)
          }
          if (e.type === 'suggestion.update' && before !== 'pending') {
            pendingBody.delete(e.suggestion)
            break
          }
          pendingBody.set(e.suggestion, { seq: e.seq, fromStale: before === 'stale' })
          if (e.type === 'suggestion.rebase' && (before === 'stale' || before === 'pending')) status.set(e.suggestion, 'pending')
          break
        }
        case 'suggestion.stale':
          if (status.get(e.suggestion) === 'pending') status.set(e.suggestion, 'stale')
          break
        case 'suggestion.accept':
          status.set(e.suggestion, 'accepted')
          pendingBody.delete(e.suggestion)
          break
        case 'suggestion.reject':
          status.set(e.suggestion, 'rejected')
          pendingBody.delete(e.suggestion)
          break
        case 'suggestion.withdraw':
          status.set(e.suggestion, 'withdrawn')
          pendingBody.delete(e.suggestion)
          break
        case 'suggestion.reopen':
          status.set(e.suggestion, 'pending')
          pendingBody.delete(e.suggestion)
          break
        default:
          break
      }
    }
  }

  const before = digest(f)
  const attempt = (withSugg: boolean): SidecarEvent[] | null => {
    const kept = events.filter((e) => !dropRev(e) && !(withSugg && dropSugg.has(e.seq)))
    return digest(fold(kept)) === before ? kept : null
  }
  const kept = attempt(true) ?? attempt(false) ?? events
  const dropped = events.length - kept.length
  if (dropped === 0) return { header: i.header, events, dropped: 0 }
  const prior = i.header.compacted?.droppedLines ?? 0
  return { header: { ...i.header, compacted: { at: i.now, droppedLines: prior + dropped } }, events: kept, dropped }
}
