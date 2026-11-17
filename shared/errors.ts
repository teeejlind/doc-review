// doc-review v2 (mdr): FROZEN error type (CONTRACTS §3.9, §8.2). Owner: integrator.
// Every DocStore / core failure is a StoreError. Routes map it 1:1 to ApiError (overlaying presence and
// activity on `review` through withHandoff, §3.9); the CLI maps it 1:1 to CliErr on stdout plus
// ERROR_TABLE's exit code.
import { ERROR_TABLE } from './types'
import type { ApiErrorBody, DocSnapshot, ErrorCode, StoreReviewState } from './types'

export type StoreErrorExtra = Omit<ApiErrorBody, 'code' | 'message'>

export class StoreError extends Error {
  readonly code: ErrorCode
  /** HTTP status from ERROR_TABLE (0 = never on the wire). */
  readonly status: number
  /** CLI exit code from ERROR_TABLE. */
  readonly exit: number
  readonly body: ApiErrorBody
  readonly current: DocSnapshot | undefined
  readonly review: StoreReviewState | undefined

  constructor(
    code: ErrorCode,
    message: string,
    extra: StoreErrorExtra = {},
    snap: { current?: DocSnapshot; review?: StoreReviewState } = {},
  ) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.status = ERROR_TABLE[code].http
    this.exit = ERROR_TABLE[code].exit
    this.body = { ...extra, code, message }
    this.current = snap.current
    this.review = snap.review
  }
}

export function isStoreError(e: unknown): e is StoreError {
  return e instanceof StoreError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'StoreError'
    && typeof (e as { code?: unknown }).code === 'string' && (e as { code: string }).code in ERROR_TABLE)
}

export const httpFor = (code: ErrorCode): number => ERROR_TABLE[code].http
export const exitFor = (code: ErrorCode): number => ERROR_TABLE[code].exit
