// tests/e2e/p4-handoff-latch.spec.ts (P4; CONTRACTS §14 P4 E2E, §8.5 steps 3–6 "the latch is this durable line", §8.7
// at-least-once, §9.7 "Latch", D46).
//
// Send to Claude when no waiter stream is open at that instant, against the real built server with
// MDR_TEST_WAIT_TIMEOUT_S=3: (a) during a server restart (the loop's `wait` is held so it can't reconnect before the
// click lands), and (b) during the loop's re-arm gap (between one `wait` exiting 2 and the next connecting). Both are
// `latched` (SSE `handoff { state: 'latched' }`) and both are delivered to the loop. (c) A latched click survives the
// server process itself: clicked with no loop, server restarted, then the loop starts and gets it (the latch is the
// handoff.sent line, read back through store.handoffs(), D46).
import type { ArmResult, StatusResult, WaitResult } from '../../shared/types'
import { buildWakePrompt } from '../../shared/handoff-prompt'
import { expect, killLoops, ok, P4_PORT_OFFSET, presenceOf, recordEvents, startLoop, test, type Loop } from './fixtures/p4'

const FILE = 'basic.md'
const ENV = { MDR_TEST_WAIT_TIMEOUT_S: '3', MDR_TEST_HEARTBEAT_MS: '50', MDR_TEST_WATCHDOG_MS: '300' }

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P4_PORT_OFFSET, serverEnv: ENV })
test.afterEach(killLoops)

type Woke = Extract<WaitResult, { status: 'handoff' }>

function delivered(out: Awaited<Loop['exited']>, seqs: number[]): Woke {
  expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0)
  expect(out.lines).toHaveLength(1)
  const w = out.json as Woke
  expect(w.status).toBe('handoff')
  expect(w.prompt).toBe(buildWakePrompt(w.payload))
  expect(w.payload.handoffs.map((h) => h.seq)).toEqual(seqs)
  return w
}

test('latched during a server restart and during the loop\'s re-arm gap: both delivered', async ({ cli, server, webClient, tmpRoot }) => {
  test.setTimeout(90_000)
  const abs = cli.abs(FILE)

  // (a) during a server restart: hold the loop so its wait can't reconnect, restart, click, release
  const arm = ok<ArmResult>(await cli.run(['arm', abs]))
  const loop = startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
  expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
  process.kill(-loop.child.pid!, 'SIGSTOP')
  let restartSeq: number
  try {
    await server.restart({ env: ENV })
    const log = await recordEvents(webClient)
    expect((await presenceOf(webClient)).waiter, 'restart grace: the old loop is expected back').toBe('grace')
    const r = await webClient.handoff('clicked during the restart')
    expect(r.delivery).toBe('latched')
    restartSeq = r.seq
    expect((await log.next('handoff', { where: (e) => e.data.seq === r.seq })).data).toMatchObject({ state: 'latched', delivery: 'latched' })
    void log.close()
  } finally {
    process.kill(-loop.child.pid!, 'SIGCONT')
  }
  delivered(await loop.exit(20_000), [restartSeq])

  // (b) during the loop's re-arm gap: a new loop, wait for a `grace` between two waits, click
  const arm2 = ok<ArmResult>(await cli.run(['arm', abs]))
  const loop2 = startLoop(arm2.waiter!, { home: tmpRoot.home, env: ENV })
  expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
  const log2 = await recordEvents(webClient)
  const from = log2.mark()
  await log2.next('presence', { from, where: (e) => e.data.waiter === 'grace' && e.data.waiterId === arm2.waiter!.waiter, timeoutMs: 8_000 })
  const gap = await webClient.handoff('clicked in the re-arm gap')
  expect(gap.delivery).toBe('latched')
  const w = delivered(await loop2.exit(15_000), [gap.seq])
  expect(w.payload).toMatchObject({ waiter: arm2.waiter!.waiter, round: 2 })
  void log2.close()

  // both handoff lines are durable and consumed by the waiter that delivered them
  const lines = tmpRoot.readSidecar(FILE) as Array<{ type?: string; seq: number; delivery?: string; handoffs?: number[]; via?: string; by?: string }>
  expect(lines.filter((l) => l.type === 'handoff.sent').map((l) => [l.seq, l.delivery])).toEqual([[restartSeq, 'latched'], [gap.seq, 'latched']])
  const consumed = lines.filter((l) => l.type === 'handoff.consumed')
  expect(consumed.map((l) => [l.handoffs, l.via, l.by])).toEqual([[[restartSeq], 'waiter', 'Claude'], [[gap.seq], 'waiter', 'Claude']])
})

test('a latched click outlives the server process: clicked with no loop, server restarted, the next loop gets it', async ({ cli, server, webClient, tmpRoot }) => {
  test.setTimeout(60_000)
  const abs = cli.abs(FILE)
  ok<ArmResult>(await cli.run(['arm', abs])) // the skill is starting a loop: presence grace
  const r = await webClient.handoff('clicked before the loop started')
  expect(r.delivery).toBe('latched')
  await server.restart({ env: ENV })
  const st = ok<StatusResult>(await cli.run(['status', abs]))
  expect(st.handoff.undelivered).toEqual([r.seq]) // read back from the log, not from memory
  const arm = ok<ArmResult>(await cli.run(['arm', abs]))
  const loop = startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
  const out = await loop.exit(15_000)
  const w = delivered(out, [r.seq])
  expect(out.ms, 'delivered on connect').toBeLessThan(3_000)
  expect(w.payload).toMatchObject({ round: 1, handoffs: [{ seq: r.seq, message: 'clicked before the loop started' }] })
})
