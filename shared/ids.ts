// doc-review v2 (mdr): FROZEN id formats (CONTRACTS §0.4). Owner: integrator.
import type {
  BlockHash, BlockRef, ClientId, CommentId, DocId, EventId, Hash, OpKey, SuggestionId, ThreadId, VersionId, WaiterId,
} from './types'

/** Crockford base32 ULID body: 26 chars, no I L O U. */
const ULID = '[0-9A-HJKMNP-TV-Z]{26}'

export const ID_RE = {
  thread: new RegExp(`^t_${ULID}$`),
  comment: new RegExp(`^c_${ULID}$`),
  suggestion: new RegExp(`^s_${ULID}$`),
  event: new RegExp(`^e_${ULID}$`),
  doc: new RegExp(`^d_${ULID}$`),
  clientId: new RegExp(`^k_${ULID}$`),
  opKey: new RegExp(`^op_${ULID}$`),
  waiter: /^w_[0-9a-f]{16}$/,
  version: /^v[1-9][0-9]*$/,
  blockRef: /^b[1-9][0-9]*$/,
  hash: /^[0-9a-f]{64}$/,
  blockHash: /^[0-9a-f]{16}$/,
} as const

export const isThreadId = (s: string): s is ThreadId => ID_RE.thread.test(s)
export const isCommentId = (s: string): s is CommentId => ID_RE.comment.test(s)
export const isSuggestionId = (s: string): s is SuggestionId => ID_RE.suggestion.test(s)
export const isEventId = (s: string): s is EventId => ID_RE.event.test(s)
export const isDocId = (s: string): s is DocId => ID_RE.doc.test(s)
export const isClientId = (s: string): s is ClientId => ID_RE.clientId.test(s)
export const isOpKey = (s: string): s is OpKey => ID_RE.opKey.test(s)
export const isWaiterId = (s: string): s is WaiterId => ID_RE.waiter.test(s)
export const isVersionId = (s: string): s is VersionId => ID_RE.version.test(s)
export const isBlockRef = (s: string): s is BlockRef => ID_RE.blockRef.test(s)
export const isHash = (s: string): s is Hash => ID_RE.hash.test(s)
export const isBlockHash = (s: string): s is BlockHash => ID_RE.blockHash.test(s)

/** `b${index + 1}` (CONTRACTS §3.3). */
export const refOf = (index: number): BlockRef => `b${index + 1}`
/** 0-based index of a ref, or null if malformed. */
export function indexOfRef(ref: string): number | null {
  return isBlockRef(ref) ? Number(ref.slice(1)) - 1 : null
}
