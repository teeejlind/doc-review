// core/md/schema.ts (P1; lifted from spike/s2/src/md.ts on day 0, CONTRACTS §3.2).
//
// The Milkdown 7 schema additions and upstream fixes S2 proved (FINDINGS "Failure categories" 1, code-fence meta,
// the raw_block fallback, the doc marks override, the stringify defaults). core/md/index.ts boots them; nothing
// else may construct a schema. The S2-b additions (suggestion marks on bullet_list / ordered_list / list_item /
// blockquote, §3.2) are below; createMd's signature is unchanged.
import { blockquoteSchema, bulletListSchema, hardbreakSchema, imageSchema, codeBlockSchema, linkSchema, orderedListSchema } from '@milkdown/kit/preset/commonmark'
import { extendListItemSchemaForTask } from '@milkdown/kit/preset/gfm'
import { $node, $prose, $remark, $markSchema } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state'
import { AddMarkStep, ReplaceStep } from '@milkdown/kit/prose/transform'
import { Fragment, type MarkSpec, type Node as PMNode } from '@milkdown/kit/prose/model'
import remarkFrontmatter from 'remark-frontmatter'
import { addSuggestionMarks } from '@handlewithcare/prosemirror-suggest-changes'
import { StoreError } from '../../shared/errors'
import { autolinkRuns, bareLinkKind, fallbackAutolink, type AutolinkKind } from './autolink'

// ---------------------------------------------------------------- custom nodes

/** remark-frontmatter, registered through Milkdown so parse AND stringify both get it. */
export const remarkFrontmatterPlugin = $remark('remarkFrontmatter', () => remarkFrontmatter as never, ['yaml', 'toml'])

/** Frontmatter: an atom block holding the raw YAML/TOML text (the editor renders it as a panel). */
export const frontmatterNode = $node('frontmatter', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  selectable: true,
  attrs: { value: { default: '' }, kind: { default: 'yaml' } },
  parseDOM: [{ tag: 'pre[data-frontmatter]', getAttrs: (dom) => ({ value: (dom as HTMLElement).textContent ?? '' }) }],
  toDOM: (node) => ['pre', { 'data-frontmatter': node.attrs.kind }, node.attrs.value],
  parseMarkdown: {
    match: (n) => n.type === 'yaml' || n.type === 'toml',
    runner: (state, n, type) => {
      state.addNode(type, { value: (n as { value?: string }).value ?? '', kind: n.type })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'frontmatter',
    runner: (state, node) => {
      state.addNode(node.attrs.kind as string, undefined, node.attrs.value as string)
    },
  },
}))

/**
 * raw_block: the lossless fallback. Holds the exact source bytes of a block Milkdown can't
 * represent faithfully. Never produced by the markdown parser directly; the splice layer
 * creates it. Serializes back verbatim (the splicer writes attrs.value directly).
 */
export const rawBlockNode = $node('raw_block', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  selectable: true,
  attrs: { value: { default: '' }, reason: { default: '' } },
  parseDOM: [{ tag: 'pre[data-raw-block]', getAttrs: (dom) => ({ value: (dom as HTMLElement).textContent ?? '' }) }],
  toDOM: (node) => ['pre', { 'data-raw-block': node.attrs.reason }, node.attrs.value],
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === 'raw_block',
    runner: (state, node) => {
      state.addNode('html', undefined, node.attrs.value as string)
    },
  },
}))

/**
 * Doc override: same as commonmark's doc, plus `marks` so suggest-changes can put
 * insertion/deletion marks on block nodes. commonmark's docSchema is a plain $node (no
 * extendSchema), but $node upserts by id, so registering 'doc' again after commonmark wins.
 */
