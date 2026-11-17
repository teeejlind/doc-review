// tests/e2e/fixtures/p1.ts (P1). Producer-local helpers for the p1-* specs (CONTRACTS §1.3 e2e row, §2.5, §14 P1 E2E).
//
// The p1-* specs act as TJ through tests/helpers/webClient.ts and as Claude through the built CLI (the day-0 shell's
// `serve` and `batch`), never through P2/P3 UI. This file adds what those two don't cover:
// - `openEvents`: a background consumer of webClient.events() that timestamps every frame on arrival, resolves once
//   the stream is live (hello, or doc-removed for a gone doc), and lets a spec wait for the next matching event;
// - `tjCall` / `agentCall`: one browser-route or agent-route request with exactly the §8.1 headers (tjCall carries the
//   given webClient's clientId, so a restore made through it is stamped with that tab's id, D32);
// - sidecar and bytes readers.
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import type { BrowserSseEvent, SidecarEvent } from '../../../shared/types'
import { agentHeaders, browserHeaders } from '../../helpers/startServer'
import type { TmpRoot } from '../../helpers/tmpRoot'
import type { WebClient } from '../../helpers/webClient'
import type { ServerUnderTest } from '../fixtures'

export { expect, test } from '../fixtures'

/**
 * Every p1 spec passes this as `portOffset`. MDR_E2E_PORT_OFFSET (0..9) moves the spec's server inside its worker's
 * port window, for running p1-* beside another worktree's e2e run on the same machine (both would otherwise take
 * 29000 + workerIndex*10). Unset, it is 0, the fixture default.
 */
export const P1_PORT_OFFSET: number = (() => {
  const n = Number.parseInt(process.env.MDR_E2E_PORT_OFFSET ?? '0', 10)
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : 0
})()

/** An SSE event as received, with its arrival time (Date.now()). */
export type Stamped = BrowserSseEvent & { at: number }
type Of<K extends BrowserSseEvent['event']> = Extract<BrowserSseEvent, { event: K }> & { at: number }

export interface EventLog {
  readonly events: readonly Stamped[]
  /** Index of the next event to arrive (pass it as `from` to ignore everything before now). */
  mark(): number
  /** The first event of kind `k` at index >= `from` that satisfies `where`; rejects after `timeoutMs` (default 5 s). */
  next<K extends BrowserSseEvent['event']>(k: K, o?: { from?: number; where?: (e: Of<K>) => boolean; timeoutMs?: number }): Promise<Of<K>>
  /** Every event of kind `k` at index >= `from`. */
  all<K extends BrowserSseEvent['event']>(k: K, from?: number): Array<Of<K>>
  /** Wait a quiet period and return what arrived since `from` (to assert that nothing else followed). */
  settle(from: number, quietMs?: number): Promise<Stamped[]>
  close(): Promise<void>
}

/** Subscribe to `client`'s doc channel and resolve once the stream is live (its first event has arrived). */
export async function openEvents(client: WebClient, o: { afterSeq?: number; knownRev?: number; timeoutMs?: number } = {}): Promise<EventLog> {
  const events: Stamped[] = []
  const waiters = new Set<() => void>()
  let failure: unknown = null
  let ended = false
  const it = client.events({
    ...(o.afterSeq === undefined ? {} : { afterSeq: o.afterSeq }),
    ...(o.knownRev === undefined ? {} : { knownRev: o.knownRev }),
  })[Symbol.asyncIterator]()
  const pump = (async () => {
    try {
      for (;;) {
        const r = await it.next()
        if (r.done) break
        events.push({ ...r.value, at: Date.now() } as Stamped)
        for (const w of [...waiters]) w()
      }
    } catch (e) {
      failure = e
    } finally {
      ended = true
      for (const w of [...waiters]) w()
    }
  })()

  const waitUntil = <T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const check = (): boolean => {
        const v = probe()
        if (v !== undefined) {
          cleanup()
          resolve(v)
          return true
        }
        if (failure || ended) {
          cleanup()
          reject(new Error(`event stream ended while waiting for ${what}: ${String(failure ?? 'closed')}\nseen: ${summary(events)}`))
          return true
        }
        return false
      }
      const t = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}\nseen: ${summary(events)}`))
      }, timeoutMs)
      const w = (): void => void check()
      const cleanup = (): void => {
        clearTimeout(t)
        waiters.delete(w)
      }
      waiters.add(w)
      check()
    })

  const log: EventLog = {
    events,
    mark: () => events.length,
    next(k, no = {}) {
      const from = no.from ?? 0
      return waitUntil(() => events.slice(from).find((e) => e.event === k && (!no.where || no.where(e as never))) as never, no.timeoutMs ?? 5_000, `"${k}" from #${from}`)
    },
    all: (k, from = 0) => events.slice(from).filter((e) => e.event === k) as never,
    async settle(from, quietMs = 400) {
      let n = -1
      while (n !== events.length) {
        n = events.length
        await sleep(quietMs)
      }
      return events.slice(from)
    },
    async close() {
      await it.return?.()
      await pump
    },
  }
  await waitUntil(() => (events.length > 0 ? true : undefined), o.timeoutMs ?? 5_000, 'the first event (hello)')
  return log
}

