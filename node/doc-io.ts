// node/doc-io.ts (P1). Reading and writing the .md bytes (CONTRACTS §3.1).
//
// - decodeDoc: BOM detection, fatal UTF-8 decode plus the re-encode guard (NOT_UTF8), MAX_DOC_BYTES (TOO_LARGE).
// - readDisk: one read of the file with its stat, hashed in the doc-hash domain (raw bytes, BOM included, D40).
// - writeDocAtomic: tmp file in the same directory (`.<name>.mdr-<pid>-<rand>.tmp`), fsync, the original mode bits
//   (0644 for a new file), rename over the realpath target, fsync(dir). MDR_FAULT after-tmp / after-rename crash
//   between the steps (Appendix A step 8).
// - removeDeadTmps: a writer that died after its tmp write leaves `.<name>.mdr-<pid>-*.tmp`; the next writer removes
//   it when that pid is dead, or is this process (under the lock no write of ours is in flight) (§13 row 7).
import { chmodSync, closeSync, fsyncSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Hash, ReadOnlyCode } from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { sha256Hex } from '../core/hash'
import { fault } from './fault'
import { renameWithRetry } from './rename'

export type DocReadOnly = false | { code: Extract<ReadOnlyCode, 'NOT_UTF8' | 'TOO_LARGE'>; message: string }

/** §3.1 read. `text` is null when the bytes can't be served as text (NOT_UTF8 / TOO_LARGE). */
export function decodeDoc(raw: Buffer, file: string): { text: string | null; bom: boolean; readOnly: DocReadOnly } {
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  if (raw.length > CONSTANTS.MAX_DOC_BYTES) {
    return { text: null, bom, readOnly: { code: 'TOO_LARGE', message: `${file} is ${raw.length} bytes; the limit is ${CONSTANTS.MAX_DOC_BYTES}` } }
  }
  const body = raw.subarray(bom ? 3 : 0)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    // re-encode guard: a decode that doesn't round-trip byte-exactly is not served as text
    if (!Buffer.from(text, 'utf8').equals(body)) throw new Error('re-encode mismatch')
    return { text, bom, readOnly: false }
  } catch {
    return { text: null, bom, readOnly: { code: 'NOT_UTF8', message: `${file} is not valid UTF-8` } }
  }
}

/** `bytes = (bom ? EF BB BF : '') + utf8(text)`. */
export function encodeDoc(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8')
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
}

export interface DiskRead {
  exists: boolean
  raw: Buffer | null
  /** sha256 of the raw bytes (= docHash(text, bom) for a UTF-8 doc); null when missing. */
  hash: Hash | null
  size: number
  mtimeMs: number
}

export function readDisk(abs: string): DiskRead {
  try {
    const raw = readFileSync(abs)
    const st = statSync(abs)
    return { exists: true, raw, hash: sha256Hex(new Uint8Array(raw)), size: raw.length, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false, raw: null, hash: null, size: 0, mtimeMs: 0 }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * §3.6 step 1 stable read: two equal reads WATCH_STABILITY_MS apart, so a truncate-then-write tool is never recorded
 * mid-write. Gives up after `maxTries` (a file rewritten continuously) and returns the last read.
 */
export async function stableRead(abs: string, maxTries = 20): Promise<DiskRead> {
  let a = readDisk(abs)
  for (let i = 0; i < maxTries; i++) {
    await sleep(CONSTANTS.WATCH_STABILITY_MS)
    const b = readDisk(abs)
    if (a.exists === b.exists && a.hash === b.hash) return b
    a = b
  }
  return a
}

/** Write `bytes` over `abs` atomically (tmp + fsync + mode + rename + fsync(dir)). */
export function writeDocAtomic(abs: string, bytes: Buffer, o: { mode?: number } = {}): void {
  const dir = dirname(abs)
  let mode = o.mode
  if (mode === undefined) {
    try {
      mode = statSync(abs).mode & 0o7777
    } catch {
      mode = 0o644
    }
  }
  const tmp = join(dir, `.${basename(abs)}.mdr-${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`)
  const fd = openSync(tmp, 'w', mode)
  try {
    let off = 0
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(tmp, mode)
  fault('after-tmp')
  renameWithRetry(tmp, abs)
  try {
    const dfd = openSync(dir, 'r')
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } catch {
    // some filesystems refuse fsync on a directory; the rename is still durable enough there
  }
  fault('after-rename')
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM'
  }
}

/** Remove `.<name>.mdr-<pid>-*.tmp` files whose writer is dead (or is us, between our own writes). Returns their names. */
export function removeDeadTmps(abs: string): string[] {
  const dir = dirname(abs)
  const prefix = `.${basename(abs)}.mdr-`
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    const m = /^(\d+)-/.exec(name.slice(prefix.length))
    if (!m || pidAlive(Number(m[1]))) continue
    try {
      unlinkSync(join(dir, name))
      removed.push(name)
    } catch {
      // raced with another cleaner
    }
  }
  return removed
}
