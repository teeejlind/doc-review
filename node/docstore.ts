// node/docstore.ts (P1). The DocStore: one per (root, file) per process; the server caches them, the CLI opens one
// per command (CONTRACTS §3.1, §3.5, §3.9, §4, §6, §7, §9.5, §10, Appendix A).
//
// The ledger (node/ledger.ts) owns the cached state, the lock, reconcile, the WAL commit, the TJ session and history
// triggers. This file is the DocStore surface on top of it:
//   - reads (lock-free, every mode): snapshot, review (never throws for the §8.3 read-only states), handoffs() (D46),
//     agent.{status, snapshot, thread}, history.{list, show, diff};
//   - writes (a locked transaction each): save (merge3way for stale bases, the splice ladder, expectHash, recreate),
//     the tj.* surface (threads, decisions with bulk and the atomic bulk reopen, read markers, restore, policy),
//     agent.batch (node/batch.ts: keys computed here, base-map selectors, SUGGEST_ONLY, the suggestion target check),
//     agent.setPolicy, agent.pending (flushes the TJ session first), appendEvents (handoff events only), flushTjSession.
// Idempotency (§4.7): a key already in the fold returns the original result, re-read from the keyed lines (exact
// within this process from a bounded memory cache), with duplicate: true; nothing is appended.
import './dom'
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ulid } from 'ulid'
import type {
  Actor, AgentSnapshot, AgentSnapshotQuery, Anchor, AnchorView, Author, BatchRequest, BatchResult, BlockConflict, BlockOp,
  BlockRef, BulkDecisionRequest, BulkDecisionResult, ClientId, CommentId, CreateThreadRequest, CreateThreadResponse,
  DecideRequest, DecisionResult, DocId, DocSnapshot, DocStore, EditCommentRequest, ErrorCode, FlushReason, Hash, HandoffEventInput,
  HandoffRecord, HistoryDiff, HistoryList, HistoryRef, MessageResponse, NewEvent, OpenDocStore, OpKeyRequest, PendingResult,
  PolicyRequest, ReadMarkerRequest, ReplyRequest, Resolution, RestoreRequest, RestoreResponse, RevCause, SaveRequest,
  SaveResponse, SeqResponse, SidecarEvent, StatusResult, StoreChange, StoreReviewState, Suggestion, SuggestionBody,
  SuggestionId, Thread, ThreadDetail, ThreadId, ThreadOpResponse, TjCtx, TjSuggestionUpsert, Unsubscribe, VersionId,
  VersionShow, Warning,
} from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { StoreError, isStoreError } from '../shared/errors'
import { indexOfRef, isBlockRef, isClientId, isOpKey, isSuggestionId, isThreadId, refOf } from '../shared/ids'
import { load, type Loaded } from '../core/splice/load'
import { applyBlockOps, validateBlockOps } from '../core/splice/apply'
import { docHash } from '../core/hash'
import { createAnchor, createBlockAnchor, resolveAnchor } from '../core/anchors'
import { diffBlocks, isAtomBlock } from '../core/blocks'
import { merge3way } from '../core/merge'
import { handoffRecords, isAutoResolved, toReviewState, type FoldState, type SuggestionFold, type ThreadFold } from '../core/sidecar/fold'
import { saveKey, tjKey } from '../core/sidecar/keys'
import { suggestionTransition, validateAnchor, validateCommentBody } from '../core/sidecar/validate'
import { applyToSource, hunksOf, locate, rebase } from '../core/suggest/record'
import { settledResolution } from '../core/suggest/settled'
import { ptextOf, type PText } from '../core/ptext'
import { buildPending } from '../core/pending/digest'
import { assertServable, realId } from './root'
import { mdrCmd } from './config'
import { nameForAgent } from './identity'
import { sharedMd } from './md'
import { Ledger, type CommitResult, type DocState, type SideState, type View } from './ledger'
import { planBatch, type BatchContext } from './batch'
import { historyBytes, historyDiff, historyList, historyShow, readIndex, readObjectText, type HistoryCurrent } from './history'
import type { Md } from '../core/md/index'

export { decodeDoc } from './doc-io'
export { trailingInFlight } from './ledger'

const PENDING_IGNORED: ReadonlySet<SidecarEvent['type']> = new Set([
  'doc.rev', 'doc.abort', 'server.recovered', 'log.repair', 'ack', 'read-marker', 'handoff.consumed',
])

const newThreadId = (): ThreadId => `t_${ulid()}`
const newCommentId = (): CommentId => `c_${ulid()}`

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'))
const err = (code: ErrorCode, message: string, extra: Record<string, unknown> = {}): StoreError => new StoreError(code, message, extra)

function recoveryWarning(v: View): Warning {
  return v.inFlight
    ? { code: 'NEEDS_RECOVERY', message: `a write of rev ${v.inFlight.rev} never landed; the next writer recovers it` }
    : { code: 'NEEDS_RECOVERY', message: `an unflushed editing session by ${nameForAgent()} is in the log; the next writer flushes it` }
}

/** Table structure of a markdown run: rows × columns and the alignment row, per table (§6.2 TJ upsert check). */
export function tableSignature(md: Md, text: string): string[] {
  if (!text) return []
  const L = load(md, text)
  const out: string[] = []
  for (const e of L.entries) {
    for (const n of e.nodes) {
      if (n.type.name !== 'table') continue
      const cols: number[] = []
      n.forEach((row) => cols.push(row.childCount))
      const align: string[] = []
      n.firstChild?.forEach((cell) => align.push(String(cell.attrs.alignment ?? '')))
      out.push(`${n.childCount}x${cols.join(',')}:${align.join('|')}`)
    }
  }
  return out
}

function assertObject(v: unknown, what: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw err('BAD_REQUEST', `${what} must be an object`)
}
function assertOpKey(v: unknown): void {
  if (typeof v !== 'string' || !isOpKey(v)) throw err('BAD_REQUEST', 'opKey must be op_<ULID>')
}

// ===================================================================================== the store

class NodeDocStore extends Ledger implements DocStore {
  constructor(root: string, file: string, abs: string, opts: { mode: 'server' | 'direct'; readOnly: boolean; lockTimeoutMs: number }, md: Md) {
    super(root, file, abs, opts, md)
  }

  private via(): 'server' | 'direct' {
    return this.mode === 'server' ? 'server' : 'direct'
  }

  // ----------------------------------------------------------------------------------- shared helpers

  private gone(d: DocState, s: SideState): void {
    if (!d.missing) return
    if (s.exists) throw new StoreError('DOC_GONE', `${this.file} was moved or deleted`, { hint: 'restore the file, or reopen it from its new path' })
    throw new StoreError('FILE_NOT_FOUND', `${this.file} does not exist`)
  }

  private readOnlyOf(d: DocState, s: SideState): false | { code: import('../shared/types').ReadOnlyCode; message: string } {
    return s.readOnly || d.readOnly || false
  }

  /** Writes on a doc that can't be served as text (§3.1) refuse READ_ONLY. */
  private assertTextual(d: DocState): void {
    if (d.readOnly) throw new StoreError('READ_ONLY', d.readOnly.message, { hint: 'the document is read-only; fix its bytes and reopen it' })
  }

  /** A thread's anchor against the current text; an accepted suggestion's replaced quote is placed where it went (settled.ts). */
  private resolveThreadAnchor(d: DocState, a: Anchor, t?: ThreadFold, f?: FoldState): Resolution {
    const r = resolveAnchor(d.P, d.L.blocks, a, { fuzzy: t?.kind !== 'suggestion' })
    return r.state === 'detached' && t && f ? (settledResolution(d.L, f, t) ?? r) : r
  }

  private resolver(d: DocState, f?: FoldState): (a: Anchor) => Resolution {
    const textless = d.readOnly !== false
    const threadOf = new Map<Anchor, ThreadFold>()
    if (f) for (const t of f.threads.values()) threadOf.set(t.anchor, t)
    return (a) => {
      if (a.kind === 'doc') return { state: 'doc' }
      if (textless) return { state: 'detached' }
      return this.resolveThreadAnchor(d, a, threadOf.get(a), f)
    }
  }

  private storeReview(d: DocState, s: SideState, v: View): StoreReviewState {
    if (v.review) return v.review
    const base = toReviewState(v.f, this.resolver(d, v.f), { file: this.file })
    const textless = d.readOnly !== false
    const suggestions: Suggestion[] = base.suggestions.map((x) => ({
      ...x, located: x.status === 'pending' && !textless ? locate(d.L, x) : null,
    }))
    v.review = {
      ...base,
      suggestions,
      undeliveredHandoffs: handoffRecords(v.f, { unconsumed: true }).map((h) => h.seq),
      warnings: [...base.warnings, ...v.warnings],
      readOnly: this.readOnlyOf(d, s),
    }
    return v.review
  }

  private snap(d: DocState, s: SideState, v: View): DocSnapshot {
    return {
      file: this.file, abs: this.abs, docId: v.header?.docId ?? null, rev: v.f.rev, hash: d.hash, markdown: d.text,
      bom: d.bom, eol: d.L.eol, size: d.size, mtimeMs: d.mtimeMs, blocks: d.L.blocks, seq: Math.max(v.f.seq, s.parsed?.lastSeq ?? 0),
      schemaFingerprint: this.md.schemaFingerprint, readOnly: this.readOnlyOf(d, s),
    }
  }

