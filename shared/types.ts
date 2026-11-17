// doc-review v2 (mdr): FROZEN shared contract types.
//
// Owner: integrator. Producers never edit this file; change requests go to CONTRACT_CHANGES.md.
// Behaviour lives in CONTRACTS.md; shapes live here. Section tags (§n) point at CONTRACTS.md.
// If CONTRACTS.md and this file disagree on a SHAPE, this file wins. If they disagree on
// BEHAVIOUR, CONTRACTS.md wins.
//
// This file has no imports. Its only runtime values are frozen constants (SIDECAR_SCHEMA,
// PROTOCOL, ERROR_TABLE, AGENT_CONTENT_ROUTES, CONSTANTS, THEME_TOKENS, TESTID, TEST_ACTIONS). It references the
// DOM types `Document` and `HTMLElement` (§12.0 factories), so every tsconfig project includes lib
// "DOM" for types only; nothing here touches a DOM global at runtime.
//
// The other frozen shared files import from here and never redefine anything defined here:
// constants.ts (re-exports the runtime constants), errors.ts (StoreError), ids.ts (id regexes and
// guards), handoff-prompt.ts (§9.10 builders), version.ts (MDR_VERSION, CORE_VERSION). Runtime
// validation lives in shared/schemas.ts (zod 4), which the integrator derives from these types on
// day 0; tests/contract/schemas-match-types asserts `z.infer<schema>` equals each type with expectTypeOf.

// =====================================================================================
// §0 Primitives and identifiers
// =====================================================================================

/** The only comment and suggestion authors. Fixed by surface: browser = TJ, CLI = Claude. */
export type Author = 'TJ' | 'Claude'
/** `external` = a disk write that did not come through mdr. `system` = bookkeeping, never content. */
export type Actor = Author | 'external' | 'system'
export type Mode = 'editing' | 'suggesting'
export type Eol = '\n' | '\r\n'
export type Via = 'server' | 'direct'

/**
 * sha256 lowercase hex, 64 chars. Doc hash = over the raw file bytes, BOM included: computed from text as
 * docHash(text, bom) = sha256((bom ? EF BB BF : '') ‖ utf8(text)) (core/hash.ts, §0.4, D40).
 */
export type Hash = string
/** First 16 hex chars of sha256(utf8(block source slice)). */
export type BlockHash = string
/** Positional block ref, 1-based, valid only together with the rev it was read at (Proof-style). */
export type BlockRef = `b${number}`

/** IDs are `<prefix>_<ULID>` (Crockford base32, 26 chars). Regexes: shared/ids.ts. */
export type ThreadId = `t_${string}`
export type CommentId = `c_${string}`
export type SuggestionId = `s_${string}`
export type EventId = `e_${string}`
export type DocId = `d_${string}`
/** Browser tab id, minted once per tab load; sent as X-MDR-Client-Id on every non-GET browser request (D32). */
export type ClientId = `k_${string}`
/**
 * Waiter id: `w_` + 16 hex. `mdr open` / `mdr arm` mint a random one per waiter loop and bake it into
 * WaiterSpec.command as `--waiter <id>` (§9.8). Without `--waiter`, `mdr wait` derives
 * sha256(seed + '\0' + abs).slice(0, 16) from `--waiter-seed <s>` or hostname+cwd+ppid.
 */
export type WaiterId = `w_${string}`
/** History version id: `v` + decimal version number, e.g. `v12`. */
export type VersionId = `v${number}`
/** Browser-minted idempotency key for one user action: `op_` + ULID, minted at click time. */
export type OpKey = `op_${string}`
/** ISO-8601 UTC with milliseconds, server clock. Informational only: ordering is seq / rev. */
export type IsoTime = string
export type Unsubscribe = () => void

// =====================================================================================
// §3 Document model
// =====================================================================================

export type BlockKind = 'md' | 'raw' | 'frontmatter'
export type Fidelity = 'exact' | 'semantic' | 'lossy'
/** mdast type of the top-level source block, or 'gap' for non-whitespace text between blocks. */
export type MdType =
  | 'yaml' | 'toml' | 'heading' | 'paragraph' | 'list' | 'table' | 'blockquote' | 'code'
  | 'thematicBreak' | 'html' | 'footnoteDefinition' | 'definition' | 'gap' | (string & {})

export interface BlockInfo {
  ref: BlockRef
  /** 0-based position in the block map at this rev. */
  index: number
  kind: BlockKind
  mdType: MdType
  /** UTF-16 offsets into the BOM-stripped decoded text, [start, end), excluding surrounding gaps. */
  start: number
  end: number
  /** 1-based source lines, inclusive. */
  line: number
  endLine: number
  hash: BlockHash
  fidelity: Fidelity
  /** This block's range in the ptext (§5.1). */
  pStart: number
  pEnd: number
  /** First 80 chars of the block's ptext (or of its source for atoms). */
  preview: string
}

export type ReadOnlyCode =
  | 'NOT_UTF8' | 'TOO_LARGE' | 'SIDECAR_CORRUPT' | 'SIDECAR_SCHEMA_UNSUPPORTED'
  | 'CONTRACT_MISMATCH' | 'DOC_GONE' | 'TAB_NOT_LEADER'

export interface DocSnapshot {
  file: string              // posix, relative to root
  abs: string               // realpath, NFC
  docId: DocId | null       // null until the sidecar exists
  rev: number               // 0 = mdr has never recorded a revision for this doc
  hash: Hash                // docHash domain (raw bytes, BOM included)
  markdown: string          // decoded, BOM stripped, EOLs untouched
  bom: boolean
  eol: Eol                  // dominant EOL; used only for newly serialized blocks
  size: number              // bytes on disk
  mtimeMs: number
  blocks: BlockInfo[]
  seq: number               // sidecar seq this snapshot is consistent with (0 if no sidecar)
  schemaFingerprint: string // core/md schema fingerprint; browser refuses to edit on mismatch
  readOnly: false | { code: ReadOnlyCode; message: string }
}

/**
 * One run splice against a BASE revision (§3.4). Replaces the base blocks strictly between
 * `after` and `before` with `blocks`. Seams (inter-block whitespace) are chosen by applyBlockOps,
 * never sent. Ops in one request are sorted by `after` and never overlap.
 */
export interface BlockOp {
  /** Base index of the untouched block immediately before the run; -1 = start of document. */
  after: number
  /** Base index of the untouched block immediately after the run; base block count = end of document. */
  before: number
  /** Hashes of base blocks after+1 .. before-1 in order. [] = pure insertion (before === after + 1). */
  covers: BlockHash[]
  /** Replacement block sources, no surrounding gaps, doc EOL. [] = pure deletion. */
  blocks: string[]
}

/**
 * core/splice applyBlockOps result (§3.4). Deterministic, so the browser and the server get the same
 * text. `verified` is true iff `failed` is empty; `text` is always valid without the failed ops.
 */
export interface ApplyBlockOpsResult {
  text: string
  verified: boolean
  /** Ops that passed only after the widening ladder (D37): level 1 full-block render, 2 = ±1, 3 = ±2 neighbours. */
  widened: Array<{ op: number; level: 1 | 2 | 3 }>
  /** Indexes of ops that failed every ladder level; they were left out of `text`. */
  failed: number[]
  /** List-merge marker flips (D36). entry = base index of the flipped untouched list; null = inside the op's own new blocks. */
  flips: Array<{ op: number; entry: number | null }>
}

export interface BlockSide {
  /** Block index at the side's rev (before: fromRev, after: toRev). */
  index: number
  count: number
  /** Netting identity (§9.6, D33): chains are followed and dropped by hashes only, never by md. */
  hashes: BlockHash[]
  /** UTF-16 source offsets of the run at the side's rev (BOM-stripped text), [start, end). */
  start: number
  end: number
  /**
   * The run's markdown. Whole run when its length <= CHANGE_MD_CAP. Otherwise a WINDOW around the
   * changed region (the changed middle plus CHANGE_MD_CONTEXT chars each side), never a bare prefix (§7.1).
   */
  md: string
  /** Present iff `md` is a window: offset of md[0] within the full run text, and the full run length. */
  window?: { offset: number; total: number }
  /** The changed region alone exceeded CHANGE_MD_CAP, so `md` is cut. Full text: PendingInput.runText. */
  truncated?: true
}
export interface BlockChange {
  op: 'replace' | 'insert' | 'delete'
  before: BlockSide | null  // null for insert
  after: BlockSide | null   // null for delete
}

export interface BlockConflict {
  /**
   * 'conflict': the same block changed on both sides (§7.3). 'unsaveable': the op failed the whole splice
   * widening ladder (D37); base = theirs = the current disk text, mine = TJ's blocks (§7.4).
   */
  kind: 'conflict' | 'unsaveable'
  /** `conflict:` / `unsaveable:` + base block hash. Stable for the life of the entry. */
  id: `conflict:${string}` | `unsaveable:${string}`
  baseIndex: number
  /** Where theirs sits in the current map; null when theirs deleted the block. */
  currentIndex: number | null
  base: string
  mine: string | null       // null = TJ deleted it
  theirs: string | null     // null = deleted on disk
  theirsBy: Actor
  theirsRev: number
}

/** 'save' is a browser SaveRequest with cause 'edit'; 'merge' and 'recreate' map 1:1 (§3.9). */
export type RevCause =
  | 'baseline' | 'save' | 'accept' | 'undo-accept' | 'cli' | 'restore' | 'merge' | 'external' | 'recreate'
/**
 * doc.edit sources. TJ save/merge/recreate revs are TJ editor saves covered by the session flush ('editor'),
 * never by a doc.edit of their own (§4.3, §7.1). There is no 'merge' source.
 */
export type EditSource = 'editor' | 'cli' | 'accept' | 'undo-accept' | 'restore'

// =====================================================================================
// §3.2 Markdown core handle (core/md createMd(); P1 defines `interface Md extends MdHandle`)
// =====================================================================================

/**
 * Opaque view of core/md's `Md`. The concrete interface lives in core/md/index.ts (§3.2): editor, view, schema,
 * remark, parseDoc, mdastToDoc, serializeNodes, destroy (the members S2's load() uses, FINDINGS).
 */
export interface MdHandle {
  readonly schemaFingerprint: string
  readonly coreVersion: string
  /** true when created with `root` (a live EditorView in the browser), false when headless. */
  readonly live: boolean
}
/**
 * P2's hook into createMd({ extend }): receives the Milkdown Editor before create() and returns it with
 * view-only additions (plugins, node views, keymaps, input rules, view props). Must not alter node or mark
 * specs; createMd asserts the fingerprint afterwards (§3.2). Generic so this file stays import-free.
 */
export type MdExtend<E> = (editor: E) => E

// =====================================================================================
// §5 Anchors
// =====================================================================================

export interface TextAnchor {
  kind: 'text'
  /**
   * Exact ptext slice, 1..MAX_QUOTE_CHARS UTF-16 units. '' only for suggestion insertion points.
   * Long form (D45, §5.2): when the selected span exceeds MAX_QUOTE_CHARS, `quote` holds only its first
   * LONG_QUOTE_EDGE_CHARS units, `tail` its last LONG_QUOTE_EDGE_CHARS units and `span` its full length.
   */
  quote: string
  /** Long form only: the span's last LONG_QUOTE_EDGE_CHARS ptext units. Present iff `span` is. */
  tail?: string
  /** Long form only: full ptext length of the anchored span (> MAX_QUOTE_CHARS). Present iff `tail` is. */
  span?: number
  /** <= 32 ptext units immediately before (may cross block separators). */
  prefix: string
  /** <= 32 ptext units immediately after. */
  suffix: string
  hint: { rev: number; pos: number; block: number; blockHash: BlockHash; offsetInBlock: number }
}
/**
 * For atom blocks (§3.3: kind 'raw' or 'frontmatter', or mdType 'thematicBreak'; PM nodes raw_block,
 * frontmatter, hr), which have no ptext of their own. Block HTML is a raw_block after promotion (§3.4, D44).
 */
export interface BlockAnchor {
  kind: 'block'
  /** kind/mdType let resolution fall back without the old block map (§5.3, D35). */
  hint: { rev: number; block: number; blockHash: BlockHash; kind: BlockKind; mdType: MdType }
  preview: string
}
export interface DocAnchor { kind: 'doc' }
export type Anchor = TextAnchor | BlockAnchor | DocAnchor

export type ResolutionState = 'exact' | 'moved' | 'fuzzy' | 'detached' | 'doc'
export interface Resolution {
  state: ResolutionState
  /** ptext offsets at the current rev (text anchors). */
  from?: number
  to?: number
  /** Block index at the current rev. */
  block?: number
  /** Full tie between candidates: first taken, flagged, never detached (§5.3). */
  ambiguous?: true
}

/** CLI/agent-facing anchor summary. */
export interface AnchorView {
  state: 'ok' | 'fuzzy' | 'detached' | 'doc'
  block: BlockRef | null
  line: number | null
  /** The quote; for a long anchor `quote + ' … ' + tail` (§5.2). */
  quote: string
  ambiguous?: true
}

// =====================================================================================
// §6 Suggestions
// =====================================================================================

/** Display hunk, derived by the server: dmp diff of ptext(base) vs ptext(proposed), cleanupSemantic. */
export interface Hunk {
  del: string
  ins: string
  /** ptext offset at range.rev where `del` starts. */
  at: number
}

