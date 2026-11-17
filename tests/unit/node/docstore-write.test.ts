// tests/unit/node/docstore-write.test.ts (P1). The M2 write path of node/docstore.ts over real files (CONTRACTS §3.5,
// §3.9, §4.3, §4.6, §4.7, §6.6, §7.1, §10, Appendix A): sidecar materialization and the WAL batch, browser saves
// (direct, merged, conflicts, unsaveable, expectHash with a BOM, suggestions.reopen refused, cause edit → save), the
// TJ session (coalesced, merge/recreate extend it, flush triggers, recovery at open, net-empty), windowed BlockSides,
// the tj.* surface (threads, decisions, bulk with the atomic bulk reopen, read markers, policy, restore with its
// snapshot), history triggers, idempotency across a restart, handoff events, and StoreChange emission with clientId.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { docHash } from '../../../core/hash'
import { setIdleFlushMsForTests } from '../../../node/ledger'
import { readIndex } from '../../../node/history'
import * as S from '../../../shared/schemas'
import type { DocStore, SidecarEvent, SuggestionId, TextAnchor, ThreadId } from '../../../shared/types'
import { anchorOn, blockAnchorOn, clientId, makeKit, opKey, opsFor, saveReq, type Kit } from './store-kit'

const DOC = '# Title\n\nWe launch in Q3.\n\nThe notes carry a member rate of 12% paid monthly.\n\nLast line.\n'

let kit: Kit
beforeAll(() => {
  kit = makeKit()
})
afterAll(async () => {
  await kit.cleanup()
})
afterEach(() => {
  setIdleFlushMsForTests(null)
})

const types = (evs: readonly SidecarEvent[]): string[] => evs.map((e) => e.type)
const ofType = <T extends SidecarEvent['type']>(evs: readonly SidecarEvent[], t: T): Array<Extract<SidecarEvent, { type: T }>> =>
  evs.filter((e) => e.type === t) as Array<Extract<SidecarEvent, { type: T }>>

async function saveText(s: DocStore, next: string, o: Parameters<typeof saveReq>[2] = {}) {
  const snap = await s.snapshot()
  return s.save(await saveReq(snap, next, o))
}

describe('first write materializes the sidecar (§3.5, §4.1)', () => {
  it('a comment: header + baseline doc.rev + the event, in one creation; reads before it create nothing', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    await s.review()
    await s.snapshot()
    expect(existsSync(kit.abs(file) + '.review.jsonl')).toBe(false)
    const r = await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'hello' })
    expect(r.seq).toBe(2)
    const lines = kit.sidecar(file)
    expect(lines[0]).toMatchObject({ type: 'header', schema: 'mdr.sidecar/2', file: 'doc.md' })
    expect(types(lines.slice(1) as SidecarEvent[])).toEqual(['doc.rev', 'comment.add'])
    expect(lines[1]).toMatchObject({ seq: 1, rev: 1, by: 'system', cause: 'baseline', prevRev: null, hash: docHash(DOC, false) })
    expect(lines[2]).toMatchObject({ seq: 2, rev: 1 })
    expect((lines[2] as SidecarEvent).key).toMatch(/^tj:op_/)
    // the baseline version (§10: the pre-write content, by external)
    expect(readIndex(kit.abs(file)).versions.map((v) => [v.cause, v.by, v.rev])).toEqual([['baseline', 'external', 1]])
    // every line parses with the frozen schema
    for (const l of lines.slice(1)) expect(S.SidecarEventSchema.safeParse(l).success).toBe(true)
  })

  it('a byte write: the WAL batch carries wal { rev, hash } on every line, appended before the rename; rev = 2', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const next = DOC.replace('Q3', 'Q4')
    const r = await saveText(s, next)
    expect(r).toMatchObject({ applied: 'direct', rev: 2 })
    expect(kit.read(file)).toBe(next)
    const evs = kit.events(file)
    expect(types(evs)).toEqual(['doc.rev', 'doc.rev'])
    const w = evs[1] as Extract<SidecarEvent, { type: 'doc.rev' }>
    expect(w).toMatchObject({ rev: 2, by: 'TJ', cause: 'save', prevRev: 1, prevHash: docHash(DOC, false), hash: docHash(next, false), wal: { rev: 2, hash: docHash(next, false) } })
    expect(w.key).toMatch(/^save:k_/)
    // the object for the new rev was written before the WAL append (§3.8)
    expect(existsSync(`${kit.root}/${file.split('/')[0]}/.review/history/doc.md/objects/${docHash(next, false)}.md.gz`)).toBe(true)
    expect(readFileSync(`${kit.root}/${file.split('/')[0]}/.review/.gitignore`, 'utf8')).toBe('*\n')
  })
})

