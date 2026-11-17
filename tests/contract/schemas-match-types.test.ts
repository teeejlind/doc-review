// tests/contract/schemas-match-types.test.ts (integrator, day 0; CONTRACTS §2.4 item 2).
//
// shared/schemas.ts is derived from shared/types.ts. This suite proves it:
// - compile time (tsc -b over tests/): for every `<Name>Schema`, z.infer<schema> equals types.ts's `<Name>`, after a
//   deep normalization that flattens intersections (Ev<...>, Presence & {...}) but keeps optional-key exactness,
//   readonly-ness, literal types and template-literal ids. An `optional()` where the type says `x?: T` fails here,
//   because the project builds with exactOptionalPropertyTypes.
// - run time: every exported schema is covered by the compile-time list below, the enums list exactly the members
//   the runtime tables use, and the validation rules CONTRACTS puts on a shape (long anchors, comment bodies, strict
//   objects, id formats) behave.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import * as S from '../../shared/schemas'
import type * as T from '../../shared/types'
import { AGENT_CONTENT_ROUTES, CONSTANTS, ERROR_TABLE } from '../../shared/types'

/** Structural normal form: maps every object (and array/tuple) homomorphically, so `A & B` becomes one object type. */
type Deep<X> = X extends readonly unknown[] ? { [K in keyof X]: Deep<X[K]> } : X extends object ? { [K in keyof X]: Deep<X[K]> } : X
type Out<Sc extends z.ZodType> = Deep<z.infer<Sc>>

// ---------------------------------------------------------------- compile-time equality, one line per type

