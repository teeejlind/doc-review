// node/ledger.ts (P1). The per-doc ledger: cached state, the locked transaction and the commit algorithm (CONTRACTS
// Appendix A, §3.5, §3.6, §3.8, §4.6, §5.4, §6.7, §7.1, §10). The server and CLI direct mode run the same code; the
// DocStore surface (node/docstore.ts) builds CommitSpecs on top of it.
//
// transact(fn), under withDocLock (per-doc mutex, then the file lock):
//   1. refresh the cached view (revalidated by (ino, size, mtimeNs)); a corrupt or future-schema sidecar refuses;
//      a torn tail is truncated (server.recovered torn-tail); dead writers' tmp files are removed
//   2. reconcile (§3.6): in sync | doc.missing | doc.abort not-landed (+ server.recovered wal) | external batch
//      (TJ session flushed first, object written, doc.rev + doc.external + the re-resolution events, history
//      `external`); then the step-9 catch-up (system events missing for the current rev, e.g. after a crash between
//      steps 8 and 9) and the TJ session recovery flush (a session this process did not open, §7.1 `recovery`)
//   3-4. fn validates and builds a CommitSpec; idempotency keys are checked by fn against the fold (step 3)
//   5-9. commit(spec): a byte change that is not a TJ editor save flushes the session ('foreign-write') and versions
//      the pre-write content; the object is written (FAULT after-object); ONE batch is appended with wal on every line
//      (doc.rev + doc.edit unless a TJ editor save + op events + the re-resolution/rebase events computed against the
//      new text) (FAULT mid-append:<n>, after-wal); the disk is re-hashed (changed → doc.abort raced-external, back to
//      step 2, at most 3 rounds, then LOCK_TIMEOUT); tmp + rename (FAULT after-tmp, after-rename); history triggers;
//      the TJ idle timer for TJ saves.
// After unlock the StoreChanges are emitted in seq order (doc before sidecar), with the request's clientId (D32).
//
// Reads never lock (§3.9): `state()` folds the log as of (doc, sidecar), excluding a trailing WAL batch whose hash is
// not the disk's (§4.6). Under the lock, after reconcile, no batch is ever in flight.
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { ulid } from 'ulid'
import type {
  Actor, Anchor, Author, BlockChange, ClientId, DocId, EditSource, FlushReason, Hash, Hunk, NewEvent, ReadOnlyCode,
  Resolution, RevCause, SidecarEvent, SidecarEventOf, SidecarHeader, StoreChange, StoreReviewState, SuggestionId, TextAnchor,
  ThreadId, VersionCause, VersionId, Warning,
} from '../shared/types'
import { CONSTANTS, SIDECAR_SCHEMA } from '../shared/constants'
import { StoreError } from '../shared/errors'
import { CREATED_BY } from '../shared/version'
import type { Md } from '../core/md/index'
import { load, type Loaded } from '../core/splice/load'
import { updateLoaded } from '../core/splice/update'
import { ptextOf, type PText } from '../core/ptext'
import { createAnchor, createBlockAnchor, followBlockAnchor, refreshAnchor, resolveAnchor } from '../core/anchors'
import { blockChanges } from '../core/diff'
import { sha256Hex } from '../core/hash'
import { fold, needsFullRefold, type FoldState, type ThreadFold } from '../core/sidecar/fold'
import { parseSidecar, type ParsedSidecar } from '../core/sidecar/parse'
import { locate, rebase } from '../core/suggest/record'
import { phraseSpan } from '../core/suggest/words'
import { decodeDoc, encodeDoc, readDisk, removeDeadTmps, writeDocAtomic, type DocReadOnly } from './doc-io'
import { fault } from './fault'
import { addVersion, applyRetention, gcObjects, readIndex, readObject, readObjectText, writeObject } from './history'
import { isDocLocked, withDocLock } from './lock'
import { reconcileDisk } from './reconcile'
import { mdrCmd } from './config'
import { nameForAgent } from './identity'
import { appendSidecar, createSidecar, sidecarPathOf, truncateTornTail } from './sidecar-io'

// ===================================================================================== state

export type SideReadOnly = false | { code: Extract<ReadOnlyCode, 'SIDECAR_CORRUPT' | 'SIDECAR_SCHEMA_UNSUPPORTED'>; message: string }

export interface DocState {
  key: string
  missing: boolean
  text: string
  bom: boolean
  hash: Hash
  size: number
  mtimeMs: number
  readOnly: DocReadOnly
  L: Loaded
  P: PText
}

export interface SideState {
  key: string
  exists: boolean
  bytes: number
  parsed: ParsedSidecar | null
  readOnly: SideReadOnly
}

/** The fold as of (doc, sidecar): in-flight exclusion depends on the disk hash, so both keys name it. */
export interface View {
  key: string
  header: SidecarHeader | null
  /** Non-excluded lines (void lines included: the fold skips them, `pending` filters them). Never aliases `parsed`. */
  events: SidecarEvent[]
  f: FoldState
  /** A trailing WAL batch excluded because its hash isn't the disk's (§4.6). */
  inFlight: { rev: number; lines: number } | null
  /** Max rev of any doc.rev ever (void included): the next byte write is 1 + this (§3.5). */
  maxRev: number
  revHashes: Map<number, Hash>
  revBy: Map<number, Actor>
  warnings: Warning[]
  review: StoreReviewState | null
}

export function statKey(p: string): string | null {
  try {
    const st = statSync(p, { bigint: true })
    return `${st.ino}:${st.size}:${st.mtimeNs}`
  } catch {
    return null
  }
}

/**
 * The trailing WAL batch when it is in flight against `diskHash` (§4.6): the run of last lines sharing one wal.rev,
 * carrying its own doc.rev, whose wal.hash is not the disk's. A doc.abort after it breaks the run, so an aborted batch
 * is never "in flight" (the fold voids it instead).
 */
export function trailingInFlight(events: readonly SidecarEvent[], diskHash: Hash | null): { rev: number; from: number } | null {
  const last = events[events.length - 1]
  if (!last?.wal) return null
  const rev = last.wal.rev
  let from = events.length
  while (from > 0 && events[from - 1]!.wal?.rev === rev) from--
  if (!events.slice(from).some((e) => e.type === 'doc.rev')) return null
  if (diskHash !== null && last.wal.hash === diskHash) return null
  return { rev, from }
}

/**
 * Where to cut a torn tail (§4.6): the end of the last good line, moved back over the complete lines of the same batch,
 * so a partial multi-line batch never survives as a shorter batch. One commit stamps all its lines with one `at` and
 * ids sharing one ULID time prefix; the torn fragment names its batch by either (the id comes within the first ~30
 * bytes of a line). A fragment too short to carry either is cut alone. The header is never cut.
 */
export function tornBatchStart(path: string, validBytes: number): number {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return validBytes
  }
  const tail = buf.subarray(validBytes).toString('utf8')
  const at = /"at":"([^"]+)"/.exec(tail)?.[1]
  const prefix = /"id":"(e_[0-9A-HJKMNP-TV-Z]{10})/.exec(tail)?.[1]
  if (!at && !prefix) return validBytes
  const sameBatch = (l: string): boolean => (at ? l.includes(`"at":"${at}"`) : l.includes(`"id":"${prefix}`))
  const lines = buf.subarray(0, validBytes).toString('utf8').split('\n')
  lines.pop()
  let off = validBytes
  for (let k = lines.length - 1; k >= 1; k--) {
    const l = lines[k]!
    if (!sameBatch(l)) break
    off -= Buffer.byteLength(l, 'utf8') + 1
  }
  return off
}

