// web/src/history/diff-view.ts (P3; CONTRACTS §10 "Diff", R5). Pure helpers for the history panel.
//
// - diffItems: which blocks of a HistoryDiff the panel shows. Every changed block, plus `context` unchanged blocks on
//   each side of a change; longer unchanged runs fold into one "N unchanged blocks" row.
// - inlineSegments: a replace block's word-level diff as runs of kept / deleted / inserted text.
// - versionLabel / causeLabel / actorLabel: the timeline's words (plain ones: a colleague has never heard of mdr).
// - plainBlockText / cleanSegments: a block's text without the markdown markers its lines start with ("## ", "- ").
import type { Actor, DiffBlock, HistoryDiff, VersionCause, VersionMeta } from '../../../shared/types'
import { userName } from '../identity'

export type DiffItem =
  | { type: 'block'; index: number; block: DiffBlock; context: boolean }
  | { type: 'fold'; from: number; count: number }

export function diffItems(blocks: readonly DiffBlock[], context = 1): DiffItem[] {
  const changed = blocks.map((b) => b.op !== 'equal')
  const near = blocks.map((_, i) => {
    for (let d = -context; d <= context; d++) if (changed[i + d]) return true
    return false
  })
  const out: DiffItem[] = []
  let run: { from: number; count: number } | null = null
  const flush = (): void => {
    if (run) out.push({ type: 'fold', ...run })
    run = null
  }
  blocks.forEach((b, i) => {
    if (near[i]) {
      flush()
      out.push({ type: 'block', index: i, block: b, context: b.op === 'equal' })
    } else if (run) run.count++
    else run = { from: i, count: 1 }
  })
  flush()
  return out
}

export function changeCount(blocks: readonly DiffBlock[]): number {
  return blocks.filter((b) => b.op !== 'equal').length
}

export type Segment = { kind: 'same' | 'del' | 'ins'; text: string }

/** A replace block's segments (its dmp word diff; without one, the whole before then the whole after). */
export function inlineSegments(b: DiffBlock): Segment[] {
  if (b.inline?.length) {
    const out: Segment[] = []
    for (const [op, text] of b.inline) {
      if (!text) continue
      const kind = op === 0 ? 'same' : op < 0 ? 'del' : 'ins'
      const prev = out[out.length - 1]
      if (prev && prev.kind === kind) prev.text += text
      else out.push({ kind, text })
    }
    return out
  }
  return [
    ...(b.before ? [{ kind: 'del' as const, text: b.before }] : []),
    ...(b.after ? [{ kind: 'ins' as const, text: b.after }] : []),
  ]
}