function typeAssertions(): void {
  expectTypeOf<Out<typeof S.AuthorSchema>>().toEqualTypeOf<Deep<T.Author>>()
  expectTypeOf<Out<typeof S.ActorSchema>>().toEqualTypeOf<Deep<T.Actor>>()
  expectTypeOf<Out<typeof S.ModeSchema>>().toEqualTypeOf<Deep<T.Mode>>()
  expectTypeOf<Out<typeof S.EolSchema>>().toEqualTypeOf<Deep<T.Eol>>()
  expectTypeOf<Out<typeof S.ViaSchema>>().toEqualTypeOf<Deep<T.Via>>()
  expectTypeOf<Out<typeof S.HashSchema>>().toEqualTypeOf<Deep<T.Hash>>()
  expectTypeOf<Out<typeof S.BlockHashSchema>>().toEqualTypeOf<Deep<T.BlockHash>>()
  expectTypeOf<Out<typeof S.BlockRefSchema>>().toEqualTypeOf<Deep<T.BlockRef>>()
  expectTypeOf<Out<typeof S.ThreadIdSchema>>().toEqualTypeOf<Deep<T.ThreadId>>()
  expectTypeOf<Out<typeof S.CommentIdSchema>>().toEqualTypeOf<Deep<T.CommentId>>()
  expectTypeOf<Out<typeof S.SuggestionIdSchema>>().toEqualTypeOf<Deep<T.SuggestionId>>()
  expectTypeOf<Out<typeof S.EventIdSchema>>().toEqualTypeOf<Deep<T.EventId>>()
  expectTypeOf<Out<typeof S.DocIdSchema>>().toEqualTypeOf<Deep<T.DocId>>()
  expectTypeOf<Out<typeof S.ClientIdSchema>>().toEqualTypeOf<Deep<T.ClientId>>()
  expectTypeOf<Out<typeof S.WaiterIdSchema>>().toEqualTypeOf<Deep<T.WaiterId>>()
  expectTypeOf<Out<typeof S.VersionIdSchema>>().toEqualTypeOf<Deep<T.VersionId>>()
  expectTypeOf<Out<typeof S.OpKeySchema>>().toEqualTypeOf<Deep<T.OpKey>>()
  expectTypeOf<Out<typeof S.IsoTimeSchema>>().toEqualTypeOf<Deep<T.IsoTime>>()
  expectTypeOf<Out<typeof S.BlockKindSchema>>().toEqualTypeOf<Deep<T.BlockKind>>()
  expectTypeOf<Out<typeof S.FidelitySchema>>().toEqualTypeOf<Deep<T.Fidelity>>()
  expectTypeOf<Out<typeof S.MdTypeSchema>>().toEqualTypeOf<Deep<T.MdType>>()
  expectTypeOf<Out<typeof S.BlockInfoSchema>>().toEqualTypeOf<Deep<T.BlockInfo>>()
  expectTypeOf<Out<typeof S.ReadOnlyCodeSchema>>().toEqualTypeOf<Deep<T.ReadOnlyCode>>()
  expectTypeOf<Out<typeof S.DocSnapshotSchema>>().toEqualTypeOf<Deep<T.DocSnapshot>>()
  expectTypeOf<Out<typeof S.BlockOpSchema>>().toEqualTypeOf<Deep<T.BlockOp>>()
  expectTypeOf<Out<typeof S.ApplyBlockOpsResultSchema>>().toEqualTypeOf<Deep<T.ApplyBlockOpsResult>>()
  expectTypeOf<Out<typeof S.BlockSideSchema>>().toEqualTypeOf<Deep<T.BlockSide>>()
  expectTypeOf<Out<typeof S.BlockChangeSchema>>().toEqualTypeOf<Deep<T.BlockChange>>()
  expectTypeOf<Out<typeof S.BlockConflictSchema>>().toEqualTypeOf<Deep<T.BlockConflict>>()
  expectTypeOf<Out<typeof S.RevCauseSchema>>().toEqualTypeOf<Deep<T.RevCause>>()
  expectTypeOf<Out<typeof S.EditSourceSchema>>().toEqualTypeOf<Deep<T.EditSource>>()
  expectTypeOf<Out<typeof S.TextAnchorSchema>>().toEqualTypeOf<Deep<T.TextAnchor>>()
  expectTypeOf<Out<typeof S.BlockAnchorSchema>>().toEqualTypeOf<Deep<T.BlockAnchor>>()
  expectTypeOf<Out<typeof S.DocAnchorSchema>>().toEqualTypeOf<Deep<T.DocAnchor>>()
  expectTypeOf<Out<typeof S.AnchorSchema>>().toEqualTypeOf<Deep<T.Anchor>>()
  expectTypeOf<Out<typeof S.ResolutionStateSchema>>().toEqualTypeOf<Deep<T.ResolutionState>>()
  expectTypeOf<Out<typeof S.ResolutionSchema>>().toEqualTypeOf<Deep<T.Resolution>>()
  expectTypeOf<Out<typeof S.AnchorViewSchema>>().toEqualTypeOf<Deep<T.AnchorView>>()
  expectTypeOf<Out<typeof S.HunkSchema>>().toEqualTypeOf<Deep<T.Hunk>>()
  expectTypeOf<Out<typeof S.SuggestionBodySchema>>().toEqualTypeOf<Deep<T.SuggestionBody>>()
  expectTypeOf<Out<typeof S.SuggestionStatusSchema>>().toEqualTypeOf<Deep<T.SuggestionStatus>>()
  expectTypeOf<Out<typeof S.StaleReasonSchema>>().toEqualTypeOf<Deep<T.StaleReason>>()
  expectTypeOf<Out<typeof S.SuggestionSchema>>().toEqualTypeOf<Deep<T.Suggestion>>()
  expectTypeOf<Out<typeof S.SidecarHeaderSchema>>().toEqualTypeOf<Deep<T.SidecarHeader>>()
  expectTypeOf<Out<typeof S.EventTypeSchema>>().toEqualTypeOf<Deep<T.EventType>>()
  expectTypeOf<Out<typeof S.EventBaseSchema>>().toEqualTypeOf<Deep<T.EventBase>>()
  expectTypeOf<Out<typeof S.SidecarEventSchema>>().toEqualTypeOf<Deep<T.SidecarEvent>>()
  expectTypeOf<Out<typeof S.NewEventSchema>>().toEqualTypeOf<Deep<T.NewEvent>>()
  expectTypeOf<Out<typeof S.HandoffEventInputSchema>>().toEqualTypeOf<Deep<T.HandoffEventInput>>()
  expectTypeOf<Out<typeof S.WarningCodeSchema>>().toEqualTypeOf<Deep<T.WarningCode>>()
  expectTypeOf<Out<typeof S.WarningSchema>>().toEqualTypeOf<Deep<T.Warning>>()
  expectTypeOf<Out<typeof S.MessageSchema>>().toEqualTypeOf<Deep<T.Message>>()
  expectTypeOf<Out<typeof S.ThreadSchema>>().toEqualTypeOf<Deep<T.Thread>>()
  expectTypeOf<Out<typeof S.CursorsSchema>>().toEqualTypeOf<Deep<T.Cursors>>()
  expectTypeOf<Out<typeof S.PresenceSchema>>().toEqualTypeOf<Deep<T.Presence>>()
  expectTypeOf<Out<typeof S.ClaudeActivitySchema>>().toEqualTypeOf<Deep<T.ClaudeActivity>>()
  expectTypeOf<Out<typeof S.ReviewPolicySchema>>().toEqualTypeOf<Deep<T.ReviewPolicy>>()
  expectTypeOf<Out<typeof S.ReviewStateSchema>>().toEqualTypeOf<Deep<T.ReviewState>>()
  expectTypeOf<Out<typeof S.StoreReviewStateSchema>>().toEqualTypeOf<Deep<T.StoreReviewState>>()
  expectTypeOf<Out<typeof S.ErrorCodeSchema>>().toEqualTypeOf<Deep<T.ErrorCode>>()
  expectTypeOf<Out<typeof S.QuoteCandidateSchema>>().toEqualTypeOf<Deep<T.QuoteCandidate>>()
  expectTypeOf<Out<typeof S.ApiErrorBodySchema>>().toEqualTypeOf<Deep<T.ApiErrorBody>>()
  expectTypeOf<Out<typeof S.ApiErrorSchema>>().toEqualTypeOf<Deep<T.ApiError>>()
  expectTypeOf<Out<typeof S.DisplayNameSourceSchema>>().toEqualTypeOf<Deep<T.DisplayNameSource>>()
  expectTypeOf<Out<typeof S.UserIdentitySchema>>().toEqualTypeOf<Deep<T.UserIdentity>>()
  expectTypeOf<Out<typeof S.MeResultSchema>>().toEqualTypeOf<Deep<T.MeResult>>()
  expectTypeOf<Out<typeof S.HealthSchema>>().toEqualTypeOf<Deep<T.Health>>()
  expectTypeOf<Out<typeof S.AnchorUpdateSchema>>().toEqualTypeOf<Deep<T.AnchorUpdate>>()
  expectTypeOf<Out<typeof S.TjSuggestionUpsertSchema>>().toEqualTypeOf<Deep<T.TjSuggestionUpsert>>()
  expectTypeOf<Out<typeof S.SaveRequestSchema>>().toEqualTypeOf<Deep<T.SaveRequest>>()
  expectTypeOf<Out<typeof S.SaveResponseSchema>>().toEqualTypeOf<Deep<T.SaveResponse>>()
  expectTypeOf<Out<typeof S.CreateThreadRequestSchema>>().toEqualTypeOf<Deep<T.CreateThreadRequest>>()
  expectTypeOf<Out<typeof S.CreateThreadResponseSchema>>().toEqualTypeOf<Deep<T.CreateThreadResponse>>()
  expectTypeOf<Out<typeof S.ReplyRequestSchema>>().toEqualTypeOf<Deep<T.ReplyRequest>>()
  expectTypeOf<Out<typeof S.EditCommentRequestSchema>>().toEqualTypeOf<Deep<T.EditCommentRequest>>()
  expectTypeOf<Out<typeof S.OpKeyRequestSchema>>().toEqualTypeOf<Deep<T.OpKeyRequest>>()
  expectTypeOf<Out<typeof S.MessageResponseSchema>>().toEqualTypeOf<Deep<T.MessageResponse>>()
  expectTypeOf<Out<typeof S.SeqResponseSchema>>().toEqualTypeOf<Deep<T.SeqResponse>>()
  expectTypeOf<Out<typeof S.ThreadOpResponseSchema>>().toEqualTypeOf<Deep<T.ThreadOpResponse>>()
  expectTypeOf<Out<typeof S.DecideRequestSchema>>().toEqualTypeOf<Deep<T.DecideRequest>>()
  expectTypeOf<Out<typeof S.DecisionResultSchema>>().toEqualTypeOf<Deep<T.DecisionResult>>()
  expectTypeOf<Out<typeof S.BulkDecisionRequestSchema>>().toEqualTypeOf<Deep<T.BulkDecisionRequest>>()
  expectTypeOf<Out<typeof S.BulkDecisionResultSchema>>().toEqualTypeOf<Deep<T.BulkDecisionResult>>()
  expectTypeOf<Out<typeof S.ReadMarkerRequestSchema>>().toEqualTypeOf<Deep<T.ReadMarkerRequest>>()
  expectTypeOf<Out<typeof S.FlushRequestSchema>>().toEqualTypeOf<Deep<T.FlushRequest>>()
  expectTypeOf<Out<typeof S.PolicyRequestSchema>>().toEqualTypeOf<Deep<T.PolicyRequest>>()
  expectTypeOf<Out<typeof S.HandoffRequestSchema>>().toEqualTypeOf<Deep<T.HandoffRequest>>()
  expectTypeOf<Out<typeof S.HandoffResultSchema>>().toEqualTypeOf<Deep<T.HandoffResult>>()
  expectTypeOf<Out<typeof S.HandoffOutcomeSchema>>().toEqualTypeOf<Deep<T.HandoffOutcome>>()
  expectTypeOf<Out<typeof S.VersionCauseSchema>>().toEqualTypeOf<Deep<T.VersionCause>>()
  expectTypeOf<Out<typeof S.VersionMetaSchema>>().toEqualTypeOf<Deep<T.VersionMeta>>()
  expectTypeOf<Out<typeof S.RestoreRequestSchema>>().toEqualTypeOf<Deep<T.RestoreRequest>>()
  expectTypeOf<Out<typeof S.RestoreResponseSchema>>().toEqualTypeOf<Deep<T.RestoreResponse>>()
  expectTypeOf<Out<typeof S.HistoryListSchema>>().toEqualTypeOf<Deep<T.HistoryList>>()
  expectTypeOf<Out<typeof S.VersionShowSchema>>().toEqualTypeOf<Deep<T.VersionShow>>()
  expectTypeOf<Out<typeof S.HistoryRefSchema>>().toEqualTypeOf<Deep<T.HistoryRef>>()
  expectTypeOf<Out<typeof S.DiffBlockSchema>>().toEqualTypeOf<Deep<T.DiffBlock>>()
  expectTypeOf<Out<typeof S.HistoryDiffSchema>>().toEqualTypeOf<Deep<T.HistoryDiff>>()
  expectTypeOf<Out<typeof S.BrowserSseEventSchema>>().toEqualTypeOf<Deep<T.BrowserSseEvent>>()
  expectTypeOf<Out<typeof S.CliErrSchema>>().toEqualTypeOf<Deep<T.CliErr>>()
  expectTypeOf<Out<typeof S.BlockSelSchema>>().toEqualTypeOf<Deep<T.BlockSel>>()
  expectTypeOf<Out<typeof S.NearHintSchema>>().toEqualTypeOf<Deep<T.NearHint>>()
  expectTypeOf<Out<typeof S.AgentOpSchema>>().toEqualTypeOf<Deep<T.AgentOp>>()
  expectTypeOf<Out<typeof S.BatchRequestSchema>>().toEqualTypeOf<Deep<T.BatchRequest>>()
  expectTypeOf<Out<typeof S.BatchOpResultSchema>>().toEqualTypeOf<Deep<T.BatchOpResult>>()
  expectTypeOf<Out<typeof S.BatchResultSchema>>().toEqualTypeOf<Deep<T.BatchResult>>()
  expectTypeOf<Out<typeof S.AgentSnapshotSchema>>().toEqualTypeOf<Deep<T.AgentSnapshot>>()
  expectTypeOf<Out<typeof S.PendingActivitySchema>>().toEqualTypeOf<Deep<T.PendingActivity>>()
  expectTypeOf<Out<typeof S.PendingThreadSchema>>().toEqualTypeOf<Deep<T.PendingThread>>()
  expectTypeOf<Out<typeof S.PendingEditSchema>>().toEqualTypeOf<Deep<T.PendingEdit>>()
  expectTypeOf<Out<typeof S.PendingNoticeSchema>>().toEqualTypeOf<Deep<T.PendingNotice>>()
  expectTypeOf<Out<typeof S.PendingCountsSchema>>().toEqualTypeOf<Deep<T.PendingCounts>>()
  expectTypeOf<Out<typeof S.PendingResultSchema>>().toEqualTypeOf<Deep<T.PendingResult>>()
  expectTypeOf<Out<typeof S.ThreadDetailSchema>>().toEqualTypeOf<Deep<T.ThreadDetail>>()
  expectTypeOf<Out<typeof S.ServerInfoSchema>>().toEqualTypeOf<Deep<T.ServerInfo>>()
  expectTypeOf<Out<typeof S.StatusResultSchema>>().toEqualTypeOf<Deep<T.StatusResult>>()
  expectTypeOf<Out<typeof S.ServerMarkerSchema>>().toEqualTypeOf<Deep<T.ServerMarker>>()
  expectTypeOf<Out<typeof S.PortResultSchema>>().toEqualTypeOf<Deep<T.PortResult>>()
  expectTypeOf<Out<typeof S.ServeResultSchema>>().toEqualTypeOf<Deep<T.ServeResult>>()
  expectTypeOf<Out<typeof S.StopResultSchema>>().toEqualTypeOf<Deep<T.StopResult>>()
  expectTypeOf<Out<typeof S.StopAllResultSchema>>().toEqualTypeOf<Deep<T.StopAllResult>>()
  expectTypeOf<Out<typeof S.VersionResultSchema>>().toEqualTypeOf<Deep<T.VersionResult>>()
  expectTypeOf<Out<typeof S.ConfigResultSchema>>().toEqualTypeOf<Deep<T.ConfigResult>>()
  expectTypeOf<Out<typeof S.WaiterSpecSchema>>().toEqualTypeOf<Deep<T.WaiterSpec>>()
  expectTypeOf<Out<typeof S.OpenResultSchema>>().toEqualTypeOf<Deep<T.OpenResult>>()
  expectTypeOf<Out<typeof S.TourOfferResultSchema>>().toEqualTypeOf<Deep<T.TourOfferResult>>()
  expectTypeOf<Out<typeof S.TourResultSchema>>().toEqualTypeOf<Deep<T.TourResult>>()
  expectTypeOf<Out<typeof S.ArmResultSchema>>().toEqualTypeOf<Deep<T.ArmResult>>()
  expectTypeOf<Out<typeof S.DisarmResultSchema>>().toEqualTypeOf<Deep<T.DisarmResult>>()
  expectTypeOf<Out<typeof S.ArmRouteResultSchema>>().toEqualTypeOf<Deep<T.ArmRouteResult>>()
  expectTypeOf<Out<typeof S.HandoffPayloadSchema>>().toEqualTypeOf<Deep<T.HandoffPayload>>()
  expectTypeOf<Out<typeof S.WakePromptInputSchema>>().toEqualTypeOf<Deep<T.WakePromptInput>>()
  expectTypeOf<Out<typeof S.WaitResultSchema>>().toEqualTypeOf<Deep<T.WaitResult>>()
  expectTypeOf<Out<typeof S.WaiterSseEventSchema>>().toEqualTypeOf<Deep<T.WaiterSseEvent>>()
  expectTypeOf<Out<typeof S.DoctorResultSchema>>().toEqualTypeOf<Deep<T.DoctorResult>>()
  expectTypeOf<Out<typeof S.FlushReasonSchema>>().toEqualTypeOf<Deep<T.FlushReason>>()
  expectTypeOf<Out<typeof S.StoreChangeSchema>>().toEqualTypeOf<Deep<T.StoreChange>>()
  expectTypeOf<Out<typeof S.TjCtxSchema>>().toEqualTypeOf<Deep<T.TjCtx>>()
  expectTypeOf<Out<typeof S.OpenDocStoreOptionsSchema>>().toEqualTypeOf<Deep<T.OpenDocStoreOptions>>()
  expectTypeOf<Out<typeof S.AgentSnapshotQuerySchema>>().toEqualTypeOf<Deep<T.AgentSnapshotQuery>>()
  expectTypeOf<Out<typeof S.HandoffRecordSchema>>().toEqualTypeOf<Deep<T.HandoffRecord>>()
  expectTypeOf<Out<typeof S.AgentRouteSchema>>().toEqualTypeOf<Deep<T.AgentRoute>>()
  expectTypeOf<Out<typeof S.StartServerOptionsSchema>>().toEqualTypeOf<Deep<T.StartServerOptions>>()
  expectTypeOf<Out<typeof S.RailCardInputSchema>>().toEqualTypeOf<Deep<T.RailCardInput>>()
  expectTypeOf<Out<typeof S.RailLayoutInputSchema>>().toEqualTypeOf<Deep<T.RailLayoutInput>>()
  expectTypeOf<Out<typeof S.RailPlacementSchema>>().toEqualTypeOf<Deep<T.RailPlacement>>()
  expectTypeOf<Out<typeof S.RailLayoutOutputSchema>>().toEqualTypeOf<Deep<T.RailLayoutOutput>>()
  expectTypeOf<Out<typeof S.SaveStateSchema>>().toEqualTypeOf<Deep<T.SaveState>>()
  expectTypeOf<Out<typeof S.SessionBannerSchema>>().toEqualTypeOf<Deep<T.SessionBanner>>()
  expectTypeOf<Out<typeof S.RecoveredDraftSchema>>().toEqualTypeOf<Deep<T.RecoveredDraft>>()
  expectTypeOf<Out<typeof S.SessionEventSchema>>().toEqualTypeOf<Deep<T.SessionEvent>>()
  expectTypeOf<Out<typeof S.AnchorRectSchema>>().toEqualTypeOf<Deep<T.AnchorRect>>()
  expectTypeOf<Out<typeof S.SelectionTargetSchema>>().toEqualTypeOf<Deep<T.SelectionTarget>>()
  expectTypeOf<Out<typeof S.SuggestionSummarySchema>>().toEqualTypeOf<Deep<T.SuggestionSummary>>()
  expectTypeOf<Out<typeof S.SessionBootstrapSchema>>().toEqualTypeOf<Deep<T.SessionBootstrap>>()
  expectTypeOf<Out<typeof S.StatusHeaderInfoSchema>>().toEqualTypeOf<Deep<T.StatusHeaderInfo>>()
  expectTypeOf<Out<typeof S.DraftRecordSchema>>().toEqualTypeOf<Deep<T.DraftRecord>>()
}
void typeAssertions

