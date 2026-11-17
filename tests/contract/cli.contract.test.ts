// tests/contract/cli.contract.test.ts (integrator, day 0; CONTRACTS §1.3, §2.4 "Day-0 CLI shell", §9.1–§9.7, D42).
//
// The CLI process contract: argv → exactly one JSON document on stdout (§9.1), CliOk-shaped or CliErr, and an exit
// code from ERROR_TABLE. From M0 it ran `serve`, `batch` and `wait` against the day-0 shell (cli/main.ts); the other
// commands' cases (it.todo until then) run P4's real CLI against P1's real server since P4's final pass.
//
// The CLI runs from source under the tsx loader (`node --import tsx cli/main.ts`, one process, so pids match), so
// `npm test` needs no build; the built `.e2e-dist/cli.js` is int-smoke's job (§1.3). Roots are tmp copies of the
// committed fixtures under tests/e2e/.tmp with a tmp HOME (tests/helpers/tmpRoot.ts).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import * as S from '../../shared/schemas'
import { ERROR_TABLE } from '../../shared/types'
import type { CliErr, ErrorCode, ServeResult, SuggestionId } from '../../shared/types'
import { buildWakePrompt } from '../../shared/handoff-prompt'
import { MDR_VERSION } from '../../shared/version'
import { portFor } from '../../node/root'
import { runCli, spawnCli, type CliProcess, type CliRun, type RunCliOptions } from '../helpers/runCli'
import { readMarker } from '../helpers/startServer'
import { REPO_ROOT, tmpRoot, type TmpRoot } from '../helpers/tmpRoot'
import { testCore, webClient, type WebClient } from '../helpers/webClient'

const CLI_SRC = join(REPO_ROOT, 'cli', 'main.ts')
const DOC = 'basic.md'
const WAITER = 'w_0123456789abcdef'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

function cliOpts(r: TmpRoot, extra: Partial<RunCliOptions> = {}): RunCliOptions {
  return { cliPath: CLI_SRC, env: { NODE_OPTIONS: '--import tsx' }, home: r.home, cwd: REPO_ROOT, timeoutMs: 60_000, ...extra }
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(port))
    })
  })
}

function issues(schema: z.ZodType, v: unknown): string[] {
  const r = schema.safeParse(v)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
}

/**
 * §9.1: exactly one JSON document; ok → it parses as `okSchema` and the exit code is one of `okExits`; otherwise it
 * is a CliErr whose exit code is ERROR_TABLE[code].exit.
 */
function expectCliContract(run: CliRun, okSchema: z.ZodType, okExits: readonly number[]): void {
  expect(run.docs, `stdout must hold exactly one JSON document; stdout=${run.stdout} stderr=${run.stderr}`).toBe(1)
  const j = run.json as { ok?: unknown }
  if (j.ok === true) {
    expect(issues(okSchema, j), run.stdout).toEqual([])
    expect(okExits, `exit ${run.code} for ${run.stdout}`).toContain(run.code)
  } else {
    expect(issues(S.CliErrSchema, j), run.stdout).toEqual([])
    const code = (j as CliErr).error.code
    expect(run.code, `exit code for ${code}`).toBe(ERROR_TABLE[code].exit)
  }
}

function expectCliErr(run: CliRun, codes: readonly ErrorCode[]): CliErr {
  expect(run.docs, `stdout=${run.stdout} stderr=${run.stderr}`).toBe(1)
  expect(issues(S.CliErrSchema, run.json), run.stdout).toEqual([])
  const err = run.json as CliErr
  expect(codes).toContain(err.error.code)
  expect(run.code).toBe(ERROR_TABLE[err.error.code].exit)
  return err
}

// =====================================================================================
// Server up: one `serve --foreground` for the describe block
// =====================================================================================

describe('mdr serve --foreground, then batch and wait against it (day-0 shell from M0)', () => {
  let root: TmpRoot
  let port: number
  let serve: CliProcess
  let serveResult: ServeResult

  beforeAll(async () => {
    root = tmpRoot({ name: 'cli-contract-up', fixtures: [DOC, 'syn__crlf.md'] })
    port = await freePort()
    serve = spawnCli(['serve', root.root, '--foreground', '--port', String(port)], cliOpts(root, { timeoutMs: Infinity }))
    await serve.waitFor(/\}\s*$/m, { timeoutMs: 45_000 })
    serveResult = JSON.parse(serve.stdout().trim().split('\n')[0]!) as ServeResult
  }, 60_000)

  afterAll(async () => {
    if (serve && serve.child.exitCode === null && serve.child.signalCode === null) {
      serve.kill('SIGKILL')
      await serve.exited
    }
    root?.cleanup()
  })

  it('prints one ServeResult for this root, port and pid', () => {
    expect(issues(S.ServeResultSchema, serveResult)).toEqual([])
    expect(serveResult).toMatchObject({ ok: true, root: root.root, port, pid: serve.child.pid })
    expect(serveResult.url.startsWith(`http://127.0.0.1:${port}`)).toBe(true)
  })

  it('answers /api/health for the root with X-MDR-Root-Hash, and wrote the marker after .review/.gitignore', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(res.status).toBe(200)
    const health = (await res.json()) as unknown
    expect(issues(S.HealthSchema, health)).toEqual([])
    expect(health).toMatchObject({ ok: true, app: 'mdr', protocol: 2, root: root.root, rootHash: sha(root.root), port, pid: serve.child.pid })
    expect(res.headers.get('x-mdr-root-hash')).toBe(sha(root.root))
    const marker = readMarker(root.root)
    expect(issues(S.ServerMarkerSchema, marker)).toEqual([])
    expect(marker).toMatchObject({ app: 'mdr', root: root.root, port, pid: serve.child.pid })
    expect(readFileSync(join(root.root, '.review', '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('batch (stdin, empty BatchRequest): one JSON document, BatchResult or a CliErr with its ERROR_TABLE exit', async () => {
    const run = await runCli(['batch', root.path(DOC), '--root', root.root], cliOpts(root, { stdin: { ops: [] } }))
    expectCliContract(run, S.BatchResultSchema, [0])
    if (run.ok) expect(run.json).toMatchObject({ via: 'server', file: DOC, noop: true, results: [] })
  })

  it('batch --ops-file: same contract as stdin', async () => {
    root.write('ops.json', JSON.stringify({ ops: [] }))
    const run = await runCli(['batch', root.path(DOC), '--root', root.root, '--ops-file', root.path('ops.json')], cliOpts(root))
    expectCliContract(run, S.BatchResultSchema, [0])
  })

  it('batch with a body that is not JSON fails with exit 3 (BAD_REQUEST or USAGE)', async () => {
    const run = await runCli(['batch', root.path(DOC), '--root', root.root], cliOpts(root, { stdin: 'not json' }))
    expectCliErr(run, ['BAD_REQUEST', 'USAGE'])
  })

  it('wait against a live server: one JSON document, WaitResult (0 handoff, 2 timeout) or a CliErr with its exit', async () => {
    const run = await runCli(['wait', root.path(DOC), '--root', root.root, '--timeout', '2', '--waiter', WAITER], cliOpts(root))
    expectCliContract(run, S.WaitResultSchema, [0, 2])
    const j = run.json as { ok: boolean; status?: string }
    if (j.ok && j.status === 'timeout') {
      expect(run.code).toBe(2)
      expect(run.json).toMatchObject({ file: DOC })
    }
    if (j.ok && j.status === 'handoff') expect(run.code).toBe(0)
  })

  // P1 merge decision (CONTRACT_CHANGES): only an explicit 'stop' removes the marker; a signal leaves it, so the
  // successor reuses the token and an open tab keeps working across the restart (D16, §13 #2).
  it('SIGTERM closes the server: exit 0, still exactly one stdout document, marker kept; the successor reuses its token', async () => {
    const before = readMarker(root.root)
    expect(before?.token).toMatch(/^[0-9a-f]{64}$/)
    serve.kill('SIGTERM')
    const r = await serve.exited
    expect(r.code).toBe(0)
    expect(r.docs).toBe(1)
    expect(readMarker(root.root)?.token).toBe(before!.token)
    serve = spawnCli(['serve', root.root, '--foreground', '--port', String(port)], cliOpts(root, { timeoutMs: Infinity }))
    await serve.waitFor(/\}\s*$/m, { timeoutMs: 45_000 })
    const next = readMarker(root.root)
    expect(next).toMatchObject({ token: before!.token, pid: serve.child.pid, port })
    expect(next!.serverId).not.toBe(before!.serverId)
    serve.kill('SIGTERM')
    expect((await serve.exited).code).toBe(0)
  }, 60_000)
})