  private current(): { current: DocSnapshot; review: StoreReviewState } {
    const { d, s, v } = this.state()
    return { current: this.snap(d, s, v), review: this.storeReview(d, s, v) }
  }

  private stale(code: 'STALE_REVISION' | 'CONFLICT', message: string, extra: Record<string, unknown> = {}): StoreError {
    return new StoreError(code, message, extra, this.current())
  }

  private threadOf(f: FoldState, id: ThreadId): ThreadFold {
    const t = f.threads.get(id)
    if (!t) throw err('THREAD_NOT_FOUND', `thread ${id} not found`, { thread: id })
    return t
  }

  private suggestionOf(f: FoldState, id: SuggestionId): SuggestionFold {
    const s = f.suggestions.get(id)
    if (!s) throw err('SUGGESTION_NOT_FOUND', `suggestion ${id} not found`, { suggestion: id })
    return s
  }

  private messageOf(f: FoldState, id: CommentId): { t: ThreadFold; by: Author } {
    for (const t of f.threads.values()) {
      const m = t.messages.find((x) => x.id === id)
      if (m && !m.deleted) return { t, by: m.by }
    }
    throw err('COMMENT_NOT_FOUND', `comment ${id} not found`)
  }

  private reviewThread(id: ThreadId): Thread {
    const { d, s, v } = this.state()
    const t = this.storeReview(d, s, v).threads.find((x) => x.id === id)
    if (!t) throw err('THREAD_NOT_FOUND', `thread ${id} not found`, { thread: id })
    return t
  }

  /** The non-void lines that carry `key` (a duplicate's original lines). */
  private keyedLines(v: View, key: string): SidecarEvent[] {
    return v.events.filter((e) => e.key === key && !(e.wal && v.f.voidRevs.has(e.wal.rev)))
  }

  private cached<T>(key: string, mark: (r: T) => T = (r) => ({ ...(r as object), duplicate: true }) as T): T | null {
    const r = this.results.get(key)
    return r === undefined ? null : mark(r as T)
  }

  private ctxOf(ctx?: TjCtx): { clientId?: ClientId } {
    if (ctx?.clientId !== undefined && !isClientId(ctx.clientId)) throw err('BAD_REQUEST', 'X-MDR-Client-Id must be k_<ULID>')
    return ctx?.clientId ? { clientId: ctx.clientId } : {}
  }

  private pendingIn(f: FoldState, t: ThreadFold): SuggestionId[] {
    return t.suggestions.filter((id) => {
      const s = f.suggestions.get(id)
      return s !== undefined && (s.status === 'pending' || s.status === 'stale')
    })
  }

  // ----------------------------------------------------------------------------------- reads

  async snapshot(): Promise<DocSnapshot> {
    const { d, s, v } = this.state()
    this.gone(d, s)
    return this.snap(d, s, v)
  }

  async review(): Promise<StoreReviewState> {
    const { d, s, v } = this.state()
    this.gone(d, s)
    const r = this.storeReview(d, s, v)
    if (!(await this.needsRecovery(v))) return r
    return { ...r, warnings: [...r.warnings, recoveryWarning(v)] }
  }

  async handoffs(o?: { unconsumed?: boolean }): Promise<HandoffRecord[]> {
    return handoffRecords(this.state().v.f, o)
  }

  onChange(cb: (c: StoreChange) => void): Unsubscribe {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    // the server flushes TJ sessions itself before closing (RunningServer.close); a session this store owns is
    // flushed here too, so a store closed any other way never strands one
    if (this.mode === 'server' && !this.readOnlyStore && this.ownSession !== null) {
      await this.flushTjSessionLocked('shutdown').catch(() => undefined)
    }
    await this.shutdownLedger()
  }

  /**
   * Server open (§3.6 "on server start for every doc it opens"): reconcile, the step-9 catch-up and the TJ session
   * recovery now, so the first reader already sees an external edit made while nothing watched. Best effort: a held
   * lock or a read-only state just leaves it to the first write.
   */
  async initialize(): Promise<void> {
    if (this.readOnlyStore) return
    this.startTracking()
    const { d, s } = this.state()
    if (!s.exists || s.readOnly || d.readOnly !== false) return
    await this.transact(() => undefined).catch(() => undefined)
  }

  // ----------------------------------------------------------------------------------- agent reads

  private anchorView(d: DocState, a: Anchor, t?: ThreadFold, f?: FoldState): AnchorView {
    if (a.kind === 'doc') return { state: 'doc', block: null, line: null, quote: '' }
    const r: Resolution = t?.detached ? { state: 'detached' } : (d.readOnly !== false ? { state: 'detached' } : this.resolveThreadAnchor(d, a, t, f))
    const state: AnchorView['state'] = r.state === 'exact' || r.state === 'moved' ? 'ok' : r.state === 'fuzzy' ? 'fuzzy' : r.state === 'doc' ? 'doc' : 'detached'
    const block = state === 'detached' ? null : (r.block ?? null)
    const quote = a.kind === 'text' ? (a.tail !== undefined ? `${a.quote} … ${a.tail}` : a.quote) : a.preview
    return {
      state, block: block === null ? null : refOf(block), line: block === null ? null : (d.L.blocks[block]?.line ?? null), quote,
      ...(r.ambiguous ? { ambiguous: true as const } : {}),
    }
  }

  private pendingCount(v: View): number {
    const ack = v.f.cursors.claudeAck
    let n = 0
    for (const e of v.events) {
      if (e.seq <= ack || e.by === 'Claude' || PENDING_IGNORED.has(e.type)) continue
      if (e.wal && v.f.voidRevs.has(e.wal.rev)) continue
      n++
    }
    // §7.1: status never flushes, and counts an open TJ session as one edit
    return n + (this.liveSession(v) ? 1 : 0)
  }

  private async statusNow(): Promise<Omit<StatusResult, 'server' | 'presence' | 'activity'>> {
    const { d, s, v } = this.state()
    this.gone(d, s)
    const threads = [...v.f.threads.values()]
    const sugg = [...v.f.suggestions.values()]
    const needsRecovery = await this.needsRecovery(v)
    const warnings: Warning[] = [...v.f.warnings, ...v.warnings]
    if (s.bytes > CONSTANTS.SIDECAR_WARN_BYTES) warnings.push({ code: 'SIDECAR_LARGE', message: `the sidecar is ${s.bytes} bytes; ${mdrCmd()} doctor --compact shrinks it` })
    const hb = historyBytes(this.abs)
    if (hb > CONSTANTS.HISTORY_MAX_BYTES) warnings.push({ code: 'HISTORY_LARGE', message: `history uses ${hb} bytes (cap ${CONSTANTS.HISTORY_MAX_BYTES})` })
    // §3.7: the mdr 1 sidecar is never read, written or migrated; status only reports it
    const legacy = existsSync(this.abs + '.comments.jsonl')
    if (legacy) warnings.push({ code: 'LEGACY_SIDECAR', message: 'an mdr 1 comments sidecar exists next to this file; mdr 2 never reads or migrates it' })
    if (needsRecovery) warnings.push(recoveryWarning(v))
    return {
      ok: true, via: this.via(), file: this.file, abs: this.abs, root: this.root, rev: v.f.rev, hash: d.hash, seq: v.f.seq,
      threads: {
        // a decided suggestion thread is closed whatever its stored status: the same reading `pending` and the rail use
        open: threads.filter((t) => t.status === 'open' && !t.detached && !isAutoResolved(v.f, t)).length,
        resolved: threads.filter((t) => t.status === 'resolved' || isAutoResolved(v.f, t)).length,
        detached: threads.filter((t) => t.detached).length,
      },
      suggestions: { pending: sugg.filter((x) => x.status === 'pending').length, stale: sugg.filter((x) => x.status === 'stale').length },
      pendingCount: this.pendingCount(v),
      cursor: { ack: v.f.cursors.claudeAck, latest: v.f.seq },
      handoff: { undelivered: handoffRecords(v.f, { unconsumed: true }).map((h) => h.seq) },
      policy: { ...v.f.policy },
      legacySidecar: legacy,
      needsRecovery,
      readOnly: this.readOnlyOf(d, s),
      warnings,
    }
  }

  private refIndex(ref: BlockRef | undefined, d: DocState, fallback: number): number {
    if (ref === undefined) return fallback
    if (!isBlockRef(ref)) throw new StoreError('BAD_REQUEST', `${String(ref)} is not a block ref (bN)`)
    const i = indexOfRef(ref)!
    if (i >= d.L.blocks.length) {
      throw new StoreError('BLOCK_NOT_FOUND', `${ref} is beyond the last block (b${d.L.blocks.length})`, { hint: `run ${mdrCmd()} snapshot for the current refs` })
    }
    return i
  }

