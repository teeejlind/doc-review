// tests/unit/cli/wait.test.ts (P4; CONTRACTS §9.7, §8.7, D21, D49; §13 rows 50, 52, 53, 78, 82, 89, 92).
//
// `mdr wait` (the real CLI, in-process) over real sockets against the real handoff module served by the harness:
// handoff → the step-3 line then consume; timeout while connected → 2; superseded / disarmed / server-shutdown stop
// → 10; a server restart mid-wait → reconnect and deliver; down until the deadline → 11; PROTOCOL_MISMATCH and
// ROOT_MISMATCH → 8 at once; the watchdog reconnects a silent stream with the same waiter id and gen.
import { afterEach, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import { buildWakePrompt } from '../../../shared/handoff-prompt'
import { createHarness, until, W1, W2, type Harness } from '../handoff/harness'
import { cli, type InProcessRun } from './runner'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const file = (h: Harness): string => `${h.root}/doc.md`
const connected = (h: Harness, id = W1): boolean => {
  const p = h.module.presence('doc.md')
  return p.waiter === 'connected' && p.waiterId === id
}

function waitCli(h: Harness, args: string[], env: Record<string, string> = {}): Promise<InProcessRun> {
  return cli(['wait', file(h), '--root', h.root, ...args], { env })
}

describe('mdr wait over a real socket', () => {
  it('a handoff → prints {ok, status: handoff, payload, prompt} once, exits 0, then consumes', async () => {
    h = await createHarness()
    await h.serve()
    const p = waitCli(h, ['--waiter', W1, '--timeout', '20'])
    await until(() => connected(h!), 5000)
    const sent = await h.handoff({ message: 'Section 2' })
    const r = await p
    expect(r.code).toBe(0)
    expect(r.docs).toBe(1)
    expect(S.WaitResultSchema.safeParse(r.json).success).toBe(true)
    expect(r.json).toMatchObject({ ok: true, status: 'handoff', payload: { handoffs: [{ seq: sent.seq, message: 'Section 2' }], round: 1, waiter: W1 } })
    expect(r.json.prompt).toBe(buildWakePrompt(r.json.payload))
    expect(r.stderr).toBe('')
    await until(() => (h!.broadcasts.some((e) => e.event === 'handoff' && e.data.state === 'consumed')), 3000)
    const consumed = h.events().filter((e) => e.type === 'handoff.consumed')
    expect(consumed).toMatchObject([{ by: 'Claude', via: 'waiter', waiter: W1, handoffs: [sent.seq] }])
  })

  it('a latched handoff (sent before the wait started) is delivered on connect', async () => {
    h = await createHarness()
    await h.serve()
    await h.arm()
    const sent = await h.handoff()
    expect(sent.delivery).toBe('latched')
    const r = await waitCli(h, ['--waiter', W1, '--timeout', '20'])
    expect(r.code).toBe(0)
    expect(r.json.payload.handoffs.map((x: { seq: number }) => x.seq)).toEqual([sent.seq])
  })

  it('the deadline while connected → {status: timeout} exit 2 (not an error: nothing on stderr)', async () => {
    h = await createHarness()
    await h.serve()
    const r = await waitCli(h, ['--waiter', W1, '--timeout', '1'])
    expect(r.code).toBe(2)
    expect(r.json).toMatchObject({ ok: true, status: 'timeout', file: 'doc.md' })
    expect(r.json.waitedMs).toBeGreaterThanOrEqual(900)
    expect(r.stderr).toBe('')
  })

  it('another waiter for the doc → WAITER_SUPERSEDED exit 10; the same line twice → the older copy exits 10', async () => {
    h = await createHarness()
    await h.serve()
    const a = waitCli(h, ['--waiter', W1, '--timeout', '20', '--waiter-gen', '1'])
    await until(() => connected(h!, W1), 5000)
    const b = waitCli(h, ['--waiter', W2, '--timeout', '2'])
    const ra = await a
    expect(ra.code).toBe(10)
    expect(ra.json).toMatchObject({ ok: false, error: { code: 'WAITER_SUPERSEDED', details: { by: W2, reason: 'newer-waiter' } } })
    await b
    const c = waitCli(h, ['--waiter', W1, '--timeout', '20', '--waiter-gen', '5'])
    await until(() => connected(h!, W1), 5000)
    const d = waitCli(h, ['--waiter', W1, '--timeout', '1', '--waiter-gen', '9'])
    const rc = await c
    expect(rc.code).toBe(10)
    expect(rc.json.error.details).toEqual({ by: W1, reason: 'replaced' })
    expect((await d).code).toBe(2)
  })

  it('mdr disarm → the live wait exits DISARMED (10)', async () => {
    h = await createHarness()
    await h.serve()
    const p = waitCli(h, ['--waiter', W1, '--timeout', '20'])
    await until(() => connected(h!), 5000)
    const dis = await cli(['disarm', file(h)])
    expect(dis.json).toEqual({ ok: true, file: 'doc.md', disarmed: true })
    const r = await p
    expect(r.code).toBe(10)
    expect(r.json).toMatchObject({ error: { code: 'DISARMED' } })
  })

  it('server-shutdown stop → SERVER_STOPPED (10)', async () => {
    h = await createHarness()
    const served = await h.serve()
    const p = waitCli(h, ['--waiter', W1, '--timeout', '20'])
    await until(() => connected(h!), 5000)
    await served.stop('stop')
    const r = await p
    expect(r.code).toBe(10)
    expect(r.json).toMatchObject({ error: { code: 'SERVER_STOPPED' } })
  })

  it('a server restart mid-wait → reconnects (same id) and still delivers a click made after the restart (§13 #50)', async () => {
    h = await createHarness()
    const served = await h.serve()
    const p = waitCli(h, ['--waiter', W1, '--timeout', '30'])
    await until(() => connected(h!), 5000)
    await served.stop('restart')
    await h.restart()
    await h.serve({ port: served.port })
    await until(() => connected(h!), 8000)
    const sent = await h.handoff()
    const r = await p
    expect(r.code).toBe(0)
    expect(r.json.payload.handoffs.map((x: { seq: number }) => x.seq)).toEqual([sent.seq])
  })

  it('a click while the server is down is latched by the durable line and delivered after the restart', async () => {
    h = await createHarness()
    const served = await h.serve()
    const p = waitCli(h, ['--waiter', W1, '--timeout', '30'])
    await until(() => connected(h!), 5000)
    await served.stop('restart')
    await h.restart()
    const sent = await h.handoff() // module up, socket down: the waiter can't be connected; the line is durable
    await h.serve({ port: served.port })
    const r = await p
    expect(r.code).toBe(0)
    expect(r.json.payload.handoffs.map((x: { seq: number }) => x.seq)).toEqual([sent.seq])
  })

  it('no server until the deadline → SERVER_UNREACHABLE exit 11; wait never starts one', async () => {
    h = await createHarness()
    const t0 = Date.now()
    const r = await waitCli(h, ['--waiter', W1, '--timeout', '1'])
    expect(r.code).toBe(11)
    expect(r.json).toMatchObject({ ok: false, error: { code: 'SERVER_UNREACHABLE' } })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  })

  it('PROTOCOL_MISMATCH → exit 8 at once, no retry inside the run (§13 #92)', async () => {
    h = await createHarness()
    await h.serve({ protocol: 3 })
    const t0 = Date.now()
    const r = await waitCli(h, ['--waiter', W1, '--timeout', '30'])
    expect(r.code).toBe(8)
    expect(r.json).toMatchObject({ error: { code: 'PROTOCOL_MISMATCH', hint: `mdr serve ${h.root} --restart` } })
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('ROOT_MISMATCH (the stream lacks this root\'s hash) → exit 8 at once', async () => {
    h = await createHarness()
    await h.serve({ rootHash: 'a'.repeat(64) })
    const t0 = Date.now()
    const r = await waitCli(h, ['--waiter', W1, '--timeout', '30'])
    expect(r.code).toBe(8)
    expect(r.json).toMatchObject({ error: { code: 'ROOT_MISMATCH' } })
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('the watchdog drops a silent stream and reconnects with the same id and gen (MDR_TEST_WATCHDOG_MS)', async () => {
    h = await createHarness({ options: { heartbeatMs: 60_000 } })
    await h.serve()
    let waits = 0
    const orig = h.module.core.openWaiter.bind(h.module.core)
    h.module.core.openWaiter = (f, id, gen) => {
      waits++
      expect(id).toBe(W1)
      expect(gen).toBe(77)
      return orig(f, id, gen)
    }
    const p = waitCli(h, ['--waiter', W1, '--timeout', '20', '--waiter-gen', '77'], { MDR_TEST_WATCHDOG_MS: '200' })
    await until(() => waits >= 3, 8000)
    const sent = await h.handoff()
    const r = await p
    expect(r.code).toBe(0)
    expect(r.json.payload.handoffs.map((x: { seq: number }) => x.seq)).toEqual([sent.seq])
  })

  it('a derived waiter id (no --waiter) is w_ + 16 hex of sha256(seed + NUL + abs)', async () => {
    h = await createHarness()
    await h.serve()
    const p = waitCli(h, ['--waiter-seed', 'seed-1', '--timeout', '20'])
    await until(() => h!.module.presence('doc.md').waiter === 'connected', 5000)
    const { createHash } = await import('node:crypto')
    const want = 'w_' + createHash('sha256').update('seed-1\0' + file(h)).digest('hex').slice(0, 16)
    expect(h.module.presence('doc.md').waiterId).toBe(want)
    await h.disarm()
    expect((await p).code).toBe(10)
  })
})
