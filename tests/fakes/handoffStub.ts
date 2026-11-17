// tests/fakes/handoffStub.ts (integrator, day 0; CONTRACTS §2.2 "Handoff ↔ server", §2.4 stub table, §2.5, §8.5,
// §8.7, §12.10, D46, D48).
//
// A CreateHandoffModule<Hono> that fakeApp mounts through HandoffDeps exactly as P1's server/app.ts mounts P4's real
// module. It is the day-0 handoff floor plus a scriptable surface for P3's badge/toast specs:
//   - routes: POST /api/handoff, GET /api/agent/wait (waiter SSE), POST /api/agent/handoff/consume,
//     POST /api/agent/disarm, POST /api/agent/arm. Every handoff fact (round, at, message, consumed) is read from
//     store.handoffs() (D46), so nothing is lost across a fake restart over the same sidecar.
//   - presence: derived (connected while a waiter stream is open; grace for WAITER_GRACE_MS after a non-delivering
//     disconnect or an arm; turn after a delivering disconnect until the next connect, arm, disarm or TURN_IDLE_MS
//     without an agent request; else none) unless scripted with setPresence / POST /__test/presence.
//   - activity: the §8.5 table at face value (waiting-pickup → working → replied → idle) unless scripted with
//     setActivity / POST /__test/activity.
//   - delivery: §8.5 step 3 unless forced once with forceDelivery / POST /__test/delivery.
//   - testRoutes: POST /__test/presence, /__test/activity, /__test/delivery, /__test/handoff-state (the last emits SSE
//     `handoff { state }`). The real server never mounts these.
import { Hono } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import type {
  AgentRoute, ArmRouteResult, ClaudeActivity, DisarmResult, HandoffDeps, HandoffModule, HandoffPayload, HandoffRequest,
  HandoffResult, Presence, SidecarEvent, WaiterId, WaiterSseEvent,
} from '../../shared/types'
import { AGENT_CONTENT_ROUTES, CONSTANTS } from '../../shared/constants'
import { StoreError } from '../../shared/errors'
import { isWaiterId } from '../../shared/ids'
import { buildClipboardPrompt } from '../../shared/handoff-prompt'
import { HandoffRequestSchema } from '../../shared/schemas'
import type { FakeEnv } from './hono-env'

type Delivery = 'waiter' | 'latched' | 'clipboard'

export interface HandoffStubOptions {
  /** Waiter-stream heartbeat (§8.7). Default SSE_HEARTBEAT_MS. */
  heartbeatMs?: number
  graceMs?: number
  turnIdleMs?: number
  undeliveredMs?: number
  coalesceMs?: number
  activityIdleMs?: number
}

export interface HandoffStub extends HandoffModule<Hono<FakeEnv>> {
  /** Script presence for `file`; null returns to the derived value. Broadcasts `presence`. */
  setPresence(file: string, p: Presence | null): void
  /** Script activity for `file`; null returns to the derived value. Broadcasts `claude-activity`. */
  setActivity(file: string, a: ClaudeActivity | null): void
  /** Force the delivery of the next handoff (any file), once; null clears. */
  forceDelivery(d: Delivery | null): void
  /** Broadcast SSE `handoff { state }` (P3's toast specs). */
  emitHandoffState(file: string, state: 'sent' | 'latched' | 'consumed' | 'undelivered', o?: { seq?: number; delivery?: Delivery }): Promise<void>
  /** Number of open waiter streams for `file` (0 or 1). */
  waiterCount(file: string): number
  /** Send `server-shutdown { reason }` to every waiter stream and close them. */
  shutdown(reason: 'stop' | 'restart' | 'signal'): void
  /** The fake-only /__test/* routes. */
  readonly testRoutes: Hono<FakeEnv>
}

interface WaiterConn {
  id: WaiterId
  gen: number
  stream: SSEStreamingApi
  delivered: boolean
  closed: boolean
  queue: Promise<unknown>
}