// ===================================================================================== commit spec

/** TJ editor saves (D6): they extend the TJ session and carry no doc.edit of their own. */
export const TJ_EDITOR_CAUSES: ReadonlySet<RevCause> = new Set(['save', 'merge', 'recreate'])

export interface CommitSpec {
  /** Op events, given the rev in effect after the commit (resultRev, anchors). Pure: may run more than once. */
  events: (rev: number) => NewEvent[]
  /** Idempotency key put on every op line that has none (§4.7). */
  key?: string
  /** Key for the doc.rev / doc.edit lines (default `key`; a batch passes its single byte op's key or none). */
  revKey?: string | null
  /** New text; a change of bytes appends doc.rev (+ doc.edit unless a TJ editor save). */
  text?: string
  /** Recreate a missing file (§3.6): `baseText` is object(lastHash) and the bytes are written even if equal. */
  recreate?: { baseText: string; baseL: Loaded }
  by?: Actor
  cause?: RevCause
  edit?: { source: EditSource; cause?: { type: 'suggestion.accept' | 'suggestion.reopen' | 'restore'; id: string } }
  clientId?: ClientId
  saveId?: number
  /** History version recorded after a byte write (§10). */
  version?: { cause: VersionCause; by: Actor; restoredFrom?: VersionId }
  /** Pre-built Loaded for `text` (saves it a parse). */
  textL?: Loaded
}

export interface CommitResult {
  seq: number
  rev: number
  hash: Hash
  /** Every line this commit appended (its own batch and the system lines), in seq order. */
  events: SidecarEvent[]
  changes: BlockChange[]
  bytesChanged: boolean
  staled: SuggestionId[]
  rebased: SuggestionId[]
  detached: ThreadId[]
  warnings: Warning[]
  version: import('../shared/types').VersionMeta | null
}

export interface SystemPass {
  events: NewEvent[]
  staled: SuggestionId[]
  rebased: SuggestionId[]
  detached: ThreadId[]
  warnings: Warning[]
}

const RACED = Symbol('raced-external')
const MAX_RACE_ROUNDS = 3

let idleFlushMs: number = CONSTANTS.EDIT_SESSION_IDLE_MS
/** Test-only: the TJ session idle flush delay (§7.1 `idle`). */
export function setIdleFlushMsForTests(ms: number | null): void {
  idleFlushMs = ms ?? CONSTANTS.EDIT_SESSION_IDLE_MS
}

const nowIso = (): string => new Date().toISOString()
const RESULT_CACHE_MAX = 512

// ===================================================================================== the ledger

export class Ledger {
  readonly root: string
  readonly file: string
  readonly abs: string
  readonly mode: 'server' | 'direct'
  protected readonly readOnlyStore: boolean
  protected readonly lockTimeoutMs: number
  protected readonly md: Md
  protected readonly sidecarPath: string
  protected doc: DocState | null = null
  protected side: SideState | null = null
  protected view: View | null = null
  protected readonly listeners = new Set<(c: StoreChange) => void>()
  /** Revs whose rename this process completed (§3.6 "this process did not itself complete T's rename"). */
  protected readonly renamedRevs = new Set<number>()
  /**
   * Under the lock, after reconcile ruled the trailing WAL batch of this rev landed (the "external" row of §3.6: the
   * disk moved on past it), the view keeps that batch instead of excluding it as in flight. Only unlocked readers
   * exclude a trailing batch whose hash isn't the disk's (§4.6); a writer that has reconciled knows better.
   */
  private landedRev: number | null = null
  /** The rev whose step-9 re-resolution this process completed (Appendix A, catch-up). */
  protected systemRev: number | null = null
  /** baseRev of the TJ session this store extended (a session it didn't open is recovered, §7.1). */
  protected ownSession: number | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Original results by idempotency key, for exact replays inside this process (the log is the durable fallback). */
  protected readonly results = new Map<string, unknown>()
  private readonly loadCache = new Map<Hash, Loaded>()
  protected closed = false
  /**
   * Server mode only (§8.6, §3.6): what this process has already told its listeners. `seq`/`docId`: lines past them were
   * appended by another process (a direct-mode CLI write) and are emitted by the next transaction's catch-up. `keys`:
   * the (doc, sidecar) stat keys after the last transaction, so a watcher event for our own write costs no lock.
   * `hash`: the doc hash then. `doc`: the bytes of a doc with no sidecar yet, so an external edit or delete of it can be
   * recorded against them (the ledger materializes with them as the baseline). null = not tracking (direct, read-only).
   */
  private seen: { seq: number; docId: DocId | null; keys: string; hash: Hash; doc: { hash: Hash; text: string; bom: boolean } | null } | null = null
  /** Set once the current transaction round has emitted the foreign lines (markSeen may then advance `seen`). */
  private caughtUp = false

  constructor(root: string, file: string, abs: string, o: { mode: 'server' | 'direct'; readOnly: boolean; lockTimeoutMs: number }, md: Md) {
    this.root = root
    this.file = file
    this.abs = abs
    this.mode = o.mode
    this.readOnlyStore = o.readOnly
    this.lockTimeoutMs = o.lockTimeoutMs
    this.md = md
    this.sidecarPath = sidecarPathOf(abs)
  }

  // ----------------------------------------------------------------------------------- loading (lock-free)

  protected loadDoc(): DocState {
    const key = statKey(this.abs) ?? 'missing'
    if (this.doc && this.doc.key === key) return this.doc
    if (key === 'missing') {
      const L = load(this.md, '')
      this.doc = { key, missing: true, text: '', bom: false, hash: sha256Hex(''), size: 0, mtimeMs: 0, readOnly: false, L, P: ptextOf(L.doc, L) }
      return this.doc
    }
    let raw: Buffer
    let mtimeMs: number
    try {
      raw = readFileSync(this.abs)
      mtimeMs = statSync(this.abs).mtimeMs
    } catch {
      this.doc = null
      return this.loadDocMissing()
    }
    const d = decodeDoc(raw, this.file)
    const text = d.text ?? ''
    const prev = this.doc && !this.doc.missing && this.doc.readOnly === false ? this.doc.L : undefined
    const L = this.loadCached(text, prev)
    this.doc = {
      key, missing: false, text, bom: d.bom, hash: sha256Hex(new Uint8Array(raw)),
      size: raw.length, mtimeMs, readOnly: d.readOnly, L, P: ptextOf(L.doc, L),
    }
    return this.doc
  }

  private loadDocMissing(): DocState {
    const L = load(this.md, '')
    this.doc = { key: 'missing', missing: true, text: '', bom: false, hash: sha256Hex(''), size: 0, mtimeMs: 0, readOnly: false, L, P: ptextOf(L.doc, L) }
    return this.doc
  }

