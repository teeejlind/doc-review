// doc-review v2 (mdr): FROZEN runtime schemas (zod 4), derived from shared/types.ts on day 0. Owner: integrator.
//
// One schema per data type in types.ts, named `<TypeName>Schema`. types.ts decides shapes: when the two disagree,
// types.ts wins and this file is the bug. tests/contract/schemas-match-types.test.ts asserts, for every schema here,
// that z.infer<schema> equals its type (deep-normalized, exact optional properties included) and that the enums
// list exactly the type's members.
//
// Conventions:
// - Every object is strict (unknown keys are rejected), so a contract test catches shape drift on the wire.
// - An optional property `x?: T` is `.exactOptional()`: the key may be absent, but never present as undefined
//   (the project builds with exactOptionalPropertyTypes; JSON has no undefined).
// - Ids, hashes and refs are checked against shared/ids.ts; times are ISO-8601 UTC; seq / rev / counts are integers.
// - Validation rules CONTRACTS states for a shape live on its schema: the long-anchor rule (§5.2, D45) on
//   TextAnchorSchema, comment bodies 1..MAX_COMMENT_CHARS after trimming (§4.4) on request bodies, and
//   message <= MAX_HANDOFF_MESSAGE_CHARS (D17) on HandoffRequest. Responses and stored events are structural.
// - Types that carry functions (DocStore, DocSession, EditorBridge, Transport, notices with actions, ...) have no
//   schema: they never cross a process or persistence boundary.
import { z } from 'zod'
import { ID_RE } from './ids'
import { CONSTANTS, PROTOCOL, SIDECAR_SCHEMA } from './types'
import type { MdType } from './types'

// =====================================================================================
// helpers
// =====================================================================================

const int = () => z.number().int()
const nat = () => z.number().int().nonnegative()
const port = () => z.number().int().min(1).max(65535)

/** 1..MAX_COMMENT_CHARS after trimming (§4.4). */
const commentBody = () =>
  z.string().refine((s) => {
    const n = s.trim().length
    return n >= 1 && n <= CONSTANTS.MAX_COMMENT_CHARS
  }, `body must be 1..${CONSTANTS.MAX_COMMENT_CHARS} characters after trimming`)

// =====================================================================================
// §0 Primitives and identifiers
// =====================================================================================

export const AuthorSchema = z.enum(['TJ', 'Claude'])
export const ActorSchema = z.enum(['TJ', 'Claude', 'external', 'system'])
export const ModeSchema = z.enum(['editing', 'suggesting'])
export const EolSchema = z.enum(['\n', '\r\n'])
export const ViaSchema = z.enum(['server', 'direct'])

export const HashSchema = z.string().regex(ID_RE.hash)
export const BlockHashSchema = z.string().regex(ID_RE.blockHash)
export const BlockRefSchema = z.templateLiteral(['b', z.number()]).check(z.regex(ID_RE.blockRef))

export const ThreadIdSchema = z.templateLiteral(['t_', z.string()]).check(z.regex(ID_RE.thread))
export const CommentIdSchema = z.templateLiteral(['c_', z.string()]).check(z.regex(ID_RE.comment))
export const SuggestionIdSchema = z.templateLiteral(['s_', z.string()]).check(z.regex(ID_RE.suggestion))
export const EventIdSchema = z.templateLiteral(['e_', z.string()]).check(z.regex(ID_RE.event))
export const DocIdSchema = z.templateLiteral(['d_', z.string()]).check(z.regex(ID_RE.doc))
export const ClientIdSchema = z.templateLiteral(['k_', z.string()]).check(z.regex(ID_RE.clientId))
export const WaiterIdSchema = z.templateLiteral(['w_', z.string()]).check(z.regex(ID_RE.waiter))
export const VersionIdSchema = z.templateLiteral(['v', z.number()]).check(z.regex(ID_RE.version))
export const OpKeySchema = z.templateLiteral(['op_', z.string()]).check(z.regex(ID_RE.opKey))
export const IsoTimeSchema = z.iso.datetime()

// =====================================================================================
// §3 Document model
// =====================================================================================

export const BlockKindSchema = z.enum(['md', 'raw', 'frontmatter'])
export const FidelitySchema = z.enum(['exact', 'semantic', 'lossy'])
/** Any string at runtime; the type lists the common mdast names plus (string & {}). */
export const MdTypeSchema = z.custom<MdType>((v) => typeof v === 'string' && v.length > 0, 'mdType must be a non-empty string')

export const BlockInfoSchema = z.strictObject({
  ref: BlockRefSchema,
  index: nat(),
  kind: BlockKindSchema,
  mdType: MdTypeSchema,
  start: nat(),
  end: nat(),
  line: int().min(1),
  endLine: int().min(1),
  hash: BlockHashSchema,
  fidelity: FidelitySchema,
  pStart: nat(),
  pEnd: nat(),
  preview: z.string(),
})

export const ReadOnlyCodeSchema = z.enum([
  'NOT_UTF8', 'TOO_LARGE', 'SIDECAR_CORRUPT', 'SIDECAR_SCHEMA_UNSUPPORTED', 'CONTRACT_MISMATCH', 'DOC_GONE', 'TAB_NOT_LEADER',
])
const readOnlyField = () => z.union([z.literal(false), z.strictObject({ code: ReadOnlyCodeSchema, message: z.string() })])

export const DocSnapshotSchema = z.strictObject({
  file: z.string(),
  abs: z.string(),
  docId: DocIdSchema.nullable(),
  rev: nat(),
  hash: HashSchema,
  markdown: z.string(),
  bom: z.boolean(),
  eol: EolSchema,
  size: nat(),
  mtimeMs: z.number(),
  blocks: z.array(BlockInfoSchema),
  seq: nat(),
  schemaFingerprint: z.string(),
  readOnly: readOnlyField(),
})

export const BlockOpSchema = z.strictObject({
  after: int().min(-1),
  before: nat(),
  covers: z.array(BlockHashSchema),
  blocks: z.array(z.string()),
})

export const ApplyBlockOpsResultSchema = z.strictObject({
  text: z.string(),
  verified: z.boolean(),
  widened: z.array(z.strictObject({ op: nat(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]) })),
  failed: z.array(nat()),
  flips: z.array(z.strictObject({ op: nat(), entry: nat().nullable() })),
})

export const BlockSideSchema = z.strictObject({
  index: nat(),
  count: nat(),
  hashes: z.array(BlockHashSchema),
  start: nat(),
  end: nat(),
  md: z.string(),
  window: z.strictObject({ offset: nat(), total: nat() }).exactOptional(),
  truncated: z.literal(true).exactOptional(),
})
export const BlockChangeSchema = z.strictObject({
  op: z.enum(['replace', 'insert', 'delete']),
  before: BlockSideSchema.nullable(),
  after: BlockSideSchema.nullable(),
})

export const BlockConflictSchema = z.strictObject({
  kind: z.enum(['conflict', 'unsaveable']),
  id: z.union([z.templateLiteral(['conflict:', z.string()]), z.templateLiteral(['unsaveable:', z.string()])]),
  baseIndex: nat(),
  currentIndex: nat().nullable(),
  base: z.string(),
  mine: z.string().nullable(),
  theirs: z.string().nullable(),
  theirsBy: ActorSchema,
  theirsRev: nat(),
})

export const RevCauseSchema = z.enum(['baseline', 'save', 'accept', 'undo-accept', 'cli', 'restore', 'merge', 'external', 'recreate'])
export const EditSourceSchema = z.enum(['editor', 'cli', 'accept', 'undo-accept', 'restore'])

// =====================================================================================
// §5 Anchors
// =====================================================================================

