// core/bridge/gdoc-read.ts. A Google Docs `read_doc` result (documents.get, commentsIncluded) → markdown plus the
// review items to post on it: comments with their replies, and suggested edits (spike/gdocs/FINDINGS.md).
//
// The body is walked once. Every kept character goes to `text` (the plain text the markdown's ptext will equal:
// textblocks joined by '\n', top-level empty paragraphs skipped, CONTRACTS §5.1) and every Google index that holds a
// kept character is recorded in a segment table, so a comment's index range maps onto `text` exactly instead of being
// searched for. Suggested edits are inline in the body (SUGGESTIONS_INLINE): runs with suggestedInsertionIds are
// proposed text and are left out; runs with suggestedDeletionIds are original text and are kept. Each suggestion is
// then re-expressed as quote → replacement against the original text.
//
// Pure: no I/O, no editor. The CLI (cli/commands/bridge.ts) turns the result into store ops.

/** The parts of documents.get this module reads. Everything is optional: callers may hand in a trimmed copy. */
export interface GTextRun { content?: string; textStyle?: GTextStyle; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] }
export interface GTextStyle {
  bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean
  link?: { url?: string }; weightedFontFamily?: { fontFamily?: string }
}
export interface GElement {
  startIndex?: number; endIndex?: number
  textRun?: GTextRun
  inlineObjectElement?: unknown
  horizontalRule?: unknown
  pageBreak?: unknown
  footnoteReference?: { footnoteNumber?: string }
  person?: { personProperties?: { name?: string; email?: string } }
  richLink?: { richLinkProperties?: { title?: string; uri?: string } }
  dateElement?: { dateElementProperties?: { displayText?: string } }
}
export interface GParagraph {
  elements?: GElement[]
  paragraphStyle?: { namedStyleType?: string }
  bullet?: { listId?: string; nestingLevel?: number }
}
export interface GStructural {
  startIndex?: number; endIndex?: number
  paragraph?: GParagraph
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: GStructural[] }> }> }
  sectionBreak?: unknown
  tableOfContents?: { content?: GStructural[] }
}
export interface GPost {
  author?: { displayName?: string }
  content?: string
  createTime?: string
  commentAction?: string
}
export interface GComment {
  commentId?: string
  anchorId?: string
  status?: string
  plainTextQuote?: string
  headPost?: GPost
  replies?: GPost[]
}
export interface GSuggestion {
  suggestionId?: string
  status?: string
  headPost?: GPost
  summaryText?: string
}
export interface GList { listProperties?: { nestingLevels?: Array<{ glyphType?: string; glyphSymbol?: string }> } }
export interface GDocumentTab {
  body?: { content?: GStructural[] }
  commentAnchors?: Record<string, { ranges?: Array<{ startIndex?: number; endIndex?: number }> }>
  lists?: Record<string, GList>
}
export interface GDoc {
  documentId?: string
  title?: string
  revisionId?: string
  comments?: GComment[]
  suggestions?: GSuggestion[]
  tabs?: Array<{ documentTab?: GDocumentTab; tabProperties?: { title?: string } }>
  /** Legacy single-tab shape (documents.get without includeTabsContent). */
  body?: GDocumentTab['body']
  lists?: GDocumentTab['lists']
}

export interface ImportPost { author: string; body: string; at?: string }

export interface ImportThread {
  /** Google's comment id, for the report. */
  sourceId: string
  author: string
  body: string
  at?: string
  replies: ImportPost[]
  resolved: boolean
  /** Where it lands: an exact span of `text`, or the doc (no anchor left, or the anchor fell inside proposed text). */
  anchor: { kind: 'text'; from: number; to: number; quote: string; occurrence: number } | { kind: 'doc'; quote: string; why: DocWhy }
}
export type DocWhy = 'NO_ANCHOR' | 'ANCHOR_DELETED' | 'IN_SUGGESTED_TEXT' | 'NO_TEXT'

export interface ImportSuggestion {
  sourceId: string
  author: string
  /** Offsets in `text` of the replaced span (from === to for a pure insertion). */
  from: number
  to: number
  del: string
  ins: string
  /** Google's own one-line summary, e.g. `Replace: “a” with “b”`. */
  summary?: string
  /** true when the change crosses a paragraph boundary: it cannot be a text-level doc-review suggestion. */
  multiBlock: boolean
}

