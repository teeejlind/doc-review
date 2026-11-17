// tests/unit/web/editor/helpers.ts (P2). Mount the real editor (createEditor) on a real session over MockTransport and
// fakeApp, in vitest's jsdom (CONTRACTS §12.0.3). jsdom has no layout, so rect assertions live in the p2-rects e2e;
// these tests drive the editor through transactions (user transactions go through the editor's own dispatch pipeline).
import { TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { EditorBridge, EditorHandle, EditorNotice, SuggestionId } from '../../../../shared/types'
import { createEditor } from '../../../../web/src/editor/index'
import { editorOfBridge } from '../../../../web/src/editor/bridge'
import type { MdrEditor } from '../../../../web/src/editor/editor'
import type { MdrDocSession } from '../../../../web/src/session/session'
import type { SessionInternals } from '../../../../web/src/session/internals'
import type { SessionEnv } from '../../../../web/src/session/env'
import type { MockTransport } from '../../../fakes/MockTransport'
import { fixture, type Fixture } from '../session/helpers'

export { until, tick } from '../session/helpers'

// jsdom has no layout: ProseMirror's scroll-into-view and our rect helpers ask Ranges for client rects
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  const empty = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = empty
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
}

export interface Mounted {
  fx: Fixture
  session: MdrDocSession
  internals: SessionInternals
  transport: MockTransport
  handle: EditorHandle
  bridge: EditorBridge
  ed: MdrEditor
  view: EditorView
  host: HTMLElement
  toolbarHost: HTMLElement
  scroll: HTMLElement
  notices: EditorNotice[]
  close(): Promise<void>
}

/**
 * `mode`: the app opens every doc in Suggesting (TJ, 2026-11-16); most of these tests were written against Editing,
 * so mount switches to Editing explicitly unless told otherwise ('as-loaded' keeps the mode the editor opened in).
 */
export async function mount(o: { file?: string; markdown: string; claude?: Array<Record<string, unknown>>; env?: Partial<SessionEnv>; fx?: Fixture; mode?: 'editing' | 'suggesting' | 'as-loaded' }): Promise<Mounted> {
  const file = o.file ?? 'doc.md'
  const fx = o.fx ?? (await fixture({ file, markdown: o.markdown }))
  if (o.claude?.length) await fx.agent(o.claude as never)
  const { session, internals, transport } = await fx.open(o.env ? { env: o.env } : {})
  const app = document.createElement('div')
  app.id = 'mdr-app'
  const toolbarHost = document.createElement('div')
  toolbarHost.id = 'mdr-toolbar-host'
  const scroll = document.createElement('div')
  scroll.id = 'mdr-scroll'
  const host = document.createElement('div')
  host.id = 'mdr-editor-host'
  scroll.appendChild(host)
  app.append(toolbarHost, scroll)
  document.body.appendChild(app)
  const handle = await createEditor({ host, toolbarHost, scrollContainer: scroll, session })
  const ed = editorOfBridge.get(handle.bridge)!
  if ((o.mode ?? 'editing') !== 'as-loaded') handle.bridge.setMode(o.mode === 'suggesting' ? 'suggesting' : 'editing')
  const notices: EditorNotice[] = []
  handle.bridge.onNotice((n) => notices.push(n))
  return {
    fx, session, internals, transport, handle, bridge: handle.bridge, ed, view: ed.view, host, toolbarHost, scroll, notices,
    async close() {
      handle.destroy()
      app.remove()
      await fx.close()
    },
  }
}

/** Position of the nth occurrence of `text` in the live doc. */
export function find(view: EditorView, text: string, nth = 0): { from: number; to: number } {
  let hit: { from: number; to: number } | null = null
  let k = 0
  view.state.doc.descendants((node, pos) => {
    if (hit) return false
    if (!node.isText) return true
    let i = node.text!.indexOf(text)
    while (i >= 0) {
      if (k === nth) {
        hit = { from: pos + i, to: pos + i + text.length }
        return false
      }
      k++
      i = node.text!.indexOf(text, i + 1)
    }
    return true
  })
  if (!hit) throw new Error(`text not found: ${text}`)
  return hit
}