  protected loadSide(): SideState {
    const key = statKey(this.sidecarPath) ?? 'absent'
    if (this.side && this.side.key === key) return this.side
    if (key === 'absent') {
      this.side = { key, exists: false, bytes: 0, parsed: null, readOnly: false }
      return this.side
    }
    let buf: Buffer
    try {
      buf = readFileSync(this.sidecarPath)
    } catch {
      this.side = { key: 'absent', exists: false, bytes: 0, parsed: null, readOnly: false }
      return this.side
    }
    const parsed = parseSidecar(buf.toString('utf8'))
    let readOnly: SideReadOnly = false
    if (parsed.schemaUnsupported !== null) {
      readOnly = { code: 'SIDECAR_SCHEMA_UNSUPPORTED', message: `sidecar schema ${parsed.schemaUnsupported} is not supported by mdr 2` }
    } else if (parsed.corrupt) {
      readOnly = { code: 'SIDECAR_CORRUPT', message: `sidecar line ${parsed.corrupt.line}: ${parsed.corrupt.reason}` }
    }
    this.side = { key, exists: true, bytes: buf.length, parsed, readOnly }
    return this.side
  }

  /** Revalidate both caches by stat and return the current (doc, sidecar, view). */
  protected state(): { d: DocState; s: SideState; v: View } {
    const d = this.loadDoc()
    const s = this.loadSide()
    const key = `${d.key}|${s.key}`
    if (this.view && this.view.key === key) return { d, s, v: this.view }
    const all = s.readOnly && s.readOnly.code === 'SIDECAR_SCHEMA_UNSUPPORTED' ? [] : (s.parsed?.events ?? [])
    const trailing = d.missing ? null : trailingInFlight(all, d.hash)
    const inFlight = trailing && trailing.rev === this.landedRev ? null : trailing
    const events = inFlight ? all.slice(0, inFlight.from) : all.slice()
    const f = fold(events)
    const warnings: Warning[] = [...(s.parsed?.warnings ?? [])]
    if (s.readOnly && s.readOnly.code === 'SIDECAR_CORRUPT' && s.parsed?.corrupt) {
      warnings.push({ code: 'SIDECAR_INVALID_EVENT', message: `line ${s.parsed.corrupt.line}: ${s.parsed.corrupt.reason}`, line: s.parsed.corrupt.line })
    }
    let maxRev = 0
    const revHashes = new Map<number, Hash>()
    const revBy = new Map<number, Actor>()
    for (const e of all) {
      if (e.type !== 'doc.rev') continue
      if (e.rev > maxRev) maxRev = e.rev
      if (inFlight && e.wal?.rev === inFlight.rev) continue
      if (e.wal && f.voidRevs.has(e.wal.rev)) continue
      revHashes.set(e.rev, e.hash)
      revBy.set(e.rev, e.by)
    }
    this.view = {
      key, header: s.parsed?.header ?? null, events, f,
      inFlight: inFlight ? { rev: inFlight.rev, lines: all.length - inFlight.from } : null,
      maxRev, revHashes, revBy, warnings, review: null,
    }
    return { d, s, v: this.view }
  }

  protected invalidate(): void {
    this.doc = null
    this.side = null
    this.view = null
  }

  /**
   * load(md, text), cached by text hash. With `base` (a Loaded of a nearby text) the incremental updateLoaded runs
   * instead, which equals load() (gate G2) and re-classifies only the changed region.
   */
  protected loadCached(text: string, base?: Loaded): Loaded {
    const d = this.doc
    if (d && !d.missing && d.readOnly === false && d.text === text) return d.L
    const h = sha256Hex(text)
    const hit = this.loadCache.get(h)
    if (hit) return hit
    const L = base && base.src !== text ? updateLoaded(this.md, base, text, []) : load(this.md, text)
    this.cacheLoaded(h, L)
    return L
  }

  private cacheLoaded(h: Hash, L: Loaded): void {
    this.loadCache.set(h, L)
    if (this.loadCache.size > 8) this.loadCache.delete(this.loadCache.keys().next().value!)
  }

  /** Decoded text of a rev's bytes by doc hash: the current doc, else its object; null when gone. */
  protected textOfHash(hash: Hash): string | null {
    const d = this.doc
    if (d && !d.missing && d.readOnly === false && d.hash === hash) return d.text
    return readObjectText(this.abs, hash)?.text ?? null
  }

  /** Actor of the last non-void doc.rev ('external' when there is none). */
  protected lastRevBy(v: View): Actor {
    let by: Actor = 'external'
    for (const e of v.events) if (e.type === 'doc.rev' && !(e.wal && v.f.voidRevs.has(e.wal.rev))) by = e.by
    return by
  }

  /** The last non-void doc.rev line. */
  protected lastRev(v: View): SidecarEventOf<'doc.rev'> | null {
    for (let k = v.events.length - 1; k >= 0; k--) {
      const e = v.events[k]!
      if (e.type === 'doc.rev' && !(e.wal && v.f.voidRevs.has(e.wal.rev))) return e
    }
    return null
  }

  /**
   * The highest seq in the file: the fold's, or a later line the view doesn't fold (an in-flight batch, a skipped
   * forward-compatible line). New lines always number from here, so a seq is never reused.
   */
  protected trueSeq(): number {
    const { s, v } = this.state()
    return Math.max(v.f.seq, s.parsed?.lastSeq ?? 0)
  }

  /** The TJ session when its net change is non-empty (a session whose last hash is its base nets to nothing). */
  protected liveSession(v: View): FoldState['tjSession'] {
    const s = v.f.tjSession
    if (!s) return null
    const last = v.revHashes.get(s.lastRev)
    return last !== undefined && last !== s.baseHash ? s : null
  }

  protected async needsRecovery(v: View): Promise<boolean> {
    if (v.inFlight && !(await isDocLocked(this.abs))) return true
    const s = this.liveSession(v)
    return s !== null && this.ownSession !== s.baseRev
  }

  protected emit(changes: readonly StoreChange[]): void {
    for (const c of changes) {
      for (const cb of [...this.listeners]) {
        try {
          cb(c)
        } catch {
          // a listener's failure never breaks a commit
        }
      }
    }
  }

  protected remember(key: string, result: unknown): void {
    this.results.set(key, result)
    if (this.results.size > RESULT_CACHE_MAX) this.results.delete(this.results.keys().next().value!)
  }

  // ----------------------------------------------------------------------------------- the transaction

  /**
   * Run `fn` under the doc lock after refresh, reconcile, the step-9 catch-up and the TJ session recovery. `fn` gets
   * the emission list to pass to commit / flush. A raced external write re-runs the whole round (at most 3).
   */
  protected async transact<T>(fn: (emits: StoreChange[]) => T | Promise<T>): Promise<T> {
    if (this.readOnlyStore) throw new StoreError('READ_ONLY', `${this.file}: this store was opened read-only`)
    if (this.closed) throw new StoreError('INTERNAL', `${this.file}: the store is closed`)
    const emits: StoreChange[] = []
    try {
      return await withDocLock(this.abs, this.lockTimeoutMs, async () => {
        for (let round = 1; ; round++) {
          this.caughtUp = false
          try {
            await this.prepare(emits)
            return await fn(emits)
          } catch (e) {
            if (e !== RACED) throw e
            this.invalidate()
            if (round >= MAX_RACE_ROUNDS) {
              throw new StoreError('LOCK_TIMEOUT', `${this.file} kept changing on disk during the write (${MAX_RACE_ROUNDS} attempts)`, {
                hint: 'retry once the other writer is done',
              })
            }
          } finally {
            // still under the lock: everything in the log now has been emitted (ours by `emits`, foreign by catch-up)
            if (this.caughtUp) this.markSeen()
          }
        }
      })
    } catch (e) {
      // a failure after writes began leaves the caches unreliable; the next read re-reads both files
      if (!(e instanceof StoreError) || e.code === 'IO_ERROR' || e.code === 'INTERNAL' || e.code === 'LOCK_TIMEOUT') this.invalidate()
      throw e
    } finally {
      this.emit(emits)
    }
  }

