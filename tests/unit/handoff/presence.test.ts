// tests/unit/handoff/presence.test.ts (P4; CONTRACTS §8.5 "Presence", D48; §13 rows 50, 93).
//
// Presence transitions with short timers: grace after a drop; grace after an arm with no stream, lapsing to none after
// graceMs; turn after a delivering stream closes, ended by a connect (→ connected), an arm (→ grace), a disarm
// (→ none) or turnIdleMs with no agent request of any kind (→ none), and kept alive by control requests as well as
// content ones; the undelivered timer starts only when presence is none.
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, handoffStates, presenceEvents, until, W1, W2, type Harness } from './harness'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const waiter = (h: Harness): string => h.module.presence('doc.md').waiter
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Connect W1, deliver one handoff to it, and let the `wait` exit: presence is then `turn`. */
async function intoTurn(h: Harness): Promise<void> {
  const w = await h.wait(W1)
  await w.next('armed')
  await h.handoff()
  const e = await w.next('handoff')
  if (e.event === 'handoff') await h.consume(e.data.handoffs.map((x) => x.seq), W1) // what `wait` does after printing
  await w.cancel()
  expect(waiter(h)).toBe('turn')
}

describe('presence (§8.5, D48)', () => {
  it('starts none; connected while a stream is open; grace after a drop; none after graceMs', async () => {
    h = await createHarness({ options: { graceMs: 80 } })
    expect(h.module.presence('doc.md')).toEqual({ waiter: 'none' })
    const w = await h.wait(W1)
    await w.next('armed')
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'connected', waiterId: W1 })
    await w.cancel()
    await until(() => waiter(h!) === 'grace')
    const p = h.module.presence('doc.md')
    expect(p.graceUntil).toBeDefined()
    await until(() => waiter(h!) === 'none', 1000)
    expect(presenceEvents(h)).toEqual(['connected', 'grace', 'none'])
  })

  it('a reconnect inside grace goes straight back to connected (the loop\'s re-arm gap never reaches none)', async () => {
    h = await createHarness({ options: { graceMs: 200 } })
    for (let gen = 1; gen <= 3; gen++) {
      const w = await h.wait(W1, gen)
      await w.next('armed')
      await w.cancel()
    }
    const last = await h.wait(W1, 4)
    await last.next('armed')
    expect(presenceEvents(h).includes('none')).toBe(false)
    expect(waiter(h)).toBe('connected')
  })

  it('an arm with no stream → grace for graceMs, a later arm extends it, then none', async () => {
    h = await createHarness({ options: { graceMs: 100 } })
    const r = (await h.arm()) as { presence: { waiter: string; graceUntil: string } }
    expect(r.presence.waiter).toBe('grace')
    await sleep(60)
    const r2 = (await h.arm()) as { presence: { waiter: string; graceUntil: string } }
    expect(Date.parse(r2.presence.graceUntil)).toBeGreaterThan(Date.parse(r.presence.graceUntil))
    await sleep(60)
    expect(waiter(h)).toBe('grace') // extended
    await until(() => waiter(h!) === 'none', 1000)
  })

  it('an arm while connected leaves connected unchanged', async () => {
    h = await createHarness()
    const w = await h.wait(W1)
    await w.next('armed')
    const r = (await h.arm()) as { presence: { waiter: string; waiterId: string } }
    expect(r.presence).toMatchObject({ waiter: 'connected', waiterId: W1 })
  })

  it('turn after a delivering close; a connect ends it (→ connected)', async () => {
    h = await createHarness({ options: { turnIdleMs: 5000 } })
    await intoTurn(h)
    const w2 = await h.wait(W2)
    await w2.next('armed')
    expect(waiter(h)).toBe('connected')
  })

  it('turn ended by an arm → grace, then none after graceMs when no loop connects', async () => {
    h = await createHarness({ options: { turnIdleMs: 5000, graceMs: 80 } })
    await intoTurn(h)
    await h.arm()
    expect(waiter(h)).toBe('grace')
    await until(() => waiter(h!) === 'none', 1000)
  })

  it('turn ended by a disarm → none', async () => {
    h = await createHarness({ options: { turnIdleMs: 5000 } })
    await intoTurn(h)
    await h.disarm()
    expect(waiter(h)).toBe('none')
  })

  it('turn lapses to none after turnIdleMs with no agent request; control and content requests both keep it alive', async () => {
    h = await createHarness({ options: { turnIdleMs: 120 } })
    await intoTurn(h)
    for (const route of ['status', 'snapshot', 'consume', 'pending'] as const) {
      await sleep(70)
      h.agentRequest(route)
      expect(waiter(h)).toBe('turn')
    }
    await until(() => waiter(h!) === 'none', 1000)
  })

  it('requests for another doc don\'t keep this doc\'s turn alive', async () => {
    h = await createHarness({ options: { turnIdleMs: 100 } })
    await intoTurn(h)
    const t0 = Date.now()
    const keep = setInterval(() => h!.agentRequest('status', 'other.md'), 20)
    try {
      await until(() => waiter(h!) === 'none', 1000)
    } finally {
      clearInterval(keep)
    }
    expect(Date.now() - t0).toBeLessThan(400)
  })

  it('a click in turn is latched; undelivered starts only once presence is none', async () => {
    h = await createHarness({ options: { turnIdleMs: 120, undeliveredMs: 60 } })
    await intoTurn(h)
    const r = await h.handoff({ message: 'next round' })
    expect(r.delivery).toBe('latched')
    await sleep(90)
    expect(handoffStates(h).some(([, s]) => s === 'undelivered')).toBe(false)
    await until(() => waiter(h!) === 'none', 1000)
    await until(() => handoffStates(h!).some(([s, st]) => s === r.seq && st === 'undelivered'), 1000)
  })
})

describe('restart grace (§8.5 "grace: ... a restart")', () => {
  it('restartGrace: every doc starts in grace for graceMs; a click is latched; the old loop reconnecting → connected', async () => {
    h = await createHarness({ options: { graceMs: 150, restartGrace: true } })
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'grace' })
    expect(h.module.presence('doc.md').graceUntil).toBeDefined()
    const r = await h.handoff()
    expect(r.delivery).toBe('latched')
    const w = await h.wait(W1)
    expect((await w.next('handoff')).event).toBe('handoff') // the reconnecting loop gets the latched click
    await w.cancel()
  })

  it('restartGrace with no loop coming back: grace lapses to none (broadcast), and only then the undelivered timer runs', async () => {
    h = await createHarness({ options: { graceMs: 100, restartGrace: true, undeliveredMs: 60 } })
    const r = await h.handoff()
    expect(r.delivery).toBe('latched')
    await until(() => waiter(h!) === 'none', 1000)
    expect(presenceEvents(h)).toContain('none')
    await until(() => handoffStates(h!).some(([s, st]) => s === r.seq && st === 'undelivered'), 1000)
  })

  it('defaults: on only when a predecessor marker exists when the module is built', async () => {
    h = await createHarness()
    expect(h.module.presence('doc.md')).toEqual({ waiter: 'none' }) // no server.json: a fresh start
    await h.serve() // writes server.json, as a running server would leave it
    await h.restart() // the successor sees the marker
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'grace' })
  })
})
