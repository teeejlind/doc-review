// tests/unit/node/root/root.test.ts (P4; CONTRACTS §9.2, §13 rows 18–20, 23–25, D12, D15, D23).
//
// node/root.ts: the port formula's stability across NFC/NFD and case spellings, the three protected-guard clauses
// (including a real walk over the cap failing closed), root resolution, and discovery that skips other roots and
// foreign processes without ever stopping them.
// Generalization pass: the protected segments are configurable (node/config.ts). The (b)/(c) cases run with TJ's set
// in MDR_PROTECTED_SEGMENTS; the default ([]: only `/` and $HOME refused, no walk) and custom sets have their own cases.
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertServable, clearProtectedWalkCache, discover, isInside, portFor, probeHealth, protectedSegmentOf, readMarker, realId, resolveRoot,
  rootHashOf, walkForProtected,
} from '../../../../node/root'
import { ensureReviewDir } from '../../../../node/review-dir'
import { CONSTANTS } from '../../../../shared/constants'
import type { Health } from '../../../../shared/types'
import { SAMPLE_PROTECTED_SEGMENTS } from '../../../helpers/userEnv'

const made: string[] = []
function tmpRoot(dirs: string[] = [], name = 'mdr-root-'): string {
  const r = realId(mkdtempSync(join(tmpdir(), name)))
  made.push(r)
  for (const d of dirs) mkdirSync(join(r, d), { recursive: true })
  writeFileSync(join(r, 'doc.md'), '# Doc\n')
  return r
}
afterAll(() => {
  for (const r of made) rmSync(r, { recursive: true, force: true })
})

const codeOf = (f: () => void): string | null => {
  try {
    f()
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'THREW'
  }
}

describe('realId / portFor (D23, §13 #24)', () => {
  it('is 8300 + sha256(realId(root))[0..4] % 600, stable per root', () => {
    const r = tmpRoot()
    const p = portFor(r)
    expect(p).toBeGreaterThanOrEqual(CONSTANTS.PORT_BASE)
    expect(p).toBeLessThan(CONSTANTS.PORT_BASE + CONSTANTS.PORT_SPAN)
    expect(portFor(r)).toBe(p)
    expect(portFor(r + '/')).toBe(p)
    expect(portFor(join(r, '.', 'x', '..'))).toBe(p)
  })

  it('an NFD spelling of an NFC-named root gives the same id and port, and vice versa', () => {
    const base = tmpRoot()
    const nfc = join(base, 'Café Docs')
    mkdirSync(nfc)
    const nfdSpelling = join(base, 'Café Docs')
    expect(realId(nfdSpelling)).toBe(realId(nfc))
    expect(realId(nfdSpelling)).toBe(realId(nfdSpelling).normalize('NFC'))
    expect(portFor(nfdSpelling)).toBe(portFor(nfc))

    const nfdNamed = join(base, 'Résumé')
    mkdirSync(nfdNamed)
    const nfcSpelling = join(base, 'Résumé')
    expect(realId(nfdNamed)).toBe(realId(nfcSpelling))
    expect(realId(nfdNamed).endsWith('Résumé')).toBe(true)
    expect(portFor(nfdNamed)).toBe(portFor(nfcSpelling))
    expect(rootHashOf(realId(nfdNamed))).toBe(rootHashOf(realId(nfcSpelling)))
  })

  it('a different-case spelling names the same root on a case-insensitive volume', () => {
    const base = tmpRoot()
    const dir = join(base, 'MixedCase')
    mkdirSync(dir)
    const upper = join(base, 'MIXEDCASE')
    if (!existsSync(upper)) return // case-sensitive volume: nothing to normalize
    expect(realId(upper)).toBe(realId(dir))
    expect(realId(upper).endsWith('MixedCase')).toBe(true)
    expect(portFor(upper)).toBe(portFor(dir))
  })
})

