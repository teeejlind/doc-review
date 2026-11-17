// web/src/handoff/copy.ts (P3; CONTRACTS §8.5 badge copy table, §12.10 toasts, §12.15 toast / claudeBadge).
//
// The words the Send button's toasts and the Claude badge say, as pure functions of what actually happened, so
// they are unit-tested against every (clientDecision, delivery, copied) combination and every ClaudeActivity row.
// The rule from §12.10: "copied" is said only when a clipboard write inside a live gesture succeeded.
// The reader is a colleague who installed a plugin, not a developer (QA3): no "waiter", "mdr" or "session", and the
// message goes "into your Claude conversation", not "the chat". Badge rows stay under 40 characters (the badge caps at
// 300px and ellipsizes).
import type { ClaudeActivity, HandoffOutcome } from '../../../shared/types'

/**
 * `data-code` values of the handoff toasts (the session and editor notices carry their own codes). Not part of the
 * §12.15 table yet; filed in contract-changes/P3.md.
 */
export type HandoffToastCode =
  | 'HANDOFF_SENT' | 'HANDOFF_LATCHED' | 'HANDOFF_COPIED' | 'HANDOFF_MISMATCH' | 'HANDOFF_UNDELIVERED'
  | 'HANDOFF_OFFLINE' | 'HANDOFF_FAILED' | 'HANDOFF_UNPOSTED' | 'HANDOFF_NOTHING_NEW' | 'HANDOFF_HINT'

export interface HandoffToastCopy {
  code: HandoffToastCode
  kind: 'info' | 'warn' | 'error'
  text: string
  /** Offer a Copy message button (a fresh gesture). */
  copyPrompt: boolean
}

/** §12.10 step 3 / step 5: a toast, or the clipboard-refused modal. */
export type HandoffReaction = { toast: HandoffToastCopy } | { modal: true }

export const HANDOFF_TEXT = {
  sent: 'Sent to Claude.',
  nothingNew: 'Nothing new to send yet. Add a comment or edit first.',
  /** Once, after the first comment you post: a comment is saved at once but Claude only hears about it on Send. */
  hint: 'Saved. Claude sees this when you click Send to Claude.',
  latched: 'Claude is busy right now. It will see your changes when it finishes.',
  copied: 'Claude isn’t listening. Message copied: paste it into your Claude conversation.',
  mismatch: 'Claude isn’t listening anymore. Copy this message and paste it into your Claude conversation.',
  undelivered: 'Claude didn’t pick this up',
  offline: 'Lost connection to the review page. Reload to reconnect. Your last edits aren’t saved yet.',
  offlineCopied: 'Lost connection to the review page. Reload to reconnect. Your last edits aren’t saved yet. Message copied.',
  unposted: 'Your reply or comment didn’t post, so nothing was sent to Claude. It is still in its box: post it, then send again.',
} as const

/**
 * §12.10 step 5, the clipboard-refused modal's paragraph. `manual` = a write inside a click was refused on this page
 * (Pass 4 #29), so the dialog has no Copy button: the message is selected and the person copies it with `keys`.
 */
export function promptModalText(manual: boolean, keys: string): string {
  return manual
    ? `Claude isn’t listening, and this page can’t copy to your clipboard. The message below is selected: press ${keys}, then paste it into your Claude conversation.`
    : 'Claude isn’t listening, and your browser didn’t allow copying. Copy this message, then paste it into your Claude conversation.'
}

