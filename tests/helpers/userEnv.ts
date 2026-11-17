// tests/helpers/userEnv.ts (generalization pass). The per-user mdr settings every test process starts from, so no
// developer's own MDR_USER_NAME, MDR_PROTECTED_SEGMENTS, MDR_CMD or MDR_IDLE_EXIT_MIN leaks into a run: the human is
// "TJ" (as on TJ's machine), nothing is protected (the default), the command is `mdr`, the idle exit is the default.
// A test that exercises one of them sets it explicitly.

/** TJ's own protected set (CONTRACT_CHANGES.md, generalization pass): guard tests set MDR_PROTECTED_SEGMENTS to it. */
export const SAMPLE_PROTECTED_SEGMENTS = 'approvals,legal/signed,legal/filed,registry'

export const USER_ENV_KEYS = ['MDR_USER_NAME', 'MDR_PROTECTED_SEGMENTS', 'MDR_CMD', 'MDR_IDLE_EXIT_MIN'] as const

/** Pin `env` in place: MDR_USER_NAME=TJ, MDR_PROTECTED_SEGMENTS='' (explicitly none), MDR_CMD / MDR_IDLE_EXIT_MIN unset. */
export function pinUserEnv(env: Record<string, string | undefined>): void {
  for (const k of USER_ENV_KEYS) delete env[k]
  env.MDR_USER_NAME = 'TJ'
  env.MDR_PROTECTED_SEGMENTS = ''
}

/** Run `fn` with `vars` set on process.env, restoring the previous values afterwards (sync or async). */
export async function withProcessEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
