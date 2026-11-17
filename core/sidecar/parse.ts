// core/sidecar/parse.ts (P1). Read a `<name>.md.review.jsonl` sidecar (CONTRACTS §4.1, §4.5 tolerance, §4.6).
//
// - Line 1 is the header. Any other `schema` → schemaUnsupported (the doc goes read-only, SIDECAR_SCHEMA_UNSUPPORTED).
// - A final line without '\n', or a final line with bad JSON, is a torn tail: ignored here, truncated by the next
//   writer under the lock.
// - Mid-file corruption (bad JSON before the last line, a duplicate or decreasing seq, a line over MAX_LINE_BYTES, a
//   schema-invalid line of a known type) → `corrupt { line }`; `events` is the valid prefix, for display only.
// - Unknown types and actors their type doesn't allow → skipped with warning SIDECAR_INVALID_EVENT. Their seq (when it
//   is a positive integer) still takes part in the ordering checks, so a forward-compatible line never reads as a gap.
// - A seq gap is legal only after compaction (header.compacted); otherwise warning SIDECAR_SEQ_GAP.
// Pure: the caller does the I/O. Line numbers are 1-based, header = line 1.
import type { SidecarEvent, SidecarHeader, Warning } from '../../shared/types'
import { SidecarHeaderSchema } from '../../shared/schemas'
import { CONSTANTS, SIDECAR_SCHEMA } from '../../shared/constants'
import { checkStoredEvent } from './validate'

export interface ParsedSidecar {
  header: SidecarHeader | null
  /** Valid events in seq order (the valid prefix when `corrupt` is set). */
  events: SidecarEvent[]
  /** Complete ('\n'-terminated) lines read, header included. */
  lines: number
  tornTail: boolean
  /** UTF-16 length of the text up to the end of the last good complete line (where a writer truncates a torn tail). */
  validLength: number
  /** The same boundary in UTF-8 bytes (what a writer passes to ftruncate). */
  validBytes: number
  /** Highest seq seen on a valid or skipped line (0 when none). */
  lastSeq: number
  corrupt: { line: number; reason: string } | null
  /** The header's schema when it isn't SIDECAR_SCHEMA (nothing else is folded). */
  schemaUnsupported: string | null
  /** Seqs at which a gap starts (the first seq after the gap). */
  seqGaps: number[]
  warnings: Warning[]
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length

export function parseSidecar(text: string): ParsedSidecar {
  const out: ParsedSidecar = {
    header: null, events: [], lines: 0, tornTail: false, validLength: 0, validBytes: 0, lastSeq: 0, corrupt: null,
    schemaUnsupported: null, seqGaps: [], warnings: [],
  }
  if (text === '') return out
  const parts = text.split('\n')
  const tail = parts.pop()!
  if (tail !== '') out.tornTail = true
  out.lines = parts.length
  let offset = 0
  let bytes = 0
  let lastSeq = 0
  const accept = (next: number, lineBytes: number): void => {
    offset = next
    bytes += lineBytes + 1
    out.validLength = offset
    out.validBytes = bytes
  }
  /** Ordering check shared by valid and skipped lines; false = corrupt (already recorded). */
  const orderSeq = (seq: number, lineNo: number): boolean => {
    if (seq <= lastSeq) {
      out.corrupt = { line: lineNo, reason: `seq ${seq} is not above ${lastSeq}` }
      return false
    }
    if (seq !== lastSeq + 1) {
      out.seqGaps.push(seq)
      if (!out.header?.compacted) out.warnings.push({ code: 'SIDECAR_SEQ_GAP', message: `seq jumps from ${lastSeq} to ${seq} at line ${lineNo}`, line: lineNo })
    }
    lastSeq = seq
    out.lastSeq = seq
    return true
  }

  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!
    const lineNo = i + 1
    const isLast = i === parts.length - 1 && !out.tornTail
    const next = offset + line.length + 1
    const lineBytes = utf8Len(line)
    if (lineBytes > CONSTANTS.MAX_LINE_BYTES) {
      out.corrupt = { line: lineNo, reason: 'line exceeds MAX_LINE_BYTES' }
      return out
    }
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      if (isLast && i > 0) {
        out.tornTail = true
        return out
      }
      out.corrupt = { line: lineNo, reason: 'bad JSON' }
      return out
    }
    if (i === 0) {
      const schema = (raw as { schema?: unknown } | null)?.schema
      if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'header' && schema !== SIDECAR_SCHEMA) {
        out.schemaUnsupported = String(schema)
        return out
      }
      const h = SidecarHeaderSchema.safeParse(raw)
      if (!h.success) {
        out.corrupt = { line: 1, reason: 'invalid header' }
        return out
      }
      out.header = h.data as SidecarHeader
      accept(next, lineBytes)
      continue
    }
    const c = checkStoredEvent(raw)
    if (!c.ok) {
      if (c.kind === 'invalid') {
        out.corrupt = { line: lineNo, reason: c.message }
        return out
      }
      const rawSeq = (raw as { seq?: unknown }).seq
      if (typeof rawSeq === 'number' && Number.isInteger(rawSeq) && rawSeq > 0 && !orderSeq(rawSeq, lineNo)) return out
      out.warnings.push({ code: 'SIDECAR_INVALID_EVENT', message: `line ${lineNo}: ${c.message} (skipped)`, line: lineNo })
      accept(next, lineBytes)
      continue
    }
    if (!orderSeq(c.event.seq, lineNo)) return out
    out.events.push(c.event)
    accept(next, lineBytes)
  }
  return out
}
