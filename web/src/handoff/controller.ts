// web/src/handoff/controller.ts (P3; CONTRACTS §8.5, §12.10, §11.5 Send shortcuts).
//
// What Send to Claude does, shared by the button and the two shortcuts (Cmd+Enter in the editor outside code
// blocks, Cmd+Shift+Enter anywhere):
//   1. `send()` calls session.handoff() synchronously, so the session's clipboard write (presence none) happens
//      inside the user's gesture, before any await (§12.10 step 1);
//   2. when the outcome arrives, it raises the toast for what actually happened, or the clipboard-refused modal;
//   3. it remembers the server's prompt (HandoffResult.prompt), which the Copy message buttons of the mismatch and
//      undelivered toasts copy in their own click;
//   4. it listens for SSE `handoff { state: 'undelivered' }` (step 4) and raises "Claude didn't pick this up".
// "Copied" is said only when a clipboard write inside a live gesture resolved. Once a write inside a click was refused
// (the Claude desktop Browser pane never allows one, Pass 4 #29) the page remembers it: the Copy buttons that would
// fail again become "Show message", and the dialog shows the text selected for the person's own Cmd+C / Ctrl+C.
import { buildClipboardPrompt } from '../../../shared/handoff-prompt'
import { promptIdentity } from '../identity'
import type { BrowserSseEvent, DocSession, HandoffOutcome, Unsubscribe } from '../../../shared/types'
import type { ToastStore } from '../shell/toast-store'
import { copyText } from '../threads/clipboard'
import { failedToast, HANDOFF_TEXT, handoffReaction, offlineToast, undeliveredToast, unpostedToast, type HandoffToastCopy } from './copy'

type HandoffSse = Extract<BrowserSseEvent, { event: 'handoff' }>['data']

