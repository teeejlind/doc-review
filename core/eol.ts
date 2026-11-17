// core/eol.ts (P1). EOL detection and line bookkeeping (CONTRACTS §0.4 "EOL", §3.1 "Mixed EOLs").
//
// EOLs are detected per doc and never normalized: untouched blocks keep their bytes, re-serialized blocks use the
// dominant EOL, a missing final newline is preserved. These are the helpers load(), the block map, updateLoaded,
// record.ts and the diff windows share (no frozen signature names this module).
import type { Eol } from '../shared/types'

/** The dominant EOL of `src` (CRLF only when CRLF lines outnumber bare-LF lines; '\n' for a doc with none). */
export function detectEol(src: string): Eol {
  const crlf = (src.match(/\r\n/g) ?? []).length
  const lf = (src.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/** Convert every line ending in `s` to `eol`. */
export function convertEol(s: string, eol: Eol): string {
  return eol === '\n' ? s.replace(/\r\n/g, '\n') : s.replace(/\r?\n/g, eol)
}

/** UTF-16 offsets at which each source line starts (line 1 starts at 0). */
export function lineStarts(src: string): number[] {
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/** 1-based line number of `offset`, given `lineStarts(src)`. */
export function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** true when the text ends with a line ending. */
export function hasFinalEol(src: string): boolean {
  return src.endsWith('\n')
}
