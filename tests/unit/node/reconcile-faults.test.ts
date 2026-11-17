// tests/unit/node/reconcile-faults.test.ts (P1). Reconcile by hash (CONTRACTS §3.6, every row of its table incl. #13
// and recreate with base.hash = lastHash), the MDR_FAULT crash points and their recovery (§13 rows 3-7, 12), the stable
// read (row 11), the doc lock (rows 16-17) and the in-flight exclusion seen by unlocked readers (§4.6).
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { docHash } from '../../../core/hash'
import { stableRead } from '../../../node/doc-io'
import { setFaultHandlerForTests } from '../../../node/fault'
import { historyPaths, readIndex } from '../../../node/history'
import { lockPathOf } from '../../../node/lock'
import { maintainDoc } from '../../../node/docstore'
import type { DocStore, SidecarEvent } from '../../../shared/types'
import { makeKit, opKey, saveReq, type Kit } from './store-kit'

const DOC = '# Title\n\nWe launch in Q3.\n\nThe member is 12%.\n\nLast line.\n'

let kit: Kit
beforeAll(() => {
  kit = makeKit('mdr-reconcile-')
})
afterAll(async () => {
  await kit.cleanup()
})
afterEach(() => {
  delete process.env.MDR_FAULT
  setFaultHandlerForTests(null)
})

const types = (evs: readonly SidecarEvent[]): string[] => evs.map((e) => e.type)
const ofType = <T extends SidecarEvent['type']>(evs: readonly SidecarEvent[], t: T): Array<Extract<SidecarEvent, { type: T }>> =>
  evs.filter((e) => e.type === t) as Array<Extract<SidecarEvent, { type: T }>>

/** A doc with a materialized sidecar (one doc comment). */
async function reviewed(text = DOC, mode: 'server' | 'direct' = 'direct'): Promise<{ file: string; s: DocStore }> {
  const file = kit.docIn(text)
  const s = await kit.open(file, { mode })
  await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'start' })
  return { file, s }
}

/** Crash at `point`: the writer throws there (a dead process); the store instance is then abandoned. */
function crashAt(point: string): void {
  process.env.MDR_FAULT = point
  setFaultHandlerForTests((p) => {
    throw new Error(`crashed at ${p}`)
  })
}

