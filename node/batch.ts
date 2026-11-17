// node/batch.ts (P1). DocStore.agent.batch planning (CONTRACTS §9.5, §4.4, §4.7, §5.5, §6.2, §7.5, D3, D27, D39).
//
// planBatch validates and applies the ops IN ARRAY ORDER against an in-memory text and returns everything the store
// commits in ONE write: the op events (each carrying its op's key) and the new text, with `ack` applied last.
// - Keys (§4.7) are computed here, under the lock: op.key ?? cliKey(relFile, roundSeq, op). An op whose key is already
//   in the fold is a duplicate: its original result is re-read from the keyed lines (restart-stable) and it is
//   skipped by every later check (Appendix A step 3 before step 4).
// - SUGGEST_ONLY (§4.4, D39): any op that writes .md bytes directly refuses the whole batch.
// - Positional selectors (D3, D27): every { ref, rev } / { line, rev } / near and write's baseRev must equal the
//   current rev (else STALE_REVISION + current + remap) and names a block of the BASE map, before op 0. The working
//   document keeps byte ops as BlockOps against the base map, so cur(i) is implicit.
// - Quote selectors resolve against the working text as of that op (they see earlier ops' output).
// - BATCH_SELF_CONFLICT: a positional target (or a range block) an earlier op replaced, deleted or suggested on; an
//   insertion anchored on a deleted base block; a quote hit in a block an earlier op edited, inserted or suggested on;
//   `write` with any other byte change.
// - Any failure throws with error.op = i; nothing is written.
import { ulid } from 'ulid'
import type {
  Actor, AgentOp, Anchor, AnchorView, BatchOpResult, BatchRequest, BlockHash, BlockOp, BlockRef, BlockSel, CommentId,
  NewEvent, SidecarEvent, SuggestionBody, SuggestionId, ThreadId, WaiterId, Warning,
} from '../shared/types'
import { StoreError, isStoreError } from '../shared/errors'
import { mdrCmd } from './config'
import { nameForAgent } from './identity'
import { indexOfRef, refOf } from '../shared/ids'
import type { Md } from '../core/md/index'
import { load, type Loaded } from '../core/splice/load'
import { updateLoaded } from '../core/splice/update'
import { applyBlockOps } from '../core/splice/apply'
import { diffBlocks, isAtomBlock } from '../core/blocks'
import { ptextOf, type PText } from '../core/ptext'
import { createAnchor, createBlockAnchor } from '../core/anchors'
import { assertCliQuote, findQuoteInPtext, findQuoteInSource, pickQuoteHit, quoteContext } from '../core/quote'
import { convertEol } from '../core/eol'
import { handoffRecords, type FoldState, type ThreadFold } from '../core/sidecar/fold'
import { cliKey, roundSeqOf } from '../core/sidecar/keys'
import { suggestionTransition, validateCommentBody } from '../core/sidecar/validate'
import { phraseSpan } from '../core/suggest/words'
import { applyToSource, changedSpan, fromBlock, fromQuote, locate, quoteNearMisses, sourceQuoteMiss, spansOverlap } from '../core/suggest/record'

const newThreadId = (): ThreadId => `t_${ulid()}`
const newCommentId = (): CommentId => `c_${ulid()}`
const newSuggestionId = (): SuggestionId => `s_${ulid()}`

export function isByteOp(op: AgentOp): boolean {
  return op.op === 'replace_block' || op.op === 'replace_range' || op.op === 'insert_after' || op.op === 'insert_before'
    || op.op === 'delete_block' || op.op === 'write' || (op.op === 'decide' && op.decision === 'accept')
}

/** Every positional selector of an op (§9.5): { ref, rev }, { line, rev } and `near`. */
export function positionalSels(op: AgentOp): Array<{ ref?: BlockRef; line?: number; rev: number }> {
  const out: Array<{ ref?: BlockRef; line?: number; rev: number }> = []
  const add = (s: BlockSel | undefined): void => {
    if (s && 'rev' in s) out.push(s)
  }
  switch (op.op) {
    case 'comment':
      if ('block' in op) add(op.block)
      if ('near' in op && op.near) out.push(op.near)
      break
    case 'suggest':
      if (op.near) out.push(op.near)
      break
    case 'suggest_block':
    case 'replace_block':
    case 'insert_after':
    case 'insert_before':
    case 'delete_block':
      add(op.target)
      break
    case 'replace_range':
      add(op.from)
      add(op.to)
      break
    default:
      break
  }
  return out
}

/** Re-throw a StoreError with `op` set (batch error attribution, §9.5). */
function withOp(e: unknown, i: number): never {
  if (isStoreError(e)) {
    throw new StoreError(e.code, e.message, { ...e.body, op: i }, {
      ...(e.current ? { current: e.current } : {}),
      ...(e.review ? { review: e.review } : {}),
    })
  }
  throw e
}

// ===================================================================================== the working document

interface Working { text: string; L: Loaded; P: PText; toBase: Array<number | null>; toWorking: Array<number | null>; failed: number[]; hazard: boolean }

/**
 * The in-memory text of one batch (§9.5): BlockOps against the BASE map, so positional selectors keep naming base
 * blocks (D27). Groups replace or delete a base run; insertions hang off boundaries; `write` replaces everything.
 */
