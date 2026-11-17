// node/history.ts (P1). History storage and the read side of §10.
//
// Layout (§3.7): `<dir>/.review/history/<name>.md/index.jsonl` holds one VersionMeta per line (append-only except the
// retention rewrite); `objects/<hash>.md.gz` holds the gzip of a rev's raw bytes (BOM included), content-addressed by
// docHash, written if absent via tmp + rename. Objects double as the §3.8 rev objects (the bases for external diffs
// and 3-way merges), so readers use them for `rev:N` refs too.
//
// Reads (M1): list / show / diff. Diff aligns blocks by hash (diffBlocks), carries a word-level dmp diff on
// `replace`, and attributes each changed block to the authors of the intermediate versions in (from, to] that touched
// it, by following block lineage through every intermediate version (§10 "Diff").
// Writes (objects, index appends, the retention rewrite and objects GC) are used by the M2 commit path under the doc
// lock; they never run on a readOnly store.
// - Retention (§10; server start, then hourly, under the lock): everything younger than 7 days; days 7–90 the last
//   version per (UTC day, actor) plus every restore / claude-write / accept / external; older than 90 days the last per
//   ISO week; always the newest 20; then a 50 MB cap per doc where the oldest go first (never the newest 20).
// - Objects GC (§3.8): keeps every object the index references plus the set the store pins (head, the last
//   OBJECT_KEEP_REVS revs, an open TJ session's base, Claude's ack rev and the revs a windowed BlockSide after it
//   references); everything else, and dead writers' tmp files, is deleted.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type {
  Actor, DiffBlock, Hash, HistoryDiff, HistoryList, HistoryRef, VersionCause, VersionId, VersionMeta, VersionShow, Warning,
} from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { StoreError } from '../shared/errors'
import { VersionMetaSchema } from '../shared/schemas'
import type { Md } from '../core/md/index'
import { load, type Loaded } from '../core/splice/load'
import { diffBlocks } from '../core/blocks'
import { wordDiff } from '../core/diff'
import { ensureReviewDir } from './review-dir'
import { renameWithRetry } from './rename'

export interface HistoryPaths {
  /** `<dir>/.review/history/<name>.md` */
  dir: string
  index: string
  objects: string
}

/** Paths only; nothing is created. */
export function historyPaths(abs: string): HistoryPaths {
  const dir = join(dirname(abs), '.review', 'history', basename(abs))
  return { dir, index: join(dir, 'index.jsonl'), objects: join(dir, 'objects') }
}

export function objectPath(abs: string, hash: Hash): string {
  return join(historyPaths(abs).objects, `${hash}.md.gz`)
}

// ===================================================================================== bytes

const BOM = [0xef, 0xbb, 0xbf] as const

/** Raw bytes → decoded text without the BOM (objects are always valid UTF-8: they were a rev's served text). */
export function decodeRaw(raw: Uint8Array): { text: string; bom: boolean } {
  const bom = raw.length >= 3 && raw[0] === BOM[0] && raw[1] === BOM[1] && raw[2] === BOM[2]
  return { text: new TextDecoder('utf-8').decode(raw.subarray(bom ? 3 : 0)), bom }
}

export function encodeRaw(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8')
  return bom ? Buffer.concat([Buffer.from(BOM), body]) : body
}

/** The raw bytes of object(hash), or null when it is gone. */
export function readObject(abs: string, hash: Hash): Buffer | null {
  try {
    return gunzipSync(readFileSync(objectPath(abs, hash)))
  } catch {
    return null
  }
}

export function readObjectText(abs: string, hash: Hash): { text: string; bom: boolean } | null {
  const raw = readObject(abs, hash)
  return raw === null ? null : decodeRaw(raw)
}

