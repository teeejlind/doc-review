// tests/fakes/FakeDocStore.ts (integrator, day 0; CONTRACTS §2.2 "Doc operations", §3.5–§3.9, §4, §6.6, §7, §9.5, D46).
//
// A whole-text, single-process DocStore that stands in for P1's node/docstore.ts until M1/M2. It runs the same core
// code the real store will: load() for the block map, applyBlockOps for browser ops (so the client's expectHash
// agrees and the splice-fault hook applies), merge3way for stale-base saves, the sidecar fold / toReviewState /
// handoffRecords for review state and handoffs() (D46), cliKey/tjKey/saveKey for idempotency, the record functions
// for suggestions and buildPending for `pending`. What it does NOT do: locking, a WAL with crash recovery, objects
// GC, history retention, or a watcher. Revisions, seqs, ids, keys, the suggestion state machine, the TJ session
// (coalesced doc.edit, D6), suggest-only (D39), positional strictness (D3) and batch semantics (§9.5, D27) follow
// the contract.
//
// Persistence: with `persist` (the default when the doc was read from disk) every committed write goes through to
// `<root>/<file>` (tmp + rename) and its sidecar `<file>.review.jsonl` in the real §4.1 format, so e2e specs can
// assert disk bytes and the sidecar, and an existing sidecar is read back with parseSidecar on open (a corrupt or
// future-schema sidecar makes the store read-only, §4.6, §8.3). `checkDisk()` detects an external edit or a deletion
// (doc.external / doc.missing, §3.6) and is called at the start of every operation; fakeApp polls it while SSE
// clients are connected.
import '../helpers/setup-node-dom'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ulid } from 'ulid'
import type {
  Actor, AgentOp, AgentSnapshot, AgentSnapshotQuery, Anchor, AnchorView, Author, BatchOpResult, BatchRequest,
  BatchResult, BlockChange, BlockConflict, BlockHash, BlockOp, BlockRef, BlockSel, BuildPending, BulkDecisionRequest,
  BulkDecisionResult, ClientId, CommentId, CreateThreadRequest, CreateThreadResponse, DecideRequest, DecisionResult,
  DocId, DocSnapshot, DocStore, DiffBlock, EditCommentRequest, EditSource, ErrorCode, FlushReason, Hash,
  HandoffEventInput, HandoffRecord, HistoryDiff, HistoryList, HistoryRef, Hunk, MessageResponse, NewEvent,
  OpenDocStore, OpKeyRequest, PendingResult, PolicyRequest, ReadMarkerRequest, ReadOnlyCode, ReplyRequest, Resolution,
  RestoreRequest, RestoreResponse, RevCause, SaveRequest, SaveResponse, SeqResponse, SidecarEvent, SidecarHeader,
  StatusResult, StoreChange, StoreReviewState, Suggestion, SuggestionBody, SuggestionId, TextAnchor, ThreadDetail,
  ThreadId, ThreadOpResponse, TjCtx, TjSuggestionUpsert, Unsubscribe, VersionCause, VersionId, VersionMeta,
  VersionShow, Warning, WaiterId,
} from '../../shared/types'
import { CONSTANTS, SIDECAR_SCHEMA } from '../../shared/constants'
import { StoreError, isStoreError } from '../../shared/errors'
import { indexOfRef, isSuggestionId, refOf } from '../../shared/ids'
import { CREATED_BY } from '../../shared/version'
import { createMd, type Md } from '../../core/md/index'
import { load, type Loaded } from '../../core/splice/load'
import { applyBlockOps } from '../../core/splice/apply'
import { diffBlocks, isAtomBlock } from '../../core/blocks'
import { docHash, sha256Hex } from '../../core/hash'
import { ptextOf, type PText } from '../../core/ptext'
import { createAnchor, createBlockAnchor, resolveAnchor } from '../../core/anchors'
import { findQuoteInPtext, findQuoteInSource } from '../../core/quote'
import { convertEol } from '../../core/eol'
import { blockChanges, wordDiff } from '../../core/diff'
import { merge3way } from '../../core/merge'
import { fold, handoffRecords, isAutoResolved, toReviewState, type FoldState, type SuggestionFold, type ThreadFold } from '../../core/sidecar/fold'
import { parseSidecar } from '../../core/sidecar/parse'
import { cliKey, saveKey, tjKey } from '../../core/sidecar/keys'
import { suggestionTransition, validateAnchor, validateCommentBody } from '../../core/sidecar/validate'
import { applyToSource, fromBlock, fromQuote, hunksOf, locate, rebase as rebaseRecord } from '../../core/suggest/record'
import { buildPending as defaultBuildPending } from '../../core/pending/digest'

// ===================================================================================== shared headless Md

let mdPromise: Promise<Md> | null = null
/** One headless Md per process (jsdom installed by the setup-node-dom import above). */
export function sharedMd(): Promise<Md> {
  mdPromise ??= createMd()
  return mdPromise
}

// ===================================================================================== small helpers

const nowIso = (): string => new Date().toISOString()
const newThreadId = (): ThreadId => `t_${ulid()}`
const newCommentId = (): CommentId => `c_${ulid()}`
const newSuggestionId = (): SuggestionId => `s_${ulid()}`
const newDocId = (): DocId => `d_${ulid()}`
const TJ_EDITOR_CAUSES: ReadonlySet<RevCause> = new Set(['save', 'merge', 'recreate'])
const PENDING_IGNORED_TYPES = new Set(['doc.rev', 'doc.abort', 'server.recovered', 'log.repair', 'ack', 'read-marker', 'handoff.consumed'])

function err(code: ErrorCode, message: string, extra: Omit<import('../../shared/types').ApiErrorBody, 'code' | 'message'> = {}): StoreError {
  return new StoreError(code, message, extra)
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

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let k = 0
  while (k < max && a[k] === b[k]) k++
  return k
}
function commonSuffixLen(a: string, b: string, floor: number): number {
  let k = 0
  while (k < a.length - floor && k < b.length - floor && a[a.length - 1 - k] === b[b.length - 1 - k]) k++
  return k
}

/** Source span changed by a suggestion, relative to its run start: [p, base.length - s). */
function changedSpan(s: Pick<SuggestionBody, 'base' | 'proposed'>): [number, number] {
  const p = commonPrefixLen(s.base, s.proposed)
  const sfx = commonSuffixLen(s.base, s.proposed, p)
  return [p, s.base.length - sfx]
}
function spansOverlap(a: [number, number], b: [number, number]): boolean {
  const aEmpty = a[0] >= a[1]
  const bEmpty = b[0] >= b[1]
  if (aEmpty && bEmpty) return a[0] === b[0]
  if (aEmpty) return a[0] >= b[0] && a[0] <= b[1]
  if (bEmpty) return b[0] >= a[0] && b[0] <= a[1]
  return a[0] < b[1] && b[0] < a[1]
}

function isByteOp(op: AgentOp): boolean {
  return op.op === 'replace_block' || op.op === 'replace_range' || op.op === 'insert_after' || op.op === 'insert_before'
    || op.op === 'delete_block' || op.op === 'write' || (op.op === 'decide' && op.decision === 'accept')
}