/** Canonical, source-level suggestion record. Server and CLI act on it without ProseMirror. */
export interface SuggestionBody {
  /** Block index hint [start, end) at range.rev. */
  range: { start: number; end: number; rev: number }
  /** Exact source of blocks start..end-1 including the gaps between them, excluding outer gaps. */
  base: string
  /** Exact replacement source in doc EOL. '' = delete the run (plus one adjacent gap). */
  proposed: string
  hunks: Hunk[]
}

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'stale' | 'withdrawn'
export type StaleReason = 'BASE_GONE' | 'AMBIGUOUS' | 'OVERLAP' | 'MERGE_HAZARD'

export interface Suggestion extends SuggestionBody {
  id: SuggestionId
  thread: ThreadId
  by: Author
  status: SuggestionStatus
  anchor: TextAnchor
  createdSeq: number
  updatedSeq: number
  decidedBy?: Author
  decidedSeq?: number
  staleReason?: StaleReason
  /** Current block run [start, end) of `base`, computed on read; null when stale. */
  located: { start: number; end: number } | null
}

// =====================================================================================
// §4 Sidecar v2 event log (<doc>.md.review.jsonl)
// =====================================================================================

export const SIDECAR_SCHEMA = 'mdr.sidecar/2' as const

export interface SidecarHeader {
  type: 'header'
  schema: typeof SIDECAR_SCHEMA
  docId: DocId
  file: string        // basename at creation (informational)
  createdAt: IsoTime
  createdBy: string   // "mdr/<version>"
  /** Present after `mdr doctor --compact`; seq gaps are legal only when this is set. */
  compacted?: { at: IsoTime; droppedLines: number }
}

export type EventType =
  | 'comment.add' | 'comment.reply' | 'comment.edit' | 'comment.delete'
  | 'thread.resolve' | 'thread.reopen' | 'thread.detach' | 'thread.reattach' | 'anchor.update'
  | 'suggestion.add' | 'suggestion.update' | 'suggestion.accept' | 'suggestion.reject'
  | 'suggestion.reopen' | 'suggestion.withdraw' | 'suggestion.rebase' | 'suggestion.stale'
  | 'doc.rev' | 'doc.edit' | 'doc.external' | 'doc.abort' | 'doc.missing'
  | 'ack' | 'read-marker' | 'handoff.sent' | 'handoff.consumed'
  | 'server.recovered' | 'log.repair' | 'policy.set'

export interface EventBase {
  /** Strictly +1 per line, assigned under the doc lock. Gaps legal only after compaction. */
  seq: number
  id: EventId
  type: EventType
  by: Actor
  at: IsoTime
  /** Doc rev in effect AFTER this event (doc.rev: the new rev). */
  rev: number
  /** Idempotency key (§4.7). All lines produced by one op share it. */
  key?: string
  /** Present on every line of a write batch that changes the .md: the rev/hash it commits (§4.6 WAL). */
  wal?: { rev: number; hash: Hash }
}

type Ev<T extends EventType, B extends Actor, P> = EventBase & { type: T; by: B } & P

export type SidecarEvent =
  | Ev<'comment.add', Author, { thread: ThreadId; comment: CommentId; anchor: Anchor; body: string }>
  | Ev<'comment.reply', Author, { thread: ThreadId; comment: CommentId; body: string }>
  | Ev<'comment.edit', Author, { comment: CommentId; body: string }>
  | Ev<'comment.delete', Author, { comment: CommentId }>
  | Ev<'thread.resolve', Author, { thread: ThreadId }>
  | Ev<'thread.reopen', Author, { thread: ThreadId }>
  | Ev<'thread.detach', 'TJ' | 'system', { thread: ThreadId; cause: 'deleted' | 'unresolvable' }>
  | Ev<'thread.reattach', 'system', { thread: ThreadId; anchor: TextAnchor | BlockAnchor }>
  | Ev<'anchor.update', 'TJ' | 'system', { thread: ThreadId; anchor: Anchor }>
  | Ev<'suggestion.add', Author, {
      thread: ThreadId; newThread: boolean; suggestion: SuggestionId
      /** Reason card message (Claude's --reason). Absent for TJ's editor suggestions. */
      comment?: CommentId; body?: string
      anchor: TextAnchor
    } & SuggestionBody>
  | Ev<'suggestion.update', Author, { suggestion: SuggestionId; anchor: TextAnchor } & SuggestionBody>
  | Ev<'suggestion.accept', Author, { suggestion: SuggestionId; resultRev: number }>
  | Ev<'suggestion.reject', Author, { suggestion: SuggestionId }>
  | Ev<'suggestion.reopen', 'TJ', { suggestion: SuggestionId; resultRev: number | null }>
  | Ev<'suggestion.withdraw', Author, { suggestion: SuggestionId }>
  | Ev<'suggestion.rebase', 'system', { suggestion: SuggestionId; anchor: TextAnchor } & SuggestionBody>
  | Ev<'suggestion.stale', 'system', { suggestion: SuggestionId; reason: StaleReason }>
  | Ev<'doc.rev', Actor, {
      prevRev: number | null; prevHash: Hash | null; hash: Hash; bytes: number; cause: RevCause
      clientId?: ClientId; saveId?: number
    }>
  | Ev<'doc.edit', Author, {
      source: EditSource; fromRev: number; toRev: number; changes: BlockChange[]
      cause?: { type: 'suggestion.accept' | 'suggestion.reopen' | 'restore'; id: string }
    }>
  | Ev<'doc.external', 'external', { fromRev: number; toRev: number; changes: BlockChange[] | null }>
  | Ev<'doc.abort', 'system', { abortedRev: number; reason: 'not-landed' | 'raced-external' }>
  | Ev<'doc.missing', 'external', { lastHash: Hash }>
  | Ev<'ack', 'Claude', { upTo: number; waiter?: WaiterId }>
  | Ev<'read-marker', 'TJ', { thread: ThreadId | null; upTo: number }>
  | Ev<'handoff.sent', 'TJ', { message: string | null; delivery: 'waiter' | 'latched' | 'clipboard' }>
  | Ev<'handoff.consumed', 'Claude' | 'system', { handoffs: number[]; via: 'waiter' | 'ack'; waiter?: WaiterId }>
  | Ev<'server.recovered', 'system', { what: 'torn-tail' | 'tj-session' | 'wal'; detail: string }>
  | Ev<'log.repair', 'system', { droppedBytes: number; quarantined?: string }>
  /** §9.9.1, D39: while suggestOnly, Claude's direct-edit ops fail SUGGEST_ONLY. Appended only on a change. */
  | Ev<'policy.set', Author, { suggestOnly: boolean }>

export type SidecarEventOf<T extends EventType> = Extract<SidecarEvent, { type: T }>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** What a store-internal writer hands the log: the store assigns seq, id, at, rev and wal. */
export type NewEvent = DistributiveOmit<SidecarEvent, 'seq' | 'id' | 'at' | 'rev' | 'wal'>
/**
 * What the handoff module hands DocStore.appendEvents: no `by`. The store derives it (§3.9):
 * handoff.sent -> 'TJ'; handoff.consumed via 'waiter' -> 'Claude', via 'ack' -> 'system'.
 */
export type HandoffEventInput = DistributiveOmit<
  SidecarEventOf<'handoff.sent' | 'handoff.consumed'>, 'seq' | 'id' | 'at' | 'rev' | 'wal' | 'by'>
  & { by?: never }

export interface Warning {
  code: WarningCode
  message: string
  thread?: ThreadId
  suggestion?: SuggestionId
  line?: number
}
export type WarningCode =
  | 'THREAD_DETACHED' | 'THREAD_FUZZY' | 'THREAD_AMBIGUOUS' | 'SUGGESTION_STALE' | 'SUGGESTION_REBASED'
  | 'VERSION_SKEW' | 'LEGACY_SIDECAR' | 'SIDECAR_REPAIRED' | 'SIDECAR_SEQ_GAP' | 'SIDECAR_INVALID_EVENT'
  | 'SIDECAR_LARGE' | 'HISTORY_LARGE' | 'NEEDS_RECOVERY'
  /** A thread was resolved while it still had pending or stale suggestions (§6.8, D31). */
  | 'RESOLVED_WITH_PENDING'
  /** applyBlockOps needed the widening ladder for an op (§3.4, D37). */
  | 'SPLICE_WIDENED'
  /** replace_block / delete_block picked by quote or line landed in a list, table or quote and shrank or removed all of it (§9.5). */
  | 'WHOLE_BLOCK_REPLACED'

// =====================================================================================
// §4.5 / §8 Folded review state (what the browser renders; the browser never folds)
// =====================================================================================

export interface Message {
  id: CommentId
  by: Author
  at: IsoTime
  body: string              // '' when deleted
  seq: number
  editedAt?: IsoTime
  deleted?: true
}

export interface Thread {
  id: ThreadId
  kind: 'comment' | 'suggestion' | 'doc'
  status: 'open' | 'resolved'
  /** Suggestion thread whose suggestions are all terminal and which has no replies: shown resolved. */
  autoResolved: boolean
  anchor: Anchor
  /** Last anchor that resolved, for the Detached section's original quote. */
  lastAnchor: Anchor
  resolution: Resolution
  detached: boolean
  createdBy: Author
  createdSeq: number
  lastSeq: number
  messages: Message[]
  suggestions: SuggestionId[]
  /** Claude messages/suggestions with seq > max(tjRead, tjReadByThread[id]). */
  unread: number
}

export interface Cursors {
  claudeAck: number
  tjRead: number
  tjReadByThread: Record<ThreadId, number>
}

export interface Presence {
  /**
   * connected = a waiter stream is open; grace = disconnected < WAITER_GRACE_MS ago, or `mdr open` / `mdr arm`
   * announced a loop (POST /api/agent/arm) less than WAITER_GRACE_MS ago; turn = the last waiter delivered a
   * handoff and exited, so Claude's turn is running and its loop re-arms when the turn ends. `turn` ends on a
   * waiter connect (-> connected), an arm (-> grace), a disarm (-> none), or TURN_IDLE_MS with no agent request
   * of any kind for the file (-> none) (§8.5, D48). Clicks in grace or turn are latched; the browser copies a
   * prompt only on none.
   */
  waiter: 'connected' | 'grace' | 'turn' | 'none'
  waiterId?: WaiterId
  since?: IsoTime
  graceUntil?: IsoTime
}

export interface ClaudeActivity {
  file: string
  state: 'idle' | 'waiting-pickup' | 'working' | 'replied'
  since: IsoTime
  /** Present iff state === 'waiting-pickup': the delivery of the handoff being waited on (badge copy, §8.5). */
  delivery?: 'waiter' | 'latched' | 'clipboard'
  lastSeenAt?: IsoTime
  unreadFromClaude: number
}

export interface ReviewPolicy {
  /** §9.9.1, D39: Claude may comment and suggest but not edit the .md directly. */
  suggestOnly: boolean
}

/**
 * Wire review state. P1's route layer builds it as `{ ...await store.review(), presence, activity }`
 * with presence/activity from the handoff module (§3.9). The store itself returns StoreReviewState.
 * GET /api/review is always 200 for a servable file; read-only states come back in `readOnly` (§8.3).
 */
export interface ReviewState {
  ok: true
  file: string
  rev: number
  seq: number
  /**
   * SIDECAR_CORRUPT: folded from the valid prefix. SIDECAR_SCHEMA_UNSUPPORTED: []. NOT_UTF8 /
   * TOO_LARGE: the full fold with every text anchor detached (§8.3).
   */
  threads: Thread[]
  suggestions: Suggestion[]
  cursors: Cursors
  presence: Presence
  activity: ClaudeActivity
  /** Unconsumed handoff seqs (latched for the next waiter). */
  undeliveredHandoffs: number[]
  policy: ReviewPolicy
  warnings: Warning[]
  readOnly: false | { code: ReadOnlyCode; message: string }
}
/** What DocStore.review() returns: no presence/activity (those belong to the handoff module). */
export type StoreReviewState = Omit<ReviewState, 'presence' | 'activity'>

// =====================================================================================
// §8 REST API: envelope and errors
// =====================================================================================

export const PROTOCOL = 2 as const