  private agentSnapshotNow(q: AgentSnapshotQuery): AgentSnapshot {
    const { d, s, v } = this.state()
    this.gone(d, s)
    const from = this.refIndex(q.from, d, 0)
    const to = this.refIndex(q.to, d, d.L.blocks.length - 1)
    const review = this.storeReview(d, s, v)
    return {
      ok: true, via: this.via(), file: this.file, abs: this.abs, rev: v.f.rev, hash: d.hash, eol: d.L.eol, bom: d.bom,
      blocks: d.L.blocks.filter((b) => b.index >= from && b.index <= to).map((b) => ({
        ref: b.ref, type: b.mdType, kind: b.kind, line: b.line, endLine: b.endLine, hash: b.hash,
        ...(q.md ? { md: d.text.slice(b.start, b.end) } : {}),
        ...(q.text ? { text: d.P.text.slice(b.pStart, b.pEnd) } : {}),
      })),
      threads: review.threads.map((t) => ({
        id: t.id, kind: t.kind, status: t.autoResolved ? 'resolved' : t.status, anchor: this.anchorView(d, t.anchor, v.f.threads.get(t.id), v.f), by: t.createdBy,
        replies: Math.max(0, t.messages.filter((m) => !m.deleted).length - 1),
      })),
      suggestions: review.suggestions.map((x) => ({
        id: x.id, thread: x.thread, by: x.by, status: x.status,
        block: x.located ? refOf(x.located.start) : null, line: x.located ? (d.L.blocks[x.located.start]?.line ?? null) : null,
        hunks: x.hunks.map((h) => ({ del: h.del, ins: h.ins })),
      })),
    }
  }

  private threadDetailNow(id: ThreadId): ThreadDetail {
    const { d, s, v } = this.state()
    this.gone(d, s)
    const t = v.f.threads.get(id)
    if (!t) throw new StoreError('THREAD_NOT_FOUND', `thread ${id} not found`, { thread: id })
    const view = this.anchorView(d, t.anchor, t, v.f)
    const bi = view.block === null ? null : indexOfRef(view.block)
    const blk = bi === null ? undefined : d.L.blocks[bi]
    const review = this.storeReview(d, s, v)
    return {
      ok: true, via: this.via(),
      thread: {
        id: t.id, kind: t.kind, status: isAutoResolved(v.f, t) ? 'resolved' : t.status,
        anchor: { ...view, context: blk ? d.text.slice(blk.start, blk.end) : '' },
        messages: t.messages.map((m) => ({
          id: m.id, by: m.by, at: m.at, body: m.body, ...(m.editedAt ? { editedAt: m.editedAt } : {}), ...(m.deleted ? { deleted: true as const } : {}),
        })),
        suggestions: t.suggestions
          .map((sid) => review.suggestions.find((x) => x.id === sid))
          .filter((x): x is Suggestion => x !== undefined)
          .map((x) => ({
            id: x.id, by: x.by, status: x.status, base: x.base, proposed: x.proposed, hunks: x.hunks.map((h) => ({ ...h })),
            block: x.located ? refOf(x.located.start) : null, line: x.located ? (d.L.blocks[x.located.start]?.line ?? null) : null,
            ...(x.staleReason ? { staleReason: x.staleReason } : {}),
          })),
      },
    }
  }

  /** §9.6 input: the non-void log, the review state, and runText over objects pre-read for the window (D33). */
  private computePending(): PendingResult {
    const { d, s, v } = this.state()
    this.gone(d, s)
    if (s.readOnly) throw new StoreError(s.readOnly.code, s.readOnly.message, { hint: `run ${mdrCmd()} doctor ${this.file}` })
    const review = this.storeReview(d, s, v)
    const ack = v.f.cursors.claudeAck
    const texts = new Map<number, string | null>()
    const textAt = (rev: number): string | null => {
      if (texts.has(rev)) return texts.get(rev)!
      const h = v.revHashes.get(rev)
      const t = h === undefined ? null : h === d.hash && d.readOnly === false ? d.text : (readObjectText(this.abs, h)?.text ?? null)
      texts.set(rev, t)
      return t
    }
    // pre-read (under the lock when the store is writable) every rev a side in the window references
    for (const e of v.events) {
      if (e.seq <= ack) continue
      if (e.type === 'doc.edit' || e.type === 'doc.external') {
        textAt(e.fromRev)
        textAt(e.toRev)
      }
    }
    const runText = (rev: number, start: number, end: number): string | null => {
      const t = textAt(rev)
      return t === null ? null : t.slice(start, end)
    }
    return buildPending({
      file: this.file, abs: this.abs, rev: v.f.rev, hash: d.hash, via: this.via(),
      events: v.events.filter((e) => !(e.wal && v.f.voidRevs.has(e.wal.rev))), review, blocks: d.L.blocks, runText,
    })
  }

  private async pendingNow(): Promise<PendingResult> {
    const { d, s } = this.state()
    this.gone(d, s)
    if (s.readOnly) throw new StoreError(s.readOnly.code, s.readOnly.message, { hint: `run ${mdrCmd()} doctor ${this.file}` })
    // a readOnly store never flushes; a doc with no sidecar has no session to flush (and a read never creates one)
    if (this.readOnlyStore || !s.exists || d.readOnly !== false) return this.computePending()
    return this.transact((emits) => {
      this.flushSessionNow('agent-read', emits)
      return this.computePending()
    })
  }

  readonly agent: DocStore['agent'] = {
    status: () => this.statusNow(),
    snapshot: async (q) => this.agentSnapshotNow(q ?? {}),
    pending: () => this.pendingNow(),
    thread: async (id) => this.threadDetailNow(id),
    batch: (req) => this.batch(req),
    setPolicy: (req) => this.setPolicy(req, 'Claude').then((r) => ({ ok: true as const, seq: r.seq, suggestOnly: this.state().v.f.policy.suggestOnly })),
  }

  // ----------------------------------------------------------------------------------- history (§10)

  private historyCurrent(): HistoryCurrent {
    const { d, s, v } = this.state()
    this.gone(d, s)
    return {
      file: this.file, rev: v.f.rev, hash: d.hash, text: d.text, lastBy: this.lastRevBy(v),
      revHash: (rev) => v.revHashes.get(rev), revBy: (rev) => v.revBy.get(rev),
    }
  }

  readonly history: DocStore['history'] = {
    list: async (o): Promise<HistoryList> => ({ ...historyList(this.abs, this.historyCurrent(), o), via: this.via() }),
    show: async (ver: VersionId): Promise<VersionShow> => {
      this.historyCurrent()
      return { ...historyShow(this.abs, ver), via: this.via() }
    },
    diff: async (from: HistoryRef, to: HistoryRef): Promise<HistoryDiff> => (
      { ...historyDiff(this.md, this.abs, this.historyCurrent(), from, to), via: this.via() }
    ),
  }

  // ----------------------------------------------------------------------------------- flush (§7.1)

  async flushTjSession(reason: FlushReason): Promise<void> {
    await this.flushTjSessionLocked(reason)
  }

  // ----------------------------------------------------------------------------------- appendEvents (§3.9, §8.5)

  async appendEvents(events: HandoffEventInput[], ctx?: TjCtx): Promise<{ seq: number; events: SidecarEvent[] }> {
    if (!Array.isArray(events)) throw err('INTERNAL', 'appendEvents takes an array of handoff events')
    const batch: NewEvent[] = events.map((e) => {
      const ev = e as HandoffEventInput & { by?: unknown }
      if (ev.by !== undefined) throw err('INTERNAL', 'appendEvents derives `by`; the caller never passes one')
      if (ev.type === 'handoff.sent') {
        if (ev.message !== null && (typeof ev.message !== 'string' || ev.message.length > CONSTANTS.MAX_HANDOFF_MESSAGE_CHARS)) {
          throw err('BAD_REQUEST', `message must be at most ${CONSTANTS.MAX_HANDOFF_MESSAGE_CHARS} characters`)
        }
        if (!['waiter', 'latched', 'clipboard'].includes(ev.delivery)) throw err('INTERNAL', `bad delivery ${String(ev.delivery)}`)
        // §4.7 "Browser discrete action": the handoff module passes `tj:<opKey>`; it goes on the line, and a repeat of
        // it is a duplicate like any other keyed TJ action (integrator, P4 merge; contract-changes/P4.md)
        const key = (ev as { key?: unknown }).key
        if (key !== undefined && (typeof key !== 'string' || !key.startsWith('tj:') || !isOpKey(key.slice(3)))) {
          throw err('INTERNAL', 'a handoff.sent key must be tj:<opKey>')
        }
        return { type: 'handoff.sent', by: 'TJ', message: ev.message, delivery: ev.delivery, ...(key !== undefined ? { key } : {}) } as NewEvent
      }
      if (ev.type === 'handoff.consumed') {
        if (!Array.isArray(ev.handoffs) || ev.handoffs.some((x) => !Number.isInteger(x))) throw err('INTERNAL', 'handoff.consumed needs seq numbers')
        return {
          type: 'handoff.consumed', by: ev.via === 'waiter' ? 'Claude' : 'system', handoffs: [...ev.handoffs], via: ev.via,
          ...(ev.waiter !== undefined ? { waiter: ev.waiter } : {}),
        } as NewEvent
      }
      throw err('INTERNAL', `appendEvents takes handoff events only, got ${(ev as { type?: unknown }).type as string}`)
    })
    const c = this.ctxOf(ctx)
    const isHandoff = (x: SidecarEvent): boolean => x.type === 'handoff.sent' || x.type === 'handoff.consumed'
    return this.transact((emits) => {
      const { d, s, v } = this.state()
      // a keyed event already in the log is not appended again; when nothing is left, answer the original line(s)
      const keyOf = (e: NewEvent): string | undefined => (e as { key?: string }).key
      const repeats = batch.filter((e) => keyOf(e) !== undefined && v.f.keys.has(keyOf(e)!))
      const fresh = batch.filter((e) => !repeats.includes(e))
      if (fresh.length === 0) {
        const lines = repeats.flatMap((e) => this.keyedLines(v, keyOf(e)!)).filter(isHandoff)
        return { seq: Math.max(...repeats.flatMap((e) => v.f.keys.get(keyOf(e)!)!)), events: lines }
      }
      this.gone(d, s)
      this.assertTextual(d)
      if (fresh.some((e) => e.type === 'handoff.sent')) this.flushSessionNow('handoff', emits)
      const r = this.commit({ events: () => fresh, ...c }, emits)
      return { seq: r.seq, events: r.events.filter(isHandoff) }
    })
  }

