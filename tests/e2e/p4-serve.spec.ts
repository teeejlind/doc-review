// tests/e2e/p4-serve.spec.ts (P4; CONTRACTS §14 P4 E2E, §9.2 guard and discovery, §9.2.1, §9.4 serve/stop/port, D12, D13,
// D15, §13 rows 18–20, 23–25).
//
// `mdr serve` with the built CLI, as TJ or the skill runs it:
// - protected roots are refused (PROTECTED_ROOT, exit 4) before any server starts: with TJ's MDR_PROTECTED_SEGMENTS a
//   root holding approvals/ or legal/signed/, a root inside /registry/; $HOME and `/` always; with and without
//   --foreground. With the default (nothing configured) a root holding approvals/ is served (generalization pass);
// - the port is stable: `mdr port` names portFor(root); `serve` (background, ensureServer) takes the first free port of
//   the window, a second `serve` adopts it, and after `stop` the next `serve` comes back on the same port;
// - another root's server is never touched: when it holds this root's formula port, `serve` moves to the next port,
//   and neither `serve --restart` nor `stop` for this root affects it;
// - 127.0.0.1 only: the server answers on 127.0.0.1 and not on ::1 or a LAN address, and every URL it prints is
//   http://127.0.0.1:<port>/.
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { PortResult, ServeResult, StopResult } from '../../shared/types'
import { portFor } from '../../node/root'
import { startServer, workerPort } from '../helpers/startServer'
import { tmpRoot as makeTmpRoot } from '../helpers/tmpRoot'
import { SAMPLE_PROTECTED_SEGMENTS } from '../helpers/userEnv'
import { expect, json, ok, P4_PORT_OFFSET, test } from './fixtures/p4'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P4_PORT_OFFSET })

/** GET /api/health on host:port; the status, or the socket error code. */
function probe(host: string, port: number): Promise<number | string> {
  return new Promise((resolve) => {
    const req = request({ host, port, path: '/api/health', timeout: 1_000 }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve('TIMEOUT')
    })
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERROR'))
    req.end()
  })
}

test('protected roots are refused before any server starts (PROTECTED_ROOT, exit 4)', async ({ cli, tmpRoot }) => {
  test.setTimeout(60_000)
  tmpRoot.write('approvals/receipt.md', '# Receipt\n')
  const withSigned = makeTmpRoot({ name: 'p4-serve-signed', fixtures: [FILE], files: { 'legal/signed/c.md': '# signed\n' } })
  const insideRegistry = makeTmpRoot({ name: 'p4-serve-registry', fixtures: 'none', files: { 'registry/doc.md': '# r\n' } })
  try {
    const port = workerPort(P4_PORT_OFFSET === 9 ? 8 : 9) // this worker's window, never the spec's own server port
    const cases: Array<{ what: string; args: string[] }> = [
      { what: 'a root holding approvals/', args: ['serve', tmpRoot.root] },
      { what: 'a root holding approvals/ (--foreground)', args: ['serve', tmpRoot.root, '--foreground', '--port', String(port)] },
      { what: 'a root holding legal/signed/', args: ['serve', withSigned.root] },
      { what: 'a root inside /registry/', args: ['serve', insideRegistry.path('registry')] },
      { what: '$HOME', args: ['serve', tmpRoot.home] },
      { what: '/', args: ['serve', '/'] },
      { what: 'open on a doc under approvals/', args: ['open', tmpRoot.path('approvals/receipt.md')] },
    ]
    for (const c of cases) {
      const r = await cli.run(c.args, { env: { MDR_PROTECTED_SEGMENTS: SAMPLE_PROTECTED_SEGMENTS } })
      expect(r.code, `${c.what}: ${r.stdout}`).toBe(4)
      expect(json(r)).toMatchObject({ ok: false, error: { code: 'PROTECTED_ROOT' } })
    }
    for (const c of cases.filter((x) => x.what === '$HOME' || x.what === '/')) {
      const r = await cli.run(c.args) // the default protects nothing else, but never these two
      expect(r.code, `${c.what} (default): ${r.stdout}`).toBe(4)
    }
    expect(await probe('127.0.0.1', port)).toBe('ECONNREFUSED')
    expect(tmpRoot.exists('.review/server.json')).toBe(false)
  } finally {
    withSigned.cleanup()
    insideRegistry.cleanup()
  }
})