export type ErrorCode =
  | 'BAD_REQUEST' | 'USAGE' | 'IDENTITY_IN_BODY' | 'PAYLOAD_TOO_LARGE' | 'ACK_OUT_OF_RANGE'
  | 'UNAUTHORIZED' | 'FORBIDDEN_ORIGIN' | 'PROTECTED_ROOT' | 'PATH_OUTSIDE_ROOT' | 'NOT_AUTHOR'
  | 'SUGGEST_ONLY' | 'READ_ONLY' | 'UNANCHORABLE_TARGET'
  | 'FILE_NOT_FOUND' | 'DOC_GONE' | 'THREAD_NOT_FOUND' | 'COMMENT_NOT_FOUND' | 'SUGGESTION_NOT_FOUND'
  | 'VERSION_NOT_FOUND' | 'BLOCK_NOT_FOUND' | 'QUOTE_NOT_FOUND' | 'QUOTE_NOT_IN_SOURCE'
  | 'QUOTE_IN_PENDING_SUGGESTION'
  | 'QUOTE_AMBIGUOUS'
  | 'STALE_REVISION' | 'CONFLICT' | 'SUGGESTION_OVERLAP' | 'SUGGESTION_CLOSED' | 'SUGGESTION_STALE'
  | 'SUGGESTION_CHANGED_SINCE' | 'BLOCK_MERGE_HAZARD' | 'BATCH_SELF_CONFLICT' | 'ACK_CONFLICT'
  | 'SERVER_START_FAILED' | 'SERVER_UNREACHABLE' | 'ROOT_MISMATCH' | 'PORT_EXHAUSTED'
  | 'PROTOCOL_MISMATCH' | 'MISDIRECTED'
  | 'LOCK_TIMEOUT' | 'SIDECAR_CORRUPT' | 'SIDECAR_SCHEMA_UNSUPPORTED' | 'NOT_UTF8' | 'TOO_LARGE'
  | 'SUGGESTION_RESIDUE' | 'SPLICE_MISMATCH' | 'CONTRACT_MISMATCH' | 'IO_ERROR'
  | 'WAITER_SUPERSEDED' | 'SERVER_STOPPED' | 'DISARMED'
  | 'INTERNAL' | 'INTERRUPTED'

/** Normative code -> HTTP status -> CLI exit code table (§8.2, §9.1). http 0 = never on the wire. */
export const ERROR_TABLE: Readonly<Record<ErrorCode, { http: number; exit: number }>> = {
  BAD_REQUEST: { http: 400, exit: 3 },
  USAGE: { http: 0, exit: 3 },
  IDENTITY_IN_BODY: { http: 400, exit: 3 },
  PAYLOAD_TOO_LARGE: { http: 413, exit: 3 },
  ACK_OUT_OF_RANGE: { http: 400, exit: 3 },
  UNAUTHORIZED: { http: 401, exit: 4 },
  FORBIDDEN_ORIGIN: { http: 403, exit: 4 },
  PROTECTED_ROOT: { http: 403, exit: 4 },
  PATH_OUTSIDE_ROOT: { http: 403, exit: 4 },
  NOT_AUTHOR: { http: 403, exit: 4 },
  SUGGEST_ONLY: { http: 403, exit: 4 },
  READ_ONLY: { http: 422, exit: 4 },
  UNANCHORABLE_TARGET: { http: 422, exit: 4 },
  FILE_NOT_FOUND: { http: 404, exit: 5 },
  DOC_GONE: { http: 410, exit: 5 },
  THREAD_NOT_FOUND: { http: 404, exit: 5 },
  COMMENT_NOT_FOUND: { http: 404, exit: 5 },
  SUGGESTION_NOT_FOUND: { http: 404, exit: 5 },
  VERSION_NOT_FOUND: { http: 404, exit: 5 },
  BLOCK_NOT_FOUND: { http: 404, exit: 5 },
  QUOTE_NOT_FOUND: { http: 422, exit: 5 },
  QUOTE_NOT_IN_SOURCE: { http: 422, exit: 5 },
  QUOTE_IN_PENDING_SUGGESTION: { http: 422, exit: 5 },
  QUOTE_AMBIGUOUS: { http: 422, exit: 6 },
  STALE_REVISION: { http: 409, exit: 7 },
  CONFLICT: { http: 409, exit: 7 },
  SUGGESTION_OVERLAP: { http: 409, exit: 7 },
  SUGGESTION_CLOSED: { http: 409, exit: 7 },
  SUGGESTION_STALE: { http: 409, exit: 7 },
  SUGGESTION_CHANGED_SINCE: { http: 409, exit: 7 },
  BLOCK_MERGE_HAZARD: { http: 422, exit: 7 },
  BATCH_SELF_CONFLICT: { http: 422, exit: 7 },
  ACK_CONFLICT: { http: 409, exit: 7 },
  SERVER_START_FAILED: { http: 0, exit: 8 },
  /** wait only: the server stayed down until the deadline. Its own exit code so the waiter loop retries only this (D49). */
  SERVER_UNREACHABLE: { http: 0, exit: 11 },
  ROOT_MISMATCH: { http: 0, exit: 8 },
  PORT_EXHAUSTED: { http: 0, exit: 8 },
  PROTOCOL_MISMATCH: { http: 426, exit: 8 },
  MISDIRECTED: { http: 421, exit: 8 },
  LOCK_TIMEOUT: { http: 503, exit: 9 },
  SIDECAR_CORRUPT: { http: 500, exit: 9 },
  SIDECAR_SCHEMA_UNSUPPORTED: { http: 500, exit: 9 },
  NOT_UTF8: { http: 415, exit: 9 },
  TOO_LARGE: { http: 413, exit: 9 },
  SUGGESTION_RESIDUE: { http: 500, exit: 9 },
  SPLICE_MISMATCH: { http: 500, exit: 9 },
  CONTRACT_MISMATCH: { http: 409, exit: 9 },
  IO_ERROR: { http: 500, exit: 9 },
  WAITER_SUPERSEDED: { http: 0, exit: 10 },
  SERVER_STOPPED: { http: 0, exit: 10 },
  DISARMED: { http: 0, exit: 10 },
  INTERNAL: { http: 500, exit: 1 },
  INTERRUPTED: { http: 0, exit: 130 },
}

export interface QuoteCandidate {
  occurrence: number        // 1-based in doc order
  block: BlockRef
  line: number
  /** ~40 chars each side with the match wrapped in ⟦ ⟧. */
  context: string
  similarity?: number       // fuzzy near-misses only (shown, never applied)
}

export interface ApiErrorBody {
  code: ErrorCode
  message: string
  hint?: string
  /** batch: index of the failing op. */
  op?: number
  candidates?: QuoteCandidate[]
  /** QUOTE_NOT_IN_SOURCE: the exact source span whose ptext matched the quote. */
  sourceQuote?: string
  /** STALE_REVISION on positional refs: old ref -> current ref for targets whose block is unchanged. */
  remap?: Partial<Record<BlockRef, BlockRef>>
  conflicts?: BlockConflict[]
  suggestion?: SuggestionId
  thread?: ThreadId
  details?: Record<string, unknown>
}
export interface ApiError {
  ok: false
  error: ApiErrorBody
  /** Every STALE_REVISION / CONFLICT carries a fresh snapshot (and review state for the browser). */
  current?: DocSnapshot
  review?: ReviewState
}

// =====================================================================================
// §8.3 Browser routes (actor TJ)
// =====================================================================================

/**
 * Generalization pass (2026-10-16): who the human is, for display only. The stored actor id stays 'TJ' (Author);
 * node/identity.ts resolves the name: MDR_USER_NAME > config.json displayName > git user.name > macOS `id -F` > OS user
 * name > "You".
 */
export type DisplayNameSource = 'env' | 'config' | 'git' | 'os-full-name' | 'os-username' | 'default'
export interface UserIdentity {
  displayName: string
  source: DisplayNameSource
}
/** GET /api/me (browser route): the display name the page shows for the human. */
export interface MeResult {
  ok: true
  displayName: string
  source: DisplayNameSource
}

export interface Health {
  ok: true
  app: 'mdr'
  version: string
  protocol: typeof PROTOCOL
  schemaFingerprint: string
  root: string
  rootHash: Hash
  port: number
  pid: number
  serverId: string
  startedAt: IsoTime
}

export interface AnchorUpdate {
  thread: ThreadId
  /** null = the decorated range was fully deleted -> thread.detach{by:'TJ', cause:'deleted'}. */
  anchor: Anchor | null
}

export interface TjSuggestionUpsert {
  id: SuggestionId          // browser-minted (marks need it synchronously)
  /** Existing thread to attach to; absent = new suggestion thread. */
  thread?: ThreadId
  range: { start: number; end: number }   // block index hint at base.rev
  base: string
  proposed: string
  anchor: TextAnchor
}

export interface SaveRequest {
  clientId: ClientId
  /** Monotonic per clientId; (clientId, saveId) is the save's idempotency key. */
  saveId: number
  base: { rev: number; hash: Hash; blockHashes: BlockHash[] }
  ops: BlockOp[]
  /**
   * docHash(applyBlockOps(base, ops).text, snapshot.bom) as the client computed it: the doc-hash domain,
   * raw bytes WITH the BOM (§0.4, D40). Required iff ops.length > 0.
   */
  expectHash?: Hash
  /** Maps to doc.rev cause: 'edit' -> 'save', 'merge' -> 'merge', 'recreate' -> 'recreate' (§3.9). */
  cause: 'edit' | 'merge' | 'recreate'
  /** true for ordinary autosaves: non-conflicting ops apply, conflicting ones come back as conflicts. */
  allowPartial: boolean
  anchors?: AnchorUpdate[]
  /** Undo of a decision is NOT here: it is a reopen route, sent before the save (D26). */
  suggestions?: { upsert?: TjSuggestionUpsert[]; withdraw?: SuggestionId[] }
}
export interface SaveResponse {
  ok: true
  applied: 'direct' | 'merged' | 'noop' | 'duplicate'
  rev: number
  hash: Hash
  seq: number
  /** Non-empty only when allowPartial and some ops hit a block both sides changed. kind 'conflict'. */
  conflicts: BlockConflict[]
  /** Ops that failed the splice widening ladder; the rest of the save applied (D37). kind 'unsaveable'. */
  unsaveable: BlockConflict[]
  warnings: Warning[]
  /** Present iff applied === 'merged' or conflicts.length > 0: the client adopts it (§12.4). */
  rebased?: DocSnapshot
  /** Suggestions this save staled or rebased. */
  staled: SuggestionId[]
  rebasedSuggestions: SuggestionId[]
}

export interface CreateThreadRequest {
  opKey: OpKey
  /** Anchor as created in the browser at anchorRev; the server re-resolves if anchorRev < rev. */
  anchor: Anchor
  anchorRev: number
  body: string
}
export interface CreateThreadResponse { ok: true; thread: Thread; seq: number; duplicate?: true }
export interface ReplyRequest { opKey: OpKey; body: string }
export interface EditCommentRequest { opKey: OpKey; body: string }
export interface OpKeyRequest { opKey: OpKey }
export interface MessageResponse { ok: true; message: Message; seq: number; duplicate?: true }
export interface SeqResponse { ok: true; seq: number; duplicate?: true }
export interface ThreadOpResponse { ok: true; thread: Thread; seq: number; warnings?: Warning[]; duplicate?: true }
/** Decisions act on the server's current record; no baseRev (§6.6). */
export interface DecideRequest { opKey: OpKey }
export interface DecisionResult {
  ok: true
  suggestion: SuggestionId
  status: SuggestionStatus
  rev: number
  hash: Hash
  seq: number
  /** Blocks the decision changed (accept / reopen); [] for reject. */
  changes: BlockChange[]
  duplicate?: true
}
/**
 * accept/reject: sequential, one commit, per-id results (partial success allowed).
 * reopen (undo of a bulk entry, D26): `ids` required, `authors` ignored, ALL-OR-NOTHING: one commit, or
 * 409 SUGGESTION_CHANGED_SINCE with details.ids and nothing written.
 */
export type BulkDecisionRequest =
  | { opKey: OpKey; decision: 'accept' | 'reject'; authors: Author[]; ids?: SuggestionId[] }
  | { opKey: OpKey; decision: 'reopen'; authors: Author[]; ids: SuggestionId[] }
export interface BulkDecisionResult {
  ok: true
  rev: number
  hash: Hash
  seq: number
  results: Array<{ id: SuggestionId; ok: boolean; code?: ErrorCode; duplicate?: true }>
}
export interface ReadMarkerRequest { thread: ThreadId | null; upTo: number }
/** POST /api/flush: tab close (keepalive fetch on pagehide). Flushes the TJ session; never writes .md bytes (§7.1). */
export interface FlushRequest { clientId: ClientId; reason: 'beacon' }
/** POST /api/policy (TJ) and POST /api/agent/policy (Claude, with `file`): appends policy.set only on a change. */
export interface PolicyRequest { suggestOnly: boolean }
export interface HandoffRequest {
  opKey: OpKey
  message?: string          // <= MAX_HANDOFF_MESSAGE_CHARS
  /** What the click handler already did: 'clipboard' if it copied the prompt inside the gesture. */
  clientDecision: 'waiter' | 'clipboard'
  /**
   * QA3: the browser's Send. With no message and nothing since Claude's last ack (no comment, reply, suggestion,
   * decision, resolve, edit, outside write or notice), the server appends nothing and answers `nothingNew` instead of
   * waking Claude for an empty round. Absent = the plumbing's old behaviour.
   */
  onlyIfNew?: true
}
export interface HandoffResult {
  ok: true
  seq: number
  coalesced: boolean
  delivery: 'waiter' | 'latched' | 'clipboard'
  /**
   * buildClipboardPrompt with the server-computed round and pendingCounts (§9.10), always returned. Used by
   * the Copy message buttons (mismatch, undelivered); it may differ from the in-gesture copy, which has no round.
   */
  prompt: string
  presence: Presence
  /** QA3: `onlyIfNew` and nothing to send. No handoff was appended (`seq` is the latest one, 0 when none), nothing was delivered. */
  nothingNew?: true
}
/** What DocSession.handoff resolves to: the server result plus what THIS click did inside the gesture (§12.10). */
export type HandoffOutcome = HandoffResult & {
  clientDecision: HandoffRequest['clientDecision']
  /** true iff the in-gesture clipboard write resolved. Toasts say "copied" only when this is true. */
  copied: boolean
}
export interface RestoreRequest { opKey: OpKey; v: VersionId; baseRev: number }
export interface RestoreResponse {
  ok: true
  rev: number
  hash: Hash
  seq: number
  version: VersionMeta
  detached: ThreadId[]
  staled: SuggestionId[]
  /**
   * The doc after the restore, markdown included. The open editor adopts it through the §12.6 reload path
   * (restore is an explicit reload trigger, D47); the SSE echo of this commit is then dropped by echo rule 1.
   */
  snapshot: DocSnapshot
}

