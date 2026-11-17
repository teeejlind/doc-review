// web/src/shell/toast-store.ts (P3; CONTRACTS §12.10, §12.14 notices, §12.15 toast / toastAction).
//
// The toast queue every P3 surface writes to: session notices (DRAFT_RECOVERED, DECISION_REVERTED, RECREATE_FAILED,
// POLICY_CHANGED, CLAUDE_EDITED), editor notices (FOREIGN_SUGGESTION, SUGGEST_MODE_BLOCKED, ...) and the Send button's handoff
// toasts. A toast is keyed by its code: showing a code that is already up replaces it in place and restarts its
// timer, so a guard that fires on every blocked keystroke shows one toast, not a pile.
//
// Timers: info toasts without an action leave after 5 s, warnings and errors after 8 s, toasts with an action after
// 12 s; `timeoutMs: null` keeps a toast until it is dismissed (the Copy message toasts, whose button is the only way
// to get the prompt after the gesture has expired). A toast's timer pauses while the pointer or focus is on it.
import type { EditorBridge, EditorNotice, SessionNotice, Unsubscribe } from '../../../shared/types'

/** `data-action` values P3 puts on toast buttons (TEST_ACTIONS.toastAction). */
export type ToastActionId = 'copy-prompt' | 'show-prompt' | 'switch-to-editing'

export interface ToastAction {
  label: string
  /** Runs inside the click (a clipboard write here is inside the gesture). */
  run(): void | Promise<unknown>
  /** TEST_ACTIONS.toastAction value; omitted for a notice action outside the closed set. */
  id?: ToastActionId
  /** The toast stays after the click (the action updates or dismisses it itself, e.g. Copy message → "Copied"). */
  keepOpen?: boolean
}

export interface ToastInput {
  code: string
  kind: 'info' | 'warn' | 'error'
  text: string
  action?: ToastAction
  /** ms before it leaves on its own; null = until dismissed. Default by kind and action (see above). */
  timeoutMs?: number | null
}

export interface Toast extends ToastInput {
  id: number
  timeoutMs: number | null
}

export interface ToastStore {
  show(t: ToastInput): number
  dismiss(id: number): void
  /** Dismiss the toast with this code, if any. */
  dismissCode(code: string): void
  list(): readonly Toast[]
  subscribe(cb: () => void): Unsubscribe
}

export const TOAST_MAX = 3

export function defaultTimeout(t: Pick<ToastInput, 'kind' | 'action'>): number {
  if (t.action) return 12_000
  return t.kind === 'info' ? 5_000 : 8_000
}

export function createToastStore(): ToastStore {
  let toasts: Toast[] = []
  let next = 1
  const subs = new Set<() => void>()
  const emit = (): void => {
    for (const cb of [...subs]) cb()
  }
  return {
    show(t) {
      const toast: Toast = { ...t, id: next++, timeoutMs: t.timeoutMs === undefined ? defaultTimeout(t) : t.timeoutMs }
      const at = toasts.findIndex((x) => x.code === t.code)
      if (at >= 0) toasts = toasts.map((x, i) => (i === at ? toast : x))
      else toasts = [...toasts, toast].slice(-TOAST_MAX)
      emit()
      return toast.id
    },
    dismiss(id) {
      const n = toasts.filter((x) => x.id !== id)
      if (n.length === toasts.length) return
      toasts = n
      emit()
    },
    dismissCode(code) {
      const n = toasts.filter((x) => x.code !== code)
      if (n.length === toasts.length) return
      toasts = n
      emit()
    },
    list: () => toasts,
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
  }
}

const SWITCH_TO_EDITING = /switch to editing/i

/**
 * A session notice as a toast (its action, when present, keeps its own label). `onViewHistory` is the shell's way to
 * open the version history panel: CLAUDE_EDITED ("Claude changed 1 block.") offers it as "View history".
 */
export function sessionNoticeToast(n: SessionNotice, o: { onViewHistory?: () => void } = {}): ToastInput {
  const base = { code: n.code, kind: n.kind, text: n.text }
  if (n.action) return { ...base, action: { label: n.action.label, run: n.action.run, ...(SWITCH_TO_EDITING.test(n.action.label) ? { id: 'switch-to-editing' as const } : {}) } }
  if (n.code === 'CLAUDE_EDITED' && o.onViewHistory) return { ...base, action: { label: 'View history', run: o.onViewHistory } }
  return base
}

/**
 * An editor notice as a toast. SUGGEST_MODE_BLOCKED always offers "Switch to Editing" (D14): P2's own action when it
 * sends one, else bridge.setMode('editing').
 */
export function editorNoticeToast(n: EditorNotice, bridge: Pick<EditorBridge, 'setMode'>): ToastInput {
  if (n.code === 'SUGGEST_MODE_BLOCKED') {
    const run = n.action?.run ?? (() => bridge.setMode('editing'))
    return { code: n.code, kind: n.kind, text: n.text, action: { label: n.action?.label ?? 'Switch to Editing', run, id: 'switch-to-editing' } }
  }
  return { code: n.code, kind: n.kind, text: n.text, ...(n.action ? { action: { label: n.action.label, run: n.action.run, ...(SWITCH_TO_EDITING.test(n.action.label) ? { id: 'switch-to-editing' as const } : {}) } } : {}) }
}