export const docWithSuggestionMarks = $node('doc', () => ({
  content: 'block+',
  marks: 'insertion modification deletion',
  parseMarkdown: {
    match: ({ type }) => type === 'root',
    runner: (state, node, type) => {
      state.injectRoot(node, type)
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'doc',
    runner: (state, node) => {
      state.openNode('root')
      state.next(node.content)
    },
  },
}))

/**
 * Pending suggestions must never reach the .md (R5.2). A StoreError with code SUGGESTION_RESIDUE, so routes and
 * the CLI map it 1:1 (§3.9); `instanceof SuggestionResidueError` still distinguishes it.
 */
export class SuggestionResidueError extends StoreError {
  constructor(message: string) {
    super('SUGGESTION_RESIDUE', message)
  }
}

// suggest-changes marks, wrapped for Milkdown (every Milkdown mark needs parse/toMarkdown).
const suggestionSpecs = addSuggestionMarks({} as Record<never, MarkSpec>)
export const SUGGESTION_MARK_NAMES = ['insertion', 'deletion', 'modification'] as const
export const suggestionMarkPlugins = SUGGESTION_MARK_NAMES.map((name) =>
  $markSchema(name, () => ({
    ...(suggestionSpecs[name] as object),
    parseMarkdown: { match: () => false, runner: () => {} },
    toMarkdown: {
      match: (mark) => mark.type.name === name,
      runner: () => {
        // Defense in depth: pending suggestions must never reach the .md (R5.2).
        throw new SuggestionResidueError(`suggestion mark "${name}" reached the markdown serializer`)
      },
    },
  })),
)

// ---------------------------------------------------------------- S2-b: suggestion marks inside lists and quotes

/**
 * In ProseMirror a node's marks are allowed by its PARENT's `marks` spec. These containers allow no marks by default,
 * so without this a list-item insertion (the inserted list_item, or the paragraph inside it) or a task-checkbox
 * toggle (an AttrStep that suggest-changes tracks with a `modification` mark on the list_item) could not be marked in
 * Suggesting mode. Table nodes deliberately get nothing (D14). The containers allowed no marks before, so the
 * suggestion marks are their whole set.
 *
 * list_item extends gfm's task-list extension, not commonmark's base schema: `extendSchema` wraps the schema factory
 * of the object it is called on, and gfm's version carries the `checked` attr. All four register after the presets in
 * core/md/index.ts, and `$node` upserts by id, so these specs win.
 */
const SUGGESTION_MARKS_SPEC = 'insertion modification deletion'
export const bulletListWithSuggestionMarks = bulletListSchema.extendSchema((prev) => (ctx) => ({ ...prev(ctx), marks: SUGGESTION_MARKS_SPEC }))
export const orderedListWithSuggestionMarks = orderedListSchema.extendSchema((prev) => (ctx) => ({ ...prev(ctx), marks: SUGGESTION_MARKS_SPEC }))
const isEmptyParagraph = (n: PMNode | null | undefined): boolean => !!n && n.type.name === 'paragraph' && n.content.size === 0

/**
 * QA2 30: Enter leaves an empty list item or quote line, and Milkdown serializes an empty paragraph as the `<br />`
 * placeholder, which put HTML the user never wrote into the .md ("- <br />"). An item that is only an empty paragraph
 * now serializes as the bare marker ("-", "3."): markdown reads it back as the same empty item (a task item loses its
 * checkbox until it has text, since a lone "- [ ]" is not a task). A quote's trailing empty paragraphs are left out:
 * the line has no markdown form until it has text. The `<br />` spelling an earlier build wrote still parses (to the
 * same empty paragraph) and loads as an editable list; core/splice/eq.ts normMdast treats the two as one.
 */
export const listItemWithSuggestionMarks = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    marks: SUGGESTION_MARKS_SPEC,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        if (node.childCount === 1 && isEmptyParagraph(node.firstChild)) {
          // an empty mdast paragraph (not the `<br />` html child the paragraph schema adds), which prints as "-"
          state.openNode('listItem', undefined, { spread: node.attrs.spread })
          state.addNode('paragraph', [])
          state.closeNode()
          return
        }
        base.toMarkdown.runner(state, node)
      },
    },
  }
})
export const blockquoteWithSuggestionMarks = blockquoteSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    marks: SUGGESTION_MARKS_SPEC,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const kept: PMNode[] = []
        node.forEach((c) => kept.push(c))
        while (kept.length > 0 && isEmptyParagraph(kept[kept.length - 1])) kept.pop()
        if (!kept.some(isEmptyParagraph)) {
          base.toMarkdown.runner(state, kept.length === node.childCount ? node : node.copy(Fragment.fromArray(kept)))
          return
        }
        // QA3: an empty quote line inside the quote is a bare '>' line, never the paragraph's `<br />` placeholder
        state.openNode('blockquote')
        for (const c of kept) {
          if (isEmptyParagraph(c)) state.addNode('paragraph', [])
          else state.next(c)
        }
        state.closeNode()
      },
    },
  }
})

