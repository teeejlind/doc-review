// web/src/session/autosave.ts (P2). The autosave planner, its trigger scheduler and the retry backoff (CONTRACTS §12.4).
//
// The plan is computed at send time, never queued as diffs:
//   1. reopen candidates first (§6.6, D26): they become `reopen` queue items, each answered before step 2;
//   2. base = baseDoc(live); assertNoSuggestionMarks(base);
//   3. ops = planSave(md, L, base) minus ops covering held conflicts and held unsaveable ops (§7.4);
//   4. suggestions = { upsert, withdraw } from tjSuggestionDiff (upserts of known ids throttled until their marks have
//      been still for SUGGESTION_UPSERT_STABLE_MS, unless this is a flush-reason save; none at all in a save that
//      writes direct edits, they follow in the next save), anchors from the editor (§5.4);
//   5. r = applyBlockOps(md, L, ops); expectHash = docHash(r.text, snapshot.bom), the doc-hash domain WITH the BOM (D40);
//      ops in r.failed stay in the request (the server reports them back as `unsaveable`);
//   6. everything empty -> nothing to send; otherwise one SaveRequest.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { docHash } from '../../../core/hash'
import type { Md } from '../../../core/md/index'
import { applyBlockOps } from '../../../core/splice/apply'
import { contentNodes } from '../../../core/splice/eq'
import type { Loaded } from '../../../core/splice/load'
import { planSave } from '../../../core/splice/plan'
import { assertNoSuggestionMarks } from '../../../core/splice/render'
import { CONSTANTS } from '../../../shared/types'
import type {
  AnchorUpdate, ApplyBlockOpsResult, BlockHash, BlockOp, ClientId, Hash, ReviewState, SaveRequest, SuggestionId,
  TjSuggestionUpsert,
} from '../../../shared/types'
import type { ReopenGroup, SuggestionPlan } from './internals'

// ------------------------------------------------------------------ backoff

/** §12.4: 1, 2, 4, 8, 15, 30 s, capped. */
export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1)]!
}

// ------------------------------------------------------------------ flush reasons

export type FlushReason =
  | 'debounce' | 'max-wait' | 'blur' | 'hidden' | 'unload' | 'queued-op' | 'explicit' | 'retry' | 'stable' | 'draft' | 'release'

/** §6.4 throttle: these saves send every pending upsert regardless of how recently its marks changed. */
export const FLUSH_REASONS: ReadonlySet<FlushReason> = new Set<FlushReason>(['blur', 'hidden', 'unload', 'queued-op', 'explicit', 'release'])

// ------------------------------------------------------------------ holds

/** The key an op is held by when it covers nothing (a pure insertion): the hash of the block before it, or 'bof'. */
export function insertionKey(L: Pick<Loaded, 'blocks'>, op: BlockOp): string {
  return L.blocks[op.after]?.hash ?? 'bof'
}

/** The id the server gives an unsaveable op (§7.4): 'unsaveable:' + covers[0], or the insertion key. */
export function unsaveableIdOf(L: Pick<Loaded, 'blocks'>, op: BlockOp): `unsaveable:${string}` {
  return `unsaveable:${op.covers[0] ?? insertionKey(L, op)}`
}

export interface Holds {
  /** Base block hashes whose ops are withheld. */
  hashes: ReadonlySet<BlockHash>
  /** Insertion keys (see insertionKey) of held pure-insertion ops. */
  insertions: ReadonlySet<string>
}

/** The base source of block `index` (no surrounding gaps). */
export function blockSource(L: Pick<Loaded, 'src' | 'blocks'>, index: number): string {
  const b = L.blocks[index]
  return b ? L.src.slice(b.start, b.end) : ''
}

export function isHeld(L: Pick<Loaded, 'blocks'>, op: BlockOp, h: Holds): boolean {
  if (op.covers.some((x) => h.hashes.has(x))) return true
  return op.covers.length === 0 && h.insertions.has(insertionKey(L, op))
}

// ------------------------------------------------------------------ planner

