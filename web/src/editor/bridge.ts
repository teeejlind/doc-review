// web/src/editor/bridge.ts (P2). The EditorBridge P3 consumes (CONTRACTS §12.1, types.ts). No ProseMirror type crosses
// it: rects are content coordinates, ids are strings, and every decision goes through the session's write queue.
import type {
  AnchorRect, Author, BlockConflict, BulkDecisionResult, EditorBridge, EditorNotice, ErrorCode, Mode, SelectionTarget,
  ShortcutBinding, SuggestionId, SuggestionSummary, ThreadId, Unsubscribe,
} from '../../../shared/types'
import type { LayoutReason, MdrEditor } from './editor'

/** P2-private test seam: the editor behind a bridge (unit tests reach the view through it; P3 never does). */
export const editorOfBridge = new WeakMap<EditorBridge, MdrEditor>()

function sub<T>(set: Set<T>, cb: T): Unsubscribe {
  set.add(cb)
  return () => void set.delete(cb)
}

export function createBridge(ed: MdrEditor): EditorBridge {
  // a second accept/reject of the same id while the first is in flight shares its result (double-click applies once)
  const inflight = new Map<string, Promise<{ ok: boolean; noop?: true; code?: ErrorCode }>>()
  const decide = (id: SuggestionId, d: 'accept' | 'reject'): Promise<{ ok: boolean; noop?: true; code?: ErrorCode }> => {
    const key = `${d}:${id}`
    const hit = inflight.get(key)
    if (hit) return hit
    const p = ed.internals.decide(id, d).catch((e: unknown) => {
      const code = (typeof e === 'object' && e !== null && 'code' in e ? (e as { code: ErrorCode }).code : 'INTERNAL') as ErrorCode
      ed.notice({ kind: 'error', code: 'DECISION_FAILED', text: "Couldn't apply that decision. Try again." })
      return { ok: false, code }
    }).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }
  const bulk = (decision: 'accept' | 'reject', sel?: { by?: Author; ids?: readonly SuggestionId[] }): Promise<BulkDecisionResult | null> =>
    ed.internals.bulk({ decision, ...(sel?.by ? { by: sel.by } : {}), ...(sel?.ids ? { ids: sel.ids } : {}) }).then(
      (r) => {
        // Many changes landed at once and the cards that carried them are gone: say how many, and offer Undo (QA3 rail-ui 16)
        const n = r?.results.filter((x) => x.ok && x.duplicate !== true).length ?? 0
        if (n > 0) {
          ed.notice({
            kind: 'info',
            code: 'DECISIONS_APPLIED',
            text: `${decision === 'accept' ? 'Accepted' : 'Rejected'} ${n} ${n === 1 ? 'change' : 'changes'}.`,
            action: { label: 'Undo', run: () => void ed.runAction('undo', ed.view) },
          })
        }
        return r
      },
      (e: unknown) => {
        ed.notice({ kind: 'error', code: 'DECISION_FAILED', text: "Couldn't apply those decisions. Try again." })
        throw e
      },
    )

  const bridge: EditorBridge = {
    getMode: (): Mode => ed.mode,
    setMode: (m: Mode) => ed.setMode(m),
    onModeChange: (cb) => sub(ed.subs.mode, cb),
    getAnchorRects(ids: readonly string[]): Map<string, AnchorRect | null> {
      const out = new Map<string, AnchorRect | null>()
      for (const id of ids) out.set(id, ed.rectOf(id))
      return out
    },
    onLayoutInvalidated: (cb: (reason: LayoutReason) => void) => sub(ed.subs.layout, cb),
    getSelectionTarget: (o?: { collapsed?: 'none' | 'word' }): SelectionTarget => ed.selectionTarget(o),
    onSelectionChange: (cb) => sub(ed.subs.selection, cb),
    setVisibleThreads: (ids: readonly ThreadId[]) => ed.setVisibleThreads(ids),
    setActiveThread: (id: string | null) => ed.setActiveThread(id),
    setDraftHighlight: (on: boolean) => ed.setDraftHighlight(on),
    onHighlightClick: (cb) => sub(ed.subs.highlight, cb),
    scrollToThread: (id: string, opts?: { align: 'top30' | 'nearest' }) => ed.scrollToThread(id, opts?.align ?? 'top30'),
    accept: (id) => decide(id, 'accept'),
    reject: (id) => decide(id, 'reject'),
    acceptAll: (sel) => bulk('accept', sel),
    rejectAll: (sel) => bulk('reject', sel),
    getSuggestionSummaries: (): Map<SuggestionId, SuggestionSummary> => ed.summaries(),
    resolveConflict: (id: BlockConflict['id'], choice: 'mine' | 'theirs') => ed.internals.resolveConflict(id, choice),
    focusEditor: (o) => ed.refocus(o),
    onNotice: (cb: (n: EditorNotice) => void) => sub(ed.subs.notice, cb),
    registerShortcut: (b: ShortcutBinding) => ed.keys.register(b),
    onTypingActivity: (cb) => sub(ed.subs.typing, cb),
  }
  editorOfBridge.set(bridge, ed)
  return bridge
}
