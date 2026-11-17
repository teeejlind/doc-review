// core/splice/render.ts (P1; lifted verbatim from spike/s2/src/splice.ts on day 0, CONTRACTS §3.4).
//
// Rendering and seam helpers shared by load(), planSave, applyBlockOps and the corpus oracle
// (tests/corpus/oracle-save.ts = S2's save()): per-node rendering in the doc's EOL, the standalone block parse
// with the doc's definitions as context, the 3-way region splice (FINDINGS failure category 5), and the
// list-merge marker helpers (category 4, D36).
import DiffMatchPatch from 'diff-match-patch'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { Eol } from '../../shared/types'
import type { Md } from '../md/index'
import { SuggestionResidueError } from '../md/schema'

const dmp = new DiffMatchPatch()
dmp.Patch_Margin = 8

// ------------------------------------------------------------------ helpers

export const toEol = (s: string, eol: string): string => (eol === '\n' ? s.replace(/\r\n/g, '\n') : s.replace(/\r?\n/g, eol))

export type MdastNode = {
  type: string
  position?: { start: { offset: number }; end: { offset: number } }
  children?: MdastNode[]
  ordered?: boolean
}

/** Milkdown's own configured remark parse + transform, so the mdast is identical to what the editor sees. */
export function parseMdast(md: Md, text: string): MdastNode {
  return md.remark.runSync(md.remark.parse(text), text) as unknown as MdastNode
}

/** Parse a block's markdown on its own (with the doc's definitions as context). */
export function parseBlock(md: Md, text: string, defs: string): PMNode[] {
  const doc = md.parseDoc(defs ? text + '\n\n' + defs : text)
  const nodes: PMNode[] = []
  doc.forEach((n) => nodes.push(n))
  if (!defs) return nodes
  // drop the trailing nodes that came from the definitions themselves
  const defNodes = md.parseDoc(defs).childCount
  return nodes.slice(0, Math.max(0, nodes.length - defNodes))
}

/** Serialize one top-level node as source text (no trailing newline), in the doc's EOL style. */
export function renderNode(md: Md, node: PMNode, eol: Eol): string {
  if (node.type.name === 'raw_block') return node.attrs.value as string
  const s = md.serializeNodes([node]).replace(/(\r?\n)+$/, '')
  return toEol(s, eol)
}

export function assertNoSuggestionMarks(doc: PMNode): void {
  const names = new Set(['insertion', 'deletion', 'modification'])
  doc.descendants((n) => {
    for (const m of n.marks) if (names.has(m.type.name)) throw new SuggestionResidueError(`pending suggestion mark "${m.type.name}" in doc at save`)
    return true
  })
}

// ------------------------------------------------------------------ list-merge protection (D36)

/** First-item marker of a top-level list in `text` ('-', '*', '+', '.', ')'), or null. */
export function listMarker(md: Md, text: string): { kind: 'bullet' | 'ordered'; ch: string } | null {
  const tree = parseMdast(md, text)
  const list = tree.children?.[0]
  if (!list || list.type !== 'list' || !list.children?.length) return null
  const off = list.children[0]!.position!.start.offset
  if (!list.ordered) return { kind: 'bullet', ch: text[off]! }
  const m = /^\d+([.)])/.exec(text.slice(off))
  return m ? { kind: 'ordered', ch: m[1]! } : null
}

/** Swap a top-level list's item markers ('-'<->'*', '.'<->')') so it can't merge with a neighbour. */
export function swapListMarkers(md: Md, text: string): string {
  const tree = parseMdast(md, text)
  const list = tree.children?.[0]
  if (!list || list.type !== 'list') return text
  const chars = text.split('')
  for (const item of list.children ?? []) {
    const off = item.position!.start.offset
    if (!list.ordered) chars[off] = chars[off] === '-' ? '*' : '-'
    else {
      let k = off
      while (/\d/.test(chars[k]!)) k++
      chars[k] = chars[k] === '.' ? ')' : '.'
    }
  }
  return chars.join('')
}

// ------------------------------------------------------------------ 3-way helpers

/**
 * 3-way region splice: the changed regions between A and B have their boundaries mapped into S through diff(A, S),
 * and B's regions replace S's. Changes separated by an unchanged stretch holding a line break are separate regions
 * (QA3: a table's header cell and a body cell edited in one save replaced everything between them, so the delimiter
 * row in between came back normalized); with a single region this is the original single-region splice.
 */
export function regionSplice(A: string, B: string, S: string): string | null {
  if (A === B) return S
  // char-level hunks of A -> B: [a0, a1) in A replaced by [b0, b1) of B
  const d = dmp.diff_main(A, B, false)
  const hunks: Array<{ a0: number; a1: number; b0: number; b1: number }> = []
  let a = 0
  let b = 0
  let cur: { a0: number; a1: number; b0: number; b1: number } | null = null
  for (const [op, text] of d) {
    if (op === 0) {
      if (cur && /\n/.test(text)) {
        hunks.push(cur)
        cur = null
      }
      a += text.length
      b += text.length
      continue
    }
    cur ??= { a0: a, a1: a, b0: b, b1: b }
    if (op === -1) a += text.length
    else b += text.length
    cur.a1 = a
    cur.b1 = b
  }
  if (cur) hunks.push(cur)
  // widen each to whole tokens so a mapped boundary never lands inside an escape sequence or marker run
  const token = /[\\*_~`[\]]/
  hunks.forEach((h, k) => {
    const lo = k > 0 ? hunks[k - 1]!.a1 : 0
    const hi = k + 1 < hunks.length ? hunks[k + 1]!.a0 : A.length
    while (h.a0 > lo && token.test(A[h.a0 - 1]!)) {
      h.a0--
      h.b0--
    }
    while (h.a1 < hi && token.test(A[h.a1]!)) {
      h.a1++
      h.b1++
    }
  })
  const diffs = dmp.diff_main(A, S, false)
  let out = ''
  let sAt = 0
  for (const h of hunks) {
    const s0 = dmp.diff_xIndex(diffs, h.a0)
    const s1 = dmp.diff_xIndex(diffs, h.a1)
    if (s1 < s0 || s0 < sAt) return null
    out += S.slice(sAt, s0) + B.slice(h.b0, h.b1)
    sAt = s1
  }
  return out + S.slice(sAt)
}

export function dmpPatch(A: string, B: string, S: string): string | null {
  const [R, oks] = dmp.patch_apply(dmp.patch_make(A, B), S) as [string, boolean[]]
  return oks.every(Boolean) ? R : null
}
