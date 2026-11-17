// core/md/index.ts (P1; the integrator's day-0 adapter over spike/s2/src/md.ts boot(), CONTRACTS §3.2, D42).
//
// There is exactly one parser: createMd(). Headless (jsdom in node: call installDom() from
// core/md/dom-env.node.ts first; core never imports it) or live (the browser, `root` = the editor host).
// The member names are S2's own, so the lifted splice code calls them unchanged.
import {
  Editor, rootCtx, schemaCtx, remarkCtx, remarkStringifyOptionsCtx, editorViewCtx,
} from '@milkdown/kit/core'
import type { EditorView } from '@milkdown/kit/prose/view'
import { commonmark, hardbreakClearMarkPlugin } from '@milkdown/kit/preset/commonmark'
import { gfm, remarkGFMPlugin } from '@milkdown/kit/preset/gfm'
import { ParserState, SerializerState } from '@milkdown/kit/transformer'
import type { RemarkParser } from '@milkdown/kit/transformer'
import type { Node as PMNode, Schema } from '@milkdown/kit/prose/model'
import type { MdExtend, MdHandle } from '../../shared/types'
import { StoreError } from '../../shared/errors'
import { CORE_VERSION } from '../../shared/version'
import { fingerprintOf, headlessFingerprint } from './fingerprint'
import {
  codeBlockWithMeta, docWithSuggestionMarks, frontmatterNode, hardbreakClearFormattingMarks, GFM_OPTIONS, imageSchemaFixed, linkWithBareAutolink, mdrTextHandler, rawBlockNode,
  remarkFrontmatterPlugin, STRINGIFY_OPTIONS, suggestionContainerPlugins, suggestionMarkPlugins,
} from './schema'

export { fingerprintOf, headlessFingerprint } from './fingerprint'
export { SuggestionResidueError, SUGGESTION_MARK_NAMES, STRINGIFY_OPTIONS, GFM_OPTIONS } from './schema'

export interface Md extends MdHandle {
  readonly editor: Editor               // the Milkdown editor (headless, or live when `root` was given)
  /** The EditorView: on jsdom headless, in `root` live. S2's plugin-interaction checks use the headless one. */
  readonly view: EditorView
  readonly schema: Schema
  /** Milkdown's fully configured unified processor (remark-parse + every preset remark plugin + stringify). */
  readonly remark: RemarkParser
  /** S2 parseDoc: remark.parse → remark.runSync → mdastToDoc. What "parse(x)" means in CONTRACTS. */
  parseDoc(markdown: string): PMNode
  /** S2 mdastToDoc: Milkdown's ParserState over an already-transformed mdast root. load() converts each top-level child with it. */
  mdastToDoc(root: unknown): PMNode
  /** S2 serializeNodes: top-level nodes → markdown with the stringify defaults, no trailing-newline normalization. */
  serializeNodes(nodes: readonly PMNode[]): string
  destroy(): Promise<void>
}

export interface CreateMdOptions {
  /** Browser only: mount the live EditorView in this element. Omitted = headless (jsdom in node). */
  root?: HTMLElement
  /** P2's hook, run before `create()`: view-only plugins, node views, keymaps, input rules, editorViewOptions. */
  extend?: MdExtend<Editor>
  /**
   * The fingerprint the schema must have after `extend`. The browser passes `boot.schemaFingerprint` (the
   * server's headless fingerprint from the `mdr-fingerprint` meta), so it never boots a second editor to get
   * one. Omitted with `extend` set → `await headlessFingerprint()`.
   */
  expectFingerprint?: string
}

/**
 * The S2 boot sequence: presets, upstream fixes, frontmatter + raw_block, doc marks, suggestion marks, plus the S2-b
 * container marks (bullet_list, ordered_list, list_item, blockquote; §3.2), which must follow gfm.
 */
function configure(root: HTMLElement): Editor {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...STRINGIFY_OPTIONS, handlers: { ...prev.handlers, text: mdrTextHandler as never } }))
      ctx.set(remarkGFMPlugin.options.key, { ...GFM_OPTIONS })
    })
    // commonmark minus its hardbreakClearMarkPlugin, which turns soft line breaks into hard ones (see schema.ts)
    .use(commonmark.filter((p) => p !== hardbreakClearMarkPlugin))
    .use(hardbreakClearFormattingMarks)
    .use(gfm)
    .use(imageSchemaFixed)
    .use(linkWithBareAutolink)
    .use(codeBlockWithMeta)
    .use(remarkFrontmatterPlugin)
    .use(frontmatterNode)
    .use(rawBlockNode)
    .use(docWithSuggestionMarks)
    .use(suggestionContainerPlugins)
    .use(suggestionMarkPlugins.flat())
}

export async function createMd(o: CreateMdOptions = {}): Promise<Md> {
  if (typeof document === 'undefined') {
    throw new Error('core/md: no DOM. In node, call installDom() from core/md/dom-env.node.ts before createMd().')
  }
  const live = o.root !== undefined
  const root = o.root ?? document.createElement('div')
  if (!live) document.body.appendChild(root)

  let editor = configure(root)
  if (o.extend) editor = o.extend(editor)
  try {
    await editor.create()
  } catch (e) {
    if (!live) root.remove()
    throw e
  }

  let schema!: Schema
  let remark!: RemarkParser
  let view!: EditorView
  editor.action((ctx) => {
    schema = ctx.get(schemaCtx)
    remark = ctx.get(remarkCtx)
    view = ctx.get(editorViewCtx)
  })

  const destroy = async (): Promise<void> => {
    await editor.destroy(true)
    if (!live) root.remove()
  }

  const schemaFingerprint = fingerprintOf(schema)
  // The fingerprint assertion (§3.2): whenever `extend` is given, and whenever the caller states the fingerprint it
  // expects (the browser always does, so a stale bundle against a newer server is caught even without `extend`).
  if (o.extend !== undefined || o.expectFingerprint !== undefined) {
    const expected = o.expectFingerprint ?? (await headlessFingerprint())
    if (schemaFingerprint !== expected) {
      await destroy()
      throw new StoreError(
        'CONTRACT_MISMATCH',
        `core/md schema fingerprint ${schemaFingerprint} does not match the expected ${expected}; ` +
          '`extend` may add plugins, node views, keymaps and input rules, never node or mark specs',
        { details: { expected, actual: schemaFingerprint } },
      )
    }
  }

  const mdastToDoc = (tree: unknown): PMNode => {
    const state = new ParserState(schema)
    state.next(tree as never)
    return state.toDoc()
  }
  const parseDoc = (markdown: string): PMNode => {
    const tree = remark.runSync(remark.parse(markdown), markdown)
    return mdastToDoc(tree)
  }
  const serializeNodes = (nodes: readonly PMNode[]): string => {
    const doc = schema.topNodeType.create(null, nodes as PMNode[])
    return SerializerState.create(schema, remark)(doc)
  }

  return {
    editor, view, schema, remark, parseDoc, mdastToDoc, serializeNodes, destroy,
    schemaFingerprint, coreVersion: CORE_VERSION, live,
  }
}
