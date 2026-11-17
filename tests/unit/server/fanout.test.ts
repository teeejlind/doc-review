// tests/unit/server/fanout.test.ts (P1). Store → SSE on the real server with the real watcher (CONTRACTS §3.6, §8.6,
// D18, D32, §13 rows 8, 11, 15, 28, 29): commit order (doc-changed before sidecar-changed, ids rev.seq), echo stamping
// (a browser write carries its clientId, an agent, CLI or external write none), external writes in place and by rename
// reach the page in < 1 s attributed `external`, a direct-mode CLI write is adopted by hash and announced as Claude's,
// an edit or delete of a never-written doc is recorded against the bytes the server saw, a deleted doc is doc-removed
// then DOC_GONE, a deleted sidecar resyncs, and onSidecarAppended fires for every append whoever wrote it.
import { renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openDocStore } from '../../../node/docstore'
import { storeChangeEvents } from '../../../server/sse'
import * as S from '../../../shared/schemas'
import type { BrowserSseEvent, SaveResponse, SidecarEvent } from '../../../shared/types'
import { CONSTANTS } from '../../../shared/types'
import { webClient, type WebClient } from '../../helpers/webClient'
import { sleep, startSrv, type Recorder, type Srv } from './server-kit'

const DOC = '# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n'

let srv: Srv
const open: Array<{ close(): unknown }> = []
beforeAll(async () => {
  srv = await startSrv({
    files: {
      'a.md': DOC, 'b.md': DOC, 'c.md': DOC, 'd.md': DOC, 'e.md': DOC, 'f.md': DOC, 'g.md': DOC, 'h.md': DOC, 'fresh.md': DOC,
      'gone.md': DOC, 'reset.md': DOC,
    },
  })
})
afterEach(async () => {
  for (const x of open.splice(0)) await x.close()
})
afterAll(async () => {
  await srv?.close()
})

async function client(file: string): Promise<WebClient> {
  const c = await webClient({ port: srv.port, root: srv.root, file })
  open.push(c)
  return c
}
async function stream(file: string | null): Promise<Recorder> {
  const r = await srv.sse(file)
  open.push(r)
  return r
}
const valid = (events: BrowserSseEvent[]): void => {
  for (const e of events) {
    // the recorder keeps the frame's `id:` on the event; the wire shape is event + data
    const { id: _id, ...wire } = e as BrowserSseEvent & { id?: string }
    expect(S.BrowserSseEventSchema.safeParse(wire).success, JSON.stringify(e)).toBe(true)
  }
}
const after = <K extends BrowserSseEvent['event']>(r: Recorder, k: K, from: number): Array<Extract<BrowserSseEvent, { event: K }>> =>
  r.events.slice(from).filter((e) => e.event === k) as never