describe('browser saves (§3.9, §7.3, §7.4)', () => {
  it('a no-op save is noop and appends nothing; cause edit folds as save', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    await saveText(s, DOC.replace('Q3', 'Q4'))
    const before = kit.events(file).length
    const r = await saveText(s, DOC.replace('Q3', 'Q4'))
    expect(r.applied).toBe('noop')
    expect(kit.events(file).length).toBe(before)
    expect(ofType(kit.events(file), 'doc.rev').at(-1)!.cause).toBe('save')
  })

  it('a retried save (same clientId + saveId) is a duplicate with the original rev, in this process and after a restart', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const req = await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4'))
    const a = await s.save(req)
    const b = await s.save(req)
    expect(b).toMatchObject({ applied: 'duplicate', rev: a.rev, hash: a.hash })
    const s2 = await kit.open(file)
    const c = await s2.save(req)
    expect(c).toMatchObject({ applied: 'duplicate', rev: a.rev, hash: a.hash })
    expect(ofType(kit.events(file), 'doc.rev')).toHaveLength(2)
  })

  it('a stale base merges block-wise: an edit to the block next to Claude\'s applies (row 10)', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    const base = await s.snapshot()
    // Claude rewrites the last block
    const t = await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b4', rev: base.rev }, markdown: 'Final line.' }] })
    expect(t.rev).toBeGreaterThan(base.rev)
    // TJ's autosave was planned against the old base and edits b2
    const r = await s.save(await saveReq(base, DOC.replace('Q3', 'Q4')))
    expect(r.applied).toBe('merged')
    expect(r.conflicts).toEqual([])
    expect(r.rebased?.markdown).toBe(DOC.replace('Q3', 'Q4').replace('Last line.', 'Final line.'))
    expect(kit.read(file)).toBe(DOC.replace('Q3', 'Q4').replace('Last line.', 'Final line.'))
  })

  it('the same block changed on both sides: allowPartial → conflicts (disk keeps theirs); strict → 409 CONFLICT, nothing written', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const base = await s.snapshot()
    await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b2', rev: base.rev }, markdown: 'We launch in Q1.' }] })
    const r = await s.save(await saveReq(base, DOC.replace('Q3', 'Q4')))
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0]).toMatchObject({ kind: 'conflict', mine: 'We launch in Q4.', theirs: 'We launch in Q1.', base: 'We launch in Q3.', theirsBy: 'Claude' })
    expect(r.rebased).toBeDefined()
    expect(kit.read(file)).toContain('Q1')
    const before = kit.events(file).length
    await expect(s.save(await saveReq(base, DOC.replace('Q3', 'Q5'), { allowPartial: false, cause: 'merge', saveId: 2 })))
      .rejects.toMatchObject({ code: 'CONFLICT', status: 409, body: { conflicts: [expect.objectContaining({ kind: 'conflict' })] } })
    expect(kit.events(file).length).toBe(before)
  })

  it('expectHash is a docHash over the bytes WITH the BOM (D40); a wrong one → SPLICE_MISMATCH, nothing written', async () => {
    const body = 'Para one.\r\n\r\nPara two.\r\n'
    const file = kit.docIn(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]))
    const s = await kit.open(file)
    const snap = await s.snapshot()
    expect(snap.bom).toBe(true)
    const next = body.replace('two', 'TWO')
    const req = await saveReq(snap, next)
    expect(req.expectHash).toBe(docHash(next, true))
    const r = await s.save(req)
    expect(r.hash).toBe(docHash(next, true))
    const raw = readFileSync(kit.abs(file))
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(raw.subarray(3).toString()).toBe(next)
    const bad = await saveReq(await s.snapshot(), next.replace('one', 'ONE'), { saveId: 2 })
    await expect(s.save({ ...bad, expectHash: docHash(next.replace('one', 'ONE'), false) })).rejects.toMatchObject({ code: 'SPLICE_MISMATCH' })
  })

  it('suggestions.reopen in a save → BAD_REQUEST (D26); ops without expectHash → BAD_REQUEST', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const req = await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4'))
    await expect(s.save({ ...req, suggestions: { reopen: [] } as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const { expectHash: _e, ...noHash } = req
    await expect(s.save(noHash)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('anchor updates and TJ suggestion upserts / withdrawals ride the save batch', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const c = await s.tj.createThread({ opKey: opKey(), anchor: await anchorOn(DOC, 'in Q3', 0), anchorRev: 0, body: 'q' })
    const snap = await s.snapshot()
    const para = 'The notes carry a member rate of 12% paid monthly.'
    const sid = `s_01JAB3K9Q2T7V5X8Y0Z1W2E3R${'Z'}` as SuggestionId
    const anchor = await anchorOn(DOC, '12%', snap.rev)
    // TJ deleted the highlighted text, so the browser sends anchor: null (§5.4)
    const r = await s.save(await saveReq(snap, DOC.replace('We launch in Q3.', 'We launch.'), {
      anchors: [{ thread: c.thread.id, anchor: null }],
      suggestions: { upsert: [{ id: sid, range: { start: 2, end: 3 }, base: para, proposed: para.replace('12%', '11%'), anchor }] },
    }))
    expect(r.applied).toBe('direct')
    const evs = kit.events(file)
    const batch = evs.filter((e) => e.rev === r.rev && e.wal)
    expect(types(batch)).toEqual(['doc.rev', 'thread.detach', 'suggestion.add'])
    expect(batch.every((e) => e.key === batch[0]!.key)).toBe(true)
    const rv = await s.review()
    expect(rv.threads.find((t) => t.id === c.thread.id)?.detached).toBe(true)
    expect(rv.suggestions.find((x) => x.id === sid)).toMatchObject({ by: 'TJ', status: 'pending', located: { start: 2, end: 3 } })
    // a later save withdraws it
    const w = await s.save(await saveReq(await s.snapshot(), (await s.snapshot()).markdown, { saveId: 2, suggestions: { withdraw: [sid] } }))
    expect(w.applied).toBe('direct')
    expect((await s.review()).suggestions.find((x) => x.id === sid)?.status).toBe('withdrawn')
  })

  it('a claim that a range was deleted is ignored while its text is still there, with or without a byte change (QA3 R1)', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const c = await s.tj.createThread({ opKey: opKey(), anchor: await anchorOn(DOC, 'in Q3', 0), anchorRev: 0, body: 'q' })
    const detach = { thread: c.thread.id, anchor: null }
    // the page lost the decoration (a restored draft remounted the doc); nothing in the text changed
    const same = await saveText(s, DOC, { saveId: 1, anchors: [detach] })
    expect(same.applied).toBe('noop')
    expect(ofType(kit.events(file), 'thread.detach')).toEqual([])
    expect((await s.agent.status()).threads).toEqual({ open: 1, resolved: 0, detached: 0 })
    // the same claim riding a save that edits another block
    await saveText(s, DOC.replace('Last line.', 'Last line, edited.'), { saveId: 2, anchors: [detach] })
    expect(ofType(kit.events(file), 'thread.detach')).toEqual([])
    expect((await s.agent.status()).threads).toEqual({ open: 1, resolved: 0, detached: 0 })
    // a real deletion still detaches it, and with no byte change it stays detached (nothing else to reattach to)
    const gone = DOC.replace('Last line.', 'Last line, edited.').replace('We launch in Q3.', 'We launch.')
    await saveText(s, gone, { saveId: 3, anchors: [detach] })
    expect(ofType(kit.events(file), 'thread.detach')).toHaveLength(1)
    expect((await s.agent.status()).threads).toEqual({ open: 0, resolved: 0, detached: 1 })
  })

  it('TJ upsert target check (§6.2): an atom run or a table structure change → UNANCHORABLE_TARGET; table cell text is fine', async () => {
    const text = '---\nstatus: draft\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nPara.\n'
    const file = kit.docIn(text)
    const s = await kit.open(file)
    const snap = await s.snapshot()
    const table = '| a | b |\n|---|---|\n| 1 | 2 |'
    const anchor = await anchorOn(text, 'Para', 0)
    const upsert = (id: string, base: string, proposed: string, start: number) => ({ id: id as SuggestionId, range: { start, end: start + 1 }, base, proposed, anchor })
    const fm = '---\nstatus: draft\n---'
    await expect(s.save(await saveReq(snap, text, { suggestions: { upsert: [upsert('s_01JAB3K9Q2T7V5X8Y0Z1W2E3R1', fm, fm.replace('draft', 'final'), 0)] } })))
      .rejects.toMatchObject({ code: 'UNANCHORABLE_TARGET' })
    await expect(s.save(await saveReq(snap, text, { saveId: 2, suggestions: { upsert: [upsert('s_01JAB3K9Q2T7V5X8Y0Z1W2E3R2', table, table + '\n| 3 | 4 |', 1)] } })))
      .rejects.toMatchObject({ code: 'UNANCHORABLE_TARGET' })
    const ok = await s.save(await saveReq(snap, text, { saveId: 3, suggestions: { upsert: [upsert('s_01JAB3K9Q2T7V5X8Y0Z1W2E3R3', table, table.replace('| 1 |', '| one |'), 1)] } }))
    expect(ok.applied).toBe('direct')
  })
})

describe('the TJ session (§7.1, D6)', () => {
  it('two autosaves are two doc.revs and one session; agent.batch flushes it as ONE doc.edit (editor) plus a tj-session version', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    await saveText(s, DOC.replace('Q3', 'Q4'))
    await saveText(s, DOC.replace('Q3', 'Q4').replace('12%', '11%'), { saveId: 2 })
    expect(types(kit.events(file))).toEqual(['doc.rev', 'doc.rev', 'doc.rev'])
    const st = await s.agent.status()
    expect(st.needsRecovery).toBe(false) // this store owns the session
    expect(st.pendingCount).toBe(1)
    await s.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'looked' }] })
    const edits = ofType(kit.events(file), 'doc.edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({ by: 'TJ', source: 'editor', fromRev: 1, toRev: 3 })
    // the two edited blocks are adjacent, so the net diff is one replace run of two blocks
    expect(edits[0]!.changes.map((c) => [c.op, c.before?.count, c.before?.md, c.after?.md])).toEqual([
      ['replace', 2, 'We launch in Q3.\n\nThe notes carry a member rate of 12% paid monthly.', 'We launch in Q4.\n\nThe notes carry a member rate of 11% paid monthly.'],
    ])
    expect(readIndex(kit.abs(file)).versions.map((v) => [v.cause, v.by, v.revs])).toEqual([['baseline', 'external', [1, 1]], ['tj-session', 'TJ', [2, 3]]])
  })

  it('merge and recreate saves extend the session and carry no doc.edit of their own', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    await saveText(s, DOC.replace('Q3', 'Q4'))
    await saveText(s, DOC.replace('Q3', 'Q4').replace('Last', 'Final'), { cause: 'merge', allowPartial: false, saveId: 2 })
    expect(ofType(kit.events(file), 'doc.edit')).toHaveLength(0)
    expect(ofType(kit.events(file), 'doc.rev').map((e) => e.cause)).toEqual(['baseline', 'save', 'merge'])
    await s.flushTjSession('beacon')
    const e = ofType(kit.events(file), 'doc.edit')
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ fromRev: 1, toRev: 3, source: 'editor' })
  })

  it('the idle timer flushes the session (server mode)', async () => {
    setIdleFlushMsForTests(60)
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    await saveText(s, DOC.replace('Q3', 'Q4'))
    await new Promise((r) => setTimeout(r, 400))
    expect(ofType(kit.events(file), 'doc.edit')).toHaveLength(1)
  })

  it('a session left by another process is recovered at the next transaction: server.recovered + doc.edit; net-empty sessions append nothing', async () => {
    const file = kit.docIn(DOC)
    const a = await kit.open(file, { mode: 'server' })
    await saveText(a, DOC.replace('Q3', 'Q4'))
    // a new process (a fresh store) sees an unowned session
    const b = await kit.open(file, { mode: 'direct' })
    expect((await b.agent.status()).needsRecovery).toBe(true)
    await b.tj.readMarker({ thread: null, upTo: 1 })
    const evs = kit.events(file)
    expect(types(evs).slice(-3)).toEqual(['server.recovered', 'doc.edit', 'read-marker'])
    expect(ofType(evs, 'server.recovered')[0]).toMatchObject({ what: 'tj-session' })
    expect((await b.agent.status()).needsRecovery).toBe(false)

    // a session whose net change is empty (TJ typed and undid) appends no doc.edit
    const file2 = kit.docIn(DOC)
    const c = await kit.open(file2, { mode: 'server' })
    await saveText(c, DOC.replace('Q3', 'Q4'))
    await saveText(c, DOC, { saveId: 2 })
    await c.flushTjSession('beacon')
    expect(ofType(kit.events(file2), 'doc.edit')).toHaveLength(0)
    expect((await c.agent.status()).pendingCount).toBe(0)
  })

  it('agent.pending flushes the session first (agent-read)', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    await saveText(s, DOC.replace('Q3', 'Q4'))
    await s.agent.pending()
    expect(ofType(kit.events(file), 'doc.edit')).toHaveLength(1)
  })
})

