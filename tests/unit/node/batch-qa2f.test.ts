// tests/unit/node/batch-qa2f.test.ts (QA2-F, what a Claude session sees through `mdr batch`; QA_FINDINGS unverified 21, 25, 26).
// - a batch retried after a dropped connection (CONTRACTS §4.7, §9.5): the ops answer duplicate: true and the ack outcome
//   of the first attempt is replayed instead of ACK_CONFLICT;
// - STALE_REVISION on a doc never saved before (rev 0) carries a usable remap, and a hint that tells the truth;
// - a quote or line selector that lands in a list or table, with an edit that shrinks it, warns WHOLE_BLOCK_REPLACED;
// - BATCH_SELF_CONFLICT names the earlier op and says what to send instead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import type { AgentOp, DocStore } from '../../../shared/types'
import { makeKit, opKey, saveReq, type Kit } from './store-kit'

const NINE = '# Plan\n\nIntro para.\n\nWe launch in Q3.\n\n## Section\n\nPara five.\n\nPara six.\n\nPara seven.\n\nPara eight.\n\nPara nine.\n'

let kit: Kit
beforeAll(() => {
  kit = makeKit('mdr-batch-qa2f-')
})
afterAll(async () => {
  await kit.cleanup()
})

async function fresh(text = NINE): Promise<{ file: string; s: DocStore; rev: number }> {
  const file = kit.docIn(text)
  const s = await kit.open(file)
  await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'start' })
  return { file, s, rev: (await s.snapshot()).rev }
}

describe('a retried batch that carries ack / ackSince (unverified 25)', () => {
  it('replays the original result, ack outcome included, instead of ACK_CONFLICT', async () => {
    const { s } = await fresh()
    const h = await s.appendEvents([{ type: 'handoff.sent', message: 'hi', delivery: 'waiter' }])
    const req = { ops: [{ op: 'comment', quote: 'Para six', body: 'one' }] as AgentOp[], ack: h.seq, ackSince: 0 }
    const first = await s.agent.batch(req)
    expect(first).toMatchObject({ acked: h.seq, consumed: [h.seq], noop: false })
    const retry = await s.agent.batch(req)
    expect(retry).toMatchObject({ noop: true, acked: h.seq, consumed: [h.seq] })
    expect(retry.results).toMatchObject([{ duplicate: true, key: first.results[0]!.key, thread: first.results[0]!.thread, comment: first.results[0]!.comment }])
    // nothing was appended: still one comment, and a second retry (even after a reopen) answers the same
    const again = await (await kit.open(await fileOf(s))).agent.batch(req)
    expect(again).toMatchObject({ noop: true, acked: h.seq, consumed: [h.seq] })
  })

  it('still ACK_CONFLICT for new ops, and for an ack-only request another session got to first', async () => {
    const { s } = await fresh()
    const h = await s.appendEvents([{ type: 'handoff.sent', message: 'hi', delivery: 'waiter' }])
    await s.agent.batch({ ops: [{ op: 'comment', quote: 'Para six', body: 'one' }], ack: h.seq, ackSince: 0 })
    await expect(s.agent.batch({ ops: [{ op: 'comment', quote: 'Para seven', body: 'two' }], ack: h.seq + 1, ackSince: 0 })).rejects.toMatchObject({ code: 'ACK_CONFLICT' })
    await expect(s.agent.batch({ ops: [{ op: 'comment', quote: 'Para seven', body: 'two' }], ack: h.seq, ackSince: 0 })).rejects.toMatchObject({ code: 'ACK_CONFLICT' })
    await expect(s.agent.batch({ ops: [], ack: h.seq, ackSince: 0 })).rejects.toMatchObject({ code: 'ACK_CONFLICT' })
  })
})