class BatchDoc {
  readonly n: number
  readonly groups: Array<{ start: number; end: number; blocks: string[] }> = []
  readonly groupOf = new Map<number, number>()
  readonly suggested = new Set<number>()
  /** Base block -> the index of the op that replaced, deleted or suggested on it (BATCH_SELF_CONFLICT details). */
  readonly touchedBy = new Map<number, number>()
  /** The op being planned. */
  curOp = -1
  readonly deletedSet = new Set<number>()
  readonly inserts = new Map<number, string[]>()
  writeOps: BlockOp[] | null = null
  private cache: Working | null = null

  constructor(private readonly md: Md, readonly base: Loaded, private readonly baseP: PText) {
    this.n = base.blocks.length
  }

  touched(i: number): boolean {
    return this.groupOf.has(i) || this.suggested.has(i)
  }
  markSuggested(i: number): void {
    this.suggested.add(i)
    this.touchedBy.set(i, this.curOp)
  }
  get hasByteOps(): boolean {
    return this.writeOps !== null || this.groups.length > 0 || this.inserts.size > 0
  }
  replace(start: number, end: number, blocks: string[]): void {
    const gi = this.groups.length
    this.groups.push({ start, end, blocks })
    for (let k = start; k < end; k++) {
      this.groupOf.set(k, gi)
      this.touchedBy.set(k, this.curOp)
      if (blocks.length === 0) this.deletedSet.add(k)
    }
    this.cache = null
  }
  insertAt(boundary: number, blocks: string[]): void {
    const list = this.inserts.get(boundary) ?? []
    list.push(...blocks)
    this.inserts.set(boundary, list)
    this.cache = null
  }
  /** Boundary for insert_after base block k: after its replacement run when an earlier op replaced it. */
  afterBoundary(k: number): number {
    const g = this.groupOf.get(k)
    return g === undefined ? k + 1 : this.groups[g]!.end
  }
  beforeBoundary(k: number): number {
    const g = this.groupOf.get(k)
    return g === undefined ? k : this.groups[g]!.start
  }
  setWrite(ops: BlockOp[]): void {
    this.writeOps = ops
    this.cache = null
  }

  ops(): BlockOp[] {
    if (this.writeOps) return this.writeOps
    const out: BlockOp[] = []
    let i = 0
    while (i <= this.n) {
      if (!(this.inserts.has(i) || (i < this.n && this.groupOf.has(i)))) {
        i++
        continue
      }
      const after = i - 1
      const covers: BlockHash[] = []
      const blocks: string[] = []
      for (;;) {
        blocks.push(...(this.inserts.get(i) ?? []))
        const g = i < this.n ? this.groupOf.get(i) : undefined
        if (g === undefined) break
        const grp = this.groups[g]!
        for (let k = grp.start; k < grp.end; k++) covers.push(this.base.blocks[k]!.hash)
        blocks.push(...grp.blocks)
        i = grp.end
      }
      out.push({ after, before: i, covers, blocks })
      i++
    }
    return out
  }

  working(): Working {
    if (this.cache) return this.cache
    if (!this.hasByteOps) {
      const ident = this.base.blocks.map((_, k) => k)
      this.cache = { text: this.base.src, L: this.base, P: this.baseP, toBase: ident, toWorking: [...ident], failed: [], hazard: false }
      return this.cache
    }
    const ops = this.ops()
    const r = applyBlockOps(this.md, this.base, ops)
    // incremental (equals load(), gate G2): only the region the ops touched is re-classified
    const L = updateLoaded(this.md, this.base, r.text, ops)
    const toBase = new Array<number | null>(L.blocks.length).fill(null)
    const toWorking = new Array<number | null>(this.n).fill(null)
    for (const d of diffBlocks(this.base.blocks, L.blocks)) {
      if (d.op !== 'equal') continue
      for (let k = 0; k < d.n; k++) {
        if (this.touched(d.a + k)) continue
        toBase[d.b + k] = d.a + k
        toWorking[d.a + k] = d.b + k
      }
    }
    this.cache = { text: r.text, L, P: ptextOf(L.doc, L), toBase, toWorking, failed: r.failed, hazard: r.flips.some((f) => f.entry === null) }
    return this.cache
  }
}

// ===================================================================================== planning

export interface BatchContext {
  md: Md
  file: string
  L: Loaded
  P: PText
  /** The current rev (every positional selector must carry it). */
  rev: number
  /** The rev a byte change will get (stamped into the anchors this batch creates). */
  nextRev: number
  /** The highest seq in the log (the ack range, §4.4). */
  seq: number
  f: FoldState
  /** The non-void log, for re-reading a duplicate op's original result. */
  events: readonly SidecarEvent[]
  remap(refs: readonly BlockRef[], rev: number): Partial<Record<BlockRef, BlockRef>>
  /** STALE_REVISION carrying the current snapshot and review state. */
  stale(message: string, extra: Record<string, unknown>): StoreError
  /** The current AnchorView of an anchor (duplicate results). */
  anchorView(a: Anchor, t?: ThreadFold): AnchorView
}

export interface BatchPlan {
  results: BatchOpResult[]
  /** Op events in op order, each with its key; the ack event last. suggestion.accept carries resultRev -1. */
  events: NewEvent[]
  text: string | null
  textL: Loaded | null
  onlyAccepts: boolean
  /** Key for the doc.rev / doc.edit lines: the batch's byte op's key when there is exactly one, else null. */
  revKey: string | null
  acked: number | null
  consumed: number[]
  warnings: Warning[]
  /** Results to remember by key once the commit lands. */
  remember: Array<{ key: string; result: BatchOpResult }>
}