/**
 * QA3: a link whose text is its own address (https://…, www.…, name@host) goes to the text handler below as flagged
 * text, which writes it bare where GFM reads it back as the same link (else `<…>`), instead of remark's `<…>` /
 * `[www.x](http://www.x)` forms. Only a plain text node whose one mark is the link, with no title.
 */
export const linkWithBareAutolink = linkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, mark, node) => {
        const kind = node.isText && node.marks.length === 1 && !mark.attrs.title ? bareLinkKind(node.text ?? '', String(mark.attrs.href ?? '')) : null
        if (!kind) return base.toMarkdown.runner(state, mark, node)
        state.addNode('text', undefined, node.text ?? '', { mdrAutolink: kind })
        return true
      },
    },
  }
})
/** The S2-b container plugins, registered after commonmark and gfm. */
export const suggestionContainerPlugins = [
  bulletListWithSuggestionMarks, orderedListWithSuggestionMarks, listItemWithSuggestionMarks, blockquoteWithSuggestionMarks,
].flat()

// ---------------------------------------------------------------- upstream fixes

/**
 * BUG in @milkdown/preset-commonmark 7.22.2: the image parse runner passes mdast's `title: null`
 * into an attr declared `validate: 'string'`. prosemirror-model >=1.25 validates attrs and
 * throws; ParserState.addNode swallows the throw with console.error, so EVERY titleless image
 * (`![alt](src)`) is silently dropped from the PM doc. Coerce null -> ''.
 */
export const imageSchemaFixed = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        state.addNode(type, { src: (node.url as string) ?? '', alt: (node.alt as string) ?? '', title: (node.title as string) ?? '' })
      },
    },
  }
})

/** code_block drops the fence info string's meta (```ts title="x.ts"```). Carry it as an attr. */
export const codeBlockWithMeta = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...base.attrs, meta: { default: '' } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        state.openNode(type, { language: (node.lang as string) ?? '', meta: (node.meta as string) ?? '' })
        if (node.value) state.addText(node.value as string)
        state.closeNode()
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.addNode('code', undefined, node.content.firstChild?.text || '', {
          lang: node.attrs.language,
          meta: node.attrs.meta || null,
        })
      },
    },
  }
})

// ---------------------------------------------------------------- stringify defaults

/**
 * Match the workspace's dominant conventions so re-serialized blocks drift less:
 * '-' bullets (1737 vs 39 '*'), '---' rules (495/495). Unpadded table columns: GFM_OPTIONS.
 */
export const STRINGIFY_OPTIONS = { bullet: '-', rule: '-' } as const

interface PhrasingInfo { before: string; after: string }
interface StringifyState { safe(value: string, info: PhrasingInfo & { encode?: string[] }): string; stack: string[] }
/** Constructs inside which GFM never reads an autolink literal (or where a bare address would break out). */
const NO_AUTOLINK = new Set(['label', 'link', 'image', 'autolink', 'reference', 'destinationLiteral', 'destinationRaw', 'titleQuote', 'titleApostrophe'])

/**
 * The remark-stringify `text` handler: Milkdown's own (a value ending in whitespace with no `*`, `_` or `\\` goes out as
 * it is; everything else through `safe`), plus two QA3 fixes:
 * - spaces and tabs at the start of a line are dropped: markdown can't keep them (the parser strips them), and left
 *   in, `safe` wrote them as `&#x20;` / `&#x9;`;
 * - address runs (core/md/autolink.ts) go out unescaped where GFM reads them back as that link, and a flagged link
 *   (linkWithBareAutolink) goes out bare or as `<…>`.
 */
