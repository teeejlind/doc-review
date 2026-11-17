// tests/fakes/FakeDocSession.ts (integrator, day 0; CONTRACTS §2.2 "Session factory" / "Data ↔ UI", §12.0.3, §12.1,
// §12.10, §12.14). Browser-safe: no node:*, no core/, no ProseMirror.
//
// A DocSession P3 builds against before P2 lands. Two modes:
//   - scripted (no transport): every state is local and set through `emit(...)`; the thread ops, decisions, policy,
//     history and handoff mutate that local state and resolve plausible, schema-shaped answers. Unit tests drive it.
//   - live (`transport` given, which is what tests/fakes/web-session.ts does in the MDR_FAKE_EDITOR page): the
//     snapshot and review come from GET /api/doc and /api/review, the browser SSE stream keeps them current
//     (sidecar-changed → refetch review, doc-changed, presence, claude-activity, handoff, navigate, doc-removed), and
//     the thread ops, decisions, policy, read markers, handoff and history go to the real routes. `emit(...)` still
//     overrides any state (banners, recovered drafts, notices) for P3's e2e specs.
// The fake editor never edits text, so the session never saves; flush() resolves the current rev.
import { ulid } from 'ulid'
import type {
  Anchor, BlockConflict, BrowserSseEvent, BulkDecisionResult, ClaudeActivity, ClientId, CommentId, CreateThreadResponse,
  DecisionResult, DocSession, DocSnapshot, HandoffOutcome, HandoffResult, HistoryDiff, HistoryList, HistoryRef,
  Message, MessageResponse, OpKey, Presence, RecoveredDraft, RestoreResponse, ReviewPolicy, ReviewState, SaveResponse,
  SaveState, SeqResponse, SessionBanner, SessionBootstrap, SessionEvent, SessionNotice, Suggestion, SuggestionId,
  Thread, ThreadId, ThreadOpResponse, Transport, Unsubscribe, VersionId, VersionMeta, VersionShow,
} from '../../shared/types'
import { buildClipboardPrompt } from '../../shared/handoff-prompt'

export type HandoffSseData = Extract<BrowserSseEvent, { event: 'handoff' }>['data']

/** What `emit` can set (§2.5: presence | activity | handoff | banner | recovered, plus the rest of the state). */
export type FakeSessionEmit =
  | { presence: Presence }
  | { activity: ClaudeActivity }
  | { handoff: HandoffSseData }
  | { banner: SessionBanner | null }
  | { recovered: RecoveredDraft | null }
  | { notice: SessionNotice }
  | { snapshot: DocSnapshot }
  | { review: ReviewState }
  | { save: SaveState }
  | { conflicts: BlockConflict[] }
  | { navigate: string }

export interface FakeDocSessionOptions {
  file?: string
  root?: string
  port?: number
  /** Initial markdown for the default snapshot (ignored when `snapshot` is given). */
  markdown?: string
  snapshot?: DocSnapshot
  review?: Partial<ReviewState>
  saveState?: SaveState
  conflicts?: BlockConflict[]
  banner?: SessionBanner | null
  recovered?: RecoveredDraft | null
  /** Scripted history (scripted mode). */
  history?: { versions: VersionMeta[]; markdown?: Partial<Record<VersionId, string>> }
  /** Answer handoff() with this instead of the computed default (scripted mode). */
  handoffResult?: Partial<HandoffResult>
  /** Clipboard used inside handoff()/copyPrompt()/copyRecoveredDraft(). Default navigator.clipboard. */
  clipboard?: { writeText(s: string): Promise<void> } | null
  /** Live mode: REST + SSE through this transport. */
  transport?: Transport
  /** Live mode: the page bootstrap (token for the SSE query). */
  boot?: SessionBootstrap
  clientId?: ClientId
}

