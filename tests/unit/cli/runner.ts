// tests/unit/cli/runner.ts (P4). Runs the real CLI (cli/main.ts run()) in-process over a test io: captured stdout and
// stderr, a given stdin, P1's real openDocStore for direct mode (a tmp root's own sidecar, doc lock and WAL), and an
// `mdr` self pointing at the source entry. Server-up tests start P1's real server in-process with `realServer`.
import { join } from 'node:path'
import type { OpenDocStore, RunningServer, StartServer } from '../../../shared/types'
import '../../../node/dom'
import { openDocStore } from '../../../node/docstore'
import { startServer } from '../../../server/index'
import type { CliIo } from '../../../cli/io'
import { run } from '../../../cli/main'
import { REPO_ROOT } from '../../helpers/tmpRoot'
import { freePort } from '../handoff/harness'

export interface InProcessRun {
  code: number
  stdout: string
  stderr: string
  /** The single stdout document (undefined when stdout isn't exactly one JSON document). */
  json: any
  docs: number
}

const noServer: StartServer = async () => {
  throw new Error('startServer is not available in in-process CLI tests')
}

export type RealServer = RunningServer & { stop(): Promise<void> }

/**
 * P1's real server (server/index.ts#startServer) in this process, on a free port, test hooks on. `env` is set on
 * process.env only while the server starts (MDR_TEST_PROTOCOL and MDR_TEST_HEARTBEAT_MS are read at start), then
 * restored. stop() closes it with reason 'stop' (the marker goes); idempotent.
 */
export async function realServer(root: string, o: { env?: Record<string, string> } = {}): Promise<RealServer> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(o.env ?? {})) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  let s: RunningServer
  try {
    s = await startServer({ root, port: await freePort(), testHooks: true })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  let stopped = false
  return {
    ...s,
    close: (r) => s.close(r),
    stop: async () => {
      if (stopped) return
      stopped = true
      await s.close('stop')
    },
  }
}

export async function cli(argv: string[], o: {
  cwd?: string
  stdin?: string | object
  env?: Record<string, string | undefined>
  openDocStore?: OpenDocStore
  files?: Record<string, string>
} = {}): Promise<InProcessRun> {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    cwd: o.cwd ?? REPO_ROOT,
    env: { MDR_TEST_HOOKS: '1', ...(o.env ?? {}) },
    stdout: async (s) => {
      stdout += s
    },
    stderr: (s) => {
      stderr += s.endsWith('\n') ? s : s + '\n'
    },
    readStdin: async () => (o.stdin === undefined ? '' : typeof o.stdin === 'string' ? o.stdin : JSON.stringify(o.stdin)),
    readFile: (p) => {
      if (o.files && p in o.files) return o.files[p]!
      throw new Error(`ENOENT: ${p}`)
    },
    openDocStore: o.openDocStore ?? openDocStore,
    startServer: noServer,
    self: () => ({ node: process.execPath, execArgv: ['--import', 'tsx'], script: join(REPO_ROOT, 'cli', 'main.ts') }),
    signal: new Promise(() => {}),
  }
  const code = await run(argv, io)
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  let json: unknown
  let docs = 0
  try {
    json = JSON.parse(stdout)
    docs = 1
  } catch {
    docs = lines.length
  }
  return { code, stdout, stderr, json, docs }
}
