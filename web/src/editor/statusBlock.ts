// web/src/editor/statusBlock.ts (P2). The body status header chip (CONTRACTS §12.12 B, R1.8, D30).
//
// The status block stays an ordinary paragraph (no schema change, no node view, no ptext change). This plugin only
// decorates it:
// - collapsed (default): a node decoration hides the block (.mdr-status-block.is-collapsed) and a widget renders the
//   chip (data-testid="mdr-status-chip", data-expanded="false"): a "Status" label, one read-only pill per phrase,
//   the other fields as quiet meta text, and an Edit affordance;
// - expanded: the block is normal rich text; a small label widget (data-expanded="true") marks it;
// - it is expanded while the selection is in it (a chip click, or an arrow key moving the caret in, puts it there)
//   and collapses again when the selection leaves; a block holding suggestion marks or an open thread's highlight
//   always renders expanded, so tracked changes and highlights are never hidden;
// - while collapsed the block is read-only: filterTransaction refuses user steps touching it (programmatic origins
//   and undo/redo exempt);
// - the chip re-derives (detectStatusHeaderInDoc) on every doc change, so Claude rewriting the status line on disk
//   updates it after the reload. Expanding and collapsing are selection-only transactions (no steps), so planSave
//   never sees them.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from '@milkdown/kit/prose/transform'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { TESTID } from '../../../shared/constants'
import { detectStatusHeaderInDoc, type LiveStatusHeader } from '../../../core/status-header'
import { isProgrammaticTr, kindOf } from '../../../core/suggest/guards'
import { highlightKey, isCollapsed as placeCollapsed } from './highlights'

export interface StatusState {
  live: LiveStatusHeader | null
}

export const statusKey = new PluginKey<StatusState>('mdr-status-block')

function hasSuggestionMarks(node: PMNode): boolean {
  let hit = node.marks.some((m) => kindOf(m) !== null)
  node.descendants((n) => {
    if (hit) return false
    if (n.marks.some((m) => kindOf(m) !== null)) hit = true
    return !hit
  })
  return hit
}

/** An open, shown comment highlight inside [from, to). */
function openHighlightIn(state: EditorState, from: number, to: number): boolean {
  const hs = highlightKey.getState(state)
  if (!hs) return false
  for (const [id, p] of hs.places) {
    if (placeCollapsed(p)) continue
    if (hs.resolved.has(id)) continue
    if (hs.visible && !hs.visible.has(id)) continue
    const a = p.kind === 'text' ? p.from : p.pos
    const b = p.kind === 'text' ? p.to : p.pos + 1
    if (a < to && b > from) return true
  }
  return false
}

export function blockRange(live: LiveStatusHeader): { from: number; to: number } {
  return { from: live.pos, to: live.pos + live.node.nodeSize }
}

/** Collapsed = no selection in the block, no suggestion marks in it, no open highlight in it. */
export function statusCollapsed(state: EditorState): boolean {
  const live = statusKey.getState(state)?.live
  if (!live) return false
  const { from, to } = blockRange(live)
  const sel = state.selection
  if (sel.from < to && sel.to > from) return false
  if (hasSuggestionMarks(live.node)) return false
  if (openHighlightIn(state, from, to)) return false
  return true
}

/** The doc range a step changes (in the doc it applies to). */
function stepRange(step: unknown, doc: PMNode): { from: number; to: number } | null {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep || step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    const s = step as unknown as { from: number; to: number }
    return { from: s.from, to: s.to }
  }
  if (step instanceof AttrStep) {
    const pos = (step as unknown as { pos: number }).pos
    return { from: pos, to: pos + (doc.nodeAt(pos)?.nodeSize ?? 1) }
  }
  return null
}

function touchesBlock(tr: Transaction, from: number, to: number): boolean {
  for (let i = 0; i < tr.steps.length; i++) {
    const r = stepRange(tr.steps[i], tr.docs[i]!)
    if (!r) continue
    const m = tr.mapping.slice(0, i)
    const a = m.map(from, 1)
    const b = m.map(to, -1)
    // strictly overlapping: an insert at the block's outer edge (a new paragraph after it) is allowed
    if (r.from < b && r.to > a) return true
    if (r.from === r.to && r.from > a && r.from < b) return true
  }
  return false
}

