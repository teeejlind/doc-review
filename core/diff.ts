// core/diff.ts (P1). Block changes with windowed BlockSide text (CONTRACTS §7.1 "BlockSide text", D33) and the text
// diffs history (§10, DiffBlock.inline) and pending (§9.6, change.format 'diff') render.
//
// BlockSide.md (§7.1): the whole run when it is <= CHANGE_MD_CAP chars; otherwise, for a replace, each side's changed
// middle (after the common prefix/suffix of both full texts) plus CHANGE_MD_CONTEXT chars each side, with
// window { offset, total }; a changed middle over the cap is cut to its first CHANGE_MD_CAP chars with
// truncated: true; inserts and deletes over the cap store the first CHANGE_MD_CAP chars, window { offset: 0, total },
// truncated: true. A window is never a bare prefix of an unchanged region.
// No frozen signature names this module.
import DiffMatchPatch from 'diff-match-patch'
import type { BlockChange, BlockInfo, BlockSide } from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { diffBlocks } from './blocks'

const { CHANGE_MD_CAP, CHANGE_MD_CONTEXT } = CONSTANTS
const dmp = new DiffMatchPatch()

/** A document at one rev: its BOM-stripped source and block map. */
export interface DocSide { src: string; blocks: readonly Pick<BlockInfo, 'hash' | 'start' | 'end'>[] }

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let k = 0
  while (k < max && a[k] === b[k]) k++
  return k
}

/** md / window / truncated for one side's full run text (§7.1). `other` = the opposite side's run for a replace. */
export function sideText(full: string, other: string | null): Pick<BlockSide, 'md' | 'window' | 'truncated'> {
  if (full.length <= CHANGE_MD_CAP) return { md: full }
  if (other === null) return { md: full.slice(0, CHANGE_MD_CAP), window: { offset: 0, total: full.length }, truncated: true }
  const pre = commonPrefixLen(full, other)
  const max = Math.min(full.length, other.length) - pre
  let suf = 0
  while (suf < max && full[full.length - 1 - suf] === other[other.length - 1 - suf]) suf++
  const midStart = pre
  const midEnd = full.length - suf
  if (midEnd - midStart > CHANGE_MD_CAP) {
    return { md: full.slice(midStart, midStart + CHANGE_MD_CAP), window: { offset: midStart, total: full.length }, truncated: true }
  }
  const ws = Math.max(0, midStart - CHANGE_MD_CONTEXT)
  const we = Math.min(full.length, midEnd + CHANGE_MD_CONTEXT)
  return { md: full.slice(ws, we), window: { offset: ws, total: full.length } }
}

function runOf(side: DocSide, index: number, count: number): { start: number; end: number; text: string } {
  if (count === 0) {
    const at = index < side.blocks.length ? side.blocks[index]!.start : side.src.length
    return { start: at, end: at, text: '' }
  }
  const start = side.blocks[index]!.start
  const end = side.blocks[index + count - 1]!.end
  return { start, end, text: side.src.slice(start, end) }
}

/** One BlockSide for blocks [index, index + count) of `side`; `other` = the opposite run's text for a replace. */
export function blockSide(side: DocSide, index: number, count: number, other: string | null): BlockSide {
  const run = runOf(side, index, count)
  return {
    index, count,
    hashes: side.blocks.slice(index, index + count).map((b) => b.hash),
    start: run.start, end: run.end,
    ...sideText(run.text, other),
  }
}

/** BlockChange[] between two revs: diffBlocks over the block maps, sides windowed per §7.1. */
export function blockChanges(before: DocSide, after: DocSide): BlockChange[] {
  const out: BlockChange[] = []
  for (const d of diffBlocks([...before.blocks], [...after.blocks])) {
    if (d.op === 'equal') continue
    if (d.op === 'insert') out.push({ op: 'insert', before: null, after: blockSide(after, d.b, d.bn, null) })
    else if (d.op === 'delete') out.push({ op: 'delete', before: blockSide(before, d.a, d.an, null), after: null })
    else {
      const a = runOf(before, d.a, d.an).text
      const b = runOf(after, d.b, d.bn).text
      out.push({ op: 'replace', before: blockSide(before, d.a, d.an, b), after: blockSide(after, d.b, d.bn, a) })
    }
  }
  return out
}

/** Word-level dmp diff (DiffBlock.inline, §10): tokens are whitespace runs and non-whitespace runs. */
export function wordDiff(a: string, b: string): Array<[op: -1 | 0 | 1, text: string]> {
  const tokens: string[] = []
  const index = new Map<string, number>()
  const encode = (s: string): string => {
    let out = ''
    for (const t of s.match(/\s+|\S+/g) ?? []) {
      let k = index.get(t)
      if (k === undefined) {
        k = tokens.length
        tokens.push(t)
        index.set(t, k)
      }
      out += String.fromCharCode(k + 1)
    }
    return out
  }
  const ea = encode(a)
  const eb = encode(b)
  const diffs = dmp.diff_main(ea, eb, false)
  dmp.diff_cleanupSemantic(diffs)
  return diffs.map(([op, chars]) => {
    let text = ''
    for (let i = 0; i < chars.length; i++) text += tokens[chars.charCodeAt(i) - 1]!
    return [op as -1 | 0 | 1, text]
  })
}

/** Unified line diff with `context` lines (pending change.format 'diff', §9.6). Empty string when equal. */
export function unifiedDiff(a: string, b: string, context = 3): string {
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b)
  const diffs = dmp.diff_main(chars1, chars2, false)
  dmp.diff_charsToLines_(diffs, lineArray)
  const lines: Array<{ op: -1 | 0 | 1; text: string }> = []
  for (const [op, text] of diffs) {
    for (const line of text.split(/(?<=\n)/)) if (line !== '') lines.push({ op: op as -1 | 0 | 1, text: line })
  }
  const changed = lines.map((l, i) => (l.op !== 0 ? i : -1)).filter((i) => i >= 0)
  if (!changed.length) return ''
  // group changed lines whose gap is <= 2 * context
  const groups: Array<[number, number]> = []
  for (const i of changed) {
    const g = groups[groups.length - 1]
    if (g && i - g[1] <= 2 * context + 1) g[1] = i
    else groups.push([i, i])
  }
  // old/new line numbers before each index
  const oldAt: number[] = []
  const newAt: number[] = []
  let o = 1
  let n = 1
  for (const l of lines) {
    oldAt.push(o)
    newAt.push(n)
    if (l.op <= 0) o++
    if (l.op >= 0) n++
  }
  const out: string[] = []
  for (const [s, e] of groups) {
    const from = Math.max(0, s - context)
    const to = Math.min(lines.length - 1, e + context)
    const slice = lines.slice(from, to + 1)
    const oldLen = slice.filter((l) => l.op <= 0).length
    const newLen = slice.filter((l) => l.op >= 0).length
    out.push(`@@ -${oldAt[from]},${oldLen} +${newAt[from]},${newLen} @@\n`)
    for (const l of slice) {
      const body = l.text.endsWith('\n') ? l.text : l.text + '\n\\ No newline at end of file\n'
      out.push((l.op === 0 ? ' ' : l.op < 0 ? '-' : '+') + body)
    }
  }
  return out.join('')
}
