// server/routes/context.ts (P1). What every route module gets from server/app.ts, plus the shared request helpers:
// the §8.1 step-7 `file` resolution (with DOC_GONE for a recorded doc whose file vanished), query parsing, request-body
// validation against shared/schemas.ts, and the TjCtx of a browser write (D32).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'hono'
import type { DocStore, Health, HandoffModule, ReviewState, StoreReviewState, TjCtx } from '../../shared/types'
import { StoreError } from '../../shared/errors'
import type { SseHub } from '../sse'
import { validateFile, type ServerEnv } from '../security'

export interface RouteCtx {
  root: string
  port: number
  heartbeatMs: number
  /** Last-stream-closed beacon flush delay (§7.1): BEACON_GRACE_MS (tests shorten it). */
  beaconGraceMs: number
  /** The cached store for a validated file (the same instance the handoff module gets). */
  store(file: string): Promise<DocStore>
  /** True when the server has a store open for this file (a doc it serves stays addressable once deleted). */
  hasStore(file: string): boolean
  handoff: HandoffModule<unknown>
  hub: SseHub
  health(): Health
  /** §3.9: the one place a wire ReviewState is built from the store's. */
  withHandoff(r: StoreReviewState): ReviewState
  /** POST /api/agent/shutdown: answer first, then close the server with this reason. */
  shutdown(reason: 'stop' | 'restart'): void
}

/**
 * §8.1 step 7 on `?file=` (or a body's `file`): POSIX-relative, inside the root, .md/.markdown, not protected, existing.
 * A missing file whose sidecar exists was a recorded doc: 410 DOC_GONE rather than 404 (§8.3). `allowGone` lets the
 * routes that act on a gone doc through (a `cause: 'recreate'` save, a beacon flush): the store answers them.
 */
export function resolveFile(root: string, raw: string | null | undefined, o: { allowGone?: boolean; known?: (file: string) => boolean } = {}): string {
  const v = validateFile(root, raw)
  if (v.ok) return v.file
  if (v.code === 'FILE_NOT_FOUND' && raw) {
    const file = raw.normalize('NFC')
    const recorded = existsSync(join(root, file) + '.review.jsonl') || (o.known?.(file) ?? false)
    if (recorded) {
      if (o.allowGone) return file
      throw new StoreError('DOC_GONE', `${file} was moved or deleted`, { hint: 'restore the file, or reopen it from its new path' })
    }
  }
  throw new StoreError(v.code, v.message)
}

export function fileOf(c: Context, root: string): string {
  return resolveFile(root, c.req.query('file'))
}

/** `?name=0|1` (also true/false); absent → undefined. */
export function flagOf(c: Context, name: string): boolean | undefined {
  const v = c.req.query(name)
  if (v === undefined) return undefined
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false' || v === '') return false
  throw new StoreError('BAD_REQUEST', `?${name}= must be 0 or 1`)
}

/** A non-negative integer query value; absent or empty → undefined. */
export function natOf(c: Context, name: string): number | undefined {
  const v = c.req.query(name)
  if (v === undefined || v === '') return undefined
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new StoreError('BAD_REQUEST', `?${name}= must be a non-negative integer`)
  return Number(v)
}

type SafeParser = { safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }

/** Validate a request body against its shared/schemas.ts schema; the first issue becomes a BAD_REQUEST message. */
export function parseBody<T>(schema: SafeParser, v: unknown, what: string): T {
  const r = schema.safeParse(v)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new StoreError('BAD_REQUEST', `invalid ${what}: ${i ? `${i.path.map(String).join('.') || '(root)'}: ${i.message}` : 'schema mismatch'}`)
  }
  return r.data as T
}

/** The parsed JSON body the security middleware stashed. */
export function bodyOf(c: Context<ServerEnv>): unknown {
  return c.get('body')
}

/** The store context of a browser write: its X-MDR-Client-Id, stamped on the commit's SSE events (D32). */
export function tjCtxOf(c: Context<ServerEnv>): TjCtx {
  const id = c.get('clientId')
  return id ? { clientId: id } : {}
}

/** A path parameter checked against an id format (malformed → BAD_REQUEST). */
export function idParam<T extends string>(c: Context<ServerEnv>, ok: (s: string) => s is T, what: string): T {
  const v = c.req.param('id') ?? ''
  if (!ok(v)) throw new StoreError('BAD_REQUEST', `malformed ${what} id ${JSON.stringify(v)}`)
  return v
}
