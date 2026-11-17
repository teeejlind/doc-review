// tests/unit/web/session/safety-states.test.ts (P2; named by CONTRACTS §12.14). Every safety-state row driven over
// MockTransport + fakeApp, plus the banner precedence: doc removed (+ Recreate), review data reset, contract mismatch
// (+ Reload keeping the draft), read-only file or sidecar, another tab editing (+ Take over), merge failed (Copy, Keep
// mine, Dismiss), draft schema-invalid, unsaveable op (D37), a same-block conflict (§7.4), and the session notices.
import { unlinkSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { setSpliceFaultForTests } from '../../../../core/splice/apply'
import type { BrowserSseEvent, DocId, DocSnapshot, ReviewState, SaveRequest, SessionNotice } from '../../../../shared/types'
import { NO_SAFETY_FLAGS, pickBanner, readOnlyReason, type SafetyFlags } from '../../../../web/src/session/banners'
import { draftKey, memoryDraftStore } from '../../../../web/src/session/drafts'
import { sessionInternals } from '../../../../web/src/session/internals'
import { openSession } from '../../../../web/src/session/session'
import { bodiesTo, channelBus, fixture, TestPort, tick, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'

let fx: Fixture | null = null
afterEach(async () => {
  setSpliceFaultForTests(null)
  await fx?.close()
  fx = null
})

function hello(session: { getSnapshot(): DocSnapshot; getReview(): ReviewState }, over: Partial<Extract<BrowserSseEvent, { event: 'hello' }>['data']>): BrowserSseEvent {
  const s = session.getSnapshot()
  return {
    event: 'hello',
    data: {
      serverId: 'same', protocol: 2, version: '2.0.0-dev', schemaFingerprint: s.schemaFingerprint, file: DOC, docId: s.docId, rev: s.rev,
      hash: s.hash, seq: session.getReview().seq, presence: { waiter: 'none' }, activity: session.getReview().activity, ...over,
    },
  }
}

// ===================================================================================== precedence

describe('banner precedence (§12.14)', () => {
  it('contract-mismatch > doc-removed > read-only > tab-not-leader > review-reset; only the highest shows', () => {
    const all: SafetyFlags = {
      authLost: false,
      contractMismatch: { expected: 'aaa', actual: 'bbb' },
      docRemoved: { canRecreate: true },
      readOnly: { code: 'SIDECAR_CORRUPT', message: 'bad line 3' },
      tabNotLeader: true,
      reviewReset: { kind: 'review-reset', previousDocId: null, docId: null },
    }
    const order: Array<keyof SafetyFlags> = ['contractMismatch', 'docRemoved', 'readOnly', 'tabNotLeader', 'reviewReset']
    const kinds: string[] = []
    const f: SafetyFlags = { ...all }
    for (const k of order) {
      kinds.push(pickBanner(f)!.kind)
      ;(f as unknown as Record<string, unknown>)[k] = k === 'tabNotLeader' ? false : null
    }
    expect(kinds).toEqual(['contract-mismatch', 'doc-removed', 'read-only', 'tab-not-leader', 'review-reset'])
    expect(pickBanner(NO_SAFETY_FLAGS)).toBeNull()
    expect(readOnlyReason(all, DOC)?.code).toBe('CONTRACT_MISMATCH')
    expect(readOnlyReason({ ...NO_SAFETY_FLAGS, reviewReset: all.reviewReset }, DOC)).toBeNull()
  })
})

// ===================================================================================== rows

describe('doc removed (§13 #28)', () => {
  it('SSE doc-removed → banner, readonly DOC_GONE, autosave paused, drafts still written; Recreate writes it back', async () => {
    fx = await fixture({ file: DOC, markdown: MD, diskPollMs: 40 })
    const port = await TestPort.create()
    const drafts = memoryDraftStore()
    const { session, transport } = await fx.open({ port, env: { drafts } })
    await until(() => transport.openStreamCount() === 1)
    const lastHash = session.getSnapshot().hash
    unlinkSync(fx.root.path(DOC))
    await until(() => session.getBanner()?.kind === 'doc-removed', 3_000, 'doc-removed banner')
    expect(session.getBanner()).toEqual({ kind: 'doc-removed', canRecreate: true })
    expect(session.getSaveState()).toMatchObject({ state: 'readonly', code: 'DOC_GONE' })
    port.setText(2, 'Typed after the file vanished.')
    await tick(900)
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
    expect(drafts.map.get(draftKey(fx.boot.rootHash, DOC))).toBeDefined()

    const res = await session.recreate()
    expect(res.ok).toBe(true)
    const req = bodiesTo<SaveRequest>(transport, '/api/save')[0]!
    expect(req).toMatchObject({ cause: 'recreate', allowPartial: false })
    expect(req.base.hash).toBe(lastHash)
    expect(session.getBanner()).toBeNull()
    expect(session.getSaveState().state).toBe('saved')
    expect(fx.root.read(DOC)).toBe(MD.replace('Second paragraph here.', 'Typed after the file vanished.'))
  })

  it('a save answered 410 DOC_GONE raises the same banner; a failed Recreate raises RECREATE_FAILED', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    const notices: SessionNotice[] = []
    session.onNotice((n) => notices.push(n))
    transport.intercept((req) => req.path.startsWith('/api/save') && (req.body as SaveRequest).cause === 'edit'
      ? { status: 410, json: { ok: false, error: { code: 'DOC_GONE', message: 'gone' } } }
      : undefined)
    port.setText(1, 'Edit into the void.')
    await session.flush()
    expect(session.getBanner()).toEqual({ kind: 'doc-removed', canRecreate: true })
    expect(session.getSaveState()).toMatchObject({ state: 'readonly', code: 'DOC_GONE' })
    transport.intercept((req) => req.path.startsWith('/api/save') && (req.body as SaveRequest).cause === 'recreate'
      ? { status: 409, json: { ok: false, error: { code: 'CONFLICT', message: 'base mismatch' } } }
      : undefined)
    await expect(session.recreate()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(notices.map((n) => n.code)).toEqual(['RECREATE_FAILED'])
    expect(session.getBanner()?.kind).toBe('doc-removed')
  })
})

describe('review data reset (§13 #29)', () => {
  it('a hello with a different docId fully reloads and shows the dismissible review-reset banner', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    await fx.agent([{ op: 'comment', doc: true, body: 'Sidecar exists.' }])
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1)
    await tick(30)
    const oldId = session.getSnapshot().docId!
    const newId = 'd_01JAB3K9Q2T7V5X8Y0Z1W2E3R9' as DocId
    transport.intercept(async (req) => {
      if (!req.path.startsWith('/api/doc')) return undefined
      const real = await (await fx!.fa.store(DOC)).snapshot()
      return { status: 200, json: { ...real, docId: newId } }
    })
    transport.emit(hello(session, { docId: newId }))
    await until(() => session.getBanner()?.kind === 'review-reset', 3_000, 'review-reset')
    expect(session.getBanner()).toEqual({ kind: 'review-reset', previousDocId: oldId, docId: newId })
    await until(() => port.reloads.some((r) => r.reason === 'full' && r.prev === null), 3_000, 'full reload')
    expect(session.getSaveState().state).toBe('saved')
    session.dismissBanner()
    expect(session.getBanner()).toBeNull()
  })
})

