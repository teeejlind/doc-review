// web/src/threads/context.ts (P3). What every card reads from the rail: the session and bridge, the suggestion data,
// the active id, and the rail's actions (activation, pinExpanded, decisions). RailView provides it.
import { createContext, useContext } from 'react'
import type { DocSession, EditorBridge, Suggestion, SuggestionId, SuggestionSummary, Thread, ThreadId } from '../../../shared/types'
import type { RailScheduler } from '../rail/scheduler'
import type { ToastInput } from '../shell/toast-store'
import type { ReadMarkers } from './read-markers'

export type Decision = 'accept' | 'reject'

export interface RailApi {
  session: DocSession
  bridge: EditorBridge
  scheduler: RailScheduler | null
  readMarkers: ReadMarkers | null
  summaries: ReadonlyMap<SuggestionId, SuggestionSummary>
  suggestionsById: ReadonlyMap<SuggestionId, Suggestion>
  activeId: string | null
  /** Comments can't be written (read-only sidecar or file). */
  readOnly: boolean
  /** §11.4: `compensate` only for a card-body pointer-down. */
  activate(id: string, compensate: boolean): void
  /** pinExpanded (§11.1): a focused composer, an unsent draft, a decision in flight. */
  setPin(id: string, pinned: boolean): void
  decide(id: SuggestionId, d: Decision): void
  acceptAllInThread(t: Thread): void
  /** Suggestion ids (and `thread:<id>` for Accept all in thread) with a request in flight. */
  inFlight: ReadonlySet<string>
  /** Last decision error per suggestion id. */
  errors: ReadonlyMap<string, string>
  /** The reply box of a thread card, for focusing it on demand (an `inside-suggestion` reply, next/prev). */
  registerReply(id: ThreadId, el: HTMLTextAreaElement | null): void
  /** A thread's unsent reply: hoisted out of the card so it survives the card remounting (rail ↔ sheet at the breakpoint). */
  getReply(id: ThreadId): string
  putReply(id: ThreadId, body: string): void
  /** A card posts its own reply box on request (Send to Claude posts what is typed first); true = it went through. */
  registerPoster(id: ThreadId, post: (() => Promise<boolean>) | null): void
  /** Hand the focus back to the document (after a comment is posted or cancelled, or Esc in a reply box). */
  returnToDoc(o?: { collapse?: boolean }): void
  /** A toast (resolve → Undo). A no-op where the rail has nowhere to show one. */
  notify(t: ToastInput): void
  /** A card's hover state, for its anchor tick's connector (§11.4). */
  hover(id: string, on: boolean): void
  /**
   * Focus an element with preventScroll once the next layout frame has placed its card (§11.4). `reveal` also scrolls
   * the document the least that shows it ('card': its whole card; 'unless-above': the element, but not when it is wholly
   * above the window, which is somewhere TJ scrolled away from).
   */
  focusAfterLayout(get: () => HTMLElement | null, reveal?: FocusReveal): void
}

/** What focusAfterLayout does about scrolling: nothing (false), reveal the element (true), its card, or the element unless it is above the window. */
export type FocusReveal = boolean | 'card' | 'unless-above'

export const RailContext = createContext<RailApi | null>(null)

export function useRail(): RailApi {
  const r = useContext(RailContext)
  if (!r) throw new Error('useRail outside RailContext')
  return r
}