  // ----------------------------------------------------------------------------------- save (§3.9, §7.1, §7.3, §7.4)

  async save(req: SaveRequest, ctx?: TjCtx): Promise<SaveResponse> {
    assertObject(req, 'the save request')
    if (typeof req.clientId !== 'string' || !isClientId(req.clientId)) throw err('BAD_REQUEST', 'clientId must be k_<ULID>')
    if (!Number.isInteger(req.saveId) || req.saveId < 0) throw err('BAD_REQUEST', 'saveId must be a non-negative integer')
    assertObject(req.base, 'base')
    if (!Number.isInteger(req.base.rev) || typeof req.base.hash !== 'string' || !Array.isArray(req.base.blockHashes)) {
      throw err('BAD_REQUEST', 'base needs rev, hash and blockHashes')
    }
    if (!Array.isArray(req.ops)) throw err('BAD_REQUEST', 'ops must be an array')
    if (req.cause !== 'edit' && req.cause !== 'merge' && req.cause !== 'recreate') throw err('BAD_REQUEST', `cause must be edit, merge or recreate`)
    if (typeof req.allowPartial !== 'boolean') throw err('BAD_REQUEST', 'allowPartial must be a boolean')
    if (req.suggestions !== undefined) {
      assertObject(req.suggestions, 'suggestions')
      if ('reopen' in req.suggestions) throw err('BAD_REQUEST', 'suggestions.reopen is not part of a save: reopen through POST /api/suggestions/:id/reopen before saving (D26)')
    }
    if (req.ops.length > 0 && req.expectHash === undefined) throw err('BAD_REQUEST', 'expectHash is required when ops are sent')
    const c = this.ctxOf(ctx)
    return this.transact((emits) => this.saveNow(req, c, emits))
  }

  private saveNow(req: SaveRequest, c: { clientId?: ClientId }, emits: StoreChange[]): SaveResponse {
    const key = saveKey(req.clientId, req.saveId)
    const hit = this.results.get(key) as SaveResponse | undefined
    if (hit) return { ...hit, applied: 'duplicate' }
    const { d, s, v } = this.state()
    if (v.f.keys.has(key)) {
      const rev = this.keyedLines(v, key).find((e) => e.type === 'doc.rev')
      const lineRev = rev?.rev ?? this.keyedLines(v, key)[0]?.rev ?? v.f.rev
      return {
        ok: true, applied: 'duplicate', rev: lineRev, hash: v.revHashes.get(lineRev) ?? d.hash, seq: Math.max(...v.f.keys.get(key)!),
        conflicts: [], unsaveable: [], warnings: [], staled: [], rebasedSuggestions: [],
      }
    }
    const missing = d.missing
    if (missing && req.cause !== 'recreate') this.gone(d, s)
    if (missing && !s.exists) this.gone(d, s)
    this.assertTextual(d)

    // the current text: the disk, or for a recreate object(lastHash) (§3.6)
    let L: Loaded = d.L
    let baseText = d.text
    let curHash: Hash = d.hash
    let recreate: { baseText: string; baseL: Loaded } | undefined
    if (missing) {
      const lastHash = this.lastRev(v)?.hash ?? v.f.hash
      const text0 = lastHash ? this.textOfHash(lastHash) : null
      if (!lastHash || text0 === null) throw err('DOC_GONE', `${this.file} was deleted and its last content is no longer retained`)
      L = this.loadCached(text0)
      baseText = text0
      curHash = lastHash
      recreate = { baseText: text0, baseL: L }
      if (req.base.hash !== lastHash) {
        const cur: DocSnapshot = { ...this.snap(d, s, v), hash: lastHash, markdown: text0, blocks: L.blocks, eol: L.eol, readOnly: false }
        throw new StoreError('CONFLICT', 'recreate base does not match the last known content of the file', {}, { current: cur, review: this.storeReview(d, s, v) })
      }
    }
    validateBlockOps(req.base.blockHashes.map((hash) => ({ hash })), req.ops)

    const strict = !req.allowPartial
    const curHashes = L.blocks.map((b) => b.hash)
    const direct = req.base.hash === curHash && req.base.blockHashes.length === curHashes.length && req.base.blockHashes.every((h, k) => h === curHashes[k])
    let ops: BlockOp[] = req.ops
    let conflicts: BlockConflict[] = []
    if (!direct && req.ops.length > 0) {
      let baseL: Loaded | null | undefined
      const baseBlocks = (): Loaded | null => {
        if (baseL === undefined) {
          const t = this.textOfHash(req.base.hash)
          baseL = t === null ? null : this.loadCached(t, L)
        }
        return baseL
      }
      const m = merge3way(
        { baseHashes: req.base.blockHashes, current: L, ops: req.ops, theirsBy: (j) => this.theirsBy(v, L, j) },
        (index) => {
          const bl = baseBlocks()
          const b = bl?.blocks[index]
          return bl && b ? bl.src.slice(b.start, b.end) : null
        },
      )
      ops = m.mapped
      conflicts = m.conflicts
      if (conflicts.length && strict) throw this.stale('CONFLICT', `${conflicts.length} block(s) changed on both sides`, { conflicts })
    }
    let text = baseText
    let textL: Loaded | undefined
    let unsaveable: BlockConflict[] = []
    const warnings: Warning[] = []
    if (ops.length > 0) {
      const r = applyBlockOps(this.md, L, ops)
      if (r.failed.length) {
        if (strict) throw err('SPLICE_MISMATCH', `${r.failed.length} op(s) failed splice verification at every widening level`)
        unsaveable = r.failed.map((k) => this.unsaveableOf(ops[k]!, L, v))
        if (this.mode === 'server') {
          // §7.4: logged with the block source so it can join the corpus (server.log is the detached server's stderr)
          for (const u of unsaveable) console.error(`[mdr] unsaveable op in ${this.file}: ${JSON.stringify({ id: u.id, mine: u.mine, theirs: u.theirs })}`)
        }
      }
      if (r.widened.length) {
        warnings.push({ code: 'SPLICE_WIDENED', message: `${r.widened.length} op(s) verified only after the widening ladder (levels ${r.widened.map((w) => w.level).join(', ')})` })
      }
      if (direct && req.expectHash !== undefined && docHash(r.text, d.bom) !== req.expectHash) {
        throw err('SPLICE_MISMATCH', 'the spliced text does not match expectHash', { details: { expected: req.expectHash, actual: docHash(r.text, d.bom) } })
      }
      text = r.text
    }
    if (text !== baseText) textL = this.loadCached(text, L)
    const events = this.saveEvents(req, L, v.f, textL ?? L)
    const cause: RevCause = req.cause === 'edit' ? 'save' : req.cause
    const res = this.commit({
      events: () => events, key, text, ...(recreate ? { recreate } : {}), by: 'TJ', cause, ...c, saveId: req.saveId,
      ...(textL ? { textL } : {}),
    }, emits)
    const merged = !direct && req.ops.length > 0
    const applied: SaveResponse['applied'] = res.bytesChanged ? (merged ? 'merged' : 'direct') : res.events.length ? 'direct' : 'noop'
    const after = this.state()
    const out: SaveResponse = {
      ok: true, applied, rev: res.rev, hash: res.hash, seq: res.seq, conflicts, unsaveable,
      warnings: [...warnings, ...res.warnings],
      ...(applied === 'merged' || conflicts.length > 0 ? { rebased: this.snap(after.d, after.s, after.v) } : {}),
      staled: res.staled, rebasedSuggestions: res.rebased,
    }
    if (res.events.length) this.remember(key, out)
    return out
  }

  /** Who wrote theirs for a conflict (§7.3): the latest doc.edit / doc.external whose after side holds that block. */
  private theirsBy(v: View, L: Loaded, j: number): { by: Actor; rev: number } {
    const h = L.blocks[j]?.hash
    if (h !== undefined) {
      for (let k = v.events.length - 1; k >= 0; k--) {
        const e = v.events[k]!
        if ((e.type === 'doc.edit' || e.type === 'doc.external') && e.changes?.some((c) => c.after?.hashes.includes(h))) {
          return { by: e.by, rev: e.toRev }
        }
      }
    }
    return { by: this.lastRevBy(v), rev: v.f.rev }
  }

  private unsaveableOf(op: BlockOp, L: Loaded, v: View): BlockConflict {
    const covered = op.covers.length ? L.src.slice(L.blocks[op.after + 1]!.start, L.blocks[op.before - 1]!.end) : ''
    const anchorHash = op.covers[0] ?? L.blocks[op.after]?.hash ?? 'bof'
    return {
      kind: 'unsaveable', id: `unsaveable:${anchorHash}`, baseIndex: op.after + 1, currentIndex: op.covers.length ? op.after + 1 : null,
      base: covered, mine: op.blocks.length ? op.blocks.join(L.eol + L.eol) : null, theirs: covered,
      theirsBy: this.lastRevBy(v), theirsRev: v.f.rev,
    }
  }

