// tests/e2e/int-claude-loop.spec.ts (integrator, M4; CONTRACTS §2.5 "int-claude-loop", §8.5, §9.6–§9.9, §12.10,
// Appendix B rows "pending exact", "suggest renders inline + card; TJ reply in pending", "Send with waiter wakes").
//
// The p4-claude-loop round, with TJ in the real page instead of webClient: `mdr open` → the waiter loop (the
// WaiterSpec line under bash, as the skill's Bash run_in_background runs it) → Claude comments and suggests in one
// `batch` → the page shows the comment's highlight and card and the suggestion inline (Claude's track change) with its
// reason card → TJ types a reply in the card and an edit in the editor (Editing mode, autosaved) → TJ clicks Send →
// "Sent to Claude.", nothing copied → the loop exits 0 with the payload and its wake prompt → `mdr pending` is exact
// → the badge says "Claude is working" → Claude replies and acks → the card shows the reply live and the badge says
// "Claude replied". Round 2: `mdr arm` and a new loop; TJ accepts Claude's suggestion in its card and sends with
// Cmd+Enter from the editor; the new loop wakes with round 2 and `pending` reports the decision (not an edit). End of
// review: `mdr disarm`, presence drops to none, and Send falls back to copying the prompt.
import type { ArmResult, BatchResult, OpenResult, PendingResult, StatusResult, WaitResult } from '../../shared/types'
import { buildWakePrompt } from '../../shared/handoff-prompt'
import { openEditor } from '../helpers/openEditor'
import { badgeOf, cardOf, INT_PORT_OFFSET, pageWaiter, tid, toastOf } from '../helpers/int'
import { expect, test } from './fixtures'
import { MOD, placeCaret } from './fixtures/p2'
import { clipWrites, installClipboard, railSettled } from './fixtures/p3'
import { json, killLoops, ok, sleep, startLoop } from './fixtures/p4'

const FILE = 'basic.md'

test.use({ serverKind: 'real', fixtureFiles: [FILE], docFile: FILE, portOffset: INT_PORT_OFFSET })
test.afterEach(killLoops)

type Woke = Extract<WaitResult, { status: 'handoff' }>