/** Leading markers of a line: heading hashes, a bullet or number (with a task box), quote marks, possibly nested. */
const MARKER = /^(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|>[ \t]?)+/
/** Blocks whose punctuation is their content: fences, tables, raw HTML, rules. */
const LITERAL_BLOCK = /^(?:```|~~~|\||<|(?:-{3,}|\*{3,}|_{3,})\s*$)/

/** [from, to) offsets of the markers each line of a block starts with ([] for a literal block). */
function markerRanges(md: string): Array<[number, number]> {
  if (LITERAL_BLOCK.test(md.trimStart())) return []
  const out: Array<[number, number]> = []
  let off = 0
  for (const line of md.split('\n')) {
    const m = MARKER.exec(line)
    if (m) out.push([off, off + m[0].length])
    off += line.length + 1
  }
  return out
}

/** A block's markdown as the text it shows: no "## " or "- " in front of its lines. */
export function plainBlockText(md: string): string {
  const ranges = markerRanges(md)
  if (ranges.length === 0) return md
  let out = ''
  let at = 0
  for (const [a, b] of ranges) {
    out += md.slice(at, a)
    at = b
  }
  return out + md.slice(at)
}

/** What kind of block a markdown block is, from its first line (the diff styles headings; the rest read as text). */
export function blockKindOf(md: string): 'heading' | 'list' | 'quote' | 'text' {
  const first = md.trimStart()
  if (/^#{1,6}[ \t]/.test(first)) return 'heading'
  if (/^(?:[-*+]|\d{1,9}[.)])[ \t]/.test(first)) return 'list'
  if (first.startsWith('>')) return 'quote'
  return 'text'
}

/**
 * A replace block's word diff (`segs`, over `before` → `after`) with the line markers taken out. The markers are found
 * in each side's own text and dropped wherever they sit, so it does not matter which segment carries them (a bullet
 * turned numbered arrives as one deleted and one inserted piece). A 'same' character goes only when it is a marker on
 * both sides.
 */
export function cleanSegments(before: string, after: string, segs: ReadonlyArray<readonly [op: -1 | 0 | 1, text: string]>): Segment[] {
  const rb = markerRanges(before)
  const ra = markerRanges(after)
  const inside = (rs: ReadonlyArray<[number, number]>, i: number): boolean => rs.some(([a, b]) => i >= a && i < b)
  const out: Segment[] = []
  let bo = 0
  let ao = 0
  for (const [op, text] of segs) {
    let kept = ''
    for (let i = 0; i < text.length; i++) {
      const drop = op === 0 ? inside(rb, bo) && inside(ra, ao) : op < 0 ? inside(rb, bo) : inside(ra, ao)
      if (op <= 0) bo++
      if (op >= 0) ao++
      if (!drop) kept += text[i]
    }
    if (!kept) continue
    const kind = op === 0 ? 'same' : op < 0 ? 'del' : 'ins'
    const prev = out[out.length - 1]
    if (prev && prev.kind === kind) prev.text += kept
    else out.push({ kind, text: kept })
  }
  return out
}

/** Timeline labels by actor id; the human's id 'TJ' reads as their display name (web/src/identity.ts), per read. */
export const ACTOR_LABEL: Readonly<Record<Actor, string>> = {
  get TJ() {
    return userName()
  },
  Claude: 'Claude', external: 'Another app', system: 'mdr',
}
export const actorLabel = (a: Actor): string => ACTOR_LABEL[a] ?? a

export const CAUSE_LABEL: Readonly<Record<VersionCause, string>> = {
  baseline: 'Opened for review',
  'pre-write': 'Before a change',
  'tj-session': 'Your edits',
  'claude-write': 'Claude’s edit',
  accept: 'Accepted suggestions',
  external: 'Edited outside the review (Claude or another app)',
  restore: 'Restored',
  shutdown: 'Your edits (saved at shutdown)',
}

export function causeLabel(v: Pick<VersionMeta, 'cause' | 'restoredFrom' | 'by'>): string {
  if (v.cause === 'restore' && v.restoredFrom) return `Restored ${v.restoredFrom}`
  if (v.cause === 'tj-session' && v.by !== 'TJ') return `${actorLabel(v.by)}’s edits`
  return CAUSE_LABEL[v.cause] ?? v.cause
}

/**
 * The first word of a version row. The baseline is the file as review first found it, so no app wrote it: it reads
 * "Original", not the internal 'external' actor's "Another app" (T2 polish #36).
 */
export function versionWhoLabel(v: Pick<VersionMeta, 'cause' | 'by'>): string {
  return v.cause === 'baseline' ? 'Original' : actorLabel(v.by)
}

export function sideLabel(s: HistoryDiff['from']): string {
  return 'current' in s ? 'the current version' : s.v
}

/** "Today, 2:31 PM" · "Yesterday, 9:02 AM" · "Oct 12, 4:15 PM" (local time). */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return `Today, ${t}`
  if (diff === 1) return `Yesterday, ${t}`
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}, ${t}`
}

/** The full local date and time for a tooltip: "Thursday, October 15, 2026 at 12:00 PM". */
export function fullWhenLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })
}

/** The colour key of a changed block: its last author (lastBy), else the first of `by`. */
export function blockAuthor(b: Pick<DiffBlock, 'by' | 'lastBy'>): Actor | null {
  return b.lastBy ?? b.by[0] ?? null
}

/** §13 row 64: what a restore reports, as one sentence for the toast. */
export function restoredText(v: string, r: { detached: readonly unknown[]; staled: readonly unknown[] }): string {
  const parts = [`Restored ${v}.`]
  const d = r.detached.length
  const s = r.staled.length
  if (d) parts.push(`${d} ${d === 1 ? 'comment lost its text and moved' : 'comments lost their text and moved'} to Detached.`)
  if (s) parts.push(`${s} ${s === 1 ? 'suggestion is' : 'suggestions are'} out of date now.`)
  return parts.join(' ')
}
