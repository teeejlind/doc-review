// web/src/session/errors.ts (P2). The one error type the session rejects with (CONTRACTS §8.2, §12.0.3).
//
// Shaped so P3's codeOf() reads it the same way as a StoreError: `code` on the error itself, the ApiErrorBody in
// `body`, plus the HTTP status (0 for a network failure) and, for 409s, the `current` snapshot and `review` state the
// server attached.
import { ERROR_TABLE } from '../../../shared/types'
import type { ApiErrorBody, DocSnapshot, ErrorCode, ReviewState } from '../../../shared/types'

export class SessionError extends Error {
  readonly code: ErrorCode
  /** HTTP status; 0 when the request never got an answer (network error, server down). */
  readonly status: number
  readonly body: ApiErrorBody
  readonly current: DocSnapshot | undefined
  readonly review: ReviewState | undefined
  /** true when fetch rejected (no HTTP answer at all). */
  readonly network: boolean

  constructor(o: { code: ErrorCode; status: number; message: string; body?: ApiErrorBody; current?: DocSnapshot; review?: ReviewState; network?: boolean }) {
    super(o.message)
    this.name = 'SessionError'
    this.code = o.code
    this.status = o.status
    this.body = o.body ?? { code: o.code, message: o.message }
    this.current = o.current
    this.review = o.review
    this.network = o.network === true
  }
}

const isCode = (c: unknown): c is ErrorCode => typeof c === 'string' && c in ERROR_TABLE

/** A non-2xx answer as a SessionError (the ApiError envelope when there is one). */
export function errorFromResponse(status: number, json: unknown): SessionError {
  const env = (json ?? {}) as { error?: Partial<ApiErrorBody>; current?: DocSnapshot; review?: ReviewState }
  const body = env.error
  const code: ErrorCode = isCode(body?.code) ? body.code : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'
  const message = typeof body?.message === 'string' ? body.message : `HTTP ${status}`
  return new SessionError({
    code,
    status,
    message,
    body: { ...(body ?? {}), code, message },
    ...(env.current !== undefined ? { current: env.current } : {}),
    ...(env.review !== undefined ? { review: env.review } : {}),
  })
}

/** fetch rejected: the server is unreachable. */
export function networkError(cause: unknown): SessionError {
  const message = cause instanceof Error ? cause.message : 'the mdr server is unreachable'
  return new SessionError({ code: 'SERVER_UNREACHABLE', status: 0, message, network: true })
}

export function isSessionError(e: unknown): e is SessionError {
  return e instanceof SessionError
}

/** Network failures and 5xx answers both mean "try again later" (§12.4), except the codes a retry can't fix. */
const NOT_RETRYABLE_5XX: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'SPLICE_MISMATCH', 'SUGGESTION_RESIDUE', 'SIDECAR_CORRUPT', 'SIDECAR_SCHEMA_UNSUPPORTED',
])
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof SessionError)) return false
  if (e.network) return true
  return e.status >= 500 && !NOT_RETRYABLE_5XX.has(e.code)
}
