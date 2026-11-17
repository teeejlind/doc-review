// tests/unit/node/docstore-adopt.test.ts (P1; CONTRACTS §3.6, §8.6, §9.3, rows 8, 15, 28, 29). What a server-mode store
// tells its listeners about writes it did not make, through reconcileDoc (the watcher's hook):
// - lines another process appended (a direct-mode CLI write) are emitted once, in order: a doc change per new doc.rev
//   (by Claude, cause cli, with the batch's doc.edit changes) and one sidecar change; the server adopts by hash and
//   records no doc.external;
// - the store's own writes are never re-emitted, and a tick with nothing new on disk takes no lock;
// - a never-written doc edited or deleted on disk gets a ledger whose baseline is the bytes the store saw, then
//   doc.external / doc.missing against them;
// - a deleted sidecar re-emits from seq 0; a corrupt sidecar cannot record, so a changed doc is announced unrecorded;
// - direct and read-only stores track nothing.
import { readFileSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileDoc, storeCursor, storeTextAt } from '../../../node/docstore'
import type { DocStore, StoreChange } from '../../../shared/types'
import { makeKit, saveReq, type Kit } from './store-kit'

const DOC = '# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n'

let kit: Kit
beforeEach(() => {
  kit = makeKit('mdr-adopt-')
})
afterEach(async () => {
  await kit.cleanup()
})

const kinds = (cs: StoreChange[]): string[] => cs.map((c) => c.kind)

async function written(file: string): Promise<DocStore> {
  // a first TJ save gives the doc its ledger
  const s = await kit.open(file, { mode: 'server' })
  await s.save(await saveReq(await s.snapshot(), DOC.replace('First', 'Opening')))
  await s.flushTjSession('beacon')
  return s
}

describe('foreign lines (direct-mode CLI writes)', () => {
  it('a CLI write is emitted once, as Claude\'s, with its doc.edit changes; no doc.external is recorded', async () => {
    const file = kit.docIn(DOC)
    const server = await written(file)
    const seen = kit.watch(server)
    const cli = await kit.open(file, { mode: 'direct' })
    const before = kit.events(file).length
    const r = await cli.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b3', rev: (await cli.snapshot()).rev }, markdown: 'Replaced.' }, { op: 'comment', quote: 'Opening', body: 'Hm.' }] })
    await reconcileDoc(server)
    expect(kinds(seen)).toEqual(['doc', 'sidecar'])
    const [doc, side] = seen as [Extract<StoreChange, { kind: 'doc' }>, Extract<StoreChange, { kind: 'sidecar' }>]
    expect(doc).toMatchObject({ rev: r.rev, hash: r.hash, by: 'Claude', cause: 'cli' })
    expect(doc.changes.length).toBeGreaterThan(0)
    expect(doc).not.toHaveProperty('clientId')
    expect(side.fromSeq).toBe(kit.events(file)[before - 1]!.seq)
    expect(side.events.map((e) => e.type)).toEqual(expect.arrayContaining(['doc.rev', 'doc.edit', 'comment.add']))
    expect(side.seq).toBe(kit.events(file).at(-1)!.seq)
    expect(storeTextAt(server, r.hash)).toContain('Replaced.')
    expect(storeCursor(server)).toMatchObject({ rev: r.rev, seq: side.seq })
    expect(kit.events(file).some((e) => e.type === 'doc.external')).toBe(false)
    // nothing new → nothing emitted
    await reconcileDoc(server)
    expect(seen).toHaveLength(2)
  })

  it('the store\'s own writes are never re-emitted by a tick', async () => {
    const file = kit.docIn(DOC)
    const server = await written(file)
    const seen = kit.watch(server)
    await server.tj.createThread({ opKey: `op_${'2'.repeat(26)}`, anchor: { kind: 'doc' }, anchorRev: 0, body: 'Mine.' })
    expect(kinds(seen)).toEqual(['sidecar'])
    await reconcileDoc(server)
    await reconcileDoc(server)
    expect(kinds(seen)).toEqual(['sidecar'])
  })

  it('a doc first written by the CLI (its sidecar created there) is caught up from seq 0, baseline skipped', async () => {
    const file = kit.docIn(DOC)
    const server = await kit.open(file, { mode: 'server' })
    const seen = kit.watch(server)
    const cli = await kit.open(file, { mode: 'direct' })
    const r = await cli.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b2', rev: 0 }, markdown: 'From the CLI.' }] })
    await reconcileDoc(server)
    expect(kinds(seen)).toEqual(['doc', 'sidecar'])
    expect(seen[0]).toMatchObject({ kind: 'doc', by: 'Claude', rev: r.rev })
    expect((seen[1] as Extract<StoreChange, { kind: 'sidecar' }>).fromSeq).toBe(0)
  })
})

