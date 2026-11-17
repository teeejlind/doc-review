// web/src/main.tsx (P3; CONTRACTS §12.0.2, §12.0.3, §2.3).
//
// Page entry. The normative order lives in shell/start.tsx: readBootstrap → (no file: empty state + root channel)
// → openDocSession → session.onNavigate → render(<App session={session} />). This file supplies P2's entry
// functions, the only P2 module it may import besides the editor entry App.tsx uses.
import { App } from './App'
import { connectRootChannel, openDocSession, readBootstrap } from './session/index'
import { startPage } from './shell/start'
import './theme/index'

void startPage({
  readBootstrap,
  openDocSession,
  connectRootChannel,
  renderApp: (session, app) => <App session={session} app={app} />,
})
