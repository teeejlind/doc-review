// tests/unit/node/gc-pinning.test.ts (integrator, M4; CONTRACTS §3.6, §3.8; CONTRACT_CHANGES row "objects GC vs an
// unreconciled external write").
//
// Regression for a bug int-external found on the real server: the store's objects GC (2 s after a store opens, then
// hourly) ran while an external write sat on disk unreconciled. state() then read TJ's last committed rev as an
// in-flight WAL batch (its hash no longer matches the disk), so the rev dropped out of the pinned set and its object
// was deleted. The watcher's reconcile right after recorded `doc.external { changes: null }` and flushed TJ's session
// as `doc.edit { changes: [] }`, so `pending` lost TJ's edit. The GC must keep that object.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { maintainDoc, reconcileDoc } from '../../../node/docstore'
import { historyPaths } from '../../../node/history'
import type { SidecarEvent } from '../../../shared/types'
import { makeKit, saveReq, type Kit } from './store-kit'

const DOC = '# T\n\nAlpha beta.\n\nGamma delta.\n\nEpsilon zeta.\n'

let kit: Kit
beforeAll(() => {
  kit = makeKit('mdr-gc-pin-')
})
afterAll(async () => {
  await kit.cleanup()
})

describe('objects GC with an external write not yet reconciled (§3.8)', () => {
  it('keeps the last committed rev\'s object, so the external diff and TJ\'s session flush keep their text', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    const snap = await s.snapshot()
    const mine = DOC.replace('Gamma delta.', 'Gamma delta, edited by TJ.')
    const r = await s.save(await saveReq(snap, mine))
    expect(r.applied).toBe('direct')
    const tjObject = join(historyPaths(kit.abs(file)).objects, `${r.hash}.md.gz`)
    expect(existsSync(tjObject)).toBe(true)

    // an external writer (Claude's Edit tool) lands on disk; the watcher has not reconciled it yet
    kit.write(file, mine.replace('Epsilon zeta.', 'Epsilon zeta, rewritten outside.'))
    await maintainDoc(s)
    expect(existsSync(tjObject), 'the GC kept the object of TJ\'s committed rev').toBe(true)

    // the watcher's reconcile now records the external change against it, with its text
    await reconcileDoc(s)
    const evs = kit.events(file)
    const ext = evs.filter((e): e is Extract<SidecarEvent, { type: 'doc.external' }> => e.type === 'doc.external')
    expect(ext).toHaveLength(1)
    expect(ext[0]!.changes).not.toBeNull()
    expect(ext[0]!.changes!.map((c) => c.after?.md ?? '').join('\n')).toContain('rewritten outside')
    const tj = evs.filter((e): e is Extract<SidecarEvent, { type: 'doc.edit' }> => e.type === 'doc.edit' && e.by === 'TJ')
    expect(tj).toHaveLength(1)
    expect(tj[0]!.changes.map((c) => c.after?.md ?? '').join('\n')).toContain('edited by TJ')
    expect(tj[0]!.changes.map((c) => c.after?.md ?? '').join('\n')).not.toContain('rewritten outside')

    // and pending keeps them apart, each with its text
    const p = await s.agent.pending()
    expect(p.edits.map((e) => e.by)).toEqual(['TJ'])
    expect(JSON.stringify(p.edits)).toContain('edited by TJ')
    expect(p.external.map((e) => e.by)).toEqual(['external'])
    expect(JSON.stringify(p.external)).toContain('rewritten outside')
  })

  it('still deletes an object nothing pins once the disk and the ledger agree', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    const snap = await s.snapshot()
    await s.save(await saveReq(snap, DOC.replace('Alpha beta.', 'Alpha beta 2.')))
    const orphan = join(historyPaths(kit.abs(file)).objects, `${'cd'.repeat(32)}.md.gz`)
    const { writeFileSync } = await import('node:fs')
    const { gzipSync } = await import('node:zlib')
    writeFileSync(orphan, gzipSync(Buffer.from('orphan')))
    const out = await maintainDoc(s)
    expect(out.removedObjects).toBe(1)
    expect(existsSync(orphan)).toBe(false)
  })
})
