// tests/unit/server/day0-server.test.ts (integrator, day 0; P1 owns it from M0).
//
// The day-0 startServer (§9.2.1): .review/.gitignore before server.json, /api/health, the §8.1 middleware, the SPA
// with meta injection (§12.0.2), PORT_EXHAUSTED on a busy port, token reuse across restarts, marker cleanup on close.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realId, rootHashOf } from '../../../node/root'
import { startServer } from '../../../server/index'
import type { RunningServer } from '../../../shared/types'

function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => done(port))
    })
  })
}

function raw(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}):
  Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: o.headers ?? {} }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', fail)
    if (o.body !== undefined) req.write(o.body)
    req.end()
  })
}

let root: string
let web: string
let port: number
let s: RunningServer
const prevWeb = process.env.MDR_WEB_DIR

beforeAll(async () => {
  root = realId(mkdtempSync(join(tmpdir(), 'mdr-srv-')))
  writeFileSync(join(root, 'doc.md'), '# Doc\n\nBody.\n')
  web = realId(mkdtempSync(join(tmpdir(), 'mdr-web-')))
  mkdirSync(join(web, 'assets'))
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><!--mdr:meta--></head><body><div id="mdr-app"></div></body></html>')
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)\n')
  process.env.MDR_WEB_DIR = web
  port = await freePort()
  s = await startServer({ root, port })
})
afterAll(async () => {
  await s?.close('stop')
  if (prevWeb === undefined) delete process.env.MDR_WEB_DIR
  else process.env.MDR_WEB_DIR = prevWeb
  rmSync(root, { recursive: true, force: true })
  rmSync(web, { recursive: true, force: true })
})

