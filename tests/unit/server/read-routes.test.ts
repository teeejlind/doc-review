// tests/unit/server/read-routes.test.ts (P1). The M1 server over real HTTP (CONTRACTS §8.1, §8.3, §8.4, §8.6, §9.2.1,
// §12.0.2): meta injection (escaping, mdr-test-hooks only under test hooks, mdr-file-error), /__dev/meta only with
// MDR_DEV_ORIGIN=1 and identical to the injected block, .review/.gitignore before server.json, the read routes' 200s
// and their edge errors (corrupt sidecar → 200 readOnly, DOC_GONE, bad query values), SSE hello → resync, the root
// channel (no hello), and presence/activity overlaid by withHandoff.
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docHash } from '../../../core/hash'
import { appendVersion, encodeRaw, writeObject } from '../../../node/history'
import { realId } from '../../../node/root'
import { startServer } from '../../../server/index'
import { renderMetaTags, type MetaContext } from '../../../server/static'
import * as S from '../../../shared/schemas'
import type { BrowserSseEvent, RunningServer } from '../../../shared/types'
import { ERROR_TABLE, PROTOCOL } from '../../../shared/types'
import { readSse } from '../../helpers/sse'

const AT = '2026-10-15T17:00:00.000Z'
const DOC = '# Doc\n\nFirst paragraph.\n\nSecond paragraph.\n'
const H = docHash(DOC, false)

function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => done(port))
    })
  })
}

let root: string
let web: string
let port: number
let s: RunningServer
const prevWeb = process.env.MDR_WEB_DIR
const header = { type: 'header', schema: 'mdr.sidecar/2', docId: `d_${ulid()}`, file: 'doc.md', createdAt: AT, createdBy: 'mdr/2.0.0-dev' }
const line = (seq: number, e: Record<string, unknown>) => JSON.stringify({ seq, id: `e_${ulid()}`, at: AT, rev: 1, ...e })
const baseline = line(1, { type: 'doc.rev', by: 'system', prevRev: null, prevHash: null, hash: H, bytes: DOC.length, cause: 'baseline' })
const T1 = `t_${ulid()}`

beforeAll(async () => {
  root = realId(mkdtempSync(join(tmpdir(), 'mdr-read-')))
  writeFileSync(join(root, 'doc.md'), DOC)
  writeFileSync(join(root, 'doc.md.review.jsonl'), [
    JSON.stringify(header), baseline,
    line(2, { type: 'comment.add', by: 'TJ', thread: T1, comment: `c_${ulid()}`, anchor: { kind: 'doc' }, body: 'note' }),
  ].join('\n') + '\n')
  // a corrupt sidecar: the doc goes read-only, review still answers
  writeFileSync(join(root, 'corrupt.md'), DOC)
  writeFileSync(join(root, 'corrupt.md.review.jsonl'), [JSON.stringify(header), baseline, '{nope', line(3, { type: 'read-marker', by: 'TJ', thread: null, upTo: 0 })].join('\n') + '\n')
  // a recorded doc whose file is gone
  writeFileSync(join(root, 'gone.md.review.jsonl'), [JSON.stringify(header), baseline].join('\n') + '\n')
  // history for doc.md: v1 (an earlier text) and v2 (the current bytes)
  const abs = join(root, 'doc.md')
  const old = '# Doc\n\nFirst paragraph.\n'
  writeObject(abs, docHash(old, false), encodeRaw(old, false))
  writeObject(abs, H, encodeRaw(DOC, false))
  appendVersion(abs, { v: 'v1', n: 1, rev: 1, hash: docHash(old, false), by: 'external', cause: 'baseline', at: AT, size: old.length, revs: [1, 1], blocksChanged: 0 })
  appendVersion(abs, { v: 'v2', n: 2, rev: 1, hash: H, by: 'TJ', cause: 'tj-session', at: AT, size: DOC.length, revs: [1, 1], blocksChanged: 1 })

  web = realId(mkdtempSync(join(tmpdir(), 'mdr-web-')))
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><!--mdr:meta--></head><body></body></html>')
  process.env.MDR_WEB_DIR = web
  port = await freePort()
  s = await startServer({ root, port, testHooks: true })
})
afterAll(async () => {
  await s?.close('stop')
  if (prevWeb === undefined) delete process.env.MDR_WEB_DIR
  else process.env.MDR_WEB_DIR = prevWeb
  rmSync(root, { recursive: true, force: true })
  rmSync(web, { recursive: true, force: true })
})