  /** Steps 1-2 of Appendix A plus the catch-up re-resolution and the TJ session recovery. */
  private async prepare(emits: StoreChange[]): Promise<void> {
    let { s } = this.state()
    if (s.readOnly) throw new StoreError(s.readOnly.code, s.readOnly.message, { hint: `run ${mdrCmd()} doctor ${this.file}` })
    this.catchUpForeign(emits)
    ;({ s } = this.state())
    if (s.exists && s.parsed?.tornTail) {
      const cut = truncateTornTail(this.sidecarPath, tornBatchStart(this.sidecarPath, s.parsed.validBytes))
      this.side = null
      this.view = null
      ;({ s } = this.state())
      if (s.readOnly) throw new StoreError(s.readOnly.code, s.readOnly.message, { hint: `run ${mdrCmd()} doctor ${this.file}` })
      if (!s.parsed?.header) {
        // the creating write died inside its header line: nothing was ever recorded, so the sidecar never existed
        unlinkSync(this.sidecarPath)
        this.side = null
        this.view = null
      } else {
        this.appendSystem([{ type: 'server.recovered', by: 'system', what: 'torn-tail', detail: `truncated ${cut} bytes of a torn final line` }], emits)
      }
    }
    removeDeadTmps(this.abs)
    this.materializeSeen(emits)
    await this.reconcileNow(emits)
    const { d, s: s2, v } = this.state()
    if (s2.exists && !d.missing && d.readOnly === false && this.systemRev !== v.f.rev) {
      const sys = this.systemEvents(v.f, d.L, d.P, v.f.rev, null)
      if (sys.events.length) this.appendSystem(sys.events, emits)
      this.systemRev = this.state().v.f.rev
    }
    const v2 = this.state().v
    const sess = this.liveSession(v2)
    if (sess && this.ownSession !== sess.baseRev) this.flushSessionNow('recovery', emits)
  }

  /** §3.6 reconcile, applied. */
  protected async reconcileNow(emits: StoreChange[]): Promise<void> {
    const { s } = this.state()
    if (!s.exists || !s.parsed) return
    const all = s.parsed.events
    const cur = this.state().v
    const full = cur.inFlight ? fold(all) : cur.f
    let T: SidecarEventOf<'doc.rev'> | null = null
    let tIdx = -1
    for (let k = all.length - 1; k >= 0; k--) {
      const e = all[k]!
      if (e.type === 'doc.rev' && !(e.wal && full.voidRevs.has(e.wal.rev))) {
        T = e
        tIdx = k
        break
      }
    }
    const missingRecorded = tIdx >= 0 && all.slice(tIdx + 1).some((e) => e.type === 'doc.missing')
    const verdict = await reconcileDisk(this.abs, { T, tAborted: false, missingRecorded }, this.renamedRevs)
    switch (verdict.kind) {
      case 'in-sync': {
        const d = this.loadDoc()
        if (!d.missing && d.hash !== verdict.disk.hash) {
          this.doc = null
          this.view = null
        }
        return
      }
      case 'missing':
        this.doc = null
        this.view = null
        if (verdict.alreadyRecorded) return
        this.appendSystem([{ type: 'doc.missing', by: 'external', lastHash: verdict.lastHash }], emits, { removed: true })
        return
      case 'not-landed':
        this.appendSystem([
          { type: 'doc.abort', by: 'system', abortedRev: verdict.abortedRev, reason: 'not-landed' },
          { type: 'server.recovered', by: 'system', what: 'wal', detail: `rev ${verdict.abortedRev} never landed on disk; its batch is void` },
        ], emits)
        return
      case 'external':
        this.doc = null
        this.view = null
        // T's batch landed and the disk moved on: record the external rev against T (prevRev T.rev, §3.6), after
        // flushing a TJ session that T may have extended
        this.landedRev = T?.wal ? T.wal.rev : null
        try {
          this.recordExternal(emits)
        } finally {
          this.landedRev = null
          this.view = null
        }
        return
    }
  }

  /** §3.6 "Anything else": the disk holds bytes the ledger never wrote. */
  private recordExternal(emits: StoreChange[]): void {
    this.flushSessionNow('foreign-write', emits)
    const { d, v } = this.state()
    const T = this.lastRev(v)
    const prevRev = T?.rev ?? v.f.rev
    const prevHash = T?.hash ?? v.f.hash
    const raw = readFileSync(this.abs)
    const hash = sha256Hex(new Uint8Array(raw))
    writeObject(this.abs, hash, raw)
    const newRev = v.maxRev + 1
    const oldText = prevHash ? this.textOfHash(prevHash) : null
    const textual = d.readOnly === false
    const changes = textual && oldText !== null ? blockChanges(this.loadCached(oldText, d.L), d.L) : null
    const fromSeq = this.trueSeq()
    const batch: NewEvent[] = [
      { type: 'doc.rev', by: 'external', prevRev, prevHash, hash, bytes: raw.length, cause: 'external' } as NewEvent,
      { type: 'doc.external', by: 'external', fromRev: prevRev, toRev: newRev, changes },
    ]
    let seq = fromSeq
    const at = nowIso()
    const head = this.stamp(batch, newRev, () => ++seq, { at })
    let sys: SystemPass = { events: [], staled: [], rebased: [], detached: [], warnings: [] }
    if (textual) sys = this.systemEvents(fold(head, v.f), d.L, d.P, newRev, changes)
    const lines = [...head, ...this.stamp(sys.events, newRev, () => ++seq, { at })]
    const bytes = appendSidecar(this.sidecarPath, lines)
    this.adopt(lines, bytes)
    this.systemRev = newRev
    if (textual) {
      this.version({ cause: 'external', by: 'external', rev: newRev, revs: [newRev, newRev], hash, raw, text: d.text })
    }
    emits.push({ kind: 'doc', rev: newRev, prevRev, hash, by: 'external', cause: 'external', changes: changes ?? [] })
    emits.push({ kind: 'sidecar', fromSeq, seq: this.state().v.f.seq, events: lines })
  }

  // ----------------------------------------------------------------------------------- foreign writes (server, §3.6, §8.6)

  /** Highest seq of the folded (non-in-flight) lines. */
  private static topSeq(v: View): number {
    return v.events.length ? v.events[v.events.length - 1]!.seq : 0
  }

  /**
   * Server mode: start tracking what listeners have been told, as of now (store open). Nothing already in the log is
   * replayed; a write in flight right now is folded later and emitted by catch-up then.
   */
  protected startTracking(): void {
    if (this.mode !== 'server' || this.readOnlyStore) return
    this.markSeen()
  }

  /** Under the lock, at the end of a transaction round (and at open): the log, the doc and the keys as now known. */
  private markSeen(): void {
    if (this.mode !== 'server' || this.readOnlyStore) return
    const { d, s, v } = this.state()
    this.seen = {
      seq: Ledger.topSeq(v),
      docId: v.header?.docId ?? null,
      keys: `${d.key}|${s.key}`,
      hash: d.hash,
      doc: !s.exists && !d.missing && d.readOnly === false ? { hash: d.hash, text: d.text, bom: d.bom } : null,
    }
  }

