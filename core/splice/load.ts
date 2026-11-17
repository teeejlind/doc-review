// core/splice/load.ts (P1; lifted from spike/s2/src/splice.ts load() on day 0, CONTRACTS §3.4, D42, D44).
//
// Parse the source with Milkdown's own remark processor to get top-level mdast blocks with source offsets,
// convert each block to PM nodes with Milkdown's ParserState, classify each block's fidelity, and fall back to an
// atomic raw_block for anything Milkdown can't represent. Non-whitespace text between blocks (link reference
// definitions remark-inline-links removed) becomes a raw `gap` block; inter-block whitespace is kept as gaps.
//
// M1 additions over the lift:
// - HTML promotion (D44): an exact/semantic entry whose nodes are exactly one paragraph holding only inline `html`
//   atoms (optionally separated by hardbreaks or whitespace-only text) becomes a raw entry
//   `{ kind: 'raw', mdType: 'html', fidelity: 'exact', reason: 'html', nodes: [raw_block { value, reason: 'html' }] }`.
//   Bytes, block hash, ptext (one U+FFFC either way) and (start, end) are unchanged by it.
// - fidelityHints (S2-c): a block whose hash is in the map skips the render-and-compare classification and takes
//   the hinted fidelity (it is still converted to PM nodes; a conversion that errors still falls back to raw).
// - One classifier (`classifyText`) shared by load(), loadRun(), applyBlockOps verification and updateLoaded's
//   region re-parse, so all four classify a block identically.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { BlockHash, BlockInfo, BlockKind, Eol, Fidelity, MdType } from '../../shared/types'
import type { Md } from '../md/index'
import { blockMap } from '../blocks'
import { detectEol } from '../eol'
import { blockHash } from '../hash'
import { normMdast } from './eq'
import { parseMdast, renderNode, type MdastNode } from './render'

export interface Entry {
  kind: BlockKind; mdType: MdType; start: number; end: number; nodes: PMNode[]; fidelity: Fidelity; reason?: string
  /**
   * Set only when updateLoaded adopted editor nodes into `nodes` (G3, a split paragraph's trailing space): what the
   * bytes actually parse to. Splice verification compares a reloaded untouched block against this, never against the
   * adopted nodes, so client and server verify the same thing (QA3 F1).
   */
  parsed?: PMNode[]
}
export interface Loaded { src: string; eol: Eol; entries: Entry[]; gaps: string[]; doc: PMNode; defs: string; blocks: BlockInfo[] }

// ------------------------------------------------------------------ helpers

function mdastOf(md: Md, text: string, defs: string): unknown {
  const tree = parseMdast(md, defs ? text + '\n\n' + defs : text)
  const kids = tree.children ?? []
  return normMdast(defs ? kids.slice(0, kids.length - countBlocks(md, defs)) : kids)
}

// keyed per schema (remark processors are per editor), then by text
const blockCountCaches = new WeakMap<object, Map<string, number>>()
function countBlocks(md: Md, text: string): number {
  let cache = blockCountCaches.get(md.schema)
  if (!cache) blockCountCaches.set(md.schema, (cache = new Map()))
  let n = cache.get(text)
  if (n === undefined) {
    n = (parseMdast(md, text).children ?? []).length
    if (cache.size > 2000) cache.clear()
    cache.set(text, n)
  }
  return n
}

function withConsoleCapture<T>(fn: () => T): { value: T; errors: string[] } {
  const errors: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '))
  try {
    return { value: fn(), errors }
  } finally {
    console.error = orig
  }
}

/**
 * HTML promotion test (D44): exactly one paragraph whose inline children are all `html` atoms, optionally separated
 * by `hardbreak` nodes or whitespace-only text, with at least one `html` atom. A paragraph mixing text and HTML is
 * never promoted (its HTML stays inline, §12.13).
 */
export function isHtmlOnlyParagraph(nodes: readonly PMNode[]): boolean {
  if (nodes.length !== 1) return false
  const p = nodes[0]!
  if (p.type.name !== 'paragraph' || p.childCount === 0) return false
  let html = 0
  let ok = true
  p.forEach((c) => {
    if (c.type.name === 'html') html++
    else if (c.type.name === 'hardbreak') return
    else if (c.isText && /^\s*$/.test(c.text ?? '')) return
    else ok = false
  })
  return ok && html > 0
}

/**
 * Milkdown's remark-preserve-empty-line turns a top-level `<br>` / `<br />` line into an EMPTY paragraph, which has no
 * markdown form here (contentNodes drops it, so the next save would delete the line). Such an entry is block HTML
 * and is promoted like any other (contract-changes/P1.md, 2026-10-15). True when every node is an empty paragraph.
 */