describe('startServer (day 0)', () => {
  it('writes .review/.gitignore and a 0600 marker', () => {
    expect(readFileSync(join(root, '.review', '.gitignore'), 'utf8')).toBe('*\n')
    const mpath = join(root, '.review', 'server.json')
    expect(statSync(mpath).mode & 0o777).toBe(0o600)
    const m = JSON.parse(readFileSync(mpath, 'utf8'))
    expect(m).toMatchObject({ app: 'mdr', root, port, pid: process.pid, serverId: s.serverId, protocol: 2 })
    expect(m.token).toMatch(/^[0-9a-f]{64}$/)
    expect(s.url).toBe(`http://127.0.0.1:${port}/`)
  })

  it('answers /api/health without credentials and stamps X-MDR-Root-Hash', async () => {
    const r = await raw(port, '/api/health')
    expect(r.status).toBe(200)
    expect(r.headers['x-mdr-root-hash']).toBe(rootHashOf(root))
    const h = JSON.parse(r.body)
    expect(h).toMatchObject({ ok: true, app: 'mdr', root, rootHash: rootHashOf(root), port, pid: process.pid, protocol: 2 })
    expect(h.schemaFingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('applies the §8.1 chain: Host, agent headers, protocol, origin', async () => {
    const token = s.marker.token
    expect((await raw(port, '/api/health', { headers: { Host: 'evil.example:80' } })).status).toBe(421)
    expect((await raw(port, '/api/agent/batch?file=doc.md', { method: 'POST' })).status).toBe(401)
    const agent = { 'X-MDR-Client': 'cli', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const proto = await raw(port, '/api/agent/batch?file=doc.md', { method: 'POST', headers: { ...agent, 'X-MDR-Protocol': '1' }, body: '{}' })
    expect(proto.status).toBe(426)
    expect(JSON.parse(proto.body).error.code).toBe('PROTOCOL_MISMATCH')
    const withOrigin = await raw(port, '/api/agent/batch?file=doc.md', { method: 'POST', headers: { ...agent, 'X-MDR-Protocol': '2', Origin: `http://127.0.0.1:${port}` }, body: '{}' })
    expect(withOrigin.status).toBe(403)
    // mounted since M2: an empty batch is a noop BatchResult
    const empty = await raw(port, '/api/agent/batch?file=doc.md', { method: 'POST', headers: { ...agent, 'X-MDR-Protocol': '2' }, body: '{"ops":[]}' })
    expect(empty.status).toBe(200)
    expect(JSON.parse(empty.body)).toMatchObject({ ok: true, via: 'server', file: 'doc.md', noop: true })
    expect(empty.headers['x-mdr-root-hash']).toBe(rootHashOf(root))
    const unknown = await raw(port, '/api/agent/nope?file=doc.md', { method: 'POST', headers: { ...agent, 'X-MDR-Protocol': '2' }, body: '{}' })
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body).ok).toBe(false)
    expect(unknown.headers['x-mdr-root-hash']).toBe(rootHashOf(root))
    const identity = await raw(port, '/api/agent/batch?file=doc.md', { method: 'POST', headers: { ...agent, 'X-MDR-Protocol': '2' }, body: '{"by":"TJ"}' })
    expect(JSON.parse(identity.body).error.code).toBe('IDENTITY_IN_BODY')
    const web = { 'X-MDR-Client': 'web', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const noOrigin = await raw(port, '/api/handoff?file=doc.md', { method: 'POST', headers: web, body: '{}' })
    expect(JSON.parse(noOrigin.body).error.code).toBe('FORBIDDEN_ORIGIN')
    const noClientId = await raw(port, '/api/handoff?file=doc.md', { method: 'POST', headers: { ...web, Origin: `http://localhost:${port}` }, body: '{}' })
    expect(JSON.parse(noClientId.body).error.code).toBe('BAD_REQUEST')
    const badToken = await raw(port, '/api/handoff?file=doc.md', { method: 'POST', headers: { ...web, Authorization: 'Bearer nope' }, body: '{}' })
    expect(badToken.status).toBe(401)
  })

  it('serves index.html with the meta tags injected and no-store', async () => {
    const ok = await raw(port, '/?file=doc.md')
    expect(ok.status).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    expect(ok.body).toContain(`<meta name="mdr-token" content="${s.marker.token}">`)
    expect(ok.body).toContain('<meta name="mdr-file" content="doc.md">')
    expect(ok.body).toContain(`<meta name="mdr-port" content="${port}">`)
    expect(ok.body).not.toContain('mdr-file-error')
    expect(ok.body).not.toContain('mdr-test-hooks')
    expect(ok.body).not.toContain('<!--mdr:meta-->')
    const missing = await raw(port, '/?file=nope.md')
    expect(missing.status).toBe(200)
    expect(missing.body).toContain('<meta name="mdr-file" content="">')
    expect(missing.body).toContain('<meta name="mdr-file-error" content="FILE_NOT_FOUND">')
    expect((await raw(port, '/?file=../x.md')).body).toContain('content="PATH_OUTSIDE_ROOT"')
    expect((await raw(port, '/?file=notes.txt')).body).toContain('content="BAD_REQUEST"')
    const asset = await raw(port, '/assets/app.js')
    expect(asset.status).toBe(200)
    expect(asset.headers['content-type']).toContain('text/javascript')
    expect((await raw(port, '/assets/../index.html')).status).not.toBe(500)
  })

  it('refuses a busy port with PORT_EXHAUSTED', async () => {
    await expect(startServer({ root, port })).rejects.toMatchObject({ code: 'PORT_EXHAUSTED' })
  })

  it('keeps the marker (and so the token) across a restart, and removes only its own marker on stop', async () => {
    const token = s.marker.token
    await s.close('restart')
    expect(existsSync(join(root, '.review', 'server.json'))).toBe(true)
    s = await startServer({ root, port: await freePort(), testHooks: true })
    expect(s.marker.token).toBe(token)
    const page = await raw(s.port, '/')
    expect(page.body).toContain('<meta name="mdr-test-hooks" content="1">')
    const first = s
    s = await startServer({ root, port: await freePort() })
    expect(s.marker.token).toBe(token)
    await first.close('stop')
    expect(existsSync(join(root, '.review', 'server.json'))).toBe(true)
    await s.close('stop')
    expect(existsSync(join(root, '.review', 'server.json'))).toBe(false)
    s = await startServer({ root, port: await freePort() })
  })
})
