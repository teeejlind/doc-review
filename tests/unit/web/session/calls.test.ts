// tests/unit/web/session/calls.test.ts (P2). The rest of the DocSession surface over MockTransport + fakeApp:
// read markers (CONTRACTS §12.9: throttled per thread, never below the server cursor), Send to Claude (§12.10: the
// clipboard is written synchronously inside the gesture when no waiter listens; the outcome says what the gesture
// did), thread ops retrying a network failure with the SAME opKey (§12.3), SSE presence / handoff / navigate, and
// connectRootChannel for an empty-state tab (§12.0.1).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateThreadRequest, HandoffRequest, ReadMarkerRequest, ThreadId } from '../../../../shared/types'
import { buildClipboardPrompt } from '../../../../shared/handoff-prompt'
import { ReadMarkerThrottle } from '../../../../web/src/session/readMarkers'
import { connectRootChannel } from '../../../../web/src/session/rootChannel'
import { isSessionError } from '../../../../web/src/session/errors'
import { bodiesTo, fixture, TestPort, tick, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n'
const T1 = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R1' as ThreadId
const T2 = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R2' as ThreadId

let fx: Fixture | null = null
afterEach(async () => {
  vi.useRealTimers()
  await fx?.close()
  fx = null
})

describe('ReadMarkerThrottle (§12.9)', () => {
  it('sends at most once per READ_MARK_THROTTLE_MS per thread, keeping the highest upTo for the end of the window', () => {
    vi.useFakeTimers()
    const sent: Array<[ThreadId | null, number]> = []
    const known = new Map<string, number>()
    const t = new ReadMarkerThrottle({ send: (th, u) => sent.push([th, u]), known: (th) => known.get(th ?? '') ?? 0, now: () => Date.now() })
    t.mark(T1, 5)
    t.mark(T1, 7)
    t.mark(T1, 6)
    t.mark(T2, 3)
    t.mark(null, 9)
    expect(sent).toEqual([[T1, 5], [T2, 3], [null, 9]])
    vi.advanceTimersByTime(9_999)
    expect(sent).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(sent).toEqual([[T1, 5], [T2, 3], [null, 9], [T1, 7]])
    t.close()
  })

  it('never sends a marker at or below what the server already holds', () => {
    vi.useFakeTimers()
    const sent: number[] = []
    const t = new ReadMarkerThrottle({ send: (_t, u) => sent.push(u), known: () => 10, now: () => Date.now() })
    t.mark(T1, 4)
    t.mark(T1, 10)
    expect(sent).toEqual([])
    t.mark(T1, 11)
    expect(sent).toEqual([11])
    t.close()
  })

  it('the session posts POST /api/read-marker { thread, upTo } and refreshes the review', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    await fx.agent([{ op: 'comment', doc: true, body: 'Unread from Claude.' }])
    const { session, transport } = await fx.open({})
    const th = session.getReview().threads[0]!
    expect(th.unread).toBe(1)
    session.markRead(th.id, th.lastSeq)
    await until(() => session.getReview().threads[0]!.unread === 0, 3_000, 'unread cleared')
    expect(bodiesTo<ReadMarkerRequest>(transport, '/api/read-marker')).toEqual([{ thread: th.id, upTo: th.lastSeq }])
  })
})

