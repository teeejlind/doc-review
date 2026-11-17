// tests/unit/handoff/harness.ts (P4). An in-process host for the real handoff module: a Hono app with the bits of the
// §8.1 middleware the module relies on (X-MDR-Root-Hash, agent routes reported to onAgentRequest with their file,
// StoreError → ApiError), HandoffDeps over P1's real doc store (openDocStore in server mode on a tmp root, so a
// "restart" rebuilds the module and the stores from the same sidecar, D46), a recorded browser broadcast log, and
// waiter-stream readers. Full-server coverage (P1's app, security middleware, the built CLI) is in tests/e2e/p4-*.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve as honoServe } from '@hono/node-server'
import { Hono } from 'hono'
import type {
  AgentRoute, BrowserSseEvent, DocStore, HandoffDeps, HandoffResult, PendingCounts, SidecarEvent, WaiterSseEvent,
} from '../../../shared/types'
import { CONSTANTS, PROTOCOL } from '../../../shared/constants'
import { isStoreError } from '../../../shared/errors'
import { MDR_VERSION } from '../../../shared/version'
import '../../../node/dom'
import { parseSidecar } from '../../../core/sidecar/parse'
import { openDocStore } from '../../../node/docstore'
import { realId, rootHashOf } from '../../../node/root'
import { ensureReviewDir } from '../../../node/review-dir'
import { createHandoffModuleWith, type HandoffModuleOptions, type P4HandoffModule, type HandoffCore } from '../../../server/handoff/index'
import { readSse } from '../../helpers/sse'

export const PORT = 18_765
export const ORIGIN = `http://127.0.0.1:${PORT}`
const AGENT_BODY_FILE = new Set(['handoff', 'disarm', 'arm', 'open', 'policy'])

export interface WaiterReader {
  /** Every waiter event so far (heartbeats excluded). */
  readonly events: WaiterSseEvent[]
  readonly heartbeats: number
  readonly status: number
  /** Resolves when an event of that name arrives (or at once if it already did). */
  next(name: WaiterSseEvent['event'], timeoutMs?: number): Promise<WaiterSseEvent>
  /** true once the server ended the stream. */
  readonly ended: boolean
  ended$: Promise<void>
  /** Client goes away (the socket closes). */
  cancel(): Promise<void>
}

export interface Harness {
  readonly root: string
  readonly file: string
  module: P4HandoffModule & { core: HandoffCore }
  app: Hono
  /** Every browser broadcast, in order. */
  readonly broadcasts: BrowserSseEvent[]
  store(file?: string): Promise<DocStore>
  /** The sidecar's committed events (header dropped), read from disk with the real parser. */
  events(file?: string): SidecarEvent[]
  agentRequest(route: AgentRoute, file?: string | null): void
  handoff(o?: { message?: string; clientDecision?: 'waiter' | 'clipboard'; opKey?: string; onlyIfNew?: boolean }): Promise<HandoffResult>
  arm(): Promise<unknown>
  disarm(): Promise<unknown>
  consume(handoffs: number[], waiter?: string): Promise<{ ok: true; seq: number }>
  wait(waiter: string, gen?: number): Promise<WaiterReader>
  raw(method: string, path: string, body?: unknown): Promise<Response>
  /** A fresh module and fresh stores over the same root and sidecar (what a server restart is). */
  restart(): Promise<void>
  /**
   * Serve the app on 127.0.0.1 (with GET /api/health) and write <root>/.review/server.json, so the CLI's discovery
   * finds it exactly as it finds a real server. `protocol` / `rootHash` override what health and responses report.
   */
  serve(o?: { port?: number; protocol?: number; rootHash?: string }): Promise<Served>
  close(): Promise<void>
}

export interface Served {
  readonly port: number
  readonly token: string
  /** module.shutdown(reason), then close the socket (the marker stays, as after a crash or a restart). */
  stop(reason?: 'stop' | 'restart' | 'signal'): Promise<void>
}

export const TOKEN = 'f'.repeat(64)

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = netServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

let opSeq = 0
export const opKey = (): `op_${string}` => `op_${String(++opSeq).padStart(26, '0')}`
export const W1 = 'w_0000000000000001'
export const W2 = 'w_0000000000000002'

