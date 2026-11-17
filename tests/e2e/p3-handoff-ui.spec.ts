// tests/e2e/p3-handoff-ui.spec.ts (P3; CONTRACTS §8.5 badge table, §12.10, §14 P3 E2E "p3-handoff-ui").
//
// Send to Claude in a real browser. Two halves:
// - Against startFakeServer and the handoffStub test routes (§2.5): every toast (waiter, latched, clipboard-copied,
//   clipboard-refused modal, mismatch, undelivered, server-unreachable) and the full badge table (waiting-pickup for
//   each delivery, working, replied, idle). The real server never mounts /__test/presence, /__test/activity,
//   /__test/delivery or /__test/handoff-state, and two states can't be produced on it on demand: a mismatch needs the
//   page's presence to lag the server's, and `undelivered` waits HANDOFF_UNDELIVERED_MS (60 s).
// - Against the real built server and P4's handoff module (skipped on the fake page build): a live waiter loop
//   (sent), `mdr arm` with no loop (latched), no waiter (copied, and the refused-clipboard modal), the server stopped
//   (offline), and the badge driven by Claude's real requests: waiting-pickup → working (a content request) →
//   replied (a Claude comment) → idle (TJ's read marker from "Claude replied").
// The clipboard is a recording stub installed before load, so each case asserts exactly what was copied and when.
import type { Page } from '@playwright/test'
import { TEST_ACTIONS } from '../../shared/constants'
import type { ArmResult, StatusResult } from '../../shared/types'
import { openEditor } from '../helpers/openEditor'
import { webClient as makeWebClient } from '../helpers/webClient'
import { expect, test } from './fixtures'
import { clipWrites, installClipboard, P3_SERVER_KIND, railDoc, sel, setClipRefuse } from './fixtures/p3'
import { killLoops, ok, startLoop } from './fixtures/p4'

const FILE = 'handoff.md'
test.use({ serverKind: 'fake', fixtureFiles: [], docFile: FILE })
test.afterEach(killLoops)

const DOC = '# Handoff check\n\nA paragraph TJ is reviewing.\n\nAnother paragraph after it.\n'

