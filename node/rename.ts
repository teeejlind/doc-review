// node/rename.ts (final pass 2026-11-16): the atomic tmp → target rename every durable write ends with.
//
// On Windows a rename onto a file that another process holds open (a virus scan, OneDrive or Dropbox sync, an editor
// with the file open, the search indexer) fails for a moment with EPERM, EACCES or EBUSY, then succeeds. Node's own
// graceful-fs retries those codes on win32 for the same reason. Here the retry is bounded (about 1.5 s in all) and
// synchronous, because the writers that call it are synchronous. On other platforms those codes are permanent and
// the first error is thrown as before.
import { renameSync } from 'node:fs'

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])
const DELAYS_MS = [10, 20, 40, 80, 120, 160, 200, 250, 300, 300]

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function renameWithRetry(
  from: string,
  to: string,
  o: { platform?: NodeJS.Platform; rename?: (a: string, b: string) => void; sleep?: (ms: number) => void } = {},
): void {
  const rename = o.rename ?? renameSync
  const sleep = o.sleep ?? sleepSync
  const retry = (o.platform ?? process.platform) === 'win32'
  for (let i = 0; ; i++) {
    try {
      rename(from, to)
      return
    } catch (e) {
      const code = (e as { code?: string }).code ?? ''
      if (!retry || !TRANSIENT.has(code) || i >= DELAYS_MS.length) throw e
      sleep(DELAYS_MS[i]!)
    }
  }
}
