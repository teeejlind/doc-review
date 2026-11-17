// server/security.ts (P1). Transport, identity and security middleware (CONTRACTS §8.1, D4, D13, D32, D43).
//
// Checks, for every request:
//   1 Host: 127.0.0.1:<port> | localhost:<port>, else 421 MISDIRECTED (health included).
//   2 Actor by path prefix: /api/agent/* = Claude, every other /api/* = TJ. /__test/* (test hooks) takes the browser
//     checks. Static, /__dev/meta and GET /api/health take no credentials.
//   5 Token: Bearer (or ?t= on GET /api/events and GET /api/asset, which EventSource and <img> can't give headers):
//     missing or wrong → 401, never a default actor. The token is checked before the header rules below, so a request
//     with no credentials at all is always 401 (the same order as tests/fakes/fakeApp.ts; see contract-changes/P1.md).
//   4 Agent routes: no Origin at all (403 FORBIDDEN_ORIGIN, so a page can never post as Claude), X-MDR-Client: cli
//     (400), X-MDR-Protocol = the served protocol (426 PROTOCOL_MISMATCH with the restart hint).
//   3 Browser routes: an Origin, when present, must be on the allow-list (exact `http://127.0.0.1:<port>` or
//     `http://localhost:<port>`; plus the Vite origins under MDR_DEV_ORIGIN=1); non-GET requires one. X-MDR-Client: web
//     (400) except on /api/events and /api/asset. Non-GET requires X-MDR-Client-Id = k_<ULID> (400); /api/events
//     requires ?clientId=.
//   6 Body (non-GET): at most MAX_BODY_BYTES (413), JSON when non-empty (400), and no top-level `by`, `author` or
//     `actor` (400 IDENTITY_IN_BODY). The parsed body is stashed for the routes (`c.get('body')`); Hono caches the raw
//     text, so a handler that calls c.req.json() itself (the handoff module) still reads it.
//   8 X-MDR-Root-Hash on every response.
// Step 7 (`file`) is validateFile, which routes, the handoff module and static.ts call. No CORS headers and no
// preflight handling (D43): a cross-origin page is simply refused by the browser.
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { Context, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiError, ApiErrorBody, ClientId, ErrorCode, ReviewState, StoreReviewState } from '../shared/types'
import { ERROR_TABLE } from '../shared/constants'
import { isStoreError, type StoreError, type StoreErrorExtra } from '../shared/errors'
import { isClientId } from '../shared/ids'
import { mdrCmd } from '../node/config'
import { assertServable, realId } from '../node/root'

export interface SecurityOptions {
  root: string
  rootHash: string
  port: number
  token: string
  /** The protocol agent routes require (PROTOCOL, or MDR_TEST_PROTOCOL under test hooks). */
  protocol: number
  /** MDR_DEV_ORIGIN=1: also admit the Vite dev server's origins (dev script only). */
  devOrigin: boolean
  vitePort: number
}

/** The actor a route belongs to by its path prefix; null = not an /api route. */
export type RouteActor = 'TJ' | 'Claude' | null

/** Hono env shared by every P1 route module: what the middleware established for the request. */
export type ServerEnv = {
  Variables: {
    /** The parsed JSON body of a non-GET request (undefined when empty). */
    body: unknown
    /** X-MDR-Client-Id of a browser write, or ?clientId= on /api/events (D32). */
    clientId: ClientId | undefined
    actor: RouteActor
  }
}

/** Request bodies above this are 413 (a save carries at most the whole doc, MAX_DOC_BYTES, a few times over). */
export const MAX_BODY_BYTES = 16 * 1024 * 1024

/** The §8.1 Origin allow-list: exact strings, scheme http, no path. */
export function allowedOrigins(o: Pick<SecurityOptions, 'port' | 'devOrigin' | 'vitePort'>): Set<string> {
  const s = new Set([`http://127.0.0.1:${o.port}`, `http://localhost:${o.port}`])
  if (o.devOrigin) {
    s.add(`http://127.0.0.1:${o.vitePort}`)
    s.add(`http://localhost:${o.vitePort}`)
  }
  return s
}

export function apiError(code: ErrorCode, message: string, extra: StoreErrorExtra = {}): ApiError {
  const error: ApiErrorBody = { ...extra, code, message }
  return { ok: false, error }
}

/**
 * HTTP status of an error code: ERROR_TABLE's, and for the few codes the table keeps off the wire (ROOT_MISMATCH from
 * /api/agent/shutdown, USAGE) a 409 / 400 so a route can still answer them.
 */
export function statusOf(code: ErrorCode): ContentfulStatusCode {
  const http = ERROR_TABLE[code].http
  if (http) return http as ContentfulStatusCode
  return (code === 'ROOT_MISMATCH' ? 409 : code === 'USAGE' ? 400 : 500) as ContentfulStatusCode
}

export function sendError(c: Context, code: ErrorCode, message: string, extra: StoreErrorExtra = {}): Response {
  return c.json(apiError(code, message, extra), statusOf(code))
}