describe('windowed BlockSide text (§7.1, D33)', () => {
  it('an edit at char 5,000 of a 6,000-char block lands inside md, with a window', async () => {
    const big = Array.from({ length: 1000 }, (_, k) => `w${String(k).padStart(4, '0')}`).join(' ')
    const text = `# T\n\n${big}\n`
    const file = kit.docIn(text)
    const s = await kit.open(file, { mode: 'server' })
    const at = big.indexOf('w0833')
    expect(at).toBeGreaterThan(4900)
    const next = text.replace('w0833', 'CHANGED')
    await saveText(s, next)
    await s.flushTjSession('beacon')
    const e = ofType(kit.events(file), 'doc.edit')[0]!
    const side = e.changes[0]!.after!
    expect(side.md).toContain('CHANGED')
    expect(side.window).toBeDefined()
    expect(side.window!.total).toBe(big.replace('w0833', 'CHANGED').length)
    expect(side.md.length).toBeLessThan(1000)
    expect(e.changes[0]!.before!.md).toContain('w0833')
  })
})

describe('threads and comments (tj.*)', () => {
  it('create, reply (reopens a resolved thread in the same batch), edit and delete own; NOT_AUTHOR on Claude\'s', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const t = await s.tj.createThread({ opKey: opKey(), anchor: await anchorOn(DOC, 'Q3', 0), anchorRev: 0, body: 'Q3?' })
    expect(S.CreateThreadResponseSchema.safeParse(t).success).toBe(true)
    const tid = t.thread.id
    await s.tj.resolve(tid, { opKey: opKey() })
    const rep = await s.tj.reply(tid, { opKey: opKey(), body: 'more' })
    expect(types(kit.events(file)).slice(-2)).toEqual(['comment.reply', 'thread.reopen'])
    expect((await s.review()).threads[0]!.status).toBe('open')
    const ed = await s.tj.editComment(rep.message.id, { opKey: opKey(), body: 'edited' })
    expect(ed.message).toMatchObject({ body: 'edited' })
    const b = await s.agent.batch({ ops: [{ op: 'reply', thread: tid, body: 'from Claude' }] })
    await expect(s.tj.editComment(b.results[0]!.comment!, { opKey: opKey(), body: 'x' })).rejects.toMatchObject({ code: 'NOT_AUTHOR' })
    await s.tj.deleteComment(rep.message.id, { opKey: opKey() })
    await expect(s.tj.deleteComment(rep.message.id, { opKey: opKey() })).rejects.toMatchObject({ code: 'COMMENT_NOT_FOUND' })
    await expect(s.tj.reply(`t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7` as ThreadId, { opKey: opKey(), body: 'x' })).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' })
    await expect(s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('a retried discrete action (same opKey) returns the original ids with duplicate: true, even after a restart', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const k = opKey()
    const a = await s.tj.createThread({ opKey: k, anchor: { kind: 'doc' }, anchorRev: 0, body: 'once' })
    const b = await s.tj.createThread({ opKey: k, anchor: { kind: 'doc' }, anchorRev: 0, body: 'once' })
    expect(b).toMatchObject({ duplicate: true, seq: a.seq, thread: { id: a.thread.id } })
    const s2 = await kit.open(file)
    const c = await s2.tj.createThread({ opKey: k, anchor: { kind: 'doc' }, anchorRev: 0, body: 'once' })
    expect(c).toMatchObject({ duplicate: true, seq: a.seq, thread: { id: a.thread.id } })
    expect(ofType(kit.events(file), 'comment.add')).toHaveLength(1)
  })

  it('resolving with pending suggestions warns RESOLVED_WITH_PENDING (§6.8)', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const b = await s.agent.batch({ ops: [{ op: 'suggest', quote: 'Q3', replace: 'Q4', reason: 'later' }] })
    const r = await s.tj.resolve(b.results[0]!.thread!, { opKey: opKey() })
    expect(r.warnings?.map((w) => w.code)).toEqual(['RESOLVED_WITH_PENDING'])
  })

  it('read markers: ACK_OUT_OF_RANGE past the latest seq; a lower value is a no-op', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })
    await expect(s.tj.readMarker({ thread: null, upTo: 99 })).rejects.toMatchObject({ code: 'ACK_OUT_OF_RANGE' })
    const a = await s.tj.readMarker({ thread: null, upTo: 2 })
    const b = await s.tj.readMarker({ thread: null, upTo: 1 })
    expect(b.seq).toBe(a.seq)
    expect(ofType(kit.events(file), 'read-marker')).toHaveLength(1)
  })

  it('policy: appended only on a change (TJ and Claude)', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    await s.agent.setPolicy({ suggestOnly: true })
    const again = await s.agent.setPolicy({ suggestOnly: true })
    expect(again.suggestOnly).toBe(true)
    await s.tj.setPolicy({ suggestOnly: false })
    expect(ofType(kit.events(file), 'policy.set').map((e) => [e.by, e.suggestOnly])).toEqual([['Claude', true], ['TJ', false]])
  })
})