export interface GdocImport {
  title: string
  documentId?: string
  markdown: string
  /** The plain text the markdown's ptext equals (see the header comment). */
  text: string
  threads: ImportThread[]
  suggestions: ImportSuggestion[]
  /** Human-readable notes about what was simplified or skipped. */
  notes: string[]
  /** text offset → the Google document index of that unit (-1 for joiners and characters Google does not have). */
  gindex: number[]
}

// ------------------------------------------------------------------------------------------------------------------
// HTML entities in plainTextQuote (FINDINGS: `caf&#233; ☕`)

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

// ------------------------------------------------------------------------------------------------------------------
// Markdown escaping of plain text (the ptext keeps the literal character)

function escapeInline(s: string, inTable: boolean): string {
  let out = s.replace(/[\\`*_[\]<>~]/g, (c) => `\\${c}`).replace(/&(?=#?[a-z0-9]+;)/gi, '\\&')
  if (inTable) out = out.replace(/\|/g, '\\|')
  return out
}

/** Escapes that only matter at the start of a block line. */
function escapeLineStart(s: string): string {
  return s
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)([-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])(?=\s)/, '$1$2\\$3')
    .replace(/^(\s*)(=+|-{3,})\s*$/, '$1\\$2')
}

// ------------------------------------------------------------------------------------------------------------------

type Style = { b: boolean; i: boolean; s: boolean; code: boolean; link: string | null }
const MONO = /mono|courier|consolas|menlo|source code/i

function styleOf(ts: GTextStyle | undefined): Style {
  return {
    b: !!ts?.bold,
    i: !!ts?.italic,
    s: !!ts?.strikethrough,
    code: !!ts?.weightedFontFamily?.fontFamily && MONO.test(ts.weightedFontFamily.fontFamily),
    link: ts?.link?.url ?? null,
  }
}
const sameStyle = (a: Style, b: Style): boolean => a.b === b.b && a.i === b.i && a.s === b.s && a.code === b.code && a.link === b.link

/** One kept piece of a textblock: its plain text and, per UTF-16 unit, the Google index it came from (-1 = none). */
interface Piece { text: string; style: Style; gidx: number[] }

function renderPieces(pieces: Piece[], inTable: boolean): string {
  // merge neighbours with the same style, so `**a****b**` never happens
  const merged: Piece[] = []
  for (const p of pieces) {
    const last = merged[merged.length - 1]
    if (last && sameStyle(last.style, p.style)) {
      last.text += p.text
      last.gidx.push(...p.gidx)
    } else merged.push({ ...p, gidx: [...p.gidx] })
  }
  let out = ''
  for (const p of merged) {
    if (p.text === '') continue
    const st = p.style
    const plain = !st.b && !st.i && !st.s && !st.code && st.link === null
    // hard line breaks (Google's vertical tab, mapped to '\n' already) become markdown hard breaks
    const brk = (s: string): string => s.replace(/\n/g, '\\\n')
    if (plain) {
      out += brk(escapeInline(p.text, inTable))
      continue
    }
    // emphasis markers cannot sit next to whitespace: move it outside
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(p.text)!
    const [, lead, core, trail] = m as unknown as [string, string, string, string]
    if (core === '') {
      out += brk(escapeInline(p.text, inTable))
      continue
    }
    let inner: string
    if (st.code && !core.includes('\n')) {
      const fence = core.includes('`') ? '``' : '`'
      const pad = core.startsWith('`') || core.endsWith('`') ? ' ' : ''
      inner = `${fence}${pad}${inTable ? core.replace(/\|/g, '\\|') : core}${pad}${fence}`
    } else inner = brk(escapeInline(core, inTable))
    if (st.s) inner = `~~${inner}~~`
    if (st.i) inner = `*${inner}*`
    if (st.b) inner = `**${inner}**`
    if (st.link !== null) inner = `[${inner}](<${st.link.replace(/[<>]/g, encodeURIComponent)}>)`
    out += brk(escapeInline(lead, inTable)) + inner + brk(escapeInline(trail, inTable))
  }
  return out
}

/** Builder state shared by the walk. */
interface Walk {
  text: string
  /** Google index → offset in `text`, for every kept unit. */
  map: Map<number, number>
  /** Per suggestion id, its pieces in document order. */
  sugg: Map<string, Array<{ kind: 'ins' | 'del'; at: number; text: string; block: number }>>
  blockNo: number
  notes: Set<string>
  /** Suggestions that add or remove a paragraph break. */
  structural: Set<string>
}

/**
 * One textblock's kept pieces. `pre` = units already collected for the same textblock (multi-paragraph table cells);
 * `flat` turns line breaks into spaces (headings, table cells: one line in markdown).
 */
function collectPieces(w: Walk, para: GParagraph, pre = 0, flat = false): Piece[] {
  const pieces: Piece[] = []
  const here = (): number => w.text.length + pre + pieces.reduce((n, p) => n + p.text.length, 0)
  for (const el of para.elements ?? []) {
    let gi = el.startIndex ?? -1
    const tr = el.textRun
    if (tr) {
      let content = (tr.content ?? '').replace(/\u000b/g, flat ? ' ' : '\n')
      const ins = tr.suggestedInsertionIds ?? []
      const del = tr.suggestedDeletionIds ?? []
      // the paragraph's own terminating newline is structure, not text; a suggestion that adds or removes it
      // splits or joins paragraphs, which no text-level suggestion can express
      if (content.endsWith('\n') && el === para.elements![para.elements!.length - 1]) {
        content = content.slice(0, -1)
        for (const id of [...ins, ...del]) w.structural.add(id)
      }
      if (ins.length) {
        // proposed text: not part of the original; remembered per suggestion at the current offset
        for (const id of ins) pushSugg(w, id, 'ins', here(), content)
        continue
      }
      // private-use characters are Google's own markers (U+E907 brackets a code block): no text, but they hold indices
      let kept = ''
      const gidx: number[] = []
      for (let k = 0; k < content.length; k++) {
        if (PUA.test(content[k]!)) continue
        kept += content[k]
        gidx.push(gi >= 0 ? gi + k : -1)
      }
      const at = here()
      for (const id of del) pushSugg(w, id, 'del', at, kept)
      pieces.push({ text: kept, style: styleOf(tr.textStyle), gidx })
      continue
    }
    const plain = (s: string): void => {
      const gidx = [gi]
      for (let k = 1; k < s.length; k++) gidx.push(-1)
      pieces.push({ text: s, style: styleOf(undefined), gidx })
    }
    if (el.person) plain(el.person.personProperties?.name ?? el.person.personProperties?.email ?? '@person')
    else if (el.richLink) {
      const t = el.richLink.richLinkProperties?.title ?? el.richLink.richLinkProperties?.uri ?? 'link'
      const gidx = [gi]
      for (let k = 1; k < t.length; k++) gidx.push(-1)
      pieces.push({ text: t, style: { ...styleOf(undefined), link: el.richLink.richLinkProperties?.uri ?? null }, gidx })
    } else if (el.dateElement) plain(el.dateElement.dateElementProperties?.displayText ?? 'date')
    else if (el.footnoteReference) plain(`[${el.footnoteReference.footnoteNumber ?? '*'}]`)
    else if (el.inlineObjectElement) {
      w.notes.add('Images were replaced with “[image]”.')
      plain('[image]')
    } else if (el.horizontalRule) {
      w.notes.add('Horizontal rules inside paragraphs were dropped.')
      gi = -1
    }
    // pageBreak and anything unknown: dropped (no text)
  }
  return pieces
}

function pushSugg(w: Walk, id: string, kind: 'ins' | 'del', at: number, text: string): void {
  let list = w.sugg.get(id)
  if (!list) w.sugg.set(id, (list = []))
  // runs of the same suggestion that touch merge into one piece
  const last = list[list.length - 1]
  if (last && last.kind === kind && last.block === w.blockNo && (kind === 'ins' ? last.at === at : last.at + last.text.length === at)) {
    last.text += text
    return
  }
  list.push({ kind, at, text, block: w.blockNo })
}

/** Commit a textblock's pieces to the walk's text and index map. Returns its plain text. */
function commitBlock(w: Walk, pieces: Piece[], topLevel: boolean): string | null {
  const plain = pieces.map((p) => p.text).join('')
  if (topLevel && plain === '') return null    // §5.1: top-level empty paragraphs are skipped entirely
  const sep = w.blockNo > 0 ? 1 : 0
  const base = w.text.length + sep
  if (sep) {
    // shift suggestion pieces recorded for this block (they were computed without the joiner)
    for (const list of w.sugg.values()) for (const s of list) if (s.block === w.blockNo && s.at >= w.text.length) s.at += 1
    w.text += '\n'
  }
  let off = base
  for (const p of pieces) {
    for (let k = 0; k < p.text.length; k++) {
      const g = p.gidx[k]!
      if (g >= 0 && !w.map.has(g)) w.map.set(g, off + k)
    }
    off += p.text.length
  }
  w.text += plain
  w.blockNo++
  return plain
}

interface ListState { counters: Map<string, number[]> }

const PUA = /[\uE000-\uF8FF]/
const PUA_G = /[\uE000-\uF8FF]/g

/**
 * 'code' = a code line: Google's code-block marker is in it, or every visible run is monospace. 'marker' = no
 * visible text but a marker or a monospace newline: an empty code line, or the block's closing marker.
 */
function codeKind(p: GParagraph): 'code' | 'marker' | null {
  let marker = false
  let mono = false
  let text = ''
  let allMono = true
  for (const el of p.elements ?? []) {
    const tr = el.textRun
    if (!tr) {
      if (el.inlineObjectElement || el.person || el.richLink || el.dateElement || el.footnoteReference) allMono = false
      continue
    }
    if (tr.suggestedInsertionIds?.length) continue
    const c = tr.content ?? ''
    if (PUA.test(c)) marker = true
    if (styleOf(tr.textStyle).code) mono = true
    const t = c.replace(/\n$/, '').replace(PUA_G, '')
    if (t.trim()) {
      text += t
      if (!styleOf(tr.textStyle).code) allMono = false
    }
  }
  if (!text.trim()) return marker || mono ? 'marker' : null
  return marker || allMono ? 'code' : null
}

function isOrdered(lists: GDocumentTab['lists'], listId: string | undefined, level: number): boolean {
  const lvl = listId ? lists?.[listId]?.listProperties?.nestingLevels?.[level] : undefined
  if (!lvl) return false
  if (lvl.glyphSymbol) return false
  return !!lvl.glyphType && lvl.glyphType !== 'GLYPH_TYPE_UNSPECIFIED' && lvl.glyphType !== 'NONE'
}

function headingLevel(t: string | undefined): number {
  if (t === 'TITLE') return 1
  const m = /^HEADING_(\d)$/.exec(t ?? '')
  return m ? Number(m[1]) : 0
}

/** documents.get JSON → GdocImport. Throws Error with a readable message when the input is not a read_doc result. */
export function parseGdoc(input: unknown): GdocImport {
  const root = unwrap(input)
  const tab0: GDocumentTab = root.tabs?.[0]?.documentTab ?? { ...(root.body ? { body: root.body } : {}), ...(root.lists ? { lists: root.lists } : {}) }
  const content = tab0.body?.content
  if (!Array.isArray(content)) throw new Error('not a Google Docs read_doc result: no body content (expected content.tabs[0].documentTab.body.content)')
  const w: Walk = { text: '', map: new Map(), sugg: new Map(), blockNo: 0, notes: new Set(), structural: new Set() }
  if ((root.tabs?.length ?? 0) > 1) w.notes.add(`The doc has ${root.tabs!.length} tabs; only the first (“${root.tabs![0]?.tabProperties?.title ?? 'Tab 1'}”) was imported.`)
  const lists = tab0.lists
  const out: string[] = []
  const ls: ListState = { counters: new Map() }
  let prevList = false
  let prevListId: string | null = null
  let code: string[] | null = null
  let pendingEmpty = 0

  const flushListGap = (isList: boolean): void => {
    if (prevList && !isList) out.push('')
    prevList = isList
    if (!isList) prevListId = null
  }
  const flushCode = (): void => {
    if (!code) return
    let fence = '```'
    while (code.some((l) => l.trimStart().startsWith(fence))) fence += '`'
    out.push(fence, ...code, fence, '')
    code = null
    pendingEmpty = 0
  }

  for (const se of content) {
    if (se.sectionBreak) continue
    if (se.tableOfContents) {
      w.notes.add('The table of contents was dropped.')
      continue
    }
    if (se.paragraph) {
      const p = se.paragraph
      const ck = p.bullet || headingLevel(p.paragraphStyle?.namedStyleType) ? null : codeKind(p)
      if (ck === 'marker') {
        // an empty code line counts only if more code follows; the opening/closing marker lines are dropped
        if (code) pendingEmpty++
        continue
      }
      if (ck === 'code') {
        flushListGap(false)
        if (!code) code = []
        for (; pendingEmpty > 0; pendingEmpty--) {
          commitBlock(w, [], false)
          code.push('')
        }
        const pc = collectPieces(w, p)
        commitBlock(w, pc, false)
        code.push(pc.map((x) => x.text).join(''))
        continue
      }
      flushCode()
      const h = p.bullet ? 0 : headingLevel(p.paragraphStyle?.namedStyleType)
      const pieces = collectPieces(w, p, 0, h > 0)
      const textOnly = pieces.map((x) => x.text).join('')
      const hasRule = (p.elements ?? []).some((e) => e.horizontalRule) && textOnly.trim() === ''
      if (hasRule) {
        flushListGap(false)
        // an hr is an atom block in ptext (U+FFFC); keep the text map consistent by committing that one unit
        commitBlock(w, [{ text: '￼', style: styleOf(undefined), gidx: [-1] }], true)
        out.push('---', '')
        continue
      }
      const plain = commitBlock(w, pieces, true)
      if (plain === null) continue
      const md = renderPieces(pieces, false)
      if (p.bullet) {
        const level = Math.max(0, p.bullet.nestingLevel ?? 0)
        const ordered = isOrdered(lists, p.bullet.listId, level)
        const key = p.bullet.listId ?? ''
        const counters = ls.counters.get(key) ?? []
        counters[level] = (counters[level] ?? 0) + 1
        counters.length = level + 1
        ls.counters.set(key, counters)
        const indent = '    '.repeat(level)
        // a new list right after another one needs a blank line, or markdown merges them
        if (prevList && level === 0 && prevListId !== null && key !== prevListId) out.push('')
        flushListGap(true)
        if (level === 0) prevListId = key
        out.push(`${indent}${ordered ? `${counters[level]}.` : '-'} ${md || ' '}`)
        continue
      }
      flushListGap(false)
      if (h > 0) out.push(`${'#'.repeat(h)} ${md}`, '')
      else out.push(escapeLineStart(md), '')
      continue
    }
    if (se.table) {
      flushCode()
      flushListGap(false)
      const rows = se.table.tableRows ?? []
      const lines: string[] = []
      let cols = 0
      rows.forEach((r, ri) => {
        const cells = (r.tableCells ?? []).map((c) => {
          // a markdown table cell is one textblock: a multi-paragraph cell is joined with a space
          const all: Piece[] = []
          ;(c.content ?? []).forEach((cse, k) => {
            if (!cse.paragraph) return
            if (k > 0 && all.length) all.push({ text: ' ', style: styleOf(undefined), gidx: [-1] })
            const pc = collectPieces(w, cse.paragraph, all.reduce((n, x) => n + x.text.length, 0), true)
            // Google bolds the header row itself; markdown's header row is bold already
            all.push(...(ri === 0 ? pc.map((x) => ({ ...x, style: { ...x.style, b: false } })) : pc))
          })
          commitBlock(w, all, false)
          return renderPieces(all, true)
        })
        cols = Math.max(cols, cells.length)
        lines.push(`| ${cells.join(' | ')} |`)
      })
      if (lines.length) {
        lines.splice(1, 0, `|${' --- |'.repeat(cols)}`)
        out.push(...lines, '')
      }
      continue
    }
  }

  flushCode()
  const gindex: number[] = new Array<number>(w.text.length).fill(-1)
  for (const [g, o] of w.map) if (o < gindex.length) gindex[o] = g
  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n*$/, '\n')
  const text = w.text

  // ---- comments
  const anchors = tab0.commentAnchors ?? {}
  const threads: ImportThread[] = []
  for (const c of root.comments ?? []) {
    const head = c.headPost ?? {}
    const quoteRaw = unescapeHtml(c.plainTextQuote ?? '')
    const ranges = c.anchorId ? anchors[c.anchorId]?.ranges ?? [] : []
    let anchor: ImportThread['anchor']
    if (!c.anchorId) anchor = { kind: 'doc', quote: quoteRaw, why: 'NO_ANCHOR' }
    else if (!ranges.length) anchor = { kind: 'doc', quote: quoteRaw, why: 'ANCHOR_DELETED' }
    else {
      const gs = Math.min(...ranges.map((r) => r.startIndex ?? 0))
      const ge = Math.max(...ranges.map((r) => r.endIndex ?? 0))
      const span = mapRange(w.map, gs, ge)
      if (!span) anchor = { kind: 'doc', quote: quoteRaw, why: 'IN_SUGGESTED_TEXT' }
      else {
        let { from, to } = span
        // never start or end on a block joiner
        while (from < to && text[from] === '\n') from++
        while (to > from && text[to - 1] === '\n') to--
        const quote = text.slice(from, to)
        anchor = quote.trim() === '' ? { kind: 'doc', quote: quoteRaw, why: 'NO_TEXT' } : { kind: 'text', from, to, quote, occurrence: occurrenceAt(text, quote, from) }
      }
    }
    const replies: ImportPost[] = (c.replies ?? [])
      .filter((r) => (r.content ?? '').trim() !== '')
      .map((r) => ({ author: r.author?.displayName ?? 'Someone', body: (r.content ?? '').trim(), ...(r.createTime ? { at: r.createTime } : {}) }))
    threads.push({
      sourceId: c.commentId ?? '',
      author: head.author?.displayName ?? 'Someone',
      body: (head.content ?? '').trim(),
      ...(head.createTime ? { at: head.createTime } : {}),
      replies,
      resolved: c.status === 'RESOLVED',
      anchor,
    })
  }
  // document order (doc-level last), stable
  threads.sort((a, b) => (a.anchor.kind === 'text' ? a.anchor.from : Infinity) - (b.anchor.kind === 'text' ? b.anchor.from : Infinity))

  // ---- suggestions
  const meta = new Map((root.suggestions ?? []).map((s) => [s.suggestionId ?? '', s]))
  const suggestions: ImportSuggestion[] = []
  for (const [id, parts] of w.sugg) {
    const m = meta.get(id)
    if (m && m.status && m.status !== 'OPEN') continue
    const dels = parts.filter((p) => p.kind === 'del')
    const inss = parts.filter((p) => p.kind === 'ins')
    const from = Math.min(...parts.map((p) => p.at))
    const to = dels.length ? Math.max(...dels.map((p) => p.at + p.text.length)) : from
    const blocks = new Set(parts.map((p) => p.block))
    const ins = inss.map((p) => p.text).join('')
    const del = text.slice(from, to)
    suggestions.push({
      sourceId: id,
      author: m?.headPost?.author?.displayName ?? 'Someone',
      from, to, del, ins,
      ...(m?.summaryText ? { summary: m.summaryText } : {}),
      multiBlock: w.structural.has(id) || blocks.size > 1 || del.includes('\n') || ins.includes('\n'),
    })
  }
  suggestions.sort((a, b) => a.from - b.from)

  return {
    title: root.title ?? 'Untitled',
    ...(root.documentId ? { documentId: root.documentId } : {}),
    markdown,
    text,
    threads,
    suggestions,
    notes: [...w.notes],
    gindex,
  }
}

