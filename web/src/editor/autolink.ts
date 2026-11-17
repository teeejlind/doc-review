// web/src/editor/autolink.ts (QA round 3). Addresses become links as they are typed or pasted, as in Google Docs:
// a URL, www. address or email followed by Space or Enter (Editing mode), and the ones in pasted plain text. A run is
// linked exactly as GFM would link it in the saved .md (core/md/autolink.ts), so the screen and the file agree.
import type { Mark, Node as PMNode, Schema } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { autolinkRuns, type AutolinkKind } from '../../../core/md/autolink'

export const hrefFor = (text: string, kind: AutolinkKind): string => (kind === 'www' ? `http://${text}` : kind === 'email' ? `mailto:${text}` : text)

/** Text nodes for `text` (no newlines), each address run carrying a link mark. */
export function linkifiedText(schema: Schema, text: string, marks: readonly Mark[] = []): PMNode[] {
  if (!text) return []
  const link = schema.marks.link
  const runs = link ? autolinkRuns(text, '', '') : []
  const out: PMNode[] = []
  let last = 0
  for (const r of runs) {
    if (r.start > last) out.push(schema.text(text.slice(last, r.start), marks))
    const t = text.slice(r.start, r.end)
    out.push(schema.text(t, link!.create({ href: hrefFor(t, r.kind), title: null }).addToSet(marks)))
    last = r.end
  }
  if (last < text.length) out.push(schema.text(text.slice(last), marks))
  return out
}

/** Does plain text hold an address that linkifiedText would link? */
export function hasAddress(text: string): boolean {
  return text.split(/\r?\n/).some((line) => autolinkRuns(line, '', '').length > 0)
}

/**
 * The address that ends right before `pos` (trailing punctuation allowed), linked; null when there is none, or it is
 * already a link, or in code. What Space or Enter after a typed address does.
 */
export function autolinkBefore(state: EditorState, pos: number): Transaction | null {
  const { link, inlineCode } = state.schema.marks
  const $p = state.doc.resolve(pos)
  const parent = $p.parent
  if (!link || !parent.isTextblock || parent.type.spec.code) return null
  const before = parent.textBetween(0, $p.parentOffset, undefined, '￼')
  let chunkStart = before.length
  while (chunkStart > 0 && !/[\s￼]/.test(before[chunkStart - 1]!)) chunkStart--
  const chunk = before.slice(chunkStart)
  if (!chunk) return null
  const runs = autolinkRuns(chunk, chunkStart > 0 ? before[chunkStart - 1]! : '', ' ')
  const r = runs[runs.length - 1]
  if (!r || chunk.slice(r.end).replace(/[?!.,:*_~'")]/g, '') !== '') return null
  const from = $p.start() + chunkStart + r.start
  const to = from + (r.end - r.start)
  if (state.doc.rangeHasMark(from, to, link) || (inlineCode && state.doc.rangeHasMark(from, to, inlineCode))) return null
  const text = chunk.slice(r.start, r.end)
  return state.tr.addMark(from, to, link.create({ href: hrefFor(text, r.kind), title: null }))
}