// =====================================================================================
// §10 History
// =====================================================================================

export type VersionCause =
  | 'baseline' | 'pre-write' | 'tj-session' | 'claude-write' | 'accept' | 'external' | 'restore' | 'shutdown'
export interface VersionMeta {
  v: VersionId
  n: number
  rev: number
  hash: Hash
  by: Actor
  cause: VersionCause
  at: IsoTime
  size: number
  /** Revs this version summarises (a TJ session covers several). */
  revs: [number, number]
  blocksChanged: number
  restoredFrom?: VersionId
}
export interface HistoryList { ok: true; via?: Via; file: string; versions: VersionMeta[]; currentRev: number; currentHash: Hash; unsnapshotted: boolean }
export interface VersionShow { ok: true; via?: Via; meta: VersionMeta; markdown: string }
export type HistoryRef = VersionId | `rev:${number}` | 'current'
export interface DiffBlock {
  op: 'equal' | 'replace' | 'insert' | 'delete'
  before?: string
  after?: string
  /** Authors of the intermediate versions in (from, to] that touched this block. */
  by: Actor[]
  lastBy: Actor | null
  /** Word-level dmp diff for 'replace'. */
  inline?: Array<[op: -1 | 0 | 1, text: string]>
}
export interface HistoryDiff {
  ok: true
  via?: Via
  from: VersionMeta | { current: true; rev: number; hash: Hash }
  to: VersionMeta | { current: true; rev: number; hash: Hash }
  blocks: DiffBlock[]
}

// =====================================================================================
// §8.6 Browser SSE (GET /api/events)
// =====================================================================================

/**
 * A file channel gets every event; a root channel (no `file`, §8.6) gets only navigate and server-shutdown.
 * doc-changed / sidecar-changed carry the X-MDR-Client-Id of the browser request that caused the commit (D32).
 */
export type BrowserSseEvent =
  | { event: 'hello'; data: { serverId: string; protocol: typeof PROTOCOL; version: string; schemaFingerprint: string; file: string; docId: DocId | null; rev: number; hash: Hash; seq: number; presence: Presence; activity: ClaudeActivity } }
  | { event: 'doc-changed'; data: { file: string; rev: number; prevRev: number; hash: Hash; by: Actor; cause: RevCause; clientId?: ClientId; saveId?: number; changes: BlockChange[]; markdown?: string } }
  | { event: 'sidecar-changed'; data: { file: string; fromSeq: number; seq: number; types: EventType[]; clientId?: ClientId } }
  | { event: 'presence'; data: Presence & { file: string } }
  | { event: 'handoff'; data: { file: string; seq: number; state: 'sent' | 'latched' | 'consumed' | 'undelivered'; delivery: 'waiter' | 'latched' | 'clipboard' } }
  | { event: 'claude-activity'; data: ClaudeActivity }
  | { event: 'navigate'; data: { file: string } }
  | { event: 'doc-removed'; data: { file: string } }
  | { event: 'resync'; data: { reason: 'gap' | 'restart' | 'skew' } }
  | { event: 'server-shutdown'; data: { reason: 'stop' | 'restart' | 'signal' } }

/**
 * §8.7 Waiter SSE (GET /api/agent/wait?file&waiter&gen). Heartbeat `: hb` comments every SSE_HEARTBEAT_MS.
 * `superseded` ends the process with exit 10 for either reason: 'newer-waiter' = a different waiter id
 * connected for this doc; 'replaced' = a connect with the SAME id and a higher-or-equal gen took over
 * (or this connect's gen was lower and was refused).
 */
export type WaiterSseEvent =
  | { event: 'armed'; data: { waiter: WaiterId; file: string; undelivered: number[] } }
  | { event: 'handoff'; data: HandoffPayload }
  | { event: 'superseded'; data: { by: WaiterId; reason: 'newer-waiter' | 'replaced' } }
  | { event: 'disarmed'; data: { file: string } }
  | { event: 'server-shutdown'; data: { reason: 'stop' | 'restart' | 'signal' } }

// =====================================================================================
// §8.4 / §9 Agent routes and CLI JSON (actor Claude)
// =====================================================================================

export type CliOk<T> = { ok: true } & T
export interface CliErr { ok: false; error: ApiErrorBody; current?: DocSnapshot }

/** Positional selectors are strict (§7.5). Quote selectors match markdown SOURCE bytes (§5.5). */
export type BlockSel =
  | { ref: BlockRef; rev: number }
  | { line: number; rev: number }
  | { quote: string; occurrence?: number }

/** Disambiguation hint for a quote. Positional, so it carries a rev: stale -> STALE_REVISION + remap (§5.5, D3). */
export type NearHint = { ref: BlockRef; rev: number }

/**
 * suggest / suggest_block on a run containing an atom block -> 422 UNANCHORABLE_TARGET (§6.2).
 * While policy.suggestOnly: replace_block, replace_range, insert_*, delete_block, write and
 * decide(accept) -> 403 SUGGEST_ONLY for the whole batch (§9.9.1).
 */
export type AgentOp =
  | { op: 'comment'; quote: string; occurrence?: number; near?: NearHint; body: string; key?: string }
  | { op: 'comment'; doc: true; body: string; key?: string }
  | { op: 'comment'; block: BlockSel; body: string; key?: string }
  | { op: 'reply'; thread: ThreadId; body: string; key?: string }
  | { op: 'suggest'; quote: string; replace: string; reason?: string; thread?: ThreadId; occurrence?: number; near?: NearHint; key?: string }
  | { op: 'suggest_block'; target: BlockSel; markdown: string; reason?: string; thread?: ThreadId; key?: string }
  | { op: 'replace_block'; target: BlockSel; markdown: string; key?: string }
  | { op: 'replace_range'; from: BlockSel; to: BlockSel; markdown: string; key?: string }
  | { op: 'insert_after' | 'insert_before'; target: BlockSel; markdown: string; key?: string }
  | { op: 'delete_block'; target: BlockSel; key?: string }
  | { op: 'write'; markdown: string; baseRev: number; key?: string }
  | { op: 'resolve'; thread: ThreadId; body?: string; key?: string }
  | { op: 'reopen'; thread: ThreadId; key?: string }
  | { op: 'edit_comment'; comment: CommentId; body: string; key?: string }
  | { op: 'delete_comment'; comment: CommentId; key?: string }
  | { op: 'withdraw'; suggestion: SuggestionId; key?: string }
  | { op: 'decide'; suggestion: SuggestionId; decision: 'accept' | 'reject'; key?: string }

export interface BatchRequest {
  ops: AgentOp[]
  /** Applied LAST, in the same request, after every op. */
  ack?: number
  /** Compare-and-swap for ack: the `since` this caller saw in pending; mismatch -> ACK_CONFLICT (not for a retry whose ops all landed: that replays the first answer, §4.7). */
  ackSince?: number
  dryRun?: boolean
  waiter?: WaiterId
}
export interface BatchOpResult {
  i: number
  op: AgentOp['op']
  key: string
  duplicate?: true
  noop?: true
  thread?: ThreadId
  comment?: CommentId
  suggestion?: SuggestionId
  anchor?: AnchorView
  hunks?: Array<{ del: string; ins: string }>
  changes?: Array<{ op: 'replace' | 'insert' | 'delete'; block: BlockRef | null; line: number | null }>
}
export interface BatchResult {
  ok: true
  via: Via
  file: string
  rev: number
  hash: Hash
  seq: number
  noop: boolean
  dryRun?: true
  results: BatchOpResult[]
  acked: number | null
  /** Handoff seqs this ack consumed. */
  consumed: number[]
  warnings: Warning[]
}

export interface AgentSnapshot {
  ok: true
  via: Via
  file: string
  abs: string
  rev: number
  hash: Hash
  eol: Eol
  bom: boolean
  blocks: Array<{ ref: BlockRef; type: MdType; kind: BlockKind; line: number; endLine: number; hash: BlockHash; md?: string; text?: string }>
  threads: Array<{ id: ThreadId; kind: Thread['kind']; status: Thread['status']; anchor: AnchorView; by: Author; replies: number }>
  suggestions: Array<{ id: SuggestionId; thread: ThreadId; by: Author; status: SuggestionStatus; block: BlockRef | null; line: number | null; hunks: Array<{ del: string; ins: string }> }>
}

export type PendingActivity =
  | 'created' | 'replied' | 'edited' | 'deleted' | 'resolved' | 'reopened' | 'suggested' | 'revised'
  | 'accepted' | 'rejected' | 'withdrawn' | 'reopened-suggestion' | 'detached' | 'reattached'
/** A display hunk as `pending` reports it (§9.6): the text, plus where it sits in the source (QA round 1, confirmed 20). */
export interface PendingHunk {
  del: string
  ins: string
  /** Source text just before an insertion (a pure insertion only; up to 40 characters). */
  before?: string
  /** Source text just after an insertion. */
  after?: string
  /** The table cell the hunk sits in, e.g. `row “BAR”, column “Rate”`. */
  cell?: string
}
/** What a suggestion whose hunks carry no text does (mark-only, structure-only or a split), e.g. `Bold: member`. */
export interface PendingChange {
  kind: 'format' | 'structure'
  detail: string
}
export interface PendingThread {
  id: ThreadId
  kind: Thread['kind']
  status: Thread['status']
  anchor: AnchorView
  activity: PendingActivity[]
  /** Whole thread for context; items new since `since` are flagged. */
  messages: Array<{ id: CommentId; by: Author; at: IsoTime; body: string; new?: true; edited?: true; deleted?: true }>
  suggestions: Array<{
    id: SuggestionId; by: Author; status: SuggestionStatus; new?: true; decidedBy?: Author; block: BlockRef | null; line: number | null
    hunks: PendingHunk[]
    /** Present when the hunks carry no text: what the change is (a format or structure change). */
    change?: PendingChange
  }>
}
export interface PendingEdit {
  by: 'TJ' | 'external'
  /**
   * Distinct doc.edit sources netted into this entry ([] for external). Only 'editor' and 'restore' occur:
   * TJ 'accept' / 'undo-accept' edits are excluded because the decision is reported on its thread (§9.6).
   */
  sources: Array<'editor' | 'restore'>
  fromRev: number
  toRev: number
  blocks: Array<{
    op: 'replace' | 'insert' | 'delete'
    block: BlockRef | null    // current ref (null when deleted)
    line: number | null
    /** partial: a history object was gone, so the text comes from stored windows only (§9.6, D33). */
    change: { format: 'full'; before: string | null; after: string | null; partial?: true } | { format: 'diff'; diff: string; partial?: true }
  }>
}
export interface PendingNotice {
  type: 'suggestion.stale' | 'suggestion.rebase' | 'thread.detach' | 'thread.reattach'
  suggestion?: SuggestionId
  thread?: ThreadId
  reason: string
}
/** `edits` / `external` count changed BLOCKS after netting, across the respective lists (summarize(), §9.10). */
export interface PendingCounts {
  threads: number; messages: number; suggestions: number; decisions: number; resolves: number
  edits: number; external: number; notices: number; handoffs: number
}
export interface PendingResult {
  ok: true
  via: Via
  file: string
  abs: string
  rev: number
  hash: Hash
  /** Claude's ack cursor when this was read. */
  since: number
  /** Highest seq folded into this result: pass to `ack` (with ackSince = since). */
  cursor: number
  empty: boolean
  handoffs: Array<{ seq: number; at: IsoTime; message: string | null }>
  threads: PendingThread[]
  edits: PendingEdit[]      // TJ only, netted per block chain
  external: PendingEdit[]   // external only, netted, never merged with TJ's
  notices: PendingNotice[]
  counts: PendingCounts
  warnings: Warning[]
  /** The human's display name (server routes and the CLI add it; the stored actor id is still 'TJ'). */
  user?: UserIdentity
}

export interface ThreadDetail {
  ok: true
  via: Via
  thread: {
    id: ThreadId; kind: Thread['kind']; status: Thread['status']
    anchor: AnchorView & { context: string /* the anchored block's markdown */ }
    messages: Array<{ id: CommentId; by: Author; at: IsoTime; body: string; editedAt?: IsoTime; deleted?: true }>
    suggestions: Array<{ id: SuggestionId; by: Author; status: SuggestionStatus; base: string; proposed: string; hunks: Hunk[]; block: BlockRef | null; line: number | null; staleReason?: StaleReason }>
  }
}

