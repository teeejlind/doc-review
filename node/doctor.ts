// node/doctor.ts (P1). The store half of `mdr doctor <file> [--repair] [--compact] [--gc]` (CONTRACTS §4.8, D22).
// P4's command calls doctor(); every flag that changes a file runs under the doc lock.
//
// - No flags: the DoctorResult report (seq gaps, corrupt lines, torn tail, history size, orphan objects). Read-only.
// - --repair: each corrupt mid-file line (bad JSON, a duplicate or decreasing seq, a schema-invalid line of a known
//   type, a line over MAX_LINE_BYTES) moves to `<name>.md.review.jsonl.quarantine-<ts>`, a torn tail is dropped, the
//   sidecar is rewritten via tmp + rename, and `log.repair { droppedBytes, quarantined? }` is appended. Only on
//   explicit request; nothing ever auto-repairs.
// - --compact: core/sidecar/compact.ts over the parsed log (history-referenced revs kept), rewritten via tmp + rename
//   with a new header carrying `compacted`. A corrupt sidecar must be repaired first (SIDECAR_CORRUPT).
// - --gc: history retention and objects GC now (the same pass the server runs at start and hourly).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import type { DoctorResult, Hash, SidecarEvent, SidecarHeader, Warning } from '../shared/types'
import { CONSTANTS, SIDECAR_SCHEMA } from '../shared/constants'
import { StoreError } from '../shared/errors'
import { SidecarHeaderSchema } from '../shared/schemas'
import { compactLines } from '../core/sidecar/compact'
import { checkStoredEvent } from '../core/sidecar/validate'
import { parseSidecar } from '../core/sidecar/parse'
import { historyBytes, listObjects, readIndex } from './history'
import { withDocLock } from './lock'
import { mdrCmd } from './config'
import { serializeLines, sidecarPathOf } from './sidecar-io'
import { maintainDoc, openDocStore } from './docstore'
import { renameWithRetry } from './rename'

export interface DoctorOptions {
  repair?: boolean
  compact?: boolean
  gc?: boolean
  lockTimeoutMs?: number
  now?: Date
}

interface LineScan {
  line: number
  text: string
  bytes: number
  kind: 'header' | 'event' | 'skipped' | 'corrupt'
  seq?: number
  reason?: string
}

/** Classify every complete line on its own (parse stops at the first corrupt line; the doctor needs them all). */
export function scanLines(text: string): { lines: LineScan[]; tornTail: string; schema: string | null; seqGaps: number[] } {
  const parts = text.split('\n')
  const tornTail = parts.pop() ?? ''
  const out: LineScan[] = []
  let schema: string | null = null
  let lastSeq = 0
  const seqGaps: number[] = []
  let compacted = false
  parts.forEach((t, i) => {
    const bytes = Buffer.byteLength(t, 'utf8') + 1
    const line = i + 1
    if (bytes - 1 > CONSTANTS.MAX_LINE_BYTES) {
      out.push({ line, text: t, bytes, kind: 'corrupt', reason: 'line exceeds MAX_LINE_BYTES' })
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(t)
    } catch {
      out.push({ line, text: t, bytes, kind: 'corrupt', reason: 'bad JSON' })
      return
    }
    if (i === 0) {
      schema = typeof (raw as { schema?: unknown })?.schema === 'string' ? (raw as { schema: string }).schema : null
      const h = SidecarHeaderSchema.safeParse(raw)
      if (h.success) compacted = !!(h.data as SidecarHeader).compacted
      out.push({ line, text: t, bytes, kind: h.success || schema !== SIDECAR_SCHEMA ? 'header' : 'corrupt', ...(h.success ? {} : { reason: 'invalid header' }) })
      return
    }
    const c = checkStoredEvent(raw)
    const rawSeq = (raw as { seq?: unknown })?.seq
    const seq = typeof rawSeq === 'number' && Number.isInteger(rawSeq) && rawSeq > 0 ? rawSeq : undefined
    if (!c.ok && c.kind === 'invalid') {
      out.push({ line, text: t, bytes, kind: 'corrupt', reason: c.message })
      return
    }
    if (seq !== undefined && seq <= lastSeq) {
      out.push({ line, text: t, bytes, kind: 'corrupt', seq, reason: `seq ${seq} is not above ${lastSeq}` })
      return
    }
    if (seq !== undefined) {
      if (seq !== lastSeq + 1 && !compacted) seqGaps.push(seq)
      lastSeq = seq
    }
    out.push({ line, text: t, bytes, kind: c.ok ? 'event' : 'skipped', ...(seq !== undefined ? { seq } : {}) })
  })
  return { lines: out, tornTail, schema, seqGaps }
}

