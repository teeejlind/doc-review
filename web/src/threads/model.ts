// web/src/threads/model.ts (P3, pure; CONTRACTS §6.3, §6.8, §11.4, §12.9, §13 rows 26, 37, 38, 84).
//
// Where each thread shows and what the rail header counts, derived from the review state, the editor's suggestion
// summaries and the show-resolved toggle. No DOM, no React: RailView renders what this returns.
//
//   positioned  anchored threads (text or block) laid out next to their anchor by layoutRail
//   docThreads  whole-doc comments (rail header)
//   detached    threads whose text is gone, shown with their original quote (rail header, §5.4)
//   unplaced    suggestion threads whose every live suggestion is BASE_NOT_FOUND / ID_COLLISION (rail header, §6.3;
//               decided by SuggestionSummary.unplaced, never by a null rect)
//
// Visibility (§6.8): a resolved thread (status 'resolved', or auto-resolved) hides unless show-resolved is on, but a
// resolved thread that still has a pending or stale suggestion stays listed and actionable either way.
import type { Author, ReviewState, Suggestion, SuggestionId, SuggestionSummary, Thread, ThreadId } from '../../../shared/types'
import { personName } from '../identity'

/** Pending and stale suggestions are live: they still need a decision. */
export const isLive = (s: Pick<Suggestion, 'status'>): boolean => s.status === 'pending' || s.status === 'stale'

/** Resolved by TJ or Claude, or auto-resolved (every suggestion terminal and no replies). */
export const isResolved = (t: Pick<Thread, 'status' | 'autoResolved'>): boolean => t.status === 'resolved' || t.autoResolved

/** The thread's suggestion records, in the thread's own order (missing ids skipped). */
export function suggestionsOf(t: Pick<Thread, 'suggestions'>, byId: ReadonlyMap<SuggestionId, Suggestion>): Suggestion[] {
  const out: Suggestion[] = []
  for (const id of t.suggestions) {
    const s = byId.get(id)
    if (s) out.push(s)
  }
  return out
}

export function hasLive(t: Pick<Thread, 'suggestions'>, byId: ReadonlyMap<SuggestionId, Suggestion>): boolean {
  return suggestionsOf(t, byId).some(isLive)
}

export function threadVisible(t: Thread, byId: ReadonlyMap<SuggestionId, Suggestion>, showResolved: boolean, keep?: ReadonlySet<string>): boolean {
  return showResolved || !isResolved(t) || hasLive(t, byId) || keep?.has(t.id) === true
}

/** BASE_NOT_FOUND / ID_COLLISION: "Can't place this inline", listed in the rail header (SCHEMA cards stay anchored). */
export const isHeaderUnplaced = (s: SuggestionSummary | undefined): boolean =>
  s !== undefined && !s.placed && (s.unplaced === 'BASE_NOT_FOUND' || s.unplaced === 'ID_COLLISION')

export interface RailModel {
  positioned: Thread[]
  docThreads: Thread[]
  detached: Thread[]
  unplaced: Thread[]
  /** Unread Claude messages and suggestions across every thread (the rail header count, §12.9). */
  unreadTotal: number
  /** Pending suggestions by Claude (the rail header's Accept all / Reject all from Claude). */
  pendingClaude: SuggestionId[]
  /** Resolved threads "Show resolved" hides (resolved, and no suggestion left to decide). */
  resolvedCount: number
  suggestionsById: Map<SuggestionId, Suggestion>
}

export function buildRailModel(
  review: Pick<ReviewState, 'threads' | 'suggestions'>,
  summaries: ReadonlyMap<SuggestionId, SuggestionSummary>,
  showResolved: boolean,
  o: {
    /** A block's ptext start, to place a block-anchored thread among the text-anchored ones (document order). */
    blockStart?: (index: number) => number | undefined
    /** Threads that stay listed though resolved: TJ has an unposted reply in them (Claude resolved it mid-sentence). */
    keepVisible?: ReadonlySet<string>
  } = {},
): RailModel {
  const { blockStart, keepVisible } = o
  const suggestionsById = new Map(review.suggestions.map((s) => [s.id, s] as const))
  const out: RailModel = { positioned: [], docThreads: [], detached: [], unplaced: [], unreadTotal: 0, pendingClaude: [], resolvedCount: 0, suggestionsById }
  for (const s of review.suggestions) if (s.status === 'pending' && s.by === 'Claude') out.pendingClaude.push(s.id)
  for (const t of review.threads) {
    out.unreadTotal += Math.max(0, t.unread)
    if (isResolved(t) && !hasLive(t, suggestionsById)) out.resolvedCount++
    if (!threadVisible(t, suggestionsById, showResolved, keepVisible)) continue
    if (t.anchor.kind === 'doc') out.docThreads.push(t)
    else if (t.detached) out.detached.push(t)
    else if (allLiveHeaderUnplaced(t, suggestionsById, summaries)) out.unplaced.push(t)
    else out.positioned.push(t)
  }
  // Document order (the anchor's ptext offset), not creation order: the sheet lists cards top to bottom, and the rail's
  // DOM order (so Tab order, WCAG 2.4.3) matches the order they sit in. Array#sort is stable, so ties keep creation order.
  out.positioned.sort((a, b) => documentOrderOf(a, blockStart) - documentOrderOf(b, blockStart))
  return out
}

