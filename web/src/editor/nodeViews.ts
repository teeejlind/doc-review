// web/src/editor/nodeViews.ts (P2). Node views for §12.13: task checkboxes, the code-block language field, raw
// blocks and inline-HTML chips, plus the raw / inline-HTML source popover (CONTRACTS §12.13, §12.15, D44).
//
// - list_item: a task item (checked !== null) renders li[data-task] with input.mdr-task[type=checkbox]
//   (data-testid="mdr-task-checkbox", data-checked); a change toggles `checked` through setNodeAttribute as a user
//   transaction (Editing mode writes through; Suggesting mode is decided by the editor's D14 / §6.5 rules).
// - code_block: a language field (data-testid="mdr-code-language") above the code; Enter or blur commits
//   code_block.attrs.language (meta is untouched).
// - raw_block: a read-only monospace source block (data-testid="mdr-raw-block", data-reason). Click, or Enter while
//   focused, opens the raw popover (data-testid="mdr-raw-popover") with the exact source in popoverField `source`.
//   Save replaces the atom with loadRun(md, newSource, L.defs, L.eol) (the editor's commitRawBlock); Cancel closes.
// - html (inline): a source chip (data-testid="mdr-inline-html") in the mono font, an atom selected and deleted as
//   a unit; click opens the same popover on its value; Save is setNodeAttribute(pos, 'value', v).
// - hardbreak: a <br> for every line break, soft ones included (Milkdown paints a soft break as a space).
// - image: an <img> that loads a relative `src` from beside the document (assets.ts); the node keeps its src.
// In Suggesting mode the popover still opens, Save is aria-disabled and raises SUGGEST_MODE_BLOCKED (D14).
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view'
import { TESTID } from '../../../shared/constants'
import type { Mode } from '../../../shared/types'
import type { SuggestBlockReason } from '../../../core/suggest/guards'
import { ARM, atomGuardKey } from './atomGuard'
import { Popover, type PopoverSlot } from './popover'

export interface NodeViewHooks {
  host: HTMLElement
  slot: PopoverSlot
  mode(): Mode
  editable(): boolean
  blocked(why: SuggestBlockReason): void
  /** Replace the raw_block at `pos` with loadRun(newSource); returns an error message, or null when committed. */
  commitRawBlock(pos: number, node: PMNode, source: string): string | null
}

type GetPos = () => number | undefined

const inside = (root: HTMLElement, e: Event): boolean => e.target instanceof Node && root.contains(e.target)

// ------------------------------------------------------------------ task list items

export class ListItemView implements NodeView {
  dom: HTMLLIElement
  contentDOM: HTMLElement
  private box: HTMLInputElement | null = null
  private boxWrap: HTMLElement | null = null

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: GetPos) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement('li')
    this.setAttrs(node)
    if (this.isTask(node)) {
      this.dom.dataset.task = ''
      const wrap = doc.createElement('span')
      wrap.className = 'mdr-task__box'
      wrap.setAttribute('contenteditable', 'false')
      const box = doc.createElement('input')
      box.type = 'checkbox'
      box.className = 'mdr-task'
      box.dataset.testid = TESTID.taskCheckbox
      box.setAttribute('aria-label', 'Task done')
      box.addEventListener('mousedown', (e) => e.stopPropagation())
      box.addEventListener('change', () => this.toggle(box.checked))
      wrap.appendChild(box)
      this.dom.appendChild(wrap)
      this.box = box
      this.boxWrap = wrap
      const content = doc.createElement('div')
      content.className = 'mdr-task__content'
      this.dom.appendChild(content)
      this.contentDOM = content
    } else {
      this.contentDOM = this.dom
    }
    this.sync(node)
  }

  private isTask(n: PMNode): boolean {
    return n.attrs.checked !== null && n.attrs.checked !== undefined
  }

  private setAttrs(n: PMNode): void {
    const d = this.dom.dataset
    d.label = String(n.attrs.label ?? '')
    d.listType = String(n.attrs.listType ?? '')
    d.spread = String(n.attrs.spread ?? false)
    if (this.isTask(n)) {
      d.itemType = 'task'
      d.checked = String(!!n.attrs.checked)
    }
  }

  private sync(n: PMNode): void {
    this.setAttrs(n)
    if (!this.box) return
    const on = !!n.attrs.checked
    this.box.checked = on
    this.box.dataset.checked = String(on)
    this.box.disabled = false
  }

  private toggle(want: boolean): void {
    const pos = this.getPos()
    if (pos === undefined) return
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'checked', want))
    // a refused toggle (read-only, or a Suggesting-mode refusal): the box shows the doc's state again
    this.sync(this.node)
  }

  update(n: PMNode): boolean {
    if (n.type !== this.node.type || this.isTask(n) !== this.isTask(this.node)) return false
    this.node = n
    this.sync(n)
    return true
  }

  stopEvent(e: Event): boolean {
    return !!this.boxWrap && inside(this.boxWrap, e)
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    if (m.type === 'selection') return false
    return !!this.boxWrap && this.boxWrap.contains(m.target)
  }
}

