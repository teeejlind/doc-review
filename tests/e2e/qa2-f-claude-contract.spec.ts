// tests/e2e/qa2-f-claude-contract.spec.ts (QA fix pass 2, agent F: QA_FINDINGS unverified 21, 25, 26, 37).
//
// What a Claude session sees through the built `mdr` CLI against the real server: a batch retried after a dropped
// connection replays its ack instead of ACK_CONFLICT, BATCH_SELF_CONFLICT says what to send instead, a STALE_REVISION on
// a doc whose first round was never saved carries a usable remap, and an edit-block --quote inside a list warns that the
// whole list went.
import type { AgentSnapshot, BatchResult, PendingResult } from '../../shared/types'
import { expect, json, ok, P4_PORT_OFFSET, test } from './fixtures/p4'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P4_PORT_OFFSET })

test('a batch with ack/ackSince retried after a dropped connection answers duplicate: true with the same ack (unverified 25)', async ({ cli, webClient }) => {
  const abs = cli.abs(FILE)
  const sent = await webClient.handoff('Please look at the rate.')
  expect(sent).toMatchObject({ ok: true })
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(p.empty).toBe(false)
  const req = { ops: [{ op: 'comment' as const, quote: 'member rate of 12%', body: 'Is 12% still current?' }], ack: p.cursor, ackSince: p.since }
  const first = ok<BatchResult>(await cli.batch(FILE, req))
  expect(first).toMatchObject({ acked: p.cursor, consumed: [sent.seq], noop: false })
  // the same request again, as Claude would send it when it never saw the first answer
  const retry = ok<BatchResult>(await cli.batch(FILE, req))
  expect(retry).toMatchObject({ acked: p.cursor, consumed: [sent.seq], noop: true, seq: first.seq })
  expect(retry.results[0]).toMatchObject({ duplicate: true, key: first.results[0]!.key, thread: first.results[0]!.thread, comment: first.results[0]!.comment })
  expect(ok<PendingResult>(await cli.run(['pending', abs])).empty).toBe(true)
  // a genuinely stale ack still conflicts
  const other = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'Publish the FAQ', body: 'Another note.' }], ack: p.cursor + 1, ackSince: p.since })
  expect(other.code).toBe(7)
  expect((json(other) as { error: { code: string } }).error.code).toBe('ACK_CONFLICT')
})

test('two suggestions in one paragraph in one batch fail with the op, the block and the way out (unverified 21)', async ({ cli }) => {
  const abs = cli.abs(FILE)
  const two = { ops: [
    { op: 'suggest' as const, quote: 'We launch in Q3.', replace: 'We launch in Q3 2026.', reason: 'Name the year.' },
    { op: 'suggest' as const, quote: 'a member rate of 12% paid monthly', replace: 'a 12% member rate, paid monthly' },
  ] }
  const run = await cli.batch(FILE, two)
  expect(run.code).toBe(7)
  const e = (json(run) as { error: { code: string; message: string; hint: string; op: number; details: { block: string; earlierOp: number } } }).error
  expect(e).toMatchObject({ code: 'BATCH_SELF_CONFLICT', op: 1, details: { block: 'b2', earlierOp: 0 } })
  expect(e.message).toContain('op 0')
  expect(e.hint).toMatch(/send this op as its own command or batch/)
  // what the hint says works
  ok<BatchResult>(await cli.batch(FILE, { ops: [two.ops[0]!] }))
  ok<BatchResult>(await cli.batch(FILE, { ops: [two.ops[1]!] }))
  void abs
})

test('STALE_REVISION on a doc whose first round was never saved carries a remap for the untouched block (unverified 26)', async ({ cli, webClient }) => {
  const abs = cli.abs(FILE)
  const snap = ok<AgentSnapshot>(await cli.run(['snapshot', abs, '--md']))
  expect(snap.rev).toBe(0)
  const target = snap.blocks.find((b) => b.md?.startsWith('Final paragraph'))!
  const doc = await webClient.doc()
  await webClient.saveText(doc.markdown.replace('# Launch plan', '# Launch plan\n\nTJ added a line.'))
  const run = await cli.run(['edit-block', abs, '--ref', target.ref, '--base-rev', '0', '--md', 'Closing paragraph.'])
  expect(run.code).toBe(7)
  const e = (json(run) as { error: { code: string; hint: string; remap: Record<string, string> } }).error
  expect(e.code).toBe('STALE_REVISION')
  expect(e.remap[target.ref]).toBeDefined()
  expect(e.hint).toContain('retry with the remapped ref')
  // retrying with it lands
  const fresh = ok<AgentSnapshot>(await cli.run(['snapshot', abs]))
  ok<BatchResult>(await cli.run(['edit-block', abs, '--ref', e.remap[target.ref]!, '--base-rev', String(fresh.rev), '--md', 'Closing paragraph.']))
})

test('edit-block --quote inside a list warns that the whole list was replaced (unverified 37)', async ({ cli, tmpRoot }) => {
  const abs = cli.abs(FILE)
  const r = ok<BatchResult>(await cli.run(['edit-block', abs, '--quote', 'Ship the explainer page', '--md', '- Ship the explainer page (CLAUDE)']))
  expect(r.warnings).toMatchObject([{ code: 'WHOLE_BLOCK_REPLACED', line: 7, message: expect.stringMatching(/replaced the whole list b\d+ \(lines 7-9, 3 lines\) with 1 line/) }])
  expect(tmpRoot.read(FILE)).toContain('- Ship the explainer page (CLAUDE)\n\nThe member rate')
})