// =====================================================================================
// Server down
// =====================================================================================

describe('server down (day-0 shell from M0)', () => {
  let root: TmpRoot
  beforeAll(() => {
    root = tmpRoot({ name: 'cli-contract-down', fixtures: [DOC] })
  })
  afterAll(() => root?.cleanup())

  it('wait never starts a server: SERVER_UNREACHABLE, exit 11, at the deadline', async () => {
    const t0 = Date.now()
    const run = await runCli(['wait', root.path(DOC), '--root', root.root, '--timeout', '1', '--waiter', WAITER], cliOpts(root))
    expectCliErr(run, ['SERVER_UNREACHABLE'])
    expect(run.code).toBe(11)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(existsSync(join(root.root, '.review', 'server.json'))).toBe(false)
  })

  it('batch in direct mode: one JSON document, BatchResult (via direct) or a CliErr with its ERROR_TABLE exit', async () => {
    const run = await runCli(['batch', root.path(DOC), '--root', root.root], cliOpts(root, { stdin: { ops: [] } }))
    expectCliContract(run, S.BatchResultSchema, [0])
    if (run.ok) expect(run.json).toMatchObject({ via: 'direct', file: DOC })
    expect(existsSync(join(root.root, '.review', 'server.json'))).toBe(false)
  })
})

// =====================================================================================
// Every other command (§2.4, §9.4). The day-0 it.todo cases, turned on with P4's real CLI against P1's real server
// (P4 final pass after the P1 merge; the integrator confirms at the M3 merge). Each case works on its own copy of the
// fixture doc, so the cases run concurrently against one shared `serve --foreground`; the cases that stop or replace a
// server get servers of their own.
// =====================================================================================

const BASIC = readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'docs', DOC), 'utf8')
const HTML_DOC = readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'docs', 'syn__block-html.md'), 'utf8')

/** §9.1 and the ok schema: exactly one document, ok: true, exit 0. */
function expectOk<T = any>(run: CliRun, schema: z.ZodType): T {
  expect(run.docs, `stdout=${run.stdout} stderr=${run.stderr}`).toBe(1)
  expect(run.code, run.stdout + run.stderr).toBe(0)
  expect(issues(schema, run.json), run.stdout).toEqual([])
  return run.json as T
}

/** A served root: `serve --foreground` on a free port, with an optional env (MDR_TEST_PROTOCOL, ...). */
async function serveRoot(r: TmpRoot, env: Record<string, string> = {}): Promise<{ port: number; proc: CliProcess; token: string; stop(): Promise<void> }> {
  const port = await freePort()
  const proc = spawnCli(['serve', r.root, '--foreground', '--port', String(port)], cliOpts(r, { timeoutMs: Infinity, env: { NODE_OPTIONS: '--import tsx', ...env } }))
  await proc.waitFor(/\}\s*$/m, { timeoutMs: 45_000 })
  return {
    port, proc, token: readMarker(r.root)!.token,
    async stop() {
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.kill('SIGTERM')
        await proc.exited
      }
    },
  }
}

/**
 * An HTTP server that claims to serve `root` in /api/health (and its marker says so) but stamps every response with
 * another root's X-MDR-Root-Hash: what a port re-used by another root's server looks like to the CLI (§9.2).
 */
