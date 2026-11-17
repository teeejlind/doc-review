// core/md/autolink.ts (QA round 3). URLs and emails in the .md as people write them.
//
// GFM reads a bare `https://…`, `www.…` or `name@host.tld` as a link (an autolink literal). The serializer escaped
// such text so it would stay text (`https\://…`, `\@`, `www\.`), and wrote a link whose text is its own address as
// `<https://…>` or `[www.x](http://www.x)`. Claude, HubSpot and Slack then got backslash noise, and a link copied out
// of the .md carried it (QA3). Here: an address run is written as it is wherever GFM reads that exact run back as a
// link (so plain text with an address becomes a link on reload, like Google Docs autolinks), and a link whose text
// is its own address is written bare under the same condition, else as `<…>`. Everything else is escaped as before.
//
// The check is conservative: a run is written bare only when the character before it lets a literal start (line
// start, whitespace, `*`, `_`, `~`, `(`) and what follows it up to the next space is only trailing punctuation GFM
// leaves out. Splice verification re-parses every written block, so a misjudged run could never reach the file.

export type AutolinkKind = 'url' | 'www' | 'email'

export interface AutolinkRun { start: number; end: number; kind: AutolinkKind }

const DOMAIN = '[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+'
const PATH = "(?:[/?#][^\\s<>`*\\[\\]\\\\]*)?"
const CANDIDATE = new RegExp(
  `(https?:\\/\\/${DOMAIN}(?::\\d{1,5})?${PATH})|(www\\.${DOMAIN}(?::\\d{1,5})?${PATH})|([A-Za-z0-9._+-]+@${DOMAIN})`,
  'g',
)

/** GFM's trailing-punctuation rule: `?!.,:*_~'"` never end a literal, nor an unbalanced `)`, nor `&entity;`. */
function trimTrailing(s: string): string {
  for (;;) {
    const before = s
    s = s.replace(/[?!.,:*_~'"]+$/, '')
    if (s.endsWith(')')) {
      const open = (s.match(/\(/g) ?? []).length
      const close = (s.match(/\)/g) ?? []).length
      if (close > open) s = s.slice(0, -1)
    }
    s = s.replace(/&[A-Za-z0-9]+;$/, '')
    if (s === before) return s
  }
}

const canStartAfter = (ch: string): boolean => ch === '' || /[\s*_~(]/.test(ch)
/** A character that ends a literal's run of non-space characters. */
const isStop = (ch: string): boolean => ch === '' || /[\s<]/.test(ch)

/**
 * The address runs in `value` that GFM reads back as exactly that link when `value` is written as it is. `before` /
 * `after`: the text right before and after `value` in its line ('' at a line edge).
 */
export function autolinkRuns(value: string, before: string, after: string): AutolinkRun[] {
  const out: AutolinkRun[] = []
  const at = (k: number): string => (k < value.length ? value[k]! : k === value.length ? after.slice(0, 1) : '')
  CANDIDATE.lastIndex = 0
  for (let m = CANDIDATE.exec(value); m; m = CANDIDATE.exec(value)) {
    const start = m.index
    const prev = start === 0 ? before.slice(-1) : value[start - 1]!
    if (m[3] !== undefined) {
      // email: needs a line edge, a space or '(' before it; it ends where its domain can't go on
      const end = start + m[0].length
      const next = at(end)
      if (!(prev === '' || /[\s(]/.test(prev)) || /[-_]$/.test(m[0]) || /[A-Za-z0-9_@+-]/.test(next)) continue
      if (next === '.' && (end + 1 > value.length || /[A-Za-z0-9_-]/.test(at(end + 1)))) continue
      out.push({ start, end, kind: 'email' })
      continue
    }
    if (!canStartAfter(prev)) continue
    // url / www: GFM takes everything up to the next space or '<' (into `after` when the value ends first), then
    // drops trailing punctuation; the run must be exactly that
    let chunkEnd = start
    while (chunkEnd < value.length && !isStop(value[chunkEnd]!)) chunkEnd++
    if (chunkEnd === value.length && !isStop(after.slice(0, 1))) continue
    const text = trimTrailing(value.slice(start, chunkEnd))
    if (!text || text !== trimTrailing(m[0])) continue
    if (value.slice(start + text.length, chunkEnd).replace(/[?!.,:*_~'")]/g, '') !== '') continue
    out.push({ start, end: start + text.length, kind: m[1] ? 'url' : 'www' })
    CANDIDATE.lastIndex = Math.max(CANDIDATE.lastIndex, chunkEnd)
  }
  return out
}

/** How a link with text `text` and target `href` can be written as an autolink, or null when it can't. */
export function bareLinkKind(text: string, href: string): AutolinkKind | null {
  if (!text || /\s/.test(text)) return null
  const whole = (k: AutolinkKind): boolean => {
    const r = autolinkRuns(text, '', '')
    return r.length === 1 && r[0]!.start === 0 && r[0]!.end === text.length && r[0]!.kind === k
  }
  if (href === text && /^https?:\/\//i.test(text)) return whole('url') ? 'url' : null
  if (href === `http://${text}` && /^www\./i.test(text)) return whole('www') ? 'www' : null
  if (href === `mailto:${text}`) return whole('email') ? 'email' : null
  return null
}

/** A link whose text is its own address, written where the bare form would not read back as that link. */
export function fallbackAutolink(text: string, kind: AutolinkKind): string {
  return kind === 'www' ? `[${text}](http://${text})` : `<${text}>`
}