describe('Send to Claude (§12.10)', () => {
  it('no waiter: the prompt is copied synchronously inside the gesture; outcome clipboard/copied', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const writes: string[] = []
    const { session, transport } = await fx.open({ env: { clipboard: () => ({ writeText: async (s) => void writes.push(s) }) } })
    expect(session.getReview().presence.waiter).toBe('none')
    const p = session.handoff('Please look at the intro.')
    // before any await: the clipboard write already happened
    expect(writes).toEqual([buildClipboardPrompt({ file: DOC, abs: session.getSnapshot().abs, root: fx.boot.root, round: null })])
    const out = await p
    expect(out).toMatchObject({ clientDecision: 'clipboard', copied: true, delivery: 'clipboard' })
    expect(bodiesTo<HandoffRequest>(transport, '/api/handoff')[0]).toMatchObject({ clientDecision: 'clipboard', message: 'Please look at the intro.' })
    expect(bodiesTo<HandoffRequest>(transport, '/api/handoff')[0]!.opKey).toMatch(/^op_/)
  })

  it('a waiter listens: nothing is copied; outcome waiter/not copied', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const writes: string[] = []
    const { session, transport } = await fx.open({ env: { clipboard: () => ({ writeText: async (s) => void writes.push(s) }) } })
    await until(() => transport.openStreamCount() === 1)
    await transport.request('POST', `/__test/presence?file=${DOC}`, { waiter: 'connected', waiterId: 'w_0123456789abcdef' })
    await until(() => session.getReview().presence.waiter === 'connected', 3_000, 'presence event')
    const out = await session.handoff()
    expect(writes).toEqual([])
    expect(out).toMatchObject({ clientDecision: 'waiter', copied: false })
    expect(bodiesTo<HandoffRequest>(transport, '/api/handoff')[0]).toMatchObject({ clientDecision: 'waiter' })
    expect('message' in bodiesTo<HandoffRequest>(transport, '/api/handoff')[0]!).toBe(false)
  })

  it('a refused clipboard write reports copied: false; a dirty editor is flushed before POST /api/handoff', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port, env: { clipboard: () => ({ writeText: async () => { throw new Error('denied') } }) } })
    port.setText(1, 'Edited right before Send.')
    const out = await session.handoff()
    expect(out).toMatchObject({ clientDecision: 'clipboard', copied: false })
    const w = transport.requests.filter((r) => r.method === 'POST').map((r) => r.path.split('?')[0])
    expect(w.indexOf('/api/save')).toBeLessThan(w.indexOf('/api/handoff'))
    expect(fx.root.read(DOC)).toContain('Edited right before Send.')
  })

  it('server unreachable: rejects at once; the in-gesture copy still happened', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const writes: string[] = []
    const { session, transport } = await fx.open({ env: { clipboard: () => ({ writeText: async (s) => void writes.push(s) }) } })
    transport.failNext('network-error')
    const t0 = Date.now()
    const err = await session.handoff().catch((e: unknown) => e)
    expect(isSessionError(err) && err.network).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(writes).toHaveLength(1)
    // §12.10 step 6 (P3 merge): the rejection says what the gesture did
    expect(err).toMatchObject({ clientDecision: 'clipboard', copied: true })
  })

  it('server unreachable with a waiter known: the rejection reports nothing copied (P3 merge)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const writes: string[] = []
    const { session, transport } = await fx.open({ env: { clipboard: () => ({ writeText: async (s) => void writes.push(s) }) } })
    await until(() => transport.openStreamCount() === 1)
    await transport.request('POST', `/__test/presence?file=${DOC}`, { waiter: 'connected', waiterId: 'w_0123456789abcdef' })
    await until(() => session.getReview().presence.waiter === 'connected', 3_000, 'presence event')
    transport.failNext('network-error')
    const err = await session.handoff().catch((e: unknown) => e)
    expect(isSessionError(err) && err.network).toBe(true)
    expect(err).toMatchObject({ clientDecision: 'waiter', copied: false })
    expect(writes).toEqual([])
  })

  it('SSE handoff { state } is kept for the undelivered toast and notifies "handoff"; copyPrompt copies round-less', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const writes: string[] = []
    const { session, transport } = await fx.open({ env: { clipboard: () => ({ writeText: async (s) => void writes.push(s) }) } })
    await until(() => transport.openStreamCount() === 1)
    const seen: string[] = []
    session.subscribe((w) => seen.push(w))
    await transport.request('POST', `/__test/handoff-state?file=${DOC}`, { state: 'undelivered', seq: 3, delivery: 'clipboard' })
    await until(() => session.getLastHandoffEvent()?.state === 'undelivered', 3_000, 'handoff event')
    expect(seen).toContain('handoff')
    expect(await session.copyPrompt()).toBe(true)
    expect(writes).toEqual([buildClipboardPrompt({ file: DOC, abs: session.getSnapshot().abs, root: fx.boot.root, round: null })])
  })
})

describe('thread ops (§12.3)', () => {
  it('a network failure is retried with the same opKey (it may have landed)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const { session, transport } = await fx.open({})
    transport.failNext('network-error')
    const r = await session.createThread({ kind: 'doc' }, 'Retried once.')
    expect(r.ok).toBe(true)
    const sent = bodiesTo<CreateThreadRequest>(transport, '/api/threads')
    expect(sent).toHaveLength(2)
    expect(sent[1]!.opKey).toBe(sent[0]!.opKey)
    expect(session.getReview().threads.filter((t) => t.messages.some((m) => m.body === 'Retried once.'))).toHaveLength(1)
  })

  it('every user action mints a fresh opKey', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const { session, transport } = await fx.open({})
    await session.createThread({ kind: 'doc' }, 'One.')
    await session.createThread({ kind: 'doc' }, 'Two.')
    const [a, b] = bodiesTo<CreateThreadRequest>(transport, '/api/threads')
    expect(a!.opKey).not.toBe(b!.opKey)
  })
})

describe('navigation (§12.0.3) and the root channel (§12.0.1)', () => {
  it('SSE navigate reaches onNavigate subscribers', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const { session, transport } = await fx.open({})
    await until(() => transport.openStreamCount() === 1)
    const got: string[] = []
    session.onNavigate((f) => got.push(f))
    transport.emit({ event: 'navigate', data: { file: 'other.md' } })
    await tick(10)
    expect(got).toEqual(['other.md'])
  })

  it('connectRootChannel opens /api/events without a file, surfaces navigate, and close() closes it', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const transport = fx.transport()
    const ch = connectRootChannel({ ...fx.boot, file: null }, transport)
    await until(() => transport.openStreamCount() === 1)
    const q = new URLSearchParams(transport.streams[0]!.path.split('?')[1])
    expect(transport.streams[0]!.path.startsWith('/api/events?')).toBe(true)
    expect(q.has('file')).toBe(false)
    expect(q.get('clientId')).toBe(fx.clientId)
    const got: string[] = []
    ch.onNavigate((f) => got.push(f))
    transport.emit({ event: 'navigate', data: { file: 'next.md' } })
    await tick(10)
    expect(got).toEqual(['next.md'])
    ch.close()
    expect(transport.streams.every((s) => s.closed())).toBe(true)
  })
})