describe('reconcile table (§3.6)', () => {
  it('in sync: the server\'s own echo and a touch append nothing', async () => {
    const { file, s } = await reviewed()
    await s.save(await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4')))
    const n = kit.events(file).length
    const { utimesSync } = await import('node:fs')
    utimesSync(kit.abs(file), new Date(), new Date())
    await s.tj.readMarker({ thread: null, upTo: 1 })
    expect(types(kit.events(file).slice(n))).toEqual(['read-marker'])
  })

  it('external: doc.rev { by external } + doc.external with the block changes, an external version, and a doc change event', async () => {
    const { file, s } = await reviewed(DOC, 'server')
    const changes = kit.watch(s)
    kit.write(file, DOC.replace('Last line.', 'Edited by a tool.'))
    await s.tj.readMarker({ thread: null, upTo: 1 })
    const evs = kit.events(file)
    const ext = ofType(evs, 'doc.external')[0]!
    expect(ofType(evs, 'doc.rev').at(-1)).toMatchObject({ by: 'external', cause: 'external', prevRev: 1, hash: docHash(DOC.replace('Last line.', 'Edited by a tool.'), false) })
    expect(ext).toMatchObject({ by: 'external', fromRev: 1, toRev: 2 })
    expect(ext.changes!.map((c) => [c.op, c.before?.md, c.after?.md])).toEqual([['replace', 'Last line.', 'Edited by a tool.']])
    expect(readIndex(kit.abs(file)).versions.at(-1)).toMatchObject({ cause: 'external', by: 'external', rev: 2 })
    expect(changes[0]).toMatchObject({ kind: 'doc', by: 'external', cause: 'external', rev: 2 })
    expect(changes[0]).not.toHaveProperty('clientId')
    expect((await s.snapshot()).rev).toBe(2)
  })

  it('external right after a TJ save (its WAL batch still trailing): prevRev is TJ\'s rev, and his session is flushed first, without the external change', async () => {
    const { file, s } = await reviewed(DOC, 'server')
    const tj = await s.save(await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4')))
    expect(tj.rev).toBe(2)
    // nothing follows TJ's batch in the log, so its wal hash is the last thing the ledger says about the disk
    expect(kit.events(file).at(-1)).toMatchObject({ type: 'doc.rev', by: 'TJ', wal: { rev: 2 } })
    const changes = kit.watch(s)
    const tool = DOC.replace('Q3', 'Q4').replace('Last line.', 'Edited by a tool.')
    kit.write(file, tool)
    await s.tj.readMarker({ thread: null, upTo: 1 })
    const evs = kit.events(file)
    const tail = evs.slice(evs.findIndex((e) => e.type === 'doc.rev' && e.rev === 2) + 1)
    expect(types(tail)).toEqual(['doc.edit', 'doc.rev', 'doc.external', 'read-marker'])
    expect(tail[0]).toMatchObject({ by: 'TJ', source: 'editor', fromRev: 1, toRev: 2 })
    const sessionMd = JSON.stringify((tail[0] as { changes: unknown }).changes)
    expect(sessionMd).toContain('Q4')
    expect(sessionMd).not.toContain('Edited by a tool')
    expect(tail[1]).toMatchObject({ by: 'external', cause: 'external', rev: 3, prevRev: 2, prevHash: tj.hash, hash: docHash(tool, false) })
    const ext = tail[2] as Extract<SidecarEvent, { type: 'doc.external' }>
    expect(ext).toMatchObject({ fromRev: 2, toRev: 3 })
    expect(ext.changes!.map((c) => [c.op, c.before?.md, c.after?.md])).toEqual([['replace', 'Last line.', 'Edited by a tool.']])
    expect(changes.find((c) => c.kind === 'doc')).toMatchObject({ by: 'external', rev: 3, prevRev: 2 })
    expect(await s.snapshot()).toMatchObject({ rev: 3, markdown: tool })
    expect(await s.agent.status()).toMatchObject({ rev: 3, needsRecovery: false })
  })

  it('row 15: a direct-mode CLI write logged by another process is adopted by hash; the browser save planned before it merges', async () => {
    const { file, s } = await reviewed(DOC, 'server')
    const base = await s.snapshot()
    const cli = await kit.open(file, { mode: 'direct' })
    const b = await cli.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b4', rev: base.rev }, markdown: 'Final line.' }] })
    expect(b.via).toBe('direct')
    const r = await s.save(await saveReq(base, DOC.replace('Q3', 'Q4')))
    expect(r.applied).toBe('merged')
    expect(ofType(kit.events(file), 'doc.external')).toHaveLength(0)
    expect(ofType(kit.events(file), 'doc.rev').map((e) => e.by)).toEqual(['system', 'Claude', 'TJ'])
    expect(kit.read(file)).toBe(DOC.replace('Q3', 'Q4').replace('Last line.', 'Final line.'))
  })

  it('#13: an external revert to the content of an earlier mdr write is recorded as external, never swallowed', async () => {
    const { file, s } = await reviewed()
    await s.save(await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4')))
    kit.write(file, DOC)
    await s.tj.readMarker({ thread: null, upTo: 1 })
    expect(ofType(kit.events(file), 'doc.rev').at(-1)).toMatchObject({ by: 'external', hash: docHash(DOC, false) })
  })

  it('an external edit made while no store was open is reconciled when a server store opens', async () => {
    const { file } = await reviewed()
    kit.write(file, DOC.replace('Q3', 'Q9'))
    const s = await kit.open(file, { mode: 'server' })
    expect(ofType(kit.events(file), 'doc.external')).toHaveLength(1)
    expect((await s.snapshot()).rev).toBe(2)
  })

  it('missing: doc.missing { lastHash } once, a removed event, writes DOC_GONE; recreate with base.hash = lastHash writes it back (0644)', async () => {
    const { file, s } = await reviewed(DOC, 'server')
    const snap = await s.snapshot()
    const changes = kit.watch(s)
    unlinkSync(kit.abs(file))
    await expect(s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })).rejects.toMatchObject({ code: 'DOC_GONE', status: 410 })
    await expect(s.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'x' }] })).rejects.toMatchObject({ code: 'DOC_GONE' })
    expect(ofType(kit.events(file), 'doc.missing')).toEqual([expect.objectContaining({ by: 'external', lastHash: snap.hash })])
    expect(changes.map((c) => c.kind)).toContain('removed')
    await expect(s.snapshot()).rejects.toMatchObject({ code: 'DOC_GONE' })
    // a recreate whose base isn't lastHash → CONFLICT with current built from object(lastHash)
    const wrong = await saveReq({ ...snap, hash: docHash('nope', false) }, snap.markdown, { cause: 'recreate', allowPartial: false })
    await expect(s.save(wrong)).rejects.toMatchObject({ code: 'CONFLICT', current: expect.objectContaining({ hash: snap.hash, markdown: DOC }) })
    // Recreate from my copy: base = lastHash, ops from planSave against it
    const r = await s.save(await saveReq(snap, DOC.replace('Q3', 'Q4'), { cause: 'recreate', allowPartial: false, saveId: 2 }))
    expect(r.applied).toBe('direct')
    expect(kit.read(file)).toBe(DOC.replace('Q3', 'Q4'))
    expect(statSync(kit.abs(file)).mode & 0o777).toBe(0o644)
    expect(ofType(kit.events(file), 'doc.rev').at(-1)).toMatchObject({ by: 'TJ', cause: 'recreate', prevHash: snap.hash })
    expect(ofType(kit.events(file), 'doc.missing')).toHaveLength(1)
  })

  it('a sidecar deleted while serving is treated as new: the next write starts a new header and docId (row 29)', async () => {
    const { file, s } = await reviewed()
    const id1 = (await s.snapshot()).docId
    unlinkSync(kit.abs(file) + '.review.jsonl')
    await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'again' })
    const snap = await s.snapshot()
    expect(snap.docId).not.toBe(id1)
    expect(snap.rev).toBe(1)
  })
})

