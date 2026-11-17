// Integrator (day 0): startFakeServer over a real socket, driven by the day-0 CLI (run from source with tsx, like
// tests/contract/cli.contract.test.ts). Proves the pieces P2/P3/P4 specs combine before M2 (CONTRACTS §2.5, §8.5,
// §8.7, §9.2): the marker makes the fake discoverable, `mdr batch` writes through it, and `mdr wait` receives a
// handoff through the stub's waiter stream (presence connected → delivery 'waiter'), with the wake prompt carrying
// the server-computed round.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BatchResult, HandoffResult, WaitResult } from '../../../shared/types'
import { buildWakePrompt } from '../../../shared/handoff-prompt'
import { runCli, spawnCli, type RunCliOptions } from '../../helpers/runCli'
import { readMarker } from '../../helpers/startServer'
import { startFakeServer, type FakeServerHandle } from '../../helpers/startFakeServer'
import { REPO_ROOT, tmpRoot, type TmpRoot } from '../../helpers/tmpRoot'
import { webClient } from '../../helpers/webClient'

const CLI_SRC = join(REPO_ROOT, 'cli', 'main.ts')
const DOC = 'basic.md'

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(p))
    })
  })
}

describe('startFakeServer + the day-0 CLI', () => {
  let root: TmpRoot
  let fake: FakeServerHandle
  const cli = (extra: RunCliOptions = {}): RunCliOptions => ({ cliPath: CLI_SRC, env: { NODE_OPTIONS: '--import tsx' }, home: root.home, cwd: REPO_ROOT, timeoutMs: 60_000, ...extra })

  beforeAll(async () => {
    root = tmpRoot({ name: 'start-fake-server', fixtures: [DOC] })
    fake = await startFakeServer({ root: root.root, port: await freePort(), diskPollMs: 0 })
  }, 60_000)
  afterAll(async () => {
    await fake?.close()
    root?.cleanup()
  })

  it('writes a marker the CLI accepts (pid = this process, mode 0600, .gitignore first)', () => {
    const m = readMarker(root.root)
    expect(m).toMatchObject({ app: 'mdr', root: root.root, port: fake.port, pid: process.pid, token: fake.token })
    expect(root.exists('.review/.gitignore')).toBe(true)
  })

  it('mdr batch discovers the fake and writes through it', async () => {
    const r = await runCli(['batch', root.path(DOC)], cli({ stdin: { ops: [{ op: 'comment', doc: true, body: 'From the CLI.' }] } }))
    expect(r.docs, r.stderr).toBe(1)
    expect(r.code).toBe(0)
    const b = r.json as BatchResult
    expect(b.via).toBe('server')
    expect(b.results[0]!.thread).toMatch(/^t_/)
    const review = await (await fake.store(DOC)).review()
    expect(review.threads.some((t) => t.messages[0]?.body === 'From the CLI.')).toBe(true)
  }, 60_000)

  it('mdr wait receives a handoff through the waiter stream (delivery waiter, server round)', async () => {
    const waiter = `w_${randomBytes(8).toString('hex')}`
    const w = spawnCli(['wait', root.path(DOC), '--root', root.root, '--waiter', waiter, '--timeout', '30'], cli())
    const store = await fake.store(DOC)
    const t0 = Date.now()
    while (fake.app.handoff.presence(DOC).waiter !== 'connected') {
      if (Date.now() - t0 > 20_000) throw new Error(`waiter never connected: ${w.stderr()}`)
      await new Promise((r) => setTimeout(r, 50))
    }
    const tj = await webClient({ port: fake.port, root: root.root, file: DOC })
    const h: HandoffResult = await tj.handoff('Please look at the goals')
    expect(h.delivery).toBe('waiter')
    const done = await w.exited
    expect(done.code, done.stderr).toBe(0)
    const out = done.json as Extract<WaitResult, { status: 'handoff' }>
    expect(out.status).toBe('handoff')
    expect(out.payload.handoffs.map((x) => x.seq)).toEqual([h.seq])
    expect(out.payload.round).toBe((await store.handoffs()).find((x) => x.seq === h.seq)!.round)
    expect(out.prompt).toBe(buildWakePrompt(out.payload))
    await tj.close()
  }, 60_000)
})