const err = (code: import('../shared/types').ErrorCode, message: string, extra: Record<string, unknown> = {}): StoreError => new StoreError(code, message, extra)

function messageOf(f: FoldState, id: CommentId): { t: ThreadFold; by: Actor } {
  for (const t of f.threads.values()) {
    const m = t.messages.find((x) => x.id === id)
    if (m && !m.deleted) return { t, by: m.by }
  }
  throw err('COMMENT_NOT_FOUND', `comment ${id} not found`)
}

function pendingIn(f: FoldState, t: ThreadFold): SuggestionId[] {
  return t.suggestions.filter((id) => {
    const s = f.suggestions.get(id)
    return s !== undefined && (s.status === 'pending' || s.status === 'stale')
  })
}

/** A duplicate op's original result, re-read from the lines that carry its key (§4.7). */
export function originalResult(ctx: BatchContext, op: AgentOp, i: number, key: string): BatchOpResult {
  const out: BatchOpResult = { i, op: op.op, key, duplicate: true }
  const lines = ctx.events.filter((e) => e.key === key && !(e.wal && ctx.f.voidRevs.has(e.wal.rev)))
  for (const e of lines) {
    switch (e.type) {
      case 'comment.add':
        out.thread = e.thread
        out.comment = e.comment
        out.anchor = ctx.anchorView(e.anchor, ctx.f.threads.get(e.thread))
        break
      case 'comment.reply':
        out.thread = e.thread
        out.comment = e.comment
        break
      case 'comment.edit':
      case 'comment.delete':
        out.comment = e.comment
        for (const t of ctx.f.threads.values()) if (t.messages.some((m) => m.id === e.comment)) out.thread = t.id
        break
      case 'thread.resolve':
      case 'thread.reopen':
        out.thread = e.thread
        break
      case 'suggestion.add':
        out.thread = e.thread
        out.suggestion = e.suggestion
        out.anchor = ctx.anchorView(e.anchor)
        out.hunks = e.hunks.map((h) => ({ del: h.del, ins: h.ins }))
        break
      case 'suggestion.accept':
      case 'suggestion.reject':
      case 'suggestion.withdraw':
        {
          out.suggestion = e.suggestion
          const th = ctx.f.suggestions.get(e.suggestion)?.thread
          if (th !== undefined) out.thread = th
        }
        break
      case 'doc.edit':
        out.changes = e.changes.map((c) => ({
          op: c.op, block: c.after ? refOf(c.after.index) : null, line: null,
        }))
        break
      default:
        break
    }
  }
  return out
}

/**
 * The handoffs a past `ack upTo` consumed (a retried batch replays this), or null when the log has no such ack. They
 * are the handoffs after the previous ack's cursor, up to `upTo`, that no handoff.consumed had covered before it.
 */
function originalAck(ctx: BatchContext, upTo: number): number[] | null {
  let prev = 0
  for (const e of ctx.events) {
    if (e.type !== 'ack') continue
    if (e.upTo !== upTo) {
      if (e.upTo < upTo) prev = Math.max(prev, e.upTo)
      continue
    }
    return [...ctx.f.handoffs.entries()]
      .filter(([seq, h]) => seq > prev && seq <= upTo && (h.consumedSeq === undefined || h.consumedSeq > e.seq))
      .map(([seq]) => seq)
      .sort((a, b) => a - b)
  }
  return null
}