describe('MDR_FAULT crash points (rows 3-7)', () => {
  it('after-wal: the next lock holder sees disk = prevHash → doc.abort not-landed + server.recovered wal; keys are freed', async () => {
    const { file, s } = await reviewed()
    const req = await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4'))
    crashAt('after-wal')
    await expect(s.save(req)).rejects.toThrow('crashed at after-wal')
    expect(kit.read(file)).toBe(DOC)
    // an unlocked reader excludes the in-flight batch and reports needsRecovery
    const ro = await kit.open(file, { readOnly: true })
    expect(await ro.agent.status()).toMatchObject({ rev: 1, needsRecovery: true })
    delete process.env.MDR_FAULT
    const s2 = await kit.open(file)
    const r = await s2.save(req)
    expect(r.applied).toBe('direct')
    expect(r.rev).toBe(3) // aborted revs are never reused
    const evs = kit.events(file)
    expect(types(evs).slice(-4)).toEqual(['doc.rev', 'doc.abort', 'server.recovered', 'doc.rev'])
    expect(ofType(evs, 'doc.abort')[0]).toMatchObject({ abortedRev: 2, reason: 'not-landed' })
    expect(ofType(evs, 'server.recovered')[0]).toMatchObject({ what: 'wal' })
    expect(kit.read(file)).toBe(DOC.replace('Q3', 'Q4'))
  })

  it('after-rename: committed; the retry with the same key is a duplicate with the original result', async () => {
    const { file, s } = await reviewed()
    const req = await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4'))
    crashAt('after-rename')
    await expect(s.save(req)).rejects.toThrow('crashed at after-rename')
    expect(kit.read(file)).toBe(DOC.replace('Q3', 'Q4'))
    delete process.env.MDR_FAULT
    const s2 = await kit.open(file)
    expect(await s2.save(req)).toMatchObject({ applied: 'duplicate', rev: 2 })
    expect(ofType(kit.events(file), 'doc.abort')).toHaveLength(0)
  })

  it('after-object: an orphan object and nothing else; GC removes it', async () => {
    const { file, s } = await reviewed()
    const before = kit.events(file).length
    const next = DOC.replace('Q3', 'Q4')
    crashAt('after-object')
    await expect(s.save(await saveReq(await s.snapshot(), next))).rejects.toThrow('crashed at after-object')
    expect(kit.events(file).length).toBe(before)
    const obj = join(historyPaths(kit.abs(file)).objects, `${docHash(next, false)}.md.gz`)
    expect(existsSync(obj)).toBe(true)
    delete process.env.MDR_FAULT
    const s2 = await kit.open(file)
    const gc = await maintainDoc(s2)
    expect(gc.removedObjects).toBe(1)
    expect(existsSync(obj)).toBe(false)
    expect(kit.events(file).length).toBe(before)
  })

  it('after-tmp: the dead writer\'s tmp file is removed by the next writer, and the batch is aborted', async () => {
    const { file, s } = await reviewed()
    crashAt('after-tmp')
    await expect(s.save(await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4')))).rejects.toThrow('crashed at after-tmp')
    const tmps = (): string[] => readdirSync(dirname(kit.abs(file))).filter((n) => n.endsWith('.tmp'))
    expect(tmps()).toHaveLength(1)
    delete process.env.MDR_FAULT
    const s2 = await kit.open(file)
    await s2.tj.readMarker({ thread: null, upTo: 1 })
    expect(tmps()).toHaveLength(0)
    expect(ofType(kit.events(file), 'doc.abort')[0]).toMatchObject({ reason: 'not-landed' })
  })

  it('mid-append:<n>: the torn tail is ignored by readers, truncated by the next writer (the whole partial batch), server.recovered torn-tail', async () => {
    const { file, s } = await reviewed()
    const t = await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'thread' })
    await s.tj.resolve(t.thread.id, { opKey: opKey() })
    const n0 = kit.events(file).length
    // a reply to a resolved thread is a two-line batch (comment.reply + thread.reopen): cut it inside its second line
    const k = opKey()
    process.env.MDR_FAULT = 'mid-append:330'
    setFaultHandlerForTests((p) => {
      throw new Error(`crashed at ${p}`)
    })
    await expect(s.tj.reply(t.thread.id, { opKey: k, body: 'partial' })).rejects.toThrow(/crashed at mid-append/)
    delete process.env.MDR_FAULT
    const ro = await kit.open(file, { readOnly: true })
    const rv = await ro.review()
    expect(rv.threads.find((x) => x.id === t.thread.id)?.status).toBe('resolved')
    const s2 = await kit.open(file)
    const again = await s2.tj.reply(t.thread.id, { opKey: k, body: 'partial' })
    expect(again.duplicate).toBeUndefined()
    const evs = kit.events(file)
    expect(types(evs.slice(n0))).toEqual(['server.recovered', 'comment.reply', 'thread.reopen'])
    expect(evs[n0]).toMatchObject({ what: 'torn-tail' })
    expect((await s2.review()).threads.find((x) => x.id === t.thread.id)?.status).toBe('open')
  })

  it('mid-append inside the creating write: a torn header is removed, a header with no baseline gets one', async () => {
    for (const cut of [20, 250]) {
      const file = kit.docIn(DOC)
      const s = await kit.open(file)
      process.env.MDR_FAULT = `mid-append:${cut}`
      setFaultHandlerForTests((p) => {
        throw new Error(`crashed at ${p}`)
      })
      await expect(s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'first' })).rejects.toThrow(/crashed/)
      delete process.env.MDR_FAULT
      const s2 = await kit.open(file)
      await s2.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'again' })
      const lines = kit.sidecar(file)
      expect(lines[0]).toMatchObject({ type: 'header' })
      const evs = lines.slice(1) as SidecarEvent[]
      expect(evs.find((e) => e.type === 'doc.rev')).toMatchObject({ rev: 1, cause: 'baseline' })
      expect(evs.at(-1)).toMatchObject({ type: 'comment.add', body: 'again', rev: 1 })
      expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => evs[0]!.seq + i))
      expect((await s2.review()).threads.map((t) => t.messages[0]!.body)).toEqual(['again'])
    }
  })

  it('row 12: an external write inside the commit window → doc.abort raced-external, reconcile, re-merge, the save still lands', async () => {
    const { file, s } = await reviewed()
    const req = await saveReq(await s.snapshot(), DOC.replace('Q3', 'Q4'))
    process.env.MDR_FAULT = 'after-wal'
    setFaultHandlerForTests(() => {
      delete process.env.MDR_FAULT
      writeFileSync(kit.abs(file), DOC.replace('Last line.', 'Tool wrote this.'))
    })
    const r = await s.save(req)
    expect(r.applied).toBe('merged')
    expect(kit.read(file)).toBe(DOC.replace('Q3', 'Q4').replace('Last line.', 'Tool wrote this.'))
    const evs = kit.events(file)
    expect(ofType(evs, 'doc.abort')[0]).toMatchObject({ reason: 'raced-external', abortedRev: 2 })
    expect(ofType(evs, 'doc.external')).toHaveLength(1)
    expect(ofType(evs, 'doc.rev').map((e) => [e.rev, e.by])).toEqual([[1, 'system'], [2, 'TJ'], [3, 'external'], [4, 'TJ']])
  })
})

