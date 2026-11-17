// web/src/editor/paste/normalize.ts (P2, pure over the DOM). The paste normalizer (CONTRACTS §12.11).
//
// normalizePastedHTML runs as ProseMirror's transformPastedHTML. Its output goes through Milkdown's normal DOM
// parser, so "clean markdown" means: pasted into an empty doc and saved, the file equals the fixture's expected
// markdown (tests/unit/web/editor/paste/fixtures). Rules, in order:
//   1. all sources: drop meta/link/style/script/noscript/iframe/object/form/input/button/svg/canvas and comments;
//      drop every class/style/id/data-* attribute (after 2-3 read what they need); unwrap div/span/font/section/
//      article/main (block wrappers keep their paragraph boundaries); <br> stays a hard break;
//   2. Google Docs: strip the docs-internal-guid wrapper; styled spans → strong / em / s; <p> inside <li> unwrapped;
//      sub/superscript loses its alignment;
//   3. Word: drop conditional comments, <o:p>, <w:*>, <v:*>; MsoListParagraph / mso-list paragraphs become nested
//      list items (the mso-list:Ignore marker glyph decides bullet vs ordered); MsoTitle/MsoHeading1-3 → h1-h3;
//   4. web pages: keep h1-h6, p, ul/ol/li, blockquote, pre/code, a[href], img, table, strong/b, em/i, s/del, hr;
//      nav/header/footer/aside dropped when there is other block content; relative href/src resolved against the
//      source URL (text/x-moz-url, or <base href>), otherwise unwrapped to plain text;
//   5. tables: rectangular GFM tables, first row = header, merged cells filled out with empty cells, cell content
//      inline only (blocks inside a cell join with <br>);
//   6. images: data:/blob: (and any other non-http(s) source) dropped and counted (notice PASTE_IMAGE_DROPPED);
//      http(s) images keep src and alt, never a title.
// HTML a ProseMirror editor put on the clipboard (data-pm-slice) is our own schema's DOM: it passes through as is.

export interface NormalizeOptions {
  /** The page the HTML came from (the clipboard's text/x-moz-url); <base href> is used when absent. */
  sourceUrl?: string
}

export interface NormalizeResult {
  html: string
  /** Images dropped because their source can't be a markdown image (data:, blob:, file:, cid:, ...). */
  droppedImages: number
  source: 'pm' | 'gdocs' | 'word' | 'web'
}