// ------------------------------------------------------------------ code blocks

export class CodeBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private readonly pre: HTMLPreElement
  private readonly bar: HTMLElement
  private readonly input: HTMLInputElement

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: GetPos) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement('div')
    this.dom.className = 'mdr-code-block'
    this.bar = doc.createElement('div')
    this.bar.className = 'mdr-code-block__bar'
    this.bar.setAttribute('contenteditable', 'false')
    this.input = doc.createElement('input')
    this.input.type = 'text'
    this.input.className = 'mdr-code-language'
    this.input.dataset.testid = TESTID.codeLanguage
    this.input.placeholder = 'language'
    this.input.setAttribute('aria-label', 'Code block language')
    this.input.spellcheck = false
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.commit()
        this.backToBody()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.input.value = String(this.node.attrs.language ?? '')
        this.backToBody()
      }
    })
    this.input.addEventListener('blur', () => this.commit())
    this.bar.appendChild(this.input)
    this.pre = doc.createElement('pre')
    const code = doc.createElement('code')
    this.pre.appendChild(code)
    this.dom.append(this.bar, this.pre)
    this.contentDOM = code
    this.sync(node)
  }

  private sync(n: PMNode): void {
    const lang = String(n.attrs.language ?? '')
    if (lang) this.pre.dataset.language = lang
    else delete this.pre.dataset.language
    if (this.input.ownerDocument.activeElement !== this.input) this.input.value = lang
  }

  /**
   * Back to this block's code with the caret at its start (QA3: focus went back to wherever the selection was before
   * the click into the field, usually the top of the document, and the next typing landed in the title).
   */
  private backToBody(): void {
    const pos = this.getPos()
    if (pos !== undefined && pos + 1 <= this.view.state.doc.content.size) {
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1)))
    }
    this.view.focus()
  }

  private commit(): void {
    const pos = this.getPos()
    const want = this.input.value.trim()
    if (pos === undefined || want === String(this.node.attrs.language ?? '')) return
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'language', want))
    if (String(this.view.state.doc.nodeAt(pos)?.attrs.language ?? '') !== want) this.input.value = String(this.node.attrs.language ?? '')
  }

  update(n: PMNode): boolean {
    if (n.type !== this.node.type) return false
    this.node = n
    this.sync(n)
    return true
  }

  stopEvent(e: Event): boolean {
    return inside(this.bar, e)
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    if (m.type === 'selection') return false
    return !this.contentDOM.contains(m.target) || (m.target === this.pre && m.type === 'attributes')
  }
}

// ------------------------------------------------------------------ the source popover (raw blocks, inline HTML)