test('the default protects nothing beyond / and $HOME: a root holding approvals/ is served, and config.json can protect it', async ({ cli }) => {
  test.setTimeout(60_000)
  const r = makeTmpRoot({ name: 'p4-serve-default', fixtures: [FILE], files: { 'approvals/receipt.md': '# Receipt\n' } })
  try {
    const up = ok<ServeResult>(await cli.run(['serve', r.root], { home: r.home }))
    expect(up).toMatchObject({ root: r.root, adopted: false })
    expect(ok<StopResult>(await cli.run(['stop', r.root], { home: r.home }))).toMatchObject({ stopped: true })
    // the file-based setting: `mdr config set protected` in this HOME, with no env override
    const set = ok<{ protectedSegments: { segments: string[]; source: string } }>(await cli.run(['config', 'set', 'protected', 'approvals'], { home: r.home, env: { MDR_PROTECTED_SEGMENTS: undefined } }))
    expect(set.protectedSegments).toEqual({ segments: ['approvals'], source: 'config' })
    const refused = await cli.run(['serve', r.root], { home: r.home, env: { MDR_PROTECTED_SEGMENTS: undefined } })
    expect(refused.code).toBe(4)
    expect(json(refused)).toMatchObject({ ok: false, error: { code: 'PROTECTED_ROOT' } })
  } finally {
    r.cleanup()
  }
})

test('the port is stable: port names portFor(root); serve adopts on a second run and comes back on the same port after stop', async ({ cli, tmpRoot }) => {
  test.setTimeout(60_000)
  const root = tmpRoot.root
  const formula = portFor(root)
  const before = ok<PortResult>(await cli.run(['port', root]))
  expect(before).toMatchObject({ root, formulaPort: formula })
  if (before.state !== 'free') test.skip(true, `the window from ${formula} is busy on this machine (${before.state})`)
  try {
    const s1 = ok<ServeResult>(await cli.run(['serve', root]))
    expect(s1).toMatchObject({ root, port: before.port, url: `http://127.0.0.1:${before.port}/`, adopted: false })
    expect(s1.port).toBeGreaterThanOrEqual(formula)
    expect(s1.port).toBeLessThan(formula + 10)
    const s2 = ok<ServeResult>(await cli.run(['serve', root]))
    expect(s2).toMatchObject({ port: s1.port, pid: s1.pid, adopted: true })
    expect(ok<PortResult>(await cli.run(['port', cli.abs(FILE)]))).toMatchObject({ state: 'up', port: s1.port })
    expect(ok<StopResult>(await cli.run(['stop', root]))).toEqual({ ok: true, root, stopped: true, port: s1.port })
    expect(tmpRoot.exists('.review/server.json'), 'stop removes the marker').toBe(false)
    const s3 = ok<ServeResult>(await cli.run(['serve', root]))
    expect(s3).toMatchObject({ port: s1.port, adopted: false })
    expect(s3.pid).not.toBe(s1.pid)
  } finally {
    await cli.run(['stop', root])
  }
})

test('another root\'s server is never touched: serve moves to the next port; serve --restart and stop leave it alone', async ({ cli, tmpRoot }) => {
  test.setTimeout(60_000)
  const other = makeTmpRoot({ name: 'p4-serve-other', fixtures: [FILE] })
  const root = tmpRoot.root
  const formula = portFor(root)
  let held: Awaited<ReturnType<typeof startServer>> | null = null
  try {
    try {
      held = await startServer({ root: other.root, port: formula, home: other.home })
    } catch {
      test.skip(true, `port ${formula} is busy on this machine`)
    }
    const s = ok<ServeResult>(await cli.run(['serve', root]))
    expect(s.port, 'skips the port another root holds').toBeGreaterThan(formula)
    expect(s.port).toBeLessThan(formula + 10)
    const r = ok<ServeResult>(await cli.run(['serve', root, '--restart']))
    expect(r).toMatchObject({ port: s.port, restarted: true, adopted: false })
    expect(ok<StopResult>(await cli.run(['stop', root]))).toMatchObject({ stopped: true, port: s.port })
    // the other root's server is the same process, still healthy, still serving its own root
    const h = await held!.health()
    expect(h).toMatchObject({ root: other.root, pid: held!.pid, port: formula })
    // stop for that root's file from here refuses nothing and stops only that root
    expect(ok<StopResult>(await cli.run(['stop', other.root]))).toMatchObject({ root: other.root, stopped: true, port: formula })
  } finally {
    await cli.run(['stop', root])
    await held?.stop()
    other.cleanup()
  }
})

test('127.0.0.1 only: answers on 127.0.0.1, not on ::1 or a LAN address; every printed URL is http://127.0.0.1', async ({ cli, server }) => {
  expect(await probe('127.0.0.1', server.port)).toBe(200)
  expect(await probe('::1', server.port)).not.toBe(200)
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
  if (lan) expect(await probe(lan.address, server.port)).not.toBe(200)
  expect(server.real!.serveResult?.url).toBe(`http://127.0.0.1:${server.port}/`)
  const open = ok<{ url: string; waiter: { port: number } }>(await cli.run(['open', cli.abs(FILE)]))
  expect(open.url).toBe(`http://127.0.0.1:${server.port}/?file=${FILE}`)
  expect(ok<ServeResult>(await cli.run(['serve', server.root]))).toMatchObject({ url: `http://127.0.0.1:${server.port}/`, adopted: true })
})