async function lyingServer(r: TmpRoot): Promise<{ port: number; close(): Promise<void> }> {
  const port = await freePort()
  const startedAt = new Date().toISOString()
  const srv = createHttpServer((req, res) => {
    res.setHeader('X-MDR-Root-Hash', sha('/somewhere/else'))
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/health') {
      res.end(JSON.stringify({ ok: true, app: 'mdr', version: MDR_VERSION, protocol: 2, schemaFingerprint: '0'.repeat(16), root: r.root, rootHash: sha(r.root), port, pid: process.pid, serverId: 'srv_liar', startedAt }))
    } else {
      res.end(JSON.stringify({ ok: true }))
    }
  })
  await new Promise<void>((done) => srv.listen(port, '127.0.0.1', () => done()))
  mkdirSync(join(r.root, '.review'), { recursive: true })
  writeFileSync(join(r.root, '.review', 'server.json'), JSON.stringify({ app: 'mdr', root: r.root, rootHash: sha(r.root), port, pid: process.pid, serverId: 'srv_liar', version: MDR_VERSION, protocol: 2, startedAt, token: 'e'.repeat(64) }))
  return { port, close: () => new Promise<void>((done) => srv.close(() => done())) }
}

/** A TJ-authored suggestion on the block holding `quote` (a save with a suggestions.upsert, as P2's editor sends it). */
async function tjSuggestion(c: WebClient, quote: string, proposedBlock: string): Promise<SuggestionId> {
  const core = await testCore()
  const [{ ptextOf }, { createAnchor }] = await Promise.all([import('../../core/ptext'), import('../../core/anchors')])
  const snap = await c.doc()
  const L = core.load(core.md, snap.markdown)
  const p = ptextOf(L.doc, L)
  const from = p.text.indexOf(quote)
  const at = p.blockAt(from).index
  const block = L.blocks[at]!
  const id = `s_${ulid()}` as SuggestionId
  await c.save({
    base: { rev: snap.rev, hash: snap.hash, blockHashes: L.blocks.map((b) => b.hash) }, ops: [], cause: 'edit', allowPartial: true,
    suggestions: { upsert: [{ id, range: { start: at, end: at + 1 }, base: snap.markdown.slice(block.start, block.end), proposed: proposedBlock, anchor: createAnchor(p, L.blocks, from, from + quote.length, snap.rev) }] },
  })
  return id
}

