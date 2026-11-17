// cli/commands/read.ts (P4). snapshot, pending, thread, history (CONTRACTS §8.4, §9.3, §9.4). Server up → the agent
// route; down → direct: readOnly for snapshot, thread and history; `pending` takes the lock only to flush and recover
// first, and never acks.
import type { AgentSnapshot, AgentSnapshotQuery, HistoryDiff, HistoryList, HistoryRef, PendingResult, ThreadDetail, VersionId, VersionShow } from '../../shared/types'
import { isBlockRef, isThreadId, isVersionId } from '../../shared/ids'
import { withStore } from '../direct'
import { agentCall, q } from '../http'
import { cliErr, CliExit } from '../output'
import { arg, fileOf, flag, intOpt, localUser, opt, serverFor, withSkew, type Ctx } from './common'

function snapshotQuery(ctx: Ctx): AgentSnapshotQuery {
  const from = opt(ctx, 'from')
  const to = opt(ctx, 'to')
  for (const [v, f] of [[from, '--from'], [to, '--to']] as const) {
    if (v !== undefined && !isBlockRef(v)) throw cliErr('USAGE', `${f} must be a block ref like b3, got ${JSON.stringify(v)}`)
  }
  return {
    ...(flag(ctx, 'md') ? { md: true } : {}), ...(flag(ctx, 'text') ? { text: true } : {}),
    ...(from !== undefined ? { from: from as `b${number}` } : {}), ...(to !== undefined ? { to: to as `b${number}` } : {}),
  }
}

export async function runSnapshot(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const query = snapshotQuery(ctx)
  const up = await serverFor(ctx, at.root)
  if (up) {
    const res = await agentCall<AgentSnapshot>(up.conn, 'GET', `/api/agent/snapshot${q({
      file: at.rel, md: query.md ? 1 : 0, text: query.text ? 1 : 0, from: query.from, to: query.to,
    })}`)
    return new CliExit(res, 0)
  }
  return new CliExit(await withStore(ctx.io, at, { readOnly: true }, (s) => s.agent.snapshot(query)), 0)
}

export async function runPending(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const up = await serverFor(ctx, at.root)
  if (up) {
    const res = await agentCall<PendingResult>(up.conn, 'GET', `/api/agent/pending${q({ file: at.rel })}`)
    return new CliExit(withSkew(res.user ? res : { ...res, user: localUser(ctx) }, up.conn), 0)
  }
  const res = await withStore(ctx.io, at, {}, (s) => s.agent.pending())
  return new CliExit({ ...res, user: localUser(ctx) }, 0)
}

export async function runThread(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const id = arg(ctx, 1, 'thread id')
  if (!isThreadId(id)) throw cliErr('USAGE', `not a thread id: ${JSON.stringify(id)} (t_ + ULID)`)
  const up = await serverFor(ctx, at.root)
  if (up) return new CliExit(await agentCall<ThreadDetail>(up.conn, 'GET', `/api/agent/thread${q({ file: at.rel, id })}`), 0)
  return new CliExit(await withStore(ctx.io, at, { readOnly: true }, (s) => s.agent.thread(id)), 0)
}

const isRef = (v: string): v is HistoryRef => v === 'current' || isVersionId(v) || /^rev:\d+$/.test(v)

export async function runHistory(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const show = opt(ctx, 'show')
  const diff = opt(ctx, 'diff')
  const limit = intOpt(ctx, 'limit', '--limit', 1)
  if ([show, diff, limit].filter((x) => x !== undefined).length > 1) throw cliErr('USAGE', 'history takes one of --limit N, --show vN, --diff a..b')
  if (show !== undefined && !isVersionId(show)) throw cliErr('USAGE', `--show takes a version like v3, got ${JSON.stringify(show)}`)
  let range: [HistoryRef, HistoryRef] | null = null
  if (diff !== undefined) {
    const parts = diff.split('..')
    if (parts.length !== 2 || !isRef(parts[0]!) || !isRef(parts[1]!)) throw cliErr('USAGE', `--diff takes a..b with vN, rev:N or current, got ${JSON.stringify(diff)}`)
    range = [parts[0], parts[1]]
  }
  const up = await serverFor(ctx, at.root)
  if (up) {
    if (show !== undefined) return new CliExit(await agentCall<VersionShow>(up.conn, 'GET', `/api/agent/history/version${q({ file: at.rel, v: show })}`), 0)
    if (range) return new CliExit(await agentCall<HistoryDiff>(up.conn, 'GET', `/api/agent/history/diff${q({ file: at.rel, from: range[0], to: range[1] })}`), 0)
    return new CliExit(await agentCall<HistoryList>(up.conn, 'GET', `/api/agent/history${q({ file: at.rel, limit })}`), 0)
  }
  return new CliExit(await withStore(ctx.io, at, { readOnly: true }, async (s) => {
    if (show !== undefined) return s.history.show(show as VersionId)
    if (range) return s.history.diff(range[0], range[1])
    return s.history.list(limit !== undefined ? { limit } : {})
  }), 0)
}
