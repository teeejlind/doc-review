// web/src/editor/docdiff.ts (QA3 R1, server-store). Turn one ProseMirror doc into another with the smallest steps that
// keep everything untouched where it is.
//
// A draft restored after a reload is a whole saved doc. Swapping it in with one replace of [0, size) maps every
// position-based decoration (the comment highlights) to nothing, so the draft save reports each thread as deleted and
// the server detaches all of them. Replacing only what differs does what the typing itself would have done: a
// highlight in an untouched block does not move, one that text was typed into or cut from grows or shrinks, and only
// text that is really gone collapses.
//
// Shape of the diff: equal leading and trailing children are kept; if the middle run has the same number of children
// on both sides they are paired and diffed one by one (a textblock by its inline content, a container by recursing);
// otherwise the run is replaced as one piece.
import type { Fragment, Node as PMNode } from '@milkdown/kit/prose/model'
import { Slice } from '@milkdown/kit/prose/model'
import { Transform } from '@milkdown/kit/prose/transform'

const kids = (n: PMNode): PMNode[] => {
  const out: PMNode[] = []
  n.forEach((c) => out.push(c))
  return out
}

/** Inline content differs only between a common prefix and suffix: replace just that span. */
function diffInline(tr: Transform, x: PMNode, y: PMNode, pos: number): void {
  const start = x.content.findDiffStart(y.content)
  if (start === null) return
  const end = x.content.findDiffEnd(y.content)
  if (end === null) return
  let { a: endA, b: endB } = end
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) {
    endA += overlap
    endB += overlap
  }
  const inner = pos + 1
  tr.replace(inner + start, inner + endA, new Slice(y.content.cut(start, endB) as Fragment, 0, 0))
}

function diffNode(tr: Transform, x: PMNode, y: PMNode, pos: number): void {
  if (x.eq(y)) return
  if (x.sameMarkup(y)) {
    if (x.isTextblock) return diffInline(tr, x, y, pos)
    if (!x.isLeaf) return diffChildren(tr, x, y, pos + 1)
  }
  tr.replaceWith(pos, pos + x.nodeSize, y)
}

/** `inner` is the position of the first child of `x` in the doc as it is before any step of this run. */
function diffChildren(tr: Transform, x: PMNode, y: PMNode, inner: number): void {
  const a = kids(x)
  const b = kids(y)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre]!.eq(b[pre]!)) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf]!.eq(b[b.length - 1 - suf]!)) suf++
  const midA = a.slice(pre, a.length - suf)
  const midB = b.slice(pre, b.length - suf)
  if (midA.length === 0 && midB.length === 0) return
  let from = inner
  for (let i = 0; i < pre; i++) from += a[i]!.nodeSize
  if (midA.length === midB.length) {
    // pairs from the last to the first: a step at a later sibling never moves an earlier one
    const at: number[] = []
    let p = from
    for (const n of midA) {
      at.push(p)
      p += n.nodeSize
    }
    for (let i = midA.length - 1; i >= 0; i--) diffNode(tr, midA[i]!, midB[i]!, at[i]!)
    return
  }
  const to = from + midA.reduce((s, n) => s + n.nodeSize, 0)
  if (midB.length === 0) tr.delete(from, to)
  else tr.replaceWith(from, to, midB)
}

/**
 * The steps that turn `from` into `to` (same schema), as a Transform over `from`, or null if the result is not
 * `to` (the caller then replaces the whole doc).
 */
export function docDiffSteps(from: PMNode, to: PMNode): Transform | null {
  const tr = new Transform(from)
  try {
    if (from.sameMarkup(to)) diffChildren(tr, from, to, 0)
    else return null
  } catch {
    return null
  }
  return tr.doc.eq(to) ? tr : null
}