describe('stable read (row 11)', () => {
  it('two equal reads 150 ms apart: a file still being rewritten is read once it settles', async () => {
    const file = kit.docIn('first')
    const abs = kit.abs(file)
    const writes = ['', 'par', 'partial', 'settled']
    let k = 0
    const timer = setInterval(() => {
      if (k < writes.length) writeFileSync(abs, writes[k++]!)
    }, 60)
    const r = await stableRead(abs)
    clearInterval(timer)
    expect(r.raw!.toString()).toBe('settled')
  })
})

describe('the doc lock (§4.6)', () => {
  it('a lock held elsewhere → LOCK_TIMEOUT (503 / exit 9) after lockTimeoutMs', async () => {
    const { file } = await reviewed()
    const release = await lockfile.lock(kit.abs(file), { lockfilePath: lockPathOf(kit.abs(file)), realpath: false })
    try {
      const s = await kit.open(file, { lockTimeoutMs: 150 })
      await expect(s.tj.readMarker({ thread: null, upTo: 1 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT', status: 503, exit: 9 })
    } finally {
      await release()
    }
  })

  it('two writers in one process are serialized; seqs stay contiguous (row 16)', async () => {
    const { file } = await reviewed()
    const a = await kit.open(file)
    const b = await kit.open(file)
    await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: `c${i}` })))
    const seqs = kit.events(file).map((e) => e.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
    expect(ofType(kit.events(file), 'comment.add')).toHaveLength(7)
  })
})
