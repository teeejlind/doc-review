// tests/unit/server/t2-asset.test.ts (T2 editor-ux, Pass 4 #28): GET /api/asset, the images a markdown file points at.
//
// validateAsset is the guard: relative to the document's own folder, inside the served root and no further, no
// absolute path, no traversal, no hidden folder, no symlink out of the root or into a protected folder, images only by
// extension (on the path and on where it really lands). The route around it sends the bytes with our Content-Type, takes
// its token in ?t= because an <img> can't send headers, and sends nothing without it.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { realId } from '../../../node/root'
import { ASSET_TYPES, validateAsset } from '../../../server/security'
import { startSrv, type Srv } from './server-kit'

// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

let outside: string
let root: string
const made: string[] = []

beforeAll(() => {
  outside = realId(mkdtempSync(join(tmpdir(), 'mdr-asset-outside-')))
  root = realId(mkdtempSync(join(tmpdir(), 'mdr-asset-root-')))
  made.push(outside, root)
  const put = (rel: string, content: string | Buffer, base = root): void => {
    mkdirSync(join(base, rel, '..'), { recursive: true })
    writeFileSync(join(base, rel), content)
  }
  put('top.md', '# Top\n')
  put('notes/doc.md', '# Doc\n')
  put('notes/pic.png', PNG)
  put('notes/PHOTO.JPG', PNG)
  put('notes/images/deep.png', PNG)
  put('shared/up.png', PNG)
  put('notes/not-an-image.txt', 'secret text')
  put('notes/.hidden/x.png', PNG)
  put('.git/objects/x.png', PNG)
  put('secret.png', PNG, outside)
  put('secret.txt', 'outside text', outside)
  mkdirSync(join(root, 'notes/dir.png'))
  symlinkSync(join(outside, 'secret.png'), join(root, 'notes/escape.png'))
  symlinkSync(join(root, 'notes/not-an-image.txt'), join(root, 'notes/disguised.png'))
  symlinkSync(join(root, 'shared/up.png'), join(root, 'notes/alias.png'))
})

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const check = (doc: string, rel: string | null | undefined) => validateAsset(root, doc, rel)
const refused = (doc: string, rel: string | null | undefined) => {
  const r = check(doc, rel)
  if (r.ok) throw new Error(`expected a refusal for ${JSON.stringify(rel)}, got ${r.abs}`)
  return r.code
}

describe('validateAsset: what is served', () => {
  it('a path beside the document, below it, and above it but inside the root', () => {
    for (const [doc, rel, want] of [
      ['notes/doc.md', 'pic.png', 'notes/pic.png'],
      ['notes/doc.md', './pic.png', 'notes/pic.png'],
      ['notes/doc.md', 'images/deep.png', 'notes/images/deep.png'],
      ['notes/doc.md', './images/../pic.png', 'notes/pic.png'],
      ['notes/doc.md', '../shared/up.png', 'shared/up.png'],
      ['top.md', 'notes/pic.png', 'notes/pic.png'],
      ['notes/doc.md', 'alias.png', 'shared/up.png'],
    ] as const) {
      const r = check(doc, rel)
      expect(r.ok, `${doc} + ${rel}`).toBe(true)
      if (r.ok) {
        expect(r.abs).toBe(join(root, want))
        expect(r.type).toBe('image/png')
      }
    }
  })

  it('the extension is read case-insensitively and the type is ours', () => {
    const r = check('notes/doc.md', 'PHOTO.JPG')
    expect(r.ok && r.type).toBe('image/jpeg')
    expect(Object.values(ASSET_TYPES).every((t) => t.startsWith('image/'))).toBe(true)
  })
})

describe('validateAsset: what is refused', () => {
  it('leaving the root', () => {
    expect(refused('notes/doc.md', '../../secret.png')).toBe('PATH_OUTSIDE_ROOT')
    expect(refused('notes/doc.md', '../../../../../../etc/hosts.png')).toBe('PATH_OUTSIDE_ROOT')
    expect(refused('top.md', '../secret.png')).toBe('PATH_OUTSIDE_ROOT')
    expect(refused('notes/doc.md', 'images/../../../x.png')).toBe('PATH_OUTSIDE_ROOT')
  })

  it('an absolute path, a drive letter, a backslash, a NUL', () => {
    expect(refused('notes/doc.md', '/etc/hosts.png')).toBe('PATH_OUTSIDE_ROOT')
    expect(refused('notes/doc.md', join(root, 'notes/pic.png'))).toBe('PATH_OUTSIDE_ROOT')
    expect(refused('notes/doc.md', 'C:/x.png')).toBe('PATH_OUTSIDE_ROOT')
    expect(refused('notes/doc.md', 'images\\deep.png')).toBe('PATH_OUTSIDE_ROOT')
    expect(refused('notes/doc.md', 'pic.png\0.txt')).toBe('PATH_OUTSIDE_ROOT')
  })

  it('anything that is not an image, by extension, on the path and on where a link really lands', () => {
    expect(refused('notes/doc.md', 'not-an-image.txt')).toBe('BAD_REQUEST')
    expect(refused('notes/doc.md', 'doc.md')).toBe('BAD_REQUEST')
    expect(refused('notes/doc.md', 'pic')).toBe('BAD_REQUEST')
    expect(refused('notes/doc.md', 'disguised.png')).toBe('BAD_REQUEST')
  })

  it('a link that leads out of the root', () => {
    expect(refused('notes/doc.md', 'escape.png')).toBe('PATH_OUTSIDE_ROOT')
  })

  it('hidden folders (.git, .review, a dot-folder of its own)', () => {
    expect(refused('notes/doc.md', '.hidden/x.png')).toBe('PATH_OUTSIDE_ROOT')
    expect(refused('notes/doc.md', '../.git/objects/x.png')).toBe('PATH_OUTSIDE_ROOT')
  })

  it('missing, a folder named like an image, no path at all', () => {
    expect(refused('notes/doc.md', 'nope.png')).toBe('FILE_NOT_FOUND')
    expect(refused('notes/doc.md', 'dir.png')).toBe('FILE_NOT_FOUND')
    expect(refused('notes/doc.md', '')).toBe('BAD_REQUEST')
    expect(refused('notes/doc.md', null)).toBe('BAD_REQUEST')
    expect(refused('notes/doc.md', undefined)).toBe('BAD_REQUEST')
  })

  it('a protected folder: the root guard still applies', () => {
    const prev = process.env.MDR_PROTECTED_SEGMENTS
    process.env.MDR_PROTECTED_SEGMENTS = 'images'
    try {
      expect(refused('notes/doc.md', 'images/deep.png')).toBe('PROTECTED_ROOT')
      expect(refused('notes/doc.md', 'pic.png')).toBe('PROTECTED_ROOT')
    } finally {
      if (prev === undefined) delete process.env.MDR_PROTECTED_SEGMENTS
      else process.env.MDR_PROTECTED_SEGMENTS = prev
    }
  })
})