const summary = (es: readonly Stamped[]): string => es.map((e) => e.event).join(', ') || '(nothing)'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface Answer<T = unknown> { status: number; json: T }

async function answer<T>(r: Response): Promise<Answer<T>> {
  const text = await r.text()
  let json: unknown
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = text
  }
  return { status: r.status, json: json as T }
}

/** A browser-route request (§8.1 step 3) carrying `client`'s X-MDR-Client-Id; the path includes its query. */
export async function tjCall<T = unknown>(server: ServerUnderTest, client: WebClient, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Answer<T>> {
  const headers: Record<string, string> = browserHeaders({ token: server.token, port: server.port, clientId: client.clientId })
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return answer<T>(await fetch(server.origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
}

/** An agent-route request (§8.1 step 4): X-MDR-Client cli, protocol, token, never an Origin. */
export async function agentCall<T = unknown>(server: ServerUnderTest, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer<T>> {
  const headers: Record<string, string> = agentHeaders({ token: server.token })
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return answer<T>(await fetch(server.origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
}

/** `?file=<rel>` for a route path. */
export const q = (file: string): string => `file=${encodeURIComponent(file)}`

/** The sidecar's events (header dropped). A torn or corrupt line is kept as `{ __raw }`. */
export function sidecarEvents(root: TmpRoot, file: string): Array<SidecarEvent & { __raw?: string }> {
  const lines = root.readSidecar(file) as Array<SidecarEvent & { __raw?: string; type?: string }>
  return lines.filter((l) => (l as { type?: string }).type !== 'header') as never
}

/** The event types of the sidecar, in order. */
export const sidecarTypes = (root: TmpRoot, file: string): string[] => sidecarEvents(root, file).map((e) => e.__raw !== undefined ? '__raw' : e.type)

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/** Files in the doc's directory ending in `.tmp` (a dead writer's leftovers). */
export function tmpFiles(root: TmpRoot): string[] {
  return readdirSync(root.root).filter((n) => n.endsWith('.tmp'))
}

/**
 * Take the server down through POST /api/agent/shutdown (what `mdr stop` / the first half of a restart send) and wait
 * until /api/health stops answering. `restart` keeps the marker, so the next start reuses the token (D16, §13 #2);
 * `stop` removes it. Follow with `server.restart()` to start it again on the same root and port.
 */
export async function shutdownServer(server: ServerUnderTest, reason: 'stop' | 'restart'): Promise<void> {
  const r = await agentCall(server, 'POST', '/api/agent/shutdown', { root: server.root, reason })
  if (r.status !== 200) throw new Error(`shutdown: HTTP ${r.status} ${JSON.stringify(r.json)}`)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const h = await fetch(`${server.origin}/api/health`, { signal: AbortSignal.timeout(300) })
      if (!h.ok) return
    } catch {
      return
    }
    await sleep(50)
  }
  throw new Error('shutdown: the server still answers /api/health after 5 s')
}