/** Write object(hash) if absent: gzip to a tmp file in objects/, fsync, rename (§3.7, §3.8). Returns true if written. */
export function writeObject(abs: string, hash: Hash, raw: Uint8Array): boolean {
  const target = objectPath(abs, hash)
  if (existsSync(target)) return false
  ensureReviewDir(dirname(abs))
  const { objects } = historyPaths(abs)
  mkdirSync(objects, { recursive: true, mode: 0o700 })
  const tmp = join(objects, `.${hash}.mdr-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
  const fd = openSync(tmp, 'w', 0o644)
  try {
    writeSync(fd, gzipSync(raw))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameWithRetry(tmp, target)
  return true
}

// ===================================================================================== index

/** Every valid VersionMeta in file order; a torn tail or a bad line is skipped with a warning (never thrown). */
export function readIndex(abs: string): { versions: VersionMeta[]; warnings: Warning[] } {
  const { index } = historyPaths(abs)
  let text: string
  try {
    text = readFileSync(index, 'utf8')
  } catch {
    return { versions: [], warnings: [] }
  }
  const versions: VersionMeta[] = []
  const warnings: Warning[] = []
  const lines = text.split('\n')
  lines.pop() // '' after the last '\n', or a torn tail: never read
  lines.forEach((line, i) => {
    if (line === '') return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      raw = undefined
    }
    const r = VersionMetaSchema.safeParse(raw)
    if (r.success) versions.push(r.data as VersionMeta)
    else warnings.push({ code: 'SIDECAR_INVALID_EVENT', message: `history index line ${i + 1} is invalid (skipped)`, line: i + 1 })
  })
  versions.sort((a, b) => a.n - b.n)
  return { versions, warnings }
}

/** Append one VersionMeta line (one write, fsync). The caller holds the doc lock. */
export function appendVersion(abs: string, meta: VersionMeta): void {
  ensureReviewDir(dirname(abs))
  const { dir, index } = historyPaths(abs)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const fd = openSync(index, 'a', 0o644)
  try {
    writeSync(fd, JSON.stringify(meta) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Bytes used by this doc's history (index + objects); 0 when there is none. */
export function historyBytes(abs: string): number {
  const { dir, index, objects } = historyPaths(abs)
  if (!existsSync(dir)) return 0
  let total = 0
  try {
    total += statSync(index).size
  } catch {
    // no index yet
  }
  try {
    for (const name of readdirSync(objects)) total += statSync(join(objects, name)).size
  } catch {
    // no objects yet
  }
  return total
}

// ===================================================================================== writes (M2, under the doc lock)

/** Rewrite the whole index (tmp + rename): the retention pass is the only non-append writer. */
export function rewriteIndex(abs: string, versions: readonly VersionMeta[]): void {
  ensureReviewDir(dirname(abs))
  const { dir, index } = historyPaths(abs)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.index.jsonl.mdr-${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`)
  const fd = openSync(tmp, 'w', 0o644)
  try {
    writeSync(fd, versions.map((v) => JSON.stringify(v) + '\n').join(''))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameWithRetry(tmp, index)
}

export interface NewVersion {
  cause: VersionCause
  by: Actor
  rev: number
  revs: [number, number]
  /** docHash of the version's raw bytes. */
  hash: Hash
  /** The raw bytes (BOM included), written as the object if absent. */
  raw: Buffer
  text: string
  restoredFrom?: VersionId
}

/**
 * Append a version unless its hash equals the latest version's (§10 "A version is skipped when its hash equals the
 * latest version's hash"). `blocksChanged` counts the blocks the diff from the previous version touches. Returns the
 * new meta, or null when skipped.
 */
export function addVersion(
  md: Md, abs: string, nv: NewVersion,
  o: { now?: Date; prevText?: (hash: Hash) => string | null; loadOf?: (text: string, base?: Loaded) => Loaded } = {},
): VersionMeta | null {
  const { versions } = readIndex(abs)
  const last = versions[versions.length - 1]
  if (last && last.hash === nv.hash) return null
  let blocksChanged = 0
  if (last) {
    const prev = o.prevText?.(last.hash) ?? readObjectText(abs, last.hash)?.text ?? null
    if (prev !== null) {
      const loadOf = o.loadOf ?? ((text: string) => load(md, text))
      const cur = loadOf(nv.text)
      for (const d of diffBlocks(loadOf(prev, cur).blocks, cur.blocks)) if (d.op !== 'equal') blocksChanged += Math.max(d.an, d.bn)
    }
  }
  const n = (last?.n ?? 0) + 1
  writeObject(abs, nv.hash, nv.raw)
  const meta: VersionMeta = {
    v: `v${n}`, n, rev: nv.rev, hash: nv.hash, by: nv.by, cause: nv.cause, at: (o.now ?? new Date()).toISOString(),
    size: nv.raw.length, revs: [nv.revs[0], nv.revs[1]], blocksChanged,
    ...(nv.restoredFrom ? { restoredFrom: nv.restoredFrom } : {}),
  }
  appendVersion(abs, meta)
  return meta
}

const DAY_MS = 86_400_000
const RETAIN_ALWAYS: ReadonlySet<VersionCause> = new Set(['restore', 'claude-write', 'accept', 'external'])

/** ISO-8601 week key (`2026-W42`) of a UTC instant. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * §10 retention over `versions` (oldest first) at `now`: which version numbers stay. `objectBytes(hash)` sizes the
 * 50 MB cap (each distinct object counted once, plus the index line).
 */
export function retentionPlan(versions: readonly VersionMeta[], now: Date, objectBytes: (hash: Hash) => number, maxBytes: number = CONSTANTS.HISTORY_MAX_BYTES): Set<number> {
  const keep = new Set<number>()
  const nowMs = now.getTime()
  const lastOf = new Map<string, number>()
  for (const v of versions) {
    const age = nowMs - Date.parse(v.at)
    if (!(age >= CONSTANTS.HISTORY_KEEP_ALL_DAYS * DAY_MS)) {
      keep.add(v.n)
      continue
    }
    if (age < CONSTANTS.HISTORY_DAILY_DAYS * DAY_MS) {
      if (RETAIN_ALWAYS.has(v.cause)) keep.add(v.n)
      lastOf.set(`d:${v.at.slice(0, 10)}:${v.by}`, v.n)
    } else {
      lastOf.set(`w:${isoWeekKey(new Date(v.at))}`, v.n)
    }
  }
  for (const n of lastOf.values()) keep.add(n)
  const newest = versions.slice(-CONSTANTS.HISTORY_KEEP_LATEST).map((v) => v.n)
  for (const n of newest) keep.add(n)
  // the cap: the oldest kept versions go first, never the newest 20
  const protectedN = new Set(newest)
  const total = (): number => {
    const seen = new Set<Hash>()
    let bytes = 0
    for (const v of versions) {
      if (!keep.has(v.n)) continue
      bytes += JSON.stringify(v).length + 1
      if (seen.has(v.hash)) continue
      seen.add(v.hash)
      bytes += objectBytes(v.hash)
    }
    return bytes
  }
  for (const v of versions) {
    if (total() <= maxBytes) break
    if (keep.has(v.n) && !protectedN.has(v.n)) keep.delete(v.n)
  }
  return keep
}

function objectFileBytes(abs: string, hash: Hash): number {
  try {
    return statSync(objectPath(abs, hash)).size
  } catch {
    return 0
  }
}

/** Run retention now: rewrite the index without the dropped versions. Returns how many were dropped. */
export function applyRetention(abs: string, now: Date = new Date()): number {
  const { versions } = readIndex(abs)
  if (!versions.length) return 0
  const keep = retentionPlan(versions, now, (h) => objectFileBytes(abs, h))
  if (keep.size === versions.length) return 0
  rewriteIndex(abs, versions.filter((v) => keep.has(v.n)))
  return versions.length - keep.size
}

function pidDead(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as { code?: string }).code !== 'EPERM'
  }
}