test('open → loop → markup shown inline and in cards → TJ replies in a card, types an edit, clicks Send → the loop wakes → pending exact → round 2 by Cmd+Enter → disarm', async ({ page, cli, server, tmpRoot, webClient }) => {
  test.setTimeout(150_000)
  const abs = cli.abs(FILE)
  const url = `http://127.0.0.1:${server.port}/?file=${FILE}`

  // 1. open: serves (already up), arms, prints a spec; the loop attaches
  const open = ok<OpenResult>(await cli.run(['open', abs]))
  expect(open).toMatchObject({ via: 'server', file: FILE, abs, url, presence: { waiter: 'grace' } })
  const spec = open.waiter!
  const loop = startLoop(spec, { home: tmpRoot.home })
  expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence).toMatchObject({ waiter: 'connected', waiterId: spec.waiter })

  // 2. Claude marks up in one batch
  const mark = ok<BatchResult>(await cli.batch(FILE, { ops: [
    { op: 'comment', quote: 'member rate of 12%', body: 'Is 12% still current?' },
    { op: 'suggest', quote: 'We launch in Q3.', replace: 'We launch in Q3 2026.', reason: 'Name the year.' },
  ] }))
  expect(mark.results).toMatchObject([
    { i: 0, op: 'comment', anchor: { state: 'ok', quote: 'member rate of 12%' } },
    { i: 1, op: 'suggest', anchor: { state: 'ok' }, hunks: [{ del: '', ins: ' 2026' }] },
  ])
  const thread = mark.results[0]!.thread!
  const sugThread = mark.results[1]!.thread!
  const sug = mark.results[1]!.suggestion!
  const disk0 = tmpRoot.read(FILE)
  expect(disk0, 'a pending suggestion never reaches the .md').not.toContain('2026')

  // 3. TJ opens the page: the full shell over the real editor
  await installClipboard(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const ed = await openEditor(page, { port: server.port, file: FILE })
  await railSettled(page)
  // the comment: highlight on its quote, card with Claude's message
  await expect(ed.testid('highlight', { 'data-thread': thread }).first()).toBeVisible()
  await expect(ed.testid('highlight', { 'data-thread': thread })).toHaveText(['member rate of 12%'])
  const card = cardOf(page, thread)
  await expect(card.locator(tid('message', { 'data-by': 'Claude' }))).toContainText('Is 12% still current?')
  // the suggestion: inline insert by Claude, plus its reason card with the pending row
  const ins = ed.testid('suggestion', { 'data-suggestion': sug, 'data-kind': 'ins' })
  await expect(ins.first()).toBeVisible()
  await expect(ins.first()).toHaveAttribute('data-by', 'Claude')
  await expect(ins).toHaveText([' 2026'])
  const sugCard = cardOf(page, sugThread)
  await expect(sugCard).toContainText('Name the year.')
  const row = sugCard.locator(tid('suggestionItem', { 'data-suggestion': sug }))
  await expect(row).toHaveAttribute('data-status', 'pending')
  await expect(page.locator(tid('acceptAllClaude'))).toHaveAttribute('aria-disabled', 'false')
  // the page knows the waiter is there, so Send will not copy anything
  await expect.poll(() => pageWaiter(page)).toBe('connected')

  // 4. TJ types a reply in the comment card (Cmd+Enter posts)
  await card.locator(tid('cardReply')).click()
  await expect(page.locator(`${tid('cardReply')}:focus`)).toHaveCount(1)
  await page.keyboard.type('Yes, as of the 10/1 brief.')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(card.locator(tid('message', { 'data-by': 'TJ' }))).toContainText('Yes, as of the 10/1 brief.')

  // 5. TJ types an edit in the editor, in Editing mode; autosave writes it
  await expect(ed.testid('modePill')).toHaveAttribute('data-mode', 'editing')
  await placeCaret(page, 'Grow the waitlist', 'end')
  await page.keyboard.type(' to 5,000')
  await expect.poll(() => tmpRoot.read(FILE), { timeout: 10_000 }).toBe(disk0.replace('- Grow the waitlist\n', '- Grow the waitlist to 5,000\n'))
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'saved')
  await sleep(300)
  expect(loop.done(), 'neither Claude\'s writes nor TJ\'s saves and replies wake the loop').toBe(false)

  // 6. Send to Claude: the connected waiter gets it; nothing is copied
  await page.locator(tid('send')).click()
  await expect(toastOf(page, 'HANDOFF_SENT')).toContainText('Sent to Claude.')
  expect(await clipWrites(page)).toEqual([])

  // 7. the loop exits 0 with one line: the payload and its wake prompt
  const out = await loop.exit(20_000)
  expect(out.code, out.stdout + out.stderr).toBe(0)
  expect(out.lines).toHaveLength(1)
  const woke = out.json as Woke
  expect(woke.status).toBe('handoff')
  expect(woke.prompt).toBe(buildWakePrompt(woke.payload))
  expect(woke.payload).toMatchObject({ file: FILE, abs, root: tmpRoot.root, port: server.port, url, waiter: spec.waiter, round: 1 })
  expect(woke.payload.handoffs).toHaveLength(1)
  expect(woke.payload.handoffs[0]!.message).toBeNull()
  const sentSeq = woke.payload.handoffs[0]!.seq
  // the waiter consumed it: the badge says Claude is working
  await expect(badgeOf(page)).toHaveAttribute('data-state', 'working')
  await expect(badgeOf(page)).toHaveText('Claude is working')

  // 8. pending is exact: TJ's typed reply (new), his typed edit netted to one block, the click
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  const counts = { threads: 1, messages: 1, suggestions: 0, decisions: 0, resolves: 0, edits: 1, external: 0, notices: 0, handoffs: 1 }
  expect(p).toEqual({
    ok: true, via: 'server', file: FILE, abs, rev: expect.any(Number), hash: expect.any(String), since: 0, cursor: expect.any(Number), empty: false,
    user: { displayName: 'TJ', source: 'env' }, // the server's display name (generalization pass; the tests pin MDR_USER_NAME=TJ)
    handoffs: [{ seq: sentSeq, at: expect.any(String), message: null }],
    threads: [{
      id: thread, kind: 'comment', status: 'open', anchor: { state: 'ok', block: 'b2', line: 3, quote: 'member rate of 12%' },
      activity: ['replied'],
      messages: [
        { id: mark.results[0]!.comment, by: 'Claude', at: expect.any(String), body: 'Is 12% still current?' },
        { id: expect.stringMatching(/^c_/), by: 'TJ', at: expect.any(String), body: 'Yes, as of the 10/1 brief.', new: true },
      ],
      suggestions: [],
    }],
    edits: [{
      by: 'TJ', sources: ['editor'], fromRev: expect.any(Number), toRev: p.rev,
      blocks: [{
        op: 'replace', block: 'b4', line: 7,
        change: { format: 'full', before: '- Grow the waitlist\n- Ship the explainer page\n- Publish the FAQ', after: '- Grow the waitlist to 5,000\n- Ship the explainer page\n- Publish the FAQ' },
      }],
    }],
    external: [], notices: [], counts, warnings: [],
  })
  expect(woke.payload.counts).toEqual(counts)
  expect(p.handoffs).toEqual(woke.payload.handoffs)
  expect(p.cursor).toBe((tmpRoot.readSidecar(FILE).at(-1) as { seq: number }).seq)
  // the edit is TJ's, from the editor; nothing on disk is attributed to anyone else
  const ledger = tmpRoot.readSidecar(FILE) as Array<{ type?: string; by?: string }>
  expect(ledger.filter((e) => e.type === 'doc.edit').map((e) => e.by)).toEqual(expect.arrayContaining(['TJ']))
  expect(ledger.some((e) => e.type === 'doc.external')).toBe(false)

  // 9. Claude acts and acks in one batch; the page shows the reply live and the badge says Claude replied
  const acked = ok<BatchResult>(await cli.batch(FILE, { ops: [{ op: 'reply', thread, body: 'Thanks. Leaving 12% as is.' }], ack: p.cursor, ackSince: p.since }))
  expect(acked).toMatchObject({ acked: p.cursor })
  await expect(card.locator(tid('message', { 'data-by': 'Claude' }))).toHaveCount(2)
  await expect(card.locator(tid('message', { 'data-by': 'Claude' })).last()).toContainText('Thanks. Leaving 12% as is.')
  await expect(badgeOf(page)).toHaveAttribute('data-state', 'replied')
  expect(ok<PendingResult>(await cli.run(['pending', abs])).empty).toBe(true)

  // 10. end of turn: arm, a new loop attaches; the page sees it; the delivered click never arrives again
  const arm = ok<ArmResult>(await cli.run(['arm', abs]))
  expect(arm.waiter!.waiter).not.toBe(spec.waiter)
  const loop2 = startLoop(arm.waiter!, { home: tmpRoot.home })
  expect(ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15'])).presence).toMatchObject({ waiter: 'connected', waiterId: arm.waiter!.waiter })
  await expect.poll(() => pageWaiter(page)).toBe('connected')
  await sleep(1_500)
  expect(loop2.done(), 'a consumed handoff must not wake the new loop').toBe(false)

  // 11. round 2: TJ accepts Claude's suggestion in its card, then sends with Cmd+Enter from the editor
  await row.locator(tid('accept')).click()
  await expect.poll(() => tmpRoot.read(FILE), { timeout: 10_000 }).toContain('We launch in Q3 2026.')
  await expect(ed.testid('suggestion', { 'data-suggestion': sug })).toHaveCount(0)
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'saved')
  await placeCaret(page, 'Final paragraph', 'start')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(toastOf(page, 'HANDOFF_SENT')).toHaveCount(1)
  const out2 = await loop2.exit(20_000)
  expect(out2.code, out2.stdout + out2.stderr).toBe(0)
  const woke2 = out2.json as Woke
  expect(woke2.payload).toMatchObject({ waiter: arm.waiter!.waiter, round: 2 })
  expect(woke2.payload.handoffs.map((h) => h.seq)).not.toContain(sentSeq)
  // Cmd+Enter in the editor sent; it did not split the paragraph
  expect(tmpRoot.read(FILE)).toContain('\nFinal paragraph with **bold**')
  const p2 = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(p2).toMatchObject({
    empty: false,
    handoffs: woke2.payload.handoffs,
    threads: [{ id: sugThread, kind: 'suggestion', activity: ['accepted'], suggestions: [{ id: sug, by: 'Claude', status: 'accepted', decidedBy: 'TJ' }] }],
    edits: [], // an accept is reported on its thread, never as a TJ edit (§9.6)
    external: [],
    counts: { decisions: 1, edits: 0, handoffs: 1, messages: 0 },
  })
  ok<BatchResult>(await cli.batch(FILE, { ops: [], ack: p2.cursor, ackSince: p2.since }))

  // 12. end of review: disarm; presence drops to none; Send falls back to copying the prompt
  expect(json(await cli.run(['disarm', abs]))).toMatchObject({ ok: true, file: FILE })
  await expect.poll(() => pageWaiter(page), { timeout: 10_000 }).toBe('none')
  // (QA3: Send with nothing new since Claude's ack says so and copies nothing it claims, so there is a new note first)
  await webClient.createThread({ kind: 'doc' }, 'One more thing before we stop.')
  await page.locator(tid('send')).click()
  await expect(toastOf(page, 'HANDOFF_COPIED')).toContainText('Message copied')
  const writes = await clipWrites(page)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toContain(FILE)
})
