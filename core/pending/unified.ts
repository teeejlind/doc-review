// core/pending/unified.ts (P4, pure). The unified line diff `pending` uses for change.format 'diff' (CONTRACTS §9.6):
// diff-match-patch over lines, `context` lines of context (3 by default), standard `@@ -a,b +c,d @@` hunk headers.
// Kept here rather than borrowed from core/diff.ts so the digest's output does not move when P1 reshapes that module.
import DiffMatchPatch from 'diff-match-patch'

const dmp = new DiffMatchPatch()

interface Line { op: -1 | 0 | 1; text: string }

/** Unified diff of `a` → `b`. Empty string when equal. Lines without a final newline get the usual marker line. */
export function unifiedDiff(a: string, b: string, context = 3): string {
  if (a === b) return ''
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b)
  const diffs = dmp.diff_main(chars1, chars2, false)
  dmp.diff_charsToLines_(diffs, lineArray)
  const lines: Line[] = []
  for (const [op, text] of diffs) {
    for (const line of text.split(/(?<=\n)/)) if (line !== '') lines.push({ op: op as Line['op'], text: line })
  }
  const changed: number[] = []
  lines.forEach((l, i) => {
    if (l.op !== 0) changed.push(i)
  })
  if (!changed.length) return ''
  const groups: Array<[number, number]> = []
  for (const i of changed) {
    const g = groups[groups.length - 1]
    if (g && i - g[1] <= 2 * context + 1) g[1] = i
    else groups.push([i, i])
  }
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
    const oldStart = oldLen === 0 ? oldAt[from]! - 1 : oldAt[from]!
    const newStart = newLen === 0 ? newAt[from]! - 1 : newAt[from]!
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n`)
    for (const l of slice) {
      const body = l.text.endsWith('\n') ? l.text : l.text + '\n\\ No newline at end of file\n'
      out.push((l.op === 0 ? ' ' : l.op < 0 ? '-' : '+') + body)
    }
  }
  return out.join('')
}
