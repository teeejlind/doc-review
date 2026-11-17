// web/src/session/session.ts (P2). The DocSession (CONTRACTS §12.0, §12.1, §12.3-§12.10, §12.14, §8.6, §10).
//
// Owns REST and SSE (through a Transport, §12.0.5), the write queue, the save planner and its retry, drafts, the tab
// lock, the review-state cache, presence/activity, banners, the recovered draft and session notices. It never touches
// the EditorView: everything that needs the live ProseMirror state goes through the EditorPort the editor attaches
// (internals.ts). Without an attached editor (P3's fake path, the contract suite) it is a complete, read-mostly
// session: it fetches, streams, refreshes and performs every thread, policy, read-marker, history and handoff call.
import { ulid } from 'ulid'
import { docHash } from '../../../core/hash'
import { load, type Loaded } from '../../../core/splice/load'
import { updateLoaded } from '../../../core/splice/update'
import { buildClipboardPrompt } from '../../../shared/handoff-prompt'
import { promptIdentity } from '../identity'
import type {
  Anchor, Author, BlockConflict, BlockHash, BrowserSseEvent, BulkDecisionRequest, BulkDecisionResult, ClientId,
  CommentId, CreateThreadResponse, DecisionResult, DocId, DocSession, DocSnapshot, DraftRecord, ErrorCode, EventType, Hash,
  HandoffOutcome, HandoffRequest, HandoffResult, HistoryDiff, HistoryList, HistoryRef, MessageResponse,
  OpenDocSessionOptions, OpKey, RecoveredDraft, RestoreResponse, ReviewPolicy, ReviewState, SaveRequest, SaveResponse,
  SaveState, SeqResponse, SessionBanner, SessionEvent, SessionNotice, SuggestionId, SuggestionStatus, Thread, ThreadId,
  ThreadOpResponse, Transport, Unsubscribe, VersionId, VersionShow,
} from '../../../shared/types'
import {
  AutosaveScheduler, backoffDelay, FLUSH_REASONS, insertionKey, planSaveRequest, unsaveableIdOf, type FlushReason, type SavePlan,
} from './autosave'
import {
  deriveSaveState, isReadOnlyBannerCode, NO_SAFETY_FLAGS, pickBanner, readOnlyReason, sameBanner, sameSaveState, type SafetyFlags,
} from './banners'
import { classifyDraft, draftKey, DraftWriter, isDraftRecord } from './drafts'
import { docChangedEcho, sidecarChangedEcho } from './echo'
import { defaultEnv, type SessionEnv } from './env'
import { errorFromResponse, isRetryable, isSessionError, networkError, SessionError } from './errors'
import { sessionInternals, type EditorPort, type ReloadReason, type ReopenGroup, type SessionInternals } from './internals'
import { WriteQueue } from './queue'
import { ReadMarkerThrottle } from './readMarkers'
import { checkParity, fidelityHintsOf } from './remote'
import { SseConnection } from './sse'
import { tabChannelName, TabElection, type TabRole } from './tabs'
import { createDefaultTransport } from './transport'

export type HandoffSseData = Extract<BrowserSseEvent, { event: 'handoff' }>['data']

/** The real session: the frozen DocSession plus the one fake-parity extension P3 can feature-detect (CONTRACT_CHANGES). */
export interface MdrDocSession extends DocSession {
  /** The last SSE `handoff { state }` event (§12.10 step 4); see contract-changes/P2.md. */
  getLastHandoffEvent(): HandoffSseData | null
  readonly clientId: ClientId
}

export interface OpenSessionOptions extends OpenDocSessionOptions {
  /** Unit tests swap browser facilities (drafts, channel, clipboard, idle, window/document). */
  env?: Partial<SessionEnv>
  /** Overrides the transport's own client id (default: transport.clientId, else a fresh k_ id). */
  clientId?: ClientId
  tabs?: { electionMs?: number; heartbeatMs?: number; leaderTimeoutMs?: number }
}

/** Discrete ops (threads, decisions, policy, restore) retry a network failure this many times, reusing the opKey. */
const DISCRETE_RETRIES = 2
/** §12.7: sidecar-changed → GET /api/review after this debounce. */
const REVIEW_DEBOUNCE_MS = 50
/** close() waits this long for its flush before giving up (the draft keeps the rest). */
const CLOSE_FLUSH_TIMEOUT_MS = 3_000

