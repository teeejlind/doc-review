// tests/unit/handoff/activity.test.ts (P4; CONTRACTS §8.5 "Claude activity").
//
// Control requests (including arm) never move the state; content requests → working; Claude-initiated markup →
// replied even with no prior send; an ack-only commit → idle; a TJ read-marker covering Claude's items → idle;
// handoff.sent → waiting-pickup carrying its delivery; consumption → working; idle timeout.
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRoute, BrowserSseEvent, ClaudeActivity } from '../../../shared/types'
import { createActivityTracker } from '../../../server/handoff/activity'
import { createHarness, until, W1, type Harness } from './harness'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const state = (h: Harness): ClaudeActivity['state'] => h.module.activity('doc.md').state
const activityEvents = (h: Harness): string[] =>
  h.broadcasts.filter((e): e is Extract<BrowserSseEvent, { event: 'claude-activity' }> => e.event === 'claude-activity').map((e) => e.data.state)

describe('Claude activity (§8.5)', () => {
  it('control requests never move the state (status, open, policy, wait, consume, disarm, shutdown, arm)', async () => {
    h = await createHarness()
    const control: AgentRoute[] = ['status', 'open', 'policy', 'wait', 'consume', 'disarm', 'shutdown', 'arm']
    for (const r of control) h.agentRequest(r)
    await h.arm()
    const w = await h.wait(W1)
    await w.next('armed')
    await h.disarm()
    expect(state(h)).toBe('idle')
    expect(activityEvents(h)).toEqual([])
  })

  it('content requests (pending, snapshot, thread, history, batch) → working, with lastSeenAt', async () => {
    for (const r of ['pending', 'snapshot', 'thread', 'history', 'batch'] as const) {
      h = await createHarness()
      h.agentRequest(r)
      expect(h.module.activity('doc.md')).toMatchObject({ state: 'working', lastSeenAt: expect.any(String) })
      await h.close()
      h = null
    }
  })

  it('handoff.sent → waiting-pickup with that delivery; consumed → working; a coalesced click moves nothing', async () => {
    h = await createHarness()
    const r = await h.handoff()
    expect(h.module.activity('doc.md')).toMatchObject({ state: 'waiting-pickup', delivery: 'clipboard' })
    const n = activityEvents(h).length
    await h.handoff() // coalesced
    expect(activityEvents(h).length).toBe(n)
    await h.consume([r.seq], W1)
    expect(state(h)).toBe('working')
  })

  it('Claude-initiated markup with no prior send → replied, counting unread; a covering read-marker → idle', async () => {
    h = await createHarness()
    const store = await h.store()
    const res = await store.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'Overall: tighten the intro.' }] })
    await until(() => state(h!) === 'replied')
    await until(() => h!.module.activity('doc.md').unreadFromClaude === 1)
    const thread = res.results[0]!.thread!
    await store.tj.readMarker({ thread, upTo: res.seq })
    await until(() => state(h!) === 'idle')
  })

  it('a per-thread read-marker covers only that thread\'s items', async () => {
    h = await createHarness()
    const store = await h.store()
    const a = await store.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'A' }] })
    const b = await store.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'B' }] })
    await until(() => state(h!) === 'replied')
    await store.tj.readMarker({ thread: a.results[0]!.thread!, upTo: b.seq })
    await new Promise((r) => setTimeout(r, 20))
    expect(state(h)).toBe('replied')
    await store.tj.readMarker({ thread: null, upTo: b.seq })
    await until(() => state(h!) === 'idle')
  })

  it('working + an ack-only commit ("nothing new") → idle', async () => {
    h = await createHarness()
    await h.handoff()
    const store = await h.store()
    h.agentRequest('pending')
    const p = await store.agent.pending()
    expect(state(h)).toBe('working')
    await store.agent.batch({ ops: [], ack: p.cursor, ackSince: p.since })
    await until(() => state(h!) === 'idle')
  })

  it('working + a commit with Claude content → replied (with the ack in the same batch)', async () => {
    h = await createHarness()
    await h.handoff()
    const store = await h.store()
    h.agentRequest('pending')
    const p = await store.agent.pending()
    await store.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'Done.' }], ack: p.cursor, ackSince: p.since })
    await until(() => state(h!) === 'replied')
  })

  it('working and replied lapse to idle after idleMs with no content request; waiting-pickup never times out', async () => {
    h = await createHarness({ options: { activityIdleMs: 60 } })
    h.agentRequest('snapshot')
    expect(state(h)).toBe('working')
    await until(() => state(h!) === 'idle', 1000)
    await h.handoff()
    await new Promise((r) => setTimeout(r, 120))
    expect(state(h)).toBe('waiting-pickup')
  })
})

describe('activity tracker unit: events are processed once each, by seq', () => {
  it('replaying the same events moves nothing', () => {
    const changes: string[] = []
    const t = createActivityTracker({ idleMs: 10_000, onChange: (_f, a) => changes.push(a.state) })
    const ev = { seq: 5, id: 'e_1', type: 'comment.add', by: 'Claude', at: '', rev: 1, thread: 't_1', comment: 'c_1', anchor: { kind: 'doc' }, body: 'x' } as const
    t.events('doc.md', [ev as never])
    t.events('doc.md', [ev as never])
    expect(changes).toEqual(['replied'])
    t.close()
  })
})