/** Objects GC (§3.8): delete every object neither the index references nor `pinned` names. Returns the deleted hashes. */
export function gcObjects(abs: string, pinned: ReadonlySet<Hash>): Hash[] {
  const { objects } = historyPaths(abs)
  let names: string[]
  try {
    names = readdirSync(objects)
  } catch {
    return []
  }
  const keep = new Set<Hash>(pinned)
  for (const v of readIndex(abs).versions) keep.add(v.hash)
  const removed: Hash[] = []
  for (const name of names) {
    const m = /^([0-9a-f]{64})\.md\.gz$/.exec(name)
    if (m) {
      if (keep.has(m[1]!)) continue
      try {
        unlinkSync(join(objects, name))
        removed.push(m[1]!)
      } catch {
        // already gone
      }
      continue
    }
    const t = /\.mdr-(\d+)-[^.]*\.tmp$/.exec(name)
    if (t && pidDead(Number(t[1]))) {
      try {
        unlinkSync(join(objects, name))
      } catch {
        // already gone
      }
    }
  }
  return removed
}

/** Hashes of every object file present (for doctor's orphan count). */
export function listObjects(abs: string): Hash[] {
  try {
    return readdirSync(historyPaths(abs).objects).map((n) => /^([0-9a-f]{64})\.md\.gz$/.exec(n)?.[1]).filter((h): h is Hash => h !== undefined)
  } catch {
    return []
  }
}

// ===================================================================================== reads

/** What the store knows about the current doc and its rev log, for list/diff. */
export interface HistoryCurrent {
  file: string
  rev: number
  hash: Hash
  text: string
  /** Actor of the last non-void doc.rev (who wrote the current bytes); 'external' when there is none. */
  lastBy: Actor
  /** Hash of a non-void rev, from the sidecar's doc.rev lines. */
  revHash(rev: number): Hash | undefined
  /** Actor of a non-void rev's doc.rev. */
  revBy(rev: number): Actor | undefined
}