describe('decisions (§6.6)', () => {
  async function withSuggestion(text = DOC, ops: Array<Record<string, unknown>> = [{ op: 'suggest', quote: 'Q3', replace: 'Q4' }]) {
    const file = kit.docIn(text)
    const s = await kit.open(file, { mode: 'server' })
    const b = await s.agent.batch({ ops: ops as never })
    return { file, s, ids: b.results.map((r) => r.suggestion!) }
  }

  it('accept writes exactly proposed in one WAL batch (doc.rev accept + doc.edit accept + suggestion.accept), plus an accept version', async () => {
    const { file, s, ids } = await withSuggestion()
    const r = await s.tj.decide(ids[0]!, 'accept', { opKey: opKey() })
    expect(S.DecisionResultSchema.safeParse(r).success).toBe(true)
    expect(r).toMatchObject({ status: 'accepted' })
    expect(r.changes.map((c) => c.after?.md)).toEqual(['We launch in Q4.'])
    expect(kit.read(file)).toBe(DOC.replace('Q3', 'Q4'))
    const batch = kit.events(file).filter((e) => e.wal?.rev === r.rev)
    expect(types(batch)).toEqual(['doc.rev', 'doc.edit', 'suggestion.accept'])
    expect(batch[0]).toMatchObject({ by: 'TJ', cause: 'accept' })
    expect(batch[1]).toMatchObject({ by: 'TJ', source: 'accept', cause: { type: 'suggestion.accept', id: ids[0] } })
    expect(batch[2]).toMatchObject({ resultRev: r.rev })
    expect(readIndex(kit.abs(file)).versions.at(-1)).toMatchObject({ cause: 'accept', by: 'TJ', rev: r.rev })
    // the same decision again → duplicate; the opposite → SUGGESTION_CLOSED
    expect(await s.tj.decide(ids[0]!, 'accept', { opKey: opKey() })).toMatchObject({ duplicate: true })
    await expect(s.tj.decide(ids[0]!, 'reject', { opKey: opKey() })).rejects.toMatchObject({ code: 'SUGGESTION_CLOSED' })
  })

  it('a decided suggestion thread counts as resolved in status and never reads detached in pending (QA3 R1, unverified 32 again)', async () => {
    const { s, ids } = await withSuggestion(DOC, [
      { op: 'suggest', quote: 'Q3', replace: 'Q4' },
      { op: 'comment', quote: 'member rate of 12%', body: 'Still current?' },
    ])
    const before = await s.agent.status()
    expect(before.threads).toEqual({ open: 2, resolved: 0, detached: 0 })
    await s.tj.decide(ids[0]!, 'accept', { opKey: opKey() })
    const st = await s.agent.status()
    expect(st.threads).toEqual({ open: 1, resolved: 1, detached: 0 })
    const pending = await s.agent.pending()
    const t = pending.threads.find((x) => x.kind === 'suggestion')!
    expect(t.status).toBe('resolved')
    // placed where the accepted text went, with the quote it replaced
    expect(t.anchor).toEqual({ state: 'ok', block: 'b2', line: 3, quote: 'Q3' })
    const rv = await s.agent.thread(t.id)
    expect(rv.thread.status).toBe('resolved')
    expect(rv.thread.anchor).toMatchObject({ state: 'ok', block: 'b2', quote: 'Q3' })
    expect((await s.agent.snapshot({})).threads.find((x) => x.id === t.id)).toMatchObject({ status: 'resolved', anchor: { state: 'ok', block: 'b2' } })
    // a rejected one reads the same way
    const more = await s.agent.batch({ ops: [{ op: 'suggest', quote: 'launch', replace: 'ship' }] })
    await s.tj.decide(more.results[0]!.suggestion!, 'reject', { opKey: opKey() })
    expect((await s.agent.status()).threads).toEqual({ open: 1, resolved: 2, detached: 0 })
  })

  it('an accepted suggestion whose new text was edited since still reads placed in its block, as approximate (QA3 R1)', async () => {
    const { s, ids } = await withSuggestion()
    await s.tj.decide(ids[0]!, 'accept', { opKey: opKey() })
    await s.agent.batch({ ops: [{ op: 'replace_block', target: { quote: 'We launch in Q4.' }, markdown: 'We ship in Q4 2026, as planned.' }] as never })
    const id = (await s.agent.snapshot({})).threads.find((x) => x.kind === 'suggestion')!.id
    const t = (await s.agent.thread(id)).thread
    expect(t.status).toBe('resolved')
    expect(t.anchor).toMatchObject({ state: 'fuzzy', block: 'b2', quote: 'Q3' })
    expect((await s.agent.status()).threads).toEqual({ open: 0, resolved: 1, detached: 0 })
  })

  it('accepting one of two suggestions in one block rebases the other (row 43)', async () => {
    const text = 'Alpha beta gamma delta epsilon.\n'
    // two suggestions in one block come from two batches (one batch may not suggest twice on a block, §9.5)
    const { file, s, ids } = await withSuggestion(text, [{ op: 'suggest', quote: 'beta', replace: 'BETA' }])
    ids.push((await s.agent.batch({ ops: [{ op: 'suggest', quote: 'delta', replace: 'DELTA' }] })).results[0]!.suggestion!)
    const r = await s.tj.decide(ids[0]!, 'accept', { opKey: opKey() })
    expect(kit.read(file)).toBe('Alpha BETA gamma delta epsilon.\n')
    const batch = kit.events(file).filter((e) => e.wal?.rev === r.rev)
    expect(types(batch)).toEqual(['doc.rev', 'doc.edit', 'suggestion.accept', 'suggestion.rebase'])
    const rv = await s.review()
    const other = rv.suggestions.find((x) => x.id === ids[1])!
    expect(other).toMatchObject({ status: 'pending', base: 'Alpha BETA gamma delta epsilon.', proposed: 'Alpha BETA gamma DELTA epsilon.' })
    expect(other.located).toEqual({ start: 0, end: 1 })
    await s.tj.decide(ids[1]!, 'accept', { opKey: opKey() })
    expect(kit.read(file)).toBe('Alpha BETA gamma DELTA epsilon.\n')
  })

  it('reject appends only suggestion.reject; reopen of a reject has resultRev null', async () => {
    const { file, s, ids } = await withSuggestion()
    const r = await s.tj.decide(ids[0]!, 'reject', { opKey: opKey() })
    expect(r.changes).toEqual([])
    expect(kit.read(file)).toBe(DOC)
    const o = await s.tj.reopenSuggestion(ids[0]!, { opKey: opKey() })
    expect(o.status).toBe('pending')
    expect(ofType(kit.events(file), 'suggestion.reopen')[0]).toMatchObject({ resultRev: null })
  })

  it('undo of an accept splices proposed → base while intact (undo-accept); edited since → SUGGESTION_CHANGED_SINCE', async () => {
    const { file, s, ids } = await withSuggestion()
    await s.tj.decide(ids[0]!, 'accept', { opKey: opKey() })
    const u = await s.tj.reopenSuggestion(ids[0]!, { opKey: opKey() })
    expect(kit.read(file)).toBe(DOC)
    expect(ofType(kit.events(file), 'doc.rev').at(-1)).toMatchObject({ cause: 'undo-accept' })
    expect(ofType(kit.events(file), 'doc.edit').at(-1)).toMatchObject({ source: 'undo-accept', cause: { type: 'suggestion.reopen', id: ids[0] } })
    expect(u.status).toBe('pending')
    await s.tj.decide(ids[0]!, 'accept', { opKey: opKey() })
    await saveText(s, DOC.replace('Q3', 'Q4 2026'))
    await expect(s.tj.reopenSuggestion(ids[0]!, { opKey: opKey() })).rejects.toMatchObject({ code: 'SUGGESTION_CHANGED_SINCE' })
  })

  it('bulk accept is one commit with per-id results; the bulk reopen is all-or-nothing in one rev (D26)', async () => {
    const text = 'One a.\n\nTwo b.\n\nThree c.\n'
    const { file, s, ids } = await withSuggestion(text, [
      { op: 'suggest', quote: 'One a', replace: 'One A' },
      { op: 'suggest', quote: 'Two b', replace: 'Two B' },
      { op: 'suggest', quote: 'Three c', replace: 'Three C' },
    ])
    const revs0 = ofType(kit.events(file), 'doc.rev').length
    const bulk = await s.tj.bulkDecide({ opKey: opKey(), decision: 'accept', authors: ['Claude'], ids: [...ids, 's_01JAB3K9Q2T7V5X8Y0Z1W2E3R9' as SuggestionId] })
    expect(S.BulkDecisionResultSchema.safeParse(bulk).success).toBe(true)
    expect(bulk.results.map((r) => r.ok)).toEqual([true, true, true, false])
    expect(bulk.results[3]!.code).toBe('SUGGESTION_NOT_FOUND')
    expect(ofType(kit.events(file), 'doc.rev').length).toBe(revs0 + 1)
    expect(kit.read(file)).toBe('One A.\n\nTwo B.\n\nThree C.\n')
    // edit one accepted text: the whole bulk undo refuses and writes nothing
    const before = kit.events(file).length
    await saveText(s, 'One A.\n\nTwo B!\n\nThree C.\n')
    const mid = kit.events(file).length
    expect(mid).toBeGreaterThan(before)
    await expect(s.tj.bulkDecide({ opKey: opKey(), decision: 'reopen', authors: [], ids })).rejects.toMatchObject({ code: 'SUGGESTION_CHANGED_SINCE', body: { details: { ids: [ids[1]] } } })
    expect(kit.events(file).length).toBe(mid)
    // restore the edit; now the undo lands in ONE rev
    await saveText(s, 'One A.\n\nTwo B.\n\nThree C.\n', { saveId: 2 })
    const revs1 = ofType(kit.events(file), 'doc.rev').length
    const undo = await s.tj.bulkDecide({ opKey: opKey(), decision: 'reopen', authors: [], ids })
    expect(undo.results.every((r) => r.ok)).toBe(true)
    expect(ofType(kit.events(file), 'doc.rev').length).toBe(revs1 + 1)
    expect(kit.read(file)).toBe(text)
    expect(ofType(kit.events(file), 'suggestion.reopen')).toHaveLength(3)
  })

  it('accept of a stale suggestion → SUGGESTION_STALE', async () => {
    const { s, ids } = await withSuggestion()
    // Claude's own write deletes the suggested text: the suggestion goes stale in the same commit
    const snap = await s.snapshot()
    const b = await s.agent.batch({ ops: [{ op: 'delete_block', target: { ref: 'b2', rev: snap.rev } }] })
    expect(b.warnings.map((w) => w.code)).toContain('SUGGESTION_STALE')
    await expect(s.tj.decide(ids[0]!, 'accept', { opKey: opKey() })).rejects.toMatchObject({ code: 'SUGGESTION_STALE' })
  })
})