const ASSERTED = [
  'AuthorSchema',
  'ActorSchema',
  'ModeSchema',
  'EolSchema',
  'ViaSchema',
  'HashSchema',
  'BlockHashSchema',
  'BlockRefSchema',
  'ThreadIdSchema',
  'CommentIdSchema',
  'SuggestionIdSchema',
  'EventIdSchema',
  'DocIdSchema',
  'ClientIdSchema',
  'WaiterIdSchema',
  'VersionIdSchema',
  'OpKeySchema',
  'IsoTimeSchema',
  'BlockKindSchema',
  'FidelitySchema',
  'MdTypeSchema',
  'BlockInfoSchema',
  'ReadOnlyCodeSchema',
  'DocSnapshotSchema',
  'BlockOpSchema',
  'ApplyBlockOpsResultSchema',
  'BlockSideSchema',
  'BlockChangeSchema',
  'BlockConflictSchema',
  'RevCauseSchema',
  'EditSourceSchema',
  'TextAnchorSchema',
  'BlockAnchorSchema',
  'DocAnchorSchema',
  'AnchorSchema',
  'ResolutionStateSchema',
  'ResolutionSchema',
  'AnchorViewSchema',
  'HunkSchema',
  'SuggestionBodySchema',
  'SuggestionStatusSchema',
  'StaleReasonSchema',
  'SuggestionSchema',
  'SidecarHeaderSchema',
  'EventTypeSchema',
  'EventBaseSchema',
  'SidecarEventSchema',
  'NewEventSchema',
  'HandoffEventInputSchema',
  'WarningCodeSchema',
  'WarningSchema',
  'MessageSchema',
  'ThreadSchema',
  'CursorsSchema',
  'PresenceSchema',
  'ClaudeActivitySchema',
  'ReviewPolicySchema',
  'ReviewStateSchema',
  'StoreReviewStateSchema',
  'ErrorCodeSchema',
  'QuoteCandidateSchema',
  'ApiErrorBodySchema',
  'ApiErrorSchema',
  'DisplayNameSourceSchema',
  'UserIdentitySchema',
  'MeResultSchema',
  'HealthSchema',
  'AnchorUpdateSchema',
  'TjSuggestionUpsertSchema',
  'SaveRequestSchema',
  'SaveResponseSchema',
  'CreateThreadRequestSchema',
  'CreateThreadResponseSchema',
  'ReplyRequestSchema',
  'EditCommentRequestSchema',
  'OpKeyRequestSchema',
  'MessageResponseSchema',
  'SeqResponseSchema',
  'ThreadOpResponseSchema',
  'DecideRequestSchema',
  'DecisionResultSchema',
  'BulkDecisionRequestSchema',
  'BulkDecisionResultSchema',
  'ReadMarkerRequestSchema',
  'FlushRequestSchema',
  'PolicyRequestSchema',
  'HandoffRequestSchema',
  'HandoffResultSchema',
  'HandoffOutcomeSchema',
  'VersionCauseSchema',
  'VersionMetaSchema',
  'RestoreRequestSchema',
  'RestoreResponseSchema',
  'HistoryListSchema',
  'VersionShowSchema',
  'HistoryRefSchema',
  'DiffBlockSchema',
  'HistoryDiffSchema',
  'BrowserSseEventSchema',
  'CliErrSchema',
  'BlockSelSchema',
  'NearHintSchema',
  'AgentOpSchema',
  'BatchRequestSchema',
  'BatchOpResultSchema',
  'BatchResultSchema',
  'AgentSnapshotSchema',
  'PendingActivitySchema',
  'PendingThreadSchema',
  'PendingEditSchema',
  'PendingNoticeSchema',
  'PendingCountsSchema',
  'PendingResultSchema',
  'ThreadDetailSchema',
  'ServerInfoSchema',
  'StatusResultSchema',
  'ServerMarkerSchema',
  'PortResultSchema',
  'ServeResultSchema',
  'StopResultSchema',
  'StopAllResultSchema',
  'VersionResultSchema',
  'ConfigResultSchema',
  'WaiterSpecSchema',
  'OpenResultSchema',
  'TourOfferResultSchema',
  'TourResultSchema',
  'ArmResultSchema',
  'DisarmResultSchema',
  'ArmRouteResultSchema',
  'HandoffPayloadSchema',
  'WakePromptInputSchema',
  'WaitResultSchema',
  'WaiterSseEventSchema',
  'DoctorResultSchema',
  'FlushReasonSchema',
  'StoreChangeSchema',
  'TjCtxSchema',
  'OpenDocStoreOptionsSchema',
  'AgentSnapshotQuerySchema',
  'HandoffRecordSchema',
  'AgentRouteSchema',
  'StartServerOptionsSchema',
  'RailCardInputSchema',
  'RailLayoutInputSchema',
  'RailPlacementSchema',
  'RailLayoutOutputSchema',
  'SaveStateSchema',
  'SessionBannerSchema',
  'RecoveredDraftSchema',
  'SessionEventSchema',
  'AnchorRectSchema',
  'SelectionTargetSchema',
  'SuggestionSummarySchema',
  'SessionBootstrapSchema',
  'StatusHeaderInfoSchema',
  'DraftRecordSchema',
] as const

