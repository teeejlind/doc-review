// core/sidecar/validate.ts (P1). Sidecar event validation (CONTRACTS §4.3, §4.4, §4.5 "Fold tolerance").
//
// - Read time: checkStoredEvent classifies one parsed line: unknown type or an actor its type doesn't allow →
//   skipped with warning SIDECAR_INVALID_EVENT; a known type that fails its schema → corrupt (§4.6).
// - Write time (writers refuse, they never write an invalid event): comment bodies, anchors (the long-anchor rule,
//   D45), and the suggestion state machine (§4.5).
import type {
  Actor, Anchor, Author, ErrorCode, EventType, SidecarEvent, SuggestionStatus, TextAnchor,
} from '../../shared/types'
import { StoreError } from '../../shared/errors'
import { AnchorSchema, EventTypeSchema, SidecarEventSchema, TextAnchorSchema } from '../../shared/schemas'
import { CONSTANTS } from '../../shared/constants'

const A: readonly Actor[] = ['TJ', 'Claude']
/** §4.3: the actors each event type allows. */
export const EVENT_ACTORS: Readonly<Record<EventType, readonly Actor[]>> = {
  'comment.add': A, 'comment.reply': A, 'comment.edit': A, 'comment.delete': A,
  'thread.resolve': A, 'thread.reopen': A, 'thread.detach': ['TJ', 'system'], 'thread.reattach': ['system'],
  'anchor.update': ['TJ', 'system'],
  'suggestion.add': A, 'suggestion.update': A, 'suggestion.accept': A, 'suggestion.reject': A,
  'suggestion.reopen': ['TJ'], 'suggestion.withdraw': A, 'suggestion.rebase': ['system'], 'suggestion.stale': ['system'],
  'doc.rev': ['TJ', 'Claude', 'external', 'system'], 'doc.edit': A, 'doc.external': ['external'], 'doc.abort': ['system'],
  'doc.missing': ['external'],
  ack: ['Claude'], 'read-marker': ['TJ'], 'handoff.sent': ['TJ'], 'handoff.consumed': ['Claude', 'system'],
  'server.recovered': ['system'], 'log.repair': ['system'], 'policy.set': A,
}

export function actorAllowed(type: EventType, by: Actor): boolean {
  return EVENT_ACTORS[type].includes(by)
}

export type EventCheck =
  | { ok: true; event: SidecarEvent }
  | { ok: false; kind: 'unknown-type' | 'bad-actor' | 'invalid'; message: string }

/** Classify one parsed sidecar line (not the header). */
export function checkStoredEvent(raw: unknown): EventCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, kind: 'invalid', message: 'not a JSON object' }
  const o = raw as { type?: unknown; by?: unknown }
  const type = EventTypeSchema.safeParse(o.type)
  if (!type.success) return { ok: false, kind: 'unknown-type', message: `unknown event type ${JSON.stringify(o.type)}` }
  if (typeof o.by !== 'string' || !actorAllowed(type.data, o.by as Actor)) {
    return { ok: false, kind: 'bad-actor', message: `actor ${JSON.stringify(o.by)} is not allowed for ${type.data}` }
  }
  const r = SidecarEventSchema.safeParse(raw)
  if (!r.success) return { ok: false, kind: 'invalid', message: `invalid ${type.data}: ${r.error.issues[0]?.message ?? 'schema mismatch'}` }
  return { ok: true, event: r.data as SidecarEvent }
}

/** §4.4: 1..MAX_COMMENT_CHARS after trimming, else BAD_REQUEST. Returns the body unchanged. */
export function validateCommentBody(body: unknown): string {
  if (typeof body !== 'string') throw new StoreError('BAD_REQUEST', 'body must be a string')
  const n = body.trim().length
  if (n < 1 || n > CONSTANTS.MAX_COMMENT_CHARS) {
    throw new StoreError('BAD_REQUEST', `body must be 1..${CONSTANTS.MAX_COMMENT_CHARS} characters after trimming`)
  }
  return body
}

/** §5.2 validation (D45): quote <= MAX_QUOTE_CHARS; tail and span both or neither; long-form edge lengths. */
export function validateTextAnchor(a: TextAnchor): void {
  const r = TextAnchorSchema.safeParse(a)
  if (!r.success) throw new StoreError('BAD_REQUEST', `invalid text anchor: ${r.error.issues[0]?.message ?? 'schema mismatch'}`)
}

export function validateAnchor(a: Anchor): void {
  const r = AnchorSchema.safeParse(a)
  if (!r.success) throw new StoreError('BAD_REQUEST', `invalid anchor: ${r.error.issues[0]?.message ?? 'schema mismatch'}`)
}

export type SuggestionTransition =
  | 'suggestion.accept' | 'suggestion.reject' | 'suggestion.withdraw' | 'suggestion.reopen'
  | 'suggestion.stale' | 'suggestion.rebase' | 'suggestion.update'

/**
 * §4.5 suggestion state machine. 'ok' = legal; 'duplicate' = a repeat of the current state (append nothing, return
 * duplicate: true); otherwise the error code to refuse with.
 */
export function suggestionTransition(
  s: { status: SuggestionStatus; by: Author; decidedBy?: Author },
  t: SuggestionTransition,
  by: Author | 'system',
): 'ok' | 'duplicate' | ErrorCode {
  switch (t) {
    case 'suggestion.accept':
    case 'suggestion.reject': {
      const target: SuggestionStatus = t === 'suggestion.accept' ? 'accepted' : 'rejected'
      if (s.status === target) return 'duplicate'
      if (by === 'Claude' && s.by !== 'TJ') return 'NOT_AUTHOR'
      if (s.status === 'pending') return 'ok'
      if (s.status === 'stale') return t === 'suggestion.reject' && by === 'TJ' ? 'ok' : 'SUGGESTION_STALE'
      return 'SUGGESTION_CLOSED'
    }
    case 'suggestion.withdraw':
      if (s.status === 'withdrawn') return 'duplicate'
      if (by !== s.by) return 'NOT_AUTHOR'
      return s.status === 'pending' || s.status === 'stale' ? 'ok' : 'SUGGESTION_CLOSED'
    case 'suggestion.reopen':
      if (s.status === 'pending') return 'duplicate'
      if (by !== 'TJ') return 'NOT_AUTHOR'
      return (s.status === 'accepted' || s.status === 'rejected') && s.decidedBy === 'TJ' ? 'ok' : 'SUGGESTION_CLOSED'
    case 'suggestion.stale':
      if (s.status === 'stale') return 'duplicate'
      return s.status === 'pending' ? 'ok' : 'SUGGESTION_CLOSED'
    case 'suggestion.rebase':
      return s.status === 'pending' || s.status === 'stale' ? 'ok' : 'SUGGESTION_CLOSED'
    case 'suggestion.update':
      if (by !== s.by) return 'NOT_AUTHOR'
      return s.status === 'pending' ? 'ok' : 'SUGGESTION_CLOSED'
  }
}
