// tests/unit/node/doctor.test.ts (P1). The store half of `mdr doctor` (CONTRACTS §4.8, D22): the read-only report,
// --repair (quarantine + log.repair, the doc writable again), --compact on a real store log (review state and pending
// equal before and after), --gc (orphan objects), plus history retention (§10) and objects GC pinning (§3.8).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { doctor } from '../../../node/doctor'
import { historyPaths, retentionPlan, isoWeekKey } from '../../../node/history'
import * as S from '../../../shared/schemas'
import type { Actor, SuggestionId, VersionCause, VersionMeta } from '../../../shared/types'
import { anchorOn, makeKit, opKey, saveReq, type Kit } from './store-kit'

const DOC = '# T\n\nAlpha beta.\n\nGamma delta.\n'

let kit: Kit
beforeAll(() => {
  kit = makeKit('mdr-doctor-')
})
afterAll(async () => {
  await kit.cleanup()
})

describe('mdr doctor (§4.8)', () => {
  it('reports a healthy log read-only; --repair quarantines a corrupt mid-file line, appends log.repair, and the doc is writable again', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    for (let k = 0; k < 3; k++) await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: `c${k}` })
    const healthy = await doctor(kit.root, file, kit.abs(file))
    expect(S.DoctorResultSchema.safeParse(healthy).success).toBe(true)
    expect(healthy.sidecar).toMatchObject({ exists: true, lines: 5, corruptLines: [], tornTail: false, schema: 'mdr.sidecar/2' })
    expect(healthy.actions).toEqual([])

    const path = kit.abs(file) + '.review.jsonl'
    const lines = readFileSync(path, 'utf8').split('\n')
    lines[2] = '{"seq": not json'
    writeFileSync(path, lines.join('\n'))
    await expect(s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })).rejects.toMatchObject({ code: 'SIDECAR_CORRUPT' })
    expect((await s.review()).readOnly).toMatchObject({ code: 'SIDECAR_CORRUPT' })
    const rep = await doctor(kit.root, file, kit.abs(file))
    expect(rep.sidecar.corruptLines).toEqual([3])
    const fixed = await doctor(kit.root, file, kit.abs(file), { repair: true })
    expect(fixed.actions).toEqual(['quarantined'])
    expect(fixed.sidecar.corruptLines).toEqual([])
    const last = JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!)
    expect(last).toMatchObject({ type: 'log.repair', by: 'system' })
    expect(existsSync(last.quarantined)).toBe(true)
    expect(readFileSync(last.quarantined, 'utf8')).toBe('{"seq": not json\n')
    const r = await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'after repair' })
    expect(r.thread.messages[0]!.body).toBe('after repair')
  })

  it('--repair drops a torn tail (repaired-tail)', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })
    writeFileSync(kit.abs(file) + '.review.jsonl', readFileSync(kit.abs(file) + '.review.jsonl', 'utf8') + '{"seq":9,"type":"comm')
    expect((await doctor(kit.root, file, kit.abs(file))).sidecar.tornTail).toBe(true)
    const r = await doctor(kit.root, file, kit.abs(file), { repair: true })
    expect(r.actions).toEqual(['repaired-tail'])
    expect(r.sidecar.tornTail).toBe(false)
  })

  it('--compact on a real log: the review state and pending are equal before and after', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file, { mode: 'server' })
    const id = 's_01JAB3K9Q2T7V5X8Y0Z1W2E3K1' as SuggestionId
    // TJ keeps editing his own pending suggestion: several suggestion.update lines
    for (let k = 0; k < 4; k++) {
      const snap = await s.snapshot()
      await s.save(await saveReq(snap, snap.markdown, {
        saveId: k + 1,
        suggestions: { upsert: [{ id, range: { start: 1, end: 2 }, base: 'Alpha beta.', proposed: `Alpha beta ${k}.`, anchor: await anchorOn(snap.markdown, 'beta', snap.rev) }] },
      }))
    }
    const p0 = await s.agent.pending()
    await s.agent.batch({ ops: [{ op: 'reply', thread: (await s.review()).suggestions[0]!.thread, body: 'seen' }], ack: p0.cursor, ackSince: p0.since })
    const snap = await s.snapshot()
    await s.save(await saveReq(snap, snap.markdown, { saveId: 9, suggestions: { upsert: [{ id, range: { start: 1, end: 2 }, base: 'Alpha beta.', proposed: 'Alpha beta final.', anchor: await anchorOn(snap.markdown, 'beta', snap.rev) }] } }))
    const before = await s.review()
    const pendingBefore = await s.agent.pending()
    const out = await doctor(kit.root, file, kit.abs(file), { compact: true })
    expect(out.actions).toEqual(['compacted'])
    expect(out.sidecar.seqGaps).toEqual([])
    const header = JSON.parse(readFileSync(kit.abs(file) + '.review.jsonl', 'utf8').split('\n')[0]!)
    expect(header.compacted.droppedLines).toBeGreaterThanOrEqual(3)
    const after = await s.review()
    expect({ ...after, warnings: [] }).toEqual({ ...before, warnings: [] })
    expect(await s.agent.pending()).toEqual(pendingBefore)
    // the compacted store still writes
    await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'still works' })
  })

  it('--gc removes an orphan object', async () => {
    const file = kit.docIn(DOC)
    const s = await kit.open(file)
    await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })
    const orphan = join(historyPaths(kit.abs(file)).objects, `${'ab'.repeat(32)}.md.gz`)
    writeFileSync(orphan, gzipSync(Buffer.from('orphan')))
    expect((await doctor(kit.root, file, kit.abs(file))).history.orphanObjects).toBe(1)
    const r = await doctor(kit.root, file, kit.abs(file), { gc: true })
    expect(r.actions).toEqual(['gc'])
    expect(existsSync(orphan)).toBe(false)
    expect(r.history.orphanObjects).toBe(0)
  })
})