export interface ServerInfo {
  state: 'up' | 'down'
  port: number | null
  url: string | null
  pid?: number
  version?: string
  protocol?: number
}
export interface StatusResult {
  ok: true
  via: Via
  file: string
  abs: string
  root: string
  server: ServerInfo
  rev: number
  hash: Hash
  seq: number
  threads: { open: number; resolved: number; detached: number }
  suggestions: { pending: number; stale: number }
  pendingCount: number
  cursor: { ack: number; latest: number }
  presence: Presence
  /** null in direct mode (no handoff module). */
  activity: ClaudeActivity | null
  handoff: { undelivered: number[] }
  policy: ReviewPolicy
  legacySidecar: boolean
  needsRecovery: boolean
  readOnly: false | { code: ReadOnlyCode; message: string }
  warnings: Warning[]
  /** The human's display name (server routes and the CLI add it; the stored actor id is still 'TJ'). */
  user?: UserIdentity
}

/** <root>/.review/server.json, mode 0600. Discovery fast path only; health is authoritative. */
export interface ServerMarker {
  app: 'mdr'
  root: string
  rootHash: Hash
  port: number
  pid: number
  serverId: string
  version: string
  protocol: typeof PROTOCOL
  startedAt: IsoTime
  /** Bearer token, stable across restarts of the same root (reused when the marker's root matches). */
  token: string
}

export interface PortResult { ok: true; root: string; formulaPort: number; port: number | null; state: 'up' | 'free' | 'exhausted' }
export interface ServeResult { ok: true; root: string; port: number; url: string; pid: number; adopted: boolean; restarted?: true }
export interface StopResult { ok: true; root: string; stopped: boolean; port: number | null }
/** `mdr stop --all`: every mdr server answering health on the port windows (PORT_BASE .. +PORT_SPAN+PORT_PROBE). */
export interface StopAllResult {
  ok: true
  all: true
  stopped: Array<{ root: string; port: number; pid: number }>
  failed: Array<{ root: string; port: number; code: ErrorCode; message: string }>
}
/** `mdr --version`. */
export interface VersionResult { ok: true; version: string }
/** `mdr config get|set|unset`: the config file and what is in effect. */
export interface ConfigResult {
  ok: true
  path: string
  config: { displayName?: string; protectedSegments?: string[]; tourDone?: boolean }
  user: UserIdentity
  protectedSegments: { segments: string[]; source: 'env' | 'config' | 'default' }
  /** 'offer' until Claude has offered the 2-minute tour once (the skill offers it on the first-ever review). */
  tour: 'offer' | 'done'
}

/** `mdr open --offer-tour` on the first-ever review: nothing was opened; offer the tour, then open or tour. */
export interface TourOfferResult {
  ok: true
  tour: 'offer'
  opened: false
  file: string
  abs: string
  root: string
  user: UserIdentity
}

/** `mdr tour`: the practice doc was copied and its cards posted; the rest is exactly `mdr open`'s result. */
export interface TourResult extends OpenResult {
  /** threads: the six cards' thread ids in document order (accept, reject, reply, Editing, comment, Send). */
  tour: { folder: string; cards: number; threads: string[] }
}

/**
 * The background waiter the skill starts (§9.8, D1). Printed by `mdr open` and `mdr arm` as `waiter`;
 * null when the clipboard is primary (the final-build S1 re-run failed, §0.1).
 */
export interface WaiterSpec {
  v: 2
  root: string
  file: string              // relative to root
  abs: string
  port: number
  /** Minted per spec; baked into `command` as `--waiter <id>`. presence.waiterId equals it while the loop is attached. */
  waiter: WaiterId
  /**
   * The exact shell line the skill runs with Bash `run_in_background: true`. It re-runs
   * `<node> <cli.js> wait <abs> --root <root> --waiter <id> --timeout WAIT_DEFAULT_TIMEOUT_S` on exit 2
   * (and on exit 11, SERVER_UNREACHABLE, after 5 s), prints only the final WaitResult or CliErr line, and exits
   * with its code. Every other code, including a non-retryable exit 8 (PROTOCOL_MISMATCH, ROOT_MISMATCH),
   * ends the loop at once (§9.8.1, D49).
   */
  command: string
}
export interface OpenResult {
  ok: true
  via: 'server'
  file: string
  abs: string
  root: string
  port: number
  url: string               // http://127.0.0.1:<port>/?file=<encodeURIComponent(rel)>
  rev: number
  connectedTabs: number
  navigated: boolean
  waiter: WaiterSpec | null
  /** Why `waiter` is null (clipboard-primary build, or no POSIX shell on Windows); absent when a spec was printed. */
  waiterReason?: string
  presence: Presence
  /** After applying --suggest-only / --allow-edits, if given. */
  policy: ReviewPolicy
  /** The human's display name: address them by it. */
  user?: UserIdentity
  /** Present with --launch: true when the system browser was started (no tab was connected to navigate). */
  launched?: boolean
}
export interface ArmResult {
  ok: true
  waiter: WaiterSpec | null
  /** Why `waiter` is null; absent when a spec was printed. */
  waiterReason?: string
  /** presence.waiter === 'connected' (some waiter is attached to this doc). The skill starts a loop only when its own has exited (§9.9). */
  attached: boolean
  presence: Presence
  server: ServerInfo
  policy: ReviewPolicy
}
export interface DisarmResult { ok: true; file: string; disarmed: boolean }
/**
 * POST /api/agent/arm { file } (P4 handoff module; sent by `mdr open` and `mdr arm` right before they print a
 * WaiterSpec). Presence `turn` or `none` -> `grace` for WAITER_GRACE_MS, so a click while the loop starts is
 * latched, and a loop that never connects falls back to `none` (§8.5, D48). `connected` is unchanged.
 */
export interface ArmRouteResult { ok: true; presence: Presence }

export interface HandoffPayload {
  file: string
  abs: string
  root: string
  port: number
  url: string
  /** Every unconsumed handoff, oldest first; consumed together. */
  handoffs: Array<{ seq: number; at: IsoTime; message: string | null }>
  /** Round ordinal of the NEWEST handoff in `handoffs`: count of non-void handoff.sent with seq <= it (§9.10). */
  round: number
  rev: number
  counts: PendingCounts
  waiter: WaiterId
  /** The human's display name, for the wake prompt (servers before the generalization pass omit it). */
  who?: string
}

/** shared/handoff-prompt.ts buildWakePrompt input (§9.10). HandoffPayload satisfies it structurally. */
export interface WakePromptInput {
  file: string
  abs: string
  root: string
  /** Server-computed round ordinal; null when the browser builds the prompt inside the click gesture. */
  round: number | null
  /** Omitted -> summary "new items". */
  counts?: PendingCounts
  /** Who sent it (the display name). Omitted -> "TJ", today's text. */
  who?: string
  /** The command Claude runs (MDR_CMD). Omitted -> "mdr". */
  cmd?: string
}
export type WaitResult =
  /** prompt = buildWakePrompt(payload) (§9.10). */
  | { ok: true; status: 'handoff'; payload: HandoffPayload; prompt: string }
  | { ok: true; status: 'timeout'; file: string; waitedMs: number }

export interface DoctorResult {
  ok: true
  file: string
  sidecar: { exists: boolean; bytes: number; lines: number; seqGaps: number[]; corruptLines: number[]; tornTail: boolean; schema: string | null }
  history: { versions: number; bytes: number; orphanObjects: number }
  actions: Array<'repaired-tail' | 'quarantined' | 'compacted' | 'gc'>
  warnings: Warning[]
}

// =====================================================================================
// §3.9 / §9.3 seam: DocStore (P1 implements; server routes and CLI direct mode call it)
// =====================================================================================

export type FlushReason = 'idle' | 'foreign-write' | 'handoff' | 'agent-read' | 'shutdown' | 'beacon' | 'recovery'

/** clientId = the X-MDR-Client-Id of the browser request that caused the commit (D32); absent otherwise. */
export type StoreChange =
  | { kind: 'doc'; rev: number; prevRev: number; hash: Hash; by: Actor; cause: RevCause; clientId?: ClientId; saveId?: number; changes: BlockChange[] }
  | { kind: 'sidecar'; fromSeq: number; seq: number; events: SidecarEvent[]; clientId?: ClientId }
  | { kind: 'removed' }

/** Per-request context for TJ-surface store calls (D32). */
export interface TjCtx { clientId?: ClientId }

export interface OpenDocStoreOptions {
  mode: 'server' | 'direct'
  /** Lock acquisition timeout: LOCK_TIMEOUT_SERVER_MS or LOCK_TIMEOUT_CLI_MS. */
  lockTimeoutMs: number
  /** Never locks, never writes, never runs recovery; reports needsRecovery instead. */
  readOnly?: boolean
}

export interface AgentSnapshotQuery { md?: boolean; text?: boolean; from?: BlockRef; to?: BlockRef }

/** One non-void handoff.sent as the fold sees it (§4.5, §8.5, §9.10, D46). */
export interface HandoffRecord {
  seq: number
  at: IsoTime
  /** null = no message. Capped at MAX_HANDOFF_MESSAGE_CHARS. */
  message: string | null
  delivery: 'waiter' | 'latched' | 'clipboard'
  /** 1-based ordinal among all non-void handoff.sent lines of the doc (the fold's round). Stable across restarts. */
  round: number
  /** Covered by a handoff.consumed, or by an ack with upTo >= seq (§8.5). */
  consumed: boolean
}

export interface DocStore {
  readonly root: string
  readonly file: string
  readonly abs: string
  readonly mode: 'server' | 'direct'
  snapshot(): Promise<DocSnapshot>
  /**
   * Routes overlay presence/activity to make the wire ReviewState (§3.9). Never throws for SIDECAR_CORRUPT /
   * SIDECAR_SCHEMA_UNSUPPORTED / NOT_UTF8 / TOO_LARGE: returns readOnly plus what can be folded (§8.3).
   */
  review(): Promise<StoreReviewState>
  /** TJ surface (browser routes only). */
  save(req: SaveRequest, ctx?: TjCtx): Promise<SaveResponse>
  tj: {
    createThread(req: CreateThreadRequest, ctx?: TjCtx): Promise<CreateThreadResponse>
    reply(thread: ThreadId, req: ReplyRequest, ctx?: TjCtx): Promise<MessageResponse>
    editComment(comment: CommentId, req: EditCommentRequest, ctx?: TjCtx): Promise<MessageResponse>
    deleteComment(comment: CommentId, req: OpKeyRequest, ctx?: TjCtx): Promise<SeqResponse>
    resolve(thread: ThreadId, req: OpKeyRequest, ctx?: TjCtx): Promise<ThreadOpResponse>
    reopen(thread: ThreadId, req: OpKeyRequest, ctx?: TjCtx): Promise<ThreadOpResponse>
    decide(suggestion: SuggestionId, decision: 'accept' | 'reject', req: DecideRequest, ctx?: TjCtx): Promise<DecisionResult>
    reopenSuggestion(suggestion: SuggestionId, req: DecideRequest, ctx?: TjCtx): Promise<DecisionResult>
    /** decision 'reopen' is the atomic bulk undo (D26). */
    bulkDecide(req: BulkDecisionRequest, ctx?: TjCtx): Promise<BulkDecisionResult>
    readMarker(req: ReadMarkerRequest, ctx?: TjCtx): Promise<SeqResponse>
    restore(req: RestoreRequest, ctx?: TjCtx): Promise<RestoreResponse>
    setPolicy(req: PolicyRequest, ctx?: TjCtx): Promise<SeqResponse>
  }
  /** Claude surface (agent routes and CLI direct mode only). */
  agent: {
    status(): Promise<Omit<StatusResult, 'server' | 'presence' | 'activity'>>
    snapshot(q: AgentSnapshotQuery): Promise<AgentSnapshot>
    /** Throws SIDECAR_CORRUPT / SIDECAR_SCHEMA_UNSUPPORTED (it can't promise nothing missing). */
    pending(): Promise<PendingResult>
    thread(id: ThreadId): Promise<ThreadDetail>
    /** Computes every op's idempotency key itself, under the lock (§4.7). */
    batch(req: BatchRequest): Promise<BatchResult>
    setPolicy(req: PolicyRequest): Promise<{ ok: true; seq: number; suggestOnly: boolean }>
  }
  history: {
    list(o?: { limit?: number }): Promise<HistoryList>
    show(v: VersionId): Promise<VersionShow>
    diff(from: HistoryRef, to: HistoryRef): Promise<HistoryDiff>
  }
  /**
   * Append handoff events under the lock (handoff module only). The store derives `by`; other types throw
   * INTERNAL. ctx carries the browser clientId for handoff.sent (D32).
   */
  appendEvents(events: HandoffEventInput[], ctx?: TjCtx): Promise<{ seq: number; events: SidecarEvent[] }>
  /**
   * Every non-void handoff.sent, oldest first, with its round and consumed flag (D46). `unconsumed: true` keeps
   * only the unconsumed ones. Read-only: never flushes, never takes the lock beyond revalidating the cached fold,
   * and works on a readOnly store. The handoff module's source for HandoffPayload.handoffs/round, coalescing,
   * the undelivered timer and HandoffResult.prompt, including after a server restart.
   */
  handoffs(o?: { unconsumed?: boolean }): Promise<HandoffRecord[]>
  /** 'beacon' comes from POST /api/flush (pagehide) or the server's BEACON_GRACE_MS timer after the last SSE stream closes (§7.1). */
  flushTjSession(reason: FlushReason): Promise<void>
  onChange(cb: (c: StoreChange) => void): Unsubscribe
  close(): Promise<void>
}
export type OpenDocStore = (root: string, file: string, opts: OpenDocStoreOptions) => Promise<DocStore>

