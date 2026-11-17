// cli/commands/doctor.ts (P4). `mdr doctor <file> [--repair] [--compact] [--gc]` (CONTRACTS §4.8, D22).
//
// A thin command over P1's node/doctor.ts#doctor(root, file, abs, { repair?, compact?, gc?, lockTimeoutMs? }):
// - no flags: the read-only DoctorResult (seq gaps, every corrupt line, torn tail, schema, history size, orphan
//   objects); it never writes and takes no lock;
// - --repair (quarantine corrupt lines, drop a torn tail, append log.repair), --compact (§4.8 rules, new header) and
//   --gc (history retention and objects GC) run under the doc lock, in that order, and are listed in `actions`.
// It works the same with the server up or down: the doc lock serializes it against the server's writes, and the
// server's fold cache revalidates by (ino, size, mtime), so it sees a rewritten sidecar on its next read.
import type { DoctorResult } from '../../shared/types'
import { CONSTANTS } from '../../shared/constants'
import { doctor, type DoctorOptions } from '../../node/doctor'
import { assertServable } from '../../node/root'
import { CliExit } from '../output'
import { fileOf, flag, type Ctx } from './common'

export type DoctorImpl = (root: string, file: string, abs: string, o: DoctorOptions) => Promise<DoctorResult>

export async function runDoctor(ctx: Ctx, impl: DoctorImpl = doctor): Promise<CliExit> {
  const at = fileOf(ctx)
  assertServable(at.root, at.abs)
  const o: DoctorOptions = { lockTimeoutMs: CONSTANTS.LOCK_TIMEOUT_CLI_MS }
  if (flag(ctx, 'repair')) o.repair = true
  if (flag(ctx, 'compact')) o.compact = true
  if (flag(ctx, 'gc')) o.gc = true
  ctx.verbose(`doctor ${at.rel}: ${[o.repair && 'repair', o.compact && 'compact', o.gc && 'gc'].filter(Boolean).join(', ') || 'report only'}`)
  return new CliExit(await impl(at.root, at.rel, at.abs, o), 0)
}