  /** Anchor updates and TJ suggestion upserts / withdrawals ride the save batch (§5.4, §6.4). */
  private saveEvents(req: SaveRequest, L: Loaded, f: FoldState, after: Loaded): NewEvent[] {
    const out: NewEvent[] = []
    let afterP: PText | undefined
    for (const a of req.anchors ?? []) {
      assertObject(a, 'an anchor update')
      if (typeof a.thread !== 'string' || !isThreadId(a.thread)) throw err('BAD_REQUEST', 'anchor update needs a thread id')
      const t = this.threadOf(f, a.thread)
      if (a.anchor === null) {
        // The browser reports the decorated range as deleted. That is only a claim: a restored draft or a remounted doc
        // loses the decoration while the text stays, and a detach recorded in a commit that changes no bytes would
        // stand until some later write (the system pass only runs on a byte change). If the quote still resolves
        // exactly and uniquely in the text this save leaves, the thread stays attached (QA3 R1).
        afterP ??= ptextOf(after.doc, after)
        const held = !t.detached && t.anchor.kind !== 'doc' && this.uniquePlace(afterP, after, t, t.anchor) !== null
        if (!held) out.push({ type: 'thread.detach', by: 'TJ', thread: a.thread, cause: 'deleted' })
      } else {
        validateAnchor(a.anchor)
        out.push({ type: 'anchor.update', by: 'TJ', thread: a.thread, anchor: a.anchor })
      }
    }
    for (const u of req.suggestions?.upsert ?? []) out.push(...this.upsertEvents(u, L, f))
    for (const id of req.suggestions?.withdraw ?? []) {
      const s = this.suggestionOf(f, id)
      const t = suggestionTransition(s, 'suggestion.withdraw', 'TJ')
      if (t === 'duplicate') continue
      if (t !== 'ok') throw err(t, `cannot withdraw ${id} (${s.status})`, { suggestion: id })
      out.push({ type: 'suggestion.withdraw', by: 'TJ', suggestion: id })
    }
    return out
  }

  /**
   * One TJ editor suggestion (§6.4) with the §6.2 target check: a run holding an atom block, or a proposed text that
   * changes a table's structure (rows, columns, alignment), is UNANCHORABLE_TARGET. Table cell text is fine.
   */
  private upsertEvents(u: TjSuggestionUpsert, L: Loaded, f: FoldState): NewEvent[] {
    assertObject(u, 'a suggestion upsert')
    if (typeof u.id !== 'string' || !isSuggestionId(u.id)) throw err('BAD_REQUEST', `malformed suggestion id ${String(u.id)}`)
    if (typeof u.base !== 'string' || typeof u.proposed !== 'string') throw err('BAD_REQUEST', 'upsert needs base and proposed')
    if (!u.anchor || u.anchor.kind !== 'text') throw err('BAD_REQUEST', 'a suggestion anchor is a text anchor')
    validateAnchor(u.anchor)
    assertObject(u.range, 'range')
    if (!Number.isInteger(u.range.start) || !Number.isInteger(u.range.end) || u.range.start < 0 || u.range.end < u.range.start) {
      throw err('BAD_REQUEST', 'upsert range must be block indexes { start, end } with start <= end')
    }
    const run = locate(L, { base: u.base, range: { start: u.range.start, end: u.range.end, rev: 0 } })
    const runBlocks = run ? L.blocks.slice(run.start, run.end) : load(this.md, u.base).blocks
    for (const b of runBlocks) {
      if (isAtomBlock(b)) throw err('UNANCHORABLE_TARGET', `block ${run ? b.ref : 'in the suggestion'} is an atom block and takes no inline suggestion`, { suggestion: u.id })
    }
    if (load(this.md, u.proposed).blocks.some((b) => isAtomBlock(b) && !u.base.includes(u.proposed.slice(b.start, b.end)))) {
      throw err('UNANCHORABLE_TARGET', 'a suggestion cannot insert an atom block (frontmatter, a raw block, a rule)', { suggestion: u.id })
    }
    if (JSON.stringify(tableSignature(this.md, u.base)) !== JSON.stringify(tableSignature(this.md, u.proposed))) {
      throw err('UNANCHORABLE_TARGET', 'a suggestion cannot change a table\'s structure; switch to Editing for rows, columns and alignment', { suggestion: u.id })
    }
    const at = L.blocks[run?.start ?? u.range.start]?.pStart ?? 0
    const hunks = hunksOf(this.md, { base: u.base, proposed: u.proposed }, at)
    const range = { start: run?.start ?? u.range.start, end: run?.end ?? u.range.end, rev: f.rev }
    const existing = f.suggestions.get(u.id)
    if (existing) {
      if (existing.by !== 'TJ') throw err('BAD_REQUEST', `suggestion id ${u.id} belongs to ${existing.by}`, { suggestion: u.id })
      const t = suggestionTransition(existing, 'suggestion.update', 'TJ')
      if (t !== 'ok') throw err(t === 'duplicate' ? 'SUGGESTION_CLOSED' : t, `cannot update ${u.id} (${existing.status})`, { suggestion: u.id })
      if (existing.base === u.base && existing.proposed === u.proposed) return []
      return [{ type: 'suggestion.update', by: 'TJ', suggestion: u.id, anchor: u.anchor, range, base: u.base, proposed: u.proposed, hunks }]
    }
    if (u.thread !== undefined) this.threadOf(f, u.thread)
    return [{
      type: 'suggestion.add', by: 'TJ', thread: u.thread ?? newThreadId(), newThread: u.thread === undefined, suggestion: u.id,
      anchor: u.anchor, range, base: u.base, proposed: u.proposed, hunks,
    }]
  }

  // ----------------------------------------------------------------------------------- TJ surface

  readonly tj: DocStore['tj'] = {
    createThread: (req, ctx) => this.createThread(req, ctx),
    reply: (thread, req, ctx) => this.reply(thread, req, ctx),
    editComment: (comment, req, ctx) => this.editComment(comment, req, ctx),
    deleteComment: (comment, req, ctx) => this.deleteComment(comment, req, ctx),
    resolve: (thread, req, ctx) => this.threadStatus(thread, 'resolved', req, ctx),
    reopen: (thread, req, ctx) => this.threadStatus(thread, 'open', req, ctx),
    decide: (id, decision, req, ctx) => this.decide(id, decision, req, ctx),
    reopenSuggestion: (id, req, ctx) => this.reopenSuggestion(id, req, ctx),
    bulkDecide: (req, ctx) => this.bulkDecide(req, ctx),
    readMarker: (req, ctx) => this.readMarker(req, ctx),
    restore: (req, ctx) => this.restore(req, ctx),
    setPolicy: (req, ctx) => this.setPolicy(req, 'TJ', ctx),
  }

  /** Open a TJ transaction: duplicate check by key (memory, then the log), then the doc checks. */
  private async tjTx<T>(key: string, fromLog: (v: View, lines: SidecarEvent[]) => T, body: (emits: StoreChange[], v: View, d: DocState, s: SideState) => T, o: { needDoc?: boolean; mark?: (r: T) => T } = {}): Promise<T> {
    const hit = this.cached<T>(key, o.mark)
    if (hit) return hit
    return this.transact((emits) => {
      const again = this.cached<T>(key, o.mark)
      if (again) return again
      const { d, s, v } = this.state()
      if (v.f.keys.has(key)) return fromLog(v, this.keyedLines(v, key))
      if (o.needDoc !== false) this.gone(d, s)
      this.assertTextual(d)
      const out = body(emits, v, d, s)
      this.remember(key, out)
      return out
    })
  }