describe('assertServable (§9.2 guard, D15)', () => {
  beforeEach(() => {
    process.env.MDR_PROTECTED_SEGMENTS = SAMPLE_PROTECTED_SEGMENTS
    clearProtectedWalkCache()
  })
  afterEach(() => {
    process.env.MDR_PROTECTED_SEGMENTS = ''
    clearProtectedWalkCache()
  })

  it('passes an ordinary root and a file inside it', () => {
    const r = tmpRoot(['docs/sub', 'a/signed', 'a/legal-signed'])
    expect(codeOf(() => assertServable(r))).toBeNull()
    expect(codeOf(() => assertServable(r, join(r, 'doc.md')))).toBeNull()
    expect(codeOf(() => assertServable(r, 'doc.md'))).toBeNull()
  })

  it('(a) refuses / and $HOME', () => {
    expect(codeOf(() => assertServable('/'))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(homedir()))).toBe('PROTECTED_ROOT')
  })

  it('(b) refuses a root or file under, or ending in, a protected segment sequence', () => {
    const r = tmpRoot(['x/legal/signed/deep', 'y/approvals'])
    expect(codeOf(() => assertServable(join(r, 'x/legal/signed/deep')))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(join(r, 'x/legal/signed')))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(join(r, 'y/approvals')))).toBe('PROTECTED_ROOT')
    const ok = tmpRoot()
    mkdirSync(join(ok, '.hidden/registry'), { recursive: true })
    writeFileSync(join(ok, '.hidden/registry/a.md'), 'x\n')
    expect(codeOf(() => assertServable(ok))).toBeNull() // the walk skips dot-dirs …
    expect(codeOf(() => assertServable(ok, join(ok, '.hidden/registry/a.md')))).toBe('PROTECTED_ROOT') // … the per-file check does not
    expect(protectedSegmentOf('/a/legal/filed')).toBe('legal/filed')
    expect(protectedSegmentOf('/a/legal/filed-old/x')).toBeNull()
    expect(protectedSegmentOf('/a/myapprovals/x')).toBeNull()
  })

  it('(c) refuses a root that is a parent of a protected directory, at any depth', () => {
    expect(codeOf(() => assertServable(tmpRoot(['approvals'])))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(tmpRoot(['a/b/registry'])))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(tmpRoot(['legal/signed'])))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(tmpRoot(['a/legal/filed'])))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(tmpRoot(['a/signed', 'b/filed'])))).toBeNull()
    expect(codeOf(() => assertServable(tmpRoot(['node_modules/approvals', '.git/registry', '.review/approvals'])))).toBeNull()
    const ws = tmpRoot(['memory', 'legal/drafts', 'legal/signed'])
    expect(walkForProtected(ws).hit).toBe('legal/signed')
  })

  it('(c) a root named legal holding signed/ is refused (it is the parent of /legal/signed/)', () => {
    const base = tmpRoot()
    const ctx = join(base, 'legal')
    mkdirSync(join(ctx, 'signed'), { recursive: true })
    expect(codeOf(() => assertServable(ctx))).toBe('PROTECTED_ROOT')
  })

  it('the walk over the cap fails closed: a small cap directly, and the real PROTECTED_WALK_MAX_DIRS', () => {
    const r = tmpRoot(['a/b/c/d', 'e/f', 'g'])
    expect(walkForProtected(r, 3)).toMatchObject({ hit: null, overCap: true })
    expect(walkForProtected(r, 100)).toMatchObject({ hit: null, overCap: false })

    const big = tmpRoot([], 'mdr-cap-')
    for (let i = 0; i <= CONSTANTS.PROTECTED_WALK_MAX_DIRS; i++) mkdirSync(join(big, `d${i}`))
    clearProtectedWalkCache()
    const err = (() => {
      try {
        assertServable(big)
        return null
      } catch (e) {
        return e as { code: string; message: string }
      }
    })()
    expect(err?.code).toBe('PROTECTED_ROOT')
    expect(err?.message).toMatch(/more than 20000 directories/)
  }, 30_000)

  it('custom segments: exactly the configured ones are protected, any depth, multi-part sequences included', () => {
    process.env.MDR_PROTECTED_SEGMENTS = ' secrets , legal/signed/ ,, ../x '
    clearProtectedWalkCache()
    expect(codeOf(() => assertServable(tmpRoot(['approvals', 'registry'])))).toBeNull()
    expect(codeOf(() => assertServable(tmpRoot(['a/secrets'])))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(tmpRoot(['legal/signed'])))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(tmpRoot(['signed', 'legal/drafts'])))).toBeNull()
    const r = tmpRoot(['legal/signed/q3'])
    expect(codeOf(() => assertServable(join(r, 'legal/signed/q3')))).toBe('PROTECTED_ROOT')
    expect(protectedSegmentOf('/w/legal/signed/x.md')).toBe('legal/signed')
  })

  it('refuses a file outside the root, and a symlink escaping it (§13 #25)', async () => {
    const r = tmpRoot()
    const other = tmpRoot()
    expect(codeOf(() => assertServable(r, join(other, 'doc.md')))).toBe('PATH_OUTSIDE_ROOT')
    const { symlinkSync } = await import('node:fs')
    symlinkSync(join(other, 'doc.md'), join(r, 'link.md'))
    expect(codeOf(() => assertServable(r, join(r, 'link.md')))).toBe('PATH_OUTSIDE_ROOT')
    expect(isInside(r, join(r, 'a', 'b'))).toBe(true)
    expect(isInside(r, r + '-sibling')).toBe(false)
  })
})