export const TextAnchorSchema = z
  .strictObject({
    kind: z.literal('text'),
    quote: z.string().max(CONSTANTS.MAX_QUOTE_CHARS),
    tail: z.string().exactOptional(),
    span: int().exactOptional(),
    prefix: z.string(),
    suffix: z.string(),
    hint: z.strictObject({ rev: nat(), pos: nat(), block: nat(), blockHash: BlockHashSchema, offsetInBlock: nat() }),
  })
  .superRefine((a, ctx) => {
    // Long form (§5.2, D45): tail and span both present or both absent; when present the head and tail are exactly
    // LONG_QUOTE_EDGE_CHARS units and the span exceeds MAX_QUOTE_CHARS.
    const hasTail = a.tail !== undefined
    const hasSpan = a.span !== undefined
    if (hasTail !== hasSpan) {
      ctx.addIssue({ code: 'custom', message: 'tail and span must be both present or both absent', path: [hasTail ? 'span' : 'tail'] })
      return
    }
    if (hasTail) {
      const edge = CONSTANTS.LONG_QUOTE_EDGE_CHARS
      if (a.quote.length !== edge) ctx.addIssue({ code: 'custom', message: `long anchor quote must be ${edge} units`, path: ['quote'] })
      if (a.tail!.length !== edge) ctx.addIssue({ code: 'custom', message: `long anchor tail must be ${edge} units`, path: ['tail'] })
      if (!(a.span! > CONSTANTS.MAX_QUOTE_CHARS)) ctx.addIssue({ code: 'custom', message: `long anchor span must exceed ${CONSTANTS.MAX_QUOTE_CHARS}`, path: ['span'] })
    }
  })
export const BlockAnchorSchema = z.strictObject({
  kind: z.literal('block'),
  hint: z.strictObject({ rev: nat(), block: nat(), blockHash: BlockHashSchema, kind: BlockKindSchema, mdType: MdTypeSchema }),
  preview: z.string(),
})
export const DocAnchorSchema = z.strictObject({ kind: z.literal('doc') })
export const AnchorSchema = z.discriminatedUnion('kind', [TextAnchorSchema, BlockAnchorSchema, DocAnchorSchema])

export const ResolutionStateSchema = z.enum(['exact', 'moved', 'fuzzy', 'detached', 'doc'])
export const ResolutionSchema = z.strictObject({
  state: ResolutionStateSchema,
  from: nat().exactOptional(),
  to: nat().exactOptional(),
  block: nat().exactOptional(),
  ambiguous: z.literal(true).exactOptional(),
})

export const AnchorViewSchema = z.strictObject({
  state: z.enum(['ok', 'fuzzy', 'detached', 'doc']),
  block: BlockRefSchema.nullable(),
  line: int().min(1).nullable(),
  quote: z.string(),
  ambiguous: z.literal(true).exactOptional(),
})

// =====================================================================================
// §6 Suggestions
// =====================================================================================

export const HunkSchema = z.strictObject({ del: z.string(), ins: z.string(), at: nat() })

const suggestionBodyShape = {
  range: z.strictObject({ start: nat(), end: nat(), rev: nat() }),
  base: z.string(),
  proposed: z.string(),
  hunks: z.array(HunkSchema),
}
export const SuggestionBodySchema = z.strictObject(suggestionBodyShape)

export const SuggestionStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'stale', 'withdrawn'])
export const StaleReasonSchema = z.enum(['BASE_GONE', 'AMBIGUOUS', 'OVERLAP', 'MERGE_HAZARD'])

export const SuggestionSchema = z.strictObject({
  ...suggestionBodyShape,
  id: SuggestionIdSchema,
  thread: ThreadIdSchema,
  by: AuthorSchema,
  status: SuggestionStatusSchema,
  anchor: TextAnchorSchema,
  createdSeq: nat(),
  updatedSeq: nat(),
  decidedBy: AuthorSchema.exactOptional(),
  decidedSeq: nat().exactOptional(),
  staleReason: StaleReasonSchema.exactOptional(),
  located: z.strictObject({ start: nat(), end: nat() }).nullable(),
})

// =====================================================================================
// §4 Sidecar v2 event log
// =====================================================================================

export const SidecarHeaderSchema = z.strictObject({
  type: z.literal('header'),
  schema: z.literal(SIDECAR_SCHEMA),
  docId: DocIdSchema,
  file: z.string(),
  createdAt: IsoTimeSchema,
  createdBy: z.string(),
  compacted: z.strictObject({ at: IsoTimeSchema, droppedLines: nat() }).exactOptional(),
})

export const EventTypeSchema = z.enum([
  'comment.add', 'comment.reply', 'comment.edit', 'comment.delete',
  'thread.resolve', 'thread.reopen', 'thread.detach', 'thread.reattach', 'anchor.update',
  'suggestion.add', 'suggestion.update', 'suggestion.accept', 'suggestion.reject',
  'suggestion.reopen', 'suggestion.withdraw', 'suggestion.rebase', 'suggestion.stale',
  'doc.rev', 'doc.edit', 'doc.external', 'doc.abort', 'doc.missing',
  'ack', 'read-marker', 'handoff.sent', 'handoff.consumed',
  'server.recovered', 'log.repair', 'policy.set',
])

/** The envelope minus `type` and `by`, which every event narrows (keeping them out avoids intersecting two zod types). */
const envelopeShape = {
  seq: nat(),
  id: EventIdSchema,
  at: IsoTimeSchema,
  rev: nat(),
  key: z.string().exactOptional(),
  wal: z.strictObject({ rev: nat(), hash: HashSchema }).exactOptional(),
}
export const EventBaseSchema = z.strictObject({ ...envelopeShape, type: EventTypeSchema, by: ActorSchema })

const TJ = z.literal('TJ')
const CLAUDE = z.literal('Claude')
const SYSTEM = z.literal('system')
const EXTERNAL = z.literal('external')
const DELIVERY = z.enum(['waiter', 'latched', 'clipboard'])

/** Each event's own fields beyond the envelope: [type, by, payload]. One table feeds SidecarEvent, NewEvent and HandoffEventInput. */
const EVENT_PAYLOADS = {
  'comment.add': { by: AuthorSchema, thread: ThreadIdSchema, comment: CommentIdSchema, anchor: AnchorSchema, body: z.string() },
  'comment.reply': { by: AuthorSchema, thread: ThreadIdSchema, comment: CommentIdSchema, body: z.string() },
  'comment.edit': { by: AuthorSchema, comment: CommentIdSchema, body: z.string() },
  'comment.delete': { by: AuthorSchema, comment: CommentIdSchema },
  'thread.resolve': { by: AuthorSchema, thread: ThreadIdSchema },
  'thread.reopen': { by: AuthorSchema, thread: ThreadIdSchema },
  'thread.detach': { by: z.enum(['TJ', 'system']), thread: ThreadIdSchema, cause: z.enum(['deleted', 'unresolvable']) },
  'thread.reattach': { by: SYSTEM, thread: ThreadIdSchema, anchor: z.discriminatedUnion('kind', [TextAnchorSchema, BlockAnchorSchema]) },
  'anchor.update': { by: z.enum(['TJ', 'system']), thread: ThreadIdSchema, anchor: AnchorSchema },
  'suggestion.add': {
    by: AuthorSchema, thread: ThreadIdSchema, newThread: z.boolean(), suggestion: SuggestionIdSchema,
    comment: CommentIdSchema.exactOptional(), body: z.string().exactOptional(), anchor: TextAnchorSchema, ...suggestionBodyShape,
  },
  'suggestion.update': { by: AuthorSchema, suggestion: SuggestionIdSchema, anchor: TextAnchorSchema, ...suggestionBodyShape },
  'suggestion.accept': { by: AuthorSchema, suggestion: SuggestionIdSchema, resultRev: nat() },
  'suggestion.reject': { by: AuthorSchema, suggestion: SuggestionIdSchema },
  'suggestion.reopen': { by: TJ, suggestion: SuggestionIdSchema, resultRev: nat().nullable() },
  'suggestion.withdraw': { by: AuthorSchema, suggestion: SuggestionIdSchema },
  'suggestion.rebase': { by: SYSTEM, suggestion: SuggestionIdSchema, anchor: TextAnchorSchema, ...suggestionBodyShape },
  'suggestion.stale': { by: SYSTEM, suggestion: SuggestionIdSchema, reason: StaleReasonSchema },
  'doc.rev': {
    by: ActorSchema, prevRev: nat().nullable(), prevHash: HashSchema.nullable(), hash: HashSchema, bytes: nat(), cause: RevCauseSchema,
    clientId: ClientIdSchema.exactOptional(), saveId: nat().exactOptional(),
  },
  'doc.edit': {
    by: AuthorSchema, source: EditSourceSchema, fromRev: nat(), toRev: nat(), changes: z.array(BlockChangeSchema),
    cause: z.strictObject({ type: z.enum(['suggestion.accept', 'suggestion.reopen', 'restore']), id: z.string() }).exactOptional(),
  },
  'doc.external': { by: EXTERNAL, fromRev: nat(), toRev: nat(), changes: z.array(BlockChangeSchema).nullable() },
  'doc.abort': { by: SYSTEM, abortedRev: nat(), reason: z.enum(['not-landed', 'raced-external']) },
  'doc.missing': { by: EXTERNAL, lastHash: HashSchema },
  ack: { by: CLAUDE, upTo: nat(), waiter: WaiterIdSchema.exactOptional() },
  'read-marker': { by: TJ, thread: ThreadIdSchema.nullable(), upTo: nat() },
  'handoff.sent': { by: TJ, message: z.string().nullable(), delivery: DELIVERY },
  'handoff.consumed': { by: z.enum(['Claude', 'system']), handoffs: z.array(nat()), via: z.enum(['waiter', 'ack']), waiter: WaiterIdSchema.exactOptional() },
  'server.recovered': { by: SYSTEM, what: z.enum(['torn-tail', 'tj-session', 'wal']), detail: z.string() },
  'log.repair': { by: SYSTEM, droppedBytes: nat(), quarantined: z.string().exactOptional() },
  'policy.set': { by: AuthorSchema, suggestOnly: z.boolean() },
} as const

