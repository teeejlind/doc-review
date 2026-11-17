// cli/wait.ts (P4). `mdr wait`: background-safe, run only inside the waiter loop (CONTRACTS §9.7, §8.7, D21, D49).
//
// 1. Discover the root; never start a server. Down → poll discovery every 5 s backing off to 30 s.
// 2. GET /api/agent/wait?file&waiter&gen with no body or idle timeout of its own (node:http, socket timeout 0). A
//    watchdog counts the stream as dropped when no byte (event or `: hb`) arrives for WAITER_WATCHDOG_MS.
// 3. `handoff` → write {ok, status:'handoff', payload, prompt: buildWakePrompt(payload)} + '\n', await the drain,
//    POST /api/agent/handoff/consume (best effort: delivery is at-least-once), exit 0.
// 4. A drop, or server-shutdown { restart | signal } → reconnect with backoff 0.5 / 1 / 2 / 5 / 10 s (re-running
//    discovery), same waiter id and gen.
// 5. server-shutdown { stop } → SERVER_STOPPED (10). 6. superseded → WAITER_SUPERSEDED (10); disarmed → DISARMED (10).
// 7. The deadline while connected → {status:'timeout'} exit 2; while disconnected → SERVER_UNREACHABLE exit 11.
//    PROTOCOL_MISMATCH / ROOT_MISMATCH on any call → exit 8 at once, never retried inside the run.
// 8. --forever never times out. 9. stdout stays empty until exit; SIGINT/SIGTERM → INTERRUPTED (130).
// The transport is injectable so tests/unit/cli/wait-longevity.test.ts can drive 55 minutes with fake timers.
import { request } from 'node:http'
import { createHash } from 'node:crypto'
import type { HandoffPayload, WaiterId, WaitResult } from '../shared/types'
import { CONSTANTS, PROTOCOL } from '../shared/constants'
import { buildWakePrompt } from '../shared/handoff-prompt'
import { discover as realDiscover, rootHashOf, type Discovery } from '../node/root'
import { agentHeaders, protocolMismatch } from './http'
import { cliErr, CliExit, fromHttp } from './output'

/** Reconnect delays after a drop (§9.7 step 4), then held at 30 s while the server stays down (§9.3). */
export const DROP_BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 20_000, 30_000] as const
/** Polling a server that is down from the start (§9.3): every 5 s, backing off to 30 s. */
export const DOWN_BACKOFF_MS = [5000, 10_000, 20_000, 30_000] as const

export interface WaitStream {
  status: number
  rootHash: string | null
  /** Body chunks (utf8); `end` fires once when the stream closes for any reason. */
  onData(cb: (chunk: string) => void): void
  onEnd(cb: () => void): void
  /** The whole body (non-200 answers). */
  text(): Promise<string>
  close(): void
}

export interface WaitTransport {
  discover(root: string): Promise<Discovery>
  /** Rejects when no connection could be made. */
  open(port: number, path: string, headers: Record<string, string>): Promise<WaitStream>
  post(port: number, path: string, headers: Record<string, string>, body: unknown): Promise<void>
}

export interface WaitOptions {
  abs: string
  root: string
  rel: string
  waiter: WaiterId
  gen: number
  /** null = --forever. */
  timeoutMs: number | null
  watchdogMs?: number
  /** The command the wake prompt names (MDR_CMD || 'mdr'); default 'mdr'. */
  cmd?: string
}

export interface WaitIo {
  stdout(s: string): Promise<void>
  /** Resolves on SIGINT / SIGTERM. */
  signal?: Promise<unknown>
}

/** `w_` + 16 hex of sha256(seed + '\0' + abs) (§9.7 step 2). */
export function deriveWaiterId(seed: string, abs: string): WaiterId {
  return `w_${createHash('sha256').update(seed + '\0' + abs, 'utf8').digest('hex').slice(0, 16)}`
}

export function watchdogMsFrom(env: Record<string, string | undefined>): number {
  if (env.MDR_TEST_HOOKS === '1') {
    const n = Number(env.MDR_TEST_WATCHDOG_MS)
    if (Number.isFinite(n) && n > 0) return n
  }
  return CONSTANTS.WAITER_WATCHDOG_MS
}

