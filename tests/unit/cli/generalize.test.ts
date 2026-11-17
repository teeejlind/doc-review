// tests/unit/cli/generalize.test.ts (generalization pass). The CLI for any user: `mdr --version`; `mdr config
// get | set | unset` over ~/.config/mdr/config.json; `user` on open / status / pending (the server's when it is up,
// the CLI's own in direct mode); `open --launch` (recorded through MDR_TEST_LAUNCH_LOG, never a real browser; only
// when no tab was navigated); `waiterReason` and waiter null on Windows without a POSIX shell (staged with
// MDR_TEST_PLATFORM); `stop --all` over a test-only port range; MDR_CMD and the display name in the exit actions.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import type { RunningServer } from '../../../shared/types'
import { MDR_VERSION } from '../../../shared/version'
import { startServer } from '../../../server/index'
import { exitActions } from '../../../cli/exit'
import { browserCommand } from '../../../cli/launch'
import { posixShellAvailable, waiterUnavailableReason, WAITER_REASON } from '../../../cli/waiter-loop'
import { tmpRoot, type TmpRoot } from '../../helpers/tmpRoot'
import { cli, realServer, type RealServer } from './runner'

const DOC = 'basic.md'
const dirs: string[] = []
let root: TmpRoot | null = null
let srv: RealServer | null = null
afterEach(async () => {
  await srv?.stop()
  srv = null
  root?.cleanup()
  root = null
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const valid = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } }, v: unknown): void => {
  const r = schema.safeParse(v)
  expect(r.success, JSON.stringify(r.error?.issues?.slice(0, 3))).toBe(true)
}
const tmpHome = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'mdr-cli-home-'))
  dirs.push(d)
  return d
}

describe('mdr --version', () => {
  it('prints {"ok":true,"version":MDR_VERSION} and exits 0, alone or with the global flags', async () => {
    const r = await cli(['--version'])
    expect(r.code).toBe(0)
    expect(r.docs).toBe(1)
    valid(S.VersionResultSchema, r.json)
    expect(r.json).toEqual({ ok: true, version: MDR_VERSION })
    const p = await cli(['--version', '--pretty'])
    expect(p.code).toBe(0)
    expect(p.stdout).toContain('\n  "version": ')
    expect(p.stderr).toBe('')
    // --version as an option of a command is still a usage error, not a version print
    expect((await cli(['status', '--version'])).code).toBe(3)
  })
})