  /**
   * Lines another process appended since this process last emitted (a direct-mode CLI write the server adopts by hash,
   * §9.3, or another process's reconcile): one doc change per new non-void doc.rev that moved the bytes, `removed` for
   * a doc.missing, and one sidecar change covering them all, so SSE and HandoffDeps.onSidecarAppended see every append
   * whoever wrote it. A replaced or deleted sidecar (new docId, row 29) re-emits from seq 0.
   */
  private catchUpForeign(emits: StoreChange[]): void {
    this.caughtUp = true
    const seen = this.seen
    if (!seen) return
    const { v } = this.state()
    const docId = v.header?.docId ?? null
    const reset = docId !== seen.docId && seen.docId !== null
    const from = reset ? 0 : seen.seq
    const lines = v.events.filter((e) => e.seq > from)
    if (!lines.length && !reset) return
    for (const e of lines) {
      if (e.type === 'doc.missing') emits.push({ kind: 'removed' })
      if (e.type !== 'doc.rev' || e.cause === 'baseline' || (e.wal && v.f.voidRevs.has(e.wal.rev))) continue
      const edit = lines.find((x): x is SidecarEventOf<'doc.edit'> | SidecarEventOf<'doc.external'> =>
        (x.type === 'doc.edit' || x.type === 'doc.external') && x.toRev === e.rev)
      emits.push({ kind: 'doc', rev: e.rev, prevRev: e.prevRev ?? 0, hash: e.hash, by: e.by, cause: e.cause, changes: edit?.changes ?? [] })
    }
    emits.push({ kind: 'sidecar', fromSeq: from, seq: lines.length ? lines[lines.length - 1]!.seq : 0, events: lines })
    this.seen = { ...seen, seq: Ledger.topSeq(v), docId }
  }

  /**
   * A doc with no sidecar yet changed or vanished on disk since this process last saw it: create the ledger with the
   * bytes it saw as the baseline (header + doc.rev baseline + object + history), so reconcile then records the change
   * as `doc.external` or `doc.missing` against them, exactly as for a recorded doc (§3.6, row 8: never TJ).
   */
  private materializeSeen(emits: StoreChange[]): void {
    const seen = this.seen
    if (!seen?.doc) return
    const { d, s } = this.state()
    if (s.exists || (!d.missing && d.hash === seen.doc.hash)) return
    const raw = encodeDoc(seen.doc.text, seen.doc.bom)
    writeObject(this.abs, seen.doc.hash, raw)
    this.version({ cause: 'baseline', by: 'external', rev: 1, revs: [1, 1], hash: seen.doc.hash, raw, text: seen.doc.text })
    const header: SidecarHeader = { type: 'header', schema: SIDECAR_SCHEMA, docId: `d_${ulid()}` as DocId, file: basename(this.abs), createdAt: nowIso(), createdBy: CREATED_BY }
    let seq = 0
    const lines = this.stamp([{ type: 'doc.rev', by: 'system', prevRev: null, prevHash: null, hash: seen.doc.hash, bytes: raw.length, cause: 'baseline' } as NewEvent], 1, () => ++seq, {})
    const bytes = createSidecar(this.sidecarPath, header, lines)
    this.adopt(lines, bytes, { header })
    this.systemRev = 1
    emits.push({ kind: 'sidecar', fromSeq: 0, seq: 1, events: lines })
    this.seen = { ...seen, seq: 1, docId: header.docId, doc: null }
  }

  /**
   * The watcher's hook (§3.6 "on every watcher event for an opened doc"): when the doc or the sidecar changed on disk
   * since this process's last transaction, run an empty transaction, whose prepare adopts foreign lines and reconciles.
   * Our own writes leave the keys equal, so they cost nothing. A corrupt or future-schema sidecar can't be written:
   * a changed doc is then announced without being recorded.
   */
  async watchTick(): Promise<void> {
    const seen = this.seen
    if (!seen || this.closed) return
    const { d, s, v } = this.state()
    if (`${d.key}|${s.key}` === seen.keys) return
    if (s.readOnly) {
      if (d.hash !== seen.hash && !d.missing) {
        this.emit([{ kind: 'doc', rev: v.f.rev, prevRev: v.f.rev, hash: d.hash, by: 'external', cause: 'external', changes: [] }])
      }
      this.seen = { ...seen, keys: `${d.key}|${s.key}`, hash: d.hash }
      return
    }
    await this.transact(() => undefined).catch(() => undefined)
  }

  /** Server fan-out: the decoded text of a rev by doc hash (the current doc or its object); null when gone. */
  textAt(hash: Hash): string | null {
    try {
      return this.textOfHash(hash)
    } catch {
      return null
    }
  }

  /** Server fan-out: where the log stands now (SSE `id:` = rev.seq, and a docId change means a reset sidecar). */
  cursor(): { rev: number; seq: number; docId: DocId | null } {
    const { s, v } = this.state()
    return { rev: v.f.rev, seq: Math.max(v.f.seq, s.parsed?.lastSeq ?? 0), docId: v.header?.docId ?? null }
  }

  // ----------------------------------------------------------------------------------- appending

  /** Stamp NewEvents into lines: consecutive seqs, ids, `at`, `rev`, the key on lines without one, and the wal. */
  protected stamp(batch: readonly NewEvent[], rev: number, nextSeq: () => number, o: { key?: string | null; wal?: { rev: number; hash: Hash }; at?: string }): SidecarEvent[] {
    const at = o.at ?? nowIso()
    // every line of one batch shares `at` and the ULID time prefix of its id, which is how a torn tail's partial batch
    // is recognized and rolled back whole (tornBatchStart)
    const t = Date.parse(at)
    return batch.map((e) => {
      const { type, by, key, ...rest } = e as NewEvent & { key?: string }
      const k = key ?? o.key ?? undefined
      return {
        seq: nextSeq(), id: `e_${ulid(t)}`, type, by, at, rev,
        ...(k !== undefined && k !== null ? { key: k } : {}),
        ...(o.wal ? { wal: o.wal } : {}),
        ...rest,
      } as unknown as SidecarEvent
    })
  }

  /**
   * Fold our own appended lines into the caches without re-reading: the sidecar grew by `bytes`, and, after a rename,
   * the doc is `doc`. Anything inconsistent drops the cache instead (the next state() re-reads).
   */
  protected adopt(lines: readonly SidecarEvent[], bytes: number, o: { header?: SidecarHeader; doc?: { text: string; bom: boolean; hash: Hash; size: number; L: Loaded; P?: PText } } = {}): void {
    // the view may be updated in place only if it was built from exactly the caches this append extends
    const viewWasCurrent = !!this.view && !!this.doc && !!this.side && this.view.key === `${this.doc.key}|${this.side.key}`
    const skey = statKey(this.sidecarPath)
    const side = this.side
    if (side && side.exists && side.parsed && !o.header && skey) {
      side.parsed.events.push(...lines)
      side.parsed.lines += lines.length
      side.parsed.lastSeq = lines.length ? lines[lines.length - 1]!.seq : side.parsed.lastSeq
      side.parsed.validBytes += bytes
      side.bytes += bytes
      side.key = skey
    } else this.side = null
    if (o.doc) {
      const dkey = statKey(this.abs)
      if (dkey) {
        let mtimeMs = Date.now()
        try {
          mtimeMs = statSync(this.abs).mtimeMs
        } catch {
          // stat raced a delete; the next read notices
        }
        this.doc = { key: dkey, missing: false, text: o.doc.text, bom: o.doc.bom, hash: o.doc.hash, size: o.doc.size, mtimeMs, readOnly: false, L: o.doc.L, P: o.doc.P ?? ptextOf(o.doc.L.doc, o.doc.L) }
        this.cacheLoaded(sha256Hex(o.doc.text), o.doc.L)
      } else this.doc = null
    }
    const v = this.view
    if (!v || !viewWasCurrent || !this.side || !this.doc) {
      this.view = null
      return
    }
    v.events.push(...lines)
    v.f = needsFullRefold(v.f, lines) ? fold(v.events) : fold(lines, v.f)
    for (const e of lines) {
      if (e.type !== 'doc.rev') continue
      if (e.rev > v.maxRev) v.maxRev = e.rev
      if (e.wal && v.f.voidRevs.has(e.wal.rev)) continue
      v.revHashes.set(e.rev, e.hash)
      v.revBy.set(e.rev, e.by)
    }
    for (const e of lines) {
      if (e.type === 'doc.abort') {
        v.revHashes.delete(e.abortedRev)
        v.revBy.delete(e.abortedRev)
      }
    }
    v.inFlight = null
    v.review = null
    v.key = `${this.doc.key}|${this.side.key}`
  }

