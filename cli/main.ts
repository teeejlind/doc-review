// cli/main.ts (P4). The `mdr` entry point (CONTRACTS §9). One JSON document on stdout per invocation, CliOk-shaped or
// CliErr, with the ERROR_TABLE exit code (§9.1); at most one human stderr line on failure, progress only with
// --verbose. `run()` is the whole CLI over an injectable io (unit tests run it in-process over the real store);
// running this file as a script wires the real process.
import '../node/dom'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { openDocStore } from '../node/docstore'
import { startServer } from '../server/index'
import { parseCommand, type ParsedCommand } from './args'
import type { VersionResult } from '../shared/types'
import { MDR_VERSION } from '../shared/version'
import { runExportDocx, runExportGdoc, runImportGdoc } from './commands/bridge'
import { runConfig } from './commands/config'
import { runTour } from './commands/tour'
import { runDoctor } from './commands/doctor'
import { runHistory, runPending, runSnapshot, runThread } from './commands/read'
import { runArm, runDisarm, runOpen, runStatus } from './commands/review'
import { runPort, runServe, runStop } from './commands/server'
import { runWaitCommand } from './commands/wait'
import { runWrite } from './commands/write'
import type { Ctx } from './commands/common'
import { processIo, type CliIo } from './io'
import { CliExit, failureLine, fromError, render } from './output'

export async function dispatch(ctx: Ctx): Promise<CliExit> {
  switch (ctx.cmd.name) {
    case 'port': return runPort(ctx)
    case 'serve': return runServe(ctx)
    case 'stop': return runStop(ctx)
    case 'open': return runOpen(ctx)
    case 'arm': return runArm(ctx)
    case 'disarm': return runDisarm(ctx)
    case 'status': return runStatus(ctx)
    case 'snapshot': return runSnapshot(ctx)
    case 'pending': return runPending(ctx)
    case 'thread': return runThread(ctx)
    case 'history': return runHistory(ctx)
    case 'doctor': return runDoctor(ctx)
    case 'wait': return runWaitCommand(ctx)
    case 'config': return runConfig(ctx)
    case 'import-gdoc': return runImportGdoc(ctx)
    case 'export-gdoc': return runExportGdoc(ctx)
    case 'export-docx': return runExportDocx(ctx)
    case 'tour': return runTour(ctx)
    case 'comment': case 'reply': case 'suggest': case 'edit-block': case 'write': case 'resolve': case 'reopen':
    case 'decide': case 'withdraw': case 'edit-comment': case 'delete-comment': case 'ack': case 'batch':
      return runWrite(ctx)
  }
}

/** Run one CLI invocation; argv excludes node and the script. Returns the exit code after writing stdout. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const pretty = argv.includes('--pretty')
  const verbose = argv.includes('--verbose')
  let exit: CliExit
  let cmd: ParsedCommand | null = null
  // `mdr --version` (with or without the global flags): no command, exit 0
  if (argv.includes('--version') && argv.every((a) => a === '--version' || a === '--pretty' || a === '--verbose')) {
    const doc: VersionResult = { ok: true, version: MDR_VERSION }
    await io.stdout(render(doc, pretty))
    return 0
  }
  try {
    cmd = parseCommand(argv)
    const ctx: Ctx = { io, cmd, verbose: (m) => (verbose ? io.stderr(`mdr: ${m}`) : undefined) }
    exit = await dispatch(ctx)
  } catch (e) {
    exit = fromError(e)
  }
  if (!exit.printed) await io.stdout(render(exit.doc, pretty))
  const line = exit.code !== 0 && exit.code !== 2 ? failureLine(exit.doc) : null
  if (line) io.stderr(line)
  return exit.code
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const code = await run(argv.slice(2), processIo({ openDocStore, startServer }))
  process.exit(code)
}

const isEntry = ((): boolean => {
  const script = process.argv[1]
  if (!script) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href
  } catch {
    return false
  }
})()
if (isEntry) void main()
