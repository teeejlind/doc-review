// tests/unit/web/session/transport.test.ts (P2). The default transport (CONTRACTS §12.0.5, §8.1, D32, D43) and
// readBootstrap (§12.0.2): origin-relative URLs only, X-MDR-Client + Authorization on every request and
// X-MDR-Client-Id on non-GET, non-2xx answers resolved, network errors rejected; a session opened WITHOUT a transport
// builds only origin-relative URLs.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientId, DocSnapshot } from '../../../../shared/types'
import { readBootstrap } from '../../../../web/src/session/bootstrap'
import { assertOriginRelative, createDefaultTransport } from '../../../../web/src/session/transport'
import { openSession } from '../../../../web/src/session/session'
import { memoryDraftStore } from '../../../../web/src/session/drafts'
import { fixture, type Fixture } from './helpers'

const CID = 'k_01JAB3K9Q2T7V5X8Y0Z1W2E3R4' as ClientId

interface Call { url: string; init: RequestInit }
function fakeFetch(answer: (c: Call) => Response | Promise<Response>): { calls: Call[]; fetch: (u: string, i: RequestInit) => Promise<Response> } {
  const calls: Call[] = []
  return { calls, fetch: async (url, init) => { const c = { url, init }; calls.push(c); return answer(c) } }
}

class FakeES {
  static last: FakeES | null = null
  readonly listeners = new Map<string, (e: MessageEvent) => void>()
  onerror: ((e: Event) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeES.last = this
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    this.listeners.set(type, cb)
  }
  close(): void {
    this.closed = true
  }
}

const noScheme = (u: string): void => {
  expect(u.startsWith('/'), u).toBe(true)
  expect(u.startsWith('//'), u).toBe(false)
  expect(u).not.toMatch(/^[a-z][a-z0-9+.-]*:/i)
}

describe('createDefaultTransport (§12.0.5)', () => {
  it('GET: origin-relative path, X-MDR-Client: web + Authorization, no client id, JSON parsed', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ ok: true, x: 1 }), { status: 200 }))
    const t = createDefaultTransport({ token: 'tok', clientId: CID, fetch: f.fetch })
    const r = await t.request('GET', '/api/doc?file=a.md')
    expect(r).toEqual({ status: 200, json: { ok: true, x: 1 } })
    noScheme(f.calls[0]!.url)
    expect(f.calls[0]!.url).toBe('/api/doc?file=a.md')
    const h = f.calls[0]!.init.headers as Record<string, string>
    expect(h['X-MDR-Client']).toBe('web')
    expect(h.Authorization).toBe('Bearer tok')
    expect(h['X-MDR-Client-Id']).toBeUndefined()
    expect(f.calls[0]!.init.body).toBeUndefined()
    expect(t.clientId).toBe(CID)
  })

  it('POST/PATCH: X-MDR-Client-Id and a JSON body; keepalive passes through', async () => {
    const f = fakeFetch(() => new Response('{"ok":true}', { status: 200 }))
    const t = createDefaultTransport({ token: 'tok', clientId: CID, fetch: f.fetch })
    await t.request('POST', '/api/save?file=a.md', { a: 1 }, { keepalive: true })
    await t.request('PATCH', '/api/comments/c_1?file=a.md', { b: 2 })
    const [post, patch] = f.calls
    expect((post!.init.headers as Record<string, string>)['X-MDR-Client-Id']).toBe(CID)
    expect(post!.init.body).toBe('{"a":1}')
    expect(post!.init.keepalive).toBe(true)
    expect(post!.init.method).toBe('POST')
    expect((patch!.init.headers as Record<string, string>)['X-MDR-Client-Id']).toBe(CID)
    expect(patch!.init.keepalive).toBeUndefined()
  })

  it('a non-2xx answer resolves { status, json }; a fetch rejection rejects', async () => {
    const f = fakeFetch(() => new Response('{"ok":false,"error":{"code":"FILE_NOT_FOUND","message":"x"}}', { status: 404 }))
    const t = createDefaultTransport({ token: 'tok', clientId: CID, fetch: f.fetch })
    expect(await t.request('GET', '/api/doc?file=n.md')).toEqual({ status: 404, json: { ok: false, error: { code: 'FILE_NOT_FOUND', message: 'x' } } })
    const down = createDefaultTransport({ token: 'tok', clientId: CID, fetch: async () => { throw new TypeError('Failed to fetch') } })
    await expect(down.request('GET', '/api/doc?file=a.md')).rejects.toThrow('Failed to fetch')
  })

  it('refuses absolute, scheme and protocol-relative paths', async () => {
    const t = createDefaultTransport({ token: 'tok', clientId: CID, fetch: async () => new Response('{}') })
    for (const p of ['http://127.0.0.1:8300/api/doc', '//localhost:8300/api/doc', 'api/doc', 'https://x/y']) {
      await expect(t.request('GET', p)).rejects.toThrow(/origin-relative/)
      expect(() => t.events(p)).toThrow(/origin-relative/)
    }
    expect(() => assertOriginRelative('/api/events?file=a.md')).not.toThrow()
  })

  it('events(): EventSource on the origin-relative path; listeners get { data, lastEventId }; onerror and close wire through', () => {
    const t = createDefaultTransport({ token: 'tok', clientId: CID, EventSource: FakeES as unknown as never })
    const es = t.events('/api/events?file=a.md&clientId=k_x&t=tok')
    const fake = FakeES.last!
    expect(fake.url).toBe('/api/events?file=a.md&clientId=k_x&t=tok')
    const got: Array<{ data: string; lastEventId: string }> = []
    es.addEventListener('hello', (e) => got.push(e))
    fake.listeners.get('hello')!({ data: '{"a":1}', lastEventId: '3.4' } as MessageEvent)
    expect(got).toEqual([{ data: '{"a":1}', lastEventId: '3.4' }])
    let errs = 0
    es.onerror = () => void errs++
    fake.onerror?.(new Event('error'))
    expect(errs).toBe(1)
    es.close()
    expect(fake.closed).toBe(true)
  })
})

