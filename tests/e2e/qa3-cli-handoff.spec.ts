// tests/e2e/qa3-cli-handoff.spec.ts (QA round 3, cli-handoff). The reported behaviours on the real built server, the real
// CLI and the real page:
// - an empty `mdr pending` leaves the Claude badge idle (it used to read "Claude is working" for 15 minutes);
// - a pasted prompt (no waiter) followed by a long Claude turn never raises "Claude didn't pick this up";
// - a direct Claude edit raises "Claude changed 1 block." with View history, and the badge never says "Claude replied";
// - `mdr open` of another doc leaves a tab that is showing a different doc alone, and navigates an empty-state tab.
import type { Page } from '@playwright/test'
import type { OpenResult, PendingResult, StatusResult } from '../../shared/types'
import { badgeOf, tid, toastOf } from '../helpers/int'
import { openEditor } from '../helpers/openEditor'
import { expect, test, type CliHelper } from './fixtures'
import { clipWrites, installClipboard } from './fixtures/p3'
import { ok, sleep } from './fixtures/p4'

const A = 'qa3-a.md'
const B = 'qa3-b.md'
const DOC = '# QA3\n\nThe member rate is reviewed every quarter.\n\nA second paragraph for company.\n'

test.use({ serverKind: 'real', fixtureFiles: [], docFile: A })

const activityOf = async (cli: CliHelper, file: string): Promise<StatusResult['activity']> => ok<StatusResult>(await cli.run(['status', cli.abs(file)])).activity

test('an empty pending read leaves the badge idle, however long you watch', async ({ page, cli, server, tmpRoot }) => {
  tmpRoot.write(A, DOC)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openEditor(page, { port: server.port, file: A })
  await expect(badgeOf(page)).toHaveAttribute('data-state', 'idle')
  ok<OpenResult>(await cli.run(['open', cli.abs(A)]))
  const p = ok<PendingResult>(await cli.run(['pending', cli.abs(A)]))
  expect(p.empty).toBe(true)
  await sleep(2_500)
  await expect(badgeOf(page)).toHaveAttribute('data-state', 'idle')
  expect((await activityOf(cli, A))?.state).toBe('idle')
})

test.describe('a pasted prompt and a long turn', () => {
  test.use({ serverEnv: { MDR_TEST_UNDELIVERED_MS: '1200' } })
  test('Claude reads pending, keeps working, acks late: never "Claude didn’t pick this up"', async ({ page, cli, server, tmpRoot, webClient }) => {
    tmpRoot.write(A, DOC)
    await installClipboard(page)
    await openEditor(page, { port: server.port, file: A })
    await webClient.createThread({ kind: 'doc' }, 'Which quarter exactly?')
    await page.locator(tid('send')).click()
    await expect(toastOf(page, 'HANDOFF_COPIED')).toBeVisible()
    expect(await clipWrites(page)).toHaveLength(1)
    // the paste: Claude reads pending (+ a content request every second), and acks only at the end of a long turn
    const p = ok<PendingResult>(await cli.run(['pending', cli.abs(A)]))
    expect(p.handoffs).toHaveLength(1)
    for (let i = 0; i < 5; i++) {
      await sleep(1_000)
      ok(await cli.run(['snapshot', cli.abs(A)]))
    }
    await expect(toastOf(page, 'HANDOFF_UNDELIVERED')).toHaveCount(0)
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
    ok(await cli.batch(A, { ops: [], ack: p.cursor, ackSince: p.since }))
    await expect(badgeOf(page)).toHaveAttribute('data-state', 'idle')
  })
})

test('a direct Claude edit: "Claude changed 1 block." with View history, and no "Claude replied"', async ({ page, cli, server, tmpRoot }) => {
  tmpRoot.write(A, DOC)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openEditor(page, { port: server.port, file: A })
  const snap = ok<{ rev: number }>(await cli.run(['snapshot', cli.abs(A)]))
  ok(await cli.run(['edit-block', cli.abs(A), '--quote', 'The member rate is reviewed every quarter.', '--base-rev', String(snap.rev), '--md', 'The member rate is reviewed monthly.']))
  const t = toastOf(page, 'CLAUDE_EDITED')
  await expect(t).toContainText('Claude changed 1 block.')
  await expect(page.locator('.ProseMirror')).toContainText('reviewed monthly')
  await expect(badgeOf(page)).not.toHaveAttribute('data-state', 'replied')
  await t.getByRole('button', { name: 'View history' }).click()
  await expect(page.locator(tid('historyPanel'))).toBeVisible()
})

const urlOf = (page: Page): string => new URL(page.url()).searchParams.get('file') ?? ''

test('mdr open of another doc leaves a tab on a different doc alone, and takes over an empty-state tab', async ({ page, context, cli, server, tmpRoot }) => {
  tmpRoot.write(A, DOC)
  tmpRoot.write(B, DOC)
  tmpRoot.write('qa3-c.md', DOC)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openEditor(page, { port: server.port, file: A })
  const second = await context.newPage()
  await openEditor(second, { port: server.port, file: B })
  await sleep(800)
  // a third chat opens a third doc: neither tab moves
  const r = ok<OpenResult>(await cli.run(['open', cli.abs('qa3-c.md')]))
  expect(r).toMatchObject({ connectedTabs: 2, navigated: false })
  await sleep(1_500)
  expect([urlOf(page), urlOf(second)]).toEqual([A, B])
  // an empty-state tab (no ?file=) is the idle one: it gets the doc
  const idle = await context.newPage()
  await idle.goto(`http://127.0.0.1:${server.port}/`)
  await expect(idle.locator(tid('emptyState'))).toBeVisible()
  await sleep(800)
  const r2 = ok<OpenResult>(await cli.run(['open', cli.abs('qa3-c.md')]))
  expect(r2).toMatchObject({ connectedTabs: 3, navigated: true })
  await expect.poll(() => urlOf(idle)).toBe('qa3-c.md')
  expect([urlOf(page), urlOf(second)]).toEqual([A, B])
})