describe('BATCH_SELF_CONFLICT says which op got there first and what to send instead (unverified 21)', () => {
  const MD = '# Plan\n\nWe launch in Q3. The notes carry a member rate of 12% paid monthly.\n\nSecond paragraph here.\n'

  it('two suggestions in one paragraph: the error names op 0, block b2 and the way out; the second op alone then lands', async () => {
    const { file, s } = await fresh(MD)
    const ops: AgentOp[] = [
      { op: 'suggest', quote: 'We launch in Q3.', replace: 'We launch in Q3 2026.', reason: 'Name the year.' },
      { op: 'suggest', quote: 'a member rate of 12% paid monthly', replace: 'a 12% member rate, paid monthly' },
    ]
    const e = await s.agent.batch({ ops }).catch((x: unknown) => x)
    expect(e).toMatchObject({
      code: 'BATCH_SELF_CONFLICT',
      body: { op: 1, details: { block: 'b2', earlierOp: 0 } },
    })
    const body = (e as { body: { message: string; hint?: string } }).body
    expect(body.message).toContain('op 0')
    expect(body.hint).toMatch(/merge the ops on this block into one/)
    expect(body.hint).toMatch(/its own command or batch after op 0 has landed/)
    expect(kit.read(file)).toBe(MD)
    // the recovery the hint names works: the first op, then the second as its own batch
    await s.agent.batch({ ops: [ops[0]!] })
    const second = await s.agent.batch({ ops: [ops[1]!] })
    expect(second.results[0]!.suggestion).toBeDefined()
  })

  it('what the skill tells Claude holds: comments before the one suggest on a block land together, a comment after it does not', async () => {
    const { s } = await fresh(MD)
    const together = await s.agent.batch({ ops: [
      { op: 'comment', quote: 'member rate', body: 'Check this.' },
      { op: 'comment', quote: 'paid monthly', body: 'And this.' },
      { op: 'suggest', quote: 'We launch in Q3.', replace: 'We launch in Q3 2026.' },
    ] })
    expect(together.results.map((r) => r.op)).toEqual(['comment', 'comment', 'suggest'])
    await expect(s.agent.batch({ ops: [
      { op: 'suggest', quote: 'Second paragraph', replace: 'Second paragraph, tightened' },
      { op: 'comment', quote: 'here', body: 'late' },
    ] })).rejects.toMatchObject({ code: 'BATCH_SELF_CONFLICT', body: { op: 1 } })
  })

  it('every self-conflict site carries a hint', async () => {
    const { s, rev } = await fresh()
    const cases: AgentOp[][] = [
      [{ op: 'replace_block', target: { ref: 'b5', rev }, markdown: 'one' }, { op: 'delete_block', target: { ref: 'b5', rev } }],
      [{ op: 'delete_block', target: { ref: 'b6', rev } }, { op: 'insert_after', target: { ref: 'b6', rev }, markdown: 'orphan' }],
      [{ op: 'replace_block', target: { quote: 'Para five.' }, markdown: 'Para five, edited.' }, { op: 'comment', quote: 'five, edited', body: 'x' }],
      [{ op: 'suggest', quote: 'Para six', replace: 'Paragraph six' }, { op: 'comment', quote: 'six', body: 'x' }],
      [{ op: 'replace_block', target: { ref: 'b5', rev }, markdown: 'x' }, { op: 'write', markdown: 'whole new doc\n', baseRev: rev }],
    ]
    for (const ops of cases) {
      const e = await s.agent.batch({ ops }).catch((x: unknown) => x)
      expect(e, JSON.stringify(ops)).toMatchObject({ code: 'BATCH_SELF_CONFLICT', body: { op: 1, hint: expect.any(String) } })
    }
  })
})

