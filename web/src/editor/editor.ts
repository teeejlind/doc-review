// web/src/editor/editor.ts (P2). The live editor: Milkdown from createMd({ root, extend, expectFingerprint }), the
// dispatch pipeline, Editing / Suggesting modes, the suggestion and comment bookkeeping, and the EditorPort the
// session drives (web/src/session/internals.ts). The EditorBridge P3 sees is a thin facade over this (bridge.ts).
//
// Dispatch pipeline (every view.dispatch):
//   1. classify: programmatic (mdr.origin meta or history$), housekeeping (Milkdown's view plugins rewriting volatile
//      attrs such as heading.id), or a user transaction;
//   2. read-only → user edits and undo/redo are dropped;
//   3. user: the foreign-content filter (both modes) and, in Suggesting mode, the D14 blocks run on the ORIGINAL
//      transaction (§6.5); a refusal raises an EditorNotice and nothing applies;
//   4. withSuggestChanges(apply, () => 's_' + ulid()) transforms user transactions in Suggesting mode (skip meta on
//      every programmatic one, I-SKIP); a transform the schema refuses is a SUGGEST_MODE_BLOCKED notice;
//   5. apply: state.applyTransaction (idGuard appends its I-ID fixes), view.updateState, then the bookkeeping:
//      decision journal, dirty generation (§12.4: not hydrate / reload / decide / unmark / install), mark-change
//      clock for the upsert throttle, typing activity, layout invalidation.
import { editorViewOptionsCtx, schemaCtx, type Editor } from '@milkdown/kit/core'
import {
  inputRules as commonmarkInputRules, keymap as commonmarkKeymap, markInputRules as commonmarkMarkInputRules,
} from '@milkdown/kit/preset/commonmark'
import { inputRules as gfmInputRules, keymap as gfmKeymap, markInputRules as gfmMarkInputRules } from '@milkdown/kit/preset/gfm'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { closeHistory, history, redo, undo } from '@milkdown/kit/prose/history'
import { undoInputRule } from '@milkdown/kit/prose/inputrules'
import { joinForward } from '@milkdown/kit/prose/commands'
import { EditorState, Selection, TextSelection, type Command, type Transaction } from '@milkdown/kit/prose/state'
import { ReplaceAroundStep, AttrStep, Mapping, type Transform } from '@milkdown/kit/prose/transform'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { suggestChanges, suggestChangesKey, withSuggestChanges } from '@handlewithcare/prosemirror-suggest-changes'
import { ulid } from 'ulid'
import { CONSTANTS, TESTID } from '../../../shared/constants'
import { StoreError } from '../../../shared/errors'
import type {
  Anchor, AnchorRect, AnchorUpdate, Author, BlockConflict, BlockInfo, DocSession, EditorNotice, Mode, OpKey, ReviewState,
  SuggestionId, SuggestionSummary, TextAnchor, ThreadId, TjSuggestionUpsert,
} from '../../../shared/types'
import { createAnchor, resolveAnchor } from '../../../core/anchors'
import { blockHash } from '../../../core/hash'
import { createMd, type Md } from '../../../core/md/index'
import { ptextOf, type PText } from '../../../core/ptext'
import { contentNodes, VOLATILE_ATTRS } from '../../../core/splice/eq'
import { applyBlockOps, assembleOps } from '../../../core/splice/apply'
import { load, loadRun, type Loaded } from '../../../core/splice/load'
import { alignNodes, planSave } from '../../../core/splice/plan'
import { locate } from '../../../core/suggest/record'
import { extract, tjSuggestionDiff } from '../../../core/suggest/extract'
import { alignLive, hydrate, type LiveAlignment, type Unplaced } from '../../../core/suggest/hydrate'
import {
  baseChangedBy, decideSuggestions, foreignViolation, idGuard, isProgrammaticTr, kindOf, markIdOf, mdrMeta, onlyApplied, reassignIds, retypeGuard, revertAll,
  SUGGEST_BLOCK_TEXT, suggestModeViolation, suggestionIdsIn, suggestionMarkTypes, suggestionSegments, touchedRanges, ZWSP,
  type MdrMeta, type MdrOrigin, type SuggestBlockReason,
} from '../../../core/suggest/guards'
import type { DraftState, EditorPort, ReloadApply, ReopenGroup, SessionInternals, SuggestionPlan } from '../session/internals'
import { buildMinimalReplaceTr } from '../session/remote'
import { docDiffSteps } from './docdiff'
import {
  backspaceBetweenLists, backspaceBlockquote, backspaceLift, commandFor, enterKey, exitCodeBlock, hardBreak, indent, joinNextText, outdent, type ToolbarAction,
} from './commands'
import { FrontmatterView } from './frontmatter/view'
import { mdrInputRulesPlugin } from './inputRules'
import { joinAcrossStruck, joinOwnInsertion, joinOwnSplit, ownInsertionScope } from './ownInsertion'
import { autolinkBefore } from './autolink'
import { assetUrl } from './assets'
import { CodeBlockView, HardbreakView, ImageView, InlineHtmlView, ListItemView, RawBlockView, type NodeViewHooks } from './nodeViews'
import { pastePlugin } from './paste/plugin'
import { PopoverSlot } from './popover'
import { statusBlockPlugin, statusCollapsed, statusKey, blockRange } from './statusBlock'
import { atomGuardPlugin, guardKeyDown } from './atomGuard'
import { stickyHeaderPlugin } from './stickyHeader'
import { actionState, cellAt, fixTablesGuard, tableActionTr, TableControls, tableControlsPlugin, tableEnter, tableTab, type TableAction } from './tables'
import { conflictKey, conflictPlugin, DRAFT_PLACE, highlightKey, highlightPlugin, isCollapsed, spacerKey, spacerPlugin, threadsAt, type ConflictPlace, type ThreadPlace } from './highlights'
import { DecisionJournal, type JournalEntry } from './journal'
import { KeyRouter, type P2Action } from './keymap'
import { LinkPopover, linkAllowed, linkBoundaryPlugin, linkRange } from './linkPopover'
import { coordsAt, elementBox, nodeBox, toContent } from './rects'
import { offsetNear, selectionTarget } from './selection'
import { bidiPlugin } from './bidi'
import { suggestDecoKey, suggestDecoPlugin } from './suggestDecos'
import { Toolbar } from './toolbar'

export type LayoutReason = 'doc' | 'decorations' | 'reload' | 'mode' | 'resize'

/** Keys that are only a modifier going down: they never end the Esc-then-Tab way out of the document. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

/** How long after a composition ends ProseMirror takes to read its text (its own settle timer is 20 ms). */
const COMPOSITION_SETTLE_MS = 60

/** Origins whose doc changes are TJ's edits (dirty, §12.4) even though they are programmatic. */
const DIRTY_ORIGINS: ReadonlySet<MdrOrigin> = new Set<MdrOrigin>(['restore-draft', 'keep-mine', 'take-theirs', 'raw-commit', 'revive', 'refused'])

export interface MdrEditorOptions {
  host: HTMLElement
  toolbarHost: HTMLElement
  scrollContainer: HTMLElement
  session: DocSession
  internals: SessionInternals
}

interface UnplacedEntry { reason: Unplaced; seq: number; L: Loaded | null }

/** Milkdown's view plugins rewrite volatile attrs (heading.id, list_item.label) with addToHistory false. */
function isVolatileAttrTr(tr: Transaction): boolean {
  if (!tr.docChanged || tr.getMeta('addToHistory') !== false) return false
  return tr.steps.every((step, i) => {
    const doc = tr.docs[i]!
    if (step instanceof AttrStep) {
      const n = doc.nodeAt(step.pos)
      return !!n && (VOLATILE_ATTRS[n.type.name] ?? []).includes(step.attr)
    }
    if (step instanceof ReplaceAroundStep) {
      const s = step as unknown as { from: number; to: number; gapFrom: number; gapTo: number; insert: number; structure: boolean; slice: { size: number; content: { firstChild: PMNode | null } } }
      if (!(s.insert === 1 && s.slice.size === 2 && s.gapFrom === s.from + 1 && s.gapTo === s.to - 1)) return false
      const before = doc.nodeAt(s.from)
      const after = s.slice.content.firstChild
      if (!before || !after || before.type !== after.type) return false
      const skip = VOLATILE_ATTRS[before.type.name] ?? []
      for (const k of new Set([...Object.keys(before.attrs), ...Object.keys(after.attrs)])) {
        if (!skip.includes(k) && JSON.stringify(before.attrs[k]) !== JSON.stringify(after.attrs[k])) return false
      }
      return true
    }
    return false
  })
}

/**
 * loadRun for the raw popover. Day-0 loadRun (P1's stub until M1) classifies `src + defs` and keeps the entries that
 * start inside `src`, so a definition-only run (a `gap`) swallows the appended defs into its value. The trailing
 * defs are stripped back off (contract-changes/P2.md); with P1's loadRun this is a no-op.
 */
function runNodes(md: Md, src: string, L: Loaded): PMNode[] {
  const nodes = loadRun(md, src, L.defs, L.eol)
  const last = nodes[nodes.length - 1]
  const defs = L.defs.trim()
  if (!last || last.type.name !== 'raw_block' || !defs) return nodes
  const v = String(last.attrs.value ?? '')
  if (!v.endsWith(defs) || src.trimEnd().endsWith(defs)) return nodes
  const own = v.slice(0, v.length - defs.length).replace(/\s+$/, '')
  const out = nodes.slice(0, -1)
  if (own) out.push(last.type.create({ ...last.attrs, value: own }))
  return out
}

function textOf(n: PMNode): string {
  return (n.isText ? (n.text ?? '') : n.textContent).split(ZWSP).join('')
}

export class MdrEditor implements EditorPort {
  md!: Md
  view!: EditorView
  journal = new DecisionJournal()
  readonly keys: KeyRouter
  toolbar!: Toolbar
  link!: LinkPopover
  tableControls: TableControls | null = null
  readonly popovers = new PopoverSlot()
  /** Every open starts in Suggesting (TJ, 2026-11-16: "when I open up a doc, it defaults to suggest mode"). */
  mode: Mode = 'suggesting'

  private editableFlag = false
  private gen = 0
  private txCount = 0
  private destroyed = false
  /** Kinds of the dispatches in progress (a view plugin may dispatch from inside updateState: a stack, not a flag). */
  private readonly kinds: Array<'user' | 'programmatic' | 'housekeeping'> = []
  /** The state a Backspace just left, when it already did the work of the Backspace after it (dropOwnEmptyItem). */
  private spentBackspace: { doc: PMNode; pos: number } | null = null
  /** The selection a composition started over, in doc positions (kept current by afterApply), struck when it ends;
   *  `inserted` is how much inserted text the document held then, so the end can tell what the composition added. */
  private compositionStrike: { from: number; to: number; inserted: number } | null = null
  private suggestDispatch!: (this: EditorView, tr: Transaction) => void
  private review: ReviewState
  private readonly claudeIds = new Set<SuggestionId>()
  private readonly hydrated = new Map<SuggestionId, { seq: number; by: Author }>()
  private readonly unplaced = new Map<SuggestionId, UnplacedEntry>()
  private readonly locallyDecided = new Map<SuggestionId, 'accept' | 'reject'>()
  /** The last Suggesting-mode transaction the base guard refused (live doc before, and as it would have been). Tests read it. */
  lastBaseRefusal: { before: PMNode; after: PMNode } | null = null
  private readonly wiped = new Set<SuggestionId>()
  /** TJ ids this editor has seen the server withdraw (a withdrawn suggestion is terminal: its marks can't come back). */
  private readonly withdrawnTj = new Set<SuggestionId>()
  private readonly seenTj = new Set<SuggestionId>()
  private readonly markChangedAt = new Map<SuggestionId, number>()
  private readonly markVersion = new Map<SuggestionId, number>()
  private readonly commitVersion = new Map<SuggestionId, number>()
  private readonly extractCache = new Map<SuggestionId, { v: number; L: Loaded; u: TjSuggestionUpsert | null }>()
  private lastPlanUpserts = new Map<SuggestionId, TjSuggestionUpsert>()
  private readonly committedRecords = new Map<SuggestionId, { base: string; proposed: string }>()
  private readonly replaying = new Set<SuggestionId>()
  private pendingUnplacedDecision: { ids: SuggestionId[]; decision: 'accept' | 'reject'; bulk?: OpKey } | null = null
  private readonly sentAnchors = new Map<ThreadId, Anchor | null>()
  private readonly placedAnchors = new Map<ThreadId, string>()
  private baseCache: { doc: PMNode; tr: Transform } | null = null
  private alignCache: { doc: PMNode; L: Loaded; al: LiveAlignment } | null = null
  private pastePlainUntil = 0
  /** Esc was the last key pressed in the document: the next Tab moves focus on instead of being the editor's. */
  private tabLeaves = false
  private linkClickTimer: ReturnType<typeof setTimeout> | null = null
  private dispatchId: SuggestionId | null = null
  private typing = false
  private typingTimer: ReturnType<typeof setTimeout> | null = null
  private toolbarFrame: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private readonly cleanups: Array<() => void> = []