const ev = <T extends keyof typeof EVENT_PAYLOADS>(type: T) =>
  z.strictObject({ ...envelopeShape, type: z.literal(type), ...EVENT_PAYLOADS[type] })
const nev = <T extends keyof typeof EVENT_PAYLOADS>(type: T) =>
  z.strictObject({ type: z.literal(type), key: envelopeShape.key, ...EVENT_PAYLOADS[type] })

export const SidecarEventSchema = z.discriminatedUnion('type', [
  ev('comment.add'), ev('comment.reply'), ev('comment.edit'), ev('comment.delete'),
  ev('thread.resolve'), ev('thread.reopen'), ev('thread.detach'), ev('thread.reattach'), ev('anchor.update'),
  ev('suggestion.add'), ev('suggestion.update'), ev('suggestion.accept'), ev('suggestion.reject'),
  ev('suggestion.reopen'), ev('suggestion.withdraw'), ev('suggestion.rebase'), ev('suggestion.stale'),
  ev('doc.rev'), ev('doc.edit'), ev('doc.external'), ev('doc.abort'), ev('doc.missing'),
  ev('ack'), ev('read-marker'), ev('handoff.sent'), ev('handoff.consumed'),
  ev('server.recovered'), ev('log.repair'), ev('policy.set'),
])

/** What a store-internal writer hands the log: the store assigns seq, id, at, rev and wal. */
export const NewEventSchema = z.discriminatedUnion('type', [
  nev('comment.add'), nev('comment.reply'), nev('comment.edit'), nev('comment.delete'),
  nev('thread.resolve'), nev('thread.reopen'), nev('thread.detach'), nev('thread.reattach'), nev('anchor.update'),
  nev('suggestion.add'), nev('suggestion.update'), nev('suggestion.accept'), nev('suggestion.reject'),
  nev('suggestion.reopen'), nev('suggestion.withdraw'), nev('suggestion.rebase'), nev('suggestion.stale'),
  nev('doc.rev'), nev('doc.edit'), nev('doc.external'), nev('doc.abort'), nev('doc.missing'),
  nev('ack'), nev('read-marker'), nev('handoff.sent'), nev('handoff.consumed'),
  nev('server.recovered'), nev('log.repair'), nev('policy.set'),
])

/** What the handoff module hands DocStore.appendEvents: no `by` (the store derives it, §3.9). */
export const HandoffEventInputSchema = z.discriminatedUnion('type', [
  nev('handoff.sent').omit({ by: true }).extend({ by: z.never().exactOptional() }),
  nev('handoff.consumed').omit({ by: true }).extend({ by: z.never().exactOptional() }),
])

export const WarningCodeSchema = z.enum([
  'THREAD_DETACHED', 'THREAD_FUZZY', 'THREAD_AMBIGUOUS', 'SUGGESTION_STALE', 'SUGGESTION_REBASED',
  'VERSION_SKEW', 'LEGACY_SIDECAR', 'SIDECAR_REPAIRED', 'SIDECAR_SEQ_GAP', 'SIDECAR_INVALID_EVENT',
  'SIDECAR_LARGE', 'HISTORY_LARGE', 'NEEDS_RECOVERY', 'RESOLVED_WITH_PENDING', 'SPLICE_WIDENED', 'WHOLE_BLOCK_REPLACED',
])
export const WarningSchema = z.strictObject({
  code: WarningCodeSchema,
  message: z.string(),
  thread: ThreadIdSchema.exactOptional(),
  suggestion: SuggestionIdSchema.exactOptional(),
  line: int().min(1).exactOptional(),
})

// =====================================================================================
// §4.5 / §8 Folded review state
// =====================================================================================

export const MessageSchema = z.strictObject({
  id: CommentIdSchema,
  by: AuthorSchema,
  at: IsoTimeSchema,
  body: z.string(),
  seq: nat(),
  editedAt: IsoTimeSchema.exactOptional(),
  deleted: z.literal(true).exactOptional(),
})

export const ThreadSchema = z.strictObject({
  id: ThreadIdSchema,
  kind: z.enum(['comment', 'suggestion', 'doc']),
  status: z.enum(['open', 'resolved']),
  autoResolved: z.boolean(),
  anchor: AnchorSchema,
  lastAnchor: AnchorSchema,
  resolution: ResolutionSchema,
  detached: z.boolean(),
  createdBy: AuthorSchema,
  createdSeq: nat(),
  lastSeq: nat(),
  messages: z.array(MessageSchema),
  suggestions: z.array(SuggestionIdSchema),
  unread: nat(),
})

export const CursorsSchema = z.strictObject({
  claudeAck: nat(),
  tjRead: nat(),
  tjReadByThread: z.record(ThreadIdSchema, nat()),
})

export const PresenceSchema = z.strictObject({
  waiter: z.enum(['connected', 'grace', 'turn', 'none']),
  waiterId: WaiterIdSchema.exactOptional(),
  since: IsoTimeSchema.exactOptional(),
  graceUntil: IsoTimeSchema.exactOptional(),
})

export const ClaudeActivitySchema = z.strictObject({
  file: z.string(),
  state: z.enum(['idle', 'waiting-pickup', 'working', 'replied']),
  since: IsoTimeSchema,
  delivery: DELIVERY.exactOptional(),
  lastSeenAt: IsoTimeSchema.exactOptional(),
  unreadFromClaude: nat(),
})

export const ReviewPolicySchema = z.strictObject({ suggestOnly: z.boolean() })

export const ReviewStateSchema = z.strictObject({
  ok: z.literal(true),
  file: z.string(),
  rev: nat(),
  seq: nat(),
  threads: z.array(ThreadSchema),
  suggestions: z.array(SuggestionSchema),
  cursors: CursorsSchema,
  presence: PresenceSchema,
  activity: ClaudeActivitySchema,
  undeliveredHandoffs: z.array(nat()),
  policy: ReviewPolicySchema,
  warnings: z.array(WarningSchema),
  readOnly: readOnlyField(),
})
export const StoreReviewStateSchema = ReviewStateSchema.omit({ presence: true, activity: true })

