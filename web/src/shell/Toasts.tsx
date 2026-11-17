// web/src/shell/Toasts.tsx (P3; CONTRACTS §12.10, §12.14, §12.15 toast / toastAction).
//
// The toast stack, bottom-left of the window, over everything but the history panel. Each toast is
// `data-testid="mdr-toast"` with `data-code` (the notice or handoff code) and `data-kind`; its button is
// `mdr-toast-action` with `data-action` from TEST_ACTIONS.toastAction. The stack is one polite live region that
// exists from the first render, so a screen reader hears each new toast once.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { TESTID } from '../../../shared/constants'
import type { DocSession, EditorBridge } from '../../../shared/types'
import { editorNoticeToast, sessionNoticeToast, type Toast, type ToastStore } from './toast-store'

export interface ToastsProps {
  store: ToastStore
  /** Test seam for the auto-dismiss timers. */
  setTimer?: ((cb: () => void, ms: number) => unknown) | undefined
  clearTimer?: ((h: unknown) => void) | undefined
}

export function Toasts({ store, setTimer, clearTimer }: ToastsProps) {
  const toasts = useSyncExternalStore(store.subscribe, store.list, store.list)
  return (
    <section className="mdr-toasts" aria-label="Notifications" aria-live="polite" aria-relevant="additions text">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} store={store} setTimer={setTimer} clearTimer={clearTimer} />
      ))}
    </section>
  )
}

function ToastView({ toast, store, setTimer, clearTimer }: { toast: Toast } & ToastsProps) {
  const [paused, setPaused] = useState(false)
  const set = useRef(setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms)))
  const clear = useRef(clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))
  useEffect(() => {
    if (toast.timeoutMs === null || paused) return undefined
    const h = set.current(() => store.dismiss(toast.id), toast.timeoutMs)
    return () => clear.current(h)
  }, [toast.id, toast.timeoutMs, paused, store])
  const a = toast.action
  return (
    <div
      className="mdr-toast"
      data-testid={TESTID.toast}
      data-code={toast.code}
      data-kind={toast.kind}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false)
      }}
    >
      <span className="mdr-toast-mark" aria-hidden="true" />
      <span className="mdr-toast-text">{toast.text}</span>
      {a ? (
        <button
          type="button"
          className="mdr-toast-action"
          data-testid={TESTID.toastAction}
          {...(a.id ? { 'data-action': a.id } : {})}
          aria-label={a.label}
          onClick={() => {
            // the action runs inside this click: a clipboard write in it is inside the gesture
            void a.run()
            if (!a.keepOpen) store.dismiss(toast.id)
          }}
        >
          {a.label}
        </button>
      ) : null}
      <button type="button" className="mdr-toast-close" aria-label="Dismiss notification" onClick={() => store.dismiss(toast.id)}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

/** Session and editor notices → toasts (§12.14 "Session notices"; the editor's guards, §6.5, D14). */
export function useNoticeToasts(store: ToastStore, session: DocSession, bridge: EditorBridge | null, o: { onViewHistory?: () => void } = {}): void {
  const viewHistory = useRef(o.onViewHistory)
  viewHistory.current = o.onViewHistory
  useEffect(() => session.onNotice((n) => void store.show(sessionNoticeToast(n, viewHistory.current ? { onViewHistory: () => viewHistory.current?.() } : {}))), [store, session])
  useEffect(() => (bridge ? bridge.onNotice((n) => void store.show(editorNoticeToast(n, bridge))) : undefined), [store, bridge])
}
