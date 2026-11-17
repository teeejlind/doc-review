// web/src/editor/journal.ts (P2). The decision journal (CONTRACTS §6.6, D26).
//
// One entry per decide transaction ({ ids, decision, bulk? }; a single decision has one id), mirroring PM history's
// undo and redo stacks through the history$ meta:
//  - a decide transaction is its own history event (closeHistory on it and on the next history-bearing transaction),
//    so `depth` = undoDepth right after it identifies its event;
//  - undo of that event moves the entry to `undone` (its ids become reopen candidates until the review shows them
//    pending again); redo moves it back;
//  - an entry stays in `undone` for reopen even after new typing clears the redo stack (it is then not redoable).
import { redoDepth, undoDepth } from '@milkdown/kit/prose/history'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { OpKey, SuggestionId } from '../../../shared/types'
import { mdrMeta } from '../../../core/suggest/guards'

export interface JournalEntry {
  ids: SuggestionId[]
  decision: 'accept' | 'reject'
  bulk?: OpKey
  /** undoDepth right after the decide transaction (its history event's index). */
  depth: number
  /** Index in the redo stack while undone and redoable; null once new history cleared it. */
  redoIndex: number | null
}

export class DecisionJournal {
  done: JournalEntry[] = []
  undone: JournalEntry[] = []
  /** The last history-bearing transaction was a decide: the next one must start a new history event. */
  lastWasDecide = false

  /** Observe every transaction applied to the view (the root and appended ones), after the state updated. */
  observe(trs: readonly Transaction[], newState: EditorState): void {
    for (const tr of trs) {
      const hist = tr.getMeta('history$') as { redo?: boolean } | undefined
      const meta = mdrMeta(tr)
      if (hist) {
        this.lastWasDecide = false
        if (hist.redo) {
          // the redone event sits at the new undo depth
          const d = undoDepth(newState)
          const k = this.undone.findIndex((e) => e.redoIndex !== null && e.redoIndex === redoDepth(newState) + 1)
          if (k >= 0) {
            const e = this.undone.splice(k, 1)[0]!
            this.done.push({ ...e, depth: d, redoIndex: null })
          }
        } else {
          // the undone event was at undoDepth + 1
          const d = undoDepth(newState) + 1
          const k = this.done.findIndex((e) => e.depth === d)
          if (k >= 0) {
            const e = this.done.splice(k, 1)[0]!
            this.undone.push({ ...e, redoIndex: redoDepth(newState) })
          }
        }
        continue
      }
      if (meta?.origin === 'decide' && tr.getMeta('addToHistory') !== false && meta.ids?.length && meta.decision) {
        this.done.push({
          ids: [...meta.ids], decision: meta.decision, ...(meta.bulk ? { bulk: meta.bulk as OpKey } : {}),
          depth: undoDepth(newState), redoIndex: null,
        })
        this.lastWasDecide = true
        continue
      }
      if (tr.docChanged && tr.getMeta('addToHistory') !== false) {
        this.lastWasDecide = false
        // new history clears the redo stack: undone entries stay (reopen) but are no longer redoable
        const rd = redoDepth(newState)
        for (const e of this.undone) if (e.redoIndex !== null && e.redoIndex > rd) e.redoIndex = null
        const ud = undoDepth(newState)
        this.done = this.done.filter((e) => e.depth <= ud)
      }
    }
  }

  /** The undone entry whose event is on top of the redo stack, if any. */
  redoTop(state: EditorState): JournalEntry | null {
    const rd = redoDepth(state)
    if (rd === 0) return null
    return this.undone.find((e) => e.redoIndex === rd) ?? null
  }

  isUndone(id: SuggestionId): boolean {
    return this.undone.some((e) => e.ids.includes(id))
  }

  entryOf(id: SuggestionId): JournalEntry | null {
    return this.undone.find((e) => e.ids.includes(id)) ?? null
  }

  /** Drop an undone entry (its reopen was refused and re-applied, or it was replayed through the server). */
  drop(e: JournalEntry): void {
    this.undone = this.undone.filter((x) => x !== e)
  }

  /** Forget undone entries whose ids are all pending again and that can't be redone. */
  prune(isPendingAgain: (id: SuggestionId) => boolean): void {
    this.undone = this.undone.filter((e) => e.redoIndex !== null || !e.ids.every(isPendingAgain))
  }
}