const metaOnly = (v: VersionMeta): VersionMeta => ({ ...v, revs: [v.revs[0], v.revs[1]] })

export function historyList(abs: string, cur: HistoryCurrent, o?: { limit?: number }): Omit<HistoryList, 'via'> {
  const { versions } = readIndex(abs)
  const newestFirst = [...versions].reverse().map(metaOnly)
  const last = versions[versions.length - 1]
  const limit = o?.limit !== undefined && Number.isFinite(o.limit) && o.limit >= 0 ? Math.floor(o.limit) : undefined
  return {
    ok: true, file: cur.file, versions: limit !== undefined ? newestFirst.slice(0, limit) : newestFirst,
    currentRev: cur.rev, currentHash: cur.hash, unsnapshotted: !last || last.hash !== cur.hash,
  }
}

export function historyShow(abs: string, v: VersionId): Omit<VersionShow, 'via'> {
  const ver = readIndex(abs).versions.find((x) => x.v === v)
  if (!ver) throw new StoreError('VERSION_NOT_FOUND', `version ${v} not found`)
  const obj = readObjectText(abs, ver.hash)
  if (!obj) throw new StoreError('VERSION_NOT_FOUND', `version ${v}'s bytes are no longer retained`)
  return { ok: true, meta: metaOnly(ver), markdown: obj.text }
}

/** One end of a diff: its text, its wire side, and its position p (versions[0..p) are at or before it). */
interface End {
  side: HistoryDiff['from']
  text: string
  p: number
  /** Index of the version this end IS, or null for current / a rev that has no version. */
  k: number | null
  /** Who wrote this end's bytes when it is not a version (current, rev:N); null for a version. */
  by: Actor | null
}

function resolveEnd(abs: string, versions: VersionMeta[], cur: HistoryCurrent, ref: HistoryRef): End {
  if (ref === 'current') {
    const k = versions.length > 0 && versions[versions.length - 1]!.hash === cur.hash ? versions.length - 1 : null
    return { side: { current: true, rev: cur.rev, hash: cur.hash }, text: cur.text, p: versions.length, k, by: k === null ? cur.lastBy : null }
  }
  if (ref.startsWith('rev:')) {
    const rev = Number(ref.slice(4))
    const hash = rev === cur.rev ? cur.hash : cur.revHash(rev)
    if (hash === undefined) throw new StoreError('VERSION_NOT_FOUND', `rev ${rev} is not in this doc's log`)
    const text = hash === cur.hash ? cur.text : readObjectText(abs, hash)?.text
    if (text === undefined) throw new StoreError('VERSION_NOT_FOUND', `rev ${rev}'s bytes are no longer retained`)
    const k = versions.findIndex((x) => x.hash === hash && x.revs[0] <= rev && rev <= x.revs[1])
    if (k >= 0) return { side: metaOnly(versions[k]!), text, p: k + 1, k, by: null }
    const p = versions.filter((x) => x.rev <= rev).length
    return { side: { current: true, rev, hash }, text, p, k: null, by: cur.revBy(rev) ?? 'external' }
  }
  const k = versions.findIndex((x) => x.v === ref)
  if (k < 0) throw new StoreError('VERSION_NOT_FOUND', `version ${ref} not found`)
  const ver = versions[k]!
  const text = ver.hash === cur.hash ? cur.text : readObjectText(abs, ver.hash)?.text
  if (text === undefined) throw new StoreError('VERSION_NOT_FOUND', `version ${ref}'s bytes are no longer retained`)
  return { side: metaOnly(ver), text, p: k + 1, k, by: null }
}

interface Lineage {
  /** Indexes of `from` blocks this block descends from (itself, when unchanged since `from`). */
  origins: Set<number>
  authors: Set<Actor>
  /** Step index of the latest change, and its author. */
  last: { step: number; by: Actor } | null
}

const later = (a: Lineage['last'], b: Lineage['last']): Lineage['last'] => (!a ? b : !b ? a : b.step >= a.step ? b : a)

/**
 * HistoryDiff from → to (§10). Blocks align by hash; `replace` carries a word diff; `by` / `lastBy` come from the block
 * lineage through every intermediate version in (from, to]. A reverse diff (to before from) carries no attribution.
 */
