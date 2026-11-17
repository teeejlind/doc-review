// tests/helpers/startFakeServer.ts (integrator, day 0; CONTRACTS §2.5 "P2 and P3 run before the real layers land",
// §1.3, §8.7, §9.2).
//
// Serves fakeApp (FakeDocStore + the handoff stub) over a real socket on 127.0.0.1 with @hono/node-server, from the
// test process, plus the built SPA from .e2e-dist/web with the meta injection. It also writes the §9.2.1 marker
// (`<root>/.review/server.json`, mode 0600, after `.review/.gitignore`) with this process's pid, so the day-0 CLI's
// discovery (`mdr batch`, `mdr wait`) finds the fake exactly as it finds a real server. SSE routes run with no request
// or socket timeout (§8.7). `restart()` builds a new app over the same root and port from what is on disk (sidecar
// included), keeping the token, which is what a server restart looks like to a client.
import './setup-node-dom'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { BrowserSseEvent, ClaudeActivity, Presence, ServerMarker } from '../../shared/types'
import { PROTOCOL } from '../../shared/constants'
import { MDR_VERSION } from '../../shared/version'
import { ensureReviewDir } from '../../node/review-dir'
import { createFakeApp, type FakeApp, type FakeAppOptions } from '../fakes/fakeApp'
import type { FakeDocStore } from '../fakes/FakeDocStore'
import { browserHeaders, workerPort } from './startServer'
import { REPO_ROOT } from './tmpRoot'

/** The e2e build of the SPA (§1.2). */
export const E2E_WEB_DIR = join(REPO_ROOT, '.e2e-dist', 'web')

export interface FakeServerOptions extends Partial<Omit<FakeAppOptions, 'root' | 'port' | 'onShutdown'>> {
  root: string
  /** Default workerPort(0). */
  port?: number
  /** Write <root>/.review/server.json (default true) so the CLI discovers the fake. */
  writeMarker?: boolean
}

export interface FakeServerHandle {
  readonly root: string
  readonly port: number
  readonly origin: string
  readonly url: string
  readonly token: string
  readonly app: FakeApp
  readonly marker: ServerMarker | null
  store(file: string): Promise<FakeDocStore>
  /** POST a /__test/* route with the browser-route headers; resolves the JSON answer (throws on non-2xx). */
  testHook(path: string, body: unknown, file?: string): Promise<unknown>
  setPresence(file: string, p: Presence | null): Promise<void>
  setActivity(file: string, a: Omit<ClaudeActivity, 'file'> | null): Promise<void>
  forceDelivery(d: 'waiter' | 'latched' | 'clipboard' | null): Promise<void>
  emitHandoffState(file: string, state: Extract<BrowserSseEvent, { event: 'handoff' }>['data']['state'], o?: { seq?: number; delivery?: 'waiter' | 'latched' | 'clipboard' }): Promise<void>
  /** Close the socket and the app (server-shutdown to every stream; marker removed). */
  close(reason?: 'stop' | 'restart' | 'signal'): Promise<void>
  /** Close, then serve a fresh app over the same root and port with the same token. */
  restart(): Promise<FakeServerHandle>
}

function writeMarkerFile(root: string, m: ServerMarker): void {
  const dir = ensureReviewDir(root)
  const tmp = join(dir, `.server.json.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, join(dir, 'server.json'))
}

function listen(app: FakeApp, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as Server
    server.requestTimeout = 0
    server.on('connection', (s) => s.setTimeout(0))
    server.once('error', reject)
    server.once('listening', () => resolve(server))
  })
}

export async function startFakeServer(o: FakeServerOptions): Promise<FakeServerHandle> {
  const port = o.port ?? workerPort(0)
  const { root, port: _p, writeMarker = true, ...appOpts } = o
  let server: Server | null = null
  let closed = false
  const app = await createFakeApp({
    webDir: existsSync(E2E_WEB_DIR) ? E2E_WEB_DIR : null,
    ...appOpts,
    root,
    port,
    onShutdown: () => {
      void handle.close('stop')
    },
  })
  server = await listen(app, port)
  const marker: ServerMarker | null = writeMarker
    ? {
        app: 'mdr', root, rootHash: app.rootHash, port, pid: process.pid, serverId: app.serverId, version: MDR_VERSION,
        protocol: PROTOCOL, startedAt: app.startedAt, token: app.token,
      }
    : null
  if (marker) writeMarkerFile(root, marker)
  const origin = `http://127.0.0.1:${port}`

  const testHook = async (path: string, body: unknown, file?: string): Promise<unknown> => {
    const q = file ? `${path.includes('?') ? '&' : '?'}file=${encodeURIComponent(file)}` : ''
    const r = await fetch(`${origin}${path}${q}`, {
      method: 'POST',
      headers: { ...browserHeaders({ token: app.token, port, clientId: `k_${'0'.repeat(26)}` }), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await r.json()) as unknown
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(json)}`)
    return json
  }

  const handle: FakeServerHandle = {
    root, port, origin, url: `${origin}/`, token: app.token, app, marker,
    store: (file) => app.store(file),
    testHook,
    setPresence: async (file, p) => {
      await testHook(p === null ? '/__test/presence?reset=1' : '/__test/presence', p, file)
    },
    setActivity: async (file, a) => {
      await testHook(a === null ? '/__test/activity?reset=1' : '/__test/activity', a, file)
    },
    forceDelivery: async (d) => {
      await testHook('/__test/delivery', { delivery: d })
    },
    emitHandoffState: async (file, state, eo = {}) => {
      await testHook('/__test/handoff-state', { state, ...eo }, file)
    },
    async close(reason = 'stop') {
      if (closed) return
      closed = true
      await app.close(reason)
      if (server) {
        const s = server
        server = null
        await new Promise<void>((res) => {
          s.close(() => res())
          s.closeAllConnections?.()
        })
      }
      if (marker) {
        const p = join(root, '.review', 'server.json')
        try {
          const cur = JSON.parse(readFileSync(p, 'utf8')) as ServerMarker
          if (cur.serverId === marker.serverId) rmSync(p, { force: true })
        } catch {
          // already gone
        }
      }
    },
    async restart() {
      await handle.close('restart')
      return startFakeServer({ ...o, port, token: app.token })
    },
  }
  return handle
}
