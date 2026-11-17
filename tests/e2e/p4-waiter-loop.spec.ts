// tests/e2e/p4-waiter-loop.spec.ts (P4; CONTRACTS §9.8.3, §9.8.1–§9.8.2, §9.7, §8.5, §8.7, D21, D48, D49).
//
// The real loop line from `mdr arm` (WaiterSpec.command) run as a child bash, against the real built server with
// MDR_TEST_WAIT_TIMEOUT_S=3, MDR_TEST_HEARTBEAT_MS=50, MDR_TEST_WATCHDOG_MS=150 and MDR_TEST_TURN_IDLE_MS=1500:
// - three re-arms with presence never `none`; a click in a re-arm gap is `latched` and the loop exits 0 with it; a
//   second click right after (presence `turn`) is `latched` and the next loop exits 0 with it at once;
// - a server restart mid-wait: the click after the restart is delivered to the same loop;
// - the same line started twice: the older copy exits 10 (WAITER_SUPERSEDED);
// - `mdr disarm`: exit 10 (DISARMED);
// - a server restarted with another protocol (MDR_TEST_PROTOCOL): the loop exits 8 once with PROTOCOL_MISMATCH and
//   does not re-run;
// - `mdr arm` with no loop: presence `grace`, then `none` after WAITER_GRACE_MS (20 s, no test hook);
// - after a delivering exit, no agent request for TURN_IDLE_MS: presence `none`; a control request keeps `turn` alive.
import type { ArmResult, HandoffResult, Presence, StatusResult, WaitResult } from '../../shared/types'
import { CONSTANTS } from '../../shared/constants'
import { buildWakePrompt } from '../../shared/handoff-prompt'
import type { CliHelper } from './fixtures'
import { expect, killLoops, ok, P4_PORT_OFFSET, presenceOf, recordEvents, sleep, startLoop, test, waitPresence, type Loop } from './fixtures/p4'
import type { TmpRoot } from '../helpers/tmpRoot'

const FILE = 'basic.md'
const TURN_IDLE_MS = 1_500
const ENV = { MDR_TEST_WAIT_TIMEOUT_S: '3', MDR_TEST_HEARTBEAT_MS: '50', MDR_TEST_WATCHDOG_MS: '150', MDR_TEST_TURN_IDLE_MS: String(TURN_IDLE_MS) }

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P4_PORT_OFFSET, serverEnv: ENV })
test.afterEach(killLoops)

type Woke = Extract<WaitResult, { status: 'handoff' }>

/** `mdr arm`, then start its loop line; resolves once the loop's waiter is connected. */
async function armAndStart(cli: CliHelper, tmpRoot: TmpRoot): Promise<{ arm: ArmResult; loop: Loop }> {
  const arm = ok<ArmResult>(await cli.run(['arm', cli.abs(FILE)]))
  expect(arm.waiter, 'the waiter loop is primary (CLIPBOARD_PRIMARY off)').not.toBeNull()
  expect(arm.waiter!.command).toContain(' --timeout 3)') // MDR_TEST_WAIT_TIMEOUT_S replaces <T>
  const loop = startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
  const st = ok<StatusResult>(await cli.run(['status', cli.abs(FILE), '--wait-waiter', '15']))
  expect(st.presence).toMatchObject({ waiter: 'connected', waiterId: arm.waiter!.waiter })
  return { arm, loop }
}

function woke(out: Awaited<Loop['exited']>): Woke {
  expect(out.code, `loop exit; stdout=${out.stdout} stderr=${out.stderr}`).toBe(0)
  expect(out.lines, 'the loop prints exactly one line').toHaveLength(1)
  const w = out.json as Woke
  expect(w).toMatchObject({ ok: true, status: 'handoff' })
  expect(w.prompt).toBe(buildWakePrompt(w.payload))
  return w
}