export function isEmptyParagraphEntry(nodes: readonly PMNode[]): boolean {
  return nodes.length > 0 && nodes.every((n) => n.type.name === 'paragraph' && n.content.size === 0)
}
const HTML_TAG_LINE = /^<[^<>]+>$/

// ------------------------------------------------------------------ the classifier (S2 load body)

// keyed per schema: nodes built for one editor's schema must never leak into another editor
const classifyCaches = new WeakMap<object, Map<string, Entry>>()

export interface ClassifyOptions {
  /** EOL used for rendering during classification; default = detectEol(src). */
  eol?: Eol
  /**
   * Text parsed after `src` (joined by a blank line) as reference context, e.g. the doc's `defs` for a standalone
   * run. Its own blocks are never returned.
   */
  context?: string
  /** The defs string used for the classification cache key and the semantic check; default = computed from the parse. */
  defs?: string
  hints?: ReadonlyMap<BlockHash, Fidelity>
}

export interface Classified { eol: Eol; entries: Entry[]; gaps: string[]; defs: string }

/**
 * S2 load() minus the doc assembly, plus HTML promotion and hints. `entries[k]` offsets are into `src`; `gaps` has
 * `entries.length + 1` items (`gaps[k]` precedes entry k, the last is the trailing text).
 */
export function classifyText(md: Md, src: string, o: ClassifyOptions = {}): Classified {
  const eol = o.eol ?? detectEol(src)
  // micromark strips a BOM before computing positions: parse without it, shift offsets by 1
  const bom = src.startsWith('﻿') ? 1 : 0
  const body = bom ? src.slice(1) : src
  const full = o.context ? body + '\n\n' + o.context : body
  const tree = parseMdast(md, full)
  const rawType = md.schema.nodes.raw_block!
  let classifyCache = classifyCaches.get(md.schema)
  if (!classifyCache) classifyCaches.set(md.schema, (classifyCache = new Map()))
  const entries: Entry[] = []
  const gaps: string[] = []
  let cursor = 0
  const all = tree.children ?? []
  // only the children that start inside `src`; the context's own blocks are never entries
  const children = o.context ? all.filter((c) => c.position!.start.offset < body.length) : all

  // definitions (link refs removed by remark-inline-links show up as non-whitespace gaps, plus footnote
  // definitions) are context for parsing any single block standalone
  const defs = o.defs ?? defsOf(full, all)

  const pushRawGap = (from: number, to: number): void => {
    // non-whitespace text between blocks (e.g. link reference definitions that remark-inline-links removed from
    // the tree): keep as an atomic raw block
    const seg = src.slice(from, to)
    const s = from + (seg.length - seg.trimStart().length)
    const e = to - (seg.length - seg.trimEnd().length)
    gaps.push(src.slice(cursor, s))
    const value = src.slice(s, e)
    entries.push({
      kind: 'raw', mdType: 'gap', start: s, end: e, fidelity: 'lossy', reason: 'removed-by-remark-transform',
      nodes: [rawType.create({ value, reason: 'gap' })],
    })
    cursor = e
  }

  for (const child of children) {
    if (!child.position) throw new Error(`top-level mdast node without position: ${child.type}`)
    const start = child.position.start.offset + bom
    const end = child.position.end.offset + bom
    if (src.slice(Math.max(cursor, bom), start).trim() !== '') pushRawGap(Math.max(cursor, bom), start)
    gaps.push(src.slice(cursor, start))
    cursor = end
    const slice = src.slice(start, end)

    // the classification of a block depends only on its bytes, the EOL style and the doc's defs
    const cacheKey = `${eol}\u0000${defs}\u0000${slice}`
    const hit = classifyCache.get(cacheKey)
    if (hit) {
      entries.push({ ...hit, start, end })
      continue
    }

    const hint = o.hints?.get(blockHash(slice))
    if (hint === 'lossy') {
      entries.push({ kind: 'raw', mdType: child.type, start, end, fidelity: 'lossy', reason: 'hint', nodes: [rawType.create({ value: slice, reason: child.type })] })
      continue
    }

    const { value: doc, errors } = withConsoleCapture(() => md.mdastToDoc({ type: 'root', children: [child] }))
    const nodes: PMNode[] = []
    doc.forEach((n) => nodes.push(n))

    let fidelity: Fidelity
    let reason: string | undefined
    if (errors.length) reason = `parser-errors: ${errors[0]!.slice(0, 120)}`
    else if (nodes.length === 0) reason = 'no-pm-nodes'

    if (reason) fidelity = 'lossy'
    else if (hint !== undefined) fidelity = hint
    else {
      let rendered = ''
      try {
        rendered = nodes.map((n) => renderNode(md, n, eol)).join(eol + eol)
      } catch (e) {
        reason = `serialize-throws: ${(e as Error).message}`
      }
      if (reason) fidelity = 'lossy'
      else if (rendered === slice) fidelity = 'exact'
      else {
        const isDef = child.type === 'footnoteDefinition'
        const a = JSON.stringify(normMdast([child]))
        const b = JSON.stringify(mdastOf(md, rendered, isDef ? '' : defs))
        if (a === b) fidelity = 'semantic'
        else {
          fidelity = 'lossy'
          reason = 'mdast-mismatch-after-roundtrip'
        }
      }
    }

    if (fidelity !== 'lossy' && isEmptyParagraphEntry(nodes) && !HTML_TAG_LINE.test(slice.trim())) {
      // a non-empty source block that converts to nothing but empty paragraphs can't round-trip: keep its bytes
      fidelity = 'lossy'
      reason = 'empty-paragraph'
    }

    let entry: Entry
    if (fidelity === 'lossy') {
      entry = {
        kind: 'raw', mdType: child.type, start, end, fidelity, ...(reason !== undefined ? { reason } : {}),
        nodes: [rawType.create({ value: slice, reason: child.type })],
      }
    } else if (isHtmlOnlyParagraph(nodes) || isEmptyParagraphEntry(nodes)) {
      // HTML promotion (D44): block HTML reaches the raw popover as a raw_block holding its exact source (an empty
      // paragraph here is always a `<br>`-only line: any other empty-paragraph entry went lossy above)
      entry = { kind: 'raw', mdType: 'html', start, end, fidelity: 'exact', reason: 'html', nodes: [rawType.create({ value: slice, reason: 'html' })] }
    } else {
      entry = { kind: child.type === 'yaml' || child.type === 'toml' ? 'frontmatter' : 'md', mdType: child.type, start, end, fidelity, nodes }
    }
    entries.push(entry)
    if (hint === undefined) {
      if (classifyCache.size > 20000) classifyCache.clear()
      classifyCache.set(cacheKey, entry)
    }
  }
  if (cursor < src.length && src.slice(Math.max(cursor, bom)).trim() !== '') pushRawGap(Math.max(cursor, bom), src.length)
  gaps.push(src.slice(Math.min(cursor, src.length)))
  return { eol, entries, gaps, defs }
}