describe('GET /api/asset over HTTP', () => {
  let srv: Srv | null = null
  afterEach(async () => {
    await srv?.close()
    srv = null
  })

  const start = async (): Promise<Srv> =>
    (srv = await startSrv({ files: { 'notes/doc.md': '# Doc\n\n![a](./pic.png)\n', 'notes/pic.png': PNG, 'notes/note.txt': 'text', 'top.md': '# Top\n' } }))
  const url = (s: Srv, q: Record<string, string>, token: string | null = s.token): string => {
    const p = new URLSearchParams(q)
    if (token !== null) p.set('t', token)
    return `${s.origin}/api/asset?${p.toString()}`
  }

  it('sends the image with our type, nosniff and a CSP that sandboxes it; the token rides ?t= and no client headers are needed', async () => {
    const s = await start()
    const r = await fetch(url(s, { file: 'notes/doc.md', path: './pic.png' }))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toContain('sandbox')
    expect(r.headers.get('x-mdr-root-hash')).toBeTruthy()
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('without the token, or with a wrong one: 401, and no bytes', async () => {
    const s = await start()
    for (const token of [null, 'wrong']) {
      const r = await fetch(url(s, { file: 'notes/doc.md', path: './pic.png' }, token))
      expect(r.status).toBe(401)
      expect(r.headers.get('content-type')).toContain('json')
    }
  })

  it('a cross-origin page is refused even with a token; a foreign Host is misdirected', async () => {
    const s = await start()
    const r = await fetch(url(s, { file: 'notes/doc.md', path: './pic.png' }), { headers: { Origin: 'http://evil.example' } })
    expect(r.status).toBe(403)
    // (fetch won't override Host, so ask the app directly)
    const h = await s.app.app.fetch(new Request(url(s, { file: 'notes/doc.md', path: './pic.png' }).replace(s.origin, 'http://evil.example')))
    expect(h.status).toBe(421)
  })

  it('traversal, a non-image, a missing file and a bad document are plain errors', async () => {
    const s = await start()
    const get = async (q: Record<string, string>): Promise<{ status: number; code: string }> => {
      const r = await fetch(url(s, q))
      const body = (await r.json()) as { error: { code: string } }
      return { status: r.status, code: body.error.code }
    }
    expect(await get({ file: 'notes/doc.md', path: '../../../../etc/hosts.png' })).toEqual({ status: 403, code: 'PATH_OUTSIDE_ROOT' })
    expect(await get({ file: 'notes/doc.md', path: '/etc/hosts.png' })).toEqual({ status: 403, code: 'PATH_OUTSIDE_ROOT' })
    expect(await get({ file: 'notes/doc.md', path: 'note.txt' })).toEqual({ status: 400, code: 'BAD_REQUEST' })
    expect(await get({ file: 'notes/doc.md', path: 'gone.png' })).toEqual({ status: 404, code: 'FILE_NOT_FOUND' })
    expect(await get({ file: 'notes/doc.md' })).toEqual({ status: 400, code: 'BAD_REQUEST' })
    expect(await get({ file: 'notes/pic.png', path: 'pic.png' })).toEqual({ status: 400, code: 'BAD_REQUEST' })
    expect(await get({ file: '../doc.md', path: 'pic.png' })).toEqual({ status: 403, code: 'PATH_OUTSIDE_ROOT' })
    expect(await get({ path: 'pic.png' })).toEqual({ status: 400, code: 'BAD_REQUEST' })
  })

  it('it is read-only: a POST is not a route', async () => {
    const s = await start()
    const r = await s.web('POST', '/api/asset?file=notes/doc.md&path=pic.png', {})
    expect(r.status).toBe(404)
  })
})