// =====================================================================================
// §8.5 seam: handoff module (P4 implements; P1's server/app.ts mounts it)
// =====================================================================================

/** Agent route names reported to the handoff module (§8.5). */
export type AgentRoute =
  | 'status' | 'pending' | 'thread' | 'snapshot' | 'batch' | 'history' | 'open' | 'policy'
  | 'wait' | 'consume' | 'disarm' | 'shutdown' | 'arm'
/** Content routes: the only ones that count as "Claude is working". Everything else is a control route. */
export const AGENT_CONTENT_ROUTES: readonly AgentRoute[] = ['pending', 'thread', 'snapshot', 'batch', 'history']

export interface HandoffDeps {
  root: string
  rootHash: Hash
  port: number
  /** Opens (cached) the DocStore for a file; the same instance the routes use. */
  store(file: string): Promise<DocStore>
  /** Push to every browser SSE client of `file`. */
  broadcast(file: string, e: BrowserSseEvent): void
  /** Fires after every sidecar append (any writer, including direct-mode CLI writes the watcher adopts). */
  onSidecarAppended(cb: (file: string, events: SidecarEvent[]) => void): Unsubscribe
  /** Fires on every /api/agent/* request with its route; only AGENT_CONTENT_ROUTES drive 'working' (§8.5). */
  onAgentRequest(cb: (file: string | null, route: AgentRoute) => void): Unsubscribe
  pendingCounts(file: string): Promise<PendingCounts>
}
/** `R` is the Hono app type; generic so this file stays import-free. */
export interface HandoffModule<R = unknown> {
  routes: R
  presence(file: string): Presence
  activity(file: string): ClaudeActivity
  /**
   * Optional (P4 merge, CONTRACT_CHANGES.md): send `server-shutdown { reason }` to every open waiter stream and close
   * each once its queue has drained (<= 250 ms). RunningServer.close calls it first, then awaits close(), which waits
   * for the drain; without it a `stop` sent just before the socket closes is lost and `wait` exits 11, not 10.
   */
  shutdown?(reason: 'stop' | 'restart' | 'signal'): void | Promise<void>
  /**
   * Optional (QA3, contract-changes/qa3-cli-handoff.md): `GET /api/agent/pending` was answered for `file`; `empty` is the
   * result's `empty`. An empty read means Claude looked and found nothing (the skill ends the turn without an ack), so
   * the activity the read moved to `working` is put back.
   */
  pendingServed?(file: string, empty: boolean): void
  close(): Promise<void>
}
export type CreateHandoffModule<R = unknown> = (deps: HandoffDeps) => HandoffModule<R>

// =====================================================================================
// §9.2.1 seam: startServer (P1 server/index.ts implements; P4 `mdr serve --foreground` calls it)
// =====================================================================================

export interface StartServerOptions {
  /** realId(root) (realpath, NFC). startServer re-runs the protected-root guard. */
  root: string
  /** Exact port to bind on 127.0.0.1. Busy -> rejects PORT_EXHAUSTED; never takes over. */
  port: number
  /** Inject <meta name="mdr-test-hooks" content="1"> and honour MDR_TEST_* overrides (MDR_TEST_HOOKS=1, e2e only). */
  testHooks?: boolean
}
export interface RunningServer {
  root: string
  port: number
  url: string               // http://127.0.0.1:<port>/
  pid: number
  serverId: string
  /** The marker this server wrote (server/marker.ts is the only writer). */
  marker: ServerMarker
  /** Broadcast server-shutdown, flush TJ sessions, close stores, remove the marker iff it is still ours, unbind. */
  close(reason: 'stop' | 'restart' | 'signal'): Promise<void>
  /** Resolves once the server has closed for any reason (a stop route, the idle exit, close()). */
  done?: Promise<void>
}
export type StartServer = (o: StartServerOptions) => Promise<RunningServer>

/** core/pending/digest.ts (P4): pure. P1's DocStore.agent.pending() gathers the input. */
export interface PendingInput {
  file: string
  abs: string
  rev: number
  hash: Hash
  via: Via
  /** Full non-void log, seq order. */
  events: SidecarEvent[]
  /** Folded at the same seq. */
  review: StoreReviewState
  /** Current block map (for refs and lines). */
  blocks: BlockInfo[]
  /**
   * Full source slice [start, end) of the doc as it was at `rev`, served from objects P1 pre-read under the
   * lock (every rev a windowed or multi-link side in the window references). null = object gone (§9.6, D33).
   */
  runText(rev: number, start: number, end: number): string | null
}
export type BuildPending = (input: PendingInput) => PendingResult

// =====================================================================================
// §11 Rail layout engine (core/rail/layout.ts, P3, pure)
// =====================================================================================

export interface RailCardInput {
  id: ThreadId | `conflict:${string}` | `unsaveable:${string}`
  /** px from the shared scroll container's content top to the anchor's first line top: exactly AnchorRect.top (§12.0.3). */
  anchorY: number
  /** Stable tiebreak: ptext offset of the anchor start. */
  order: number
  /** Last ResizeObserver height, px. */
  height: number
  /** One-line preview height, px. */
  collapsedHeight: number
  /** Focused composer, unsent draft, or a decision in flight: never collapsed. */
  pinExpanded?: boolean
}
export interface RailLayoutInput {
  /** Any order. Detached, doc-level and unplaced items are NOT passed. */
  cards: RailCardInput[]
  activeId: string | null
  gap: number                    // RAIL_GAP
  minTop: number                 // bottom of the rail header panel
  collapseDisplacement: number   // RAIL_COLLAPSE_DISPLACEMENT
  cluster: { maxAnchorGap: number; minRun: number }  // RAIL_CLUSTER_*
}
export interface RailPlacement {
  id: string
  top: number
  height: number            // effective height used (full or collapsed)
  collapsed: boolean
  displacement: number      // top - anchorY
}
export interface RailLayoutOutput {
  placements: RailPlacement[]   // sorted by (anchorY, order, id); excludes overflowAbove ids
  /** Cards above the active card that cannot fit at or below minTop: one "+N above" chip at minTop. */
  overflowAbove: string[]
  height: number
}
export type LayoutRail = (input: RailLayoutInput) => RailLayoutOutput

// =====================================================================================
// §12 Editor <-> UI seams (web)
// =====================================================================================

export type SaveState =
  | { state: 'saved'; rev: number; at: IsoTime }
  | { state: 'unsaved' }
  | { state: 'saving' }
  | { state: 'offline'; since: IsoTime; retryAt: IsoTime }
  /** count = held conflicts plus held unsaveable ops (§7.4). */
  | { state: 'conflict'; count: number }
  | { state: 'error'; code: ErrorCode; message: string }
  | { state: 'readonly'; code: ReadOnlyCode; message: string }

/**
 * §12.14. At most one banner shows; precedence contract-mismatch > doc-removed > read-only >
 * tab-not-leader > review-reset. P2 computes, P3 renders and wires the actions.
 */
export type SessionBanner =
  /** QA pass 4 #3. The server restarted with a new session token and every call answers 401. Action "Reload" -> DocSession.reload(). Editor read-only; unsaved text stays in the local draft store. */
  | { kind: 'connection-lost' }
  /** §13 #28. Action "Recreate from my copy" -> DocSession.recreate(). Autosave is paused while shown. */
  | { kind: 'doc-removed'; canRecreate: boolean }
  /** §13 #29. The sidecar's docId changed; doc and review were fully reloaded. Dismissible. */
  | { kind: 'review-reset'; previousDocId: DocId | null; docId: DocId | null }
  /** §13 #22. Action "Reload" -> DocSession.reload(). Editor read-only. */
  | { kind: 'contract-mismatch'; expected: string; actual: string }
  /** §13 #26, #30, #31. Editor read-only; for NOT_UTF8 / TOO_LARGE no document renders. */
  | { kind: 'read-only'; code: 'NOT_UTF8' | 'TOO_LARGE' | 'SIDECAR_CORRUPT' | 'SIDECAR_SCHEMA_UNSUPPORTED'; message: string }
  /** §13 #61. Action "Take over" -> DocSession.takeOver(). */
  | { kind: 'tab-not-leader' }

/** Local copy kept when a save could not be merged or a draft could not be restored (§12.4, §12.5, §12.14). */
export interface RecoveredDraft {
  /** 'merge-failed': Copy, Keep mine, Dismiss. 'schema-invalid': Copy, Dismiss (the draft can't be loaded). */
  reason: 'merge-failed' | 'schema-invalid'
  /** TJ's copy as markdown (base text with his own pending suggestions applied, where it still parses). */
  markdown: string
  baseRev: number
  savedAt: IsoTime
}

/** Toasts from the session (EditorNotice covers the editor's own guards). */
export interface SessionNotice {
  kind: 'info' | 'warn' | 'error'
  /** CLAUDE_EDITED (QA3): Claude changed block text directly; the shell adds a "View history" action. */
  code: 'DRAFT_RECOVERED' | 'DECISION_REVERTED' | 'RECREATE_FAILED' | 'POLICY_CHANGED' | 'CLAUDE_EDITED'
  text: string
  action?: { label: string; run: () => void }
}

export type SessionEvent =
  | 'doc' | 'review' | 'save' | 'presence' | 'activity' | 'conflicts' | 'handoff' | 'recovered' | 'banner'

/** P2 implements (web/src/session), P3 consumes. No ProseMirror types cross this seam. */
export interface DocSession {
  readonly file: string
  readonly root: string
  readonly port: number
  getSnapshot(): DocSnapshot
  getReview(): ReviewState
  getSaveState(): SaveState
  /** Conflicts (kind 'conflict') and held unsaveable ops (kind 'unsaveable'). */
  getConflicts(): BlockConflict[]
  /** §12.14; null when nothing applies. */
  getBanner(): SessionBanner | null
  subscribe(cb: (what: SessionEvent) => void): Unsubscribe
  /**
   * The latest SSE `handoff { state }` payload, null before the first (§12.10 step 4: the "Claude didn't pick this up"
   * toast). subscribe('handoff') says it changed (P2 merge, CONTRACT_CHANGES row 29).
   */
  getLastHandoffEvent(): Extract<BrowserSseEvent, { event: 'handoff' }>['data'] | null
  onNotice(cb: (n: SessionNotice) => void): Unsubscribe
  /**
   * Resolves after everything typed so far is persisted (immediately if clean, or while saving is impossible: read-only,
   * follower tab, no editor). Rejects with the network error while the server is unreachable; the save stays
   * outstanding and the backoff keeps retrying it (§12.1, P2 merge).
   */
  flush(): Promise<{ rev: number }>
  /** "Couldn't save: Retry" / click on Offline: cancel backoff and attempt now (no-op while saving). */
  retrySave(): void
  /** Only while the banner is 'doc-removed': save with cause 'recreate' (§3.6, §12.4). */
  recreate(): Promise<SaveResponse>
  /** 'contract-mismatch' Reload: awaits the IndexedDB draft write, then location.reload(). */
  reload(): Promise<void>
  /** Dismisses a dismissible banner ('review-reset'). */
  dismissBanner(): void
  getRecoveredDraft(): RecoveredDraft | null
  /** "Keep mine" ('merge-failed' only): load the draft into the editor (reload path) and save it with cause 'merge', allowPartial false. */
  keepRecoveredDraft(): Promise<void>
  discardRecoveredDraft(): void
  /** Copy the draft's markdown; call only from a user gesture. false if the write was refused. */
  copyRecoveredDraft(): Promise<boolean>
  /** SSE `navigate` (§8.4): P3 flushes, then full-page-loads the target file (§12.0.3). */
  onNavigate(cb: (file: string) => void): Unsubscribe
  /** Flush (waiting at most 3 s; the IndexedDB draft keeps the rest), close SSE, release the tab lock. Call after EditorHandle.destroy(). */
  close(): Promise<void>
  createThread(anchor: Anchor, body: string): Promise<CreateThreadResponse>
  reply(thread: ThreadId, body: string): Promise<MessageResponse>
  editComment(comment: CommentId, body: string): Promise<MessageResponse>
  deleteComment(comment: CommentId): Promise<SeqResponse>
  resolve(thread: ThreadId): Promise<ThreadOpResponse>
  reopen(thread: ThreadId): Promise<ThreadOpResponse>
  markRead(thread: ThreadId | null, upTo: number): void
  /**
   * Call synchronously inside the click handler: before its first await it copies the clipboard prompt when
   * presence.waiter === 'none'. The outcome reports what the gesture did (§12.10). A rejection (server unreachable,
   * or a refusal) carries the same two facts on the error object, `Pick<HandoffOutcome, 'clientDecision' | 'copied'>`,
   * so step 6 says "copied" only when the in-gesture write resolved (P3 merge). Read them duck-typed.
   */
  handoff(message?: string): Promise<HandoffOutcome>
  /** Copies the clipboard prompt; call only from a user gesture. Returns false if the write was refused. */
  copyPrompt(): Promise<boolean>
  /** The rail-header toggle "Claude may edit directly" (§9.9.1): POST /api/policy. */
  setPolicy(p: ReviewPolicy): Promise<SeqResponse>
  history: {
    list(): Promise<HistoryList>
    show(v: VersionId): Promise<VersionShow>
    diff(from: HistoryRef, to: HistoryRef): Promise<HistoryDiff>
    restore(v: VersionId): Promise<RestoreResponse>
  }
  /** Become the editable tab (BroadcastChannel election, §12.8). */
  takeOver(): void
  /**
   * Optional (onboarding): POST /api/reveal, show this document in the OS file manager (Finder, Explorer). Fakes may
   * leave it out; the file strip hides its Reveal button then.
   */
  revealFile?(): Promise<void>
}

