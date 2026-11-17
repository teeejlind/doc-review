// tests/unit/web/editor/keymap.test.ts (P2; CONTRACTS §11.5). P2's key table has no duplicate and no collision with
// P3's documented editor-scoped keys other than the Cmd+Enter split; the registration seam outranks P2's keymap;
// `when: 'not-in-code'` hands Mod-Enter to exit-code-block inside a code block; the mode keys switch modes.
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { normalizeKey } from './keys'
import { DOCUMENTED_SPLITS, P2_KEYS } from '../../../../web/src/editor/keymap'
import { find, mount, type Mounted } from './helpers'

/** §11.5 P3 rows registered through the seam (Send, Comment, next/prev, accept/reject). */
const P3_EDITOR_KEYS = ['Mod-Enter', 'Mod-Shift-Enter', 'Mod-Alt-m', 'Mod-Alt-]', 'Mod-Alt-[', 'Mod-Alt-a', 'Mod-Alt-r']

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

/** A keydown as the browser sends it (jsdom: not macOS, so Mod is Ctrl). */
function key(mm: Mounted, k: string, o: { ctrl?: boolean; alt?: boolean; shift?: boolean; code?: number } = {}): boolean {
  const e = new KeyboardEvent('keydown', { key: k, ctrlKey: !!o.ctrl, altKey: !!o.alt, shiftKey: !!o.shift, bubbles: true, cancelable: true, ...(o.code ? { keyCode: o.code } : {}) })
  return mm.view.someProp('handleKeyDown', (f) => f(mm.view, e)) ?? false
}

describe('§11.5 key table', () => {
  it('has no duplicate key, and collides with P3 only on the documented Mod-Enter split', () => {
    const keys = P2_KEYS.map((r) => normalizeKey(r.key))
    expect(new Set(keys).size).toBe(keys.length)
    const p3 = new Set(P3_EDITOR_KEYS.map(normalizeKey))
    const shared = keys.filter((k) => p3.has(k))
    expect(shared).toEqual([...DOCUMENTED_SPLITS].map(normalizeKey))
  })

  it('carries every §11.5 P2 row', () => {
    const actions = new Set(P2_KEYS.map((r) => r.action))
    for (const a of ['mode-editing', 'mode-suggesting', 'bold', 'italic', 'strike', 'code', 'link', 'heading-0', 'heading-1', 'heading-2', 'heading-3',
      'bullet', 'ordered', 'task', 'blockquote', 'code-block', 'indent', 'outdent', 'exit-code', 'paste-plain', 'undo', 'redo']) {
      expect(actions.has(a as never)).toBe(true)
    }
  })
})

describe('Cmd+U (QA round 1, TJ hands-on)', () => {
  it('is claimed (the browser would underline nothing) and says why with a notice; the text is untouched', async () => {
    m = await mount({ markdown: 'Hello world.\n' })
    const r = find(m.view, 'world')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.from, r.to)))
    const before = m.view.state.doc
    expect(key(m, 'u', { ctrl: true })).toBe(true)
    expect(m.view.state.doc.eq(before)).toBe(true)
    expect(m.notices.map((n) => n.code)).toContain('UNDERLINE_UNSUPPORTED')
  })
})

describe('the registration seam (§11.5, D28)', () => {
  it('a registered binding outranks P2 (Mod-b) and unregisters cleanly', async () => {
    m = await mount({ markdown: 'Hello world.\n' })
    const r = find(m.view, 'world')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.from, r.to)))
    let calls = 0
    const off = m.bridge.registerShortcut({ key: 'Mod-b', run: () => (calls++, true) })
    expect(key(m, 'b', { ctrl: true })).toBe(true)
    expect(calls).toBe(1)
    expect(m.view.state.doc.rangeHasMark(r.from, r.to, m.view.state.schema.marks.strong!)).toBe(false)
    off()
    expect(key(m, 'b', { ctrl: true })).toBe(true)
    expect(calls).toBe(1)
    expect(m.view.state.doc.rangeHasMark(r.from, r.to, m.view.state.schema.marks.strong!)).toBe(true)
  })

  it("when: 'not-in-code' gives Mod-Enter to P3 outside code blocks and to exit-code-block inside", async () => {
    m = await mount({ markdown: 'Para.\n\n```js\nx\n```\n' })
    let sends = 0
    m.bridge.registerShortcut({ key: 'Mod-Enter', when: 'not-in-code', run: () => (sends++, true) })
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, find(m.view, 'Para').from + 1)))
    expect(key(m, 'Enter', { ctrl: true })).toBe(true)
    expect(sends).toBe(1)
    const x = find(m.view, 'x').to
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, x)))
    const blocks = m.view.state.doc.childCount
    expect(key(m, 'Enter', { ctrl: true })).toBe(true)
    expect(sends).toBe(1)
    expect(m.view.state.doc.childCount).toBe(blocks + 1)
    expect(m.view.state.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('the mode keys switch modes (Mod-Alt-Shift-X / Mod-Alt-Shift-E)', async () => {
    m = await mount({ markdown: 'Hello.\n' })
    const modes: string[] = []
    m.bridge.onModeChange((x) => modes.push(x))
    expect(key(m, 'X', { ctrl: true, alt: true, shift: true, code: 88 })).toBe(true)
    expect(m.bridge.getMode()).toBe('suggesting')
    expect(key(m, 'E', { ctrl: true, alt: true, shift: true, code: 69 })).toBe(true)
    expect(m.bridge.getMode()).toBe('editing')
    expect(modes).toEqual(['suggesting', 'editing'])
  })
})

describe('AltGr characters are typed, not taken as chords (final pass 2026-11-16)', () => {
  /** AltGr on Windows: Ctrl and Alt both set, plus the AltGraph modifier. */
  function altGr(mm: Mounted, k: string): boolean {
    const e = new KeyboardEvent('keydown', { key: k, ctrlKey: true, altKey: true, bubbles: true, cancelable: true })
    Object.defineProperty(e, 'getModifierState', { value: (m: string) => m === 'AltGraph' || m === 'Control' || m === 'Alt' })
    return mm.view.someProp('handleKeyDown', (f) => f(mm.view, e)) ?? false
  }
  it("'[' and ']' typed with AltGr (German AltGr+8/9, Spanish AltGr+`) don't run the previous / next comment chords", async () => {
    m = await mount({ markdown: 'Hello.\n' })
    let ran = 0
    m.bridge.registerShortcut({ key: 'Mod-Alt-[', run: () => (ran++, true) })
    m.bridge.registerShortcut({ key: 'Mod-Alt-]', run: () => (ran++, true) })
    expect(altGr(m, '[')).toBe(false)
    expect(altGr(m, ']')).toBe(false)
    expect(ran).toBe(0)
    // the same chord from real Ctrl+Alt (no AltGraph) still runs
    expect(key(m, '[', { ctrl: true, alt: true })).toBe(true)
    expect(ran).toBe(1)
  })
})
