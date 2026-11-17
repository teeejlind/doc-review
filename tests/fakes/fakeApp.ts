// tests/fakes/fakeApp.ts (integrator, day 0; CONTRACTS §2.2 "HTTP", §2.5, §8, §12.0.2, D4, D32, D43, D51).
//
// Hono over FakeDocStore with every route of §8.3 and §8.4, both SSE channels (§8.6 browser, §8.7 waiter through the
// handoff stub), the root-wide client registry POST /api/agent/open uses, static serving of the built SPA with the
// <meta name="mdr-*"> injection (§12.0.2), and the test-only routes of §2.5 (/__test/presence|activity|delivery|
// handoff-state from handoffStub, plus /__test/splice-fault). The §8.1 middleware runs in order: Host, actor by path
// prefix, browser-route headers / agent-route headers, token, identity-in-body, file validation; every response carries
// X-MDR-Root-Hash. tests/contract/api.contract.test.ts runs the same suite against this app and P1's real server.
//
// In-process use (MockTransport, vitest): `app.fetch(request)`. Over a socket (startFakeServer, Playwright): the same
// app under @hono/node-server.
import '../helpers/setup-node-dom'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, posix, sep } from 'node:path'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type {
  AgentRoute, AgentSnapshotQuery, BlockHash, BrowserSseEvent, ClientId, ErrorCode, HandoffDeps, Health, HistoryRef,
  PendingCounts, ReviewState, SidecarEvent, StatusResult, StoreChange, StoreReviewState, Unsubscribe,
} from '../../shared/types'
import * as S from '../../shared/schemas'
import { CONSTANTS, PROTOCOL } from '../../shared/constants'
import { StoreError, isStoreError } from '../../shared/errors'
import { ID_RE, isBlockRef, isClientId, isCommentId, isSuggestionId, isThreadId, isVersionId } from '../../shared/ids'
import { MDR_VERSION } from '../../shared/version'
import { setSpliceFaultForTests } from '../../core/splice/apply'
import { FakeDocStore, sharedMd, type FakeDocStoreOptions } from './FakeDocStore'
import { createHandoffStub, type HandoffStub, type HandoffStubOptions } from './handoffStub'
import type { FakeEnv } from './hono-env'
import { SAMPLE_PROTECTED_SEGMENTS } from '../helpers/userEnv'

export interface FakeAppOptions {
  /** Served root: realpath + NFC (TmpRoot.root). */
  root: string
  /** The port the app is (or will be) served on: Host/Origin checks, Health, meta tags, URLs. */
  port: number
  /** Bearer token. Default: 32 random bytes as hex. */
  token?: string
  /** Mount /__test/* and inject <meta name="mdr-test-hooks" content="1">. Default true. */
  testHooks?: boolean
  /** Directory of the built SPA (startFakeServer passes .e2e-dist/web). null/absent: a minimal built-in page. */
  webDir?: string | null
  /** The protocol the server requires and reports (MDR_TEST_PROTOCOL). Default PROTOCOL. */
  protocol?: number
  /** Admit the Vite dev origins (MDR_DEV_ORIGIN=1) and mount GET /__dev/meta. */
  devOrigin?: boolean
  /** Browser SSE heartbeat. Default MDR_TEST_HEARTBEAT_MS under test hooks, else SSE_HEARTBEAT_MS. */
  heartbeatMs?: number
  /** Poll FakeDocStore.checkDisk() this often for files with SSE clients (external edits, deletions). 0 = off. Default 150. */
  diskPollMs?: number
  /** Last-stream-closed beacon flush delay (§7.1). Default BEACON_GRACE_MS. */
  beaconGraceMs?: number
  /** Extra FakeDocStore options for every opened doc (e.g. idleFlushMs). */
  storeOptions?: Partial<Omit<FakeDocStoreOptions, 'root' | 'file'>>
  handoff?: HandoffStubOptions
  /** Called after POST /api/agent/shutdown answered (startFakeServer closes the socket). */
  onShutdown?: (reason: 'stop' | 'restart') => void
}

export interface FakeApp {
  readonly app: Hono<FakeEnv>
  readonly root: string
  readonly rootHash: string
  readonly port: number
  readonly token: string
  readonly serverId: string
  readonly startedAt: string
  readonly handoff: HandoffStub
  fetch(req: Request): Promise<Response>
  /** The (cached) store for a validated root-relative file. */
  store(file: string): Promise<FakeDocStore>
  health(): Health
  /** The <meta name="mdr-*"> block for a ?file= value (§12.0.2). */
  renderMetaTags(fileParam: string | null): string
  /** Push a browser SSE event to every client of `file` (HandoffDeps.broadcast). */
  broadcast(file: string, e: BrowserSseEvent): void
  /** Connected browser SSE clients (file and root channels). */
  clientCount(): number
  /** server-shutdown to every stream, flush TJ sessions, close stores and timers. */
  close(reason?: 'stop' | 'restart' | 'signal'): Promise<void>
}