/** §12.10 step 3, by what the click did (`clientDecision`, `copied`) and what the server did (`delivery`). */
export function handoffReaction(o: Pick<HandoffOutcome, 'clientDecision' | 'delivery' | 'copied'> & { nothingNew?: true }): HandoffReaction {
  // QA3: nothing since Claude's last ack, so nothing was sent; whatever the click copied is not the story
  if (o.nothingNew) return { toast: { code: 'HANDOFF_NOTHING_NEW', kind: 'info', text: HANDOFF_TEXT.nothingNew, copyPrompt: false } }
  if (o.clientDecision === 'clipboard') {
    // the server honours a clipboard decision, so delivery is 'clipboard'; either way only `copied` decides the words
    if (o.copied) return { toast: { code: 'HANDOFF_COPIED', kind: 'info', text: HANDOFF_TEXT.copied, copyPrompt: false } }
    return { modal: true } // step 5: the write was refused; show the prompt with a Copy button
  }
  switch (o.delivery) {
    case 'waiter':
      return { toast: { code: 'HANDOFF_SENT', kind: 'info', text: HANDOFF_TEXT.sent, copyPrompt: false } }
    case 'latched':
      return { toast: { code: 'HANDOFF_LATCHED', kind: 'info', text: HANDOFF_TEXT.latched, copyPrompt: false } }
    case 'clipboard':
      // the mismatch case: the waiter died after the last presence event; nothing was copied and the gesture expired
      return { toast: { code: 'HANDOFF_MISMATCH', kind: 'warn', text: HANDOFF_TEXT.mismatch, copyPrompt: true } }
  }
}

/** §12.10 step 4: SSE `handoff { state: 'undelivered' }`. */
export function undeliveredToast(): HandoffToastCopy {
  return { code: 'HANDOFF_UNDELIVERED', kind: 'warn', text: HANDOFF_TEXT.undelivered, copyPrompt: true }
}

/** §12.10 step 6: the server was unreachable. `copied` = the in-gesture copy of step 1 succeeded. */
export function offlineToast(copied: boolean): HandoffToastCopy {
  return copied
    ? { code: 'HANDOFF_OFFLINE', kind: 'warn', text: HANDOFF_TEXT.offlineCopied, copyPrompt: false }
    : { code: 'HANDOFF_OFFLINE', kind: 'warn', text: HANDOFF_TEXT.offline, copyPrompt: true }
}

 /** Send found something typed but not posted, tried to post it first, and couldn't (QA3 rail-ui 5). */
export function unpostedToast(): HandoffToastCopy {
  return { code: 'HANDOFF_UNPOSTED', kind: 'warn', text: HANDOFF_TEXT.unposted, copyPrompt: false }
}

/** A refusal that isn't "unreachable" (a 4xx such as READ_ONLY): say what the server said. */
export function failedToast(message: string): HandoffToastCopy {
  return { code: 'HANDOFF_FAILED', kind: 'error', text: `Couldn’t send to Claude: ${message}`, copyPrompt: false }
}

export interface BadgeCopy {
  text: string
  /** The waiting-for-paste row offers Copy message (§8.5). */
  copyPrompt: boolean
  /** Pulsing dot (static under prefers-reduced-motion). */
  pulse: boolean
  /** The replied row: the unread count, and a click activates the first unread card. */
  count: number | null
}

export const BADGE_TEXT = {
  waiter: 'Sent to Claude',
  latched: 'Queued for Claude',
  clipboard: 'Waiting for you to paste it into Claude',
  working: 'Claude is working',
  replied: 'Claude replied',
} as const

/** §8.5 badge copy (normative). null = no badge (idle). */
export function badgeCopy(a: Pick<ClaudeActivity, 'state' | 'delivery' | 'unreadFromClaude'>): BadgeCopy | null {
  switch (a.state) {
    case 'idle':
      return null
    case 'waiting-pickup':
      if (a.delivery === 'latched') return { text: BADGE_TEXT.latched, copyPrompt: false, pulse: false, count: null }
      if (a.delivery === 'clipboard') return { text: BADGE_TEXT.clipboard, copyPrompt: true, pulse: false, count: null }
      return { text: BADGE_TEXT.waiter, copyPrompt: false, pulse: false, count: null }
    case 'working':
      return { text: BADGE_TEXT.working, copyPrompt: false, pulse: true, count: null }
    case 'replied':
      return { text: BADGE_TEXT.replied, copyPrompt: false, pulse: false, count: Math.max(0, a.unreadFromClaude) }
  }
}

/** The badge's accessible text (the live region reads it once per change). */
export function badgeLabel(c: BadgeCopy): string {
  if (c.count !== null && c.count > 0) return `${c.text}, ${c.count} unread. Show the first`
  return c.text
}