/**
 * px in SCROLL-CONTAINER CONTENT coordinates (§12.0.3): for a client rect r and C =
 * scrollContainer.getBoundingClientRect(): top = r.top - C.top + scrollTop - clientTop (bottom likewise),
 * left = r.left - C.left + scrollLeft - clientLeft. Independent of the current scroll position.
 * P2 converts; P3 uses the values as-is (RailCardInput.anchorY = rect.top).
 */
export interface AnchorRect { top: number; bottom: number; left: number }
/**
 * `rect` = the selection's first line; `extent` = the whole selection's vertical span (multi-paragraph
 * selections can exceed the viewport; the floating Comment button clamps to it, §11.4). Both in content
 * coordinates. Endpoints inside insertion-marked text map to base ptext offsets; a selection covering only
 * inserted text is 'inside-suggestion' (§12.1).
 */
export type SelectionTarget =
  | null
  | { kind: 'anchor'; anchor: TextAnchor; quote: string; rect: AnchorRect; extent: { top: number; bottom: number } }
  | { kind: 'block'; anchor: BlockAnchor; rect: AnchorRect; extent: { top: number; bottom: number } }
  | { kind: 'inside-suggestion'; suggestion: SuggestionId; thread: ThreadId; rect: AnchorRect; extent: { top: number; bottom: number } }

export interface SuggestionSummary {
  id: SuggestionId
  by: Author
  /** 'format' when deleted and inserted ptext are identical (a mark-only change). */
  kind: 'insert' | 'delete' | 'replace' | 'format' | 'structure'
  deletedText: string
  insertedText: string
  /** Number of display hunks; a record is accepted or rejected as a whole (D31). */
  hunkCount: number
  placed: boolean
  /**
   * Present iff placed === false: hydrate's reason (§6.3). 'SCHEMA' = a "Shown as a diff" card anchored at the
   * run's first block (getAnchorRects returns that block's rect); 'BASE_NOT_FOUND' / 'ID_COLLISION' = "Can't
   * place this inline", listed in the rail header's unplaced section with no anchor rect.
   */
  unplaced?: 'SCHEMA' | 'BASE_NOT_FOUND' | 'ID_COLLISION'
}

export interface EditorNotice {
  kind: 'info' | 'warn' | 'error'
  code:
    | 'FOREIGN_SUGGESTION'
    | 'SUGGEST_MODE_BLOCKED'
    | 'PASTE_IMAGE_DROPPED'
    | 'SUGGESTION_UNPLACED'
    | 'DECISION_FAILED'
    | 'UNDO_CANCELLED'
    | 'UNDERLINE_UNSUPPORTED'
    | 'DECISIONS_APPLIED'
    | 'TABLE_DELETED'
    /** A click in a read-only document: why typing does nothing there (another tab has it, or the file can't be written). */
    | 'READ_ONLY'
  text: string
  action?: { label: string; run: () => void }
}

/** §11.5 registration seam: P3's editor-scoped keys, checked before every other keymap. */
export interface ShortcutBinding {
  /** prosemirror-keymap syntax, e.g. 'Mod-Enter', 'Mod-Alt-m', 'Mod-Alt-]'. */
  key: string
  /** Return true when handled (the event is then consumed). */
  run: () => boolean
  /** 'not-in-code': the binding returns false while the selection is inside a code_block (Mod-Enter vs exit code block). */
  when?: 'always' | 'not-in-code'
}

/** P2 implements (web/src/editor/bridge.ts), P3 consumes. */
export interface EditorBridge {
  getMode(): Mode
  setMode(m: Mode): void
  onModeChange(cb: (m: Mode) => void): Unsubscribe
  /** Threads (highlight start or first suggestion mark), conflicts and unsaveable ops; null = not placed in the live doc. */
  getAnchorRects(ids: readonly string[]): Map<string, AnchorRect | null>
  onLayoutInvalidated(cb: (reason: 'doc' | 'decorations' | 'reload' | 'mode' | 'resize') => void): Unsubscribe
  /** `collapsed: 'word'` (Cmd+Opt+M) targets the word at a collapsed caret; default 'none' returns null for a collapsed caret. */
  getSelectionTarget(o?: { collapsed?: 'none' | 'word' }): SelectionTarget
  onSelectionChange(cb: () => void): Unsubscribe
  /** Which threads' highlights render (the show-resolved toggle is P3's state). */
  setVisibleThreads(ids: readonly ThreadId[]): void
  setActiveThread(id: string | null): void
  /** Keeps the current selection highlighted while a new-comment box is open (`false` removes it). */
  setDraftHighlight(on: boolean): void
  onHighlightClick(cb: (thread: ThreadId) => void): Unsubscribe
  /** Writes the scroll container's scrollTop; P2's only scroll write besides reload restoration (§12.0.1). */
  scrollToThread(id: string, opts?: { align: 'top30' | 'nearest' }): void
  accept(id: SuggestionId): Promise<{ ok: boolean; noop?: true; code?: ErrorCode }>
  reject(id: SuggestionId): Promise<{ ok: boolean; noop?: true; code?: ErrorCode }>
  /**
   * One bulk request, one commit, one undo entry (§6.6). `{ by: 'Claude' }` = "Accept all from Claude";
   * `{ ids }` = "Accept all in thread". Both filters intersect. null when nothing matched.
   */
  acceptAll(sel?: { by?: Author; ids?: readonly SuggestionId[] }): Promise<BulkDecisionResult | null>
  rejectAll(sel?: { by?: Author; ids?: readonly SuggestionId[] }): Promise<BulkDecisionResult | null>
  getSuggestionSummaries(): Map<SuggestionId, SuggestionSummary>
  /** For kind 'unsaveable': 'theirs' discards TJ's change, 'mine' re-plans and retries once (§7.4). */
  resolveConflict(id: BlockConflict['id'], choice: 'mine' | 'theirs'): Promise<void>
  /**
   * Give the document the focus back (no scroll). `collapse: 'end'` first collapses a non-empty selection to its end, in
   * the editor's own state: the next keystroke must not replace the text that was just commented on (QA3 rail-ui 9).
   */
  focusEditor(o?: { collapse?: 'end' }): void
  /** Toast requests from editor guards. P3 renders them. */
  onNotice(cb: (n: EditorNotice) => void): Unsubscribe
  /** §11.5. Highest-precedence keymap entry; unregister with the returned function. */
  registerShortcut(b: ShortcutBinding): Unsubscribe
  /** true on a doc-changing user transaction; false after TYPING_IDLE_MS without one or on pointer move (quiet chrome, §12.2.4). */
  onTypingActivity(cb: (typing: boolean) => void): Unsubscribe
}

// =====================================================================================
// §12.0 Page composition: bootstrap, factories, transport (P2 implements; P3 calls)
// =====================================================================================

/** Read from the <meta name="mdr-*"> tags P1 injects into index.html (§12.0.2). */
export interface SessionBootstrap {
  token: string
  root: string
  rootHash: Hash
  port: number
  /** Validated ?file= (posix, relative to root); null when absent or invalid. */
  file: string | null
  /** Set when ?file= was given but rejected (FILE_NOT_FOUND, PROTECTED_ROOT, ...). */
  fileError: ErrorCode | null
  version: string
  protocol: number
  schemaFingerprint: string
  testHooks: boolean
}
/** web/src/session/bootstrap.ts (P2). Throws when mdr-token or mdr-root is missing. */
export type ReadBootstrap = (doc: Document) => SessionBootstrap

/** Minimal EventSource surface the session needs; MockTransport implements it in-process. */
export interface EventSourceLike {
  addEventListener(type: string, cb: (e: { data: string; lastEventId: string }) => void): void
  close(): void
  onerror: ((e: unknown) => void) | null
}
/**
 * §12.0.5. Default = fetch + EventSource with ORIGIN-RELATIVE paths (`fetch('/api/...')`,
 * `new EventSource('/api/events?...')`), so a page opened at http://localhost:<port>/ talks to localhost and one
 * at 127.0.0.1 talks to 127.0.0.1: always same-origin, no CORS (D43). tests/fakes/MockTransport.ts over fakeApp.
 * `request` adds X-MDR-Client, Authorization and (non-GET) X-MDR-Client-Id itself. `path` always starts with '/'.
 */
export interface Transport {
  request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, o?: { keepalive?: boolean }): Promise<{ status: number; json: unknown }>
  events(pathWithQuery: string): EventSourceLike
  /**
   * The X-MDR-Client-Id this transport sends (D32), when it has one (P2 merge, CONTRACT_CHANGES): the session uses it
   * for the SSE query, SaveRequest/FlushRequest.clientId and echo rule 1; absent, the session mints one.
   */
  readonly clientId?: ClientId
}

export interface OpenDocSessionOptions {
  boot: SessionBootstrap
  file: string
  transport?: Transport
}
/** web/src/session/index.ts (P2). Fetches snapshot + review, opens SSE, runs tab election. */
export type OpenDocSession = (o: OpenDocSessionOptions) => Promise<DocSession>

/** Root SSE channel for a tab with no ?file= (§8.6, §12.0.1): navigate only. */
export interface RootChannel {
  onNavigate(cb: (file: string) => void): Unsubscribe
  close(): void
}
export type ConnectRootChannel = (boot: SessionBootstrap, transport?: Transport) => RootChannel

export interface CreateEditorOptions {
  /** Empty element P3 renders inside .mdr-doc-col (#mdr-editor-host); P2 mounts the view into it. */
  host: HTMLElement
  /** Empty element P3 renders in the top bar (#mdr-toolbar-host); P2 renders format buttons + mode pill into it. */
  toolbarHost: HTMLElement
  /** P3's single scroll container (#mdr-scroll) holding the doc column AND the rail; the AnchorRect origin. */
  scrollContainer: HTMLElement
  /** Must come from openDocSession (createEditor attaches to P2-private internals; anything else throws TypeError). */
  session: DocSession
}
export interface EditorHandle {
  bridge: EditorBridge
  /** Destroy the view, listeners and decorations; empty host and toolbarHost. Does not flush (session.close() does). */
  destroy(): void
}
/** web/src/editor/index.ts (P2). */
export type CreateEditor = (o: CreateEditorOptions) => Promise<EditorHandle>

/** window.__mdrDebug, defined only when <meta name="mdr-test-hooks" content="1"> is present (§12.0.4). */
export interface EditorDebugHooks {
  blocks(): BlockInfo[]
  ptext(): { text: string; blockRanges: Array<{ index: number; pStart: number; pEnd: number }> }
  planSave(): BlockOp[]
  liveMarkdown(): string
  /** Resolves after two animation frames with no pending view-plugin transaction. */
  settled(): Promise<void>
  /**
   * The live bridge and session, so p2-* specs drive decisions, modes, conflicts, recovered drafts and selection
   * targets without P3's UI and pass unchanged on the day-0 harness page and on P3's shell (§12.0.4, D42).
   */
  bridge(): EditorBridge
  session(): DocSession
  /**
   * Test-only splice fault (G7 in a real browser, §12.0.4): until cleared with [], this page's applyBlockOps
   * treats every op covering one of these base block hashes as failing every widening level. Pair it with
   * POST /__test/splice-fault on the server so both sides agree on `failed` / `unsaveable`.
   */
  failSplice(blockHashes: readonly BlockHash[]): void
}

/** core/status-header.ts detectStatusHeader (P2, pure; §12.12 B). */
export interface StatusHeaderInfo {
  /** Top-level entry index of the status paragraph (or of the blockquote holding it). */
  index: number
  /** How it was found: a `Status:` label line, or a header status phrase (§12.12 B). */
  rule: 'label' | 'phrase'
  /** Every bold label in the block (`**Label:**` / `**Label**:`) with its value. */
  fields: Array<{ label: string; value: string }>
  /** The Status field's value (rule 'label') or the matched phrase segment (rule 'phrase'). */
  status: string
  /** `status` split on ' · ' (U+00B7 with spaces), trimmed, empties dropped: one chip pill each. */
  phrases: string[]
}

/** IndexedDB record (P2): key `mdr:draft:<rootHash>:<file>`. */
export interface DraftRecord {
  v: 1
  docId: DocId | null
  baseRev: number
  baseHash: Hash
  baseMarkdown: string
  /** Live ProseMirror doc JSON including suggestion marks. */
  liveDoc: unknown
  mode: Mode
  selection: { anchor: number; head: number } | null
  /** Base hashes held by open conflicts and unsaveable ops (§7.4). */
  heldConflicts: BlockHash[]
  savedAt: IsoTime
}

