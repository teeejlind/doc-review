// tests/unit/server/write-routes.test.ts (P1). The M2 write routes on the real server (CONTRACTS §8.3, §8.4, §3.9,
// §10, D32, D47, D51): SaveRequest.suggestions.reopen refused; cause 'edit' folds as 'save'; a BOM doc's expectHash
// (docHash) matches the server's hash; restore returns `snapshot` equal to a fresh GET /api/doc and both SSE events of
// the restore and of an accept carry the clientId; /__test/splice-fault holds exactly the matching op as unsaveable;
// GET /api/review is 200 with readOnly for future-schema, non-UTF-8 and too-large docs while writes refuse; POST
// /api/flush flushes the TJ session; open → navigate reaches an empty-state tab and never a tab on another doc; agent requests
// report their route (and body file) to the handoff module, `arm` included; shutdown refuses another root and stops.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { docHash } from '../../../core/hash'
import { realId } from '../../../node/root'
import { startServer } from '../../../server/index'
import * as S from '../../../shared/schemas'
import type {
  AgentRoute, BatchResult, DecisionResult, DocSnapshot, HistoryList, RestoreResponse, ReviewState, SaveResponse, SidecarEvent,
} from '../../../shared/types'
import { CONSTANTS } from '../../../shared/types'
import { opsForText, webClient, type WebClient } from '../../helpers/webClient'
import { freePort, opKey, sleep, startSrv, type Recorder, type Srv } from './server-kit'

const DOC = '# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'
const BOM_DOC = '﻿# Title\r\n\r\nBody line one.\r\n\r\nBody line two.\r\n'