/**
 * StoreError → the ApiError envelope, 1:1 (§3.9). `withHandoff` overlays presence/activity on the store's review state
 * (routes/review.ts); without it the `review` field is left out.
 */
export function sendStoreError(c: Context, e: StoreError, withHandoff?: (r: StoreReviewState) => ReviewState): Response {
  const body: ApiError = { ok: false, error: e.body }
  if (e.current) body.current = e.current
  if (e.review && withHandoff) body.review = withHandoff(e.review)
  return c.json(body, e.status ? (e.status as ContentfulStatusCode) : statusOf(e.code))
}

/** Which actor a path belongs to (§8.1 step 2). null = not an /api route (static, dev, test). */
export function actorFor(path: string): RouteActor {
  if (path === '/api/agent' || path.startsWith('/api/agent/')) return 'Claude'
  if (path === '/api' || path.startsWith('/api/')) return 'TJ'
  return null
}

const bearer = (c: Context): string | null => {
  const h = c.req.header('authorization')
  return h && /^Bearer /i.test(h) ? h.slice(7).trim() : null
}

/** A top-level by / author / actor field (§8.1 step 6). */
export function identityInBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && ['by', 'author', 'actor'].some((k) => Object.prototype.hasOwnProperty.call(body, k))
}

/** The browser client id of a request (X-MDR-Client-Id, or ?clientId= on /api/events). */
export function clientIdOf(c: Context): ClientId | undefined {
  const v = c.req.header('x-mdr-client-id') ?? (c.req.path === '/api/events' ? c.req.query('clientId') : undefined)
  return v && isClientId(v) ? v : undefined
}