test('three re-arms never reach none; a click in a re-arm gap is latched and wakes the loop; a click in turn wakes the next loop at once', async ({ cli, webClient, tmpRoot }) => {
  test.setTimeout(90_000)
  const log = await recordEvents(webClient)
  const { arm, loop } = await armAndStart(cli, tmpRoot)
  const id = arm.waiter!.waiter

  // three re-arms: each `wait --timeout 3` exits 2 while connected and the loop re-runs it with the same id
  const from = log.mark()
  const connects = (): number => log.all('presence', from).filter((e) => e.data.waiter === 'connected').length
  const deadline = Date.now() + 20_000
  while (connects() < 3 && Date.now() < deadline) await sleep(100)
  expect(connects(), 'three re-arms').toBeGreaterThanOrEqual(3)
  const seen = log.all('presence', from).map((e) => e.data)
  expect(seen.map((p) => p.waiter)).not.toContain('none')
  expect(seen.every((p: Presence) => p.waiterId === id)).toBe(true)
  expect(loop.done()).toBe(false)

  // a click in the next re-arm gap: latched, and the loop's next wait delivers it
  const gapFrom = log.mark()
  await log.next('presence', { from: gapFrom, where: (e) => e.data.waiter === 'grace', timeoutMs: 8_000 })
  const first: HandoffResult = await webClient.handoff('first, sent in the re-arm gap')
  expect(first.delivery).toBe('latched')
  expect(first.presence).toMatchObject({ waiter: 'grace', waiterId: id })
  const w1 = woke(await loop.exit(15_000))
  expect(w1.payload.handoffs.map((h) => h.seq)).toEqual([first.seq])
  expect(w1.payload).toMatchObject({ waiter: id, round: 1 })

  // a second click right after the delivering exit: presence turn → latched; the next loop exits 0 with it at once
  await waitPresence(webClient, (p) => p.waiter === 'turn', { what: 'turn' })
  const second = await webClient.handoff('second, sent during the turn')
  expect(second).toMatchObject({ coalesced: false, delivery: 'latched' })
  const arm2 = ok<ArmResult>(await cli.run(['arm', cli.abs(FILE)]))
  expect(arm2).toMatchObject({ attached: false, presence: { waiter: 'grace' } })
  const loop2 = startLoop(arm2.waiter!, { home: tmpRoot.home, env: ENV })
  const out2 = await loop2.exit(15_000)
  const w2 = woke(out2)
  expect(out2.ms, 'delivered on connect, before the first 3 s timeout').toBeLessThan(3_000)
  expect(w2.payload.handoffs.map((h) => h.seq)).toEqual([second.seq]) // the first was consumed: never redelivered
  expect(w2.payload).toMatchObject({ waiter: arm2.waiter!.waiter, round: 2 })
  await log.close()
})

test('a server restart mid-wait: the click after the restart reaches the same loop', async ({ cli, server, webClient, tmpRoot }) => {
  test.setTimeout(90_000)
  const { arm, loop } = await armAndStart(cli, tmpRoot)
  const tokenBefore = server.token
  await server.restart({ env: ENV })
  expect(server.token, 'a signal restart keeps the marker, so the token (and the open tab) survive').toBe(tokenBefore)
  // restart grace: the new process starts the doc in grace, so the click is latched while the loop reconnects
  const r = await webClient.handoff('after the restart')
  expect(['latched', 'waiter']).toContain(r.delivery)
  const w = woke(await loop.exit(20_000))
  expect(w.payload.handoffs.map((h) => h.seq)).toEqual([r.seq])
  expect(w.payload.waiter).toBe(arm.waiter!.waiter)
})

test('a click while the restarted server waits for the old loop is latched (restart grace), not offered as a clipboard prompt', async ({ cli, server, webClient, tmpRoot }) => {
  test.setTimeout(90_000)
  const { loop } = await armAndStart(cli, tmpRoot)
  // hold the loop: stop the shell's process group so its wait can't reconnect yet
  process.kill(-loop.child.pid!, 'SIGSTOP')
  try {
    await server.restart({ env: ENV })
    expect((await presenceOf(webClient)).waiter).toBe('grace')
    const r = await webClient.handoff('clicked before the loop reconnected')
    expect(r.delivery).toBe('latched')
  } finally {
    process.kill(-loop.child.pid!, 'SIGCONT')
  }
  const w = woke(await loop.exit(20_000))
  expect(w.payload.handoffs).toHaveLength(1)
})

