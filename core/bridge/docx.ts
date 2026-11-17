// core/bridge/docx.ts. The reviewed doc as a Word file: the document as it stands (accepted changes are already in the
// .md; pending suggestions are not applied) with every open thread as a real Word comment anchored on its span, and
// replies threaded under it (commentsExtended, Word 2013+; older readers show them as separate comments on the same
// span). Pure: the walk follows core/ptext.ts's traversal exactly, so thread.resolution offsets place
// commentRangeStart / commentRangeEnd on the right characters; the zip is written uncompressed (valid OOXML, no zlib).
import type { Mark, Node as PMNode } from '@milkdown/kit/prose/model'
import type { ExportThread } from './export-plan'

const OBJ_LEN = 1
const ATOMS = new Set(['frontmatter', 'raw_block', 'hr'])

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    // XML 1.0 forbids most C0 controls
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')

const tRun = (text: string, rPr: string): string => (text ? `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : '')

interface Ev { at: number; kind: 'start' | 'end'; ids: number[] }

interface Comment { id: number; author: string; date: string; initials: string; body: string; paraId: string; parent?: string }

export interface BuiltDocx { bytes: Uint8Array; comments: number; replies: number; general: number }

const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).map((w) => [...w][0]!.toUpperCase()).join('').slice(0, 4) || 'C'

export function buildDocx(doc: PMNode, threads: readonly ExportThread[], o: { title: string; author: string; now?: Date }): BuiltDocx {
  const date = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // ---- comments and their range events
  const comments: Comment[] = []
  const events: Ev[] = []
  const generalIds: number[] = []
  let paraSeq = 0x10000000
  const nextPara = (): string => (paraSeq++).toString(16).toUpperCase().padStart(8, '0')
  let general = 0
  for (const t of threads) {
    const ids: number[] = []
    let parentPara: string | undefined
    t.messages.forEach((m, k) => {
      const id = comments.length
      const paraId = nextPara()
      let body = m.body
      if (k === 0 && !t.span && t.quote) body = `(General comment on “${t.quote.slice(0, 120)}”) ${body}`
      comments.push({ id, author: m.who, date: m.at ? m.at.replace(/\.\d{3}Z$/, 'Z') : date, initials: initialsOf(m.who), body, paraId, ...(k > 0 && parentPara ? { parent: parentPara } : {}) })
      if (k === 0) parentPara = paraId
      ids.push(id)
    })
    if (t.span) {
      events.push({ at: t.span.from, kind: 'start', ids }, { at: t.span.to, kind: 'end', ids })
    } else {
      general++
      generalIds.push(...ids)
    }
  }
  events.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'end' ? -1 : 1))

  // ---- relationships for links
  const links: string[] = []
  const linkRel = (href: string): string => {
    let i = links.indexOf(href)
    if (i < 0) i = links.push(href) - 1
    return `rIdL${i + 1}`
  }

  // ---- numbering: one bullet definition; every ordered list gets its own instance (restart)
  const orderedStarts: number[] = []

  // ---- the walk
  let off = 0          // ptext offset at the start of the next segment
  let first = true     // no '\n' joiner before the first segment
  let ei = 0
  const body: string[] = []

  const endTag = (id: number): string => `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`
  /** Every range boundary at or before ptext offset `pos` (ends before starts at the same offset). */
  const emit = (pos: number): string => {
    let s = ''
    while (ei < events.length && events[ei]!.at <= pos) {
      const e = events[ei++]!
      s += e.kind === 'start' ? e.ids.map((id) => `<w:commentRangeStart w:id="${id}"/>`).join('') : e.ids.map(endTag).join('')
    }
    return s
  }

  /** Start a ptext segment; returns its start offset. */
  const segment = (): number => {
    if (!first) off += 1
    first = false
    return off
  }

  const rPrOf = (marks: readonly Mark[]): string => {
    let r = ''
    for (const m of marks) {
      if (m.type.name === 'strong') r += '<w:b/>'
      else if (m.type.name === 'emphasis') r += '<w:i/>'
      else if (m.type.name === 'strike_through') r += '<w:strike/>'
      else if (m.type.name === 'inlineCode') r += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>'
    }
    if (marks.some((m) => m.type.name === 'link')) r = '<w:rStyle w:val="Hyperlink"/>' + r
    return r
  }

  /** Inline content of a textblock, with comment markers at their offsets. */
  const inline = (node: PMNode, codeBlock = false): string => {
    let s = ''
    let pos = off
    let linkOpen: string | null = null
    const closeLink = (): void => {
      if (linkOpen !== null) s += '</w:hyperlink>'
      linkOpen = null
    }
    s += emit(pos)
    node.forEach((child) => {
      const href = child.marks.find((m) => m.type.name === 'link')?.attrs.href as string | undefined
      if ((href ?? null) !== linkOpen) {
        closeLink()
        if (href) {
          s += `<w:hyperlink r:id="${linkRel(href)}">`
          linkOpen = href
        }
      }
      if (child.isText) {
        const text = child.text ?? ''
        const rPr = codeBlock ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : rPrOf(child.marks)
        // split at every event inside this run
        let k = 0
        while (k < text.length) {
          const nextEv = events[ei]
          let stop = text.length
          if (nextEv && nextEv.at > pos && nextEv.at < pos + (text.length - k)) stop = k + (nextEv.at - pos)
          const piece = text.slice(k, stop)
          if (codeBlock) {
            piece.split('\n').forEach((ln, li) => {
              if (li > 0) s += '<w:r><w:br/></w:r>'
              s += tRun(ln, rPr)
            })
          } else s += tRun(piece, rPr)
          pos += piece.length
          k = stop
          s += emit(pos)
        }
      } else if (child.type.name === 'hardbreak') {
        s += '<w:r><w:br/></w:r>'
        pos += 1
        s += emit(pos)
      } else {
        const label = child.type.name === 'image' ? `[image${child.attrs.alt ? `: ${String(child.attrs.alt)}` : ''}]`
          : child.type.name === 'footnote_reference' ? `[^${String(child.attrs.label ?? '')}]`
          : child.type.name === 'html' ? String(child.attrs.value ?? '') : ''
        s += tRun(label, '<w:color w:val="666666"/>')
        pos += OBJ_LEN
        s += emit(pos)
      }
    })
    closeLink()
    off = pos
    return s
  }

  const para = (pPr: string, content: string): string => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`

  let firstParaDone = false
  const generalStart = (): string => (generalIds.length && !firstParaDone ? generalIds.map((id) => `<w:commentRangeStart w:id="${id}"/>`).join('') : '')
  const generalEnd = (): string => {
    if (!generalIds.length || firstParaDone) return ''
    firstParaDone = true
    return generalIds.map(endTag).join('')
  }

  const textblock = (node: PMNode, pPr: string, code = false): string => {
    segment()
    const gs = generalStart()
    const content = inline(node, code)
    return para(pPr, gs + content + generalEnd())
  }

  const block = (node: PMNode, ctx: { list?: { num: number; level: number }; quote?: boolean; top: boolean }): string => {
    const name = node.type.name
    if (ATOMS.has(name)) {
      segment()
      off += OBJ_LEN
      const m = emit(off)
      if (name === 'hr') return para('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="AAAAAA"/></w:pBdr>', m)
      if (name === 'raw_block') return para('<w:pStyle w:val="Code"/>', tRun(String(node.attrs.value ?? node.textContent ?? ''), '') + m)
      return m ? para('', m) : ''
    }
    if (name === 'paragraph') {
      if (ctx.top && node.content.size === 0) return ''     // §5.1: top-level empty paragraphs are skipped
      let pPr = ''
      if (ctx.list) pPr = `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ctx.list.level}"/><w:numId w:val="${ctx.list.num}"/></w:numPr>`
      else if (ctx.quote) pPr = '<w:pStyle w:val="Quote"/>'
      return textblock(node, pPr)
    }
    if (name === 'heading') return textblock(node, `<w:pStyle w:val="Heading${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}"/>`)
    if (name === 'code_block') return textblock(node, '<w:pStyle w:val="Code"/>', true)
    if (name === 'blockquote') {
      let s = ''
      node.forEach((c) => (s += block(c, { ...ctx, top: false, quote: true })))
      return s
    }
    if (name === 'bullet_list' || name === 'ordered_list') {
      const level = ctx.list ? ctx.list.level + 1 : 0
      let num = 1
      if (name === 'ordered_list') {
        orderedStarts.push(Number(node.attrs.order) || 1)
        num = orderedStarts.length + 1
      }
      let s = ''
      node.forEach((item) => {
        let firstChild = true
        item.forEach((c) => {
          if (c.type.name === 'paragraph' && firstChild) {
            const checked = item.attrs.checked
            const box = checked === true ? '☒ ' : checked === false ? '☐ ' : ''
            segment()
            const gs = generalStart()
            const content = inline(c)
            s += para(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${Math.min(level, 8)}"/><w:numId w:val="${num}"/></w:numPr>`, gs + tRun(box, '') + content + generalEnd())
          } else if (c.type.name === 'bullet_list' || c.type.name === 'ordered_list') {
            s += block(c, { list: { num, level }, top: false })
          } else {
            s += block(c, { ...(ctx.quote ? { quote: true } : {}), top: false })
          }
          firstChild = false
        })
      })
      return s
    }
    if (name === 'table') {
      let rows = ''
      node.forEach((row) => {
        let cells = ''
        const header = row.type.name === 'table_header_row'
        row.forEach((cell) => {
          let inner = ''
          cell.forEach((c) => {
            if (c.isTextblock) {
              segment()
              const align = cell.attrs.alignment === 'center' ? '<w:jc w:val="center"/>' : cell.attrs.alignment === 'right' ? '<w:jc w:val="right"/>' : ''
              const content = inline(c)
              inner += para(align, header ? content.replace(/<w:r>(<w:rPr>)?/g, (_m, p: string | undefined) => (p ? '<w:r><w:rPr><w:b/>' : '<w:r><w:rPr><w:b/></w:rPr>')) : content)
            } else inner += block(c, { top: false })
          })
          cells += `<w:tc><w:tcPr>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>${inner || '<w:p/>'}</w:tc>`
        })
        rows += `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`
      })
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${rows}</w:tbl><w:p/>`
    }
    if (name === 'footnote_definition') {
      let s = ''
      node.forEach((c) => (s += block(c, { ...ctx, top: false })))
      return s
    }
    // anything else with children: walk them; a leaf: one object unit
    if (node.isTextblock) return textblock(node, '')
    if (node.isLeaf) {
      segment()
      off += OBJ_LEN
      return ''
    }
    let s = ''
    node.forEach((c) => (s += block(c, { ...ctx, top: false })))
    return s
  }

  doc.forEach((n) => body.push(block(n, { top: true })))
  // anything not closed (an end past the last segment, or general comments on an empty doc) closes at the end
  let tail = emit(Infinity)
  if (generalIds.length && !firstParaDone) tail = generalStart() + generalEnd() + tail
  if (tail) body.push(`<w:p>${tail}</w:p>`)

  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15"'
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`

  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments ${NS}>${comments.map((c) => {
    const lines = c.body.split(/\r?\n/)
    const paras = lines.map((ln, i) => {
      const last = i === lines.length - 1
      return `<w:p${last ? ` w14:paraId="${c.paraId}" w14:textId="77777777"` : ''}><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${i === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : ''}${tRun(ln, '')}</w:p>`
    }).join('')
    return `<w:comment w:id="${c.id}" w:author="${esc(c.author)}" w:date="${c.date}" w:initials="${esc(c.initials)}">${paras}</w:comment>`
  }).join('')}</w:comments>`

  const commentsExXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w15:commentsEx ${NS}>${comments.map((c) => `<w15:commentEx w15:paraId="${c.paraId}"${c.parent ? ` w15:paraIdParent="${c.parent}"` : ''} w15:done="0"/>`).join('')}</w15:commentsEx>`

  const lvls = (fmt: 'bullet' | 'decimal'): string => Array.from({ length: 9 }, (_, i) => {
    const text = fmt === 'bullet' ? ['•', '◦', '▪'][i % 3]! : `%${i + 1}.`
    const numFmt = fmt === 'bullet' ? 'bullet' : ['decimal', 'lowerLetter', 'lowerRoman'][i % 3]!
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
  }).join('')
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${orderedStarts.map((start, i) => `<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`).join('')}</w:numbering>`

  const heading = (n: number, size: number): string => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n < 3 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + [heading(1, 36), heading(2, 30), heading(3, 26), heading(4, 24), heading(5, 22), heading(6, 22)].join('')
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BBBBBB"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '</w:styles>'

  // without compatibilityMode 15 Word opens the file in Compatibility Mode
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings ${NS}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`

  const hasComments = comments.length > 0
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
    + (hasComments ? '<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rIdCommentsEx" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>' : '')
    + links.map((href, i) => `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`).join('')
    + '</Relationships>'
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + (hasComments ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>' : '')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '</Types>'
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(o.title)}</dc:title><dc:creator>${esc(o.author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created></cp:coreProperties>`

  const files: Array<[string, string]> = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['docProps/core.xml', coreXml],
    ['word/document.xml', documentXml],
    ['word/_rels/document.xml.rels', docRels],
    ['word/styles.xml', stylesXml],
    ['word/numbering.xml', numberingXml],
    ['word/settings.xml', settingsXml],
    ...(hasComments ? [['word/comments.xml', commentsXml], ['word/commentsExtended.xml', commentsExXml]] as Array<[string, string]> : []),
  ]
  const replies = comments.filter((c) => c.parent).length
  return { bytes: zipStore(files), comments: comments.length - replies, replies, general }
}

// ------------------------------------------------------------------------------------------------------------------
// A minimal zip writer: STORE (no compression), UTF-8 names, CRC-32. Enough for OOXML.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function zipStore(files: ReadonlyArray<[string, string | Uint8Array]>): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of files) {
    const data = typeof content === 'string' ? enc.encode(content) : content
    const nameB = enc.encode(name)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameB.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)          // UTF-8 names
    lv.setUint16(8, 0, true)               // STORE
    lv.setUint16(10, 0, true)
    lv.setUint16(12, 0x21, true)           // 1980-01-01
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameB.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameB, 30)
    local.set(data, 30 + nameB.length)
    const central = new Uint8Array(46 + nameB.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameB, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + cdSize + 22)
  let p = 0
  for (const l of locals) {
    out.set(l, p)
    p += l.length
  }
  for (const c of centrals) {
    out.set(c, p)
    p += c.length
  }
  out.set(end, p)
  return out
}