// =====================================================================================
// Constants (frozen; shared/constants.ts re-exports these)
// =====================================================================================

export const CONSTANTS = {
  HOST: '127.0.0.1',
  PORT_BASE: 8300,
  PORT_SPAN: 600,
  PORT_PROBE: 10,
  SERVER_START_TIMEOUT_MS: 10_000,
  HEALTH_TIMEOUT_MS: 300,
  AUTOSAVE_DEBOUNCE_MS: 600,
  AUTOSAVE_MAX_WAIT_MS: 5_000,
  DRAFT_DEBOUNCE_MS: 250,
  EDIT_SESSION_IDLE_MS: 30_000,
  WATCH_STABILITY_MS: 150,
  WATCH_MAX_FILES: 200,
  LOCK_STALE_MS: 10_000,
  LOCK_UPDATE_MS: 2_000,
  LOCK_TIMEOUT_SERVER_MS: 5_000,
  LOCK_TIMEOUT_CLI_MS: 5_000,
  SSE_HEARTBEAT_MS: 15_000,
  /** No byte for this long on a waiter stream = dropped; reconnect (§9.7). 3 heartbeats. */
  WAITER_WATCHDOG_MS: 45_000,
  /** Last browser SSE stream for a file closed and none reconnected: flush the TJ session with 'beacon' (§7.1). */
  BEACON_GRACE_MS: 5_000,
  /** One `mdr wait` run inside the waiter loop: 55 min, then exit 2 and the loop re-arms (§9.8). */
  WAIT_DEFAULT_TIMEOUT_S: 3_300,
  WAITER_GRACE_MS: 20_000,
  HANDOFF_UNDELIVERED_MS: 60_000,
  HANDOFF_COALESCE_MS: 10_000,
  ACTIVITY_IDLE_MS: 15 * 60_000,
  /** Presence `turn` -> `none` after this long with no agent request of any kind for the file (§8.5, D48). */
  TURN_IDLE_MS: 5 * 60_000,
  ANCHOR_CONTEXT_CHARS: 32,
  MAX_QUOTE_CHARS: 10_000,
  /** Long text anchors (span > MAX_QUOTE_CHARS) store this many ptext units at each end (§5.2, D45). */
  LONG_QUOTE_EDGE_CHARS: 1_000,
  MAX_DOC_BYTES: 5 * 1024 * 1024,
  MAX_LINE_BYTES: 1024 * 1024,
  MAX_COMMENT_CHARS: 20_000,
  MAX_HANDOFF_MESSAGE_CHARS: 2_000,
  CHANGE_MD_CAP: 4_096,
  CHANGE_MD_CONTEXT: 300,
  PENDING_DIFF_THRESHOLD: 1_200,
  SSE_MARKDOWN_MAX_BYTES: 512 * 1024,
  OBJECT_KEEP_REVS: 50,
  HISTORY_KEEP_ALL_DAYS: 7,
  HISTORY_DAILY_DAYS: 90,
  HISTORY_KEEP_LATEST: 20,
  HISTORY_MAX_BYTES: 50 * 1024 * 1024,
  SIDECAR_WARN_BYTES: 10 * 1024 * 1024,
  PROTECTED_WALK_MAX_DIRS: 20_000,
  NARROW_BREAKPOINT_PX: 640,
  RAIL_GAP: 8,
  RAIL_COLLAPSE_DISPLACEMENT: 120,
  RAIL_CLUSTER_MAX_ANCHOR_GAP: 48,
  RAIL_CLUSTER_MIN_RUN: 3,
  /** §11.4: active-card move animation (instant under prefers-reduced-motion). */
  CARD_MOVE_MS: 120,
  /** Levels of the applyBlockOps widening ladder: full block, ±1, ±2 neighbours (D37). */
  SPLICE_WIDEN_LEVELS: 3,
  /** TJ suggestion upserts wait until an id's marks are still this long, or a flush-reason save (§6.4). */
  SUGGESTION_UPSERT_STABLE_MS: 2_000,
  /** §12.9 read markers. */
  READ_MARK_VISIBLE_RATIO: 0.5,
  READ_MARK_DWELL_MS: 1_500,
  READ_MARK_THROTTLE_MS: 10_000,
  /** §12.12 body status header: top-level entries scanned after frontmatter (first heading not counted). */
  STATUS_HEADER_SCAN_BLOCKS: 6,
  /** §12.12 body status header, phrase rule: leading content blocks scanned. */
  STATUS_PHRASE_SCAN_BLOCKS: 3,
  /** §12.2.4 quiet chrome: onTypingActivity(false) after this long without a doc-changing user transaction. */
  TYPING_IDLE_MS: 1_500,
  /** §12.2.4 quiet chrome: P3 fades after this long of continuous typing. */
  QUIET_CHROME_AFTER_MS: 1_500,
  QUIET_CHROME_OPACITY: 0.35,
} as const

/** §12.2.2: every CSS custom property P3 defines (light + dark) and the only ones P2's editor CSS may use. */
export const THEME_TOKENS = [
  '--mdr-bg', '--mdr-surface', '--mdr-surface-raised',
  '--mdr-text', '--mdr-text-muted', '--mdr-text-faint',
  '--mdr-rule', '--mdr-control-border', '--mdr-focus', '--mdr-accent', '--mdr-accent-text', '--mdr-hover', '--mdr-selection',
  '--mdr-author-tj', '--mdr-author-tj-soft', '--mdr-author-claude', '--mdr-author-claude-soft', '--mdr-author-external',
  '--mdr-insert', '--mdr-delete', '--mdr-suggest', '--mdr-suggest-soft', '--mdr-caret',
  '--mdr-conflict', '--mdr-conflict-soft', '--mdr-hl-active',
  '--mdr-warn', '--mdr-danger', '--mdr-success',
  '--mdr-font-body', '--mdr-font-ui', '--mdr-font-mono',
  '--mdr-body-size', '--mdr-body-leading', '--mdr-measure', '--mdr-ui-size', '--mdr-ui-size-small',
  '--mdr-radius', '--mdr-radius-small', '--mdr-shadow', '--mdr-shadow-popover', '--mdr-z-popover',
  '--mdr-chrome-opacity',
] as const
export type ThemeToken = (typeof THEME_TOKENS)[number]

/** §12.15 selector contract. Every e2e spec locates elements by these data-testid values only. */
export const TESTID = {
  emptyState: 'mdr-empty-state',
  topbar: 'mdr-topbar',
  toolbar: 'mdr-toolbar',
  modePill: 'mdr-mode-pill',
  saveChip: 'mdr-save-chip',
  commentButton: 'mdr-comment-button',
  historyButton: 'mdr-history-button',
  send: 'mdr-send',
  claudeBadge: 'mdr-claude-badge',
  scroll: 'mdr-scroll',
  editor: 'mdr-editor',
  highlight: 'mdr-highlight',
  suggestion: 'mdr-suggestion',
  statusChip: 'mdr-status-chip',
  frontmatterPanel: 'mdr-frontmatter-panel',
  frontmatterStatus: 'mdr-frontmatter-status',
  linkPopover: 'mdr-link-popover',
  rawPopover: 'mdr-raw-popover',
  floatingComment: 'mdr-floating-comment',
  rail: 'mdr-rail',
  railHeader: 'mdr-rail-header',
  policyToggle: 'mdr-policy-toggle',
  card: 'mdr-card',
  cardReply: 'mdr-card-reply',
  cardSubmit: 'mdr-card-submit',
  cardResolve: 'mdr-card-resolve',
  suggestionItem: 'mdr-suggestion-item',
  accept: 'mdr-accept',
  reject: 'mdr-reject',
  detachedSection: 'mdr-detached-section',
  overflowChip: 'mdr-overflow-chip',
  offscreenPill: 'mdr-offscreen-pill',
  conflictCard: 'mdr-conflict-card',
  recoveredCard: 'mdr-recovered-card',
  banner: 'mdr-banner',
  toast: 'mdr-toast',
  historyPanel: 'mdr-history-panel',
  historyVersion: 'mdr-history-version',
  sheet: 'mdr-sheet',
  // ---- added in merge-loop round 1 (D51); owners and state attributes in CONTRACTS §12.15
  // P2 (inside #mdr-editor-host / #mdr-toolbar-host)
  toolbarButton: 'mdr-toolbar-button',
  tableControls: 'mdr-table-controls',
  tableAction: 'mdr-table-action',
  taskCheckbox: 'mdr-task-checkbox',
  codeLanguage: 'mdr-code-language',
  rawBlock: 'mdr-raw-block',
  inlineHtml: 'mdr-inline-html',
  conflictBlock: 'mdr-conflict-block',
  frontmatterField: 'mdr-frontmatter-field',
  frontmatterAdd: 'mdr-frontmatter-add',
  frontmatterRemove: 'mdr-frontmatter-remove',
  editYaml: 'mdr-edit-yaml',
  yamlPopover: 'mdr-yaml-popover',
  popoverField: 'mdr-popover-field',
  popoverAction: 'mdr-popover-action',
  // P3 (shell, rail, cards, history)
  docComment: 'mdr-doc-comment',
  docComposer: 'mdr-doc-composer',
  docComposerInput: 'mdr-doc-composer-input',
  docComposerPost: 'mdr-doc-composer-post',
  showResolved: 'mdr-show-resolved',
  acceptAllClaude: 'mdr-accept-all-claude',
  rejectAllClaude: 'mdr-reject-all-claude',
  unplacedSection: 'mdr-unplaced-section',
  navPrev: 'mdr-nav-prev',
  navNext: 'mdr-nav-next',
  unread: 'mdr-unread',
  message: 'mdr-message',
  cardEdit: 'mdr-card-edit',
  cardDelete: 'mdr-card-delete',
  cardReopen: 'mdr-card-reopen',
  acceptAllThread: 'mdr-accept-all-thread',
  cardAction: 'mdr-card-action',
  bannerAction: 'mdr-banner-action',
  toastAction: 'mdr-toast-action',
  promptModal: 'mdr-prompt-modal',
  historyPick: 'mdr-history-pick',
  historyDiff: 'mdr-history-diff',
  historyRestore: 'mdr-history-restore',
  // ---- added at the P3 merge (CONTRACT_CHANGES, P3 rows); state attributes in CONTRACTS §12.15
  sheetToggle: 'mdr-sheet-toggle',
  badgeAction: 'mdr-badge-action',
  // ---- added in QA round 3 (theme-polish); CONTRACTS §12.15
  railSettings: 'mdr-rail-settings',
  docName: 'mdr-doc-name',
  // ---- added in onboarding (the "where's my file" strip under the top bar)
  fileStrip: 'mdr-file-strip',
  fileStripReveal: 'mdr-file-strip-reveal',
  fileStripCopy: 'mdr-file-strip-copy',
} as const
export type TestId = (typeof TESTID)[keyof typeof TESTID]

/**
 * §12.15. Closed value sets for the multi-purpose test ids: the `data-action` value (or `data-field` /
 * `data-role` where the key says so) that tells same-testid controls apart. Specs import these, never literals.
 */
export const TEST_ACTIONS = {
  /** data-action on TESTID.toolbarButton (P2). heading-0..3 are the heading menu's items. */
  toolbarButton: [
    'bold', 'italic', 'strike', 'code', 'link', 'heading', 'heading-0', 'heading-1', 'heading-2', 'heading-3',
    'bullet', 'ordered', 'task', 'blockquote', 'code-block', 'hr', 'undo', 'redo',
  ],
  /** data-action on TESTID.tableAction (P2, §12.13 Tables). */
  tableAction: [
    'row-above', 'row-below', 'row-delete', 'col-left', 'col-right', 'col-delete',
    'align-left', 'align-center', 'align-right', 'align-none', 'table-delete',
  ],
  /** data-action on TESTID.popoverAction (P2: link, raw, inline-HTML and YAML popovers). */
  popoverAction: ['apply', 'cancel', 'remove', 'open', 'edit', 'save'],
  /** data-field on TESTID.popoverField (P2). */
  popoverField: ['url', 'text', 'source', 'yaml'],
  /** data-field on the frontmatter Add form's two inputs inside TESTID.frontmatterPanel (P2, §12.12 A; P2 merge). */
  frontmatterNewField: ['new-key', 'new-value'],
  /** data-action on TESTID.cardAction (P3: conflict, unsaveable, recovered-draft and stale-suggestion cards). */
  cardAction: ['keep-mine', 'take-theirs', 'copy', 'copy-markdown', 'discard', 'dismiss', 'copy-replacement'],
  /** data-action on TESTID.bannerAction (P3, §12.14). */
  bannerAction: ['recreate', 'reload', 'take-over', 'dismiss'],
  /** data-action on TESTID.toastAction (P3; also the Copy button inside TESTID.promptModal). `show-prompt` replaces a Copy that is known to fail (Pass 4 #29). */
  toastAction: ['copy-prompt', 'show-prompt', 'switch-to-editing'],
  /** data-role on TESTID.historyPick (P3): which end of the diff a version row sets. */
  historyPick: ['from', 'to'],
  /** data-action on TESTID.badgeAction (P3, §8.5 badge rows; P3 merge): the replied row's button, the paste row's Copy. */
  badgeAction: ['show-unread', 'copy-prompt', 'show-prompt'],
} as const
