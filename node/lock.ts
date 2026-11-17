// node/lock.ts (P1). The per-doc lock (CONTRACTS §3.7, §4.6): proper-lockfile at
// `<dir>/.review/locks/<name>.md.lock` (stale LOCK_STALE_MS, heartbeat LOCK_UPDATE_MS). One lock covers the .md, the
// sidecar and the objects.
//
// - withDocLock: a per-doc async mutex (one chain per abs path, per process) in front of the file lock, so the server's
//   concurrent requests queue in process and only one of them contends for the file lock with other processes. The
//   acquire timeout (LOCK_TIMEOUT_SERVER_MS / LOCK_TIMEOUT_CLI_MS) covers the file lock only → LOCK_TIMEOUT (503 /
//   exit 9). A holder killed mid-transaction leaves a lock that goes stale by heartbeat (10 s) and is stolen (row 17).
//   The lock is never held across a network await (callers do disk work only).
// - isDocLocked: the probe unlocked readers use: a trailing in-flight WAL batch is needsRecovery when the lock is free
//   and a write in progress when it is held (§4.6).
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { CONSTANTS } from '../shared/constants'
import { StoreError } from '../shared/errors'
import { ensureReviewDir } from './review-dir'

/** `<dir>/.review/locks/<name>.md.lock` for the doc at `abs` (not created). */
export function lockPathOf(abs: string): string {
  return join(dirname(abs), '.review', 'locks', `${basename(abs)}.lock`)
}

/** True while a live (non-stale) holder has the doc lock. Never creates anything. */
export async function isDocLocked(abs: string): Promise<boolean> {
  try {
    return await lockfile.check(abs, { lockfilePath: lockPathOf(abs), stale: CONSTANTS.LOCK_STALE_MS, realpath: false })
  } catch {
    // an unreadable lock dir is treated as held: the reader then reports "in progress", never a false recovery
    return true
  }
}

const chains = new Map<string, Promise<void>>()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Acquire the file lock, retrying until the deadline. */
async function acquire(abs: string, timeoutMs: number): Promise<() => Promise<void>> {
  ensureReviewDir(dirname(abs))
  mkdirSync(join(dirname(abs), '.review', 'locks'), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let wait = 20
  for (;;) {
    try {
      return await lockfile.lock(abs, {
        lockfilePath: lockPathOf(abs), stale: CONSTANTS.LOCK_STALE_MS, update: CONSTANTS.LOCK_UPDATE_MS, realpath: false, retries: 0,
        // a compromised lock (stolen after a stall longer than LOCK_STALE_MS) must not crash the process; the WAL and
        // reconcile keep the log consistent whoever writes next
        onCompromised: () => undefined,
      })
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'ELOCKED') {
        throw new StoreError('IO_ERROR', `could not take the doc lock: ${(e as Error).message}`)
      }
      if (Date.now() >= deadline) {
        throw new StoreError('LOCK_TIMEOUT', `the document lock is held by another writer (waited ${timeoutMs} ms)`, {
          hint: 'retry in a moment; a crashed holder goes stale after 10 s',
        })
      }
      await sleep(Math.min(wait, Math.max(1, deadline - Date.now())))
      wait = Math.min(wait * 2, 200)
    }
  }
}

/**
 * Run `fn` under the doc lock: the in-process mutex for `abs` first, then the file lock (timeout → LOCK_TIMEOUT).
 * Released in `finally`, whatever `fn` does.
 */
export async function withDocLock<T>(abs: string, timeoutMs: number, fn: () => Promise<T> | T): Promise<T> {
  const prev = chains.get(abs) ?? Promise.resolve()
  let done!: () => void
  const mine = new Promise<void>((r) => (done = r))
  const tail = prev.then(() => mine)
  chains.set(abs, tail)
  try {
    await prev
    const release = await acquire(abs, timeoutMs)
    try {
      return await fn()
    } finally {
      await release().catch(() => undefined)
    }
  } finally {
    done()
    if (chains.get(abs) === tail) chains.delete(abs)
  }
}