function positionalSels(op: AgentOp): Array<{ ref?: BlockRef; line?: number; rev: number }> {
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

// ===================================================================================== batch working document

/**
 * The in-memory text of one batch (§9.5): BlockOps against the BASE map, so positional selectors keep naming base
 * blocks (D27). Groups replace or delete a base run; insertions hang off boundaries; `write` replaces everything.
 */
class BatchDoc {
  readonly n: number
  readonly groups: Array<{ start: number; end: number; blocks: string[] }> = []
  readonly groupOf = new Map<number, number>()
  readonly suggested = new Set<number>()
  readonly deletedSet = new Set<number>()
  readonly inserts = new Map<number, string[]>()
  writeOps: BlockOp[] | null = null
  private cache: { text: string; L: Loaded; P: PText; toBase: Array<number | null>; toWorking: Array<number | null>; failed: number[]; hazard: boolean } | null = null

  constructor(private readonly md: Md, readonly base: Loaded) {
    this.n = base.blocks.length
  }

  touched(i: number): boolean {
    return this.groupOf.has(i) || this.suggested.has(i)
  }
  get hasByteOps(): boolean {
    return this.writeOps !== null || this.groups.length > 0 || this.inserts.size > 0
  }
  replace(start: number, end: number, blocks: string[]): void {
    const gi = this.groups.length
    this.groups.push({ start, end, blocks })
    for (let k = start; k < end; k++) {
      this.groupOf.set(k, gi)
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

  working(): { text: string; L: Loaded; P: PText; toBase: Array<number | null>; toWorking: Array<number | null>; failed: number[]; hazard: boolean } {
    if (this.cache) return this.cache
    if (!this.hasByteOps) {
      const P = ptextOf(this.base.doc, this.base)
      const ident = this.base.blocks.map((_, k) => k)
      this.cache = { text: this.base.src, L: this.base, P, toBase: ident, toWorking: [...ident], failed: [], hazard: false }
      return this.cache
    }
    const r = applyBlockOps(this.md, this.base, this.ops())
    const L = load(this.md, r.text)
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

// ===================================================================================== the store

export interface FakeDocStoreOptions {
  /** Served root (realpath + NFC). */
  root: string
  /** POSIX path relative to root. */
  file: string
  mode?: 'server' | 'direct'
  /** Initial markdown (BOM-stripped). Omitted → read `<root>/<file>` from disk. */
  markdown?: string
  bom?: boolean
  /** Write .md bytes and the sidecar through to disk. Default: true iff the doc was read from disk. */
  persist?: boolean
  /** OpenDocStoreOptions.readOnly: never writes (writes throw READ_ONLY). */
  readOnly?: boolean
  md?: Md
  /** TJ session idle flush (§7.1). Default EDIT_SESSION_IDLE_MS; 0 disables the timer. */
  idleFlushMs?: number
  buildPending?: BuildPending
}

interface FakeVersion extends VersionMeta { text: string }

interface CommitSpec {
  /** Op events; given the rev in effect after the commit (resultRev, anchors). */
  events: (rev: number) => NewEvent[]
  /** Idempotency key put on every line that has none (§4.7). */
  key?: string
  /** New text; a change of bytes appends doc.rev (+ doc.edit unless a TJ editor save). */
  text?: string
  /** Write even when the bytes are unchanged (a recreate of a deleted file, §3.6). */
  force?: boolean
  by?: Actor
  cause?: RevCause
  edit?: { source: EditSource; cause?: { type: 'suggestion.accept' | 'suggestion.reopen' | 'restore'; id: string } }
  clientId?: ClientId
  saveId?: number
  /** History version to record after a byte write (§10). */
  version?: { cause: VersionCause; by: Actor; restoredFrom?: VersionId }
}
interface CommitResult {
  seq: number
  rev: number
  hash: Hash
  events: SidecarEvent[]
  changes: BlockChange[]
  bytesChanged: boolean
  staled: SuggestionId[]
  rebased: SuggestionId[]
  detached: ThreadId[]
  warnings: Warning[]
}

export class FakeDocStore implements DocStore {
  readonly root: string
  readonly file: string
  readonly abs: string
  readonly mode: 'server' | 'direct'
  readonly md: Md

  private text = ''
  private bom = false
  private L!: Loaded
  private P!: PText
  private rawHash: Hash | null = null
  private size = 0
  private mtimeMs = Date.now()
  private missing: { lastHash: Hash } | null = null
  private readOnlyState: false | { code: ReadOnlyCode; message: string } = false
  private readonly forbidWrites: boolean
  private readonly persist: boolean
  private header: SidecarHeader | null = null
  private events: SidecarEvent[] = []
  private f!: FoldState
  private seqCounter = 0
  private curRev = 0
  private curHash!: Hash
  private maxRev = 0
  private readonly revHashes = new Map<number, Hash>()
  private readonly objects = new Map<Hash, string>()
  private readonly versions: FakeVersion[] = []
  private session: { baseRev: number; baseHash: Hash; lastRev: number; lastHash: Hash } | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly idleFlushMs: number
  private readonly results = new Map<string, unknown>()
  private readonly listeners = new Set<(c: StoreChange) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly extraWarnings: Warning[] = []
  private readonly pendingFn: BuildPending
  private closed = false
  private diskMtime = 0
  private diskSize = -1

  private constructor(o: FakeDocStoreOptions, md: Md) {
    this.root = o.root
    this.file = o.file
    this.abs = join(o.root, ...o.file.split('/'))
    this.mode = o.mode ?? 'server'
    this.md = md
    this.forbidWrites = o.readOnly === true
    this.persist = o.persist ?? o.markdown === undefined
    this.idleFlushMs = o.idleFlushMs ?? CONSTANTS.EDIT_SESSION_IDLE_MS
    this.pendingFn = o.buildPending ?? defaultBuildPending
  }

  /** Open a store. Reads the doc (and its sidecar) from disk unless `markdown` is given. */
  static async create(o: FakeDocStoreOptions): Promise<FakeDocStore> {
    const s = new FakeDocStore(o, o.md ?? (await sharedMd()))
    if (o.markdown !== undefined) s.adoptText(o.markdown, o.bom ?? false)
    else s.readFromDisk(true)
    s.refold()
    return s
  }

  // ----------------------------------------------------------------------------------- test helpers (not DocStore)

  /** The sidecar lines (header excluded), in seq order. */
  allEvents(): readonly SidecarEvent[] {
    return this.events
  }
  sidecarHeader(): SidecarHeader | null {
    return this.header
  }
  currentText(): string {
    return this.text
  }
  currentLoaded(): Loaded {
    return this.L
  }
  foldState(): FoldState {
    return this.f
  }
  listenerCount(): number {
    return this.listeners.size
  }
  /** Simulate a write by another process (in-memory mode) or write the file and reconcile (persist mode). */
  async simulateExternalWrite(markdown: string): Promise<void> {
    if (this.persist) {
      writeFileSync(this.abs, Buffer.from((this.bom ? '﻿' : '') + markdown, 'utf8'))
      await this.checkDisk()
      return
    }
    await this.serial(async () => this.recordExternal(markdown))
  }
  /** Simulate the file being deleted (§3.6 doc.missing). */
  async simulateRemoval(): Promise<void> {
    await this.serial(async () => this.recordMissing())
  }
  /** Force a read-only state (banners, §8.3) without touching disk. */
  setReadOnlyForTests(state: false | { code: ReadOnlyCode; message: string }): void {
    this.readOnlyState = state
  }

  // ----------------------------------------------------------------------------------- disk + state

  private adoptText(text: string, bom: boolean): void {
    if (text.startsWith('﻿')) {
      text = text.slice(1)
      bom = true
    }
    this.text = text
    this.bom = bom
    this.L = load(this.md, text)
    this.P = ptextOf(this.L.doc, this.L)
    this.curHash = docHash(text, bom)
    this.rawHash = this.curHash
    this.size = Buffer.byteLength(text, 'utf8') + (bom ? 3 : 0)
    this.mtimeMs = Date.now()
    this.objects.set(this.curHash, text)
  }

  private sidecarPath(): string {
    return this.abs + '.review.jsonl'
  }

  /** Read the doc (and, on first open, the sidecar). Sets read-only states per §3.1 / §4.6. */
  private readFromDisk(first: boolean): void {
    if (!existsSync(this.abs)) throw err('FILE_NOT_FOUND', `${this.file} does not exist`)
    const raw = readFileSync(this.abs)
    const st = statSync(this.abs)
    this.diskMtime = st.mtimeMs
    this.diskSize = st.size
    const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    let text: string | null = null
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(bom ? 3 : 0))
      if (!Buffer.from(text, 'utf8').equals(raw.subarray(bom ? 3 : 0))) text = null
    } catch {
      text = null
    }
    if (raw.length > CONSTANTS.MAX_DOC_BYTES) {
      this.readOnlyState = { code: 'TOO_LARGE', message: `${this.file} is ${raw.length} bytes (max ${CONSTANTS.MAX_DOC_BYTES})` }
      text = null
    } else if (text === null) {
      this.readOnlyState = { code: 'NOT_UTF8', message: `${this.file} is not valid UTF-8` }
    }
    if (text === null) {
      this.adoptText('', false)
      this.rawHash = sha256Hex(new Uint8Array(raw))
      this.curHash = this.rawHash
      this.size = raw.length
    } else {
      this.adoptText(text, bom)
    }
    this.mtimeMs = st.mtimeMs
    if (!first) return
    const sp = this.sidecarPath()
    if (!existsSync(sp)) return
    const parsed = parseSidecar(readFileSync(sp, 'utf8'))
    if (parsed.schemaUnsupported) {
      this.readOnlyState = { code: 'SIDECAR_SCHEMA_UNSUPPORTED', message: `sidecar schema ${parsed.schemaUnsupported} is not supported` }
      return
    }
    this.header = parsed.header
    this.events = parsed.events
    this.extraWarnings.push(...parsed.warnings)
    if (parsed.corrupt) {
      this.readOnlyState = { code: 'SIDECAR_CORRUPT', message: `sidecar line ${parsed.corrupt.line}: ${parsed.corrupt.reason}` }
      this.extraWarnings.push({ code: 'SIDECAR_INVALID_EVENT', message: `line ${parsed.corrupt.line}: ${parsed.corrupt.reason}`, line: parsed.corrupt.line })
    }
    this.seqCounter = this.events.length ? this.events[this.events.length - 1]!.seq : 0
    for (const e of this.events) {
      if (e.type !== 'doc.rev') continue
      this.revHashes.set(e.rev, e.hash)
      this.maxRev = Math.max(this.maxRev, e.rev)
      this.curRev = e.rev
    }
    const lastHash = this.revHashes.get(this.curRev)
    if (this.curRev > 0 && lastHash && lastHash !== this.curHash && !this.readOnlyState && !this.forbidWrites) {
      // the file changed while nothing watched it: record it as external on open (§3.6)
      const text0 = this.text
      this.curHash = lastHash
      this.refold()
      this.recordExternal(text0, true)
    }
  }

  private refold(): void {
    this.f = fold(this.events)
  }

  private seq(): number {
    return this.seqCounter
  }

  private emit(c: StoreChange): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(c)
      } catch {
        // a listener's failure never breaks a commit
      }
    }
  }

  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.persist && !this.closed) await this.syncDisk()
      return fn()
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Reconcile with disk (persist mode, §3.6): missing → doc.missing; different bytes → doc.external. Public so
   * fakeApp can poll it for connected SSE clients.
   */
  checkDisk(): Promise<boolean> {
    if (!this.persist) return Promise.resolve(false)
    return this.serial(() => false).then(() => this.lastSyncChanged)
  }
  private lastSyncChanged = false

  private async syncDisk(): Promise<void> {
    this.lastSyncChanged = false
    if (!existsSync(this.abs)) {
      if (!this.missing) {
        this.recordMissing()
        this.lastSyncChanged = true
      }
      return
    }
    const st = statSync(this.abs)
    if (!this.missing && st.mtimeMs === this.diskMtime && st.size === this.diskSize) return
    const raw = readFileSync(this.abs)
    this.diskMtime = st.mtimeMs
    this.diskSize = st.size
    const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(bom ? 3 : 0))
    } catch {
      this.readOnlyState = { code: 'NOT_UTF8', message: `${this.file} is not valid UTF-8` }
      this.lastSyncChanged = true
      return
    }
    if (!this.missing && docHash(text, bom) === this.curHash) return
    this.bom = bom
    this.recordExternal(text)
    this.lastSyncChanged = true
  }

  private persistMd(): void {
    if (!this.persist) return
    const dir = dirname(this.abs)
    const tmp = join(dir, `.${basename(this.abs)}.mdr-${process.pid}-${ulid()}.tmp`)
    writeFileSync(tmp, Buffer.from((this.bom ? '﻿' : '') + this.text, 'utf8'))
    renameSync(tmp, this.abs)
    const st = statSync(this.abs)
    this.diskMtime = st.mtimeMs
    this.diskSize = st.size
    this.mtimeMs = st.mtimeMs
  }

  private persistLines(lines: readonly object[], withHeader: boolean): void {
    if (!this.persist) return
    const body = lines.map((l) => JSON.stringify(l) + '\n').join('')
    if (withHeader) writeFileSync(this.sidecarPath(), JSON.stringify(this.header) + '\n' + body)
    else appendFileSync(this.sidecarPath(), body)
  }

  private assertWritable(): void {
    if (this.forbidWrites) throw err('READ_ONLY', 'this store was opened read-only')
    const ro = this.readOnlyState
    if (!ro) return
    if (ro.code === 'SIDECAR_CORRUPT' || ro.code === 'SIDECAR_SCHEMA_UNSUPPORTED') throw err(ro.code, ro.message)
    throw err('READ_ONLY', ro.message)
  }

  private snap(): DocSnapshot {
    return {
      file: this.file,
      abs: this.abs,
      docId: this.header?.docId ?? null,
      rev: this.curRev,
      hash: this.curHash,
      markdown: this.text,
      bom: this.bom,
      eol: this.L.eol,
      size: this.size,
      mtimeMs: this.mtimeMs,
      blocks: this.L.blocks,
      seq: this.seq(),
      schemaFingerprint: this.md.schemaFingerprint,
      readOnly: this.readOnlyState,
    }
  }

  private resolve(a: Anchor): Resolution {
    if (a.kind === 'doc') return { state: 'doc' }
    const ro = this.readOnlyState
    if (ro && (ro.code === 'NOT_UTF8' || ro.code === 'TOO_LARGE')) return { state: 'detached' }
    return resolveAnchor(this.P, this.L.blocks, a, { fuzzy: true })
  }

  private storeReview(): StoreReviewState {
    const base = this.readOnlyState && this.readOnlyState.code === 'SIDECAR_SCHEMA_UNSUPPORTED'
      ? toReviewState(fold([]), (a) => this.resolve(a), { file: this.file })
      : toReviewState(this.f, (a) => this.resolve(a), { file: this.file })
    const suggestions: Suggestion[] = base.suggestions.map((s) => ({ ...s, located: s.status === 'pending' ? locate(this.L, s) : null }))
    return {
      ...base,
      ok: true,
      file: this.file,
      rev: this.curRev,
      seq: this.seq(),
      suggestions,
      undeliveredHandoffs: handoffRecords(this.f, { unconsumed: true }).map((h) => h.seq),
      warnings: [...base.warnings, ...this.extraWarnings],
      readOnly: this.readOnlyState,
    }
  }

  private stale(code: 'STALE_REVISION' | 'CONFLICT', message: string, extra: Omit<import('../../shared/types').ApiErrorBody, 'code' | 'message'> = {}): StoreError {
    return new StoreError(code, message, extra, { current: this.snap(), review: this.storeReview() })
  }

  private threadOf(id: ThreadId): ThreadFold {
    const t = this.f.threads.get(id)
    if (!t) throw err('THREAD_NOT_FOUND', `thread ${id} not found`, { thread: id })
    return t
  }
  private suggestionOf(id: SuggestionId): SuggestionFold {
    const s = this.f.suggestions.get(id)
    if (!s) throw err('SUGGESTION_NOT_FOUND', `suggestion ${id} not found`, { suggestion: id })
    return s
  }
  private messageOf(id: CommentId): { t: ThreadFold; by: Author } {
    for (const t of this.f.threads.values()) {
      const m = t.messages.find((x) => x.id === id)
      if (m && !m.deleted) return { t, by: m.by }
    }
    throw err('COMMENT_NOT_FOUND', `comment ${id} not found`)
  }
  private reviewThread(id: ThreadId): import('../../shared/types').Thread {
    const t = this.storeReview().threads.find((x) => x.id === id)
    if (!t) throw err('THREAD_NOT_FOUND', `thread ${id} not found`, { thread: id })
    return t
  }
  private lastRevBy(): Actor {
    for (let k = this.events.length - 1; k >= 0; k--) {
      const e = this.events[k]!
      if (e.type === 'doc.rev') return e.by
    }
    return 'external'
  }

  /** Materialize the sidecar on the first write (§3.5): header + doc.rev { rev 1, cause baseline }. */
  private materialize(): SidecarEvent[] {
    if (this.header) return []
    this.header = { type: 'header', schema: SIDECAR_SCHEMA, docId: newDocId(), file: basename(this.abs), createdAt: nowIso(), createdBy: CREATED_BY }
    const bytes = this.size
    this.maxRev = Math.max(this.maxRev, 1)
    this.curRev = 1
    this.revHashes.set(1, this.curHash)
    const baseline = this.stamp([{ type: 'doc.rev', by: 'system', prevRev: null, prevHash: null, hash: this.curHash, bytes, cause: 'baseline' }], 1, {})
    this.addVersion('baseline', 'external', this.text, [1, 1])
    return baseline
  }

  private stamp(batch: readonly NewEvent[], rev: number, o: { key?: string; wal?: { rev: number; hash: Hash } }): SidecarEvent[] {
    return batch.map((e) => {
      const { type, by, key, ...rest } = e as NewEvent & { key?: string }
      const k = key ?? o.key
      const line = {
        seq: ++this.seqCounter,
        id: `e_${ulid()}`,
        type,
        by,
        at: nowIso(),
        rev,
        ...(k !== undefined ? { key: k } : {}),
        ...(o.wal ? { wal: o.wal } : {}),
        ...rest,
      }
      return line as unknown as SidecarEvent
    })
  }

  /** Append lines, refold, persist. `fromSeq` is the seq before the first appended line. */
  private appendLines(lines: SidecarEvent[], withHeader: boolean): void {
    this.events.push(...lines)
    this.refold()
    this.persistLines(lines, withHeader)
  }

  private addVersion(cause: VersionCause, by: Actor, text: string, revs: [number, number], restoredFrom?: VersionId): void {
    const hash = docHash(text, this.bom)
    const last = this.versions[this.versions.length - 1]
    if (last && last.hash === hash) return
    const n = this.versions.length + 1
    let blocksChanged = 0
    if (last) {
      const a = load(this.md, last.text)
      const b = load(this.md, text)
      for (const d of diffBlocks(a.blocks, b.blocks)) if (d.op !== 'equal') blocksChanged += Math.max(d.an, d.bn)
    }
    this.versions.push({
      v: `v${n}`, n, rev: revs[1], hash, by, cause, at: nowIso(), size: Buffer.byteLength(text, 'utf8'), revs, blocksChanged,
      ...(restoredFrom ? { restoredFrom } : {}),
      text,
    })
    this.objects.set(hash, text)
  }

  /** Before any write: version the current content if it has none yet (§10 'pre-write'). */
  private ensureVersion(): void {
    const last = this.versions[this.versions.length - 1]
    if (!last || last.hash !== this.curHash) this.addVersion('pre-write', this.lastRevBy(), this.text, [this.curRev, this.curRev])
  }

  /**
   * The one commit path (Appendix A, minus the lock and the WAL recovery): materialize, append ONE batch (doc.rev +
   * doc.edit + op events, `wal` on every line when bytes change), apply the bytes, then the post-commit system pass
   * (stale suggestions, detach anchors), history, and the StoreChange emissions in order.
   */
  private commit(spec: CommitSpec): CommitResult {
    const fromSeq = this.seq()
    const bytesChanged = spec.text !== undefined && (spec.text !== this.text || spec.force === true)
    const tjEditor = spec.by === 'TJ' && spec.cause !== undefined && TJ_EDITOR_CAUSES.has(spec.cause)
    if (bytesChanged && !tjEditor) this.flushSessionNow('foreign-write')
    const opEventsProbe = spec.events(bytesChanged ? this.maxRev + (this.header ? 1 : 2) : this.curRev || 1)
    if (!bytesChanged && opEventsProbe.length === 0) {
      return { seq: this.seq(), rev: this.curRev, hash: this.curHash, events: [], changes: [], bytesChanged: false, staled: [], rebased: [], detached: [], warnings: [] }
    }
    const withHeader = this.header === null
    const head = this.materialize()
    if (bytesChanged && !tjEditor) this.ensureVersion()
    let lines: SidecarEvent[]
    let changes: BlockChange[] = []
    if (bytesChanged) {
      const newText = spec.text!
      const newRev = this.maxRev + 1
      const newHash = docHash(newText, this.bom)
      const prevRev = this.curRev
      const prevHash = this.curHash
      const oldL = this.L
      const newL = load(this.md, newText)
      changes = blockChanges({ src: this.text, blocks: oldL.blocks }, { src: newText, blocks: newL.blocks })
      const bytes = Buffer.byteLength(newText, 'utf8') + (this.bom ? 3 : 0)
      const batch: NewEvent[] = [{
        type: 'doc.rev', by: spec.by ?? 'system', prevRev, prevHash, hash: newHash, bytes, cause: spec.cause ?? 'cli',
        ...(spec.clientId ? { clientId: spec.clientId } : {}),
        ...(spec.saveId !== undefined ? { saveId: spec.saveId } : {}),
      } as NewEvent]
      if (spec.edit && !tjEditor) {
        batch.push({
          type: 'doc.edit', by: (spec.by === 'TJ' || spec.by === 'Claude' ? spec.by : 'Claude') as Author, source: spec.edit.source,
          fromRev: prevRev, toRev: newRev, changes, ...(spec.edit.cause ? { cause: spec.edit.cause } : {}),
        } as NewEvent)
      }
      batch.push(...spec.events(newRev))
      lines = this.stamp(batch, newRev, { ...(spec.key !== undefined ? { key: spec.key } : {}), wal: { rev: newRev, hash: newHash } })
      // the doc.rev line carries the request's key too (Appendix A: every line of a save batch)
      this.maxRev = newRev
      this.curRev = newRev
      this.revHashes.set(newRev, newHash)
      this.text = newText
      this.L = newL
      this.P = ptextOf(newL.doc, newL)
      this.curHash = newHash
      this.rawHash = newHash
      this.size = bytes
      this.mtimeMs = Date.now()
      this.objects.set(newHash, newText)
      if (this.missing) this.missing = null
      this.persistMd()
      if (tjEditor) {
        if (this.session) {
          this.session.lastRev = newRev
          this.session.lastHash = newHash
        } else this.session = { baseRev: prevRev, baseHash: prevHash, lastRev: newRev, lastHash: newHash }
        this.armIdle()
      }
    } else {
      lines = this.stamp(spec.events(this.curRev), this.curRev, spec.key !== undefined ? { key: spec.key } : {})
    }
    this.appendLines([...head, ...lines], withHeader)
    const sys = bytesChanged ? this.systemPass() : { lines: [] as SidecarEvent[], staled: [], rebased: [], detached: [], warnings: [] }
    if (bytesChanged && spec.version) this.addVersion(spec.version.cause, spec.version.by, this.text, [this.curRev, this.curRev], spec.version.restoredFrom)
    const all = [...head, ...lines, ...sys.lines]
    if (bytesChanged) {
      const docRev = lines[0] as Extract<SidecarEvent, { type: 'doc.rev' }>
      this.emit({
        kind: 'doc', rev: this.curRev, prevRev: docRev.prevRev ?? 0, hash: this.curHash, by: docRev.by, cause: docRev.cause,
        ...(spec.clientId ? { clientId: spec.clientId } : {}),
        ...(spec.saveId !== undefined ? { saveId: spec.saveId } : {}),
        changes,
      })
    }
    this.emit({ kind: 'sidecar', fromSeq, seq: this.seq(), events: all, ...(spec.clientId ? { clientId: spec.clientId } : {}) })
    return {
      seq: this.seq(), rev: this.curRev, hash: this.curHash, events: all, changes, bytesChanged,
      staled: sys.staled, rebased: sys.rebased, detached: sys.detached, warnings: sys.warnings,
    }
  }

  /** Step 9: rebase / stale pending suggestions (§6.7) and detach / reattach anchors (§5.4). No wal. */
  private systemPass(): { lines: SidecarEvent[]; staled: SuggestionId[]; rebased: SuggestionId[]; detached: ThreadId[]; warnings: Warning[] } {
    const batch: NewEvent[] = []
    const staled: SuggestionId[] = []
    const rebased: SuggestionId[] = []
    const detached: ThreadId[] = []
    const warnings: Warning[] = []
    for (const s of this.f.suggestions.values()) {
      if (s.status !== 'pending') continue
      if (locate(this.L, s)) continue
      const r = rebaseRecord(this.md, this.L, s)
      if ('stale' in r) {
        batch.push({ type: 'suggestion.stale', by: 'system', suggestion: s.id, reason: r.stale })
        staled.push(s.id)
        warnings.push({ code: 'SUGGESTION_STALE', message: `suggestion ${s.id} went stale (${r.stale})`, suggestion: s.id })
      } else {
        const anchor = this.anchorForHunks(r.hunks, this.L, this.P, this.curRev) ?? s.anchor
        batch.push({ type: 'suggestion.rebase', by: 'system', suggestion: s.id, anchor, range: { ...r.range, rev: this.curRev }, base: r.base, proposed: r.proposed, hunks: r.hunks })
        rebased.push(s.id)
        warnings.push({ code: 'SUGGESTION_REBASED', message: `suggestion ${s.id} was rebased`, suggestion: s.id })
      }
    }
    for (const t of this.f.threads.values()) {
      if (t.anchor.kind === 'doc') continue
      const r = this.resolve(t.anchor)
      if (!t.detached && r.state === 'detached') {
        batch.push({ type: 'thread.detach', by: 'system', thread: t.id, cause: 'unresolvable' })
        detached.push(t.id)
        warnings.push({ code: 'THREAD_DETACHED', message: `thread ${t.id} lost its anchor`, thread: t.id })
      } else if (t.detached && t.lastAnchor.kind !== 'doc') {
        const back = this.resolve(t.lastAnchor)
        if ((back.state === 'exact' || back.state === 'moved') && !back.ambiguous) {
          const anchor = t.lastAnchor.kind === 'text' && back.from !== undefined && back.to !== undefined
            ? createAnchor(this.P, this.L.blocks, back.from, back.to, this.curRev)
            : t.lastAnchor.kind === 'block' && back.block !== undefined ? createBlockAnchor(this.L.blocks, back.block, this.curRev) : null
          if (anchor) batch.push({ type: 'thread.reattach', by: 'system', thread: t.id, anchor })
        }
      }
    }
    if (!batch.length) return { lines: [], staled, rebased, detached, warnings }
    const lines = this.stamp(batch, this.curRev, {})
    this.appendLines(lines, false)
    return { lines, staled, rebased, detached, warnings }
  }

  private anchorForHunks(hunks: readonly Hunk[], L: Loaded, P: PText, rev: number): TextAnchor | null {
    const h = hunks[0]
    if (!h) return null
    const from = Math.min(h.at, P.text.length)
    const to = Math.min(from + h.del.length, P.text.length)
    return createAnchor(P, L.blocks, from, to, rev)
  }

  private armIdle(): void {
    if (this.idleFlushMs <= 0) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.flushTjSession('idle').catch(() => undefined)
    }, this.idleFlushMs)
    this.idleTimer.unref?.()
  }

  /** The TJ session flush (§7.1): one doc.edit covering every TJ editor save since the session opened. */
  private flushSessionNow(reason: FlushReason): SidecarEvent[] {
    void reason
    const s = this.session
    if (!s) return []
    this.session = null
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const before = this.objects.get(s.baseHash)
    const after = this.objects.get(s.lastHash)
    if (before === undefined || after === undefined || s.baseHash === s.lastHash) return []
    const a = load(this.md, before)
    const b = load(this.md, after)
    const changes = blockChanges({ src: before, blocks: a.blocks }, { src: after, blocks: b.blocks })
    if (!changes.length) return []
    const fromSeq = this.seq()
    const lines = this.stamp([{ type: 'doc.edit', by: 'TJ', source: 'editor', fromRev: s.baseRev, toRev: s.lastRev, changes }], this.curRev, {})
    this.appendLines(lines, false)
    this.addVersion('tj-session', 'TJ', after, [s.baseRev, s.lastRev])
    this.emit({ kind: 'sidecar', fromSeq, seq: this.seq(), events: lines })
    return lines
  }

  /** External write (§3.6 "Anything else"). `quietOpen` skips the emission (store open). */
  private recordExternal(text: string, quietOpen = false): void {
    this.flushSessionNow('foreign-write')
    const fromSeq = this.seq()
    const withHeader = this.header === null
    const head = this.materialize()
    const prevRev = this.curRev
    const prevHash = this.curHash
    const oldText = this.objects.get(prevHash) ?? null
    const newRev = this.maxRev + 1
    const newHash = docHash(text, this.bom)
    const newL = load(this.md, text)
    const changes = oldText === null ? null : blockChanges({ src: oldText, blocks: load(this.md, oldText).blocks }, { src: text, blocks: newL.blocks })
    const bytes = Buffer.byteLength(text, 'utf8') + (this.bom ? 3 : 0)
    const lines = this.stamp([
      { type: 'doc.rev', by: 'external', prevRev, prevHash, hash: newHash, bytes, cause: 'external' },
      { type: 'doc.external', by: 'external', fromRev: prevRev, toRev: newRev, changes },
    ], newRev, {})
    this.missing = null
    this.maxRev = newRev
    this.curRev = newRev
    this.revHashes.set(newRev, newHash)
    this.text = text
    this.L = newL
    this.P = ptextOf(newL.doc, newL)
    this.curHash = newHash
    this.rawHash = newHash
    this.size = bytes
    this.objects.set(newHash, text)
    this.appendLines([...head, ...lines], withHeader)
    const sys = this.systemPass()
    this.addVersion('external', 'external', text, [newRev, newRev])
    if (quietOpen) return
    this.emit({ kind: 'doc', rev: newRev, prevRev, hash: newHash, by: 'external', cause: 'external', changes: changes ?? [] })
    this.emit({ kind: 'sidecar', fromSeq, seq: this.seq(), events: [...head, ...lines, ...sys.lines] })
  }

  private recordMissing(): void {
    if (this.missing) return
    const fromSeq = this.seq()
    const withHeader = this.header === null
    const head = this.materialize()
    const lastHash = this.curHash
    const lines = this.stamp([{ type: 'doc.missing', by: 'external', lastHash }], this.curRev, {})
    this.missing = { lastHash }
    this.appendLines([...head, ...lines], withHeader)
    this.emit({ kind: 'removed' })
    this.emit({ kind: 'sidecar', fromSeq, seq: this.seq(), events: [...head, ...lines] })
  }

  private gone(): void {
    if (this.missing) throw err('DOC_GONE', `${this.file} was moved or deleted`)
  }

  // =================================================================================== DocStore: reads

  snapshot(): Promise<DocSnapshot> {
    return this.serial(() => {
      this.gone()
      return this.snap()
    })
  }

  review(): Promise<StoreReviewState> {
    return this.serial(() => {
      this.gone()
      return this.storeReview()
    })
  }

  handoffs(o?: { unconsumed?: boolean }): Promise<HandoffRecord[]> {
    return Promise.resolve(handoffRecords(this.f, o))
  }

  flushTjSession(reason: FlushReason): Promise<void> {
    return this.serial(() => {
      this.flushSessionNow(reason)
    })
  }

  onChange(cb: (c: StoreChange) => void): Unsubscribe {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async close(): Promise<void> {
    await this.serial(() => {
      if (!this.forbidWrites && !this.readOnlyState) this.flushSessionNow('shutdown')
    }).catch(() => undefined)
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.listeners.clear()
  }

  appendEvents(events: HandoffEventInput[], ctx?: TjCtx): Promise<{ seq: number; events: SidecarEvent[] }> {
    return this.serial(() => {
      this.assertWritable()
      const batch: NewEvent[] = events.map((e) => {
        if (e.type === 'handoff.sent') return { ...e, by: 'TJ' } as NewEvent
        if (e.type === 'handoff.consumed') return { ...e, by: e.via === 'waiter' ? 'Claude' : 'system' } as NewEvent
        throw err('INTERNAL', `appendEvents takes handoff events only, got ${(e as { type: string }).type}`)
      })
      const r = this.commit({ events: () => batch, ...(ctx?.clientId ? { clientId: ctx.clientId } : {}) })
      return { seq: r.seq, events: r.events.filter((x) => x.type === 'handoff.sent' || x.type === 'handoff.consumed') }
    })
  }

  // =================================================================================== DocStore: TJ save

  save(req: SaveRequest, ctx?: TjCtx): Promise<SaveResponse> {
    return this.serial(() => this.saveNow(req, ctx))
  }

  private saveNow(req: SaveRequest, ctx?: TjCtx): SaveResponse {
    const key = saveKey(req.clientId, req.saveId)
    const dup = this.results.get(key) as SaveResponse | undefined
    if (dup) return { ...dup, applied: 'duplicate' }
    if (this.f.keys.has(key)) {
      const line = this.events.find((e) => e.key === key && e.type === 'doc.rev') as Extract<SidecarEvent, { type: 'doc.rev' }> | undefined
      return {
        ok: true, applied: 'duplicate', rev: line?.rev ?? this.curRev, hash: line?.hash ?? this.curHash, seq: this.seq(),
        conflicts: [], unsaveable: [], warnings: [], staled: [], rebasedSuggestions: [],
      }
    }
    if (this.missing && req.cause !== 'recreate') throw err('DOC_GONE', `${this.file} was moved or deleted`)
    this.assertWritable()
    if (req.ops.length > 0 && req.expectHash === undefined) throw err('BAD_REQUEST', 'expectHash is required when ops are sent')
    if (this.missing && req.base.hash !== this.missing.lastHash) {
      throw this.stale('CONFLICT', 'recreate base does not match the last known content of the file')
    }
    const strict = !req.allowPartial
    const curHashes = this.L.blocks.map((b) => b.hash)
    const direct = req.base.hash === this.curHash
      && req.base.blockHashes.length === curHashes.length && req.base.blockHashes.every((h, k) => h === curHashes[k])
    let ops: BlockOp[] = req.ops
    let conflicts: BlockConflict[] = []
    if (!direct && req.ops.length > 0) {
      const m = merge3way(
        {
          baseHashes: req.base.blockHashes, current: this.L, ops: req.ops,
          theirsBy: () => ({ by: this.lastRevBy(), rev: this.curRev }),
        },
        (index) => {
          const t = this.objects.get(req.base.hash)
          if (t === undefined) return null
          const bl = load(this.md, t).blocks[index]
          return bl ? t.slice(bl.start, bl.end) : null
        },
      )
      ops = m.mapped
      conflicts = m.conflicts
      if (conflicts.length && strict) throw this.stale('CONFLICT', `${conflicts.length} block(s) changed on both sides`, { conflicts })
    }
    let text = this.text
    let unsaveable: BlockConflict[] = []
    if (ops.length > 0) {
      const r = applyBlockOps(this.md, this.L, ops)
      if (r.failed.length) {
        if (strict) throw err('SPLICE_MISMATCH', `${r.failed.length} op(s) failed splice verification`)
        unsaveable = r.failed.map((k) => this.unsaveableOf(ops[k]!))
      }
      if (direct && req.expectHash !== undefined && docHash(r.text, this.bom) !== req.expectHash) {
        throw err('SPLICE_MISMATCH', 'the spliced text does not match expectHash', { details: { expected: req.expectHash, actual: docHash(r.text, this.bom) } })
      }
      text = r.text
    }
    const events = this.saveEvents(req)
    const cause: RevCause = req.cause === 'edit' ? 'save' : req.cause
    const res = this.commit({
      events: () => events,
      key,
      text,
      ...(this.missing ? { force: true } : {}),
      by: 'TJ',
      cause,
      ...(ctx?.clientId ? { clientId: ctx.clientId } : {}),
      saveId: req.saveId,
    })
    const merged = !direct && req.ops.length > 0
    const applied: SaveResponse['applied'] = res.bytesChanged ? (merged ? 'merged' : 'direct') : res.events.length ? 'direct' : 'noop'
    const out: SaveResponse = {
      ok: true, applied, rev: res.rev, hash: res.hash, seq: res.seq, conflicts, unsaveable,
      warnings: res.warnings,
      ...(applied === 'merged' || conflicts.length > 0 ? { rebased: this.snap() } : {}),
      staled: res.staled, rebasedSuggestions: res.rebased,
    }
    this.results.set(key, out)
    return out
  }

  private unsaveableOf(op: BlockOp): BlockConflict {
    const covered = op.covers.length
      ? this.text.slice(this.L.blocks[op.after + 1]!.start, this.L.blocks[op.before - 1]!.end)
      : ''
    const anchorHash = op.covers[0] ?? this.L.blocks[op.after]?.hash ?? 'bof'
    return {
      kind: 'unsaveable', id: `unsaveable:${anchorHash}`, baseIndex: op.after + 1, currentIndex: op.covers.length ? op.after + 1 : null,
      base: covered, mine: op.blocks.length ? op.blocks.join(this.L.eol + this.L.eol) : null, theirs: covered,
      theirsBy: this.lastRevBy(), theirsRev: this.curRev,
    }
  }

  /** Anchor updates and TJ suggestion upserts/withdrawals ride the save batch (§5.4, §6.4). */
  private saveEvents(req: SaveRequest): NewEvent[] {
    const out: NewEvent[] = []
    for (const a of req.anchors ?? []) {
      this.threadOf(a.thread)
      if (a.anchor === null) out.push({ type: 'thread.detach', by: 'TJ', thread: a.thread, cause: 'deleted' })
      else {
        validateAnchor(a.anchor)
        out.push({ type: 'anchor.update', by: 'TJ', thread: a.thread, anchor: a.anchor })
      }
    }
    for (const u of req.suggestions?.upsert ?? []) out.push(...this.upsertEvents(u))
    for (const id of req.suggestions?.withdraw ?? []) {
      const s = this.suggestionOf(id)
      const t = suggestionTransition(s, 'suggestion.withdraw', 'TJ')
      if (t === 'duplicate') continue
      if (t !== 'ok') throw err(t, `cannot withdraw ${id}`, { suggestion: id })
      out.push({ type: 'suggestion.withdraw', by: 'TJ', suggestion: id })
    }
    return out
  }

  private upsertEvents(u: TjSuggestionUpsert): NewEvent[] {
    if (!isSuggestionId(u.id)) throw err('BAD_REQUEST', `malformed suggestion id ${u.id}`)
    validateAnchor(u.anchor)
    for (let k = u.range.start; k < u.range.end; k++) {
      const b = this.L.blocks[k]
      if (b && isAtomBlock(b)) throw err('UNANCHORABLE_TARGET', `block ${b.ref} is an atom block and takes no inline suggestion`)
    }
    const at = this.L.blocks[u.range.start]?.pStart ?? 0
    const hunks = hunksOf(this.md, { base: u.base, proposed: u.proposed }, at)
    const range = { start: u.range.start, end: u.range.end, rev: this.curRev }
    const existing = this.f.suggestions.get(u.id)
    if (existing) {
      if (existing.by !== 'TJ') throw err('BAD_REQUEST', `suggestion id ${u.id} belongs to ${existing.by}`)
      const t = suggestionTransition(existing, 'suggestion.update', 'TJ')
      if (t !== 'ok') throw err(t === 'duplicate' ? 'SUGGESTION_CLOSED' : t, `cannot update ${u.id}`, { suggestion: u.id })
      if (existing.base === u.base && existing.proposed === u.proposed) return []
      return [{ type: 'suggestion.update', by: 'TJ', suggestion: u.id, anchor: u.anchor, range, base: u.base, proposed: u.proposed, hunks }]
    }
    if (u.thread) this.threadOf(u.thread)
    return [{
      type: 'suggestion.add', by: 'TJ', thread: u.thread ?? newThreadId(), newThread: !u.thread, suggestion: u.id,
      anchor: u.anchor, range, base: u.base, proposed: u.proposed, hunks,
    }]
  }

  // =================================================================================== DocStore: TJ surface

  readonly tj: DocStore['tj'] = {
    createThread: (req, ctx) => this.serial(() => this.createThreadNow(req, ctx)),
    reply: (thread, req, ctx) => this.serial(() => this.replyNow(thread, req, ctx)),
    editComment: (comment, req, ctx) => this.serial(() => this.editCommentNow(comment, req, ctx)),
    deleteComment: (comment, req, ctx) => this.serial(() => this.deleteCommentNow(comment, req, ctx)),
    resolve: (thread, req, ctx) => this.serial(() => this.threadStatusNow(thread, 'resolved', req, ctx)),
    reopen: (thread, req, ctx) => this.serial(() => this.threadStatusNow(thread, 'open', req, ctx)),
    decide: (id, decision, req, ctx) => this.serial(() => this.decideNow(id, decision, req, ctx)),
    reopenSuggestion: (id, req, ctx) => this.serial(() => this.reopenSuggestionNow(id, req, ctx)),
    bulkDecide: (req, ctx) => this.serial(() => this.bulkNow(req, ctx)),
    readMarker: (req, ctx) => this.serial(() => this.readMarkerNow(req, ctx)),
    restore: (req, ctx) => this.serial(() => this.restoreNow(req, ctx)),
    setPolicy: (req, ctx) => this.serial(() => this.setPolicyNow(req, 'TJ', ctx)),
  }

  private dupOf<T>(key: string): T | null {
    const r = this.results.get(key)
    return r === undefined ? null : ({ ...(r as object), duplicate: true } as T)
  }

  private ctxOf(ctx?: TjCtx): { clientId?: ClientId } {
    return ctx?.clientId ? { clientId: ctx.clientId } : {}
  }

  private createThreadNow(req: CreateThreadRequest, ctx?: TjCtx): CreateThreadResponse {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<CreateThreadResponse>(key)
    if (dup) return dup
    this.gone()
    this.assertWritable()
    validateAnchor(req.anchor)
    validateCommentBody(req.body)
    let anchor = req.anchor
    if (anchor.kind === 'text' && req.anchorRev < this.curRev) {
      const r = this.resolve(anchor)
      if (r.from !== undefined && r.to !== undefined && r.state !== 'detached') anchor = createAnchor(this.P, this.L.blocks, r.from, r.to, this.curRev)
    }
    if (anchor.kind === 'text' && anchor.quote.includes('￼') && anchor.quote.replace(/￼/g, '').trim() === '') {
      throw err('UNANCHORABLE_TARGET', 'the selection holds only atom content; anchor it to the block instead')
    }
    const thread = newThreadId()
    const res = this.commit({ events: () => [{ type: 'comment.add', by: 'TJ', thread, comment: newCommentId(), anchor, body: req.body }], key, ...this.ctxOf(ctx) })
    const out: CreateThreadResponse = { ok: true, thread: this.reviewThread(thread), seq: res.seq }
    this.results.set(key, out)
    return out
  }

  private replyNow(thread: ThreadId, req: ReplyRequest, ctx?: TjCtx): MessageResponse {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<MessageResponse>(key)
    if (dup) return dup
    this.assertWritable()
    validateCommentBody(req.body)
    const t = this.threadOf(thread)
    const comment = newCommentId()
    const res = this.commit({
      events: () => [
        { type: 'comment.reply', by: 'TJ', thread, comment, body: req.body },
        ...(t.status === 'resolved' ? [{ type: 'thread.reopen', by: 'TJ', thread } as NewEvent] : []),
      ],
      key,
      ...this.ctxOf(ctx),
    })
    const out: MessageResponse = { ok: true, message: this.reviewThread(thread).messages.find((m) => m.id === comment)!, seq: res.seq }
    this.results.set(key, out)
    return out
  }

  private editCommentNow(comment: CommentId, req: EditCommentRequest, ctx?: TjCtx): MessageResponse {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<MessageResponse>(key)
    if (dup) return dup
    this.assertWritable()
    validateCommentBody(req.body)
    const m = this.messageOf(comment)
    if (m.by !== 'TJ') throw err('NOT_AUTHOR', 'TJ can edit only his own messages')
    const res = this.commit({ events: () => [{ type: 'comment.edit', by: 'TJ', comment, body: req.body }], key, ...this.ctxOf(ctx) })
    const out: MessageResponse = { ok: true, message: this.reviewThread(m.t.id).messages.find((x) => x.id === comment)!, seq: res.seq }
    this.results.set(key, out)
    return out
  }

  private deleteCommentNow(comment: CommentId, req: OpKeyRequest, ctx?: TjCtx): SeqResponse {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<SeqResponse>(key)
    if (dup) return dup
    this.assertWritable()
    const m = this.messageOf(comment)
    if (m.by !== 'TJ') throw err('NOT_AUTHOR', 'TJ can delete only his own messages')
    const res = this.commit({ events: () => [{ type: 'comment.delete', by: 'TJ', comment }], key, ...this.ctxOf(ctx) })
    const out: SeqResponse = { ok: true, seq: res.seq }
    this.results.set(key, out)
    return out
  }

  private pendingIn(t: ThreadFold): SuggestionId[] {
    return t.suggestions.filter((id) => {
      const s = this.f.suggestions.get(id)
      return s !== undefined && (s.status === 'pending' || s.status === 'stale')
    })
  }

  private threadStatusNow(thread: ThreadId, status: 'open' | 'resolved', req: OpKeyRequest, ctx?: TjCtx): ThreadOpResponse {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<ThreadOpResponse>(key)
    if (dup) return dup
    this.assertWritable()
    const t = this.threadOf(thread)
    const warnings: Warning[] = []
    const pending = this.pendingIn(t)
    if (status === 'resolved' && pending.length) {
      warnings.push({ code: 'RESOLVED_WITH_PENDING', message: `resolved with pending suggestions: ${pending.join(', ')}`, thread })
    }
    const res = t.status === status
      ? { seq: this.seq() }
      : this.commit({ events: () => [{ type: status === 'resolved' ? 'thread.resolve' : 'thread.reopen', by: 'TJ', thread } as NewEvent], key, ...this.ctxOf(ctx) })
    const out: ThreadOpResponse = { ok: true, thread: this.reviewThread(thread), seq: res.seq, ...(warnings.length ? { warnings } : {}) }
    this.results.set(key, out)
    return out
  }

  private decideNow(id: SuggestionId, decision: 'accept' | 'reject', req: DecideRequest, ctx?: TjCtx): DecisionResult {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<DecisionResult>(key)
    if (dup) return dup
    this.gone()
    this.assertWritable()
    const s = this.suggestionOf(id)
    const t = suggestionTransition(s, decision === 'accept' ? 'suggestion.accept' : 'suggestion.reject', 'TJ')
    if (t === 'duplicate') return { ok: true, suggestion: id, status: s.status, rev: this.curRev, hash: this.curHash, seq: this.seq(), changes: [], duplicate: true }
    if (t !== 'ok') throw err(t, `cannot ${decision} ${id} (${s.status})`, { suggestion: id, thread: s.thread })
    let res: CommitResult
    if (decision === 'reject') {
      res = this.commit({ events: () => [{ type: 'suggestion.reject', by: 'TJ', suggestion: id }], key, ...this.ctxOf(ctx) })
    } else {
      const ap = this.applySuggestionText(s)
      res = this.commit({
        events: (rev) => [{ type: 'suggestion.accept', by: 'TJ', suggestion: id, resultRev: rev }],
        key, text: ap, by: 'TJ', cause: 'accept', edit: { source: 'accept', cause: { type: 'suggestion.accept', id } },
        version: { cause: 'accept', by: 'TJ' }, ...this.ctxOf(ctx),
      })
    }
    const out: DecisionResult = {
      ok: true, suggestion: id, status: decision === 'accept' ? 'accepted' : 'rejected', rev: res.rev, hash: res.hash, seq: res.seq,
      changes: res.changes,
    }
    this.results.set(key, out)
    return out
  }

  /** Text after splicing a suggestion's proposed at its located run (exact bytes, §6.6), or BLOCK_MERGE_HAZARD. */
  private applySuggestionText(s: SuggestionBody, L: Loaded = this.L): string {
    if (!locate(L, s)) throw err('SUGGESTION_STALE', 'the suggestion base is no longer in the document')
    const r = applyToSource(this.md, L, s)
    if (!r.verified) throw err('BLOCK_MERGE_HAZARD', 'applying the suggestion would change a neighbouring block')
    return r.text
  }

  /** Undo of an accept: splice proposed → base if proposed is still intact (§6.6). */
  private unapplySuggestionText(s: SuggestionBody, L: Loaded = this.L): string | null {
    const flipped: SuggestionBody = { ...s, base: s.proposed, proposed: s.base }
    if (s.proposed === '' || !locate(L, flipped)) return null
    const r = applyToSource(this.md, L, flipped)
    return r.verified ? r.text : null
  }

  private reopenSuggestionNow(id: SuggestionId, req: DecideRequest, ctx?: TjCtx): DecisionResult {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<DecisionResult>(key)
    if (dup) return dup
    this.assertWritable()
    const s = this.suggestionOf(id)
    const t = suggestionTransition(s, 'suggestion.reopen', 'TJ')
    if (t === 'duplicate') return { ok: true, suggestion: id, status: 'pending', rev: this.curRev, hash: this.curHash, seq: this.seq(), changes: [], duplicate: true }
    if (t !== 'ok') throw err('SUGGESTION_CHANGED_SINCE', `cannot reopen ${id} (${s.status})`, { suggestion: id })
    let res: CommitResult
    if (s.status === 'rejected') {
      res = this.commit({ events: () => [{ type: 'suggestion.reopen', by: 'TJ', suggestion: id, resultRev: null }], key, ...this.ctxOf(ctx) })
    } else {
      const text = this.unapplySuggestionText(s)
      if (text === null) throw err('SUGGESTION_CHANGED_SINCE', `the accepted text of ${id} changed since`, { suggestion: id, details: { ids: [id] } })
      res = this.commit({
        events: (rev) => [{ type: 'suggestion.reopen', by: 'TJ', suggestion: id, resultRev: rev }],
        key, text, by: 'TJ', cause: 'undo-accept', edit: { source: 'undo-accept', cause: { type: 'suggestion.reopen', id } },
        version: { cause: 'accept', by: 'TJ' }, ...this.ctxOf(ctx),
      })
    }
    const out: DecisionResult = { ok: true, suggestion: id, status: 'pending', rev: res.rev, hash: res.hash, seq: res.seq, changes: res.changes }
    this.results.set(key, out)
    return out
  }

  private bulkNow(req: BulkDecisionRequest, ctx?: TjCtx): BulkDecisionResult {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<BulkDecisionResult>(key)
    if (dup) return dup
    this.gone()
    this.assertWritable()
    if (req.decision === 'reopen') return this.bulkReopen(req, key, ctx)
    const authorOk = (by: Author): boolean => req.authors.length === 0 || req.authors.includes(by)
    const ids = req.ids
      ? req.ids
      : [...this.f.suggestions.values()].filter((s) => s.status === 'pending' && authorOk(s.by)).map((s) => s.id)
    const results: BulkDecisionResult['results'] = []
    const events: NewEvent[] = []
    let text = this.text
    let L = this.L
    let anyAccept = false
    for (const id of ids) {
      const s = this.f.suggestions.get(id)
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
        // §6.6 Bulk (P2 merge), as node/docstore.ts: after an earlier id changed the text, a record whose base is
        // gone is rebased (§6.7) against the intermediate text, and its suggestion.rebase rides the same batch.
        let body: SuggestionBody = s
        let rebased: NewEvent | null = null
        if (anyAccept && !locate(L, s)) {
          const r = rebaseRecord(this.md, L, s)
          if (!('stale' in r)) {
            body = r
            const anchor = this.anchorForHunks(r.hunks, L, ptextOf(L.doc, L), -1) ?? s.anchor
            rebased = { type: 'suggestion.rebase', by: 'system', suggestion: id, anchor, range: r.range, base: r.base, proposed: r.proposed, hunks: r.hunks }
          }
        }
        text = this.applySuggestionText(body, L)
        L = load(this.md, text)
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
      ...(anyAccept ? { text, by: 'TJ' as const, cause: 'accept' as const, edit: { source: 'accept' as const }, version: { cause: 'accept' as const, by: 'TJ' as const } } : {}),
      ...this.ctxOf(ctx),
    })
    const out: BulkDecisionResult = { ok: true, rev: res.rev, hash: res.hash, seq: res.seq, results }
    this.results.set(key, out)
    return out
  }

  /** D26: all-or-nothing bulk undo. */
  private bulkReopen(req: Extract<BulkDecisionRequest, { decision: 'reopen' }>, key: string, ctx?: TjCtx): BulkDecisionResult {
    const failing: SuggestionId[] = []
    let text = this.text
    let L = this.L
    let anyAccept = false
    const events: NewEvent[] = []
    for (const id of [...req.ids].reverse()) {
      const s = this.f.suggestions.get(id)
      if (!s || suggestionTransition(s, 'suggestion.reopen', 'TJ') !== 'ok') {
        failing.push(id)
        continue
      }
      if (s.status === 'accepted') {
        const t = this.unapplySuggestionText(s, L)
        if (t === null) {
          failing.push(id)
          continue
        }
        text = t
        L = load(this.md, text)
        anyAccept = true
        events.push({ type: 'suggestion.reopen', by: 'TJ', suggestion: id, resultRev: -1 })
      } else {
        events.push({ type: 'suggestion.reopen', by: 'TJ', suggestion: id, resultRev: null })
      }
    }
    if (failing.length) {
      throw err('SUGGESTION_CHANGED_SINCE', `${failing.length} suggestion(s) changed since the bulk decision`, { details: { ids: failing.reverse() } })
    }
    events.reverse()
    const res = this.commit({
      events: (rev) => events.map((e) => (e.type === 'suggestion.reopen' && e.resultRev === -1 ? { ...e, resultRev: rev } : e)),
      key,
      ...(anyAccept ? { text, by: 'TJ' as const, cause: 'undo-accept' as const, edit: { source: 'undo-accept' as const }, version: { cause: 'accept' as const, by: 'TJ' as const } } : {}),
      ...this.ctxOf(ctx),
    })
    const out: BulkDecisionResult = { ok: true, rev: res.rev, hash: res.hash, seq: res.seq, results: req.ids.map((id) => ({ id, ok: true })) }
    this.results.set(key, out)
    return out
  }

  private readMarkerNow(req: ReadMarkerRequest, ctx?: TjCtx): SeqResponse {
    this.assertWritable()
    if (req.upTo > this.seq()) throw err('ACK_OUT_OF_RANGE', `upTo ${req.upTo} is past the latest seq ${this.seq()}`)
    if (req.thread !== null) this.threadOf(req.thread)
    const cur = req.thread === null ? this.f.cursors.tjRead : (this.f.cursors.tjReadByThread[req.thread] ?? 0)
    if (req.upTo <= cur) return { ok: true, seq: this.seq() }
    const res = this.commit({ events: () => [{ type: 'read-marker', by: 'TJ', thread: req.thread, upTo: req.upTo }], ...this.ctxOf(ctx) })
    return { ok: true, seq: res.seq }
  }

  private restoreNow(req: RestoreRequest, ctx?: TjCtx): RestoreResponse {
    const key = tjKey(req.opKey)
    const dup = this.dupOf<RestoreResponse>(key)
    if (dup) return dup
    this.gone()
    this.assertWritable()
    if (req.baseRev !== this.curRev) throw this.stale('STALE_REVISION', `restore was planned at rev ${req.baseRev}; the doc is at rev ${this.curRev}`)
    const v = this.versions.find((x) => x.v === req.v)
    if (!v) throw err('VERSION_NOT_FOUND', `version ${req.v} not found`)
    const res = this.commit({
      events: () => [], key, text: v.text, by: 'TJ', cause: 'restore',
      edit: { source: 'restore', cause: { type: 'restore', id: req.v } },
      version: { cause: 'restore', by: 'TJ', restoredFrom: req.v }, ...this.ctxOf(ctx),
    })
    const version = this.versions[this.versions.length - 1]!
    const { text: _t, ...meta } = version
    const out: RestoreResponse = {
      ok: true, rev: res.rev, hash: res.hash, seq: res.seq, version: meta, detached: res.detached, staled: res.staled, snapshot: this.snap(),
    }
    this.results.set(key, out)
    return out
  }

  private setPolicyNow(req: PolicyRequest, by: Author, ctx?: TjCtx): SeqResponse {
    this.assertWritable()
    if (this.f.policy.suggestOnly === req.suggestOnly) return { ok: true, seq: this.seq() }
    const res = this.commit({ events: () => [{ type: 'policy.set', by, suggestOnly: req.suggestOnly }], ...this.ctxOf(ctx) })
    return { ok: true, seq: res.seq }
  }

  // =================================================================================== DocStore: agent surface

  readonly agent: DocStore['agent'] = {
    status: () => this.serial(() => this.statusNow()),
    snapshot: (q) => this.serial(() => this.agentSnapshotNow(q)),
    pending: () => this.serial(() => this.pendingNow()),
    thread: (id) => this.serial(() => this.threadDetailNow(id)),
    batch: (req) => this.serial(() => this.batchNow(req)),
    setPolicy: (req) => this.serial(() => {
      const r = this.setPolicyNow(req, 'Claude')
      return { ok: true as const, seq: r.seq, suggestOnly: this.f.policy.suggestOnly }
    }),
  }

  private via(): 'server' | 'direct' {
    return this.mode
  }

  private anchorView(a: Anchor, t?: ThreadFold): AnchorView {
    if (a.kind === 'doc') return { state: 'doc', block: null, line: null, quote: '' }
    const r = t?.detached ? ({ state: 'detached' } as Resolution) : this.resolve(a)
    const state: AnchorView['state'] = r.state === 'exact' || r.state === 'moved' ? 'ok' : r.state === 'fuzzy' ? 'fuzzy' : r.state === 'doc' ? 'doc' : 'detached'
    const block = r.block ?? null
    const quote = a.kind === 'text' ? (a.tail !== undefined ? `${a.quote} … ${a.tail}` : a.quote) : a.preview
    return {
      state, block: block === null ? null : refOf(block), line: block === null ? null : (this.L.blocks[block]?.line ?? null), quote,
      ...(r.ambiguous ? { ambiguous: true as const } : {}),
    }
  }

  private statusNow(): Omit<StatusResult, 'server' | 'presence' | 'activity'> {
    this.gone()
    const threads = [...this.f.threads.values()]
    const sugg = [...this.f.suggestions.values()]
    const ack = this.f.cursors.claudeAck
    const pendingCount = this.events.filter((e) => e.seq > ack && e.by !== 'Claude' && !PENDING_IGNORED_TYPES.has(e.type)).length + (this.session ? 1 : 0)
    return {
      ok: true, via: this.via(), file: this.file, abs: this.abs, root: this.root, rev: this.curRev, hash: this.curHash, seq: this.seq(),
      threads: {
        open: threads.filter((t) => t.status === 'open' && !t.detached && !isAutoResolved(this.f, t)).length,
        resolved: threads.filter((t) => t.status === 'resolved' || isAutoResolved(this.f, t)).length,
        detached: threads.filter((t) => t.detached).length,
      },
      suggestions: { pending: sugg.filter((s) => s.status === 'pending').length, stale: sugg.filter((s) => s.status === 'stale').length },
      pendingCount,
      cursor: { ack, latest: this.seq() },
      handoff: { undelivered: handoffRecords(this.f, { unconsumed: true }).map((h) => h.seq) },
      policy: { ...this.f.policy },
      legacySidecar: this.persist && existsSync(this.abs + '.comments.jsonl'),
      needsRecovery: false,
      readOnly: this.readOnlyState,
      warnings: [...this.f.warnings, ...this.extraWarnings],
    }
  }

  private agentSnapshotNow(q: AgentSnapshotQuery): AgentSnapshot {
    this.gone()
    const from = q.from ? indexOfRef(q.from) ?? 0 : 0
    const to = q.to ? indexOfRef(q.to) ?? this.L.blocks.length - 1 : this.L.blocks.length - 1
    const blocks = this.L.blocks.filter((b) => b.index >= from && b.index <= to).map((b) => ({
      ref: b.ref, type: b.mdType, kind: b.kind, line: b.line, endLine: b.endLine, hash: b.hash,
      ...(q.md ? { md: this.text.slice(b.start, b.end) } : {}),
      ...(q.text ? { text: this.P.text.slice(b.pStart, b.pEnd) } : {}),
    }))
    const review = this.storeReview()
    return {
      ok: true, via: this.via(), file: this.file, abs: this.abs, rev: this.curRev, hash: this.curHash, eol: this.L.eol, bom: this.bom,
      blocks,
      threads: review.threads.map((t) => ({
        id: t.id, kind: t.kind, status: t.autoResolved ? 'resolved' : t.status, anchor: this.anchorView(t.anchor, this.f.threads.get(t.id)), by: t.createdBy,
        replies: Math.max(0, t.messages.filter((m) => !m.deleted).length - 1),
      })),
      suggestions: review.suggestions.map((s) => ({
        id: s.id, thread: s.thread, by: s.by, status: s.status,
        block: s.located ? refOf(s.located.start) : null, line: s.located ? (this.L.blocks[s.located.start]?.line ?? null) : null,
        hunks: s.hunks.map((h) => ({ del: h.del, ins: h.ins })),
      })),
    }
  }

  private pendingNow(): PendingResult {
    this.gone()
    const ro = this.readOnlyState
    if (ro && (ro.code === 'SIDECAR_CORRUPT' || ro.code === 'SIDECAR_SCHEMA_UNSUPPORTED')) throw err(ro.code, ro.message)
    if (!this.forbidWrites && !ro) this.flushSessionNow('agent-read')
    const runText = (rev: number, start: number, end: number): string | null => {
      const h = this.revHashes.get(rev)
      const t = h === undefined ? undefined : this.objects.get(h)
      return t === undefined ? null : t.slice(start, end)
    }
    return this.pendingFn({
      file: this.file, abs: this.abs, rev: this.curRev, hash: this.curHash, via: this.via(),
      events: [...this.events], review: this.storeReview(), blocks: this.L.blocks, runText,
    })
  }

  private threadDetailNow(id: ThreadId): ThreadDetail {
    this.gone()
    const t = this.threadOf(id)
    const view = this.anchorView(t.anchor, t)
    const bi = view.block === null ? null : indexOfRef(view.block)
    const blk = bi === null ? undefined : this.L.blocks[bi]
    const review = this.storeReview()
    return {
      ok: true, via: this.via(),
      thread: {
        id: t.id, kind: t.kind, status: isAutoResolved(this.f, t) ? 'resolved' : t.status,
        anchor: { ...view, context: blk ? this.text.slice(blk.start, blk.end) : '' },
        messages: t.messages.map((m) => ({
          id: m.id, by: m.by, at: m.at, body: m.body, ...(m.editedAt ? { editedAt: m.editedAt } : {}), ...(m.deleted ? { deleted: true as const } : {}),
        })),
        suggestions: t.suggestions.map((sid) => review.suggestions.find((s) => s.id === sid)).filter((s): s is Suggestion => !!s).map((s) => ({
          id: s.id, by: s.by, status: s.status, base: s.base, proposed: s.proposed, hunks: s.hunks,
          block: s.located ? refOf(s.located.start) : null, line: s.located ? (this.L.blocks[s.located.start]?.line ?? null) : null,
          ...(s.staleReason ? { staleReason: s.staleReason } : {}),
        })),
      },
    }
  }

  // ----------------------------------------------------------------------------------- batch (§9.5)

  private remapFor(refs: readonly BlockRef[], rev: number): Partial<Record<BlockRef, BlockRef>> {
    const out: Partial<Record<BlockRef, BlockRef>> = {}
    const h = this.revHashes.get(rev)
    const old = h === undefined ? undefined : this.objects.get(h)
    if (old === undefined) return out
    const oldBlocks = load(this.md, old).blocks
    for (const ref of refs) {
      const i = indexOfRef(ref)
      const ob = i === null ? undefined : oldBlocks[i]
      if (!ob) continue
      const hits = this.L.blocks.filter((b) => b.hash === ob.hash)
      if (hits.length === 1) out[ref] = hits[0]!.ref
    }
    return out
  }

  private batchNow(req: BatchRequest): BatchResult {
    this.gone()
    this.assertWritable()
    this.flushSessionNow('foreign-write')
    const ops = req.ops
    const suggestOnly = this.f.policy.suggestOnly
    ops.forEach((op, i) => {
      if (suggestOnly && isByteOp(op)) throw err('SUGGEST_ONLY', `op ${i} (${op.op}) writes the document directly; this review is suggest-only`, { op: i, hint: 'use suggest / suggest_block, or ask TJ to allow direct edits' })
    })
    // D3 / D27: every positional selector names the base map at the current rev
    ops.forEach((op, i) => {
      const sels = positionalSels(op)
      const staleSel = sels.find((s) => s.rev !== this.curRev)
      if (staleSel) {
        const refs = sels.filter((s) => s.ref !== undefined).map((s) => s.ref!)
        throw this.stale('STALE_REVISION', `op ${i} was read at rev ${staleSel.rev}; the doc is at rev ${this.curRev}`, {
          op: i, hint: `retry with the remapped ref and rev ${this.curRev}, or use a quote selector`, remap: this.remapFor(refs, staleSel.rev),
        })
      }
      if (op.op === 'write' && op.baseRev !== this.curRev) {
        throw this.stale('STALE_REVISION', `write was planned at rev ${op.baseRev}; the doc is at rev ${this.curRev}`, { op: i })
      }
    })
    const roundSeq = [...this.f.handoffs.keys()].reduce((m, s) => Math.max(m, s), 0)
    const doc = new BatchDoc(this.md, this.L)
    const predictedRev = (): number => (doc.hasByteOps && doc.working().text !== this.text ? this.maxRev + (this.header ? 1 : 2) : this.curRev || 1)
    const results: BatchOpResult[] = []
    const events: NewEvent[] = []
    const warnings: Warning[] = []
    const createdThreads = new Set<ThreadId>()
    let onlyAccepts = true
    let anyByte = false
    let writeSeen = false
    const keyedEvents: Array<{ key: string; events: NewEvent[]; result: BatchOpResult }> = []

    ops.forEach((op, i) => {
      const key = cliKey(this.file, roundSeq, op)
      const prior = this.results.get(key) as BatchOpResult | undefined
      if (prior || this.f.keys.has(key)) {
        results.push({ ...(prior ?? { op: op.op, key }), i, duplicate: true })
        return
      }
      try {
        const out = this.batchOp(op, i, key, doc, predictedRev, createdThreads, warnings)
        if (out.byte) {
          if (writeSeen || (op.op === 'write' && anyByte)) throw err('BATCH_SELF_CONFLICT', 'write must be the only byte change in a batch', { op: i })
          anyByte = true
          if (op.op === 'write') writeSeen = true
          if (!(op.op === 'decide' && op.decision === 'accept')) onlyAccepts = false
          const w = doc.working()
          if (w.failed.length || w.hazard) throw err('BLOCK_MERGE_HAZARD', `op ${i} would merge into or change a neighbouring block`, { op: i, hint: 'keep a blank line between blocks; a new list next to a list merges' })
        }
        events.push(...out.events.map((e) => ({ ...e, key }) as NewEvent))
        results.push(out.result)
        keyedEvents.push({ key, events: out.events, result: out.result })
      } catch (e) {
        withOp(e, i)
      }
    })

    // ack is applied LAST (§9.5)
    let acked: number | null = null
    const consumedBefore = new Set(handoffRecords(this.f, { unconsumed: true }).map((h) => h.seq))
    let consumed: number[] = []
    let ackEvent: NewEvent | null = null
    if (req.ack !== undefined) {
      const cursor = this.f.cursors.claudeAck
      if (req.ackSince !== undefined && req.ackSince !== cursor) {
        throw err('ACK_CONFLICT', `another session acked first: cursor is ${cursor}, not ${req.ackSince}`, {
          details: { cursor, lastAckWaiter: this.f.cursors.lastAckWaiter ?? null },
        })
      }
      // §4.4 ack range against the log BEFORE this batch's own lines, as P1's store does (CONTRACT_CHANGES, P1 merge).
      const maxSeq = this.seq()
      if (req.ack > maxSeq) throw err('ACK_OUT_OF_RANGE', `ack ${req.ack} is past the latest seq ${maxSeq}`)
      if (req.ack <= cursor) acked = cursor
      else {
        acked = req.ack
        ackEvent = { type: 'ack', by: 'Claude', upTo: req.ack, ...(req.waiter ? { waiter: req.waiter as WaiterId } : {}) }
        consumed = [...consumedBefore].filter((s) => s <= req.ack!).sort((a, b) => a - b)
      }
    }

    const w = doc.working()
    const text = anyByte ? w.text : undefined
    if (req.dryRun) {
      return {
        ok: true, via: this.via(), file: this.file, rev: this.curRev, hash: this.curHash, seq: this.seq(), noop: true, dryRun: true,
        results, acked, consumed, warnings,
      }
    }
    const res = this.commit({
      events: (rev) => [...events.map((e) => (e.type === 'suggestion.accept' ? { ...e, resultRev: rev } : e)), ...(ackEvent ? [ackEvent] : [])],
      ...(text !== undefined ? { text, by: 'Claude' as const, cause: onlyAccepts ? 'accept' as const : 'cli' as const, edit: { source: onlyAccepts ? 'accept' as const : 'cli' as const }, version: { cause: onlyAccepts ? 'accept' as const : 'claude-write' as const, by: 'Claude' as const } } : {}),
    })
    for (const k of keyedEvents) this.results.set(k.key, k.result)
    return {
      ok: true, via: this.via(), file: this.file, rev: res.rev, hash: res.hash, seq: res.seq, noop: res.events.length === 0,
      results, acked, consumed, warnings: [...warnings, ...res.warnings],
    }
  }

  /** Resolve a BlockSel to a BASE block index (§9.5): positional against the base map, quotes against the working text. */
  private baseIndexOf(sel: BlockSel, doc: BatchDoc): number {
    if ('ref' in sel) {
      const i = indexOfRef(sel.ref)
      if (i === null || i >= doc.n) throw err('BLOCK_NOT_FOUND', `no block ${sel.ref} at rev ${sel.rev}`)
      return i
    }
    if ('line' in sel) {
      const b = doc.base.blocks.find((x) => x.line <= sel.line && sel.line <= x.endLine)
      if (!b) throw err('BLOCK_NOT_FOUND', `no block contains line ${sel.line} at rev ${sel.rev}`)
      return b.index
    }
    if (sel.quote.length > CONSTANTS.MAX_QUOTE_CHARS) throw err('BAD_REQUEST', 'quote is too long', { hint: 'quote a shorter span, or use --block bN --base-rev R' })
    const w = doc.working()
    const hits = findQuoteInSource(w.text, sel.quote)
    if (!hits.length) this.quoteMiss(sel.quote, w, true)
    const blockAt = (off: number): number => {
      const k = w.L.blocks.findIndex((b) => b.end > off)
      return k < 0 ? w.L.blocks.length - 1 : k
    }
    let hit = hits[0]!
    if (sel.occurrence !== undefined) {
      const h = hits[sel.occurrence - 1]
      if (!h) throw err('QUOTE_NOT_FOUND', `occurrence ${sel.occurrence} does not exist (${hits.length} found)`)
      hit = h
    } else if (hits.length > 1) {
      throw err('QUOTE_AMBIGUOUS', `quote matches ${hits.length} places`, {
        hint: 'pass --occurrence N, or --near bN --base-rev R',
        candidates: hits.map((h, k) => {
          const bi = blockAt(h.start)
          return { occurrence: k + 1, block: refOf(bi), line: w.L.blocks[bi]?.line ?? 1, context: this.contextOf(w.text, h.start, h.end) }
        }),
      })
    }
    const wi = blockAt(hit.start)
    const base = w.toBase[wi]
    if (base === null || base === undefined) throw err('BATCH_SELF_CONFLICT', 'the quote lies in a block an earlier op in this batch edited or inserted')
    return base
  }

  private contextOf(src: string, start: number, end: number): string {
    return `${src.slice(Math.max(0, start - 40), start)}⟦${src.slice(start, end)}⟧${src.slice(end, end + 40)}`.replace(/\r?\n/g, ' ')
  }

  /** No hit for a quote: QUOTE_NOT_IN_SOURCE (bytes ops whose ptext matched), QUOTE_IN_PENDING_SUGGESTION, or QUOTE_NOT_FOUND (§5.5). */
  private quoteMiss(quote: string, w: ReturnType<BatchDoc['working']>, bytes: boolean): never {
    if (bytes) {
      const ph = findQuoteInPtext(this.md, w.P, quote)[0]
      if (ph) {
        const b = w.L.blocks[w.P.blockAt(ph.from).index]
        throw err('QUOTE_NOT_IN_SOURCE', 'the quote matches the rendered text but not the markdown source', {
          ...(b ? { sourceQuote: w.text.slice(b.start, b.end) } : {}), hint: 'retry with the exact source bytes (sourceQuote)',
        })
      }
    }
    for (const s of this.f.suggestions.values()) {
      if (s.status === 'pending' && s.proposed.includes(quote)) {
        throw err('QUOTE_IN_PENDING_SUGGESTION', 'the quote occurs only inside a pending suggestion', { suggestion: s.id, thread: s.thread })
      }
    }
    throw err('QUOTE_NOT_FOUND', `quote not found: ${JSON.stringify(quote.slice(0, 80))}`, { candidates: [] })
  }

  private assertUntouched(doc: BatchDoc, indices: readonly number[], what: string): void {
    for (const k of indices) if (doc.touched(k)) throw err('BATCH_SELF_CONFLICT', `${what}: base block ${refOf(k)} was already changed or suggested on by an earlier op in this batch`)
  }

  private threadExists(id: ThreadId, created: ReadonlySet<ThreadId>): ThreadFold | null {
    const t = this.f.threads.get(id)
    if (t) return t
    if (created.has(id)) return null
    throw err('THREAD_NOT_FOUND', `thread ${id} not found`, { thread: id })
  }

  private changesOf(before: ReturnType<BatchDoc['working']>, after: ReturnType<BatchDoc['working']>): NonNullable<BatchOpResult['changes']> {
    const out: NonNullable<BatchOpResult['changes']> = []
    for (const d of diffBlocks(before.L.blocks, after.L.blocks)) {
      if (d.op === 'equal') continue
      if (d.op === 'delete') out.push({ op: 'delete', block: null, line: null })
      else for (let k = 0; k < d.bn; k++) out.push({ op: d.op, block: refOf(d.b + k), line: after.L.blocks[d.b + k]?.line ?? null })
    }
    return out
  }

  private batchOp(
    op: AgentOp, i: number, key: string, doc: BatchDoc, predictedRev: () => number, created: Set<ThreadId>, warnings: Warning[],
  ): { events: NewEvent[]; result: BatchOpResult; byte: boolean } {
    const base: BatchOpResult = { i, op: op.op, key }
    const eol = this.L.eol
    switch (op.op) {
      case 'comment': {
        validateCommentBody(op.body)
        const thread = newThreadId()
        const comment = newCommentId()
        let anchor: Anchor
        if ('doc' in op) anchor = { kind: 'doc' }
        else if ('block' in op) {
          const bi = this.baseIndexOf(op.block, doc)
          this.assertUntouched(doc, [bi], `op ${i}`)
          const w = doc.working()
          const wi = w.toWorking[bi] ?? bi
          anchor = createBlockAnchor(w.L.blocks, wi, predictedRev())
        } else {
          if (op.quote.length > CONSTANTS.MAX_QUOTE_CHARS) throw err('BAD_REQUEST', 'quote is too long', { hint: 'quote a shorter span, or use --block bN --base-rev R' })
          const w = doc.working()
          const hits = findQuoteInPtext(this.md, w.P, op.quote)
          if (!hits.length) this.quoteMiss(op.quote, w, false)
          let hit = hits[0]!
          if (op.occurrence !== undefined) {
            const h = hits[op.occurrence - 1]
            if (!h) throw err('QUOTE_NOT_FOUND', `occurrence ${op.occurrence} does not exist (${hits.length} found)`)
            hit = h
          } else if (op.near) {
            const nb = indexOfRef(op.near.ref) ?? 0
            const target = w.toWorking[nb] ?? nb
            hit = hits.reduce((best, h) => (Math.abs(w.P.blockAt(h.from).index - target) < Math.abs(w.P.blockAt(best.from).index - target) ? h : best))
          } else if (hits.length > 1) {
            throw err('QUOTE_AMBIGUOUS', `quote matches ${hits.length} places`, {
              hint: 'pass --occurrence N, or --near bN --base-rev R',
              candidates: hits.map((h, k) => {
                const bi = w.P.blockAt(h.from).index
                return { occurrence: k + 1, block: refOf(bi), line: w.L.blocks[bi]?.line ?? 1, context: `${w.P.text.slice(Math.max(0, h.from - 40), h.from)}⟦${w.P.text.slice(h.from, h.to)}⟧${w.P.text.slice(h.to, h.to + 40)}`.replace(/\n/g, ' ') }
              }),
            })
          }
          const wb = w.P.blockAt(hit.from).index
          const blk = w.L.blocks[wb]
          if (blk && isAtomBlock(blk)) throw err('UNANCHORABLE_TARGET', `block ${blk.ref} is an atom block; comment on it with --block ${blk.ref} --base-rev R`)
          const bIdx = w.toBase[wb]
          if (bIdx === null || bIdx === undefined || doc.touched(bIdx)) throw err('BATCH_SELF_CONFLICT', 'the quote lies in a block an earlier op in this batch edited, inserted or suggested on')
          anchor = createAnchor(w.P, w.L.blocks, hit.from, hit.to, predictedRev())
        }
        created.add(thread)
        const view = this.viewOfNew(anchor, doc)
        return { events: [{ type: 'comment.add', by: 'Claude', thread, comment, anchor, body: op.body }], result: { ...base, thread, comment, anchor: view }, byte: false }
      }
      case 'reply': {
        validateCommentBody(op.body)
        const t = this.threadExists(op.thread, created)
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
        const t = this.threadExists(op.thread, created)
        const evs: NewEvent[] = []
        let comment: CommentId | undefined
        if (op.body !== undefined) {
          validateCommentBody(op.body)
          comment = newCommentId()
          evs.push({ type: 'comment.reply', by: 'Claude', thread: op.thread, comment, body: op.body })
        }
        if (t?.status !== 'resolved') evs.push({ type: 'thread.resolve', by: 'Claude', thread: op.thread })
        const pend = t ? this.pendingIn(t) : []
        if (pend.length) warnings.push({ code: 'RESOLVED_WITH_PENDING', message: `thread ${op.thread} resolved with pending suggestions: ${pend.join(', ')}`, thread: op.thread })
        return { events: evs, result: { ...base, thread: op.thread, ...(comment ? { comment } : {}), ...(evs.length ? {} : { noop: true as const }) }, byte: false }
      }
      case 'reopen': {
        const t = this.threadExists(op.thread, created)
        const evs: NewEvent[] = t?.status === 'resolved' ? [{ type: 'thread.reopen', by: 'Claude', thread: op.thread }] : []
        return { events: evs, result: { ...base, thread: op.thread, ...(evs.length ? {} : { noop: true as const }) }, byte: false }
      }
      case 'edit_comment': {
        validateCommentBody(op.body)
        const m = this.messageOf(op.comment)
        if (m.by !== 'Claude') throw err('NOT_AUTHOR', 'Claude can edit only its own messages')
        return { events: [{ type: 'comment.edit', by: 'Claude', comment: op.comment, body: op.body }], result: { ...base, comment: op.comment, thread: m.t.id }, byte: false }
      }
      case 'delete_comment': {
        const m = this.messageOf(op.comment)
        if (m.by !== 'Claude') throw err('NOT_AUTHOR', 'Claude can delete only its own messages')
        return { events: [{ type: 'comment.delete', by: 'Claude', comment: op.comment }], result: { ...base, comment: op.comment, thread: m.t.id }, byte: false }
      }
      case 'withdraw': {
        const s = this.suggestionOf(op.suggestion)
        const t = suggestionTransition(s, 'suggestion.withdraw', 'Claude')
        if (t === 'duplicate') return { events: [], result: { ...base, suggestion: op.suggestion, thread: s.thread, noop: true }, byte: false }
        if (t !== 'ok') throw err(t, `cannot withdraw ${op.suggestion} (${s.status})`, { suggestion: op.suggestion, thread: s.thread })
        return { events: [{ type: 'suggestion.withdraw', by: 'Claude', suggestion: op.suggestion }], result: { ...base, suggestion: op.suggestion, thread: s.thread }, byte: false }
      }
      case 'decide': {
        const s = this.suggestionOf(op.suggestion)
        const t = suggestionTransition(s, op.decision === 'accept' ? 'suggestion.accept' : 'suggestion.reject', 'Claude')
        if (t === 'duplicate') return { events: [], result: { ...base, suggestion: op.suggestion, thread: s.thread, noop: true }, byte: false }
        if (t !== 'ok') throw err(t, `cannot ${op.decision} ${op.suggestion} (${s.status})`, { suggestion: op.suggestion, thread: s.thread })
        if (op.decision === 'reject') return { events: [{ type: 'suggestion.reject', by: 'Claude', suggestion: op.suggestion }], result: { ...base, suggestion: op.suggestion, thread: s.thread }, byte: false }
        const loc = locate(doc.base, s)
        if (!loc) throw err('SUGGESTION_STALE', `the base of ${op.suggestion} is no longer in the document`, { suggestion: op.suggestion })
        const idx = Array.from({ length: loc.end - loc.start }, (_, k) => loc.start + k)
        this.assertUntouched(doc, idx, `op ${i}`)
        const before = doc.working()
        doc.replace(loc.start, loc.end, s.proposed === '' ? [] : [s.proposed])
        return {
          events: [{ type: 'suggestion.accept', by: 'Claude', suggestion: op.suggestion, resultRev: -1 }],
          result: { ...base, suggestion: op.suggestion, thread: s.thread, changes: this.changesOf(before, doc.working()) },
          byte: true,
        }
      }
      case 'suggest':
      case 'suggest_block': {
        const w = doc.working()
        let body: SuggestionBody
        if (op.op === 'suggest') {
          if (op.quote.length > CONSTANTS.MAX_QUOTE_CHARS) throw err('BAD_REQUEST', 'quote is too long', { hint: 'quote a shorter span, or use --block bN --base-rev R' })
          try {
            const near = op.near ? (w.toWorking[indexOfRef(op.near.ref) ?? 0] ?? indexOfRef(op.near.ref) ?? 0) : undefined
            body = fromQuote(this.md, w.L, { quote: op.quote, replace: op.replace, ...(op.occurrence !== undefined ? { occurrence: op.occurrence } : {}), ...(near !== undefined ? { near } : {}) })
          } catch (e) {
            if (isStoreError(e) && e.code === 'QUOTE_NOT_FOUND' && findQuoteInSource(w.text, op.quote).length === 0) this.quoteMiss(op.quote, w, true)
            throw e
          }
        } else {
          const bi = this.baseIndexOf(op.target, doc)
          const wi = w.toWorking[bi]
          if (wi === null || wi === undefined) throw err('BATCH_SELF_CONFLICT', `base block ${refOf(bi)} was changed by an earlier op in this batch`)
          body = fromBlock(this.md, w.L, wi, op.markdown)
        }
        const baseIdx: number[] = []
        for (let k = body.range.start; k < body.range.end; k++) {
          const b = w.toBase[k]
          if (b === null || b === undefined) throw err('BATCH_SELF_CONFLICT', 'the suggestion targets a block an earlier op in this batch edited or inserted')
          baseIdx.push(b)
        }
        this.assertUntouched(doc, baseIdx, `op ${i}`)
        if (body.base === body.proposed) return { events: [], result: { ...base, noop: true }, byte: false }
        // overlap with another pending suggestion (§6.2 step 2), in base coordinates
        const runStart = doc.base.blocks[baseIdx[0]!]!.start
        const mine = changedSpan(body).map((x) => x + runStart) as [number, number]
        for (const s of this.f.suggestions.values()) {
          if (s.status !== 'pending') continue
          const loc = locate(this.L, s)
          if (!loc) continue
          const theirStart = this.L.blocks[loc.start]!.start
          const theirs = changedSpan(s).map((x) => x + theirStart) as [number, number]
          if (spansOverlap(mine, theirs)) throw err('SUGGESTION_OVERLAP', `overlaps pending suggestion ${s.id}`, { suggestion: s.id, thread: s.thread })
        }
        const ap = applyToSource(this.md, w.L, body)
        if (!ap.verified) throw err('BLOCK_MERGE_HAZARD', 'the suggestion would merge into or change a neighbouring block')
        let thread: ThreadId
        let newThread = true
        if (op.thread) {
          this.threadExists(op.thread, created)
          thread = op.thread
          newThread = false
        } else {
          thread = newThreadId()
          created.add(thread)
        }
        const rev = predictedRev()
        const anchor = this.anchorForHunks(body.hunks, w.L, w.P, rev) ?? createAnchor(w.P, w.L.blocks, w.L.blocks[body.range.start]!.pStart, w.L.blocks[body.range.start]!.pStart, rev)
        for (const b of baseIdx) doc.suggested.add(b)
        const suggestion = newSuggestionId()
        const comment = op.reason !== undefined ? newCommentId() : undefined
        if (op.reason !== undefined) validateCommentBody(op.reason)
        return {
          events: [{
            type: 'suggestion.add', by: 'Claude', thread, newThread, suggestion,
            ...(comment ? { comment, body: op.reason! } : {}),
            anchor, range: { ...body.range, rev }, base: body.base, proposed: body.proposed, hunks: body.hunks,
          } as NewEvent],
          result: { ...base, thread, suggestion, anchor: this.viewOfNew(anchor, doc), hunks: body.hunks.map((h) => ({ del: h.del, ins: h.ins })) },
          byte: false,
        }
      }
      case 'replace_block':
      case 'delete_block':
      case 'insert_after':
      case 'insert_before': {
        const bi = this.baseIndexOf(op.target, doc)
        const before = doc.working()
        if (op.op === 'replace_block' || op.op === 'delete_block') {
          this.assertUntouched(doc, [bi], `op ${i}`)
          if (op.op === 'replace_block') {
            const md = convertEol(op.markdown, eol)
            const cur = doc.base.src.slice(doc.base.blocks[bi]!.start, doc.base.blocks[bi]!.end)
            if (md === cur) return { events: [], result: { ...base, noop: true }, byte: false }
            doc.replace(bi, bi + 1, [md])
          } else doc.replace(bi, bi + 1, [])
        } else {
          if (doc.deletedSet.has(bi)) throw err('BATCH_SELF_CONFLICT', `op ${i} is anchored on base block ${refOf(bi)}, which an earlier op deleted`)
          const md = convertEol(op.markdown, eol)
          doc.insertAt(op.op === 'insert_after' ? doc.afterBoundary(bi) : doc.beforeBoundary(bi), [md])
        }
        return { events: [], result: { ...base, changes: this.changesOf(before, doc.working()) }, byte: true }
      }
      case 'replace_range': {
        const a = this.baseIndexOf(op.from, doc)
        const b = this.baseIndexOf(op.to, doc)
        if (b < a) throw err('BAD_REQUEST', `replace_range: ${refOf(a)} comes after ${refOf(b)}`)
        const idx = Array.from({ length: b - a + 1 }, (_, k) => a + k)
        this.assertUntouched(doc, idx, `op ${i}`)
        const before = doc.working()
        doc.replace(a, b + 1, [convertEol(op.markdown, eol)])
        return { events: [], result: { ...base, changes: this.changesOf(before, doc.working()) }, byte: true }
      }
      case 'write': {
        const next = convertEol(op.markdown, eol)
        if (next === this.text) return { events: [], result: { ...base, noop: true }, byte: false }
        const N = load(this.md, next)
        const wops: BlockOp[] = []
        for (const d of diffBlocks(this.L.blocks, N.blocks)) {
          if (d.op === 'equal') continue
          wops.push({
            after: d.a - 1, before: d.a + d.an, covers: this.L.blocks.slice(d.a, d.a + d.an).map((x) => x.hash),
            blocks: N.blocks.slice(d.b, d.b + d.bn).map((x) => next.slice(x.start, x.end)),
          })
        }
        const before = doc.working()
        doc.setWrite(wops)
        return { events: [], result: { ...base, changes: this.changesOf(before, doc.working()) }, byte: true }
      }
    }
  }

  private viewOfNew(anchor: Anchor, doc: BatchDoc): AnchorView {
    if (anchor.kind === 'doc') return { state: 'doc', block: null, line: null, quote: '' }
    const w = doc.working()
    const b = anchor.hint.block
    const quote = anchor.kind === 'text' ? (anchor.tail !== undefined ? `${anchor.quote} … ${anchor.tail}` : anchor.quote) : anchor.preview
    return { state: 'ok', block: refOf(b), line: w.L.blocks[b]?.line ?? null, quote }
  }

  // =================================================================================== history (§10)

  readonly history: DocStore['history'] = {
    list: (o) => this.serial(() => this.historyList(o)),
    show: (v) => this.serial(() => this.historyShow(v)),
    diff: (from, to) => this.serial(() => this.historyDiff(from, to)),
  }

  private meta(v: FakeVersion): VersionMeta {
    const { text: _t, ...m } = v
    return m
  }

  private historyList(o?: { limit?: number }): HistoryList {
    const all = [...this.versions].reverse().map((v) => this.meta(v))
    const last = this.versions[this.versions.length - 1]
    return {
      ok: true, via: this.via(), file: this.file, versions: o?.limit !== undefined ? all.slice(0, o.limit) : all,
      currentRev: this.curRev, currentHash: this.curHash, unsnapshotted: !last || last.hash !== this.curHash,
    }
  }

  private historyShow(v: VersionId): VersionShow {
    const ver = this.versions.find((x) => x.v === v)
    if (!ver) throw err('VERSION_NOT_FOUND', `version ${v} not found`)
    return { ok: true, via: this.via(), meta: this.meta(ver), markdown: ver.text }
  }

  private refText(ref: HistoryRef): { side: HistoryDiff['from']; text: string; n: number } {
    if (ref === 'current') return { side: { current: true, rev: this.curRev, hash: this.curHash }, text: this.text, n: Infinity }
    if (ref.startsWith('rev:')) {
      const rev = Number(ref.slice(4))
      const h = this.revHashes.get(rev)
      const t = h === undefined ? undefined : this.objects.get(h)
      if (t === undefined || h === undefined) throw err('VERSION_NOT_FOUND', `rev ${rev} is not retained`)
      const ver = this.versions.find((x) => x.hash === h)
      return { side: ver ? this.meta(ver) : { current: true, rev, hash: h }, text: t, n: ver?.n ?? Infinity }
    }
    const ver = this.versions.find((x) => x.v === ref)
    if (!ver) throw err('VERSION_NOT_FOUND', `version ${ref} not found`)
    return { side: this.meta(ver), text: ver.text, n: ver.n }
  }

  private historyDiff(from: HistoryRef, to: HistoryRef): HistoryDiff {
    const a = this.refText(from)
    const b = this.refText(to)
    const between = this.versions.filter((v) => v.n > (a.n === Infinity ? this.versions.length : a.n) && v.n <= (b.n === Infinity ? this.versions.length : b.n))
    const by = [...new Set(between.map((v) => v.by))]
    const lastBy = between.length ? between[between.length - 1]!.by : null
    const La = load(this.md, a.text)
    const Lb = load(this.md, b.text)
    const run = (L: Loaded, src: string, i: number, n: number): string => (n === 0 ? '' : src.slice(L.blocks[i]!.start, L.blocks[i + n - 1]!.end))
    const blocks: DiffBlock[] = []
    for (const d of diffBlocks(La.blocks, Lb.blocks)) {
      if (d.op === 'equal') {
        for (let k = 0; k < d.n; k++) {
          const t = run(La, a.text, d.a + k, 1)
          blocks.push({ op: 'equal', before: t, after: t, by: [], lastBy: null })
        }
        continue
      }
      const before = run(La, a.text, d.a, d.an)
      const after = run(Lb, b.text, d.b, d.bn)
      if (d.op === 'insert') blocks.push({ op: 'insert', after, by, lastBy })
      else if (d.op === 'delete') blocks.push({ op: 'delete', before, by, lastBy })
      else blocks.push({ op: 'replace', before, after, by, lastBy, inline: wordDiff(before, after) })
    }
    return { ok: true, via: this.via(), from: a.side, to: b.side, blocks }
  }
}

/** OpenDocStore over FakeDocStore: reads `<root>/<file>` and persists writes, like the real store. */
export const openFakeDocStore: OpenDocStore = (root, file, opts) =>
  FakeDocStore.create({ root, file, mode: opts.mode, ...(opts.readOnly ? { readOnly: true } : {}) })

export function createFakeDocStore(o: FakeDocStoreOptions): Promise<FakeDocStore> {
  return FakeDocStore.create(o)
}
