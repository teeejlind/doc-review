// server/marker.ts (P1). The ONLY writer of <root>/.review/server.json (CONTRACTS §9.2.1).
//
// - Token: if the existing marker parses and its root === the served root, reuse its token (D16); otherwise 32 random
//   bytes as 64 hex chars.
// - Write: tmp file in .review/ with mode 0600, fsync, rename, fsync(dir).
// - Cleanup: delete the marker only if it still carries this server's serverId (a newer server for the same root may
//   have replaced it). A crash leaves a stale marker; discovery ignores it and the next start overwrites it.
// startServer calls markerToken before binding and writeMarker after (§9.2.1 order).
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerMarker } from '../shared/types'
import { ensureReviewDir } from '../node/review-dir'
import { renameWithRetry } from '../node/rename'

export function markerPath(root: string): string {
  return join(root, '.review', 'server.json')
}

function readRaw(root: string): Partial<ServerMarker> | null {
  try {
    const v = JSON.parse(readFileSync(markerPath(root), 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Partial<ServerMarker>) : null
  } catch {
    return null
  }
}

/** The bearer token for a server on `root`: the existing marker's when it names the same root, else a fresh one. */
export function markerToken(root: string): string {
  const m = readRaw(root)
  if (m && m.root === root && typeof m.token === 'string' && /^[0-9a-f]{64}$/.test(m.token)) return m.token
  return randomBytes(32).toString('hex')
}

/** Atomically writes the marker (0600, fsync, rename, fsync dir) and returns it. */
export function writeMarker(m: ServerMarker): ServerMarker {
  const review = ensureReviewDir(m.root)
  const tmp = join(review, `.server.json.mdr-${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(m) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameWithRetry(tmp, markerPath(m.root))
  try {
    const dfd = openSync(review, 'r')
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } catch {
    // fsync on a directory is best effort on some filesystems
  }
  return m
}

/** Removes the marker iff it still carries `serverId`. Returns whether it was removed. */
export function removeMarkerIfOurs(root: string, serverId: string): boolean {
  const m = readRaw(root)
  if (!m || m.serverId !== serverId) return false
  try {
    unlinkSync(markerPath(root))
    return true
  } catch {
    return false
  }
}