/** Accepts the raw tool result ({content: doc}), a documents.get body, or a JSON string of either. */
export function unwrap(input: unknown): GDoc {
  let v: unknown = input
  if (typeof v === 'string') v = JSON.parse(v)
  if (v && typeof v === 'object' && 'content' in v && (v as { content: unknown }).content && typeof (v as { content: unknown }).content === 'object' && !Array.isArray((v as { content: unknown }).content)) {
    v = (v as { content: unknown }).content
  }
  if (!v || typeof v !== 'object') throw new Error('not a Google Docs read_doc result')
  return v as GDoc
}

/** Google index range [gs, ge) → [from, to) in the walk's text, over the kept units only. null when none is kept. */
export function mapRange(map: ReadonlyMap<number, number>, gs: number, ge: number): { from: number; to: number } | null {
  let from = -1
  let to = -1
  for (let g = gs; g < ge; g++) {
    const o = map.get(g)
    if (o === undefined) continue
    if (from < 0 || o < from) from = o
    if (o + 1 > to) to = o + 1
  }
  return from < 0 ? null : { from, to }
}

/** 1-based occurrence of `quote` at `from` among its (overlapping) hits in `text`, as core/quote.ts counts them. */
export function occurrenceAt(text: string, quote: string, from: number): number {
  let n = 0
  for (let i = text.indexOf(quote); i !== -1 && i <= from; i = text.indexOf(quote, i + 1)) n++
  return Math.max(1, n)
}