describe('history retention (§10)', () => {
  const DAY = 86_400_000
  const now = new Date('2026-10-15T12:00:00.000Z')
  const mk = (n: number, daysAgo: number, by: Actor, cause: VersionCause, hoursOffset = 0): VersionMeta => ({
    v: `v${n}`, n, rev: n, hash: n.toString(16).padStart(64, '0'), by, cause,
    at: new Date(now.getTime() - daysAgo * DAY + hoursOffset * 3_600_000).toISOString(), size: 10, revs: [n, n], blocksChanged: 1,
  })

  it('keeps < 7 days, the last per (day, actor) plus restore/claude-write/accept/external in 7–90 days, the last per ISO week past 90, and the newest 20', () => {
    const vs: VersionMeta[] = []
    let n = 0
    // > 90 days: three versions in one ISO week, two in another
    vs.push(mk(++n, 120, 'TJ', 'tj-session'), mk(++n, 119, 'TJ', 'tj-session'), mk(++n, 118, 'TJ', 'tj-session'))
    vs.push(mk(++n, 110, 'TJ', 'tj-session'), mk(++n, 109, 'TJ', 'tj-session'))
    // 7–90 days: one day with two TJ sessions, a Claude write and an external change
    vs.push(mk(++n, 30, 'TJ', 'tj-session', 1), mk(++n, 30, 'TJ', 'tj-session', 2), mk(++n, 30, 'Claude', 'claude-write', 3), mk(++n, 30, 'external', 'external', 4))
    // < 7 days
    vs.push(mk(++n, 2, 'TJ', 'tj-session'), mk(++n, 1, 'TJ', 'tj-session'))
    const keep = retentionPlan(vs, now, () => 10, Number.MAX_SAFE_INTEGER)
    // everything is within the newest 20, so all stay
    expect(keep.size).toBe(vs.length)
    // with more than 20 newer versions, the rules alone decide for the old ones
    const pad = Array.from({ length: 20 }, (_, k) => mk(100 + k, 0.5, 'TJ', 'tj-session', k * 0.01))
    const keep2 = retentionPlan([...vs, ...pad], now, () => 10, Number.MAX_SAFE_INTEGER)
    const weekA = isoWeekKey(new Date(vs[0]!.at))
    expect(isoWeekKey(new Date(vs[2]!.at))).toBe(weekA)
    expect([1, 2, 3].filter((k) => keep2.has(k))).toEqual([3]) // the last of that week
    expect(keep2.has(5)).toBe(true)
    expect(keep2.has(6)).toBe(false) // an earlier TJ session the same day
    expect([7, 8, 9].every((k) => keep2.has(k))).toBe(true)
    expect(keep2.has(10) && keep2.has(11)).toBe(true)
  })

  it('the 50 MB cap drops the oldest first, never the newest 20', () => {
    const vs = Array.from({ length: 30 }, (_, k) => mk(k + 1, 1, 'TJ', 'tj-session', k * 0.01))
    const keep = retentionPlan(vs, now, () => 1000, 25 * 1000)
    expect(keep.size).toBe(20)
    expect([...keep].sort((a, b) => a - b)[0]).toBe(11)
  })
})