export function planBatch(ctx: BatchContext, req: BatchRequest): BatchPlan {
  const ops = req.ops
  if (!Array.isArray(ops)) throw err('BAD_REQUEST', 'ops must be an array')
  const roundSeq = roundSeqOf(ctx.f)
  const keys = ops.map((op) => cliKey(ctx.file, roundSeq, op))
  const dup = keys.map((k) => ctx.f.keys.has(k))

  // §4.4 SUGGEST_ONLY: the whole batch, before anything else
  if (ctx.f.policy.suggestOnly) {
    ops.forEach((op, i) => {
      if (!dup[i] && isByteOp(op)) {
        throw err('SUGGEST_ONLY', `op ${i} (${op.op}) writes the document directly; this review is suggest-only`, {
          op: i, hint: `use suggest / suggest_block, or ask ${nameForAgent()} to allow direct edits`,
        })
      }
    })
  }
  // D3 / D27: every positional selector names the base map at the current rev
  ops.forEach((op, i) => {
    if (dup[i]) return
    const sels = positionalSels(op)
    const staleSel = sels.find((s) => s.rev !== ctx.rev)
    if (staleSel) {
      const refs = sels.filter((s) => s.ref !== undefined).map((s) => s.ref!)
      const remap = ctx.remap(refs, staleSel.rev)
      throw ctx.stale(`op ${i} was read at rev ${staleSel.rev}; the doc is at rev ${ctx.rev}`, {
        op: i,
        hint: Object.keys(remap).length
          ? `retry with the remapped ref and rev ${ctx.rev}, or use a quote selector`
          : `nothing to remap (the block changed, or the revision it was read at is gone): run ${mdrCmd()} snapshot for the current refs and rev ${ctx.rev}, or use a quote selector`,
        remap,
      })
    }
    if (op.op === 'write' && op.baseRev !== ctx.rev) {
      throw ctx.stale(`write was planned at rev ${op.baseRev}; the doc is at rev ${ctx.rev}`, { op: i, remap: {} })
    }
  })

  const doc = new BatchDoc(ctx.md, ctx.L, ctx.P)
  const results: BatchOpResult[] = []
  const events: NewEvent[] = []
  const warnings: Warning[] = []
  const created = new Set<ThreadId>()
  const remember: BatchPlan['remember'] = []
  let onlyAccepts = true
  let byteKeys: string[] = []
  let writeSeen = false

  ops.forEach((op, i) => {
    const key = keys[i]!
    if (dup[i]) {
      results.push(originalResult(ctx, op, i, key))
      return
    }
    try {
      doc.curOp = i
      const out = batchOp(ctx, op, i, key, doc, created, warnings)
      if (out.byte) {
        if (writeSeen || (op.op === 'write' && byteKeys.length)) {
          throw err('BATCH_SELF_CONFLICT', 'write must be the only byte change in a batch', { op: i, hint: 'send write as its own batch, or express every change as replace_block / insert ops instead' })
        }
        byteKeys = [...byteKeys, key]
        if (op.op === 'write') writeSeen = true
        if (!(op.op === 'decide' && op.decision === 'accept')) onlyAccepts = false
        const w = doc.working()
        if (w.failed.length || w.hazard) {
          throw err('BLOCK_MERGE_HAZARD', `op ${i} would merge into or change a neighbouring block`, {
            op: i, hint: 'keep a blank line between blocks; a new list next to a list merges',
          })
        }
      }
      events.push(...out.events.map((e) => ({ ...e, key }) as NewEvent))
      results.push(out.result)
      remember.push({ key, result: out.result })
    } catch (e) {
      withOp(e, i)
    }
  })

  // ack is applied LAST (§9.5)
  let acked: number | null = null
  let consumed: number[] = []
  if (req.ack !== undefined) {
    if (!Number.isInteger(req.ack) || req.ack < 0) throw err('BAD_REQUEST', 'ack must be a non-negative integer')
    const cursor = ctx.f.cursors.claudeAck
    // §4.7 retry: every op already landed (all duplicates) and the ack is covered, so this is the same request again
    // (a dropped connection). The CAS would fail against the cursor its own first attempt moved: replay instead.
    const retry = ops.length > 0 && dup.every(Boolean) && req.ack <= cursor
    if (req.ackSince !== undefined && req.ackSince !== cursor && !retry) {
      throw err('ACK_CONFLICT', `another session acked first: the cursor is ${cursor}, not ${req.ackSince}`, {
        details: { cursor, lastAckWaiter: ctx.f.cursors.lastAckWaiter ?? null },
      })
    }
    if (req.ack > ctx.seq) throw err('ACK_OUT_OF_RANGE', `ack ${req.ack} is past the latest seq ${ctx.seq}`)
    if (retry) {
      const original = originalAck(ctx, req.ack)
      acked = original ? req.ack : cursor
      consumed = original ?? []
    } else if (req.ack <= cursor) acked = cursor
    else {
      acked = req.ack
      const unconsumed = handoffRecords(ctx.f, { unconsumed: true }).map((h) => h.seq)
      consumed = unconsumed.filter((s) => s <= req.ack!).sort((a, b) => a - b)
      events.push({ type: 'ack', by: 'Claude', upTo: req.ack, ...(req.waiter ? { waiter: req.waiter as WaiterId } : {}) } as NewEvent)
    }
  }

  const w = doc.working()
  const text = doc.hasByteOps && w.text !== ctx.L.src ? w.text : null
  return {
    results, events, text, textL: text !== null ? w.L : null, onlyAccepts, revKey: byteKeys.length === 1 ? byteKeys[0]! : null,
    acked, consumed, warnings, remember,
  }
}

// ===================================================================================== one op

function contextOf(src: string, start: number, end: number): string {
  return quoteContext(src, start, end)
}

/** No hit for a quote (§5.5): QUOTE_NOT_IN_SOURCE (byte ops whose ptext matched), QUOTE_IN_PENDING_SUGGESTION, or QUOTE_NOT_FOUND with near-misses. */
function quoteMiss(ctx: BatchContext, quote: string, w: Working, bytes: boolean): never {
  if (bytes) {
    try {
      sourceQuoteMiss(ctx.md, w.L, quote)
    } catch (e) {
      if (isStoreError(e) && e.code === 'QUOTE_NOT_IN_SOURCE') throw e
    }
  }
  for (const s of ctx.f.suggestions.values()) {
    if (s.status === 'pending' && s.proposed.includes(quote)) {
      throw err('QUOTE_IN_PENDING_SUGGESTION', 'the quote occurs only inside a pending suggestion', { suggestion: s.id, thread: s.thread })
    }
  }
  const candidates = bytes
    ? quoteNearMisses(w.text, w.L.blocks.map((b) => ({ index: b.index, start: b.start, end: b.end })), quote, (k) => w.L.blocks[k]?.line ?? 1)
    : quoteNearMisses(w.P.text, w.P.blockRanges.map((r) => ({ index: r.index, start: r.pStart, end: r.pEnd })), quote, (k) => w.L.blocks[k]?.line ?? 1)
  throw err('QUOTE_NOT_FOUND', `quote not found: ${JSON.stringify(quote.slice(0, 80))}`, { candidates })
}

