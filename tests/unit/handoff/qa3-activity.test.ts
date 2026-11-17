// tests/unit/handoff/qa3-activity.test.ts (QA round 3, cli-handoff; CONTRACTS §8.5 "Claude activity", step 6).
//
// - An empty `pending` read ("Claude looked and found nothing") puts the badge back where it was; the skill ends the
//   turn without an ack on an empty read, so nothing else would clear "Claude is working" (up to 15 minutes).
// - A handoff Claude has picked up (activity left `waiting-pickup`) is never reported undelivered, however long the
//   turn runs: the pasted-prompt path has no waiter, so presence stays `none` and the timer would otherwise fire.
// - A Claude direct edit is not a reply: it never moves the badge to "Claude replied".
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserSseEvent, ClaudeActivity } from '../../../shared/types'
import { createActivityTracker } from '../../../server/handoff/activity'
import { createHarness, handoffStates, until, W1, type Harness } from './harness'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const state = (h: Harness): ClaudeActivity['state'] => h.module.activity('doc.md').state
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const activityStates = (h: Harness): string[] =>
  h.broadcasts.filter((e): e is Extract<BrowserSseEvent, { event: 'claude-activity' }> => e.event === 'claude-activity').map((e) => e.data.state)

describe('an empty pending read clears "working" (tracker)', () => {
  const tracker = (): { t: ReturnType<typeof createActivityTracker>; states: string[] } => {
    const states: string[] = []
    const t = createActivityTracker({ idleMs: 60_000, onChange: (_f, a) => states.push(a.state) })
    return { t, states }
  }
  const comment = { seq: 1, id: 'e_1', type: 'comment.add', by: 'Claude', at: '', rev: 1, thread: 't_1', comment: 'c_1', anchor: { kind: 'doc' }, body: 'x' } as never

  it('idle → pending → empty → idle', () => {
    const { t, states } = tracker()
    t.contentRequest('doc.md', 'pending')
    expect(t.get('doc.md').state).toBe('working')
    t.emptyPending('doc.md')
    expect(t.get('doc.md').state).toBe('idle')
    expect(states).toEqual(['working', 'idle'])
    t.close()
  })

  it('a pending read that found something stays working', () => {
    const { t } = tracker()
    t.contentRequest('doc.md', 'pending')
    t.close()
    expect(t.get('doc.md').state).toBe('working')
  })

  it('replied → pending → empty → back to replied, with the unread items kept', () => {
    const { t, states } = tracker()
    t.events('doc.md', [comment])
    t.setUnread('doc.md', 1)
    t.contentRequest('doc.md', 'pending')
    expect(t.get('doc.md').state).toBe('working')
    t.emptyPending('doc.md')
    expect(t.get('doc.md')).toMatchObject({ state: 'replied', unreadFromClaude: 1 })
    expect(states).toEqual(['replied', 'replied', 'working', 'replied'])
    // the restored replied state still ends on a covering read marker
    t.events('doc.md', [{ seq: 2, id: 'e_2', type: 'read-marker', by: 'TJ', at: '', rev: 1, thread: null, upTo: 1 } as never])
    expect(t.get('doc.md').state).toBe('idle')
    t.close()
  })

  it('a pending read made while Claude was already working is not undone by its empty result', () => {
    const { t } = tracker()
    t.contentRequest('doc.md', 'snapshot')
    t.contentRequest('doc.md', 'pending')
    t.emptyPending('doc.md')
    expect(t.get('doc.md').state).toBe('working')
    t.close()
  })

  it('a later content request means Claude kept going: a stale empty-pending result changes nothing', () => {
    const { t } = tracker()
    t.contentRequest('doc.md', 'pending')
    t.contentRequest('doc.md', 'snapshot')
    t.emptyPending('doc.md')
    expect(t.get('doc.md').state).toBe('working')
    t.close()
  })
})