export async function createHarness(o: { options?: HandoffModuleOptions; markdown?: string; file?: string } = {}): Promise<Harness> {
  const root = realId(mkdtempSync(join(tmpdir(), 'mdr-handoff-')))
  const file = o.file ?? 'doc.md'
  writeFileSync(join(root, file), o.markdown ?? '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n')
  const broadcasts: BrowserSseEvent[] = []
  const readers: WaiterReader[] = []
  const sockets: Server[] = []

  let servedPort = PORT
  let protocol: number = PROTOCOL
  let rootHashHeader = rootHashOf(root)
  const startedAt = new Date().toISOString()
  let stores = new Map<string, Promise<DocStore>>()
  let sidecarCbs = new Set<(file: string, events: SidecarEvent[]) => void>()
  let agentCbs = new Set<(file: string | null, route: AgentRoute) => void>()

  const getStore = (f: string): Promise<DocStore> => {
    let p = stores.get(f)
    if (!p) {
      const cbs = sidecarCbs
      p = openDocStore(root, f, { mode: 'server', lockTimeoutMs: CONSTANTS.LOCK_TIMEOUT_SERVER_MS }).then((s) => {
        s.onChange((ch) => {
          if (ch.kind === 'sidecar') for (const cb of cbs) cb(f, ch.events)
        })
        return s
      })
      stores.set(f, p)
    }
    return p
  }

  const build = (): { module: P4HandoffModule & { core: HandoffCore }; app: Hono } => {
    const deps: HandoffDeps = {
      root, rootHash: rootHashOf(root), port: servedPort,
      store: (f) => getStore(f),
      broadcast: (_f, e) => broadcasts.push(e),
      onSidecarAppended: (cb) => {
        sidecarCbs.add(cb)
        return () => sidecarCbs.delete(cb)
      },
      onAgentRequest: (cb) => {
        agentCbs.add(cb)
        return () => agentCbs.delete(cb)
      },
      pendingCounts: async (f): Promise<PendingCounts> => (await (await getStore(f)).agent.pending()).counts,
    }
    const module = createHandoffModuleWith(deps, o.options ?? {})
    const app = new Hono()
    app.get('/api/health', (c) => c.json({
      ok: true, app: 'mdr', version: MDR_VERSION, protocol, schemaFingerprint: '0'.repeat(16), root, rootHash: rootHashOf(root),
      port: servedPort, pid: process.pid, serverId: 'srv_harness', startedAt,
    }))
    app.use('*', async (c, next) => {
      c.header('X-MDR-Root-Hash', rootHashHeader)
      if (c.req.path.startsWith('/api/agent/')) {
        const seg = c.req.path.split('/')[3] ?? ''
        let f: string | null = c.req.query('file') ?? null
        if (AGENT_BODY_FILE.has(seg) && c.req.method === 'POST') {
          const b = (await c.req.json().catch(() => null)) as { file?: unknown } | null
          if (b && typeof b.file === 'string') f = b.file
        }
        const route = (seg === 'handoff' ? 'consume' : seg) as AgentRoute
        for (const cb of agentCbs) cb(f, route)
      }
      await next()
    })
    app.route('/', module.routes)
    app.onError((e, c) => {
      if (isStoreError(e)) return c.json({ ok: false, error: e.body }, (e.status || 400) as 400)
      return c.json({ ok: false, error: { code: 'INTERNAL', message: String(e) } }, 500)
    })
    return { module, app }
  }

  let built = build()

  const raw = (method: string, path: string, body?: unknown): Promise<Response> =>
    Promise.resolve(built.app.fetch(new Request(ORIGIN + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-mdr-client-id': 'k_00000000000000000000000001' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })))
  const json = async <T>(r: Promise<Response>): Promise<T> => {
    const res = await r
    const j = (await res.json()) as T
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j)}`)
    return j
  }

  const h: Harness = {
    root, file, broadcasts,
    get module() {
      return built.module
    },
    get app() {
      return built.app
    },
    store: (f = file) => getStore(f),
    events: (f = file) => {
      try {
        return parseSidecar(readFileSync(join(root, f) + '.review.jsonl', 'utf8')).events
      } catch {
        return []
      }
    },
    agentRequest: (route, f = file) => {
      for (const cb of agentCbs) cb(f, route)
    },
    handoff: (ho = {}) => json<HandoffResult>(raw('POST', `/api/handoff?file=${encodeURIComponent(file)}`, {
      opKey: ho.opKey ?? opKey(), clientDecision: ho.clientDecision ?? 'waiter', ...(ho.message !== undefined ? { message: ho.message } : {}),
      ...(ho.onlyIfNew ? { onlyIfNew: true } : {}),
    })),
    arm: () => json(raw('POST', '/api/agent/arm', { file })),
    disarm: () => json(raw('POST', '/api/agent/disarm', { file })),
    consume: (handoffs, waiter) => json(raw('POST', '/api/agent/handoff/consume', { file, handoffs, ...(waiter ? { waiter } : {}) })),
    async wait(waiter, gen = 1) {
      const res = await raw('GET', `/api/agent/wait?file=${encodeURIComponent(file)}&waiter=${waiter}&gen=${gen}`)
      const events: WaiterSseEvent[] = []
      let heartbeats = 0
      let ended = false
      const ac = new AbortController()
      const listeners = new Set<() => void>()
      let endResolve!: () => void
      const ended$ = new Promise<void>((r) => (endResolve = r))
      if (res.status === 200 && res.body) {
        void (async () => {
          try {
            for await (const f of readSse(res.body!, ac.signal)) {
              if (f.kind === 'comment') heartbeats++
              else events.push({ event: f.message.event, data: JSON.parse(f.message.data) } as WaiterSseEvent)
              for (const l of listeners) l()
            }
          } catch {
            // cancelled
          }
          ended = true
          endResolve()
          for (const l of listeners) l()
        })()
      } else {
        ended = true
        endResolve()
      }
      const reader: WaiterReader = {
        events,
        get heartbeats() {
          return heartbeats
        },
        status: res.status,
        get ended() {
          return ended
        },
        ended$,
        next: (name, timeoutMs = 2000) => new Promise((resolve, reject) => {
          const hit = (): boolean => {
            const e = events.find((x) => x.event === name)
            if (e) {
              listeners.delete(check)
              clearTimeout(t)
              resolve(e)
              return true
            }
            return false
          }
          const check = (): void => {
            if (!hit() && ended) {
              listeners.delete(check)
              clearTimeout(t)
              reject(new Error(`stream ended before ${name}; got ${JSON.stringify(events)}`))
            }
          }
          const t = setTimeout(() => {
            listeners.delete(check)
            reject(new Error(`timed out waiting for ${name}; got ${JSON.stringify(events)}`))
          }, timeoutMs)
          listeners.add(check)
          check()
        }),
        async cancel() {
          ac.abort()
          await ended$
        },
      }
      readers.push(reader)
      return reader
    },
    raw,
    async restart() {
      for (const r of readers) if (!r.ended) await r.cancel()
      await built.module.close()
      for (const p of stores.values()) await (await p).close()
      stores = new Map()
      sidecarCbs = new Set()
      agentCbs = new Set()
      built = build()
    },
    async serve(so = {}) {
      const port = so.port ?? (await freePort())
      servedPort = port
      protocol = so.protocol ?? PROTOCOL
      rootHashHeader = so.rootHash ?? rootHashOf(root)
      await built.module.close()
      built = build()
      const server = await new Promise<Server>((resolve, reject) => {
        const s = honoServe({ fetch: (req: Request) => built.app.fetch(req), port, hostname: '127.0.0.1' }) as Server
        s.requestTimeout = 0
        s.once('error', reject)
        s.once('listening', () => resolve(s))
      })
      sockets.push(server)
      ensureReviewDir(root)
      writeFileSync(join(root, '.review', 'server.json'), JSON.stringify({
        app: 'mdr', root, rootHash: rootHashOf(root), port, pid: process.pid, serverId: 'srv_harness', version: MDR_VERSION,
        protocol: PROTOCOL, startedAt, token: TOKEN,
      }), { mode: 0o600 })
      return {
        port, token: TOKEN,
        async stop(reason = 'stop') {
          await built.module.shutdown(reason)
          await new Promise<void>((r) => {
            server.close(() => r())
            server.closeAllConnections?.()
          })
        },
      }
    },
    async close() {
      for (const s of sockets) {
        await new Promise<void>((r) => {
          s.close(() => r())
          s.closeAllConnections?.()
        })
      }
      for (const r of readers) if (!r.ended) await r.cancel().catch(() => {})
      await built.module.close()
      for (const p of stores.values()) await (await p).close().catch(() => {})
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}

/** Wait until `pred` holds (polling the event loop). */
export async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until: timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

export const presenceEvents = (h: Harness): string[] =>
  h.broadcasts.filter((e) => e.event === 'presence').map((e) => (e.data as { waiter: string }).waiter)
export const handoffStates = (h: Harness): Array<[number, string, string]> =>
  h.broadcasts.filter((e): e is Extract<BrowserSseEvent, { event: 'handoff' }> => e.event === 'handoff').map((e) => [e.data.seq, e.data.state, e.data.delivery])