/** A suggestion thread whose live suggestions are all "can't place inline" (and there is at least one). */
function allLiveHeaderUnplaced(t: Thread, byId: ReadonlyMap<SuggestionId, Suggestion>, summaries: ReadonlyMap<SuggestionId, SuggestionSummary>): boolean {
  if (t.kind !== 'suggestion') return false
  const live = suggestionsOf(t, byId).filter(isLive)
  return live.length > 0 && live.every((s) => isHeaderUnplaced(summaries.get(s.id)))
}

/** The §11.1 tiebreak for a thread: the anchor start's ptext offset. */
export function orderOf(t: Thread): number {
  return t.resolution.from ?? (t.anchor.kind === 'text' ? t.anchor.hint.pos : 0)
}

/**
 * Where a thread sits in the document, as a ptext offset: its resolved offset, else its anchor's, else (a block
 * anchor) where its block starts. `blockStart` is unknown to the pure model; without it a block anchor reads 0.
 */
export function documentOrderOf(t: Thread, blockStart?: (index: number) => number | undefined): number {
  if (t.resolution.from !== undefined) return t.resolution.from
  if (t.anchor.kind === 'text') return t.anchor.hint.pos
  if (t.anchor.kind === 'block') return blockStart?.(t.resolution.block ?? t.anchor.hint.block) ?? 0
  return 0
}

/** The seq to mark a thread read up to (§12.9): its latest event. */
export const readUpTo = (t: Pick<Thread, 'lastSeq'>): number => t.lastSeq

/** Pending suggestion ids of one thread (Accept all in thread, §6.8). */
export function pendingIdsOf(t: Thread, byId: ReadonlyMap<SuggestionId, Suggestion>): SuggestionId[] {
  return suggestionsOf(t, byId)
    .filter((s) => s.status === 'pending')
    .map((s) => s.id)
}

/** Display label of an author: the human's id 'TJ' shows as their display name (web/src/identity.ts). */
export function authorLabel(a: Author | 'external' | 'system'): string {
  if (a === 'external') return 'Someone outside the editor'
  if (a === 'system') return 'mdr'
  return personName(a)
}

/**
 * Next / previous in reading order (§11.4). `order` is the thread ids sorted by anchor position. With an active
 * thread, step from it (wrapping); without one, the first thread at or below `viewTop` going forward, the last one
 * above `viewBottom` going back. `anchors` maps each id to its anchor's content y.
 */
export function navTarget(
  order: readonly string[],
  activeId: string | null,
  dir: 1 | -1,
  anchors: ReadonlyMap<string, number>,
  view: { top: number; bottom: number },
): string | null {
  if (order.length === 0) return null
  const i = activeId === null ? -1 : order.indexOf(activeId)
  if (i >= 0) return order[(i + dir + order.length) % order.length]!
  if (dir === 1) return order.find((id) => (anchors.get(id) ?? -Infinity) >= view.top) ?? order[0]!
  for (let j = order.length - 1; j >= 0; j--) if ((anchors.get(order[j]!) ?? Infinity) < view.bottom) return order[j]!
  return order[order.length - 1]!
}

/** Sort thread ids by (anchor y, order, id), dropping ids without an anchor y. */
export function readingOrder(ids: readonly ThreadId[], anchors: ReadonlyMap<string, number>, orders: ReadonlyMap<string, number>): ThreadId[] {
  return ids
    .filter((id) => anchors.has(id))
    .sort((a, b) => anchors.get(a)! - anchors.get(b)! || (orders.get(a) ?? 0) - (orders.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
}