function chip(view: EditorView, live: LiveStatusHeader, collapsed: boolean): HTMLElement {
  const doc = view.dom.ownerDocument
  const el = doc.createElement('div')
  el.className = `mdr-status-chip${collapsed ? '' : ' is-expanded'}`
  el.dataset.testid = TESTID.statusChip
  el.dataset.expanded = String(!collapsed)
  el.setAttribute('contenteditable', 'false')
  const label = doc.createElement('span')
  label.className = 'mdr-status-chip__label'
  label.textContent = 'Status'
  el.appendChild(label)
  if (!collapsed) return el
  el.setAttribute('role', 'button')
  el.tabIndex = 0
  // the accessible name carries every word the chip shows, in order (WCAG 2.5.3, label in name), then the hint
  const shown: string[] = ['Status']
  for (const p of live.info.phrases) {
    const pill = doc.createElement('span')
    pill.className = 'mdr-status-chip__pill'
    pill.textContent = p
    el.append(doc.createTextNode(' '), pill)
    shown.push(p)
  }
  const meta = live.info.fields.filter((f) => !/^status$/i.test(f.label) && f.value)
  if (meta.length) {
    const m = doc.createElement('span')
    m.className = 'mdr-status-chip__meta'
    m.textContent = meta.map((f) => `${f.label}: ${f.value}`).join(' · ')
    el.append(doc.createTextNode(' '), m)
    shown.push(m.textContent)
  }
  el.setAttribute('aria-label', `${shown.join(' ')}. Press Enter to edit.`)
  // the "Edit" hint is drawn by CSS (its ::after): text in the DOM would be visible text the name has to carry
  const edit = doc.createElement('span')
  edit.className = 'mdr-status-chip__edit'
  edit.setAttribute('aria-hidden', 'true')
  el.appendChild(edit)
  const expand = (e: Event): void => {
    e.preventDefault()
    expandStatus(view)
  }
  el.addEventListener('mousedown', (e) => e.preventDefault())
  el.addEventListener('click', expand)
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') expand(e)
  })
  return el
}

/** Put the caret at the start of the status paragraph (a selection-only transaction) and focus the editor. */
export function expandStatus(view: EditorView, at: 'start' | 'end' = 'start'): boolean {
  const live = statusKey.getState(view.state)?.live
  if (!live) return false
  const para = view.state.doc.nodeAt(live.paraPos)
  if (!para) return false
  const pos = at === 'start' ? live.paraPos + 1 : live.paraPos + para.nodeSize - 1
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).scrollIntoView())
  view.focus()
  return true
}

const ARROWS: Readonly<Record<string, { dir: 1 | -1; probe: 'up' | 'down' | 'left' | 'right' }>> = {
  ArrowDown: { dir: 1, probe: 'down' },
  ArrowRight: { dir: 1, probe: 'right' },
  ArrowUp: { dir: -1, probe: 'up' },
  ArrowLeft: { dir: -1, probe: 'left' },
}

export function statusBlockPlugin(): Plugin<StatusState> {
  return new Plugin<StatusState>({
    key: statusKey,
    state: {
      init: (_c, s) => ({ live: detectStatusHeaderInDoc(s.doc) }),
      apply: (tr, prev) => (tr.docChanged ? { live: detectStatusHeaderInDoc(tr.doc) } : prev),
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged || isProgrammaticTr(tr)) return true
      const live = statusKey.getState(state)?.live
      if (!live || !statusCollapsed(state)) return true
      const { from, to } = blockRange(live)
      return !touchesBlock(tr, from, to)
    },
    props: {
      decorations(state) {
        const live = statusKey.getState(state)?.live
        if (!live) return null
        const collapsed = statusCollapsed(state)
        const { from, to } = blockRange(live)
        const key = `mdr-status:${collapsed ? 'c' : 'e'}:${JSON.stringify(live.info)}`
        const decos = [
          Decoration.widget(from, (view) => chip(view, live, collapsed), { side: -1, key, ignoreSelection: true, stopEvent: () => true }),
          Decoration.node(from, to, { class: `mdr-status-block${collapsed ? ' is-collapsed' : ''}` }),
        ]
        return DecorationSet.create(state.doc, decos)
      },
      handleKeyDown(view, e) {
        const a = ARROWS[e.key]
        if (!a || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false
        const state = view.state
        const live = statusKey.getState(state)?.live
        if (!live || !statusCollapsed(state) || !state.selection.empty) return false
        const $h = state.selection.$head
        if (!$h.parent.isTextblock || !view.endOfTextblock(a.probe)) return false
        const edge = a.dir > 0 ? $h.after($h.depth) : $h.before($h.depth)
        if (edge < 0 || edge > state.doc.content.size) return false
        const next = Selection.findFrom(state.doc.resolve(edge), a.dir, true)
        if (!next) return false
        const { from, to } = blockRange(live)
        if (next.from <= from || next.from >= to) return false
        return expandStatus(view, a.dir > 0 ? 'start' : 'end')
      },
    },
  })
}
