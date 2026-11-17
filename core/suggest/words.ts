// core/suggest/words.ts (QA round 1). Word-level diff for suggestions.
//
// A suggestion's display hunks (the card, `mdr pending`) and its inline track changes (hydrate) used to come from a
// character diff, which cut words in half ("12%" → "11.5%" was {2 → 1.5}). Both now come from here: the two strings
// are split into tokens (words, numbers with their $ / % / separators, contractions, hyphenated words, runs of
// whitespace, single punctuation marks), dmp diffs the token sequences, and each changed run is a span over whole
// tokens. Applying every span to `a` gives `b` exactly.
//
// Rules on top of the plain token diff:
//   - an insert-only or delete-only run never starts with whitespace that the next token repeats (the space moves to the
//     end: "lead-gen " rather than " lead-gen"), so it reads as a word;
//   - changed runs separated only by whitespace are one span (two neighbouring words swapped read as one phrase swap).
// `keysA` / `keysB` (one per UTF-16 unit) make equal text with different keys (marks, atoms) a change.
import DiffMatchPatch from 'diff-match-patch'

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 0

export interface WordSpan {
  /** [a0, a1) in `a` and [b0, b1) in `b`, UTF-16 offsets on token boundaries. */
  a0: number
  a1: number
  b0: number
  b1: number
}

interface Tok {
  start: number
  end: number
}

const W = '[\\p{L}\\p{N}\\p{M}_]'
// [$€£]?word(('|’|-|digit-separator)word)*%?  |  whitespace run  |  any other single code point
const TOKEN = new RegExp(`[$€£]?${W}+(?:(?:['’-]|(?<=\\p{N})[.,](?=\\p{N}))${W}+)*%?|\\s+|[\\s\\S]`, 'gu')
const WS = /^\s+$/

/** 55k distinct tokens fit one UTF-16 unit each; a single block never gets near it. */
const MAX_TOKENS = 0xd800 - 0x100

function tokenize(s: string): Tok[] {
  const out: Tok[] = []
  for (const m of s.matchAll(TOKEN)) out.push({ start: m.index, end: m.index + m[0].length })
  return out
}

export function wordSpans(a: string, b: string, keysA?: readonly string[], keysB?: readonly string[]): WordSpan[] {
  const ta = tokenize(a)
  const tb = tokenize(b)
  const keyOf = (s: string, keys: readonly string[] | undefined, t: Tok): string => (keys ? keys.slice(t.start, t.end).join('\u0001') : s.slice(t.start, t.end))
  const ka = ta.map((t) => keyOf(a, keysA, t))
  const kb = tb.map((t) => keyOf(b, keysB, t))
  const ids = new Map<string, number>()
  const chr = (k: string): string => {
    let id = ids.get(k)
    if (id === undefined) {
      id = ids.size
      ids.set(k, id)
    }
    return String.fromCharCode(id + 0x100)
  }
  const sa = ka.map(chr).join('')
  const sb = kb.map(chr).join('')
  if (ids.size > MAX_TOKENS) return a === b && !keysA ? [] : [{ a0: 0, a1: a.length, b0: 0, b1: b.length }]

  interface Region {
    a0: number
    a1: number
    b0: number
    b1: number
  }
  const regions: Region[] = []
  let cur: Region | null = null
  let ia = 0
  let ib = 0
  for (const [op, text] of dmp.diff_main(sa, sb, false)) {
    const n = text.length
    if (op === 0) {
      if (cur) regions.push(cur)
      cur = null
      ia += n
      ib += n
      continue
    }
    cur ??= { a0: ia, a1: ia, b0: ib, b1: ib }
    if (op < 0) {
      ia += n
      cur.a1 = ia
    } else {
      ib += n
      cur.b1 = ib
    }
  }
  if (cur) regions.push(cur)

  // leading whitespace of a pure insert / delete moves to the end when the following token repeats it
  const isWs = (s: string, t: Tok | undefined): boolean => !!t && WS.test(s.slice(t.start, t.end))
  for (const r of regions) {
    if (r.a0 === r.a1) {
      while (r.b1 < tb.length && isWs(b, tb[r.b0]) && kb[r.b0] === kb[r.b1]) {
        r.a0++
        r.a1++
        r.b0++
        r.b1++
      }
    } else if (r.b0 === r.b1) {
      while (r.a1 < ta.length && isWs(a, ta[r.a0]) && ka[r.a0] === ka[r.a1]) {
        r.a0++
        r.a1++
        r.b0++
        r.b1++
      }
    }
  }

  // changed runs separated by nothing but whitespace are one span
  const merged: Region[] = []
  for (const r of regions) {
    const last = merged[merged.length - 1]
    if (last) {
      let between = true
      for (let i = last.a1; i < r.a0; i++) if (!isWs(a, ta[i])) between = false
      if (between) {
        last.a1 = r.a1
        last.b1 = r.b1
        continue
      }
    }
    merged.push({ ...r })
  }

  const off = (t: Tok[], i: number, len: number): number => (i < t.length ? t[i]!.start : len)
  return merged.map((r) => {
    const a0 = off(ta, r.a0, a.length)
    const b0 = off(tb, r.b0, b.length)
    return { a0, a1: r.a1 > r.a0 ? ta[r.a1 - 1]!.end : a0, b0, b1: r.b1 > r.b0 ? tb[r.b1 - 1]!.end : b0 }
  })
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_%$€£'’-]/u

/**
 * The span of `text` (the base ptext) that a suggestion's card quotes: from the first hunk's start to the last hunk's
 * end, so the card names the whole phrase being changed. A pure insertion has nothing to quote, so it takes the word
 * before it (or the word after it at the start of the text). null when `hunks` is empty.
 */
export function phraseSpan(hunks: readonly { del: string; at: number }[], text: string): { from: number; to: number } | null {
  const first = hunks[0]
  const last = hunks[hunks.length - 1]
  if (!first || !last) return null
  const clamp = (n: number): number => Math.max(0, Math.min(n, text.length))
  let from = clamp(first.at)
  let to = Math.max(from, clamp(last.at + last.del.length))
  if (from < to) return { from, to }
  // back over spaces and punctuation to the word before, never across a block separator: an insertion at the end of
  // a paragraph ("text.|") quotes its last word, not the next block's first word (QA3)
  let i = from
  while (i > 0 && text[i - 1] !== '\n' && !WORD_CHAR.test(text[i - 1]!)) i--
  const wordEnd = i
  while (i > 0 && WORD_CHAR.test(text[i - 1]!)) i--
  if (i < wordEnd) return { from: i, to: wordEnd }
  i = to
  while (i < text.length && text[i] !== '\n' && /\s/.test(text[i]!)) i++
  const wordStart = i
  while (i < text.length && WORD_CHAR.test(text[i]!)) i++
  if (i > wordStart) {
    from = wordStart
    to = i
  }
  return { from, to }
}