describe('mdr config', () => {
  it('get on a fresh HOME: no file, the name from the chain, nothing protected', async () => {
    const HOME = tmpHome()
    const r = await cli(['config', 'get'], { env: { HOME, MDR_USER_NAME: 'Ana' } })
    expect(r.code).toBe(0)
    valid(S.ConfigResultSchema, r.json)
    expect(r.json).toEqual({
      ok: true, path: join(HOME, '.config', 'mdr', 'config.json'), config: {},
      user: { displayName: 'Ana', source: 'env' }, protectedSegments: { segments: [], source: 'default' }, tour: 'offer',
    })
  })

  it('set name / set protected / unset write the file; MDR_USER_NAME still wins over it', async () => {
    const HOME = tmpHome()
    const env = { HOME }
    const a = await cli(['config', 'set', 'name', '  Ana   Díaz '], { env })
    expect(a.code).toBe(0)
    valid(S.ConfigResultSchema, a.json)
    expect(a.json.config).toEqual({ displayName: 'Ana Díaz' })
    expect(a.json.user).toEqual({ displayName: 'Ana Díaz', source: 'config' })
    const file = join(HOME, '.config', 'mdr', 'config.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ displayName: 'Ana Díaz' })
    const b = await cli(['config', 'set', 'protected', 'approvals, legal/signed,'], { env })
    expect(b.json.config).toEqual({ displayName: 'Ana Díaz', protectedSegments: ['approvals', 'legal/signed'] })
    expect(b.json.protectedSegments).toEqual({ segments: ['approvals', 'legal/signed'], source: 'config' })
    const c = await cli(['config', 'get'], { env: { HOME, MDR_USER_NAME: 'TJ', MDR_PROTECTED_SEGMENTS: '' } })
    expect(c.json.user).toEqual({ displayName: 'TJ', source: 'env' })
    expect(c.json.protectedSegments).toEqual({ segments: [], source: 'env' })
    const d = await cli(['config', 'unset', 'name'], { env })
    expect(d.json.config).toEqual({ protectedSegments: ['approvals', 'legal/signed'] })
    expect(d.json.user.source).not.toBe('config')
  })

  it('usage errors: unknown action or key, missing value, an empty name, extra arguments', async () => {
    const env = { HOME: tmpHome() }
    for (const argv of [['config'], ['config', 'frob'], ['config', 'set'], ['config', 'set', 'colour', 'x'], ['config', 'set', 'name'],
      ['config', 'set', 'name', '   '], ['config', 'set', 'name', 'x'.repeat(65)], ['config', 'unset', 'name', 'x'], ['config', 'set', 'name', 'a', 'b']]) {
      const r = await cli(argv, { env })
      expect(r.code, argv.join(' ')).toBe(3)
      expect(r.json, argv.join(' ')).toMatchObject({ ok: false, error: { code: 'USAGE' } })
    }
    expect(existsSync(join(env.HOME, '.config', 'mdr', 'config.json'))).toBe(false)
  })
})

describe('`user` on open / status / pending', () => {
  it('direct mode: the CLI resolves it from its own env', async () => {
    root = tmpRoot({ name: 'gen-user-direct', fixtures: [DOC] })
    const st = await cli(['status', root.path(DOC)], { env: { MDR_USER_NAME: 'Ana' } })
    valid(S.StatusResultSchema, st.json)
    expect(st.json).toMatchObject({ via: 'direct', user: { displayName: 'Ana', source: 'env' } })
    const p = await cli(['pending', root.path(DOC)], { env: { MDR_USER_NAME: 'Ana' } })
    valid(S.PendingResultSchema, p.json)
    expect(p.json.user).toEqual({ displayName: 'Ana', source: 'env' })
  })

  it('server up: the server\'s name (the one the page shows), on open, status and pending', async () => {
    root = tmpRoot({ name: 'gen-user-server', fixtures: [DOC] })
    srv = await realServer(root.root)
    const env = { MDR_USER_NAME: 'Not the server' }
    const o = await cli(['open', root.path(DOC)], { env })
    valid(S.OpenResultSchema, o.json)
    expect(o.json.user).toEqual({ displayName: 'TJ', source: 'env' })
    expect(o.json).not.toHaveProperty('launched')
    expect(o.json).not.toHaveProperty('waiterReason')
    expect((await cli(['status', root.path(DOC)], { env })).json.user).toEqual({ displayName: 'TJ', source: 'env' })
    expect((await cli(['pending', root.path(DOC)], { env })).json.user).toEqual({ displayName: 'TJ', source: 'env' })
  })
})

describe('open --launch', () => {
  it('no tab connected: the system browser command runs once (macOS open / Windows cmd start / xdg-open)', async () => {
    root = tmpRoot({ name: 'gen-launch', fixtures: [DOC] })
    srv = await realServer(root.root)
    const log = join(tmpHome(), 'launch.jsonl')
    const r = await cli(['open', root.path(DOC), '--launch'], { env: { MDR_TEST_LAUNCH_LOG: log, MDR_TEST_PLATFORM: 'darwin' } })
    expect(r.code).toBe(0)
    valid(S.OpenResultSchema, r.json)
    expect(r.json).toMatchObject({ navigated: false, launched: true })
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { url: string; cmd: string; args: string[] })
    expect(lines).toEqual([{ url: r.json.url, cmd: 'open', args: [r.json.url], verbatim: false }])
    const w = await cli(['open', root.path(DOC), '--launch'], { env: { MDR_TEST_LAUNCH_LOG: log, MDR_TEST_PLATFORM: 'win32', SHELL: '/usr/bin/bash' } })
    expect(w.json.launched).toBe(true)
    expect(JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[1]!)).toMatchObject({ cmd: 'cmd', args: ['/c', 'start', '""', w.json.url], verbatim: true })
  })

  it('browserCommand per platform; a failed opener reports launched: false', async () => {
    const url = 'http://127.0.0.1:8301/?file=a%20b.md'
    expect(browserCommand(url, 'darwin')).toEqual({ cmd: 'open', args: [url], verbatim: false })
    expect(browserCommand(url, 'win32')).toEqual({ cmd: 'cmd', args: ['/c', 'start', '""', url], verbatim: true })
    expect(browserCommand(url, 'linux')).toEqual({ cmd: 'xdg-open', args: [url], verbatim: false })
    root = tmpRoot({ name: 'gen-launch-fail', fixtures: [DOC] })
    srv = await realServer(root.root)
    const bad = join(tmpHome(), 'no-such-dir', 'launch.jsonl')
    const r = await cli(['open', root.path(DOC), '--launch'], { env: { MDR_TEST_LAUNCH_LOG: bad } })
    expect(r.code).toBe(0)
    expect(r.json.launched).toBe(false)
  })
})

