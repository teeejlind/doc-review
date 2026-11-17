// tests/unit/server/t2-cli-arm.test.ts (fix pass T2 cli; QA_FINDINGS Pass 4 #14). The real server, through the agent routes
// with the real hooks: a turn that only reads the doc leaves "Claude is working" up until the skill's end-of-turn
// `POST /api/agent/arm` (which `mdr arm` and `mdr open` send) ends it. The ack path and the rest are unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArmRouteResult, ClaudeActivity, StatusResult } from '../../../shared/types'
import { startSrv, type Srv } from './server-kit'

const DOC = '# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n'

let srv: Srv
beforeAll(async () => {
  srv = await startSrv({ files: { 'read.md': DOC, 'edit.md': DOC, 'other.md': DOC } })
})
afterAll(async () => {
  await srv?.close()
})

const activity = async (file: string): Promise<ClaudeActivity> => (await srv.agent<StatusResult>('GET', `/api/agent/status?file=${file}`)).json.activity!

describe('POST /api/agent/arm ends a turn that left no ack', () => {
  it('a read-only turn: working after the snapshot, idle after the arm; the status read in between does not move it', async () => {
    await srv.agent('GET', '/api/agent/snapshot?file=read.md')
    expect((await activity('read.md')).state).toBe('working')
    expect((await activity('read.md')).state).toBe('working')
    const r = await srv.agent<ArmRouteResult>('POST', '/api/agent/arm', { file: 'read.md' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, presence: { waiter: 'grace' } })
    expect((await activity('read.md')).state).toBe('idle')
  })

  it('a direct-edit turn with no ack: still working after the edit, idle after the arm, never replied', async () => {
    const rec = await srv.sse('edit.md')
    await rec.until((es) => es.some((e) => e.event === 'hello'))
    const snap = (await srv.agent<{ rev: number }>('GET', '/api/agent/snapshot?file=edit.md')).json
    const b = await srv.agent('POST', '/api/agent/batch?file=edit.md', { ops: [{ op: 'replace_block', target: { ref: 'b2', rev: snap.rev }, markdown: 'First paragraph, tightened.' }] })
    expect(b.status).toBe(200)
    await rec.until((es) => es.some((e) => e.event === 'sidecar-changed'))
    expect((await activity('edit.md')).state).toBe('working')
    await srv.agent('POST', '/api/agent/arm', { file: 'edit.md' })
    await rec.until((es) => es.some((e) => e.event === 'claude-activity' && e.data.state === 'idle'))
    expect(rec.of('claude-activity').map((e) => e.data.state)).toEqual(['working', 'idle'])
    rec.close()
  })

  it('an arm for one doc leaves another doc working', async () => {
    await srv.agent('GET', '/api/agent/snapshot?file=other.md')
    await srv.agent('POST', '/api/agent/arm', { file: 'read.md' })
    expect((await activity('other.md')).state).toBe('working')
    await srv.agent('POST', '/api/agent/arm', { file: 'other.md' })
    expect((await activity('other.md')).state).toBe('idle')
  })
})