describe('a session without a transport uses origin-relative URLs only (D43, §13 #77)', () => {
  let fx: Fixture | null = null
  afterEach(async () => {
    vi.unstubAllGlobals()
    await fx?.close()
    fx = null
  })

  it('every fetch and EventSource URL is a path', async () => {
    fx = await fixture({ file: 'doc.md', markdown: '# T\n\nBody.\n' })
    const urls: string[] = []
    const f = fx
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      urls.push(input)
      const headers = { ...(init.headers as Record<string, string>), ...(init.method && init.method !== 'GET' ? { Origin: `http://localhost:${f.fa.port}` } : {}) }
      return f.fa.fetch(new Request(`http://localhost:${f.fa.port}${input}`, { ...init, headers }))
    })
    vi.stubGlobal('EventSource', class extends FakeES {
      constructor(url: string) {
        super(url)
        urls.push(url)
      }
    })
    const s = await openSession({
      boot: fx.boot, file: 'doc.md',
      env: { drafts: memoryDraftStore(), channel: () => null, window: null, document: null, clipboard: () => null, storage: null },
    })
    expect((s.getSnapshot() as DocSnapshot).markdown).toBe('# T\n\nBody.\n')
    await s.createThread({ kind: 'doc' }, 'Through the default transport.')
    await s.setPolicy({ suggestOnly: true })
    await s.close()
    expect(urls.length).toBeGreaterThanOrEqual(5)
    for (const u of urls) noScheme(u)
    expect(urls.some((u) => u.startsWith('/api/events?'))).toBe(true)
  })
})

describe('readBootstrap (§12.0.2)', () => {
  function doc(metas: Record<string, string>): Document {
    const d = document.implementation.createHTMLDocument('t')
    for (const [name, content] of Object.entries(metas)) {
      const m = d.createElement('meta')
      m.setAttribute('name', name)
      m.setAttribute('content', content)
      d.head.append(m)
    }
    return d
  }
  const base = {
    'mdr-token': 'tok', 'mdr-root': '/r', 'mdr-root-hash': 'ab'.repeat(32), 'mdr-port': '8312', 'mdr-version': '2.0.0',
    'mdr-protocol': '2', 'mdr-fingerprint': '0123456789abcdef',
  }

  it('reads every tag', () => {
    expect(readBootstrap(doc({ ...base, 'mdr-file': 'notes/a.md', 'mdr-test-hooks': '1' }))).toEqual({
      token: 'tok', root: '/r', rootHash: 'ab'.repeat(32), port: 8312, file: 'notes/a.md', fileError: null, version: '2.0.0', protocol: 2,
      schemaFingerprint: '0123456789abcdef', testHooks: true,
    })
  })
  it('empty mdr-file → file null; mdr-file-error → that code; no test-hooks tag → false', () => {
    expect(readBootstrap(doc({ ...base, 'mdr-file': '' }))).toMatchObject({ file: null, fileError: null, testHooks: false })
    expect(readBootstrap(doc({ ...base, 'mdr-file': '', 'mdr-file-error': 'PROTECTED_ROOT' }))).toMatchObject({ file: null, fileError: 'PROTECTED_ROOT' })
  })
  it('a missing token or root throws', () => {
    const { 'mdr-token': _t, ...noToken } = base
    const { 'mdr-root': _r, ...noRoot } = base
    expect(() => readBootstrap(doc(noToken))).toThrow(/mdr-token/)
    expect(() => readBootstrap(doc(noRoot))).toThrow(/mdr-root/)
  })
})