// =====================================================================================
// §8 REST API: envelope and errors
// =====================================================================================

export const ErrorCodeSchema = z.enum([
  'BAD_REQUEST', 'USAGE', 'IDENTITY_IN_BODY', 'PAYLOAD_TOO_LARGE', 'ACK_OUT_OF_RANGE',
  'UNAUTHORIZED', 'FORBIDDEN_ORIGIN', 'PROTECTED_ROOT', 'PATH_OUTSIDE_ROOT', 'NOT_AUTHOR',
  'SUGGEST_ONLY', 'READ_ONLY', 'UNANCHORABLE_TARGET',
  'FILE_NOT_FOUND', 'DOC_GONE', 'THREAD_NOT_FOUND', 'COMMENT_NOT_FOUND', 'SUGGESTION_NOT_FOUND',
  'VERSION_NOT_FOUND', 'BLOCK_NOT_FOUND', 'QUOTE_NOT_FOUND', 'QUOTE_NOT_IN_SOURCE',
  'QUOTE_IN_PENDING_SUGGESTION',
  'QUOTE_AMBIGUOUS',
  'STALE_REVISION', 'CONFLICT', 'SUGGESTION_OVERLAP', 'SUGGESTION_CLOSED', 'SUGGESTION_STALE',
  'SUGGESTION_CHANGED_SINCE', 'BLOCK_MERGE_HAZARD', 'BATCH_SELF_CONFLICT', 'ACK_CONFLICT',
  'SERVER_START_FAILED', 'SERVER_UNREACHABLE', 'ROOT_MISMATCH', 'PORT_EXHAUSTED',
  'PROTOCOL_MISMATCH', 'MISDIRECTED',
  'LOCK_TIMEOUT', 'SIDECAR_CORRUPT', 'SIDECAR_SCHEMA_UNSUPPORTED', 'NOT_UTF8', 'TOO_LARGE',
  'SUGGESTION_RESIDUE', 'SPLICE_MISMATCH', 'CONTRACT_MISMATCH', 'IO_ERROR',
  'WAITER_SUPERSEDED', 'SERVER_STOPPED', 'DISARMED',
  'INTERNAL', 'INTERRUPTED',
])

export const QuoteCandidateSchema = z.strictObject({
  occurrence: int().min(1),
  block: BlockRefSchema,
  line: int().min(1),
  context: z.string(),
  similarity: z.number().exactOptional(),
})

export const ApiErrorBodySchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string(),
  hint: z.string().exactOptional(),
  op: nat().exactOptional(),
  candidates: z.array(QuoteCandidateSchema).exactOptional(),
  sourceQuote: z.string().exactOptional(),
  remap: z.partialRecord(BlockRefSchema, BlockRefSchema).exactOptional(),
  conflicts: z.array(BlockConflictSchema).exactOptional(),
  suggestion: SuggestionIdSchema.exactOptional(),
  thread: ThreadIdSchema.exactOptional(),
  details: z.record(z.string(), z.unknown()).exactOptional(),
})
export const ApiErrorSchema = z.strictObject({
  ok: z.literal(false),
  error: ApiErrorBodySchema,
  current: DocSnapshotSchema.exactOptional(),
  review: ReviewStateSchema.exactOptional(),
})

// =====================================================================================
// §8.3 Browser routes
// =====================================================================================

export const DisplayNameSourceSchema = z.enum(['env', 'config', 'git', 'os-full-name', 'os-username', 'default'])
export const UserIdentitySchema = z.strictObject({ displayName: z.string().min(1), source: DisplayNameSourceSchema })
export const MeResultSchema = z.strictObject({ ok: z.literal(true), displayName: z.string().min(1), source: DisplayNameSourceSchema })

export const HealthSchema = z.strictObject({
  ok: z.literal(true),
  app: z.literal('mdr'),
  version: z.string(),
  protocol: z.literal(PROTOCOL),
  schemaFingerprint: z.string(),
  root: z.string(),
  rootHash: HashSchema,
  port: port(),
  pid: int(),
  serverId: z.string(),
  startedAt: IsoTimeSchema,
})

export const AnchorUpdateSchema = z.strictObject({ thread: ThreadIdSchema, anchor: AnchorSchema.nullable() })

export const TjSuggestionUpsertSchema = z.strictObject({
  id: SuggestionIdSchema,
  thread: ThreadIdSchema.exactOptional(),
  range: z.strictObject({ start: nat(), end: nat() }),
  base: z.string(),
  proposed: z.string(),
  anchor: TextAnchorSchema,
})

export const SaveRequestSchema = z.strictObject({
  clientId: ClientIdSchema,
  saveId: nat(),
  base: z.strictObject({ rev: nat(), hash: HashSchema, blockHashes: z.array(BlockHashSchema) }),
  ops: z.array(BlockOpSchema),
  expectHash: HashSchema.exactOptional(),
  cause: z.enum(['edit', 'merge', 'recreate']),
  allowPartial: z.boolean(),
  anchors: z.array(AnchorUpdateSchema).exactOptional(),
  suggestions: z.strictObject({
    upsert: z.array(TjSuggestionUpsertSchema).exactOptional(),
    withdraw: z.array(SuggestionIdSchema).exactOptional(),
  }).exactOptional(),
})
export const SaveResponseSchema = z.strictObject({
  ok: z.literal(true),
  applied: z.enum(['direct', 'merged', 'noop', 'duplicate']),
  rev: nat(),
  hash: HashSchema,
  seq: nat(),
  conflicts: z.array(BlockConflictSchema),
  unsaveable: z.array(BlockConflictSchema),
  warnings: z.array(WarningSchema),
  rebased: DocSnapshotSchema.exactOptional(),
  staled: z.array(SuggestionIdSchema),
  rebasedSuggestions: z.array(SuggestionIdSchema),
})

export const CreateThreadRequestSchema = z.strictObject({ opKey: OpKeySchema, anchor: AnchorSchema, anchorRev: nat(), body: commentBody() })
export const CreateThreadResponseSchema = z.strictObject({ ok: z.literal(true), thread: ThreadSchema, seq: nat(), duplicate: z.literal(true).exactOptional() })
export const ReplyRequestSchema = z.strictObject({ opKey: OpKeySchema, body: commentBody() })
export const EditCommentRequestSchema = z.strictObject({ opKey: OpKeySchema, body: commentBody() })
export const OpKeyRequestSchema = z.strictObject({ opKey: OpKeySchema })
export const MessageResponseSchema = z.strictObject({ ok: z.literal(true), message: MessageSchema, seq: nat(), duplicate: z.literal(true).exactOptional() })
export const SeqResponseSchema = z.strictObject({ ok: z.literal(true), seq: nat(), duplicate: z.literal(true).exactOptional() })
export const ThreadOpResponseSchema = z.strictObject({
  ok: z.literal(true), thread: ThreadSchema, seq: nat(), warnings: z.array(WarningSchema).exactOptional(), duplicate: z.literal(true).exactOptional(),
})
export const DecideRequestSchema = z.strictObject({ opKey: OpKeySchema })
export const DecisionResultSchema = z.strictObject({
  ok: z.literal(true),
  suggestion: SuggestionIdSchema,
  status: SuggestionStatusSchema,
  rev: nat(),
  hash: HashSchema,
  seq: nat(),
  changes: z.array(BlockChangeSchema),
  duplicate: z.literal(true).exactOptional(),
})
export const BulkDecisionRequestSchema = z.union([
  z.strictObject({ opKey: OpKeySchema, decision: z.enum(['accept', 'reject']), authors: z.array(AuthorSchema), ids: z.array(SuggestionIdSchema).exactOptional() }),
  z.strictObject({ opKey: OpKeySchema, decision: z.literal('reopen'), authors: z.array(AuthorSchema), ids: z.array(SuggestionIdSchema) }),
])
export const BulkDecisionResultSchema = z.strictObject({
  ok: z.literal(true),
  rev: nat(),
  hash: HashSchema,
  seq: nat(),
  results: z.array(z.strictObject({ id: SuggestionIdSchema, ok: z.boolean(), code: ErrorCodeSchema.exactOptional(), duplicate: z.literal(true).exactOptional() })),
})
export const ReadMarkerRequestSchema = z.strictObject({ thread: ThreadIdSchema.nullable(), upTo: nat() })
export const FlushRequestSchema = z.strictObject({ clientId: ClientIdSchema, reason: z.literal('beacon') })
export const PolicyRequestSchema = z.strictObject({ suggestOnly: z.boolean() })
export const HandoffRequestSchema = z.strictObject({
  opKey: OpKeySchema,
  message: z.string().max(CONSTANTS.MAX_HANDOFF_MESSAGE_CHARS).exactOptional(),
  clientDecision: z.enum(['waiter', 'clipboard']),
  onlyIfNew: z.literal(true).exactOptional(),
})
export const HandoffResultSchema = z.strictObject({
  ok: z.literal(true),
  seq: nat(),
  coalesced: z.boolean(),
  delivery: DELIVERY,
  prompt: z.string(),
  presence: PresenceSchema,
  nothingNew: z.literal(true).exactOptional(),
})
export const HandoffOutcomeSchema = HandoffResultSchema.extend({
  clientDecision: z.enum(['waiter', 'clipboard']),
  copied: z.boolean(),
})