export interface PlanInput {
  md: Md
  L: Loaded
  /** The rev/hash `L` was loaded at (the save's base). */
  base: { rev: number; hash: Hash }
  /** snapshot.bom: the doc-hash domain includes it (D40). */
  bom: boolean
  baseDoc: PMNode
  review: ReviewState
  holds: Holds
  suggestions: SuggestionPlan
  anchors: AnchorUpdate[]
  stableSince: (id: SuggestionId) => number | undefined
  now: number
  /** A flush-reason save sends throttled upserts too (§6.4). */
  flushReason: boolean
  cause: SaveRequest['cause']
  allowPartial: boolean
  clientId: ClientId
  saveId: number
}

export type SavePlan =
  | { kind: 'reopen'; groups: ReopenGroup[] }
  | { kind: 'empty'; deferredUntil: number | null; withheld: number }
  | {
    kind: 'save'
    req: SaveRequest
    ops: BlockOp[]
    apply: ApplyBlockOpsResult
    /** contentNodes(baseDoc): updateLoaded reuses them for written blocks (§3.4). */
    liveNodes: PMNode[]
    /** Session-clock ms when a throttled upsert becomes sendable; null when none was deferred. */
    deferredUntil: number | null
    /** Ops withheld by holds. */
    withheld: number
    upserted: SuggestionId[]
    withdrawn: SuggestionId[]
  }

const NO_OPS: ApplyBlockOpsResult = { text: '', verified: true, widened: [], failed: [], flips: [] }

export function planSaveRequest(i: PlanInput): SavePlan {
  // 1. reopen first, as queue items (never save fields, D26)
  if (i.suggestions.reopen.length > 0) return { kind: 'reopen', groups: i.suggestions.reopen.map((g) => ({ ...g, ids: [...g.ids] })) }

  // 2. the save always plans against baseDoc(live); residue throws SuggestionResidueError (never sent, §13 #60)
  assertNoSuggestionMarks(i.baseDoc)

  // 3. ops minus held ones
  const planned = planSave(i.md, i.L, i.baseDoc)
  const ops: BlockOp[] = []
  let withheld = 0
  for (const op of planned) {
    if (!isHeld(i.L, op, i.holds)) {
      ops.push(op)
      continue
    }
    withheld++
    // planSave joins adjacent changed blocks into one run. For an in-place run, keep TJ's free blocks saving
    // (§7.4: "the rest of the document keeps saving") by splitting the run into one op per maximal stretch of free
    // blocks, so no op sent ever covers a held hash (§12.4 step 3) and disk keeps theirs there. Neighbouring sub-ops
    // share the held block as their boundary, which §3.4 allows (ops[k].before <= ops[k+1].after). A stretch whose
    // blocks are unchanged is dropped. Structural runs are withheld whole.
    if (op.covers.length > 0 && op.covers.length === op.blocks.length) {
      for (let k = 0; k < op.covers.length; ) {
        if (i.holds.hashes.has(op.covers[k]!)) {
          k++
          continue
        }
        let e = k
        while (e + 1 < op.covers.length && !i.holds.hashes.has(op.covers[e + 1]!)) e++
        const blocks = op.blocks.slice(k, e + 1)
        if (blocks.some((b, j) => b !== blockSource(i.L, op.after + 1 + k + j))) {
          ops.push({ after: op.after + k, before: op.after + e + 2, covers: op.covers.slice(k, e + 1), blocks })
        }
        k = e + 1
      }
    }
  }

  // 4. suggestion upserts (throttled) and withdrawals. A save that writes direct edits sends no upserts: the editor
  // extracts a suggestion against the saved base, so an unsaved direct edit anywhere in the doc would ride along as a
  // hunk of the suggestion (QA3: an Editing-mode edit after a reload was absorbed into TJ's pending suggestion, and
  // Accept wrote it twice). The upserts go in a follow-up save, extracted against the base that holds the edits.
  const known = new Set(i.review.suggestions.map((s) => s.id))
  const upsert: TjSuggestionUpsert[] = []
  let deferredUntil: number | null = null
  for (const u of i.suggestions.upsert) {
    if (ops.length > 0) {
      deferredUntil = deferredUntil === null ? i.now : Math.min(deferredUntil, i.now)
      continue
    }
    const since = i.stableSince(u.id)
    if (!known.has(u.id) || i.flushReason || since === undefined || i.now - since >= CONSTANTS.SUGGESTION_UPSERT_STABLE_MS) {
      upsert.push(u)
    } else {
      const at = since + CONSTANTS.SUGGESTION_UPSERT_STABLE_MS
      deferredUntil = deferredUntil === null ? at : Math.min(deferredUntil, at)
    }
  }
  const withdraw = [...i.suggestions.withdraw]

  // 5. the same assembly the server runs; expectHash in the doc-hash domain (BOM included)
  const apply = ops.length > 0 ? applyBlockOps(i.md, i.L, ops) : { ...NO_OPS, text: i.L.src }

  // 6. nothing to send?
  const nothing = ops.length === 0 && upsert.length === 0 && withdraw.length === 0 && i.anchors.length === 0
  if (nothing && i.cause !== 'recreate') return { kind: 'empty', deferredUntil, withheld }

  const req: SaveRequest = {
    clientId: i.clientId,
    saveId: i.saveId,
    base: { rev: i.base.rev, hash: i.base.hash, blockHashes: i.L.blocks.map((b) => b.hash) },
    ops,
    cause: i.cause,
    allowPartial: i.allowPartial,
  }
  if (ops.length > 0) req.expectHash = docHash(apply.text, i.bom)
  if (i.anchors.length > 0) req.anchors = i.anchors
  if (upsert.length > 0 || withdraw.length > 0) {
    req.suggestions = {}
    if (upsert.length > 0) req.suggestions.upsert = upsert
    if (withdraw.length > 0) req.suggestions.withdraw = withdraw
  }
  return {
    kind: 'save',
    req,
    ops,
    apply,
    liveNodes: contentNodes(i.baseDoc),
    deferredUntil,
    withheld,
    upserted: upsert.map((u) => u.id),
    withdrawn: withdraw,
  }
}