describe('browser writes: order, ids and echo stamping (§8.6, D32)', () => {
  it('a save emits doc-changed then sidecar-changed, both with the clientId and the saveId; nothing else follows', async () => {
    // a write first, so the doc has a ledger and the save below is not the materializing one
    const c = await client('a.md')
    await c.saveText(DOC.replace('First', 'Opening'))
    const rec = await stream('a.md')
    const n = rec.events.length
    const r: SaveResponse = await c.saveText(DOC.replace('First', 'Opening').replace('Second', 'Closing'))
    expect(r.applied).toBe('direct')
    await rec.until((es) => es.slice(n).some((e) => e.event === 'sidecar-changed'))
    await sleep(300) // the watcher sees our own write: it must stay silent
    const mine = rec.events.slice(n)
    expect(mine.map((e) => e.event)).toEqual(['doc-changed', 'sidecar-changed'])
    valid(mine)
    const [dc, sc] = mine as [Extract<BrowserSseEvent, { event: 'doc-changed' }>, Extract<BrowserSseEvent, { event: 'sidecar-changed' }>]
    expect(dc.data).toMatchObject({ file: 'a.md', rev: r.rev, hash: r.hash, by: 'TJ', cause: 'save', clientId: c.clientId, saveId: expect.any(Number) })
    expect(dc.data.markdown).toBe(srv.read('a.md'))
    expect(sc.data).toMatchObject({ file: 'a.md', seq: r.seq, clientId: c.clientId })
    expect(sc.data.types).toContain('doc.rev')
    expect((dc as { id?: string }).id).toBe(`${r.rev}.${r.seq}`)
    expect((sc as { id?: string }).id).toBe(`${r.rev}.${r.seq}`)
  })

  it('an agent batch carries no clientId (an agent write is never an echo)', async () => {
    const rec = await stream('b.md')
    const n = rec.events.length
    const r = await srv.agent<{ ok: boolean }>('POST', '/api/agent/batch?file=b.md', { ops: [{ op: 'comment', quote: 'Second paragraph', body: 'Why?' }] })
    expect(r.status).toBe(200)
    await rec.until((es) => es.slice(n).some((e) => e.event === 'sidecar-changed'))
    const sc = after(rec, 'sidecar-changed', n)
    expect(sc[0]!.data).not.toHaveProperty('clientId')
    expect(sc[0]!.data.types).toContain('comment.add')
  })
})

