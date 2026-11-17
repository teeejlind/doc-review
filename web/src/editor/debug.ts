// web/src/editor/debug.ts (P2). window.__mdrDebug, defined only with <meta name="mdr-test-hooks" content="1">
// (CONTRACTS §12.0.4, D51). p2-* specs drive what a P3 control would do through bridge() / session().
import { setSpliceFaultForTests } from '../../../core/splice/apply'
import { planSave } from '../../../core/splice/plan'
import { ptextOf } from '../../../core/ptext'
import type { BlockHash, DocSession, EditorBridge, EditorDebugHooks } from '../../../shared/types'
import type { MdrEditor } from './editor'


export function installDebugHooks(ed: MdrEditor, bridge: EditorBridge, session: DocSession): () => void {
  const w = globalThis as unknown as { __mdrDebug?: EditorDebugHooks }
  const hooks: EditorDebugHooks = {
    blocks: () => ed.internals.getLoaded()?.blocks ?? [],
    ptext: () => {
      const L = ed.internals.getLoaded()
      if (!L) return { text: '', blockRanges: [] }
      const p = ptextOf(ed.baseDoc(), L)
      return { text: p.text, blockRanges: p.blockRanges }
    },
    planSave: () => {
      const L = ed.internals.getLoaded()
      return L ? planSave(ed.md, L, ed.baseDoc()) : []
    },
    liveMarkdown: () => ed.liveMarkdown(),
    settled: () => ed.settled(),
    bridge: () => bridge,
    session: () => session,
    failSplice: (hashes: readonly BlockHash[]) => {
      const set = new Set(hashes)
      setSpliceFaultForTests(set.size ? (op) => op.covers.some((h) => set.has(h)) : null)
    },
  }
  w.__mdrDebug = hooks
  // P2's own page hook for the editor-bridge contract (tests/contract/editor-bridge.contract.ts step 5)
  const t = globalThis as unknown as { __mdrEditorTest?: { insertBlockAbove(id: string, px: number): boolean } }
  const test = { insertBlockAbove: (id: string, px: number) => ed.insertBlockAbove(id, px) }
  t.__mdrEditorTest = test
  return () => {
    if (w.__mdrDebug === hooks) delete w.__mdrDebug
    if (t.__mdrEditorTest === test) delete t.__mdrEditorTest
    setSpliceFaultForTests(null)
  }
}