const origin = () => `http://127.0.0.1:${port}`
const webGet = (path: string) => fetch(origin() + path, { headers: { 'X-MDR-Client': 'web', Authorization: `Bearer ${s.marker.token}` } })
const agentGet = (path: string) => fetch(origin() + path, { headers: { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(PROTOCOL), Authorization: `Bearer ${s.marker.token}` } })
async function json(r: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}
const code = (b: Record<string, unknown>) => (b.error as { code?: string } | undefined)?.code

/** SSE frames from `path` until `stop`, or until `quietMs` passes with no new message. */
async function sse(path: string, stop: (e: BrowserSseEvent[]) => boolean, quietMs = 400): Promise<{ status: number; events: BrowserSseEvent[] }> {
  const ac = new AbortController()
  const events: BrowserSseEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => ac.abort(), quietMs)
  }
  try {
    const r = await fetch(origin() + path, { headers: { Accept: 'text/event-stream' }, signal: ac.signal })
    if (!r.ok || !r.body) return { status: r.status, events }
    arm()
    for await (const f of readSse(r.body, ac.signal)) {
      if (f.kind !== 'message') continue
      events.push({ event: f.message.event, data: JSON.parse(f.message.data) } as BrowserSseEvent)
      if (stop(events)) break
      arm()
    }
    return { status: r.status, events }
  } catch (e) {
    if (ac.signal.aborted) return { status: 200, events }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    ac.abort()
  }
}

describe('meta injection (§12.0.2)', () => {
  const ctx: MetaContext = {
    root: '/r/"q"&<a>\'', rootHash: 'h', port: 1234, token: 't"k<', version: '2.0.0-dev', protocol: 2, schemaFingerprint: 'f', testHooks: false,
  }
  it('escapes every attribute value', () => {
    const m = renderMetaTags(undefined, ctx)
    expect(m).toContain('<meta name="mdr-root" content="/r/&quot;q&quot;&amp;&lt;a&gt;&#39;">')
    expect(m).toContain('<meta name="mdr-token" content="t&quot;k&lt;">')
    expect(m).not.toContain('<a>')
  })

  it('mdr-test-hooks only with test hooks; mdr-file-error only for a given-but-invalid ?file=', () => {
    expect(renderMetaTags(undefined, ctx)).not.toContain('mdr-test-hooks')
    expect(renderMetaTags(undefined, { ...ctx, testHooks: true })).toContain('<meta name="mdr-test-hooks" content="1">')
    expect(renderMetaTags(undefined, ctx)).not.toContain('mdr-file-error')
    const real = { ...ctx, root }
    expect(renderMetaTags('doc.md', real)).toContain('<meta name="mdr-file" content="doc.md">')
    expect(renderMetaTags('nope.md', real)).toContain('<meta name="mdr-file-error" content="FILE_NOT_FOUND">')
  })

  it('the served page carries mdr-test-hooks under test hooks and Cache-Control: no-store', async () => {
    const r = await fetch(`${origin()}/?file=doc.md`)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const html = await r.text()
    expect(html).toContain('<meta name="mdr-test-hooks" content="1">')
    const health = (await (await fetch(`${origin()}/api/health`)).json()) as { schemaFingerprint: string }
    expect(html).toContain(`<meta name="mdr-fingerprint" content="${health.schemaFingerprint}">`)
  })

  it('/__dev/meta is not mounted without MDR_DEV_ORIGIN=1', async () => {
    expect((await fetch(`${origin()}/__dev/meta?file=doc.md`)).status).toBe(404)
  })

  it('/__dev/meta under MDR_DEV_ORIGIN=1 returns exactly the block injected into index.html', async () => {
    const prev = process.env.MDR_DEV_ORIGIN
    process.env.MDR_DEV_ORIGIN = '1'
    const p2 = await freePort()
    const dev = await startServer({ root, port: p2 })
    try {
      const frag = await fetch(`http://127.0.0.1:${p2}/__dev/meta?file=doc.md`)
      expect(frag.status).toBe(200)
      expect(frag.headers.get('cache-control')).toBe('no-store')
      const block = await frag.text()
      const page = await (await fetch(`http://127.0.0.1:${p2}/?file=doc.md`)).text()
      expect(page).toContain(block)
      expect(block).toContain('<meta name="mdr-file" content="doc.md">')
      expect(block).not.toContain('mdr-test-hooks')
    } finally {
      await dev.close('stop')
      if (prev === undefined) delete process.env.MDR_DEV_ORIGIN
      else process.env.MDR_DEV_ORIGIN = prev
    }
  })
})