let srv: Srv
const open: Array<{ close(): unknown }> = []
beforeAll(async () => {
  srv = await startSrv({
    files: {
      'save.md': DOC, 'bom.md': BOM_DOC, 'restore.md': DOC, 'accept.md': DOC, 'fault.md': DOC, 'flush.md': DOC,
      'x.md': DOC, 'y.md': DOC,
      'future.md': DOC,
      'future.md.review.jsonl': JSON.stringify({ type: 'header', schema: 'mdr.sidecar/9', docId: `d_${'0'.repeat(26)}`, file: 'future.md', createdAt: '2026-10-15T00:00:00.000Z', createdBy: 'mdr/9' }) + '\n',
      'binary.md': Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]),
      'big.md': '# Big\n\n' + 'word '.repeat(Math.ceil((CONSTANTS.MAX_DOC_BYTES + 10) / 5)) + '\n',
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
async function stream(file: string | null, clientId?: `k_${string}`): Promise<Recorder> {
  const r = await srv.sse(file, clientId ? { clientId } : {})
  open.push(r)
  return r
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe('POST /api/save', () => {
  it('suggestions.reopen → BAD_REQUEST (undo of a decision is a reopen route, D26); cause edit folds as save', async () => {
    const snap = (await srv.web<DocSnapshot>('GET', '/api/doc?file=save.md')).json
    const next = snap.markdown.replace('First', 'Opening')
    const { ops, blockHashes } = await opsForText(snap.markdown, next)
    const base = { clientId: `k_${'1'.repeat(26)}`, saveId: 1, base: { rev: snap.rev, hash: snap.hash, blockHashes }, ops, expectHash: docHash(next, false), cause: 'edit', allowPartial: true }
    const bad = await srv.web<{ error: { code: string } }>('POST', '/api/save?file=save.md', { ...base, suggestions: { reopen: [] } })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('BAD_REQUEST')
    expect(srv.read('save.md')).toBe(DOC)
    const ok = await srv.web<SaveResponse>('POST', '/api/save?file=save.md', base)
    expect(ok.status).toBe(200)
    expect(S.SaveResponseSchema.safeParse(ok.json).success).toBe(true)
    const rev = srv.events('save.md').filter((e): e is Extract<SidecarEvent, { type: 'doc.rev' }> => e.type === 'doc.rev').pop()!
    expect(rev).toMatchObject({ by: 'TJ', cause: 'save', saveId: 1 })
  })

  it('a BOM + CRLF doc: the client\'s docHash expectHash matches the server\'s hash, BOM kept on disk (D40)', async () => {
    const c = await client('bom.md')
    const snap = await c.doc()
    expect(snap).toMatchObject({ bom: true, eol: '\r\n' })
    const next = snap.markdown.replace('one', 'uno')
    const r = await c.saveText(next)
    expect(r.applied).toBe('direct')
    expect(r.hash).toBe(docHash(next, true))
    const bytes = readFileSync(srv.path('bom.md'))
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(r.hash).toBe(sha(bytes))
  })
})

describe('restore and decisions: snapshot and echo (D47, D32)', () => {
  it('restore returns `snapshot` equal to a fresh GET /api/doc, and both SSE events carry the clientId', async () => {
    const c = await client('restore.md')
    await c.saveText(DOC.replace('First', 'Opening'))
    await c.saveText(DOC.replace('First', 'Opening').replace('Third', 'Final'))
    await srv.web('POST', '/api/flush?file=restore.md', { clientId: c.clientId, reason: 'beacon' })
    const hist = (await srv.web<HistoryList>('GET', '/api/history?file=restore.md')).json
    const baseline = hist.versions.find((v) => v.cause === 'baseline')!
    expect(baseline).toBeDefined()
    const rec = await stream('restore.md')
    const n = rec.events.length
    const cur = await c.doc()
    const r = await srv.web<RestoreResponse>('POST', '/api/history/restore?file=restore.md', { opKey: opKey(), v: baseline.v, baseRev: cur.rev }, { clientId: c.clientId })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(S.RestoreResponseSchema.safeParse(r.json).success).toBe(true)
    const fresh = (await srv.web<DocSnapshot>('GET', '/api/doc?file=restore.md')).json
    expect(r.json.snapshot).toEqual(fresh)
    expect(fresh.markdown).toBe(DOC)
    await rec.until((es) => es.slice(n).some((e) => e.event === 'sidecar-changed'))
    const mine = rec.events.slice(n).filter((e) => e.event === 'doc-changed' || e.event === 'sidecar-changed')
    expect(mine.map((e) => e.event)).toEqual(['doc-changed', 'sidecar-changed'])
    for (const e of mine) expect(e.data).toMatchObject({ clientId: c.clientId })
    expect(mine[0]!.data).toMatchObject({ by: 'TJ', cause: 'restore' })
    // a stale baseRev is refused
    const stale = await srv.web<{ error: { code: string } }>('POST', '/api/history/restore?file=restore.md', { opKey: opKey(), v: baseline.v, baseRev: cur.rev })
    expect(stale.json.error.code).toBe('STALE_REVISION')
  })

  it('an accept carries the clientId on doc-changed and sidecar-changed; the agent suggest before it carried none', async () => {
    const c = await client('accept.md')
    const rec = await stream('accept.md')
    const b = await srv.agent<BatchResult>('POST', '/api/agent/batch?file=accept.md', { ops: [{ op: 'suggest', quote: 'Second paragraph', replace: 'Middle paragraph' }] })
    expect(b.status, JSON.stringify(b.json)).toBe(200)
    await rec.until((es) => es.some((e) => e.event === 'sidecar-changed'))
    expect(rec.of('sidecar-changed')[0]!.data).not.toHaveProperty('clientId')
    const n = rec.events.length
    const d: DecisionResult = await c.decide(b.json.results[0]!.suggestion!, 'accept')
    expect(d.status).toBe('accepted')
    await rec.until((es) => es.slice(n).some((e) => e.event === 'sidecar-changed'))
    // P4 merge: the real handoff module broadcasts claude-activity (`replied`, then the unread count) after the agent
    // suggest's sidecar-changed, so they can land after `n`; only the two commit events are asserted, as for restore.
    const mine = rec.events.slice(n).filter((e) => e.event === 'doc-changed' || e.event === 'sidecar-changed')
    expect(mine.map((e) => e.event)).toEqual(['doc-changed', 'sidecar-changed'])
    for (const e of mine) expect(e.data).toMatchObject({ clientId: c.clientId })
    expect(mine[0]!.data).toMatchObject({ by: 'TJ', cause: 'accept', rev: d.rev, hash: d.hash })
  })
})

describe('/__test/splice-fault (D51)', () => {
  it('holds exactly the ops covering the faulted hashes as unsaveable; the rest of the save lands; [] clears it', async () => {
    const c = await client('fault.md')
    const snap = await c.doc()
    const target = snap.blocks[1]!
    expect((await srv.web('POST', '/__test/splice-fault', { file: 'fault.md', blockHashes: [target.hash] })).status).toBe(200)
    try {
      const next = snap.markdown.replace('First', 'Opening').replace('Third', 'Final')
      const r = await c.saveText(next)
      expect(r.unsaveable).toHaveLength(1)
      expect(r.unsaveable[0]!.kind).toBe('unsaveable')
      const disk = srv.read('fault.md')
      expect(disk).toContain('Final paragraph')
      expect(disk).toContain('First paragraph')
    } finally {
      expect((await srv.web('POST', '/__test/splice-fault', { blockHashes: [] })).status).toBe(200)
    }
    const r2 = await c.saveText(srv.read('fault.md').replace('First', 'Opening'))
    expect(r2.unsaveable).toEqual([])
    expect(srv.read('fault.md')).toContain('Opening paragraph')
  })
})

describe('read-only docs (§8.3, rows 26, 31)', () => {
  it('future schema: review 200, readOnly, no threads; writes refuse with the sidecar code', async () => {
    const r = await srv.web<ReviewState>('GET', '/api/review?file=future.md')
    expect(r.status).toBe(200)
    expect(S.ReviewStateSchema.safeParse(r.json).success).toBe(true)
    expect(r.json.readOnly).toMatchObject({ code: 'SIDECAR_SCHEMA_UNSUPPORTED' })
    expect(r.json.threads).toEqual([])
    const w = await srv.web<{ error: { code: string } }>('POST', '/api/threads?file=future.md', { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })
    expect(w.json.error.code).toBe('SIDECAR_SCHEMA_UNSUPPORTED')
  })

  it('non-UTF-8 and too-large docs: review 200 with readOnly; a comment write is READ_ONLY', async () => {
    for (const [file, code] of [['binary.md', 'NOT_UTF8'], ['big.md', 'TOO_LARGE']] as const) {
      const r = await srv.web<ReviewState>('GET', `/api/review?file=${file}`)
      expect(r.status, file).toBe(200)
      expect(S.ReviewStateSchema.safeParse(r.json).success, file).toBe(true)
      expect(r.json.readOnly, file).toMatchObject({ code })
      const snap = await srv.web<DocSnapshot>('GET', `/api/doc?file=${file}`)
      expect(snap.status, file).toBe(200)
      expect(snap.json.readOnly, file).toMatchObject({ code })
      const w = await srv.web<{ error: { code: string } }>('POST', `/api/threads?file=${file}`, { opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })
      expect(w.json.error.code, file).toBe('READ_ONLY')
    }
  })
})

describe('POST /api/flush (§7.1 beacon)', () => {
  it('flushes the TJ session into one doc.edit { source: editor }; idempotent', async () => {
    const c = await client('flush.md')
    await c.saveText(DOC.replace('First', 'Opening'))
    await c.saveText(DOC.replace('First', 'Opening').replace('Second', 'Middle'))
    expect(srv.events('flush.md').some((e) => e.type === 'doc.edit')).toBe(false)
    const f = await srv.web('POST', '/api/flush?file=flush.md', { clientId: c.clientId, reason: 'beacon' })
    expect([f.status, f.json]).toEqual([200, { ok: true }])
    const edits = srv.events('flush.md').filter((e): e is Extract<SidecarEvent, { type: 'doc.edit' }> => e.type === 'doc.edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({ by: 'TJ', source: 'editor' })
    await srv.web('POST', '/api/flush?file=flush.md', { clientId: c.clientId, reason: 'beacon' })
    expect(srv.events('flush.md').filter((e) => e.type === 'doc.edit')).toHaveLength(1)
    expect((await srv.web('POST', '/api/flush?file=flush.md', { clientId: c.clientId, reason: 'nope' })).status).toBe(400)
  })
})

describe('POST /api/agent/open → navigate (§8.4; QA3: a tab on another doc is left alone)', () => {
  type OpenOut = { ok: true; connectedTabs: number; navigated: boolean }
  const openDoc = (file: string) => srv.agent<OpenOut>('POST', '/api/agent/open', { file })

  it('nobody connected → navigated false; a bad file is refused like any other', async () => {
    expect((await openDoc('x.md')).json).toEqual({ ok: true, connectedTabs: 0, navigated: false })
    expect((await srv.agent<{ error: { code: string } }>('POST', '/api/agent/open', { file: 'nope.md' })).json.error.code).toBe('FILE_NOT_FOUND')
  })

  it('a tab already on the file counts as navigated and nothing is sent, whichever tab was used last', async () => {
    const a = await stream('x.md')
    await sleep(5)
    const c = await stream('y.md') // the most recent tab, on another doc
    expect((await openDoc('x.md')).json).toEqual({ ok: true, connectedTabs: 2, navigated: true })
    await sleep(100)
    expect(a.of('navigate')).toHaveLength(0)
    expect(c.of('navigate')).toHaveLength(0)
  })

  it('tabs on other docs are never navigated: navigated false, the url is all Claude has to offer', async () => {
    const a = await stream('x.md')
    await sleep(5)
    const c = await stream('y.md')
    const r = await openDoc('save.md')
    expect(r.json).toEqual({ ok: true, connectedTabs: 2, navigated: false })
    await sleep(100)
    expect(a.of('navigate')).toHaveLength(0)
    expect(c.of('navigate')).toHaveLength(0)
  })

  it('an empty-state (root channel) tab is the idle one: it gets the navigate, the most recently active of them if several', async () => {
    const a = await stream('x.md')
    await sleep(5)
    const rootOld = await stream(null)
    await sleep(5)
    const rootNew = await stream(null)
    await sleep(5)
    const c = await stream('y.md') // most recent overall
    const r = await openDoc('save.md')
    expect(r.json).toEqual({ ok: true, connectedTabs: 4, navigated: true })
    await rootNew.until((es) => es.some((e) => e.event === 'navigate'))
    expect(rootNew.of('navigate')[0]!.data).toEqual({ file: 'save.md' })
    // the root channel never gets a hello
    expect(rootNew.of('hello')).toHaveLength(0)
    await sleep(100)
    for (const t of [a, rootOld, c]) expect(t.of('navigate')).toHaveLength(0)
  })
})

describe('agent policy and route reporting (HandoffDeps.onAgentRequest)', () => {
  it('every agent request reports its AgentRoute and file (query or body), arm and consume included', async () => {
    const seen: Array<[string | null, AgentRoute]> = []
    const off = srv.app.deps.onAgentRequest((file, route) => seen.push([file, route]))
    await srv.agent('GET', '/api/agent/status?file=x.md')
    await srv.agent('GET', '/api/agent/history/diff?file=x.md&from=current&to=current')
    await srv.agent('POST', '/api/agent/open', { file: 'y.md' })
    const p = await srv.agent<{ ok: boolean; seq: number; suggestOnly: boolean }>('POST', '/api/agent/policy', { file: 'x.md', suggestOnly: true })
    expect(p.json).toMatchObject({ ok: true, suggestOnly: true })
    await srv.agent('POST', '/api/agent/arm', { file: 'x.md' })
    await srv.agent('POST', '/api/agent/handoff/consume', { file: 'y.md', handoffs: [], waiter: 'w_0123456789abcdef' })
    await srv.agent('GET', '/api/agent/status?file=nope.md')
    off()
    expect(seen).toEqual([
      ['x.md', 'status'], ['x.md', 'history'], ['y.md', 'open'], ['x.md', 'policy'], ['x.md', 'arm'], ['y.md', 'consume'],
    ])
    const back = await srv.agent<{ suggestOnly: boolean }>('POST', '/api/agent/policy', { file: 'x.md', suggestOnly: false })
    expect(back.json.suggestOnly).toBe(false)
  })
})

describe('POST /api/agent/shutdown', () => {
  it('refuses another root (ROOT_MISMATCH); stop answers, closes and removes the marker; restart keeps it', async () => {
    expect((await srv.agent<{ error: { code: string } }>('POST', '/api/agent/shutdown', { root: '/tmp', reason: 'stop' })).json.error.code).toBe('ROOT_MISMATCH')
    expect((await srv.agent<{ error: { code: string } }>('POST', '/api/agent/shutdown', { root: srv.root, reason: 'later' })).status).toBe(400)
    const root = realId(mkdtempSync(join(tmpdir(), 'mdr-shutdown-')))
    writeFileSync(join(root, 'doc.md'), DOC)
    try {
      for (const reason of ['stop', 'restart'] as const) {
        const port = await freePort()
        const one = await startServer({ root, port })
        const r = await fetch(`http://127.0.0.1:${port}/api/agent/shutdown`, {
          method: 'POST',
          headers: { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': '2', Authorization: `Bearer ${one.marker.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, reason }),
        })
        expect([r.status, await r.json()]).toEqual([200, { ok: true }])
        let down = false
        for (let k = 0; k < 60 && !down; k++) {
          await sleep(50)
          down = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => false, () => true)
        }
        expect(down, reason).toBe(true)
        const marker = join(root, '.review', 'server.json')
        if (reason === 'restart') expect((JSON.parse(readFileSync(marker, 'utf8')) as { serverId: string }).serverId).toBe(one.serverId)
        else expect(existsSync(marker)).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
