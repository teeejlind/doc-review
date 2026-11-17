// server/index.ts (P1). startServer (CONTRACTS §9.2.1); P4's `mdr serve --foreground` calls it.
//
// Order: re-run assertServable (node/root.ts) → ensureReviewDir(root) (§3.7: .review/.gitignore before server.json)
// → build the app and mount the handoff module → bind 127.0.0.1:port (busy → reject PORT_EXHAUSTED, never take over)
// with the long-lived-stream settings (§8.7: requestTimeout 0, no server-wide socket timeout, headersTimeout left at
// Node's default; the SSE routes also turn their own socket's timeout off, server/app.ts) → THEN write the marker →
// resolve RunningServer.
// close(reason) — also reached through POST /api/agent/shutdown — broadcasts server-shutdown to browser and waiter
// streams, flushes open TJ sessions ('shutdown'), closes the watcher and the stores, removes the marker iff it is
// still ours and the reason is 'stop' ('restart' and 'signal' leave it, so the token survives the restart), and
// unbinds: idle sockets at once, any socket still busy after CLOSE_GRACE_MS.
// Test hooks: MDR_TEST_PROTOCOL and MDR_TEST_HEARTBEAT_MS are honoured only with testHooks.
// Idle exit (generalization pass): MDR_IDLE_EXIT_MIN (default 240, 0 = never) with no browser stream, no waiter and no
// /api request → close('stop') (the marker goes), one line on stderr (server.log for a detached server).
// RunningServer.done resolves once the server has closed for any reason, so `serve --foreground` exits then.
import '../node/dom'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
import type { RunningServer, ServerMarker, StartServer, StartServerOptions } from '../shared/types'
import { CONSTANTS, PROTOCOL } from '../shared/constants'
import { StoreError } from '../shared/errors'
import { MDR_VERSION } from '../shared/version'
import { headlessFingerprint } from '../core/md/fingerprint'
import { idleExitMs } from '../node/config'
import { assertServable, rootHashOf } from '../node/root'
import { ensureReviewDir } from '../node/review-dir'
import { createServerApp, type ServerApp } from './app'
import { markerToken, removeMarkerIfOurs, writeMarker } from './marker'

/** How long close() lets busy sockets finish before cutting them. */
const CLOSE_GRACE_MS = 500

/**
 * §8.7 "Long-lived streams": a `wait` run holds its stream up to 55 minutes and /api/events for as long as the tab is
 * open, so Node's 300 s requestTimeout is off and there is no server-wide socket timeout. headersTimeout keeps its
 * default (a client that never finishes its headers is still cut).
 */
export function configureHttpServer(server: Server): Server {
  server.requestTimeout = 0
  server.setTimeout(0)
  return server
}

const running = new WeakMap<RunningServer, { server: Server; app: ServerApp }>()

/** Test access to a running server's node:http server and app (sse-timeouts, fan-out tests). */
export function internalsOf(s: RunningServer): { server: Server; app: ServerApp } | undefined {
  return running.get(s)
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
        rejectListen(new StoreError('PORT_EXHAUSTED', `port ${port} on ${host} is already in use`, { details: { port } }))
      } else rejectListen(new StoreError('SERVER_START_FAILED', `could not bind ${host}:${port}: ${e.message}`, { details: { port, code: e.code } }))
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function unbind(server: Server): Promise<void> {
  return new Promise<void>((done) => {
    const cut = setTimeout(() => server.closeAllConnections?.(), CLOSE_GRACE_MS)
    cut.unref?.()
    server.close(() => {
      clearTimeout(cut)
      done()
    })
    server.closeIdleConnections?.()
  })
}

export const startServer: StartServer = async (o: StartServerOptions): Promise<RunningServer> => {
  const root = o.root
  assertServable(root)
  ensureReviewDir(root)
  const testHooks = o.testHooks === true
  const env = process.env
  const protocol = (testHooks && Number(env.MDR_TEST_PROTOCOL)) || PROTOCOL
  const heartbeatMs = (testHooks && Number(env.MDR_TEST_HEARTBEAT_MS)) || CONSTANTS.SSE_HEARTBEAT_MS
  const rootHash = rootHashOf(root)
  const schemaFingerprint = await headlessFingerprint()
  const serverId = `srv_${randomUUID()}`
  const startedAt = new Date().toISOString()
  const token = markerToken(root)

  let close: RunningServer['close'] = async () => undefined
  let markDone: () => void = () => undefined
  const done = new Promise<void>((r) => {
    markDone = r
  })
  const idleMs = idleExitMs(env)
  const sa = createServerApp({
    root, rootHash, port: o.port, pid: process.pid, serverId, startedAt, token, schemaFingerprint, protocol, testHooks,
    devOrigin: env.MDR_DEV_ORIGIN === '1', vitePort: Number(env.MDR_DEV_VITE_PORT) || 5173, heartbeatMs,
    ...(env.MDR_WEB_DIR ? { webDir: env.MDR_WEB_DIR } : {}),
    onShutdown: (reason) => {
      void close(reason)
    },
    idleExitMs: idleMs,
    onIdle: () => {
      process.stderr.write(`mdr: no browser tab, waiter or agent request for ${Math.round(idleMs / 60_000)} min; stopping the server for ${root}\n`)
      void close('stop')
    },
  })
  const server = configureHttpServer(createAdaptorServer({ fetch: sa.app.fetch }) as Server)
  try {
    await listen(server, o.port, CONSTANTS.HOST)
  } catch (e) {
    await sa.close('stop').catch(() => undefined)
    throw e
  }

  const marker: ServerMarker = writeMarker({
    app: 'mdr', root, rootHash, port: o.port, pid: process.pid, serverId, version: MDR_VERSION,
    protocol: protocol as typeof PROTOCOL, startedAt, token,
  })

  let closing: Promise<void> | null = null
  close = (reason: 'stop' | 'restart' | 'signal'): Promise<void> => {
    closing ??= (async () => {
      await sa.close(reason)
      // Only an explicit 'stop' removes the marker. 'restart' and 'signal' (SIGINT/SIGTERM, e.g. Ctrl-C on
      // `serve --foreground`) leave it for the successor, so the token stays stable across a restart (D16, §13 #2),
      // as it already does after a crash; discovery ignores the stale marker (health is authoritative).
      // See CONTRACT_CHANGES.md (day 0 and P1 merge rows, §9.2.1).
      if (reason === 'stop') removeMarkerIfOurs(root, serverId)
      await unbind(server)
      markDone()
    })()
    return closing
  }

  const rs: RunningServer = { root, port: o.port, url: `http://${CONSTANTS.HOST}:${o.port}/`, pid: process.pid, serverId, marker, close: (r) => close(r), done }
  running.set(rs, { server, app: sa })
  return rs
}
