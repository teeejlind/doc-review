// web/src/shell/start.tsx (P3; CONTRACTS §12.0.2, §12.0.3).
//
// The page boot in the normative §12.0.3 order. main.tsx hands in P2's entry functions (this module never imports
// P2 code, §2.3) and how to render the App:
//
//   const boot = readBootstrap(document)        // throws → "must be opened from `mdr open`" + Reload
//   if (!boot.file) { renderEmptyState(boot); connectRootChannel(boot).onNavigate(goTo); return }
//      (empty and error states render inside the §12.0.1 frame, so the host ids are always present)
//   const session = await openDocSession({ boot, file: boot.file })   // empty-state codes → empty state
//   session.onNavigate(flush, then full page load)
//   render(<App session={session} />)           // App creates the editor in a layout effect
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectRootChannel, DocSession, ErrorCode, OpenDocSession, ReadBootstrap, SessionBootstrap } from '../../../shared/types'
import { installTheme } from '../theme/theme'
import { EmptyPage, NO_BOOTSTRAP, NO_FILE, OPEN_FAILED } from './EmptyState'
import { goTo, navigateOnRequest, type Assign } from './navigate'

/** openDocSession rejections that mean "show the empty state with this reason" (§12.0.3). */
export const EMPTY_STATE_CODES: ReadonlySet<string> = new Set<ErrorCode>(['FILE_NOT_FOUND', 'DOC_GONE', 'PROTECTED_ROOT', 'PATH_OUTSIDE_ROOT'])

export interface PageDeps {
  readBootstrap: ReadBootstrap
  openDocSession: OpenDocSession
  connectRootChannel: ConnectRootChannel
  renderApp(session: DocSession, app: HTMLElement): ReactNode
  doc?: Document
  location?: Pick<Location, 'assign' | 'reload' | 'search'>
}

export type PageResult =
  | { kind: 'empty'; reason: string; root: Root }
  | { kind: 'error'; reason: string; root: Root }
  | { kind: 'app'; session: DocSession; root: Root }

/** The rejection's ErrorCode, whether it is a StoreError, an ApiErrorBody or an ApiError envelope. */
export function codeOf(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null
  const o = e as { code?: unknown; error?: { code?: unknown }; body?: { code?: unknown } }
  const c = o.code ?? o.error?.code ?? o.body?.code
  return typeof c === 'string' ? c : null
}

const basename = (f: string): string => f.split('/').pop() || f

export async function startPage(deps: PageDeps): Promise<PageResult> {
  const doc = deps.doc ?? document
  const loc = deps.location ?? doc.defaultView!.location
  const app = doc.getElementById('mdr-app')
  if (!app) throw new Error('index.html has no #mdr-app (§12.0.1)')
  installTheme({ doc, app, loc })
  const root = createRoot(app)
  const assign: Assign = (url) => loc.assign(url)
  const reload = (): void => loc.reload()
  const requested = new URLSearchParams(loc.search).get('file') ?? ''

  const empty = (reason: string, file: string, boot: SessionBootstrap): PageResult => {
    root.render(<EmptyPage reason={reason} file={file} />)
    deps.connectRootChannel(boot).onNavigate((f) => goTo(f, assign))
    return { kind: 'empty', reason, root }
  }
  const error = (reason: string, file: string, detail: string | null): PageResult => {
    root.render(<EmptyPage reason={reason} file={file} detail={detail} onReload={reload} />)
    return { kind: 'error', reason, root }
  }

  let boot: SessionBootstrap
  try {
    boot = deps.readBootstrap(doc)
  } catch (e) {
    console.error('[mdr] readBootstrap failed', e)
    return error(NO_BOOTSTRAP, requested, null)
  }
  if (!boot.file) return empty(boot.fileError ?? NO_FILE, requested, boot)

  let session: DocSession
  try {
    session = await deps.openDocSession({ boot, file: boot.file })
  } catch (e) {
    const c = codeOf(e)
    if (c !== null && EMPTY_STATE_CODES.has(c)) return empty(c, boot.file, boot)
    console.error('[mdr] openDocSession failed', e)
    return error(OPEN_FAILED, boot.file, e instanceof Error ? e.message : String(c ?? e))
  }
  navigateOnRequest(session, assign)
  doc.title = `${basename(boot.file)} · mdr`
  root.render(deps.renderApp(session, app))
  return { kind: 'app', session, root }
}
