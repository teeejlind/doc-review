// tests/e2e/fixtures/p4.ts (P4). Producer-local helpers for the p4-* specs (CONTRACTS §1.3 e2e row, §9.8.3, §14 P4 E2E).
//
// The p4-* specs act as TJ through tests/helpers/webClient.ts and as Claude through the built CLI (.e2e-dist/cli.js),
// against the real server the shared fixture starts (`serve --foreground`, MDR_TEST_HOOKS=1). This file adds:
// - `startLoop`: runs a WaiterSpec.command exactly as the skill does (a child `bash -c`, in its own process group so a
//   test can end the whole loop), and resolves with its single output line and exit code;
// - `recordEvents`: a background consumer of webClient.events() (presence, handoff, claude-activity, ...);
// - `presenceOf` / `waitPresence`: presence read through GET /api/review, a browser route, so polling it never counts
//   as an agent request (which would keep a `turn` alive, D48);
// - `json`: one CLI run's single stdout document, asserting the §9.1 output contract on the way.
import { spawn, type ChildProcess } from 'node:child_process'
import { ulid } from 'ulid'
import type { BrowserSseEvent, Presence, SaveResponse, SuggestionId, WaiterSpec } from '../../../shared/types'
import type { CliRun } from '../../helpers/runCli'
import { testCore, type WebClient } from '../../helpers/webClient'
import { expect } from '../fixtures'
import { pinUserEnv } from '../../helpers/userEnv'

export { expect, test } from '../fixtures'

/**
 * Every p4 spec passes this as `portOffset`. MDR_E2E_PORT_OFFSET (0..9) moves the spec's server inside its worker's
 * port window, for running p4-* beside another worktree's e2e run on the same machine. Unset, it is 0.
 */
export const P4_PORT_OFFSET: number = (() => {
  const n = Number.parseInt(process.env.MDR_E2E_PORT_OFFSET ?? '0', 10)
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : 0
})()

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The single stdout JSON document of a CLI run (§9.1: exactly one), typed as the caller expects. */
export function json<T = any>(run: CliRun): T {
  expect(run.docs, `stdout must hold exactly one JSON document; code=${run.code} stdout=${run.stdout} stderr=${run.stderr}`).toBe(1)
  return run.json as T
}

/** A CLI run that must succeed (exit 0, ok: true). */
export function ok<T = any>(run: CliRun): T {
  const j = json<T & { ok: boolean }>(run)
  expect(run.code, `exit ${run.code}: ${run.stdout} ${run.stderr}`).toBe(0)
  expect(j.ok).toBe(true)
  return j
}

// ---------------------------------------------------------------- TJ's Suggesting mode, headless

/**
 * A TJ-authored suggestion on the block holding `quote`, sent the way P2's editor does: a save with no byte ops and a
 * `suggestions.upsert` (TjSuggestionUpsert: block range at base.rev, the block's source as `base`, `proposed`, and a
 * TextAnchor on the quote built with the real core). Returns the suggestion id and the save response.
 */
export async function tjSuggest(c: WebClient, quote: string, proposedBlock: string): Promise<{ id: SuggestionId; save: SaveResponse }> {
  const core = await testCore()
  const [{ ptextOf }, { createAnchor }] = await Promise.all([import('../../../core/ptext'), import('../../../core/anchors')])
  const snap = await c.doc()
  const L = core.load(core.md, snap.markdown)
  const p = ptextOf(L.doc, L)
  const from = p.text.indexOf(quote)
  if (from < 0) throw new Error(`tjSuggest: ${quote} is not in the doc's ptext`)
  const at = p.blockAt(from).index
  const block = L.blocks[at]!
  const id = `s_${ulid()}` as SuggestionId
  const save = await c.save({
    base: { rev: snap.rev, hash: snap.hash, blockHashes: L.blocks.map((b) => b.hash) }, ops: [], cause: 'edit', allowPartial: true,
    suggestions: { upsert: [{ id, range: { start: at, end: at + 1 }, base: snap.markdown.slice(block.start, block.end), proposed: proposedBlock, anchor: createAnchor(p, L.blocks, from, from + quote.length, snap.rev) }] },
  })
  return { id, save }
}

// ---------------------------------------------------------------- the waiter loop, as the skill runs it

export interface LoopExit {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** stdout's non-empty lines (the loop prints exactly one on exit, §9.8.1). */
  lines: string[]
  /** The parsed single line (a WaitResult on 0, a CliErr otherwise); undefined when there isn't exactly one. */
  json: any
  /** ms from start to exit. */
  ms: number
}

export interface Loop {
  readonly spec: WaiterSpec
  readonly child: ChildProcess
  readonly exited: Promise<LoopExit>
  /** true once the shell exited. */
  done(): boolean
  /** Resolves with the exit, or rejects after timeoutMs (the loop is still running then). */
  exit(timeoutMs?: number): Promise<LoopExit>
  /** End the whole loop (shell and any `wait` child): SIGTERM to the process group, SIGKILL after 3 s. */
  kill(): Promise<void>
}

const live = new Set<Loop>()

/** Env for the loop's shell: the runner's env without fault/test overrides, plus HOME, MDR_TEST_HOOKS=1 and `env`. */
function loopEnv(home: string, env: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(out)) if (k === 'MDR_FAULT' || k.startsWith('MDR_TEST_')) delete out[k]
  pinUserEnv(out)
  return { ...out, HOME: home, MDR_TEST_HOOKS: '1', ...env }
}

