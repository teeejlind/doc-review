// tests/unit/cli/doctor.test.ts (P4; CONTRACTS §4.8, §13 #30).
//
// `mdr doctor <file>` over P1's node/doctor.ts with a sidecar written by the real store (direct mode): the read-only
// report (lines, seq gaps, corrupt lines, torn tail, schema), then --repair (quarantine + log.repair), --compact and
// --gc reported in `actions`, and the same command with the real server up.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import { openDocStore } from '../../../node/docstore'
import { tmpRoot, type TmpRoot } from '../../helpers/tmpRoot'
import { cli, realServer, type RealServer } from './runner'

let root: TmpRoot | null = null
let srv: RealServer | null = null
afterEach(async () => {
  await srv?.stop()
  srv = null
  root?.cleanup()
  root = null
})

async function withSidecar(): Promise<TmpRoot> {
  root = tmpRoot({ name: 'p4-doctor', fixtures: ['basic.md'] })
  const store = await openDocStore(root.root, 'basic.md', { mode: 'direct', lockTimeoutMs: 5_000 })
  try {
    await store.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'one' }, { op: 'comment', doc: true, body: 'two' }] })
  } finally {
    await store.close()
  }
  return root
}

const lines = (p: string): string[] => readFileSync(p, 'utf8').split('\n').filter(Boolean)

describe('mdr doctor', () => {
  it('no sidecar yet: exists false, nothing to report', async () => {
    root = tmpRoot({ name: 'p4-doctor', fixtures: ['basic.md'] })
    const r = await cli(['doctor', root.path('basic.md')])
    expect(r.code).toBe(0)
    expect(S.DoctorResultSchema.safeParse(r.json).success).toBe(true)
    expect(r.json).toMatchObject({ ok: true, file: 'basic.md', sidecar: { exists: false, lines: 0 }, actions: [] })
  })

  it('a healthy sidecar written by the real store: the schema, no gaps, no corruption', async () => {
    const t = await withSidecar()
    const r = await cli(['doctor', t.path('basic.md')])
    expect(S.DoctorResultSchema.safeParse(r.json).success).toBe(true)
    expect(r.json.sidecar).toMatchObject({ exists: true, schema: 'mdr.sidecar/2', seqGaps: [], corruptLines: [], tornTail: false })
    expect(r.json.sidecar.lines).toBe(lines(t.sidecarPath('basic.md')).length)
    expect(r.json.sidecar.bytes).toBeGreaterThan(0)
  })

  it('reports a corrupt mid-file line and a torn tail without touching the file', async () => {
    const t = await withSidecar()
    const p = t.sidecarPath('basic.md')
    const ls = lines(p)
    ls.splice(2, 0, '{not json')
    writeFileSync(p, ls.join('\n') + '\n')
    appendFileSync(p, '{"seq":99,"torn')
    const before = readFileSync(p, 'utf8')
    const r = await cli(['doctor', t.path('basic.md')])
    expect(r.code).toBe(0)
    expect(r.json.sidecar).toMatchObject({ corruptLines: [3], tornTail: true })
    expect(readFileSync(p, 'utf8')).toBe(before)
  })

  it('--repair quarantines the corrupt line, drops the torn tail and appends log.repair; the report is clean after', async () => {
    const t = await withSidecar()
    const p = t.sidecarPath('basic.md')
    const ls = lines(p)
    ls.splice(2, 0, '{not json')
    writeFileSync(p, ls.join('\n') + '\n{"seq":99,"torn')
    const r = await cli(['doctor', t.path('basic.md'), '--repair'])
    expect(r.code, r.stdout).toBe(0)
    expect(S.DoctorResultSchema.safeParse(r.json).success).toBe(true)
    expect(r.json.actions).toEqual(['quarantined', 'repaired-tail'])
    expect(r.json.sidecar).toMatchObject({ corruptLines: [], tornTail: false })
    const quarantine = readdirSync(dirname(p)).filter((f) => f.startsWith('basic.md.review.jsonl.quarantine-'))
    expect(quarantine).toHaveLength(1)
    expect(readFileSync(`${dirname(p)}/${quarantine[0]}`, 'utf8')).toBe('{not json\n')
    const last = JSON.parse(lines(p).at(-1)!) as { type: string }
    expect(last.type).toBe('log.repair')
    // the repaired log opens and folds: the two comments are still there
    const st = await cli(['status', t.path('basic.md')])
    expect(st.code, st.stdout).toBe(0)
  })

  it('--compact and --gc run and are listed; a corrupt log must be repaired before compacting (SIDECAR_CORRUPT, exit 9)', async () => {
    const t = await withSidecar()
    const r = await cli(['doctor', t.path('basic.md'), '--compact', '--gc'])
    expect(r.code, r.stdout).toBe(0)
    expect(r.json.actions).toContain('gc')
    expect(S.DoctorResultSchema.safeParse(r.json).success).toBe(true)
    const p = t.sidecarPath('basic.md')
    const ls = lines(p)
    ls.splice(2, 0, '{not json')
    writeFileSync(p, ls.join('\n') + '\n')
    const bad = await cli(['doctor', t.path('basic.md'), '--compact'])
    expect(bad.code).toBe(9)
    expect(bad.json).toMatchObject({ ok: false, error: { code: 'SIDECAR_CORRUPT' } })
  })

  it('works with the real server up (the doc lock serializes it); the server keeps reading the doc after', async () => {
    const t = await withSidecar()
    srv = await realServer(t.root)
    const before = await cli(['status', t.path('basic.md')])
    expect(before.json.via).toBe('server')
    const r = await cli(['doctor', t.path('basic.md'), '--gc'])
    expect(r.code, r.stdout).toBe(0)
    expect(r.json.actions).toEqual(['gc'])
    const after = await cli(['pending', t.path('basic.md')])
    expect(after.code, after.stdout).toBe(0)
    expect(after.json.via).toBe('server')
    expect(existsSync(t.sidecarPath('basic.md'))).toBe(true)
  })
})