export function mdrTextHandler(node: { value: string; mdrAutolink?: AutolinkKind }, parent: { type?: string; children?: unknown[] } | undefined, state: StringifyState, info: PhrasingInfo): string {
  const free = !state.stack.some((c) => NO_AUTOLINK.has(c))
  if (node.mdrAutolink) {
    const v = node.value
    const r = free ? autolinkRuns(v, info.before, info.after) : []
    return r.length === 1 && r[0]!.start === 0 && r[0]!.end === v.length ? v : fallbackAutolink(v, node.mdrAutolink)
  }
  let value = node.value
  const first = (parent?.type === 'paragraph' || parent?.type === 'heading') && parent.children?.[0] === node
  if (first || /[\r\n]$/.test(info.before)) value = value.replace(/^[ \t]+/, '')
  if (/^[^*_\\]*\s+$/.test(value)) return value
  const runs = free ? autolinkRuns(value, info.before, info.after) : []
  if (!runs.length) return state.safe(value, { ...info, encode: [] })
  let out = ''
  let last = 0
  for (const r of runs) {
    if (r.start > last) out += state.safe(value.slice(last, r.start), { before: last === 0 ? info.before : value[last - 1]!, after: value[r.start]!, encode: [] })
    out += value.slice(r.start, r.end)
    last = r.end
  }
  if (last < value.length) out += state.safe(value.slice(last), { before: value[last - 1]!, after: info.after, encode: [] })
  return out
}
/**
 * What the handler's output starts with, for the previous sibling's `after` (mdast-util-to-markdown peeks with
 * `before: ''`, which must not count as a line start: " now" after a link peeks as ' ', not 'n').
 */
mdrTextHandler.peek = (node: { value: string; mdrAutolink?: AutolinkKind }, _parent: unknown, state: StringifyState, info: PhrasingInfo): string => {
  if (node.mdrAutolink) return node.value.slice(0, 1)
  const value = node.value
  if (/^[^*_\\]*\s+$/.test(value)) return value.slice(0, 1)
  return state.safe(value, { ...info, encode: [] }).slice(0, 1)
}
export const GFM_OPTIONS = { tablePipeAlign: false } as const

/**
 * Replaces commonmark's hardbreakClearMarkPlugin (final pass 2026-11-16). Upstream keeps marks off a line break by
 * re-creating the node with `setNodeMarkup(pos, hardbreak, undefined, [])` whenever a transaction's first step adds a
 * mark over one. `undefined` attrs reset `isInline` to false, which turns a soft line break (a plain newline in the
 * .md) into a hard break (a backslash and a newline), and the `[]` also drops suggestion marks. So a Claude suggestion
 * across a soft break ("text\nline two" → "text, line two") lost its deletion mark the moment it was shown, its
 * insertion was left behind as a phantom suggestion by the user, and the next save wrote a stray `\` into a line nobody
 * touched; bolding a selection across a soft break did the same. This one does upstream's job (formatting marks off
 * a line break) but keeps the node's attrs and its suggestion marks.
 */
export const hardbreakClearFormattingMarks = $prose((ctx) => new Plugin({
  key: new PluginKey('MDR_HARDBREAK_MARKS'),
  appendTransaction: (trs, _old, state) => {
    const type = hardbreakSchema.type(ctx)
    const keep = new Set<string>(SUGGESTION_MARK_NAMES)
    let tr: Transaction | null = null
    const ranges: Array<[number, number]> = []
    for (const t of trs) {
      t.steps.forEach((step, i) => {
        const fresh = t.getMeta('hardbreak') && step instanceof ReplaceStep
        if (!fresh && !(step instanceof AddMarkStep)) return
        // map the step's range to the final doc through the rest of this transaction and the ones after it
        let from = (step as ReplaceStep | AddMarkStep).from
        let to = fresh ? from + 1 : (step as AddMarkStep).to
        const rest = t.mapping.slice(i + 1)
        from = rest.map(from, -1)
        to = rest.map(to, 1)
        for (const later of trs.slice(trs.indexOf(t) + 1)) {
          from = later.mapping.map(from, -1)
          to = later.mapping.map(to, 1)
        }
        ranges.push([from, Math.min(to, state.doc.content.size)])
      })
    }
    for (const [from, to] of ranges) {
      if (to <= from) continue
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type !== type) return true
        const marks = node.marks.filter((m) => keep.has(m.type.name))
        if (marks.length === node.marks.length) return false
        tr ??= state.tr
        tr.setNodeMarkup(pos, type, node.attrs, marks)
        return false
      })
    }
    return tr
  },
}))
