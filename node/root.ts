// node/root.ts (P4). Root, port, discovery, protected guard, ensureServer (CONTRACTS §9.2, §9.2.1, D12, D15, D16, D23).
//
// - realId: realpath.native + NFC, so an NFD path or a different-case path on APFS names the same root (D23, §13 #24).
// - portFor: 8300 + sha256(realId(root))[0..4] % 600. The window is portFor .. portFor+9 (D12).
// - assertServable: the three guard clauses of §9.2 (D15). (a) `/` and $HOME are always refused. (b) and (c) use the
//   configured protected segments (node/config.ts protectedSegments(): MDR_PROTECTED_SEGMENTS > config.json > [];
//   generalization pass): with none configured both are skipped, the walk included. (c) walks the subtree
//   breadth-first, skipping dot-dirs and node_modules, capped at PROTECTED_WALK_MAX_DIRS; over the cap it refuses
//   (fails closed). The walk result is cached per root and segment set for WALK_CACHE_MS so the server's per-file
//   re-check stays cheap; (a) and (b) are never cached.
// - discover: the marker fast path verified by /api/health (root and pid must match), then all ten ports of the window
//   scanned for a same-root server before a free port is chosen. Ports held by other roots or foreign processes are
//   skipped and never stopped (§13 #18, #19, #20).
// - ensureServer: serialized by <root>/.review/locks/server.lock (ensureReviewDir first, §3.7), spawns
//   `node <cli.js> serve <root> --foreground --port <p>` detached with output in .review/server.log, waits
//   SERVER_START_TIMEOUT_MS for health and the marker, else SERVER_START_FAILED with the last 20 log lines.
// This module only ever READS the marker: server/marker.ts (P1) is the only writer and the only token minter.
// resolveRoot is synchronous by signature, so "live" there means the marker's root contains the file and its pid is
// alive (kill(pid, 0)); discover() is the health-verified path every command takes afterwards.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, type Dirent } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import type { Health, ServerMarker } from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { StoreError } from '../shared/errors'
import { ServerMarkerSchema } from '../shared/schemas'
import { mdrCmd, protectedSegments } from './config'
import { ensureReviewDir } from './review-dir'

const { HEALTH_TIMEOUT_MS, PORT_BASE, PORT_PROBE, PORT_SPAN, PROTECTED_WALK_MAX_DIRS, SERVER_START_TIMEOUT_MS } = CONSTANTS
const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const WALK_CACHE_MS = 30_000
/** Directory names the walk never descends into (dot-dirs are skipped as well). */
const WALK_SKIP = new Set(['node_modules'])

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'))

/** fs.realpathSync.native(p).normalize('NFC') (D23). Throws ENOENT for a missing path. */
export function realId(p: string): string {
  return realpathSync.native(p).normalize('NFC')
}

/** realId when the path exists, else the resolved absolute path (NFC). */
function realOrResolved(p: string): string {
  try {
    return realId(p)
  } catch {
    return resolve(p).normalize('NFC')
  }
}

/** sha256 hex of the served root string: the X-MDR-Root-Hash header and Health.rootHash (§8.1 step 8). */
export function rootHashOf(root: string): string {
  return sha256hex(root)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The marker shape with any integer protocol. A server of another protocol (older or newer build, or the
 * MDR_TEST_PROTOCOL hook) writes its own number; discovery must still find it by its marker (it may run outside the
 * portFor window, e.g. `serve --port N`), so the CLI can answer PROTOCOL_MISMATCH instead of treating it as down and
 * going direct beside a live server. The HTTP layer refuses the mismatch from Health.protocol before any call.
 */
const AnyProtocolMarkerSchema = ServerMarkerSchema.extend({ protocol: z.number().int().positive() })

/** Parse <root>/.review/server.json; null when absent or malformed. `protocol` may differ from ours. Read-only. */
export function readMarker(root: string): ServerMarker | null {
  try {
    const r = AnyProtocolMarkerSchema.safeParse(JSON.parse(readFileSync(join(root, '.review', 'server.json'), 'utf8')))
    return r.success ? (r.data as ServerMarker) : null
  } catch {
    return null
  }
}

/** true when `p` is `root` or below it (both absolute and normalized). */
export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** --root > nearest ancestor of realId(file) holding a live .review/server.json whose root contains the file > dirname. */
export function resolveRoot(file: string, rootFlag?: string): string {
  if (rootFlag !== undefined) return realId(rootFlag)
  const abs = realId(file)
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    const m = readMarker(dir)
    if (m && m.root === dir && isInside(m.root, abs) && pidAlive(m.pid)) return m.root
    if (dirname(dir) === dir) break
  }
  return dirname(abs)
}

