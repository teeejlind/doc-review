// cli/commands/server.ts (P4). port, serve, stop (CONTRACTS §9.2, §9.2.1, §9.4, D12, D16; §13 rows 18–21, 23).
//
// - port: the formula port, and the window's state (up / free / exhausted). Never computes ports in shell (D12).
// - serve --foreground: assertServable, startServer({ root: realId(root), port, testHooks }), print ServeResult, close
//   on SIGINT/SIGTERM and exit 0. P4 never writes server.json (server/marker.ts does).
// - serve (background): ensureServer, which spawns the foreground form detached. --restart stops a SAME-ROOT server
//   first (POST /api/agent/shutdown with its own protocol, so an incompatible old server can still be restarted; if
//   that fails, SIGTERM to the same-root pid from its health). --port N is for tests and dev and still refuses a port
//   held by another root or process.
// - stop: POST /api/agent/shutdown { root, reason: 'stop' } to the same-root server only; down → stopped: false.
// - stop --all (generalization pass): every mdr server answering /api/health on the port windows (PORT_BASE ..
//   PORT_BASE + PORT_SPAN + PORT_PROBE - 1), each stopped the same way as its own root's `stop`. Servers started on an
//   explicit --port outside that range are not found. Under MDR_TEST_HOOKS=1, MDR_TEST_STOP_ALL_PORTS=<lo>-<hi> replaces
//   the range (tests never touch real servers).
// - serve --foreground also returns when the server closes itself (the shutdown route, the idle exit).
import type { CliErr, Health, PortResult, ServeResult, ServerMarker, StopAllResult, StopResult } from '../../shared/types'
import { CONSTANTS } from '../../shared/constants'
import { assertServable, discover, ensureServer, portFor, probeHealth, readMarker, realId, type Discovery } from '../../node/root'
import { locateRoot, urlFor } from '../discover'
import { agentCall, connOf } from '../http'
import { cliErr, CliExit, fromError } from '../output'
import { intOpt, opt, flag, type Ctx } from './common'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runPort(ctx: Ctx): Promise<CliExit> {
  const root = locateRoot(ctx.cmd.args[0], ctx.io.cwd, opt(ctx, 'root'))
  const d = await discover(root)
  const out: PortResult = d.state === 'up'
    ? { ok: true, root, formulaPort: portFor(root), port: d.port, state: 'up' }
    : { ok: true, root, formulaPort: portFor(root), port: d.freePort, state: d.freePort === null ? 'exhausted' : 'free' }
  return new CliExit(out, 0)
}

/** Until nothing answers health for `root` on `port` (or timeoutMs passes). */
async function waitDown(root: string, port: number, timeoutMs = 10_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const p = await probeHealth(port)
    if (p.kind !== 'health' || p.health.root !== root) return true
    await sleep(100)
  }
  return false
}

/**
 * Stop the same-root server `d`: the shutdown route with its own protocol, then a SIGTERM fallback to its pid. A
 * response with another root's X-MDR-Root-Hash is ROOT_MISMATCH and ends it there (§9.2: the CLI never proceeds), so a
 * port answering for the wrong root can never get a process signalled. The fallback covers an incompatible or wedged
 * same-root server (refused route, no route, unknown token, dead socket) and never signals this process or pid <= 1.
 */