export function securityMiddleware(o: SecurityOptions): MiddlewareHandler<ServerEnv> {
  const hosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`])
  const origins = allowedOrigins(o)
  const stamp = (res: Response): Response => {
    try {
      res.headers.set('X-MDR-Root-Hash', o.rootHash)
    } catch {
      // immutable headers (never ours)
    }
    return res
  }

  return async (c, next) => {
    c.header('X-MDR-Root-Hash', o.rootHash)
    c.set('body', undefined)
    c.set('clientId', undefined)
    c.set('actor', null)
    const deny = (code: ErrorCode, message: string, extra: StoreErrorExtra = {}): Response => stamp(sendError(c, code, message, extra))

    // 1. Host (every request, health included). A browser always sends one; only an in-process app.fetch lacks it.
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!hosts.has(host)) return deny('MISDIRECTED', `Host must be 127.0.0.1:${o.port} or localhost:${o.port}`)

    const path = c.req.path
    const actor = actorFor(path)
    const testRoute = path.startsWith('/__test/')
    if ((actor === null && !testRoute) || path === '/api/health') {
      await next()
      stamp(c.res)
      return
    }
    c.set('actor', actor)
    const method = c.req.method
    const nonGet = method !== 'GET' && method !== 'HEAD'
    const origin = c.req.header('origin')
    const events = path === '/api/events' && !nonGet
    // an <img> can't send headers either: the asset route takes the token in ?t= and no client headers (Pass 4 #28)
    const asset = path === '/api/asset' && !nonGet

    // 5. token (before the header rules: no credentials → 401, whatever else is missing)
    const presented = events || asset ? (c.req.query('t') ?? bearer(c)) : bearer(c)
    if (presented !== o.token) return deny('UNAUTHORIZED', presented ? 'wrong token' : 'missing token')

    if (actor === 'Claude') {
      // 4. agent routes
      if (origin !== undefined) return deny('FORBIDDEN_ORIGIN', 'agent routes must carry no Origin')
      if (c.req.header('x-mdr-client') !== 'cli') return deny('BAD_REQUEST', 'agent routes require X-MDR-Client: cli')
      if (c.req.header('x-mdr-protocol') !== String(o.protocol)) {
        return deny('PROTOCOL_MISMATCH', `this server speaks protocol ${o.protocol}`, {
          hint: `${mdrCmd()} serve ${o.root} --restart`, details: { protocol: o.protocol },
        })
      }
    } else {
      // 3. browser routes (and /__test/* under test hooks)
      if (origin !== undefined && !origins.has(origin)) return deny('FORBIDDEN_ORIGIN', `Origin ${origin} is not allowed`)
      if (events) {
        const id = c.req.query('clientId')
        if (!id || !isClientId(id)) return deny('BAD_REQUEST', '?clientId= is missing or malformed (k_<ULID>)')
        c.set('clientId', id)
      } else if (!asset) {
        if (c.req.header('x-mdr-client') !== 'web') return deny('BAD_REQUEST', 'browser routes require X-MDR-Client: web')
        if (nonGet) {
          if (origin === undefined) return deny('FORBIDDEN_ORIGIN', 'a browser write must carry an allowed Origin')
          const id = c.req.header('x-mdr-client-id')
          if (!id || !isClientId(id)) return deny('BAD_REQUEST', 'X-MDR-Client-Id is missing or malformed (k_<ULID>)')
          c.set('clientId', id)
        }
      }
    }

    // 6. body
    if (nonGet) {
      const declared = Number(c.req.header('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return deny('PAYLOAD_TOO_LARGE', `request body over ${MAX_BODY_BYTES} bytes`)
      let text: string
      try {
        text = await c.req.text()
      } catch {
        return deny('BAD_REQUEST', 'unreadable request body')
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return deny('PAYLOAD_TOO_LARGE', `request body over ${MAX_BODY_BYTES} bytes`)
      let body: unknown
      if (text.trim() !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          return deny('BAD_REQUEST', 'the request body is not valid JSON')
        }
      }
      if (identityInBody(body)) return deny('IDENTITY_IN_BODY', 'request bodies never carry by / author / actor; identity comes from the route')
      c.set('body', body)
    }
    await next()
    stamp(c.res)
  }
}

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'))
const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export type FileCheck = { ok: true; file: string; abs: string } | { ok: false; code: ErrorCode; message: string }

/** §8.1 step 7: POSIX-relative, inside the root (realpath), .md/.markdown, not protected, existing. */
export function validateFile(root: string, file: string | null | undefined): FileCheck {
  if (!file) return { ok: false, code: 'BAD_REQUEST', message: 'missing ?file=' }
  file = file.normalize('NFC')
  if (file.includes('\0') || file.includes('\\') || isAbsolute(file) || /^[a-zA-Z]:/.test(file)) {
    return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: `${file} must be a POSIX path relative to the served root` }
  }
  const lexical = join(root, file)
  if (!inside(root, lexical)) return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: `${file} is outside the served root` }
  if (!/\.(md|markdown)$/i.test(file)) return { ok: false, code: 'BAD_REQUEST', message: 'only .md and .markdown files are served' }
  try {
    assertServable(root, lexical)
  } catch (e) {
    if (isStoreError(e)) return { ok: false, code: e.code, message: e.message }
    throw e
  }
  if (!existsSync(lexical)) return { ok: false, code: 'FILE_NOT_FOUND', message: `${file} does not exist` }
  const abs = realId(lexical)
  if (!inside(root, abs)) return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: `${file} resolves outside the served root` }
  if (!statSync(abs).isFile()) return { ok: false, code: 'FILE_NOT_FOUND', message: `${file} is not a file` }
  try {
    assertServable(root, abs)
  } catch (e) {
    if (isStoreError(e)) return { ok: false, code: e.code, message: e.message }
    throw e
  }
  return { ok: true, file: toPosix(relative(root, abs)).normalize('NFC'), abs }
}

/** The image types GET /api/asset serves, by extension. The Content-Type is this table's, never guessed from the bytes. */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
}

export type AssetCheck = { ok: true; abs: string; type: string } | { ok: false; code: ErrorCode; message: string }

/**
 * An image the markdown file `docFile` points at, `rel` being the path as the browser resolves it: relative to the
 * file's own folder (`./pic.png`, `images/pic.png`, `../shared/pic.png`), anywhere inside the served root and no
 * further (Pass 4 #28). Same guards as validateFile, on the file and again on its realpath (a symlink can't lead out of
 * the root or into a protected folder), plus: images only, by extension, on the path and on where it really lands (so
 * a link named pic.png can't serve notes.txt); no hidden folders or files (.git, .review); never an absolute path.
 */
export function validateAsset(root: string, docFile: string, rel: string | null | undefined): AssetCheck {
  if (!rel) return { ok: false, code: 'BAD_REQUEST', message: 'missing ?path=' }
  rel = rel.normalize('NFC')
  if (rel.includes('\0') || rel.includes('\\') || isAbsolute(rel) || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: `${rel} must be a POSIX path relative to the document` }
  }
  if (!ASSET_TYPES[extname(rel).toLowerCase()]) return { ok: false, code: 'BAD_REQUEST', message: 'only image files are served' }
  const hidden = (p: string): boolean => relative(root, p).split(sep).some((seg) => seg.startsWith('.'))
  const lexical = join(root, dirname(docFile), rel)
  if (!inside(root, lexical)) return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: `${rel} is outside the served root` }
  if (hidden(lexical)) return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: `${rel} is in a hidden folder` }
  try {
    assertServable(root, lexical)
  } catch (e) {
    if (isStoreError(e)) return { ok: false, code: e.code, message: e.message }
    throw e
  }
  if (!existsSync(lexical)) return { ok: false, code: 'FILE_NOT_FOUND', message: `${rel} does not exist` }
  const abs = realId(lexical)
  if (!inside(root, abs)) return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: `${rel} resolves outside the served root` }
  const type = ASSET_TYPES[extname(abs).toLowerCase()]
  if (!type || hidden(abs)) return { ok: false, code: 'BAD_REQUEST', message: 'only image files are served' }
  if (!statSync(abs).isFile()) return { ok: false, code: 'FILE_NOT_FOUND', message: `${rel} is not a file` }
  try {
    assertServable(root, abs)
  } catch (e) {
    if (isStoreError(e)) return { ok: false, code: e.code, message: e.message }
    throw e
  }
  return { ok: true, abs, type }
}
