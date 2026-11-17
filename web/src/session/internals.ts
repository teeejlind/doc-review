// web/src/session/internals.ts (P2-private). The seam between the session (web/src/session) and the editor
// (web/src/editor). Nothing here crosses to P3: createEditor finds these internals through `sessionInternals` (a
// WeakMap keyed by the DocSession openDocSession returned), which is why createEditor throws TypeError for any other
// object (§12.0.3).
//
// Division of labour:
// - The session owns the base (`Loaded` + rev/hash), REST, SSE, the queue, the save planner, drafts, holds,
//   banners and notices. It never touches the EditorView.
// - The editor implements `EditorPort`: everything that needs the live ProseMirror state (baseDoc, suggestion and
//   anchor diffs, the reload transaction, draft restore, selection and scroll).
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { Md } from '../../../core/md/index'
import type { Loaded } from '../../../core/splice/load'
import type {
  AnchorUpdate, Author, BlockConflict, BlockHash, BulkDecisionResult, ClientId, DocSession, ErrorCode, Mode, OpKey,
  ReviewState, SessionBootstrap, SessionNotice, SuggestionId, TjSuggestionUpsert, Unsubscribe,
} from '../../../shared/types'

/** One reopen request the planner sends before a save (§6.6, D26): a single id, or every id of one bulk entry. */
export interface ReopenGroup {
  ids: SuggestionId[]
  /** The bulk's opKey when the ids were decided by one bulk (one atomic POST /api/suggestions/bulk reopen). */
  bulk?: OpKey
}

/** §6.4 tjSuggestionDiff, with reopen ids grouped by the decision journal. */
export interface SuggestionPlan {
  upsert: TjSuggestionUpsert[]
  withdraw: SuggestionId[]
  reopen: ReopenGroup[]
}

export type ReloadReason = 'remote' | 'merge' | 'restore' | 'resync' | 'decision' | 'recover' | 'full'

/** §12.6 steps 4, 5, 6 (re-hydration and decorations) and 7, which need the live view. */
export interface ReloadApply {
  /** The base the live doc was built on; null = replace the whole document (docId change, draft-less full reload). */
  prev: Loaded | null
  next: Loaded
  /** Base hashes whose live blocks keep TJ's text (held conflicts, §7.4): their runs are never replaced. */
  preserve: ReadonlySet<BlockHash>
  review: ReviewState
  reason: ReloadReason
}

export interface DraftState {
  /** Live ProseMirror doc JSON including suggestion marks. */
  liveDoc: unknown
  selection: { anchor: number; head: number } | null
  mode: Mode
}