interface FileState {
  scriptedPresence: Presence | null
  scriptedActivity: ClaudeActivity | null
  waiter: WaiterConn | null
  waiterSince: string | null
  graceUntil: number
  turn: boolean
  turnSince: string | null
  lastAgentAt: number
  activity: ClaudeActivity
  activityTimer: ReturnType<typeof setTimeout> | null
  undeliveredTimers: Map<number, ReturnType<typeof setTimeout>>
  lastDeliveredAt: number
  lastPresenceKey: string
}

const iso = (ms = Date.now()): string => new Date(ms).toISOString()

function testMs(name: string): number | undefined {
  if (process.env.MDR_TEST_HOOKS !== '1') return undefined
  const v = process.env[name]
  const n = v === undefined ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function createHandoffStub(deps: HandoffDeps, o: HandoffStubOptions = {}): HandoffStub {
  const heartbeatMs = o.heartbeatMs ?? testMs('MDR_TEST_HEARTBEAT_MS') ?? CONSTANTS.SSE_HEARTBEAT_MS
  const graceMs = o.graceMs ?? CONSTANTS.WAITER_GRACE_MS
  const turnIdleMs = o.turnIdleMs ?? testMs('MDR_TEST_TURN_IDLE_MS') ?? CONSTANTS.TURN_IDLE_MS
  const undeliveredMs = o.undeliveredMs ?? CONSTANTS.HANDOFF_UNDELIVERED_MS
  const coalesceMs = o.coalesceMs ?? CONSTANTS.HANDOFF_COALESCE_MS
  const activityIdleMs = o.activityIdleMs ?? CONSTANTS.ACTIVITY_IDLE_MS
  const files = new Map<string, FileState>()
  let forced: Delivery | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const unsubs: Array<() => void> = []

  const st = (file: string): FileState => {
    let s = files.get(file)
    if (!s) {
      s = {
        scriptedPresence: null, scriptedActivity: null, waiter: null, waiterSince: null, graceUntil: 0, turn: false,
        turnSince: null, lastAgentAt: Date.now(), activity: { file, state: 'idle', since: iso(), unreadFromClaude: 0 },
        activityTimer: null, undeliveredTimers: new Map(), lastDeliveredAt: 0, lastPresenceKey: '',
      }
      files.set(file, s)
    }
    return s
  }

  const later = (ms: number, fn: () => void): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    t.unref?.()
    timers.add(t)
    return t
  }

  function derivedPresence(file: string): Presence {
    const s = st(file)
    if (s.waiter && !s.waiter.closed) return { waiter: 'connected', waiterId: s.waiter.id, ...(s.waiterSince ? { since: s.waiterSince } : {}) }
    const now = Date.now()
    if (s.graceUntil > now) return { waiter: 'grace', graceUntil: iso(s.graceUntil) }
    if (s.turn && now - s.lastAgentAt < turnIdleMs) return { waiter: 'turn', ...(s.turnSince ? { since: s.turnSince } : {}) }
    return { waiter: 'none' }
  }

  function presence(file: string): Presence {
    return st(file).scriptedPresence ?? derivedPresence(file)
  }

  function activity(file: string): ClaudeActivity {
    const s = st(file)
    return s.scriptedActivity ?? s.activity
  }

  function broadcastPresence(file: string, force = false): void {
    const p = presence(file)
    const key = JSON.stringify(p)
    const s = st(file)
    if (!force && key === s.lastPresenceKey) return
    s.lastPresenceKey = key
    deps.broadcast(file, { event: 'presence', data: { ...p, file } })
  }

  /** Re-check presence after `ms` (grace / turn expiry). */
  function recheckPresence(file: string, ms: number): void {
    later(ms + 5, () => broadcastPresence(file))
  }

  function setActivityState(file: string, state: ClaudeActivity['state'], extra: { delivery?: Delivery } = {}): void {
    const s = st(file)
    const now = iso()
    const next: ClaudeActivity = {
      file, state, since: now, unreadFromClaude: s.activity.unreadFromClaude,
      ...(state === 'waiting-pickup' && extra.delivery ? { delivery: extra.delivery } : {}),
      ...(state === 'working' || s.activity.lastSeenAt ? { lastSeenAt: state === 'working' ? now : s.activity.lastSeenAt! } : {}),
    }
    s.activity = next
    if (s.activityTimer) clearTimeout(s.activityTimer)
    s.activityTimer = null
    if (state === 'working' || state === 'replied') {
      s.activityTimer = later(activityIdleMs, () => setActivityState(file, 'idle'))
    }
    if (!s.scriptedActivity) deps.broadcast(file, { event: 'claude-activity', data: next })
  }

  // ------------------------------------------------------------------ waiter streams (§8.7)

  function send(w: WaiterConn, e: WaiterSseEvent): Promise<unknown> {
    w.queue = w.queue.then(() => (w.closed ? undefined : w.stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) })))
    return w.queue
  }

  async function payloadFor(file: string, waiter: WaiterId): Promise<HandoffPayload | null> {
    const store = await deps.store(file)
    const pending = await store.handoffs({ unconsumed: true })
    if (!pending.length) return null
    await store.flushTjSession('agent-read')
    const snap = await store.snapshot()
    const newest = pending[pending.length - 1]!
    return {
      file, abs: store.abs, root: deps.root, port: deps.port, url: `http://127.0.0.1:${deps.port}/?file=${encodeURIComponent(file)}`,
      handoffs: pending.map((h) => ({ seq: h.seq, at: h.at, message: h.message })),
      round: newest.round, rev: snap.rev, counts: await deps.pendingCounts(file), waiter,
    }
  }

  async function deliver(file: string): Promise<boolean> {
    const s = st(file)
    const w = s.waiter
    if (!w || w.closed || w.delivered) return false
    const payload = await payloadFor(file, w.id)
    if (!payload) return false
    w.delivered = true
    s.lastDeliveredAt = Date.now()
    await send(w, { event: 'handoff', data: payload })
    return true
  }

  function closeWaiter(file: string, w: WaiterConn, how: 'delivered' | 'dropped' | 'disarmed' | 'superseded' | 'shutdown'): void {
    if (w.closed) return
    w.closed = true
    void w.queue.then(() => w.stream.close()).catch(() => undefined)
    const s = st(file)
    if (s.waiter !== w) return
    s.waiter = null
    s.waiterSince = null
    if (how === 'superseded') return
    if (how === 'disarmed' || how === 'shutdown') {
      s.turn = false
      s.graceUntil = 0
    } else if (w.delivered || how === 'delivered') {
      s.turn = true
      s.turnSince = iso()
      s.lastAgentAt = Date.now()
      recheckPresence(file, turnIdleMs)
    } else {
      s.graceUntil = Date.now() + graceMs
      recheckPresence(file, graceMs)
    }
    broadcastPresence(file)
  }

  // ------------------------------------------------------------------ store hooks

  unsubs.push(deps.onAgentRequest((file, route: AgentRoute) => {
    if (file === null) return
    const s = st(file)
    s.lastAgentAt = Date.now()
    if (s.turn) recheckPresence(file, turnIdleMs)
    if (AGENT_CONTENT_ROUTES.includes(route) && s.activity.state !== 'working') setActivityState(file, 'working')
  }))
  unsubs.push(deps.onSidecarAppended((file, events: SidecarEvent[]) => {
    const claudeContent = events.some((e) => e.by === 'Claude' && (e.type.startsWith('comment.') || e.type.startsWith('suggestion.')
      || e.type === 'thread.resolve' || e.type === 'thread.reopen' || e.type === 'doc.edit'))
    const s = st(file)
    if (claudeContent) {
      s.activity = { ...s.activity, unreadFromClaude: s.activity.unreadFromClaude + 1 }
      setActivityState(file, 'replied')
    } else if (events.some((e) => e.type === 'ack' && e.by === 'Claude') && s.activity.state === 'working') setActivityState(file, 'idle')
    if (events.some((e) => e.type === 'handoff.consumed') || events.some((e) => e.type === 'ack')) {
      for (const [seq, t] of s.undeliveredTimers) {
        clearTimeout(t)
        s.undeliveredTimers.delete(seq)
      }
    }
  }))

  // ------------------------------------------------------------------ routes

  const routes = new Hono<FakeEnv>()

  routes.post('/api/handoff', async (c) => {
    const file = c.get('file')!
    const parsed = HandoffRequestSchema.safeParse(c.get('body'))
    if (!parsed.success) throw new StoreError('BAD_REQUEST', `invalid HandoffRequest: ${parsed.error.issues[0]?.message ?? ''}`)
    const req: HandoffRequest = parsed.data as HandoffRequest
    const store = await deps.store(file)
    await store.flushTjSession('handoff')
    const s = st(file)
    const message = req.message === undefined || req.message === '' ? null : req.message
    const pending = await store.handoffs({ unconsumed: true })
    const last = pending[pending.length - 1]
    const recent = (await store.handoffs()).slice(-1)[0]
    const coalesceInto = last ?? (recent && Date.now() - s.lastDeliveredAt < coalesceMs && s.activity.state !== 'working' && s.activity.state !== 'replied' ? recent : undefined)
    const p0 = presence(file)
    const counts = await deps.pendingCounts(file)
    const promptFor = (round: number): string => buildClipboardPrompt({ file, abs: store.abs, root: deps.root, round, counts })
    if (coalesceInto && (message === null || message === coalesceInto.message)) {
      const out: HandoffResult = { ok: true, seq: coalesceInto.seq, coalesced: true, delivery: coalesceInto.delivery, prompt: promptFor(coalesceInto.round), presence: p0 }
      return c.json(out)
    }
    let delivery: Delivery
    if (forced) {
      delivery = forced
      forced = null
    } else if (req.clientDecision === 'clipboard') delivery = 'clipboard'
    else delivery = p0.waiter === 'connected' ? 'waiter' : p0.waiter === 'grace' || p0.waiter === 'turn' ? 'latched' : 'clipboard'
    const clientId = c.get('clientId')
    const { seq } = await store.appendEvents([{ type: 'handoff.sent', message, delivery }], clientId ? { clientId } : {})
    const rec = (await store.handoffs()).find((h) => h.seq === seq)
    setActivityState(file, 'waiting-pickup', { delivery })
    deps.broadcast(file, { event: 'handoff', data: { file, seq, state: delivery === 'latched' ? 'latched' : 'sent', delivery } })
    if (delivery === 'waiter') await deliver(file)
    s.undeliveredTimers.set(seq, later(undeliveredMs, async () => {
      s.undeliveredTimers.delete(seq)
      const still = (await store.handoffs({ unconsumed: true })).some((h) => h.seq === seq)
      const pnow = presence(file)
      if (still && pnow.waiter !== 'connected' && pnow.waiter !== 'turn') deps.broadcast(file, { event: 'handoff', data: { file, seq, state: 'undelivered', delivery } })
    }))
    const out: HandoffResult = { ok: true, seq, coalesced: false, delivery, prompt: promptFor(rec?.round ?? 1), presence: presence(file) }
    return c.json(out)
  })

  routes.get('/api/agent/wait', (c) => {
    const file = c.get('file')!
    const waiterQ = c.req.query('waiter') ?? ''
    if (!isWaiterId(waiterQ)) throw new StoreError('BAD_REQUEST', 'waiter must be w_ + 16 hex')
    const waiter: WaiterId = waiterQ
    const gen = Number(c.req.query('gen') ?? Date.now())
    return streamSSE(c, async (stream) => {
      const s = st(file)
      const w: WaiterConn = { id: waiter, gen: Number.isFinite(gen) ? gen : Date.now(), stream, delivered: false, closed: false, queue: Promise.resolve() }
      const old = s.waiter
      if (old && !old.closed) {
        if (old.id === w.id && w.gen < old.gen) {
          // same waiter, older generation: refused at once (D21)
          await send(w, { event: 'superseded', data: { by: old.id, reason: 'replaced' } })
          w.closed = true
          await stream.close()
          return
        }
        await send(old, { event: 'superseded', data: { by: w.id, reason: old.id === w.id ? 'replaced' : 'newer-waiter' } })
        closeWaiter(file, old, 'superseded')
      }
      s.waiter = w
      s.waiterSince = iso()
      s.graceUntil = 0
      s.turn = false
      broadcastPresence(file)
      const store = await deps.store(file)
      const undelivered = (await store.handoffs({ unconsumed: true })).map((h) => h.seq)
      await send(w, { event: 'armed', data: { waiter: w.id, file, undelivered } })
      if (undelivered.length) await deliver(file)
      const hb = setInterval(() => {
        if (!w.closed) w.queue = w.queue.then(() => stream.write(': hb\n\n'))
      }, heartbeatMs)
      hb.unref?.()
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve())
        const poll = setInterval(() => {
          if (w.closed) {
            clearInterval(poll)
            resolve()
          }
        }, 50)
        poll.unref?.()
        stream.onAbort(() => clearInterval(poll))
      })
      clearInterval(hb)
      closeWaiter(file, w, w.delivered ? 'delivered' : 'dropped')
    })
  })

  routes.post('/api/agent/handoff/consume', async (c) => {
    const file = c.get('file')!
    const body = (c.get('body') ?? {}) as { handoffs?: unknown; waiter?: unknown }
    if (!Array.isArray(body.handoffs) || !body.handoffs.every((x) => Number.isInteger(x))) throw new StoreError('BAD_REQUEST', 'handoffs must be an array of seqs')
    const waiter = typeof body.waiter === 'string' && isWaiterId(body.waiter) ? body.waiter : undefined
    const store = await deps.store(file)
    const open = new Set((await store.handoffs({ unconsumed: true })).map((h) => h.seq))
    const todo = (body.handoffs as number[]).filter((s) => open.has(s))
    if (!todo.length) return c.json({ ok: true, seq: (await store.snapshot()).seq })
    const r = await store.appendEvents([{ type: 'handoff.consumed', handoffs: todo, via: 'waiter', ...(waiter ? { waiter } : {}) }])
    for (const seq of todo) {
      const t = st(file).undeliveredTimers.get(seq)
      if (t) clearTimeout(t)
      st(file).undeliveredTimers.delete(seq)
      deps.broadcast(file, { event: 'handoff', data: { file, seq, state: 'consumed', delivery: 'waiter' } })
    }
    setActivityState(file, 'working')
    return c.json({ ok: true, seq: r.seq })
  })

  routes.post('/api/agent/disarm', (c) => {
    const file = c.get('file')!
    const s = st(file)
    const w = s.waiter
    const disarmed = !!w && !w.closed
    if (w && !w.closed) {
      void send(w, { event: 'disarmed', data: { file } })
      closeWaiter(file, w, 'disarmed')
    } else {
      s.turn = false
      s.graceUntil = 0
      broadcastPresence(file)
    }
    const out: DisarmResult = { ok: true, file, disarmed }
    return c.json(out)
  })

  routes.post('/api/agent/arm', (c) => {
    const file = c.get('file')!
    const s = st(file)
    const p = derivedPresence(file)
    if (p.waiter !== 'connected') {
      s.turn = false
      s.graceUntil = Date.now() + graceMs
      recheckPresence(file, graceMs)
      broadcastPresence(file)
    }
    const out: ArmRouteResult = { ok: true, presence: presence(file) }
    return c.json(out)
  })

  // ------------------------------------------------------------------ fake-only test routes (§2.5)

  const testRoutes = new Hono<FakeEnv>()
  const fileOf = (c: { req: { query(k: string): string | undefined }; get(k: 'body'): unknown }): string => {
    const f = c.req.query('file') ?? (c.get('body') as { file?: unknown } | undefined)?.file
    if (typeof f !== 'string' || f === '') throw new StoreError('BAD_REQUEST', 'pass ?file=')
    return f
  }
  const strip = (b: unknown): Record<string, unknown> => {
    const { file: _f, ...rest } = (b ?? {}) as Record<string, unknown>
    return rest
  }

  testRoutes.post('/__test/presence', (c) => {
    const file = fileOf(c)
    const body = c.get('body')
    stub.setPresence(file, body === null || c.req.query('reset') === '1' ? null : (strip(body) as unknown as Presence))
    return c.json({ ok: true, presence: presence(file) })
  })
  testRoutes.post('/__test/activity', (c) => {
    const file = fileOf(c)
    const body = c.get('body')
    stub.setActivity(file, body === null || c.req.query('reset') === '1' ? null : ({ file, ...strip(body) } as unknown as ClaudeActivity))
    return c.json({ ok: true, activity: activity(file) })
  })
  testRoutes.post('/__test/delivery', (c) => {
    const d = (c.get('body') as { delivery?: unknown } | null)?.delivery
    if (d !== null && d !== 'waiter' && d !== 'latched' && d !== 'clipboard') throw new StoreError('BAD_REQUEST', 'delivery must be waiter | latched | clipboard | null')
    stub.forceDelivery(d)
    return c.json({ ok: true, delivery: d })
  })
  testRoutes.post('/__test/handoff-state', async (c) => {
    const file = fileOf(c)
    const b = (c.get('body') ?? {}) as { state?: unknown; seq?: unknown; delivery?: unknown }
    if (b.state !== 'sent' && b.state !== 'latched' && b.state !== 'consumed' && b.state !== 'undelivered') throw new StoreError('BAD_REQUEST', 'state must be sent | latched | consumed | undelivered')
    await stub.emitHandoffState(file, b.state, {
      ...(typeof b.seq === 'number' ? { seq: b.seq } : {}),
      ...(b.delivery === 'waiter' || b.delivery === 'latched' || b.delivery === 'clipboard' ? { delivery: b.delivery } : {}),
    })
    return c.json({ ok: true })
  })

  const stub: HandoffStub = {
    routes,
    testRoutes,
    presence,
    activity,
    setPresence(file, p) {
      st(file).scriptedPresence = p
      broadcastPresence(file, true)
    },
    setActivity(file, a) {
      const s = st(file)
      s.scriptedActivity = a
      deps.broadcast(file, { event: 'claude-activity', data: activity(file) })
    },
    forceDelivery(d) {
      forced = d
    },
    async emitHandoffState(file, state, eo = {}) {
      let seq = eo.seq
      if (seq === undefined) {
        const store = await deps.store(file)
        seq = (await store.handoffs()).slice(-1)[0]?.seq ?? 0
      }
      deps.broadcast(file, { event: 'handoff', data: { file, seq, state, delivery: eo.delivery ?? 'waiter' } })
    },
    waiterCount: (file) => (st(file).waiter && !st(file).waiter!.closed ? 1 : 0),
    shutdown(reason) {
      for (const [file, s] of files) {
        const w = s.waiter
        if (!w || w.closed) continue
        void send(w, { event: 'server-shutdown', data: { reason } })
        closeWaiter(file, w, 'shutdown')
      }
    },
    async close() {
      stub.shutdown('stop')
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const s of files.values()) {
        if (s.activityTimer) clearTimeout(s.activityTimer)
        for (const t of s.undeliveredTimers.values()) clearTimeout(t)
      }
      for (const u of unsubs) u()
    },
  }
  return stub
}
