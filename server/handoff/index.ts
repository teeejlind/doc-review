// server/handoff/index.ts (P4). The handoff module P1's server/app.ts mounts through HandoffDeps (CONTRACTS §8.5,
// §8.7, §9.10, §2.2 seam "Handoff ↔ server", D21, D25, D46, D48).
//
// State: every handoff fact (at, message, delivery, round, consumed) is read from store.handoffs() (D46), so a module
// restarted over the same sidecar computes the same payload, round and coalescing decision. The module itself keeps
// only timers, presence, activity and the live waiter streams.
//
// - POST /api/handoff: flush the TJ session ('handoff'); coalesce into an unconsumed handoff, or one delivered
//   < coalesceMs ago with no Claude activity since, when the message is empty or the same; else pick the delivery
//   (clipboard when the browser already copied; waiter when one is connected; latched in grace / turn; else
//   clipboard), append handoff.sent BEFORE delivering (the durable latch), push to the connected waiter, broadcast
//   SSE `handoff`, and arm the undelivered timer. `prompt` = buildClipboardPrompt with the record's round and
//   pendingCounts after the flush.
// - Waiter streams (§8.7): one live waiter per doc with the same-id gen rule (registry.ts); `armed { undelivered }`,
//   then every unconsumed handoff in ONE `handoff` payload (TJ session flushed first, counts after the flush, round of
//   the newest). A connected waiter never sits on an unconsumed handoff: a handoff sent while one is connected is
//   pushed at once whatever its delivery label. Delivering detaches the stream and moves presence to `turn`.
// - Consumed = handoff.consumed covering the seq, or a Claude ack with upTo >= seq (the fold rule); either one
//   broadcasts SSE `handoff { state: 'consumed' }` and stops the undelivered timer.
// - Undelivered: a handoff still unconsumed undeliveredMs after it was sent or after presence last became `none`
//   (whichever is later) → SSE `handoff { state: 'undelivered' }`, once per `none` period. The timer runs only while
//   presence is `none`, so a click during a long Claude turn never reports undelivered while the turn runs.
// `shutdown(reason)` (beyond HandoffModule; see contract-changes/P4.md) sends server-shutdown { reason } to every open
// waiter stream so a restart makes `wait` reconnect while a stop makes it exit 10.
// Restart grace (§8.5 "grace: ... a restart"): when the predecessor's server.json survived (only `stop` removes it; P1
// writes the new marker after the module is built), every doc starts in `grace` for WAITER_GRACE_MS, so a click while
// the previous process's loop is reconnecting is latched rather than offered as a clipboard prompt.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import type {
  AgentRoute, ArmRouteResult, ClaudeActivity, CreateHandoffModule, DisarmResult, DocStore, HandoffDeps, HandoffModule,
  HandoffPayload, HandoffRecord, HandoffRequest, HandoffResult, PendingCounts, Presence, SidecarEvent, TjCtx, WaiterId,
} from '../../shared/types'
import { AGENT_CONTENT_ROUTES, CONSTANTS } from '../../shared/constants'
import { buildClipboardPrompt } from '../../shared/handoff-prompt'
import { mdrCmd } from '../../node/config'
import { nameForAgent } from '../../node/identity'
import { createActivityTracker, isClaudeContent, isClaudeWork, type ActivityTracker } from './activity'
import { createPresenceTracker, type PresenceTracker } from './presence'
import { openWaiterStream, WaiterRegistry, type CloseCause, type WaiterConn } from './registry'
import { handoffRoutes, normFile } from './routes'

type Delivery = 'waiter' | 'latched' | 'clipboard'

export interface HandoffModuleOptions {
  /** Waiter-stream heartbeat (§8.7). Default MDR_TEST_HEARTBEAT_MS under test hooks, else SSE_HEARTBEAT_MS. */
  heartbeatMs?: number
  /** Default MDR_TEST_GRACE_MS under test hooks, else WAITER_GRACE_MS. */
  graceMs?: number
  /** Default MDR_TEST_TURN_IDLE_MS under test hooks, else TURN_IDLE_MS. */
  turnIdleMs?: number
  /** Default MDR_TEST_UNDELIVERED_MS under test hooks, else HANDOFF_UNDELIVERED_MS. */
  undeliveredMs?: number
  coalesceMs?: number
  activityIdleMs?: number
  /** Start every doc in `grace` for graceMs (restart grace). Default: true iff <root>/.review/server.json exists now. */
  restartGrace?: boolean
}