async function open(page: Page, port: number): Promise<void> {
  await installClipboard(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openEditor(page, { port, file: FILE, wait: 'editor' })
  await expect(page.locator(sel('send'))).toBeVisible()
}

const toast = (page: Page, code: string) => page.locator(sel('toast', { 'data-code': code }))
const badge = (page: Page) => page.locator(sel('claudeBadge'))

test.describe('p3-handoff-ui: toasts (§12.10)', () => {
  test.beforeEach(async ({ tmpRoot }) => {
    tmpRoot.write(FILE, DOC)
  })

  test('waiter connected: "Sent to Claude.", nothing copied, badge "Sent to Claude"', async ({ page, server }) => {
    await server.fake!.setPresence(FILE, { waiter: 'connected' })
    await open(page, server.port)
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_SENT')).toContainText('Sent to Claude.')
    expect(await clipWrites(page)).toEqual([])
    await expect(badge(page)).toHaveAttribute('data-state', 'waiting-pickup')
    await expect(badge(page)).toHaveText('Sent to Claude')
  })

  test('grace: latched, nothing copied, badge "Queued…"', async ({ page, server }) => {
    await server.fake!.setPresence(FILE, { waiter: 'grace', graceUntil: new Date(Date.now() + 20_000).toISOString() })
    await open(page, server.port)
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_LATCHED')).toContainText('Claude is busy right now. It will see your changes when it finishes.')
    expect(await clipWrites(page)).toEqual([])
    await expect(badge(page)).toHaveText('Queued for Claude')
  })

  test('no waiter: the prompt is copied inside the click; toast says so; badge waits for the paste', async ({ page, server }) => {
    await server.fake!.setPresence(FILE, { waiter: 'none' })
    await open(page, server.port)
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_COPIED')).toContainText('Claude isn’t listening. Message copied: paste it into your Claude conversation.')
    const writes = await clipWrites(page)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(FILE)
    await expect(badge(page)).toContainText('Waiting for you to paste it into Claude')
    // the badge's Copy message copies again, in its own click
    await badge(page).locator(sel('badgeAction', { 'data-action': 'copy-prompt' })).click()
    await expect.poll(async () => (await clipWrites(page)).length).toBe(2)
  })

  test('clipboard refused: the modal shows the prompt selected, with no Copy button that would fail; Send again once the browser allows it copies', async ({ page, server }) => {
    await server.fake!.setPresence(FILE, { waiter: 'none' })
    await open(page, server.port)
    await setClipRefuse(page, true)
    await page.locator(sel('send')).click()
    const modal = page.locator(sel('promptModal'))
    await expect(modal).toBeVisible()
    await expect(modal).toHaveAttribute('role', 'dialog')
    await expect(modal.locator('textarea')).toHaveValue(new RegExp(FILE.replace('.', '\\.')))
    await expect(page.locator(sel('toast'))).toHaveCount(0)
    // Pass 4 #29: the click's own write was refused, so the page knows a Copy would fail: the message is selected for the
    // person's own copy and there is no button to click
    await expect(modal).toHaveAttribute('data-copy', 'manual')
    await expect(modal.locator('textarea')).toBeFocused()
    await expect(modal.locator('.mdr-modal-text')).toContainText(/press (Cmd|Ctrl)\+C,/)
    await expect(modal.locator(sel('toastAction'))).toHaveCount(0)
    expect(TEST_ACTIONS.toastAction).toContain('copy-prompt')
    await modal.getByRole('button', { name: 'Close' }).click()
    await expect(modal).toHaveCount(0)
    // the browser allows copying again: the next Send copies in its click, as it always did
    await setClipRefuse(page, false)
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_COPIED')).toContainText('Message copied')
    await expect(modal).toHaveCount(0)
    expect((await clipWrites(page)).at(-1)).toContain(FILE)
  })

  test('mismatch: the waiter died since the last presence event; nothing copied; Copy message copies the server prompt', async ({ page, server }) => {
    await server.fake!.setPresence(FILE, { waiter: 'connected' })
    await server.fake!.forceDelivery('clipboard')
    await open(page, server.port)
    await page.locator(sel('send')).click()
    const t = toast(page, 'HANDOFF_MISMATCH')
    await expect(t).toContainText('Claude isn’t listening anymore. Copy this message and paste it into your Claude conversation.')
    await expect(t).not.toContainText(/copied/i)
    expect(await clipWrites(page)).toEqual([])
    await t.locator(sel('toastAction', { 'data-action': 'copy-prompt' })).click()
    const writes = await clipWrites(page)
    expect(writes).toHaveLength(1)
    // the server's prompt carries the round (§9.10); the in-gesture one never does
    expect(writes[0]).toContain(FILE)
    await expect(t).toContainText('Message copied: paste it into your Claude conversation.')
  })

  test('undelivered: "Claude didn’t pick this up" with Copy message', async ({ page, server }) => {
    await server.fake!.setPresence(FILE, { waiter: 'connected' })
    await open(page, server.port)
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_SENT')).toBeVisible()
    await server.fake!.emitHandoffState(FILE, 'undelivered')
    const t = toast(page, 'HANDOFF_UNDELIVERED')
    await expect(t).toContainText('Claude didn’t pick this up')
    await t.locator(sel('toastAction', { 'data-action': 'copy-prompt' })).click()
    expect((await clipWrites(page)).at(-1)).toContain(FILE)
  })

  test('server unreachable with nothing copied: says the edits aren’t saved, never "copied", offers Copy message', async ({ page, server }) => {
    await server.fake!.setPresence(FILE, { waiter: 'connected' })
    await open(page, server.port)
    await server.stop()
    await page.locator(sel('send')).click()
    const t = toast(page, 'HANDOFF_OFFLINE')
    await expect(t).toContainText('Lost connection to the review page. Reload to reconnect.')
    await expect(t.locator('.mdr-toast-text')).not.toContainText(/copied/i)
    await expect(t.locator(sel('toastAction', { 'data-action': 'copy-prompt' }))).toHaveText('Copy message')
    await t.locator(sel('toastAction', { 'data-action': 'copy-prompt' })).click()
    expect((await clipWrites(page)).at(-1)).toContain(FILE)
  })
})

test.describe('p3-handoff-ui: Claude badge (§8.5)', () => {
  test.beforeEach(async ({ tmpRoot }) => {
    tmpRoot.write(FILE, DOC)
  })

  test('working, replied (with the unread count), idle; a polite live region throughout', async ({ page, server }) => {
    await open(page, server.port)
    const b = badge(page)
    await expect(b).toHaveAttribute('role', 'status')
    await expect(b).toHaveAttribute('aria-live', 'polite')
    await expect(b).toHaveAttribute('data-state', 'idle')
    await expect(b).toHaveText('')
    const since = new Date().toISOString()
    for (const delivery of ['waiter', 'latched', 'clipboard'] as const) {
      await server.fake!.setActivity(FILE, { state: 'waiting-pickup', delivery, since, unreadFromClaude: 0 })
      await expect(b).toHaveAttribute('data-state', 'waiting-pickup')
      await expect(b).toContainText({ waiter: 'Sent to Claude', latched: 'Queued for Claude', clipboard: 'Waiting for you to paste it into Claude' }[delivery])
    }
    await server.fake!.setActivity(FILE, { state: 'working', since, unreadFromClaude: 0 })
    await expect(b).toHaveAttribute('data-state', 'working')
    await expect(b).toHaveText('Claude is working')
    await server.fake!.setActivity(FILE, { state: 'replied', since, unreadFromClaude: 3 })
    await expect(b).toHaveAttribute('data-state', 'replied')
    await expect(b.locator(sel('badgeAction', { 'data-action': 'show-unread' }))).toHaveAccessibleName('Claude replied 3 unread')
    await server.fake!.setActivity(FILE, { state: 'idle', since, unreadFromClaude: 0 })
    await expect(b).toHaveAttribute('data-state', 'idle')
    await expect(b).toHaveText('')
  })

  test('"Claude replied" activates the first unread card', async ({ page, server, cli }) => {
    const r = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'Another paragraph', body: 'A question from Claude.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    await open(page, server.port)
    await expect(page.locator(sel('card'))).toHaveCount(1)
    await server.fake!.setActivity(FILE, { state: 'replied', since: new Date().toISOString(), unreadFromClaude: 1 })
    await badge(page).locator(sel('badgeAction', { 'data-action': 'show-unread' })).click()
    await expect(page.locator(`${sel('card')}[data-active="true"]`)).toHaveCount(1)
    await expect(page.locator(`${sel('card')}[data-active="true"]`)).toContainText('A question from Claude.')
  })
})

// ---------------------------------------------------------------------------------------------- the real server

/** The waiter presence the page's session holds (what its clientDecision is computed from). */
const pageWaiter = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const d = (window as unknown as { __mdrDebug?: { session(): { getReview(): { presence?: { waiter: string } } } } }).__mdrDebug
    return d?.session().getReview().presence?.waiter ?? null
  })