describe('contract mismatch (§13 #22)', () => {
  it('hello.schemaFingerprint ≠ the bundle → banner, readonly CONTRACT_MISMATCH; Reload awaits the draft, then reloads', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const drafts = memoryDraftStore()
    let reloaded = 0
    const { session, transport } = await fx.open({ port, env: { drafts, reloadPage: () => void reloaded++ } })
    await until(() => transport.openStreamCount() === 1)
    port.setText(1, 'Unsaved when the bundle went stale.')
    transport.emit(hello(session, { schemaFingerprint: 'ffffffffffffffff' }))
    await until(() => session.getBanner()?.kind === 'contract-mismatch', 3_000, 'banner')
    expect(session.getBanner()).toEqual({ kind: 'contract-mismatch', expected: port.md.schemaFingerprint, actual: 'ffffffffffffffff' })
    expect(session.getSaveState()).toMatchObject({ state: 'readonly', code: 'CONTRACT_MISMATCH' })
    expect(port.editable).toBe(false)
    await tick(800)
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
    await session.reload()
    expect(reloaded).toBe(1)
    const rec = drafts.map.get(draftKey(fx.boot.rootHash, DOC))!
    expect(port.md.schema.nodeFromJSON(rec.liveDoc).child(1).textContent).toBe('Unsaved when the bundle went stale.')
  })
})