/** Resolve a BlockSel to a BASE block index (§9.5): positional against the base map, quotes against the working text. */
function baseIndexOf(ctx: BatchContext, sel: BlockSel, doc: BatchDoc): number {
  if ('ref' in sel) {
    const i = indexOfRef(sel.ref)
    if (i === null || i >= doc.n) throw err('BLOCK_NOT_FOUND', `no block ${String(sel.ref)} at rev ${sel.rev}`, { hint: `run ${mdrCmd()} snapshot for the current refs` })
    return i
  }
  if ('line' in sel) {
    const b = doc.base.blocks.find((x) => x.line <= sel.line && sel.line <= x.endLine)
    if (!b) throw err('BLOCK_NOT_FOUND', `no block contains line ${sel.line} at rev ${sel.rev}`)
    return b.index
  }
  assertCliQuote(sel.quote)
  const w = doc.working()
  const hits = findQuoteInSource(w.text, sel.quote)
  if (!hits.length) quoteMiss(ctx, sel.quote, w, true)
  const blockAt = (off: number): number => {
    const k = w.L.blocks.findIndex((b) => b.end > off)
    return k < 0 ? w.L.blocks.length - 1 : k
  }
  const withBlocks = hits.map((h) => ({ ...h, block: blockAt(h.start) }))
  const picked = pickQuoteHit(withBlocks, sel.occurrence !== undefined ? { occurrence: sel.occurrence } : {})
  if (picked === null) throw err('QUOTE_NOT_FOUND', `occurrence ${sel.occurrence} does not exist (${hits.length} found)`, { candidates: [] })
  if (picked === 'ambiguous') {
    throw err('QUOTE_AMBIGUOUS', `quote matches ${hits.length} places`, {
      hint: 'pass --occurrence N, or --near bN --base-rev R',
      candidates: withBlocks.map((h, k) => ({ occurrence: k + 1, block: refOf(h.block), line: w.L.blocks[h.block]?.line ?? 1, context: contextOf(w.text, h.start, h.end) })),
    })
  }
  const base = w.toBase[picked.hit.block]
  if (base === null || base === undefined) throw selfConflict('the quote lies in a block an earlier op in this batch edited or inserted', doc)
  return base
}

/**
 * BATCH_SELF_CONFLICT (§9.5) with the way out: which earlier op got to the block first and what to send instead. The rule
 * itself is the contract's (a batch holds one changing or suggesting op per block); only the recovery is spelled out.
 */
function selfConflict(message: string, doc: BatchDoc, base?: number): StoreError {
  const earlier = base === undefined ? undefined : doc.touchedBy.get(base)
  const who = earlier === undefined || earlier < 0 ? 'an earlier op' : `op ${earlier}`
  return err('BATCH_SELF_CONFLICT', message.replace('an earlier op', who), {
    hint: `one batch can change or suggest on a block only once: merge the ops on this block into one (for suggestions, one suggest whose quote covers both changes), or send this op as its own command or batch after ${who} has landed`,
    ...(base !== undefined ? { details: { block: refOf(base), ...(earlier !== undefined && earlier >= 0 ? { earlierOp: earlier } : {}) } } : {}),
  })
}

/**
 * WHOLE_BLOCK_REPLACED (§9.5): a quote or line selector only picks the block that holds it. When that block is a list,
 * table or quote of several lines and the edit shrinks it (or deletes it), say so: the other items are gone.
 */
function wholeBlockWarning(op: AgentOp, bi: number, doc: BatchDoc, markdown: string | null): Warning | null {
  if (op.op !== 'replace_block' && op.op !== 'delete_block') return null
  if (!('quote' in op.target) && !('line' in op.target)) return null
  const b = doc.base.blocks[bi]!
  if (b.mdType !== 'list' && b.mdType !== 'table' && b.mdType !== 'blockquote') return null
  const lines = b.endLine - b.line + 1
  const kept = markdown === null ? 0 : markdown.replace(/(\r?\n)+$/, '').split(/\r?\n/).length
  if (lines < 2 || kept >= lines) return null
  const what = b.mdType === 'blockquote' ? 'quote' : b.mdType
  return {
    code: 'WHOLE_BLOCK_REPLACED', line: b.line,
    message: `${markdown === null ? 'deleted' : 'replaced'} the whole ${what} ${refOf(bi)} (lines ${b.line}-${b.endLine}, ${lines} lines)${markdown === null ? '' : ` with ${kept} line${kept === 1 ? '' : 's'}`}: `
      + `a quote or line selector only picks the block that holds it. To change one item, send the complete ${what} in --md, or use suggest --quote Q --replace R`,
  }
}

function assertUntouched(doc: BatchDoc, indices: readonly number[], what: string): void {
  for (const k of indices) if (doc.touched(k)) throw selfConflict(`${what}: base block ${refOf(k)} was already changed or suggested on by an earlier op in this batch`, doc, k)
}

function threadExists(ctx: BatchContext, id: ThreadId, created: ReadonlySet<ThreadId>): ThreadFold | null {
  const t = ctx.f.threads.get(id)
  if (t) return t
  if (created.has(id)) return null
  throw err('THREAD_NOT_FOUND', `thread ${id} not found`, { thread: id })
}

function changesOf(before: Working, after: Working): NonNullable<BatchOpResult['changes']> {
  const out: NonNullable<BatchOpResult['changes']> = []
  for (const d of diffBlocks(before.L.blocks, after.L.blocks)) {
    if (d.op === 'equal') continue
    if (d.op === 'delete') out.push({ op: 'delete', block: null, line: null })
    else for (let k = 0; k < d.bn; k++) out.push({ op: d.op, block: refOf(d.b + k), line: after.L.blocks[d.b + k]?.line ?? null })
  }
  return out
}

