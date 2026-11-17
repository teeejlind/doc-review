// tests/unit/handoff/handoff.test.ts (P4; CONTRACTS §8.5, §8.7, §9.10, D21, D25, D46; §13 rows 49–54).
//
// The real handoff module over the real doc store: delivery choice, coalescing (double click, same message, delivered
// < 10 s ago), the durable latch delivered on the next connect, consume (route and ack), supersede, the round ordinal,
// the undelivered timer, and a module restarted mid-review computing the same payload, round and coalescing decision.
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoffPayload, WaiterSseEvent } from '../../../shared/types'
import { buildClipboardPrompt } from '../../../shared/handoff-prompt'
import * as S from '../../../shared/schemas'
import { createHarness, handoffStates, until, W1, W2, type Harness } from './harness'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const payloadOf = (e: WaiterSseEvent): HandoffPayload => {
  expect(e.event).toBe('handoff')
  return (e as Extract<WaiterSseEvent, { event: 'handoff' }>).data
}

describe('POST /api/handoff: delivery and prompt', () => {
  it('no waiter (presence none) → clipboard, prompt = buildClipboardPrompt with round and counts', async () => {
    h = await createHarness()
    const store = await h.store()
    await store.tj.createThread({ opKey: `op_${'1'.repeat(26)}`, anchor: { kind: 'doc' }, anchorRev: 0, body: 'Tighten this' })
    const r = await h.handoff({ message: 'Section 2 please' })
    expect(S.HandoffResultSchema.safeParse(r).success).toBe(true)
    expect(r).toMatchObject({ ok: true, coalesced: false, delivery: 'clipboard', presence: { waiter: 'none' } })
    const counts = (await store.agent.pending()).counts
    expect(counts.messages).toBe(1)
    expect(r.prompt).toBe(buildClipboardPrompt({ file: 'doc.md', abs: store.abs, root: h.root, round: 1, counts }))
    expect(r.prompt).toContain('round #1: 1 message')
    const recs = await store.handoffs()
    expect(recs).toMatchObject([{ seq: r.seq, message: 'Section 2 please', delivery: 'clipboard', round: 1, consumed: false }])
    expect(handoffStates(h)).toEqual([[r.seq, 'sent', 'clipboard']])
    expect(h.module.activity('doc.md')).toMatchObject({ state: 'waiting-pickup', delivery: 'clipboard' })
  })

  it('the handoff line is by TJ with no message when none is given; a retried click (same opKey) appends nothing', async () => {
    h = await createHarness()
    const r = await h.handoff({ opKey: `op_${'A'.repeat(26)}` })
    const line = h.events().find((e) => e.seq === r.seq)!
    expect(line).toMatchObject({ type: 'handoff.sent', by: 'TJ', message: null, delivery: 'clipboard' })
    const again = await h.handoff({ opKey: `op_${'A'.repeat(26)}` })
    expect(again).toMatchObject({ seq: r.seq, coalesced: true })
    expect(h.events().filter((e) => e.type === 'handoff.sent')).toHaveLength(1)
  })

  // §4.7 puts `tj:<opKey>` on the line. Was it.fails until the P4 merge, where the integrator made P1's appendEvents keep
  // the key and treat a repeat as a duplicate (CONTRACT_CHANGES.md, P4 merge).
  it('the handoff line carries the idempotency key tj:<opKey>', async () => {
    h = await createHarness()
    const r = await h.handoff({ opKey: `op_${'B'.repeat(26)}` })
    expect(h.events().find((e) => e.seq === r.seq)).toMatchObject({ key: `tj:op_${'B'.repeat(26)}` })
  })

  it('the store answers a repeated handoff key with the original seq and appends nothing, across a restart', async () => {
    h = await createHarness()
    const key = `tj:op_${'C'.repeat(26)}`
    const first = await (await h.store()).appendEvents([{ type: 'handoff.sent', key, message: null, delivery: 'clipboard' }])
    await h.restart()
    const again = await (await h.store()).appendEvents([{ type: 'handoff.sent', key, message: null, delivery: 'clipboard' }])
    expect(again.seq).toBe(first.seq)
    expect(again.events.map((e) => e.seq)).toEqual([first.seq])
    expect(h.events().filter((e) => e.type === 'handoff.sent')).toHaveLength(1)
    await expect((await h.store()).appendEvents([{ type: 'handoff.sent', key: 'cli:nope', message: null, delivery: 'clipboard' }]))
      .rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('a click retried after its handoff was consumed (outside coalescing) is coalesced: no new line, no second sent, activity kept', async () => {
    h = await createHarness({ options: { coalesceMs: 0 } })
    const opKey = `op_${'D'.repeat(26)}`
    const r = await h.handoff({ opKey })
    await h.consume([r.seq])
    await until(() => h!.module.activity('doc.md').state === 'working', 1000)
    const again = await h.handoff({ opKey })
    expect(again).toMatchObject({ seq: r.seq, coalesced: true, delivery: 'clipboard' })
    expect(h.events().filter((e) => e.type === 'handoff.sent')).toHaveLength(1)
    expect(handoffStates(h).filter(([seq, s]) => seq === r.seq && s === 'sent')).toHaveLength(1)
    expect(h.module.activity('doc.md').state).toBe('working')
  })

  it('a message over MAX_HANDOFF_MESSAGE_CHARS is BAD_REQUEST', async () => {
    h = await createHarness()
    const res = await h.raw('POST', '/api/handoff?file=doc.md', { opKey: `op_${'1'.repeat(26)}`, clientDecision: 'waiter', message: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('presence grace (an arm) or turn → latched, nothing pushed; the next connect delivers it (the latch)', async () => {
    h = await createHarness()
    await h.arm()
    const r = await h.handoff()
    expect(r).toMatchObject({ delivery: 'latched', presence: { waiter: 'grace' } })
    expect(handoffStates(h)).toEqual([[r.seq, 'latched', 'latched']])
    const w = await h.wait(W1)
    expect((await w.next('armed')).data).toEqual({ waiter: W1, file: 'doc.md', undelivered: [r.seq] })
    const p = payloadOf(await w.next('handoff'))
    expect(S.HandoffPayloadSchema.safeParse(p).success).toBe(true)
    expect(p).toMatchObject({ file: 'doc.md', root: h.root, round: 1, waiter: W1, handoffs: [{ seq: r.seq, message: null }] })
    expect(p.url).toBe(`http://127.0.0.1:${18765}/?file=doc.md`)
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'turn', waiterId: W1 })
    expect(w.events.map((e) => e.event)).toEqual(['armed', 'handoff'])
  })

  it('a connected waiter gets the handoff pushed at once (delivery waiter), and presence becomes turn', async () => {
    h = await createHarness()
    const w = await h.wait(W1)
    await w.next('armed')
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'connected', waiterId: W1 })
    const r = await h.handoff({ message: 'go' })
    expect(r.delivery).toBe('waiter')
    expect(payloadOf(await w.next('handoff')).handoffs).toEqual([{ seq: r.seq, at: expect.any(String), message: 'go' }])
    expect(r.presence.waiter).toBe('turn')
    expect(handoffStates(h)).toEqual([[r.seq, 'sent', 'waiter']])
  })

  it('clientDecision clipboard is never contradicted, but a connected waiter still gets the handoff', async () => {
    h = await createHarness()
    const w = await h.wait(W1)
    await w.next('armed')
    const r = await h.handoff({ clientDecision: 'clipboard' })
    expect(r.delivery).toBe('clipboard')
    expect(payloadOf(await w.next('handoff')).handoffs.map((x) => x.seq)).toEqual([r.seq])
  })
})

describe('coalescing and round (§8.5 step 2, §9.10)', () => {
  it('a double click coalesces: same seq, nothing appended, no new round', async () => {
    h = await createHarness()
    const a = await h.handoff()
    const b = await h.handoff()
    expect(b).toMatchObject({ seq: a.seq, coalesced: true, delivery: 'clipboard' })
    expect(b.prompt).toContain('round #1')
    expect(await (await h.store()).handoffs()).toHaveLength(1)
  })

  it('a coalesced click that the browser already copied answers clipboard (never contradicted)', async () => {
    h = await createHarness()
    await h.arm()
    const a = await h.handoff()
    expect(a.delivery).toBe('latched')
    const b = await h.handoff({ clientDecision: 'clipboard' })
    expect(b).toMatchObject({ seq: a.seq, coalesced: true, delivery: 'clipboard' })
  })

  it('two concurrent clicks still make one round (the module serializes per doc)', async () => {
    h = await createHarness()
    const [a, b] = await Promise.all([h.handoff(), h.handoff()])
    expect(a.seq).toBe(b.seq)
    expect([a.coalesced, b.coalesced].sort()).toEqual([false, true])
    expect(await (await h.store()).handoffs()).toHaveLength(1)
  })

  it('the same message coalesces; a new non-empty message appends; the next waiter gets both in one payload, round = newest', async () => {
    h = await createHarness()
    const a = await h.handoff({ message: 'first' })
    const same = await h.handoff({ message: 'first' })
    expect(same).toMatchObject({ seq: a.seq, coalesced: true })
    const b = await h.handoff({ message: 'second' })
    expect(b).toMatchObject({ coalesced: false })
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(b.prompt).toContain('round #2')
    const w = await h.wait(W1)
    const p = payloadOf(await w.next('handoff'))
    expect(p.handoffs.map((x) => [x.seq, x.message])).toEqual([[a.seq, 'first'], [b.seq, 'second']])
    expect(p.round).toBe(2)
  })

  it('a click < coalesceMs after a delivery with no Claude activity since coalesces into the delivered round', async () => {
    h = await createHarness()
    const w = await h.wait(W1)
    await w.next('armed')
    const a = await h.handoff()
    const p = payloadOf(await w.next('handoff'))
    await h.consume(p.handoffs.map((x) => x.seq), W1)
    const b = await h.handoff()
    expect(b).toMatchObject({ seq: a.seq, coalesced: true })
    h.agentRequest('pending') // Claude started working: the next click is a new round
    const c = await h.handoff()
    expect(c).toMatchObject({ coalesced: false })
    expect(c.prompt).toContain('round #2')
  })
})

describe('consume and ack (§8.5 "Consumed", §8.7 at-least-once)', () => {
  it('consume is idempotent and broadcasts consumed once; a new waiter then gets nothing', async () => {
    h = await createHarness()
    const r = await h.handoff()
    const c1 = await h.consume([r.seq], W1)
    const c2 = await h.consume([r.seq], W1)
    expect(c2.seq).toBe(c1.seq)
    const lines = h.events().filter((e) => e.type === 'handoff.consumed')
    expect(lines).toMatchObject([{ by: 'Claude', handoffs: [r.seq], via: 'waiter', waiter: W1 }])
    await until(() => handoffStates(h!).some(([, s]) => s === 'consumed'))
    expect(handoffStates(h).filter(([, s]) => s === 'consumed')).toEqual([[r.seq, 'consumed', 'clipboard']])
    const w = await h.wait(W2)
    expect((await w.next('armed')).data).toMatchObject({ undelivered: [] })
    await new Promise((res) => setTimeout(res, 30))
    expect(w.events.map((e) => e.event)).toEqual(['armed'])
  })

  it('an ack past a clipboard handoff consumes it: no later waiter redelivers it (§13 #49)', async () => {
    h = await createHarness()
    const r = await h.handoff()
    const store = await h.store()
    const p = await store.agent.pending()
    expect(p.handoffs.map((x) => x.seq)).toEqual([r.seq])
    await store.agent.batch({ ops: [], ack: p.cursor, ackSince: p.since })
    await until(() => handoffStates(h!).some(([s, st]) => s === r.seq && st === 'consumed'))
    const w = await h.wait(W1)
    expect((await w.next('armed')).data).toMatchObject({ undelivered: [] })
  })

  it('a wait that dies before consume leaves the handoff for the next loop (at-least-once); the ack then consumes it', async () => {
    h = await createHarness()
    const w = await h.wait(W1)
    await w.next('armed')
    const r = await h.handoff()
    await w.next('handoff')
    await w.cancel() // printed, then died before consume
    const w2 = await h.wait(W2)
    expect(payloadOf(await w2.next('handoff')).handoffs.map((x) => x.seq)).toEqual([r.seq])
    await w2.cancel()
    const store = await h.store()
    const p = await store.agent.pending()
    await store.agent.batch({ ops: [], ack: p.cursor, ackSince: p.since })
    const w3 = await h.wait(W1, 5)
    expect((await w3.next('armed')).data).toMatchObject({ undelivered: [] })
  })
})

describe('supersede and disarm (D21)', () => {
  it('a different waiter id supersedes the live one with reason newer-waiter', async () => {
    h = await createHarness()
    const a = await h.wait(W1)
    await a.next('armed')
    const b = await h.wait(W2)
    await b.next('armed')
    expect((await a.next('superseded')).data).toEqual({ by: W2, reason: 'newer-waiter' })
    await a.ended$
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'connected', waiterId: W2 })
  })

  it('disarm sends disarmed to the live waiter and presence becomes none', async () => {
    h = await createHarness()
    const a = await h.wait(W1)
    await a.next('armed')
    expect(await h.disarm()).toEqual({ ok: true, file: 'doc.md', disarmed: true })
    expect((await a.next('disarmed')).data).toEqual({ file: 'doc.md' })
    await a.ended$
    expect(h.module.presence('doc.md')).toEqual({ waiter: 'none' })
    expect(await h.disarm()).toEqual({ ok: true, file: 'doc.md', disarmed: false })
  })

  it('shutdown(restart) tells every waiter server-shutdown with the reason', async () => {
    h = await createHarness()
    const a = await h.wait(W1)
    await a.next('armed')
    h.module.shutdown('restart')
    expect((await a.next('server-shutdown')).data).toEqual({ reason: 'restart' })
    await a.ended$
  })
})

