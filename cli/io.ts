// cli/io.ts (P4). Everything the CLI touches outside its own logic, behind one object, so the same command code runs
// as the real process (defaultIo) and in-process in unit tests (the real openDocStore, captured stdout).
import { readFileSync, realpathSync } from 'node:fs'
import type { OpenDocStore, StartServer } from '../shared/types'

export interface CliIo {
  cwd: string
  env: Record<string, string | undefined>
  /** Write to stdout; resolves once the bytes are flushed (the `wait` drain, §9.7 step 3). */
  stdout(s: string): Promise<void>
  stderr(s: string): void
  readStdin(): Promise<string>
  readFile(path: string): string
  openDocStore: OpenDocStore
  startServer: StartServer
  /** The node binary, its flags and the CLI script that re-run this CLI (ensureServer, the waiter loop line). */
  self(): { node: string; execArgv: string[]; script: string }
  /** Resolves on SIGINT / SIGTERM (`serve --foreground`, `wait`). */
  signal: Promise<NodeJS.Signals>
}

export function processIo(o: { openDocStore: OpenDocStore; startServer: StartServer }): CliIo {
  // Installed on first use only (serve --foreground, wait): a SIGINT listener suppresses Node's default exit, so a
  // short command like `mdr batch` must keep the default behaviour.
  let signal: Promise<NodeJS.Signals> | null = null
  const io: CliIo = {
    cwd: process.cwd(),
    env: process.env,
    // resolve on the write callback (the bytes left the process), not on write()'s return value: stdout to a pipe is
    // asynchronous on macOS, and main() exits right after
    stdout: (s) => new Promise((done) => {
      process.stdout.write(s, () => done())
    }),
    stderr: (s) => {
      process.stderr.write(s.endsWith('\n') ? s : s + '\n')
    },
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const c of process.stdin) chunks.push(c as Buffer)
      return Buffer.concat(chunks).toString('utf8')
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    openDocStore: o.openDocStore,
    startServer: o.startServer,
    self: () => {
      const script = process.env.MDR_CLI_JS ?? process.argv[1] ?? ''
      let real = script
      try {
        real = realpathSync(script)
      } catch {
        // keep as given
      }
      return { node: process.execPath, execArgv: [...process.execArgv], script: real }
    },
    get signal() {
      signal ??= new Promise<NodeJS.Signals>((resolve) => {
        process.once('SIGINT', () => resolve('SIGINT'))
        process.once('SIGTERM', () => resolve('SIGTERM'))
      })
      return signal
    },
  }
  return io
}
