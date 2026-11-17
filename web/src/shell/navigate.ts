// web/src/shell/navigate.ts (P3; CONTRACTS §12.0.3 "Navigation").
//
// A file switch is always a full page load, and only after everything typed so far is persisted:
// `await session.flush()` then `location.assign('/?file=' + encodeURIComponent(file))`. No second session is ever
// created in one page. A failed flush still navigates (the pagehide keepalive save covers the remainder), and a
// second navigate while the first is flushing is ignored.
import type { DocSession } from '../../../shared/types'

export const fileUrl = (file: string): string => '/?file=' + encodeURIComponent(file)

export type Assign = (url: string) => void

/** The empty-state path: no session, navigate straight away. */
export function goTo(file: string, assign: Assign): void {
  assign(fileUrl(file))
}

/** Wires session.onNavigate (SSE `navigate`) to flush-then-load. Returns the unsubscribe. */
export function navigateOnRequest(session: Pick<DocSession, 'flush' | 'onNavigate'>, assign: Assign): () => void {
  let going = false
  return session.onNavigate((file) => {
    if (going) return
    going = true
    void session
      .flush()
      .catch(() => undefined)
      .then(() => assign(fileUrl(file)))
  })
}
