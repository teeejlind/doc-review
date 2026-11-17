// web/src/editor/atomGuard.ts (QA2). Keeps caret movement plus one key from destroying a block whose contents the collapsed
// view hides: the frontmatter panel and raw source blocks (promoted block HTML included). ProseMirror node-selects an atom
// on Backspace at the start of the next block, on ArrowUp / ArrowLeft into it, and as the initial selection of a document
// that starts with one; the next Backspace / Delete then removes it and the next printable key replaces it, silently.
//
// Rule: while one of these is node-selected, typed characters do nothing, and Backspace / Delete only act when the
// selection came from a click on the block itself (the node views dispatch it with ARM). Reaching it by moving the caret
// leaves it selected (the ring shows) and unharmed. Cmd+Z, cut and paste are deliberate chords and are left alone.
import { NodeSelection, Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

const GUARDED: ReadonlySet<string> = new Set(['frontmatter', 'raw_block'])

/** Transaction meta (value ARM): this selection is a click on the block, so Backspace / Delete may remove it. */
export const atomGuardKey = new PluginKey<boolean>('mdr-atom-guard')
export const ARM = 'arm'

function guardedSelected(state: EditorState): boolean {
  const sel = state.selection
  return sel instanceof NodeSelection && GUARDED.has(sel.node.type.name)
}

/** true = swallow this keydown. */
export function guardKeyDown(view: EditorView, e: KeyboardEvent): boolean {
  if (!guardedSelected(view.state)) return false
  if (e.key === 'Backspace' || e.key === 'Delete') return atomGuardKey.getState(view.state) !== true
  // a typed character would replace the selected node
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey
}

export function atomGuardPlugin(): Plugin<boolean> {
  return new Plugin<boolean>({
    key: atomGuardKey,
    state: {
      init: () => false,
      apply: (tr, armed, _old, state) => {
        if (!guardedSelected(state)) return false
        if (tr.getMeta(atomGuardKey) === ARM) return true
        return tr.selectionSet ? false : armed
      },
    },
    props: {
      // text that reaches ProseMirror without a keydown (an IME, a dictation) replaces the node the same way
      handleTextInput: (view) => guardedSelected(view.state),
    },
  })
}
