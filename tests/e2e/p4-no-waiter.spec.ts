// tests/e2e/p4-no-waiter.spec.ts (P4; CONTRACTS §14 P4 E2E, §8.5 steps 2–5, §9.10, §12.10, §13 #70).
//
// Send to Claude with no waiter against the real built server. The browser already copied (`clientDecision:
// 'clipboard'`) → `delivery: 'clipboard'`, and `prompt` is byte-equal to buildClipboardPrompt with the handoff's
// round and the server's pending counts. The mismatch case (the browser chose 'waiter' from stale presence, but no
// waiter is attached) is also `clipboard`, with the prompt the browser offers behind its Copy button. A double click
// coalesces (same seq, same round); a new message is a new round. The toast UI itself is P3's (p3-handoff-ui).
import type { HandoffResult, PendingResult } from '../../shared/types'
import { buildClipboardPrompt } from '../../shared/handoff-prompt'
import { expect, ok, P4_PORT_OFFSET, recordEvents, test } from './fixtures/p4'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P4_PORT_OFFSET })

test('no waiter: clipboard delivery, prompt = buildClipboardPrompt(round, counts); double click coalesces; a new message is round 2', async ({ cli, webClient, tmpRoot }) => {
  const abs = cli.abs(FILE)
  const log = await recordEvents(webClient)
  // TJ's work before he clicks: a comment and an edit
  const snap = await webClient.doc()
  await webClient.createThread({ kind: 'doc' }, 'Tighten the intro.')
  await webClient.saveText(snap.markdown.replace('Publish the FAQ', 'Publish the FAQ and the glossary'))
  expect((await webClient.review()).presence).toEqual({ waiter: 'none' })

  const r1: HandoffResult = await webClient.handoff(undefined, 'clipboard')
  expect(r1).toMatchObject({ ok: true, coalesced: false, delivery: 'clipboard', presence: { waiter: 'none' } })
  // the server's counts are pending's counts after its flush (the handoff included); pending never acks
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(p.counts).toMatchObject({ threads: 1, messages: 1, edits: 1, handoffs: 1 })
  expect(r1.prompt).toBe(buildClipboardPrompt({ file: FILE, abs, root: tmpRoot.root, round: 1, counts: p.counts }))
  expect(r1.prompt.split('\n')[0]).toBe(`[doc-review] TJ sent \`${FILE}\` back to you (round #1: 1 message, edits in 1 block).`)
  const sent = await log.next('handoff', { where: (e) => e.data.seq === r1.seq })
  expect(sent.data).toEqual({ file: FILE, seq: r1.seq, state: 'sent', delivery: 'clipboard' })
  const act = await log.next('claude-activity', { where: (e) => e.data.state === 'waiting-pickup' })
  expect(act.data).toMatchObject({ state: 'waiting-pickup', delivery: 'clipboard' })

  // a double click (no message) coalesces: same seq, same round, nothing appended
  const lines = tmpRoot.readSidecar(FILE).length
  const r2 = await webClient.handoff(undefined, 'clipboard')
  expect(r2).toMatchObject({ seq: r1.seq, coalesced: true, delivery: 'clipboard' })
  expect(r2.prompt).toContain('(round #1: ')
  expect(tmpRoot.readSidecar(FILE).length).toBe(lines)

  // the mismatch case: the browser picked 'waiter' but nobody is attached → clipboard; a new message is a new round
  const r3 = await webClient.handoff('And the goals, please.', 'waiter')
  expect(r3).toMatchObject({ coalesced: false, delivery: 'clipboard', presence: { waiter: 'none' } })
  expect(r3.seq).toBeGreaterThan(r1.seq)
  const p2 = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(p2.handoffs.map((h) => [h.seq, h.message])).toEqual([[r1.seq, null], [r3.seq, 'And the goals, please.']])
  expect(r3.prompt).toBe(buildClipboardPrompt({ file: FILE, abs, root: tmpRoot.root, round: 2, counts: p2.counts }))
  const sidecar = tmpRoot.readSidecar(FILE) as Array<{ type?: string; delivery?: string; message?: string | null; by?: string }>
  expect(sidecar.filter((l) => l.type === 'handoff.sent').map((l) => [l.by, l.delivery, l.message])).toEqual([
    ['TJ', 'clipboard', null], ['TJ', 'clipboard', 'And the goals, please.'],
  ])

  // pasting the prompt and acking consumes both (the prompt names the round; the ack dedupes a later wake)
  const acked = ok<{ consumed: number[] }>(await cli.batch(FILE, { ops: [], ack: p2.cursor, ackSince: p2.since }))
  expect(acked.consumed).toEqual([r1.seq, r3.seq])
  await log.next('handoff', { where: (e) => e.data.seq === r3.seq && e.data.state === 'consumed' })
  expect((await webClient.review()).undeliveredHandoffs).toEqual([])
  await log.close()
})