export interface FakeDocSession extends DocSession {
  /** Set any piece of state and notify subscribers (§2.5: same effect as the /__test routes in unit tests). */
  emit(e: FakeSessionEmit): void
  /** Every DocSession method call, in order. */
  readonly calls: Array<{ method: string; args: unknown[] }>
  /** The last SSE `handoff` event (frozen on DocSession at the P2 merge; restated here with the local alias). */
  getLastHandoffEvent(): HandoffSseData | null
  /** Notices delivered so far. */
  readonly notices: SessionNotice[]
  /** true once close() ran. */
  readonly closed: boolean
  /** Decision hooks the fake bridge calls (scripted: local status change; live: the decision routes). */
  decide(id: SuggestionId, decision: 'accept' | 'reject'): Promise<{ ok: boolean; code?: string }>
  decideMany(ids: readonly SuggestionId[], decision: 'accept' | 'reject'): Promise<BulkDecisionResult>
  dropConflict(id: BlockConflict['id']): void
  /** Live mode: refetch snapshot and review now. */
  refresh(): Promise<void>
}

const ZERO_HASH = '0'.repeat(64)
const nowIso = (): string => new Date().toISOString()
const opKey = (): OpKey => `op_${ulid()}`

function defaultSnapshot(file: string, root: string, markdown: string): DocSnapshot {
  return {
    file, abs: `${root}/${file}`, docId: null, rev: 0, hash: ZERO_HASH, markdown, bom: false, eol: '\n',
    size: markdown.length, mtimeMs: 0, blocks: [], seq: 0, schemaFingerprint: '0'.repeat(16), readOnly: false,
  }
}

function defaultReview(file: string): ReviewState {
  return {
    ok: true, file, rev: 0, seq: 0, threads: [], suggestions: [],
    cursors: { claudeAck: 0, tjRead: 0, tjReadByThread: {} },
    presence: { waiter: 'none' },
    activity: { file, state: 'idle', since: nowIso(), unreadFromClaude: 0 },
    undeliveredHandoffs: [], policy: { suggestOnly: false }, warnings: [], readOnly: false,
  }
}

/** A rejection the way main.tsx's codeOf() reads it: an Error with `code` and the ApiErrorBody. */
function apiError(status: number, json: unknown): Error & { code: string; status: number; body: unknown } {
  const body = (json as { error?: { code?: string; message?: string } } | undefined)?.error
  const e = new Error(body?.message ?? `HTTP ${status}`) as Error & { code: string; status: number; body: unknown }
  e.code = body?.code ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST')
  e.status = status
  e.body = body ?? json
  return e
}

