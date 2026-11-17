// core/status-header.ts (P2, pure). Body status header detection (CONTRACTS §12.12 B, R1.8, D30).
//
// detectStatusHeader finds the status paragraph (a `Status:` label line, or a header status phrase) in the first
// STATUS_HEADER_SCAN_BLOCKS top-level entries after frontmatter (the first heading not counted), and returns its
// fields and phrases. The block stays an ordinary paragraph everywhere: this module only reads it.
//
// Two entry points over one algorithm:
// - detectStatusHeader(L): the loaded-file view; rule `label` tests each candidate's SOURCE first line (after an
//   optional `> `) against STATUS_LINE_RE, exactly as §12.12 states it.
// - detectStatusHeaderInDoc(doc): the editor's live view, re-derived on every transaction. It has no source, so it
//   rebuilds the first line from the paragraph's inline nodes (bold text wrapped in `**`), which the label regex reads
//   the same way. tests/unit/core/status-header asserts both agree over the fixtures and the corpus.
// Fields, `status` and `phrases` come from the paragraph's text (ptext: marks dropped, hardbreak = line end), so
// backticks and emphasis markers never reach a chip.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { CONSTANTS } from '../shared/constants'
import type { StatusHeaderInfo } from '../shared/types'
import type { Loaded } from './splice/load'

/** §12.12 B rule `label`: a bold `Status` label (colon inside or outside the bold), or a plain `Status:` (capital S). */
export const STATUS_LINE_RE: readonly RegExp[] = [
  /^(?:\*\*|__)Status(?::(?:\*\*|__)|(?:\*\*|__):)\s*\S/i,
  /^Status:\s+\S/,
]

/** §12.12 B rule `phrase`: the header status phrases. */
const PHRASE_RE = /draft only|needs legal review|potential style issues flagged|needs [^·\n]*sign-off|blocked:|approved per/i

const STATUS_MAX = 80
const SEP = ' · '
const OBJ = '￼'

/** One top-level block, as the detector sees it. */
interface Block {
  index: number
  /** The block's single PM node (null for multi-node or raw entries). */
  node: PMNode | null
  frontmatter: boolean
  heading: boolean
  /** Source first line (L path) or the rebuilt one (live path); null = not a candidate. */
  firstLine: string | null
}

/** The paragraph of a candidate: a top-level paragraph, or a blockquote whose only child is a paragraph. */
export function statusParagraphOf(n: PMNode | null): PMNode | null {
  if (!n) return null
  if (n.type.name === 'paragraph') return n
  if (n.type.name === 'blockquote' && n.childCount === 1 && n.firstChild!.type.name === 'paragraph') return n.firstChild
  return null
}

// ------------------------------------------------------------------ inline text model

interface Tok { text: string; bold: boolean; br: boolean }

/** The paragraph's inline content as text tokens (consecutive same-weight text merged; hardbreak = line end). */
function tokens(para: PMNode): Tok[] {
  const out: Tok[] = []
  para.forEach((n) => {
    if (n.type.name === 'hardbreak') {
      out.push({ text: '', bold: false, br: true })
      return
    }
    const text = n.isText ? (n.text ?? '') : OBJ
    const bold = n.marks.some((m) => m.type.name === 'strong')
    // a soft line break inside a text node ends the line too
    text.split('\n').forEach((p, i) => {
      if (i > 0) out.push({ text: '', bold: false, br: true })
      if (!p) return
      const last = out[out.length - 1]
      if (last && !last.br && last.bold === bold) last.text += p
      else out.push({ text: p, bold, br: false })
    })
  })
  return out
}

/** Plain text of the paragraph's first line (ptext rules: marks dropped, inline atoms are U+FFFC). */
function plainFirstLine(para: PMNode): string {
  let s = ''
  for (const t of tokens(para)) {
    if (t.br) break
    s += t.text
  }
  return s
}

/** The first line rebuilt as markdown-ish source: bold runs wrapped in `**` (enough for STATUS_LINE_RE). */
function rebuiltFirstLine(para: PMNode): string {
  let s = ''
  for (const t of tokens(para)) {
    if (t.br) break
    s += t.bold ? `**${t.text}**` : t.text
  }
  return s
}

function cleanValue(v: string): string {
  let s = v.split(OBJ).join('').trim()
  for (;;) {
    const next = s.replace(/^`+|`+$/g, '').replace(/\s*·\s*$/, '').trim()
    if (next === s) return s
    s = next
  }
}

