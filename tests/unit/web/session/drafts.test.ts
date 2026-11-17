// tests/unit/web/session/drafts.test.ts (P2). Drafts (CONTRACTS §12.5, §13 #1, #29, #62): a DraftRecord is written
// DRAFT_DEBOUNCE_MS after a dirty transaction and cleared once saved and clean; on open a same-base draft is restored
// and flushed, a different-base draft saves against its own base and the server merges, a draft that fails schema
// validation becomes a 'schema-invalid' recovered draft, and a draft from an older docId a 'merge-failed' one.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { docHash } from '../../../../core/hash'
import type { Md } from '../../../../core/md/index'
import { load } from '../../../../core/splice/load'
import { CONSTANTS } from '../../../../shared/types'
import type { DocId, DraftRecord, SaveRequest, SessionNotice } from '../../../../shared/types'
import { classifyDraft, draftKey, memoryDraftStore } from '../../../../web/src/session/drafts'
import { sessionInternals } from '../../../../web/src/session/internals'
import { openSession } from '../../../../web/src/session/session'
import { sharedMd } from '../../../fakes/FakeDocStore'
import { bodiesTo, fixture, TestPort, tick, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'

let md: Md
beforeAll(async () => {
  md = await sharedMd()
})

let fx: Fixture | null = null
const opened: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close().catch(() => undefined)
  await fx?.close()
  fx = null
})

function draft(over: Partial<DraftRecord> & { live: string }): DraftRecord {
  const { live, ...rest } = over
  return {
    v: 1, docId: null, baseRev: 0, baseHash: docHash(MD, false), baseMarkdown: MD, liveDoc: load(md, live).doc.toJSON(), mode: 'editing',
    selection: null, heldConflicts: [], savedAt: '2026-10-15T00:00:00.000Z', ...rest,
  }
}

/** Open with a pre-filled draft store; notices are collected before the editor attaches. */
async function openWithDraft(f: Fixture, rec: DraftRecord | null): Promise<{ port: TestPort; notices: SessionNotice[]; store: ReturnType<typeof memoryDraftStore>; session: Awaited<ReturnType<typeof openSession>>; transport: ReturnType<Fixture['transport']> }> {
  const store = memoryDraftStore()
  if (rec) await store.set(draftKey(f.boot.rootHash, DOC), rec)
  const transport = f.transport()
  const session = await openSession({
    boot: f.boot, file: DOC, transport,
    env: { drafts: store, channel: () => null, window: null, document: null, clipboard: () => null, idle: (fn) => setTimeout(fn, 0), storage: null },
  })
  opened.push(session)
  const notices: SessionNotice[] = []
  session.onNotice((n) => notices.push(n))
  const port = await TestPort.create()
  const internals = sessionInternals.get(session)!
  port.internals = internals
  await internals.attachEditor(port)
  return { port, notices, store, session, transport }
}

describe('classifyDraft (§12.5)', () => {
  it('same base, other base, docId reset', () => {
    const d = draft({ live: MD })
    expect(classifyDraft(d, { hash: d.baseHash, docId: null })).toBe('same-base')
    expect(classifyDraft(d, { hash: 'f'.repeat(64), docId: null })).toBe('other-base')
    const withId = { ...d, docId: 'd_01JAB3K9Q2T7V5X8Y0Z1W2E3R4' as DocId }
    expect(classifyDraft(withId, { hash: d.baseHash, docId: 'd_01JAB3K9Q2T7V5X8Y0Z1W2E3R5' as DocId })).toBe('doc-reset')
    expect(classifyDraft(withId, { hash: d.baseHash, docId: null })).toBe('same-base')
  })
})

describe('draft writes (§12.5)', () => {
  it('writes DRAFT_DEBOUNCE_MS after a dirty transaction, under mdr:draft:<rootHash>:<file>, and clears once saved and clean', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const { port, store, session } = await openWithDraft(fx, null)
    const key = draftKey(fx.boot.rootHash, DOC)
    expect(key).toBe(`mdr:draft:${fx.boot.rootHash}:${DOC}`)
    port.setText(1, 'Unsaved words.')
    expect(store.map.has(key)).toBe(false)
    await tick(CONSTANTS.DRAFT_DEBOUNCE_MS + 60)
    const rec = store.map.get(key)!
    expect(rec).toMatchObject({ v: 1, baseRev: 0, baseHash: docHash(MD, false), baseMarkdown: MD, heldConflicts: [], mode: 'editing' })
    expect(md.schema.nodeFromJSON(rec.liveDoc).child(1).textContent).toBe('Unsaved words.')
    await session.flush()
    await until(() => !store.map.has(key), 2_000, 'draft cleared')
  })
})

