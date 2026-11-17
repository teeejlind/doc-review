// core/splice/eq.ts (P1; lifted verbatim from spike/s2/src/splice.ts on day 0, CONTRACTS §0.2 item 2, §3.4).
//
// The ONLY ProseMirror equality in the codebase. planSave, applyBlockOps verification, updateLoaded (G2) and
// P2's tjSuggestionDiff / G5 all import from here; nobody writes a second equality. A view-plugin attr rewrite
// found beyond heading.id joins VOLATILE_ATTRS through a change request (D50).
import type { Node as PMNode } from '@milkdown/kit/prose/model'

/** Attributes the live editor mutates on its own (heading ids, ordered-list labels): not content. */
export const VOLATILE_ATTRS: Readonly<Record<string, readonly string[]>> = { heading: ['id'], list_item: ['label'] }

export function nodeEq(a: PMNode, b: PMNode): boolean {
  if (a === b) return true
  if (a.type !== b.type) return false
  if (a.isText) return a.text === b.text && sameMarks(a, b)
  const skip = VOLATILE_ATTRS[a.type.name] ?? []
  for (const k of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if (skip.includes(k)) continue
    if (JSON.stringify(a.attrs[k]) !== JSON.stringify(b.attrs[k])) return false
  }
  if (!sameMarks(a, b)) return false
  if (a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) if (!nodeEq(a.child(i), b.child(i))) return false
  return true
}
function sameMarks(a: PMNode, b: PMNode): boolean {
  if (a.marks.length !== b.marks.length) return false
  return a.marks.every((m, i) => m.eq(b.marks[i]!))
}

/** Top-level content nodes (the editor's empty typing-area paragraphs have no markdown form). */
export function contentNodes(doc: PMNode): PMNode[] {
  const out: PMNode[] = []
  doc.forEach((n) => {
    if (!(n.type.name === 'paragraph' && n.content.size === 0)) out.push(n)
  })
  return out
}

/** contentNodes(a) vs contentNodes(b), pairwise nodeEq. */
export function docsEquivalent(a: PMNode, b: PMNode): boolean {
  const x = contentNodes(a)
  const y = contentNodes(b)
  return x.length === y.length && x.every((n, i) => nodeEq(n, y[i]!))
}

const PHRASING_MARKS = new Set(['strong', 'emphasis', 'delete', 'link', 'linkReference'])

/**
 * Semantic normal form of an mdast subtree:
 * - drop positions and Milkdown's `data.isInline` bookkeeping
 * - flatten phrasing content into runs of (leaf, sorted mark set), so `[**x**](u)` and
 *   `**[x](u)**` compare equal: ProseMirror marks are a flat set and cannot keep nesting order,
 *   and both render identically
 * - line endings inside code spans become spaces (CommonMark renders them as spaces)
 * - empty paragraphs inside a list item or blockquote are dropped (QA2 30: `-` and `- <br />` are one empty item)
 */
export function normMdast(n: unknown): unknown {
  if (Array.isArray(n)) return n.map(normMdast)
  if (!n || typeof n !== 'object') return n
  const node = n as Record<string, unknown> & { type?: string; children?: unknown[] }
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'position' || k === 'children') continue
    if (k === 'data' && v && typeof v === 'object' && Object.keys(v).every((x) => x === 'isInline')) continue
    if (v === undefined || v === null) continue
    o[k] = v
  }
  if (node.type === 'inlineCode' && typeof o.value === 'string') o.value = (o.value as string).replace(/\r?\n/g, ' ')
  if (Array.isArray(node.children)) {
    const hasPhrasing = node.children.some((c) => PHRASING_MARKS.has((c as { type: string }).type) || (c as { type: string }).type === 'text')
    o.children = hasPhrasing ? flattenRuns(node.children, []) : node.children.map(normMdast)
    // an empty list item or quote line: a bare marker and Milkdown's `<br />` placeholder are the same thing
    if ((node.type === 'listItem' || node.type === 'blockquote') && !hasPhrasing) {
      o.children = (o.children as Array<{ type?: string; children?: unknown[] }>).filter((c) => !(c.type === 'paragraph' && (c.children?.length ?? 0) === 0))
    }
  }
  return o
}

function flattenRuns(children: unknown[], marks: string[]): unknown[] {
  const out: Array<Record<string, unknown>> = []
  const push = (leaf: Record<string, unknown>) => {
    const prev = out[out.length - 1]
    if (prev && prev.type === 'text' && leaf.type === 'text' && prev.marks === leaf.marks) prev.value = `${prev.value as string}${leaf.value as string}`
    else out.push(leaf)
  }
  for (const c of children) {
    const node = c as Record<string, unknown> & { type: string; children?: unknown[] }
    if (PHRASING_MARKS.has(node.type)) {
      const { children: kids, position: _p, ...attrs } = node
      const key = JSON.stringify(normMdast({ ...attrs }))
      flattenRuns(kids ?? [], [...marks, key]).forEach((x) => push(x as Record<string, unknown>))
    } else {
      const leaf = normMdast(node) as Record<string, unknown>
      push({ ...leaf, marks: [...marks].sort().join('|') })
    }
  }
  return out
}
