// tests/e2e/int-handoff-latch.spec.ts (integrator, M4; CONTRACTS §2.5 "int-handoff-latch", §8.5 steps 3–6 and the
// presence states, §8.7, §9.7 "Latch", §9.8.2, §12.10, D46, D48; Appendix B row "a server restart doesn't lose a click").
//
// TJ clicks Send in the real page at the two moments no waiter stream is open, against the real built server and the
// real waiter loop (MDR_TEST_WAIT_TIMEOUT_S=3, so the loop re-arms every 3 s):
// (a) during a server restart: the loop is held (SIGSTOP on its process group) so its `wait` can't reconnect before
//     the click lands; the page reconnects to the new server on its own and sees restart grace; the click is latched
//     ("Queued for Claude…", nothing copied, the badge says Queued); released, the loop gets it and exits 0;
// (b) during the loop's re-arm gap: between one `wait` exiting 2 and the next connecting. The gap is milliseconds
//     wide, so the spec holds it open the same way: it watches the browser channel for the loop's `grace`, stops the
//     loop's process group at once, and checks on the server that no new stream got in first (else it lets the loop
//     run and tries the next gap). The click is latched; released, the next `wait` delivers it with round 2;
// (c) during Claude's turn (presence `turn`, no loop running, §9.8.2): latched, and the loop the skill starts at the
//     end of the turn gets it on connect.
// Between rounds Claude does what the skill does after a wake (`pending`, then an acking `batch`), so each click is a
// new round rather than coalesced into the one just delivered (§8.5 step 2). Every click stays a durable
// handoff.sent line with delivery `latched`, consumed by the waiter that delivered it.
import type { Page } from '@playwright/test'
import type { ArmResult, BatchResult, PendingResult, StatusResult, WaitResult } from '../../shared/types'
import { buildWakePrompt } from '../../shared/handoff-prompt'
import { badgeOf, INT_PORT_OFFSET, pageWaiter, signalGroup, tid, toastOf } from '../helpers/int'
import { openEditor } from '../helpers/openEditor'
import type { WebClient } from '../helpers/webClient'
import { expect, test, type CliHelper } from './fixtures'
import { clipWrites, installClipboard } from './fixtures/p3'
import { killLoops, ok, recordEvents, startLoop, type Loop } from './fixtures/p4'

const FILE = 'basic.md'
const ENV = { MDR_TEST_WAIT_TIMEOUT_S: '3', MDR_TEST_HEARTBEAT_MS: '50', MDR_TEST_WATCHDOG_MS: '300' }

test.use({ serverKind: 'real', fixtureFiles: [FILE], docFile: FILE, portOffset: INT_PORT_OFFSET, serverEnv: ENV })
test.afterEach(killLoops)

type Woke = Extract<WaitResult, { status: 'handoff' }>
type Line = { type?: string; seq: number; delivery?: string; handoffs?: number[]; via?: string; by?: string }

function delivered(out: Awaited<Loop['exited']>): Woke {
  expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0)
  expect(out.lines).toHaveLength(1)
  const w = out.json as Woke
  expect(w.status).toBe('handoff')
  expect(w.prompt).toBe(buildWakePrompt(w.payload))
  return w
}

/** The newest handoff.sent line's seq (the click the page just made). */
function lastSentSeq(lines: Line[]): number {
  const sent = lines.filter((l) => l.type === 'handoff.sent')
  expect(sent.length).toBeGreaterThan(0)
  return sent.at(-1)!.seq
}

let note = 0
/**
 * Click Send and expect the latched outcome: the toast, nothing copied, the badge's Queued row. Each click is a new round,
 * so the reviewer leaves a note first: Send on a doc with nothing new since Claude's ack says so and sends nothing (QA3).
 */
async function clickLatched(page: Page, wc: WebClient): Promise<void> {
  await wc.createThread({ kind: 'doc' }, `Round note ${++note}`)
  await page.locator(tid('send')).click()
  await expect(toastOf(page, 'HANDOFF_LATCHED')).toContainText('Claude is busy right now. It will see your changes when it finishes.')
  expect(await clipWrites(page)).toEqual([])
  await expect(badgeOf(page)).toHaveAttribute('data-state', 'waiting-pickup')
  await expect(badgeOf(page)).toHaveText('Queued for Claude')
}

/** What the skill does after a wake: read pending, then ack it in one batch (a content request and a Claude ack). */
async function claudeTurn(cli: CliHelper): Promise<void> {
  const p = ok<PendingResult>(await cli.run(['pending', cli.abs(FILE)]))
  ok<BatchResult>(await cli.batch(FILE, { ops: [], ack: p.cursor, ackSince: p.since }))
}

/**
 * Stop the loop inside one of its re-arm gaps: wait for the loop's `grace` on the browser channel, SIGSTOP its process
 * group, then confirm on the server (a browser route, never an agent request) that presence is still `grace`. If the
 * next `wait` connected first, let the loop run and try the next gap (one every MDR_TEST_WAIT_TIMEOUT_S).
 */