describe('marker (§3.7, §9.2.1)', () => {
  it('a fresh root gets .review/.gitignore before server.json, and server.json is 0600', async () => {
    const fresh = realId(mkdtempSync(join(tmpdir(), 'mdr-fresh-')))
    writeFileSync(join(fresh, 'a.md'), '# A\n')
    const srv = await startServer({ root: fresh, port: await freePort() })
    try {
      const gi = statSync(join(fresh, '.review', '.gitignore'))
      const marker = statSync(join(fresh, '.review', 'server.json'))
      expect(gi.birthtimeMs).toBeLessThanOrEqual(marker.birthtimeMs)
      expect(marker.mode & 0o777).toBe(0o600)
    } finally {
      await srv.close('stop')
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})

describe('read routes', () => {
  it('GET /api/review: presence and activity overlaid by withHandoff (the day-0 handoff stub values)', async () => {
    const { status, body } = await json(await webGet('/api/review?file=doc.md'))
    expect(status).toBe(200)
    expect(S.ReviewStateSchema.safeParse(body).error?.issues ?? []).toEqual([])
    expect(body).toMatchObject({ file: 'doc.md', rev: 1, seq: 2, presence: { waiter: 'none' }, activity: { file: 'doc.md', state: 'idle' } })
  })

  it('a corrupt sidecar: /api/review is 200 with readOnly and the valid prefix; /api/doc carries readOnly too', async () => {
    const r = await json(await webGet('/api/review?file=corrupt.md'))
    expect(r.status).toBe(200)
    expect(S.ReviewStateSchema.safeParse(r.body).success).toBe(true)
    expect(r.body).toMatchObject({ readOnly: { code: 'SIDECAR_CORRUPT' }, seq: 1 })
    const d = await json(await webGet('/api/doc?file=corrupt.md'))
    expect(d.body).toMatchObject({ readOnly: { code: 'SIDECAR_CORRUPT' } })
    const p = await json(await agentGet('/api/agent/pending?file=corrupt.md'))
    expect([p.status, code(p.body)]).toEqual([ERROR_TABLE.SIDECAR_CORRUPT.http, 'SIDECAR_CORRUPT'])
  })

  it('a recorded doc whose file is gone → 410 DOC_GONE on every read; an unknown one → 404', async () => {
    for (const path of ['/api/doc?file=gone.md', '/api/review?file=gone.md']) {
      const r = await json(await webGet(path))
      expect([r.status, code(r.body)], path).toEqual([410, 'DOC_GONE'])
    }
    const st = await json(await agentGet('/api/agent/status?file=gone.md'))
    expect([st.status, code(st.body)]).toEqual([410, 'DOC_GONE'])
    expect(code((await json(await webGet('/api/doc?file=never.md'))).body)).toBe('FILE_NOT_FOUND')
  })

  it('GET /api/agent/status: the store fields plus server, presence and activity', async () => {
    const { body } = await json(await agentGet('/api/agent/status?file=doc.md'))
    expect(S.StatusResultSchema.safeParse(body).error?.issues ?? []).toEqual([])
    expect(body).toMatchObject({ via: 'server', server: { state: 'up', port, url: `http://127.0.0.1:${port}/`, protocol: PROTOCOL }, presence: { waiter: 'none' }, threads: { open: 1 } })
  })

  it('agent snapshot / thread: query validation and block slicing', async () => {
    const snap = await json(await agentGet('/api/agent/snapshot?file=doc.md&md=1&from=b2&to=b2'))
    expect(snap.body).toMatchObject({ blocks: [{ ref: 'b2', md: 'First paragraph.' }] })
    expect(code((await json(await agentGet('/api/agent/snapshot?file=doc.md&from=x'))).body)).toBe('BAD_REQUEST')
    expect(code((await json(await agentGet('/api/agent/snapshot?file=doc.md&md=2'))).body)).toBe('BAD_REQUEST')
    const far = await json(await agentGet('/api/agent/snapshot?file=doc.md&from=b40'))
    expect([far.status, code(far.body)]).toEqual([404, 'BLOCK_NOT_FOUND'])
    const t = await json(await agentGet(`/api/agent/thread?file=doc.md&id=${T1}`))
    expect(S.ThreadDetailSchema.safeParse(t.body).success).toBe(true)
    expect(t.body).toMatchObject({ via: 'server', thread: { id: T1, kind: 'doc', anchor: { state: 'doc' } } })
    expect(code((await json(await agentGet('/api/agent/thread?file=doc.md&id=nope'))).body)).toBe('BAD_REQUEST')
  })

  it('history on both surfaces: list, version, diff; bad refs → BAD_REQUEST, unknown version → VERSION_NOT_FOUND', async () => {
    for (const base of ['/api/history', '/api/agent/history']) {
      const get = base.startsWith('/api/agent') ? agentGet : webGet
      const l = await json(await get(`${base}?file=doc.md&limit=1`))
      expect(S.HistoryListSchema.safeParse(l.body).success, base).toBe(true)
      expect(l.body).toMatchObject({ versions: [{ v: 'v2' }], unsnapshotted: false })
      const v = await json(await get(`${base}/version?file=doc.md&v=v1`))
      expect(v.body).toMatchObject({ meta: { v: 'v1' }, markdown: '# Doc\n\nFirst paragraph.\n' })
      const d = await json(await get(`${base}/diff?file=doc.md&from=v1&to=current`))
      expect(S.HistoryDiffSchema.safeParse(d.body).success, base).toBe(true)
      expect((d.body.blocks as Array<{ op: string; by: string[] }>).filter((b) => b.op !== 'equal')).toEqual([
        { op: 'insert', after: 'Second paragraph.', by: ['TJ'], lastBy: 'TJ' },
      ])
      expect(code((await json(await get(`${base}/version?file=doc.md&v=x`))).body)).toBe('BAD_REQUEST')
      expect(code((await json(await get(`${base}/version?file=doc.md&v=v9`))).body)).toBe('VERSION_NOT_FOUND')
      expect(code((await json(await get(`${base}/diff?file=doc.md&from=v1&to=yesterday`))).body)).toBe('BAD_REQUEST')
      expect(code((await json(await get(`${base}?file=doc.md&limit=-1`))).body)).toBe('BAD_REQUEST')
    }
  })
})

describe('GET /api/events (§8.6)', () => {
  const cid = `k_${ulid()}`
  const q = (o: Record<string, string>) => new URLSearchParams({ clientId: cid, t: s.marker.token, ...o }).toString()

  it('hello first, id rev.seq, with docId, presence and activity; no resync when the client is current', async () => {
    const { status, events } = await sse(`/api/events?${q({ file: 'doc.md', afterSeq: '2', knownRev: '1' })}`, () => false)
    expect(status).toBe(200)
    expect(events.map((e) => e.event)).toEqual(['hello'])
    expect(S.BrowserSseEventSchema.safeParse(events[0]).success).toBe(true)
    expect(events[0]).toMatchObject({ data: { file: 'doc.md', docId: header.docId, rev: 1, seq: 2, hash: H, protocol: PROTOCOL, presence: { waiter: 'none' } } })
  })

  it('resync after hello when afterSeq is behind or knownRev differs', async () => {
    for (const o of [{ afterSeq: '0' }, { knownRev: '7' }]) {
      const { events } = await sse(`/api/events?${q({ file: 'doc.md', ...o })}`, (e) => e.length >= 2)
      expect(events.map((e) => e.event), JSON.stringify(o)).toEqual(['hello', 'resync'])
      expect(events[1]).toEqual({ event: 'resync', data: { reason: 'gap' } })
    }
  })

  it('the root channel (no file) registers but sends no hello', async () => {
    const { status, events } = await sse(`/api/events?${q({})}`, () => false)
    expect(status).toBe(200)
    expect(events).toEqual([])
  })

  it('an invalid file → the error envelope, not a stream', async () => {
    const r = await fetch(`${origin()}/api/events?${q({ file: 'nope.md' })}`)
    expect(r.status).toBe(404)
    expect(code((await r.json()) as Record<string, unknown>)).toBe('FILE_NOT_FOUND')
  })

  it('a recorded doc whose file is gone → a stream that says doc-removed instead of hello (an EventSource never retries a 410)', async () => {
    const { status, events } = await sse(`/api/events?${q({ file: 'gone.md' })}`, (e) => e.length >= 1)
    expect(status).toBe(200)
    expect(events).toEqual([{ event: 'doc-removed', data: { file: 'gone.md' } }])
  })
})

describe('external changes reach the reads (stat-revalidated caches)', () => {
  it('a doc rewritten on disk: /api/doc serves the new bytes and hash on the next request', async () => {
    mkdirSync(join(root, 'ext'), { recursive: true })
    writeFileSync(join(root, 'ext', 'x.md'), '# One\n')
    const a = await json(await webGet('/api/doc?file=ext/x.md'))
    expect(a.body).toMatchObject({ markdown: '# One\n' })
    writeFileSync(join(root, 'ext', 'x.md'), '# Two, longer\n')
    const b = await json(await webGet('/api/doc?file=ext/x.md'))
    expect(b.body).toMatchObject({ markdown: '# Two, longer\n', hash: docHash('# Two, longer\n', false) })
    unlinkSync(join(root, 'ext', 'x.md'))
    expect(code((await json(await webGet('/api/doc?file=ext/x.md'))).body)).toBe('FILE_NOT_FOUND')
  })
})
