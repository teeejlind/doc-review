// web/src/editor/index.ts (P2): the editor entry module (CONTRACTS §12.0.3). P3's App.tsx imports exactly
// `createEditor` from here (§2.3); everything else under web/src/editor is P2-private.
//
// createEditor({ host, toolbarHost, scrollContainer, session }):
//   1. finds the session's P2-private internals (TypeError for any object openDocSession didn't make);
//   2. boots Milkdown in `host` through createMd({ root, extend, expectFingerprint: boot.schemaFingerprint });
//   3. renders the toolbar and mode pill into `toolbarHost`;
//   4. attaches to the session (which loads its base with the editor's Md, installs it, checks parity and restores a
//      draft), hydrates suggestions and places comment highlights;
//   5. marks `mdr:editor-ready` (§11.7) and, with the test-hooks meta, defines window.__mdrDebug (§12.0.4).
// EditorHandle.destroy() destroys the view and every listener and empties both hosts; it does not flush
// (session.close() does).
import type { CreateEditor, EditorHandle } from '../../../shared/types'
import { internalsOf } from '../session/internals'
import { createBridge } from './bridge'
import { installDebugHooks } from './debug'
import { MdrEditor } from './editor'
import './editor.css'

export const createEditor: CreateEditor = async (o) => {
  const internals = internalsOf(o.session)
  const ed = new MdrEditor({ host: o.host, toolbarHost: o.toolbarHost, scrollContainer: o.scrollContainer, session: o.session, internals })
  try {
    await ed.mount()
    await internals.attachEditor(ed)
  } catch (e) {
    internals.detachEditor(ed)
    ed.destroy()
    throw e
  }
  const bridge = createBridge(ed)
  const uninstall = internals.boot.testHooks ? installDebugHooks(ed, bridge, o.session) : null
  try {
    performance.mark('mdr:editor-ready')
  } catch {
    // no User Timing (old jsdom): the mark is a measurement aid only
  }
  const handle: EditorHandle = {
    bridge,
    destroy() {
      uninstall?.()
      internals.detachEditor(ed)
      ed.destroy()
    },
  }
  return handle
}