// ---------------------------------------------------------------- run time

const ULID = '01JAB3K9Q2T7V5X8Y0Z1W2E3R4'
const HASH = 'ab4d6f8a0c2e4a6c8e0a2c4e6a8c0e2a4c6e8a0c2e4a6c8e0a2c4e6a8c0e2a4c'
const hint = { rev: 8, pos: 1840, block: 14, blockHash: '9f2c0d1e7a6b5c44', offsetInBlock: 22 }
const shortAnchor = { kind: 'text', quote: 'member rate of 12%', prefix: 'the notes carry a ', suffix: ' paid monthly.', hint }
const edge = CONSTANTS.LONG_QUOTE_EDGE_CHARS

describe('shared/schemas.ts matches shared/types.ts', () => {
  it('every exported schema has a compile-time type assertion', () => {
    const exported = Object.keys(S).filter((k) => k.endsWith('Schema')).sort()
    expect(exported).toEqual([...ASSERTED].sort())
  })

  it('ErrorCodeSchema lists exactly the ERROR_TABLE codes', () => {
    expect([...S.ErrorCodeSchema.options].sort()).toEqual(Object.keys(ERROR_TABLE).sort())
  })

  it('EventTypeSchema lists exactly the SidecarEvent discriminators', () => {
    const variants = S.SidecarEventSchema.options.map((o) => o.shape.type.value)
    expect([...S.EventTypeSchema.options].sort()).toEqual([...variants].sort())
    expect(S.NewEventSchema.options.map((o) => o.shape.type.value).sort()).toEqual([...variants].sort())
  })

  it('AgentRouteSchema covers AGENT_CONTENT_ROUTES', () => {
    for (const r of AGENT_CONTENT_ROUTES) expect(S.AgentRouteSchema.options).toContain(r)
  })
})