/** The doc's definitions: every non-whitespace inter-block segment (trimmed) and every footnote definition's source. */
function defsOf(text: string, children: readonly MdastNode[]): string {
  const parts: string[] = []
  let c = 0
  for (const child of children) {
    const s = child.position!.start.offset
    if (text.slice(c, s).trim() !== '') parts.push(text.slice(c, s).trim())
    if (child.type === 'footnoteDefinition') parts.push(text.slice(s, child.position!.end.offset))
    c = child.position!.end.offset
  }
  if (text.slice(c).trim() !== '') parts.push(text.slice(c).trim())
  return parts.join('\n\n')
}

/**
 * The defs a doc with these entries has (what classifyText computes from a full parse): the value of every raw `gap`
 * entry and the source of every footnote definition (raw or not), in order. updateLoaded uses it to detect a changed
 * definition set without re-parsing the whole doc.
 */
export function defsOfEntries(src: string, entries: readonly Entry[]): string {
  const parts: string[] = []
  for (const e of entries) {
    if (e.mdType === 'gap' || e.mdType === 'footnoteDefinition') parts.push(src.slice(e.start, e.end))
  }
  return parts.join('\n\n')
}

/** Assemble a Loaded from classified parts (the doc is every entry's nodes, or one empty paragraph). */
export function assembleLoaded(md: Md, src: string, c: Classified): Loaded {
  const all = c.entries.flatMap((e) => e.nodes)
  const doc = md.schema.topNodeType.create(null, all.length ? all : [md.schema.nodes.paragraph!.create()])
  const L: Loaded = { src, eol: c.eol, entries: c.entries, gaps: c.gaps, doc, defs: c.defs, blocks: [] }
  L.blocks = blockMap(md, L)
  return L
}

// ------------------------------------------------------------------ public API

/**
 * S2 load() with HTML promotion (D44). `fidelityHints` (S2-c) skips re-classification for blocks whose hash is in the
 * map; G4 / G6 prove it gives the same ptext and block map as a full classification.
 */
export function load(md: Md, text: string, o?: { fidelityHints?: ReadonlyMap<BlockHash, Fidelity> }): Loaded {
  return assembleLoaded(md, text, classifyText(md, text, o?.fidelityHints ? { hints: o.fidelityHints } : {}))
}

/**
 * The classifying parse of a standalone run: the top-level nodes load() would give `text` (raw fallback and HTML
 * promotion included), with `defs` as context. Verification and P2's raw-popover commit use it (D44).
 */
export function loadRun(md: Md, text: string, defs: string, eol: Eol): PMNode[] {
  const { entries } = classifyText(md, text, defs ? { eol, context: defs } : { eol })
  return entries.flatMap((e) => e.nodes)
}
