// tests/e2e/t2-cli-badge.spec.ts (fix pass T2 cli; QA_FINDINGS Pass 4 #14 and #15). The real built server, the real CLI,
// the real waiter loop and the real page:
// - #14: a turn that only read the doc, edited it directly or sent a failed batch left "Claude is working" up for
//   ACTIVITY_IDLE_MS (15 min) even with the waiter connected. The skill ends every turn with `mdr arm`, which now ends it;
// - #15: a Send queued while an arm announced a loop that never came said "Queued for Claude" forever, and a second click
//   said "copied" while the badge still said Queued. When the grace lapses the badge is the paste row, and both agree.
import type { Page } from '@playwright/test'
import type { ArmResult, StatusResult, WaitResult } from '../../shared/types'
import { badgeOf, pageWaiter, tid, toastOf } from '../helpers/int'
import { openEditor } from '../helpers/openEditor'
import { expect, test, type CliHelper } from './fixtures'
import { clipWrites, installClipboard } from './fixtures/p3'
import { killLoops, ok, sleep, startLoop } from './fixtures/p4'

const FILE = 'badge.md'
const DOC = '# Badge\n\nThe member rate is reviewed every quarter.\n\nA second paragraph for company.\n'
const ENV = { MDR_TEST_WAIT_TIMEOUT_S: '30', MDR_TEST_HEARTBEAT_MS: '100', MDR_TEST_WATCHDOG_MS: '2000' }

test.use({ serverKind: 'real', fixtureFiles: [], docFile: FILE, serverEnv: ENV })
test.afterEach(killLoops)

const activityOf = async (cli: CliHelper): Promise<StatusResult['activity']> => ok<StatusResult>(await cli.run(['status', cli.abs(FILE)])).activity
const state = (page: Page) => badgeOf(page).getAttribute('data-state')

test.describe('#14: the badge settles when Claude ends a turn that left no ack', () => {
  test('read-only, direct-edit and failed-batch turns: working while Claude is in it, idle once the skill ends the turn with `mdr arm`', async ({ page, cli, server, tmpRoot }) => {
    test.setTimeout(180_000)
    tmpRoot.write(FILE, DOC)
    const abs = cli.abs(FILE)
    await page.setViewportSize({ width: 1440, height: 900 })
    // the review is open and Claude's loop is connected (the skill's state between turns)
    const arm = ok<ArmResult>(await cli.run(['arm', abs]))
    startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
    expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
    await openEditor(page, { port: server.port, file: FILE })
    await expect.poll(() => pageWaiter(page)).toBe('connected')
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'idle')

    // 1. a turn that only reads the doc to answer a chat question
    ok(await cli.run(['snapshot', abs, '--md']))
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
    await expect(badgeOf(page)).toHaveText('Claude is working')
    await sleep(1_500) // nothing else clears it while Claude is still in the turn
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
    ok<ArmResult>(await cli.run(['arm', abs])) // the skill's first end-of-turn step
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'idle')
    expect((await activityOf(cli))?.state).toBe('idle')

    // 2. a turn that only edits directly, with no ack
    const snap = ok<{ rev: number }>(await cli.run(['snapshot', abs]))
    ok(await cli.run(['edit-block', abs, '--quote', 'The member rate is reviewed every quarter.', '--base-rev', String(snap.rev), '--md', 'The member rate is reviewed monthly.']))
    await expect(page.locator('.ProseMirror')).toContainText('reviewed monthly')
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
    ok<ArmResult>(await cli.run(['arm', abs]))
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'idle')

    // 3. a batch that fails (QUOTE_NOT_FOUND): the request still counted as Claude working
    const bad = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'a sentence that is not in the document', body: 'x' }] })
    expect(bad.code).not.toBe(0)
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
    ok<ArmResult>(await cli.run(['arm', abs]))
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'idle')

    // and the loop never left
    expect(ok<StatusResult>(await cli.run(['status', abs])).presence.waiter).toBe('connected')
  })

  test('the loop starting at the end of a turn settles it too (a connect, no arm needed)', async ({ page, cli, server, tmpRoot }) => {
    test.setTimeout(120_000)
    tmpRoot.write(FILE, DOC)
    const abs = cli.abs(FILE)
    await openEditor(page, { port: server.port, file: FILE })
    // the spec Claude prints at the end of one turn is started at the end of the next
    const arm = ok<ArmResult>(await cli.run(['arm', abs]))
    ok(await cli.run(['snapshot', abs, '--md']))
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
    startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'idle')
    expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
    // a content request after that is working again
    ok(await cli.run(['snapshot', abs, '--md']))
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
  })
})