describe('draft restore on open (§12.5)', () => {
  it('same base: restores the live doc, raises DRAFT_RECOVERED, flushes against the current snapshot', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const live = MD.replace('Second paragraph here.', 'Second paragraph, recovered.')
    const { port, notices, store, session, transport } = await openWithDraft(fx, draft({ live }))
    expect(port.text(2)).toBe('Second paragraph, recovered.')
    expect(notices.map((n) => n.code)).toEqual(['DRAFT_RECOVERED'])
    expect(notices[0]!.text).toBe('Recovered unsaved edits')
    await until(() => session.getSaveState().state === 'saved' && bodiesTo(transport, '/api/save').length === 1, 3_000, 'flushed')
    const req = bodiesTo<SaveRequest>(transport, '/api/save')[0]!
    expect(req.base.hash).toBe(docHash(MD, false))
    expect(fx.root.read(DOC)).toBe(live)
    await until(() => store.map.size === 0, 2_000, 'draft cleared')
  })

  it('different base: plans against load(draft.baseMarkdown), sends the draft base, the server merges with current', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    // Claude wrote while the tab was gone
    await fx.agent([{ op: 'replace_block', target: { quote: 'Third paragraph here.' }, markdown: 'Third paragraph, Claude meanwhile.' }])
    const live = MD.replace('First paragraph here.', 'First paragraph, my draft.')
    const { port, notices, session, transport } = await openWithDraft(fx, draft({ live }))
    expect(notices.map((n) => n.code)).toEqual(['DRAFT_RECOVERED'])
    await until(() => bodiesTo(transport, '/api/save').length >= 1 && session.getSaveState().state === 'saved', 3_000, 'saved')
    const req = bodiesTo<SaveRequest>(transport, '/api/save')[0]!
    expect(req.base).toEqual({ rev: 0, hash: docHash(MD, false), blockHashes: load(md, MD).blocks.map((b) => b.hash) })
    expect(fx.root.read(DOC)).toBe('# Title\n\nFirst paragraph, my draft.\n\nSecond paragraph here.\n\nThird paragraph, Claude meanwhile.\n')
    // the merged result was adopted into the editor through the reload path
    expect(port.text(1)).toBe('First paragraph, my draft.')
    expect(port.text(3)).toBe('Third paragraph, Claude meanwhile.')
    expect(session.getConflicts()).toEqual([])
  })

  it('a draft that fails schema validation becomes a schema-invalid recovered draft; nothing is saved', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const bad: DraftRecord = { ...draft({ live: MD }), liveDoc: { type: 'doc', content: [{ type: 'no_such_node' }] } }
    const { notices, session, transport } = await openWithDraft(fx, bad)
    const rd = session.getRecoveredDraft()
    expect(rd).toMatchObject({ reason: 'schema-invalid', markdown: MD, baseRev: 0 })
    expect(notices).toEqual([])
    await tick(100)
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
    session.discardRecoveredDraft()
    expect(session.getRecoveredDraft()).toBeNull()
  })

  it('a draft from an older docId (sidecar recreated) becomes a merge-failed recovered draft (§13 #29)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    await fx.agent([{ op: 'comment', doc: true, body: 'Creates the sidecar.' }])
    const live = MD.replace('First paragraph here.', 'Written under the old sidecar.')
    const { session, store, transport } = await openWithDraft(fx, draft({ live, docId: 'd_01JAB3K9Q2T7V5X8Y0Z1W2E3R4' as DocId }))
    expect(session.getSnapshot().docId).not.toBeNull()
    expect(session.getRecoveredDraft()).toMatchObject({ reason: 'merge-failed', markdown: expect.stringContaining('Written under the old sidecar.') })
    expect(store.map.size).toBe(0)
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
  })
})