describe('validation rules carried by the schemas', () => {
  it('ids, hashes and refs follow shared/ids.ts', () => {
    expect(S.ThreadIdSchema.safeParse(`t_${ULID}`).success).toBe(true)
    expect(S.ThreadIdSchema.safeParse(`c_${ULID}`).success).toBe(false)
    expect(S.ThreadIdSchema.safeParse('t_short').success).toBe(false)
    expect(S.ThreadIdSchema.safeParse(`t_${ULID.slice(0, 25)}I`).success).toBe(false) // no I/L/O/U in Crockford base32
    expect(S.BlockRefSchema.safeParse('b1').success).toBe(true)
    expect(S.BlockRefSchema.safeParse('b0').success).toBe(false)
    expect(S.BlockRefSchema.safeParse('b1.5').success).toBe(false)
    expect(S.VersionIdSchema.safeParse('v12').success).toBe(true)
    expect(S.WaiterIdSchema.safeParse('w_0123456789abcdef').success).toBe(true)
    expect(S.WaiterIdSchema.safeParse('w_0123456789ABCDEF').success).toBe(false)
    expect(S.HashSchema.safeParse(HASH).success).toBe(true)
    expect(S.HashSchema.safeParse(HASH.slice(1)).success).toBe(false)
    expect(S.BlockHashSchema.safeParse('9f2c0d1e7a6b5c44').success).toBe(true)
    expect(S.HistoryRefSchema.safeParse('rev:0').success).toBe(true)
    expect(S.HistoryRefSchema.safeParse('current').success).toBe(true)
    expect(S.HistoryRefSchema.safeParse('rev:x').success).toBe(false)
    expect(S.IsoTimeSchema.safeParse('2026-10-15T17:00:00.000Z').success).toBe(true)
    expect(S.IsoTimeSchema.safeParse('yesterday').success).toBe(false)
  })

  it('objects are strict and optional keys are exact', () => {
    expect(S.SeqResponseSchema.safeParse({ ok: true, seq: 3 }).success).toBe(true)
    expect(S.SeqResponseSchema.safeParse({ ok: true, seq: 3, duplicate: true }).success).toBe(true)
    expect(S.SeqResponseSchema.safeParse({ ok: true, seq: 3, extra: 1 }).success).toBe(false)
    expect(S.SeqResponseSchema.safeParse({ ok: true, seq: 3, duplicate: false }).success).toBe(false)
    expect(S.SeqResponseSchema.safeParse({ ok: true, seq: 3, duplicate: undefined }).success).toBe(false)
    expect(S.SeqResponseSchema.safeParse({ ok: true, seq: 1.5 }).success).toBe(false)
  })

  it('text anchors: short form, long form, and half-long anchors rejected (§5.2, D45)', () => {
    expect(S.TextAnchorSchema.safeParse(shortAnchor).success).toBe(true)
    expect(S.TextAnchorSchema.safeParse({ ...shortAnchor, quote: '' }).success).toBe(true) // suggestion insertion point
    const long = { ...shortAnchor, quote: 'h'.repeat(edge), tail: 't'.repeat(edge), span: CONSTANTS.MAX_QUOTE_CHARS + 1 }
    expect(S.TextAnchorSchema.safeParse(long).success).toBe(true)
    expect(S.AnchorSchema.safeParse(long).success).toBe(true)
    expect(S.TextAnchorSchema.safeParse({ ...long, span: undefined }).success).toBe(false)
    const { span: _span, ...noSpan } = long
    expect(S.TextAnchorSchema.safeParse(noSpan).success).toBe(false)
    expect(S.TextAnchorSchema.safeParse({ ...long, tail: 't'.repeat(edge - 1) }).success).toBe(false)
    expect(S.TextAnchorSchema.safeParse({ ...long, span: CONSTANTS.MAX_QUOTE_CHARS }).success).toBe(false)
    expect(S.TextAnchorSchema.safeParse({ ...shortAnchor, quote: 'q'.repeat(CONSTANTS.MAX_QUOTE_CHARS + 1) }).success).toBe(false)
  })

  it('request comment bodies are 1..MAX_COMMENT_CHARS after trimming (§4.4); responses are structural', () => {
    const req = { opKey: `op_${ULID}`, body: 'Is 12% current?' }
    expect(S.ReplyRequestSchema.safeParse(req).success).toBe(true)
    expect(S.ReplyRequestSchema.safeParse({ ...req, body: '   ' }).success).toBe(false)
    expect(S.ReplyRequestSchema.safeParse({ ...req, body: 'x'.repeat(CONSTANTS.MAX_COMMENT_CHARS + 1) }).success).toBe(false)
    expect(S.ReplyRequestSchema.safeParse({ ...req, by: 'TJ' }).success).toBe(false) // identity never in a body (D4)
    const deleted = { id: `c_${ULID}`, by: 'TJ', at: '2026-10-15T17:00:00.000Z', body: '', seq: 4, deleted: true }
    expect(S.MessageSchema.safeParse(deleted).success).toBe(true)
  })

  it('handoff messages are capped (D17)', () => {
    const req = { opKey: `op_${ULID}`, clientDecision: 'waiter' }
    expect(S.HandoffRequestSchema.safeParse({ ...req, message: 'Tighten section 2' }).success).toBe(true)
    expect(S.HandoffRequestSchema.safeParse({ ...req, message: 'm'.repeat(CONSTANTS.MAX_HANDOFF_MESSAGE_CHARS + 1) }).success).toBe(false)
  })

  it('agent ops: each comment form is distinct, CLI quotes are never long-form', () => {
    expect(S.AgentOpSchema.safeParse({ op: 'comment', quote: 'utilize', body: 'plain words' }).success).toBe(true)
    expect(S.AgentOpSchema.safeParse({ op: 'comment', doc: true, body: 'overall: good' }).success).toBe(true)
    expect(S.AgentOpSchema.safeParse({ op: 'comment', block: { ref: 'b3', rev: 7 }, body: 'this block' }).success).toBe(true)
    expect(S.AgentOpSchema.safeParse({ op: 'comment', quote: 'utilize', doc: true, body: 'mixed' }).success).toBe(false)
    expect(S.AgentOpSchema.safeParse({ op: 'comment', quote: 'q'.repeat(CONSTANTS.MAX_QUOTE_CHARS + 1), body: 'x' }).success).toBe(false)
    expect(S.AgentOpSchema.safeParse({ op: 'insert_before', target: { quote: 'Intro' }, markdown: 'New para' }).success).toBe(true)
    expect(S.AgentOpSchema.safeParse({ op: 'decide', suggestion: `s_${ULID}`, decision: 'reopen' }).success).toBe(false)
  })

  it('bulk reopen requires ids (D26)', () => {
    expect(S.BulkDecisionRequestSchema.safeParse({ opKey: `op_${ULID}`, decision: 'accept', authors: ['Claude'] }).success).toBe(true)
    expect(S.BulkDecisionRequestSchema.safeParse({ opKey: `op_${ULID}`, decision: 'reopen', authors: [] }).success).toBe(false)
    expect(S.BulkDecisionRequestSchema.safeParse({ opKey: `op_${ULID}`, decision: 'reopen', authors: [], ids: [`s_${ULID}`] }).success).toBe(true)
  })

  it('sidecar events: envelope plus the per-type payload, by constrained per type', () => {
    const base = { seq: 12, id: `e_${ULID}`, at: '2026-10-15T17:02:11.123Z', rev: 8 }
    const add = { ...base, type: 'comment.add', by: 'TJ', key: `tj:op_${ULID}`, thread: `t_${ULID}`, comment: `c_${ULID}`, anchor: shortAnchor, body: 'Is 12% current?' }
    expect(S.SidecarEventSchema.safeParse(add).success).toBe(true)
    expect(S.SidecarEventSchema.safeParse({ ...add, by: 'system' }).success).toBe(false)
    const ack = { ...base, type: 'ack', by: 'Claude', upTo: 11 }
    expect(S.SidecarEventSchema.safeParse(ack).success).toBe(true)
    expect(S.SidecarEventSchema.safeParse({ ...ack, by: 'TJ' }).success).toBe(false)
    const { seq: _s, id: _i, at: _a, rev: _r, ...input } = ack
    expect(S.NewEventSchema.safeParse(input).success).toBe(true)
    expect(S.NewEventSchema.safeParse(ack).success).toBe(false)
    expect(S.HandoffEventInputSchema.safeParse({ type: 'handoff.sent', message: null, delivery: 'clipboard' }).success).toBe(true)
    expect(S.HandoffEventInputSchema.safeParse({ type: 'handoff.sent', by: 'TJ', message: null, delivery: 'clipboard' }).success).toBe(false)
  })

  it('the frozen header and protocol literals', () => {
    expect(S.SidecarHeaderSchema.safeParse({
      type: 'header', schema: 'mdr.sidecar/2', docId: `d_${ULID}`, file: 'PLAN.md', createdAt: '2026-10-15T17:00:00.000Z', createdBy: 'mdr/2.0.0-dev',
    }).success).toBe(true)
    expect(S.SidecarHeaderSchema.safeParse({
      type: 'header', schema: 'mdr.sidecar/1', docId: `d_${ULID}`, file: 'PLAN.md', createdAt: '2026-10-15T17:00:00.000Z', createdBy: 'mdr/1',
    }).success).toBe(false)
  })
})

// keep the type-only helper referenced so an unused-type lint never strips it
expectTypeOf<Deep<{ a: 1 } & { b: 2 }>>().toEqualTypeOf<{ a: 1; b: 2 }>()