export interface P4HandoffModule extends HandoffModule<Hono> {
  /**
   * server-shutdown { reason } to every open waiter stream, then close each once its queue has drained (<= 250 ms), so
   * a `stop` reaches the `wait` (exit 10) instead of looking like a drop. RunningServer.close calls it first and then
   * awaits close(), which waits for this.
   */
  shutdown(reason: 'stop' | 'restart' | 'signal'): Promise<void>
}

const ZERO_COUNTS: PendingCounts = { threads: 0, messages: 0, suggestions: 0, decisions: 0, resolves: 0, edits: 0, external: 0, notices: 0, handoffs: 0 }

function testMs(name: string): number | undefined {
  if (process.env.MDR_TEST_HOOKS !== '1') return undefined
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

interface FileState {
  /** When a handoff was last pushed to a waiter, the newest seq it carried, and the Claude-activity tick then. */
  lastDelivery: { at: number; seq: number; tick: number } | null
  /** Bumped on every Claude content request or Claude content commit (ordering without clock ties). */
  claudeTick: number
  /** When Claude last made a content request or committed a reply or edit for the doc (ms); 0 = since this process started, never. */
  lastClaudeAt: number
  /** Unconsumed seqs as last seen, for `consumed` broadcasts. */
  knownUnconsumed: Map<number, Delivery>
  undeliveredTimer: ReturnType<typeof setTimeout> | null
  /** seq → the noneSince of the `none` period it was reported undelivered in. */
  reportedUndelivered: Map<number, number>
}

export class HandoffCore {
  readonly presence: PresenceTracker
  readonly activity: ActivityTracker
  readonly registry = new WaiterRegistry()
  private readonly open = new Set<WaiterConn>()
  private readonly files = new Map<string, FileState>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly unsubs: Array<() => void> = []
  private readonly heartbeatMs: number
  private readonly undeliveredMs: number
  private readonly coalesceMs: number
  private closed = false

  constructor(readonly deps: HandoffDeps, o: HandoffModuleOptions = {}) {
    this.heartbeatMs = o.heartbeatMs ?? testMs('MDR_TEST_HEARTBEAT_MS') ?? CONSTANTS.SSE_HEARTBEAT_MS
    this.undeliveredMs = o.undeliveredMs ?? testMs('MDR_TEST_UNDELIVERED_MS') ?? CONSTANTS.HANDOFF_UNDELIVERED_MS
    this.coalesceMs = o.coalesceMs ?? CONSTANTS.HANDOFF_COALESCE_MS
    const graceMs = o.graceMs ?? testMs('MDR_TEST_GRACE_MS') ?? CONSTANTS.WAITER_GRACE_MS
    const restartGrace = o.restartGrace ?? existsSync(join(deps.root, '.review', 'server.json'))
    this.presence = createPresenceTracker({
      graceMs,
      ...(restartGrace ? { initialGraceUntil: Date.now() + graceMs } : {}),
      turnIdleMs: o.turnIdleMs ?? testMs('MDR_TEST_TURN_IDLE_MS') ?? CONSTANTS.TURN_IDLE_MS,
      onChange: (file, p) => {
        this.deps.broadcast(file, { event: 'presence', data: { ...p, file } })
        // nobody is listening: a handoff still queued for a waiter can't be promised any more (the paste row, Pass 4 #15)
        if (p.waiter === 'none') this.activity.listenerGone(file)
        void this.scheduleUndelivered(file)
      },
    })
    this.activity = createActivityTracker({
      idleMs: o.activityIdleMs ?? CONSTANTS.ACTIVITY_IDLE_MS,
      onChange: (file, a) => this.deps.broadcast(file, { event: 'claude-activity', data: a }),
    })
    this.unsubs.push(deps.onAgentRequest((file, route) => this.onAgentRequest(file, route)))
    this.unsubs.push(deps.onSidecarAppended((file, events) => this.onEvents(normFile(file), events)))
  }

  // ---------------------------------------------------------------- plumbing

  private st(file: string): FileState {
    let s = this.files.get(file)
    if (!s) {
      s = { lastDelivery: null, claudeTick: 0, lastClaudeAt: 0, knownUnconsumed: new Map(), undeliveredTimer: null, reportedUndelivered: new Map() }
      this.files.set(file, s)
    }
    return s
  }

  /** Per-doc serialization of every read-decide-write step (double clicks, connect vs. send, consume). */
  private serial<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(file) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.locks.set(file, run.catch(() => undefined))
    return run
  }

  private store(file: string): Promise<DocStore> {
    return this.deps.store(file)
  }

  private async counts(file: string): Promise<PendingCounts | undefined> {
    try {
      return await this.deps.pendingCounts(file)
    } catch {
      return undefined
    }
  }

  private onAgentRequest(raw: string | null, route: AgentRoute): void {
    if (raw === null || this.closed) return
    const file = normFile(raw)
    this.presence.agentRequest(file)
    if (AGENT_CONTENT_ROUTES.includes(route)) {
      const s = this.st(file)
      s.claudeTick++
      s.lastClaudeAt = Date.now()
      this.activity.contentRequest(file, route)
    }
  }

  /** `GET /api/agent/pending` answered: an empty result means Claude found nothing new (see ActivityTracker.emptyPending). */
  pendingServed(raw: string, empty: boolean): void {
    if (this.closed || !empty) return
    this.activity.emptyPending(normFile(raw))
  }

  /** Committed events for a doc (the store hook, plus this module's own appends; activity dedupes by seq). */
  onEvents(file: string, events: readonly SidecarEvent[]): void {
    if (this.closed || !events.length) return
    this.activity.events(file, events)
    if (events.some(isClaudeWork)) {
      const s = this.st(file)
      s.claudeTick++
      s.lastClaudeAt = Date.now()
    }
    if (events.some((e) => e.type === 'handoff.sent' || e.type === 'handoff.consumed' || e.type === 'ack')) void this.reconcileConsumed(file)
    if (events.some((e) => isClaudeContent(e) || e.type === 'read-marker')) void this.refreshUnread(file)
  }

  private async refreshUnread(file: string): Promise<void> {
    try {
      const r = await (await this.store(file)).review()
      this.activity.setUnread(file, r.threads.reduce((n, t) => n + t.unread, 0))
    } catch {
      // a doc that can't be read has nothing to count
    }
  }

  /** Broadcast `consumed` for handoffs that left the unconsumed set; refresh the undelivered timer. */
  private async reconcileConsumed(file: string): Promise<void> {
    let recs: HandoffRecord[]
    try {
      recs = await (await this.store(file)).handoffs()
    } catch {
      return
    }
    const s = this.st(file)
    const now = new Map(recs.filter((h) => !h.consumed).map((h) => [h.seq, h.delivery] as const))
    for (const [seq, delivery] of s.knownUnconsumed) {
      if (!now.has(seq)) this.deps.broadcast(file, { event: 'handoff', data: { file, seq, state: 'consumed', delivery } })
    }
    s.knownUnconsumed = now
    for (const seq of [...s.reportedUndelivered.keys()]) if (!now.has(seq)) s.reportedUndelivered.delete(seq)
    await this.scheduleUndelivered(file)
  }

  private async scheduleUndelivered(file: string): Promise<void> {
    const s = this.st(file)
    if (s.undeliveredTimer) clearTimeout(s.undeliveredTimer)
    s.undeliveredTimer = null
    if (this.closed) return
    const noneSince = this.presence.noneSince(file)
    if (noneSince === null) return
    let pending: HandoffRecord[]
    try {
      pending = await (await this.store(file)).handoffs({ unconsumed: true })
    } catch {
      return
    }
    if (this.presence.noneSince(file) !== noneSince || this.closed) return
    const deadlineOf = (h: HandoffRecord): number => Math.max(Date.parse(h.at) || 0, noneSince) + this.undeliveredMs
    // a handoff Claude has since picked up (any content request or commit for the doc) is not "undelivered"
    const pickedUp = (h: HandoffRecord): boolean => s.lastClaudeAt > 0 && s.lastClaudeAt >= (Date.parse(h.at) || 0)
    const todo = pending.filter((h) => s.reportedUndelivered.get(h.seq) !== noneSince && !pickedUp(h))
    if (!todo.length) return
    const next = Math.min(...todo.map(deadlineOf))
    if (s.undeliveredTimer) clearTimeout(s.undeliveredTimer)
    const t = setTimeout(() => {
      s.undeliveredTimer = null
      void (async () => {
        if (this.closed || this.presence.noneSince(file) !== noneSince) return
        let still: HandoffRecord[]
        try {
          still = await (await this.store(file)).handoffs({ unconsumed: true })
        } catch {
          return
        }
        const at = Date.now()
        for (const h of still) {
          if (s.reportedUndelivered.get(h.seq) === noneSince || deadlineOf(h) > at || pickedUp(h)) continue
          s.reportedUndelivered.set(h.seq, noneSince)
          this.deps.broadcast(file, { event: 'handoff', data: { file, seq: h.seq, state: 'undelivered', delivery: h.delivery } })
        }
        await this.scheduleUndelivered(file)
      })()
    }, Math.max(0, next - Date.now()))
    ;(t as { unref?: () => void }).unref?.()
    s.undeliveredTimer = t
  }

  // ---------------------------------------------------------------- delivery

  private async payloadFor(file: string, store: DocStore, pending: HandoffRecord[], waiter: WaiterId): Promise<HandoffPayload> {
    await store.flushTjSession('agent-read')
    const counts = (await this.counts(file)) ?? ZERO_COUNTS
    let rev = 0
    try {
      rev = (await store.snapshot()).rev
    } catch {
      try {
        rev = (await store.review()).rev
      } catch {
        rev = 0
      }
    }
    const newest = pending[pending.length - 1]!
    const { port, root } = this.deps
    return {
      file, abs: store.abs, root, port, url: `http://${CONSTANTS.HOST}:${port}/?file=${encodeURIComponent(file)}`,
      handoffs: pending.map((h) => ({ seq: h.seq, at: h.at, message: h.message })),
      round: newest.round, rev, counts, waiter, who: nameForAgent(),
    }
  }

  /** Push every unconsumed handoff to the live waiter, once per connection. Call inside serial(file). */
  private async deliverIfConnected(file: string): Promise<boolean> {
    const conn = this.registry.get(file)
    if (!conn || conn.delivered) return false
    const store = await this.store(file)
    const pending = await store.handoffs({ unconsumed: true })
    if (!pending.length) return false
    const payload = await this.payloadFor(file, store, pending, conn.id)
    if (conn.closed || this.registry.get(file) !== conn) return false
    conn.delivered = true
    conn.send({ event: 'handoff', data: payload })
    this.registry.release(conn)
    this.presence.delivered(file, conn.id)
    this.st(file).lastDelivery = { at: Date.now(), seq: payload.handoffs[payload.handoffs.length - 1]!.seq, tick: this.st(file).claudeTick }
    return true
  }

  // ---------------------------------------------------------------- operations (routes.ts)

  handoff(rawFile: string, req: HandoffRequest, ctx: TjCtx): Promise<HandoffResult> {
    const file = normFile(rawFile)
    return this.serial(file, async () => {
      const store = await this.store(file)
      await store.flushTjSession('handoff')
      const message = req.message === undefined || req.message === '' ? null : req.message
      const all = await store.handoffs()
      const s = this.st(file)
      const unconsumed = all.filter((h) => !h.consumed)
      let target: HandoffRecord | undefined = unconsumed[unconsumed.length - 1]
      if (!target && s.lastDelivery && Date.now() - s.lastDelivery.at < this.coalesceMs && s.claudeTick === s.lastDelivery.tick) {
        target = all.find((h) => h.seq === s.lastDelivery!.seq)
      }
      const promptFor = (round: number, counts: PendingCounts | undefined): string =>
        buildClipboardPrompt({ file, abs: store.abs, root: this.deps.root, round, ...(counts ? { counts } : {}), who: nameForAgent(), cmd: mdrCmd() })

      if (target && (message === null || message === target.message)) {
        const counts = await this.counts(file)
        // the browser already copied when it says so; the server never contradicts that, coalesced or not
        const delivery: Delivery = req.clientDecision === 'clipboard' ? 'clipboard' : target.delivery
        return { ok: true, seq: target.seq, coalesced: true, delivery, prompt: promptFor(target.round, counts), presence: this.presence.get(file) }
      }

      // QA3: the browser's Send with no message and nothing since the ack is not a round (no comment, reply, suggestion,
      // decision, resolve, edit, outside write or notice). `handoffs` is ignored: it counts handoffs already consumed.
      if (req.onlyIfNew && message === null) {
        const counts = await this.counts(file)
        if (counts && (Object.keys(counts) as Array<keyof PendingCounts>).every((k) => k === 'handoffs' || counts[k] === 0)) {
          return { ok: true, seq: all[all.length - 1]?.seq ?? 0, coalesced: false, nothingNew: true, delivery: 'clipboard', prompt: promptFor(all[all.length - 1]?.round ?? 1, counts), presence: this.presence.get(file) }
        }
      }

      const p = this.presence.get(file)
      const delivery: Delivery = req.clientDecision === 'clipboard' ? 'clipboard'
        : p.waiter === 'connected' && this.registry.get(file) ? 'waiter'
          : p.waiter === 'grace' || p.waiter === 'turn' ? 'latched' : 'clipboard'
      const r = await store.appendEvents([{ type: 'handoff.sent', key: `tj:${req.opKey}`, message, delivery }], ctx)
      // §4.7: the store answers a repeated opKey with its original line (a retry that missed the coalescing window,
      // e.g. after that handoff was consumed). Answer it as coalesced: no second broadcast, no activity change, no push.
      const prior = all.find((h) => h.seq === r.seq)
      if (prior) {
        const counts = await this.counts(file)
        const was: Delivery = req.clientDecision === 'clipboard' ? 'clipboard' : prior.delivery
        return { ok: true, seq: prior.seq, coalesced: true, delivery: was, prompt: promptFor(prior.round, counts), presence: this.presence.get(file) }
      }
      this.onEvents(file, r.events)
      s.knownUnconsumed.set(r.seq, delivery)
      this.deps.broadcast(file, { event: 'handoff', data: { file, seq: r.seq, state: delivery === 'latched' ? 'latched' : 'sent', delivery } })
      await this.deliverIfConnected(file)
      const rec = (await store.handoffs()).find((h) => h.seq === r.seq)
      const counts = await this.counts(file)
      void this.scheduleUndelivered(file)
      return { ok: true, seq: r.seq, coalesced: false, delivery, prompt: promptFor(rec?.round ?? all.length + 1, counts), presence: this.presence.get(file) }
    })
  }

  openWaiter(rawFile: string, id: WaiterId, gen: number): Promise<ReadableStream<Uint8Array>> {
    const file = normFile(rawFile)
    return this.serial(file, async () => {
      const store = await this.store(file)
      const pending = await store.handoffs({ unconsumed: true })
      const stream = openWaiterStream({ id, gen, file, heartbeatMs: this.heartbeatMs, onClose: (c, cause) => this.onWaiterClosed(c, cause) })
      this.open.add(stream.conn)
      const outcome = this.registry.register(stream.conn)
      if (!outcome.accepted) return stream.body
      this.presence.connected(file, id)
      // the loop starts when Claude's turn ends, so a connect settles a "working" no ack came to clear (Pass 4 #14)
      this.activity.turnEnded(file)
      stream.conn.send({ event: 'armed', data: { waiter: id, file, undelivered: pending.map((h) => h.seq) } })
      if (pending.length) await this.deliverIfConnected(file)
      void this.reconcileConsumed(file)
      return stream.body
    })
  }

  private onWaiterClosed(conn: WaiterConn, cause: CloseCause): void {
    this.open.delete(conn)
    const wasLive = this.registry.release(conn)
    if (!wasLive || this.closed) return
    if (cause === 'client') this.presence.dropped(conn.file, conn.id)
  }

  consume(rawFile: string, seqs: number[], waiter: WaiterId | undefined): Promise<{ ok: true; seq: number }> {
    const file = normFile(rawFile)
    return this.serial(file, async () => {
      const store = await this.store(file)
      const open = new Map((await store.handoffs({ unconsumed: true })).map((h) => [h.seq, h.delivery] as const))
      const todo = [...new Set(seqs)].filter((x) => open.has(x)).sort((a, b) => a - b)
      if (!todo.length) return { ok: true as const, seq: (await store.review()).seq }
      // the `consumed` broadcast comes from reconcileConsumed (once, whichever path runs it first)
      const s = this.st(file)
      for (const [x, d] of open) s.knownUnconsumed.set(x, d)
      const r = await store.appendEvents([{ type: 'handoff.consumed', handoffs: todo, via: 'waiter', ...(waiter ? { waiter } : {}) }])
      this.onEvents(file, r.events)
      await this.reconcileConsumed(file)
      return { ok: true as const, seq: r.seq }
    })
  }

  disarm(rawFile: string): Promise<DisarmResult> {
    const file = normFile(rawFile)
    return this.serial(file, async () => {
      const live = this.registry.get(file)
      if (live) {
        live.send({ event: 'disarmed', data: { file } })
        this.registry.release(live)
        live.close('disarmed')
      }
      this.presence.disarmed(file)
      return { ok: true as const, file, disarmed: live !== null }
    })
  }

  arm(rawFile: string): ArmRouteResult {
    const file = normFile(rawFile)
    this.presence.agentRequest(file)
    this.presence.armed(file)
    // the skill ends every turn with `mdr arm` (§9.9): a read-only, direct-edit or failed-batch turn is over (Pass 4 #14)
    this.activity.turnEnded(file)
    return { ok: true, presence: this.presence.get(file) }
  }

  private shuttingDown: Promise<void> | null = null

  shutdown(reason: 'stop' | 'restart' | 'signal'): Promise<void> {
    const conns = [...this.open]
    for (const c of conns) {
      c.send({ event: 'server-shutdown', data: { reason } })
      this.registry.release(c)
    }
    const done = Promise.all(conns.map(async (c) => {
      await c.drained(250)
      c.close('shutdown')
    })).then(() => undefined)
    this.shuttingDown = done
    return done
  }

  async close(): Promise<void> {
    if (this.shuttingDown) await this.shuttingDown
    this.closed = true
    for (const c of [...this.open]) {
      this.registry.release(c)
      c.close('shutdown')
    }
    for (const u of this.unsubs) u()
    for (const s of this.files.values()) if (s.undeliveredTimer) clearTimeout(s.undeliveredTimer)
    this.presence.close()
    this.activity.close()
  }
}

export function createHandoffModuleWith(deps: HandoffDeps, o: HandoffModuleOptions = {}): P4HandoffModule & { core: HandoffCore } {
  const core = new HandoffCore(deps, o)
  const routes = handoffRoutes(core)
  return {
    core,
    routes,
    presence: (file: string): Presence => core.presence.get(normFile(file)),
    activity: (file: string): ClaudeActivity => core.activity.get(normFile(file)),
    shutdown: (reason) => core.shutdown(reason),
    pendingServed: (file, empty) => core.pendingServed(file, empty),
    close: () => core.close(),
  }
}

export const createHandoffModule: CreateHandoffModule<Hono> = (deps) => createHandoffModuleWith(deps)