export interface HandoffControllerOptions {
  session: DocSession
  toasts: ToastStore
  clipboard?: Pick<Clipboard, 'writeText'> | null
  /**
   * Whatever TJ typed in a reply or comment box and didn't post. Send posts it first (so Claude gets it) and hands
   * over only once it went through; when it can't be posted nothing is sent (QA3 rail-ui 5).
   */
  unsent?: { has(): boolean; post(): Promise<boolean> }
  /** Where the one-time Send hint is remembered (default: localStorage when it works; null = per page only). */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

const HINT_KEY = 'mdr:send-hint'

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export interface HandoffController {
  /** Call synchronously inside the click or key handler (§12.10 step 1). */
  send(message?: string): void
  /** A fresh gesture's Copy message: the server's last prompt when there is one, else the round-less prompt. */
  copyPrompt(): Promise<boolean>
  /** The clipboard-refused modal's prompt (null = closed). */
  getModal(): string | null
  closeModal(): void
  /**
   * A clipboard write inside a click was refused on this page (and none has worked since): a Copy button would fail
   * again, so the modal offers the text selected for the person's own copy and the toasts and badge say "Show message".
   */
  getCopyRefused(): boolean
  /** The "Show message" buttons: open the modal with the latest prompt. */
  showPrompt(): void
  /** The modal's Copy button (inside its click). Closes the modal and toasts on success. */
  copyFromModal(): Promise<boolean>
  subscribe(cb: () => void): Unsubscribe
  /** Requests in flight (the button shows it). */
  readonly pending: number
  destroy(): void
}

export const COPIED_TEXT = 'Message copied: paste it into your Claude conversation.'

/** Errors that mean "the server is unreachable" (§12.10 step 6), as opposed to a refusal with a reason. */
export function isUnreachable(e: unknown): boolean {
  if (e instanceof TypeError) return true // fetch's network failure
  if (typeof e !== 'object' || e === null) return true
  const o = e as { code?: unknown; status?: unknown; error?: { code?: unknown }; body?: { code?: unknown } }
  const code = o.code ?? o.error?.code ?? o.body?.code
  if (code === 'SERVER_UNREACHABLE' || code === 'INTERNAL') return true
  if (typeof o.status === 'number') return o.status >= 500 || o.status === 0
  return typeof code !== 'string'
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'something went wrong')

export function createHandoffController(o: HandoffControllerOptions): HandoffController {
  const { session, toasts } = o
  const clipboard = o.clipboard === undefined ? (typeof navigator !== 'undefined' ? (navigator.clipboard ?? null) : null) : o.clipboard
  const storage = o.storage === undefined ? defaultStorage() : o.storage
  let hintSeen = false
  let lastPrompt: string | null = null
  let modal: string | null = null
  let pending = 0
  let lastUndelivered = -1
  let copyRefused = false
  let destroyed = false
  const subs = new Set<() => void>()
  const emit = (): void => {
    for (const cb of [...subs]) cb()
  }

  /** Remembers whether the last clipboard write inside a click worked; passes `ok` through. */
  const noteCopy = (ok: boolean): boolean => {
    if (copyRefused === ok) {
      copyRefused = !ok
      emit()
    }
    return ok
  }

  const roundless = (): string => {
    const snap = session.getSnapshot()
    return buildClipboardPrompt({ file: session.file, abs: snap.abs, root: session.root, round: null, ...promptIdentity() })
  }

  const openModal = (prompt: string): void => {
    modal = prompt
    emit()
  }

  function toast(c: HandoffToastCopy): void {
    toasts.show({
      code: c.code,
      kind: c.kind,
      text: c.text,
      ...(c.copyPrompt
        ? {
            // the button is the only way to get the prompt now that the gesture has expired: it stays until used
            timeoutMs: null,
            action: copyRefused
              ? { label: 'Show message', id: 'show-prompt' as const, run: () => api.showPrompt() }
              : {
                  label: 'Copy message',
                  id: 'copy-prompt' as const,
                  keepOpen: true,
                  run: async () => {
                    const ok = await api.copyPrompt()
                    if (ok) toasts.show({ code: c.code, kind: 'info', text: COPIED_TEXT, timeoutMs: 4_000 })
                    else {
                      toasts.dismissCode(c.code)
                      openModal(lastPrompt ?? roundless())
                    }
                  },
                },
          }
        : {}),
    })
  }

  function onOutcome(out: HandoffOutcome, inGesture: boolean): void {
    lastPrompt = out.prompt
    // what the click's own write did; a write made after the gesture was spent (Send posted a draft first) says nothing
    if (inGesture && out.clientDecision === 'clipboard') noteCopy(out.copied)
    const r = handoffReaction(out)
    if ('modal' in r) openModal(out.prompt)
    else toast(r.toast)
  }

  function onError(e: unknown, copiedInGesture: boolean): void {
    if (isUnreachable(e)) toast(offlineToast(copiedInGesture))
    else toast(failedToast(messageOf(e)))
  }

  // §12.10 step 4: the SSE handoff event subscribe('handoff') announced (DocSession.getLastHandoffEvent, P2 merge)
  const lastEvent = (): HandoffSse | null => session.getLastHandoffEvent()
  const offHandoff = session.subscribe((what) => {
    if (what !== 'handoff') return
    const ev = lastEvent()
    if (!ev) return
    if (ev.state === 'undelivered' && ev.seq !== lastUndelivered) {
      lastUndelivered = ev.seq
      toast(undeliveredToast())
    } else if (ev.state === 'consumed') toasts.dismissCode('HANDOFF_UNDELIVERED')
  })

  /** The hand-over itself: session.handoff() now (inside the click's gesture when called straight from it, §12.10 step 1). */
  function sendNow(message?: string, inGesture = true): void {
    let p: Promise<HandoffOutcome>
    // whether step 1 copied: the session copies only when no waiter is known
    const copying = session.getReview().presence.waiter === 'none'
    try {
      p = message === undefined ? session.handoff() : session.handoff(message)
    } catch (e) {
      onError(e, false)
      return
    }
    pending++
    emit()
    p.then(
      (out) => onOutcome(out, inGesture),
      (e: unknown) => {
        // the outcome is lost with a rejection; a session that knows it attaches `copied` to the error
        const copied = copying && typeof e === 'object' && e !== null && (e as { copied?: unknown }).copied === true
        if (copying && inGesture && typeof e === 'object' && e !== null && typeof (e as { copied?: unknown }).copied === 'boolean') noteCopy(copied)
        onError(e, copied)
      },
    ).finally(() => {
      pending--
      emit()
    })
  }

  // QA3: a comment is saved at once, but Claude only hears about it on Send. Say so once, after the first comment
  // you post (a TJ message that wasn't there when the page loaded); a Send ends the need for it.
  const tjMessages = (): number =>
    session.getReview().threads.reduce((n, t) => n + t.messages.filter((m) => m.by === 'TJ' && !m.deleted).length, 0)
  const hintDone = (): boolean => {
    if (hintSeen) return true
    try {
      return storage?.getItem(HINT_KEY) === '1'
    } catch {
      return false
    }
  }
  const rememberHint = (): void => {
    hintSeen = true
    try {
      storage?.setItem(HINT_KEY, '1')
    } catch {
      // private window or blocked site data: once per page is enough
    }
  }
  let knownTjMessages = tjMessages()
  const offReview = session.subscribe((what) => {
    if (what !== 'review') return
    const n = tjMessages()
    const grew = n > knownTjMessages
    knownTjMessages = n
    if (!grew || hintDone()) return
    rememberHint()
    toasts.show({ code: 'HANDOFF_HINT', kind: 'info', text: HANDOFF_TEXT.hint, timeoutMs: 7_000 })
  })

  const api: HandoffController = {
    send(message) {
      if (destroyed) return
      rememberHint()
      const unsent = o.unsent
      // Typed but not posted: post it first, so what TJ wrote reaches Claude. This leaves the click's own gesture, which
      // only matters for the clipboard fallback (and its refused-copy modal covers that). Nothing unsent keeps the
      // synchronous path, so handoff() still runs inside the click.
      if (unsent?.has()) {
        pending++
        emit()
        unsent.post().then(
          (ok) => (ok ? sendNow(message, false) : toast(unpostedToast())),
          () => toast(unpostedToast()),
        ).finally(() => {
          pending--
          emit()
        })
        return
      }
      sendNow(message)
    },
    async copyPrompt() {
      return noteCopy(lastPrompt !== null ? await copyText(lastPrompt, clipboard) : await session.copyPrompt())
    },
    getModal: () => modal,
    closeModal() {
      if (modal === null) return
      modal = null
      emit()
    },
    getCopyRefused: () => copyRefused,
    showPrompt() {
      openModal(lastPrompt ?? roundless())
    },
    async copyFromModal() {
      const text = modal
      if (text === null) return false
      const ok = noteCopy(await copyText(text, clipboard))
      if (ok) {
        modal = null
        emit()
        toasts.show({ code: 'HANDOFF_COPIED', kind: 'info', text: COPIED_TEXT, timeoutMs: 4_000 })
      }
      return ok
    },
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    get pending() {
      return pending
    },
    destroy() {
      destroyed = true
      offHandoff()
      offReview()
      subs.clear()
    },
  }
  return api
}