describe('external writes (§3.6, row 8, row 11)', () => {
  it('an in-place write: doc-changed by external in < 1 s with the new markdown, never TJ; then sidecar-changed', async () => {
    const tj = await (await client('c.md')).saveText(DOC.replace('First', 'Opening'))
    const rec = await stream('c.md')
    const n = rec.events.length
    const next = DOC.replace('Second', 'Other')
    const t0 = Date.now()
    writeFileSync(srv.path('c.md'), next)
    const isExternal = (e: BrowserSseEvent): boolean => e.event === 'sidecar-changed' && e.data.types.includes('doc.external')
    await rec.until((es) => es.slice(n).some(isExternal), 3_000)
    const dc = after(rec, 'doc-changed', n)
    expect(dc).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(1_000)
    // TJ's open session (his save is the last WAL batch in the log) is flushed first, then the external rev follows it
    expect(rec.events.slice(n).map((e) => e.event === 'sidecar-changed' ? e.data.types.join('+') : e.event))
      .toEqual(['doc.edit', 'doc-changed', 'doc.rev+doc.external'])
    expect(dc[0]!.data).toMatchObject({ by: 'external', cause: 'external', markdown: next, prevRev: tj.rev })
    expect(dc[0]!.data).not.toHaveProperty('clientId')
    expect(dc[0]!.data.changes.length).toBeGreaterThan(0)
    valid(rec.events.slice(n))
    const snap = (await srv.web<{ markdown: string; rev: number }>('GET', '/api/doc?file=c.md')).json
    expect(snap).toMatchObject({ markdown: next, rev: dc[0]!.data.rev })
    expect(srv.events('c.md').filter((e) => e.type === 'doc.external')).toHaveLength(1)
  })

  it('an atomic tmp + rename write (an editor\'s save) is seen the same way', async () => {
    await (await client('d.md')).saveText(DOC.replace('First', 'Opening'))
    const rec = await stream('d.md')
    const n = rec.events.length
    const next = DOC.replace('Second', 'Renamed')
    writeFileSync(srv.path('.d.md.tmp'), next)
    renameSync(srv.path('.d.md.tmp'), srv.path('d.md'))
    await rec.until((es) => es.slice(n).some((e) => e.event === 'doc-changed'), 3_000)
    expect(after(rec, 'doc-changed', n)[0]!.data).toMatchObject({ by: 'external', markdown: next })
  })

  it('a never-written doc edited on disk: the ledger is created with the bytes the server saw as the baseline', async () => {
    const rec = await stream('fresh.md')
    expect(srv.sidecar('fresh.md')).toEqual([])
    const n = rec.events.length
    const next = DOC.replace('First', 'Edited')
    writeFileSync(srv.path('fresh.md'), next)
    await rec.until((es) => es.slice(n).some((e) => e.event === 'doc-changed'), 3_000)
    expect(after(rec, 'doc-changed', n)[0]!.data).toMatchObject({ by: 'external', cause: 'external', markdown: next })
    const lines = srv.events('fresh.md')
    expect(lines.map((e) => [e.type, e.by])).toEqual([['doc.rev', 'system'], ['doc.rev', 'external'], ['doc.external', 'external']])
    const [base, ext] = lines as [Extract<SidecarEvent, { type: 'doc.rev' }>, Extract<SidecarEvent, { type: 'doc.rev' }>]
    expect(base.cause).toBe('baseline')
    expect(ext.prevHash).toBe(base.hash)
    const ex = lines[2] as Extract<SidecarEvent, { type: 'doc.external' }>
    expect(ex.changes?.length).toBeGreaterThan(0)
  })

  it('a deleted doc: doc-removed, then 410 DOC_GONE on reads and writes; a recreate save brings it back', async () => {
    const c = await client('gone.md')
    await c.saveText(DOC.replace('First', 'Opening'))
    const before = await c.doc()
    const rec = await stream('gone.md')
    const n = rec.events.length
    unlinkSync(srv.path('gone.md'))
    await rec.until((es) => es.slice(n).some((e) => e.event === 'doc-removed'), 3_000)
    expect((await srv.web<{ error: { code: string } }>('GET', '/api/doc?file=gone.md')).json.error.code).toBe('DOC_GONE')
    expect((await srv.web<{ error: { code: string } }>('GET', '/api/review?file=gone.md')).status).toBe(410)
    const thread = await srv.web<{ error: { code: string } }>('POST', '/api/threads?file=gone.md', { opKey: `op_${'1'.repeat(26)}`, anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })
    expect(thread.json.error.code).toBe('DOC_GONE')
    expect(srv.events('gone.md').some((e) => e.type === 'doc.missing')).toBe(true)
    // recreate from the editor's copy: base.hash = lastHash, ops against object(lastHash)
    const r = await srv.web<SaveResponse>('POST', '/api/save?file=gone.md', {
      clientId: c.clientId, saveId: 99, base: { rev: before.rev, hash: before.hash, blockHashes: before.blocks.map((b) => b.hash) },
      ops: [], cause: 'recreate', allowPartial: false,
    })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(srv.read('gone.md')).toBe(before.markdown)
    expect((await srv.web('GET', '/api/doc?file=gone.md')).status).toBe(200)
  })

  it('a deleted sidecar under an open session (row 29): resync', async () => {
    await (await client('reset.md')).saveText(DOC.replace('First', 'Opening'))
    const rec = await stream('reset.md')
    const n = rec.events.length
    rmSync(srv.path('reset.md') + '.review.jsonl')
    await rec.until((es) => es.slice(n).some((e) => e.event === 'resync'), 3_000)
    const snap = (await srv.web<{ docId: string | null }>('GET', '/api/doc?file=reset.md')).json
    expect(snap.docId).toBeNull()
  })
})