async function holdInGap(wc: WebClient, loop: Loop, waiterId: string): Promise<void> {
  const log = await recordEvents(wc)
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const from = log.mark()
      await log.next('presence', { from, where: (e) => e.data.waiter === 'grace' && e.data.waiterId === waiterId, timeoutMs: 10_000 })
      signalGroup(loop.child.pid!, 'SIGSTOP')
      await new Promise((r) => setTimeout(r, 250)) // a connect already on the wire lands meanwhile
      if ((await wc.review()).presence.waiter === 'grace') return
      signalGroup(loop.child.pid!, 'SIGCONT')
    }
    throw new Error('never caught the loop between two waits')
  } finally {
    void log.close()
  }
}

test('Send clicked during a server restart, in the loop\'s re-arm gap and during Claude\'s turn: each latched, each delivered', async ({ page, cli, server, webClient, tmpRoot }) => {
  test.setTimeout(150_000)
  const abs = cli.abs(FILE)
  await installClipboard(page)
  await page.setViewportSize({ width: 1440, height: 900 })

  // the loop attaches; the page sees it
  const arm = ok<ArmResult>(await cli.run(['arm', abs]))
  const loop = startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
  expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
  await openEditor(page, { port: server.port, file: FILE })
  await expect(page.locator(tid('send'))).toBeVisible()
  await expect.poll(() => pageWaiter(page)).toBe('connected')

  // (a) during a server restart: hold the loop, restart, the page reconnects (restart grace), click, release
  signalGroup(loop.child.pid!, 'SIGSTOP')
  let seqA: number
  try {
    await server.restart({ env: ENV })
    await expect.poll(() => pageWaiter(page), { timeout: 15_000, message: 'the page reconnects and sees restart grace' }).toBe('grace')
    expect((await webClient.review()).presence.waiter).toBe('grace')
    await clickLatched(page, webClient)
    seqA = lastSentSeq(tmpRoot.readSidecar(FILE) as Line[])
  } finally {
    signalGroup(loop.child.pid!, 'SIGCONT')
  }
  const wA = delivered(await loop.exit(20_000))
  expect(wA.payload).toMatchObject({ waiter: arm.waiter!.waiter, round: 1, handoffs: [{ seq: seqA, message: null }] })
  await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
  await claudeTurn(cli)

  // (b) during the loop's re-arm gap: a new loop; catch it between two waits; click; release
  const arm2 = ok<ArmResult>(await cli.run(['arm', abs]))
  const loop2 = startLoop(arm2.waiter!, { home: tmpRoot.home, env: ENV })
  expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
  await expect.poll(() => pageWaiter(page)).toBe('connected')
  let seqB: number
  await holdInGap(webClient, loop2, arm2.waiter!.waiter)
  try {
    await expect.poll(() => pageWaiter(page), { timeout: 5_000 }).toBe('grace')
    await clickLatched(page, webClient)
    seqB = lastSentSeq(tmpRoot.readSidecar(FILE) as Line[])
    expect(seqB).toBeGreaterThan(seqA)
  } finally {
    signalGroup(loop2.child.pid!, 'SIGCONT')
  }
  const wB = delivered(await loop2.exit(15_000))
  expect(wB.payload).toMatchObject({ waiter: arm2.waiter!.waiter, round: 2, handoffs: [{ seq: seqB, message: null }] })
  await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')

  // (c) during Claude's turn: no loop runs (presence `turn`); Claude works; TJ clicks; the next loop gets it on connect
  await expect.poll(() => pageWaiter(page)).toBe('turn')
  await claudeTurn(cli)
  await clickLatched(page, webClient)
  const seqC = lastSentSeq(tmpRoot.readSidecar(FILE) as Line[])
  expect(seqC).toBeGreaterThan(seqB)
  const arm3 = ok<ArmResult>(await cli.run(['arm', abs]))
  const t0 = Date.now()
  const loop3 = startLoop(arm3.waiter!, { home: tmpRoot.home, env: ENV })
  const wC = delivered(await loop3.exit(15_000))
  expect(Date.now() - t0, 'delivered on connect').toBeLessThan(5_000)
  expect(wC.payload).toMatchObject({ waiter: arm3.waiter!.waiter, round: 3, handoffs: [{ seq: seqC, message: null }] })

  // every click is a durable handoff.sent line, latched, consumed by the waiter that delivered it; nothing was copied
  const lines = tmpRoot.readSidecar(FILE) as Line[]
  expect(lines.filter((l) => l.type === 'handoff.sent').map((l) => [l.seq, l.delivery])).toEqual([[seqA, 'latched'], [seqB, 'latched'], [seqC, 'latched']])
  expect(lines.filter((l) => l.type === 'handoff.consumed').map((l) => [l.handoffs, l.via, l.by])).toEqual([[[seqA], 'waiter', 'Claude'], [[seqB], 'waiter', 'Claude'], [[seqC], 'waiter', 'Claude']])
  expect(await clipWrites(page)).toEqual([])
  await expect(page.locator(tid('toast', { 'data-code': 'HANDOFF_UNDELIVERED' }))).toHaveCount(0)
})