export function openSourcePopover(
  h: NodeViewHooks,
  o: { kind: 'block' | 'inline'; view: EditorView; getPos: GetPos; node: () => PMNode; anchor: HTMLElement },
): Popover {
  const p = new Popover({
    host: h.host,
    className: `mdr-raw-popover mdr-popover--source`,
    testid: TESTID.rawPopover,
    label: o.kind === 'block' ? 'Edit raw source' : 'Edit inline HTML',
    onClose: (refocus) => {
      if (refocus) o.view.focus()
    },
  })
  h.slot.set(p)
  const original = String(o.node().attrs.value ?? '')
  const src = p.field('source', { label: 'Source', value: original, multiline: true, rows: o.kind === 'block' ? Math.min(16, Math.max(4, original.split('\n').length + 1)) : 3 })
  const why: SuggestBlockReason = o.kind === 'block' ? 'raw-block' : 'inline-html'
  const disabledReason = (): string | null => {
    if (!h.editable()) return 'This document is read-only.'
    if (h.mode() === 'suggesting') return o.kind === 'block' ? "Raw source blocks can't be edited in Suggesting mode." : "Inline HTML can't be edited in Suggesting mode."
    return null
  }
  const save = (): void => {
    if (!h.editable()) return
    if (h.mode() === 'suggesting') {
      h.blocked(why)
      return
    }
    const pos = o.getPos()
    const node = o.node()
    const cur = pos === undefined ? null : o.view.state.doc.nodeAt(pos)
    if (pos === undefined || !cur || cur.type !== node.type || String(cur.attrs.value ?? '') !== original) {
      p.setError('This changed since you opened it. Close and open it again.')
      return
    }
    const next = (src as HTMLTextAreaElement).value
    if (next === original) {
      p.close(true)
      return
    }
    if (o.kind === 'inline') {
      if (!next.trim()) {
        p.setError('Inline HTML can’t be empty. Delete the chip in the text instead.')
        return
      }
      o.view.dispatch(o.view.state.tr.setNodeAttribute(pos, 'value', next))
      p.close(true)
      return
    }
    const err = h.commitRawBlock(pos, cur, next)
    if (err) p.setError(err)
    else p.close(true)
  }
  src.addEventListener('keydown', (e) => {
    const k = e as KeyboardEvent
    if (k.key === 'Enter' && (k.metaKey || k.ctrlKey)) {
      e.preventDefault()
      save()
    }
  })
  p.action('save', 'Save', save, { primary: true, disabledReason: disabledReason() })
  p.action('cancel', 'Cancel', () => p.close(true))
  const r = o.anchor.getBoundingClientRect()
  p.open({ left: r.left, bottom: r.bottom }, src)
  return p
}

/** Select an atom as a node (so the comment flow sees a BlockAnchor / the chip as a unit). */
function selectNode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  try {
    // a click on the block: Backspace / Delete may now remove it (atomGuard.ts)
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).setMeta(atomGuardKey, ARM))
  } catch {
    // not selectable here
  }
}

// ------------------------------------------------------------------ raw blocks

export class RawBlockView implements NodeView {
  dom: HTMLElement
  private readonly pre: HTMLPreElement

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: GetPos, private readonly h: NodeViewHooks) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement('div')
    this.dom.className = 'mdr-raw-block'
    this.dom.dataset.testid = TESTID.rawBlock
    this.dom.tabIndex = 0
    this.dom.setAttribute('role', 'button')
    this.pre = doc.createElement('pre')
    this.pre.className = 'mdr-raw-block__source'
    this.dom.appendChild(this.pre)
    this.dom.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
    })
    this.dom.addEventListener('click', (e) => {
      e.preventDefault()
      this.open()
    })
    this.dom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.open()
      }
    })
    this.sync(node)
  }

  private sync(n: PMNode): void {
    this.pre.textContent = String(n.attrs.value ?? '')
    this.dom.dataset.reason = String(n.attrs.reason ?? '')
    // The button is named by what it shows, its source (WCAG 2.5.3: an aria-label that left the visible text out
    // would fail label-in-name); what it is and how to open it is the description (a tooltip for the mouse).
    this.dom.title = `Raw source block${n.attrs.reason ? ` (${String(n.attrs.reason)})` : ''}: press Enter to edit`
  }

  open(): void {
    selectNode(this.view, this.getPos())
    openSourcePopover(this.h, { kind: 'block', view: this.view, getPos: this.getPos, node: () => this.node, anchor: this.dom })
  }

  update(n: PMNode): boolean {
    if (n.type !== this.node.type) return false
    this.node = n
    this.sync(n)
    return true
  }

  selectNode(): void {
    this.dom.classList.add('is-selected')
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected')
  }

  stopEvent(e: Event): boolean {
    return e.type === 'mousedown' || e.type === 'click' || (e.type === 'keydown' && (e as KeyboardEvent).key === 'Enter' && e.target === this.dom)
  }

  ignoreMutation(): boolean {
    return true
  }
}