function viewOfNew(anchor: Anchor, doc: BatchDoc): AnchorView {
  if (anchor.kind === 'doc') return { state: 'doc', block: null, line: null, quote: '' }
  const w = doc.working()
  const b = anchor.hint.block
  const quote = anchor.kind === 'text' ? (anchor.tail !== undefined ? `${anchor.quote} … ${anchor.tail}` : anchor.quote) : anchor.preview
  return { state: 'ok', block: refOf(b), line: w.L.blocks[b]?.line ?? null, quote }
}

function anchorForHunks(hunks: SuggestionBody['hunks'], w: Working, rev: number): import('../shared/types').TextAnchor | null {
  const span = phraseSpan(hunks, w.P.text)
  if (!span) return null
  return createAnchor(w.P, w.L.blocks, span.from, span.to, rev)
}

function batchOp(
  ctx: BatchContext, op: AgentOp, i: number, key: string, doc: BatchDoc, created: Set<ThreadId>, warnings: Warning[],
): { events: NewEvent[]; result: BatchOpResult; byte: boolean } {
  const base: BatchOpResult = { i, op: op.op, key }
  const eol = ctx.L.eol
  const anchorRev = (): number => (doc.hasByteOps && doc.working().text !== ctx.L.src ? ctx.nextRev : ctx.rev)
  switch (op.op) {
    case 'comment': {
      validateCommentBody(op.body)
      const thread = newThreadId()
      const comment = newCommentId()
      let anchor: Anchor
      if ('doc' in op) anchor = { kind: 'doc' }
      else if ('block' in op) {
        const bi = baseIndexOf(ctx, op.block, doc)
        assertUntouched(doc, [bi], `op ${i}`)
        const w = doc.working()
        anchor = createBlockAnchor(w.L.blocks, w.toWorking[bi] ?? bi, anchorRev())
      } else {
        assertCliQuote(op.quote)
        const w = doc.working()
        const hits = findQuoteInPtext(ctx.md, w.P, op.quote)
        if (!hits.length) quoteMiss(ctx, op.quote, w, false)
        const withBlocks = hits.map((h) => ({ ...h, block: w.P.blockAt(h.from).index }))
        const nearIdx = op.near ? indexOfRef(op.near.ref) : null
        const near = nearIdx !== null ? (w.toWorking[nearIdx] ?? nearIdx) : undefined
        const picked = pickQuoteHit(withBlocks, {
          ...(op.occurrence !== undefined ? { occurrence: op.occurrence } : {}), ...(near !== undefined ? { near } : {}),
        })
        if (picked === null) throw err('QUOTE_NOT_FOUND', `occurrence ${op.occurrence} does not exist (${hits.length} found)`, { candidates: [] })
        if (picked === 'ambiguous') {
          throw err('QUOTE_AMBIGUOUS', `quote matches ${hits.length} places`, {
            hint: 'pass --occurrence N, or --near bN --base-rev R',
            candidates: withBlocks.map((h, k) => ({ occurrence: k + 1, block: refOf(h.block), line: w.L.blocks[h.block]?.line ?? 1, context: quoteContext(w.P.text, h.from, h.to) })),
          })
        }
        const hit = picked.hit
        const wb = hit.block
        const blk = w.L.blocks[wb]
        if (blk && isAtomBlock(blk)) {
          throw err('UNANCHORABLE_TARGET', `block ${blk.ref} is an atom block; comment on it with --block ${blk.ref} --base-rev R`)
        }
        const bIdx = w.toBase[wb]
        if (bIdx === null || bIdx === undefined || doc.touched(bIdx)) {
          throw selfConflict('the quote lies in a block an earlier op in this batch edited, inserted or suggested on', doc, bIdx ?? undefined)
        }
        anchor = createAnchor(w.P, w.L.blocks, hit.from, hit.to, anchorRev())
      }
      created.add(thread)
      return { events: [{ type: 'comment.add', by: 'Claude', thread, comment, anchor, body: op.body }], result: { ...base, thread, comment, anchor: viewOfNew(anchor, doc) }, byte: false }
    }
    case 'reply': {
      validateCommentBody(op.body)
      const t = threadExists(ctx, op.thread, created)
      const comment = newCommentId()
      return {
        events: [
          { type: 'comment.reply', by: 'Claude', thread: op.thread, comment, body: op.body },
          ...(t?.status === 'resolved' ? [{ type: 'thread.reopen', by: 'Claude', thread: op.thread } as NewEvent] : []),
        ],
        result: { ...base, thread: op.thread, comment },
        byte: false,
      }
    }
    case 'resolve': {
      const t = threadExists(ctx, op.thread, created)
      const evs: NewEvent[] = []
      let comment: CommentId | undefined
      if (op.body !== undefined) {
        validateCommentBody(op.body)
        comment = newCommentId()
        evs.push({ type: 'comment.reply', by: 'Claude', thread: op.thread, comment, body: op.body })
      }
      if (t?.status !== 'resolved') evs.push({ type: 'thread.resolve', by: 'Claude', thread: op.thread })
      const pend = t ? pendingIn(ctx.f, t) : []
      if (pend.length) warnings.push({ code: 'RESOLVED_WITH_PENDING', message: `thread ${op.thread} resolved with pending suggestions: ${pend.join(', ')}`, thread: op.thread })
      return { events: evs, result: { ...base, thread: op.thread, ...(comment ? { comment } : {}), ...(evs.length ? {} : { noop: true as const }) }, byte: false }
    }
    case 'reopen': {
      const t = threadExists(ctx, op.thread, created)
      const evs: NewEvent[] = t?.status === 'resolved' ? [{ type: 'thread.reopen', by: 'Claude', thread: op.thread }] : []
      return { events: evs, result: { ...base, thread: op.thread, ...(evs.length ? {} : { noop: true as const }) }, byte: false }
    }
    case 'edit_comment': {
      validateCommentBody(op.body)
      const m = messageOf(ctx.f, op.comment)
      if (m.by !== 'Claude') throw err('NOT_AUTHOR', 'Claude can edit only its own messages')
      return { events: [{ type: 'comment.edit', by: 'Claude', comment: op.comment, body: op.body }], result: { ...base, comment: op.comment, thread: m.t.id }, byte: false }
    }
    case 'delete_comment': {
      const m = messageOf(ctx.f, op.comment)
      if (m.by !== 'Claude') throw err('NOT_AUTHOR', 'Claude can delete only its own messages')
      return { events: [{ type: 'comment.delete', by: 'Claude', comment: op.comment }], result: { ...base, comment: op.comment, thread: m.t.id }, byte: false }
    }
    case 'withdraw': {
      const s = ctx.f.suggestions.get(op.suggestion)
      if (!s) throw err('SUGGESTION_NOT_FOUND', `suggestion ${op.suggestion} not found`, { suggestion: op.suggestion })
      const t = suggestionTransition(s, 'suggestion.withdraw', 'Claude')
      if (t === 'duplicate') return { events: [], result: { ...base, suggestion: op.suggestion, thread: s.thread, noop: true }, byte: false }
      if (t !== 'ok') throw err(t, `cannot withdraw ${op.suggestion} (${s.status})`, { suggestion: op.suggestion, thread: s.thread })
      return { events: [{ type: 'suggestion.withdraw', by: 'Claude', suggestion: op.suggestion }], result: { ...base, suggestion: op.suggestion, thread: s.thread }, byte: false }
    }
    case 'decide': {
      const s = ctx.f.suggestions.get(op.suggestion)
      if (!s) throw err('SUGGESTION_NOT_FOUND', `suggestion ${op.suggestion} not found`, { suggestion: op.suggestion })
      const t = suggestionTransition(s, op.decision === 'accept' ? 'suggestion.accept' : 'suggestion.reject', 'Claude')
      if (t === 'duplicate') return { events: [], result: { ...base, suggestion: op.suggestion, thread: s.thread, noop: true }, byte: false }
      if (t !== 'ok') throw err(t, `cannot ${op.decision} ${op.suggestion} (${s.status})`, { suggestion: op.suggestion, thread: s.thread })
      if (op.decision === 'reject') return { events: [{ type: 'suggestion.reject', by: 'Claude', suggestion: op.suggestion }], result: { ...base, suggestion: op.suggestion, thread: s.thread }, byte: false }
      const loc = locate(doc.base, s)
      if (!loc) throw err('SUGGESTION_STALE', `the base of ${op.suggestion} is no longer in the document`, { suggestion: op.suggestion })
      const idx = Array.from({ length: loc.end - loc.start }, (_, k) => loc.start + k)
      assertUntouched(doc, idx, `op ${i}`)
      const ap = applyToSource(ctx.md, doc.base, s)
      if (!ap.verified) throw err('BLOCK_MERGE_HAZARD', `accepting ${op.suggestion} would change a neighbouring block`, { suggestion: op.suggestion })
      const before = doc.working()
      doc.replace(loc.start, loc.end, s.proposed === '' ? [] : [s.proposed])
      return {
        events: [{ type: 'suggestion.accept', by: 'Claude', suggestion: op.suggestion, resultRev: -1 }],
        result: { ...base, suggestion: op.suggestion, thread: s.thread, changes: changesOf(before, doc.working()) },
        byte: true,
      }
    }
    case 'suggest':
    case 'suggest_block': {
      const w = doc.working()
      let body: SuggestionBody
      if (op.op === 'suggest') {
        assertCliQuote(op.quote)
        const nearIdx = op.near ? indexOfRef(op.near.ref) : null
        const near = nearIdx !== null ? (w.toWorking[nearIdx] ?? nearIdx) : undefined
        try {
          body = fromQuote(ctx.md, w.L, {
            quote: op.quote, replace: op.replace,
            ...(op.occurrence !== undefined ? { occurrence: op.occurrence } : {}), ...(near !== undefined ? { near } : {}),
          })
        } catch (e) {
          if (isStoreError(e) && e.code === 'QUOTE_NOT_FOUND' && findQuoteInSource(w.text, op.quote).length === 0) quoteMiss(ctx, op.quote, w, true)
          throw e
        }
      } else {
        const bi = baseIndexOf(ctx, op.target, doc)
        const wi = w.toWorking[bi]
        if (wi === null || wi === undefined) throw selfConflict(`base block ${refOf(bi)} was changed by an earlier op in this batch`, doc, bi)
        body = fromBlock(ctx.md, w.L, wi, op.markdown)
      }
      const baseIdx: number[] = []
      for (let k = body.range.start; k < body.range.end; k++) {
        const b = w.toBase[k]
        if (b === null || b === undefined) throw selfConflict('the suggestion targets a block an earlier op in this batch edited or inserted', doc)
        baseIdx.push(b)
      }
      assertUntouched(doc, baseIdx, `op ${i}`)
      if (body.base === body.proposed) return { events: [], result: { ...base, noop: true }, byte: false }
      // §6.2 step 2: overlap with another pending suggestion, in base coordinates
      const runStart = doc.base.blocks[baseIdx[0]!]!.start
      const mine = changedSpan(body).map((x) => x + runStart) as [number, number]
      for (const s of ctx.f.suggestions.values()) {
        if (s.status !== 'pending') continue
        const loc = locate(ctx.L, s)
        if (!loc) continue
        const theirStart = ctx.L.blocks[loc.start]!.start
        const theirs = changedSpan(s).map((x) => x + theirStart) as [number, number]
        if (spansOverlap(mine, theirs)) throw err('SUGGESTION_OVERLAP', `overlaps pending suggestion ${s.id}`, { suggestion: s.id, thread: s.thread })
      }
      // §6.2 step 3: merge-hazard check
      const ap = applyToSource(ctx.md, w.L, body)
      if (!ap.verified) throw err('BLOCK_MERGE_HAZARD', 'the suggestion would merge into or change a neighbouring block', { hint: 'keep a blank line between blocks; a new list next to a list merges' })
      let thread: ThreadId
      let newThread = true
      if (op.thread) {
        threadExists(ctx, op.thread, created)
        thread = op.thread
        newThread = false
      } else {
        thread = newThreadId()
        created.add(thread)
      }
      const rev = anchorRev()
      const anchor = anchorForHunks(body.hunks, w, rev) ?? createAnchor(w.P, w.L.blocks, w.L.blocks[body.range.start]!.pStart, w.L.blocks[body.range.start]!.pStart, rev)
      for (const b of baseIdx) doc.markSuggested(b)
      const suggestion = newSuggestionId()
      if (op.reason !== undefined) validateCommentBody(op.reason)
      const comment = op.reason !== undefined ? newCommentId() : undefined
      return {
        events: [{
          type: 'suggestion.add', by: 'Claude', thread, newThread, suggestion,
          ...(comment ? { comment, body: op.reason! } : {}),
          anchor, range: { ...body.range, rev }, base: body.base, proposed: body.proposed, hunks: body.hunks,
        } as NewEvent],
        result: { ...base, thread, suggestion, anchor: viewOfNew(anchor, doc), hunks: body.hunks.map((h) => ({ del: h.del, ins: h.ins })) },
        byte: false,
      }
    }
    case 'replace_block':
    case 'delete_block':
    case 'insert_after':
    case 'insert_before': {
      const bi = baseIndexOf(ctx, op.target, doc)
      const before = doc.working()
      if (op.op === 'replace_block' || op.op === 'delete_block') {
        assertUntouched(doc, [bi], `op ${i}`)
        if (op.op === 'replace_block') {
          const md = convertEol(op.markdown, eol)
          const cur = doc.base.src.slice(doc.base.blocks[bi]!.start, doc.base.blocks[bi]!.end)
          if (md === cur) return { events: [], result: { ...base, noop: true }, byte: false }
          const warn = wholeBlockWarning(op, bi, doc, md)
          if (warn) warnings.push(warn)
          doc.replace(bi, bi + 1, [md])
        } else {
          const warn = wholeBlockWarning(op, bi, doc, null)
          if (warn) warnings.push(warn)
          doc.replace(bi, bi + 1, [])
        }
      } else {
        if (doc.deletedSet.has(bi)) {
          throw err('BATCH_SELF_CONFLICT', `op ${i} is anchored on base block ${refOf(bi)}, which ${doc.touchedBy.has(bi) ? `op ${doc.touchedBy.get(bi)}` : 'an earlier op'} deleted`, {
            hint: 'anchor the insertion on a neighbouring block this batch leaves alone, or send it as its own command or batch', details: { block: refOf(bi) },
          })
        }
        const md = convertEol(op.markdown, eol)
        doc.insertAt(op.op === 'insert_after' ? doc.afterBoundary(bi) : doc.beforeBoundary(bi), [md])
      }
      return { events: [], result: { ...base, changes: changesOf(before, doc.working()) }, byte: true }
    }
    case 'replace_range': {
      const a = baseIndexOf(ctx, op.from, doc)
      const b = baseIndexOf(ctx, op.to, doc)
      if (b < a) throw err('BAD_REQUEST', `replace_range: ${refOf(a)} comes after ${refOf(b)}`)
      const idx = Array.from({ length: b - a + 1 }, (_, k) => a + k)
      assertUntouched(doc, idx, `op ${i}`)
      const before = doc.working()
      doc.replace(a, b + 1, [convertEol(op.markdown, eol)])
      return { events: [], result: { ...base, changes: changesOf(before, doc.working()) }, byte: true }
    }
    case 'write': {
      const next = convertEol(op.markdown, eol)
      if (next === ctx.L.src) return { events: [], result: { ...base, noop: true }, byte: false }
      const N = load(ctx.md, next)
      const wops: BlockOp[] = []
      for (const d of diffBlocks(ctx.L.blocks, N.blocks)) {
        if (d.op === 'equal') continue
        wops.push({
          after: d.a - 1, before: d.a + d.an, covers: ctx.L.blocks.slice(d.a, d.a + d.an).map((x) => x.hash),
          blocks: N.blocks.slice(d.b, d.b + d.bn).map((x) => next.slice(x.start, x.end)),
        })
      }
      const before = doc.working()
      doc.setWrite(wops)
      return { events: [], result: { ...base, changes: changesOf(before, doc.working()) }, byte: true }
    }
    default: {
      const bad = op as { op?: unknown }
      throw err('BAD_REQUEST', `unknown op ${JSON.stringify(bad.op)}`)
    }
  }
}
