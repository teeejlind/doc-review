// tests/unit/handoff/t2-cli-activity.test.ts (fix pass T2 cli; QA_FINDINGS Pass 4 #14 and #15; CONTRACTS §8.5 "Claude activity").
//
// #14 A turn that only read the doc, edited it directly or sent a failed batch leaves no ack, so "Claude is working"
//     used to stay for ACTIVITY_IDLE_MS (15 min) even with the waiter connected. The skill ends every turn with
//     `mdr arm` (§9.9) and starts its loop after it, so an arm or a waiter connect now settles `working`.
// #15 A Send queued while a waiter was expected (`latched`, or pushed and never consumed) said "Queued for Claude"
//     forever once the grace lapsed with no loop. When presence becomes `none` the row turns into the paste row.
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserSseEvent, ClaudeActivity } from '../../../shared/types'
import { createActivityTracker } from '../../../server/handoff/activity'
import { createHarness, until, W1, type Harness } from './harness'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const activity = (h: Harness): ClaudeActivity => h.module.activity('doc.md')
const state = (h: Harness): ClaudeActivity['state'] => activity(h).state
const rows = (h: Harness): string[] =>
  h.broadcasts
    .filter((e): e is Extract<BrowserSseEvent, { event: 'claude-activity' }> => e.event === 'claude-activity')
    .map((e) => (e.data.state === 'waiting-pickup' ? `waiting-pickup:${e.data.delivery}` : e.data.state))
const comment = { seq: 1, id: 'e_1', type: 'comment.add', by: 'Claude', at: '', rev: 1, thread: 't_1', comment: 'c_1', anchor: { kind: 'doc' }, body: 'x' } as never

describe('#14 the turn ended without an ack (tracker)', () => {
  const tracker = (): { t: ReturnType<typeof createActivityTracker>; states: string[] } => {
    const states: string[] = []
    const t = createActivityTracker({ idleMs: 60_000, onChange: (_f, a) => states.push(a.state) })
    return { t, states }
  }

  it('working → idle, once', () => {
    const { t, states } = tracker()
    t.contentRequest('doc.md', 'snapshot')
    t.turnEnded('doc.md')
    t.turnEnded('doc.md')
    expect(t.get('doc.md').state).toBe('idle')
    expect(states).toEqual(['working', 'idle'])
    t.close()
  })

  it('moves nothing unless the doc is working: idle, waiting-pickup and replied stay as they are', () => {
    const { t, states } = tracker()
    t.turnEnded('doc.md')
    expect(states).toEqual([])
    t.events('doc.md', [comment])
    t.turnEnded('doc.md')
    expect(t.get('doc.md').state).toBe('replied')
    t.close()
  })

  it('a turn that began with a pending read puts back what that read replaced (replied stays replied)', () => {
    const { t } = tracker()
    t.events('doc.md', [comment])
    t.setUnread('doc.md', 1)
    t.contentRequest('doc.md', 'pending')
    expect(t.get('doc.md').state).toBe('working')
    t.turnEnded('doc.md')
    expect(t.get('doc.md')).toMatchObject({ state: 'replied', unreadFromClaude: 1 })
    t.close()
  })
})

describe('#14 the turn ended without an ack (module)', () => {
  it('a read-only turn (snapshot): working, then idle when the skill ends the turn with `mdr arm`', async () => {
    h = await createHarness()
    h.agentRequest('snapshot')
    expect(state(h)).toBe('working')
    await sleep(30)
    expect(state(h)).toBe('working') // nothing else moves it
    await h.arm()
    expect(state(h)).toBe('idle')
    expect(rows(h)).toEqual(['working', 'idle'])
  })

  it('a direct-edit turn (replace_block, no ack): working after the edit, idle after the arm, never "replied"', async () => {
    h = await createHarness()
    const store = await h.store()
    h.agentRequest('snapshot')
    const snap = await store.snapshot()
    h.agentRequest('batch')
    await store.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b2', rev: snap.rev }, markdown: 'First paragraph, tightened.' }] })
    await sleep(30)
    expect(state(h)).toBe('working')
    await h.arm()
    expect(state(h)).toBe('idle')
    expect(rows(h)).not.toContain('replied')
  })

  it('a failed batch (QUOTE_NOT_FOUND) is the same: working, then idle on the arm', async () => {
    h = await createHarness()
    const store = await h.store()
    h.agentRequest('batch')
    await expect(store.agent.batch({ ops: [{ op: 'comment', quote: 'a sentence that is not in the doc', body: 'x' }] })).rejects.toThrow()
    expect(state(h)).toBe('working')
    await h.arm()
    expect(state(h)).toBe('idle')
  })

  it('the waiter loop connecting is the same signal: working → idle at the connect, with the waiter then connected', async () => {
    h = await createHarness()
    h.agentRequest('snapshot')
    expect(state(h)).toBe('working')
    const w = await h.wait(W1)
    await w.next('armed')
    expect(state(h)).toBe('idle')
    expect(h.module.presence('doc.md')).toMatchObject({ waiter: 'connected' })
    // a later content request is working again, whatever the waiter does
    h.agentRequest('thread')
    expect(state(h)).toBe('working')
  })

  it('a Claude reply stays "replied" through the arm: the end of the turn is not the end of the news', async () => {
    h = await createHarness()
    const store = await h.store()
    await store.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'Overall: tighten the intro.' }] })
    await until(() => state(h!) === 'replied')
    await h.arm()
    expect(state(h)).toBe('replied')
  })

  it('an arm for another doc leaves this doc working', async () => {
    h = await createHarness()
    h.agentRequest('snapshot')
    await h.raw('POST', '/api/agent/arm', { file: 'other.md' })
    expect(state(h)).toBe('working')
  })

  it('the ack path still works and a content request after the arm is working again', async () => {
    h = await createHarness()
    await h.handoff()
    const store = await h.store()
    h.agentRequest('pending')
    const p = await store.agent.pending()
    await store.agent.batch({ ops: [], ack: p.cursor, ackSince: p.since })
    await until(() => state(h!) === 'idle')
    await h.arm()
    h.agentRequest('snapshot')
    expect(state(h)).toBe('working')
  })
})