describe('direct-mode CLI writes (§9.3, row 15)', () => {
  it('a write by another store instance is adopted by hash: doc-changed by Claude, sidecar-changed, onSidecarAppended', async () => {
    await (await client('e.md')).saveText(DOC.replace('First', 'Opening'))
    const rec = await stream('e.md')
    const appended: Array<{ file: string; events: SidecarEvent[] }> = []
    const off = srv.app.deps.onSidecarAppended((file, events) => appended.push({ file, events }))
    const n = rec.events.length
    const cli = await openDocStore(srv.root, 'e.md', { mode: 'direct', lockTimeoutMs: CONSTANTS.LOCK_TIMEOUT_CLI_MS })
    const res = await cli.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b2', rev: (await cli.snapshot()).rev }, markdown: 'Replaced by the CLI.' }] })
    await cli.close()
    await rec.until((es) => es.slice(n).some((e) => e.event === 'sidecar-changed'), 3_000)
    off()
    const dc = after(rec, 'doc-changed', n)
    expect(dc).toHaveLength(1)
    expect(dc[0]!.data).toMatchObject({ by: 'Claude', cause: 'cli', rev: res.rev, hash: res.hash })
    expect(dc[0]!.data.markdown).toContain('Replaced by the CLI.')
    expect(dc[0]!.data.changes.length).toBeGreaterThan(0)
    expect(dc[0]!.data).not.toHaveProperty('clientId')
    const sc = after(rec, 'sidecar-changed', n)
    expect(sc[0]!.data.types).toEqual(expect.arrayContaining(['doc.rev', 'doc.edit']))
    expect(appended.some((a) => a.file === 'e.md' && a.events.some((e) => e.type === 'doc.edit' && e.by === 'Claude'))).toBe(true)
    // the server adopted, not re-recorded: no doc.external
    expect(srv.events('e.md').some((e) => e.type === 'doc.external')).toBe(false)
  })
})

describe('onSidecarAppended (HandoffDeps)', () => {
  it('fires after a browser write with the appended lines', async () => {
    const got: SidecarEvent[][] = []
    const off = srv.app.deps.onSidecarAppended((file, events) => {
      if (file === 'f.md') got.push(events)
    })
    const c = await client('f.md')
    await c.createThread({ kind: 'doc' }, 'Note.')
    off()
    expect(got.flat().some((e) => e.type === 'comment.add')).toBe(true)
  })
})

describe('storeChangeEvents (pure mapping)', () => {
  it('omits doc-changed.markdown above SSE_MARKDOWN_MAX_BYTES and keeps first-appearance type order', () => {
    const big = 'x'.repeat(CONSTANTS.SSE_MARKDOWN_MAX_BYTES + 1)
    const [d] = storeChangeEvents('a.md', { kind: 'doc', rev: 3, prevRev: 2, hash: 'h'.repeat(64), by: 'external', cause: 'external', changes: [] }, { rev: 3, seq: 9 }, () => big)
    expect(d!.e.data).not.toHaveProperty('markdown')
    expect(d!.id).toBe('3.9')
    const [small] = storeChangeEvents('a.md', { kind: 'doc', rev: 3, prevRev: 2, hash: 'h'.repeat(64), by: 'TJ', cause: 'save', clientId: `k_${'0'.repeat(26)}`, saveId: 4, changes: [] }, { rev: 3, seq: 9 }, () => 'hi')
    expect(small!.e.data).toMatchObject({ markdown: 'hi', clientId: `k_${'0'.repeat(26)}`, saveId: 4 })
    const ev = (type: string, seq: number) => ({ type, seq }) as unknown as SidecarEvent
    const [s] = storeChangeEvents('a.md', { kind: 'sidecar', fromSeq: 4, seq: 7, events: [ev('doc.rev', 5), ev('comment.add', 6), ev('doc.rev', 7)] }, { rev: 3, seq: 7 }, () => null)
    expect(s!.e.data).toMatchObject({ fromSeq: 4, seq: 7, types: ['doc.rev', 'comment.add'] })
    expect(s!.id).toBe('3.7')
    expect(storeChangeEvents('a.md', { kind: 'removed' }, { rev: 3, seq: 7 }, () => null)[0]!.e).toEqual({ event: 'doc-removed', data: { file: 'a.md' } })
  })
})

describe('watching (D18)', () => {
  it('only opened docs are watched', async () => {
    await srv.web('GET', '/api/doc?file=g.md')
    expect(srv.app.watcher.watching()).toContain('g.md')
    expect(srv.app.watcher.watching()).not.toContain('h.md')
  })
})