  private async createThread(req: CreateThreadRequest, ctx?: TjCtx): Promise<CreateThreadResponse> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    validateAnchor(req.anchor)
    validateCommentBody(req.body)
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    return this.tjTx(key, (_v, lines) => {
      const add = lines.find((e) => e.type === 'comment.add') as Extract<SidecarEvent, { type: 'comment.add' }> | undefined
      if (!add) throw err('INTERNAL', `key ${key} has no comment.add`)
      return { ok: true as const, thread: this.reviewThread(add.thread), seq: add.seq, duplicate: true as const }
    }, (emits, v, d) => {
      let anchor = req.anchor
      if (anchor.kind !== 'doc' && Number.isInteger(req.anchorRev) && req.anchorRev < v.f.rev) {
        // Appendix A step 4: an anchor made at an older rev is re-resolved to the current text
        const r = resolveAnchor(d.P, d.L.blocks, anchor, { fuzzy: true })
        if (anchor.kind === 'text' && r.from !== undefined && r.to !== undefined && r.state !== 'detached') anchor = createAnchor(d.P, d.L.blocks, r.from, r.to, v.f.rev)
        else if (anchor.kind === 'block' && r.block !== undefined && r.state !== 'detached') anchor = createBlockAnchor(d.L.blocks, r.block, v.f.rev)
      }
      if (anchor.kind === 'text' && anchor.quote.includes('￼') && anchor.quote.replace(/￼/g, '').trim() === '') {
        throw err('UNANCHORABLE_TARGET', 'the selection holds only atom content; anchor it to the block instead')
      }
      const thread = newThreadId()
      const res = this.commit({ events: () => [{ type: 'comment.add', by: 'TJ', thread, comment: newCommentId(), anchor, body: req.body }], key, ...c }, emits)
      return { ok: true as const, thread: this.reviewThread(thread), seq: res.seq }
    })
  }

  private async reply(thread: ThreadId, req: ReplyRequest, ctx?: TjCtx): Promise<MessageResponse> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    validateCommentBody(req.body)
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    return this.tjTx(key, (_v, lines) => {
      const r = lines.find((e) => e.type === 'comment.reply') as Extract<SidecarEvent, { type: 'comment.reply' }> | undefined
      if (!r) throw err('INTERNAL', `key ${key} has no comment.reply`)
      const m = this.reviewThread(r.thread).messages.find((x) => x.id === r.comment)!
      return { ok: true as const, message: m, seq: r.seq, duplicate: true as const }
    }, (emits, v) => {
      const t = this.threadOf(v.f, thread)
      const comment = newCommentId()
      const res = this.commit({
        events: () => [
          { type: 'comment.reply', by: 'TJ', thread, comment, body: req.body },
          ...(t.status === 'resolved' ? [{ type: 'thread.reopen', by: 'TJ', thread } as NewEvent] : []),
        ],
        key, ...c,
      }, emits)
      return { ok: true as const, message: this.reviewThread(thread).messages.find((m) => m.id === comment)!, seq: res.seq }
    })
  }

  private async editComment(comment: CommentId, req: EditCommentRequest, ctx?: TjCtx): Promise<MessageResponse> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    validateCommentBody(req.body)
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    const messageNow = (seq: number, dup: boolean): MessageResponse => {
      const { v } = this.state()
      for (const t of v.f.threads.values()) {
        if (t.messages.some((m) => m.id === comment)) {
          return { ok: true as const, message: this.reviewThread(t.id).messages.find((m) => m.id === comment)!, seq, ...(dup ? { duplicate: true as const } : {}) }
        }
      }
      throw err('COMMENT_NOT_FOUND', `comment ${comment} not found`)
    }
    return this.tjTx(key, (_v, lines) => messageNow(lines[0]!.seq, true), (emits, v) => {
      const m = this.messageOf(v.f, comment)
      if (m.by !== 'TJ') throw err('NOT_AUTHOR', 'TJ can edit only his own messages')
      const res = this.commit({ events: () => [{ type: 'comment.edit', by: 'TJ', comment, body: req.body }], key, ...c }, emits)
      return messageNow(res.seq, false)
    })
  }

  private async deleteComment(comment: CommentId, req: OpKeyRequest, ctx?: TjCtx): Promise<SeqResponse> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    return this.tjTx(key, (_v, lines) => ({ ok: true as const, seq: lines[0]!.seq, duplicate: true as const }), (emits, v) => {
      const m = this.messageOf(v.f, comment)
      if (m.by !== 'TJ') throw err('NOT_AUTHOR', 'TJ can delete only his own messages')
      const res = this.commit({ events: () => [{ type: 'comment.delete', by: 'TJ', comment }], key, ...c }, emits)
      return { ok: true as const, seq: res.seq }
    })
  }

  private async threadStatus(thread: ThreadId, status: 'open' | 'resolved', req: OpKeyRequest, ctx?: TjCtx): Promise<ThreadOpResponse> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    return this.tjTx<ThreadOpResponse>(key, (_v, lines) => ({ ok: true as const, thread: this.reviewThread(thread), seq: lines[0]!.seq, duplicate: true as const }), (emits, v) => {
      const t = this.threadOf(v.f, thread)
      const warnings: Warning[] = []
      const pending = this.pendingIn(v.f, t)
      if (status === 'resolved' && pending.length) {
        warnings.push({ code: 'RESOLVED_WITH_PENDING', message: `resolved with pending suggestions: ${pending.join(', ')}`, thread })
      }
      const seq = t.status === status
        ? this.trueSeq()
        : this.commit({ events: () => [{ type: status === 'resolved' ? 'thread.resolve' : 'thread.reopen', by: 'TJ', thread } as NewEvent], key, ...c }, emits).seq
      return { ok: true as const, thread: this.reviewThread(thread), seq, ...(warnings.length ? { warnings } : {}) }
    })
  }

  /** Text after splicing a suggestion's proposed at its located run (exact bytes, §6.6), or the refusal. */
  private applySuggestionText(s: SuggestionBody, L: Loaded): { text: string; L: Loaded } {
    if (!locate(L, s)) throw err('SUGGESTION_STALE', 'the suggestion base is no longer in the document')
    const r = applyToSource(this.md, L, s)
    if (!r.verified) throw err('BLOCK_MERGE_HAZARD', 'applying the suggestion would change a neighbouring block')
    return { text: r.text, L: this.loadCached(r.text, L) }
  }

  /** Undo of an accept: splice proposed → base if proposed is still intact at the located run (§6.6). */
  private unapplySuggestionText(s: SuggestionBody, L: Loaded): { text: string; L: Loaded } | null {
    const flipped: SuggestionBody = { ...s, base: s.proposed, proposed: s.base }
    if (s.proposed === '' || !locate(L, flipped)) return null
    const r = applyToSource(this.md, L, flipped)
    return r.verified ? { text: r.text, L: this.loadCached(r.text, L) } : null
  }

  private decisionFromLog(v: View, d: DocState, lines: SidecarEvent[], id: SuggestionId): DecisionResult {
    const ev = lines.find((e) => e.type === 'suggestion.accept' || e.type === 'suggestion.reject' || e.type === 'suggestion.reopen')
    const edit = lines.find((e) => e.type === 'doc.edit') as Extract<SidecarEvent, { type: 'doc.edit' }> | undefined
    const status = ev?.type === 'suggestion.accept' ? 'accepted' : ev?.type === 'suggestion.reject' ? 'rejected' : 'pending'
    const rev = ev?.rev ?? v.f.rev
    return {
      ok: true, suggestion: id, status, rev, hash: v.revHashes.get(rev) ?? d.hash, seq: Math.max(...lines.map((e) => e.seq)),
      changes: edit?.changes ?? [], duplicate: true,
    }
  }

  private async decide(id: SuggestionId, decision: 'accept' | 'reject', req: DecideRequest, ctx?: TjCtx): Promise<DecisionResult> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    if (decision !== 'accept' && decision !== 'reject') throw err('BAD_REQUEST', 'decision must be accept or reject')
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    return this.tjTx(key, (v, lines) => this.decisionFromLog(v, this.state().d, lines, id), (emits, v, d) => {
      const s = this.suggestionOf(v.f, id)
      const t = suggestionTransition(s, decision === 'accept' ? 'suggestion.accept' : 'suggestion.reject', 'TJ')
      if (t === 'duplicate') return { ok: true as const, suggestion: id, status: s.status, rev: v.f.rev, hash: d.hash, seq: this.trueSeq(), changes: [], duplicate: true as const }
      if (t !== 'ok') throw err(t, `cannot ${decision} ${id} (${s.status})`, { suggestion: id, thread: s.thread })
      let res: CommitResult
      if (decision === 'reject') {
        res = this.commit({ events: () => [{ type: 'suggestion.reject', by: 'TJ', suggestion: id }], key, ...c }, emits)
      } else {
        const ap = this.applySuggestionText(s, d.L)
        res = this.commit({
          events: (rev) => [{ type: 'suggestion.accept', by: 'TJ', suggestion: id, resultRev: rev }],
          key, text: ap.text, textL: ap.L, by: 'TJ', cause: 'accept', edit: { source: 'accept', cause: { type: 'suggestion.accept', id } },
          version: { cause: 'accept', by: 'TJ' }, ...c,
        }, emits)
      }
      return {
        ok: true as const, suggestion: id, status: decision === 'accept' ? 'accepted' as const : 'rejected' as const, rev: res.rev, hash: res.hash, seq: res.seq,
        changes: res.changes,
      }
    })
  }

  private async reopenSuggestion(id: SuggestionId, req: DecideRequest, ctx?: TjCtx): Promise<DecisionResult> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    return this.tjTx(key, (v, lines) => this.decisionFromLog(v, this.state().d, lines, id), (emits, v, d) => {
      const s = this.suggestionOf(v.f, id)
      const t = suggestionTransition(s, 'suggestion.reopen', 'TJ')
      if (t === 'duplicate') return { ok: true as const, suggestion: id, status: 'pending' as const, rev: v.f.rev, hash: d.hash, seq: this.trueSeq(), changes: [], duplicate: true as const }
      if (t !== 'ok') throw err('SUGGESTION_CHANGED_SINCE', `cannot reopen ${id} (${s.status})`, { suggestion: id, details: { ids: [id] } })
      let res: CommitResult
      if (s.status === 'rejected') {
        res = this.commit({ events: () => [{ type: 'suggestion.reopen', by: 'TJ', suggestion: id, resultRev: null }], key, ...c }, emits)
      } else {
        const un = this.unapplySuggestionText(s, d.L)
        if (un === null) throw err('SUGGESTION_CHANGED_SINCE', `the accepted text of ${id} changed since`, { suggestion: id, details: { ids: [id] } })
        res = this.commit({
          events: (rev) => [{ type: 'suggestion.reopen', by: 'TJ', suggestion: id, resultRev: rev }],
          key, text: un.text, textL: un.L, by: 'TJ', cause: 'undo-accept', edit: { source: 'undo-accept', cause: { type: 'suggestion.reopen', id } },
          version: { cause: 'accept', by: 'TJ' }, ...c,
        }, emits)
      }
      return { ok: true as const, suggestion: id, status: 'pending' as const, rev: res.rev, hash: res.hash, seq: res.seq, changes: res.changes }
    })
  }

  private async bulkDecide(req: BulkDecisionRequest, ctx?: TjCtx): Promise<BulkDecisionResult> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    if (req.decision !== 'accept' && req.decision !== 'reject' && req.decision !== 'reopen') throw err('BAD_REQUEST', 'decision must be accept, reject or reopen')
    if (!Array.isArray(req.authors) || req.authors.some((a) => a !== 'TJ' && a !== 'Claude')) throw err('BAD_REQUEST', 'authors must be a list of TJ / Claude')
    if (req.ids !== undefined && (!Array.isArray(req.ids) || req.ids.some((x) => typeof x !== 'string' || !isSuggestionId(x)))) throw err('BAD_REQUEST', 'ids must be suggestion ids')
    if (req.decision === 'reopen' && (!req.ids || req.ids.length === 0)) throw err('BAD_REQUEST', 'a bulk reopen needs the ids the bulk decided')
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    const markBulk = (r: BulkDecisionResult): BulkDecisionResult => ({ ...r, results: r.results.map((x) => (x.ok ? { ...x, duplicate: true as const } : x)) })
    return this.tjTx<BulkDecisionResult>(key, (v, lines) => {
      const ids = lines.filter((e) => e.type === 'suggestion.accept' || e.type === 'suggestion.reject' || e.type === 'suggestion.reopen')
        .map((e) => (e as { suggestion: SuggestionId }).suggestion)
      const rev = lines.find((e) => e.type === 'doc.rev')?.rev ?? lines[0]!.rev
      return { ok: true as const, rev, hash: v.revHashes.get(rev) ?? this.state().d.hash, seq: Math.max(...lines.map((e) => e.seq)), results: ids.map((id) => ({ id, ok: true, duplicate: true as const })) }
    }, (emits, v, d) => (req.decision === 'reopen' ? this.bulkReopen(req, key, c, emits, v, d) : this.bulkAcceptReject(req, key, c, emits, v, d)), { mark: markBulk })
  }

  private bulkAcceptReject(req: Extract<BulkDecisionRequest, { decision: 'accept' | 'reject' }>, key: string, c: { clientId?: ClientId }, emits: StoreChange[], v: View, d: DocState): BulkDecisionResult {
    const authorOk = (by: Author): boolean => req.authors.length === 0 || req.authors.includes(by)
    const ids = req.ids ?? [...v.f.suggestions.values()].filter((s) => s.status === 'pending' && authorOk(s.by)).map((s) => s.id)
    const results: BulkDecisionResult['results'] = []
    const events: NewEvent[] = []
    let text = d.text
    let L = d.L
    let anyAccept = false
    for (const id of ids) {
      const s = v.f.suggestions.get(id)
      if (!s) {
        results.push({ id, ok: false, code: 'SUGGESTION_NOT_FOUND' })
        continue
      }
      if (!authorOk(s.by)) {
        results.push({ id, ok: false, code: 'NOT_AUTHOR' })
        continue
      }
      const t = suggestionTransition(s, req.decision === 'accept' ? 'suggestion.accept' : 'suggestion.reject', 'TJ')
      if (t === 'duplicate') {
        results.push({ id, ok: true, duplicate: true })
        continue
      }
      if (t !== 'ok') {
        results.push({ id, ok: false, code: t })
        continue
      }
      if (req.decision === 'reject') {
        events.push({ type: 'suggestion.reject', by: 'TJ', suggestion: id })
        results.push({ id, ok: true })
        continue
      }
      try {
        // §6.6 Bulk (P2 merge): once an earlier id in this bulk changed the text, a record whose base is gone is
        // rebased (§6.7) against the intermediate text first; its suggestion.rebase rides the same batch, so the
        // fold holds the body that was applied (and the D26 bulk undo can find its proposed).
        let body: SuggestionBody = s
        let rebased: NewEvent | null = null
        if (anyAccept && !locate(L, s)) {
          const r = rebase(this.md, L, s)
          if (!('stale' in r)) {
            body = r
            const anchor = this.anchorForHunks(r.hunks, L, ptextOf(L.doc, L), -1) ?? s.anchor
            rebased = { type: 'suggestion.rebase', by: 'system', suggestion: id, anchor, range: r.range, base: r.base, proposed: r.proposed, hunks: r.hunks }
          }
        }
        const ap = this.applySuggestionText(body, L)
        text = ap.text
        L = ap.L
        anyAccept = true
        if (rebased) events.push(rebased)
        events.push({ type: 'suggestion.accept', by: 'TJ', suggestion: id, resultRev: -1 })
        results.push({ id, ok: true })
      } catch (e) {
        results.push({ id, ok: false, code: isStoreError(e) ? e.code : 'INTERNAL' })
      }
    }
    const res = this.commit({
      events: (rev) => events.map((e) => (e.type === 'suggestion.accept' ? { ...e, resultRev: rev }
        : e.type === 'suggestion.rebase' ? { ...e, anchor: e.anchor.hint.rev === -1 ? { ...e.anchor, hint: { ...e.anchor.hint, rev } } : e.anchor, range: { ...e.range, rev } }
          : e)),
      key,
      ...(anyAccept ? { text, textL: L, by: 'TJ' as const, cause: 'accept' as const, edit: { source: 'accept' as const }, version: { cause: 'accept' as const, by: 'TJ' as const } } : {}),
      ...c,
    }, emits)
    return { ok: true, rev: res.rev, hash: res.hash, seq: res.seq, results }
  }

  /** D26: the atomic bulk undo. One commit, or SUGGESTION_CHANGED_SINCE with details.ids and nothing written. */
  private bulkReopen(req: Extract<BulkDecisionRequest, { decision: 'reopen' }>, key: string, c: { clientId?: ClientId }, emits: StoreChange[], v: View, d: DocState): BulkDecisionResult {
    const failing: SuggestionId[] = []
    let text = d.text
    let L = d.L
    let anyAccept = false
    const events: NewEvent[] = []
    // undo in reverse decision order, so each accepted text is spliced back over the text the later ones left
    for (const id of [...req.ids].reverse()) {
      const s = v.f.suggestions.get(id)
      if (!s || suggestionTransition(s, 'suggestion.reopen', 'TJ') !== 'ok') {
        failing.push(id)
        continue
      }
      if (s.status === 'accepted') {
        const un = this.unapplySuggestionText(s, L)
        if (un === null) {
          failing.push(id)
          continue
        }
        text = un.text
        L = un.L
        anyAccept = true
        events.push({ type: 'suggestion.reopen', by: 'TJ', suggestion: id, resultRev: -1 })
      } else {
        events.push({ type: 'suggestion.reopen', by: 'TJ', suggestion: id, resultRev: null })
      }
    }
    if (failing.length) {
      throw err('SUGGESTION_CHANGED_SINCE', `${failing.length} suggestion(s) changed since the bulk decision; nothing was undone`, { details: { ids: failing.reverse() } })
    }
    events.reverse()
    const res = this.commit({
      events: (rev) => events.map((e) => (e.type === 'suggestion.reopen' && e.resultRev === -1 ? { ...e, resultRev: rev } : e)),
      key,
      ...(anyAccept ? { text, textL: L, by: 'TJ' as const, cause: 'undo-accept' as const, edit: { source: 'undo-accept' as const }, version: { cause: 'accept' as const, by: 'TJ' as const } } : {}),
      ...c,
    }, emits)
    return { ok: true, rev: res.rev, hash: res.hash, seq: res.seq, results: req.ids.map((id) => ({ id, ok: true })) }
  }

  private async readMarker(req: ReadMarkerRequest, ctx?: TjCtx): Promise<SeqResponse> {
    assertObject(req, 'the request')
    if (!Number.isInteger(req.upTo) || req.upTo < 0) throw err('BAD_REQUEST', 'upTo must be a non-negative integer')
    if (req.thread !== null && (typeof req.thread !== 'string' || !isThreadId(req.thread))) throw err('BAD_REQUEST', 'thread must be a thread id or null')
    const c = this.ctxOf(ctx)
    return this.transact((emits) => {
      const { d, s, v } = this.state()
      this.gone(d, s)
      this.assertTextual(d)
      const latest = this.trueSeq()
      if (req.upTo > latest) throw err('ACK_OUT_OF_RANGE', `upTo ${req.upTo} is past the latest seq ${latest}`)
      if (req.thread !== null) this.threadOf(v.f, req.thread)
      const cur = req.thread === null ? v.f.cursors.tjRead : (v.f.cursors.tjReadByThread[req.thread] ?? 0)
      if (req.upTo <= cur) return { ok: true as const, seq: latest }
      const res = this.commit({ events: () => [{ type: 'read-marker', by: 'TJ', thread: req.thread, upTo: req.upTo }], ...c }, emits)
      return { ok: true as const, seq: res.seq }
    })
  }

  private async restore(req: RestoreRequest, ctx?: TjCtx): Promise<RestoreResponse> {
    assertObject(req, 'the request')
    assertOpKey(req.opKey)
    if (typeof req.v !== 'string' || !/^v[1-9][0-9]*$/.test(req.v)) throw err('BAD_REQUEST', 'v must be a version id (vN)')
    if (!Number.isInteger(req.baseRev)) throw err('BAD_REQUEST', 'baseRev must be an integer')
    const c = this.ctxOf(ctx)
    const key = tjKey(req.opKey)
    const latestMeta = (): import('../shared/types').VersionMeta | undefined => {
      const vs = readIndex(this.abs).versions
      return [...vs].reverse().find((x) => x.restoredFrom === req.v) ?? vs[vs.length - 1]
    }
    return this.tjTx<RestoreResponse>(key, (v) => {
      const { d, s } = this.state()
      const meta = latestMeta()
      if (!meta) throw err('VERSION_NOT_FOUND', `version ${req.v} not found`)
      return { ok: true as const, rev: v.f.rev, hash: d.hash, seq: this.trueSeq(), version: meta, detached: [], staled: [], snapshot: this.snap(d, s, v) }
    }, (emits, v, d) => {
      if (req.baseRev !== v.f.rev) throw this.stale('STALE_REVISION', `restore was planned at rev ${req.baseRev}; the doc is at rev ${v.f.rev}`)
      const ver = readIndex(this.abs).versions.find((x) => x.v === req.v)
      if (!ver) throw err('VERSION_NOT_FOUND', `version ${req.v} not found`)
      const target = this.textOfHash(ver.hash)
      if (target === null) throw err('VERSION_NOT_FOUND', `version ${req.v}'s bytes are no longer retained`)
      // ops from current to the target, so unchanged blocks keep their bytes (§10)
      const N = this.loadCached(target, d.L)
      const ops: BlockOp[] = []
      for (const x of diffBlocks(d.L.blocks, N.blocks)) {
        if (x.op === 'equal') continue
        ops.push({
          after: x.a - 1, before: x.a + x.an, covers: d.L.blocks.slice(x.a, x.a + x.an).map((b) => b.hash),
          blocks: N.blocks.slice(x.b, x.b + x.bn).map((b) => target.slice(b.start, b.end)),
        })
      }
      let text = d.text
      if (ops.length) {
        const r = applyBlockOps(this.md, d.L, ops)
        if (r.failed.length) throw err('SPLICE_MISMATCH', `restoring ${req.v} failed splice verification`)
        text = r.text
      }
      const res = this.commit({
        events: () => [], key, text, by: 'TJ', cause: 'restore',
        edit: { source: 'restore', cause: { type: 'restore', id: req.v } },
        version: { cause: 'restore', by: 'TJ', restoredFrom: req.v }, ...c,
      }, emits)
      const after = this.state()
      const version = res.version ?? ver
      return {
        ok: true as const, rev: res.rev, hash: res.hash, seq: res.seq, version, detached: res.detached, staled: res.staled,
        snapshot: this.snap(after.d, after.s, after.v),
      }
    }, { mark: (r) => ({ ...r }) })
  }

  private async setPolicy(req: PolicyRequest, by: Author, ctx?: TjCtx): Promise<SeqResponse> {
    assertObject(req, 'the request')
    if (typeof req.suggestOnly !== 'boolean') throw err('BAD_REQUEST', 'suggestOnly must be a boolean')
    const c = by === 'TJ' ? this.ctxOf(ctx) : {}
    return this.transact((emits) => {
      const { d, s, v } = this.state()
      this.gone(d, s)
      this.assertTextual(d)
      if (v.f.policy.suggestOnly === req.suggestOnly) return { ok: true as const, seq: this.trueSeq() }
      const res = this.commit({ events: () => [{ type: 'policy.set', by, suggestOnly: req.suggestOnly }], ...c }, emits)
      return { ok: true as const, seq: res.seq }
    })
  }

  // ----------------------------------------------------------------------------------- agent.batch (§9.5)

  private remapFor(refs: readonly BlockRef[], rev: number): Partial<Record<BlockRef, BlockRef>> {
    const out: Partial<Record<BlockRef, BlockRef>> = {}
    const { d, v } = this.state()
    // rev 0 is the doc before its sidecar existed: the baseline (rev 1) records exactly the bytes this process saw then
    const h = v.revHashes.get(rev) ?? (rev === 0 ? v.revHashes.get(1) : undefined)
    const old = h === undefined ? null : this.textOfHash(h)
    if (old === null) return out
    const oldBlocks = this.loadCached(old, d.L).blocks
    for (const ref of refs) {
      const i = indexOfRef(ref)
      const ob = i === null ? undefined : oldBlocks[i]
      if (!ob) continue
      const hits = d.L.blocks.filter((b) => b.hash === ob.hash)
      if (hits.length === 1) out[ref] = hits[0]!.ref
    }
    return out
  }

  private async batch(req: BatchRequest): Promise<BatchResult> {
    assertObject(req, 'the batch request')
    if (!Array.isArray(req.ops)) throw err('BAD_REQUEST', 'ops must be an array')
    req.ops.forEach((op, i) => {
      if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string') throw err('BAD_REQUEST', `op ${i} is not an op`, { op: i })
      if ('by' in (op as object)) throw err('IDENTITY_IN_BODY', `op ${i} carries \`by\`; identity comes from the route`, { op: i })
    })
    return this.transact((emits) => {
      let { d, s, v } = this.state()
      this.gone(d, s)
      this.assertTextual(d)
      if (!req.dryRun) {
        this.flushSessionNow('foreign-write', emits)
        ;({ d, s, v } = this.state())
      }
      const ctx: BatchContext = {
        md: this.md, file: this.file, L: d.L, P: d.P, rev: v.f.rev, nextRev: Math.max(v.maxRev, s.exists ? 0 : 1) + 1, seq: this.trueSeq(),
        f: v.f, events: v.events,
        remap: (refs, rev) => this.remapFor(refs, rev),
        stale: (message, extra) => this.stale('STALE_REVISION', message, extra),
        anchorView: (a, t) => this.anchorView(d, a, t, v.f),
      }
      const plan = planBatch(ctx, req)
      if (req.dryRun) {
        return {
          ok: true as const, via: this.via(), file: this.file, rev: v.f.rev, hash: d.hash, seq: this.trueSeq(), noop: true, dryRun: true as const,
          results: plan.results, acked: plan.acked, consumed: plan.consumed, warnings: plan.warnings,
        }
      }
      const writes = plan.text !== null
      const res = this.commit({
        events: (rev) => plan.events.map((e) => (e.type === 'suggestion.accept' ? { ...e, resultRev: rev } : e)),
        revKey: plan.revKey,
        ...(writes ? {
          text: plan.text!, ...(plan.textL ? { textL: plan.textL } : {}), by: 'Claude' as const, cause: plan.onlyAccepts ? 'accept' as const : 'cli' as const,
          edit: { source: plan.onlyAccepts ? 'accept' as const : 'cli' as const },
          version: { cause: plan.onlyAccepts ? 'accept' as const : 'claude-write' as const, by: 'Claude' as const },
        } : {}),
      }, emits)
      for (const r of plan.remember) this.remember(r.key, { ...r.result })
      return {
        ok: true as const, via: this.via(), file: this.file, rev: res.rev, hash: res.hash, seq: res.seq, noop: res.events.length === 0,
        results: plan.results, acked: plan.acked, consumed: plan.consumed, warnings: [...plan.warnings, ...res.warnings],
      }
    })
  }
}