type Outcome =
  | { kind: 'exit'; exit: CliExit }
  | { kind: 'handoff'; payload: HandoffPayload }
  | { kind: 'dropped'; connected: boolean }

const isPayload = (p: unknown): p is HandoffPayload =>
  !!p && typeof p === 'object' && Array.isArray((p as HandoffPayload).handoffs) && typeof (p as HandoffPayload).file === 'string'

function streamOnce(t: WaitTransport, o: WaitOptions, d: Extract<Discovery, { state: 'up' }>, deadline: number, started: number, signal: Promise<unknown>): Promise<Outcome> {
  const watchdogMs = o.watchdogMs ?? CONSTANTS.WAITER_WATCHDOG_MS
  const path = `/api/agent/wait?file=${encodeURIComponent(o.rel)}&waiter=${o.waiter}&gen=${o.gen}`
  return new Promise<Outcome>((resolve) => {
    let settled = false
    let stream: WaitStream | null = null
    let connected = false
    let dl: ReturnType<typeof setTimeout> | null = null
    let wd: ReturnType<typeof setTimeout> | null = null
    const settle = (out: Outcome): void => {
      if (settled) return
      settled = true
      if (dl) clearTimeout(dl)
      if (wd) clearTimeout(wd)
      stream?.close()
      resolve(out)
    }
    void signal.then(() => settle({ kind: 'exit', exit: cliErr('INTERRUPTED', 'interrupted') }))
    const feed = (): void => {
      if (wd) clearTimeout(wd)
      wd = setTimeout(() => settle({ kind: 'dropped', connected }), watchdogMs)
    }
    t.open(d.port, path, { ...agentHeaders(d.marker.token), Accept: 'text/event-stream' }).then(async (s) => {
      stream = s
      if (settled) return s.close()
      if (s.rootHash !== rootHashOf(o.root)) {
        return settle({ kind: 'exit', exit: cliErr('ROOT_MISMATCH', `the server on port ${d.port} does not serve ${o.root}`, { details: { port: d.port } }) })
      }
      if (s.status !== 200) {
        const r = fromHttp(s.status, await s.text())
        return settle({ kind: 'exit', exit: r.code === 0 ? cliErr('INTERNAL', `the waiter route answered ${s.status}`, { details: { status: s.status } }) : r })
      }
      if (Number.isFinite(deadline)) {
        dl = setTimeout(() => {
          const doc: WaitResult = { ok: true, status: 'timeout', file: o.rel, waitedMs: Date.now() - started }
          settle({ kind: 'exit', exit: new CliExit(doc, 2) })
        }, Math.max(0, deadline - Date.now()))
      }
      feed()
      let buf = ''
      s.onData((chunk) => {
        if (settled) return
        feed()
        buf += chunk.replace(/\r\n?/g, '\n')
        for (let k = buf.indexOf('\n\n'); k !== -1; k = buf.indexOf('\n\n')) {
          const frame = buf.slice(0, k)
          buf = buf.slice(k + 2)
          let event = 'message'
          const data: string[] = []
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
          }
          if (!data.length) continue
          let payload: unknown
          try {
            payload = JSON.parse(data.join('\n'))
          } catch {
            continue
          }
          if (event === 'armed') connected = true
          else if (event === 'handoff' && isPayload(payload)) return settle({ kind: 'handoff', payload })
          else if (event === 'superseded') {
            return settle({ kind: 'exit', exit: cliErr('WAITER_SUPERSEDED', 'another waiter took over this document', { details: payload as Record<string, unknown> }) })
          } else if (event === 'disarmed') return settle({ kind: 'exit', exit: cliErr('DISARMED', 'the review was disarmed (mdr disarm)') })
          else if (event === 'server-shutdown') {
            if ((payload as { reason?: string }).reason === 'stop') return settle({ kind: 'exit', exit: cliErr('SERVER_STOPPED', 'the mdr server was stopped') })
            return settle({ kind: 'dropped', connected })
          }
        }
      })
      s.onEnd(() => settle({ kind: 'dropped', connected }))
    }, () => settle({ kind: 'dropped', connected: false }))
  })
}

