// cli/commands/write.ts (P4). Every write command (CONTRACTS §9.4, §9.5, §4.7). Each single-op command is sugar for
// `batch` with one op, `ack` included (ops [] plus ack); the output is always BatchResult. Server up → POST
// /api/agent/batch; down → direct mode through openDocStore(...).agent.batch. The CLI never derives an idempotency
// key: it forwards --key K as op.key and otherwise sends none (the store derives cli:… under the lock, §4.7).
import type { AgentOp, BatchRequest, BatchResult, BlockRef, BlockSel, CommentId, NearHint, SuggestionId, ThreadId } from '../../shared/types'
import { isBlockRef, isCommentId, isSuggestionId, isThreadId } from '../../shared/ids'
import { BatchRequestSchema } from '../../shared/schemas'
import { withStore } from '../direct'
import { agentCall, q } from '../http'
import { cliErr, CliExit } from '../output'
import { arg, fileOf, flag, intOpt, opt, serverFor, textOpt, withSkew, type Ctx } from './common'

const ref = (v: string, flagName: string): BlockRef => {
  if (!isBlockRef(v)) throw cliErr('USAGE', `${flagName} must be a block ref like b7, got ${JSON.stringify(v)}`)
  return v
}
const threadId = (v: string): ThreadId => {
  if (!isThreadId(v)) throw cliErr('USAGE', `not a thread id: ${JSON.stringify(v)} (t_ + ULID)`)
  return v
}
const suggestionId = (v: string): SuggestionId => {
  if (!isSuggestionId(v)) throw cliErr('USAGE', `not a suggestion id: ${JSON.stringify(v)} (s_ + ULID)`)
  return v
}
const commentId = (v: string): CommentId => {
  if (!isCommentId(v)) throw cliErr('USAGE', `not a comment id: ${JSON.stringify(v)} (c_ + ULID)`)
  return v
}

function needRev(ctx: Ctx, why: string): number {
  const r = intOpt(ctx, 'baseRev', '--base-rev', 0)
  if (r === undefined) throw cliErr('USAGE', `${why} needs --base-rev R (the rev the ref was read at)`)
  return r
}

const withKey = <T extends AgentOp>(ctx: Ctx, op: T): T => {
  const k = opt(ctx, 'key')
  return k === undefined ? op : { ...op, key: k }
}

async function required(ctx: Ctx, value: string, file: string | null, flagName: string): Promise<string> {
  const t = await textOpt(ctx, value, file, flagName)
  if (t === undefined) throw cliErr('USAGE', `mdr ${ctx.cmd.name}: ${flagName} is required (${flagName} TEXT, ${flagName} - for stdin${file ? `, or ${flagName}-file F` : ''})`)
  return t
}

/** SELECTOR := --ref bN --base-rev R | --line L --base-rev R | --quote Q [--occurrence N] (edit-block). */
function selector(ctx: Ctx): BlockSel {
  const r = opt(ctx, 'ref')
  const l = opt(ctx, 'line')
  const qv = opt(ctx, 'quote')
  const given = [r, l, qv].filter((x) => x !== undefined).length
  if (given !== 1) throw cliErr('USAGE', 'edit-block needs exactly one SELECTOR: --ref bN --base-rev R | --line L --base-rev R | --quote Q [--occurrence N]')
  if (r !== undefined) return { ref: ref(r, '--ref'), rev: needRev(ctx, '--ref') }
  if (l !== undefined) return { line: intOpt(ctx, 'line', '--line', 1)!, rev: needRev(ctx, '--line') }
  const occ = intOpt(ctx, 'occurrence', '--occurrence', 1)
  return { quote: qv!, ...(occ !== undefined ? { occurrence: occ } : {}) }
}

/** --from / --to of a range: bN (needs --base-rev), line:N (needs --base-rev), quote:TEXT; any other value is a quote. */
function rangeEnd(ctx: Ctx, v: string, flagName: string): BlockSel {
  if (isBlockRef(v)) return { ref: v, rev: needRev(ctx, flagName) }
  const lm = /^line:(\d+)$/.exec(v)
  if (lm) return { line: Number(lm[1]), rev: needRev(ctx, flagName) }
  return { quote: v.startsWith('quote:') ? v.slice(6) : v }
}