  /** Append a sidecar-only batch (no wal) at the current rev and emit it. */
  protected appendSystem(batch: readonly NewEvent[], emits: StoreChange[], o: { key?: string; clientId?: ClientId; removed?: boolean } = {}): SidecarEvent[] {
    if (!batch.length) return []
    const { v } = this.state()
    const fromSeq = this.trueSeq()
    let seq = fromSeq
    const lines = this.stamp(batch, v.f.rev, () => ++seq, o.key !== undefined ? { key: o.key } : {})
    const bytes = appendSidecar(this.sidecarPath, lines)
    this.adopt(lines, bytes)
    if (o.removed) emits.push({ kind: 'removed' })
    emits.push({ kind: 'sidecar', fromSeq, seq: lines[lines.length - 1]!.seq, events: lines, ...(o.clientId ? { clientId: o.clientId } : {}) })
    return lines
  }

  // ----------------------------------------------------------------------------------- history

  protected version(nv: { cause: VersionCause; by: Actor; rev: number; revs: [number, number]; hash: Hash; raw: Buffer; text: string; restoredFrom?: VersionId }): import('../shared/types').VersionMeta | null {
    return addVersion(this.md, this.abs, nv, { prevText: (h) => this.textOfHash(h), loadOf: (text, base) => this.loadCached(text, base) })
  }

  /** §10 'pre-write': before a write, version the current content when it has no version yet. */
  protected ensurePreWrite(): void {
    const { d, v } = this.state()
    if (d.missing || d.readOnly !== false) return
    const { versions } = readIndex(this.abs)
    const last = versions[versions.length - 1]
    if (last && last.hash === d.hash) return
    this.version({ cause: 'pre-write', by: this.lastRevBy(v), rev: v.f.rev, revs: [v.f.rev, v.f.rev], hash: d.hash, raw: encodeDoc(d.text, d.bom), text: d.text })
  }