const DROP_TAGS = new Set([
  'META', 'LINK', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT',
  'TEXTAREA', 'SVG', 'CANVAS', 'TEMPLATE', 'TITLE', 'HEAD', 'AUDIO', 'VIDEO', 'MAP', 'AREA',
])
/** Block wrappers: removed, their inline runs become paragraphs (PM's own div handling, made explicit). */
const WRAPPER_TAGS = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'FIGURE', 'CENTER', 'DETAILS', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'BODY',
  'HGROUP', 'FIELDSET', 'DL', 'FORM',
])
/** Block-ish elements that hold one paragraph of text. */
const PARA_TAGS = new Set(['DT', 'DD', 'FIGCAPTION', 'ADDRESS', 'SUMMARY', 'LEGEND', 'CAPTION'])
const BLOCK_KEEP = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR'])
const INLINE_KEEP = new Set(['A', 'IMG', 'STRONG', 'B', 'EM', 'I', 'DEL', 'CODE', 'BR', 'MDR-BR'])
const CODE_LIKE = new Set(['KBD', 'SAMP', 'TT', 'VAR'])
const BLOCK_ANY = new Set([...BLOCK_KEEP, ...WRAPPER_TAGS, ...PARA_TAGS, 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH'])

const isEl = (n: Node | null | undefined): n is HTMLElement => !!n && n.nodeType === 1
const tag = (n: Node): string => (isEl(n) ? n.tagName.toUpperCase() : '')

function styleOf(el: Element): string {
  return (el.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '')
}

function unwrap(el: Element): void {
  const p = el.parentNode
  if (!p) return
  while (el.firstChild) p.insertBefore(el.firstChild, el)
  p.removeChild(el)
}

function rename(el: Element, name: string): HTMLElement {
  const doc = el.ownerDocument
  const out = doc.createElement(name)
  for (const a of Array.from(el.attributes)) out.setAttribute(a.name, a.value)
  while (el.firstChild) out.appendChild(el.firstChild)
  el.parentNode?.replaceChild(out, el)
  return out
}

function isBlockNode(n: Node): boolean {
  return isEl(n) && BLOCK_ANY.has(tag(n))
}

function isBlankInline(n: Node): boolean {
  if (tag(n) === 'BR') return true
  if (n.nodeType === 3) return !/\S/.test((n.textContent ?? '').replace(/\u00a0/g, ' '))
  if (isEl(n)) return tag(n) !== 'IMG' && !n.querySelector('img') && !/\S/.test((n.textContent ?? '').replace(/\u00a0/g, ' '))
  return true
}

/** Replace a block wrapper with its children, wrapping each run of inline content in a <p>. */
function blockify(el: Element): void {
  const doc = el.ownerDocument
  const parent = el.parentNode
  if (!parent) return
  let run: Node[] = []
  const flush = (): void => {
    if (run.length && !run.every(isBlankInline)) {
      const p = doc.createElement('p')
      for (const n of run) p.appendChild(n)
      parent.insertBefore(p, el)
    } else {
      for (const n of run) n.parentNode?.removeChild(n)
    }
    run = []
  }
  for (const child of Array.from(el.childNodes)) {
    if (isBlockNode(child)) {
      flush()
      parent.insertBefore(child, el)
    } else run.push(child)
  }
  flush()
  parent.removeChild(el)
}

// ------------------------------------------------------------------ URLs

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

function resolveUrl(raw: string, base: string | null, kind: 'href' | 'src'): string | null {
  const u = raw.trim()
  if (!u) return null
  if (SCHEME.test(u)) {
    if (kind === 'href') return /^(https?:|mailto:)/i.test(u) ? u : null
    return /^https?:/i.test(u) ? u : null
  }
  if (u.startsWith('//')) return `https:${u}`
  if (!base) return null
  try {
    const out = new URL(u, base).href
    return /^https?:/i.test(out) ? out : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ source-specific passes

function gdocsPass(body: HTMLElement): void {
  for (const b of Array.from(body.querySelectorAll('b[id^="docs-internal-guid"]'))) unwrap(b)
}

function wordListInfo(p: Element): { level: number; ordered: boolean; start: number | null } | null {
  const cls = p.getAttribute('class') ?? ''
  const style = styleOf(p)
  const m = /mso-list:l\d+level(\d+)/.exec(style)
  if (!/^MsoListParagraph/i.test(cls) && !m) return null
  const marker = Array.from(p.querySelectorAll('span')).find((s) => /mso-list:ignore/.test(styleOf(s)))
  const glyph = (marker?.textContent ?? '').replace(/[\s ]+/g, '')
  marker?.remove()
  const ordered = /^[0-9A-Za-z]+[.)]$/.test(glyph)
  const num = /^(\d+)[.)]$/.exec(glyph)
  return { level: m ? Math.max(1, Number(m[1])) : 1, ordered, start: num ? Number(num[1]) : null }
}

function wordPass(body: HTMLElement): void {
  const doc = body.ownerDocument
  for (const el of Array.from(body.getElementsByTagName('*'))) {
    const name = el.tagName.toLowerCase()
    if (!name.includes(':')) continue
    if (name === 'o:p' || name.startsWith('w:') || name.startsWith('v:')) el.remove()
    else unwrap(el)
  }
  for (const p of Array.from(body.querySelectorAll('p[class]'))) {
    const cls = p.getAttribute('class') ?? ''
    const h = /^Mso(?:Title|Heading([1-3]))$/i.exec(cls)
    if (h) rename(p, `h${h[1] ?? '1'}`)
  }
  // list paragraphs → nested lists; consecutive list paragraphs (siblings, blanks between) form one structure
  const items = Array.from(body.querySelectorAll('p')).map((p) => ({ p, info: wordListInfo(p) })).filter((x) => x.info !== null)
  const done = new Set<Element>()
  for (const first of items) {
    if (done.has(first.p)) continue
    const group: Array<{ p: Element; info: NonNullable<ReturnType<typeof wordListInfo>> }> = [{ p: first.p, info: first.info! }]
    done.add(first.p)
    let n: Node | null = first.p.nextSibling
    while (n) {
      if (n.nodeType === 3 && !(n.textContent ?? '').trim()) {
        n = n.nextSibling
        continue
      }
      if (n.nodeType === 8) {
        n = n.nextSibling
        continue
      }
      const hit = items.find((x) => x.p === n)
      if (!hit) break
      group.push({ p: hit.p, info: hit.info! })
      done.add(hit.p)
      n = hit.p.nextSibling
    }
    const root = doc.createElement(group[0]!.info.ordered ? 'ol' : 'ul')
    if (group[0]!.info.ordered && group[0]!.info.start && group[0]!.info.start !== 1) root.setAttribute('start', String(group[0]!.info.start))
    first.p.parentNode!.insertBefore(root, first.p)
    const stack: HTMLElement[] = [root]
    for (const { p, info } of group) {
      while (stack.length > info.level) stack.pop()
      while (stack.length < info.level) {
        const parentList = stack[stack.length - 1]!
        let li = parentList.lastElementChild as HTMLElement | null
        if (!li) {
          li = doc.createElement('li')
          parentList.appendChild(li)
        }
        const sub = doc.createElement(info.ordered ? 'ol' : 'ul')
        li.appendChild(sub)
        stack.push(sub)
      }
      const li = doc.createElement('li')
      while (p.firstChild) li.appendChild(p.firstChild)
      p.remove()
      stack[stack.length - 1]!.appendChild(li)
    }
  }
}

// ------------------------------------------------------------------ generic passes

/** Inline styles → marks (Google Docs spans, Word spans, styled web text). Headings are left alone. */
function stylesToMarks(body: HTMLElement): void {
  const doc = body.ownerDocument
  for (const el of Array.from(body.querySelectorAll('span, font, b, strong, i, em'))) {
    const s = styleOf(el)
    const t = tag(el)
    if ((t === 'B' || t === 'STRONG') && /(?:^|;)font-weight:(?:normal|400)/.test(s)) {
      unwrap(el)
      continue
    }
    if (t !== 'SPAN' && t !== 'FONT') continue
    if (el.closest('h1,h2,h3,h4,h5,h6,pre')) continue
    const wraps: string[] = []
    // property names anchored at a declaration start: Word's mso-bidi-font-weight:bold is not bold
    if (/(?:^|;)font-weight:(?:bold|bolder|[6-9]00)/.test(s)) wraps.push('strong')
    if (/(?:^|;)font-style:italic/.test(s)) wraps.push('em')
    if (/(?:^|;)text-decoration(?:-line)?:[^;]*line-through/.test(s)) wraps.push('del')
    if (!wraps.length) continue
    let inner: Node[] = Array.from(el.childNodes)
    for (const w of wraps.reverse()) {
      const m = doc.createElement(w)
      for (const n of inner) m.appendChild(n)
      inner = [m]
    }
    for (const n of inner) el.appendChild(n)
  }
}

function fixNestedLists(body: HTMLElement): void {
  const doc = body.ownerDocument
  for (const list of Array.from(body.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol'))) {
    let prev = list.previousElementSibling
    if (!prev || tag(prev) !== 'LI') {
      prev = doc.createElement('li')
      list.parentNode!.insertBefore(prev, list)
    }
    prev.appendChild(list)
  }
  for (const li of Array.from(body.querySelectorAll('li'))) {
    const blocks = Array.from(li.childNodes).filter((n) => !(n.nodeType === 3 && !(n.textContent ?? '').trim()))
    const ps = blocks.filter((n) => tag(n) === 'P')
    if (ps.length === 1 && blocks[0] === ps[0]) unwrap(ps[0] as Element)
    else if (ps.length > 1) {
      // several paragraphs in one item (a Google Docs soft-return list item): one line each
      ps.forEach((p, i) => {
        if (i > 0) p.parentNode!.insertBefore(doc.createElement('br'), p)
        unwrap(p as Element)
      })
    }
  }
}

function hasOtherBlockContent(body: HTMLElement): boolean {
  const chrome = 'nav, header, footer, aside'
  for (const el of Array.from(body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, table, pre, blockquote'))) {
    if (!el.closest(chrome)) return true
  }
  return false
}

/** A cell's alignment: its own text-align / align, else its first paragraph's (Word and Google Docs align the p). */
function alignOf(cell: Element): 'center' | 'right' | null {
  const read = (el: Element | null): string => {
    if (!el) return ''
    return /(?:^|;)text-align:(left|center|right)/.exec(styleOf(el))?.[1] ?? (el.getAttribute('align') ?? '').toLowerCase()
  }
  let a = read(cell)
  if (!a) {
    const first = Array.from(cell.children).find((c) => ['P', 'DIV'].includes(tag(c))) ?? null
    a = read(first)
  }
  return a === 'center' || a === 'right' ? a : null
}

/** Rule 5: a rectangular GFM-shaped table; first row = header; merged cells filled out; inline cell content. */
function normalizeTable(table: HTMLTableElement): void {
  const doc = table.ownerDocument
  const rows = Array.from(table.rows).filter((r) => r.closest('table') === table)
  const grid: Array<Array<{ cell: HTMLTableCellElement | null; align: string | null }>> = []
  rows.forEach((tr, r) => {
    grid[r] ??= []
    let c = 0
    for (const cell of Array.from(tr.cells)) {
      while (grid[r]![c]) c++
      const cs = Math.max(1, Math.min(50, Number(cell.getAttribute('colspan')) || 1))
      const rs = Math.max(1, Math.min(500, Number(cell.getAttribute('rowspan')) || 1))
      const align = alignOf(cell)
      for (let dr = 0; dr < rs && r + dr < rows.length; dr++) {
        grid[r + dr] ??= []
        // a spanned slot is an empty cell with no alignment of its own
        for (let dc = 0; dc < cs; dc++) grid[r + dr]![c + dc] = dr === 0 && dc === 0 ? { cell, align } : { cell: null, align: null }
      }
      c += cs
    }
  })
  const width = Math.max(1, ...grid.map((row) => row.length))
  const out = doc.createElement('table')
  const caption = table.caption
  if (caption && (caption.textContent ?? '').trim()) {
    const p = doc.createElement('p')
    while (caption.firstChild) p.appendChild(caption.firstChild)
    table.parentNode?.insertBefore(p, table)
  }
  const head = doc.createElement('thead')
  const tbody = doc.createElement('tbody')
  out.append(head, tbody)
  const colAlign: Array<string | null> = Array.from({ length: width }, (_, c) => grid[0]?.[c]?.align ?? null)
  ;(grid.length ? grid : [[]]).forEach((row, r) => {
    const tr = doc.createElement('tr')
    for (let c = 0; c < width; c++) {
      const td = doc.createElement(r === 0 ? 'th' : 'td')
      const slot = row[c]
      if (slot?.cell) for (const n of inlineContent(slot.cell)) td.appendChild(n)
      if (colAlign[c]) td.setAttribute('data-mdr-align', colAlign[c]!)
      tr.appendChild(td)
    }
    ;(r === 0 ? head : tbody).appendChild(tr)
  })
  table.parentNode?.replaceChild(out, table)
}

/**
 * A cell's content as inline nodes: block children contribute their inline content. A cell holds one line (§12.13),
 * so a line break between blocks (or a <br>) becomes inline HTML `<br>` (an `html` atom, the GFM way to break a cell
 * line), never a hard break: load() of the saved table gives the same nodes back.
 */
function inlineContent(cell: Element): Node[] {
  const doc = cell.ownerDocument
  const out: Node[] = []
  let pendingBreak = false
  const blank = (n: Node): boolean => n.nodeType === 3 && !/\S/.test((n.textContent ?? '').replace(/\u00a0/g, ' '))
  const push = (n: Node): void => {
    if (pendingBreak && out.length) out.push(doc.createElement('mdr-br'))
    pendingBreak = false
    out.push(n)
  }
  const walk = (parent: Node): void => {
    for (const n of Array.from(parent.childNodes)) {
      if (isEl(n) && (BLOCK_ANY.has(tag(n)) || tag(n) === 'TABLE')) {
        if (out.length) pendingBreak = true
        if (tag(n) === 'TABLE' || tag(n) === 'PRE') {
          const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (text) push(doc.createTextNode(text))
        } else walk(n)
        if (out.length) pendingBreak = true
        continue
      }
      if (tag(n) === 'BR') {
        if (out.length) pendingBreak = true
        continue
      }
      // whitespace between blocks (source indentation) is not content
      if (blank(n) && (out.length === 0 || pendingBreak)) continue
      push(n)
    }
  }
  walk(cell)
  while (out.length && blank(out[out.length - 1]!)) out.pop()
  return out
}

function codeLanguage(pre: Element): string {
  const code = pre.querySelector('code')
  for (const el of [pre, code]) {
    const cls = el?.getAttribute('class') ?? ''
    const m = /(?:^|\s)(?:language|lang|highlight-source)-([A-Za-z0-9_+#.-]+)/.exec(cls)
    if (m) return m[1]!
    const dl = el?.getAttribute('data-language') ?? el?.getAttribute('data-lang')
    if (dl) return dl
  }
  return ''
}

function preText(pre: Element): string {
  let s = ''
  const walk = (n: Node): void => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) s += c.textContent ?? ''
      else if (tag(c) === 'BR') s += '\n'
      else if (isEl(c)) {
        const block = ['DIV', 'P', 'LI'].includes(tag(c))
        if (block && s && !s.endsWith('\n')) s += '\n'
        walk(c)
      }
    }
  }
  walk(pre)
  return s.replace(/ /g, ' ').replace(/\n+$/, '')
}

const KEEP_ATTRS: Readonly<Record<string, readonly string[]>> = { A: ['href'], IMG: ['src', 'alt'], OL: ['start'] }

function stripAttributes(body: HTMLElement): void {
  for (const el of Array.from(body.getElementsByTagName('*'))) {
    const keep = KEEP_ATTRS[tag(el)] ?? []
    for (const a of Array.from(el.attributes)) {
      if (keep.includes(a.name.toLowerCase()) || a.name === 'data-mdr-language' || a.name === 'data-mdr-align') continue
      el.removeAttribute(a.name)
    }
  }
  // the parser reads code_block.language from data-language and cell alignment from style text-align
  for (const pre of Array.from(body.querySelectorAll('pre[data-mdr-language]'))) {
    pre.setAttribute('data-language', pre.getAttribute('data-mdr-language')!)
    pre.removeAttribute('data-mdr-language')
  }
  for (const cell of Array.from(body.querySelectorAll('[data-mdr-align]'))) {
    cell.setAttribute('style', `text-align: ${cell.getAttribute('data-mdr-align')}`)
    cell.removeAttribute('data-mdr-align')
  }
  // a cell line break: Milkdown's inline `html` atom (span[data-type="html"]) holding `<br>`
  for (const br of Array.from(body.getElementsByTagName('mdr-br'))) {
    const span = body.ownerDocument.createElement('span')
    span.setAttribute('data-type', 'html')
    span.setAttribute('data-value', '<br>')
    span.textContent = '<br>'
    br.parentNode?.replaceChild(span, br)
  }
}

function removeComments(root: Node): void {
  const walker = root.ownerDocument!.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */)
  const dead: Node[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) dead.push(n)
  for (const n of dead) n.parentNode?.removeChild(n)
}

/** Paragraph-level cleanup: empty paragraphs, trailing breaks, blank runs between blocks. */
function tidy(body: HTMLElement): void {
  for (const p of Array.from(body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, th, td'))) {
    const trailing = (n: ChildNode | null): boolean => !!n && (tag(n) === 'BR' || (n.nodeType === 3 && !/\S/.test((n.textContent ?? '').replace(/\u00a0/g, ' '))))
    while (trailing(p.lastChild)) p.removeChild(p.lastChild!)
    while (p.firstChild && tag(p.firstChild) === 'BR') p.removeChild(p.firstChild)
  }
  for (const p of Array.from(body.querySelectorAll('p, h1, h2, h3, h4, h5, h6'))) {
    if (!p.querySelector('img') && !(p.textContent ?? '').replace(/ /g, ' ').trim()) p.remove()
  }
  // nbsp runs Google Docs and Word use for spacing become plain spaces
  const walker = body.ownerDocument.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('pre')) continue
    if (n.textContent?.includes(' ')) n.textContent = n.textContent.replace(/ /g, ' ')
  }
}

export function normalizePasted(html: string, o: NormalizeOptions = {}): NormalizeResult {
  if (/\sdata-pm-slice=/.test(html)) return { html, droppedImages: 0, source: 'pm' }
  const word = /urn:schemas-microsoft-com:office|class="?Mso|mso-[a-z-]+:/i.test(html)
  const gdocs = /id="docs-internal-guid/.test(html)
  const source: NormalizeResult['source'] = gdocs ? 'gdocs' : word ? 'word' : 'web'
  // conditional comments whose content sits inside the comment (<!--[if gte mso 9]><xml>…</xml><![endif]-->)
  const cleaned = html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
  const doc = new DOMParser().parseFromString(cleaned, 'text/html')
  const body = doc.body
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href') ?? null
  const base = o.sourceUrl && /^https?:/i.test(o.sourceUrl) ? o.sourceUrl : baseHref && /^https?:/i.test(baseHref) ? baseHref : null
  let droppedImages = 0

  removeComments(body)
  for (const el of Array.from(body.querySelectorAll('*'))) if (DROP_TAGS.has(tag(el)) && el.isConnected) el.remove()
  if (gdocs) gdocsPass(body)
  if (word) wordPass(body)
  stylesToMarks(body)

  // web chrome: dropped when there is real content beside it
  const dropChrome = hasOtherBlockContent(body)
  for (const el of Array.from(body.querySelectorAll('nav, header, footer, aside'))) {
    if (dropChrome && el.isConnected) el.remove()
  }

  // links and images
  for (const a of Array.from(body.querySelectorAll('a'))) {
    const href = a.getAttribute('href')
    const abs = href === null ? null : resolveUrl(href, base, 'href')
    if (abs) a.setAttribute('href', abs)
    else unwrap(a)
  }
  for (const img of Array.from(body.querySelectorAll('img'))) {
    const raw = (img.getAttribute('src') ?? '').trim()
    if (/^(data|blob):/i.test(raw)) {
      droppedImages++
      img.remove()
      continue
    }
    const abs = resolveUrl(raw, base, 'src')
    if (abs) {
      img.setAttribute('src', abs)
      continue
    }
    if (SCHEME.test(raw) || !raw) {
      droppedImages++
      img.remove()
      continue
    }
    // a relative image with nothing to resolve it against: its alt text, if any
    const alt = img.getAttribute('alt') ?? ''
    if (alt) img.parentNode?.replaceChild(doc.createTextNode(alt), img)
    else img.remove()
  }

  // code blocks: one text node, language from the class names
  for (const pre of Array.from(body.querySelectorAll('pre'))) {
    const lang = codeLanguage(pre)
    const text = preText(pre)
    pre.replaceChildren(doc.createTextNode(text))
    if (lang) pre.setAttribute('data-mdr-language', lang)
  }
  for (const el of Array.from(body.querySelectorAll('kbd, samp, tt, var'))) if (CODE_LIKE.has(tag(el))) rename(el, 'code')
  // the strike_through mark parses <del>
  for (const el of Array.from(body.querySelectorAll('s, strike'))) rename(el, 'del')

  // tables (innermost first: a nested table becomes text of its cell)
  const tables = Array.from(body.querySelectorAll('table')).reverse()
  for (const t of tables) if (t.isConnected) normalizeTable(t as HTMLTableElement)

  // unwrap / convert everything outside the keep lists
  const all = Array.from(body.querySelectorAll('*')).reverse()
  for (const el of all) {
    if (!el.isConnected) continue
    const t = tag(el)
    if (BLOCK_KEEP.has(t) || INLINE_KEEP.has(t) || ['THEAD', 'TBODY', 'TR', 'TH', 'TD'].includes(t)) continue
    if (PARA_TAGS.has(t)) {
      rename(el, 'p')
      continue
    }
    if (WRAPPER_TAGS.has(t)) {
      blockify(el)
      continue
    }
    unwrap(el)
  }
  fixNestedLists(body)
  // top-level inline runs → paragraphs, so a stray <br> between blocks never becomes an empty line
  const holder = doc.createElement('div')
  while (body.firstChild) holder.appendChild(body.firstChild)
  body.appendChild(holder)
  blockify(holder)
  for (const bq of Array.from(body.querySelectorAll('blockquote, li'))) {
    if (Array.from(bq.childNodes).some(isBlockNode)) {
      const wrap = doc.createElement('div')
      while (bq.firstChild) wrap.appendChild(bq.firstChild)
      bq.appendChild(wrap)
      blockify(wrap)
    }
  }
  stripAttributes(body)
  tidy(body)
  return { html: body.innerHTML, droppedImages, source }
}

/** §12.11: ProseMirror's transformPastedHTML. */
export function normalizePastedHTML(html: string, o?: NormalizeOptions): string {
  return normalizePasted(html, o).html
}
