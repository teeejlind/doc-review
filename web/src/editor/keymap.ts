// web/src/editor/keymap.ts (P2). P2's editor keymap and the registration seam (CONTRACTS §11.5, D28).
//
// P2 replaces Milkdown's preset keymaps (commonmark + gfm are removed in createMd's `extend`) with exactly the rows of
// P2_KEYS. The base keymap (Enter splitBlock, Backspace joinBackward, arrows...) stays underneath as Milkdown adds it.
// Order of precedence for a keydown in the editor:
//   1. bindings registered through bridge.registerShortcut (P3's editor-scoped keys), most recent first;
//   2. P2_KEYS;
//   3. every plugin's handleKeyDown, then Milkdown's base keymap.
// Both 1 and 2 run from the EditorView's own `handleKeyDown` prop, which ProseMirror consults before any plugin.
import { keydownHandler } from '@milkdown/kit/prose/keymap'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { ShortcutBinding, Unsubscribe } from '../../../shared/types'
import { isAltGrChar } from '../platform'

/** §11.5 P2 rows, in prosemirror-keymap syntax (Mod = Cmd on macOS, Ctrl elsewhere). */
export const P2_KEYS = [
  { key: 'Mod-Alt-Shift-e', action: 'mode-editing' },
  { key: 'Mod-Alt-Shift-x', action: 'mode-suggesting' },
  { key: 'Mod-b', action: 'bold' },
  { key: 'Mod-i', action: 'italic' },
  { key: 'Mod-Shift-x', action: 'strike' },
  { key: 'Mod-e', action: 'code' },
  { key: 'Mod-u', action: 'underline' },
  { key: 'Mod-k', action: 'link' },
  { key: 'Mod-Alt-0', action: 'heading-0' },
  { key: 'Mod-Alt-1', action: 'heading-1' },
  { key: 'Mod-Alt-2', action: 'heading-2' },
  { key: 'Mod-Alt-3', action: 'heading-3' },
  { key: 'Mod-Shift-8', action: 'bullet' },
  { key: 'Mod-Shift-7', action: 'ordered' },
  { key: 'Mod-Shift-9', action: 'task' },
  { key: 'Mod-Shift-b', action: 'blockquote' },
  { key: 'Mod-Alt-c', action: 'code-block' },
  { key: 'Tab', action: 'indent' },
  { key: 'Shift-Tab', action: 'outdent' },
  { key: 'Mod-Enter', action: 'exit-code' },
  { key: 'Mod-Shift-v', action: 'paste-plain' },
  { key: 'Mod-z', action: 'undo' },
  { key: 'Mod-Shift-z', action: 'redo' },
  { key: 'Mod-y', action: 'redo' },
  { key: 'Enter', action: 'enter' },
  { key: 'Shift-Enter', action: 'hard-break' },
  { key: 'Backspace', action: 'backspace' },
  { key: 'Delete', action: 'delete' },
] as const

export type P2Action = (typeof P2_KEYS)[number]['action']

/**
 * The documented P3 registrations (§11.5) that may share a key with a P2 row: Mod-Enter is split by
 * `when: 'not-in-code'` (P3's Send outside code blocks, P2's exit-code-block inside).
 */
export const DOCUMENTED_SPLITS: ReadonlySet<string> = new Set(['Mod-Enter'])

export type ActionRunner = (action: P2Action, view: EditorView) => boolean

/**
 * 'Mod-Alt-Shift-x' → 'Mod-Alt-Shift-X'. With Ctrl and Alt both down on Windows (how AltGr arrives), prosemirror-keymap
 * skips its keyCode fallback, and Shift makes `event.key` the capital, so the lowercase name never matches there
 * (Pass 4 #35: the mode chords did nothing). Binding the capital too is the same key, named the way Windows sends it.
 */
function shiftedName(key: string): string | null {
  const m = /^((?:[A-Za-z]+-)+)([a-z])$/.exec(key)
  return m && /(?:^|-)Alt-/.test(m[1]!) && /(?:^|-)Shift-/.test(m[1]!) ? `${m[1]!}${m[2]!.toUpperCase()}` : null
}

export class KeyRouter {
  private readonly registered: ShortcutBinding[] = []
  private registeredHandler: ((view: EditorView, e: KeyboardEvent) => boolean) | null = null
  private readonly p2: (view: EditorView, e: KeyboardEvent) => boolean

  constructor(run: ActionRunner, private readonly inCode: (view: EditorView) => boolean) {
    const bindings: Record<string, (state: unknown, dispatch: unknown, view?: EditorView) => boolean> = {}
    for (const row of P2_KEYS) {
      const bind = (_s: unknown, _d: unknown, view?: EditorView): boolean => (view ? run(row.action, view) : false)
      bindings[row.key] = bind
      const shifted = shiftedName(row.key)
      if (shifted) bindings[shifted] = bind
    }
    this.p2 = keydownHandler(bindings as never)
  }

  /** §11.5 seam: highest precedence; returns the unregister function. */
  register(b: ShortcutBinding): Unsubscribe {
    this.registered.push(b)
    this.registeredHandler = null
    return () => {
      const i = this.registered.indexOf(b)
      if (i >= 0) this.registered.splice(i, 1)
      this.registeredHandler = null
    }
  }

  bindings(): readonly ShortcutBinding[] {
    return this.registered
  }

  private registeredKeys(): (view: EditorView, e: KeyboardEvent) => boolean {
    if (this.registeredHandler) return this.registeredHandler
    // most recent registration first; several bindings may share a key (their `when`s decide)
    const byKey = new Map<string, ShortcutBinding[]>()
    for (const b of [...this.registered].reverse()) {
      const list = byKey.get(b.key) ?? []
      list.push(b)
      byKey.set(b.key, list)
    }
    const map: Record<string, (s: unknown, d: unknown, view?: EditorView) => boolean> = {}
    for (const [key, list] of byKey) {
      map[key] = (_s, _d, view) => {
        for (const b of list) {
          if (b.when === 'not-in-code' && view && this.inCode(view)) continue
          try {
            if (b.run()) return true
          } catch (e) {
            console.error('[mdr editor] shortcut threw', e)
          }
        }
        return false
      }
    }
    this.registeredHandler = keydownHandler(map as never)
    return this.registeredHandler
  }

  /** P2's own rows only, not the registered ones: what a Mod chord does when it reaches the page with nothing focused. */
  handleOwn(view: EditorView, e: KeyboardEvent): boolean {
    if (isAltGrChar(e)) return false
    return this.p2(view, e)
  }

  handle(view: EditorView, e: KeyboardEvent): boolean {
    if (isAltGrChar(e)) return false
    if (this.registered.length && this.registeredKeys()(view, e)) return true
    return this.p2(view, e)
  }
}