describe.concurrent('post-M3 commands (P4): one shared server, one doc per case', () => {
  let root: TmpRoot
  let up: Awaited<ReturnType<typeof serveRoot>>
  let down: TmpRoot
  let n = 0
  /** A fresh copy of the fixture doc in the served root; returns its absolute path and rel name. */
  const doc = (content = BASIC): { abs: string; rel: string } => {
    const rel = `case-${++n}.md`
    root.write(rel, content)
    return { abs: root.path(rel), rel }
  }
  const run = (args: string[], o: Partial<RunCliOptions> = {}): Promise<CliRun> => runCli(args, cliOpts(root, o))
  const tj = (rel: string): Promise<WebClient> => webClient({ port: up.port, root: root.root, file: rel, token: up.token })
  const rev = async (abs: string): Promise<number> => ((await run(['status', abs])).json as { rev: number }).rev

  beforeAll(async () => {
    root = tmpRoot({ name: 'cli-contract-m3', fixtures: [DOC] })
    down = tmpRoot({ name: 'cli-contract-m3-down', fixtures: [DOC] })
    up = await serveRoot(root)
  }, 60_000)
  afterAll(async () => {
    await up?.stop()
    root?.cleanup()
    down?.cleanup()
  })

  it('port [<root|file>] → PortResult: formulaPort = portFor(root), state up|free|exhausted (§9.2)', async () => {
    expect(expectOk(await run(['port', root.root]), S.PortResultSchema)).toEqual({ ok: true, root: root.root, formulaPort: portFor(root.root), port: up.port, state: 'up' })
    expect(expectOk(await run(['port', root.path(DOC)]), S.PortResultSchema)).toMatchObject({ root: root.root, state: 'up' })
    const d = expectOk<{ state: string; formulaPort: number }>(await runCli(['port', down.root], cliOpts(down)), S.PortResultSchema)
    expect(d.formulaPort).toBe(portFor(down.root))
    expect(['free', 'exhausted']).toContain(d.state)
  })

  it('serve without --foreground → ensureServer: ServeResult adopted:false then adopted:true on a second run; --restart only stops a same-root server', async () => {
    const r2 = tmpRoot({ name: 'cli-contract-m3-bg', fixtures: [DOC] })
    const o = cliOpts(r2)
    try {
      const a = expectOk<ServeResult>(await runCli(['serve', r2.root], o), S.ServeResultSchema)
      expect(a).toMatchObject({ root: r2.root, adopted: false, url: `http://127.0.0.1:${a.port}/` })
      expect(a.port).toBeGreaterThanOrEqual(portFor(r2.root))
      expect(a.port).toBeLessThan(portFor(r2.root) + 10)
      const b = expectOk<ServeResult>(await runCli(['serve', r2.root], o), S.ServeResultSchema)
      expect(b).toMatchObject({ port: a.port, pid: a.pid, adopted: true })
      const c = expectOk<ServeResult>(await runCli(['serve', r2.root, '--restart'], o), S.ServeResultSchema)
      expect(c).toMatchObject({ port: a.port, adopted: false, restarted: true })
      expect(c.pid).not.toBe(a.pid)
      // the shared server of another root was never touched
      const h = (await (await fetch(`http://127.0.0.1:${up.port}/api/health`)).json()) as { root: string; pid: number }
      expect(h).toMatchObject({ root: root.root, pid: up.proc.child.pid })
    } finally {
      await runCli(['stop', r2.root], o)
      r2.cleanup()
    }
  }, 60_000)

  it('serve --port N on a port held by another root → PORT_EXHAUSTED exit 8, never takes it over', async () => {
    const r3 = tmpRoot({ name: 'cli-contract-m3-port', fixtures: [DOC] })
    try {
      expectCliErr(await runCli(['serve', r3.root, '--port', String(up.port)], cliOpts(r3)), ['PORT_EXHAUSTED'])
      expectCliErr(await runCli(['serve', r3.root, '--foreground', '--port', String(up.port)], cliOpts(r3)), ['PORT_EXHAUSTED'])
      const h = (await (await fetch(`http://127.0.0.1:${up.port}/api/health`)).json()) as { root: string; pid: number }
      expect(h).toMatchObject({ root: root.root, pid: up.proc.child.pid })
    } finally {
      r3.cleanup()
    }
  })

  it('serve on a protected root ($HOME, /approvals/, a subtree holding registry/) → PROTECTED_ROOT exit 4', async () => {
    const r4 = tmpRoot({ name: 'cli-contract-m3-prot', fixtures: 'none', files: { 'approvals/a.md': '# a\n', 'deep/x/registry/r.md': '# r\n' } })
    try {
      // TJ's protected set (the default protects nothing beyond / and $HOME)
      const o = cliOpts(r4, { env: { NODE_OPTIONS: '--import tsx', MDR_PROTECTED_SEGMENTS: 'approvals,legal/signed,legal/filed,registry' } })
      expectCliErr(await runCli(['serve', r4.home], o), ['PROTECTED_ROOT'])
      expectCliErr(await runCli(['serve', r4.path('approvals')], o), ['PROTECTED_ROOT'])
      expectCliErr(await runCli(['serve', r4.path('deep')], o), ['PROTECTED_ROOT'])
      expectCliErr(await runCli(['serve', r4.root, '--foreground', '--port', String(await freePort())], o), ['PROTECTED_ROOT'])
      expect(existsSync(join(r4.root, '.review'))).toBe(false)
    } finally {
      r4.cleanup()
    }
  })

  it('stop [<root|file>] → StopResult; server down → { stopped: false }; another root → ROOT_MISMATCH', async () => {
    const r5 = tmpRoot({ name: 'cli-contract-m3-stop', fixtures: [DOC] })
    const liarRoot = tmpRoot({ name: 'cli-contract-m3-liar', fixtures: [DOC] })
    const liar = await lyingServer(liarRoot)
    try {
      expect(expectOk(await runCli(['stop', down.root], cliOpts(down)), S.StopResultSchema)).toEqual({ ok: true, root: down.root, stopped: false, port: null })
      expectCliErr(await runCli(['stop', liarRoot.root], cliOpts(liarRoot)), ['ROOT_MISMATCH'])
      const s = await serveRoot(r5)
      const w = spawnCli(['wait', r5.path(DOC), '--waiter', WAITER, '--timeout', '30'], cliOpts(r5))
      expect(expectOk(await runCli(['status', r5.path(DOC), '--wait-waiter', '20'], cliOpts(r5)), S.StatusResultSchema)).toMatchObject({ presence: { waiter: 'connected' } })
      expect(expectOk(await runCli(['stop', r5.path(DOC)], cliOpts(r5)), S.StopResultSchema)).toEqual({ ok: true, root: r5.root, stopped: true, port: s.port })
      expect(readMarker(r5.root), 'stop removes the marker').toBeNull()
      // a waiter connected to a stopped server exits 10 (SERVER_STOPPED), not 11
      const wr = await w.exited
      expectCliErr(wr, ['SERVER_STOPPED'])
      expect(wr.code).toBe(10)
      await s.proc.exited
    } finally {
      await liar.close()
      r5.cleanup()
      liarRoot.cleanup()
    }
  }, 60_000)

  it('open <file> [--suggest-only | --allow-edits] → OpenResult with a WaiterSpec (v 2, --waiter <id> in command) or waiter: null; sends /api/agent/arm first', async () => {
    const { abs, rel } = doc()
    const o = expectOk<{ waiter: { v: number; waiter: string; command: string; abs: string; port: number }; presence: { waiter: string }; policy: { suggestOnly: boolean }; url: string }>(await run(['open', abs]), S.OpenResultSchema)
    expect(o).toMatchObject({ url: `http://127.0.0.1:${up.port}/?file=${rel}`, presence: { waiter: 'grace' }, policy: { suggestOnly: false } })
    expect(o.waiter).toMatchObject({ v: 2, abs, port: up.port })
    expect(o.waiter.command).toContain(` --waiter ${o.waiter.waiter} `)
    expect(expectOk(await run(['open', abs, '--suggest-only']), S.OpenResultSchema)).toMatchObject({ policy: { suggestOnly: true } })
    expect(expectOk(await run(['open', abs, '--allow-edits']), S.OpenResultSchema)).toMatchObject({ policy: { suggestOnly: false } })
    expectCliErr(await run(['open', abs, '--suggest-only', '--allow-edits']), ['USAGE'])
    const clip = expectOk<{ waiter: unknown }>(await run(['open', abs], { env: { NODE_OPTIONS: '--import tsx', MDR_TEST_CLIPBOARD_PRIMARY: '1' } }), S.OpenResultSchema)
    expect(clip.waiter).toBeNull()
  })

  it('arm <file> → ArmResult: attached, presence, a fresh WaiterSpec; idempotent', async () => {
    const { abs, rel } = doc()
    const a = expectOk<{ waiter: { waiter: string }; attached: boolean }>(await run(['arm', abs]), S.ArmResultSchema)
    expect(a).toMatchObject({ attached: false, presence: { waiter: 'grace' }, server: { state: 'up', port: up.port }, policy: { suggestOnly: false } })
    const b = expectOk<{ waiter: { waiter: string } }>(await run(['arm', abs]), S.ArmResultSchema)
    expect(b).toMatchObject({ attached: false, presence: { waiter: 'grace' } })
    expect(b.waiter.waiter).not.toBe(a.waiter.waiter)
    expect((root.readSidecar(rel) as Array<{ type?: string }>).filter((l) => l.type === 'policy.set')).toEqual([]) // no side effect without a flag
  })

  it('disarm <file> → DisarmResult; server down → { disarmed: false }', async () => {
    const { abs, rel } = doc()
    expect(expectOk(await run(['disarm', abs]), S.DisarmResultSchema)).toMatchObject({ ok: true, file: rel })
    expect(expectOk(await runCli(['disarm', down.path(DOC)], cliOpts(down)), S.DisarmResultSchema)).toEqual({ ok: true, file: DOC, disarmed: false })
  })

  it('status <file> → StatusResult; server down → via direct, server.state down, activity null, presence none', async () => {
    const { abs, rel } = doc()
    expect(expectOk(await run(['status', abs]), S.StatusResultSchema)).toMatchObject({ via: 'server', file: rel, root: root.root, server: { state: 'up', port: up.port } })
    expect(expectOk(await runCli(['status', down.path(DOC)], cliOpts(down)), S.StatusResultSchema)).toMatchObject({ via: 'direct', server: { state: 'down', port: null, url: null }, activity: null, presence: { waiter: 'none' } })
  })

  it('status --wait-waiter <sec> blocks until presence.waiter is connected', async () => {
    const { abs } = doc()
    const t0 = Date.now()
    const idle = expectOk<{ presence: { waiter: string } }>(await run(['status', abs, '--wait-waiter', '1']), S.StatusResultSchema)
    expect(idle.presence.waiter).not.toBe('connected')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    const id = 'w_00000000000000aa'
    const w = spawnCli(['wait', abs, '--waiter', id, '--timeout', '30'], cliOpts(root))
    try {
      expect(expectOk(await run(['status', abs, '--wait-waiter', '20']), S.StatusResultSchema)).toMatchObject({ presence: { waiter: 'connected', waiterId: id } })
    } finally {
      w.kill('SIGTERM')
      const r = await w.exited
      expect(r.code).toBe(130)
      expect(r.docs).toBe(1)
    }
  }, 60_000)

  it('snapshot <file> [--md] [--text] [--from bN] [--to bN] → AgentSnapshot', async () => {
    const { abs } = doc()
    const plain = expectOk<{ blocks: Array<{ ref: string; md?: string }> }>(await run(['snapshot', abs]), S.AgentSnapshotSchema)
    expect(plain.blocks.length).toBe(7)
    const md = expectOk<{ blocks: Array<{ ref: string; md?: string }> }>(await run(['snapshot', abs, '--md']), S.AgentSnapshotSchema)
    expect(md.blocks[0]).toMatchObject({ ref: 'b1', md: '# Launch plan' })
    expectOk(await run(['snapshot', abs, '--text']), S.AgentSnapshotSchema)
    const range = expectOk<{ blocks: Array<{ ref: string }> }>(await run(['snapshot', abs, '--md', '--from', 'b2', '--to', 'b3']), S.AgentSnapshotSchema)
    expect(range.blocks.map((b) => b.ref)).toEqual(['b2', 'b3'])
  })

  it('pending <file> → PendingResult; never acks; server down → direct', async () => {
    const { abs, rel } = doc()
    const c = await tj(rel)
    try {
      await c.createThread({ kind: 'doc' }, 'A note from TJ.')
    } finally {
      await c.close()
    }
    const p1 = expectOk<{ since: number; cursor: number; empty: boolean; counts: { messages: number } }>(await run(['pending', abs]), S.PendingResultSchema)
    expect(p1).toMatchObject({ via: 'server', empty: false, since: 0, counts: { messages: 1 } })
    const p2 = expectOk<{ since: number; cursor: number }>(await run(['pending', abs]), S.PendingResultSchema)
    expect(p2).toMatchObject({ since: 0, cursor: p1.cursor }) // pending never acks
    expect(expectOk(await runCli(['pending', down.path(DOC)], cliOpts(down)), S.PendingResultSchema)).toMatchObject({ via: 'direct' })
  })

  it('thread <file> <t_id> → ThreadDetail; unknown id → THREAD_NOT_FOUND exit 5', async () => {
    const { abs } = doc()
    const c = expectOk<{ results: Array<{ thread: string }> }>(await run(['comment', abs, '--doc', '--body', 'Overall: tighten it.']), S.BatchResultSchema)
    const t = expectOk<{ thread: { id: string; messages: Array<{ by: string; body: string }> } }>(await run(['thread', abs, c.results[0]!.thread]), S.ThreadDetailSchema)
    expect(t.thread).toMatchObject({ id: c.results[0]!.thread, messages: [{ by: 'Claude', body: 'Overall: tighten it.' }] })
    const missing = expectCliErr(await run(['thread', abs, `t_${ulid()}`]), ['THREAD_NOT_FOUND'])
    expect(ERROR_TABLE[missing.error.code].exit).toBe(5)
  })

  it('comment <file> --quote Q (--body B | --body -) → BatchResult with one comment result; --doc; --block bN --base-rev R', async () => {
    const { abs } = doc()
    const q = expectOk<{ results: unknown[] }>(await run(['comment', abs, '--quote', 'member rate of 12%', '--body', 'Source?']), S.BatchResultSchema)
    expect(q.results).toMatchObject([{ i: 0, op: 'comment', anchor: { state: 'ok', block: 'b2', quote: 'member rate of 12%' } }])
    const viaStdin = expectOk<{ results: unknown[] }>(await run(['comment', abs, '--quote', 'Publish the FAQ', '--body', '-'], { stdin: 'Is the FAQ still on?' }), S.BatchResultSchema)
    expect(viaStdin.results).toMatchObject([{ op: 'comment' }])
    expect(expectOk<{ results: unknown[] }>(await run(['comment', abs, '--doc', '--body', 'Overall fine.']), S.BatchResultSchema).results).toMatchObject([{ op: 'comment' }])
    const r = await rev(abs)
    expect(expectOk<{ results: unknown[] }>(await run(['comment', abs, '--block', 'b4', '--base-rev', String(r), '--body', 'Order by impact?']), S.BatchResultSchema).results).toMatchObject([{ op: 'comment', anchor: { block: 'b4' } }])
  })

  it('comment --quote with 2 hits → QUOTE_AMBIGUOUS exit 6 with candidates; --occurrence / --near bN --base-rev R disambiguate', async () => {
    const { abs } = doc()
    const amb = expectCliErr(await run(['comment', abs, '--quote', 'member rate', '--body', 'x']), ['QUOTE_AMBIGUOUS'])
    expect(amb.error.candidates?.map((c) => c.block)).toEqual(['b2', 'b5'])
    expect(expectOk<{ results: unknown[] }>(await run(['comment', abs, '--quote', 'member rate', '--occurrence', '2', '--body', 'x']), S.BatchResultSchema).results).toMatchObject([{ anchor: { block: 'b5' } }])
    const r = await rev(abs)
    expect(expectOk<{ results: unknown[] }>(await run(['comment', abs, '--quote', 'member rate', '--near', 'b5', '--base-rev', String(r), '--body', 'y']), S.BatchResultSchema).results).toMatchObject([{ anchor: { block: 'b5' } }])
  })

  it('reply <file> <t_id> --body - (stdin) → BatchResult', async () => {
    const { abs } = doc()
    const t = expectOk<{ results: Array<{ thread: string }> }>(await run(['comment', abs, '--doc', '--body', 'First.']), S.BatchResultSchema).results[0]!.thread
    const r = expectOk<{ results: unknown[] }>(await run(['reply', abs, t, '--body', '-'], { stdin: 'A reply with "quotes", $dollars and `ticks`.' }), S.BatchResultSchema)
    expect(r.results).toMatchObject([{ op: 'reply', thread: t }])
    const detail = expectOk<{ thread: { messages: Array<{ body: string }> } }>(await run(['thread', abs, t]), S.ThreadDetailSchema)
    expect(detail.thread.messages.at(-1)!.body).toBe('A reply with "quotes", $dollars and `ticks`.')
  })

  it('suggest <file> --quote Q --replace R [--reason T] → BatchResult with suggestion, anchor and hunks; on an atom → UNANCHORABLE_TARGET exit 4', async () => {
    const { abs } = doc()
    const s = expectOk<{ results: unknown[] }>(await run(['suggest', abs, '--quote', 'We launch in Q3.', '--replace', 'We launch in Q3 2026.', '--reason', 'Name the year.']), S.BatchResultSchema)
    expect(s.results).toMatchObject([{ op: 'suggest', suggestion: expect.stringMatching(/^s_/), anchor: { state: 'ok', block: 'b2' }, hunks: [{ del: '', ins: ' 2026' }] }])
    const html = doc(HTML_DOC)
    const atom = expectCliErr(await run(['suggest', html.abs, '--quote', 'Raw block HTML stays byte-exact.', '--replace', 'Changed.']), ['UNANCHORABLE_TARGET'])
    expect(ERROR_TABLE[atom.error.code].exit).toBe(4)
  })

  it('suggest <file> --block bN --base-rev R --md M → BatchResult; stale rev → STALE_REVISION exit 7 with current and remap', async () => {
    const { abs } = doc()
    const r = await rev(abs)
    const s = expectOk<{ results: unknown[] }>(await run(['suggest', abs, '--block', 'b5', '--base-rev', String(r), '--md', 'The member rate is reviewed every month.']), S.BatchResultSchema)
    expect(s.results).toMatchObject([{ op: 'suggest_block', suggestion: expect.stringMatching(/^s_/) }])
    await run(['edit-block', abs, '--quote', 'Final paragraph', '--md', 'Final paragraph, rewritten.']) // moves the rev
    const stale = expectCliErr(await run(['suggest', abs, '--block', 'b2', '--base-rev', String(r), '--md', 'x']), ['STALE_REVISION'])
    expect(ERROR_TABLE.STALE_REVISION.exit).toBe(7)
    expect(stale.current).toBeDefined()
    expect(stale.error.remap).toBeDefined()
  })

  it('edit-block <file> SELECTOR (--md | --md - | --md-file F) [--insert-after | --insert-before] | --delete | --from/--to → BatchResult', async () => {
    const { abs } = doc()
    const ops = async (args: string[], o: Partial<RunCliOptions> = {}): Promise<string> =>
      (expectOk<{ results: Array<{ op: string }> }>(await run(['edit-block', abs, ...args], o), S.BatchResultSchema)).results[0]!.op
    expect(await ops(['--quote', 'We launch in Q3.', '--md', 'The notes carry a member rate of 12% paid monthly. We launch in Q4.'])).toBe('replace_block')
    expect(await ops(['--quote', 'Final paragraph', '--md', '-'], { stdin: 'Final paragraph from stdin.' })).toBe('replace_block')
    root.write('replacement.md', 'Final paragraph from a file.')
    expect(await ops(['--quote', 'Final paragraph from stdin.', '--md-file', root.path('replacement.md')])).toBe('replace_block')
    let r = await rev(abs)
    expect(await ops(['--ref', 'b1', '--base-rev', String(r), '--insert-after', '--md', 'An intro line.'])).toBe('insert_after')
    r = await rev(abs)
    expect(await ops(['--ref', 'b1', '--base-rev', String(r), '--insert-before', '--md', 'A preface.'])).toBe('insert_before')
    r = await rev(abs)
    expect(await ops(['--line', '1', '--base-rev', String(r), '--delete'])).toBe('delete_block')
    r = await rev(abs)
    expect(await ops(['--from', 'b2', '--to', 'b3', '--base-rev', String(r), '--md', 'Two blocks become one.'])).toBe('replace_range')
    const text = readFileSync(abs, 'utf8')
    expect(text).toContain('Two blocks become one.')
    expect(text).toContain('Final paragraph from a file.')
    expect(text).not.toContain('A preface.')
  })

  it('write <file> --base-rev R (--md-file F | --md -) → BatchResult; only changed blocks written', async () => {
    const { abs } = doc()
    const r = await rev(abs)
    const next = BASIC.replace('Ship the explainer page', 'Ship the explainer page and the FAQ')
    const w = expectOk<{ results: Array<{ op: string; changes?: Array<{ op: string; block: string }> }> }>(await run(['write', abs, '--base-rev', String(r), '--md', '-'], { stdin: next }), S.BatchResultSchema)
    expect(w.results[0]).toMatchObject({ op: 'write', changes: [{ op: 'replace', block: 'b4' }] })
    expect(readFileSync(abs, 'utf8')).toBe(next)
    root.write('whole.md', next)
    const again = expectOk<{ noop: boolean }>(await run(['write', abs, '--base-rev', String(await rev(abs)), '--md-file', root.path('whole.md')]), S.BatchResultSchema)
    expect(again.noop).toBe(true)
  })

  it('resolve / reopen <file> <t_id> → BatchResult; resolve with pending suggestions warns RESOLVED_WITH_PENDING', async () => {
    const { abs } = doc()
    const t = expectOk<{ results: Array<{ thread: string }> }>(await run(['comment', abs, '--doc', '--body', 'Done?']), S.BatchResultSchema).results[0]!.thread
    expect(expectOk<{ results: unknown[] }>(await run(['resolve', abs, t, '--body', 'Done.']), S.BatchResultSchema).results).toMatchObject([{ op: 'resolve' }])
    expect(expectOk<{ results: unknown[] }>(await run(['reopen', abs, t]), S.BatchResultSchema).results).toMatchObject([{ op: 'reopen' }])
    const st = expectOk<{ results: Array<{ thread: string }> }>(await run(['suggest', abs, '--quote', 'every quarter', '--replace', 'every month']), S.BatchResultSchema).results[0]!.thread
    const w = expectOk<{ warnings: Array<{ code: string }> }>(await run(['resolve', abs, st]), S.BatchResultSchema)
    expect(w.warnings.map((x) => x.code)).toContain('RESOLVED_WITH_PENDING')
  })

  it('decide <file> <s_id> accept|reject → BatchResult; on a Claude suggestion → NOT_AUTHOR exit 4', async () => {
    const { abs, rel } = doc()
    const c = await tj(rel)
    let a: SuggestionId
    let b: SuggestionId
    try {
      a = await tjSuggestion(c, 'reviewed every quarter', 'The member rate is reviewed every month.')
      b = await tjSuggestion(c, 'A short quote', '> A short quote that sets the context.')
    } finally {
      await c.close()
    }
    expect(expectOk<{ results: unknown[] }>(await run(['decide', abs, a, 'accept']), S.BatchResultSchema).results).toMatchObject([{ op: 'decide' }])
    expect(readFileSync(abs, 'utf8')).toContain('reviewed every month')
    expect(expectOk<{ results: unknown[] }>(await run(['decide', abs, b, 'reject']), S.BatchResultSchema).results).toMatchObject([{ op: 'decide' }])
    const mine = expectOk<{ results: Array<{ suggestion: string }> }>(await run(['suggest', abs, '--quote', 'We launch in Q3.', '--replace', 'We launch in Q4.']), S.BatchResultSchema).results[0]!.suggestion
    const e = expectCliErr(await run(['decide', abs, mine, 'accept']), ['NOT_AUTHOR'])
    expect(ERROR_TABLE[e.error.code].exit).toBe(4)
  })

  it('withdraw <file> <s_id> → BatchResult (own suggestions only)', async () => {
    const { abs } = doc()
    const s = expectOk<{ results: Array<{ suggestion: string }> }>(await run(['suggest', abs, '--quote', 'We launch in Q3.', '--replace', 'We launch soon.']), S.BatchResultSchema).results[0]!.suggestion
    expect(expectOk<{ results: unknown[] }>(await run(['withdraw', abs, s]), S.BatchResultSchema).results).toMatchObject([{ op: 'withdraw', suggestion: s }])
  })

  it('edit-comment / delete-comment <file> <c_id> → BatchResult; another author → NOT_AUTHOR', async () => {
    const { abs, rel } = doc()
    const mine = expectOk<{ results: Array<{ comment: string }> }>(await run(['comment', abs, '--doc', '--body', 'Typo here.']), S.BatchResultSchema).results[0]!.comment
    expect(expectOk<{ results: unknown[] }>(await run(['edit-comment', abs, mine, '--body', 'Typo fixed.']), S.BatchResultSchema).results).toMatchObject([{ op: 'edit_comment' }])
    expect(expectOk<{ results: unknown[] }>(await run(['delete-comment', abs, mine]), S.BatchResultSchema).results).toMatchObject([{ op: 'delete_comment' }])
    const c = await tj(rel)
    let theirs: string
    try {
      theirs = (await c.createThread({ kind: 'doc' }, 'TJ wrote this.')).thread.messages[0]!.id
    } finally {
      await c.close()
    }
    expectCliErr(await run(['edit-comment', abs, theirs, '--body', 'Rewritten by Claude.']), ['NOT_AUTHOR'])
    expectCliErr(await run(['delete-comment', abs, theirs]), ['NOT_AUTHOR'])
  })

  it('ack <file> --cursor N [--since S] → BatchResult with acked; since mismatch → ACK_CONFLICT exit 7', async () => {
    const { abs, rel } = doc()
    const c = await tj(rel)
    try {
      await c.createThread({ kind: 'doc' }, 'Please look.')
    } finally {
      await c.close()
    }
    const p = expectOk<{ cursor: number; since: number }>(await run(['pending', abs]), S.PendingResultSchema)
    const a = expectOk<{ acked: number; results: unknown[] }>(await run(['ack', abs, '--cursor', String(p.cursor), '--since', String(p.since)]), S.BatchResultSchema)
    expect(a).toMatchObject({ acked: p.cursor, results: [] })
    const e = expectCliErr(await run(['ack', abs, '--cursor', String(p.cursor), '--since', String(p.since)]), ['ACK_CONFLICT']) // since moved
    expect(ERROR_TABLE[e.error.code].exit).toBe(7)
  })

  it('batch --dry-run → BatchResult with dryRun: true, noop: true, nothing written', async () => {
    const { abs, rel } = doc()
    const before = root.readSidecar(rel).length
    const d = expectOk(await run(['batch', abs, '--dry-run'], { stdin: { ops: [{ op: 'replace_block', target: { quote: 'We launch in Q3.' }, markdown: 'Changed.' }, { op: 'comment', doc: true, body: 'x' }] } }), S.BatchResultSchema)
    expect(d).toMatchObject({ dryRun: true, noop: true })
    expect(readFileSync(abs, 'utf8')).toBe(BASIC)
    expect(root.readSidecar(rel).length).toBe(before)
  })

  it('batch retried with the same ops in the same round → duplicate: true results, nothing appended (§4.7)', async () => {
    const { abs, rel } = doc()
    const req = { ops: [{ op: 'comment', quote: 'member rate of 12%', body: 'Is this current?' }] }
    const first = expectOk<{ seq: number; results: Array<{ key: string; thread: string }> }>(await run(['batch', abs], { stdin: req }), S.BatchResultSchema)
    const lines = root.readSidecar(rel).length
    const again = expectOk<{ seq: number; results: Array<{ key: string; thread: string; duplicate?: boolean }> }>(await run(['batch', abs], { stdin: req }), S.BatchResultSchema)
    expect(again.results[0]).toMatchObject({ duplicate: true, key: first.results[0]!.key, thread: first.results[0]!.thread })
    expect(first.results[0]!.key).toMatch(/^cli:[0-9a-f]{32}$/) // derived by the store: the CLI sends no key
    expect(root.readSidecar(rel).length).toBe(lines)
  })

  it('wait delivers a latched handoff: WaitResult status handoff with prompt = buildWakePrompt(payload), exit 0, then consume', async () => {
    const { abs, rel } = doc()
    expectOk(await run(['arm', abs]), S.ArmResultSchema) // grace: the click is latched
    const c = await tj(rel)
    let sent: { seq: number; delivery: string }
    try {
      sent = await c.handoff('Your turn.')
    } finally {
      await c.close()
    }
    expect(sent.delivery).toBe('latched')
    const id = 'w_00000000000000bb'
    const w = await run(['wait', abs, '--waiter', id, '--timeout', '20'])
    const res = expectOk<{ status: string; payload: { handoffs: Array<{ seq: number; message: string }>; waiter: string; round: number }; prompt: string }>(w, S.WaitResultSchema)
    expect(res).toMatchObject({ status: 'handoff', payload: { waiter: id, round: 1, handoffs: [{ seq: sent.seq, message: 'Your turn.' }] } })
    expect(res.prompt).toBe(buildWakePrompt(res.payload as never))
    const consumed = (root.readSidecar(rel) as Array<{ type?: string; handoffs?: number[]; waiter?: string; via?: string }>).filter((l) => l.type === 'handoff.consumed')
    expect(consumed).toMatchObject([{ handoffs: [sent.seq], via: 'waiter', waiter: id }])
  }, 60_000)

  it('wait: superseded / disarmed / server-shutdown stop → exit 10; PROTOCOL_MISMATCH / ROOT_MISMATCH → exit 8 without retry', async () => {
    const { abs } = doc()
    const w1 = spawnCli(['wait', abs, '--waiter', 'w_00000000000000c1', '--timeout', '30'], cliOpts(root))
    expect(expectOk(await run(['status', abs, '--wait-waiter', '20']), S.StatusResultSchema)).toMatchObject({ presence: { waiterId: 'w_00000000000000c1' } })
    const w2 = spawnCli(['wait', abs, '--waiter', 'w_00000000000000c2', '--timeout', '30'], cliOpts(root))
    const r1 = await w1.exited
    expectCliErr(r1, ['WAITER_SUPERSEDED'])
    expect(r1.code).toBe(10)
    expect(expectOk(await run(['status', abs, '--wait-waiter', '20']), S.StatusResultSchema)).toMatchObject({ presence: { waiterId: 'w_00000000000000c2' } })
    expectOk(await run(['disarm', abs]), S.DisarmResultSchema)
    const r2 = await w2.exited
    expectCliErr(r2, ['DISARMED'])
    expect(r2.code).toBe(10)
    // (server-shutdown stop → exit 10 is in the `stop` case above, on a server of its own)

    const p3 = tmpRoot({ name: 'cli-contract-m3-proto', fixtures: [DOC] })
    const liarRoot = tmpRoot({ name: 'cli-contract-m3-liar2', fixtures: [DOC] })
    const newer = await serveRoot(p3, { MDR_TEST_PROTOCOL: '3' })
    const liar = await lyingServer(liarRoot)
    try {
      let t0 = Date.now()
      const pm = await runCli(['wait', p3.path(DOC), '--waiter', WAITER, '--timeout', '30'], cliOpts(p3))
      expect(expectCliErr(pm, ['PROTOCOL_MISMATCH']).error.hint).toBe(`mdr serve ${p3.root} --restart`)
      expect(Date.now() - t0, 'exit 8 at once, never retried until the deadline').toBeLessThan(10_000)
      t0 = Date.now()
      expectCliErr(await runCli(['wait', liarRoot.path(DOC), '--waiter', WAITER, '--timeout', '30'], cliOpts(liarRoot)), ['ROOT_MISMATCH'])
      expect(Date.now() - t0).toBeLessThan(10_000)
    } finally {
      await newer.stop()
      await liar.close()
      p3.cleanup()
      liarRoot.cleanup()
    }
  }, 90_000)

  it('history <file> [--limit N] | --show vN | --diff a..b → HistoryList | VersionShow | HistoryDiff', async () => {
    const { abs } = doc()
    await run(['edit-block', abs, '--quote', 'We launch in Q3.', '--md', 'The notes carry a member rate of 12% paid monthly. We launch in Q4.'])
    const list = expectOk<{ versions: Array<{ v: string }> }>(await run(['history', abs, '--limit', '5']), S.HistoryListSchema)
    expect(list.versions.length).toBeGreaterThanOrEqual(1)
    const v = list.versions.at(-1)!.v
    expectOk(await run(['history', abs, '--show', v]), S.VersionShowSchema)
    expectOk(await run(['history', abs, '--diff', `${v}..current`]), S.HistoryDiffSchema)
    expectCliErr(await run(['history', abs, '--diff', 'nonsense']), ['USAGE'])
  })

  it('doctor <file> [--repair] [--compact] [--gc] → DoctorResult', async () => {
    const { abs, rel } = doc()
    await run(['comment', abs, '--doc', '--body', 'One line in the log.'])
    expect(expectOk(await run(['doctor', abs]), S.DoctorResultSchema)).toMatchObject({ file: rel, sidecar: { exists: true, corruptLines: [], tornTail: false }, actions: [] })
    const g = expectOk<{ actions: string[] }>(await run(['doctor', abs, '--repair', '--compact', '--gc']), S.DoctorResultSchema)
    expect(g.actions).toContain('gc')
  })

  it('--pretty indents the single document; --verbose writes progress to stderr only; stderr holds at most one line on failure', async () => {
    const { abs } = doc()
    const pretty = await run(['status', abs, '--pretty'])
    expectOk(pretty, S.StatusResultSchema)
    expect(pretty.stdout.trim().split('\n').length).toBeGreaterThan(5)
    expect(pretty.stdout).toMatch(/\n {2}"/)
    const compact = await run(['status', abs])
    expect(compact.stdout.trim().split('\n')).toHaveLength(1)
    const verbose = await run(['status', abs, '--verbose'])
    expectOk(verbose, S.StatusResultSchema)
    expect(verbose.stderr.trim()).not.toBe('')
    const fail = await run(['thread', abs, `t_${ulid()}`])
    expectCliErr(fail, ['THREAD_NOT_FOUND'])
    expect(fail.stderr.trim().split('\n').filter(Boolean).length).toBeLessThanOrEqual(1)
  })
})