// =====================================================================================
// §10 History
// =====================================================================================

export const VersionCauseSchema = z.enum(['baseline', 'pre-write', 'tj-session', 'claude-write', 'accept', 'external', 'restore', 'shutdown'])
export const VersionMetaSchema = z.strictObject({
  v: VersionIdSchema,
  n: int().min(1),
  rev: nat(),
  hash: HashSchema,
  by: ActorSchema,
  cause: VersionCauseSchema,
  at: IsoTimeSchema,
  size: nat(),
  revs: z.tuple([nat(), nat()]),
  blocksChanged: nat(),
  restoredFrom: VersionIdSchema.exactOptional(),
})
export const RestoreRequestSchema = z.strictObject({ opKey: OpKeySchema, v: VersionIdSchema, baseRev: nat() })
export const RestoreResponseSchema = z.strictObject({
  ok: z.literal(true),
  rev: nat(),
  hash: HashSchema,
  seq: nat(),
  version: VersionMetaSchema,
  detached: z.array(ThreadIdSchema),
  staled: z.array(SuggestionIdSchema),
  snapshot: DocSnapshotSchema,
})
export const HistoryListSchema = z.strictObject({
  ok: z.literal(true),
  via: ViaSchema.exactOptional(),
  file: z.string(),
  versions: z.array(VersionMetaSchema),
  currentRev: nat(),
  currentHash: HashSchema,
  unsnapshotted: z.boolean(),
})
export const VersionShowSchema = z.strictObject({ ok: z.literal(true), via: ViaSchema.exactOptional(), meta: VersionMetaSchema, markdown: z.string() })
export const HistoryRefSchema = z.union([
  VersionIdSchema,
  z.templateLiteral(['rev:', z.number()]).check(z.regex(/^rev:(0|[1-9][0-9]*)$/)),
  z.literal('current'),
])
export const DiffBlockSchema = z.strictObject({
  op: z.enum(['equal', 'replace', 'insert', 'delete']),
  before: z.string().exactOptional(),
  after: z.string().exactOptional(),
  by: z.array(ActorSchema),
  lastBy: ActorSchema.nullable(),
  inline: z.array(z.tuple([z.union([z.literal(-1), z.literal(0), z.literal(1)]), z.string()])).exactOptional(),
})
const historyEnd = () => z.union([VersionMetaSchema, z.strictObject({ current: z.literal(true), rev: nat(), hash: HashSchema })])
export const HistoryDiffSchema = z.strictObject({
  ok: z.literal(true),
  via: ViaSchema.exactOptional(),
  from: historyEnd(),
  to: historyEnd(),
  blocks: z.array(DiffBlockSchema),
})

// =====================================================================================
// §8.6 / §8.7 SSE
// =====================================================================================

export const BrowserSseEventSchema = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('hello'),
    data: z.strictObject({
      serverId: z.string(), protocol: z.literal(PROTOCOL), version: z.string(), schemaFingerprint: z.string(), file: z.string(),
      docId: DocIdSchema.nullable(), rev: nat(), hash: HashSchema, seq: nat(), presence: PresenceSchema, activity: ClaudeActivitySchema,
    }),
  }),
  z.strictObject({
    event: z.literal('doc-changed'),
    data: z.strictObject({
      file: z.string(), rev: nat(), prevRev: nat(), hash: HashSchema, by: ActorSchema, cause: RevCauseSchema,
      clientId: ClientIdSchema.exactOptional(), saveId: nat().exactOptional(), changes: z.array(BlockChangeSchema), markdown: z.string().exactOptional(),
    }),
  }),
  z.strictObject({
    event: z.literal('sidecar-changed'),
    data: z.strictObject({ file: z.string(), fromSeq: nat(), seq: nat(), types: z.array(EventTypeSchema), clientId: ClientIdSchema.exactOptional() }),
  }),
  z.strictObject({ event: z.literal('presence'), data: PresenceSchema.extend({ file: z.string() }) }),
  z.strictObject({
    event: z.literal('handoff'),
    data: z.strictObject({ file: z.string(), seq: nat(), state: z.enum(['sent', 'latched', 'consumed', 'undelivered']), delivery: DELIVERY }),
  }),
  z.strictObject({ event: z.literal('claude-activity'), data: ClaudeActivitySchema }),
  z.strictObject({ event: z.literal('navigate'), data: z.strictObject({ file: z.string() }) }),
  z.strictObject({ event: z.literal('doc-removed'), data: z.strictObject({ file: z.string() }) }),
  z.strictObject({ event: z.literal('resync'), data: z.strictObject({ reason: z.enum(['gap', 'restart', 'skew']) }) }),
  z.strictObject({ event: z.literal('server-shutdown'), data: z.strictObject({ reason: z.enum(['stop', 'restart', 'signal']) }) }),
])

// =====================================================================================
// §8.4 / §9 Agent routes and CLI JSON
// =====================================================================================

export const CliErrSchema = z.strictObject({ ok: z.literal(false), error: ApiErrorBodySchema, current: DocSnapshotSchema.exactOptional() })

export const BlockSelSchema = z.union([
  z.strictObject({ ref: BlockRefSchema, rev: nat() }),
  z.strictObject({ line: int().min(1), rev: nat() }),
  z.strictObject({ quote: z.string().min(1).max(CONSTANTS.MAX_QUOTE_CHARS), occurrence: int().min(1).exactOptional() }),
])
export const NearHintSchema = z.strictObject({ ref: BlockRefSchema, rev: nat() })