describe('undelivered (§8.5 step 6)', () => {
  it('fires undeliveredMs after the send while presence is none, once', async () => {
    h = await createHarness({ options: { undeliveredMs: 60 } })
    const r = await h.handoff()
    await until(() => handoffStates(h!).some(([, s]) => s === 'undelivered'), 1000)
    await new Promise((res) => setTimeout(res, 120))
    expect(handoffStates(h).filter(([, s]) => s === 'undelivered')).toEqual([[r.seq, 'undelivered', 'clipboard']])
  })

  it('never fires during grace or turn; starts from when presence became none', async () => {
    h = await createHarness({ options: { undeliveredMs: 80, graceMs: 150 } })
    // Anchor on the arm call, not on when polling first sees `none`: grace starts at or after armAt, so `none` begins
    // at >= armAt + 150 and undelivered at >= armAt + 230. A polled `none` timestamp lags the real transition under
    // load (the full suite runs ~7x CPU), which made a "60 ms after we saw none" bound flaky on the merged tree.
    const armAt = Date.now()
    await h.arm()
    const r = await h.handoff()
    expect(r.delivery).toBe('latched')
    await new Promise((res) => setTimeout(res, 120))
    expect(handoffStates(h).some(([, s]) => s === 'undelivered')).toBe(false) // still in grace
    await until(() => h!.module.presence('doc.md').waiter === 'none', 1000)
    await until(() => handoffStates(h!).some(([, s]) => s === 'undelivered'), 1000)
    // Counted from send it would fire in grace (~80 ms); fired at grace end, ~150 ms; counted from none, >= 230 ms.
    expect(Date.now() - armAt).toBeGreaterThanOrEqual(225)
  })

  it('a consumed handoff never reports undelivered', async () => {
    h = await createHarness({ options: { undeliveredMs: 60 } })
    const r = await h.handoff()
    await h.consume([r.seq])
    await new Promise((res) => setTimeout(res, 150))
    expect(handoffStates(h).some(([, s]) => s === 'undelivered')).toBe(false)
  })
})

describe('restart mid-review (D46): state comes only from store.handoffs()', () => {
  it('a fresh module over the same sidecar computes the same payload, round and coalescing decision', async () => {
    h = await createHarness()
    const a = await h.handoff({ message: 'one' })
    const b = await h.handoff({ message: 'two' })
    await h.restart()
    const again = await h.handoff({ message: 'two' }) // same message as the newest unconsumed: coalesced after the restart too
    expect(again).toMatchObject({ seq: b.seq, coalesced: true })
    expect(again.prompt).toContain('round #2')
    const w = await h.wait(W1)
    const p = payloadOf(await w.next('handoff'))
    expect(p.handoffs.map((x) => x.seq)).toEqual([a.seq, b.seq])
    expect(p.round).toBe(2)
    await h.consume([a.seq, b.seq], W1)
    await h.restart()
    const c = await h.handoff()
    expect(c).toMatchObject({ coalesced: false })
    expect(c.prompt).toContain('round #3')
  })
})
