// tests/unit/server/reveal-route.test.ts (onboarding): POST /api/reveal, the file strip's Reveal in Finder.
//
// The route takes only a served document: POSIX-relative, inside the root, .md/.markdown, existing. `../` paths,
// absolute paths, other file types and missing files are refused before anything runs. It is a browser write: token,
// Origin and X-MDR-Client-Id required, the agent surface can't reach it. Under test hooks it records instead of
// spawning (GET /__test/reveals), so this suite never opens a Finder window. revealCommand spells each platform's command.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { revealCommand } from '../../../server/routes/reveal'
import { startSrv, type Srv } from './server-kit'

let srv: Srv
beforeAll(async () => {
  srv = await startSrv({ files: { 'top.md': '# Top\n', 'notes/doc.md': '# Doc\n', 'notes/data.txt': 'text', 'notes/pic.png': 'x' } })
})
afterAll(async () => {
  await srv.close()
})

type Reveals = { ok: true; reveals: Array<{ file: string; abs: string }> }
const reveals = async (): Promise<Reveals['reveals']> => (await srv.web<Reveals>('GET', '/__test/reveals')).json.reveals
const codeOf = (json: unknown): string | undefined => (json as { error?: { code?: string } }).error?.code

describe('POST /api/reveal', () => {
  it('reveals a served document and records it (no spawn under test hooks)', async () => {
    const before = (await reveals()).length
    const r = await srv.web<{ ok: boolean; file: string }>('POST', '/api/reveal', { file: 'notes/doc.md' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, file: 'notes/doc.md' })
    const list = await reveals()
    expect(list).toHaveLength(before + 1)
    expect(list.at(-1)).toMatchObject({ file: 'notes/doc.md', abs: srv.path('notes/doc.md') })
  })

  it('refuses ../ paths, absolute paths and backslashes', async () => {
    const before = (await reveals()).length
    for (const file of ['../top.md', 'notes/../../x.md', '../../etc/passwd.md', srv.path('top.md'), '/etc/hosts.md', 'notes\\doc.md']) {
      const r = await srv.web('POST', '/api/reveal', { file })
      expect(r.status, file).toBeGreaterThanOrEqual(400)
      expect(['PATH_OUTSIDE_ROOT', 'BAD_REQUEST'], file).toContain(codeOf(r.json))
    }
    expect(await reveals()).toHaveLength(before)
  })

  it('refuses files that are not markdown, and markdown that does not exist', async () => {
    const before = (await reveals()).length
    for (const file of ['notes/data.txt', 'notes/pic.png', 'notes']) {
      const r = await srv.web('POST', '/api/reveal', { file })
      expect(r.status, file).toBe(400)
      expect(codeOf(r.json), file).toBe('BAD_REQUEST')
    }
    const missing = await srv.web('POST', '/api/reveal', { file: 'nope.md' })
    expect(missing.status).toBe(404)
    expect(codeOf(missing.json)).toBe('FILE_NOT_FOUND')
    expect(await reveals()).toHaveLength(before)
  })

  it('refuses a missing or non-string file', async () => {
    for (const body of [{}, { file: 42 }, { file: null }]) {
      const r = await srv.web('POST', '/api/reveal', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('keeps the browser-write security model: token, Origin and the agent surface', async () => {
    const noToken = await srv.web('POST', '/api/reveal', { file: 'top.md' }, { headers: { Authorization: 'Bearer wrong' } })
    expect(noToken.status).toBe(401)
    const badOrigin = await srv.web('POST', '/api/reveal', { file: 'top.md' }, { headers: { Origin: 'http://evil.example' } })
    expect(badOrigin.status).toBe(403)
    const agent = await srv.agent('POST', '/api/agent/reveal', { file: 'top.md' })
    expect(agent.status).toBe(404)
  })
})

describe('revealCommand', () => {
  it('spells the command per platform, with no shell', () => {
    expect(revealCommand('darwin', '/Users/a/b c/doc.md')).toEqual({ cmd: 'open', args: ['-R', '/Users/a/b c/doc.md'] })
    expect(revealCommand('win32', 'C:\\Users\\a\\b c\\doc.md')).toEqual({ cmd: 'explorer.exe', args: ['/select,"C:\\Users\\a\\b c\\doc.md"'], verbatim: true })
    expect(revealCommand('linux', '/home/a/notes/doc.md')).toEqual({ cmd: 'xdg-open', args: ['/home/a/notes'] })
  })
})
