// tests/unit/handoff/qa3-send.test.ts (QA round 3, cli-handoff; CONTRACTS §8.5 step 2a, §12.10).
//
// A Send with nothing since Claude's last ack used to wake Claude with a handoff whose counts were all zero, burning a
// turn. The browser's Send now asks `onlyIfNew`: with no TJ activity to hand over (no comment, reply, suggestion,
// decision, resolve, edit, outside write or notice since the ack) and no message, the server answers `nothingNew` and
// appends nothing. Without the flag, and with a message, the old behaviour holds.
import { afterEach, describe, expect, it } from 'vitest'
import { saveReq } from '../node/store-kit'
import { createHarness, handoffStates, W1, type Harness } from './harness'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const sent = (h: Harness): number => h.events().filter((e) => e.type === 'handoff.sent').length
const comment = async (h: Harness): Promise<void> => {
  const store = await h.store()
  await store.tj.createThread({ opKey: `op_${'2'.repeat(26)}`, anchor: { kind: 'doc' }, anchorRev: 0, body: 'Tighten this' })
}

describe('Send with nothing new (§8.5 step 2a)', () => {
  it('a fresh doc: nothingNew, no handoff appended, no broadcast, the badge stays idle', async () => {
    h = await createHarness()
    const r = await h.handoff({ onlyIfNew: true })
    expect(r).toMatchObject({ ok: true, nothingNew: true, coalesced: false })
    expect(sent(h)).toBe(0)
    expect(handoffStates(h)).toEqual([])
    expect(h.module.activity('doc.md').state).toBe('idle')
  })

  it('a TJ comment is something to send; the same click then coalesces as before', async () => {
    h = await createHarness()
    await comment(h)
    const r = await h.handoff({ onlyIfNew: true })
    expect(r.nothingNew).toBeUndefined()
    expect(sent(h)).toBe(1)
    const again = await h.handoff({ onlyIfNew: true })
    expect(again).toMatchObject({ coalesced: true, seq: r.seq })
    expect(again.nothingNew).toBeUndefined()
  })

  it('after Claude acks everything, the next empty Send is nothing new again', async () => {
    h = await createHarness()
    await comment(h)
    const first = await h.handoff({ onlyIfNew: true })
    const store = await h.store()
    h.agentRequest('pending')
    const p = await store.agent.pending()
    await store.agent.batch({ ops: [], ack: p.cursor, ackSince: p.since })
    await h.consume([first.seq], W1)
    const r = await h.handoff({ onlyIfNew: true })
    expect(r.nothingNew).toBe(true)
    expect(sent(h)).toBe(1)
  })

  it('a TJ edit counts: the flush at click time puts it in the window', async () => {
    h = await createHarness()
    const store = await h.store()
    const snap = await store.snapshot()
    await store.save(await saveReq(snap, snap.markdown.replace('First paragraph.', 'First paragraph, edited.')))
    const r = await h.handoff({ onlyIfNew: true })
    expect(r.nothingNew).toBeUndefined()
    expect(sent(h)).toBe(1)
    expect((await store.agent.pending()).counts.edits).toBe(1)
  })

  it('a message is always something to send', async () => {
    h = await createHarness()
    const r = await h.handoff({ onlyIfNew: true, message: 'Please look again' })
    expect(r.nothingNew).toBeUndefined()
    expect(sent(h)).toBe(1)
  })

  it('without the flag nothing changes: an empty Send still appends a handoff (the module is the plumbing)', async () => {
    h = await createHarness()
    const r = await h.handoff()
    expect(r.nothingNew).toBeUndefined()
    expect(sent(h)).toBe(1)
  })
})