/** Run `spec.command` under `bash -c` (what Bash `run_in_background` does), in its own process group. */
export function startLoop(spec: WaiterSpec, o: { home: string; env?: Record<string, string>; shell?: string }): Loop {
  const t0 = Date.now()
  const child = spawn(o.shell ?? 'bash', ['-c', spec.command], { env: loopEnv(o.home, o.env ?? {}), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  let finished = false
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d))
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d))
  const exited = new Promise<LoopExit>((resolve) => {
    child.on('close', (code, signal) => {
      finished = true
      const lines = out.split('\n').filter((l) => l.trim() !== '')
      let parsed: unknown
      if (lines.length === 1) {
        try {
          parsed = JSON.parse(lines[0]!)
        } catch {
          parsed = undefined
        }
      }
      resolve({ code, signal, stdout: out, stderr: err, lines, json: parsed, ms: Date.now() - t0 })
    })
  })
  const loop: Loop = {
    spec,
    child,
    exited,
    done: () => finished,
    exit: (timeoutMs = 15_000) => Promise.race([
      exited,
      sleep(timeoutMs).then(() => {
        throw new Error(`the waiter loop did not exit within ${timeoutMs} ms; stdout=${out.slice(-400)} stderr=${err.slice(-400)}`)
      }),
    ]),
    async kill() {
      if (finished) return
      const signalGroup = (s: NodeJS.Signals): void => {
        try {
          process.kill(-child.pid!, s)
        } catch {
          // already gone
        }
      }
      signalGroup('SIGTERM')
      const t = setTimeout(() => signalGroup('SIGKILL'), 3_000)
      await exited
      clearTimeout(t)
    },
  }
  live.add(loop)
  void exited.then(() => live.delete(loop))
  return loop
}

/** Kill every loop a test left running (call from afterEach). */
export async function killLoops(): Promise<void> {
  await Promise.all([...live].map((l) => l.kill()))
}

// ---------------------------------------------------------------- presence and SSE

/** Presence as the browser sees it (GET /api/review; never an agent request). */
export async function presenceOf(c: WebClient): Promise<Presence> {
  return (await c.review()).presence
}

/** Poll presence (browser route) until `pred` holds; returns it. */
export async function waitPresence(c: WebClient, pred: (p: Presence) => boolean, o: { timeoutMs?: number; everyMs?: number; what?: string } = {}): Promise<Presence> {
  const deadline = Date.now() + (o.timeoutMs ?? 10_000)
  let last: Presence | null = null
  while (Date.now() < deadline) {
    last = await presenceOf(c)
    if (pred(last)) return last
    await sleep(o.everyMs ?? 40)
  }
  throw new Error(`presence never became ${o.what ?? 'what was expected'}; last ${JSON.stringify(last)}`)
}

export type Stamped = BrowserSseEvent & { at: number }

export interface EventLog {
  readonly events: readonly Stamped[]
  /** Index of the next event to arrive. */
  mark(): number
  /** The first event of kind `k` at index >= from matching `where`; rejects after timeoutMs (default 10 s). */
  next<K extends BrowserSseEvent['event']>(k: K, o?: { from?: number; where?: (e: Extract<BrowserSseEvent, { event: K }>) => boolean; timeoutMs?: number }): Promise<Extract<BrowserSseEvent, { event: K }>>
  /** Every event of kind `k` at index >= from. */
  all<K extends BrowserSseEvent['event']>(k: K, from?: number): Array<Extract<BrowserSseEvent, { event: K }>>
  close(): Promise<void>
}

/** Subscribe to the doc channel; resolves once the stream is live (its first event, hello, has arrived). */
export async function recordEvents(c: WebClient): Promise<EventLog> {
  const events: Stamped[] = []
  const waiters = new Set<() => void>()
  let ended = false
  const it = c.events()[Symbol.asyncIterator]()
  const pump = (async () => {
    try {
      for (;;) {
        const r = await it.next()
        if (r.done) break
        events.push({ ...r.value, at: Date.now() } as Stamped)
        for (const w of [...waiters]) w()
      }
    } catch {
      // the stream ended (server restart or close)
    } finally {
      ended = true
      for (const w of [...waiters]) w()
    }
  })()
  const waitFor = <T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> => new Promise<T>((resolve, reject) => {
    const check = (): void => {
      const v = probe()
      if (v !== undefined) {
        done()
        resolve(v)
      } else if (ended) {
        done()
        reject(new Error(`event stream ended while waiting for ${what}; seen ${events.map((e) => e.event).join(', ')}`))
      }
    }
    const t = setTimeout(() => {
      done()
      reject(new Error(`timed out waiting for ${what}; seen ${events.map((e) => e.event).join(', ')}`))
    }, timeoutMs)
    const done = (): void => {
      clearTimeout(t)
      waiters.delete(check)
    }
    waiters.add(check)
    check()
  })
  const log: EventLog = {
    events,
    mark: () => events.length,
    next: (k, o = {}) => waitFor(() => events.slice(o.from ?? 0).find((e) => e.event === k && (!o.where || o.where(e as never))) as never, o.timeoutMs ?? 10_000, `"${k}"`),
    all: (k, from = 0) => events.slice(from).filter((e) => e.event === k) as never,
    async close() {
      // An async generator's return() queues behind the in-flight next(), which resolves only on the next SSE event,
      // so it is not awaited: the webClient fixture's close() aborts the stream and ends the pump.
      void it.return?.().catch(() => undefined)
      void pump
    },
  }
  await waitFor(() => (events.length ? true : undefined), 10_000, 'hello')
  return log
}
