// tests/unit/cli/wait-longevity.test.ts (P4; CONTRACTS §9.7 "What survives the 55-minute reconnect means", §9.8.3).
//
// `wait --timeout 3300` against an in-process SSE server with fake timers: 53 simulated minutes of heartbeats, a 60 s
// silent gap (a half-open socket: the watchdog fires 45 s in and there is exactly one reconnect, with the same waiter
// id and gen), heartbeats again, then a handoff at 54:30 (inside the 55-minute run) → exit 0 with the payload
// (printed, drained, then consumed); and with no handoff → exit 2 at 3,300 s while connected.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandoffPayload, Health, ServerMarker } from '../../../shared/types'
import { CONSTANTS } from '../../../shared/constants'
import { buildWakePrompt } from '../../../shared/handoff-prompt'
import { rootHashOf } from '../../../node/root'
import { runWait, type WaitStream, type WaitTransport } from '../../../cli/wait'
import type { CliExit } from '../../../cli/output'

const ROOT = '/fake/root'
const ABS = '/fake/root/doc.md'
const WAITER = 'w_00000000000000aa' as const
const GEN = 4242
const MIN = 60_000

class FakeStream implements WaitStream {
  status = 200
  rootHash = rootHashOf(ROOT)
  silent = false
  closed = false
  private readonly dataCbs: Array<(c: string) => void> = []
  private readonly endCbs: Array<() => void> = []
  private readonly hb: ReturnType<typeof setInterval>
  constructor() {
    setTimeout(() => this.emit(`event: armed\ndata: ${JSON.stringify({ waiter: WAITER, file: 'doc.md', undelivered: [] })}\n\n`), 0)
    this.hb = setInterval(() => {
      if (!this.silent) this.emit(': hb\n\n')
    }, CONSTANTS.SSE_HEARTBEAT_MS)
  }
  emit(s: string): void {
    if (!this.closed) for (const cb of this.dataCbs) cb(s)
  }
  onData(cb: (c: string) => void): void {
    this.dataCbs.push(cb)
  }
  onEnd(cb: () => void): void {
    this.endCbs.push(cb)
  }
  text(): Promise<string> {
    return Promise.resolve('')
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.hb)
    for (const cb of this.endCbs) cb()
  }
}

class FakeServer {
  readonly conns: Array<{ path: string; stream: FakeStream }> = []
  readonly consumed: unknown[] = []
  readonly health: Health = {
    ok: true, app: 'mdr', version: '2.0.0-dev', protocol: 2, schemaFingerprint: '0'.repeat(16), root: ROOT, rootHash: rootHashOf(ROOT),
    port: 9999, pid: 1, serverId: 'srv_fake', startedAt: '2026-10-15T17:00:00.000Z',
  }
  readonly marker: ServerMarker = { ...this.health, token: 't'.repeat(64) } as unknown as ServerMarker
  readonly transport: WaitTransport = {
    discover: async () => ({ state: 'up', port: 9999, health: this.health, marker: this.marker }),
    open: async (_port, path) => {
      const stream = new FakeStream()
      this.conns.push({ path, stream })
      return stream
    },
    post: async (_port, _path, _headers, body) => {
      this.consumed.push(body)
    },
  }
}

