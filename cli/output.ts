// cli/output.ts (P4). The §9.1 output contract: exactly one JSON document on stdout per invocation (compact, or
// indented with --pretty), CliOk-shaped (`ok: true`) or CliErr, with the ERROR_TABLE exit code; stderr carries at
// most one human line on failure, plus progress only with --verbose.
import type { ApiErrorBody, CliErr, ErrorCode } from '../shared/types'
import { ERROR_TABLE } from '../shared/constants'
import { isStoreError } from '../shared/errors'
import { exitCodeFor } from './exit'

/** The end of a run: this document on stdout, this exit code. Thrown or returned by commands. */
export class CliExit {
  /** `printed`: the document already went to stdout (the `wait` handoff line is written and drained before consume). */
  constructor(readonly doc: unknown, readonly code: number, readonly printed = false) {}
}

export function cliErr(code: ErrorCode, message: string, extra: Omit<ApiErrorBody, 'code' | 'message'> = {}): CliExit {
  const doc: CliErr = { ok: false, error: { ...extra, code, message } }
  return new CliExit(doc, exitCodeFor(code))
}

export const ok = (doc: unknown, code = 0): CliExit => new CliExit(doc, code)

/** Any thrown value → CliExit: a StoreError maps 1:1 (body and `current`), anything else is INTERNAL. */
export function fromError(e: unknown): CliExit {
  if (e instanceof CliExit) return e
  if (isStoreError(e)) {
    const doc: CliErr = { ok: false, error: e.body }
    if (e.current) doc.current = e.current
    return new CliExit(doc, e.exit)
  }
  return cliErr('INTERNAL', e instanceof Error ? e.message : String(e))
}

/** An HTTP JSON body → the CLI result: ok → exit 0; an ApiError → CliErr 1:1; anything else → INTERNAL with details.status. */
export function fromHttp(status: number, text: string): CliExit {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return cliErr('INTERNAL', `the server answered ${status} with a non-JSON body`, { details: { status } })
  }
  const b = body as { ok?: unknown; error?: { code?: unknown }; current?: unknown }
  if (b && b.ok === true && status >= 200 && status < 300) return new CliExit(body, 0)
  if (b && b.ok === false && b.error && typeof b.error.code === 'string' && b.error.code in ERROR_TABLE) {
    const doc = { ok: false, error: b.error, ...(b.current ? { current: b.current } : {}) } as CliErr
    return new CliExit(doc, ERROR_TABLE[b.error.code as ErrorCode].exit)
  }
  return cliErr('INTERNAL', `the server answered ${status} with an unexpected body`, { details: { status } })
}

/** The one human stderr line for a failure (§9.1), e.g. "mdr: QUOTE_AMBIGUOUS: quote matches 2 places". */
export function failureLine(doc: unknown): string | null {
  const d = doc as { ok?: unknown; error?: { code?: unknown; message?: unknown; hint?: unknown } }
  if (!d || d.ok !== false || !d.error) return null
  const hint = typeof d.error.hint === 'string' && d.error.hint ? ` (${d.error.hint})` : ''
  return `mdr: ${String(d.error.code)}: ${String(d.error.message)}${hint}`.replace(/\s+/g, ' ').trim()
}

export function render(doc: unknown, pretty: boolean): string {
  return JSON.stringify(doc, null, pretty ? 2 : undefined) + '\n'
}