describe('restore (§10, D11, D47)', () => {
  it('strict baseRev; ops from current to the target; comments kept; restore version; snapshot equals a fresh snapshot', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    await s.tj.createThread({ opKey: opKey(), anchor: await anchorOn(DOC, 'member rate', 0), anchorRev: 0, body: 'keep me' })
    await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b2', rev: 1 }, markdown: 'We launch in Q1.' }] })
    const versions = (await s.history.list()).versions
    const baseline = versions.find((v) => v.cause === 'baseline')!
    const cur = await s.snapshot()
    await expect(s.tj.restore({ opKey: opKey(), v: baseline.v, baseRev: cur.rev - 1 })).rejects.toMatchObject({ code: 'STALE_REVISION', current: expect.objectContaining({ rev: cur.rev }) })
    const r = await s.tj.restore({ opKey: opKey(), v: baseline.v, baseRev: cur.rev })
    expect(S.RestoreResponseSchema.safeParse(r).success).toBe(true)
    expect(kit.read(file)).toBe(DOC)
    expect(r.version).toMatchObject({ cause: 'restore', by: 'TJ', restoredFrom: baseline.v })
    expect(r.snapshot).toEqual(await s.snapshot())
    expect((await s.review()).threads).toHaveLength(1)
    const last = kit.events(file).filter((e) => e.wal?.rev === r.rev)
    expect(types(last)).toEqual(['doc.rev', 'doc.edit'])
    expect(last[1]).toMatchObject({ source: 'restore', cause: { type: 'restore', id: baseline.v } })
  })
})