// ------------------------------------------------------------------ inline HTML chips

export class InlineHtmlView implements NodeView {
  dom: HTMLElement

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: GetPos, private readonly h: NodeViewHooks) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement('span')
    this.dom.className = 'mdr-inline-html'
    this.dom.dataset.testid = TESTID.inlineHtml
    this.dom.dataset.type = 'html'
    this.dom.setAttribute('contenteditable', 'false')
    this.dom.addEventListener('mousedown', (e) => {
      if (e.button === 0) e.preventDefault()
    })
    this.dom.addEventListener('click', (e) => {
      e.preventDefault()
      this.open()
    })
    this.sync(node)
  }

  private sync(n: PMNode): void {
    const v = String(n.attrs.value ?? '')
    this.dom.textContent = v
    this.dom.dataset.value = v
    this.dom.title = 'Inline HTML: click to edit'
  }

  open(): void {
    selectNode(this.view, this.getPos())
    openSourcePopover(this.h, { kind: 'inline', view: this.view, getPos: this.getPos, node: () => this.node, anchor: this.dom })
  }

  update(n: PMNode): boolean {
    if (n.type !== this.node.type) return false
    this.node = n
    this.sync(n)
    return true
  }

  selectNode(): void {
    this.dom.classList.add('is-selected')
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected')
  }

  stopEvent(e: Event): boolean {
    return e.type === 'mousedown' || e.type === 'click'
  }

  ignoreMutation(): boolean {
    return true
  }
}

// ------------------------------------------------------------------ line breaks

/**
 * A line break shows as one, soft breaks included. Milkdown parses a newline inside a paragraph's source to
 * hardbreak{isInline: true} and paints it as a space (CommonMark's rendering, and GitHub's), so consecutive source
 * lines ran together; a reader expects the Google Docs model, where a new line is a new line (Trial, TJ 2026-10-23).
 * View only: the node, its size and its markdown are unchanged, so positions, anchors and the saved bytes are too.
 */
export class HardbreakView implements NodeView {
  dom: HTMLBRElement

  constructor(node: PMNode, view: EditorView) {
    this.dom = view.dom.ownerDocument.createElement('br')
    this.dom.dataset.type = 'hardbreak'
    this.dom.dataset.isInline = String(Boolean(node.attrs.isInline))
  }
}

// ------------------------------------------------------------------ images

/**
 * An image shows what its markdown points at. A relative `src` is a file beside the document, which the page can't
 * reach as written, so the <img> loads it through the server (`show` maps src → URL). View only: the node's `src` is
 * what the markdown says and what is saved, and a DOM re-read never sees this URL (a leaf node view isn't re-parsed).
 */
export class ImageView implements NodeView {
  dom: HTMLImageElement

  constructor(private node: PMNode, view: EditorView, private readonly show: (src: string) => string) {
    this.dom = view.dom.ownerDocument.createElement('img')
    this.sync(node)
  }

  private sync(n: PMNode): void {
    const src = String(n.attrs.src ?? '')
    this.dom.setAttribute('src', this.show(src))
    this.dom.setAttribute('alt', String(n.attrs.alt ?? ''))
    this.dom.setAttribute('title', String(n.attrs.title ?? ''))
  }

  update(n: PMNode): boolean {
    if (n.type !== this.node.type) return false
    this.node = n
    this.sync(n)
    return true
  }
}