  readonly subs = {
    mode: new Set<(m: Mode) => void>(),
    layout: new Set<(r: LayoutReason) => void>(),
    selection: new Set<() => void>(),
    highlight: new Set<(t: ThreadId) => void>(),
    notice: new Set<(n: EditorNotice) => void>(),
    typing: new Set<(b: boolean) => void>(),
  }

  constructor(readonly o: MdrEditorOptions) {
    this.review = o.session.getReview()
    this.keys = new KeyRouter((action, view) => this.runAction(action, view), (view) => view.state.selection.$from.parent.type.name === 'code_block')
  }

  get session(): DocSession {
    return this.o.session
  }
  get internals(): SessionInternals {
    return this.o.internals
  }

  // ===================================================================================== mount

  async mount(): Promise<void> {
    const extend = (editor: Editor): Editor => this.extend(editor)
    const expect = this.internals.boot.schemaFingerprint
    try {
      this.md = await createMd({ root: this.o.host, extend, ...(expect ? { expectFingerprint: expect } : {}) })
    } catch (e) {
      if (!(e instanceof StoreError) || e.code !== 'CONTRACT_MISMATCH') throw e
      // the bundle's schema differs from the server's: boot anyway, so the session can show the contract-mismatch
      // banner over a read-only document (§13 #22) instead of a blank page
      this.o.host.replaceChildren()
      this.md = await createMd({ root: this.o.host, extend })
    }
    this.view = this.md.view
    // one id per user action: every step of one dispatched transaction belongs to the same suggestion
    this.suggestDispatch = withSuggestChanges(this.makeApply(), () => (this.dispatchId ??= this.mintId()))
    this.toolbar = new Toolbar(this.o.toolbarHost, {
      run: (a) => this.runToolbar(a),
      toggleMode: () => this.setMode(this.mode === 'editing' ? 'suggesting' : 'editing'),
    })
    this.toolbar.setMode(this.mode)
    this.link = new LinkPopover({ host: this.o.host, slot: this.popovers, view: () => this.view, editable: () => this.editableFlag })
    const onPointer = (): void => this.setTyping(false)
    this.o.host.addEventListener('pointermove', onPointer)
    this.cleanups.push(() => this.o.host.removeEventListener('pointermove', onPointer))
    // Editor keys (Undo, the mode switch, bold ...) also work with nothing focused: on a fresh page, or right after a
    // card's Accept took away the button that had the focus. A Mod chord that reaches the page body goes to the
    // editor's own keymap; handled, it also brings the focus back to the document. (Typing and plain keys are left alone.)
    // A read-only document (a second tab) never holds the focus, though its selection is live, so the registered
    // shortcuts run here too: Cmd+Opt+M comments on the words selected, not on the whole document (Pass 4 #23).
    const doc = this.o.host.ownerDocument
    const onBodyKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || !(e.metaKey || e.ctrlKey) || this.destroyed) return
      const a = doc.activeElement
      if (a && a !== doc.body && a !== doc.documentElement) return
      if (!(this.editableFlag ? this.keys.handleOwn(this.view, e) : this.keys.handle(this.view, e))) return
      e.preventDefault()
      this.view.focus()
    }
    doc.addEventListener('keydown', onBodyKey)
    this.cleanups.push(() => doc.removeEventListener('keydown', onBodyKey))
    const onMarginDown = (e: MouseEvent): void => this.marginClick(e)
    this.o.scrollContainer.addEventListener('mousedown', onMarginDown)
    this.cleanups.push(() => this.o.scrollContainer.removeEventListener('mousedown', onMarginDown))
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.emitLayout('resize'))
      this.resizeObserver.observe(this.o.host)
    }
    this.cleanups.push(this.session.subscribe((what) => {
      if (what === 'conflicts') this.refreshConflicts()
    }))
  }

  private extend(editor: Editor): Editor {
    // §11.5: P2's keymap replaces the presets' keymaps; §12.13: P2's input rules replace the presets' (Idle-state
    // remove is synchronous)
    void editor.remove([
      ...commonmarkKeymap, ...gfmKeymap, ...commonmarkInputRules, ...commonmarkMarkInputRules, ...gfmInputRules, ...gfmMarkInputRules,
    ])
    const self = this
    const nv = this.nodeViewHooks()
    editor.config((ctx) => {
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        dispatchTransaction(this: EditorView, tr: Transaction) {
          self.dispatch(this, tr)
        },
        editable: () => self.editableFlag,
        attributes: () => self.rootAttributes(),
        handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
          // Esc, then Tab leaves the document (see 'indent' below); any other key ends that. A modifier on its own is
          // not "another key": Shift goes down before the Tab of Shift+Tab
          if (event.key !== 'Tab' && !MODIFIER_KEYS.has(event.key)) self.tabLeaves = event.key === 'Escape'
          return guardKeyDown(view, event) || self.keys.handle(view, event)
        },
        handleClick: (view: EditorView, pos: number, event: MouseEvent) => self.onClick(view, pos, event),
        handleKeyPress: (view: EditorView, event: KeyboardEvent) => self.onKeyPress(view, event),
        nodeViews: {
          ...(prev.nodeViews ?? {}),
          list_item: (node, view, getPos) => new ListItemView(node, view, getPos),
          code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos),
          raw_block: (node, view, getPos) => new RawBlockView(node, view, getPos, nv),
          html: (node, view, getPos) => new InlineHtmlView(node, view, getPos, nv),
          hardbreak: (node, view) => new HardbreakView(node, view),
          image: (node, view) => new ImageView(node, view, (src) => assetUrl(src, { file: self.session.file, token: self.internals.boot.token }) ?? src),
          frontmatter: (node, view, getPos) => new FrontmatterView(node, view, getPos, {
            host: self.o.host,
            slot: self.popovers,
            mode: () => self.mode,
            editable: () => self.editableFlag,
            blocked: (why) => self.blocked(why),
            storageKey: () => `mdr:fm:${self.internals.boot.rootHash}:${self.session.file}`,
            eol: () => self.internals.getLoaded()?.eol ?? '\n',
          }),
        },
        handleDOMEvents: {
          ...(prev.handleDOMEvents ?? {}),
          blur: () => {
            self.tabLeaves = false
            self.internals.blurred()
            return false
          },
          // a click in a read-only document says why typing will do nothing (QA3: a second tab looked broken)
          mousedown: () => {
            if (!self.editableFlag) self.readOnlyNotice()
            return false
          },
          compositionstart: (view: EditorView) => self.onCompositionStart(view),
          compositionend: () => {
            setTimeout(() => self.internals.compositionEnded(), 0)
            // (after ProseMirror has read what was composed)
            if (self.compositionStrike) setTimeout(() => self.finishCompositionStrike(), COMPOSITION_SETTLE_MS)
            return false
          },
          // Suggesting mode: typed text becomes a transaction BEFORE the browser touches the DOM. Left to the DOM
          // observer, a tracked transaction (old text kept as a deletion) diverges from what the browser just typed,
          // and replacing a selection that crosses a block boundary scrambles the following keystrokes (S2 caveat 5).
          beforeinput: (view: EditorView, e: Event) => self.onBeforeInput(view, e as InputEvent),
        },
      }))
    })
    return editor.use([
      $prose(() => history({ depth: 200, newGroupDelay: 500 })),
      $prose((ctx) => mdrInputRulesPlugin(ctx.get(schemaCtx), { autolink: () => this.mode === 'editing' })),
      $prose(() => suggestChanges()),
      $prose(() => idGuard({ isTjOwned: (id) => !this.claudeIds.has(id), mintId: () => this.mintId(), isProgrammatic: isProgrammaticTr })),
      $prose(() => retypeGuard({ isTjOwned: (id) => !this.claudeIds.has(id), enabled: () => this.mode === 'suggesting', isProgrammatic: isProgrammaticTr })),
      $prose(() => suggestDecoPlugin({ byOf: (id) => this.byOf(id), isActive: (id) => this.activeSuggestions.has(id) })),
      $prose(() => bidiPlugin()),
      $prose(() => highlightPlugin()),
      $prose(() => conflictPlugin()),
      $prose(() => spacerPlugin()),
      $prose(() => statusBlockPlugin()),
      $prose(() => atomGuardPlugin()),
      $prose(() => fixTablesGuard()),
      $prose(() => stickyHeaderPlugin()),
      $prose(() => linkBoundaryPlugin()),
      $prose(() => pastePlugin({
        notice: (n) => this.notice(n),
        markdown: (text) => {
          const L = this.internals.getLoaded()
          if (!L || !this.md) return null
          try {
            return runNodes(this.md, text, L)
          } catch {
            return null
          }
        },
        takePlain: () => {
          const on = this.pastePlainUntil >= Date.now()
          this.pastePlainUntil = 0
          return on
        },
      })),
      $prose(() => tableControlsPlugin(() => {
        this.tableControls = new TableControls({
          host: this.o.host,
          mode: () => this.mode,
          editable: () => this.editableFlag,
          run: (a) => this.runTableAction(a),
          blocked: () => this.blocked('table-structure'),
        })
        return this.tableControls
      })),
    ])
  }

  private nodeViewHooks(): NodeViewHooks {
    return {
      host: this.o.host,
      slot: this.popovers,
      mode: () => this.mode,
      editable: () => this.editableFlag,
      blocked: (why) => this.blocked(why),
      commitRawBlock: (pos, node, source) => this.commitRawBlock(pos, node, source),
    }
  }

  /**
   * The raw popover's Save (§12.13, D44): the atom is replaced by loadRun(md, newSource, L.defs, L.eol), so the live
   * doc equals what load() would give (still a raw_block when the source still classifies as raw, otherwise the
   * parsed nodes). One undoable programmatic step; dirty like a user edit ('raw-commit').
   */
  commitRawBlock(pos: number, node: PMNode, source: string): string | null {
    if (!this.editableFlag) return 'This document is read-only.'
    if (this.mode === 'suggesting') {
      this.blocked('raw-block')
      return "Raw source blocks can't be edited in Suggesting mode."
    }
    const L = this.internals.getLoaded()
    if (!L) return 'The document is still loading.'
    // the textarea speaks \n: a CRLF document keeps its own line breaks
    const src = L.eol === '\r\n' ? source.replace(/\r?\n/g, '\r\n') : source
    let nodes: PMNode[]
    try {
      nodes = src.trim() ? runNodes(this.md, src, L) : []
    } catch {
      return "That source couldn't be read as markdown."
    }
    const tr = this.programmatic('raw-commit')
    tr.setMeta('addToHistory', true)
    if (nodes.length) tr.replaceWith(pos, pos + node.nodeSize, nodes)
    else tr.delete(pos, pos + node.nodeSize)
    if (tr.doc.childCount === 0) tr.insert(0, this.md.schema.nodes.paragraph!.create())
    this.apply(tr)
    return null
  }

  /** A table control-bar action (Editing mode; the bar refuses in Suggesting mode before this runs). */
  private runTableAction(action: TableAction): void {
    const state = this.view.state
    const info = cellAt(state)
    if (!info) return
    const tr = tableActionTr(state, info, action)
    if (tr) this.view.dispatch(tr.scrollIntoView())
    this.view.focus()
    // The table is gone in one click (also "delete the last row/column" on a one-row, one-column table): say so, with Undo
    if (tr && actionState(info, action, this.mode).effective === 'table-delete') {
      this.notice({ kind: 'info', code: 'TABLE_DELETED', text: 'Table deleted.', action: { label: 'Undo', run: () => void this.runAction('undo', this.view) } })
    }
  }

  /** bridge.focusEditor: the view gets the focus back, no scroll; `collapse: 'end'` first drops a selection to its end. */
  refocus(o?: { collapse?: 'end' }): void {
    const { state } = this.view
    // in the editor's own state, not the DOM's: ProseMirror writes its state selection back over the DOM one on the next
    // transaction (the draft highlight going away is one), which would undo a DOM-only collapse
    if (o?.collapse === 'end' && !state.selection.empty) this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, state.selection.to)))
    this.view.focus()
  }

  private rootAttributes(): Record<string, string> {
    return {
      class: 'mdr-editor',
      'data-testid': 'mdr-editor',
      'data-mode': this.mode,
      'data-readonly': String(!this.editableFlag),
      'aria-label': 'Document',
      'aria-multiline': 'true',
    }
  }

  mintId(): SuggestionId {
    return `s_${ulid()}` as SuggestionId
  }

  // ===================================================================================== dispatch

  private dispatch(view: EditorView, tr: Transaction): void {
    if (this.destroyed) return
    const meta = mdrMeta(tr)
    const hist = !!tr.getMeta('history$')
    const housekeeping = !meta && !hist && isVolatileAttrTr(tr)
    const user = !meta && !hist && !housekeeping
    if (tr.docChanged) {
      if ((user || hist) && !this.editableFlag) return
      if (user && foreignViolation(tr, (id) => this.claudeIds.has(id))) {
        this.notice({ kind: 'warn', code: 'FOREIGN_SUGGESTION', text: "That's Claude's suggestion. Accept, reject, or reply on its card." })
        return
      }
      if (user && this.mode === 'suggesting') {
        const why = suggestModeViolation(tr)
        if (why) {
          this.blocked(why)
          return
        }
      }
      if (user && this.mode === 'suggesting') {
        // a structural edit inside TJ's own pending insertion reshapes that insertion (ownInsertion.ts)
        const own = ownInsertionScope(tr, (id) => !this.claudeIds.has(id as SuggestionId))
        if (own) joinOwnInsertion(tr, own)
      }
      if (user && this.mode === 'suggesting' && tr.getMeta('uiEvent') === 'cut' && !view.state.selection.empty) {
        // a cut that crosses blocks would be a join (see trackedDeleteTr); strike the selection instead
        const { from, to } = view.state.selection
        this.dispatch(view, this.trackedDeleteTr(view.state, from, to))
        return
      }
      if ((user || hist) && this.journal.lastWasDecide && tr.getMeta('addToHistory') !== false) closeHistory(tr)
      if (housekeeping) tr.setMeta(suggestChangesKey, { skip: true })
    }
    if (user) this.dispatchId = null
    this.kinds.push(user ? 'user' : housekeeping ? 'housekeeping' : 'programmatic')
    try {
      this.suggestDispatch.call(view, tr)
    } catch (e) {
      if (user && this.mode === 'suggesting') {
        this.blocked(null)
        return
      }
      throw e
    } finally {
      this.kinds.pop()
    }
  }

  private makeApply(): (this: EditorView, tr: Transaction) => void {
    const self = this
    return function apply(this: EditorView, tr: Transaction) {
      const kind = self.kinds[self.kinds.length - 1] ?? 'programmatic'
      const old = this.state
      const { state, transactions } = old.applyTransaction(tr)
      // a Suggesting-mode user edit, as withSuggestChanges built it, must leave the base alone (else the planner would
      // save it): refuse it whole, like a D14 block
      if (kind === 'user' && self.mode === 'suggesting' && tr.docChanged && baseChangedBy(old.doc, state.doc)) {
        self.lastBaseRefusal = { before: old.doc, after: state.doc }
        self.blocked(suggestionSegments(old.doc).length > 0 ? 'base-changed' : 'untrackable')
        return
      }
      this.updateState(state)
      self.afterApply(old, state, transactions, tr, kind)
    }
  }

  private afterApply(old: EditorState, state: EditorState, trs: readonly Transaction[], root: Transaction, kind: 'user' | 'programmatic' | 'housekeeping'): void {
    this.txCount++
    this.journal.observe(trs, state)
    const docChanged = trs.some((t) => t.docChanged)
    if (docChanged) {
      if (this.compositionStrike) {
        for (const t of trs) this.compositionStrike = { ...this.compositionStrike, from: t.mapping.map(this.compositionStrike.from, 1), to: t.mapping.map(this.compositionStrike.to, -1) }
      }
      const meta = mdrMeta(root)
      const hist = !!root.getMeta('history$')
      const dirty = kind === 'user' || hist || (meta !== undefined && DIRTY_ORIGINS.has(meta.origin))
      this.trackMarks(trs)
      if (dirty) {
        this.gen++
        this.internals.changed()
      }
      if (kind === 'user') this.setTyping(true)
      this.emitLayout('doc')
    } else {
      const decoKeys = [highlightKey, conflictKey, suggestDecoKey] as const
      if (decoKeys.some((k) => k.getState(old) !== k.getState(state))) this.emitLayout('decorations')
    }
    if (docChanged || !old.selection.eq(state.selection)) {
      this.link?.caretMoved()
      for (const cb of [...this.subs.selection]) cb()
    }
    this.scheduleToolbar()
    if (docChanged && root.getMeta('history$')) this.reviveWithdrawn()
  }

  /**
   * Undo of a typed Suggesting-mode edit withdraws its suggestion, and a withdrawn suggestion is terminal on the server.
   * A redo then brings the marks back under the dead id: a mark with no card, no sidecar record and nothing in
   * `pending` (QA2 14). The returned marks get fresh ids instead, and the next save files them as a new suggestion.
   */
  private reviveWithdrawn(): void {
    const dead = new Set<SuggestionId>(this.withdrawnTj)
    for (const s of this.session.getReview().suggestions) if (s.by === 'TJ' && s.status === 'withdrawn') dead.add(s.id)
    if (dead.size === 0) return
    const fresh = new Map<SuggestionId, SuggestionId>()
    for (const id of suggestionIdsIn(this.view.state.doc)) if (dead.has(id) && !this.claudeIds.has(id)) fresh.set(id, this.mintId())
    if (fresh.size === 0) return
    const tr = this.programmatic('revive')
    tr.setMeta('addToHistory', false)
    reassignIds(tr, fresh)
    if (tr.docChanged) this.apply(tr)
  }

  /** Dispatch a programmatic transaction (already carrying its mdr meta and skip meta). */
  private apply(tr: Transaction): void {
    if (!tr.getMeta(suggestChangesKey)) tr.setMeta(suggestChangesKey, { skip: true })
    this.view.dispatch(tr)
  }

  private programmatic(origin: MdrOrigin, extra: Partial<MdrMeta> = {}): Transaction {
    const tr = this.view.state.tr
    tr.setMeta(suggestChangesKey, { skip: true })
    tr.setMeta('mdr', { origin, ...extra })
    return tr
  }

  /** Per-id clock of mark changes (the upsert throttle, §6.4) and the TJ ids this editor has seen. */
  private trackMarks(trs: readonly Transaction[]): void {
    const now = Date.now()
    const ids = new Set<SuggestionId>()
    for (const tr of trs) {
      if (!tr.docChanged && !tr.steps.length) continue
      const inv = tr.mapping.invert()
      for (const r of touchedRanges(tr)) {
        const a = Math.max(0, r.from - 1)
        const b = Math.min(tr.doc.content.size, r.to + 1)
        tr.doc.nodesBetween(a, b, (n) => {
          for (const m of n.marks) if (kindOf(m)) ids.add(markIdOf(m))
          return true
        })
        const oa = Math.max(0, inv.map(a, -1) - 1)
        const ob = Math.min(tr.before.content.size, inv.map(b, 1) + 1)
        if (ob > oa) {
          tr.before.nodesBetween(oa, ob, (n) => {
            for (const m of n.marks) if (kindOf(m)) ids.add(markIdOf(m))
            return true
          })
        }
      }
    }
    for (const id of ids) {
      this.markChangedAt.set(id, now)
      this.markVersion.set(id, (this.markVersion.get(id) ?? 0) + 1)
      if (!this.claudeIds.has(id)) this.seenTj.add(id)
    }
  }

  // ===================================================================================== notices, layout, typing

  notice(n: EditorNotice): void {
    for (const cb of [...this.subs.notice]) {
      try {
        cb(n)
      } catch (e) {
        console.error('[mdr editor] notice subscriber threw', e)
      }
    }
  }

  private blocked(why: SuggestBlockReason | null): void {
    this.notice({
      kind: 'info',
      code: 'SUGGEST_MODE_BLOCKED',
      text: why ? SUGGEST_BLOCK_TEXT[why] : "That change can't be tracked as a suggestion.",
      action: { label: 'Switch to Editing', run: () => this.setMode('editing') },
    })
  }

  emitLayout(r: LayoutReason): void {
    for (const cb of [...this.subs.layout]) {
      try {
        cb(r)
      } catch (e) {
        console.error('[mdr editor] layout subscriber threw', e)
      }
    }
  }

  private setTyping(on: boolean): void {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer)
      this.typingTimer = null
    }
    if (on) this.typingTimer = setTimeout(() => this.setTyping(false), CONSTANTS.TYPING_IDLE_MS)
    if (on === this.typing) return
    this.typing = on
    for (const cb of [...this.subs.typing]) cb(on)
  }

  private scheduleToolbar(): void {
    if (this.toolbarFrame !== null || typeof requestAnimationFrame !== 'function') {
      if (typeof requestAnimationFrame !== 'function') this.toolbar?.update(this.view.state, this.editableFlag)
      return
    }
    this.toolbarFrame = requestAnimationFrame(() => {
      this.toolbarFrame = null
      if (!this.destroyed) this.toolbar.update(this.view.state, this.editableFlag)
    })
  }

  // ===================================================================================== modes

  setMode(m: Mode): void {
    if (m === this.mode) return
    // not remembered: a reload or a reopen starts in Suggesting again (the old per-doc mdr:mode:* key is ignored)
    this.mode = m
    this.syncSuggestPlugin()
    this.toolbar.setMode(m)
    this.view.setProps({})
    this.tableControls?.update(this.view)
    for (const cb of [...this.subs.mode]) cb(m)
    this.emitLayout('mode')
  }

  private syncSuggestPlugin(): void {
    const enabled = this.mode === 'suggesting'
    if (!!suggestChangesKey.getState(this.view.state)?.enabled === enabled) return
    this.view.dispatch(this.view.state.tr.setMeta(suggestChangesKey, { skip: true, enabled }))
  }

  // ===================================================================================== keys, clicks, paste

  private runToolbar(action: ToolbarAction): void {
    if (action === 'heading') {
      this.toolbar.toggleMenu()
      return
    }
    if (action.startsWith('heading-')) this.toolbar.setMenu(false)
    this.runAction(action as P2Action, this.view)
    if (action !== 'link') this.view.focus()
  }

  runAction(action: P2Action | ToolbarAction, view: EditorView): boolean {
    const { state } = view
    const dispatch = view.dispatch.bind(view)
    switch (action) {
      case 'mode-editing':
        this.setMode('editing')
        return true
      case 'mode-suggesting':
        this.setMode('suggesting')
        return true
      case 'link':
        this.link.open()
        return true
      case 'underline':
        // markdown has no underline: say so instead of doing nothing
        this.notice({ kind: 'info', code: 'UNDERLINE_UNSUPPORTED', text: 'Underline isn’t available in this document.' })
        return true
      // Tab is the editor's wherever the caret is (Pass 4 #31): it indents a list item, steps through table cells,
      // indents code, and in plain text does nothing, rather than moving focus to the rail and losing the caret. Esc
      // first lets the next Tab through, so the document is never a keyboard trap (WCAG 2.1.2).
      case 'indent':
        if (this.tabLeaves) return false
        if (cellAt(state)) return tableTab(1, { mode: () => this.mode, blocked: () => this.blocked('table-structure') })(state, dispatch, view)
        indent(state, dispatch, view)
        return true
      case 'outdent':
        if (this.tabLeaves) return false
        if (cellAt(state)) return tableTab(-1, { mode: () => this.mode, blocked: () => this.blocked('table-structure') })(state, dispatch, view)
        outdent(state, dispatch, view)
        return true
      case 'exit-code':
        return exitCodeBlock(state, dispatch, view)
      case 'paste-plain':
        this.pastePlainUntil = Date.now() + 1_000
        return false
      case 'undo':
        return undo(state, dispatch)
      case 'redo':
        return this.redo()
      case 'enter':
        if (cellAt(state)) return tableEnter(state, dispatch, view)
        if (this.mode === 'suggesting') {
          // a block holding only the split marker is empty to the user: Enter acts as on an empty block
          const z = this.markerOnly(state)
          if (z) return this.withTrim(view, z.from, z.to, enterKey)
        } else if (state.selection.empty) {
          // Enter after a typed address links it, as Space does (QA3)
          const al = autolinkBefore(state, state.selection.from)
          if (al) {
            view.dispatch(al)
            return enterKey(view.state, view.dispatch.bind(view), view)
          }
        }
        if (this.mode === 'suggesting') return this.enterTracked(view)
        return enterKey(state, dispatch, view)
      case 'hard-break':
        return hardBreak(state, dispatch, view)
      case 'backspace':
      case 'delete':
        if (this.mode === 'suggesting' && !state.selection.empty) {
          dispatch(this.trackedDeleteTr(state, state.selection.from, state.selection.to))
          return true
        }
        if (this.mode === 'suggesting') {
          // Editing's second Backspace after the lift joins the empty line back up: with the item already gone, it is spent
          const spent = this.spentBackspace
          this.spentBackspace = null
          if (action === 'backspace' && spent && spent.doc === state.doc && spent.pos === state.selection.from) return true
          if (this.dropOwnEmptyItem(view) || this.dropEmptyItem(view)) return true
        }
        if (action === 'delete') {
          // Delete at the end of a list item joins the next text onto it (Pass 4 #9), in Editing and, as a swap of the
          // list, in Suggesting mode; what joinNextText doesn't take is the default join's
          const $f = state.selection.$from
          const inItem = Array.from({ length: $f.depth }, (_, d) => $f.node(d + 1)).some((n) => n.type.name === 'list_item')
          const atEnd = state.selection.empty && inItem && $f.parent.isTextblock && $f.parentOffset === $f.parent.content.size
          if (this.mode !== 'suggesting') return atEnd && joinNextText(state, dispatch, view)
          if (atEnd && (this.swapTracked(view, joinNextText) || this.swapTracked(view, joinForward))) return true
          return this.strikeChar(view, 1)
        }
        if (this.mode === 'suggesting' && !undoInputRule(state)) {
          // right after a block's leading split marker the caret is at the block's start to the user
          const z = this.leadingMarker(state)
          if (z) {
            const atStart: Command = (st, d, v) => backspaceLift(st, d, v) || backspaceBlockquote(st, d, v) || joinOwnSplit(st, d)
            this.withTrim(view, z.from, z.to, atStart)
            return true
          }
        }
        if (this.mode === 'suggesting' && !undoInputRule(state)) {
          if (joinAcrossStruck(state, dispatch)) return true
          if (this.liftTracked(view, backspaceLift) || this.liftTracked(view, backspaceBlockquote)) return true
        }
        return undoInputRule(state, dispatch) || (this.mode === 'editing' && backspaceBetweenLists(state, dispatch, view)) || backspaceLift(state, dispatch, view) || backspaceBlockquote(state, dispatch, view)
          || (this.mode === 'suggesting' && this.strikeChar(view, -1))
      case 'heading':
        this.toolbar.toggleMenu()
        return true
      default: {
        const cmd = commandFor(action, state.schema)
        if (!cmd) return false
        cmd(state, dispatch, view)
        return true
      }
    }
  }

  /**
   * A click on the page beside the document column (the margin, the gutter, the space above and below it) puts the caret
   * at the nearest line, as Google Docs does. Left to the browser it lands on a plain <div>, blurs the editor and the
   * next keystrokes go nowhere (Pass 4 #26). The point is clamped into the text box, so a click left of a line means
   * its start and right of it its end. The scroll bar and the comment rail are not the page and are left alone.
   */
  private marginClick(e: MouseEvent): void {
    const t = e.target
    const scroll = this.o.scrollContainer
    if (e.button !== 0 || e.defaultPrevented || !this.editableFlag || this.destroyed || !(t instanceof Element) || t === this.o.host || !t.contains(this.o.host)) return
    const r = scroll.getBoundingClientRect()
    if (e.clientX - r.left - scroll.clientLeft >= scroll.clientWidth || e.clientY - r.top - scroll.clientTop >= scroll.clientHeight) return
    const box = this.view.dom.getBoundingClientRect()
    const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))
    const at = this.view.posAtCoords({ left: clamp(e.clientX, box.left + 1, box.right - 1), top: clamp(e.clientY, box.top + 1, box.bottom - 1) })
    if (!at) return
    e.preventDefault()
    const tr = this.view.state.tr.setSelection(Selection.near(this.view.state.doc.resolve(at.pos)))
    this.view.dispatch(tr)
    this.view.focus()
  }

  private onClick(view: EditorView, pos: number, event: MouseEvent): boolean {
    const link = view.state.schema.marks.link
    const onLink = link ? linkRange(view, pos, link) : null
    if (onLink && (event.metaKey || event.ctrlKey)) {
      const href = String(onLink.mark.attrs.href ?? '')
      if (href && linkAllowed(href)) {
        view.dom.ownerDocument.defaultView?.open(href, '_blank', 'noopener')
        return true
      }
    }
    // a plain click on a link: the view popover (URL, Edit, Remove, Open) once ProseMirror has placed the caret
    if (onLink && onLink.from < pos && pos < onLink.to && !event.shiftKey) {
      if (this.linkClickTimer) clearTimeout(this.linkClickTimer)
      // the click position, not the selection: Chrome moves the selection after this handler (and after a 0 ms timer)
      this.linkClickTimer = setTimeout(() => {
        this.linkClickTimer = null
        if (!this.destroyed && pos <= this.view.state.doc.content.size) this.link.openAt(pos)
      }, 0)
    }
    // The tracked change under the pointer wins over a comment highlight that spans it: Claude suggesting inside the
    // sentence TJ commented on is the normal review loop, and a click on the green/struck words is a click on that
    // change, to accept or reject it (QA3 rail-ui 2). Clicks on the commented words around it still find the comment.
    const hit = this.threadOfSuggestionAt(event.target) ?? threadsAt(view.state, pos)[0]
    if (hit) for (const cb of [...this.subs.highlight]) cb(hit)
    return false
  }

  /** The thread of the tracked change under a click (a suggestion's inline insert or delete), if any. */
  private threadOfSuggestionAt(target: EventTarget | null): ThreadId | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-suggestion]') : null
    const id = el?.dataset.suggestion
    if (!id) return null
    return this.session.getReview().threads.find((t) => (t.suggestions as readonly string[]).includes(id))?.id ?? null
  }

  private onBeforeInput(view: EditorView, e: InputEvent): boolean {
    if (this.mode !== 'suggesting' || view.composing || e.isComposing) return false
    if (e.inputType !== 'insertText' || !e.data || !this.editableFlag) return false
    e.preventDefault()
    this.typeText(view, e.data)
    return true
  }

  /**
   * Suggesting mode, an accent dead key or an IME starting over a selection (Pass 4 #30). The browser puts the first
   * composing character in place of the selection and ProseMirror reads that back mid-composition; once the tracked
   * change re-renders the text, the composition's own text lands in the wrong node and the first character stays in the
   * suggestion ("some" became "´área"). Composing at a plain caret works, so the selection collapses to its end for the
   * composition and is struck when it ends (finishCompositionStrike): the same suggestion, the same words. Returns
   * false so ProseMirror's own composition handling still runs.
   */
  private onCompositionStart(view: EditorView): boolean {
    const sel = view.state.selection
    this.compositionStrike = null
    if (this.mode !== 'suggesting' || !this.editableFlag || view.composing || sel.empty || !(sel instanceof TextSelection)) return false
    this.compositionStrike = { from: sel.from, to: sel.to, inserted: this.insertedSize(view.state) }
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, sel.to)))
    return false
  }

  /** How much text the document holds under the insertion mark. */
  private insertedSize(state: EditorState): number {
    const insertion = suggestionMarkTypes(state.schema).insertion
    let size = 0
    state.doc.descendants((node) => {
      if (node.isText && insertion.isInSet(node.marks)) size += node.nodeSize
    })
    return size
  }

  /** The composition is over: strike the text it was typed over (see onCompositionStart), unless nothing was composed. */
  private finishCompositionStrike(): void {
    const pending = this.compositionStrike
    this.compositionStrike = null
    const view = this.view
    if (!pending || this.destroyed || view.composing || this.mode !== 'suggesting') return
    const { from, to } = pending
    // a cancelled composition left the selection's text alone, and so it stays. Text that was inserted before the
    // composition and happens to sit right after the selection is not what was composed: only new inserted text counts
    if (this.insertedSize(view.state) <= pending.inserted) {
      this.redrawBlockAt(view, to)
      return
    }
    const doc = view.state.doc
    const next = to < doc.content.size ? doc.resolve(to).nodeAfter : null
    if (!next?.isText || !suggestionMarkTypes(view.state.schema).insertion.isInSet(next.marks)) return
    const caret = view.state.selection.from
    view.dispatch(this.trackedDeleteTr(view.state, from, to))
    // striking marks the text and moves nothing: the caret goes back after what was composed
    if (caret <= view.state.doc.content.size) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)).setMeta(suggestChangesKey, { skip: true }))
  }

  /**
   * Redraw the textblock around pos from the document. A cancelled composition leaves no transaction behind, so
   * nothing re-renders what the browser did to the DOM next to it (it unwraps an insertion's decoration span, and the
   * suggestion stops looking like one). ProseMirror redraws the nodes marked dirty on its next state update.
   */
  private redrawBlockAt(view: EditorView, pos: number): void {
    const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size))
    if ($pos.depth === 0) return
    const docView = (view as unknown as { docView?: { markDirty(from: number, to: number): void } }).docView
    docView?.markDirty($pos.before(), $pos.after())
    view.updateState(view.state)
  }

  /** PM handles keypress itself for a selection across blocks (no beforeinput follows): same path in Suggesting mode. */
  private onKeyPress(view: EditorView, e: KeyboardEvent): boolean {
    if (this.mode !== 'suggesting' || view.composing || !this.editableFlag) return false
    if (!e.charCode || (e.ctrlKey && !e.altKey) || e.metaKey || view.state.selection.empty) return false
    const text = String.fromCharCode(e.charCode)
    if (/[\r\n]/.test(text)) return false
    this.typeText(view, text)
    return true
  }

  /**
   * Typed text in Suggesting mode. Over a selection: a tracked deletion of it first (trackedDeleteTr), then the text
   * at the caret, which the library places after the struck text like any replace. Input rules get the text first.
   */
  private typeText(view: EditorView, text: string): void {
    const sel = view.state.selection
    if (!sel.empty) {
      // one transaction, so one undo event takes back the whole replace (QA3): strike the selection and insert at its
      // start; suggest-changes moves an insertion out of a struck run to the run's end, so the text lands after it
      const tr = this.trackedDeleteTr(view.state, sel.from, sel.to)
      tr.insertText(text, tr.mapping.map(sel.from, -1))
      view.dispatch(tr.scrollIntoView())
      return
    }
    const { from, to } = sel
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, text, () => view.state.tr.insertText(text, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView())
  }

  /** The range of the caret's textblock when it holds only insertion-marked zero-width markers (an empty new block). */
  private markerOnly(state: EditorState): { from: number; to: number } | null {
    const { $from, empty } = state.selection
    const p = $from.parent
    if (!empty || !p.isTextblock || p.childCount === 0) return null
    const ins = state.schema.marks.insertion
    let only = true
    p.forEach((c) => {
      if (!c.isText || !ins?.isInSet(c.marks) || c.text!.split(ZWSP).join('') !== '') only = false
    })
    return only ? { from: $from.start(), to: $from.end() } : null
  }

  /** The leading insertion-marked zero-width marker of the caret's textblock when the caret sits right after it. */
  private leadingMarker(state: EditorState): { from: number; to: number } | null {
    const { $from, empty } = state.selection
    const first = $from.parent.firstChild
    if (!empty || !$from.parent.isTextblock || $from.parentOffset !== 1 || !first?.isText || !first.text!.startsWith(ZWSP)) return null
    if (!state.schema.marks.insertion?.isInSet(first.marks)) return null
    return { from: $from.start(), to: $from.start() + 1 }
  }

  /**
   * Suggesting mode, Backspace or Delete in a list item with nothing left in it but struck text (or nothing at all):
   * the item goes, bullet and all (Pass 4 #9, #24). Striking the text empties the item; the next key used to lift it
   * and re-insert the list as a second suggestion, and Accept left an empty bullet. Here the struck text's own
   * suggestion takes the whole item, so it stays one card and Accept removes the item, where Editing's third
   * Backspace takes the empty line away. An item TJ just added (own insertion) is not this: its keys are
   * ownInsertion.ts's.
   */
  private dropEmptyItem(view: EditorView): boolean {
    const { state } = view
    const $f = state.selection.$from
    if (!state.selection.empty || $f.depth < 3 || $f.parent.type.name !== 'paragraph') return false
    const item = $f.node($f.depth - 1)
    const list = $f.node($f.depth - 2)
    if (item.type.name !== 'list_item' || item.childCount !== 1 || list.childCount < 2) return false
    const { deletion, insertion } = suggestionMarkTypes(state.schema)
    let id: SuggestionId | null = null
    let blocked = false
    $f.parent.forEach((c) => {
      const del = deletion.isInSet(c.marks)
      if (!c.isText || insertion.isInSet(c.marks) || (!del && c.text !== undefined)) blocked = true
      else if (del) id ??= markIdOf(del) as SuggestionId
    })
    if (blocked || (id === null && $f.parent.content.size !== 0) || (id !== null && this.claudeIds.has(id))) return false
    const pos = $f.before($f.depth - 1)
    const tr = state.tr
    tr.removeMark($f.start(), $f.end(), deletion)
    tr.addNodeMark(pos, deletion.create({ id: id ?? this.mintId() }))
    tr.setSelection(Selection.near(tr.doc.resolve(pos), -1))
    tr.setMeta(suggestChangesKey, { skip: true })
    view.dispatch(tr.scrollIntoView())
    return true
  }

  /**
   * Suggesting mode, Backspace or Delete in the empty item that Enter at the end of an item just made (it holds only
   * the split's zero-width marker): take it back, marker pair and all, so the suggestion disappears (Pass 4 #24).
   * Editing mode's Enter, Backspace, Backspace leaves the list as it was; here the first Backspace was refused with
   * "can't be tracked over a pending suggestion" and the bullet stayed.
   */
  private dropOwnEmptyItem(view: EditorView): boolean {
    const { state } = view
    if (!this.markerOnly(state)) return false
    const $f = state.selection.$from
    if ($f.depth < 3 || $f.parent.type.name !== 'paragraph') return false
    const item = $f.node($f.depth - 1)
    const list = $f.node($f.depth - 2)
    const idx = $f.index($f.depth - 2)
    if (item.type.name !== 'list_item' || item.childCount !== 1 || idx === 0) return false
    const at = $f.before($f.depth - 1)
    const tr = state.tr.delete(at, at + item.nodeSize)
    // the other half of the split's marker pair, at the end of the item above
    const last = list.child(idx - 1).lastChild?.lastChild
    if (last?.isText && last.text === ZWSP && suggestionMarkTypes(state.schema).insertion.isInSet(last.marks)) tr.delete(at - 3, at - 2)
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(at, -1)), -1))
    tr.setMeta(suggestChangesKey, { skip: true })
    view.dispatch(tr.scrollIntoView())
    this.spentBackspace = { doc: view.state.doc, pos: view.state.selection.from }
    return true
  }

  /**
   * Suggesting mode, Enter (Pass 4 #7). With spaces right after the caret enterKey trims them and then splits, in one
   * transaction; the library strikes the spaces and puts the split after them, and the caret (worked out before the
   * tracking) stayed at the end of the first block, so the next typing landed there and Accept wrote it wrong. The
   * caret belongs at the start of the new block, past its split marker, where Editing mode puts it.
   */
  private enterTracked(view: EditorView): boolean {
    const { state } = view
    const before = state.selection.$from
    const bs = before.depth > 0 ? before.before() : -1
    if (!enterKey(state, (tr) => view.dispatch(tr))) return false
    const doc = view.state.doc
    const $s = view.state.selection.$from
    if (bs < 0 || !view.state.selection.empty || $s.depth === 0 || $s.before() !== bs) return true
    // still in the block Enter was pressed in: move to the start of the block the split made after it
    const end = bs + doc.resolve(bs).nodeAfter!.nodeSize
    const sel = TextSelection.near(doc.resolve(end), 1)
    const marker = sel.$from.parent.firstChild?.isText && sel.$from.parent.firstChild.text!.startsWith(ZWSP) && sel.$from.parentOffset === 0 ? 1 : 0
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, sel.from + marker)).setMeta(suggestChangesKey, { skip: true }))
    return true
  }

  /**
   * Suggesting mode, Backspace at the start of a list item or quote: lift the block out (Pass 4 #6). Done on a scratch
   * state first, then the whole top-level list or quote is swapped for its lifted form, so suggest-changes tracks one
   * shape every time ("old container deleted, new content inserted"). Left to the library the shape depended on the
   * item's place (struck text inside a surviving shell: Accept left an empty bullet or a bare '>'), and it parked the
   * caret in the struck copy, so the join on the next Backspace acted on struck text. The caret goes where Editing
   * mode puts it, in the inserted copy, and the join is then an edit inside TJ's own insertion (ownInsertion.ts).
   */
  private liftTracked(view: EditorView, cmd: Command): boolean {
    const $f = view.state.selection.$from
    if (!view.state.selection.empty || $f.parentOffset !== 0 || $f.depth < 2) return false
    return this.swapTracked(view, cmd)
  }

  /**
   * Run a structural `cmd` on a scratch state, then swap the top-level blocks it touched for their result in one
   * transaction, which suggest-changes tracks as "old blocks deleted, new blocks inserted". The caret lands where the
   * command put it, in the inserted copy.
   */
  private swapTracked(view: EditorView, cmd: Command): boolean {
    const { state } = view
    let scratch: Transaction | null = null
    if (!cmd(state, (t) => (scratch = t))) return false
    const lifted = scratch as Transaction | null
    if (!lifted) return false
    // the range the steps touched, in the old doc's coordinates, widened to whole top-level blocks
    let lo = Infinity
    let hi = -Infinity
    lifted.mapping.maps.forEach((map, i) => {
      // (the inverse of the steps before this one only: slice(0, i).invert() inverts every step)
      const back = new Mapping(lifted.mapping.maps.slice(0, i)).invert()
      map.forEach((a, b) => {
        lo = Math.min(lo, back.map(a, 1))
        hi = Math.max(hi, back.map(b, -1))
      })
    })
    if (lo > hi) return false
    const $lo = state.doc.resolve(lo)
    const $hi = state.doc.resolve(hi)
    const from = $lo.depth >= 1 ? $lo.before(1) : lo
    const to = $hi.depth >= 1 ? $hi.after(1) : hi
    const end = lifted.mapping.map(to, -1)
    const repl = lifted.doc.slice(from, end)
    const tr = state.tr.replaceWith(from, to, repl.content)
    view.dispatch(tr.scrollIntoView())
    // the inserted copy follows the struck container; the caret keeps its offset within it
    const { deletion } = suggestionMarkTypes(state.schema)
    const doc = view.state.doc
    let at = from
    for (;;) {
      const n = at < doc.content.size ? doc.resolve(at).nodeAfter : null
      if (!n || !deletion.isInSet(n.marks)) break
      at += n.nodeSize
    }
    const caret = at + (lifted.selection.from - from)
    if (at > from && caret <= doc.content.size) {
      view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(caret))).setMeta(suggestChangesKey, { skip: true }))
    }
    return true
  }

  /**
   * Run `cmd` as if [from, to) were already gone (the split marker the user doesn't see), and dispatch the trim plus
   * the command's steps as one user transaction (one undo). A command that changes nothing leaves the doc alone.
   */
  private withTrim(view: EditorView, from: number, to: number, cmd: Command): boolean {
    const trim = view.state.tr.delete(from, to)
    const next = EditorState.create({ doc: trim.doc, selection: TextSelection.create(trim.doc, from) })
    let done: Transaction | null = null
    if (!cmd(next, (t) => (done = t))) return false
    const run = done as Transaction | null
    if (!run) return true
    const tr = view.state.tr
    for (const step of trim.steps) tr.step(step)
    for (const step of run.steps) tr.step(step)
    tr.setSelection(Selection.fromJSON(tr.doc, run.selection.toJSON()))
    view.dispatch(tr.scrollIntoView())
    return true
  }

  /**
   * Suggesting mode, Backspace (dir -1) or Delete (dir 1) with a caret inside a textblock: strike the next character
   * that is not already struck, as a tracked deletion, and leave the caret on the far side of what is struck. Left to
   * the browser, the keystroke edits the DOM and ProseMirror diffs it back; next to struck text that diff is ambiguous
   * and came back as "struck plus re-inserted" ghost text, and suggest-changes always parks the caret at the start of
   * a tracked deletion, so a forward Delete re-hit the same character forever (QA3). False = not handled here (block
   * edge, or a non-text inline node next to the caret): the base keymap and the browser take it as before.
   */
  private strikeChar(view: EditorView, dir: -1 | 1): boolean {
    const { state } = view
    const sel = state.selection
    if (!sel.empty || !(sel instanceof TextSelection) || !sel.$from.parent.isTextblock || sel.$from.parent.type.spec.code) return false
    const deletion = state.schema.marks.deletion
    if (!deletion) return false
    const $c = sel.$from
    const lo = $c.start()
    const hi = $c.end()
    let p = $c.pos
    // step over text that is already struck
    for (;;) {
      if (dir < 0 ? p <= lo : p >= hi) break
      const $p = state.doc.resolve(p)
      const n = dir < 0 ? $p.nodeBefore : $p.nodeAfter
      if (!n || !n.isText) return false
      if (!deletion.isInSet(n.marks)) break
      p += dir * n.nodeSize
    }
    if (dir < 0 ? p <= lo : p >= hi) {
      // only struck text up to the block edge: move over it, and the next press is a block-edge key as usual
      if (p === $c.pos) return false
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, p)))
      return true
    }
    const $p = state.doc.resolve(p)
    const text = (dir < 0 ? $p.nodeBefore : $p.nodeAfter)!.text!
    const code = dir < 0 ? text.charCodeAt(text.length - 1) : text.charCodeAt(0)
    const pair = dir < 0 ? code >= 0xdc00 && code <= 0xdfff && text.length > 1 : code >= 0xd800 && code <= 0xdbff && text.length > 1
    const len = pair ? 2 : 1
    const a = dir < 0 ? p - len : p
    const before = state.doc
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, p)).delete(a, a + len).scrollIntoView())
    if (view.state.doc === before) return true // refused (foreign / D14): nothing more to do
    if (dir > 0) {
      // the library left the caret before the struck character: put it after (an own insertion is really removed)
      const after = view.state.doc.resolve(Math.min(a, view.state.doc.content.size)).nodeAfter
      if (after?.isText && deletion.isInSet(after.marks) && a + len <= view.state.doc.content.size) {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a + len)))
      }
    }
    return true
  }

  /**
   * Suggesting mode's deletion of a range: one inline deletion per textblock it crosses. A structural delete across a
   * block boundary (PM's deleteSelection) is a join, which suggest-changes renders as "both blocks deleted, their
   * join inserted" with the caret left in the deleted copy. Striking each block's text instead keeps the structure;
   * accepting removes the text (the blocks stay separate).
   */
  trackedDeleteTr(state: EditorState, from: number, to: number): Transaction {
    const tr = state.tr
    const ranges: Array<{ a: number; b: number }> = []
    // a list item whose whole text the selection covers, and which it reaches past (the item above's end, or the next
    // item's start: a triple-click, a drag from the line above), is deleted with its bullet (Pass 4 #9). That is what
    // Editing's join leaves; striking only the text left an empty bullet behind.
    const covered = new Map<PMNode, number>()
    state.doc.nodesBetween(from, to, (n, pos, parent) => {
      if (n.type.name !== 'list_item' || n.childCount !== 1 || !n.firstChild!.isTextblock || !parent) return true
      const ps = pos + 2
      const pe = pos + n.nodeSize - 2
      if (from <= ps && to >= pe && (from < ps || to > pe)) covered.set(parent, (covered.get(parent) ?? 0) + 1)
      return false
    })
    state.doc.nodesBetween(from, to, (n, pos, parent) => {
      if (n.type.name === 'list_item' && parent && covered.has(parent) && covered.get(parent)! < parent.childCount && n.childCount === 1 && n.firstChild!.isTextblock) {
        const ps = pos + 2
        const pe = pos + n.nodeSize - 2
        if (from <= ps && to >= pe && (from < ps || to > pe)) {
          ranges.push({ a: pos, b: pos + n.nodeSize })
          return false
        }
      }
      if (!n.isTextblock) return true
      const a = Math.max(from, pos + 1)
      const b = Math.min(to, pos + 1 + n.content.size)
      if (b > a) ranges.push({ a, b })
      return false
    })
    for (const r of ranges.reverse()) tr.delete(r.a, r.b)
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(from, -1)), -1))
    return tr.scrollIntoView()
  }

  // ===================================================================================== suggestions: ownership, reconcile

  isClaude(id: SuggestionId): boolean {
    return this.claudeIds.has(id)
  }

  byOf(id: SuggestionId): Author {
    return this.claudeIds.has(id) ? 'Claude' : 'TJ'
  }

  private updateOwnership(review: ReviewState): void {
    let changed = false
    for (const s of review.suggestions) {
      if (s.by === 'Claude' && !this.claudeIds.has(s.id)) {
        this.claudeIds.add(s.id)
        changed = true
      }
    }
    if (changed && this.view) this.view.dispatch(this.view.state.tr.setMeta(suggestDecoKey, 'rebuild').setMeta(suggestChangesKey, { skip: true }))
  }

  /** The suggestions the live doc should show, given the review state (§6.3 "the server record is the source of truth"). */
  private reconcile(kind: 'initial' | 'review' | 'reload' | 'draft', L: Loaded | null, review: ReviewState): void {
    if (!L || !this.view) return
    this.updateOwnership(review)
    const byId = new Map(review.suggestions.map((s) => [s.id, s]))
    for (const id of [...this.locallyDecided.keys()]) {
      const s = byId.get(id)
      if (!s || s.status !== 'pending') this.locallyDecided.delete(id)
    }
    // 1. marks that should go
    const present = suggestionIdsIn(this.view.state.doc)
    const toApply = new Set<SuggestionId>()
    const toRevert = new Set<SuggestionId>()
    for (const id of present) {
      const s = byId.get(id)
      if (!s) {
        if (this.hydrated.get(id)?.by === 'Claude') toRevert.add(id)
        continue
      }
      if (s.status === 'pending') {
        const h = this.hydrated.get(id)
        if (!h || h.seq === s.updatedSeq || this.journal.isUndone(id) || this.locallyDecided.has(id)) continue
        if (s.by === 'Claude') toRevert.add(id)
        else {
          // TJ's record changed on the server (a rebase), not by his own upsert, and his marks haven't moved since
          const sent = this.committedRecords.get(id)
          const ownUpsert = sent && sent.base === s.base && sent.proposed === s.proposed
          if (!ownUpsert && (this.commitVersion.get(id) ?? 0) === (this.markVersion.get(id) ?? 0)) {
            toRevert.add(id)
            this.wiped.add(id)
          } else h.seq = s.updatedSeq
        }
        continue
      }
      if (s.status === 'stale') {
        if (s.by === 'Claude') toRevert.add(id)
        continue
      }
      if (this.journal.isUndone(id) || this.locallyDecided.has(id) || this.replaying.has(id)) continue
      if ((kind === 'initial' || kind === 'draft') && s.decidedBy === 'TJ' && s.status !== 'withdrawn') continue // a restored undo: reopen
      if (s.status === 'accepted') toApply.add(id)
      else toRevert.add(id)
    }
    if (toApply.size || toRevert.size) {
      const tr = this.programmatic('unmark')
      tr.setMeta('addToHistory', false)
      if (toApply.size) decideSuggestions(tr, toApply, 'apply')
      if (toRevert.size) decideSuggestions(tr, toRevert, 'revert')
      if (tr.docChanged) this.apply(tr)
      for (const id of [...toApply, ...toRevert]) this.hydrated.delete(id)
    }
    // 2. pending records to place, in createdSeq order
    const now = suggestionIdsIn(this.view.state.doc)
    const pending = review.suggestions.filter((s) => s.status === 'pending').sort((a, b) => a.createdSeq - b.createdSeq)
    for (const s of pending) {
      if (now.has(s.id)) {
        if (!this.hydrated.has(s.id)) this.hydrated.set(s.id, { seq: s.updatedSeq, by: s.by })
        this.unplaced.delete(s.id)
        if (s.by === 'TJ') this.seenTj.add(s.id)
        continue
      }
      if (this.locallyDecided.has(s.id) || this.replaying.has(s.id)) continue
      const prior = this.unplaced.get(s.id)
      if (s.by === 'TJ' && kind !== 'initial' && !this.wiped.has(s.id) && !prior) continue // TJ removed his marks: withdraw
      if (prior && prior.seq === s.updatedSeq && prior.L === L) continue // nothing changed since it failed
      const r = hydrate(this.view.state, s, { md: this.md, loaded: L })
      if ('tr' in r) {
        this.apply(r.tr)
        this.hydrated.set(s.id, { seq: s.updatedSeq, by: s.by })
        this.unplaced.delete(s.id)
        this.wiped.delete(s.id)
        if (s.by === 'TJ') {
          // the marks now equal the stored record: nothing of TJ's is pending for this id
          this.seenTj.add(s.id)
          this.committedRecords.set(s.id, { base: s.base, proposed: s.proposed })
          this.commitVersion.set(s.id, this.markVersion.get(s.id) ?? 0)
        }
      } else {
        this.unplaced.set(s.id, { reason: r.unplaced, seq: s.updatedSeq, L })
      }
    }
    for (const id of [...this.unplaced.keys()]) {
      if (byId.get(id)?.status !== 'pending') this.unplaced.delete(id)
    }
    this.journal.prune((id) => byId.get(id)?.status === 'pending')
  }

  // ===================================================================================== threads

  private alignment(L: Loaded): LiveAlignment {
    const doc = this.view.state.doc
    if (this.alignCache && this.alignCache.doc === doc && this.alignCache.L === L) return this.alignCache.al
    const al = alignLive(doc, L, this.baseTr())
    this.alignCache = { doc, L, al }
    return al
  }

  private updateThreadMeta(review: ReviewState): void {
    const authors = new Map<ThreadId, Author>()
    const resolved = new Set<ThreadId>()
    for (const t of review.threads) {
      authors.set(t.id, t.createdBy)
      if (t.status === 'resolved') resolved.add(t.id)
    }
    this.view.dispatch(this.view.state.tr.setMeta(highlightKey, { authors, resolved }).setMeta(suggestChangesKey, { skip: true }))
  }

  /**
   * Place comment highlights from the review state (§12.1): new threads, reattached ones, ones whose anchor someone
   * else changed, and (after a reload) the ones the replace collapsed. Live places are otherwise left alone: the
   * mapped range is the truth for TJ's edits.
   */
  private placeThreads(review: ReviewState, L: Loaded | null, o: { full?: boolean; only?: ReadonlySet<ThreadId> } = {}): void {
    if (!L) return
    const hs = highlightKey.getState(this.view.state)
    if (!hs) return
    const comment = review.threads.filter((t) => t.kind === 'comment' && t.anchor.kind !== 'doc')
    const ids = new Set(comment.map((t) => t.id))
    const remove = [...hs.places.keys()].filter((id) => !ids.has(id) && id !== DRAFT_PLACE)
    const put = new Map<ThreadId, ThreadPlace>()
    let al: LiveAlignment | null = null
    let p: PText | null = null
    for (const t of comment) {
      const cur = hs.places.get(t.id)
      const key = JSON.stringify(t.anchor)
      const sent = this.sentAnchors.get(t.id)
      if (sent !== undefined && (sent === null ? t.detached : JSON.stringify(sent) === key)) this.sentAnchors.delete(t.id)
      if (t.detached) {
        if (cur && !isCollapsed(cur) && !o.full) continue // our live range still holds it; the server will reattach
        if (cur) remove.push(t.id)
        continue
      }
      const externallyChanged = this.placedAnchors.has(t.id) && this.placedAnchors.get(t.id) !== key && !(sent && JSON.stringify(sent) === key)
      const need = o.full || !cur || (o.only?.has(t.id) ?? false) || isCollapsed(cur) || externallyChanged
      if (!need) continue
      al ??= this.alignment(L)
      p ??= ptextOf(al.revert.doc, L)
      const res = resolveAnchor(p, L.blocks, t.anchor)
      const inv = al.revert.mapping.invert()
      this.placedAnchors.set(t.id, key)
      if (res.state === 'detached' || res.state === 'doc') continue
      if (t.anchor.kind === 'block' && res.block !== undefined) {
        const e = al.entries?.[res.block]
        if (e) put.set(t.id, { kind: 'block', pos: e.from })
        continue
      }
      if (res.from === undefined || res.to === undefined) continue
      const from = inv.map(p.toPos(res.from, 1), 1)
      const to = inv.map(p.toPos(res.to, -1), -1)
      if (to > from) put.set(t.id, { kind: 'text', from, to })
    }
    if (remove.length) this.view.dispatch(this.view.state.tr.setMeta(highlightKey, { remove }).setMeta(suggestChangesKey, { skip: true }))
    if (put.size) this.view.dispatch(this.view.state.tr.setMeta(highlightKey, { put }).setMeta(suggestChangesKey, { skip: true }))
  }

  setVisibleThreads(ids: readonly ThreadId[]): void {
    this.view.dispatch(this.view.state.tr.setMeta(highlightKey, { visible: new Set(ids) }).setMeta(suggestChangesKey, { skip: true }))
  }

  /** The new-comment box opened (`on`) or closed: the selected text keeps a highlight while TJ writes, since the textarea has the focus. */
  setDraftHighlight(on: boolean): void {
    const sel = this.view.state.selection
    if (on && !sel.empty) {
      this.view.dispatch(this.view.state.tr.setMeta(highlightKey, { put: new Map([[DRAFT_PLACE, { kind: 'text' as const, from: sel.from, to: sel.to }]]) }).setMeta(suggestChangesKey, { skip: true }))
    } else if (highlightKey.getState(this.view.state)?.places.has(DRAFT_PLACE)) {
      this.view.dispatch(this.view.state.tr.setMeta(highlightKey, { remove: [DRAFT_PLACE] }).setMeta(suggestChangesKey, { skip: true }))
    }
  }

  /** The suggestions of the active thread (their inline marks show data-active, R2.5). */
  private activeSuggestions = new Set<SuggestionId>()

  setActiveThread(id: string | null): void {
    const next = new Set<SuggestionId>(id ? (this.session.getReview().threads.find((t) => t.id === id)?.suggestions ?? []) : [])
    const same = next.size === this.activeSuggestions.size && [...next].every((s) => this.activeSuggestions.has(s))
    this.activeSuggestions = next
    let tr = this.view.state.tr.setMeta(highlightKey, { active: id }).setMeta(suggestChangesKey, { skip: true })
    if (!same) tr = tr.setMeta(suggestDecoKey, 'rebuild')
    this.view.dispatch(tr)
  }

  private refreshConflicts(): void {
    if (!this.view || this.destroyed) return
    const L = this.internals.getLoaded()
    const places: ConflictPlace[] = []
    if (L) {
      const al = this.alignment(L)
      for (const c of this.session.getConflicts()) {
        if (c.currentIndex === null) continue
        const e = al.entries?.[c.currentIndex]
        if (e) places.push({ id: c.id, kind: c.kind, pos: e.from })
      }
    }
    this.view.dispatch(this.view.state.tr.setMeta(conflictKey, places).setMeta(suggestChangesKey, { skip: true }))
  }

  // ===================================================================================== rects and selection

  rectOf(id: string): AnchorRect | null {
    const sc = this.o.scrollContainer
    const dom = this.view.dom
    const q = (sel: string): Element | null => dom.querySelector(sel)
    if (id.startsWith('t_')) {
      const place = highlightKey.getState(this.view.state)?.places.get(id as ThreadId)
      const chipRect = this.statusChipRectFor(place)
      if (chipRect) return chipRect
      const el = q(`[data-thread="${id}"]`)
      if (el) return toContent(sc, elementBox(el))
      if (place && !isCollapsed(place)) {
        const box = place.kind === 'text' ? coordsAt(this.view, place.from, 1) : nodeBox(this.view, place.pos)
        return box ? toContent(sc, box) : null
      }
      const t = this.review.threads.find((x) => x.id === id)
      if (t?.kind === 'suggestion') {
        for (const s of t.suggestions) {
          const r = this.rectOf(s)
          if (r) return r
        }
        // every suggestion decided: no marks are left, so the card sits where its text now is (Show resolved, QA1)
        const L = this.internals.getLoaded()
        if (L && t.resolution.from !== undefined) {
          const al = this.alignment(L)
          const pos = al.revert.mapping.invert().map(ptextOf(al.revert.doc, L).toPos(t.resolution.from, 1), 1)
          const box = coordsAt(this.view, pos, 1)
          if (box) return toContent(sc, box)
        }
        // an accepted change replaced the text its anchor quoted: the block it was in is the best place left
        const rec = t.suggestions.map((sid) => this.review.suggestions.find((x) => x.id === sid)).find((x) => x !== undefined)
        const entry = L && rec ? this.alignment(L).entries?.[rec.range.start] : undefined
        if (entry) {
          const box = nodeBox(this.view, entry.from)
          if (box) return toContent(sc, box)
        }
      }
      return null
    }
    if (id.startsWith('s_')) {
      // (a copy the page doesn't draw has no box: a format change's struck text, an unchanged item of a swapped list)
      const el = Array.from(dom.querySelectorAll(`[data-suggestion="${id}"]`)).find((x) => !x.closest('.mdr-sugg--shadow'))
      if (el) return toContent(sc, elementBox(el))
      if (this.unplaced.get(id as SuggestionId)?.reason !== 'SCHEMA') return null
      const s = this.review.suggestions.find((x) => x.id === id)
      const L = this.internals.getLoaded()
      if (!s || !L) return null
      const run = locate(L, s)
      const e = run ? this.alignment(L).entries?.[run.start] : undefined
      if (!e) return null
      const box = nodeBox(this.view, e.from)
      return box ? toContent(sc, box) : null
    }
    if (id.startsWith('conflict:') || id.startsWith('unsaveable:')) {
      const el = q(`[data-conflict="${id}"]`)
      return el ? toContent(sc, elementBox(el)) : null
    }
    return null
  }

  /** §12.12 B: a thread inside a collapsed status block reports the chip's rect. */
  private statusChipRectFor(place: ThreadPlace | undefined): AnchorRect | null {
    if (!place || isCollapsed(place)) return null
    const live = statusKey.getState(this.view.state)?.live
    if (!live || !statusCollapsed(this.view.state)) return null
    const { from, to } = blockRange(live)
    const a = place.kind === 'text' ? place.from : place.pos
    if (a < from || a >= to) return null
    const chip = this.view.dom.querySelector(`[data-testid="${TESTID.statusChip}"]`)
    return chip ? toContent(this.o.scrollContainer, elementBox(chip)) : null
  }

  selectionTarget(o?: { collapsed?: 'none' | 'word' }): ReturnType<typeof selectionTarget> {
    const L = this.internals.getLoaded()
    if (!L) return null
    return selectionTarget({ view: this.view, scrollContainer: this.o.scrollContainer, L, rev: this.session.getSnapshot().rev, review: this.review, alignment: this.alignment(L) }, o)
  }

  scrollToThread(id: string, align: 'top30' | 'nearest' = 'top30'): void {
    const r = this.rectOf(id)
    if (!r) return
    const sc = this.o.scrollContainer
    if (align === 'top30') sc.scrollTop = Math.max(0, r.top - sc.clientHeight * 0.3)
    else if (r.top < sc.scrollTop) sc.scrollTop = Math.max(0, r.top - 16)
    else if (r.bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = r.bottom - sc.clientHeight + 16
  }

  // ===================================================================================== summaries

  summaries(): Map<SuggestionId, SuggestionSummary> {
    const out = new Map<SuggestionId, SuggestionSummary>()
    const segs = suggestionSegments(this.view.state.doc)
    const live = new Map<SuggestionId, { del: string; ins: string; mod: boolean; runs: number }>()
    let lastId: SuggestionId | null = null
    for (const s of segs) {
      const e = live.get(s.id) ?? { del: '', ins: '', mod: false, runs: 0 }
      if (s.kind === 'mod') e.mod = true
      else if (s.kind === 'del') e.del += textOf(s.node)
      else e.ins += textOf(s.node)
      if (lastId !== s.id) e.runs++
      lastId = s.id
      live.set(s.id, e)
    }
    const kindOfChange = (del: string, ins: string, mod: boolean): SuggestionSummary['kind'] => {
      if (del && ins) return del === ins ? 'format' : 'replace'
      if (ins) return 'insert'
      if (del) return 'delete'
      return mod ? 'structure' : 'structure'
    }
    // the session's review, not this.review: it already folds a decision the server confirmed (the card goes the moment
    // TJ decides, not one refresh later, when the record would read 'pending' with no marks and look unplaced)
    const records = this.session.getReview().suggestions
    for (const s of records) {
      const l = live.get(s.id)
      // an undone decision whose marks are back is pending again for TJ, before its reopen reaches the server
      const reopening = l !== undefined && (s.status === 'accepted' || s.status === 'rejected') && this.journal.isUndone(s.id)
      if (s.status !== 'pending' && s.status !== 'stale' && !reopening) continue
      const del = s.hunks.map((h) => h.del).join('')
      const ins = s.hunks.map((h) => h.ins).join('')
      if (l) {
        out.set(s.id, {
          id: s.id, by: s.by, kind: l.mod && !l.del && !l.ins ? 'structure' : kindOfChange(l.del, l.ins, l.mod),
          deletedText: l.del, insertedText: l.ins, hunkCount: Math.max(1, s.hunks.length), placed: true,
        })
      } else {
        out.set(s.id, {
          id: s.id, by: s.by, kind: s.hunks.length === 0 ? 'format' : kindOfChange(del, ins, false), deletedText: del, insertedText: ins,
          hunkCount: s.hunks.length, placed: false, unplaced: this.unplaced.get(s.id)?.reason ?? 'BASE_NOT_FOUND',
        })
      }
    }
    for (const [id, l] of live) {
      if (out.has(id) || this.claudeIds.has(id)) continue
      if (records.some((x) => x.id === id)) continue
      out.set(id, {
        id, by: 'TJ', kind: l.mod && !l.del && !l.ins ? 'structure' : kindOfChange(l.del, l.ins, l.mod), deletedText: l.del, insertedText: l.ins,
        hunkCount: l.runs, placed: true,
      })
    }
    return out
  }

  // ===================================================================================== decisions (bridge side)

  /**
   * Redo: a decision whose undo was already reopened on the server is replayed through it (§6.6). Read from the
   * session's review, which knows a fresh decision before the refresh: with the editor's copy a quick accept → undo →
   * redo (the reopen not sent yet) read the stale 'pending', replayed an accept the server answered as a duplicate, and
   * left the marks showing over an accepted record.
   */
  private redo(): boolean {
    const state = this.view.state
    const top = this.journal.redoTop(state)
    if (top) {
      const records = this.session.getReview().suggestions
      const pending = top.ids.filter((id) => records.find((s) => s.id === id)?.status === 'pending')
      if (pending.length > 0) {
        this.journal.drop(top)
        void this.replay(top, pending)
        return true
      }
    }
    return redo(state, this.view.dispatch.bind(this.view))
  }

  private async replay(e: JournalEntry, ids: SuggestionId[]): Promise<void> {
    for (const id of ids) this.replaying.add(id)
    try {
      if (e.bulk !== undefined || ids.length > 1) await this.internals.bulk({ decision: e.decision, ids })
      else await this.internals.decide(ids[0]!, e.decision)
    } catch (err) {
      console.warn('[mdr editor] redo replay failed', err)
    } finally {
      for (const id of ids) this.replaying.delete(id)
    }
  }

  // ===================================================================================== EditorPort

  install(L: Loaded): void {
    const view = this.view
    // a caret at the start of the first text, never ProseMirror's default NodeSelection on a leading YAML panel or
    // raw block (QA3: the panel opened with a selection ring and the Comment button quoted the raw YAML)
    const first = TextSelection.findFrom(L.doc.resolve(0), 1, true)
    view.updateState(EditorState.create({ schema: view.state.schema, doc: L.doc, plugins: view.state.plugins, ...(first ? { selection: first } : {}) }))
    this.journal = new DecisionJournal()
    this.baseCache = null
    this.alignCache = null
    this.syncSuggestPlugin()
    this.review = this.session.getReview()
    this.updateThreadMeta(this.review)
    this.reconcile('initial', L, this.review)
    this.placeThreads(this.review, L, { full: true })
    this.refreshConflicts()
    this.toolbar.update(view.state, this.editableFlag)
    this.installed = true
    this.focusOnOpen()
  }

  private installed = false
  private openFocused = false
  /** Once, when the document is first shown and editable: take the focus, as Google Docs does, unless something else has it. */
  private focusOnOpen(): void {
    if (this.openFocused || !this.installed || !this.editableFlag || this.destroyed) return
    this.openFocused = true
    const doc = this.o.host.ownerDocument
    const a = doc.activeElement
    if (a && a !== doc.body && a !== doc.documentElement) return
    this.view.focus()
  }

  changeGen(): number {
    return this.gen
  }

  isComposing(): boolean {
    return this.view.composing
  }

  private baseTr(): Transform {
    const doc = this.view.state.doc
    if (this.baseCache && this.baseCache.doc === doc) return this.baseCache.tr
    const tr = revertAll(doc)
    this.baseCache = { doc, tr }
    return tr
  }

  baseDoc(): PMNode {
    return this.baseTr().doc
  }

  private cachedExtract(id: SuggestionId, L: Loaded, rev: number): TjSuggestionUpsert | null {
    const v = this.markVersion.get(id) ?? 0
    const hit = this.extractCache.get(id)
    if (hit && hit.v === v && hit.L === L) return hit.u
    const u = extract(this.view.state, id, { md: this.md, loaded: L, rev })
    this.extractCache.set(id, { v, L, u })
    return u
  }

  suggestionPlan(L: Loaded, review: ReviewState): SuggestionPlan {
    const rev = this.session.getSnapshot().rev
    const d = tjSuggestionDiff(this.view.state, review, { md: this.md, loaded: L, rev, extractFn: (id) => this.cachedExtract(id, L, rev) })
    const busy = (id: SuggestionId): boolean => this.replaying.has(id) || this.locallyDecided.has(id)
    const upsert = d.upsert.filter((u) => !busy(u.id) && !this.claudeIds.has(u.id))
    this.lastPlanUpserts = new Map(upsert.map((u) => [u.id, u]))
    const withdraw = d.withdraw.filter((id) => this.seenTj.has(id) && !busy(id) && !this.wiped.has(id) && !this.unplaced.has(id))
    // reopen: grouped by the decision journal (a bulk entry is one atomic bulk reopen, D26)
    const decided = (id: SuggestionId): boolean => {
      const s = review.suggestions.find((x) => x.id === id)
      return !!s && (s.status === 'accepted' || s.status === 'rejected') && (s.decidedBy === 'TJ' || s.decidedBy === undefined)
    }
    const loose = new Set(d.reopen.filter((id) => !busy(id)))
    const reopen: ReopenGroup[] = []
    for (const e of this.journal.undone) {
      const ids = e.ids.filter(decided)
      for (const id of ids) loose.delete(id)
      if (!ids.length) continue
      reopen.push(e.bulk !== undefined ? { ids, bulk: e.bulk } : { ids })
    }
    for (const id of loose) reopen.push({ ids: [id] })
    return { upsert, withdraw, reopen }
  }

  marksStableSince(id: SuggestionId): number | undefined {
    return this.markChangedAt.get(id)
  }

  /** Projected post-save ptext and block hashes for anchor hints (only computed when an anchor needs sending). */
  private projection(L: Loaded): { p: PText; blocks: BlockInfo[]; rev: number } {
    const base = this.baseDoc()
    const ops = planSave(this.md, L, base)
    const rev = this.session.getSnapshot().rev + (ops.length ? 1 : 0)
    if (!ops.length) return { p: ptextOf(base, L), blocks: L.blocks, rev }
    const entries: Array<{ nodes: PMNode[] }> = []
    const blocks: Array<Pick<BlockInfo, 'hash'>> = []
    let k = 0
    const keep = (until: number): void => {
      for (; k < until; k++) {
        entries.push({ nodes: L.entries[k]!.nodes })
        blocks.push({ hash: L.blocks[k]!.hash })
      }
    }
    for (const op of ops) {
      keep(op.after + 1)
      for (const src of op.blocks) {
        entries.push({ nodes: [base] })
        blocks.push({ hash: blockHash(src) })
      }
      k = op.before
    }
    keep(L.entries.length)
    return { p: ptextOf(base, { entries: entries as Loaded['entries'] }), blocks: blocks as BlockInfo[], rev }
  }

  anchorUpdates(L: Loaded, review: ReviewState): AnchorUpdate[] {
    const hs = highlightKey.getState(this.view.state)
    if (!hs || hs.places.size === 0) return []
    const threads = new Map(review.threads.map((t) => [t.id, t]))
    const out: AnchorUpdate[] = []
    let cheap: { base: PMNode; p: PText; tr: Transform } | null = null
    let proj: ReturnType<MdrEditor['projection']> | null = null
    for (const [id, place] of hs.places) {
      const t = threads.get(id)
      if (!t || t.detached || t.anchor.kind === 'doc') continue
      if (isCollapsed(place)) {
        if (this.sentAnchors.get(id) !== null) out.push({ thread: id, anchor: null })
        continue
      }
      if (place.kind === 'block' || t.anchor.kind !== 'text') continue
      if (!cheap) {
        const tr = this.baseTr()
        cheap = { base: tr.doc, p: ptextOf(tr.doc, L), tr }
      }
      const stored = (this.sentAnchors.get(id) ?? t.anchor) as TextAnchor
      const o1 = offsetNear(cheap.p, cheap.base, cheap.tr.mapping.map(place.from, 1), 1)
      const o2 = offsetNear(cheap.p, cheap.base, cheap.tr.mapping.map(place.to, -1), -1)
      if (o1 === null || o2 === null || o2 <= o1) {
        out.push({ thread: id, anchor: null })
        continue
      }
      const text = cheap.p.text
      const span = text.slice(o1, o2)
      const same = stored.span !== undefined && stored.tail !== undefined
        ? span.length === stored.span && span.startsWith(stored.quote) && span.endsWith(stored.tail)
        : span === stored.quote
      const dup = same && stored.span === undefined && text.indexOf(span) !== text.lastIndexOf(span)
      if (same && !dup) continue
      proj ??= this.projection(L)
      const fresh = createAnchor(proj.p, proj.blocks, o1, o2, proj.rev)
      if (!same) out.push({ thread: id, anchor: fresh })
      else if (fresh.prefix !== stored.prefix || fresh.suffix !== stored.suffix || fresh.hint.block !== stored.hint.block || fresh.hint.blockHash !== stored.hint.blockHash) {
        out.push({ thread: id, anchor: fresh })
      }
    }
    return out
  }

  committed(o: { L: Loaded; anchors: AnchorUpdate[]; upserted: SuggestionId[]; withdrawn: SuggestionId[] }): void {
    const detached: ThreadId[] = []
    for (const a of o.anchors) {
      this.sentAnchors.set(a.thread, a.anchor)
      if (a.anchor === null) detached.push(a.thread)
      else this.placedAnchors.set(a.thread, JSON.stringify(a.anchor))
    }
    if (detached.length) this.view.dispatch(this.view.state.tr.setMeta(highlightKey, { remove: detached }).setMeta(suggestChangesKey, { skip: true }))
    for (const id of o.upserted) {
      const u = this.lastPlanUpserts.get(id)
      if (u) this.committedRecords.set(id, { base: u.base, proposed: u.proposed })
      this.commitVersion.set(id, this.markVersion.get(id) ?? 0)
    }
    for (const id of o.withdrawn) {
      this.seenTj.delete(id)
      this.committedRecords.delete(id)
      this.withdrawnTj.add(id)
    }
    this.alignCache = null
    if (o.withdrawn.length) this.reviveWithdrawn() // a redo that landed while the withdraw was in flight
  }

  private captureScroll(L: Loaded | null): { hash: string; index: number; px: number } | null {
    if (!L) return null
    try {
      const sc = this.o.scrollContainer
      const top = sc.getBoundingClientRect().top
      const al = this.alignment(L)
      if (!al.entries) return null
      for (let i = 0; i < al.entries.length; i++) {
        const box = nodeBox(this.view, al.entries[i]!.from)
        if (!box) return null
        if (box.bottom > top) return { hash: L.blocks[i]!.hash, index: i, px: top - box.top }
      }
    } catch {
      // no layout
    }
    return null
  }

  private restoreScroll(s: { hash: string; index: number; px: number } | null, L: Loaded): void {
    if (!s) return
    const run = (): void => {
      if (this.destroyed) return
      let best = -1
      L.blocks.forEach((b, i) => {
        if (b.hash === s.hash && (best < 0 || Math.abs(i - s.index) < Math.abs(best - s.index))) best = i
      })
      if (best < 0) return
      const e = this.alignment(L).entries?.[best]
      const box = e ? nodeBox(this.view, e.from) : null
      if (!box) return
      const sc = this.o.scrollContainer
      const top = sc.getBoundingClientRect().top
      sc.scrollTop += box.top - (top - s.px)
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else run()
  }

  applyReload(o: ReloadApply): void {
    const before = highlightKey.getState(this.view.state)?.places ?? new Map<ThreadId, ThreadPlace>()
    const presentBefore = suggestionIdsIn(this.view.state.doc)
    const scroll = this.captureScroll(o.prev)
    const tr = buildMinimalReplaceTr(this.view.state, o.prev, o.next, { preserve: o.preserve })
    if (tr) {
      const pud = this.pendingUnplacedDecision
      if (o.reason === 'decision' && pud) {
        // an unplaced ('SCHEMA') accept adopted through the reload path: an undoable decide step (§6.3)
        tr.setMeta('addToHistory', true)
        tr.setMeta('mdr', { origin: 'decide', ids: pud.ids, decision: pud.decision, ...(pud.bulk ? { bulk: pud.bulk } : {}) })
        closeHistory(tr)
        this.pendingUnplacedDecision = null
      }
      this.apply(tr)
    }
    if (o.reason === 'decision') this.pendingUnplacedDecision = null
    this.baseCache = null
    this.alignCache = null
    const presentAfter = suggestionIdsIn(this.view.state.doc)
    for (const id of presentBefore) {
      if (presentAfter.has(id)) continue
      this.wiped.add(id)
      this.hydrated.delete(id)
    }
    this.review = o.review
    this.reconcile('reload', o.next, o.review)
    const after = highlightKey.getState(this.view.state)?.places ?? new Map<ThreadId, ThreadPlace>()
    const collapsed = new Set<ThreadId>()
    for (const [id, p] of before) {
      const q = after.get(id)
      if (!isCollapsed(p) && (!q || isCollapsed(q))) collapsed.add(id)
    }
    this.placeThreads(o.review, o.next, { full: o.prev === null, only: collapsed })
    this.refreshConflicts()
    this.restoreScroll(scroll, o.next)
    this.emitLayout('reload')
  }

  reviewChanged(review: ReviewState): void {
    this.review = review
    if (!this.view) return
    this.updateThreadMeta(review)
    const L = this.internals.getLoaded()
    this.reconcile('review', L, review)
    this.placeThreads(review, L)
  }

  decisionApplied(o: { ids: SuggestionId[]; decision: 'accept' | 'reject'; bulk?: OpKey }): boolean {
    this.pendingUnplacedDecision = null
    const present = suggestionIdsIn(this.view.state.doc)
    const placed = o.ids.filter((id) => present.has(id))
    const missing = o.ids.filter((id) => !present.has(id))
    for (const id of o.ids) this.locallyDecided.set(id, o.decision)
    if (placed.length) {
      const tr = this.programmatic('decide', { ids: placed, decision: o.decision, ...(o.bulk ? { bulk: o.bulk } : {}) })
      tr.setMeta('addToHistory', true)
      decideSuggestions(tr, new Set(placed), o.decision === 'accept' ? 'apply' : 'revert')
      closeHistory(tr)
      if (tr.docChanged) this.apply(tr)
    }
    if (o.decision === 'accept' && missing.length) {
      this.pendingUnplacedDecision = { ids: missing, decision: o.decision, ...(o.bulk ? { bulk: o.bulk } : {}) }
      return false
    }
    return true
  }

  reopenRefused(group: ReopenGroup): void {
    const e = this.journal.undone.find((x) => x.ids.some((id) => group.ids.includes(id))) ?? null
    const state = this.view.state
    if (e && this.journal.redoTop(state) === e) {
      redo(state, this.view.dispatch.bind(this.view))
    } else if (e) {
      const present = suggestionIdsIn(state.doc)
      const ids = new Set(e.ids.filter((id) => present.has(id)))
      if (ids.size) {
        const tr = this.programmatic('decide', { ids: [...ids], decision: e.decision })
        tr.setMeta('addToHistory', false)
        decideSuggestions(tr, ids, e.decision === 'accept' ? 'apply' : 'revert')
        if (tr.docChanged) this.apply(tr)
      }
      this.journal.drop(e)
    }
    for (const id of group.ids) this.locallyDecided.set(id, e?.decision ?? 'accept')
    this.notice({ kind: 'info', code: 'UNDO_CANCELLED', text: 'That suggestion changed since you decided it, so the undo was cancelled.' })
  }

  draftState(): DraftState {
    const s = this.view.state.selection
    return { liveDoc: this.view.state.doc.toJSON(), selection: { anchor: s.anchor, head: s.head }, mode: this.mode }
  }

  restoreDraft(d: { liveDoc: unknown; selection: DraftState['selection'] }): boolean {
    let doc: PMNode
    try {
      doc = this.md.schema.nodeFromJSON(d.liveDoc)
      doc.check()
    } catch {
      return false
    }
    const tr = this.programmatic('restore-draft')
    tr.setMeta('addToHistory', false)
    const before = highlightKey.getState(this.view.state)?.places ?? new Map<ThreadId, ThreadPlace>()
    // Only what the draft changed is replaced, so the comment highlights follow it as they follow typing: a swap of the
    // whole doc maps every one of them to nothing and the draft save would report each thread as deleted (QA3 R1).
    const diff = docDiffSteps(tr.doc, doc)
    if (diff) for (const step of diff.steps) tr.step(step)
    else tr.replaceWith(0, tr.doc.content.size, doc.content)
    if (d.selection) {
      const max = tr.doc.content.size
      try {
        tr.setSelection(TextSelection.create(tr.doc, Math.min(d.selection.anchor, max), Math.min(d.selection.head, max)))
      } catch {
        // a selection that no longer resolves: keep the default
      }
    }
    this.apply(tr)
    for (const id of suggestionIdsIn(this.view.state.doc)) if (!this.claudeIds.has(id)) this.seenTj.add(id)
    const L = this.internals.getLoaded()
    const review = this.session.getReview()
    this.reconcile('draft', L, review)
    // A highlight the steps could not carry over (its block was replaced whole) is placed again from the review state
    // against the restored doc, as a reload does. One whose text the draft really removed stays collapsed and is
    // detached by that same save.
    const collapsed = new Set<ThreadId>()
    const after = highlightKey.getState(this.view.state)?.places ?? new Map<ThreadId, ThreadPlace>()
    for (const [id, p] of before) {
      const q = after.get(id)
      if (!isCollapsed(p) && (!q || isCollapsed(q))) collapsed.add(id)
    }
    this.placeThreads(review, L, { only: collapsed })
    return true
  }

  /** The doc with TJ's own suggestions applied and Claude's reverted, as markdown (byte-preserving where it can). */
  private markdownFromDoc(doc: PMNode): string {
    const tj = new Set([...suggestionIdsIn(doc)].filter((id) => !this.claudeIds.has(id)))
    const mine = onlyApplied(doc, tj).doc
    const L = this.internals.getLoaded()
    if (L) {
      try {
        const ops = planSave(this.md, L, mine)
        const r = applyBlockOps(this.md, L, ops)
        // an op that failed verification is left out of r.text; this copy is TJ's (the recovered draft behind Keep mine
        // and Copy), so it takes the unverified splice, which still holds what he typed (QA3 F1)
        return r.failed.length ? assembleOps(this.md, L, ops).text : r.text
      } catch {
        // fall back to a whole-doc serialization
      }
    }
    return this.md.serializeNodes(contentNodes(mine))
  }

  liveMarkdown(): string {
    return this.markdownFromDoc(this.view.state.doc)
  }

  refuseSuggestion(id: SuggestionId, _message: string): boolean {
    if (this.claudeIds.has(id) || !suggestionIdsIn(this.view.state.doc).has(id)) return false
    const tr = this.programmatic('refused', { id })
    tr.setMeta('addToHistory', false)
    decideSuggestions(tr, new Set([id]), 'revert')
    this.apply(tr)
    this.notice({
      kind: 'info',
      code: 'SUGGEST_MODE_BLOCKED',
      text: "That change can't be tracked as a suggestion, so it was taken back. Switch to Editing to make it.",
      action: { label: 'Switch to Editing', run: () => this.setMode('editing') },
    })
    return true
  }

  markdownOf(liveDoc: unknown): string | null {
    try {
      const doc = this.md.schema.nodeFromJSON(liveDoc)
      doc.check()
      return this.markdownFromDoc(doc)
    } catch {
      return null
    }
  }

  replaceAll(markdown: string): void {
    const L = load(this.md, markdown)
    const nodes = L.entries.flatMap((e) => e.nodes)
    const tr = this.programmatic('keep-mine')
    tr.setMeta('addToHistory', true)
    tr.replaceWith(0, tr.doc.content.size, nodes.length ? nodes : [this.md.schema.nodes.paragraph!.create()])
    this.apply(tr)
  }

  takeTheirs(c: BlockConflict, L: Loaded): void {
    const al = this.alignment(L)
    const base = al.revert.doc
    const ops = planSave(this.md, L, base)
    const held = new Set<string>([c.id.slice(c.id.indexOf(':') + 1)])
    if (c.currentIndex !== null && L.blocks[c.currentIndex]) held.add(L.blocks[c.currentIndex]!.hash)
    const op = ops.find((x) => x.covers.some((h) => held.has(h))) ?? ops.find((x) => c.mine !== null && x.blocks.includes(c.mine))
    if (!op) return
    // live range of the op: between the kept entries op.after and op.before, found by aligning base tops with L
    const orig: PMNode[] = []
    const owner: number[] = []
    L.entries.forEach((e, ei) => e.nodes.forEach((n) => (orig.push(n), owner.push(ei))))
    const tops: Array<{ node: PMNode; pos: number }> = []
    base.forEach((n, pos) => {
      if (!(n.type.name === 'paragraph' && n.content.size === 0)) tops.push({ node: n, pos })
    })
    const map = alignNodes(orig, tops.map((t) => t.node))
    let fromBase = 0
    let toBase = base.content.size
    map.forEach((oi, j) => {
      if (oi < 0) return
      const ei = owner[oi]!
      const t = tops[j]!
      if (ei <= op.after) fromBase = Math.max(fromBase, t.pos + t.node.nodeSize)
      if (ei >= op.before) toBase = Math.min(toBase, t.pos)
    })
    const inv = al.revert.mapping.invert()
    const from = inv.map(fromBase, 1)
    const to = inv.map(toBase, -1)
    if (to < from) return
    const nodes = L.entries.slice(op.after + 1, op.before).flatMap((e) => e.nodes)
    const tr = this.programmatic('take-theirs')
    tr.setMeta('addToHistory', true)
    if (nodes.length) tr.replaceWith(from, to, nodes)
    else tr.delete(from, to)
    if (tr.docChanged) this.apply(tr)
    this.refreshConflicts()
  }

  private readOnlyNoticeAt = 0
  private readOnlyNotice(): void {
    const now = Date.now()
    if (now - this.readOnlyNoticeAt < 4_000) return
    this.readOnlyNoticeAt = now
    const b = this.session.getBanner()
    if (b?.kind === 'tab-not-leader') {
      this.notice({
        kind: 'info',
        code: 'READ_ONLY',
        text: 'This tab is read-only because the document is open in another tab.',
        action: { label: 'Take over', run: () => this.session.takeOver() },
      })
      return
    }
    this.notice({ kind: 'info', code: 'READ_ONLY', text: b?.kind === 'read-only' ? b.message : 'This document is read-only right now.' })
  }

  setEditable(editable: boolean): void {
    this.editableFlag = editable
    if (!this.view) return
    this.view.setProps({})
    this.toolbar?.update(this.view.state, editable)
    this.focusOnOpen()
  }

  // ===================================================================================== debug + lifecycle

  /**
   * Test hooks only: insert a block exactly `px` tall directly above the top-level block holding anchor `id`, through
   * a transaction (the editor-bridge contract's step 5, §12.0.3).
   */
  insertBlockAbove(id: string, px: number): boolean {
    const place = highlightKey.getState(this.view.state)?.places.get(id as ThreadId)
    let at: number | null = null
    if (place && !isCollapsed(place)) at = place.kind === 'text' ? place.from : place.pos
    if (at === null) {
      const el = this.view.dom.querySelector(`[data-thread="${id}"], [data-suggestion="${id}"]`)
      if (el) at = this.view.posAtDOM(el, 0)
    }
    if (at === null) return false
    const $at = this.view.state.doc.resolve(at)
    const pos = $at.depth > 0 ? $at.before(1) : at
    const para = this.view.state.schema.nodes.paragraph!
    const tr = this.view.state.tr.insert(pos, para.create(null, this.view.state.schema.text('spacer')))
    tr.setMeta(spacerKey, { pos, px })
    this.view.dispatch(tr)
    return true
  }

  /** Resolves after two animation frames with no transaction in between (§12.0.4). */
  async settled(): Promise<void> {
    const frame = (): Promise<void> => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)))
    for (let i = 0; i < 50; i++) {
      const c = this.txCount
      await frame()
      await frame()
      if (c === this.txCount) return
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.typingTimer) clearTimeout(this.typingTimer)
    if (this.linkClickTimer) clearTimeout(this.linkClickTimer)
    this.popovers.close(false)
    if (this.toolbarFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.toolbarFrame)
    this.resizeObserver?.disconnect()
    for (const c of this.cleanups.splice(0)) c()
    this.link?.close(false)
    this.toolbar?.destroy()
    for (const s of Object.values(this.subs)) s.clear()
    void this.md?.destroy().catch(() => undefined)
    this.o.host.replaceChildren()
    this.o.toolbarHost.replaceChildren()
  }
}