describe('resolveRoot', () => {
  it('prefers --root, else the file\'s directory when no live marker contains it', () => {
    const r = tmpRoot(['sub'])
    writeFileSync(join(r, 'sub', 'a.md'), 'x\n')
    expect(resolveRoot(join(r, 'sub', 'a.md'))).toBe(join(r, 'sub'))
    expect(resolveRoot(join(r, 'sub', 'a.md'), r)).toBe(r)
  })

  it('uses the nearest ancestor holding a live marker for its own root; ignores a dead pid or a copied marker', () => {
    const r = tmpRoot(['sub/deeper'])
    writeFileSync(join(r, 'sub', 'deeper', 'a.md'), 'x\n')
    ensureReviewDir(r)
    const marker = (root: string, pid: number): string => JSON.stringify({
      app: 'mdr', root, rootHash: rootHashOf(root), port: 8301, pid, serverId: 'srv_x', version: '2.0.0-dev',
      protocol: 2, startedAt: '2026-10-15T17:00:00.000Z', token: 'a'.repeat(64),
    })
    writeFileSync(join(r, '.review', 'server.json'), marker(r, process.pid))
    expect(resolveRoot(join(r, 'sub', 'deeper', 'a.md'))).toBe(r)
    writeFileSync(join(r, '.review', 'server.json'), marker(r, 2 ** 22 + 12345))
    expect(resolveRoot(join(r, 'sub', 'deeper', 'a.md'))).toBe(join(r, 'sub', 'deeper'))
    writeFileSync(join(r, '.review', 'server.json'), marker('/somewhere/else', process.pid))
    expect(resolveRoot(join(r, 'sub', 'deeper', 'a.md'))).toBe(join(r, 'sub', 'deeper'))
  })
})

// ------------------------------------------------------------------ discovery

function health(root: string, port: number, pid = 4242): Health {
  return {
    ok: true, app: 'mdr', version: '2.0.0-dev', protocol: 2, schemaFingerprint: '0'.repeat(16), root, rootHash: rootHashOf(root), port,
    pid, serverId: 'srv_test', startedAt: '2026-10-15T17:00:00.000Z',
  }
}

/** An HTTP server on 127.0.0.1:port answering /api/health with `body` (or a non-mdr page when body is null). */
function fakeHttp(port: number, body: Health | null): Promise<Server | null> {
  return new Promise((done) => {
    const s = createServer((req, res) => {
      if (body && req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      } else {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>not mdr</html>')
      }
    })
    s.once('error', () => done(null))
    s.listen(port, '127.0.0.1', () => done(s))
  })
}
const closeAll = (servers: Array<Server | null>): Promise<void> =>
  Promise.all(servers.map((s) => (s ? new Promise<void>((r) => s.close(() => r())) : undefined))).then(() => undefined)

async function stillAnswers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    return r.ok
  } catch {
    return false
  }
}