const nowIso = (): string => new Date().toISOString()
const newOpKey = (): OpKey => `op_${ulid()}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length

interface Base {
  L: Loaded | null
  rev: number
  hash: Hash
  blockHashes: BlockHash[]
}

interface Held {
  entry: BlockConflict
  hashes: Set<BlockHash>
  insertions: Set<string>
}

interface SaveOptions {
  keepalive?: boolean
  cause?: SaveRequest['cause']
  allowPartial?: boolean
  /** The tab lost leadership and flushes once on its way out (§12.8). */
  stepDown?: boolean
}

function transportClientId(t: Transport | undefined): ClientId | undefined {
  const id = (t as { clientId?: unknown } | undefined)?.clientId
  return typeof id === 'string' && id.startsWith('k_') ? (id as ClientId) : undefined
}

/** Event types a commit can carry for records the request didn't name (server re-resolution after a rev change). */
const SYSTEM_FOLLOWUPS: ReadonlySet<EventType> = new Set<EventType>([
  'thread.detach', 'thread.reattach', 'anchor.update', 'suggestion.rebase', 'suggestion.stale',
])

export async function openSession(o: OpenSessionOptions): Promise<MdrDocSession> {
  const env: SessionEnv = { ...defaultEnv(), ...(o.env ?? {}) }
  const boot = o.boot
  const file = o.file
  const clientId: ClientId = o.clientId ?? transportClientId(o.transport) ?? (`k_${ulid()}` as ClientId)
  const transport: Transport = o.transport ?? createDefaultTransport({ token: boot.token, clientId })
  const fq = `file=${encodeURIComponent(file)}`

  // ------------------------------------------------------------------ REST helper

  /** Set once the session is built: the server answered 401 (it restarted with a new token). */
  let onAuthLost: (() => void) | null = null

  async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, ro?: { keepalive?: boolean }): Promise<T> {
    let r: { status: number; json: unknown }
    try {
      r = await transport.request(method, path, body, ro)
    } catch (e) {
      throw networkError(e)
    }
    if (r.status < 200 || r.status >= 300) {
      const err = errorFromResponse(r.status, r.json)
      if (err.code === 'UNAUTHORIZED') onAuthLost?.()
      throw err
    }
    return r.json as T
  }

  async function discrete<T>(fn: () => Promise<T>, retries = DISCRETE_RETRIES): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (e) {
        if (!isRetryable(e) || attempt >= retries || closed) throw e
        await sleep(backoffDelay(attempt))
      }
    }
  }

  // ------------------------------------------------------------------ open: snapshot + review (+ draft read)

  let snapshot = await call<DocSnapshot>('GET', `/api/doc?${fq}`)
  let review = await call<ReviewState>('GET', `/api/review?${fq}`)
  const key = draftKey(boot.rootHash, file)
  let pendingDraft: DraftRecord | null = null
  try {
    const d = await env.drafts.get(key)
    pendingDraft = isDraftRecord(d) ? d : null
  } catch {
    pendingDraft = null
  }

  // ------------------------------------------------------------------ state

  let base: Base = { L: null, rev: snapshot.rev, hash: snapshot.hash, blockHashes: snapshot.blocks.map((b) => b.hash) }
  let port: EditorPort | null = null
  const flags: SafetyFlags = { ...NO_SAFETY_FLAGS }
  let saving = false
  let offline: { since: string; retryAt: string } | null = null
  /** `offline` was set by a dropped event stream (no failed request yet); the reconnect clears it. */
  let streamOffline = false
  let saveError: { code: ErrorCode; message: string } | null = null
  let savedAt = nowIso()
  let savedGen = 0
  let deferredUntil: number | null = null
  let outstanding: { plan: Extract<SavePlan, { kind: 'save' }>; gen: number; prevL: Loaded } | null = null
  let backoffTimer: ReturnType<typeof setTimeout> | null = null
  let backoffAttempt = 0
  let saveIdSeq = 0
  let pendingSaveReason: FlushReason = 'debounce'
  let pendingSaveKeepalive = false
  const held = new Map<BlockConflict['id'], Held>()
  let recovered: RecoveredDraft | null = null
  let lastHandoff: HandoffSseData | null = null
  let serverId: string | null = null
  let lastNonNullDocId: DocId | null = snapshot.docId
  let resetSeenFor: DocId | null | undefined = undefined
  let myPolicy: boolean | null = null
  let reviewTimer: ReturnType<typeof setTimeout> | null = null
  let reviewGen = 0
  let reloadPayload: ReloadPayload | undefined
  let closed = false
  let banner: SessionBanner | null = null
  let saveState: SaveState = { state: 'saved', rev: snapshot.rev, at: savedAt }
  let lastEditable = false
  const subs = new Set<(what: SessionEvent) => void>()
  const noticeSubs = new Set<(n: SessionNotice) => void>()
  const navSubs = new Set<(f: string) => void>()
  const editableSubs = new Set<(e: boolean) => void>()

  interface ReloadPayload {
    reason: ReloadReason
    snapshot?: DocSnapshot
    event?: Extract<BrowserSseEvent, { event: 'doc-changed' }>['data']
  }

  // the write queue (§12.3); its flush-first hook runs a save inline, inside the item's own slot
  const queue = new WriteQueue({
    flushFirst: async () => {
      if (canSave() && (dirty() || outstanding !== null)) await saveCycle('queued-op')
    },
  })

  const scheduler = new AutosaveScheduler({
    isComposing: () => port?.isComposing() ?? false,
    fire: (reason) => {
      void enqueueSave(reason, { keepalive: reason === 'hidden' }).catch(() => undefined)
    },
  })

  // ------------------------------------------------------------------ tabs (§12.8)

  const tabs = new TabElection({
    channel: env.channel(tabChannelName(boot.rootHash, file)),
    id: ulid(),
    since: env.now(),
    now: env.now,
    ...(o.tabs?.electionMs !== undefined ? { electionMs: o.tabs.electionMs } : {}),
    ...(o.tabs?.heartbeatMs !== undefined ? { heartbeatMs: o.tabs.heartbeatMs } : {}),
    ...(o.tabs?.leaderTimeoutMs !== undefined ? { leaderTimeoutMs: o.tabs.leaderTimeoutMs } : {}),
    onChange: (role: TabRole, prev: TabRole) => {
      if (role === 'follower' && prev === 'leader') {
        // the old leader flushes once, then goes read-only
        scheduler.cancel()
        void enqueueSave('release', { stepDown: true }).catch(() => undefined)
      }
      flags.tabNotLeader = role === 'follower'
      if (role === 'leader' && prev === 'follower') requestReload({ reason: 'remote' })
      sync()
    },
  })

  const notify = (...what: SessionEvent[]): void => {
    for (const w of what) for (const cb of [...subs]) {
      try {
        cb(w)
      } catch (e) {
        console.error('[mdr session] subscriber threw', e)
      }
    }
  }
  const emitNotice = (n: SessionNotice): void => {
    for (const cb of [...noticeSubs]) {
      try {
        cb(n)
      } catch (e) {
        console.error('[mdr session] notice subscriber threw', e)
      }
    }
  }

  const expectedFingerprint = (): string => port?.md.schemaFingerprint ?? boot.schemaFingerprint
  const loadedHash = (): Hash | null => (base.L ? base.hash : snapshot.hash)
  const dirty = (): boolean => port !== null && base.L !== null && port.changeGen() !== savedGen
  const heldHashes = (): Set<BlockHash> => {
    const s = new Set<BlockHash>()
    for (const h of held.values()) for (const x of h.hashes) s.add(x)
    return s
  }
  const heldInsertions = (): Set<string> => {
    const s = new Set<string>()
    for (const h of held.values()) for (const x of h.insertions) s.add(x)
    return s
  }
  const noDocument = (): boolean => snapshot.readOnly !== false && (snapshot.readOnly.code === 'NOT_UTF8' || snapshot.readOnly.code === 'TOO_LARGE')
  /** May this tab write the document now? (`stepDown` lets a demoted leader flush once.) */
  const canSave = (o: { stepDown?: boolean } = {}): boolean =>
    !closed && port !== null && base.L !== null && readOnlyReason({ ...flags, tabNotLeader: o.stepDown ? false : flags.tabNotLeader }, file) === null
    && (o.stepDown === true || tabs.role !== 'follower')
  const editable = (): boolean => port !== null && base.L !== null && !noDocument() && readOnlyReason(flags, file) === null

  function computeSaveState(): SaveState {
    return deriveSaveState({
      readOnly: readOnlyReason(flags, file),
      saving,
      offline,
      error: saveError,
      held: held.size,
      dirty: dirty() || deferredUntil !== null,
      rev: base.rev,
      savedAt,
    })
  }

  /** Recompute banner, save state and editability; notify what changed. */
  function sync(): void {
    const b = pickBanner(flags)
    if (!sameBanner(b, banner)) {
      banner = b
      notify('banner')
    }
    const s = computeSaveState()
    if (!sameSaveState(s, saveState)) {
      saveState = s
      notify('save')
    }
    const ed = editable()
    if (ed !== lastEditable) {
      lastEditable = ed
      port?.setEditable(ed)
      for (const cb of [...editableSubs]) cb(ed)
    }
  }

  function updateReadOnlyFlags(): void {
    const pick = (ro: DocSnapshot['readOnly']): SafetyFlags['readOnly'] =>
      ro !== false && isReadOnlyBannerCode(ro.code) ? { code: ro.code, message: ro.message } : null
    flags.readOnly = pick(snapshot.readOnly) ?? pick(review.readOnly)
    if (snapshot.readOnly !== false && snapshot.readOnly.code === 'DOC_GONE') flags.docRemoved ??= { canRecreate: base.L !== null }
    if (snapshot.readOnly !== false && snapshot.readOnly.code === 'CONTRACT_MISMATCH') {
      flags.contractMismatch ??= { expected: expectedFingerprint(), actual: snapshot.schemaFingerprint }
    }
  }

  function checkFingerprint(actual: string): void {
    const expected = expectedFingerprint()
    if (expected && actual && actual !== expected) flags.contractMismatch = { expected, actual }
  }

  // ------------------------------------------------------------------ drafts

  const drafts = new DraftWriter({
    store: env.drafts,
    key,
    idle: env.idle,
    build: (): DraftRecord | null => {
      if (!port || !base.L || tabs.role === 'follower') return null
      if (!dirty() && held.size === 0 && deferredUntil === null) return null
      const d = port.draftState()
      return {
        v: 1, docId: snapshot.docId, baseRev: base.rev, baseHash: base.hash, baseMarkdown: base.L.src, liveDoc: d.liveDoc,
        mode: d.mode, selection: d.selection, heldConflicts: [...heldHashes()], savedAt: nowIso(),
      }
    },
  })
  function settleDraft(): void {
    if (!port || tabs.role === 'follower') return
    if (!dirty() && held.size === 0 && deferredUntil === null && recovered === null) void drafts.clear()
    else drafts.schedule()
  }

  // ------------------------------------------------------------------ holds (§7.4)

  function hold(entry: BlockConflict, hashes: Iterable<BlockHash>, insertions: Iterable<string> = []): void {
    held.set(entry.id, { entry, hashes: new Set(hashes), insertions: new Set(insertions) })
    notify('conflicts')
  }

  function holdFromDraft(hashes: readonly BlockHash[]): void {
    const L = base.L
    if (!L) return
    for (const h of hashes) {
      const idx = L.blocks.findIndex((b) => b.hash === h)
      if (idx < 0) continue
      const b = L.blocks[idx]!
      const src = L.src.slice(b.start, b.end)
      hold({
        kind: 'conflict', id: `conflict:${h}`, baseIndex: idx, currentIndex: idx, base: src, mine: src, theirs: src,
        theirsBy: 'external', theirsRev: base.rev,
      }, [h])
    }
  }

  // ------------------------------------------------------------------ adopting server text

  /**
   * §12.6 / §13 #29: a hello or snapshot docId that differs from the session's previous non-null one means the sidecar
   * was deleted and recreated. Sets the review-reset banner once per new value; true when the caller must fully reload.
   */
  function noteDocId(docId: DocId | null): boolean {
    let reset = false
    if (lastNonNullDocId !== null && docId !== lastNonNullDocId && resetSeenFor !== docId) {
      flags.reviewReset = { kind: 'review-reset', previousDocId: lastNonNullDocId, docId }
      resetSeenFor = docId
      reset = true
    }
    if (docId !== null) lastNonNullDocId = docId
    return reset
  }

  /** Set the base (and snapshot) from a server snapshot; optionally replay it into the live doc (§12.6 steps 3-6). */
  function adoptSnapshot(snap: DocSnapshot, o: { reason: ReloadReason; applyToLive: boolean; preserve?: ReadonlySet<BlockHash>; parity?: 'full' | 'skip'; replaceAll?: boolean; prev?: Loaded }): void {
    // §13 #29: a docId that differs from the previous non-null one -> full reload + review-reset banner
    const full = noteDocId(snap.docId) || o.reason === 'full' || o.replaceAll === true
    checkFingerprint(snap.schemaFingerprint)
    const prevSnap = snapshot
    snapshot = snap
    updateReadOnlyFlags()
    // the file is there (a snapshot answered 200): a doc-removed banner no longer applies
    if (flags.docRemoved && !(snap.readOnly !== false && snap.readOnly.code === 'DOC_GONE')) flags.docRemoved = null
    if (port && !noDocument()) {
      const next = load(port.md, snap.markdown, { fidelityHints: fidelityHintsOf(snap.blocks) })
      if (o.parity !== 'skip') {
        const mismatch = checkParity(next, snap.blocks)
        if (mismatch) flags.contractMismatch = mismatch
      }
      if (o.applyToLive || full) {
        port.applyReload({ prev: full ? null : (o.prev ?? base.L), next, preserve: o.preserve ?? heldHashes(), review, reason: full && o.reason !== 'recover' ? 'full' : o.reason })
      }
      base = { L: next, rev: snap.rev, hash: snap.hash, blockHashes: next.blocks.map((b) => b.hash) }
      if (full) savedGen = port.changeGen()
    } else {
      base = { L: null, rev: snap.rev, hash: snap.hash, blockHashes: snap.blocks.map((b) => b.hash) }
    }
    if (prevSnap !== snap) notify('doc')
    sync()
  }

  async function fetchDoc(): Promise<DocSnapshot> {
    try {
      return await call<DocSnapshot>('GET', `/api/doc?${fq}`)
    } catch (e) {
      if (isSessionError(e) && e.code === 'DOC_GONE') {
        flags.docRemoved = { canRecreate: base.L !== null }
        scheduler.cancel()
        sync()
      }
      throw e
    }
  }

  /**
   * A write of this tab changed the bytes (accept, reopen, bulk): adopt the server text as the new base. When the
   * live doc already shows the change (marks applied, history restored) the editor is left alone, so TJ's edits
   * elsewhere stay dirty and the next plan yields only them; otherwise (an unplaced suggestion, a racing foreign write)
   * the reload path replaces the differing runs.
   */
  async function adoptOwnText(rev: number, hash: Hash, liveShowsIt: boolean, reason: ReloadReason): Promise<void> {
    if (hash === loadedHash()) {
      if (rev > base.rev) {
        base = { ...base, rev }
        snapshot = { ...snapshot, rev }
        notify('doc')
      }
      return
    }
    const snap = await fetchDoc()
    adoptSnapshot(snap, { reason, applyToLive: snap.hash !== hash || !liveShowsIt })
  }

  // ------------------------------------------------------------------ the save cycle (§12.4)

  function enqueueSave(reason: FlushReason, o: SaveOptions = {}): Promise<void> {
    if (!canSave(o)) return Promise.resolve()
    if (FLUSH_REASONS.has(reason) || pendingSaveReason === 'debounce') pendingSaveReason = reason
    if (o.keepalive) pendingSaveKeepalive = true
    const special = o.cause !== undefined || o.allowPartial !== undefined || o.stepDown === true
    return queue.enqueue('save', () => {
      const r = special ? reason : pendingSaveReason
      const keepalive = special ? o.keepalive === true : pendingSaveKeepalive
      if (!special) {
        pendingSaveReason = 'debounce'
        pendingSaveKeepalive = false
      }
      return saveCycle(r, { ...o, keepalive })
    }, special ? {} : { coalesce: 'save' })
  }

  /** Runs inside a queue slot: re-send an outstanding request, else plan (reopen first) and send. */
  async function saveCycle(reason: FlushReason, o: SaveOptions = {}): Promise<void> {
    await tabs.ready
    if (!canSave(o)) return
    if (backoffTimer) {
      clearTimeout(backoffTimer)
      backoffTimer = null
    }
    if (outstanding) {
      // §12.4: the retry re-sends the identical request (same saveId; it may have landed)
      await sendSave(outstanding.plan, outstanding.gen, outstanding.prevL, o)
      if (!dirty() && deferredUntil === null) return
    }
    for (let round = 0; round < 4; round++) {
      const p = port
      const L = base.L
      if (!p || !L || !canSave(o)) return
      const gen = p.changeGen()
      const plan = planSaveRequest({
        md: p.md,
        L,
        base: { rev: base.rev, hash: base.hash },
        bom: snapshot.bom,
        baseDoc: p.baseDoc(),
        review,
        holds: { hashes: heldHashes(), insertions: heldInsertions() },
        suggestions: p.suggestionPlan(L, review),
        anchors: p.anchorUpdates(L, review),
        stableSince: (id) => p.marksStableSince(id),
        now: env.now(),
        flushReason: FLUSH_REASONS.has(reason),
        cause: o.cause ?? 'edit',
        allowPartial: o.allowPartial ?? true,
        clientId,
        saveId: ++saveIdSeq,
      })
      if (plan.kind === 'reopen') {
        // §6.6 / D26: each reopen is its own request (a bulk entry is one atomic bulk reopen), answered before the save
        saveIdSeq--
        for (const g of plan.groups) await runReopen(g)
        continue
      }
      if (plan.kind === 'empty') {
        saveIdSeq--
        savedGen = gen
        saveError = null
        deferredUntil = plan.deferredUntil
        if (deferredUntil !== null) scheduler.at(deferredUntil, env.now())
        savedAt = nowIso()
        settleDraft()
        sync()
        return
      }
      outstanding = { plan, gen, prevL: L }
      await sendSave(plan, gen, L, o)
      return
    }
  }

  async function runReopen(g: ReopenGroup): Promise<void> {
    const opKey = newOpKey()
    try {
      if (g.bulk !== undefined || g.ids.length > 1) {
        const body: BulkDecisionRequest = { opKey, decision: 'reopen', authors: [], ids: [...g.ids] }
        const r = await discrete(() => call<BulkDecisionResult>('POST', `/api/suggestions/bulk?${fq}`, body))
        await adoptOwnText(r.rev, r.hash, true, 'decision')
      } else {
        const id = g.ids[0]!
        const r = await discrete(() => call<DecisionResult>('POST', `/api/suggestions/${id}/reopen?${fq}`, { opKey }))
        await adoptOwnText(r.rev, r.hash, true, 'decision')
      }
    } catch (e) {
      if (isSessionError(e) && e.code === 'SUGGESTION_CHANGED_SINCE') port?.reopenRefused(g)
      else throw e
    }
    await refreshReviewNow()
  }

  async function sendSave(plan: Extract<SavePlan, { kind: 'save' }>, gen: number, prevL: Loaded, o: SaveOptions): Promise<void> {
    saving = true
    sync()
    let res: SaveResponse
    try {
      res = await call<SaveResponse>('POST', `/api/save?${fq}`, plan.req, o.keepalive ? { keepalive: true } : undefined)
    } catch (e) {
      saving = false
      if (isRetryable(e)) {
        // §12.4 offline: keep `outstanding` (the identical request is re-sent), back off 1, 2, 4, 8, 15, 30 s
        const delay = backoffDelay(backoffAttempt++)
        if (isSessionError(e) && !e.network && (e.code === 'IO_ERROR' || (e.code === 'INTERNAL' && /\b(EACCES|EPERM|EROFS|ENOSPC)\b/.test(e.message)))) {
          // the server answered but couldn't write: say so (QA3: this read "Offline" and sent TJ to check his network);
          // still retried with the same backoff, since fixing the file's permissions is enough
          saveError = { code: 'IO_ERROR', message: `The server can't write this file (${e.message}). Your changes are kept on this device.` }
          offline = null
          streamOffline = false
        } else {
          offline = { since: offline?.since ?? nowIso(), retryAt: new Date(env.now() + delay).toISOString() }
        }
        if (backoffTimer) clearTimeout(backoffTimer)
        backoffTimer = setTimeout(() => {
          backoffTimer = null
          void enqueueSave('retry').catch(() => undefined)
        }, delay)
        drafts.schedule()
        sync()
        throw e
      }
      outstanding = null
      offline = null
      backoffAttempt = 0
      await handleSaveError(e)
      sync()
      return
    }
    saving = false
    outstanding = null
    offline = null
    streamOffline = false
    backoffAttempt = 0
    saveError = null
    await handleSaveOk(plan, res, gen, prevL)
    sync()
  }

  async function handleSaveOk(plan: Extract<SavePlan, { kind: 'save' }>, res: SaveResponse, gen: number, prevL: Loaded): Promise<void> {
    const p = port
    if (!p) return
    const expect = plan.req.expectHash ?? docHash(prevL.src, snapshot.bom)
    const newConflictHashes = new Set(res.conflicts.map((c) => c.id.slice('conflict:'.length)))
    if (res.applied === 'merged' || res.conflicts.length > 0) {
      // §12.4: adopt `rebased` through the reload path (conflicted blocks keep TJ's text), then register the conflicts
      const preserve = new Set([...heldHashes(), ...newConflictHashes])
      // the live doc is the doc as sent plus whatever TJ typed while the save was on the wire (and keeps trailing spaces the
      // markdown drops), so Claude's changes are replayed against the doc as sent: the blocks TJ wrote are equal there
      // and are left alone, caret included
      const applied = plan.ops.filter((_, i) => !plan.apply.failed.includes(i))
      const sent = preserve.size === 0 && applied.length > 0 ? updateLoaded(p.md, prevL, plan.apply.text, applied, plan.liveNodes) : undefined
      const o = { reason: 'merge' as const, applyToLive: true, preserve, ...(sent ? { prev: sent } : {}) }
      if (res.rebased) adoptSnapshot(res.rebased, o)
      else adoptSnapshot(await fetchDoc(), o)
      for (const c of res.conflicts) {
        const hs = new Set<BlockHash>([c.id.slice('conflict:'.length)])
        const cur = c.currentIndex !== null ? base.L?.blocks[c.currentIndex]?.hash : undefined
        if (cur) hs.add(cur)
        hold(c, hs)
      }
    } else if (res.hash !== expect) {
      // §12.4 SPLICE_MISMATCH path (or a duplicate whose text we can't reproduce): GET /api/doc, then reload
      adoptSnapshot(await fetchDoc(), { reason: 'remote', applyToLive: true })
    } else {
      const applied = plan.ops.filter((_, i) => !plan.apply.failed.includes(i))
      const nextL = applied.length > 0 ? updateLoaded(p.md, prevL, plan.apply.text, applied, plan.liveNodes) : prevL
      base = { L: nextL, rev: res.rev, hash: res.hash, blockHashes: nextL.blocks.map((b) => b.hash) }
      if (snapshot.rev !== res.rev || snapshot.hash !== res.hash || snapshot.markdown !== nextL.src) {
        snapshot = {
          ...snapshot, rev: res.rev, hash: res.hash, markdown: nextL.src, blocks: nextL.blocks, seq: Math.max(snapshot.seq, res.seq),
          size: utf8Bytes(nextL.src) + (snapshot.bom ? 3 : 0), docId: snapshot.docId ?? null,
        }
        notify('doc')
      }
    }
    // §7.4 / D37: hold the ops the server could not splice
    for (const u of res.unsaveable) {
      const op = plan.ops.find((x) => unsaveableIdOf(prevL, x) === u.id)
      const hashes = op ? op.covers : u.id.startsWith('unsaveable:') ? [u.id.slice('unsaveable:'.length)] : []
      const ins = op && op.covers.length === 0 ? [insertionKey(prevL, op)] : []
      hold(u, hashes, ins)
    }
    if (base.L) p.committed({ L: base.L, anchors: plan.req.anchors ?? [], upserted: plan.upserted, withdrawn: plan.withdrawn })
    savedGen = gen
    savedAt = nowIso()
    deferredUntil = plan.deferredUntil
    if (deferredUntil !== null) scheduler.at(deferredUntil, env.now())
    if (plan.req.anchors || plan.req.suggestions || res.staled.length || res.rebasedSuggestions.length || res.conflicts.length || res.warnings.length) {
      scheduleReviewRefresh()
    }
    settleDraft()
  }

  async function handleSaveError(e: unknown): Promise<void> {
    if (!isSessionError(e)) {
      saveError = { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) }
      return
    }
    switch (e.code) {
      case 'STALE_REVISION':
      case 'CONFLICT':
      case 'SPLICE_MISMATCH':
        // §12.4 409 (allowPartial false) and §13 #59: reload from current; the local copy becomes the recovered draft
        await recoverFrom(e.current ?? (await fetchDoc().catch(() => null)))
        return
      case 'DOC_GONE':
        flags.docRemoved = { canRecreate: base.L !== null }
        scheduler.cancel()
        void drafts.flush()
        return
      case 'READ_ONLY': {
        const snap = await fetchDoc().catch(() => null)
        if (snap) adoptSnapshot(snap, { reason: 'remote', applyToLive: false })
        if (readOnlyReason(flags, file) === null) saveError = { code: e.code, message: e.message }
        return
      }
      case 'UNAUTHORIZED':
        return // call() already raised the connection-lost banner; the chip reads Read-only, not an error code
      case 'CONTRACT_MISMATCH':
        flags.contractMismatch = { expected: expectedFingerprint(), actual: snapshot.schemaFingerprint }
        return
      case 'UNANCHORABLE_TARGET': {
        // a suggestion the server won't take: the editor takes it back and its revert re-triggers the save (QA3)
        const id = e.body.suggestion
        if (id && port?.refuseSuggestion?.(id, e.message)) {
          saveError = null
          return
        }
        saveError = { code: e.code, message: e.message }
        return
      }
      default:
        saveError = { code: e.code, message: e.message }
    }
  }

  async function recoverFrom(current: DocSnapshot | null): Promise<void> {
    const p = port
    if (!p) return
    recovered = { reason: 'merge-failed', markdown: p.liveMarkdown(), baseRev: base.rev, savedAt: nowIso() }
    void drafts.flush()
    if (current) {
      // reload from current: the editor shows exactly `current` and the session is clean against it
      adoptSnapshot(current, { reason: 'recover', applyToLive: true, preserve: new Set(), replaceAll: true })
      savedGen = p.changeGen()
    }
    notify('recovered')
  }

  // ------------------------------------------------------------------ reload path (§12.6)

  function requestReload(p: ReloadPayload): void {
    // one waiting reload; the newest payload wins (a full reload is never downgraded)
    if (reloadPayload?.reason === 'full' && p.reason !== 'full') p = { ...p, reason: 'full' }
    reloadPayload = p
    void queue.enqueue('reload', async () => {
      const x = reloadPayload
      reloadPayload = undefined
      if (x) await reloadInline(x)
    }, { coalesce: 'reload' }).catch((e: unknown) => {
      if (!closed) console.warn('[mdr session] reload failed', e)
    })
  }

  /** §12.6 inside a queue slot: step 1 is the queue itself (the in-flight request finished first). */
  async function reloadInline(p: ReloadPayload): Promise<void> {
    // 2. dirty -> flush first; a merged response carries `rebased`, which the save handling adopts
    if (canSave() && (dirty() || outstanding !== null)) {
      try {
        await saveCycle('queued-op')
      } catch {
        // offline: fall through and try to read anyway
      }
    }
    let snap: DocSnapshot | null = p.snapshot ?? null
    let parity: 'full' | 'skip' = 'full'
    if (!snap && p.event && p.event.markdown !== undefined && p.event.rev >= base.rev && docHash(p.event.markdown, snapshot.bom) === p.event.hash) {
      // clean: use the payload's markdown (blocks come from our own load; the changed blocks are checked below)
      snap = { ...snapshot, rev: p.event.rev, hash: p.event.hash, markdown: p.event.markdown, blocks: [], size: utf8Bytes(p.event.markdown) + (snapshot.bom ? 3 : 0) }
      parity = 'skip'
    }
    if (!snap) snap = await fetchDoc()
    if (snap.hash === loadedHash() && snap.rev === base.rev && snap.docId === snapshot.docId && p.reason !== 'full') {
      if (snap !== snapshot && parity === 'full') {
        snapshot = snap
        notify('doc')
      }
      return
    }
    adoptSnapshot(snap, { reason: p.reason, applyToLive: true, parity })
    if (parity === 'skip' && base.L) {
      snapshot = { ...snapshot, blocks: base.L.blocks }
      if (p.event) checkChangedBlocks(base.L, p.event.changes)
    }
    // 6. refetch the review state (re-hydration and decorations follow in the editor)
    await refreshReviewNow().catch(() => undefined)
  }

  /** Partial G6 guard for a doc-changed payload: the after-side hashes the server reported must be in our map. */
  function checkChangedBlocks(L: Loaded, changes: Extract<BrowserSseEvent, { event: 'doc-changed' }>['data']['changes']): void {
    for (const c of changes) {
      if (!c.after) continue
      const got = L.blocks.slice(c.after.index, c.after.index + c.after.count).map((b) => b.hash)
      if (got.length !== c.after.hashes.length || got.some((h, i) => h !== c.after!.hashes[i])) {
        flags.contractMismatch = { expected: `blocks ${c.after.hashes.join(',')} at ${c.after.index}`, actual: `blocks ${got.join(',')} at ${c.after.index}` }
        sync()
        return
      }
    }
  }

  // ------------------------------------------------------------------ review refresh (§12.7)

  /**
   * Fold a decision the server just confirmed into the held review state: status and decidedBy only, never seq, so
   * echo rule 2 still can't swallow a foreign event (§8.6). A review GET already in flight predates the decision and
   * is dropped. Without this, a Cmd+Z that lands before the debounced refresh made the planner read the old 'pending':
   * the reopen was never sent and the undone accept went out as a plain TJ save.
   */
  function noteDecided(ids: readonly SuggestionId[], status: SuggestionStatus): void {
    if (status !== 'accepted' && status !== 'rejected') return
    const set = new Set(ids)
    if (!review.suggestions.some((s) => set.has(s.id))) return
    reviewGen++
    review = { ...review, suggestions: review.suggestions.map((s) => (set.has(s.id) ? { ...s, status, decidedBy: 'TJ' as Author } : s)) }
  }

  function scheduleReviewRefresh(): void {
    if (closed) return
    if (reviewTimer) clearTimeout(reviewTimer)
    reviewTimer = setTimeout(() => {
      reviewTimer = null
      void refreshReviewNow().catch(() => undefined)
    }, REVIEW_DEBOUNCE_MS)
  }

  async function refreshReviewNow(): Promise<void> {
    if (closed) return
    const g = ++reviewGen
    const r = await call<ReviewState>('GET', `/api/review?${fq}`)
    if (g !== reviewGen || closed) return
    const prevPolicy = review.policy.suggestOnly
    review = r
    if (r.policy.suggestOnly !== prevPolicy && r.policy.suggestOnly !== myPolicy) {
      emitNotice({
        kind: 'info',
        code: 'POLICY_CHANGED',
        text: r.policy.suggestOnly
          ? 'Claude switched this document to suggestions only.'
          : 'Claude may now edit this document directly.',
      })
    }
    myPolicy = null
    updateReadOnlyFlags()
    port?.reviewChanged(r)
    notify('review', 'presence', 'activity')
    sync()
  }

  /** Patch one thread from a write response (the seq stays: only a fetched review may raise it, §8.6). */
  function applyThread(t: Thread): void {
    const i = review.threads.findIndex((x) => x.id === t.id)
    const threads = i >= 0 ? review.threads.map((x) => (x.id === t.id ? t : x)) : [...review.threads, t]
    review = { ...review, threads }
    notify('review')
  }

  // ------------------------------------------------------------------ SSE (§8.6)

  const sse = new SseConnection({
    transport,
    path: () => {
      const qs = new URLSearchParams({ file, clientId, t: boot.token, afterSeq: String(review.seq), knownRev: String(base.rev) })
      return `/api/events?${qs.toString()}`
    },
    handlers: {
      hello: (d) => {
        const newServer = serverId !== null && d.serverId !== serverId
        serverId = d.serverId
        review = { ...review, presence: d.presence, activity: d.activity }
        notify('presence', 'activity')
        checkFingerprint(d.schemaFingerprint)
        if (noteDocId(d.docId)) requestReload({ reason: 'full' })
        else if (newServer && (d.rev !== base.rev || d.hash !== loadedHash())) requestReload({ reason: 'remote' })
        if (newServer && (offline !== null || outstanding !== null)) session.retrySave()
        sync()
      },
      'doc-changed': (d) => {
        if (d.file !== file) return
        if (docChangedEcho(d, { clientId, loadedHash: loadedHash() })) return
        // Claude's direct edit changes text under the human's eyes: say so (the Claude badge stays out of it)
        if (d.by === 'Claude') {
          const n = d.changes.length
          emitNotice({ kind: 'info', code: 'CLAUDE_EDITED', text: n === 0 ? 'Claude changed the document.' : `Claude changed ${n} block${n === 1 ? '' : 's'}.` })
        }
        requestReload({ reason: 'remote', event: d })
      },
      'sidecar-changed': (d) => {
        if (d.file !== file) return
        const echo = sidecarChangedEcho(d, { clientId, reviewSeq: review.seq })
        // an own commit can carry the server's re-resolution of other records (§5.4 reattach, §6.7 rebase / stale),
        // which no write response returns: refetch for those even when the event is our own echo
        if (echo === 'own-client' && d.types.some((t) => SYSTEM_FOLLOWUPS.has(t))) {
          scheduleReviewRefresh()
          return
        }
        if (echo) return
        scheduleReviewRefresh()
      },
      presence: (d) => {
        const { file: _f, ...p } = d
        review = { ...review, presence: p }
        notify('presence')
      },
      'claude-activity': (d) => {
        review = { ...review, activity: d }
        notify('activity')
      },
      handoff: (d) => {
        lastHandoff = d
        notify('handoff')
        scheduleReviewRefresh()
      },
      navigate: (d) => {
        for (const cb of [...navSubs]) cb(d.file)
      },
      'doc-removed': (d) => {
        if (d.file !== file) return
        flags.docRemoved = { canRecreate: base.L !== null }
        scheduler.cancel()
        void drafts.flush()
        sync()
      },
      resync: () => {
        requestReload({ reason: 'resync' })
        scheduleReviewRefresh()
      },
    },
    // QA3: a dropped stream means the server is probably gone: say Offline now, not after the next save fails (which
    // while TJ types continuously is the 5 s max-wait), and try a pending save at once
    onDrop: (attempt) => {
      if (closed || flags.authLost) return
      // a server restarted on the same port refuses the old token: the stream can't tell 401 from a dead server, a plain request can
      void call('GET', `/api/review?${fq}`).catch(() => undefined)
      if (offline === null) {
        offline = { since: nowIso(), retryAt: new Date(env.now() + backoffDelay(attempt)).toISOString() }
        streamOffline = true
        sync()
      }
      if (canSave() && dirty() && outstanding === null) void enqueueSave('retry').catch(() => undefined)
    },
    onReconnect: () => {
      if (streamOffline && outstanding === null) {
        offline = null
        streamOffline = false
        sync()
      }
      if (offline !== null || outstanding !== null) session.retrySave()
    },
  })

  // ------------------------------------------------------------------ page lifecycle listeners

  function unloadFlush(): void {
    if (closed) return
    try {
      if (canSave() && !saving) {
        let req: SaveRequest | null = outstanding?.plan.req ?? null
        if (!req && dirty() && port && base.L) {
          const p = port
          const L = base.L
          const plan = planSaveRequest({
            md: p.md, L, base: { rev: base.rev, hash: base.hash }, bom: snapshot.bom, baseDoc: p.baseDoc(), review,
            holds: { hashes: heldHashes(), insertions: heldInsertions() }, suggestions: { ...p.suggestionPlan(L, review), reopen: [] },
            anchors: p.anchorUpdates(L, review), stableSince: () => undefined, now: env.now(), flushReason: true,
            cause: 'edit', allowPartial: true, clientId, saveId: ++saveIdSeq,
          })
          if (plan.kind === 'save') req = plan.req
        }
        if (req) void transport.request('POST', `/api/save?${fq}`, req, { keepalive: true }).catch(() => undefined)
      }
    } catch {
      // the draft below still keeps everything
    }
    void transport.request('POST', `/api/flush?${fq}`, { clientId, reason: 'beacon' }, { keepalive: true }).catch(() => undefined)
    if (dirty() || held.size > 0) void drafts.flush()
  }
  const onPageHide = (): void => unloadFlush()
  const onVisibility = (): void => {
    if (env.document?.visibilityState === 'hidden') scheduler.now('hidden')
  }
  env.window?.addEventListener('pagehide', onPageHide)
  env.window?.addEventListener('beforeunload', onPageHide)
  env.document?.addEventListener('visibilitychange', onVisibility)

  // ------------------------------------------------------------------ read markers (§12.9)

  const rmPending = new Map<string, { thread: ThreadId | null; upTo: number }>()
  const readMarkers = new ReadMarkerThrottle({
    now: env.now,
    known: (thread) => Math.max(review.cursors.tjRead, thread === null ? 0 : (review.cursors.tjReadByThread[thread] ?? 0)),
    send: (thread, upTo) => {
      const k = thread ?? ''
      const prev = rmPending.get(k)
      rmPending.set(k, { thread, upTo: Math.max(prev?.upTo ?? 0, upTo) })
      void queue.enqueue('readMarker', async () => {
        const m = rmPending.get(k)
        rmPending.delete(k)
        if (!m) return
        await call<SeqResponse>('POST', `/api/read-marker?${fq}`, { thread: m.thread, upTo: m.upTo })
        scheduleReviewRefresh()
      }, { coalesce: `readMarker:${k}` }).catch(() => undefined)
    },
  })

  // ------------------------------------------------------------------ decisions (internals, §6.6)

  function requireWritable(what: string): void {
    const ro = readOnlyReason(flags, file)
    if (ro) throw new SessionError({ code: 'READ_ONLY', status: 422, message: `${what}: ${ro.message}` })
  }

  const decisionCodes = new Set<ErrorCode>(['SUGGESTION_CLOSED', 'SUGGESTION_STALE'])
  function decisionReverted(code: ErrorCode): void {
    emitNotice({
      kind: 'warn',
      code: 'DECISION_REVERTED',
      text: code === 'SUGGESTION_STALE'
        ? 'That suggestion no longer matches the text, so it was not applied.'
        : 'That suggestion was already closed, so your decision was not applied.',
    })
    scheduleReviewRefresh()
  }

  // ------------------------------------------------------------------ clipboard

  /** Calls writeText synchronously (inside the gesture) and resolves whether it succeeded. */
  function tryCopy(text: string): Promise<boolean> {
    const c = env.clipboard()
    if (!c) return Promise.resolve(false)
    try {
      return c.writeText(text).then(() => true, () => false)
    } catch {
      return Promise.resolve(false)
    }
  }
  const prompt = (): string => buildClipboardPrompt({ file, abs: snapshot.abs, root: boot.root, round: null, ...promptIdentity() })

  // ------------------------------------------------------------------ the session

  const session: MdrDocSession = {
    file,
    root: boot.root,
    port: boot.port,
    clientId,
    getSnapshot: () => snapshot,
    getReview: () => review,
    getSaveState: () => saveState,
    getConflicts: () => [...held.values()].map((h) => h.entry),
    getBanner: () => banner,
    getLastHandoffEvent: () => lastHandoff,
    subscribe(cb) {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    onNotice(cb) {
      noticeSubs.add(cb)
      return () => void noticeSubs.delete(cb)
    },
    onNavigate(cb) {
      navSubs.add(cb)
      return () => void navSubs.delete(cb)
    },

    async flush() {
      if (closed || !canSave()) return { rev: base.rev }
      scheduler.cancel()
      if (dirty() || outstanding !== null || deferredUntil !== null || queue.has('save')) await enqueueSave('explicit')
      return { rev: base.rev }
    },

    retrySave() {
      if (saving || closed) return
      if (backoffTimer) {
        clearTimeout(backoffTimer)
        backoffTimer = null
      }
      saveError = null
      void enqueueSave('retry').catch(() => undefined)
      sync()
    },

    recreate() {
      if (!flags.docRemoved) {
        return Promise.reject(new SessionError({ code: 'BAD_REQUEST', status: 400, message: 'recreate() only applies while the doc-removed banner shows' }))
      }
      return queue.enqueue('save', async () => {
        const p = port
        const L = base.L
        let plan: SavePlan
        if (p && L) {
          plan = planSaveRequest({
            md: p.md, L, base: { rev: base.rev, hash: base.hash }, bom: snapshot.bom, baseDoc: p.baseDoc(), review,
            holds: { hashes: new Set(), insertions: new Set() }, suggestions: { upsert: [], withdraw: [], reopen: [] },
            anchors: [], stableSince: () => undefined, now: env.now(), flushReason: true, cause: 'recreate',
            allowPartial: false, clientId, saveId: ++saveIdSeq,
          })
        } else {
          plan = { kind: 'empty', deferredUntil: null, withheld: 0 }
        }
        const req: SaveRequest = plan.kind === 'save' ? plan.req : {
          clientId, saveId: ++saveIdSeq, base: { rev: base.rev, hash: base.hash, blockHashes: base.blockHashes }, ops: [],
          cause: 'recreate', allowPartial: false,
        }
        const gen = p?.changeGen() ?? 0
        saving = true
        sync()
        try {
          const res = await call<SaveResponse>('POST', `/api/save?${fq}`, req)
          flags.docRemoved = null
          saving = false
          if (plan.kind === 'save' && L) await handleSaveOk(plan, res, gen, L)
          else {
            const snap = await fetchDoc().catch(() => null)
            if (snap) adoptSnapshot(snap, { reason: 'remote', applyToLive: false })
          }
          sync()
          return res
        } catch (e) {
          saving = false
          emitNotice({ kind: 'error', code: 'RECREATE_FAILED', text: "Couldn't recreate the file from your copy. Your copy is still safe in this tab." })
          sync()
          throw e
        }
      })
    },

    async reload() {
      await drafts.flush().catch(() => undefined)
      env.reloadPage()
    },

    dismissBanner() {
      if (flags.reviewReset) {
        flags.reviewReset = null
        sync()
      }
    },

    getRecoveredDraft: () => recovered,

    async keepRecoveredDraft() {
      const r = recovered
      if (!r || r.reason !== 'merge-failed' || !port) return
      recovered = null
      notify('recovered')
      port.replaceAll(r.markdown)
      sync()
      await queue.enqueue('save', () => saveCycle('explicit', { cause: 'merge', allowPartial: false })).catch(() => undefined)
    },

    discardRecoveredDraft() {
      if (!recovered) return
      recovered = null
      notify('recovered')
      settleDraft()
    },

    copyRecoveredDraft() {
      return recovered ? tryCopy(recovered.markdown) : Promise.resolve(false)
    },

    async close() {
      if (closed) return
      try {
        await Promise.race([session.flush(), sleep(CLOSE_FLUSH_TIMEOUT_MS)])
      } catch {
        // the draft keeps anything unsaved
      }
      if (dirty() || held.size > 0) await drafts.flush().catch(() => undefined)
      closed = true
      sse.close()
      tabs.close()
      readMarkers.close()
      scheduler.stop()
      drafts.stop()
      queue.close()
      if (reviewTimer) clearTimeout(reviewTimer)
      if (backoffTimer) clearTimeout(backoffTimer)
      env.window?.removeEventListener('pagehide', onPageHide)
      env.window?.removeEventListener('beforeunload', onPageHide)
      env.document?.removeEventListener('visibilitychange', onVisibility)
    },

    createThread(anchor: Anchor, body: string): Promise<CreateThreadResponse> {
      const opKey = newOpKey()
      return queue.enqueue('threadOp', () => discrete(async () => {
        const r = await call<CreateThreadResponse>('POST', `/api/threads?${fq}`, { opKey, anchor, anchorRev: base.rev, body })
        applyThread(r.thread)
        scheduleReviewRefresh()
        return r
      }))
    },
    reply(thread: ThreadId, body: string): Promise<MessageResponse> {
      const opKey = newOpKey()
      return queue.enqueue('threadOp', () => discrete(async () => {
        const r = await call<MessageResponse>('POST', `/api/threads/${thread}/replies?${fq}`, { opKey, body })
        scheduleReviewRefresh()
        return r
      }))
    },
    editComment(comment: CommentId, body: string): Promise<MessageResponse> {
      const opKey = newOpKey()
      return queue.enqueue('threadOp', () => discrete(async () => {
        const r = await call<MessageResponse>('PATCH', `/api/comments/${comment}?${fq}`, { opKey, body })
        scheduleReviewRefresh()
        return r
      }))
    },
    deleteComment(comment: CommentId): Promise<SeqResponse> {
      const opKey = newOpKey()
      return queue.enqueue('threadOp', () => discrete(async () => {
        const r = await call<SeqResponse>('POST', `/api/comments/${comment}/delete?${fq}`, { opKey })
        scheduleReviewRefresh()
        return r
      }))
    },
    resolve(thread: ThreadId): Promise<ThreadOpResponse> {
      const opKey = newOpKey()
      return queue.enqueue('threadOp', () => discrete(async () => {
        const r = await call<ThreadOpResponse>('POST', `/api/threads/${thread}/resolve?${fq}`, { opKey })
        applyThread(r.thread)
        scheduleReviewRefresh()
        return r
      }))
    },
    reopen(thread: ThreadId): Promise<ThreadOpResponse> {
      const opKey = newOpKey()
      return queue.enqueue('threadOp', () => discrete(async () => {
        const r = await call<ThreadOpResponse>('POST', `/api/threads/${thread}/reopen?${fq}`, { opKey })
        applyThread(r.thread)
        scheduleReviewRefresh()
        return r
      }))
    },
    markRead(thread: ThreadId | null, upTo: number) {
      if (closed) return
      readMarkers.mark(thread, upTo)
    },

    handoff(message?: string): Promise<HandoffOutcome> {
      // §12.10 step 1, synchronously inside the gesture: copy the prompt before the first await
      const clientDecision: HandoffRequest['clientDecision'] = review.presence.waiter === 'none' ? 'clipboard' : 'waiter'
      const copying = clientDecision === 'clipboard' ? tryCopy(prompt()) : Promise.resolve(false)
      const opKey = newOpKey()
      // the Send button hands over what is new; with no message and nothing new the server says so instead of waking Claude
      const body: HandoffRequest = { opKey, clientDecision, ...(message !== undefined && message !== '' ? { message } : { onlyIfNew: true as const }) }
      return (async () => {
        const copied = await copying
        // step 2: flush (queue rule) + POST /api/handoff; no retries, so an offline click is answered at once
        let r: HandoffResult
        try {
          r = await queue.enqueue('handoff', () => call<HandoffResult>('POST', `/api/handoff?${fq}`, body))
        } catch (e) {
          // step 6 (P3 merge): the rejection carries what the gesture did, so the offline toast can say "copied"
          if (typeof e === 'object' && e !== null && Object.isExtensible(e)) Object.assign(e, { clientDecision, copied })
          throw e
        }
        review = { ...review, presence: r.presence }
        notify('presence')
        scheduleReviewRefresh()
        return { ...r, clientDecision, copied }
      })()
    },
    copyPrompt() {
      return tryCopy(prompt())
    },

    async revealFile(): Promise<void> {
      await call<{ ok: true }>('POST', '/api/reveal', { file })
    },

    setPolicy(p: ReviewPolicy): Promise<SeqResponse> {
      return queue.enqueue('policy', () => discrete(async () => {
        myPolicy = p.suggestOnly
        const r = await call<SeqResponse>('POST', `/api/policy?${fq}`, { suggestOnly: p.suggestOnly })
        review = { ...review, policy: { suggestOnly: p.suggestOnly } }
        notify('review')
        scheduleReviewRefresh()
        return r
      }))
    },

    history: {
      list: (): Promise<HistoryList> => call<HistoryList>('GET', `/api/history?${fq}`),
      show: (v: VersionId): Promise<VersionShow> => call<VersionShow>('GET', `/api/history/version?${fq}&v=${encodeURIComponent(v)}`),
      diff: (from: HistoryRef, to: HistoryRef): Promise<HistoryDiff> =>
        call<HistoryDiff>('GET', `/api/history/diff?${fq}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      restore(v: VersionId): Promise<RestoreResponse> {
        const opKey = newOpKey()
        return queue.enqueue('restore', async () => {
          requireWritable('restore')
          let r: RestoreResponse
          try {
            r = await discrete(() => call<RestoreResponse>('POST', `/api/history/restore?${fq}`, { opKey, v, baseRev: base.rev }))
          } catch (e) {
            // §10: on 409 STALE_REVISION adopt `current` through the reload path; P3 re-offers the restore
            if (isSessionError(e) && e.code === 'STALE_REVISION' && e.current) {
              adoptSnapshot(e.current, { reason: 'restore', applyToLive: true })
              await refreshReviewNow().catch(() => undefined)
            }
            throw e
          }
          // D47: the open editor adopts the restored doc (clean branch of §12.6) before the promise resolves; the SSE
          // echo of this commit carries our clientId (rule 1) and the new hash (rule 2), so it is dropped
          adoptSnapshot(r.snapshot, { reason: 'restore', applyToLive: true })
          await refreshReviewNow().catch(() => undefined)
          return r
        })
      },
    },

    takeOver() {
      tabs.takeOver()
    },
  }

  // ------------------------------------------------------------------ internals for the editor

  const internals: SessionInternals = {
    boot,
    clientId,
    async attachEditor(p: EditorPort) {
      if (port) throw new Error('mdr session: an editor is already attached')
      port = p
      // expectedFingerprint() is now the bundle's own md fingerprint
      checkFingerprint(snapshot.schemaFingerprint)
      if (!noDocument()) {
        const L = load(p.md, snapshot.markdown, { fidelityHints: fidelityHintsOf(snapshot.blocks) })
        const mismatch = checkParity(L, snapshot.blocks)
        if (mismatch) flags.contractMismatch = mismatch
        base = { L, rev: snapshot.rev, hash: snapshot.hash, blockHashes: L.blocks.map((b) => b.hash) }
        p.install(L)
      }
      savedGen = p.changeGen()
      if (flags.docRemoved) flags.docRemoved = { canRecreate: base.L !== null }
      // the editor learns its initial editability now; sync() reports only changes after this
      lastEditable = editable()
      p.setEditable(lastEditable)
      sync()
      await tabs.ready
      if (port === p) await restoreDraft()
    },
    detachEditor(p: EditorPort) {
      if (port !== p) return
      port = null
      base = { ...base, L: null }
      sync()
    },
    getLoaded: () => base.L,
    heldHashes: () => heldHashes(),
    isEditable: () => editable(),
    changed() {
      if (closed) return
      if (canSave()) scheduler.changed()
      drafts.schedule()
      sync()
    },
    blurred() {
      if (dirty() || deferredUntil !== null) scheduler.now('blur')
    },
    compositionEnded() {
      scheduler.compositionEnd()
    },
    decide(id: SuggestionId, decision: 'accept' | 'reject') {
      const opKey = newOpKey()
      return queue.enqueue('decision', async () => {
        if (readOnlyReason(flags, file)) return { ok: false, code: 'READ_ONLY' as ErrorCode }
        let r: DecisionResult
        try {
          r = await discrete(() => call<DecisionResult>('POST', `/api/suggestions/${id}/${decision}?${fq}`, { opKey }))
        } catch (e) {
          const code: ErrorCode = isSessionError(e) ? e.code : 'INTERNAL'
          if (decisionCodes.has(code)) decisionReverted(code)
          return { ok: false, code }
        }
        if (r.duplicate) {
          scheduleReviewRefresh()
          return { ok: true, noop: true as const }
        }
        noteDecided([id], r.status)
        const placed = port ? port.decisionApplied({ ids: [id], decision }) : true
        if (r.changes.length > 0 || r.hash !== loadedHash()) await adoptOwnText(r.rev, r.hash, placed, 'decision')
        scheduleReviewRefresh()
        return { ok: true }
      })
    },
    async bulk(sel) {
      const ids = sel.ids ? [...sel.ids] : undefined
      const candidates = review.suggestions.filter((s) =>
        (s.status === 'pending' || s.status === 'stale') && (sel.by === undefined || s.by === sel.by) && (ids === undefined || ids.includes(s.id)))
      if (candidates.length === 0) return null
      const authors: Author[] = sel.by ? [sel.by] : ['TJ', 'Claude']
      const opKey = newOpKey()
      return queue.enqueue('bulk', async () => {
        requireWritable('bulk decision')
        const body: BulkDecisionRequest = { opKey, decision: sel.decision, authors, ...(ids ? { ids } : {}) }
        const r = await discrete(() => call<BulkDecisionResult>('POST', `/api/suggestions/bulk?${fq}`, body))
        const ok = r.results.filter((x) => x.ok).map((x) => x.id)
        const refused = r.results.find((x) => !x.ok && x.code !== undefined && decisionCodes.has(x.code))
        if (ok.length > 0) {
          noteDecided(ok, sel.decision === 'accept' ? 'accepted' : 'rejected')
          const placed = port ? port.decisionApplied({ ids: ok, decision: sel.decision, bulk: opKey }) : true
          if (r.hash !== loadedHash()) await adoptOwnText(r.rev, r.hash, placed, 'decision')
        }
        if (refused?.code) decisionReverted(refused.code)
        scheduleReviewRefresh()
        return r
      })
    },
    async resolveConflict(id, choice) {
      const h = held.get(id)
      if (!h) return
      held.delete(id)
      notify('conflicts')
      if (choice === 'theirs') {
        if (port && base.L) port.takeTheirs(h.entry, base.L)
        sync()
        settleDraft()
        return
      }
      sync()
      if (h.entry.kind === 'conflict') {
        // Keep mine: release the hold; the next save writes mine with cause 'merge' (§7.4)
        await queue.enqueue('save', () => saveCycle('explicit', { cause: 'merge', allowPartial: false })).catch(() => undefined)
      } else {
        // unsaveable: re-plan and retry once (it is held again if it still fails)
        await enqueueSave('explicit').catch(() => undefined)
      }
    },
    notice: (n) => emitNotice(n),
    onEditableChange(cb) {
      editableSubs.add(cb)
      return () => void editableSubs.delete(cb)
    },
  }

  async function restoreDraft(): Promise<void> {
    const d = pendingDraft
    pendingDraft = null
    const p = port
    if (!d || !p || !base.L || tabs.role === 'follower' || noDocument()) return
    const branch = classifyDraft(d, snapshot)
    if (branch === 'doc-reset') {
      recovered = { reason: 'merge-failed', markdown: p.markdownOf(d.liveDoc) ?? d.baseMarkdown, baseRev: d.baseRev, savedAt: d.savedAt }
      notify('recovered')
      await drafts.clear()
      return
    }
    let draftBase: Loaded | null = null
    if (branch === 'other-base') {
      try {
        draftBase = load(p.md, d.baseMarkdown)
      } catch {
        draftBase = null
      }
    }
    const ok = (branch === 'same-base' || draftBase !== null) && p.restoreDraft({ liveDoc: d.liveDoc, selection: d.selection })
    if (!ok) {
      recovered = { reason: 'schema-invalid', markdown: p.markdownOf(d.liveDoc) ?? d.baseMarkdown, baseRev: d.baseRev, savedAt: d.savedAt }
      notify('recovered')
      return
    }
    if (branch === 'other-base' && draftBase) {
      // plan against the draft's base; the server merges against current (no server blob needed)
      base = { L: draftBase, rev: d.baseRev, hash: d.baseHash, blockHashes: draftBase.blocks.map((b) => b.hash) }
    }
    if (d.heldConflicts.length > 0) holdFromDraft(d.heldConflicts)
    emitNotice({ kind: 'info', code: 'DRAFT_RECOVERED', text: 'Recovered unsaved edits' })
    sync()
    await enqueueSave('draft').catch(() => undefined)
  }

  // ------------------------------------------------------------------ start

  updateReadOnlyFlags()
  checkFingerprint(snapshot.schemaFingerprint)
  sessionInternals.set(session, internals)
  tabs.start()
  // QA pass 4 #3: a restarted server mints a new token; the old one is refused for good. Stop retrying, go read-only with
  // the connection-lost banner, and put unsaved text in the local draft store (Reload brings it back).
  onAuthLost = () => {
    if (closed || flags.authLost) return
    flags.authLost = true
    scheduler.cancel()
    if (backoffTimer) clearTimeout(backoffTimer)
    backoffTimer = null
    offline = null
    streamOffline = false
    saveError = null
    sse.close()
    void drafts.flush().catch(() => undefined)
    sync()
  }

  sse.start()
  sync()
  return session
}