async function stopServer(ctx: Ctx, root: string, d: Extract<Discovery, { state: 'up' }>, reason: 'stop' | 'restart'): Promise<void> {
  if (d.health.root !== root) throw cliErr('ROOT_MISMATCH', `the server on port ${d.port} serves ${d.health.root}, not ${root}`)
  try {
    await agentCall(connOf(root, d), 'POST', '/api/agent/shutdown', { root, reason }, { protocol: d.health.protocol, timeoutMs: 5000 })
  } catch (e) {
    const code = (fromError(e).doc as Partial<CliErr>).error?.code
    if (code === 'ROOT_MISMATCH') throw e
    const pid = d.health.pid
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw e
    ctx.verbose(`shutdown route failed (${code}); sending SIGTERM to pid ${pid}`)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  if (!(await waitDown(root, d.port))) throw cliErr('SERVER_START_FAILED', `the mdr server for ${root} on port ${d.port} did not stop`, { details: { port: d.port, pid: d.health.pid } })
}

export async function runServe(ctx: Ctx): Promise<CliExit> {
  const rootIn = ctx.cmd.args[0] ?? opt(ctx, 'root') ?? ctx.io.cwd
  let root: string
  try {
    root = realId(rootIn)
  } catch {
    throw cliErr('FILE_NOT_FOUND', `${rootIn} does not exist`)
  }
  const port = intOpt(ctx, 'port', '--port', 1)
  if (port !== undefined && port > 65535) throw cliErr('USAGE', `--port must be a port number, got ${port}`)
  assertServable(root)
  let restarted = false
  if (flag(ctx, 'restart')) {
    const d = await discover(root)
    if (d.state === 'up') {
      await stopServer(ctx, root, d, 'restart')
      restarted = true
    }
  }
  if (!flag(ctx, 'foreground')) {
    const s = await ensureServer(root, port !== undefined ? { port } : {})
    const out: ServeResult = { ok: true, root: s.health.root, port: s.port, url: urlFor(s.port), pid: s.health.pid, adopted: !s.started, ...(restarted ? { restarted: true as const } : {}) }
    return new CliExit(out, 0)
  }
  let bind = port
  if (bind === undefined) {
    const d = await discover(root)
    if (d.state === 'up') {
      const out: ServeResult = { ok: true, root, port: d.port, url: urlFor(d.port), pid: d.health.pid, adopted: true }
      return new CliExit(out, 0)
    }
    if (d.freePort === null) throw cliErr('PORT_EXHAUSTED', `all ${CONSTANTS.PORT_PROBE} ports from ${portFor(root)} are taken by other roots or processes`)
    bind = d.freePort
  }
  const s = await ctx.io.startServer({ root, port: bind, testHooks: ctx.io.env.MDR_TEST_HOOKS === '1' })
  const out: ServeResult = { ok: true, root: s.root, port: s.port, url: s.url, pid: s.pid, adopted: false, ...(restarted ? { restarted: true as const } : {}) }
  await ctx.io.stdout(JSON.stringify(out, null, ctx.cmd.opts.pretty === true ? 2 : undefined) + '\n')
  await Promise.race([ctx.io.signal, ...(s.done ? [s.done] : [])])
  await s.close('signal')
  return new CliExit(out, 0, true)
}

/** The ports `stop --all` scans: every root's window, or MDR_TEST_STOP_ALL_PORTS under test hooks. */
export function stopAllPorts(env: Record<string, string | undefined>): number[] {
  let lo: number = CONSTANTS.PORT_BASE
  let hi: number = CONSTANTS.PORT_BASE + CONSTANTS.PORT_SPAN + CONSTANTS.PORT_PROBE - 1
  const m = env.MDR_TEST_HOOKS === '1' ? /^(\d+)-(\d+)$/.exec(env.MDR_TEST_STOP_ALL_PORTS ?? '') : null
  if (m) {
    lo = Number(m[1])
    hi = Number(m[2])
  }
  const out: number[] = []
  for (let p = Math.max(1, lo); p <= Math.min(65535, hi); p++) out.push(p)
  return out
}

/** Health on every port, at most `width` probes in flight. */
async function scanHealth(ports: readonly number[], width = 64): Promise<Array<{ port: number; health: Health }>> {
  const found: Array<{ port: number; health: Health }> = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < ports.length) {
      const port = ports[next++]!
      const p = await probeHealth(port)
      if (p.kind === 'health' && p.health.app === 'mdr') found.push({ port, health: p.health })
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, ports.length) }, worker))
  return found.sort((a, b) => a.port - b.port)
}

async function runStopAll(ctx: Ctx): Promise<CliExit> {
  const out: StopAllResult = { ok: true, all: true, stopped: [], failed: [] }
  for (const { port, health } of await scanHealth(stopAllPorts(ctx.io.env))) {
    const m = readMarker(health.root)
    const marker: ServerMarker = m && m.port === port && m.pid === health.pid ? m : {
      app: 'mdr', root: health.root, rootHash: health.rootHash, port, pid: health.pid, serverId: health.serverId,
      version: health.version, protocol: health.protocol, startedAt: health.startedAt, token: '',
    }
    try {
      await stopServer(ctx, health.root, { state: 'up', port, health, marker }, 'stop')
      out.stopped.push({ root: health.root, port, pid: health.pid })
    } catch (e) {
      const err = (fromError(e).doc as Partial<CliErr>).error
      out.failed.push({ root: health.root, port, code: err?.code ?? 'INTERNAL', message: err?.message ?? String(e) })
    }
  }
  return new CliExit(out, 0)
}

export async function runStop(ctx: Ctx): Promise<CliExit> {
  if (flag(ctx, 'all')) {
    if (ctx.cmd.args[0] !== undefined || opt(ctx, 'root') !== undefined) throw cliErr('USAGE', 'mdr stop: pass a root or --all, not both')
    return runStopAll(ctx)
  }
  const root = locateRoot(ctx.cmd.args[0], ctx.io.cwd, opt(ctx, 'root'))
  const d = await discover(root)
  if (d.state !== 'up') {
    const out: StopResult = { ok: true, root, stopped: false, port: null }
    return new CliExit(out, 0)
  }
  await stopServer(ctx, root, d, 'stop')
  const out: StopResult = { ok: true, root, stopped: true, port: d.port }
  return new CliExit(out, 0)
}