describe('read-only file or sidecar (§13 #26, #30, #31)', () => {
  it('review.readOnly SIDECAR_CORRUPT → read-only banner with the message, editor read-only', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const transport = fx.transport()
    transport.intercept(async (req) => {
      if (!req.path.startsWith('/api/review')) return undefined
      const real = await fx!.fa.fetch(new Request(`http://127.0.0.1:${fx!.fa.port}${req.path}`, { headers: req.headers }))
      const json = (await real.json()) as ReviewState
      return { status: 200, json: { ...json, readOnly: { code: 'SIDECAR_CORRUPT', message: 'line 4 is not valid JSON' } } }
    })
    const port = await TestPort.create()
    const { session } = await fx.open({ port, transport })
    expect(session.getBanner()).toEqual({ kind: 'read-only', code: 'SIDECAR_CORRUPT', message: 'line 4 is not valid JSON' })
    expect(session.getSaveState()).toMatchObject({ state: 'readonly', code: 'SIDECAR_CORRUPT' })
    expect(port.editable).toBe(false)
  })

  it('a non-UTF-8 file → read-only NOT_UTF8, no document is installed in the editor', async () => {
    fx = await fixture({ file: DOC, markdown: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]) })
    const port = await TestPort.create()
    const { session, internals } = await fx.open({ port })
    expect(session.getBanner()).toMatchObject({ kind: 'read-only', code: 'NOT_UTF8' })
    expect(session.getSaveState()).toMatchObject({ state: 'readonly', code: 'NOT_UTF8' })
    expect(port.installs).toHaveLength(0)
    expect(internals.getLoaded()).toBeNull()
    expect(internals.isEditable()).toBe(false)
  })
})

describe('another tab is editing (§13 #61, §12.8)', () => {
  it('the second tab is read-only with tab-not-leader; Take over swaps the roles and the old leader flushes', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const bus = channelBus()
    const portA = await TestPort.create()
    const portB = await TestPort.create()
    const a = await fx.open({ port: portA, env: { channel: bus.channel } })
    const b = await fx.open({ port: portB, env: { channel: bus.channel }, transport: fx.transport(`k_01JAB3K9Q2T7V5X8Y0Z1W2E3RB`) })
    await until(() => b.session.getBanner()?.kind === 'tab-not-leader', 2_000, 'follower banner')
    expect(a.session.getBanner()).toBeNull()
    expect(b.session.getSaveState()).toMatchObject({ state: 'readonly', code: 'TAB_NOT_LEADER' })
    expect(portB.editable).toBe(false)
    expect(portA.editable).toBe(true)

    portA.setText(1, 'Leader typing, unsaved at takeover.')
    b.session.takeOver()
    await until(() => a.session.getBanner()?.kind === 'tab-not-leader', 2_000, 'old leader demoted')
    expect(b.session.getBanner()).toBeNull()
    expect(portB.editable).toBe(true)
    // the old leader flushed on its way out, and the new leader catches up through the reload path
    await until(() => fx!.root.read(DOC).includes('Leader typing, unsaved at takeover.'), 3_000, 'old leader flush')
    await until(() => portB.text(1) === 'Leader typing, unsaved at takeover.', 3_000, 'new leader caught up')
  })
})