describe('an empty pending read clears "working" (module)', () => {
  it('pendingServed(empty) after a pending request → idle, broadcast once; non-empty leaves working', async () => {
    h = await createHarness()
    h.agentRequest('pending')
    expect(state(h)).toBe('working')
    h.module.pendingServed?.('doc.md', false)
    expect(state(h)).toBe('working')
    h.module.pendingServed?.('doc.md', true)
    expect(state(h)).toBe('idle')
    expect(activityStates(h)).toEqual(['working', 'idle'])
  })

  it('an empty read of one doc does not touch another doc', async () => {
    h = await createHarness()
    h.agentRequest('pending')
    h.module.pendingServed?.('other.md', true)
    expect(state(h)).toBe('working')
  })
})

describe('undelivered never fires once Claude picked the handoff up (§8.5 step 6)', () => {
  it('pasted prompt: Claude reads pending, keeps working, never acks: no undelivered', async () => {
    h = await createHarness({ options: { undeliveredMs: 60 } })
    const r = await h.handoff({ clientDecision: 'clipboard' })
    expect(r.delivery).toBe('clipboard')
    expect(state(h)).toBe('waiting-pickup')
    h.agentRequest('pending') // the pasted prompt's first command
    expect(state(h)).toBe('working')
    for (let i = 0; i < 6; i++) {
      await sleep(40)
      h.agentRequest('snapshot') // a long turn: content requests, no ack
    }
    expect(handoffStates(h).some(([, s]) => s === 'undelivered')).toBe(false)
  })

  it('a click nobody picks up is still reported, and a second click after a pickup arms the timer again', async () => {
    h = await createHarness({ options: { undeliveredMs: 60 } })
    const first = await h.handoff({ clientDecision: 'clipboard' })
    await until(() => handoffStates(h!).some(([s, st]) => s === first.seq && st === 'undelivered'), 1000)
    h.agentRequest('pending') // picked up late: working
    await sleep(5) // the new click is strictly later than the pickup
    const second = await h.handoff({ clientDecision: 'clipboard', message: 'again' })
    expect(state(h)).toBe('waiting-pickup')
    await until(() => handoffStates(h!).some(([s, st]) => s === second.seq && st === 'undelivered'), 1000)
  })

  it('the timer that was armed before the pickup stays quiet; the ack still consumes the handoff', async () => {
    h = await createHarness({ options: { undeliveredMs: 80 } })
    const r = await h.handoff({ clientDecision: 'clipboard' })
    await sleep(20)
    h.agentRequest('pending')
    await sleep(160)
    expect(handoffStates(h).some(([, s]) => s === 'undelivered')).toBe(false)
    await h.consume([r.seq], W1)
    expect(handoffStates(h).some(([, s]) => s === 'consumed')).toBe(true)
  })
})

describe('a Claude direct edit is not a reply (§8.5 activity table)', () => {
  it('replace_block + ack in one batch leaves the badge idle (working → idle), not "Claude replied"', async () => {
    h = await createHarness()
    await h.handoff()
    const store = await h.store()
    h.agentRequest('pending')
    const p = await store.agent.pending()
    const snap = await store.snapshot()
    await store.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b2', rev: snap.rev }, markdown: 'First paragraph, tightened.' }], ack: p.cursor, ackSince: p.since })
    await until(() => state(h!) === 'idle')
    expect(activityStates(h)).not.toContain('replied')
  })

  it('an edit with no ack keeps the badge at "working"; a comment in the same batch still replies', async () => {
    h = await createHarness()
    const store = await h.store()
    h.agentRequest('batch')
    const snap = await store.snapshot()
    await store.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b2', rev: snap.rev }, markdown: 'First paragraph, again.' }] })
    await sleep(40)
    expect(state(h)).toBe('working')
    await store.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'Tightened the opening.' }] })
    await until(() => state(h!) === 'replied')
  })

  it('tracker: a Claude doc.edit alone does not enter replied', () => {
    const states: string[] = []
    const t = createActivityTracker({ idleMs: 60_000, onChange: (_f, a) => states.push(a.state) })
    t.events('doc.md', [{ seq: 1, id: 'e_1', type: 'doc.edit', by: 'Claude', at: '', rev: 2, source: 'cli', changes: [] } as never])
    expect(t.get('doc.md').state).toBe('idle')
    expect(states).toEqual([])
    t.close()
  })
})