describe('#15 a Send queued for a waiter that never comes', () => {
  // Presence going to `none` is what turns the row, however it got there; the tests below end the grace by disarm (no
  // timer to race on a loaded machine) except one, which lets the real grace run out with a margin to spare.
  it('latched in grace, then the grace lapses with no loop: the row becomes "waiting for the paste"', async () => {
    h = await createHarness({ options: { graceMs: 1_500 } })
    await h.arm()
    const r = await h.handoff()
    expect(r.delivery).toBe('latched')
    expect(activity(h)).toMatchObject({ state: 'waiting-pickup', delivery: 'latched' })
    await until(() => h!.module.presence('doc.md').waiter === 'none', 8_000)
    expect(activity(h)).toMatchObject({ state: 'waiting-pickup', delivery: 'clipboard' })
    expect(rows(h)).toEqual(['waiting-pickup:latched', 'waiting-pickup:clipboard'])
  })

  it('disarm (presence → none) turns a latched row into the paste row too', async () => {
    h = await createHarness()
    await h.arm()
    await h.handoff()
    expect(activity(h)).toMatchObject({ delivery: 'latched' })
    await h.disarm()
    expect(activity(h)).toMatchObject({ state: 'waiting-pickup', delivery: 'clipboard' })
  })

  it('the second click (the page now copies) answers clipboard and the badge says the same; nothing new is appended', async () => {
    h = await createHarness()
    await h.arm()
    const first = await h.handoff()
    await h.disarm()
    const second = await h.handoff({ clientDecision: 'clipboard' })
    expect(second).toMatchObject({ seq: first.seq, coalesced: true, delivery: 'clipboard' })
    expect(activity(h)).toMatchObject({ state: 'waiting-pickup', delivery: 'clipboard' })
    expect(h.events().filter((e) => e.type === 'handoff.sent')).toHaveLength(1)
  })

  it('a loop that connects after the lapse still gets the handoff: consumed → working', async () => {
    h = await createHarness()
    await h.arm()
    const r = await h.handoff()
    await h.disarm()
    expect(activity(h).delivery).toBe('clipboard')
    const w = await h.wait(W1)
    await w.next('handoff')
    await h.consume([r.seq], W1)
    expect(state(h)).toBe('working')
  })

  it('a waiter-pushed handoff that nobody consumed is not "Sent to Claude" once presence is none', async () => {
    h = await createHarness({ options: { turnIdleMs: 1_500 } })
    const w = await h.wait(W1)
    await w.next('armed')
    await h.handoff()
    await w.next('handoff')
    expect(rows(h)).toContain('waiting-pickup:waiter')
    await until(() => h!.module.presence('doc.md').waiter === 'none', 8_000)
    expect(activity(h)).toMatchObject({ state: 'waiting-pickup', delivery: 'clipboard' })
  })

  it('Claude is already on it (working): a presence lapse changes nothing', async () => {
    h = await createHarness()
    await h.arm()
    await h.handoff()
    h.agentRequest('pending')
    expect(state(h)).toBe('working')
    await h.disarm()
    expect(h.module.presence('doc.md').waiter).toBe('none')
    expect(state(h)).toBe('working')
  })

  it('a handoff sent while presence is already none is the paste row from the start (no extra row change)', async () => {
    h = await createHarness()
    await h.handoff({ clientDecision: 'clipboard' })
    expect(rows(h)).toEqual(['waiting-pickup:clipboard'])
  })
})