describe('discover (§9.2, §13 #18–#20)', () => {
  it('reports down with a free port in the root\'s window', async () => {
    const r = tmpRoot()
    const d = await discover(r)
    expect(d.state).toBe('down')
    if (d.state === 'down') {
      expect(d.freePort).not.toBeNull()
      expect(d.freePort!).toBeGreaterThanOrEqual(portFor(r))
      expect(d.freePort!).toBeLessThan(portFor(r) + CONSTANTS.PORT_PROBE)
    }
  })

  it('skips another root\'s server and a foreign process, never stops them, and picks the next free port', async () => {
    const r = tmpRoot()
    const p0 = portFor(r)
    const servers = [await fakeHttp(p0, health('/another/root', p0)), await fakeHttp(p0 + 1, null)]
    try {
      if (servers.some((s) => s === null)) return // the machine already uses one of these ports
      const d = await discover(r)
      expect(d.state).toBe('down')
      if (d.state === 'down') expect(d.freePort).toBeGreaterThanOrEqual(p0 + 2)
      expect(await stillAnswers(p0)).toBe(true)
      expect(await stillAnswers(p0 + 1)).toBe(true)
    } finally {
      await closeAll(servers)
    }
  })

  it('scans all ten ports for a same-root server before choosing a free one', async () => {
    const r = tmpRoot()
    const p0 = portFor(r)
    const servers = [await fakeHttp(p0, health('/another/root', p0)), await fakeHttp(p0 + 5, health(r, p0 + 5))]
    try {
      if (servers.some((s) => s === null)) return
      const d = await discover(r)
      expect(d).toMatchObject({ state: 'up', port: p0 + 5 })
      if (d.state === 'up') {
        expect(d.health.root).toBe(r)
        expect(d.marker.token).toBe('') // no marker on disk: rebuilt from health, token unknown
      }
    } finally {
      await closeAll(servers)
    }
  })

  it('ignores a stale marker (its port answers for another root or another pid) and scans the window', async () => {
    const r = tmpRoot()
    const p0 = portFor(r)
    ensureReviewDir(r)
    const servers = [await fakeHttp(p0 + 2, health('/another/root', p0 + 2)), await fakeHttp(p0 + 3, health(r, p0 + 3, 999))]
    try {
      if (servers.some((s) => s === null)) return
      writeFileSync(join(r, '.review', 'server.json'), JSON.stringify({
        app: 'mdr', root: r, rootHash: rootHashOf(r), port: p0 + 2, pid: 4242, serverId: 'srv_old', version: '2.0.0-dev', protocol: 2,
        startedAt: '2026-10-15T17:00:00.000Z', token: 'b'.repeat(64),
      }))
      const d = await discover(r)
      expect(d).toMatchObject({ state: 'up', port: p0 + 3 })
      if (d.state === 'up') expect(d.marker.pid).toBe(999)
      expect(await stillAnswers(p0 + 2)).toBe(true)
    } finally {
      await closeAll(servers)
    }
  })

  it('the marker fast path is accepted when health matches its root and pid', async () => {
    const r = tmpRoot()
    const port = portFor(r) + 7
    const s = await fakeHttp(port, health(r, port, 777))
    try {
      if (!s) return
      ensureReviewDir(r)
      writeFileSync(join(r, '.review', 'server.json'), JSON.stringify({
        app: 'mdr', root: r, rootHash: rootHashOf(r), port, pid: 777, serverId: 'srv_test', version: '2.0.0-dev', protocol: 2,
        startedAt: '2026-10-15T17:00:00.000Z', token: 'c'.repeat(64),
      }))
      const d = await discover(r)
      expect(d).toMatchObject({ state: 'up', port })
      if (d.state === 'up') expect(d.marker.token).toBe('c'.repeat(64))
    } finally {
      await closeAll([s])
    }
  })

  it('a marker of another protocol, outside the window, is still found (the CLI then answers PROTOCOL_MISMATCH)', async () => {
    const r = tmpRoot()
    const port = portFor(r) + 40 // outside the window: only the marker can find it (`serve --port N`)
    const s = await fakeHttp(port, { ...health(r, port, 778), protocol: 3 as 2 })
    try {
      if (!s) return
      ensureReviewDir(r)
      writeFileSync(join(r, '.review', 'server.json'), JSON.stringify({
        app: 'mdr', root: r, rootHash: rootHashOf(r), port, pid: 778, serverId: 'srv_newer', version: '2.1.0', protocol: 3,
        startedAt: '2026-10-15T17:00:00.000Z', token: 'd'.repeat(64),
      }))
      expect(readMarker(r)).toMatchObject({ protocol: 3, token: 'd'.repeat(64) })
      const d = await discover(r)
      expect(d).toMatchObject({ state: 'up', port, health: { protocol: 3 } })
      // a marker that is malformed otherwise is still rejected
      writeFileSync(join(r, '.review', 'server.json'), JSON.stringify({ app: 'mdr', root: r, port, protocol: 3 }))
      expect(readMarker(r)).toBeNull()
    } finally {
      await closeAll([s])
    }
  })

  it('all ten ports taken → freePort null (the caller reports PORT_EXHAUSTED)', async () => {
    const r = tmpRoot()
    const p0 = portFor(r)
    const servers: Array<Server | null> = []
    try {
      for (let k = 0; k < CONSTANTS.PORT_PROBE; k++) servers.push(await fakeHttp(p0 + k, k % 2 ? null : health('/x' + k, p0 + k)))
      if (servers.some((s) => s === null)) return
      const d = await discover(r)
      expect(d).toEqual({ state: 'down', freePort: null })
    } finally {
      await closeAll(servers)
    }
  })
})

