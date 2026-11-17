// web/src/App.tsx (P3; CONTRACTS §12.0.1, §12.0.3, §2.3).
//
// `render(<App session={session} />)` from main.tsx. The shell creates the editor in a layout effect once
// #mdr-editor-host, #mdr-toolbar-host and #mdr-scroll exist, and passes editor.bridge to the rail and chrome.
// This file and main.tsx are the only P3 files that import P2 code, and only its two entry modules (§2.3); under
// MDR_FAKE_EDITOR=1 the build swaps them for tests/fakes/web-{session,editor}.ts.
import type { DocSession } from '../../shared/types'
import { createEditor } from './editor/index'
import { Shell } from './shell/Shell'

export interface AppProps {
  session: DocSession
  /** #mdr-app; defaults to the element in the page. */
  app?: HTMLElement | null
}

export function App({ session, app }: AppProps) {
  return <Shell session={session} createEditor={createEditor} app={app ?? document.getElementById('mdr-app')} />
}