describe('merge failed (§12.4 409, §12.14)', () => {
  it('a 409 on an allowPartial:false save keeps the local copy: Copy, Keep mine (saves cause merge), Dismiss', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const copied: string[] = []
    const { session, transport } = await fx.open({ port, env: { clipboard: () => ({ writeText: async (s) => void copied.push(s) }) } })
    const seen: string[] = []
    session.subscribe((w) => seen.push(w))
    // the first strict save is refused with a fresh `current`
    let refuse = true
    transport.intercept(async (req) => {
      if (!req.path.startsWith('/api/save') || (req.body as SaveRequest).allowPartial || !refuse) return undefined
      refuse = false
      const current = await (await fx!.fa.store(DOC)).snapshot()
      return { status: 409, json: { ok: false, error: { code: 'CONFLICT', message: '1 block changed on both sides' }, current } }
    })
    await sessionKeepMineViaRecovered(session, port)
    expect(session.getRecoveredDraft()).toMatchObject({ reason: 'merge-failed', markdown: expect.stringContaining('Third paragraph, mine.') })
    expect(seen).toContain('recovered')
    // the editor was reloaded from `current`, and the session is clean against it
    expect(port.text(3)).toBe('Third paragraph, theirs.')
    expect(session.getConflicts()).toEqual([])
    expect(session.getSaveState().state).toBe('saved')
    // Copy (inside the gesture), then Keep mine: the draft goes back in and saves with cause 'merge', allowPartial false
    expect(await session.copyRecoveredDraft()).toBe(true)
    expect(copied.at(-1)).toContain('Third paragraph, mine.')
    await session.keepRecoveredDraft()
    const last = bodiesTo<SaveRequest>(transport, '/api/save').at(-1)!
    expect(last).toMatchObject({ cause: 'merge', allowPartial: false })
    expect(session.getRecoveredDraft()).toBeNull()
    expect(port.text(3)).toBe('Third paragraph, mine.')
    expect(fx.root.read(DOC)).toContain('Third paragraph, mine.')
  })

  it('Dismiss drops the recovered draft', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    transport.intercept(async (req) => {
      if (!req.path.startsWith('/api/save') || (req.body as SaveRequest).allowPartial) return undefined
      return { status: 409, json: { ok: false, error: { code: 'STALE_REVISION', message: 'stale' }, current: await (await fx!.fa.store(DOC)).snapshot() } }
    })
    await sessionKeepMineViaRecovered(session, port)
    expect(session.getRecoveredDraft()?.reason).toBe('merge-failed')
    session.discardRecoveredDraft()
    expect(session.getRecoveredDraft()).toBeNull()
  })
})

/**
 * Produce a strict (allowPartial:false, cause 'merge') save the way §7.4's Keep mine does: hold a real conflict and
 * resolve it 'mine'. TJ and Claude edit the same block; the autosave merges and holds it; 'mine' sends the strict save.
 */
async function sessionKeepMineViaRecovered(session: Awaited<ReturnType<Fixture['open']>>['session'], port: TestPort): Promise<void> {
  const internals = sessionInternals.get(session)!
  port.setText(3, 'Third paragraph, mine.')
  await fx!.agent([{ op: 'replace_block', target: { quote: 'Third paragraph here.' }, markdown: 'Third paragraph, theirs.' }])
  await session.flush()
  await until(() => session.getConflicts().length === 1, 3_000, 'held conflict')
  await internals.resolveConflict(session.getConflicts()[0]!.id, 'mine')
}

describe('same-block conflict (§7.4, §13 #9)', () => {
  it('held: disk keeps theirs, the editor keeps mine, state conflict(1); take theirs releases it', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, internals } = await fx.open({ port })
    port.setText(2, 'Second paragraph, mine.')
    await fx.agent([{ op: 'replace_block', target: { quote: 'Second paragraph here.' }, markdown: 'Second paragraph, theirs.' }])
    await session.flush()
    await until(() => session.getConflicts().length === 1, 3_000, 'conflict')
    const c = session.getConflicts()[0]!
    expect(c).toMatchObject({ kind: 'conflict', theirsBy: 'Claude' })
    expect(session.getSaveState()).toEqual({ state: 'conflict', count: 1 })
    expect(port.text(2)).toBe('Second paragraph, mine.')
    expect(fx.root.read(DOC)).toContain('Second paragraph, theirs.')
    // further typing elsewhere still saves; the held block stays theirs on disk
    port.setText(1, 'First paragraph, still saving.')
    await session.flush()
    expect(fx.root.read(DOC)).toContain('First paragraph, still saving.')
    expect(fx.root.read(DOC)).toContain('Second paragraph, theirs.')
    await internals.resolveConflict(c.id, 'theirs')
    expect(port.tookTheirs).toHaveLength(1)
    expect(port.text(2)).toBe('Second paragraph, theirs.')
    await session.flush()
    expect(session.getConflicts()).toEqual([])
    expect(session.getSaveState().state).toBe('saved')
  })

  it('keep mine: the strict merge save writes mine', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await sessionKeepMineViaRecovered(session, port)
    expect(bodiesTo<SaveRequest>(transport, '/api/save').at(-1)).toMatchObject({ cause: 'merge', allowPartial: false })
    expect(fx.root.read(DOC)).toContain('Third paragraph, mine.')
    expect(session.getConflicts()).toEqual([])
  })
})

