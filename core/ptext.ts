// core/ptext.ts (P1). The shared anchor text (CONTRACTS §5.1, normative).
//
// One document-order traversal:
//  1. every textblock (paragraph, heading, code_block, and every textblock nested in list items, blockquotes, table
//     cells or footnote definitions) contributes its inline text: text verbatim with marks dropped, hardbreak → '\n',
//     any inline leaf without text (image, inline html, footnote_reference) → U+FFFC;
//  2. every atom block (§3.3: PM frontmatter, raw_block, hr) contributes the single segment U+FFFC;
//  3. segments are joined by '\n';
//  4. top-level empty paragraphs are skipped entirely (no text, no separator); nested empty textblocks contribute an
//     empty segment;
//  5. no Unicode normalization, no Intl.
//
// Offsets map linearly onto PM positions inside a segment (each inline child is one position per UTF-16 unit of its
// ptext), so toPos / toOffset are a binary search over the segment table. `segmentsOf` exposes the same traversal per
// block, so updateLoaded's incremental block map can never drift from ptextOf.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { Loaded } from './splice/load'

export interface PText {
  text: string
  blockRanges: Array<{ index: number; pStart: number; pEnd: number }>   // per load() entry
  toPos(offset: number, bias: -1 | 1): number      // ptext offset -> PM pos in the doc it was built from
  toOffset(pos: number): number | null             // PM pos -> ptext offset; null inside skipped content
  blockAt(offset: number): { index: number; offsetInBlock: number }
}

/** U+FFFC OBJECT REPLACEMENT CHARACTER: the ptext of an inline leaf or an atom block. */
export const OBJ = '￼'
/** §3.3: the PM nodes of atom blocks. */
export const ATOM_BLOCK_NODES: ReadonlySet<string> = new Set(['frontmatter', 'raw_block', 'hr'])

/** One ptext segment and the PM position range it maps onto, linearly. */
interface Seg { pStart: number; pEnd: number; posStart: number; posEnd: number }

/** The ptext of a textblock's inline content. */
export function inlineText(node: PMNode): string {
  let s = ''
  node.forEach((child) => {
    if (child.isText) s += child.text ?? ''
    else if (child.type.name === 'hardbreak') s += '\n'
    else s += OBJ
  })
  return s
}

const isEmptyPara = (n: PMNode): boolean => n.type.name === 'paragraph' && n.content.size === 0

/** Visit `node`'s segments in document order. `pos` = the PM position right before `node`. */
function walk(node: PMNode, pos: number, push: (text: string, posStart: number, posEnd: number) => void): void {
  if (ATOM_BLOCK_NODES.has(node.type.name)) return push(OBJ, pos, pos + node.nodeSize)
  if (node.isTextblock) return push(inlineText(node), pos + 1, pos + 1 + node.content.size)
  if (node.isLeaf) return push(OBJ, pos, pos + node.nodeSize)
  node.forEach((child, offset) => walk(child, pos + 1 + offset, push))
}

/** The ptext segments of a block's top-level nodes (top-level empty paragraphs skipped). Its ptext is `join('\n')`. */
export function segmentsOf(nodes: readonly PMNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) if (!isEmptyPara(n)) walk(n, 0, (t) => out.push(t))
  return out
}

export function ptextOf(doc: PMNode, L: Pick<Loaded, 'entries'>): PText {
  const parts: string[] = []
  const segs: Seg[] = []
  let off = 0

  const pushSeg = (text: string, posStart: number, posEnd: number): void => {
    if (segs.length) {
      parts.push('\n')
      off += 1
    }
    segs.push({ pStart: off, pEnd: off + text.length, posStart, posEnd })
    parts.push(text)
    off += text.length
  }

  // top-level content nodes (empty paragraphs never belong to an entry and have no ptext)
  const top: Array<{ node: PMNode; pos: number }> = []
  doc.forEach((node, offset) => {
    if (!isEmptyPara(node)) top.push({ node, pos: offset })
  })

  const blockRanges: PText['blockRanges'] = []
  let t = 0
  L.entries.forEach((entry, index) => {
    const first = segs.length
    for (let k = 0; k < entry.nodes.length && t < top.length; k++, t++) {
      if (isEmptyPara(entry.nodes[k]!)) {
        t--
        continue
      }
      walk(top[t]!.node, top[t]!.pos, pushSeg)
    }
    if (segs.length > first) blockRanges.push({ index, pStart: segs[first]!.pStart, pEnd: segs[segs.length - 1]!.pEnd })
    else blockRanges.push({ index, pStart: off, pEnd: off })
  })
  // nodes beyond the entries (a live doc that grew since load): still part of the text, in no block range
  for (; t < top.length; t++) walk(top[t]!.node, top[t]!.pos, pushSeg)

  const text = parts.join('')

  /** Index of the first segment whose pEnd >= offset (every offset in [0, len] is in a closed segment range). */
  const segAtOffset = (offset: number): number => {
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid]!.pEnd < offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const toPos = (offset: number, bias: -1 | 1): number => {
    if (!segs.length) return 0
    const o = Math.max(0, Math.min(offset, text.length))
    const k = segAtOffset(o)
    const s = segs[k]!
    // at a segment start right after a separator, bias -1 means "the end of the previous segment"
    if (bias === -1 && k > 0 && o === s.pStart) return segs[k - 1]!.posEnd
    return s.posStart + Math.min(o - s.pStart, s.posEnd - s.posStart)
  }

  const toOffset = (pos: number): number | null => {
    // the first segment whose posEnd >= pos; touching segments (two adjacent atoms) resolve to the earlier one
    let lo = 0
    let hi = segs.length - 1
    let ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid]!.posEnd >= pos) {
        ans = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    if (ans < 0) return null
    const s = segs[ans]!
    if (pos < s.posStart) return null
    return s.pStart + Math.min(pos - s.posStart, s.pEnd - s.pStart)
  }

  const blockAt = (offset: number): { index: number; offsetInBlock: number } => {
    if (!blockRanges.length) return { index: 0, offsetInBlock: offset }
    // the first block whose closed range reaches `offset`
    let lo = 0
    let hi = blockRanges.length - 1
    let ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (blockRanges[mid]!.pEnd >= offset) {
        ans = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    if (ans < 0) {
      const last = blockRanges[blockRanges.length - 1]!
      return { index: last.index, offsetInBlock: offset - last.pStart }
    }
    const r = blockRanges[ans]!
    return { index: r.index, offsetInBlock: Math.max(0, offset - r.pStart) }
  }

  return { text, blockRanges, toPos, toOffset, blockAt }
}
