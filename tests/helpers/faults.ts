// tests/helpers/faults.ts (integrator, day 0; CONTRACTS §1.3 "fault" row, §2.5, §3.4 G7, §4.6, §12.0.4, D51).
//
// Three kinds of injected failure:
// - Writer crash points: MDR_FAULT=after-object|after-wal|after-tmp|after-rename|mid-append:<bytes> makes P1's writer
//   process.exit(137) at that point (node/fault.ts). `faultEnv` builds the env; `runCliWithFault` runs a CLI write
//   under it and asserts the 137.
// - Splice faults: POST /__test/splice-fault { file, blockHashes } (fakeApp always; the real server under
//   MDR_TEST_HOOKS=1 from M2) makes applyBlockOps fail every widening level for ops covering those base hashes, until
//   cleared with []. It needs the browser-route headers (§8.1, §8.3), which `setSpliceFault` sends.
// - Sidecar damage for the read-only and repair paths (§4.6): a corrupt mid-file line, a torn tail.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { ulid } from 'ulid'
import type { BlockHash, ClientId } from '../../shared/types'
import { runCli, type CliRun, type RunCliOptions } from './runCli'
import { browserHeaders } from './startServer'

export type FaultPoint = 'after-object' | 'after-wal' | 'after-tmp' | 'after-rename' | `mid-append:${number}`

/** What a fault-injected writer exits with (§1.3). */
export const FAULT_EXIT = 137

export function faultEnv(point: FaultPoint): { MDR_FAULT: string } {
  return { MDR_FAULT: point }
}

/** Run a CLI command with MDR_FAULT set; throws unless it died with exit 137 at the fault point. */
export async function runCliWithFault(point: FaultPoint, args: readonly string[], o: RunCliOptions = {}): Promise<CliRun> {
  const r = await runCli(args, { ...o, env: { ...(o.env ?? {}), ...faultEnv(point) } })
  if (r.code !== FAULT_EXIT) {
    throw new Error(`runCliWithFault(${point}): expected exit ${FAULT_EXIT}, got ${r.code ?? r.signal}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  }
  return r
}

export interface SpliceFaultTarget {
  port: number
  token: string
  /** Root-relative POSIX path of the doc. */
  file: string
  /** X-MDR-Client-Id for the request; a fresh one when omitted. */
  clientId?: ClientId
  host?: '127.0.0.1' | 'localhost'
}

/** POST /__test/splice-fault. Pair it with `__mdrDebug.failSplice(hashes)` in the page so both sides agree (§12.0.4). */
export async function setSpliceFault(t: SpliceFaultTarget, blockHashes: readonly BlockHash[]): Promise<void> {
  const clientId = t.clientId ?? (`k_${ulid()}` as ClientId)
  const r = await fetch(`http://${t.host ?? '127.0.0.1'}:${t.port}/__test/splice-fault?file=${encodeURIComponent(t.file)}`, {
    method: 'POST',
    headers: { ...browserHeaders({ token: t.token, port: t.port, clientId, ...(t.host ? { host: t.host } : {}) }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: t.file, blockHashes }),
  })
  if (!r.ok) throw new Error(`setSpliceFault: HTTP ${r.status} ${await r.text()}`)
}

export function clearSpliceFault(t: SpliceFaultTarget): Promise<void> {
  return setSpliceFault(t, [])
}

/** The sidecar's lines (without the trailing newline split artefact). */
export function sidecarLines(sidecarAbs: string): string[] {
  const s = readFileSync(sidecarAbs, 'utf8')
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Replace 1-based line `n` with `garbage` (bad JSON by default): a mid-file corruption → SIDECAR_CORRUPT (§4.6). */
export function corruptSidecarLine(sidecarAbs: string, n: number, garbage = '{"seq": not json'): void {
  const lines = sidecarLines(sidecarAbs)
  if (n < 1 || n > lines.length) throw new Error(`corruptSidecarLine: line ${n} outside 1..${lines.length}`)
  lines[n - 1] = garbage
  writeFileSync(sidecarAbs, lines.join('\n') + '\n')
}

/** Append a final line without its newline: a torn tail, ignored by readers and truncated by the next writer (§4.6). */
export function tearSidecarTail(sidecarAbs: string, partial = '{"seq":999,"type":"comment.re'): void {
  appendFileSync(sidecarAbs, partial)
}

/** Rewrite the header with a future schema → SIDECAR_SCHEMA_UNSUPPORTED (§4.1). */
export function bumpSidecarSchema(sidecarAbs: string, schema = 'mdr.sidecar/3'): void {
  const lines = sidecarLines(sidecarAbs)
  const head = JSON.parse(lines[0]!) as Record<string, unknown>
  head.schema = schema
  lines[0] = JSON.stringify(head)
  writeFileSync(sidecarAbs, lines.join('\n') + '\n')
}