/** AgentOp.key: an optional caller-chosen idempotency key (§4.7). */
const idemKey = () => z.string().min(1).exactOptional()
const cliQuote = () => z.string().min(1).max(CONSTANTS.MAX_QUOTE_CHARS)
export const AgentOpSchema = z.union([
  z.strictObject({ op: z.literal('comment'), quote: cliQuote(), occurrence: int().min(1).exactOptional(), near: NearHintSchema.exactOptional(), body: commentBody(), key: idemKey() }),
  z.strictObject({ op: z.literal('comment'), doc: z.literal(true), body: commentBody(), key: idemKey() }),
  z.strictObject({ op: z.literal('comment'), block: BlockSelSchema, body: commentBody(), key: idemKey() }),
  z.strictObject({ op: z.literal('reply'), thread: ThreadIdSchema, body: commentBody(), key: idemKey() }),
  z.strictObject({
    op: z.literal('suggest'), quote: cliQuote(), replace: z.string(), reason: commentBody().exactOptional(), thread: ThreadIdSchema.exactOptional(),
    occurrence: int().min(1).exactOptional(), near: NearHintSchema.exactOptional(), key: idemKey(),
  }),
  z.strictObject({ op: z.literal('suggest_block'), target: BlockSelSchema, markdown: z.string(), reason: commentBody().exactOptional(), thread: ThreadIdSchema.exactOptional(), key: idemKey() }),
  z.strictObject({ op: z.literal('replace_block'), target: BlockSelSchema, markdown: z.string(), key: idemKey() }),
  z.strictObject({ op: z.literal('replace_range'), from: BlockSelSchema, to: BlockSelSchema, markdown: z.string(), key: idemKey() }),
  z.strictObject({ op: z.enum(['insert_after', 'insert_before']), target: BlockSelSchema, markdown: z.string(), key: idemKey() }),
  z.strictObject({ op: z.literal('delete_block'), target: BlockSelSchema, key: idemKey() }),
  z.strictObject({ op: z.literal('write'), markdown: z.string(), baseRev: nat(), key: idemKey() }),
  z.strictObject({ op: z.literal('resolve'), thread: ThreadIdSchema, body: commentBody().exactOptional(), key: idemKey() }),
  z.strictObject({ op: z.literal('reopen'), thread: ThreadIdSchema, key: idemKey() }),
  z.strictObject({ op: z.literal('edit_comment'), comment: CommentIdSchema, body: commentBody(), key: idemKey() }),
  z.strictObject({ op: z.literal('delete_comment'), comment: CommentIdSchema, key: idemKey() }),
  z.strictObject({ op: z.literal('withdraw'), suggestion: SuggestionIdSchema, key: idemKey() }),
  z.strictObject({ op: z.literal('decide'), suggestion: SuggestionIdSchema, decision: z.enum(['accept', 'reject']), key: idemKey() }),
])
const AGENT_OP_NAMES = z.enum([
  'comment', 'reply', 'suggest', 'suggest_block', 'replace_block', 'replace_range', 'insert_after', 'insert_before',
  'delete_block', 'write', 'resolve', 'reopen', 'edit_comment', 'delete_comment', 'withdraw', 'decide',
])

export const BatchRequestSchema = z.strictObject({
  ops: z.array(AgentOpSchema),
  ack: nat().exactOptional(),
  ackSince: nat().exactOptional(),
  dryRun: z.boolean().exactOptional(),
  waiter: WaiterIdSchema.exactOptional(),
})
const hunkView = () => z.strictObject({ del: z.string(), ins: z.string() })
export const BatchOpResultSchema = z.strictObject({
  i: nat(),
  op: AGENT_OP_NAMES,
  key: z.string(),
  duplicate: z.literal(true).exactOptional(),
  noop: z.literal(true).exactOptional(),
  thread: ThreadIdSchema.exactOptional(),
  comment: CommentIdSchema.exactOptional(),
  suggestion: SuggestionIdSchema.exactOptional(),
  anchor: AnchorViewSchema.exactOptional(),
  hunks: z.array(hunkView()).exactOptional(),
  changes: z.array(z.strictObject({ op: z.enum(['replace', 'insert', 'delete']), block: BlockRefSchema.nullable(), line: int().min(1).nullable() })).exactOptional(),
})
export const BatchResultSchema = z.strictObject({
  ok: z.literal(true),
  via: ViaSchema,
  file: z.string(),
  rev: nat(),
  hash: HashSchema,
  seq: nat(),
  noop: z.boolean(),
  dryRun: z.literal(true).exactOptional(),
  results: z.array(BatchOpResultSchema),
  acked: nat().nullable(),
  consumed: z.array(nat()),
  warnings: z.array(WarningSchema),
})

const THREAD_KIND = z.enum(['comment', 'suggestion', 'doc'])
const THREAD_STATUS = z.enum(['open', 'resolved'])
export const AgentSnapshotSchema = z.strictObject({
  ok: z.literal(true),
  via: ViaSchema,
  file: z.string(),
  abs: z.string(),
  rev: nat(),
  hash: HashSchema,
  eol: EolSchema,
  bom: z.boolean(),
  blocks: z.array(z.strictObject({
    ref: BlockRefSchema, type: MdTypeSchema, kind: BlockKindSchema, line: int().min(1), endLine: int().min(1), hash: BlockHashSchema,
    md: z.string().exactOptional(), text: z.string().exactOptional(),
  })),
  threads: z.array(z.strictObject({ id: ThreadIdSchema, kind: THREAD_KIND, status: THREAD_STATUS, anchor: AnchorViewSchema, by: AuthorSchema, replies: nat() })),
  suggestions: z.array(z.strictObject({
    id: SuggestionIdSchema, thread: ThreadIdSchema, by: AuthorSchema, status: SuggestionStatusSchema, block: BlockRefSchema.nullable(),
    line: int().min(1).nullable(), hunks: z.array(hunkView()),
  })),
})

export const PendingActivitySchema = z.enum([
  'created', 'replied', 'edited', 'deleted', 'resolved', 'reopened', 'suggested', 'revised',
  'accepted', 'rejected', 'withdrawn', 'reopened-suggestion', 'detached', 'reattached',
])
export const PendingThreadSchema = z.strictObject({
  id: ThreadIdSchema,
  kind: THREAD_KIND,
  status: THREAD_STATUS,
  anchor: AnchorViewSchema,
  activity: z.array(PendingActivitySchema),
  messages: z.array(z.strictObject({
    id: CommentIdSchema, by: AuthorSchema, at: IsoTimeSchema, body: z.string(),
    new: z.literal(true).exactOptional(), edited: z.literal(true).exactOptional(), deleted: z.literal(true).exactOptional(),
  })),
  suggestions: z.array(z.strictObject({
    id: SuggestionIdSchema, by: AuthorSchema, status: SuggestionStatusSchema, new: z.literal(true).exactOptional(),
    decidedBy: AuthorSchema.exactOptional(), block: BlockRefSchema.nullable(), line: int().min(1).nullable(),
    hunks: z.array(z.strictObject({
      del: z.string(), ins: z.string(), before: z.string().exactOptional(), after: z.string().exactOptional(), cell: z.string().exactOptional(),
    })),
    change: z.strictObject({ kind: z.enum(['format', 'structure']), detail: z.string() }).exactOptional(),
  })),
})
export const PendingEditSchema = z.strictObject({
  by: z.enum(['TJ', 'external']),
  sources: z.array(z.enum(['editor', 'restore'])),
  fromRev: nat(),
  toRev: nat(),
  blocks: z.array(z.strictObject({
    op: z.enum(['replace', 'insert', 'delete']),
    block: BlockRefSchema.nullable(),
    line: int().min(1).nullable(),
    change: z.discriminatedUnion('format', [
      z.strictObject({ format: z.literal('full'), before: z.string().nullable(), after: z.string().nullable(), partial: z.literal(true).exactOptional() }),
      z.strictObject({ format: z.literal('diff'), diff: z.string(), partial: z.literal(true).exactOptional() }),
    ]),
  })),
})
export const PendingNoticeSchema = z.strictObject({
  type: z.enum(['suggestion.stale', 'suggestion.rebase', 'thread.detach', 'thread.reattach']),
  suggestion: SuggestionIdSchema.exactOptional(),
  thread: ThreadIdSchema.exactOptional(),
  reason: z.string(),
})
export const PendingCountsSchema = z.strictObject({
  threads: nat(), messages: nat(), suggestions: nat(), decisions: nat(), resolves: nat(),
  edits: nat(), external: nat(), notices: nat(), handoffs: nat(),
})
const handoffItem = () => z.strictObject({ seq: nat(), at: IsoTimeSchema, message: z.string().nullable() })
export const PendingResultSchema = z.strictObject({
  ok: z.literal(true),
  via: ViaSchema,
  file: z.string(),
  abs: z.string(),
  rev: nat(),
  hash: HashSchema,
  since: nat(),
  cursor: nat(),
  empty: z.boolean(),
  handoffs: z.array(handoffItem()),
  threads: z.array(PendingThreadSchema),
  edits: z.array(PendingEditSchema),
  external: z.array(PendingEditSchema),
  notices: z.array(PendingNoticeSchema),
  counts: PendingCountsSchema,
  warnings: z.array(WarningSchema),
  user: UserIdentitySchema.exactOptional(),
})