  // ----------------------------------------------------------------------------------- TJ session (§7.1, D6)

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  protected armIdle(): void {
    this.clearIdle()
    if (this.mode !== 'server' || idleFlushMs <= 0 || this.closed) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.flushTjSessionLocked('idle').catch(() => undefined)
    }, idleFlushMs)
    this.idleTimer.unref?.()
  }

  /** The public flush (DocStore.flushTjSession): a transaction of its own. */
  protected async flushTjSessionLocked(reason: FlushReason): Promise<void> {
    if (this.readOnlyStore || this.closed) return
    const { s, d } = this.state()
    if (s.readOnly || d.readOnly !== false || !s.exists) return
    await this.transact((emits) => {
      this.flushSessionNow(reason, emits)
    })
  }

  /**
   * Flush the TJ session: one doc.edit { source: 'editor' } covering every TJ save, merge and recreate rev since the
   * session base (net block changes, windowed BlockSides), plus a history version. A session whose net change is empty
   * appends nothing. `recovery` adds server.recovered { what: 'tj-session' } (§7.1 crash recovery).
   */
  protected flushSessionNow(reason: FlushReason, emits: StoreChange[]): SidecarEvent[] {
    const { v } = this.state()
    const sess = this.liveSession(v)
    if (!sess) {
      this.clearIdle()
      return []
    }
    const lastHash = v.revHashes.get(sess.lastRev)!
    const before = this.textOfHash(sess.baseHash)
    const after = this.textOfHash(lastHash)
    const afterL = after !== null ? this.loadCached(after) : null
    const changes = before !== null && afterL !== null ? blockChanges(this.loadCached(before, afterL), afterL) : []
    const batch: NewEvent[] = []
    if (reason === 'recovery') {
      batch.push({ type: 'server.recovered', by: 'system', what: 'tj-session', detail: `flushed ${nameForAgent()}'s editing session of revs ${sess.baseRev + 1}..${sess.lastRev} left open by an earlier process` })
    }
    batch.push({ type: 'doc.edit', by: 'TJ', source: 'editor', fromRev: sess.baseRev, toRev: sess.lastRev, changes })
    const lines = this.appendSystem(batch, emits)
    this.clearIdle()
    this.ownSession = null
    if (after !== null) {
      const first = v.f.docLog.find((x) => x.type === 'doc.rev' && x.rev > sess.baseRev && x.by === 'TJ')?.rev ?? sess.lastRev
      const raw = readObject(this.abs, lastHash) ?? encodeDoc(after, this.doc?.bom ?? false)
      this.version({ cause: reason === 'shutdown' ? 'shutdown' : 'tj-session', by: 'TJ', rev: sess.lastRev, revs: [first, sess.lastRev], hash: lastHash, raw, text: after })
    }
    return lines
  }

  // ----------------------------------------------------------------------------------- step 9: re-resolution

  protected anchorForHunks(hunks: readonly Hunk[], L: Loaded, P: PText, rev: number): TextAnchor | null {
    // the card quotes the whole phrase the hunks change (words.ts phraseSpan), not just the first hunk's fragment
    const span = phraseSpan(hunks, P.text)
    if (!span) return null
    return createAnchor(P, L.blocks, span.from, span.to, rev)
  }

  /** Resolution of a thread's anchor as the read path computes it (fuzzy for comment threads only, §5.3 step 5). */
  protected resolveThread(P: PText, L: Loaded, t: Pick<ThreadFold, 'kind'>, a: Anchor, o: { fuzzy?: boolean } = {}): Resolution {
    if (a.kind === 'doc') return { state: 'doc' }
    return resolveAnchor(P, L.blocks, a, { fuzzy: o.fuzzy ?? t.kind !== 'suggestion' })
  }

  /**
   * Where `a` sits in (P, L) when it resolves exactly and unambiguously there (a quote that occurs once), else null:
   * the test for putting a detached thread back, and for telling a browser's "this range was deleted" claim from a
   * decoration it merely lost.
   */
  protected uniquePlace(P: PText, L: Loaded, t: Pick<ThreadFold, 'kind'>, a: Anchor): Resolution | null {
    const r = this.resolveThread(P, L, t, a, { fuzzy: false })
    if ((r.state !== 'exact' && r.state !== 'moved') || r.ambiguous) return null
    if (a.kind === 'text' && r.from !== undefined && r.to !== undefined && a.quote && P.text.split(a.quote).length - 1 !== 1) return null
    return r
  }

  /**
   * §5.4 server re-resolution and §6.7 rebase/stale against (L, P) at `rev`, on fold `f` (which already includes the
   * commit's own events). `changes` lets block anchors follow a 1:1 replace (D35); null skips that step. Suggestion
   * threads are placed by their suggestions' `located`, so only comment and doc threads are re-anchored.
   */
  protected systemEvents(f: FoldState, L: Loaded, P: PText, rev: number, changes: readonly BlockChange[] | null): SystemPass {
    const out: SystemPass = { events: [], staled: [], rebased: [], detached: [], warnings: [] }
    for (const s of f.suggestions.values()) {
      if (s.status !== 'pending' && s.status !== 'stale') continue
      const loc = locate(L, s)
      if (loc) {
        if (s.status === 'stale') {
          // the exact base is back (an undo, a revert): a successful "rebase" returns it to pending (§6.7)
          out.events.push({ type: 'suggestion.rebase', by: 'system', suggestion: s.id, anchor: s.anchor, range: { start: loc.start, end: loc.end, rev }, base: s.base, proposed: s.proposed, hunks: s.hunks.map((h) => ({ ...h })) })
          out.rebased.push(s.id)
          out.warnings.push({ code: 'SUGGESTION_REBASED', message: `suggestion ${s.id} found its base again`, suggestion: s.id })
        }
        continue
      }
      const r = rebase(this.md, L, s)
      if ('stale' in r) {
        if (s.status === 'pending') {
          out.events.push({ type: 'suggestion.stale', by: 'system', suggestion: s.id, reason: r.stale })
          out.staled.push(s.id)
          out.warnings.push({ code: 'SUGGESTION_STALE', message: `suggestion ${s.id} went stale (${r.stale})`, suggestion: s.id })
        }
        continue
      }
      const anchor = this.anchorForHunks(r.hunks, L, P, rev) ?? s.anchor
      out.events.push({ type: 'suggestion.rebase', by: 'system', suggestion: s.id, anchor, range: { ...r.range, rev }, base: r.base, proposed: r.proposed, hunks: r.hunks })
      out.rebased.push(s.id)
      out.warnings.push({ code: 'SUGGESTION_REBASED', message: `suggestion ${s.id} was rebased onto the new text`, suggestion: s.id })
    }
    for (const t of f.threads.values()) {
      if (t.kind === 'suggestion' || t.anchor.kind === 'doc') continue
      if (!t.detached) {
        if (t.anchor.kind === 'block' && changes) {
          const followed = followBlockAnchor(t.anchor, changes, L.blocks, rev)
          if (followed && followed.hint.blockHash !== t.anchor.hint.blockHash) {
            out.events.push({ type: 'anchor.update', by: 'system', thread: t.id, anchor: followed })
            continue
          }
        }
        const r = this.resolveThread(P, L, t, t.anchor)
        if (r.state === 'detached') {
          out.events.push({ type: 'thread.detach', by: 'system', thread: t.id, cause: 'unresolvable' })
          out.detached.push(t.id)
          out.warnings.push({ code: 'THREAD_DETACHED', message: `thread ${t.id} lost its anchor`, thread: t.id })
          continue
        }
        const upd = refreshAnchor(P, L.blocks, t.anchor, r, rev)
        if (upd) out.events.push({ type: 'anchor.update', by: 'system', thread: t.id, anchor: upd })
        continue
      }
      const la = t.lastAnchor
      if (la.kind === 'doc') continue
      const r = this.uniquePlace(P, L, t, la)
      if (!r) continue
      let anchor: TextAnchor | import('../shared/types').BlockAnchor | null = null
      if (la.kind === 'text' && r.from !== undefined && r.to !== undefined) anchor = createAnchor(P, L.blocks, r.from, r.to, rev)
      else if (la.kind === 'block' && r.block !== undefined) anchor = createBlockAnchor(L.blocks, r.block, rev)
      if (anchor) out.events.push({ type: 'thread.reattach', by: 'system', thread: t.id, anchor })
    }
    return out
  }

  // ----------------------------------------------------------------------------------- steps 5-9: commit

  /**
   * Commit one write (Appendix A steps 5-9). Must run inside transact(). Throws RACED (internally) when an external
   * write lands between the WAL append and the rename; transact re-runs the round.
   */
  protected commit(spec: CommitSpec, emits: StoreChange[]): CommitResult {
    let { d, s, v } = this.state()
    const recreate = spec.recreate
    const baseText = recreate ? recreate.baseText : d.text
    const bytesChanged = spec.text !== undefined && (recreate !== undefined || spec.text !== baseText)
    const tjEditor = spec.by === 'TJ' && spec.cause !== undefined && TJ_EDITOR_CAUSES.has(spec.cause)
    const materialize = !s.exists
    // a header with no doc.rev at all (a creating batch rolled back after its header) still owes the baseline
    const baseline = materialize || (v.maxRev === 0 && v.revHashes.size === 0)
    if (bytesChanged && !tjEditor && !baseline) {
      this.flushSessionNow('foreign-write', emits)
      this.ensurePreWrite()
      ;({ d, s, v } = this.state())
    }
    const nextRev = bytesChanged ? Math.max(v.maxRev, baseline ? 1 : 0) + 1 : Math.max(v.f.rev, baseline ? 1 : 0)
    const probe = spec.events(nextRev)
    const empty: CommitResult = {
      seq: v.f.seq, rev: v.f.rev, hash: d.hash, events: [], changes: [], bytesChanged: false,
      staled: [], rebased: [], detached: [], warnings: [], version: null,
    }
    if (!bytesChanged && probe.length === 0) return empty

    const fromSeq = this.trueSeq()
    let seq = fromSeq
    const next = (): number => ++seq
    const at = nowIso()
    let header: SidecarHeader | undefined
    let head: SidecarEvent[] = []
    let f0 = v.f
    if (baseline) {
      if (materialize) header = { type: 'header', schema: SIDECAR_SCHEMA, docId: `d_${ulid()}` as DocId, file: basename(this.abs), createdAt: nowIso(), createdBy: CREATED_BY }
      const raw = encodeDoc(d.text, d.bom)
      writeObject(this.abs, d.hash, raw)
      this.version({ cause: 'baseline', by: 'external', rev: 1, revs: [1, 1], hash: d.hash, raw, text: d.text })
      head = this.stamp([{ type: 'doc.rev', by: 'system', prevRev: null, prevHash: null, hash: d.hash, bytes: d.size, cause: 'baseline' } as NewEvent], 1, next, { at })
      f0 = fold(head, v.f)
    }

    if (!bytesChanged) {
      const lines = [...head, ...this.stamp(spec.events(f0.rev), f0.rev, next, { at, ...(spec.key !== undefined ? { key: spec.key } : {}) })]
      const bytes = header ? createSidecar(this.sidecarPath, header, lines) : appendSidecar(this.sidecarPath, lines)
      this.adopt(lines, bytes, header ? { header } : {})
      if (baseline) this.systemRev = 1
      const after = this.state().v
      emits.push({ kind: 'sidecar', fromSeq, seq: after.f.seq, events: lines, ...(spec.clientId ? { clientId: spec.clientId } : {}) })
      return { ...empty, seq: after.f.seq, rev: after.f.rev, events: lines }
    }

    // ---- a byte change
    const text = spec.text!
    const newRev = nextRev
    const raw = encodeDoc(text, d.bom)
    const newHash = sha256Hex(new Uint8Array(raw))
    const newL = spec.textL && spec.textL.src === text ? spec.textL : this.loadCached(text, recreate ? recreate.baseL : d.L)
    const P = ptextOf(newL.doc, newL)
    const baseL = recreate ? recreate.baseL : d.L
    const changes = blockChanges({ src: baseText, blocks: baseL.blocks }, { src: text, blocks: newL.blocks })
    const prevRev = f0.rev
    const prevHash = f0.hash ?? d.hash
    const by = spec.by ?? 'system'
    const cause = spec.cause ?? 'cli'
    const wal = { rev: newRev, hash: newHash }
    const revKey: string | null = spec.revKey === null ? null : (spec.revKey ?? spec.key ?? null)
    const docBatch: NewEvent[] = [{
      type: 'doc.rev', by, prevRev, prevHash, hash: newHash, bytes: raw.length, cause,
      ...(spec.clientId ? { clientId: spec.clientId } : {}),
      ...(spec.saveId !== undefined ? { saveId: spec.saveId } : {}),
    } as NewEvent]
    if (spec.edit && !tjEditor) {
      docBatch.push({
        type: 'doc.edit', by: (by === 'TJ' || by === 'Claude' ? by : 'Claude') as Author, source: spec.edit.source,
        fromRev: prevRev, toRev: newRev, changes, ...(spec.edit.cause ? { cause: spec.edit.cause } : {}),
      } as NewEvent)
    }
    const docLines = this.stamp(docBatch, newRev, next, { key: revKey, wal, at })
    const opLines = this.stamp(spec.events(newRev), newRev, next, { key: spec.key ?? null, wal, at })
    const sys = this.systemEvents(fold([...docLines, ...opLines], f0), newL, P, newRev, changes)
    const sysLines = this.stamp(sys.events, newRev, next, { wal, at })
    const lines = [...head, ...docLines, ...opLines, ...sysLines]

    // step 6: the object before the WAL
    writeObject(this.abs, newHash, raw)
    fault('after-object')
    // step 7: ONE append
    const bytes = header ? createSidecar(this.sidecarPath, header, lines) : appendSidecar(this.sidecarPath, lines)
    fault('after-wal')
    // step 8: re-hash right before the rename
    const now = readDisk(this.abs)
    const raced = recreate ? now.exists : (!now.exists || now.hash !== d.hash)
    if (raced) {
      let s2 = seq
      const abort = this.stamp([{ type: 'doc.abort', by: 'system', abortedRev: newRev, reason: 'raced-external' }], prevRev, () => ++s2, {})
      appendSidecar(this.sidecarPath, abort)
      this.invalidate()
      emits.push({ kind: 'sidecar', fromSeq, seq: s2, events: [...lines, ...abort] })
      throw RACED
    }
    writeDocAtomic(this.abs, raw, recreate ? { mode: 0o644 } : {})
    this.renamedRevs.add(newRev)
    this.adopt(lines, bytes, { ...(header ? { header } : {}), doc: { text, bom: d.bom, hash: newHash, size: raw.length, L: newL, P } })
    this.systemRev = newRev

    // step 9: history, the TJ idle timer
    let version: CommitResult['version'] = null
    if (spec.version) {
      version = this.version({ cause: spec.version.cause, by: spec.version.by, rev: newRev, revs: [newRev, newRev], hash: newHash, raw, text, ...(spec.version.restoredFrom ? { restoredFrom: spec.version.restoredFrom } : {}) })
    }
    if (tjEditor) {
      const sess = this.state().v.f.tjSession
      this.ownSession = sess ? sess.baseRev : null
      this.armIdle()
    } else this.ownSession = null
    const after = this.state().v
    emits.push({
      kind: 'doc', rev: newRev, prevRev, hash: newHash, by, cause, changes,
      ...(spec.clientId ? { clientId: spec.clientId } : {}),
      ...(spec.saveId !== undefined ? { saveId: spec.saveId } : {}),
    })
    emits.push({ kind: 'sidecar', fromSeq, seq: after.f.seq, events: lines, ...(spec.clientId ? { clientId: spec.clientId } : {}) })
    return {
      seq: after.f.seq, rev: newRev, hash: newHash, events: lines, changes, bytesChanged: true,
      staled: sys.staled, rebased: sys.rebased, detached: sys.detached, warnings: sys.warnings, version,
    }
  }

  // ----------------------------------------------------------------------------------- maintenance (§3.8, §10)

  /** Objects the GC must keep beyond the index (§3.8). */
  protected pinnedObjects(d: DocState, v: View): Set<Hash> {
    const keep = new Set<Hash>()
    if (!d.missing) keep.add(d.hash)
    const head = this.lastRev(v)
    if (head) keep.add(head.hash)
    const revs = [...v.revHashes.keys()].sort((a, b) => b - a)
    for (const r of revs.slice(0, CONSTANTS.OBJECT_KEEP_REVS)) keep.add(v.revHashes.get(r)!)
    const sess = v.f.tjSession
    if (sess) {
      keep.add(sess.baseHash)
      const last = v.revHashes.get(sess.lastRev)
      if (last) keep.add(last)
    }
    const ack = v.f.cursors.claudeAck
    let ackRev = 0
    for (const e of v.events) {
      if (e.seq <= ack) {
        ackRev = e.rev
        continue
      }
      if (e.type === 'doc.edit' || e.type === 'doc.external') {
        for (const r of [e.fromRev, e.toRev]) {
          const h = v.revHashes.get(r)
          if (h) keep.add(h)
        }
      }
    }
    const ah = v.revHashes.get(ackRev)
    if (ah) keep.add(ah)
    return keep
  }

  /** History retention and objects GC now, under the lock (server start, hourly, `mdr doctor --gc`). */
  async maintenance(o: { now?: Date } = {}): Promise<{ removedVersions: number; removedObjects: number }> {
    // a doc never written has no history or objects, and taking its lock would create .review/ for nothing
    if (this.readOnlyStore || !existsSync(this.sidecarPath)) return { removedVersions: 0, removedObjects: 0 }
    return withDocLock(this.abs, this.lockTimeoutMs, () => {
      const removedVersions = existsSync(this.abs) || existsSync(this.sidecarPath) ? applyRetention(this.abs, o.now ?? new Date()) : 0
      const { d, s, v } = this.state()
      const pinned = this.pinnedObjects(d, v)
      // Integrator, M4 (CONTRACT_CHANGES): §3.8 writes a rev's object before its WAL append, so the GC must keep the
      // object of a trailing batch that state() reads as in flight. That happens not only mid-commit but whenever an
      // external write has landed on top of the last committed rev and the watcher has not reconciled it yet: the
      // disk hash no longer matches the batch, the rev drops out of revHashes, and without this its object (the base
      // of the doc.external diff and of TJ's session flush) was deleted, so both recorded empty changes.
      if (!d.missing) {
        const all = s.parsed?.events ?? []
        const trailing = trailingInFlight(all, d.hash)
        if (trailing) {
          for (const e of all.slice(trailing.from)) {
            if (e.wal) pinned.add(e.wal.hash)
            if (e.type === 'doc.rev') pinned.add(e.hash)
          }
        }
      }
      const removedObjects = gcObjects(this.abs, pinned).length
      return { removedVersions, removedObjects }
    })
  }

  protected async shutdownLedger(): Promise<void> {
    this.clearIdle()
    this.closed = true
    this.listeners.clear()
    this.invalidate()
  }
}