describe('history triggers (§10)', () => {
  it('pre-write, claude-write, external and the invariant "a version\'s by is the sole author since the previous one"', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' }) // baseline
    kit.write(file, DOC.replace('Last line.', 'Edited outside.'))
    await s.agent.batch({ ops: [{ op: 'replace_block', target: { quote: 'We launch in Q3.' }, markdown: 'We launch in Q2.' }] })
    const vs = readIndex(kit.abs(file)).versions.map((v) => [v.cause, v.by])
    expect(vs).toEqual([['baseline', 'external'], ['external', 'external'], ['claude-write', 'Claude']])
  })
})

describe('appendEvents (handoff events only, §3.9)', () => {
  it('derives by: sent → TJ, consumed via waiter → Claude, via ack → system; other types → INTERNAL; sent flushes the session', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    await saveText(s, DOC.replace('Q3', 'Q4'))
    const cid = clientId()
    const changes = kit.watch(s)
    const a = await s.appendEvents([{ type: 'handoff.sent', message: 'look', delivery: 'waiter' }], { clientId: cid })
    expect(a.events[0]).toMatchObject({ type: 'handoff.sent', by: 'TJ' })
    expect(types(kit.events(file)).slice(-2)).toEqual(['doc.edit', 'handoff.sent'])
    expect(changes.filter((c) => c.kind === 'sidecar').at(-1)).toMatchObject({ clientId: cid })
    const b = await s.appendEvents([{ type: 'handoff.consumed', handoffs: [a.events[0]!.seq], via: 'waiter', waiter: 'w_0123456789abcdef' }])
    expect(b.events[0]).toMatchObject({ by: 'Claude' })
    const c = await s.appendEvents([{ type: 'handoff.consumed', handoffs: [a.events[0]!.seq], via: 'ack' }])
    expect(c.events[0]).toMatchObject({ by: 'system' })
    await expect(s.appendEvents([{ type: 'comment.add' } as never])).rejects.toMatchObject({ code: 'INTERNAL' })
    expect((await s.handoffs())[0]).toMatchObject({ seq: a.events[0]!.seq, consumed: true, round: 1 })
  })
})

