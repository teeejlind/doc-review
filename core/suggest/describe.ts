// core/suggest/describe.ts (QA round 1, confirmed 20 and 28). A suggestion's change, said in words, from its record.
//
// The display hunks (record.ts) are a diff of the rendered text, so a change that leaves the text alone (bold, a heading,
// a checkbox, a link target, a split paragraph) has no hunk, and an insertion has no place. Both the card and `mdr pending`
// need to say more, and both hold the record's source (`base`, `proposed`), so this module reads that:
// - describeChange: a one-line note ("Bold: member", "Heading 2", "Checked: Todo one", "Link: /fees → /pricing",
//   "Split paragraph") for a change whose hunks carry no text. Pure string work on the markdown; no parser.
// - hunkPlaces: for each display hunk, the source text around it (and the table cell it sits in), so Claude can find where
//   an insertion goes without a second call.
import { wordSpans } from './words'

export interface ChangeNote {
  kind: 'format' | 'structure'
  /** One line, e.g. "Bold: member". */
  detail: string
}

/** A note plus the words it is about (see changePhrase). */
interface Described extends ChangeNote {
  phrase?: string
}

export interface HunkPlace {
  /** Source text just before the change (up to 40 characters, from a word start). */
  before: string
  /** Source text just after it. */
  after: string
  /** Present when the change sits in a table row: "row “BAR”, column “Rate”". */
  cell?: string
}

const CONTEXT_CHARS = 40
const SHOWN_CHARS = 40

const trunc = (s: string, n = SHOWN_CHARS): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** True when no hunk carries visible text: a mark-only, structure-only or whitespace-only (split) change. */
export function hunksAreTextless(hunks: readonly { del: string; ins: string }[]): boolean {
  return hunks.every((h) => h.del.trim() === '' && h.ins.trim() === '')
}

// ------------------------------------------------------------------ plain text of a source fragment