// ------------------------------------------------------------------ protected guard (D15)

/** (b): the path contains, or ends in, a protected segment sequence (/approvals/, /legal/signed/, ...). */
export function protectedSegmentOf(p: string, segments: readonly string[] = protectedSegments()): string | null {
  if (segments.length === 0) return null
  const s = toPosix(p) + '/'
  for (const seg of segments) if (s.includes(`/${seg}/`)) return seg
  return null
}

export interface ProtectedWalk {
  /** Root-relative POSIX path of the first protected directory found; null when none. */
  hit: string | null
  overCap: boolean
  /** Directories visited. */
  visited: number
}

const walkCache = new Map<string, { at: number; cap: number; result: ProtectedWalk }>()
const walkKey = (root: string, segments: readonly string[]): string => `${root}\0${segments.join('\0')}`

/** Forget cached walks (tests that create protected directories under a root they already checked). */
export function clearProtectedWalkCache(): void {
  walkCache.clear()
}

/** A directory whose absolute POSIX path ends in a protected segment sequence (`/approvals`, `/legal/signed`, ...). */
function isProtectedDir(fullPosix: string, suffixes: readonly string[]): boolean {
  for (const s of suffixes) if (fullPosix.endsWith(s)) return true
  return false
}

/**
 * (c): a directory whose path ends in a protected segment (e.g. approvals, registry, legal/signed) at any depth.
 * Breadth-first, skipping dot-dirs and node_modules; more than `cap` directories → overCap (the caller refuses).
 * A root that is itself named `legal` and holds `signed/` is refused too (it is the parent of /legal/signed/).
 * No segments → no walk at all.
 */
export function walkForProtected(root: string, cap: number = PROTECTED_WALK_MAX_DIRS, segments: readonly string[] = protectedSegments()): ProtectedWalk {
  if (segments.length === 0) return { hit: null, overCap: false, visited: 0 }
  const key = walkKey(root, segments)
  const cached = walkCache.get(key)
  if (cached && cached.cap === cap && Date.now() - cached.at < WALK_CACHE_MS) return cached.result
  const suffixes = segments.map((seg) => `/${seg}`)
  const queue: string[] = [root]
  let head = 0
  let visited = 0
  let result: ProtectedWalk | null = null
  while (head < queue.length && !result) {
    const dir = queue[head++]!
    visited++
    if (visited > cap) {
      result = { hit: null, overCap: true, visited }
      break
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith('.') || WALK_SKIP.has(d.name)) continue
      const full = join(dir, d.name)
      if (isProtectedDir(toPosix(full), suffixes)) {
        result = { hit: toPosix(relative(root, full)), overCap: false, visited }
        break
      }
      queue.push(full)
    }
  }
  const out = result ?? { hit: null, overCap: false, visited }
  walkCache.set(key, { at: Date.now(), cap, result: out })
  return out
}

/** Throws StoreError PROTECTED_ROOT | PATH_OUTSIDE_ROOT. The CLI calls it before starting a server; the server at start and per file. */
export function assertServable(root: string, file?: string): void {
  const r = realOrResolved(root)
  const refuse = (message: string): never => {
    throw new StoreError('PROTECTED_ROOT', message, { hint: 'serve a narrower folder that holds no protected directories' })
  }
  if (r === '/' || /^[A-Za-z]:[\\/]?$/.test(r) || r === realOrResolved(homedir())) refuse(`refusing to serve ${r}: the filesystem root and $HOME are never served`)
  const segments = protectedSegments()
  const rootSeg = protectedSegmentOf(r, segments)
  if (rootSeg) refuse(`refusing to serve ${r}: it is inside a protected folder (${rootSeg})`)
  if (file !== undefined) {
    const abs = realOrResolved(isAbsolute(file) ? file : join(r, file))
    if (!isInside(r, abs)) throw new StoreError('PATH_OUTSIDE_ROOT', `${file} is outside the served root ${r}`)
    const seg = protectedSegmentOf(abs, segments)
    if (seg) refuse(`${file} is in a protected folder (${seg})`)
  }
  if (segments.length === 0) return
  const w = walkForProtected(r, PROTECTED_WALK_MAX_DIRS, segments)
  if (w.overCap) refuse(`refusing to serve ${r}: more than ${PROTECTED_WALK_MAX_DIRS} directories to check for protected folders`)
  if (w.hit) refuse(`refusing to serve ${r}: it contains the protected folder ${w.hit}`)
}