function cleanStatus(v: string): string {
  const s = cleanValue(v).replace(/`/g, '').replace(/\s+/g, ' ').trim()
  return s.length > STATUS_MAX ? `${s.slice(0, STATUS_MAX - 1)}…` : s
}

/** Every bold label (`**Label:**` or `**Label**:`) with its value: the text up to the next bold label or line end. */
export function statusFields(para: PMNode): Array<{ label: string; value: string }> {
  const toks = tokens(para)
  const labels: Array<{ at: number; label: string; skip: boolean }> = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (!t.bold || t.br) continue
    const inside = /^([\s\S]*?):\s*$/.exec(t.text)
    if (inside && inside[1]!.trim()) {
      labels.push({ at: i, label: inside[1]!.trim(), skip: false })
      continue
    }
    const next = toks[i + 1]
    if (next && !next.br && !next.bold && next.text.startsWith(':') && t.text.trim()) labels.push({ at: i, label: t.text.trim(), skip: true })
  }
  return labels.map((l, k) => {
    const end = k + 1 < labels.length ? labels[k + 1]!.at : toks.length
    let v = ''
    for (let i = l.at + 1; i < end; i++) {
      const t = toks[i]!
      if (t.br) break
      v += i === l.at + 1 && l.skip ? t.text.slice(1) : t.text
    }
    return { label: l.label, value: cleanValue(v) }
  })
}

/** Split `status` on ' · ', keeping a separator inside a bracketed annotation in its phrase. */
export function statusPhrases(status: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < status.length; i++) {
    const c = status[i]!
    if (c === '[' || c === '(') depth++
    else if ((c === ']' || c === ')') && depth > 0) depth--
    if (depth === 0 && status.startsWith(SEP, i)) {
      out.push(cur)
      cur = ''
      i += SEP.length - 1
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

// ------------------------------------------------------------------ the detector

function scanWindow(blocks: readonly Block[]): Block[] {
  let k = 0
  while (k < blocks.length && blocks[k]!.frontmatter) k++
  const window: Block[] = []
  let skippedHeading = false
  for (; k < blocks.length && window.length < CONSTANTS.STATUS_HEADER_SCAN_BLOCKS; k++) {
    const b = blocks[k]!
    if (!skippedHeading && b.heading) {
      skippedHeading = true
      continue
    }
    window.push(b)
  }
  return window
}

function detectIn(blocks: readonly Block[]): StatusHeaderInfo | null {
  const window = scanWindow(blocks)
  // rule `label`: the first candidate whose first line is a Status label line
  for (const b of window) {
    const para = statusParagraphOf(b.node)
    if (!para || b.firstLine === null) continue
    const line = b.firstLine.replace(/^>[ \t]?/, '')
    if (!STATUS_LINE_RE.some((re) => re.test(line))) continue
    const fields = statusFields(para)
    const labelled = fields.find((f) => /^status$/i.test(f.label))
    let raw: string
    if (labelled) raw = labelled.value
    else {
      const plain = plainFirstLine(para)
      const colon = plain.indexOf(':')
      raw = colon >= 0 ? plain.slice(colon + 1) : ''
    }
    const status = cleanStatus(raw)
    return { index: b.index, rule: 'label', fields, status, phrases: statusPhrases(status) }
  }
  // rule `phrase`: among the first STATUS_PHRASE_SCAN_BLOCKS entries, the first candidate whose first line carries
  // a header status phrase; status = the phrase through the end of its ' · ' segment
  for (const b of window.slice(0, CONSTANTS.STATUS_PHRASE_SCAN_BLOCKS)) {
    const para = statusParagraphOf(b.node)
    if (!para || b.firstLine === null) continue
    const plain = plainFirstLine(para)
    const m = PHRASE_RE.exec(plain)
    if (!m) continue
    const end = plain.indexOf(SEP, m.index)
    const status = cleanStatus(plain.slice(m.index, end < 0 ? plain.length : end))
    return { index: b.index, rule: 'phrase', fields: statusFields(para), status, phrases: statusPhrases(status) }
  }
  return null
}

/** §12.12 B over a loaded file: `index` is the top-level entry index (of the paragraph, or of its blockquote). */
export function detectStatusHeader(L: Pick<Loaded, 'entries' | 'src'>): StatusHeaderInfo | null {
  const blocks: Block[] = L.entries.map((e, index) => {
    const node = e.kind === 'md' && e.nodes.length === 1 ? e.nodes[0]! : null
    const src = L.src.slice(e.start, e.end)
    const nl = src.search(/\r?\n/)
    return {
      index,
      node,
      frontmatter: e.kind === 'frontmatter',
      heading: e.kind === 'md' && e.mdType === 'heading',
      firstLine: statusParagraphOf(node) ? (nl < 0 ? src : src.slice(0, nl)) : null,
    }
  })
  return detectIn(blocks)
}

/** A live status block: the info (index = top-level child index in `doc`) plus where its node sits. */
export interface LiveStatusHeader {
  info: StatusHeaderInfo
  /** Position of the top-level node (the paragraph, or the blockquote holding it). */
  pos: number
  /** Position of the status paragraph itself (pos + 1 inside a blockquote). */
  paraPos: number
  node: PMNode
}

/**
 * §12.12 B over the live doc (the editor re-derives the chip on every transaction). Top-level empty paragraphs are
 * skipped, as load() never produces them (contentNodes rule).
 */
export function detectStatusHeaderInDoc(doc: PMNode): LiveStatusHeader | null {
  const blocks: Block[] = []
  const at = new Map<number, { pos: number; node: PMNode }>()
  let index = 0
  doc.forEach((n, pos) => {
    const i = index++
    if (n.type.name === 'paragraph' && n.content.size === 0) return
    const para = statusParagraphOf(n)
    blocks.push({ index: i, node: n, frontmatter: n.type.name === 'frontmatter', heading: n.type.name === 'heading', firstLine: para ? rebuiltFirstLine(para) : null })
    at.set(i, { pos, node: n })
  })
  const info = detectIn(blocks)
  if (!info) return null
  const hit = at.get(info.index)!
  return { info, pos: hit.pos, paraPos: hit.node.type.name === 'blockquote' ? hit.pos + 1 : hit.pos, node: hit.node }
}