export const ThreadDetailSchema = z.strictObject({
  ok: z.literal(true),
  via: ViaSchema,
  thread: z.strictObject({
    id: ThreadIdSchema,
    kind: THREAD_KIND,
    status: THREAD_STATUS,
    anchor: AnchorViewSchema.extend({ context: z.string() }),
    messages: z.array(z.strictObject({
      id: CommentIdSchema, by: AuthorSchema, at: IsoTimeSchema, body: z.string(), editedAt: IsoTimeSchema.exactOptional(), deleted: z.literal(true).exactOptional(),
    })),
    suggestions: z.array(z.strictObject({
      id: SuggestionIdSchema, by: AuthorSchema, status: SuggestionStatusSchema, base: z.string(), proposed: z.string(), hunks: z.array(HunkSchema),
      block: BlockRefSchema.nullable(), line: int().min(1).nullable(), staleReason: StaleReasonSchema.exactOptional(),
    })),
  }),
})

export const ServerInfoSchema = z.strictObject({
  state: z.enum(['up', 'down']),
  port: port().nullable(),
  url: z.string().nullable(),
  pid: int().exactOptional(),
  version: z.string().exactOptional(),
  protocol: int().exactOptional(),
})
export const StatusResultSchema = z.strictObject({
  ok: z.literal(true),
  via: ViaSchema,
  file: z.string(),
  abs: z.string(),
  root: z.string(),
  server: ServerInfoSchema,
  rev: nat(),
  hash: HashSchema,
  seq: nat(),
  threads: z.strictObject({ open: nat(), resolved: nat(), detached: nat() }),
  suggestions: z.strictObject({ pending: nat(), stale: nat() }),
  pendingCount: nat(),
  cursor: z.strictObject({ ack: nat(), latest: nat() }),
  presence: PresenceSchema,
  activity: ClaudeActivitySchema.nullable(),
  handoff: z.strictObject({ undelivered: z.array(nat()) }),
  policy: ReviewPolicySchema,
  legacySidecar: z.boolean(),
  needsRecovery: z.boolean(),
  readOnly: readOnlyField(),
  warnings: z.array(WarningSchema),
  user: UserIdentitySchema.exactOptional(),
})

export const ServerMarkerSchema = z.strictObject({
  app: z.literal('mdr'),
  root: z.string(),
  rootHash: HashSchema,
  port: port(),
  pid: int(),
  serverId: z.string(),
  version: z.string(),
  protocol: z.literal(PROTOCOL),
  startedAt: IsoTimeSchema,
  token: z.string().min(1),
})

export const PortResultSchema = z.strictObject({
  ok: z.literal(true), root: z.string(), formulaPort: port(), port: port().nullable(), state: z.enum(['up', 'free', 'exhausted']),
})
export const ServeResultSchema = z.strictObject({
  ok: z.literal(true), root: z.string(), port: port(), url: z.string(), pid: int(), adopted: z.boolean(), restarted: z.literal(true).exactOptional(),
})
export const StopResultSchema = z.strictObject({ ok: z.literal(true), root: z.string(), stopped: z.boolean(), port: port().nullable() })
export const StopAllResultSchema = z.strictObject({
  ok: z.literal(true),
  all: z.literal(true),
  stopped: z.array(z.strictObject({ root: z.string(), port: port(), pid: int() })),
  failed: z.array(z.strictObject({ root: z.string(), port: port(), code: ErrorCodeSchema, message: z.string() })),
})
export const VersionResultSchema = z.strictObject({ ok: z.literal(true), version: z.string().min(1) })
export const ConfigResultSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string(),
  config: z.strictObject({ displayName: z.string().exactOptional(), protectedSegments: z.array(z.string()).exactOptional(), tourDone: z.boolean().exactOptional() }),
  user: UserIdentitySchema,
  protectedSegments: z.strictObject({ segments: z.array(z.string()), source: z.enum(['env', 'config', 'default']) }),
  tour: z.enum(['offer', 'done']),
})

export const WaiterSpecSchema = z.strictObject({
  v: z.literal(2),
  root: z.string(),
  file: z.string(),
  abs: z.string(),
  port: port(),
  waiter: WaiterIdSchema,
  command: z.string().min(1),
})
export const OpenResultSchema = z.strictObject({
  ok: z.literal(true),
  via: z.literal('server'),
  file: z.string(),
  abs: z.string(),
  root: z.string(),
  port: port(),
  url: z.string(),
  rev: nat(),
  connectedTabs: nat(),
  navigated: z.boolean(),
  waiter: WaiterSpecSchema.nullable(),
  waiterReason: z.string().exactOptional(),
  presence: PresenceSchema,
  policy: ReviewPolicySchema,
  user: UserIdentitySchema.exactOptional(),
  launched: z.boolean().exactOptional(),
})
export const TourOfferResultSchema = z.strictObject({
  ok: z.literal(true),
  tour: z.literal('offer'),
  opened: z.literal(false),
  file: z.string(),
  abs: z.string(),
  root: z.string(),
  user: UserIdentitySchema,
})
export const TourResultSchema = OpenResultSchema.extend({ tour: z.strictObject({ folder: z.string(), cards: nat(), threads: z.array(z.string()) }) })
export const ArmResultSchema = z.strictObject({
  ok: z.literal(true),
  waiter: WaiterSpecSchema.nullable(),
  waiterReason: z.string().exactOptional(),
  attached: z.boolean(),
  presence: PresenceSchema,
  server: ServerInfoSchema,
  policy: ReviewPolicySchema,
})
export const DisarmResultSchema = z.strictObject({ ok: z.literal(true), file: z.string(), disarmed: z.boolean() })
export const ArmRouteResultSchema = z.strictObject({ ok: z.literal(true), presence: PresenceSchema })

export const HandoffPayloadSchema = z.strictObject({
  file: z.string(),
  abs: z.string(),
  root: z.string(),
  port: port(),
  url: z.string(),
  handoffs: z.array(handoffItem()),
  round: int().min(1),
  rev: nat(),
  counts: PendingCountsSchema,
  waiter: WaiterIdSchema,
  who: z.string().exactOptional(),
})
export const WakePromptInputSchema = z.strictObject({
  file: z.string(),
  abs: z.string(),
  root: z.string(),
  round: int().min(1).nullable(),
  counts: PendingCountsSchema.exactOptional(),
  who: z.string().exactOptional(),
  cmd: z.string().exactOptional(),
})
export const WaitResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ok: z.literal(true), status: z.literal('handoff'), payload: HandoffPayloadSchema, prompt: z.string() }),
  z.strictObject({ ok: z.literal(true), status: z.literal('timeout'), file: z.string(), waitedMs: z.number().nonnegative() }),
])

export const WaiterSseEventSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('armed'), data: z.strictObject({ waiter: WaiterIdSchema, file: z.string(), undelivered: z.array(nat()) }) }),
  z.strictObject({ event: z.literal('handoff'), data: HandoffPayloadSchema }),
  z.strictObject({ event: z.literal('superseded'), data: z.strictObject({ by: WaiterIdSchema, reason: z.enum(['newer-waiter', 'replaced']) }) }),
  z.strictObject({ event: z.literal('disarmed'), data: z.strictObject({ file: z.string() }) }),
  z.strictObject({ event: z.literal('server-shutdown'), data: z.strictObject({ reason: z.enum(['stop', 'restart', 'signal']) }) }),
])

