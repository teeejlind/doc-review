// tests/helpers/runCli.ts (integrator, day 0; CONTRACTS §1.2, §1.3, §9.1).
//
// Spawns the e2e build of the CLI (`node .e2e-dist/cli.js ...`), never `dist/` (D20) and never tsx. Every run checks
// the §9.1 output contract: stdout holds exactly one JSON document. `runCli` waits for exit; `spawnCli` returns a
// handle for long-running commands (`wait`, `serve --foreground`, the waiter loop line).
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { REPO_ROOT } from './tmpRoot'
import { pinUserEnv } from './userEnv'

/** The CLI every e2e helper spawns (§1.2). */
export const E2E_CLI = join(REPO_ROOT, '.e2e-dist', 'cli.js')

export interface RunCliOptions {
  cwd?: string
  /** Merged over the inherited env; `undefined` deletes a key. */
  env?: Record<string, string | undefined>
  /** Written to stdin (objects are JSON-encoded), then stdin is closed. Omitted: stdin closed at once. */
  stdin?: string | object
  /** Default .e2e-dist/cli.js. */
  cliPath?: string
  /** Kill with SIGKILL after this long. Default 60 s. */
  timeoutMs?: number
  /** tmp HOME (TmpRoot.home). */
  home?: string
  /** Sets MDR_TEST_HOOKS=1 (default true; e2e only, §1.3). */
  testHooks?: boolean
}

export interface CliRun {
  /** Exit code; null when killed by a signal. */
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** The single stdout JSON document, or undefined when stdout is not exactly one document. */
  json: unknown
  /** How many JSON documents stdout holds (the §9.1 contract wants exactly 1). */
  docs: number
  /** json.ok === true */
  ok: boolean
}

/**
 * Count and parse the JSON documents on stdout. One compact or pretty document → docs 1. Several (one per line, or
 * concatenated) → docs n and json undefined. Non-JSON noise counts as a failure (docs 0).
 */
export function parseCliStdout(stdout: string): { json: unknown; docs: number } {
  const s = stdout.trim()
  if (s === '') return { json: undefined, docs: 0 }
  try {
    return { json: JSON.parse(s) as unknown, docs: 1 }
  } catch {
    // fall through: maybe several documents
  }
  let docs = 0
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      JSON.parse(t)
      docs++
    } catch {
      return { json: undefined, docs: 0 }
    }
  }
  return { json: undefined, docs }
}

function childEnv(o: RunCliOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // never leak a fault or test override from the runner's own env into a child unless asked
  for (const k of Object.keys(env)) if (k === 'MDR_FAULT' || k.startsWith('MDR_TEST_')) delete env[k]
  // nor the developer's own mdr settings: the human is "TJ", nothing is protected, MDR_CMD unset (o.env overrides)
  pinUserEnv(env)
  if (o.testHooks !== false) env.MDR_TEST_HOOKS = '1'
  else delete env.MDR_TEST_HOOKS
  if (o.home) env.HOME = o.home
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

export interface CliProcess {
  readonly child: ChildProcess
  stdout(): string
  stderr(): string
  /** Resolves on exit with the parsed result. */
  readonly exited: Promise<CliRun>
  kill(signal?: NodeJS.Signals): void
  /** Resolves when stdout (or stderr) contains `text`; rejects after timeoutMs. */
  waitFor(text: string | RegExp, o?: { stream?: 'stdout' | 'stderr'; timeoutMs?: number }): Promise<void>
}

export function spawnCli(args: readonly string[], o: RunCliOptions = {}): CliProcess {
  const child = spawn(process.execPath, [o.cliPath ?? E2E_CLI, ...args], {
    cwd: o.cwd ?? REPO_ROOT,
    env: childEnv(o),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const waiters = new Set<() => void>()
  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', (d: string) => {
    out += d
    for (const w of waiters) w()
  })
  child.stderr!.on('data', (d: string) => {
    err += d
    for (const w of waiters) w()
  })
  if (o.stdin !== undefined) child.stdin!.end(typeof o.stdin === 'string' ? o.stdin : JSON.stringify(o.stdin))
  else child.stdin!.end()
  const timer = o.timeoutMs === Infinity ? null : setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 60_000)
  timer?.unref()
  const exited = new Promise<CliRun>((res) => {
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      const { json, docs } = parseCliStdout(out)
      const ok = typeof json === 'object' && json !== null && (json as { ok?: unknown }).ok === true
      res({ code, signal, stdout: out, stderr: err, json, docs, ok })
    })
  })
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    kill: (signal = 'SIGTERM') => {
      child.kill(signal)
    },
    waitFor: (text, w = {}) =>
      new Promise<void>((res, rej) => {
        const hit = (): boolean => {
          const s = w.stream === 'stderr' ? err : out
          return typeof text === 'string' ? s.includes(text) : text.test(s)
        }
        if (hit()) return res()
        const t = setTimeout(() => {
          waiters.delete(check)
          rej(new Error(`spawnCli: timed out waiting for ${String(text)}; stdout=${out.slice(-500)} stderr=${err.slice(-500)}`))
        }, w.timeoutMs ?? 10_000)
        const check = (): void => {
          if (!hit()) return
          clearTimeout(t)
          waiters.delete(check)
          res()
        }
        waiters.add(check)
        void exited.then(() => {
          if (!waiters.has(check)) return
          clearTimeout(t)
          waiters.delete(check)
          if (hit()) res()
          else rej(new Error(`spawnCli: exited before ${String(text)}; stdout=${out.slice(-500)} stderr=${err.slice(-500)}`))
        })
      }),
  }
}

/** Run one CLI command to completion. Never throws for a non-zero exit; assert on `code` and `json`. */
export function runCli(args: readonly string[], o: RunCliOptions = {}): Promise<CliRun> {
  return spawnCli(args, o).exited
}