function nearOf(ctx: Ctx): NearHint | undefined {
  const n = opt(ctx, 'near')
  return n === undefined ? undefined : { ref: ref(n, '--near'), rev: needRev(ctx, '--near') }
}

/** The single op (or ack request) a write command stands for. */
export async function requestFor(ctx: Ctx): Promise<BatchRequest> {
  const c = ctx.cmd
  switch (c.name) {
    case 'comment': {
      const body = await required(ctx, 'body', 'bodyFile', '--body')
      const anchors = [opt(ctx, 'quote') !== undefined, flag(ctx, 'doc'), opt(ctx, 'block') !== undefined].filter(Boolean).length
      if (anchors !== 1) throw cliErr('USAGE', 'comment needs exactly one of --quote Q, --doc, --block bN --base-rev R')
      if (flag(ctx, 'doc')) return { ops: [withKey(ctx, { op: 'comment', doc: true, body })] }
      if (opt(ctx, 'block') !== undefined) {
        return { ops: [withKey(ctx, { op: 'comment', block: { ref: ref(opt(ctx, 'block')!, '--block'), rev: needRev(ctx, '--block') }, body })] }
      }
      const occ = intOpt(ctx, 'occurrence', '--occurrence', 1)
      const near = nearOf(ctx)
      if (occ !== undefined && near) throw cliErr('USAGE', 'pass --occurrence N or --near bN --base-rev R, not both')
      return { ops: [withKey(ctx, { op: 'comment', quote: opt(ctx, 'quote')!, ...(occ !== undefined ? { occurrence: occ } : {}), ...(near ? { near } : {}), body })] }
    }
    case 'reply':
      return { ops: [withKey(ctx, { op: 'reply', thread: threadId(arg(ctx, 1, 'thread')), body: await required(ctx, 'body', 'bodyFile', '--body') })] }
    case 'suggest': {
      const reason = opt(ctx, 'reason')
      const th = opt(ctx, 'thread')
      const extra = { ...(reason !== undefined ? { reason } : {}), ...(th !== undefined ? { thread: threadId(th) } : {}) }
      if (opt(ctx, 'block') !== undefined) {
        if (opt(ctx, 'quote') !== undefined) throw cliErr('USAGE', 'suggest takes --quote Q or --block bN, not both')
        const markdown = await required(ctx, 'md', 'mdFile', '--md')
        return { ops: [withKey(ctx, { op: 'suggest_block', target: { ref: ref(opt(ctx, 'block')!, '--block'), rev: needRev(ctx, '--block') }, markdown, ...extra })] }
      }
      const quote = opt(ctx, 'quote')
      if (quote === undefined) throw cliErr('USAGE', 'suggest needs --quote Q --replace R, or --block bN --base-rev R --md M')
      const replace = await required(ctx, 'replace', 'replaceFile', '--replace')
      const occ = intOpt(ctx, 'occurrence', '--occurrence', 1)
      const near = nearOf(ctx)
      if (occ !== undefined && near) throw cliErr('USAGE', 'pass --occurrence N or --near bN --base-rev R, not both')
      return { ops: [withKey(ctx, { op: 'suggest', quote, replace, ...extra, ...(occ !== undefined ? { occurrence: occ } : {}), ...(near ? { near } : {}) })] }
    }
    case 'edit-block': {
      const from = opt(ctx, 'from')
      const to = opt(ctx, 'to')
      if (from !== undefined || to !== undefined) {
        if (from === undefined || to === undefined) throw cliErr('USAGE', 'a range needs both --from SELECTOR and --to SELECTOR')
        const markdown = await required(ctx, 'md', 'mdFile', '--md')
        return { ops: [withKey(ctx, { op: 'replace_range', from: rangeEnd(ctx, from, '--from'), to: rangeEnd(ctx, to, '--to'), markdown })] }
      }
      const target = selector(ctx)
      const modes = [flag(ctx, 'insertAfter'), flag(ctx, 'insertBefore'), flag(ctx, 'delete')].filter(Boolean).length
      if (modes > 1) throw cliErr('USAGE', 'pass at most one of --insert-after, --insert-before, --delete')
      if (flag(ctx, 'delete')) {
        if (opt(ctx, 'md') !== undefined || opt(ctx, 'mdFile') !== undefined) throw cliErr('USAGE', '--delete takes no --md')
        return { ops: [withKey(ctx, { op: 'delete_block', target })] }
      }
      const markdown = await required(ctx, 'md', 'mdFile', '--md')
      if (flag(ctx, 'insertAfter')) return { ops: [withKey(ctx, { op: 'insert_after', target, markdown })] }
      if (flag(ctx, 'insertBefore')) return { ops: [withKey(ctx, { op: 'insert_before', target, markdown })] }
      return { ops: [withKey(ctx, { op: 'replace_block', target, markdown })] }
    }
    case 'write': {
      const baseRev = needRev(ctx, 'write')
      return { ops: [withKey(ctx, { op: 'write', markdown: await required(ctx, 'md', 'mdFile', '--md'), baseRev })] }
    }
    case 'resolve': {
      const body = await textOpt(ctx, 'body', 'bodyFile', '--body')
      return { ops: [withKey(ctx, { op: 'resolve', thread: threadId(arg(ctx, 1, 'thread')), ...(body !== undefined ? { body } : {}) })] }
    }
    case 'reopen':
      return { ops: [withKey(ctx, { op: 'reopen', thread: threadId(arg(ctx, 1, 'thread')) })] }
    case 'decide': {
      const d = arg(ctx, 2, 'decision')
      if (d !== 'accept' && d !== 'reject') throw cliErr('USAGE', `decide takes accept or reject, got ${JSON.stringify(d)}`)
      return { ops: [withKey(ctx, { op: 'decide', suggestion: suggestionId(arg(ctx, 1, 'suggestion')), decision: d })] }
    }
    case 'withdraw':
      return { ops: [withKey(ctx, { op: 'withdraw', suggestion: suggestionId(arg(ctx, 1, 'suggestion')) })] }
    case 'edit-comment':
      return { ops: [withKey(ctx, { op: 'edit_comment', comment: commentId(arg(ctx, 1, 'comment')), body: await required(ctx, 'body', 'bodyFile', '--body') })] }
    case 'delete-comment':
      return { ops: [withKey(ctx, { op: 'delete_comment', comment: commentId(arg(ctx, 1, 'comment')) })] }
    case 'ack': {
      const cursor = intOpt(ctx, 'cursor', '--cursor', 0)
      if (cursor === undefined) throw cliErr('USAGE', 'ack needs --cursor N (pending.cursor)')
      const since = intOpt(ctx, 'since', '--since', 0)
      return { ops: [], ack: cursor, ...(since !== undefined ? { ackSince: since } : {}) }
    }
    case 'batch': {
      const f = opt(ctx, 'opsFile')
      let text: string
      try {
        text = f !== undefined ? ctx.io.readFile(f) : await ctx.io.readStdin()
      } catch (e) {
        throw cliErr('USAGE', `cannot read the batch request: ${(e as Error).message}`)
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw cliErr('BAD_REQUEST', 'the batch request is not valid JSON')
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw cliErr('BAD_REQUEST', 'the batch request must be a JSON object { "ops": [...] }')
      const req = raw as BatchRequest
      return flag(ctx, 'dryRun') ? { ...req, dryRun: true } : req
    }
    default:
      throw cliErr('INTERNAL', `${c.name} is not a write command`)
  }
}

/** Validate against the frozen schema so a malformed request fails with a precise BAD_REQUEST in both modes. */
export function checkRequest(req: BatchRequest): BatchRequest {
  const r = BatchRequestSchema.safeParse(req)
  if (r.success) return req
  const i = r.error.issues[0]
  const at = i ? i.path.map(String).join('.') : ''
  const opIndex = i && i.path[0] === 'ops' && typeof i.path[1] === 'number' ? i.path[1] : undefined
  throw cliErr('BAD_REQUEST', `invalid BatchRequest${at ? ` at ${at}` : ''}: ${i?.message ?? 'schema mismatch'}`, opIndex !== undefined ? { op: opIndex } : {})
}

export async function runWrite(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const req = checkRequest(await requestFor(ctx))
  const up = await serverFor(ctx, at.root)
  if (up) {
    const res = await agentCall<BatchResult>(up.conn, 'POST', `/api/agent/batch${q({ file: at.rel })}`, req)
    return new CliExit(withSkew(res, up.conn), 0)
  }
  return new CliExit(await withStore(ctx.io, at, {}, (s) => s.agent.batch(req)), 0)
}