function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${path.split('/').pop()}.mdr-${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`)
  const fd = openSync(tmp, 'w', 0o644)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameWithRetry(tmp, path)
}

function report(abs: string, file: string): DoctorResult {
  const path = sidecarPathOf(abs)
  const versions = readIndex(abs).versions
  const referenced = new Set<Hash>(versions.map((v) => v.hash))
  const warnings: Warning[] = []
  if (!existsSync(path)) {
    return {
      ok: true, file,
      sidecar: { exists: false, bytes: 0, lines: 0, seqGaps: [], corruptLines: [], tornTail: false, schema: null },
      history: { versions: versions.length, bytes: historyBytes(abs), orphanObjects: listObjects(abs).filter((h) => !referenced.has(h)).length },
      actions: [], warnings,
    }
  }
  const buf = readFileSync(path)
  const scan = scanLines(buf.toString('utf8'))
  const parsed = parseSidecar(buf.toString('utf8'))
  for (const e of parsed.events) if (e.type === 'doc.rev') referenced.add(e.hash)
  if (buf.length > CONSTANTS.SIDECAR_WARN_BYTES) warnings.push({ code: 'SIDECAR_LARGE', message: `the sidecar is ${buf.length} bytes; --compact shrinks it` })
  return {
    ok: true, file,
    sidecar: {
      exists: true, bytes: buf.length, lines: scan.lines.length, seqGaps: scan.seqGaps,
      corruptLines: scan.lines.filter((l) => l.kind === 'corrupt').map((l) => l.line), tornTail: scan.tornTail !== '', schema: scan.schema,
    },
    history: { versions: versions.length, bytes: historyBytes(abs), orphanObjects: listObjects(abs).filter((h) => !referenced.has(h)).length },
    actions: [], warnings,
  }
}

/** `mdr doctor` for the doc at `abs` (`file` = its root-relative path, echoed in the result). */
export async function doctor(root: string, file: string, abs: string, o: DoctorOptions = {}): Promise<DoctorResult> {
  if (!o.repair && !o.compact && !o.gc) return report(abs, file)
  const path = sidecarPathOf(abs)
  const actions: DoctorResult['actions'] = []
  const timeout = o.lockTimeoutMs ?? CONSTANTS.LOCK_TIMEOUT_CLI_MS
  const now = o.now ?? new Date()
  await withDocLock(abs, timeout, () => {
    if (!existsSync(path)) return
    if (o.repair) {
      const text = readFileSync(path, 'utf8')
      const scan = scanLines(text)
      const bad = scan.lines.filter((l) => l.kind === 'corrupt')
      if (bad.length || scan.tornTail) {
        const good = scan.lines.filter((l) => l.kind !== 'corrupt')
        if (!good.length || good[0]!.kind !== 'header') throw new StoreError('SIDECAR_CORRUPT', 'the sidecar header is unreadable; it cannot be repaired in place')
        let quarantined: string | undefined
        if (bad.length) {
          quarantined = `${path}.quarantine-${now.toISOString().replace(/[:.]/g, '-')}`
          writeAtomic(quarantined, bad.map((l) => l.text + '\n').join(''))
          actions.push('quarantined')
        }
        if (scan.tornTail) actions.push('repaired-tail')
        const droppedBytes = bad.reduce((n, l) => n + l.bytes, 0) + Buffer.byteLength(scan.tornTail, 'utf8')
        const kept = good.map((l) => l.text + '\n').join('')
        const reparsed = parseSidecar(kept)
        const lastSeq = reparsed.lastSeq
        const lastRev = reparsed.events.length ? reparsed.events[reparsed.events.length - 1]!.rev : 0
        const repairLine = {
          seq: lastSeq + 1, id: `e_${ulid()}`, type: 'log.repair', by: 'system', at: now.toISOString(), rev: lastRev,
          droppedBytes, ...(quarantined ? { quarantined } : {}),
        } as unknown as SidecarEvent
        writeAtomic(path, kept + serializeLines([repairLine]))
      }
    }
    if (o.compact) {
      const text = readFileSync(path, 'utf8')
      const parsed = parseSidecar(text)
      if (parsed.schemaUnsupported !== null) throw new StoreError('SIDECAR_SCHEMA_UNSUPPORTED', `sidecar schema ${parsed.schemaUnsupported} is not supported`)
      if (parsed.corrupt) throw new StoreError('SIDECAR_CORRUPT', `sidecar line ${parsed.corrupt.line}: ${parsed.corrupt.reason}`, { hint: `run ${mdrCmd()} doctor --repair first` })
      if (!parsed.header) return
      const historyRevs = new Set<number>()
      for (const v of readIndex(abs).versions) {
        historyRevs.add(v.rev)
        historyRevs.add(v.revs[0])
        historyRevs.add(v.revs[1])
      }
      const c = compactLines({ header: parsed.header, events: parsed.events, historyRevs, now: now.toISOString() })
      if (c.dropped > 0) {
        writeAtomic(path, serializeLines([c.header, ...c.events]))
        actions.push('compacted')
      }
    }
  })
  if (o.gc) {
    const store = await openDocStore(root, file, { mode: 'direct', lockTimeoutMs: timeout })
    try {
      await maintainDoc(store, { now })
      actions.push('gc')
    } finally {
      await store.close()
    }
  }
  return { ...report(abs, file), actions }
}