test.describe('p3-handoff-ui on the real server (P4 handoff module)', () => {
  test.skip(P3_SERVER_KIND === 'fake', 'the fake page build runs against startFakeServer (the blocks above)')
  test.use({ serverKind: 'real' })
  test.beforeEach(async ({ tmpRoot, server }) => {
    tmpRoot.write(FILE, DOC)
    // QA3: Send hands over what is new since Claude's last ack; an untouched doc answers "Nothing new to send yet", so
    // the reviewer has left a note before every click below
    const wc = await makeWebClient({ port: server.port, root: server.root, file: FILE, token: server.token })
    try {
      await wc.createThread({ kind: 'doc' }, 'A note for Claude.')
    } finally {
      await wc.close()
    }
  })

  test('nothing new since Claude\'s last ack: Send says so, copies nothing it claims, and wakes nobody', async ({ page, server, cli }) => {
    const abs = cli.abs(FILE)
    // Claude has read and acked the reviewer's note: nothing is new
    const p = ok<{ cursor: number; since: number }>(await cli.run(['pending', abs]))
    ok(await cli.batch(FILE, { ops: [], ack: p.cursor, ackSince: p.since }))
    await open(page, server.port)
    await expect.poll(() => pageWaiter(page)).toBe('none')
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_NOTHING_NEW')).toContainText('Nothing new to send yet. Add a comment or edit first.')
    await expect(toast(page, 'HANDOFF_COPIED')).toHaveCount(0)
    await expect(page.locator(sel('promptModal'))).toHaveCount(0)
    await expect(badge(page)).toHaveAttribute('data-state', 'idle')
    expect(ok<StatusResult>(await cli.run(['status', abs])).handoff.undelivered).toEqual([])
  })

  test('a live waiter loop: "Sent to Claude.", nothing copied, badge "Sent to Claude"; the loop wakes with the click', async ({ page, server, cli, tmpRoot }) => {
    const abs = cli.abs(FILE)
    const arm = ok<ArmResult>(await cli.run(['arm', abs]))
    const loop = startLoop(arm.waiter!, { home: tmpRoot.home })
    expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
    await open(page, server.port)
    await expect.poll(() => pageWaiter(page)).toBe('connected')
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_SENT')).toContainText('Sent to Claude.')
    expect(await clipWrites(page)).toEqual([])
    const out = await loop.exit(15_000)
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect((out.json as { status: string }).status).toBe('handoff')
    // the loop picked it up (handoff.consumed): Claude is working
    await expect(badge(page)).toHaveAttribute('data-state', 'working')
    await expect(badge(page)).toHaveText('Claude is working')
  })

  test('mdr arm with no loop yet (grace): latched, nothing copied, badge "Queued…"', async ({ page, server, cli }) => {
    ok<ArmResult>(await cli.run(['arm', cli.abs(FILE)]))
    await open(page, server.port)
    await expect.poll(() => pageWaiter(page)).toBe('grace')
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_LATCHED')).toContainText('Claude is busy right now. It will see your changes when it finishes.')
    expect(await clipWrites(page)).toEqual([])
    await expect(badge(page)).toHaveAttribute('data-state', 'waiting-pickup')
    await expect(badge(page)).toHaveText('Queued for Claude')
  })

  test('no waiter: the prompt is copied inside the click; the badge waits for the paste', async ({ page, server }) => {
    await open(page, server.port)
    await expect.poll(() => pageWaiter(page)).toBe('none')
    await page.locator(sel('send')).click()
    await expect(toast(page, 'HANDOFF_COPIED')).toContainText('Claude isn’t listening. Message copied: paste it into your Claude conversation.')
    const writes = await clipWrites(page)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(FILE)
    await expect(badge(page)).toHaveAttribute('data-state', 'waiting-pickup')
    await expect(badge(page)).toContainText('Waiting for you to paste it into Claude')
  })

  test('no waiter and the clipboard refused: the modal shows the prompt selected, with no Copy button; Send again once the browser allows it copies', async ({ page, server }) => {
    await open(page, server.port)
    await expect.poll(() => pageWaiter(page)).toBe('none')
    await setClipRefuse(page, true)
    await page.locator(sel('send')).click()
    const modal = page.locator(sel('promptModal'))
    await expect(modal).toBeVisible()
    await expect(modal.locator('textarea')).toHaveValue(new RegExp(FILE.replace('.', '\\.')))
    await expect(modal).toHaveAttribute('data-copy', 'manual')
    await expect(modal.locator('textarea')).toBeFocused()
    await expect(modal.locator(sel('toastAction'))).toHaveCount(0)
    await modal.getByRole('button', { name: 'Close' }).click()
    await setClipRefuse(page, false)
    await page.locator(sel('send')).click()
    await expect(modal).toHaveCount(0)
    expect((await clipWrites(page)).at(-1)).toContain(FILE)
    await expect(toast(page, 'HANDOFF_COPIED')).toContainText('Message copied')
  })

  // Integrator, P3 merge: the real-server counterpart of the fake "undelivered" case. The prompt was copied and never
  // pasted, so nothing consumes the handoff while presence is `none`; MDR_TEST_UNDELIVERED_MS (test hooks only)
  // shortens HANDOFF_UNDELIVERED_MS so P4's timer fires inside the test.
  test.describe('undelivered', () => {
    test.use({ serverEnv: { MDR_TEST_UNDELIVERED_MS: '1500' } })
    test('no waiter, the prompt copied and never pasted: "Claude didn’t pick this up" with Copy message', async ({ page, server }) => {
      await open(page, server.port)
      await expect.poll(() => pageWaiter(page)).toBe('none')
      await page.locator(sel('send')).click()
      await expect(toast(page, 'HANDOFF_COPIED')).toBeVisible()
      expect(await clipWrites(page)).toHaveLength(1)
      const t = toast(page, 'HANDOFF_UNDELIVERED')
      await expect(t).toContainText('Claude didn’t pick this up', { timeout: 10_000 })
      await t.locator(sel('toastAction', { 'data-action': 'copy-prompt' })).click()
      const writes = await clipWrites(page)
      expect(writes).toHaveLength(2)
      expect(writes[1]).toContain(FILE)
    })
  })

  test('the server stopped while a waiter was connected: offline toast, never "copied", Copy message works', async ({ page, server, cli, tmpRoot }) => {
    const abs = cli.abs(FILE)
    const arm = ok<ArmResult>(await cli.run(['arm', abs]))
    startLoop(arm.waiter!, { home: tmpRoot.home })
    expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence.waiter).toBe('connected')
    await open(page, server.port)
    await expect.poll(() => pageWaiter(page)).toBe('connected')
    await server.stop()
    await page.locator(sel('send')).click()
    const t = toast(page, 'HANDOFF_OFFLINE')
    await expect(t).toContainText('Lost connection to the review page. Reload to reconnect.')
    await expect(t.locator('.mdr-toast-text')).not.toContainText(/copied/i)
    expect(await clipWrites(page)).toEqual([])
    await t.locator(sel('toastAction', { 'data-action': 'copy-prompt' })).click()
    expect((await clipWrites(page)).at(-1)).toContain(FILE)
  })

  // Integrator, P3 merge: §12.10 step 6's first clause on the real stack. P2's session now puts `copied` on the
  // rejection, so the in-gesture copy is reported and no Copy message button is offered for a prompt already copied.
  test('the server stopped with no waiter: the prompt was copied in the click; offline toast says so, no Copy message', async ({ page, server }) => {
    await open(page, server.port)
    await expect.poll(() => pageWaiter(page)).toBe('none')
    await server.stop()
    await page.locator(sel('send')).click()
    const t = toast(page, 'HANDOFF_OFFLINE')
    await expect(t).toContainText('Lost connection to the review page. Reload to reconnect.')
    await expect(t.locator(sel('toastAction'))).toHaveCount(0)
    const writes = await clipWrites(page)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(FILE)
  })

  test('the badge follows Claude: waiting-pickup → working → replied → "Claude replied" opens the card → idle', async ({ page, server, cli, tmpRoot }) => {
    // Claude's comment lands below the fold, so no dwell marks it read before the badge is used
    tmpRoot.write(FILE, railDoc(40))
    const abs = cli.abs(FILE)
    await open(page, server.port)
    const b = badge(page)
    await expect(b).toHaveAttribute('data-state', 'idle')
    await page.locator(sel('send')).click()
    await expect(b).toHaveAttribute('data-state', 'waiting-pickup')
    await expect(b).toContainText('Waiting for you to paste it into Claude')
    // TJ pasted the prompt: Claude reads what's pending (a content request)
    ok(await cli.run(['pending', abs]))
    await expect(b).toHaveAttribute('data-state', 'working')
    await expect(b).toHaveText('Claude is working')
    const r = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'marker38x', body: 'A question from Claude, far down.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    await expect(b).toHaveAttribute('data-state', 'replied')
    await expect(b.locator(sel('badgeAction', { 'data-action': 'show-unread' }))).toHaveAccessibleName('Claude replied 1 unread')
    await b.locator(sel('badgeAction', { 'data-action': 'show-unread' })).click()
    const active = page.locator(`${sel('card')}[data-active="true"]`)
    await expect(active).toHaveCount(1)
    await expect(active).toContainText('A question from Claude, far down.')
    // activation marks the thread read (§12.9): TJ's read marker covers Claude's comment
    await expect(b).toHaveAttribute('data-state', 'idle')
    await expect(b).toHaveText('')
  })
})