test('the same line started twice: the older copy exits 10 (WAITER_SUPERSEDED); disarm ends the newer with exit 10', async ({ cli, tmpRoot }) => {
  test.setTimeout(60_000)
  const { arm, loop: older } = await armAndStart(cli, tmpRoot)
  const newer = startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
  const out = await older.exit(15_000)
  expect(out.code).toBe(10)
  expect(out.lines).toHaveLength(1)
  expect(out.json).toMatchObject({ ok: false, error: { code: 'WAITER_SUPERSEDED' } })
  const st = ok<StatusResult>(await cli.run(['status', cli.abs(FILE), '--wait-waiter', '10']))
  expect(st.presence).toMatchObject({ waiter: 'connected', waiterId: arm.waiter!.waiter })
  expect(newer.done()).toBe(false)

  expect(ok(await cli.run(['disarm', cli.abs(FILE)]))).toEqual({ ok: true, file: FILE, disarmed: true })
  const end = await newer.exit(10_000)
  expect(end.code).toBe(10)
  expect(end.json).toMatchObject({ ok: false, error: { code: 'DISARMED' } })
})

test('a server restarted with another protocol: the loop exits 8 once with PROTOCOL_MISMATCH and does not re-run', async ({ cli, server, tmpRoot }) => {
  test.setTimeout(60_000)
  const { loop } = await armAndStart(cli, tmpRoot)
  const t0 = Date.now()
  await server.restart({ env: { ...ENV, MDR_TEST_PROTOCOL: '3' } })
  const out = await loop.exit(15_000)
  expect(out.code).toBe(8)
  expect(out.lines, 'one line: no re-run, no repeated output').toHaveLength(1)
  expect(out.json).toMatchObject({ ok: false, error: { code: 'PROTOCOL_MISMATCH', hint: `mdr serve ${tmpRoot.root} --restart` } })
  expect(Date.now() - t0, 'exit 8 is never retried (no 5 s sleep, no wait re-run)').toBeLessThan(5_000)
  // the skill's next `mdr arm` fails too, so it starts no new loop (§9.9)
  const arm = await cli.run(['arm', cli.abs(FILE)])
  expect(arm.code).toBe(8)
  expect(arm.json).toMatchObject({ ok: false, error: { code: 'PROTOCOL_MISMATCH' } })
})

test('mdr arm with no loop started: grace, then none after WAITER_GRACE_MS', async ({ cli, webClient }) => {
  test.setTimeout(60_000)
  const t0 = Date.now()
  const arm = ok<ArmResult>(await cli.run(['arm', cli.abs(FILE)]))
  expect(arm).toMatchObject({ attached: false, presence: { waiter: 'grace' } })
  const graceUntil = Date.parse(arm.presence.graceUntil!)
  expect(graceUntil - t0).toBeGreaterThan(CONSTANTS.WAITER_GRACE_MS - 2_000)
  expect(graceUntil - t0).toBeLessThanOrEqual(CONSTANTS.WAITER_GRACE_MS + 2_000)
  await sleep(CONSTANTS.WAITER_GRACE_MS - 3_000)
  expect((await presenceOf(webClient)).waiter).toBe('grace')
  await waitPresence(webClient, (p) => p.waiter === 'none', { timeoutMs: 8_000, what: 'none' })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(CONSTANTS.WAITER_GRACE_MS - 1_000)
  // a click now copies a prompt (nothing would deliver it)
  expect((await webClient.handoff()).delivery).toBe('clipboard')
})

test('after a delivering exit, no agent request for TURN_IDLE_MS: turn lapses to none; a control request keeps it alive', async ({ cli, webClient, tmpRoot }) => {
  test.setTimeout(60_000)
  const { loop } = await armAndStart(cli, tmpRoot)
  await webClient.handoff('wake')
  woke(await loop.exit(15_000))
  const turnAt = Date.now()
  await waitPresence(webClient, (p) => p.waiter === 'turn', { what: 'turn' })
  // a control request (status) inside the window keeps the turn alive past TURN_IDLE_MS from the delivery
  await sleep(TURN_IDLE_MS - 600)
  const st = ok<StatusResult>(await cli.run(['status', cli.abs(FILE)]))
  expect(st.presence.waiter).toBe('turn')
  const keptAt = Date.now()
  while (Date.now() < turnAt + TURN_IDLE_MS + 200) await sleep(50)
  expect((await presenceOf(webClient)).waiter, 'still turn: the status request reset the idle timer').toBe('turn')
  // then nothing: none after TURN_IDLE_MS from the last agent request (browser reads don't count)
  await waitPresence(webClient, (p) => p.waiter === 'none', { timeoutMs: TURN_IDLE_MS + 3_000, what: 'none' })
  expect(Date.now() - keptAt).toBeGreaterThanOrEqual(TURN_IDLE_MS - 300)
  expect((await webClient.handoff('nobody is coming')).delivery).toBe('clipboard')
})