const AGENT_ROUTE_OF: Record<string, AgentRoute> = {
  status: 'status', pending: 'pending', thread: 'thread', snapshot: 'snapshot', batch: 'batch', history: 'history',
  open: 'open', policy: 'policy', wait: 'wait', handoff: 'consume', disarm: 'disarm', shutdown: 'shutdown', arm: 'arm',
}
/** Agent routes whose `file` lives in the JSON body (§8.1 step 7). */
const AGENT_BODY_FILE = new Set(['open', 'policy', 'handoff', 'disarm', 'arm'])
/** TJ's protected set, for the fake only (the real guard reads node/config.ts protectedSegments(); nothing ships a default). */
const PROTECTED_DIRS = SAMPLE_PROTECTED_SEGMENTS.split(',')
const ZERO_COUNTS: PendingCounts = { threads: 0, messages: 0, suggestions: 0, decisions: 0, resolves: 0, edits: 0, external: 0, notices: 0, handoffs: 0 }
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
}
const MINIMAL_INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><!--mdr:meta--><title>mdr (fake)</title></head>
<body><div id="mdr-app" class="mdr-app" data-mode="editing"><header class="mdr-topbar" data-testid="mdr-topbar"><div id="mdr-toolbar-host"></div></header>
<div class="mdr-banner-slot"></div><div id="mdr-scroll" class="mdr-scroll" data-testid="mdr-scroll"><div class="mdr-canvas"><main class="mdr-doc-col"><div id="mdr-editor-host"></div></main>
<aside class="mdr-rail" aria-label="Comments" data-testid="mdr-rail"></aside></div></div></div></body></html>
`

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const err = (code: ErrorCode, message: string, extra: Record<string, unknown> = {}): StoreError => new StoreError(code, message, extra)

function testNum(name: string): number | undefined {
  if (process.env.MDR_TEST_HOOKS !== '1') return undefined
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function parseHistoryRef(v: string | undefined): HistoryRef {
  if (v === 'current') return 'current'
  if (v && isVersionId(v)) return v
  if (v && /^rev:\d+$/.test(v)) return v as HistoryRef
  throw err('BAD_REQUEST', `invalid history ref ${JSON.stringify(v)} (vN, rev:N or current)`)
}

function schema<T>(z: { safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, v: unknown, what: string): T {
  const r = z.safeParse(v)
  if (!r.success) {
    const i = r.error.issues[0]
    throw err('BAD_REQUEST', `invalid ${what}: ${i ? `${i.path.map(String).join('.') || '(root)'}: ${i.message}` : 'schema mismatch'}`)
  }
  return r.data as T
}

interface SseClient {
  seq: number
  clientId: ClientId
  file: string | null
  lastActive: number
  closed: boolean
  push(e: BrowserSseEvent, id?: string): void
  close(): void
}

export async function createFakeApp(o: FakeAppOptions): Promise<FakeApp> {
  const md = await sharedMd()
  const root = o.root
  const rootHash = sha256(root)
  const port = o.port
  const token = o.token ?? randomBytes(32).toString('hex')
  const testHooks = o.testHooks ?? true
  const protocol = o.protocol ?? (testHooks ? testNum('MDR_TEST_PROTOCOL') : undefined) ?? PROTOCOL
  const heartbeatMs = o.heartbeatMs ?? testNum('MDR_TEST_HEARTBEAT_MS') ?? CONSTANTS.SSE_HEARTBEAT_MS
  const diskPollMs = o.diskPollMs ?? 150
  const beaconGraceMs = o.beaconGraceMs ?? CONSTANTS.BEACON_GRACE_MS
  const serverId = `fake-${randomBytes(6).toString('hex')}`
  const startedAt = new Date().toISOString()
  const vitePort = Number(process.env.MDR_DEV_VITE_PORT ?? 5173)
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  if (o.devOrigin) {
    allowedOrigins.add(`http://127.0.0.1:${vitePort}`)
    allowedOrigins.add(`http://localhost:${vitePort}`)
  }
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  // ------------------------------------------------------------------ stores and the client registry

  const stores = new Map<string, Promise<FakeDocStore>>()
  const storeUnsubs: Unsubscribe[] = []
  const clients = new Set<SseClient>()
  let clientSeq = 0
  const sidecarCbs = new Set<(file: string, events: SidecarEvent[]) => void>()
  const agentCbs = new Set<(file: string | null, route: AgentRoute) => void>()
  const beaconTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false

  function broadcast(file: string, e: BrowserSseEvent): void {
    for (const c of clients) if (c.file === file) c.push(e)
  }
  function broadcastRoot(e: BrowserSseEvent): void {
    for (const c of clients) c.push(e)
  }

  async function onStoreChange(file: string, store: FakeDocStore, ch: StoreChange): Promise<void> {
    const snap = { rev: 0, seq: 0 }
    try {
      const s = await store.snapshot()
      snap.rev = s.rev
      snap.seq = s.seq
    } catch {
      // DOC_GONE: ids fall back to 0.0
    }
    const id = `${snap.rev}.${snap.seq}`
    if (ch.kind === 'doc') {
      const markdown = store.currentText()
      for (const c of clients) {
        if (c.file !== file) continue
        c.push({
          event: 'doc-changed',
          data: {
            file, rev: ch.rev, prevRev: ch.prevRev, hash: ch.hash, by: ch.by, cause: ch.cause,
            ...(ch.clientId ? { clientId: ch.clientId } : {}),
            ...(ch.saveId !== undefined ? { saveId: ch.saveId } : {}),
            changes: ch.changes,
            ...(Buffer.byteLength(markdown, 'utf8') <= CONSTANTS.SSE_MARKDOWN_MAX_BYTES ? { markdown } : {}),
          },
        }, id)
      }
    } else if (ch.kind === 'sidecar') {
      const types = [...new Set(ch.events.map((e) => e.type))]
      for (const c of clients) {
        if (c.file !== file) continue
        c.push({ event: 'sidecar-changed', data: { file, fromSeq: ch.fromSeq, seq: ch.seq, types, ...(ch.clientId ? { clientId: ch.clientId } : {}) } }, id)
      }
      for (const cb of sidecarCbs) cb(file, ch.events)
    } else {
      broadcast(file, { event: 'doc-removed', data: { file } })
    }
  }

  function getStore(file: string): Promise<FakeDocStore> {
    let p = stores.get(file)
    if (!p) {
      p = FakeDocStore.create({ ...(o.storeOptions ?? {}), root, file, mode: 'server' }).then((s) => {
        // queue change handling so SSE emission keeps commit order (§8.6 "Ordering")
        let chain: Promise<unknown> = Promise.resolve()
        storeUnsubs.push(s.onChange((ch) => {
          chain = chain.then(() => onStoreChange(file, s, ch)).catch(() => undefined)
        }))
        return s
      })
      p.catch(() => stores.delete(file))
      stores.set(file, p)
    }
    return p
  }

  const deps: HandoffDeps = {
    root, rootHash, port,
    store: (file) => getStore(file),
    broadcast,
    onSidecarAppended: (cb) => {
      sidecarCbs.add(cb)
      return () => sidecarCbs.delete(cb)
    },
    onAgentRequest: (cb) => {
      agentCbs.add(cb)
      return () => agentCbs.delete(cb)
    },
    pendingCounts: async (file) => {
      try {
        return (await (await getStore(file)).agent.pending()).counts
      } catch {
        return ZERO_COUNTS
      }
    },
  }
  const handoff = createHandoffStub(deps, o.handoff ?? {})

  const withHandoff = (file: string, r: StoreReviewState): ReviewState => ({ ...r, presence: handoff.presence(file), activity: handoff.activity(file) })

  // disk polling for docs with live SSE clients: external edits and deletions reach the page (§3.6)
  const poll = diskPollMs > 0
    ? setInterval(() => {
        const live = new Set([...clients].map((c) => c.file).filter((f): f is string => f !== null))
        for (const f of live) void stores.get(f)?.then((s) => s.checkDisk()).catch(() => undefined)
      }, diskPollMs)
    : null
  poll?.unref?.()

  // ------------------------------------------------------------------ file validation (§8.1 step 7)

  function validateFile(raw0: string): string {
    const raw = raw0.normalize('NFC')
    if (raw === '' || raw.includes('\0') || raw.includes('\\')) throw err('BAD_REQUEST', 'file must be a POSIX path relative to the root')
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw err('PATH_OUTSIDE_ROOT', `${raw} is not relative to the root`)
    const norm = posix.normalize(raw)
    if (norm === '..' || norm.startsWith('../')) throw err('PATH_OUTSIDE_ROOT', `${raw} is outside the root`)
    const ext = posix.extname(norm).toLowerCase()
    if (ext !== '.md' && ext !== '.markdown') throw err('BAD_REQUEST', 'only .md and .markdown files are served')
    const dirPath = '/' + posix.dirname(norm) + '/'
    for (const seg of PROTECTED_DIRS) if (dirPath.includes(`/${seg}/`)) throw err('PROTECTED_ROOT', `${norm} is under a protected folder (${seg})`)
    const abs = join(root, ...norm.split('/'))
    if (!existsSync(abs)) {
      // a doc this app already serves and that went missing stays addressable (doc.missing / recreate, §3.6)
      if (stores.has(norm)) return norm
      throw err('FILE_NOT_FOUND', `${norm} does not exist`)
    }
    const real = realpathSync.native(abs).normalize('NFC')
    if (real !== root && !real.startsWith(root + sep)) throw err('PATH_OUTSIDE_ROOT', `${norm} resolves outside the root`)
    if (!statSync(real).isFile()) throw err('BAD_REQUEST', `${norm} is not a file`)
    return norm
  }

  function renderMetaTags(fileParam: string | null): string {
    let file = ''
    let fileError: ErrorCode | null = null
    if (fileParam !== null && fileParam !== '') {
      try {
        file = validateFile(fileParam)
      } catch (e) {
        fileError = isStoreError(e) ? e.code : 'BAD_REQUEST'
      }
    }
    const tags: Array<[string, string]> = [
      ['mdr-token', token], ['mdr-root', root], ['mdr-root-hash', rootHash], ['mdr-port', String(port)], ['mdr-file', file],
      ...(fileError ? [['mdr-file-error', fileError] as [string, string]] : []),
      ['mdr-version', MDR_VERSION], ['mdr-protocol', String(protocol)], ['mdr-fingerprint', md.schemaFingerprint],
      ...(testHooks ? [['mdr-test-hooks', '1'] as [string, string]] : []),
    ]
    return tags.map(([n, v]) => `<meta name="${n}" content="${escAttr(v)}">`).join('\n    ')
  }

  const health = (): Health => ({
    ok: true, app: 'mdr', version: MDR_VERSION, protocol: protocol as typeof PROTOCOL, schemaFingerprint: md.schemaFingerprint,
    root, rootHash, port, pid: process.pid, serverId, startedAt,
  })

  // ------------------------------------------------------------------ the app

  const app = new Hono<FakeEnv>()

  app.onError((e, c) => {
    if (isStoreError(e)) {
      const file = c.get('file')
      const status = e.status > 0 ? e.status : e.code === 'ROOT_MISMATCH' ? 409 : 400
      return c.json({
        ok: false, error: e.body,
        ...(e.current ? { current: e.current } : {}),
        ...(e.review && file ? { review: withHandoff(file, e.review) } : {}),
      }, status as 400)
    }
    return c.json({ ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }, 500)
  })
  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ ok: false, error: { code: 'BAD_REQUEST', message: `no route ${c.req.method} ${c.req.path}` } }, 404) : c.text('not found', 404)))

  // §8.1: Host, actor, headers, token, body, file. X-MDR-Root-Hash on every response.
  app.use('*', async (c, next) => {
    c.header('X-MDR-Root-Hash', rootHash)
    c.set('actor', null)
    c.set('file', null)
    c.set('body', undefined)
    c.set('clientId', undefined)
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!allowedHosts.has(host)) throw err('MISDIRECTED', `Host ${host} is not this server`)
    const path = c.req.path
    const isApi = path.startsWith('/api/')
    const isTest = path.startsWith('/__test/')
    if (!isApi && !isTest) return next()
    if (path === '/api/health') return next()
    const method = c.req.method
    const nonGet = method !== 'GET' && method !== 'HEAD'
    const origin = c.req.header('origin')
    const agent = path.startsWith('/api/agent/')
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const events = path === '/api/events'
    const presented = events ? (c.req.query('t') ?? bearer) : bearer
    if (presented !== token) throw err('UNAUTHORIZED', presented ? 'wrong token' : 'missing token')
    if (agent) {
      c.set('actor', 'Claude')
      if (origin !== undefined) throw err('FORBIDDEN_ORIGIN', 'agent routes never carry an Origin')
      if (c.req.header('x-mdr-client') !== 'cli') throw err('BAD_REQUEST', 'agent routes need X-MDR-Client: cli')
      if (c.req.header('x-mdr-protocol') !== String(protocol)) {
        throw err('PROTOCOL_MISMATCH', `this server speaks protocol ${protocol}`, { hint: `mdr serve ${root} --restart` })
      }
    } else {
      c.set('actor', isApi ? 'TJ' : null)
      if (origin !== undefined && !allowedOrigins.has(origin)) throw err('FORBIDDEN_ORIGIN', `Origin ${origin} is not allowed`)
      if (events) {
        const cid = c.req.query('clientId') ?? ''
        if (!isClientId(cid)) throw err('BAD_REQUEST', 'clientId must be k_ + ULID')
        c.set('clientId', cid)
      } else {
        if (c.req.header('x-mdr-client') !== 'web') throw err('BAD_REQUEST', 'browser routes need X-MDR-Client: web')
        if (nonGet) {
          if (origin === undefined) throw err('FORBIDDEN_ORIGIN', 'a browser write must carry an allowed Origin')
          const cid = c.req.header('x-mdr-client-id') ?? ''
          if (!ID_RE.clientId.test(cid)) throw err('BAD_REQUEST', 'X-MDR-Client-Id must be k_ + ULID')
          c.set('clientId', cid as ClientId)
          for (const cl of clients) if (cl.clientId === cid) cl.lastActive = Date.now()
        }
      }
    }
    // body (§8.1 step 6)
    if (nonGet) {
      const text = await c.req.text()
      if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw err('PAYLOAD_TOO_LARGE', 'request body over 16 MiB')
      let body: unknown = undefined
      if (text.trim() !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          throw err('BAD_REQUEST', 'body is not valid JSON')
        }
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const k of ['by', 'author', 'actor']) if (k in body) throw err('IDENTITY_IN_BODY', `a "${k}" field is never accepted; identity comes from the route`)
      }
      c.set('body', body)
    }
    // file (§8.1 step 7)
    if (isApi) {
      const seg = agent ? path.split('/')[3] ?? '' : ''
      let raw: string | undefined = c.req.query('file')
      if (agent && AGENT_BODY_FILE.has(seg)) {
        const bf = (c.get('body') as { file?: unknown } | undefined)?.file
        raw = typeof bf === 'string' ? bf : raw
      }
      const needsFile = !(path === '/api/events' || path === '/api/agent/shutdown')
      if (raw !== undefined && raw !== '') c.set('file', validateFile(raw))
      else if (needsFile) throw err('BAD_REQUEST', 'missing file')
      if (agent) {
        const route = AGENT_ROUTE_OF[seg]
        if (route) for (const cb of agentCbs) cb(c.get('file'), route)
      }
    } else if (isTest) {
      const raw = c.req.query('file') ?? (c.get('body') as { file?: unknown } | undefined)?.file
      if (typeof raw === 'string' && raw !== '') c.set('file', validateFile(raw))
    }
    return next()
  })

  app.get('/api/health', (c) => c.json(health()))

  // the handoff module's routes (P4's real module at integration; the stub until then)
  app.route('/', handoff.routes)

  // ---------------------------------------------------------------- browser routes (§8.3)

  const F = (c: Context<FakeEnv>): string => c.get('file')!
  const ctx = (c: Context<FakeEnv>): { clientId?: ClientId } => {
    const id = c.get('clientId')
    return id ? { clientId: id } : {}
  }
  const idParam = <T extends string>(c: Context<FakeEnv>, ok: (s: string) => s is T, what: string): T => {
    const v = c.req.param('id') ?? ''
    if (!ok(v)) throw err('BAD_REQUEST', `malformed ${what} id ${JSON.stringify(v)}`)
    return v
  }

  app.get('/api/doc', async (c) => c.json(await (await getStore(F(c))).snapshot()))
  app.get('/api/review', async (c) => c.json(withHandoff(F(c), await (await getStore(F(c))).review())))
  app.post('/api/save', async (c) => {
    const req = schema<import('../../shared/types').SaveRequest>(S.SaveRequestSchema, c.get('body'), 'SaveRequest')
    return c.json(await (await getStore(F(c))).save(req, ctx(c)))
  })
  app.post('/api/flush', async (c) => {
    schema(S.FlushRequestSchema, c.get('body'), 'FlushRequest')
    await (await getStore(F(c))).flushTjSession('beacon')
    return c.json({ ok: true })
  })
  app.post('/api/threads', async (c) => {
    const req = schema<import('../../shared/types').CreateThreadRequest>(S.CreateThreadRequestSchema, c.get('body'), 'CreateThreadRequest')
    return c.json(await (await getStore(F(c))).tj.createThread(req, ctx(c)))
  })
  app.post('/api/threads/:id/replies', async (c) => {
    const id = idParam(c, isThreadId, 'thread')
    const req = schema<import('../../shared/types').ReplyRequest>(S.ReplyRequestSchema, c.get('body'), 'ReplyRequest')
    return c.json(await (await getStore(F(c))).tj.reply(id, req, ctx(c)))
  })
  app.patch('/api/comments/:id', async (c) => {
    const id = idParam(c, isCommentId, 'comment')
    const req = schema<import('../../shared/types').EditCommentRequest>(S.EditCommentRequestSchema, c.get('body'), 'EditCommentRequest')
    return c.json(await (await getStore(F(c))).tj.editComment(id, req, ctx(c)))
  })
  app.post('/api/comments/:id/delete', async (c) => {
    const id = idParam(c, isCommentId, 'comment')
    const req = schema<import('../../shared/types').OpKeyRequest>(S.OpKeyRequestSchema, c.get('body'), 'OpKeyRequest')
    return c.json(await (await getStore(F(c))).tj.deleteComment(id, req, ctx(c)))
  })
  for (const verb of ['resolve', 'reopen'] as const) {
    app.post(`/api/threads/:id/${verb}`, async (c) => {
      const id = idParam(c, isThreadId, 'thread')
      const req = schema<import('../../shared/types').OpKeyRequest>(S.OpKeyRequestSchema, c.get('body'), 'OpKeyRequest')
      const store = await getStore(F(c))
      return c.json(await (verb === 'resolve' ? store.tj.resolve(id, req, ctx(c)) : store.tj.reopen(id, req, ctx(c))))
    })
  }
  app.post('/api/suggestions/bulk', async (c) => {
    const req = schema<import('../../shared/types').BulkDecisionRequest>(S.BulkDecisionRequestSchema, c.get('body'), 'BulkDecisionRequest')
    return c.json(await (await getStore(F(c))).tj.bulkDecide(req, ctx(c)))
  })
  for (const verb of ['accept', 'reject', 'reopen'] as const) {
    app.post(`/api/suggestions/:id/${verb}`, async (c) => {
      const id = idParam(c, isSuggestionId, 'suggestion')
      const req = schema<import('../../shared/types').DecideRequest>(S.DecideRequestSchema, c.get('body'), 'DecideRequest')
      const store = await getStore(F(c))
      return c.json(await (verb === 'reopen' ? store.tj.reopenSuggestion(id, req, ctx(c)) : store.tj.decide(id, verb, req, ctx(c))))
    })
  }
  app.post('/api/policy', async (c) => {
    const req = schema<import('../../shared/types').PolicyRequest>(S.PolicyRequestSchema, c.get('body'), 'PolicyRequest')
    return c.json(await (await getStore(F(c))).tj.setPolicy(req, ctx(c)))
  })
  app.post('/api/read-marker', async (c) => {
    const req = schema<import('../../shared/types').ReadMarkerRequest>(S.ReadMarkerRequestSchema, c.get('body'), 'ReadMarkerRequest')
    return c.json(await (await getStore(F(c))).tj.readMarker(req, ctx(c)))
  })

  const limitOf = (c: Context<FakeEnv>): { limit?: number } => {
    const l = c.req.query('limit')
    if (l === undefined) return {}
    const n = Number(l)
    if (!Number.isInteger(n) || n < 1) throw err('BAD_REQUEST', 'limit must be a positive integer')
    return { limit: n }
  }
  const versionOf = (c: Context<FakeEnv>): import('../../shared/types').VersionId => {
    const v = c.req.query('v') ?? ''
    if (!isVersionId(v)) throw err('BAD_REQUEST', 'v must be vN')
    return v
  }
  for (const prefix of ['/api', '/api/agent'] as const) {
    app.get(`${prefix}/history`, async (c) => c.json(await (await getStore(F(c))).history.list(limitOf(c))))
    app.get(`${prefix}/history/version`, async (c) => c.json(await (await getStore(F(c))).history.show(versionOf(c))))
    app.get(`${prefix}/history/diff`, async (c) =>
      c.json(await (await getStore(F(c))).history.diff(parseHistoryRef(c.req.query('from')), parseHistoryRef(c.req.query('to')))))
  }
  app.post('/api/history/restore', async (c) => {
    const req = schema<import('../../shared/types').RestoreRequest>(S.RestoreRequestSchema, c.get('body'), 'RestoreRequest')
    return c.json(await (await getStore(F(c))).tj.restore(req, ctx(c)))
  })

  // ---------------------------------------------------------------- browser SSE (§8.6)

  app.get('/api/events', (c) => {
    const file = c.get('file')
    const clientId = c.get('clientId')!
    const num = (k: string): number | undefined => {
      const v = c.req.query(k)
      if (v === undefined || v === '') return undefined
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    const afterSeq = num('afterSeq')
    const knownRev = num('knownRev')
    return streamSSE(c, async (stream) => {
      let queue: Promise<unknown> = Promise.resolve()
      const client: SseClient = {
        seq: ++clientSeq, clientId, file, lastActive: Date.now(), closed: false,
        push(e, id) {
          queue = queue.then(() => (client.closed ? undefined : stream.writeSSE({ event: e.event, data: JSON.stringify(e.data), ...(id ? { id } : {}) })))
        },
        close() {
          client.closed = true
        },
      }
      clients.add(client)
      if (file) {
        const t = beaconTimers.get(file)
        if (t) {
          clearTimeout(t)
          beaconTimers.delete(file)
        }
        const store = await getStore(file)
        try {
          const snap = await store.snapshot()
          client.push({
            event: 'hello',
            data: {
              serverId, protocol: protocol as typeof PROTOCOL, version: MDR_VERSION, schemaFingerprint: md.schemaFingerprint, file,
              docId: snap.docId, rev: snap.rev, hash: snap.hash, seq: snap.seq, presence: handoff.presence(file), activity: handoff.activity(file),
            },
          }, `${snap.rev}.${snap.seq}`)
          if ((afterSeq !== undefined && snap.seq > afterSeq) || (knownRev !== undefined && snap.rev !== knownRev)) {
            client.push({ event: 'resync', data: { reason: 'gap' } })
          }
        } catch (e) {
          if (isStoreError(e) && e.code === 'DOC_GONE') client.push({ event: 'doc-removed', data: { file } })
          else throw e
        }
      }
      const hb = setInterval(() => {
        queue = queue.then(() => (client.closed ? undefined : stream.write(': hb\n\n')))
      }, heartbeatMs)
      hb.unref?.()
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve())
        const p = setInterval(() => {
          if (client.closed) {
            clearInterval(p)
            resolve()
          }
        }, 50)
        p.unref?.()
        stream.onAbort(() => clearInterval(p))
      })
      clearInterval(hb)
      client.closed = true
      clients.delete(client)
      if (file && ![...clients].some((x) => x.file === file) && !closed) {
        const t = setTimeout(() => {
          beaconTimers.delete(file)
          if (![...clients].some((x) => x.file === file)) void stores.get(file)?.then((s) => s.flushTjSession('beacon')).catch(() => undefined)
        }, beaconGraceMs)
        t.unref?.()
        beaconTimers.set(file, t)
      }
    })
  })

  // ---------------------------------------------------------------- agent routes (§8.4)

  app.get('/api/agent/status', async (c) => {
    const file = F(c)
    const base = await (await getStore(file)).agent.status()
    const out: StatusResult = {
      ...base,
      server: { state: 'up', port, url: `http://127.0.0.1:${port}/`, pid: process.pid, version: MDR_VERSION, protocol },
      presence: handoff.presence(file),
      activity: handoff.activity(file),
    }
    return c.json(out)
  })
  app.get('/api/agent/pending', async (c) => c.json(await (await getStore(F(c))).agent.pending()))
  app.get('/api/agent/thread', async (c) => {
    const id = c.req.query('id') ?? ''
    if (!isThreadId(id)) throw err('BAD_REQUEST', 'id must be a thread id')
    return c.json(await (await getStore(F(c))).agent.thread(id))
  })
  app.get('/api/agent/snapshot', async (c) => {
    const q: AgentSnapshotQuery = {}
    const flag = (k: 'md' | 'text'): void => {
      const v = c.req.query(k)
      if (v === '1' || v === 'true') q[k] = true
    }
    flag('md')
    flag('text')
    for (const k of ['from', 'to'] as const) {
      const v = c.req.query(k)
      if (v === undefined) continue
      if (!isBlockRef(v)) throw err('BAD_REQUEST', `${k} must be a block ref (bN)`)
      q[k] = v
    }
    return c.json(await (await getStore(F(c))).agent.snapshot(q))
  })
  app.post('/api/agent/batch', async (c) => {
    const req = schema<import('../../shared/types').BatchRequest>(S.BatchRequestSchema, c.get('body'), 'BatchRequest')
    return c.json(await (await getStore(F(c))).agent.batch(req))
  })
  app.post('/api/agent/open', (c) => {
    const file = F(c)
    const sorted = [...clients].sort((a, b) => b.lastActive - a.lastActive || b.seq - a.seq)
    const target = sorted[0]
    let navigated = false
    if (target) {
      navigated = true
      if (target.file !== file) target.push({ event: 'navigate', data: { file } })
    }
    return c.json({ ok: true, connectedTabs: clients.size, navigated })
  })
  app.post('/api/agent/policy', async (c) => {
    const { file: _f, ...rest } = (c.get('body') ?? {}) as Record<string, unknown>
    const req = schema<import('../../shared/types').PolicyRequest>(S.PolicyRequestSchema, rest, 'policy request')
    return c.json(await (await getStore(F(c))).agent.setPolicy(req))
  })
  app.post('/api/agent/shutdown', (c) => {
    const b = (c.get('body') ?? {}) as { root?: unknown; reason?: unknown }
    if (b.root !== root) throw err('ROOT_MISMATCH', 'shutdown refused: root does not match the served root')
    const reason = b.reason === 'restart' ? 'restart' : 'stop'
    queueMicrotask(() => {
      void close(reason).then(() => o.onShutdown?.(reason))
    })
    return c.json({ ok: true })
  })

  // ---------------------------------------------------------------- test-only routes (§2.5, D51)

  if (testHooks) {
    app.route('/', handoff.testRoutes)
    app.post('/__test/splice-fault', (c) => {
      const b = (c.get('body') ?? {}) as { blockHashes?: unknown }
      if (!Array.isArray(b.blockHashes) || !b.blockHashes.every((h) => typeof h === 'string')) throw err('BAD_REQUEST', 'blockHashes must be an array of block hashes')
      const set = new Set(b.blockHashes as BlockHash[])
      setSpliceFaultForTests(set.size ? (op) => op.covers.some((h) => set.has(h)) : null)
      return c.json({ ok: true, blockHashes: [...set] })
    })
  }

  // ---------------------------------------------------------------- dev + static (§12.0.2)

  if (o.devOrigin) {
    app.get('/__dev/meta', (c) => {
      c.header('Cache-Control', 'no-store')
      return c.html(renderMetaTags(c.req.query('file') ?? null))
    })
  }
  const indexHtml = (c: Context<FakeEnv>): Response => {
    const idx = o.webDir ? join(o.webDir, 'index.html') : null
    const html = idx && existsSync(idx) ? readFileSync(idx, 'utf8') : MINIMAL_INDEX
    c.header('Cache-Control', 'no-store')
    return c.html(html.replace('<!--mdr:meta-->', renderMetaTags(c.req.query('file') ?? null)))
  }
  app.get('/', indexHtml)
  app.get('/index.html', indexHtml)
  app.get('/*', (c) => {
    if (!o.webDir) return c.text('not found', 404)
    const rel = posix.normalize(c.req.path).replace(/^\/+/, '')
    if (rel.startsWith('..')) return c.text('not found', 404)
    const p = join(o.webDir, ...rel.split('/'))
    if (!existsSync(p) || !statSync(p).isFile()) return c.text('not found', 404)
    c.header('Content-Type', MIME[extname(p).toLowerCase()] ?? 'application/octet-stream')
    if (rel.startsWith('assets/')) c.header('Cache-Control', 'public, max-age=31536000, immutable')
    return c.body(readFileSync(p))
  })

  // ---------------------------------------------------------------- lifecycle

  async function close(reason: 'stop' | 'restart' | 'signal' = 'stop'): Promise<void> {
    if (closed) return
    closed = true
    broadcastRoot({ event: 'server-shutdown', data: { reason } })
    handoff.shutdown(reason)
    // let the shutdown frames flush before the streams end
    await new Promise((r) => setTimeout(r, 20))
    for (const cl of clients) cl.close()
    clients.clear()
    if (poll) clearInterval(poll)
    for (const t of beaconTimers.values()) clearTimeout(t)
    beaconTimers.clear()
    await handoff.close()
    for (const u of storeUnsubs) u()
    for (const p of stores.values()) {
      const s = await p.catch(() => null)
      await s?.close()
    }
  }

  return {
    app, root, rootHash, port, token, serverId, startedAt, handoff,
    fetch: (req) => Promise.resolve(app.fetch(req)),
    store: (file) => getStore(validateFile(file)),
    health,
    renderMetaTags,
    broadcast,
    clientCount: () => clients.size,
    close,
  }
}