export interface EditorPort {
  readonly md: Md
  /** Install the session's base as the editor's initial doc (`EditorState.create({ doc: L.doc, ... })`, §3.2). */
  install(L: Loaded): void
  /** Monotonic; bumped by every doc-changing transaction whose mdr.origin is not hydrate, reload or decide (§12.4). */
  changeGen(): number
  /** view.composing (IME, §12.4 / §13 #63). */
  isComposing(): boolean
  /** baseDoc(live): a copy with every suggestion id reverted, skip meta (§12.4 step 2). */
  baseDoc(): PMNode
  /** §6.4 tjSuggestionDiff against the review state, with reopen candidates grouped (D26). */
  suggestionPlan(L: Loaded, review: ReviewState): SuggestionPlan
  /** Session-clock ms since which `id`'s marks have not changed; undefined = unknown (send now). */
  marksStableSince(id: SuggestionId): number | undefined
  /** §5.4: changed-quote, collapsed and duplicate-quote-refresh threads for this save. */
  anchorUpdates(L: Loaded, review: ReviewState): AnchorUpdate[]
  /** A save landed with these anchors and suggestion changes: the editor commits its baselines. */
  committed(o: { L: Loaded; anchors: AnchorUpdate[]; upserted: SuggestionId[]; withdrawn: SuggestionId[] }): void
  /** §12.6 reload into the live view (minimal replace, rehydrate, decorations, selection, scroll). */
  applyReload(o: ReloadApply): void
  /** The review state changed (refresh): re-hydrate changed records, rebuild affected decorations. */
  reviewChanged(review: ReviewState): void
  /**
   * The session accepted/rejected these ids on the server: dispatch applySuggestion / revertSuggestion (decide
   * origin, one transaction, one journal entry). Returns true when the live doc now shows the decision; false when an
   * id was unplaced ('SCHEMA'), so the session adopts the accept through the reload path (§6.3, §13 #72).
   */
  decisionApplied(o: { ids: SuggestionId[]; decision: 'accept' | 'reject'; bulk?: OpKey }): boolean
  /** The server refused an undo (409 SUGGESTION_CHANGED_SINCE): re-apply the decision and show UNDO_CANCELLED. */
  reopenRefused(group: ReopenGroup): void
  /** §12.5 draft contents. */
  draftState(): DraftState
  /** Restore a draft's live doc (skip meta, counts as an edit). false = the doc failed schema validation. */
  restoreDraft(d: { liveDoc: unknown; selection: DraftState['selection'] }): boolean
  /** TJ's copy as markdown: the base text with his own pending suggestions applied, where it still parses. */
  liveMarkdown(): string
  /** A draft's live doc as markdown, or null when it does not parse against the schema. */
  markdownOf(liveDoc: unknown): string | null
  /** Keep mine: replace the content with `markdown` through the reload path, one history-enabled tr, skip meta. */
  replaceAll(markdown: string): void
  /** §7.4 take theirs / discard my change: replace the conflicted live blocks with the base's (skip, addToHistory). */
  takeTheirs(c: BlockConflict, L: Loaded): void
  /** Editable iff this tab leads and nothing makes the document read-only. */
  setEditable(editable: boolean): void
  /**
   * The server refused TJ's suggestion `id` (422 UNANCHORABLE_TARGET): take its marks back (a dirty edit, so the next
   * save and the draft drop it) and tell TJ why. false = not TJ's or not in the doc (QA3: a refused upsert used to
   * fail every save, and replay from the draft after a reload, with nothing in the UI to clear it).
   */
  refuseSuggestion?(id: SuggestionId, message: string): boolean
}

/** What the editor reaches through `sessionInternals.get(session)`. */
export interface SessionInternals {
  readonly boot: SessionBootstrap
  readonly clientId: ClientId
  /** Attach the editor: the session loads its base with the editor's Md, installs it, checks parity, restores a draft. */
  attachEditor(port: EditorPort): Promise<void>
  detachEditor(port: EditorPort): void
  getLoaded(): Loaded | null
  /** Base hashes held by conflicts and unsaveable ops (§7.4). */
  heldHashes(): ReadonlySet<BlockHash>
  isEditable(): boolean
  /** The editor reports a dirty transaction (§12.4). */
  changed(): void
  /** Editor blur (§12.4 trigger). */
  blurred(): void
  /** compositionend: run a flush deferred by IME. */
  compositionEnded(): void
  /** §6.6 single decision through the queue. */
  decide(id: SuggestionId, decision: 'accept' | 'reject'): Promise<{ ok: boolean; noop?: true; code?: ErrorCode }>
  /** §6.6 bulk accept/reject through the queue; null when no id matched. */
  bulk(sel: { decision: 'accept' | 'reject'; by?: Author; ids?: readonly SuggestionId[] }): Promise<BulkDecisionResult | null>
  /** §7.4 card actions (EditorBridge.resolveConflict delegates here). */
  resolveConflict(id: BlockConflict['id'], choice: 'mine' | 'theirs'): Promise<void>
  /** Toasts the editor wants raised as session notices. */
  notice(n: SessionNotice): void
  onEditableChange(cb: (editable: boolean) => void): Unsubscribe
}

export const sessionInternals = new WeakMap<DocSession, SessionInternals>()

/** createEditor's guard (§12.0.3): only a session made by openDocSession has internals. */
export function internalsOf(session: unknown): SessionInternals {
  const i = typeof session === 'object' && session !== null ? sessionInternals.get(session as DocSession) : undefined
  if (!i) throw new TypeError('createEditor requires a session made by openDocSession (web/src/session)')
  return i
}