/** A user transaction (typing) through the editor's dispatch pipeline. */
export function userTr(view: EditorView, build: (tr: Transaction) => Transaction): void {
  view.dispatch(build(view.state.tr))
}

export function typeAt(view: EditorView, pos: number, text: string): void {
  userTr(view, (tr) => tr.setSelection(TextSelection.create(tr.doc, pos)).insertText(text, pos))
}

export function replace(view: EditorView, text: string, by: string, nth = 0): void {
  const r = find(view, text, nth)
  userTr(view, (tr) => tr.insertText(by, r.from, r.to))
}

export function select(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
}

export function marksOf(view: EditorView): Array<{ kind: string; id: SuggestionId; text: string }> {
  const out: Array<{ kind: string; id: SuggestionId; text: string }> = []
  view.state.doc.descendants((n) => {
    for (const m of n.marks) {
      if (['insertion', 'deletion', 'modification'].includes(m.type.name)) {
        out.push({ kind: m.type.name, id: String(m.attrs.id) as SuggestionId, text: n.isText ? n.text! : `<${n.type.name}>` })
      }
    }
    return true
  })
  return out
}

/** Type like the browser: each character goes through handleTextInput (input rules), else a plain insert. */
export function typeKeys(view: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection
    const deflt = (): Transaction => view.state.tr.insertText(ch, from, to)
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt))
    if (!handled) view.dispatch(deflt())
  }
}

/** Put the caret right after the nth occurrence of `text` (or at its start with `at: 'start'`). */
export function caret(view: EditorView, text: string, o: { at?: 'start' | 'end'; nth?: number } = {}): void {
  const r = find(view, text, o.nth ?? 0)
  const pos = o.at === 'start' ? r.from : r.to
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

/** Put the caret at the end of the textblock at doc position `pos`'s block (the last block when omitted). */
export function caretAtDocEnd(view: EditorView): void {
  const end = TextSelection.atEnd(view.state.doc)
  view.dispatch(view.state.tr.setSelection(end))
}

/** Run a P2 keymap action (enter, backspace, indent, ...) the way the key would. */
export function key(m: Mounted, action: Parameters<Mounted['ed']['runAction']>[0]): boolean {
  return m.ed.runAction(action, m.view)
}

/** Flush and read the saved file. */
export async function saved(m: Mounted, file = 'doc.md'): Promise<string> {
  await m.session.flush()
  return m.fx.root.read(file)
}

/**
 * Press a key through the view's whole handleKeyDown chain (P3 registrations, P2's keymap, then every plugin and
 * Milkdown's base keymap), as a real keydown would. `mod` is Ctrl here (jsdom is not a Mac).
 */
export function press(m: Mounted, keyName: string, mods: { shift?: boolean; mod?: boolean; alt?: boolean } = {}): boolean {
  const ev = new KeyboardEvent('keydown', {
    key: keyName, shiftKey: !!mods.shift, ctrlKey: !!mods.mod, altKey: !!mods.alt, bubbles: true, cancelable: true,
  })
  return m.view.someProp('handleKeyDown', (f) => f(m.view, ev)) ?? false
}

/**
 * WCAG 2.5.3 (label in name), the way axe's label-content-name-mismatch reads it: the text the element shows (aria-hidden
 * text included: axe counts what is on screen; whitespace collapsed, punctuation dropped) has to be part of its accessible
 * name (aria-label, else its own text). Returns null when it holds, else what is wrong.
 */
export function labelInNameProblem(el: HTMLElement): string | null {
  const clean = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const visible = clean((el.textContent ?? '').replace(/\s+/g, ' '))
  if (!visible) return null
  const name = clean(el.getAttribute('aria-label') ?? el.textContent ?? '')
  return name.includes(visible) ? null : `visible "${visible}" is not in the name "${name}"`
}
