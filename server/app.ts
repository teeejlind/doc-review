// server/app.ts (P1). Builds the Hono app and everything a running server holds (CONTRACTS §8, §3.6, §3.8, §8.6,
// §9.2.1, D18, D32).
//
// - Stores: one DocStore per validated file, opened in server mode on first use and cached (§3.9). Each store's change
//   listener feeds the SSE fan-out synchronously (the store emits after releasing its lock, in commit order), so every
//   browser client sees doc-changed / sidecar-changed / doc-removed in seq order with the request's clientId (echo
//   suppression, D32), and HandoffDeps.onSidecarAppended fires for every append, whoever wrote it. A store whose docId
//   changes under a client (a deleted or replaced sidecar, row 29) also gets `resync`.
// - The scoped watcher (server/watcher.ts, D18): every opened doc and its sidecar, LRU-capped at WATCH_MAX_FILES; an
//   event runs reconcileDoc, which adopts direct-mode CLI writes and records external writes and deletions (§3.6).
// - Maintenance (§3.8, §10): history retention and objects GC shortly after a store opens, then hourly.
// - Middleware, in order: §8.1 security (server/security.ts) → long-lived streams (socket timeout off for
//   /api/events and /api/agent/wait, §8.7) → agent route reporting (HandoffDeps.onAgentRequest, every /api/agent/*
//   request with its AgentRoute; the file from ?file= or the body) → TJ activity (a browser write's clientId marks its
//   SSE client most recently active, §8.4 open).
// - Routes: health; the read routes (routes/read.ts); the browser writes (routes/write.ts); the agent writes and
//   controls (routes/agent.ts); /__test/splice-fault under test hooks (routes/test-hooks.ts); GET /__dev/meta under
//   MDR_DEV_ORIGIN=1; the handoff module (P4, through HandoffDeps); the SPA with meta injection (static.ts). Every wire
//   ReviewState goes through routes/review.ts#withHandoff, including the `review` of error bodies (§3.9).
// - Idle exit (generalization pass): with `idleExitMs` > 0, the server calls onIdle once after that long with no
//   browser stream open (any channel), no waiter present on an opened doc (presence other than `none`), and no /api
//   request (GET /api/health excluded: other roots' discovery probes it). startServer stops itself there.
import type { IncomingMessage } from 'node:http'
import { Hono } from 'hono'
import type {
  AgentRoute, CreateHandoffModule, DocId, DocStore, Health, HandoffDeps, HandoffModule, PendingCounts, SidecarEvent,
  StoreChange, Unsubscribe,
} from '../shared/types'
import { CONSTANTS, PROTOCOL } from '../shared/constants'
import { isStoreError } from '../shared/errors'
import { MDR_VERSION } from '../shared/version'
import { maintainDoc, openDocStore, reconcileDoc, storeCursor, storeTextAt } from '../node/docstore'
import { mdrCmd } from '../node/config'
import { resolveDisplayName } from '../node/identity'
import { createHandoffModule } from './handoff/index'
import { actorFor, apiError, securityMiddleware, sendStoreError, validateFile, type ServerEnv } from './security'
import { createSseHub, storeChangeEvents, type SseHub } from './sse'
import { renderMetaTags, staticRoutes, type MetaContext } from './static'
import { createScopedWatcher, type ScopedWatcher } from './watcher'
import type { RouteCtx } from './routes/context'
import { readRoutes } from './routes/read'
import { writeRoutes } from './routes/write'
import { agentRoutes } from './routes/agent'
import { testHookRoutes } from './routes/test-hooks'
import { revealRoutes } from './routes/reveal'
import { withHandoff } from './routes/review'