export function createFakeDocSession(o: FakeDocSessionOptions = {}): FakeDocSession {
  const file = o.snapshot?.file ?? o.file ?? 'doc.md'
  const root = o.root ?? o.boot?.root ?? '/fake-root'
  const port = o.port ?? o.boot?.port ?? 0
  let snapshot: DocSnapshot = o.snapshot ?? defaultSnapshot(file, root, o.markdown ?? '# Fake document\n\nA paragraph.\n')
  let review: ReviewState = { ...defaultReview(file), ...(o.review ?? {}) }
  let saveState: SaveState = o.saveState ?? { state: 'saved', rev: snapshot.rev, at: nowIso() }
  let conflicts: BlockConflict[] = [...(o.conflicts ?? [])]
  let banner: SessionBanner | null = o.banner ?? null
  let recovered: RecoveredDraft | null = o.recovered ?? null
  let lastHandoff: HandoffSseData | null = null
  let localSeq = review.seq
  const subs = new Set<(what: SessionEvent) => void>()
  const noticeSubs = new Set<(n: SessionNotice) => void>()
  const navSubs = new Set<(f: string) => void>()
  const calls: Array<{ method: string; args: unknown[] }> = []
  const notices: SessionNotice[] = []
  const transport = o.transport
  const clientId = o.clientId ?? (`k_${ulid()}` as ClientId)
  const fq = `file=${encodeURIComponent(file)}`
  let es: ReturnType<Transport['events']> | null = null
  let closed = false
  let reviewTimer: ReturnType<typeof setTimeout> | null = null

  const notify = (...what: SessionEvent[]): void => {
    for (const w of what) for (const cb of [...subs]) cb(w)
  }
  const call = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args })
  }
  const clip = (): { writeText(s: string): Promise<void> } | null =>
    o.clipboard !== undefined ? o.clipboard : (typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null)
  const tryCopy = async (text: string): Promise<boolean> => {
    const c = clip()
    if (!c) return false
    try {
      await c.writeText(text)
      return true
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------------ live plumbing

  async function req<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const r = await transport!.request(method, path, body)
    if (r.status < 200 || r.status >= 300) throw apiError(r.status, r.json)
    return r.json as T
  }
  async function refetchReview(): Promise<void> {
    if (!transport) return
    review = await req<ReviewState>('GET', `/api/review?${fq}`)
    notify('review', 'presence', 'activity')
  }
  async function refetchDoc(): Promise<void> {
    if (!transport) return
    snapshot = await req<DocSnapshot>('GET', `/api/doc?${fq}`)
    saveState = { state: 'saved', rev: snapshot.rev, at: nowIso() }
    notify('doc', 'save')
  }
  function scheduleReview(): void {
    if (reviewTimer) clearTimeout(reviewTimer)
    reviewTimer = setTimeout(() => {
      reviewTimer = null
      void refetchReview().catch(() => undefined)
    }, 50)
  }
  function openStream(): void {
    if (!transport || !o.boot) return
    const qs = new URLSearchParams({ file, clientId, t: o.boot.token, afterSeq: String(review.seq), knownRev: String(snapshot.rev) })
    es = transport.events(`/api/events?${qs.toString()}`)
    const on = (type: string, fn: (data: unknown) => void): void => es!.addEventListener(type, (e) => fn(JSON.parse(e.data)))
    on('sidecar-changed', (d) => {
      const seq = (d as { seq: number }).seq
      if (seq > review.seq) scheduleReview()
    })
    on('doc-changed', (d) => {
      const x = d as { rev: number; hash: string; markdown?: string }
      if (x.hash === snapshot.hash) return
      if (x.markdown !== undefined) {
        snapshot = { ...snapshot, rev: x.rev, hash: x.hash, markdown: x.markdown }
        notify('doc')
        void refetchDoc().catch(() => undefined)
      } else void refetchDoc().catch(() => undefined)
    })
    on('resync', () => {
      void refetchDoc().then(refetchReview).catch(() => undefined)
    })
    on('presence', (d) => {
      const { file: _f, ...p } = d as Presence & { file: string }
      review = { ...review, presence: p }
      notify('presence')
    })
    on('claude-activity', (d) => {
      review = { ...review, activity: d as ClaudeActivity }
      notify('activity')
    })
    on('handoff', (d) => {
      lastHandoff = d as HandoffSseData
      notify('handoff')
      scheduleReview()
    })
    on('navigate', (d) => {
      for (const cb of [...navSubs]) cb((d as { file: string }).file)
    })
    on('doc-removed', () => {
      banner = { kind: 'doc-removed', canRecreate: true }
      saveState = { state: 'readonly', code: 'DOC_GONE', message: `${file} was moved or deleted` }
      notify('banner', 'save')
    })
    on('server-shutdown', () => {
      saveState = { state: 'offline', since: nowIso(), retryAt: nowIso() }
      notify('save')
    })
    es.onerror = () => {
      if (closed) return
      // reconnect after a beat, like EventSource
      setTimeout(() => {
        if (!closed) openStream()
      }, 500)
    }
  }

  // ------------------------------------------------------------------ local mutations (scripted mode)

  const findThread = (id: ThreadId): Thread => {
    const t = review.threads.find((x) => x.id === id)
    if (!t) throw apiError(404, { error: { code: 'THREAD_NOT_FOUND', message: `thread ${id} not found` } })
    return t
  }
  const replaceThread = (t: Thread): void => {
    review = { ...review, threads: review.threads.map((x) => (x.id === t.id ? t : x)), seq: localSeq }
    notify('review')
  }
  const newMessage = (body: string): Message => ({ id: `c_${ulid()}` as CommentId, by: 'TJ', at: nowIso(), body, seq: ++localSeq })

  const session: FakeDocSession = {
    file,
    root,
    port,
    calls,
    notices,
    get closed() {
      return closed
    },
    getSnapshot: () => snapshot,
    getReview: () => review,
    getSaveState: () => saveState,
    getConflicts: () => conflicts,
    getBanner: () => banner,
    getLastHandoffEvent: () => lastHandoff,
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    onNotice(cb) {
      noticeSubs.add(cb)
      return () => noticeSubs.delete(cb)
    },
    onNavigate(cb) {
      navSubs.add(cb)
      return () => navSubs.delete(cb)
    },

    emit(e) {
      if ('presence' in e) {
        review = { ...review, presence: e.presence }
        notify('presence')
      } else if ('activity' in e) {
        review = { ...review, activity: e.activity }
        notify('activity')
      } else if ('handoff' in e) {
        lastHandoff = e.handoff
        notify('handoff')
      } else if ('banner' in e) {
        banner = e.banner
        notify('banner')
      } else if ('recovered' in e) {
        recovered = e.recovered
        notify('recovered')
      } else if ('notice' in e) {
        notices.push(e.notice)
        for (const cb of [...noticeSubs]) cb(e.notice)
      } else if ('snapshot' in e) {
        snapshot = e.snapshot
        notify('doc')
      } else if ('review' in e) {
        review = e.review
        localSeq = Math.max(localSeq, e.review.seq)
        notify('review', 'presence', 'activity')
      } else if ('save' in e) {
        saveState = e.save
        notify('save')
      } else if ('conflicts' in e) {
        conflicts = [...e.conflicts]
        notify('conflicts')
      } else if ('navigate' in e) {
        for (const cb of [...navSubs]) cb(e.navigate)
      }
    },

    async flush() {
      call('flush')
      return { rev: snapshot.rev }
    },
    retrySave() {
      call('retrySave')
    },
    async recreate() {
      call('recreate')
      if (banner?.kind === 'doc-removed') banner = null
      saveState = { state: 'saved', rev: snapshot.rev + 1, at: nowIso() }
      notify('banner', 'save')
      const out: SaveResponse = {
        ok: true, applied: 'direct', rev: snapshot.rev + 1, hash: snapshot.hash, seq: review.seq + 1, conflicts: [], unsaveable: [],
        warnings: [], staled: [], rebasedSuggestions: [],
      }
      return out
    },
    async reload() {
      call('reload')
    },
    dismissBanner() {
      call('dismissBanner')
      if (banner?.kind === 'review-reset') {
        banner = null
        notify('banner')
      }
    },
    getRecoveredDraft: () => recovered,
    async keepRecoveredDraft() {
      call('keepRecoveredDraft')
      recovered = null
      notify('recovered')
    },
    discardRecoveredDraft() {
      call('discardRecoveredDraft')
      recovered = null
      notify('recovered')
    },
    async copyRecoveredDraft() {
      call('copyRecoveredDraft')
      return recovered ? tryCopy(recovered.markdown) : false
    },
    async close() {
      call('close')
      closed = true
      es?.close()
      if (reviewTimer) clearTimeout(reviewTimer)
    },

    async createThread(anchor: Anchor, body: string): Promise<CreateThreadResponse> {
      call('createThread', anchor, body)
      if (transport) {
        const r = await req<CreateThreadResponse>('POST', `/api/threads?${fq}`, { opKey: opKey(), anchor, anchorRev: snapshot.rev, body })
        await refetchReview()
        return r
      }
      const msg = newMessage(body)
      const t: Thread = {
        id: `t_${ulid()}` as ThreadId, kind: anchor.kind === 'doc' ? 'doc' : 'comment', status: 'open', autoResolved: false,
        anchor, lastAnchor: anchor, resolution: { state: anchor.kind === 'doc' ? 'doc' : 'exact' }, detached: false,
        createdBy: 'TJ', createdSeq: msg.seq, lastSeq: msg.seq, messages: [msg], suggestions: [], unread: 0,
      }
      review = { ...review, threads: [...review.threads, t], seq: localSeq }
      notify('review')
      return { ok: true, thread: t, seq: localSeq }
    },
    async reply(thread, body): Promise<MessageResponse> {
      call('reply', thread, body)
      if (transport) {
        const r = await req<MessageResponse>('POST', `/api/threads/${thread}/replies?${fq}`, { opKey: opKey(), body })
        await refetchReview()
        return r
      }
      const t = findThread(thread)
      const message = newMessage(body)
      replaceThread({ ...t, status: 'open', messages: [...t.messages, message], lastSeq: message.seq })
      return { ok: true, message, seq: localSeq }
    },
    async editComment(comment, body): Promise<MessageResponse> {
      call('editComment', comment, body)
      if (transport) {
        const r = await req<MessageResponse>('PATCH', `/api/comments/${comment}?${fq}`, { opKey: opKey(), body })
        await refetchReview()
        return r
      }
      const t = review.threads.find((x) => x.messages.some((m) => m.id === comment))
      if (!t) throw apiError(404, { error: { code: 'COMMENT_NOT_FOUND', message: `comment ${comment} not found` } })
      const message = { ...t.messages.find((m) => m.id === comment)!, body, editedAt: nowIso() }
      localSeq++
      replaceThread({ ...t, messages: t.messages.map((m) => (m.id === comment ? message : m)) })
      return { ok: true, message, seq: localSeq }
    },
    async deleteComment(comment): Promise<SeqResponse> {
      call('deleteComment', comment)
      if (transport) {
        const r = await req<SeqResponse>('POST', `/api/comments/${comment}/delete?${fq}`, { opKey: opKey() })
        await refetchReview()
        return r
      }
      const t = review.threads.find((x) => x.messages.some((m) => m.id === comment))
      if (!t) throw apiError(404, { error: { code: 'COMMENT_NOT_FOUND', message: `comment ${comment} not found` } })
      localSeq++
      replaceThread({ ...t, messages: t.messages.map((m) => (m.id === comment ? { ...m, body: '', deleted: true as const } : m)) })
      return { ok: true, seq: localSeq }
    },
    async resolve(thread): Promise<ThreadOpResponse> {
      call('resolve', thread)
      if (transport) {
        const r = await req<ThreadOpResponse>('POST', `/api/threads/${thread}/resolve?${fq}`, { opKey: opKey() })
        await refetchReview()
        return r
      }
      const t = { ...findThread(thread), status: 'resolved' as const, lastSeq: ++localSeq }
      replaceThread(t)
      return { ok: true, thread: t, seq: localSeq }
    },
    async reopen(thread): Promise<ThreadOpResponse> {
      call('reopen', thread)
      if (transport) {
        const r = await req<ThreadOpResponse>('POST', `/api/threads/${thread}/reopen?${fq}`, { opKey: opKey() })
        await refetchReview()
        return r
      }
      const t = { ...findThread(thread), status: 'open' as const, lastSeq: ++localSeq }
      replaceThread(t)
      return { ok: true, thread: t, seq: localSeq }
    },
    markRead(thread, upTo) {
      call('markRead', thread, upTo)
      if (transport) {
        void req('POST', `/api/read-marker?${fq}`, { thread, upTo }).then(() => scheduleReview()).catch(() => undefined)
        return
      }
      const cursors = thread === null
        ? { ...review.cursors, tjRead: Math.max(review.cursors.tjRead, upTo) }
        : { ...review.cursors, tjReadByThread: { ...review.cursors.tjReadByThread, [thread]: Math.max(review.cursors.tjReadByThread[thread] ?? 0, upTo) } }
      review = { ...review, cursors, threads: review.threads.map((t) => (thread === null || t.id === thread ? { ...t, unread: 0 } : t)) }
      notify('review')
    },

    handoff(message?: string): Promise<HandoffOutcome> {
      call('handoff', message)
      // §12.10 step 1: synchronously, inside the gesture, before any await
      const clientDecision: HandoffOutcome['clientDecision'] = review.presence.waiter === 'none' ? 'clipboard' : 'waiter'
      const copying = clientDecision === 'clipboard'
        ? tryCopy(buildClipboardPrompt({ file, abs: snapshot.abs, root, round: null }))
        : Promise.resolve(false)
      return (async () => {
        const copied = await copying
        if (transport) {
          let r: HandoffResult
          try {
            r = await req<HandoffResult>('POST', `/api/handoff?${fq}`, { opKey: opKey(), ...(message ? { message } : { onlyIfNew: true }), clientDecision })
          } catch (e) {
            // §12.10 step 6 (P3 merge): a rejection carries what the gesture did, like P2's session
            if (typeof e === 'object' && e !== null && Object.isExtensible(e)) Object.assign(e, { clientDecision, copied })
            throw e
          }
          review = { ...review, presence: r.presence }
          notify('presence')
          scheduleReview()
          return { ...r, clientDecision, copied }
        }
        const delivery: HandoffResult['delivery'] = clientDecision === 'clipboard' ? 'clipboard'
          : review.presence.waiter === 'connected' ? 'waiter' : 'latched'
        const base: HandoffResult = {
          ok: true, seq: ++localSeq, coalesced: false, delivery,
          prompt: buildClipboardPrompt({ file, abs: snapshot.abs, root, round: 1 }), presence: review.presence,
        }
        return { ...base, ...(o.handoffResult ?? {}), clientDecision, copied }
      })()
    },
    async copyPrompt() {
      call('copyPrompt')
      return tryCopy(buildClipboardPrompt({ file, abs: snapshot.abs, root, round: null }))
    },
    async setPolicy(p: ReviewPolicy): Promise<SeqResponse> {
      call('setPolicy', p)
      if (transport) {
        const r = await req<SeqResponse>('POST', `/api/policy?${fq}`, p)
        await refetchReview()
        return r
      }
      review = { ...review, policy: { ...p }, seq: ++localSeq }
      notify('review')
      return { ok: true, seq: localSeq }
    },
    history: {
      async list(): Promise<HistoryList> {
        call('history.list')
        if (transport) return req<HistoryList>('GET', `/api/history?${fq}`)
        return { ok: true, file, versions: [...(o.history?.versions ?? [])], currentRev: snapshot.rev, currentHash: snapshot.hash, unsnapshotted: false }
      },
      async show(v: VersionId): Promise<VersionShow> {
        call('history.show', v)
        if (transport) return req<VersionShow>('GET', `/api/history/version?${fq}&v=${v}`)
        const meta = o.history?.versions.find((x) => x.v === v)
        if (!meta) throw apiError(404, { error: { code: 'VERSION_NOT_FOUND', message: `version ${v} not found` } })
        return { ok: true, meta, markdown: o.history?.markdown?.[v] ?? '' }
      },
      async diff(from: HistoryRef, to: HistoryRef): Promise<HistoryDiff> {
        call('history.diff', from, to)
        if (transport) return req<HistoryDiff>('GET', `/api/history/diff?${fq}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
        const side = (r: HistoryRef): HistoryDiff['from'] => o.history?.versions.find((x) => x.v === r) ?? { current: true, rev: snapshot.rev, hash: snapshot.hash }
        return { ok: true, from: side(from), to: side(to), blocks: [] }
      },
      async restore(v: VersionId): Promise<RestoreResponse> {
        call('history.restore', v)
        if (transport) {
          const r = await req<RestoreResponse>('POST', `/api/history/restore?${fq}`, { opKey: opKey(), v, baseRev: snapshot.rev })
          snapshot = r.snapshot
          notify('doc')
          await refetchReview()
          return r
        }
        const meta = o.history?.versions.find((x) => x.v === v)
        if (!meta) throw apiError(404, { error: { code: 'VERSION_NOT_FOUND', message: `version ${v} not found` } })
        snapshot = { ...snapshot, rev: snapshot.rev + 1, markdown: o.history?.markdown?.[v] ?? snapshot.markdown }
        notify('doc')
        return { ok: true, rev: snapshot.rev, hash: snapshot.hash, seq: ++localSeq, version: meta, detached: [], staled: [], snapshot }
      },
    },
    takeOver() {
      call('takeOver')
      if (banner?.kind === 'tab-not-leader') {
        banner = null
        if (saveState.state === 'readonly' && saveState.code === 'TAB_NOT_LEADER') saveState = { state: 'saved', rev: snapshot.rev, at: nowIso() }
        notify('banner', 'save')
      }
    },

    async decide(id, decision) {
      call('decide', id, decision)
      if (transport) {
        const r = await transport.request('POST', `/api/suggestions/${id}/${decision}?${fq}`, { opKey: opKey() })
        if (r.status >= 300) return { ok: false, code: (r.json as { error?: { code?: string } }).error?.code ?? 'INTERNAL' }
        const d = r.json as DecisionResult
        if (d.changes.length) await refetchDoc()
        await refetchReview()
        return { ok: true }
      }
      const s = review.suggestions.find((x) => x.id === id)
      if (!s) return { ok: false, code: 'SUGGESTION_NOT_FOUND' }
      if (s.status !== 'pending' && s.status !== 'stale') return { ok: false, code: 'SUGGESTION_CLOSED' }
      const status: Suggestion['status'] = decision === 'accept' ? 'accepted' : 'rejected'
      review = {
        ...review, seq: ++localSeq,
        suggestions: review.suggestions.map((x) => (x.id === id ? { ...x, status, decidedBy: 'TJ' as const, decidedSeq: localSeq, located: null } : x)),
      }
      notify('review')
      return { ok: true }
    },
    async decideMany(ids, decision) {
      call('decideMany', ids, decision)
      if (transport) {
        const r = await req<BulkDecisionResult>('POST', `/api/suggestions/bulk?${fq}`, { opKey: opKey(), decision, authors: [], ids: [...ids] })
        await refetchDoc()
        await refetchReview()
        return r
      }
      const results: BulkDecisionResult['results'] = []
      for (const id of ids) {
        const r = await session.decide(id, decision)
        results.push(r.ok ? { id, ok: true } : { id, ok: false, code: (r.code ?? 'INTERNAL') as never })
      }
      return { ok: true, rev: snapshot.rev, hash: snapshot.hash, seq: localSeq, results }
    },
    dropConflict(id) {
      conflicts = conflicts.filter((c) => c.id !== id)
      if (saveState.state === 'conflict') saveState = conflicts.length ? { state: 'conflict', count: conflicts.length } : { state: 'saved', rev: snapshot.rev, at: nowIso() }
      notify('conflicts', 'save')
    },
    async refresh() {
      await refetchDoc()
      await refetchReview()
    },
  }
  if (transport && o.boot) openStream()
  return session
}

/**
 * Live fake session (what tests/fakes/web-session.ts' openDocSession returns): fetches the snapshot and review through
 * `transport` and opens the browser SSE stream. Rejects like openDocSession for FILE_NOT_FOUND / DOC_GONE /
 * PROTECTED_ROOT / PATH_OUTSIDE_ROOT (an Error carrying `code`).
 */
export async function openFakeDocSession(o: { boot: SessionBootstrap; file: string; transport: Transport; clientId?: ClientId; clipboard?: FakeDocSessionOptions['clipboard'] }): Promise<FakeDocSession> {
  const fq = `file=${encodeURIComponent(o.file)}`
  const d = await o.transport.request('GET', `/api/doc?${fq}`)
  if (d.status !== 200) throw apiError(d.status, d.json)
  const r = await o.transport.request('GET', `/api/review?${fq}`)
  if (r.status !== 200) throw apiError(r.status, r.json)
  const snapshot = d.json as DocSnapshot
  const review = r.json as ReviewState
  const ro = snapshot.readOnly || review.readOnly
  const s = createFakeDocSession({
    file: o.file, root: o.boot.root, port: o.boot.port, snapshot, review, boot: o.boot, transport: o.transport,
    // the SSE query's clientId matches the transport's X-MDR-Client-Id, as in P2's session (D32)
    ...((o.clientId ?? (o.transport as { clientId?: ClientId }).clientId) ? { clientId: (o.clientId ?? (o.transport as { clientId?: ClientId }).clientId)! } : {}),
    ...(o.clipboard !== undefined ? { clipboard: o.clipboard } : {}),
    ...(ro && (ro.code === 'NOT_UTF8' || ro.code === 'TOO_LARGE' || ro.code === 'SIDECAR_CORRUPT' || ro.code === 'SIDECAR_SCHEMA_UNSUPPORTED')
      ? { banner: { kind: 'read-only', code: ro.code, message: ro.message } as SessionBanner, saveState: { state: 'readonly', code: ro.code, message: ro.message } as SaveState }
      : {}),
  })
  return s
}