describe('never-written docs (no sidecar yet)', () => {
  it('an external edit: baseline = the bytes the store saw, then doc.external against them', async () => {
    const file = kit.docIn(DOC)
    const server = await kit.open(file, { mode: 'server' })
    const seen = kit.watch(server)
    const old = await server.snapshot()
    kit.write(file, DOC.replace('Second', 'Other'))
    await reconcileDoc(server)
    expect(kinds(seen)).toEqual(['sidecar', 'doc', 'sidecar'])
    expect(seen[1]).toMatchObject({ kind: 'doc', by: 'external', cause: 'external', prevRev: 1 })
    const lines = kit.events(file)
    expect(lines.map((e) => e.type)).toEqual(['doc.rev', 'doc.rev', 'doc.external'])
    expect(lines[0]).toMatchObject({ cause: 'baseline', hash: old.hash })
    expect(storeTextAt(server, old.hash)).toBe(DOC)
    expect((await server.snapshot()).rev).toBe(2)
  })

  it('a delete: baseline then doc.missing, `removed` emitted, reads say DOC_GONE', async () => {
    const file = kit.docIn(DOC)
    const server = await kit.open(file, { mode: 'server' })
    const seen = kit.watch(server)
    rmSync(kit.abs(file))
    await reconcileDoc(server)
    expect(kinds(seen)).toContain('removed')
    expect(kit.events(file).map((e) => e.type)).toEqual(['doc.rev', 'doc.missing'])
    await expect(server.snapshot()).rejects.toMatchObject({ code: 'DOC_GONE' })
  })

  it('an unchanged never-written doc: a tick writes nothing and creates no .review/', async () => {
    const file = kit.docIn(DOC)
    const server = await kit.open(file, { mode: 'server' })
    const seen = kit.watch(server)
    await reconcileDoc(server)
    expect(seen).toEqual([])
    expect(kit.sidecar(file)).toEqual([])
  })
})

describe('resets and read-only sidecars', () => {
  it('a deleted sidecar re-emits from seq 0 (the fan-out then resyncs on the docId change)', async () => {
    const file = kit.docIn(DOC)
    const server = await written(file)
    const seen = kit.watch(server)
    rmSync(kit.abs(file) + '.review.jsonl')
    await reconcileDoc(server)
    expect(seen).toEqual([{ kind: 'sidecar', fromSeq: 0, seq: 0, events: [] }])
    expect(storeCursor(server)?.docId).toBeNull()
  })

  it('a corrupt sidecar: a changed doc is announced (external, unrecorded); nothing is appended', async () => {
    const file = kit.docIn(DOC)
    const server = await written(file)
    const seen = kit.watch(server)
    const sidecar = kit.sidecar(file)
    kit.write(file + '.review.jsonl', [JSON.stringify(sidecar[0]), '{corrupt', ...sidecar.slice(1).map((l) => JSON.stringify(l))].join('\n') + '\n')
    const bytes = readFileSync(kit.abs(file) + '.review.jsonl', 'utf8')
    kit.write(file, DOC.replace('Second', 'Changed'))
    await reconcileDoc(server)
    expect(kinds(seen)).toEqual(['doc'])
    expect(seen[0]).toMatchObject({ by: 'external', cause: 'external', changes: [] })
    expect(readFileSync(kit.abs(file) + '.review.jsonl', 'utf8')).toBe(bytes)
  })

  it('direct and read-only stores track nothing: reconcileDoc is a no-op', async () => {
    const file = kit.docIn(DOC)
    const direct = await kit.open(file, { mode: 'direct' })
    const ro = await kit.open(file, { mode: 'server', readOnly: true })
    const a = kit.watch(direct)
    const b = kit.watch(ro)
    kit.write(file, DOC.replace('Second', 'Other'))
    await reconcileDoc(direct)
    await reconcileDoc(ro)
    expect([a, b]).toEqual([[], []])
    expect(kit.sidecar(file)).toEqual([])
  })
})