const payload: HandoffPayload = {
  file: 'doc.md', abs: ABS, root: ROOT, port: 9999, url: 'http://127.0.0.1:9999/?file=doc.md',
  handoffs: [{ seq: 41, at: '2026-10-15T18:00:01.000Z', message: 'Tighten section 2' }], round: 4, rev: 40,
  counts: { threads: 1, messages: 3, suggestions: 0, decisions: 1, resolves: 0, edits: 3, external: 0, notices: 0, handoffs: 1 },
  waiter: WAITER,
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('wait longevity (fake timers)', () => {
  it('53 min of heartbeats, a 60 s silent gap (one watchdog reconnect, same id and gen), then a handoff → exit 0', async () => {
    const server = new FakeServer()
    let stdout = ''
    let done: CliExit | null = null
    const p = runWait(
      { abs: ABS, root: ROOT, rel: 'doc.md', waiter: WAITER, gen: GEN, timeoutMs: CONSTANTS.WAIT_DEFAULT_TIMEOUT_S * 1000, watchdogMs: CONSTANTS.WAITER_WATCHDOG_MS },
      { stdout: async (s) => {
        stdout += s
      } },
      server.transport,
    ).then((r) => (done = r))
    for (let m = 0; m < 53; m++) await vi.advanceTimersByTimeAsync(MIN)
    expect(server.conns).toHaveLength(1)
    expect(done).toBeNull()
    server.conns[0]!.stream.silent = true // a half-open socket after sleep: no bytes any more
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.conns).toHaveLength(2)
    expect(server.conns[0]!.stream.closed).toBe(true)
    expect(server.conns.map((c) => c.path)).toEqual([
      `/api/agent/wait?file=doc.md&waiter=${WAITER}&gen=${GEN}`, `/api/agent/wait?file=doc.md&waiter=${WAITER}&gen=${GEN}`,
    ])
    expect(done).toBeNull()
    await vi.advanceTimersByTimeAsync(30_000) // heartbeats on the new stream; no further reconnect
    expect(server.conns).toHaveLength(2)
    server.conns[1]!.stream.emit(`event: handoff\ndata: ${JSON.stringify(payload)}\n\n`)
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(done!.code).toBe(0)
    expect(done!.printed).toBe(true)
    expect(JSON.parse(stdout)).toEqual({ ok: true, status: 'handoff', payload, prompt: buildWakePrompt(payload) })
    expect(stdout.endsWith('}\n')).toBe(true)
    expect(server.consumed).toEqual([{ file: 'doc.md', handoffs: [41], waiter: WAITER }])
    expect(buildWakePrompt(payload)).toContain('round #4: 3 messages, 1 decision, edits in 3 blocks')
  })

  it('no handoff → exit 2 at 3,300 s while connected, never a reconnect', async () => {
    const server = new FakeServer()
    let done: CliExit | null = null
    const p = runWait(
      { abs: ABS, root: ROOT, rel: 'doc.md', waiter: WAITER, gen: GEN, timeoutMs: 3_300_000, watchdogMs: 45_000 },
      { stdout: async () => {} },
      server.transport,
    ).then((r) => (done = r))
    await vi.advanceTimersByTimeAsync(3_300_000 - 1000)
    expect(done).toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(done!.code).toBe(2)
    expect(done!.doc).toMatchObject({ ok: true, status: 'timeout', file: 'doc.md' })
    expect((done!.doc as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(3_300_000)
    expect(server.conns).toHaveLength(1)
  })

  it('a server that stays down: polls (5 s backing off to 30 s) and exits 11 at the deadline', async () => {
    let discoveries = 0
    const t: WaitTransport = {
      discover: async () => {
        discoveries++
        return { state: 'down', freePort: 8301 }
      },
      open: async () => {
        throw new Error('unused')
      },
      post: async () => {},
    }
    let done: CliExit | null = null
    const p = runWait({ abs: ABS, root: ROOT, rel: 'doc.md', waiter: WAITER, gen: GEN, timeoutMs: 120_000 }, { stdout: async () => {} }, t).then((r) => (done = r))
    await vi.advanceTimersByTimeAsync(121_000)
    await p
    expect(done!.code).toBe(11)
    expect(done!.doc).toMatchObject({ ok: false, error: { code: 'SERVER_UNREACHABLE' } })
    // 0, 5, 15, 35, 65, 95 s, and the deadline at 120 s: about 7 polls, never a busy loop
    expect(discoveries).toBeGreaterThanOrEqual(5)
    expect(discoveries).toBeLessThanOrEqual(9)
  })
})
