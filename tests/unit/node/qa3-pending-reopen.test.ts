// tests/unit/node/qa3-pending-reopen.test.ts (QA round 3, cli-handoff; CONTRACTS §9.6). The skill's standard loop on the
// real store: Claude comments, the reviewer replies, Claude wakes, reads `pending`, and sends ONE batch with its resolve
// and the ack. The reviewer then reopens the thread without a reply. `pending` must say so: the old baseline (the state
// at the ack cursor, before Claude's own resolve) netted open → open and returned `empty: true`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { opKey, makeKit, type Kit } from './store-kit'

const DOC = '# Title\n\nThe member rate of 12% is paid monthly.\n\nLast line.\n'

let kit: Kit
beforeAll(() => {
  kit = makeKit()
})
afterAll(async () => {
  await kit.cleanup()
})

describe('pending after Claude resolved in the same batch as its ack (real store)', () => {
  it('the reviewer\'s silent reopen is reported as reopened, then acked away', async () => {
    const s = await kit.open(kit.docIn(DOC))
    const c = await s.agent.batch({ ops: [{ op: 'comment', quote: 'member rate of 12%', body: 'Is 12% still current?' }] })
    const thread = c.results[0]!.thread!
    await s.tj.reply(thread, { opKey: opKey(), body: 'Yes it is.' })
    const p1 = await s.agent.pending()
    expect(p1.threads.map((t) => [t.id, t.activity])).toEqual([[thread, ['replied']]])
    // one batch: resolve + ack, exactly as SKILL.md says
    await s.agent.batch({ ops: [{ op: 'resolve', thread, body: 'Confirmed, resolving.' }], ack: p1.cursor, ackSince: p1.since })
    await s.tj.reopen(thread, { opKey: opKey() })
    const p2 = await s.agent.pending()
    expect(p2.empty).toBe(false)
    expect(p2.counts.resolves).toBe(1)
    expect(p2.threads.map((t) => [t.id, t.status, t.activity])).toEqual([[thread, 'open', ['reopened']]])
    // acked: nothing left
    await s.agent.batch({ ops: [], ack: p2.cursor, ackSince: p2.since })
    expect((await s.agent.pending()).empty).toBe(true)
  })
})
