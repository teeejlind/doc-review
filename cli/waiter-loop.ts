// cli/waiter-loop.ts (P4). The background waiter loop line `mdr open` / `mdr arm` print as WaiterSpec.command
// (CONTRACTS §9.8.1, D1, D49). Normative shape:
//
//   while :; do out=$(<NODE> <CLI> wait <ABS> --root <ROOT> --waiter <ID> --timeout <T>); rc=$?; case $rc in 2) continue ;; 11) sleep 5; continue ;; esac; printf '%s\n' "$out"; exit $rc; done
//
// <NODE> = q(process.execPath), <CLI> = q(realpath of the running cli.js), <ABS>/<ROOT> = q(abs)/q(root), <ID> a fresh
// `w_` + 16 random hex, <T> = WAIT_DEFAULT_TIMEOUT_S (MDR_TEST_WAIT_TIMEOUT_S under MDR_TEST_HOOKS=1). Exit 2 (timeout
// while connected) re-runs at once and silently; exit 11 (server down until the deadline) sleeps 5 s and re-runs;
// every other code, exit 8 included, prints the last `wait` stdout and exits with it, so the background task's output
// is one JSON line. Valid in bash and zsh. When this CLI runs from source (node flags such as `--import tsx`), those
// flags are kept between <NODE> and <CLI>; the built cli.js never has any, so the line is exactly the shape above.
//
// Generalization pass: the loop line is POSIX shell, so on Windows without one (no Git Bash / MSYS shell found) the
// spec is null and `waiterReason` says why: Send to Claude then copies a prompt (clipboard mode).
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WaiterId, WaiterSpec } from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { q as qRaw, shellPath } from '../shared/handoff-prompt'

/** Quote a path for the loop's bash line (Windows paths with forward slashes: shellPath). */
const q = (s: string): string => qRaw(shellPath(s))

/**
 * Clipboard-primary switch (§0.1, D41, §13 #70): if the final-build S1 re-run fails, the integrator sets this to true
 * and `mdr open` / `mdr arm` print `waiter: null`. No CLI or REST shape changes.
 */
export const CLIPBOARD_PRIMARY = false

export function mintWaiterId(): WaiterId {
  return `w_${randomBytes(8).toString('hex')}`
}

export function waitTimeoutS(env: Record<string, string | undefined>): number {
  if (env.MDR_TEST_HOOKS === '1') {
    const n = Number(env.MDR_TEST_WAIT_TIMEOUT_S)
    if (Number.isFinite(n) && n > 0) return n
  }
  return CONSTANTS.WAIT_DEFAULT_TIMEOUT_S
}

/** process.platform, or MDR_TEST_PLATFORM under MDR_TEST_HOOKS=1 (tests stage Windows on any host). */
export function cliPlatform(env: Record<string, string | undefined>): NodeJS.Platform {
  if (env.MDR_TEST_HOOKS === '1' && env.MDR_TEST_PLATFORM) return env.MDR_TEST_PLATFORM as NodeJS.Platform
  return process.platform
}

const SHELL_EXES = ['bash.exe', 'sh.exe', 'bash', 'sh']

/**
 * Whether the waiter loop's POSIX shell is there. Always on macOS / Linux. On Windows: an MSYS / Git Bash session
 * (MSYSTEM, or SHELL naming a sh), Claude Code's CLAUDE_CODE_GIT_BASH_PATH, or bash.exe / sh.exe on PATH. Never spawns.
 */
export function posixShellAvailable(env: Record<string, string | undefined>, platform: NodeJS.Platform = cliPlatform(env)): boolean {
  if (platform !== 'win32') return true
  if (env.MSYSTEM) return true
  if (env.SHELL && /(^|[\\/])(ba|z|da|k)?sh(\.exe)?$/i.test(env.SHELL)) return true
  const gitBash = env.CLAUDE_CODE_GIT_BASH_PATH
  if (gitBash && existsSync(gitBash)) return true
  const path = env.PATH ?? env.Path ?? ''
  for (const dir of path.split(';')) {
    if (!dir) continue
    for (const exe of SHELL_EXES) if (existsSync(join(dir, exe))) return true
  }
  return false
}

export const WAITER_REASON = {
  clipboardPrimary: 'clipboard-primary build: no waiter loop; Send to Claude copies a prompt to paste here',
  noPosixShell: 'no POSIX shell (bash) found on Windows, and the waiter loop needs one: Send to Claude copies a prompt to paste here instead. Installing Git for Windows (Git Bash) turns the waiter on.',
} as const

/** Why no waiter spec is printed, or null when the loop can run. */
export function waiterUnavailableReason(env: Record<string, string | undefined>, platform: NodeJS.Platform = cliPlatform(env)): string | null {
  if (CLIPBOARD_PRIMARY || (env.MDR_TEST_HOOKS === '1' && env.MDR_TEST_CLIPBOARD_PRIMARY === '1')) return WAITER_REASON.clipboardPrimary
  if (!posixShellAvailable(env, platform)) return WAITER_REASON.noPosixShell
  return null
}

export function waiterEnabled(env: Record<string, string | undefined>, platform: NodeJS.Platform = cliPlatform(env)): boolean {
  return waiterUnavailableReason(env, platform) === null
}

export interface LoopLineInput {
  node: string
  execArgv?: readonly string[]
  cli: string
  abs: string
  root: string
  waiter: WaiterId
  timeoutS: number
}

export function buildLoopLine(i: LoopLineInput): string {
  const node = [q(i.node), ...(i.execArgv ?? []).map(q)].join(' ')
  const wait = `${node} ${q(i.cli)} wait ${q(i.abs)} --root ${q(i.root)} --waiter ${i.waiter} --timeout ${i.timeoutS}`
  return `while :; do out=$(${wait}); rc=$?; case $rc in 2) continue ;; 11) sleep 5; continue ;; esac; printf '%s\\n' "$out"; exit $rc; done`
}

export function waiterSpec(o: { node: string; execArgv?: readonly string[]; cli: string; abs: string; root: string; file: string; port: number; timeoutS: number; waiter?: WaiterId }): WaiterSpec {
  const waiter = o.waiter ?? mintWaiterId()
  return {
    v: 2, root: o.root, file: o.file, abs: o.abs, port: o.port, waiter,
    command: buildLoopLine({ node: o.node, ...(o.execArgv ? { execArgv: o.execArgv } : {}), cli: o.cli, abs: o.abs, root: o.root, waiter, timeoutS: o.timeoutS }),
  }
}