describe('STALE_REVISION at rev 0, a doc whose first round has not been saved yet (unverified 26)', () => {
  it('remaps the untouched block to its current ref, as it does for every later rev', async () => {
    const file = kit.docIn(NINE)
    const s = await kit.open(file)
    const snap = await s.snapshot()
    expect(snap.rev).toBe(0)
    // TJ edits another block: the first save creates the sidecar (baseline rev 1) and lands at rev 2
    await s.save(await saveReq(snap, NINE.replace('Intro para.', 'Intro para.\n\nTJ added this.')))
    const e = await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b7', rev: 0 }, markdown: 'x' }] }).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'STALE_REVISION', body: { op: 0, remap: { b7: 'b8' }, hint: expect.stringContaining('retry with the remapped ref and rev 2') } })
  })

  it('a hint that promises a remap only when there is one: a block TJ changed says to re-read', async () => {
    const { s, rev } = await fresh()
    await s.save(await saveReq(await s.snapshot(), NINE.replace('Para seven.', 'Para seven, TJ edited.')))
    const e = await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b10', rev }, markdown: 'x' }] }).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'STALE_REVISION', body: { op: 0, remap: {} } })
    const hint = (e as { body: { hint: string } }).body.hint
    expect(hint).not.toMatch(/remapped ref/)
    expect(hint).toMatch(/nothing to remap/)
    expect(hint).toMatch(/mdr snapshot/)
  })
})

describe('replace_block / delete_block picked by quote or line inside a list or table (unverified 37)', () => {
  const MD = '# Goals\n\n- Grow the waitlist\n- Ship the explainer page\n- Publish the FAQ\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nLast paragraph here.\n'

  it('a list of 3 items replaced by one bullet warns; the warning names the block, its lines and the way to edit one item', async () => {
    const { file, s } = await fresh(MD)
    const r = await s.agent.batch({ ops: [{ op: 'replace_block', target: { quote: 'Ship the explainer page' }, markdown: '- Ship the explainer page (CLAUDE)' }] })
    expect(kit.read(file)).toContain('# Goals\n\n- Ship the explainer page (CLAUDE)\n\n| a | b |')
    expect(r.warnings).toEqual([{
      code: 'WHOLE_BLOCK_REPLACED', line: 3,
      message: expect.stringMatching(/replaced the whole list b2 \(lines 3-5, 3 lines\) with 1 line.*suggest --quote/),
    }])
    expect(S.BatchResultSchema.safeParse(r).success).toBe(true)
  })

  it('a table row picked by quote, a --line selector inside the list, and a delete warn too; dryRun shows the warning without writing', async () => {
    const { file, s, rev } = await fresh(MD)
    const dry = await s.agent.batch({ ops: [{ op: 'delete_block', target: { quote: 'Publish the FAQ' } }], dryRun: true })
    expect(dry.warnings.map((w) => w.code)).toEqual(['WHOLE_BLOCK_REPLACED'])
    expect(dry.warnings[0]!.message).toMatch(/deleted the whole list b2/)
    expect(kit.read(file)).toBe(MD)
    const byLine = await s.agent.batch({ ops: [{ op: 'replace_block', target: { line: 4, rev }, markdown: '- only this' }] })
    expect(byLine.warnings.map((w) => w.code)).toEqual(['WHOLE_BLOCK_REPLACED'])
    const row = await s.agent.batch({ ops: [{ op: 'replace_block', target: { quote: '3' }, markdown: '| a | b |' }] })
    expect(row.warnings).toMatchObject([{ code: 'WHOLE_BLOCK_REPLACED', message: expect.stringMatching(/replaced the whole table b\d+/) }])
  })

  it('no warning when the edit keeps every line, when the block is picked by ref, or when it is a plain paragraph', async () => {
    const { s, rev } = await fresh(MD)
    const whole = await s.agent.batch({ ops: [{ op: 'replace_block', target: { quote: 'Ship the explainer page' }, markdown: '- Grow the waitlist\n- Ship the explainer page (CLAUDE)\n- Publish the FAQ' }] })
    expect(whole.warnings).toEqual([])
    const byRef = await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b3', rev: whole.rev }, markdown: 'Table gone.' }] })
    expect(byRef.warnings).toEqual([])
    const para = await s.agent.batch({ ops: [{ op: 'replace_block', target: { quote: 'Last paragraph' }, markdown: 'Done.' }] })
    expect(para.warnings).toEqual([])
    void rev
  })
})

async function fileOf(s: DocStore): Promise<string> {
  return (await s.snapshot()).file
}
