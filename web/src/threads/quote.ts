// web/src/threads/quote.ts (P3; CONTRACTS §5.2 long-anchor display, §13 row 90).
//
// What a card shows for its anchor: the quote, squeezed to `max` characters around a middle ellipsis, and for a
// long anchor (span > MAX_QUOTE_CHARS: `quote` is the head, `tail` the last LONG_QUOTE_EDGE_CHARS units) always
// "head … tail", never just the head.
import type { Anchor } from '../../../shared/types'

const ELLIPSIS = ' … '

/** Collapses runs of whitespace (block separators included) to single spaces. */
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The first `n` characters, cut back to a word boundary when one is near. */
function head(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const sp = cut.lastIndexOf(' ')
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd()
}

/** The last `n` characters, cut forward to a word boundary when one is near. */
function tail(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(s.length - n)
  const sp = cut.indexOf(' ')
  return (sp >= 0 && sp < n * 0.4 ? cut.slice(sp + 1) : cut).trimStart()
}

export function quoteDisplay(anchor: Anchor, max = 160): string {
  if (anchor.kind === 'doc') return ''
  if (anchor.kind === 'block') return squash(anchor.preview).slice(0, max)
  const q = squash(anchor.quote)
  if (anchor.tail !== undefined) {
    const half = Math.max(8, Math.floor((max - ELLIPSIS.length) / 2))
    return `${head(q, half)}${ELLIPSIS}${tail(squash(anchor.tail), half)}`
  }
  if (q.length <= max) return q
  const half = Math.max(8, Math.floor((max - ELLIPSIS.length) / 2))
  return `${head(q, half)}${ELLIPSIS}${tail(q, half)}`
}