// ===================================================================================== open

/**
 * Opens the store for `file` (POSIX, relative to `root`). Runs the §8.1 step-7 checks itself, so CLI direct mode gets
 * the same refusals as the routes: .md/.markdown, inside the root, not protected, and existing (a missing file whose
 * sidecar exists still opens, and its reads say DOC_GONE). A writable server-mode store reconciles at open (§3.6).
 */
export const openDocStore: OpenDocStore = async (root, file, opts) => {
  if (!/\.(md|markdown)$/i.test(file)) throw new StoreError('BAD_REQUEST', `only .md and .markdown files are served (${file})`)
  const lexical = join(root, file)
  assertServable(root, lexical)
  let abs = lexical.normalize('NFC')
  if (existsSync(lexical)) {
    abs = realId(lexical)
    assertServable(root, abs)
  } else if (!existsSync(lexical + '.review.jsonl')) {
    throw new StoreError('FILE_NOT_FOUND', `${file} does not exist`)
  }
  const rel = toPosix(relative(root, abs)).normalize('NFC')
  const store = new NodeDocStore(root, rel, abs, { mode: opts.mode, readOnly: opts.readOnly === true, lockTimeoutMs: opts.lockTimeoutMs }, await sharedMd())
  if (opts.mode === 'server' && opts.readOnly !== true) await store.initialize()
  return store
}

/** History retention and objects GC for an open store (server start, hourly, `mdr doctor --gc`). */
export async function maintainDoc(store: DocStore, o: { now?: Date } = {}): Promise<{ removedVersions: number; removedObjects: number }> {
  if (store instanceof NodeDocStore) return store.maintenance(o)
  return { removedVersions: 0, removedObjects: 0 }
}

/**
 * The watcher's hook (§3.6): when the doc or its sidecar changed on disk since this process's last transaction, adopt
 * lines another process appended and reconcile, emitting every change to the store's listeners. A no-op otherwise.
 */
export async function reconcileDoc(store: DocStore): Promise<void> {
  if (store instanceof NodeDocStore) await store.watchTick()
}

/** The decoded text of a rev by doc hash (the current doc, else its object); null when gone or not a node store. */
export function storeTextAt(store: DocStore, hash: Hash): string | null {
  return store instanceof NodeDocStore ? store.textAt(hash) : null
}

/** Where a store's log stands now, synchronously (SSE ids and reset detection); null when not a node store. */
export function storeCursor(store: DocStore): { rev: number; seq: number; docId: DocId | null } | null {
  if (!(store instanceof NodeDocStore)) return null
  try {
    return store.cursor()
  } catch {
    return null
  }
}