describe('StoreChange emission (D32)', () => {
  it('a byte commit emits doc then sidecar, both with the clientId; a CLI write carries none', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    const changes = kit.watch(s)
    const cid = clientId()
    await s.save(await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4')), { clientId: cid })
    expect(changes.map((c) => c.kind)).toEqual(['doc', 'sidecar'])
    expect(changes[0]).toMatchObject({ kind: 'doc', by: 'TJ', cause: 'save', clientId: cid, saveId: 1 })
    expect(changes[1]).toMatchObject({ kind: 'sidecar', clientId: cid })
    changes.length = 0
    await s.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'x' }] })
    expect(changes.every((c) => !('clientId' in c))).toBe(true)
  })
})

describe('block anchors follow a 1:1 replace (D35, row 85)', () => {
  it('a comment on the frontmatter follows Claude\'s edit of it with anchor.update by system', async () => {
    const text = '---\nstatus: draft\n---\n\nBody.\n'
    const file = kit.docIn(text)
    const s = await kit.open(file)
    const t = await s.tj.createThread({ opKey: opKey(), anchor: await blockAnchorOn(text, 0, 0), anchorRev: 0, body: 'status?' })
    const b = await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b1', rev: 1 }, markdown: '---\nstatus: final\n---' }] })
    const upd = ofType(kit.events(file), 'anchor.update')
    expect(upd).toHaveLength(1)
    expect(upd[0]).toMatchObject({ by: 'system', thread: t.thread.id, rev: b.rev })
    const rv = await s.review()
    expect(rv.threads[0]!.resolution.state).toBe('exact')
    expect((rv.threads[0]!.anchor as { hint: { blockHash: string } }).hint.blockHash).not.toBe((t.thread.anchor as { hint: { blockHash: string } }).hint.blockHash)
  })

  it('a rewritten commented paragraph re-resolves fuzzy → anchor.update by system; deleted → thread.detach by system with THREAD_DETACHED (row 39)', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const anchor: TextAnchor = await anchorOn(DOC, 'member rate of 12% paid monthly', 0)
    await s.tj.createThread({ opKey: opKey(), anchor, anchorRev: 0, body: 'x' })
    await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b3', rev: 1 }, markdown: 'The notes carry a member rate of 12% paid quarterly.' }] })
    const upd = ofType(kit.events(file), 'anchor.update')
    expect(upd.length).toBe(1)
    expect(upd[0]!.by).toBe('system')
    const del = await s.agent.batch({ ops: [{ op: 'delete_block', target: { ref: 'b3', rev: (await s.snapshot()).rev } }] })
    expect(del.warnings.map((w) => w.code)).toContain('THREAD_DETACHED')
    expect(ofType(kit.events(file), 'thread.detach')[0]).toMatchObject({ by: 'system', cause: 'unresolvable' })
  })

  it('a detached thread whose text comes back is reattached (row 38)', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    const t = await s.tj.createThread({ opKey: opKey(), anchor: await anchorOn(DOC, 'member rate', 0), anchorRev: 0, body: 'x' })
    const gone = DOC.replace('The notes carry a member rate of 12% paid monthly.\n\n', '')
    await saveText(s, gone, { anchors: [{ thread: t.thread.id, anchor: null }] })
    expect((await s.review()).threads[0]!.detached).toBe(true)
    await saveText(s, DOC, { saveId: 2 })
    expect(ofType(kit.events(file), 'thread.reattach')).toHaveLength(1)
    expect((await s.review()).threads[0]).toMatchObject({ detached: false, resolution: { state: 'exact' } })
  })
})

describe('mode bits and the realpath target (§3.1)', () => {
  it('a write keeps the original mode bits', async () => {
    const file = kit.docIn(DOC)
    const { chmodSync } = await import('node:fs')
    chmodSync(kit.abs(file), 0o600)
    const s = await kit.open(file)
    await saveText(s, DOC.replace('Q3', 'Q4'))
    expect(statSync(kit.abs(file)).mode & 0o777).toBe(0o600)
  })
})