function sleepOrSignal(ms: number, signal: Promise<unknown>): Promise<'slept' | 'signal'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('slept'), ms)
    void signal.then(() => {
      clearTimeout(t)
      resolve('signal')
    })
  })
}

export async function runWait(o: WaitOptions, io: WaitIo, t: WaitTransport = nodeWaitTransport): Promise<CliExit> {
  const started = Date.now()
  const deadline = o.timeoutMs === null ? Infinity : started + o.timeoutMs
  const signal = io.signal ?? new Promise<never>(() => {})
  let schedule: readonly number[] = DOWN_BACKOFF_MS
  let step = 0
  for (;;) {
    let d: Discovery
    try {
      d = await t.discover(o.root)
    } catch {
      d = { state: 'down', freePort: null }
    }
    if (d.state === 'up' && d.health.protocol !== PROTOCOL) return protocolMismatch(o.root, d.health.protocol)
    if (d.state === 'up' && d.marker.token !== '') {
      const out = await streamOnce(t, o, d, deadline, started, signal)
      if (out.kind === 'exit') return out.exit
      if (out.kind === 'handoff') {
        const doc: WaitResult = { ok: true, status: 'handoff', payload: out.payload, prompt: buildWakePrompt({ ...out.payload, ...(o.cmd !== undefined ? { cmd: o.cmd } : {}) }) }
        await io.stdout(JSON.stringify(doc) + '\n')
        try {
          await t.post(d.port, '/api/agent/handoff/consume', agentHeaders(d.marker.token), {
            file: o.rel, handoffs: out.payload.handoffs.map((h) => h.seq), waiter: o.waiter,
          })
        } catch {
          // at-least-once: the skill's ack consumes it (§8.5)
        }
        return new CliExit(doc, 0, true)
      }
      if (out.connected || schedule === DOWN_BACKOFF_MS) {
        schedule = DROP_BACKOFF_MS
        if (out.connected) step = 0
      }
    }
    const now = Date.now()
    if (now >= deadline) return cliErr('SERVER_UNREACHABLE', `no mdr server answered for ${o.root} before the deadline`, { hint: 'the waiter loop sleeps 5 s and runs wait again' })
    const delay = schedule[Math.min(step, schedule.length - 1)]!
    step++
    if ((await sleepOrSignal(Math.min(delay, deadline - now), signal)) === 'signal') return cliErr('INTERRUPTED', 'interrupted')
  }
}

// ------------------------------------------------------------------ the node:http transport

export const nodeWaitTransport: WaitTransport = {
  discover: (root) => realDiscover(root),
  open(port, path, headers) {
    return new Promise((resolve, reject) => {
      const req = request({ host: CONSTANTS.HOST, port, path, method: 'GET', headers }, (res) => {
        res.setEncoding('utf8')
        res.socket?.setTimeout(0)
        const endCbs: Array<() => void> = []
        let ended = false
        const end = (): void => {
          if (ended) return
          ended = true
          for (const cb of endCbs) cb()
        }
        res.on('end', end)
        res.on('close', end)
        res.on('error', end)
        req.on('error', end)
        const h = res.headers['x-mdr-root-hash']
        resolve({
          status: res.statusCode ?? 0,
          rootHash: typeof h === 'string' ? h : null,
          onData: (cb) => res.on('data', cb),
          onEnd: (cb) => {
            if (ended) cb()
            else endCbs.push(cb)
          },
          text: () => new Promise((done) => {
            let s = ''
            res.on('data', (c: string) => (s += c))
            res.on('end', () => done(s))
            res.on('close', () => done(s))
          }),
          close: () => {
            req.destroy()
          },
        })
      })
      req.on('error', reject)
      req.setTimeout(0)
      req.end()
    })
  },
  async post(port, path, headers, body) {
    await fetch(`http://${CONSTANTS.HOST}:${port}${path}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    })
  },
}