// ------------------------------------------------------------------ trigger scheduler

export interface AutosaveSchedulerOptions {
  isComposing: () => boolean
  fire: (reason: FlushReason) => void
  debounceMs?: number
  maxWaitMs?: number
}

/**
 * §12.4 triggers: AUTOSAVE_DEBOUNCE_MS after the last change; AUTOSAVE_MAX_WAIT_MS max wait while typing; blur,
 * visibilitychange: hidden, beforeunload / pagehide (the session calls `now`). Never while composing (IME): a pending
 * flush runs at compositionend (§13 #63).
 */
export class AutosaveScheduler {
  private debounce: ReturnType<typeof setTimeout> | null = null
  private maxWait: ReturnType<typeof setTimeout> | null = null
  private deferred: FlushReason | null = null
  private stopped = false

  constructor(private readonly o: AutosaveSchedulerOptions) {}

  /** A dirty transaction happened. */
  changed(): void {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.trigger('debounce'), this.o.debounceMs ?? CONSTANTS.AUTOSAVE_DEBOUNCE_MS)
    this.maxWait ??= setTimeout(() => this.trigger('max-wait'), this.o.maxWaitMs ?? CONSTANTS.AUTOSAVE_MAX_WAIT_MS)
  }

  /** Flush now (blur, hidden, explicit), still deferred while composing. */
  now(reason: FlushReason): void {
    if (this.stopped) return
    this.trigger(reason)
  }

  /** Schedule a save at an absolute session-clock time (a throttled upsert becoming sendable). */
  at(when: number, now: number): void {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.trigger('stable'), Math.max(0, when - now))
  }

  compositionEnd(): void {
    if (this.stopped || this.deferred === null) return
    if (this.o.isComposing()) return
    const r = this.deferred
    this.deferred = null
    this.o.fire(r)
  }

  /** A timer or explicit trigger is outstanding (unsaved work is scheduled). */
  get pending(): boolean {
    return this.debounce !== null || this.maxWait !== null || this.deferred !== null
  }

  cancel(): void {
    this.clear()
    this.deferred = null
  }

  stop(): void {
    this.cancel()
    this.stopped = true
  }

  private clear(): void {
    if (this.debounce) clearTimeout(this.debounce)
    if (this.maxWait) clearTimeout(this.maxWait)
    this.debounce = null
    this.maxWait = null
  }

  private trigger(reason: FlushReason): void {
    this.clear()
    if (this.o.isComposing()) {
      // keep the strongest reason: a flush reason beats a timer
      if (this.deferred === null || (FLUSH_REASONS.has(reason) && !FLUSH_REASONS.has(this.deferred))) this.deferred = reason
      return
    }
    this.deferred = null
    this.o.fire(reason)
  }
}