export interface AppOptions {
  root: string
  rootHash: string
  port: number
  pid: number
  serverId: string
  startedAt: string
  token: string
  schemaFingerprint: string
  /** The protocol the server requires and reports (PROTOCOL, or MDR_TEST_PROTOCOL under test hooks). */
  protocol: number
  testHooks: boolean
  devOrigin: boolean
  vitePort: number
  heartbeatMs: number
  /** Overrides the SPA directory (tests). */
  webDir?: string
  /** POST /api/agent/shutdown: called after the response with the requested reason (startServer closes itself). */
  onShutdown?: (reason: 'stop' | 'restart') => void
  /** Last-stream-closed beacon flush delay; default BEACON_GRACE_MS (§7.1). */
  beaconGraceMs?: number
  /** Watcher debounce; default 50 ms (reconcile does its own stability read). */
  watchDebounceMs?: number
  /** Watched-doc cap; default WATCH_MAX_FILES (D18). */
  watchMax?: number
  /** Maintenance interval; default hourly (§3.8). The first run is MAINTENANCE_FIRST_MS after a store opens. */
  maintenanceMs?: number
  /** Replaces the handoff module (tests script presence/activity through it). Default server/handoff/index.ts. */
  createHandoff?: CreateHandoffModule<Hono>
  /** Idle exit after this many ms with no browser stream, waiter or /api request; 0 or absent = never. */
  idleExitMs?: number
  /** Called once when the idle window passes (startServer closes the server with reason 'stop'). */
  onIdle?: () => void
  /** How often idleness is checked; default idleExitMs / 4, clamped to 250 ms .. 60 s. */
  idleCheckMs?: number
}

export interface ServerApp {
  app: Hono<ServerEnv>
  hub: SseHub
  handoff: HandoffModule<Hono>
  deps: HandoffDeps
  watcher: ScopedWatcher
  health(): Health
  /** The cached store for a validated file. */
  store(file: string): Promise<DocStore>
  close(reason: 'stop' | 'restart' | 'signal'): Promise<void>
}

const HOUR_MS = 60 * 60 * 1000
const MAINTENANCE_FIRST_MS = 2_000
const ZERO_COUNTS: PendingCounts = { threads: 0, messages: 0, suggestions: 0, decisions: 0, resolves: 0, edits: 0, external: 0, notices: 0, handoffs: 0 }
const KNOWN_AGENT_ROUTES: readonly AgentRoute[] = [
  'status', 'pending', 'thread', 'snapshot', 'batch', 'history', 'open', 'policy', 'wait', 'consume', 'disarm', 'shutdown', 'arm',
]
/** Agent routes whose `file` comes in the JSON body (§8.1 step 7). */
const BODY_FILE_ROUTES: ReadonlySet<AgentRoute> = new Set(['open', 'policy', 'consume', 'disarm', 'arm'])

/** '/api/agent/batch' → 'batch'; '/api/agent/handoff/consume' → 'consume'; '/api/agent/history/diff' → 'history'. */
export function agentRouteOf(path: string): AgentRoute | null {
  const parts = path.replace(/^\/api\/agent\/?/, '').split('/').filter(Boolean)
  const name = parts[0] === 'handoff' ? parts[1] : parts[0]
  return name && (KNOWN_AGENT_ROUTES as readonly string[]).includes(name) ? (name as AgentRoute) : null
}

/** SSE routes never time out (§8.7): Node's per-socket timeout off for the request's socket. */
export function keepSocketOpen(env: unknown): void {
  const incoming = (env as { incoming?: IncomingMessage } | undefined)?.incoming
  incoming?.socket?.setTimeout(0)
}

