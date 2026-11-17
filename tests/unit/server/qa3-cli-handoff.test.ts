// tests/unit/server/qa3-cli-handoff.test.ts (QA round 3, cli-handoff). The real server, the real handoff module.
//
// - GET /api/agent/pending that comes back empty puts the Claude badge back to idle ("Claude looked and found
//   nothing"; the skill ends the turn without an ack, so nothing else would). A read that finds something stays working.
// - A Claude replace_block moves no badge to "Claude replied": the page raises its own "Claude changed N blocks" cue
//   from the doc-changed event (by: 'Claude').
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BatchResult, ClaudeActivity, PendingResult, StatusResult } from '../../../shared/types'
import { opKey, startSrv, type Srv } from './server-kit'

const DOC = '# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n'

let srv: Srv
beforeAll(async () => {
  srv = await startSrv({ files: { 'empty.md': DOC, 'busy.md': DOC, 'edit.md': DOC } })
})
afterAll(async () => {
  await srv?.close()
})

const activity = async (file: string): Promise<ClaudeActivity> => (await srv.agent<StatusResult>('GET', `/api/agent/status?file=${file}`)).json.activity!

describe('GET /api/agent/pending → the badge', () => {
  it('an empty read leaves the doc idle (it never sticks at "Claude is working")', async () => {
    const r = await srv.agent<PendingResult>('GET', '/api/agent/pending?file=empty.md')
    expect(r.json.empty).toBe(true)
    expect((await activity('empty.md')).state).toBe('idle')
  })

  it('a read that finds TJ\'s comment stays working until the ack', async () => {
    const t = await srv.web('POST', '/api/threads?file=busy.md', { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'Tighten this.' })
    expect(t.status, JSON.stringify(t.json)).toBe(200)
    const r = await srv.agent<PendingResult>('GET', '/api/agent/pending?file=busy.md')
    expect(r.json.empty).toBe(false)
    expect((await activity('busy.md')).state).toBe('working')
    await srv.agent<BatchResult>('POST', '/api/agent/batch?file=busy.md', { ops: [], ack: r.json.cursor, ackSince: r.json.since })
    await expect.poll(async () => (await activity('busy.md')).state).toBe('idle')
  })
})

describe('Claude\'s direct edit', () => {
  it('replace_block: the page gets doc-changed by Claude, the badge stays at working and never says replied', async () => {
    const rec = await srv.sse('edit.md')
    await rec.until((es) => es.some((e) => e.event === 'hello'))
    const snap = (await srv.agent<{ rev: number }>('GET', '/api/agent/snapshot?file=edit.md')).json
    const b = await srv.agent<BatchResult>('POST', '/api/agent/batch?file=edit.md', {
      ops: [{ op: 'replace_block', target: { ref: 'b2', rev: snap.rev }, markdown: 'First paragraph, tightened.' }],
    })
    expect(b.status, JSON.stringify(b.json)).toBe(200)
    await rec.until((es) => es.some((e) => e.event === 'doc-changed'))
    expect(rec.of('doc-changed')[0]!.data).toMatchObject({ by: 'Claude', changes: [{ op: 'replace' }] })
    await rec.until((es) => es.some((e) => e.event === 'sidecar-changed'))
    expect((await activity('edit.md')).state).toBe('working')
    expect(rec.of('claude-activity').map((e) => e.data.state)).not.toContain('replied')
  })
})
