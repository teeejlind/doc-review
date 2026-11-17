// tests/helpers/startServer.ts (integrator, day 0; CONTRACTS §1.3, §9.2.1).
//
// Spawns the real server the way `mdr serve --foreground` runs it: `node .e2e-dist/cli.js serve <root> --foreground
// --port <p>` with MDR_TEST_HOOKS=1 and a tmp HOME. Resolves once /api/health answers for this root and the marker
// (`<root>/.review/server.json`, written by P1's server/marker.ts after bind) carries this process's pid, so the
// bearer token is known. Ports: 29000 + workerIndex*10 (+ offset), one window of ten per Playwright worker.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Health, ServerMarker, ServeResult } from '../../shared/types'
import { spawnCli, type CliProcess, type RunCliOptions } from './runCli'

/** Base port of the e2e window (§1.3). MDR_E2E_PORT_BASE moves it, so two checkouts can run e2e side by side. */
export const E2E_PORT_BASE = Number.parseInt(process.env.MDR_E2E_PORT_BASE ?? '', 10) || 29_000

/** Playwright's worker index (TEST_WORKER_INDEX / TEST_PARALLEL_INDEX); 0 outside Playwright. */
export function workerIndex(): number {
  const v = process.env.TEST_PARALLEL_INDEX ?? process.env.TEST_WORKER_INDEX ?? '0'
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** 29000 + workerIndex*10 + offset (offset 0..9). */
export function workerPort(offset = 0): number {
  if (offset < 0 || offset > 9) throw new Error(`workerPort: offset ${offset} outside the worker's window of 10`)
  return E2E_PORT_BASE + workerIndex() * 10 + offset
}

export function readMarker(root: string): ServerMarker | null {
  const p = join(root, '.review', 'server.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ServerMarker
  } catch {
    return null
  }
}

export async function fetchHealth(port: number, timeoutMs = 300): Promise<Health | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ac.signal })
    if (!r.ok) return null
    return (await r.json()) as Health
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

export interface SpawnServerOptions {
  /** The served root (TmpRoot.root: realpath + NFC). */
  root: string
  /** Default workerPort(0). */
  port?: number
  /** Extra env (MDR_TEST_HEARTBEAT_MS, MDR_TEST_TURN_IDLE_MS, MDR_TEST_PROTOCOL, MDR_FAULT, ...). */
  env?: Record<string, string | undefined>
  cliPath?: string
  /** tmp HOME (TmpRoot.home). */
  home?: string
  /** MDR_TEST_HOOKS=1 (default true). */
  testHooks?: boolean
  /** How long to wait for health + marker. Default 15 s (SERVER_START_TIMEOUT_MS plus build-machine slack). */
  timeoutMs?: number
}

export interface SpawnedServer {
  readonly root: string
  readonly port: number
  /** http://127.0.0.1:<port> (no trailing slash): also the allowed Origin for browser routes. */
  readonly origin: string
  readonly url: string
  readonly pid: number
  readonly token: string
  readonly marker: ServerMarker
  /** The one JSON document `serve --foreground` printed, when it printed one before health went green. */
  readonly serveResult: ServeResult | null
  readonly proc: CliProcess
  health(): Promise<Health | null>
  stdout(): string
  stderr(): string
  /** Signal the process and wait for it to exit (default SIGTERM → RunningServer.close('signal')). Returns the exit code. */
  stop(signal?: NodeJS.Signals): Promise<number | null>
  /** Stop (SIGTERM) and start again on the same root and port with the same options plus `env`. */
  restart(o?: { env?: Record<string, string | undefined> }): Promise<SpawnedServer>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function startServer(o: SpawnServerOptions): Promise<SpawnedServer> {
  const port = o.port ?? workerPort(0)
  const runOpts: RunCliOptions = {
    env: o.env ?? {},
    timeoutMs: Infinity,
    ...(o.cliPath ? { cliPath: o.cliPath } : {}),
    ...(o.home ? { home: o.home } : {}),
    ...(o.testHooks === false ? { testHooks: false } : {}),
  }
  const proc = spawnCli(['serve', o.root, '--foreground', '--port', String(port)], runOpts)
  let exitedEarly = false
  void proc.exited.then(() => {
    exitedEarly = true
  })
  const deadline = Date.now() + (o.timeoutMs ?? 15_000)
  let health: Health | null = null
  let marker: ServerMarker | null = null
  while (Date.now() < deadline) {
    if (exitedEarly) {
      const r = await proc.exited
      throw new Error(`startServer: serve exited with ${r.code ?? r.signal} before health.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
    }
    health = await fetchHealth(port)
    if (health && health.root === o.root && health.pid === proc.child.pid) {
      marker = readMarker(o.root)
      if (marker && marker.pid === proc.child.pid && marker.port === port) break
    }
    await sleep(50)
  }
  if (!health || !marker) {
    proc.kill('SIGKILL')
    const r = await proc.exited
    throw new Error(`startServer: no health/marker for ${o.root} on ${port} within the timeout.\nhealth: ${JSON.stringify(health)}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  }
  let serveResult: ServeResult | null = null
  try {
    const first = proc.stdout().split('\n').find((l) => l.trim().startsWith('{'))
    if (first) serveResult = JSON.parse(first) as ServeResult
  } catch {
    serveResult = null
  }
  const self: SpawnedServer = {
    root: o.root,
    port,
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/`,
    pid: proc.child.pid!,
    token: marker.token,
    marker,
    serveResult,
    proc,
    health: () => fetchHealth(port, 1_000),
    stdout: () => proc.stdout(),
    stderr: () => proc.stderr(),
    stop: async (signal = 'SIGTERM') => {
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) return proc.child.exitCode
      proc.kill(signal)
      const killer = setTimeout(() => proc.kill('SIGKILL'), 10_000)
      const r = await proc.exited
      clearTimeout(killer)
      return r.code
    },
    restart: async (r = {}) => {
      await self.stop('SIGTERM')
      return startServer({ ...o, port, env: { ...(o.env ?? {}), ...(r.env ?? {}) } })
    },
  }
  return self
}

/** Browser-route headers for a raw request against a spawned or fake server (§8.1 step 3). */
export function browserHeaders(o: { token: string; port: number; clientId?: string; host?: '127.0.0.1' | 'localhost' }): Record<string, string> {
  const h: Record<string, string> = {
    'X-MDR-Client': 'web',
    Authorization: `Bearer ${o.token}`,
    Origin: `http://${o.host ?? '127.0.0.1'}:${o.port}`,
  }
  if (o.clientId) h['X-MDR-Client-Id'] = o.clientId
  return h
}

/** Agent-route headers (§8.1 step 4): no Origin, ever. */
export function agentHeaders(o: { token: string; protocol?: number }): Record<string, string> {
  return { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(o.protocol ?? 2), Authorization: `Bearer ${o.token}` }
}
