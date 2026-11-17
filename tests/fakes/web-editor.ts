// tests/fakes/web-editor.ts (integrator, day 0; CONTRACTS §2.4 item 6, §12.0.3, §12.0.4).
//
// The same export as P2's web/src/editor/index.ts (`createEditor`), over createFakeEditor. vite.config.ts aliases P2's
// module to this file under MDR_FAKE_EDITOR=1. With the test-hooks meta it also exposes window.__mdrFake.bridge (the
// FakeEditorBridge with its scripting helpers) and a minimal window.__mdrDebug (bridge, session, settled, blocks,
// liveMarkdown), so the shared editor-bridge contract can run in the fake-backed page as well as against P2's bridge.
import type { CreateEditor, EditorDebugHooks } from '../../shared/types'
import { createFakeEditor } from './FakeEditorBridge'

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

export const createEditor: CreateEditor = async (o) => {
  const handle = await createFakeEditor(o)
  const hooks = typeof document !== 'undefined' && document.querySelector('meta[name="mdr-test-hooks"][content="1"]') !== null
  if (hooks && typeof window !== 'undefined') {
    const w = window as unknown as { __mdrFake?: Record<string, unknown>; __mdrDebug?: EditorDebugHooks }
    w.__mdrFake = { ...(w.__mdrFake ?? {}), bridge: handle.bridge, session: o.session }
    w.__mdrDebug = {
      blocks: () => o.session.getSnapshot().blocks,
      ptext: () => ({ text: '', blockRanges: [] }),
      planSave: () => [],
      liveMarkdown: () => o.session.getSnapshot().markdown,
      settled: async () => {
        await frame()
        await frame()
      },
      bridge: () => handle.bridge,
      session: () => o.session,
      failSplice: () => undefined,
    }
  }
  return handle
}