describe('waiter on Windows without a POSIX shell', () => {
  it('posixShellAvailable: always off Windows; on Windows MSYSTEM, SHELL, CLAUDE_CODE_GIT_BASH_PATH or bash on PATH', () => {
    const dir = tmpHome()
    expect(posixShellAvailable({}, 'darwin')).toBe(true)
    expect(posixShellAvailable({}, 'linux')).toBe(true)
    expect(posixShellAvailable({}, 'win32')).toBe(false)
    expect(posixShellAvailable({ MSYSTEM: 'MINGW64' }, 'win32')).toBe(true)
    expect(posixShellAvailable({ SHELL: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' }, 'win32')).toBe(true)
    expect(posixShellAvailable({ SHELL: 'cmd.exe' }, 'win32')).toBe(false)
    writeFileSync(join(dir, 'bash.exe'), '')
    expect(posixShellAvailable({ CLAUDE_CODE_GIT_BASH_PATH: join(dir, 'bash.exe') }, 'win32')).toBe(true)
    expect(posixShellAvailable({ PATH: `C:\\nowhere;${dir}` }, 'win32')).toBe(true)
    expect(waiterUnavailableReason({}, 'win32')).toBe(WAITER_REASON.noPosixShell)
    expect(waiterUnavailableReason({ MSYSTEM: 'MINGW64' }, 'win32')).toBeNull()
    expect(waiterUnavailableReason({ MDR_TEST_HOOKS: '1', MDR_TEST_CLIPBOARD_PRIMARY: '1' }, 'darwin')).toBe(WAITER_REASON.clipboardPrimary)
  })

  it('open and arm print waiter null with waiterReason, and send no arm (presence stays none)', async () => {
    root = tmpRoot({ name: 'gen-win', fixtures: [DOC] })
    srv = await realServer(root.root)
    const env = { MDR_TEST_PLATFORM: 'win32' }
    const o = await cli(['open', root.path(DOC)], { env })
    valid(S.OpenResultSchema, o.json)
    expect(o.json).toMatchObject({ waiter: null, waiterReason: WAITER_REASON.noPosixShell, presence: { waiter: 'none' } })
    const a = await cli(['arm', root.path(DOC)], { env })
    valid(S.ArmResultSchema, a.json)
    expect(a.json).toMatchObject({ waiter: null, waiterReason: WAITER_REASON.noPosixShell, attached: false })
    // the clipboard-primary switch says so too
    const c = await cli(['open', root.path(DOC)], { env: { MDR_TEST_CLIPBOARD_PRIMARY: '1' } })
    expect(c.json).toMatchObject({ waiter: null, waiterReason: WAITER_REASON.clipboardPrimary })
  })
})

/** Two adjacent free ports, so the stop --all range holds only this test's servers. */
async function adjacentPorts(): Promise<[number, number]> {
  const listen = (port: number): Promise<boolean> => new Promise((done) => {
    const s = createServer()
    s.once('error', () => done(false))
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)))
  })
  for (let i = 0; i < 50; i++) {
    const p = 40_000 + Math.floor(Math.random() * 20_000)
    if ((await listen(p)) && (await listen(p + 1))) return [p, p + 1]
  }
  throw new Error('no two adjacent free ports')
}

describe('stop --all', () => {
  const started: RunningServer[] = []
  afterEach(async () => {
    for (const s of started.splice(0)) await s.close('stop').catch(() => undefined)
  })

  it('stops every mdr server in the scanned range, each through its own shutdown route; nothing else', async () => {
    const r1 = tmpRoot({ name: 'gen-stopall-a', fixtures: [DOC] })
    const r2 = tmpRoot({ name: 'gen-stopall-b', fixtures: [DOC] })
    try {
      const [p1, p2] = await adjacentPorts()
      const s1 = await startServer({ root: r1.root, port: p1, testHooks: true })
      const s2 = await startServer({ root: r2.root, port: p2, testHooks: true })
      started.push(s1, s2)
      const env = { MDR_TEST_STOP_ALL_PORTS: `${p1}-${p2}` }
      const r = await cli(['stop', '--all'], { env })
      expect(r.code).toBe(0)
      valid(S.StopAllResultSchema, r.json)
      expect(r.json).toEqual({
        ok: true, all: true, failed: [],
        stopped: [{ root: r1.root, port: p1, pid: process.pid }, { root: r2.root, port: p2, pid: process.pid }],
      })
      await Promise.all([s1.done, s2.done])
      expect(existsSync(join(r1.root, '.review', 'server.json'))).toBe(false)
      const again = await cli(['stop', '--all'], { env })
      expect(again.json).toEqual({ ok: true, all: true, stopped: [], failed: [] })
    } finally {
      r1.cleanup()
      r2.cleanup()
    }
  })

  it('a root together with --all is a usage error', async () => {
    const r = await cli(['stop', '/tmp', '--all'])
    expect(r.code).toBe(3)
    expect(r.json).toMatchObject({ error: { code: 'USAGE' } })
  })
})

describe('MDR_CMD and the display name in agent-facing text', () => {
  it('exit actions name the command and the user', () => {
    const a = exitActions({ cmd: 'npx -y mdr', who: 'Ana' })
    expect(a[1]).toBe('INTERNAL: report it in one line and run `npx -y mdr status`')
    expect(a[8]).toContain('tell Ana to run `npx -y mdr serve <root> --restart`')
    expect(a[5]).toContain('`npx -y mdr snapshot` or `npx -y mdr pending`')
    const d = exitActions({ cmd: 'mdr', who: 'the user' })
    expect(d[9]).toContain('`mdr doctor` diagnoses')
  })
})