export const DoctorResultSchema = z.strictObject({
  ok: z.literal(true),
  file: z.string(),
  sidecar: z.strictObject({
    exists: z.boolean(), bytes: nat(), lines: nat(), seqGaps: z.array(nat()), corruptLines: z.array(nat()), tornTail: z.boolean(), schema: z.string().nullable(),
  }),
  history: z.strictObject({ versions: nat(), bytes: nat(), orphanObjects: nat() }),
  actions: z.array(z.enum(['repaired-tail', 'quarantined', 'compacted', 'gc'])),
  warnings: z.array(WarningSchema),
})

// =====================================================================================
// §3.9 / §8.5 / §9.2.1 seams (data parts)
// =====================================================================================

export const FlushReasonSchema = z.enum(['idle', 'foreign-write', 'handoff', 'agent-read', 'shutdown', 'beacon', 'recovery'])

export const StoreChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('doc'), rev: nat(), prevRev: nat(), hash: HashSchema, by: ActorSchema, cause: RevCauseSchema,
    clientId: ClientIdSchema.exactOptional(), saveId: nat().exactOptional(), changes: z.array(BlockChangeSchema),
  }),
  z.strictObject({ kind: z.literal('sidecar'), fromSeq: nat(), seq: nat(), events: z.array(SidecarEventSchema), clientId: ClientIdSchema.exactOptional() }),
  z.strictObject({ kind: z.literal('removed') }),
])

export const TjCtxSchema = z.strictObject({ clientId: ClientIdSchema.exactOptional() })
export const OpenDocStoreOptionsSchema = z.strictObject({
  mode: z.enum(['server', 'direct']),
  lockTimeoutMs: nat(),
  readOnly: z.boolean().exactOptional(),
})
export const AgentSnapshotQuerySchema = z.strictObject({
  md: z.boolean().exactOptional(),
  text: z.boolean().exactOptional(),
  from: BlockRefSchema.exactOptional(),
  to: BlockRefSchema.exactOptional(),
})
export const HandoffRecordSchema = z.strictObject({
  seq: nat(),
  at: IsoTimeSchema,
  message: z.string().nullable(),
  delivery: DELIVERY,
  round: int().min(1),
  consumed: z.boolean(),
})

export const AgentRouteSchema = z.enum([
  'status', 'pending', 'thread', 'snapshot', 'batch', 'history', 'open', 'policy', 'wait', 'consume', 'disarm', 'shutdown', 'arm',
])

export const StartServerOptionsSchema = z.strictObject({ root: z.string(), port: port(), testHooks: z.boolean().exactOptional() })

// =====================================================================================
// §11 Rail layout (pure data)
// =====================================================================================

const railId = () => z.union([ThreadIdSchema, z.templateLiteral(['conflict:', z.string()]), z.templateLiteral(['unsaveable:', z.string()])])
export const RailCardInputSchema = z.strictObject({
  id: railId(),
  anchorY: z.number(),
  order: z.number(),
  height: z.number().nonnegative(),
  collapsedHeight: z.number().nonnegative(),
  pinExpanded: z.boolean().exactOptional(),
})
export const RailLayoutInputSchema = z.strictObject({
  cards: z.array(RailCardInputSchema),
  activeId: z.string().nullable(),
  gap: z.number(),
  minTop: z.number(),
  collapseDisplacement: z.number(),
  cluster: z.strictObject({ maxAnchorGap: z.number(), minRun: z.number() }),
})
export const RailPlacementSchema = z.strictObject({
  id: z.string(),
  top: z.number(),
  height: z.number(),
  collapsed: z.boolean(),
  displacement: z.number(),
})
export const RailLayoutOutputSchema = z.strictObject({
  placements: z.array(RailPlacementSchema),
  overflowAbove: z.array(z.string()),
  height: z.number(),
})

// =====================================================================================
// §12 Editor <-> UI seams (data parts)
// =====================================================================================

export const SaveStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('saved'), rev: nat(), at: IsoTimeSchema }),
  z.strictObject({ state: z.literal('unsaved') }),
  z.strictObject({ state: z.literal('saving') }),
  z.strictObject({ state: z.literal('offline'), since: IsoTimeSchema, retryAt: IsoTimeSchema }),
  z.strictObject({ state: z.literal('conflict'), count: nat() }),
  z.strictObject({ state: z.literal('error'), code: ErrorCodeSchema, message: z.string() }),
  z.strictObject({ state: z.literal('readonly'), code: ReadOnlyCodeSchema, message: z.string() }),
])

export const SessionBannerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connection-lost') }),
  z.strictObject({ kind: z.literal('doc-removed'), canRecreate: z.boolean() }),
  z.strictObject({ kind: z.literal('review-reset'), previousDocId: DocIdSchema.nullable(), docId: DocIdSchema.nullable() }),
  z.strictObject({ kind: z.literal('contract-mismatch'), expected: z.string(), actual: z.string() }),
  z.strictObject({
    kind: z.literal('read-only'),
    code: z.enum(['NOT_UTF8', 'TOO_LARGE', 'SIDECAR_CORRUPT', 'SIDECAR_SCHEMA_UNSUPPORTED']),
    message: z.string(),
  }),
  z.strictObject({ kind: z.literal('tab-not-leader') }),
])

export const RecoveredDraftSchema = z.strictObject({
  reason: z.enum(['merge-failed', 'schema-invalid']),
  markdown: z.string(),
  baseRev: nat(),
  savedAt: IsoTimeSchema,
})

export const SessionEventSchema = z.enum(['doc', 'review', 'save', 'presence', 'activity', 'conflicts', 'handoff', 'recovered', 'banner'])

export const AnchorRectSchema = z.strictObject({ top: z.number(), bottom: z.number(), left: z.number() })
const extent = () => z.strictObject({ top: z.number(), bottom: z.number() })
export const SelectionTargetSchema = z.union([
  z.null(),
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('anchor'), anchor: TextAnchorSchema, quote: z.string(), rect: AnchorRectSchema, extent: extent() }),
    z.strictObject({ kind: z.literal('block'), anchor: BlockAnchorSchema, rect: AnchorRectSchema, extent: extent() }),
    z.strictObject({ kind: z.literal('inside-suggestion'), suggestion: SuggestionIdSchema, thread: ThreadIdSchema, rect: AnchorRectSchema, extent: extent() }),
  ]),
])

export const SuggestionSummarySchema = z.strictObject({
  id: SuggestionIdSchema,
  by: AuthorSchema,
  kind: z.enum(['insert', 'delete', 'replace', 'format', 'structure']),
  deletedText: z.string(),
  insertedText: z.string(),
  hunkCount: nat(),
  placed: z.boolean(),
  unplaced: z.enum(['SCHEMA', 'BASE_NOT_FOUND', 'ID_COLLISION']).exactOptional(),
})

export const SessionBootstrapSchema = z.strictObject({
  token: z.string().min(1),
  root: z.string().min(1),
  rootHash: HashSchema,
  port: port(),
  file: z.string().nullable(),
  fileError: ErrorCodeSchema.nullable(),
  version: z.string(),
  protocol: int(),
  schemaFingerprint: z.string(),
  testHooks: z.boolean(),
})

export const StatusHeaderInfoSchema = z.strictObject({
  index: nat(),
  rule: z.enum(['label', 'phrase']),
  fields: z.array(z.strictObject({ label: z.string(), value: z.string() })),
  status: z.string(),
  phrases: z.array(z.string()),
})

/** IndexedDB draft (§12.5). A record that fails this schema becomes a 'schema-invalid' recovered draft. */
export const DraftRecordSchema = z.strictObject({
  v: z.literal(1),
  docId: DocIdSchema.nullable(),
  baseRev: nat(),
  baseHash: HashSchema,
  baseMarkdown: z.string(),
  liveDoc: z.unknown(),
  mode: ModeSchema,
  selection: z.strictObject({ anchor: nat(), head: nat() }).nullable(),
  heldConflicts: z.array(BlockHashSchema),
  savedAt: IsoTimeSchema,
})