describe('assertServable with the default (no protected segments)', () => {
  beforeEach(() => {
    process.env.MDR_PROTECTED_SEGMENTS = ''
    clearProtectedWalkCache()
  })

  it('still refuses / and $HOME', () => {
    expect(codeOf(() => assertServable('/'))).toBe('PROTECTED_ROOT')
    expect(codeOf(() => assertServable(homedir()))).toBe('PROTECTED_ROOT')
  })

  it('serves roots holding or inside approvals/, registry/, legal/signed/: nothing else is protected', () => {
    const r = tmpRoot(['approvals', 'a/b/registry', 'legal/signed/deep', 'legal/filed'])
    expect(codeOf(() => assertServable(r))).toBeNull()
    expect(codeOf(() => assertServable(join(r, 'legal/signed/deep')))).toBeNull()
    writeFileSync(join(r, 'approvals', 'a.md'), '# a\n')
    expect(codeOf(() => assertServable(r, join(r, 'approvals', 'a.md')))).toBeNull()
    expect(protectedSegmentOf('/x/approvals/y')).toBeNull()
  })

  it('skips the walk entirely: no directory is visited and a root over the cap is servable', () => {
    const r = tmpRoot(['a/b/c', 'approvals'])
    expect(walkForProtected(r, 1)).toEqual({ hit: null, overCap: false, visited: 0 })
    expect(codeOf(() => assertServable(r))).toBeNull()
  })

  it('MDR_PROTECTED_SEGMENTS unset falls back to config.json, then to none', async () => {
    const { configPath } = await import('../../../../node/config')
    const home = mkdtempSync(join(tmpdir(), 'mdr-home-'))
    made.push(home)
    const savedHome = process.env.HOME
    delete process.env.MDR_PROTECTED_SEGMENTS
    process.env.HOME = home
    try {
      const r = tmpRoot(['approvals'])
      clearProtectedWalkCache()
      expect(codeOf(() => assertServable(r))).toBeNull()
      mkdirSync(join(home, '.config', 'mdr'), { recursive: true })
      writeFileSync(configPath(process.env, 'darwin'), JSON.stringify({ protectedSegments: ['approvals'] }))
      clearProtectedWalkCache()
      expect(codeOf(() => assertServable(r))).toBe('PROTECTED_ROOT')
    } finally {
      process.env.HOME = savedHome
      process.env.MDR_PROTECTED_SEGMENTS = ''
      clearProtectedWalkCache()
    }
  })
})

describe('discovery when a free port is slow to refuse (Windows; final pass 2026-11-16)', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('a health probe that times out is silent, and discovery still picks a port that binds', async () => {
    // Windows retries a loopback connect after the RST for about a second: every probe of a free port times out
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')))
    expect(await probeHealth(portFor(tmpRoot()))).toEqual({ kind: 'silent' })
    const r = tmpRoot()
    const d = await discover(r)
    expect(d.state).toBe('down')
    if (d.state !== 'down') return
    expect(d.freePort).not.toBeNull()
    expect(d.freePort! - portFor(r)).toBeGreaterThanOrEqual(0)
    expect(d.freePort! - portFor(r)).toBeLessThan(CONSTANTS.PORT_PROBE)
  })
})