const LINK = /\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g
const BLOCK_PREFIX = /^\s*(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/

/** The words of a source fragment with its markdown syntax taken off (block prefixes, emphasis, code ticks, link targets). */
function plain(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(BLOCK_PREFIX, ''))
    .join(' ')
    .replace(LINK, '$1')
    .replace(/\*\*|__|~~|[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const blocksOf = (s: string): string[] => s.split(/\n[ \t]*\n/).filter((b) => b.trim() !== '')

// ------------------------------------------------------------------ links and inline marks

/** "/fees" for a same-site link, the URL without its scheme otherwise, a relative URL as it is. */
function shortUrl(u: string, other: string): string {
  const strip = (x: string): string => x.replace(/^https?:\/\//, '')
  try {
    const a = new URL(u)
    const b = new URL(other)
    if (a.origin === b.origin) return `${a.pathname}${a.search}${a.hash}` || '/'
  } catch {
    // relative or odd URLs: shown as written
  }
  return strip(u)
}

function linksOf(s: string): Array<{ text: string; url: string }> {
  return Array.from(s.matchAll(LINK), (m) => ({ text: m[1] ?? '', url: m[2] ?? '' }))
}

const MARKS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'Bold', re: /\*\*([^*]+?)\*\*|__([^_]+?)__/g },
  { name: 'Strikethrough', re: /~~(.+?)~~/g },
  { name: 'Code', re: /`([^`]+)`/g },
  { name: 'Italic', re: /(?<![*\w])\*([^*\n]+?)\*(?![*\w])|(?<![_\w])_([^_\n]+?)_(?![_\w])/g },
]

function markTexts(s: string, re: RegExp): string[] {
  return Array.from(s.matchAll(re), (m) => m[1] ?? m[2] ?? '').filter(Boolean)
}

/** Items of `a` not matched by an item of `b` (a multiset difference). */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = [...b]
  const out: string[] = []
  for (const x of a) {
    const i = left.indexOf(x)
    if (i >= 0) left.splice(i, 1)
    else out.push(x)
  }
  return out
}

function inlineChange(a: string, b: string): Described | null {
  const la = linksOf(a)
  const lb = linksOf(b)
  if (la.length === lb.length) {
    const i = la.findIndex((l, k) => l.url !== lb[k]!.url)
    if (i >= 0) {
      return { kind: 'format', detail: `Link: ${trunc(shortUrl(la[i]!.url, lb[i]!.url))} → ${trunc(shortUrl(lb[i]!.url, la[i]!.url))}`, ...phraseOf(lb[i]!.text) }
    }
  } else if (lb.length > la.length) {
    const urls = minus(lb.map((l) => l.url), la.map((l) => l.url))
    const added = urls[0] ?? lb[lb.length - 1]!.url
    return { kind: 'format', detail: `Link added: ${trunc(added.replace(/^https?:\/\//, ''))}`, ...phraseOf(lb.find((l) => l.url === added)?.text) }
  } else {
    const urls = minus(la.map((l) => l.url), lb.map((l) => l.url))
    const gone = urls[0] ?? la[la.length - 1]!.url
    return { kind: 'format', detail: `Link removed: ${trunc(gone.replace(/^https?:\/\//, ''))}`, ...phraseOf(la.find((l) => l.url === gone)?.text) }
  }
  const parts: string[] = []
  let first: string | undefined
  for (const m of MARKS) {
    const ta = markTexts(a, m.re)
    const tb = markTexts(b, m.re)
    const added = minus(tb, ta)
    const removed = minus(ta, tb)
    if (added.length) parts.push(`${m.name}: ${trunc(added.join(', '))}`)
    if (removed.length) parts.push(`Remove ${m.name.toLowerCase()}: ${trunc(removed.join(', '))}`)
    first ??= added[0] ?? removed[0]
  }
  return parts.length ? { kind: 'format', detail: parts.join('; '), ...phraseOf(first) } : null
}

/** `{ phrase }` for a source fragment that has words in it, else nothing. */
function phraseOf(src: string | undefined): { phrase?: string } {
  const p = src === undefined ? '' : plain(src)
  return p ? { phrase: p } : {}
}

// ------------------------------------------------------------------ block structure

const HEADING = /^\s{0,3}(#{1,6})[ \t]+\S/
const FENCE = /^\s{0,3}(```|~~~)/
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/

const headingLevel = (b: string): number => HEADING.exec(b)?.[1]!.length ?? 0

interface ListLine {
  indent: number
  ordered: boolean
  checked: boolean | null
  text: string
}

function listLine(l: string): ListLine | null {
  const m = LIST_LINE.exec(l)
  if (!m) return null
  return { indent: m[1]!.replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]!), checked: m[3] === undefined ? null : m[3] !== ' ', text: plain(m[4] ?? '') }
}

function blockChange(a: string, b: string): Described | null {
  const ha = headingLevel(a)
  const hb = headingLevel(b)
  if (ha !== hb) {
    const detail = ha === 0 ? `Heading ${hb}` : hb === 0 ? `Heading ${ha} → paragraph` : `Heading ${ha} → Heading ${hb}`
    return { kind: 'structure', detail }
  }
  const fa = FENCE.test(a)
  const fb = FENCE.test(b)
  if (fa !== fb) return { kind: 'structure', detail: fb ? 'Code block' : 'Remove code block' }
  const qa = a.trimStart().startsWith('>')
  const qb = b.trimStart().startsWith('>')
  if (qa !== qb) return { kind: 'structure', detail: qb ? 'Quote' : 'Remove quote' }

  const la = a.split('\n')
  const lb = b.split('\n')
  if (la.length === lb.length) {
    for (let i = 0; i < la.length; i++) {
      if (la[i] === lb[i]) continue
      const pa = listLine(la[i]!)
      const pb = listLine(lb[i]!)
      if (pa && pb) {
        const full = pb.text || pa.text
        const text = trunc(full)
        const at = phraseOf(full)
        if (pa.checked !== pb.checked) {
          if (pa.checked === null) return { kind: 'structure', detail: `Checkbox: ${text}`, ...at }
          if (pb.checked === null) return { kind: 'structure', detail: `Remove checkbox: ${text}`, ...at }
          return { kind: 'structure', detail: `${pb.checked ? 'Checked' : 'Unchecked'}: ${text}`, ...at }
        }
        if (pa.ordered !== pb.ordered) return { kind: 'structure', detail: pb.ordered ? 'Numbered list' : 'Bulleted list' }
        if (pa.indent !== pb.indent) return { kind: 'structure', detail: `${pb.indent > pa.indent ? 'Indent' : 'Outdent'}: ${text}`, ...at }
      } else if (pa || pb) {
        if (plain(la[i]!) === plain(lb[i]!)) {
          const on = pb ?? pa!
          return { kind: 'structure', detail: pb ? (on.ordered ? 'Numbered list' : 'Bulleted list') : 'Remove list item' }
        }
      }
    }
  } else if (la.some((l) => LIST_LINE.test(l)) || lb.some((l) => LIST_LINE.test(l))) {
    return { kind: 'structure', detail: lb.length > la.length ? 'New list item' : 'Remove list item' }
  }
  return inlineChange(a, b)
}

/** The items of the list lines in `blocks` that now stand as paragraphs of their own in `after` (a list lift). */
function liftedItems(blocks: readonly string[], after: readonly string[]): string[] {
  const items = blocks.flatMap((b) => b.split('\n')).map(listLine).filter((l): l is ListLine => l !== null).map((l) => l.text)
  if (!items.length) return []
  const stay = [...items]
  const out: string[] = []
  for (const blk of after) {
    if (listLine(blk.split('\n')[0]!)) continue
    const t = plain(blk)
    const at = stay.indexOf(t)
    if (t && at >= 0) {
      out.push(t)
      stay.splice(at, 1)
    }
  }
  return out
}

/**
 * What a suggestion whose display hunks carry no text changes: mark-only, structure-only, or a split. Call it only when
 * `hunksAreTextless(hunks)`; it reads the source, so a text edit it was not asked about reads as "Formatting changed".
 * null when `base` and `proposed` are the same.
 */
export function describeChange(base: string, proposed: string): ChangeNote | null {
  const d = describe(base, proposed)
  return d && { kind: d.kind, detail: d.detail }
}

/**
 * The words a textless change is about, as they read in the document ("member" for a bold, the item for a list lift or
 * a checkbox, the link text for a link change): what its card quotes. null for a change to a whole block (a heading,
 * a quote), where the card quotes the block's first line.
 */
export function changePhrase(base: string, proposed: string): string | null {
  return describe(base, proposed)?.phrase ?? null
}

function describe(base: string, proposed: string): Described | null {
  if (base === proposed) return null
  const bb = blocksOf(base)
  const pb = blocksOf(proposed)
  if (bb.length !== pb.length) {
    const same = bb.map(plain).join(' ') === pb.map(plain).join(' ')
    if (same) {
      const lifted = liftedItems(bb, pb)
      if (lifted.length) return { kind: 'structure', detail: `Lift out of list: ${trunc(lifted.join('; '))}`, phrase: lifted[0]! }
    }
    if (pb.length > bb.length) return { kind: 'structure', detail: same ? (bb.length === 1 ? 'Split paragraph' : 'Split block') : 'Add block' }
    return { kind: 'structure', detail: same ? 'Merge paragraphs' : 'Remove block' }
  }
  for (let i = 0; i < bb.length; i++) {
    if (bb[i] === pb[i]) continue
    const n = blockChange(bb[i]!, pb[i]!)
    if (n) return n
  }
  return { kind: 'format', detail: 'Formatting changed' }
}

// ------------------------------------------------------------------ where a hunk sits

/** The cell of a markdown table row that `at` (an offset in `src`) lies in, or null when that line is not a table row. */
function cellAt(src: string, at: number): string | null {
  const lineStart = src.lastIndexOf('\n', at - 1) + 1
  const nl = src.indexOf('\n', at)
  const line = src.slice(lineStart, nl < 0 ? src.length : nl)
  if (!/^\s*\|/.test(line)) return null
  const cellsOf = (l: string): string[] => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  const col = Math.max(0, (src.slice(lineStart, at).match(/(?<!\\)\|/g)?.length ?? 1) - 1)
  const lines = src.slice(0, lineStart).split('\n')
  let first = lines.length - 1
  while (first > 0 && /^\s*\|/.test(lines[first - 1]!)) first--
  const tableStart = lines.slice(0, first).join('\n').length + (first > 0 ? 1 : 0)
  const headLine = src.slice(tableStart).split('\n')[0] ?? ''
  const head = cellsOf(headLine)[col]
  const row = cellsOf(line)
  if (tableStart === lineStart) return head ? `column “${trunc(head)}” (header)` : null
  const label = col > 0 ? row[0] : ''
  const rowNo = src.slice(tableStart, lineStart).split('\n').filter((l) => /^\s*\|/.test(l) && !/^[\s|:-]+$/.test(l)).length
  const rowPart = label ? `row “${trunc(label)}”` : `row ${rowNo}`
  return head ? `${rowPart}, column “${trunc(head)}”` : rowPart
}

/** Up to CONTEXT_CHARS of `s`, starting at a word when the cut falls inside one (and ending at one, for the tail). */
function lead(s: string): string {
  if (s.length <= CONTEXT_CHARS) return s
  const cut = s.slice(s.length - CONTEXT_CHARS)
  if (/\s/.test(s[s.length - CONTEXT_CHARS - 1]!)) return cut
  const sp = cut.search(/\s/)
  return sp > 0 && sp < CONTEXT_CHARS / 2 ? cut.slice(sp) : cut
}
function trail(s: string): string {
  if (s.length <= CONTEXT_CHARS) return s
  const cut = s.slice(0, CONTEXT_CHARS)
  const sp = cut.search(/\s\S*$/)
  return sp > CONTEXT_CHARS / 2 ? cut.slice(0, sp) : cut
}

/**
 * For each display hunk (in order), where it sits in `base`'s source: the text before and after it, and its table cell.
 * A hunk is matched to the next word-level source change with the same removed and inserted text (trimmed), so a hunk
 * whose text differs from its source (an insertion inside bold, say) gets null.
 */
export function hunkPlaces(base: string, proposed: string, hunks: readonly { del: string; ins: string }[]): Array<HunkPlace | null> {
  const spans = wordSpans(base, proposed)
  let next = 0
  return hunks.map((h) => {
    for (let k = next; k < spans.length; k++) {
      const s = spans[k]!
      if (base.slice(s.a0, s.a1).trim() !== h.del.trim() || proposed.slice(s.b0, s.b1).trim() !== h.ins.trim()) continue
      next = k + 1
      const place: HunkPlace = { before: lead(base.slice(0, s.a0)), after: trail(base.slice(s.a1)) }
      const cell = cellAt(base, s.a0)
      if (cell) place.cell = cell
      return place
    }
    return null
  })
}
