// node/sidecar-io.ts (P1). Sidecar file I/O (CONTRACTS §4.1, §4.6, §4.8).
//
// - createSidecar: the header plus the first batch in ONE write on an open(O_CREAT | O_EXCL) fd, then fsync (§4.1
//   lazy creation). EEXIST means another writer created it first: the caller re-reads and appends under the lock.
// - appendSidecar: ONE write() on an O_APPEND fd, then fsync (§4.6 step 4). A batch is never split across writes, so
//   a partial batch can only be a torn tail.
// - truncateTornTail: cut the file back to the end of its last good line (ftruncate + fsync); the caller appends
//   server.recovered { what: 'torn-tail' } (§4.6).
// - MDR_FAULT=mid-append:<n> writes the first n bytes of a batch and crashes (node/fault.ts).
// The doctor half (report, --repair, --compact, --gc) is below; mdr doctor (P4) calls it under the doc lock.
import { closeSync, constants as FS, fsyncSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import type { SidecarEvent, SidecarHeader } from '../shared/types'
import { crashMidAppend, midAppendBytes } from './fault'

export function sidecarPathOf(abs: string): string {
  return abs + '.review.jsonl'
}

/** JSONL text for `lines` (each '\n'-terminated). */
export function serializeLines(lines: ReadonlyArray<SidecarEvent | SidecarHeader>): string {
  return lines.map((l) => JSON.stringify(l) + '\n').join('')
}

function writeAll(fd: number, buf: Buffer): void {
  const partial = midAppendBytes()
  if (partial !== null && partial < buf.length) {
    let off = 0
    while (off < partial) off += writeSync(fd, buf, off, partial - off)
    fsyncSync(fd)
    closeSync(fd)
    crashMidAppend()
  }
  let off = 0
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
}

/** Create the sidecar with its header and first lines, in one write (O_CREAT | O_EXCL). Returns the bytes written. */
export function createSidecar(path: string, header: SidecarHeader, lines: readonly SidecarEvent[]): number {
  const buf = Buffer.from(serializeLines([header, ...lines]), 'utf8')
  const fd = openSync(path, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY, 0o644)
  try {
    writeAll(fd, buf)
    fsyncSync(fd)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // already closed by a mid-append fault
    }
  }
  return buf.length
}

/** Append `lines` in one write on an O_APPEND fd, then fsync. Returns the bytes written. */
export function appendSidecar(path: string, lines: readonly SidecarEvent[]): number {
  if (!lines.length) return 0
  const buf = Buffer.from(serializeLines(lines), 'utf8')
  const fd = openSync(path, FS.O_APPEND | FS.O_WRONLY)
  try {
    writeAll(fd, buf)
    fsyncSync(fd)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // already closed by a mid-append fault
    }
  }
  return buf.length
}

/** Cut the sidecar back to `validBytes` (the end of its last complete, valid line). */
export function truncateTornTail(path: string, validBytes: number): number {
  const size = statSync(path).size
  if (size <= validBytes) return 0
  const fd = openSync(path, FS.O_WRONLY)
  try {
    ftruncateSync(fd, validBytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return size - validBytes
}

export function readSidecarBytes(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}