export function createServerApp(o: AppOptions): ServerApp {
  const hub = createSseHub({ heartbeatMs: o.heartbeatMs })
  const stores = new Map<string, Promise<DocStore>>()
  const opened = new Map<string, DocStore>()
  const unsubs: Unsubscribe[] = []
  const docIds = new Map<string, DocId | null>()
  const sidecarListeners = new Set<(file: string, events: SidecarEvent[]) => void>()
  const agentListeners = new Set<(file: string | null, route: AgentRoute) => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let closed = false
  const subscribe = <T>(set: Set<T>, cb: T): Unsubscribe => {
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  const watcher = createScopedWatcher({
    max: o.watchMax ?? CONSTANTS.WATCH_MAX_FILES,
    debounceMs: o.watchDebounceMs ?? 50,
    pinned: (file) => hub.clients(file).length > 0,
    onChange: async (file) => {
      const s = opened.get(file)
      if (s && !closed) await reconcileDoc(s)
    },
  })

  /** One committed StoreChange → SSE for the file's channel, then the sidecar listeners (handoff module). */
  const fanOut = (file: string, store: DocStore, ch: StoreChange): void => {
    const cur = storeCursor(store) ?? { rev: 0, seq: 0, docId: null }
    for (const { e, id } of storeChangeEvents(file, ch, cur, (h) => storeTextAt(store, h))) hub.broadcast(file, e, id)
    if (ch.kind === 'sidecar') {
      for (const cb of [...sidecarListeners]) {
        try {
          cb(file, ch.events)
        } catch {
          // a listener never breaks the fan-out
        }
      }
    }
    // a reset sidecar (new docId under an open session): the client refetches and notices (§12.6, row 29)
    const prev = docIds.get(file)
    if (prev !== undefined && prev !== null && prev !== cur.docId) hub.broadcast(file, { event: 'resync', data: { reason: 'gap' } })
    docIds.set(file, cur.docId)
  }

  const maintain = (s: DocStore): void => {
    void maintainDoc(s).catch(() => undefined)
  }

  const store = (file: string): Promise<DocStore> => {
    let p = stores.get(file)
    if (!p) {
      p = openDocStore(o.root, file, { mode: 'server', lockTimeoutMs: CONSTANTS.LOCK_TIMEOUT_SERVER_MS }).then((s) => {
        opened.set(file, s)
        docIds.set(file, storeCursor(s)?.docId ?? null)
        unsubs.push(s.onChange((ch) => fanOut(file, s, ch)))
        if (!closed) {
          watcher.watch(file, s.abs)
          const t = setTimeout(() => {
            timers.delete(t)
            if (!closed) maintain(s)
          }, MAINTENANCE_FIRST_MS)
          t.unref?.()
          timers.add(t)
        }
        return s
      })
      const mine = p
      stores.set(file, mine)
      mine.catch(() => {
        if (stores.get(file) === mine) stores.delete(file)
      })
    } else {
      const s = opened.get(file)
      if (s && !closed) watcher.watch(file, s.abs)
    }
    return p
  }

  const hourly = setInterval(() => {
    for (const s of opened.values()) maintain(s)
  }, o.maintenanceMs ?? HOUR_MS)
  hourly.unref?.()

  const deps: HandoffDeps = {
    root: o.root,
    rootHash: o.rootHash,
    port: o.port,
    store,
    broadcast: (file, e) => hub.broadcast(file, e),
    onSidecarAppended: (cb) => subscribe(sidecarListeners, cb),
    onAgentRequest: (cb) => subscribe(agentListeners, cb),
    pendingCounts: async (file): Promise<PendingCounts> => {
      try {
        return (await (await store(file)).agent.pending()).counts
      } catch {
        return ZERO_COUNTS
      }
    },
  }
  const handoff = (o.createHandoff ?? createHandoffModule)(deps)

  const health = (): Health => ({
    ok: true, app: 'mdr', version: MDR_VERSION, protocol: o.protocol as typeof PROTOCOL, schemaFingerprint: o.schemaFingerprint,
    root: o.root, rootHash: o.rootHash, port: o.port, pid: o.pid, serverId: o.serverId, startedAt: o.startedAt,
  })
  const meta: MetaContext = {
    root: o.root, rootHash: o.rootHash, port: o.port, token: o.token, version: MDR_VERSION, protocol: o.protocol,
    schemaFingerprint: o.schemaFingerprint, testHooks: o.testHooks,
    user: () => resolveDisplayName(), agentCmd: () => mdrCmd(),
  }

  // idle exit: the last moment anything was using this server
  let lastActive = Date.now()
  let idleFired = false
  const idleMs = o.idleExitMs ?? 0
  const busyNow = (): boolean => {
    if (hub.clients().length > 0) return true
    for (const file of opened.keys()) {
      try {
        if (handoff.presence(file).waiter !== 'none') return true
      } catch {
        // a presence read never decides the exit
      }
    }
    return false
  }
  const idleTimer = idleMs > 0
    ? setInterval(() => {
      if (closed || idleFired) return
      const now = Date.now()
      if (busyNow()) lastActive = now
      else if (now - lastActive >= idleMs) {
        idleFired = true
        o.onIdle?.()
      }
    }, o.idleCheckMs ?? Math.min(60_000, Math.max(250, Math.floor(idleMs / 4))))
    : null
  idleTimer?.unref?.()
  const overlay = withHandoff(handoff)

  const app = new Hono<ServerEnv>()
  app.use('*', securityMiddleware({
    root: o.root, rootHash: o.rootHash, port: o.port, token: o.token, protocol: o.protocol, devOrigin: o.devOrigin, vitePort: o.vitePort,
  }))
  // §8.7 long-lived streams: the request's socket never times out (requestTimeout 0 is set on the server itself)
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' && (c.req.path === '/api/events' || c.req.path === '/api/agent/wait')) keepSocketOpen(c.env)
    await next()
  })
  // every agent request reports its route to the handoff module (§8.4, §8.5), after the security checks passed
  app.use('/api/agent/*', async (c, next) => {
    const route = agentRouteOf(c.req.path)
    if (route && agentListeners.size) {
      const body = c.get('body') as { file?: unknown } | undefined
      const raw = c.req.query('file') ?? (BODY_FILE_ROUTES.has(route) && typeof body?.file === 'string' ? body.file : undefined)
      const v = raw !== undefined ? validateFile(o.root, raw) : null
      if (v === null || v.ok) {
        for (const cb of [...agentListeners]) {
          try {
            cb(v ? v.file : null, route)
          } catch {
            // a listener never fails the request
          }
        }
      }
    }
    await next()
  })
  // any /api request but health counts as use (idle exit)
  app.use('/api/*', async (c, next) => {
    if (c.req.path !== '/api/health') lastActive = Date.now()
    await next()
  })
  // a browser request carrying a client id counts as that client's activity (§8.4 open)
  app.use('/api/*', async (c, next) => {
    const id = c.get('clientId')
    if (id && actorFor(c.req.path) === 'TJ') hub.touch(id)
    await next()
  })

  let shutdownRequested = false
  const ctx: RouteCtx = {
    root: o.root,
    port: o.port,
    heartbeatMs: o.heartbeatMs,
    beaconGraceMs: o.beaconGraceMs ?? CONSTANTS.BEACON_GRACE_MS,
    store,
    hasStore: (file) => stores.has(file),
    handoff,
    hub,
    health,
    withHandoff: overlay,
    shutdown: (reason) => {
      if (shutdownRequested) return
      shutdownRequested = true
      // after the response has gone out
      const t = setTimeout(() => o.onShutdown?.(reason), 25)
      t.unref?.()
    },
  }
  const reads = readRoutes(ctx)

  app.get('/api/health', (c) => c.json(health()))
  if (o.devOrigin) {
    app.get('/__dev/meta', (c) => {
      c.header('Cache-Control', 'no-store')
      return c.html(renderMetaTags(c.req.query('file'), meta))
    })
  }
  app.route('/', reads.routes)
  app.route('/', writeRoutes(ctx))
  app.route('/', agentRoutes(ctx))
  app.route('/', revealRoutes(ctx, { testHooks: o.testHooks }))
  if (o.testHooks) app.route('/', testHookRoutes(ctx))
  app.route('/', handoff.routes)
  app.route('/', staticRoutes(meta, ...(o.webDir !== undefined ? [o.webDir] : [])))

  app.notFound((c) => (c.req.path.startsWith('/api/') || c.req.path.startsWith('/__')
    ? c.json(apiError('BAD_REQUEST', `no route ${c.req.method} ${c.req.path}`), 404)
    : c.text('not found', 404)))
  app.onError((e, c) => {
    if (isStoreError(e)) return sendStoreError(c, e, overlay)
    return c.json(apiError('INTERNAL', e instanceof Error ? e.message : String(e)), 500)
  })

  const close = async (reason: 'stop' | 'restart' | 'signal'): Promise<void> => {
    if (closed) return
    closed = true
    reads.close()
    clearInterval(hourly)
    if (idleTimer) clearInterval(idleTimer)
    for (const t of timers) clearTimeout(t)
    timers.clear()
    hub.broadcastAll({ event: 'server-shutdown', data: { reason } })
    // HandoffModule.shutdown (P4 merge): queue server-shutdown on the waiter streams; close() awaits their drain
    void handoff.shutdown?.(reason)
    await handoff.close().catch(() => undefined)
    await watcher.close()
    for (const u of unsubs) u()
    for (const p of stores.values()) {
      try {
        const s = await p
        await s.flushTjSession('shutdown').catch(() => undefined)
        await s.close().catch(() => undefined)
      } catch {
        // a store that never opened has nothing to flush
      }
    }
    stores.clear()
    opened.clear()
    hub.closeAll()
  }

  return { app, hub, handoff, deps, watcher, health, store, close }
}