export function historyDiff(md: Md, abs: string, cur: HistoryCurrent, from: HistoryRef, to: HistoryRef): Omit<HistoryDiff, 'via'> {
  const { versions } = readIndex(abs)
  const a = resolveEnd(abs, versions, cur, from)
  const b = resolveEnd(abs, versions, cur, to)
  const La = load(md, a.text)
  const Lb = load(md, b.text)

  // the chain of texts from `a` to `b`, each step with its author
  const steps: Array<{ L: Loaded; by: Actor }> = []
  const forward = a.p <= b.p
  if (forward) {
    let prevHash = versions[a.k ?? -1]?.hash ?? null
    const lastK = b.k ?? b.p - 1
    for (let k = a.p; k <= lastK && k < versions.length; k++) {
      const ver = versions[k]!
      if (ver.hash === prevHash) continue
      const text = ver.hash === cur.hash ? cur.text : readObjectText(abs, ver.hash)?.text
      if (text === undefined) continue
      steps.push({ L: load(md, text), by: ver.by })
      prevHash = ver.hash
    }
    if (b.k === null) {
      const endText = steps.length ? steps[steps.length - 1]!.L.src : a.text
      if (endText !== b.text) steps.push({ L: Lb, by: b.by ?? 'external' })
    }
  }

  // follow lineage through the steps
  let info: Lineage[] = La.blocks.map((_, i) => ({ origins: new Set([i]), authors: new Set(), last: null }))
  const deleters: Lineage[] = La.blocks.map(() => ({ origins: new Set(), authors: new Set(), last: null }))
  let prev = La
  steps.forEach((st, step) => {
    const next: Lineage[] = new Array(st.L.blocks.length)
    for (const d of diffBlocks(prev.blocks, st.L.blocks)) {
      if (d.op === 'equal') {
        for (let n = 0; n < d.n; n++) next[d.b + n] = info[d.a + n]!
        continue
      }
      const merged: Lineage = { origins: new Set(), authors: new Set([st.by]), last: { step, by: st.by } }
      for (let n = 0; n < d.an; n++) {
        const x = info[d.a + n]!
        for (const o of x.origins) merged.origins.add(o)
        for (const au of x.authors) merged.authors.add(au)
      }
      if (d.bn === 0) {
        for (const o of merged.origins) {
          const del = deleters[o]!
          for (const au of merged.authors) del.authors.add(au)
          del.last = later(del.last, merged.last)
        }
      } else {
        for (let n = 0; n < d.bn; n++) next[d.b + n] = { origins: new Set(merged.origins), authors: new Set(merged.authors), last: merged.last }
      }
    }
    info = next
    prev = st.L
  })
  // when steps were skipped (a reverse diff, or every object gone) the final map is not Lb's: attribution is empty
  const attributed = prev.src === Lb.src && info.length === Lb.blocks.length
  const allBy = [...new Set(steps.map((s) => s.by))]
  const lastStepBy = steps.length ? steps[steps.length - 1]!.by : null

  const run = (L: Loaded, i: number, n: number): string => (n === 0 ? '' : L.src.slice(L.blocks[i]!.start, L.blocks[i + n - 1]!.end))
  const blocks: DiffBlock[] = []
  for (const d of diffBlocks(La.blocks, Lb.blocks)) {
    if (d.op === 'equal') {
      for (let n = 0; n < d.n; n++) {
        const t = run(La, d.a + n, 1)
        blocks.push({ op: 'equal', before: t, after: t, by: [], lastBy: null })
      }
      continue
    }
    const authors = new Set<Actor>()
    let last: Lineage['last'] = null
    if (attributed) {
      for (let n = 0; n < d.bn; n++) {
        const x = info[d.b + n]!
        for (const au of x.authors) authors.add(au)
        last = later(last, x.last)
      }
      for (let n = 0; n < d.an; n++) {
        const del = deleters[d.a + n]!
        for (const au of del.authors) authors.add(au)
        last = later(last, del.last)
      }
    }
    let by = [...authors]
    let lastBy = last?.by ?? null
    if (forward && by.length === 0 && steps.length) {
      // lineage lost the block (e.g. an object in the chain is gone): every author of the span is a candidate
      by = allBy
      lastBy = lastStepBy
    }
    const before = run(La, d.a, d.an)
    const after = run(Lb, d.b, d.bn)
    if (d.op === 'insert') blocks.push({ op: 'insert', after, by, lastBy })
    else if (d.op === 'delete') blocks.push({ op: 'delete', before, by, lastBy })
    else blocks.push({ op: 'replace', before, after, by, lastBy, inline: wordDiff(before, after) })
  }
  return { ok: true, from: a.side, to: b.side, blocks }
}