// ------------------------------------------------------------------ port and discovery (D12)

export function portFor(root: string): number {
  return PORT_BASE + (parseInt(sha256hex(realId(root)).slice(0, 4), 16) % PORT_SPAN)
}

export type Probe = { kind: 'health'; health: Health } | { kind: 'refused' } | { kind: 'silent' } | { kind: 'other' }

/**
 * GET /api/health on 127.0.0.1:port within timeoutMs. 'refused' = nothing listens; 'silent' = no answer in time;
 * 'other' = something that isn't mdr. Windows retries a loopback connect after the RST for about a second before it
 * reports ECONNREFUSED, so a free port there is 'silent', not 'refused': callers that pick a port treat both the same
 * and let a real bind (portFree) decide.
 */
export async function probeHealth(port: number, timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<Probe> {
  try {
    const r = await fetch(`http://${CONSTANTS.HOST}:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const body = (await r.json().catch(() => null)) as Health | null
    if (r.ok && body && body.app === 'mdr' && typeof body.root === 'string') return { kind: 'health', health: body }
    return { kind: 'other' }
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code
    if (code === 'ECONNREFUSED') return { kind: 'refused' }
    const name = (e as { name?: string }).name
    return name === 'TimeoutError' || name === 'AbortError' ? { kind: 'silent' } : { kind: 'other' }
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const srv = createServer()
    srv.once('error', () => done(false))
    srv.listen(port, CONSTANTS.HOST, () => srv.close(() => done(true)))
  })
}

/** A marker for an adopted server whose marker file is missing or stale (the token is then unknown: ''). */
function markerFromHealth(h: Health): ServerMarker {
  return {
    app: 'mdr', root: h.root, rootHash: h.rootHash, port: h.port, pid: h.pid, serverId: h.serverId, version: h.version,
    protocol: h.protocol, startedAt: h.startedAt, token: '',
  }
}

/** The marker when it describes the server that answered `health`, else one rebuilt from health (token ''). */
function markerFor(root: string, port: number, h: Health): ServerMarker {
  const m = readMarker(root)
  return m && m.port === port && m.pid === h.pid ? m : markerFromHealth(h)
}

export type Discovery = { state: 'up'; port: number; health: Health; marker: ServerMarker } | { state: 'down'; freePort: number | null }

export async function discover(root: string): Promise<Discovery> {
  const r = realId(root)
  const m = readMarker(r)
  if (m) {
    const p = await probeHealth(m.port)
    if (p.kind === 'health' && p.health.root === r && p.health.pid === m.pid) return { state: 'up', port: m.port, health: p.health, marker: m }
  }
  const p0 = portFor(r)
  const ports = Array.from({ length: PORT_PROBE }, (_, k) => p0 + k)
  const probes = await Promise.all(ports.map((p) => probeHealth(p)))
  // scan all ten for a same-root match before choosing a port
  for (let k = 0; k < ports.length; k++) {
    const p = probes[k]!
    if (p.kind === 'health' && p.health.app === 'mdr' && p.health.root === r) {
      return { state: 'up', port: ports[k]!, health: p.health, marker: markerFor(r, ports[k]!, p.health) }
    }
  }
  // other roots and foreign processes are skipped, never stopped
  for (let k = 0; k < ports.length; k++) {
    const kind = probes[k]!.kind
    if ((kind === 'refused' || kind === 'silent') && (await portFree(ports[k]!))) return { state: 'down', freePort: ports[k]! }
  }
  return { state: 'down', freePort: null }
}

// ------------------------------------------------------------------ startup

function lastLines(path: string, n: number): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').slice(-n)
  } catch {
    return []
  }
}

/** The command that re-runs this CLI: `node [execArgv] <cli.js>` (MDR_CLI_JS overrides the script, for tests). */
export function ownCli(): { node: string; execArgv: string[]; script: string } {
  const script = process.env.MDR_CLI_JS ?? process.argv[1]
  if (!script) throw new StoreError('SERVER_START_FAILED', 'cannot locate the mdr CLI script to start a server')
  let real = script
  try {
    real = realpathSync(script)
  } catch {
    // keep the given path
  }
  return { node: process.execPath, execArgv: [...process.execArgv], script: real }
}

export interface EnsureServerOptions {
  /** `mdr serve --port N` (tests/dev): exactly this port; a port held by another root or process → PORT_EXHAUSTED. */
  port?: number
}

export async function ensureServer(root: string, o: EnsureServerOptions = {}): Promise<{ port: number; health: Health; marker: ServerMarker; started: boolean }> {
  const r = realId(root)
  assertServable(r)
  const first = await discover(r)
  if (first.state === 'up' && (o.port === undefined || first.port === o.port)) {
    return { port: first.port, health: first.health, marker: first.marker, started: false }
  }

  const review = ensureReviewDir(r)
  const locks = join(review, 'locks')
  mkdirSync(locks, { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(r, {
    lockfilePath: join(locks, 'server.lock'), realpath: false, stale: CONSTANTS.LOCK_STALE_MS, update: CONSTANTS.LOCK_UPDATE_MS,
    retries: { retries: 200, minTimeout: 50, maxTimeout: 100 },
  })
  try {
    let port: number
    if (o.port !== undefined) {
      const p = await probeHealth(o.port)
      if (p.kind === 'health' && p.health.root === r) {
        return { port: o.port, health: p.health, marker: markerFor(r, o.port, p.health), started: false }
      }
      if (p.kind === 'health') throw new StoreError('PORT_EXHAUSTED', `port ${o.port} is held by the mdr server for ${p.health.root}`, { details: { port: o.port } })
      if (p.kind === 'other' || !(await portFree(o.port))) throw new StoreError('PORT_EXHAUSTED', `port ${o.port} is held by another process`, { details: { port: o.port } })
      port = o.port
    } else {
      const d = await discover(r)
      if (d.state === 'up') return { port: d.port, health: d.health, marker: d.marker, started: false }
      if (d.freePort === null) {
        throw new StoreError('PORT_EXHAUSTED', `all ${PORT_PROBE} ports from ${portFor(r)} are taken by other roots or processes`, {
          hint: `stop a server you no longer need (${mdrCmd()} stop <root>), or free a port in the window`,
          details: { formulaPort: portFor(r) },
        })
      }
      port = d.freePort
    }
    const logPath = join(review, 'server.log')
    try {
      if (existsSync(logPath) && statSync(logPath).size > LOG_ROTATE_BYTES) renameSync(logPath, logPath + '.1')
    } catch {
      // rotation is best effort
    }
    const fd = openSync(logPath, 'a', 0o600)
    const cli = ownCli()
    const child = spawn(cli.node, [...cli.execArgv, cli.script, 'serve', r, '--foreground', '--port', String(port)], {
      detached: true, stdio: ['ignore', fd, fd], env: process.env, windowsHide: true,
    })
    child.unref()
    closeSync(fd)
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const p = await probeHealth(port)
      if (p.kind === 'health' && p.health.root === r) {
        const marker = readMarker(r)
        if (marker && marker.port === port && marker.pid === p.health.pid) return { port, health: p.health, marker, started: true }
      }
      if (child.exitCode !== null) break
      await sleep(100)
    }
    throw new StoreError('SERVER_START_FAILED', `the mdr server for ${r} did not answer on port ${port} within ${SERVER_START_TIMEOUT_MS} ms`, {
      hint: `see ${logPath}`,
      details: { port, log: lastLines(logPath, 20) },
    })
  } finally {
    await release().catch(() => {})
  }
}
