// node/review-dir.ts (P1; the integrator's day-0 reference implementation, CONTRACTS §3.7).
//
// Every writer that creates a `.review/` directory (doc writes, history, locks, startServer, ensureServer's log and
// lock) calls ensureReviewDir(dir) first. It creates `<dir>/.review` with mode 0700 and writes `.gitignore`
// containing "*\n" (tmp + rename, write-if-absent) BEFORE anything else lands in it, so the bearer token in
// server.json is never un-ignored, even on a root where no doc has been written yet.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Ensures `<dir>/.review` (0700) and its `.gitignore` ("*\n") exist; returns the `.review` path. */
export function ensureReviewDir(dir: string): string {
  const review = join(dir, '.review')
  mkdirSync(review, { recursive: true, mode: 0o700 })
  const gi = join(review, '.gitignore')
  if (!existsSync(gi)) {
    const tmp = join(review, `.gitignore.mdr-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
    writeFileSync(tmp, '*\n', { mode: 0o644 })
    // a concurrent writer may have won the race; both files carry the same bytes, so the rename is harmless
    renameSync(tmp, gi)
  }
  return review
}

/** `<dir>/.review/<...parts>`, creating `.review` (and its .gitignore) and every intermediate directory (0700). */
export function reviewPath(dir: string, ...parts: string[]): string {
  const review = ensureReviewDir(dir)
  if (parts.length > 1) mkdirSync(join(review, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 })
  return join(review, ...parts)
}
