// tests/unit/handoff/waiter-gen.test.ts (P4; CONTRACTS §8.7 step 1, §9.8.3, D21, §13 #52, #78).
//
// One live waiter per doc, and the same-id generation rule: a higher gen replaces (the old stream hears
// superseded { reason: 'replaced' }), a lower gen is refused at once, the same gen (a self-reconnect after a drop)
// replaces silently, and a different id supersedes with reason 'newer-waiter'.
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, W1, W2, type Harness } from './harness'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

describe('waiter generations (D21)', () => {
  it('same id, higher gen: replaces, and the old stream gets superseded { by: id, reason: replaced } then ends', async () => {
    h = await createHarness()
    const old = await h.wait(W1, 100)
    await old.next('armed')
    const fresh = await h.wait(W1, 200)
    await fresh.next('armed')
    expect((await old.next('superseded')).data).toEqual({ by: W1, reason: 'replaced' })
    await old.ended$
    expect(fresh.ended).toBe(false)
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'connected', waiterId: W1 })
  })

  it('same id, lower gen: refused at once (the NEW stream gets superseded replaced); the live one stays', async () => {
    h = await createHarness()
    const live = await h.wait(W1, 200)
    await live.next('armed')
    const stale = await h.wait(W1, 100)
    expect((await stale.next('superseded')).data).toEqual({ by: W1, reason: 'replaced' })
    await stale.ended$
    expect(stale.events.map((e) => e.event)).toEqual(['superseded'])
    expect(live.ended).toBe(false)
    expect(live.events.map((e) => e.event)).toEqual(['armed'])
    // a handoff still reaches the live stream
    const r = await h.handoff()
    expect(r.delivery).toBe('waiter')
    await live.next('handoff')
  })

  it('same id and gen (a self-reconnect after a drop): replaces silently, no superseded event', async () => {
    h = await createHarness()
    const halfOpen = await h.wait(W1, 300)
    await halfOpen.next('armed')
    const again = await h.wait(W1, 300)
    await again.next('armed')
    await halfOpen.ended$
    expect(halfOpen.events.map((e) => e.event)).toEqual(['armed'])
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'connected', waiterId: W1 })
  })

  it('a different id supersedes with reason newer-waiter, whatever its gen', async () => {
    h = await createHarness()
    const a = await h.wait(W1, 500)
    await a.next('armed')
    const b = await h.wait(W2, 1)
    await b.next('armed')
    expect((await a.next('superseded')).data).toEqual({ by: W2, reason: 'newer-waiter' })
    await a.ended$
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'connected', waiterId: W2 })
  })

  it('a malformed waiter id or gen is BAD_REQUEST', async () => {
    h = await createHarness()
    expect((await h.raw('GET', '/api/agent/wait?file=doc.md&waiter=w_nothex&gen=1')).status).toBe(400)
    expect((await h.raw('GET', `/api/agent/wait?file=doc.md&waiter=${W1}&gen=abc`)).status).toBe(400)
  })

  it('the stream carries a heartbeat comment every heartbeatMs', async () => {
    h = await createHarness({ options: { heartbeatMs: 20 } })
    const w = await h.wait(W1)
    await w.next('armed')
    await new Promise((r) => setTimeout(r, 90))
    expect(w.heartbeats).toBeGreaterThanOrEqual(2)
  })
})
