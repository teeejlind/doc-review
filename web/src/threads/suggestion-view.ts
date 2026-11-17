// web/src/threads/suggestion-view.ts (P3, pure; CONTRACTS §6.3, §6.6–§6.8, §13 rows 41, 72).
//
// What a suggestion row says: its kind, its state line (pending, out of date, shown as a diff, can't place inline,
// decided), how its hunks are displayed, and which actions it offers. The record (Suggestion) is the server's truth;
// the summary (SuggestionSummary) is the editor's placement report. A row is accepted or rejected as a whole whatever
// its hunk count (D31): several hunks read "N changes, accepted together".
import type { Hunk, StaleReason, Suggestion, SuggestionSummary } from '../../../shared/types'
import { describeChange, hunksAreTextless } from '../../../core/suggest/describe'
import { personName } from '../identity'

export type SuggestionKind = SuggestionSummary['kind']

/** The summary's kind when the editor has one, else derived from the record's hunks the same way. */
export function kindOf(s: Pick<Suggestion, 'hunks'>, summary?: SuggestionSummary): SuggestionKind {
  if (summary) return summary.kind
  const del = s.hunks.map((h) => h.del).join('')
  const ins = s.hunks.map((h) => h.ins).join('')
  if (del && ins) return del === ins ? 'format' : 'replace'
  if (del) return 'delete'
  if (ins) return 'insert'
  return 'structure'
}

export const KIND_LABEL: Readonly<Record<SuggestionKind, string>> = {
  insert: 'Add',
  delete: 'Delete',
  replace: 'Replace',
  format: 'Format',
  structure: 'Structure change',
}

/** A one-line excerpt of hunk text for a title or a collapsed preview (whitespace squashed, cut at `max`). */
function excerpt(text: string, max = 48): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** True when no hunk shows text: a mark-only, structure-only or whitespace-only (split) record. */
export function isTextless(s: Pick<Suggestion, 'hunks'>): boolean {
  return hunksAreTextless(s.hunks)
}

/**
 * What the row's head says: the kind of text change ("Add", "Delete", "Replace", from the hunks it lists), or for a
 * record whose hunks carry no text what it does ("Bold: member", "Heading 2", "Checked: Todo one",
 * "Link: /fees → /pricing", "Split paragraph"; QA round 1, confirmed 28), else the summary's generic kind.
 */
export function labelOf(s: Pick<Suggestion, 'hunks' | 'base' | 'proposed'>, summary?: SuggestionSummary): string {
  if (isTextless(s)) return describeChange(s.base, s.proposed)?.detail ?? KIND_LABEL[kindOf(s, summary)]
  const texty = s.hunks.filter((h) => h.del.trim() !== '' || h.ins.trim() !== '')
  if (texty.every((h) => h.del.trim() === '')) return KIND_LABEL.insert
  if (texty.every((h) => h.ins.trim() === '')) return KIND_LABEL.delete
  return KIND_LABEL.replace
}

/**
 * The label plus the change itself on one line, for a collapsed card that has no comment text to show:
 * "Add: (see below)", "Delete: waitlist", "Replace: Q3 → Q4", "Bold: member".
 */
export function titleOf(s: Pick<Suggestion, 'hunks' | 'base' | 'proposed'>, summary?: SuggestionSummary): string {
  if (isTextless(s)) return labelOf(s, summary)
  const texty = s.hunks.filter((h) => h.del.trim() !== '' || h.ins.trim() !== '')
  const h = texty[0]!
  const more = texty.length > 1 ? ` (+${texty.length - 1} more)` : ''
  const label = labelOf(s, summary)
  const what = h.del.trim() && h.ins.trim() ? `${excerpt(h.del, 24)} → ${excerpt(h.ins, 24)}` : excerpt(h.del.trim() ? h.del : h.ins)
  return `${label}: ${what}${more}`
}

export const STALE_TEXT: Readonly<Record<StaleReason, string>> = {
  BASE_GONE: 'The text this changes was edited since. It can no longer be applied.',
  AMBIGUOUS: 'The text this changes now appears more than once, so it can’t be placed.',
  OVERLAP: 'Another change overlaps this one. It can no longer be applied.',
  MERGE_HAZARD: 'Applying this now would clobber a later edit.',
}

export type RowState = 'pending' | 'stale' | 'schema' | 'unplaced' | 'decided'

export function rowState(s: Pick<Suggestion, 'status'>, summary?: SuggestionSummary): RowState {
  if (s.status === 'stale') return 'stale'
  if (s.status !== 'pending') return 'decided'
  if (summary && !summary.placed) return summary.unplaced === 'SCHEMA' ? 'schema' : 'unplaced'
  return 'pending'
}

export function stateLine(s: Pick<Suggestion, 'status' | 'staleReason' | 'decidedBy'>, summary?: SuggestionSummary): { tag: string; text: string } | null {
  switch (rowState(s, summary)) {
    case 'stale':
      return { tag: 'Out of date', text: s.staleReason ? STALE_TEXT[s.staleReason] : STALE_TEXT.BASE_GONE }
    case 'schema':
      return { tag: 'Shown as a diff', text: 'This change can’t be marked inline here (a code block or a table’s structure). Accept or reject it as a whole.' }
    case 'unplaced':
      return { tag: 'Can’t place this inline', text: 'The text it changes has moved or changed. You can still accept or reject it.' }
    case 'decided': {
      const verb = s.status === 'accepted' ? 'Accepted' : s.status === 'rejected' ? 'Rejected' : 'Withdrawn'
      return { tag: s.decidedBy && s.status !== 'withdrawn' ? `${verb} by ${personName(s.decidedBy)}` : verb, text: '' }
    }
    default:
      return null
  }
}

/** "N changes, accepted together" for a multi-hunk record (D31), else null. */
export function togetherLabel(s: Pick<Suggestion, 'hunks'>, summary?: SuggestionSummary): string | null {
  const n = summary?.hunkCount ?? s.hunks.length
  return n > 1 ? `${n} changes, accepted together` : null
}

/** A code-block suggestion shows its hunks in a monospace block (§6.3). */
export function isCodeRecord(s: Pick<Suggestion, 'base' | 'proposed'>): boolean {
  return /^\s{0,3}(```|~~~)/m.test(s.base) || /^\s{0,3}(```|~~~)/m.test(s.proposed)
}

/** Long hunk text shortened around a middle ellipsis for display (the record keeps the full text). */
export function clip(text: string, max = 280): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 3) / 2)
  return `${text.slice(0, half)} … ${text.slice(text.length - half)}`
}

export interface HunkView {
  del: string
  ins: string
}

export function hunkViews(hunks: readonly Hunk[], max = 280): HunkView[] {
  return hunks.map((h) => ({ del: clip(h.del, max), ins: clip(h.ins, max) }))
}

export interface RowActions {
  /** 'on' = live Accept; 'off' = shown disabled (a stale record keeps its Accept, greyed, §6.7); null = none. */
  accept: 'on' | 'off' | null
  reject: boolean
  /** Stale: Dismiss (a reject) and Copy replacement in place of a live Accept. */
  dismiss: boolean
  copyReplacement: boolean
}

export function rowActions(s: Pick<Suggestion, 'status'>): RowActions {
  if (s.status === 'pending') return { accept: 'on', reject: true, dismiss: false, copyReplacement: false }
  if (s.status === 'stale') return { accept: 'off', reject: false, dismiss: true, copyReplacement: true }
  return { accept: null, reject: false, dismiss: false, copyReplacement: false }
}
