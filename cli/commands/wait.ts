// cli/commands/wait.ts (P4). Argument handling for `mdr wait` (CONTRACTS §9.4, §9.7); the behaviour is cli/wait.ts.
import { hostname } from 'node:os'
import type { WaiterId } from '../../shared/types'
import { CONSTANTS } from '../../shared/constants'
import { isWaiterId } from '../../shared/ids'
import { mdrCmd } from '../../node/config'
import { cliErr, CliExit } from '../output'
import { deriveWaiterId, runWait, watchdogMsFrom, type WaitTransport } from '../wait'
import { fileOf, flag, opt, type Ctx } from './common'

/** The process start time in ms: the default --waiter-gen, fixed for the life of the process (§8.7). */
export const PROCESS_GEN = Math.round(performance.timeOrigin)

export async function runWaitCommand(ctx: Ctx, transport?: WaitTransport): Promise<CliExit> {
  const at = fileOf(ctx)
  const forever = flag(ctx, 'forever')
  const t = opt(ctx, 'timeout')
  if (forever && t !== undefined) throw cliErr('USAGE', 'pass --timeout or --forever, not both')
  const timeoutS = t === undefined ? CONSTANTS.WAIT_DEFAULT_TIMEOUT_S : Number(t)
  if (!Number.isFinite(timeoutS) || timeoutS < 0) throw cliErr('USAGE', `--timeout must be a number of seconds, got ${JSON.stringify(t)}`)
  const w = opt(ctx, 'waiter')
  const seed = opt(ctx, 'waiterSeed')
  if (w !== undefined && seed !== undefined) throw cliErr('USAGE', 'pass --waiter or --waiter-seed, not both')
  const waiter: WaiterId | string = w ?? deriveWaiterId(seed ?? hostname() + ctx.io.cwd + String(process.ppid), at.abs)
  if (!isWaiterId(waiter)) throw cliErr('USAGE', `--waiter must be w_ + 16 hex, got ${JSON.stringify(waiter)}`)
  const g = opt(ctx, 'waiterGen')
  const gen = g === undefined ? PROCESS_GEN : Number(g)
  if (!Number.isFinite(gen)) throw cliErr('USAGE', `--waiter-gen must be a number, got ${JSON.stringify(g)}`)
  return runWait(
    { abs: at.abs, root: at.root, rel: at.rel, waiter, gen, timeoutMs: forever ? null : timeoutS * 1000, watchdogMs: watchdogMsFrom(ctx.io.env), cmd: mdrCmd(ctx.io.env) },
    { stdout: (s) => ctx.io.stdout(s), signal: ctx.io.signal },
    ...(transport ? [transport] : []),
  )
}
