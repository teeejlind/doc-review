// cli/exit.ts (P4). Exit codes (CONTRACTS §8.2, §9.1, D49). ERROR_TABLE in shared/types.ts is normative; this module
// only names the non-error codes and maps an ErrorCode to its exit code.
//   0   ok (including duplicate / noop results)
//   2   `wait` timed out while connected (not an error; the waiter loop re-runs it)
//   1, 3–10, 130   ERROR_TABLE
//   11  `wait` gave up on a server that stayed down (SERVER_UNREACHABLE): the only code the loop retries after 5 s
// Generalization pass: the actions name the command Claude runs (MDR_CMD || 'mdr') and the human by display name.
import type { ErrorCode } from '../shared/types'
import { ERROR_TABLE } from '../shared/constants'
import { mdrCmd } from '../node/config'
import { nameForAgent } from '../node/identity'

export const EXIT_OK = 0
export const EXIT_WAIT_TIMEOUT = 2

export function exitCodeFor(code: ErrorCode): number {
  return ERROR_TABLE[code].exit
}

/** Codes a waiter loop must never retry (exit 8: a fix is needed first, D49). */
export const NON_RETRYABLE_WAIT_CODES: readonly ErrorCode[] = ['PROTOCOL_MISMATCH', 'ROOT_MISMATCH']

/** The action the skill takes for each exit code (references/troubleshooting.md and references/cli.md draw on it). */
export function exitActions(o: { cmd?: string; who?: string } = {}): Readonly<Record<number, string>> {
  const cmd = o.cmd ?? mdrCmd()
  const who = o.who ?? nameForAgent()
  return {
    0: 'ok: act on the result',
    1: `INTERNAL: report it in one line and run \`${cmd} status\``,
    2: 'wait timed out while connected: the waiter loop re-runs it silently',
    3: 'bad request or usage: fix the command or the JSON and retry',
    4: 'refused (auth, protected root, path outside root, not the author, suggest-only, read-only, unanchorable): change the request, never force it',
    5: `not found (file, thread, comment, suggestion, version, block, quote): re-read with \`${cmd} snapshot\` or \`${cmd} pending\``,
    6: 'quote ambiguous: pass --occurrence N or --near bN --base-rev R',
    7: 'conflict or stale revision: re-read (use `current` / `remap`) and retry',
    8: `server start / protocol / root mismatch: do not retry; PROTOCOL_MISMATCH → tell ${who} to run \`${cmd} serve <root> --restart\``,
    9: `storage problem (lock timeout, corrupt sidecar, read-only doc, splice mismatch): report it; \`${cmd} doctor\` diagnoses`,
    10: 'the waiter was superseded, disarmed or the server stopped: nothing is waiting; do not retry',
    11: 'wait gave up on a server that stayed down: the waiter loop sleeps 5 s and re-runs it',
    130: 'interrupted',
  }
}

let actions: Readonly<Record<number, string>> | null = null
const table = (): Readonly<Record<number, string>> => (actions ??= exitActions())

/** exitActions() for this process, built on first read (so a plain CLI run never resolves the display name for it). */
export const EXIT_ACTIONS: Readonly<Record<number, string>> = new Proxy({} as Record<number, string>, {
  get: (_t, k) => (typeof k === 'string' ? table()[Number(k)] : undefined),
  has: (_t, k) => typeof k === 'string' && Number(k) in table(),
  ownKeys: () => Object.keys(table()),
  getOwnPropertyDescriptor: (_t, k) => (typeof k === 'string' && Number(k) in table()
    ? { value: table()[Number(k)], enumerable: true, configurable: true, writable: false }
    : undefined),
})