test.describe('#15: a Send queued for a loop that never comes', () => {
  test.use({ serverEnv: { ...ENV, MDR_TEST_GRACE_MS: '6000' } })

  test('the grace lapses: the badge turns into the paste row with Copy message, a reload agrees, and the second click says the same', async ({ page, cli, server, tmpRoot, webClient }) => {
    test.setTimeout(120_000)
    tmpRoot.write(FILE, DOC)
    const abs = cli.abs(FILE)
    await installClipboard(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openEditor(page, { port: server.port, file: FILE })
    await expect.poll(() => pageWaiter(page)).toBe('none')

    // `mdr arm` announces a loop (grace), but no loop is ever started (the skill's "arm failed" branch, or a lost background task)
    ok<ArmResult>(await cli.run(['arm', abs]))
    await expect.poll(() => pageWaiter(page)).toBe('grace')
    await webClient.createThread({ kind: 'doc' }, 'A note for Claude.')
    await page.locator(tid('send')).click()
    await expect(toastOf(page, 'HANDOFF_LATCHED')).toContainText('Claude is busy right now. It will see your changes when it finishes.')
    await expect(badgeOf(page)).toHaveText('Queued for Claude')
    expect(await clipWrites(page)).toEqual([])

    // the grace lapses with no loop
    await expect.poll(() => pageWaiter(page), { timeout: 30_000 }).toBe('none')
    await expect(badgeOf(page)).toContainText('Waiting for you to paste it into Claude')
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'waiting-pickup')
    const copyBtn = badgeOf(page).locator(tid('badgeAction', { 'data-action': 'copy-prompt' }))
    await expect(copyBtn).toHaveText('Copy message')
    const st = ok<StatusResult>(await cli.run(['status', abs]))
    expect(st.presence.waiter).toBe('none')
    expect(st.activity).toMatchObject({ state: 'waiting-pickup', delivery: 'clipboard' })
    expect(st.handoff.undelivered).toHaveLength(1)

    // a reload shows the same row, not "Queued" again
    await page.reload()
    await expect(page.locator(tid('send'))).toBeVisible()
    await expect(badgeOf(page)).toContainText('Waiting for you to paste it into Claude')

    // the second click copies (nobody is listening) and the badge agrees with the toast
    await page.locator(tid('send')).click()
    await expect(toastOf(page, 'HANDOFF_COPIED')).toContainText('Claude isn’t listening. Message copied: paste it into your Claude conversation.')
    const writes = await clipWrites(page)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(FILE)
    await expect(badgeOf(page)).toContainText('Waiting for you to paste it into Claude')
    await expect(badgeOf(page)).not.toContainText('Queued')

    // and a loop that does start picks the handoff up: nothing was lost
    const arm = ok<ArmResult>(await cli.run(['arm', abs]))
    const loop = startLoop(arm.waiter!, { home: tmpRoot.home, env: ENV })
    const out = await loop.exit(15_000)
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect((out.json as Extract<WaitResult, { status: 'handoff' }>).status).toBe('handoff')
    expect((out.json as Extract<WaitResult, { status: 'handoff' }>).payload.handoffs).toHaveLength(1)
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
  })
})