describe('unsaveable op (D37, §13 #83)', () => {
  it('a block failing every splice level is held, the rest saves, disk keeps it; Discard my change restores it', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, internals, transport } = await fx.open({ port })
    const h = internals.getLoaded()!.blocks[1]!.hash
    // page and server agree on the fault (one module instance in-process; the route is what the e2e spec calls)
    const r = await transport.request('POST', `/__test/splice-fault?file=${encodeURIComponent(DOC)}`, { file: DOC, blockHashes: [h] })
    expect(r.status).toBe(200)
    // two separate runs (block 2 untouched between them): only the faulted one is held (D37)
    port.setText(1, 'First paragraph, cannot splice.')
    port.setText(3, 'Third paragraph, fine.')
    await session.flush()
    const held = session.getConflicts()
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ kind: 'unsaveable', id: `unsaveable:${h}` })
    expect(session.getSaveState()).toEqual({ state: 'conflict', count: 1 })
    expect(fx.root.read(DOC)).toContain('First paragraph here.')
    expect(fx.root.read(DOC)).toContain('Third paragraph, fine.')
    // later saves withhold the held op and keep saving the rest
    port.setText(3, 'Third paragraph, later.')
    await session.flush()
    expect(bodiesTo<SaveRequest>(transport, '/api/save').at(-1)!.ops.some((op) => op.covers.includes(h))).toBe(false)
    expect(fx.root.read(DOC)).toContain('Third paragraph, later.')
    expect(port.text(1)).toBe('First paragraph, cannot splice.')
    await internals.resolveConflict(held[0]!.id, 'theirs')
    expect(port.tookTheirs).toHaveLength(1)
    expect(port.text(1)).toBe('First paragraph here.')
    await session.flush()
    expect(session.getConflicts()).toEqual([])
    expect(session.getSaveState().state).toBe('saved')
  })
})

describe('session notices (§12.14)', () => {
  it('POLICY_CHANGED when Claude changes the policy; none for TJ\'s own toggle', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const { session, transport } = await fx.open({})
    await until(() => transport.openStreamCount() === 1)
    await tick(30)
    const notices: SessionNotice[] = []
    session.onNotice((n) => notices.push(n))
    await session.setPolicy({ suggestOnly: true })
    await tick(200)
    expect(notices).toEqual([])
    const res = await fx.fa.fetch(new Request(`http://127.0.0.1:${fx.fa.port}/api/agent/policy`, {
      method: 'POST',
      headers: { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': '2', Authorization: `Bearer ${fx.fa.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: DOC, suggestOnly: false }),
    }))
    expect(res.status).toBe(200)
    await until(() => notices.length === 1, 3_000, 'POLICY_CHANGED')
    expect(notices[0]).toMatchObject({ kind: 'info', code: 'POLICY_CHANGED' })
    expect(session.getReview().policy.suggestOnly).toBe(false)
  })

  it('draft schema-invalid surfaces as a recovered draft with Copy and Dismiss only', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const store = memoryDraftStore()
    await store.set(draftKey(fx.boot.rootHash, DOC), {
      v: 1, docId: null, baseRev: 0, baseHash: 'f'.repeat(64), baseMarkdown: MD, liveDoc: { type: 'nope' }, mode: 'editing', selection: null,
      heldConflicts: [], savedAt: '2026-10-15T00:00:00.000Z',
    })
    const session = await openSession({ boot: fx.boot, file: DOC, transport: fx.transport(), env: { drafts: store, channel: () => null, window: null, document: null, clipboard: () => null, storage: null } })
    const port = await TestPort.create()
    const internals = sessionInternals.get(session)!
    port.internals = internals
    await internals.attachEditor(port)
    expect(session.getRecoveredDraft()).toMatchObject({ reason: 'schema-invalid', markdown: MD })
    await session.keepRecoveredDraft() // not offered for schema-invalid: a no-op
    expect(session.getRecoveredDraft()?.reason).toBe('schema-invalid')
    await session.close()
  })
})
