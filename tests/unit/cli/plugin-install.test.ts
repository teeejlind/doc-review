// tests/unit/cli/plugin-install.test.ts (packaging; CONTRACT_CHANGES.md, 2026-10-16 "packaging" row).
//
// Runs the plugin's real scripts/ensure-runtime.sh end to end, offline: a copy of the plugin, a local mirror folder
// (DOC_REVIEW_NODE_BASE_URL=file://...) holding a stand-in Node tarball for this machine's platform, and a copy
// of runtime.lock whose hash for that platform is the stand-in's. Everything else is the shipped code path: the checksum
// gate, unpacking, the app copy, the wrapper, idempotence, repair and update. Nothing is downloaded from the network.
//
// The stand-in "node" is a two-line shell script that prints the pinned version for --version and otherwise runs the real
// Node executing this test, so the installed wrapper really starts the real bundled runtime/mdr.mjs. POSIX only (the
// PowerShell twin is not run here).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../helpers/tmpRoot'

const PLUGIN_SRC = join(REPO_ROOT, 'plugins', 'doc-review')
const posix = process.platform !== 'win32'

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

const sh = (args: string[], opts: { env: Record<string, string>; cwd: string }): Run => {
  const r = spawnSync('sh', args, { ...opts, encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const lastJson = (out: string): Record<string, unknown> => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

describe.skipIf(!posix)('scripts/ensure-runtime.sh (offline, against a local mirror)', () => {
  let base = ''
  let plugin = ''
  let mirror = ''
  let home = ''
  let nodeVersion = ''
  let mdrVersion = ''
  let pluginVersion = ''
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    LANG: 'C',
    DOC_REVIEW_NODE_BASE_URL: `file://${mirror}`,
    ...extra,
  })
  const script = (): string => join(plugin, 'scripts', 'ensure-runtime.sh')
  const run = (args: string[], extra: Record<string, string> = {}): Run => sh([script(), ...args], { env: env(extra), cwd: base })
  /** A fresh data folder with a space in its name: the wrapper must quote it. */
  const freshData = (name: string): string => join(base, `${name} data`)

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mdr-plugin-install-')))
    home = join(base, 'home')
    mirror = join(base, 'mirror')
    plugin = join(base, 'plugin')
    mkdirSync(home, { recursive: true })
    mkdirSync(mirror, { recursive: true })
    cpSync(PLUGIN_SRC, plugin, { recursive: true })

    nodeVersion = /^NODE_VERSION=(.+)$/m.exec(readFileSync(join(plugin, 'scripts', 'runtime.lock'), 'utf8'))![1]!.trim()
    pluginVersion = (JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }).version
    mdrVersion = /^mdr version: (.+)$/m.exec(readFileSync(join(plugin, 'runtime', 'BUILD.txt'), 'utf8'))![1]!.trim()

    // the stand-in tarball for this machine, named and laid out exactly like nodejs.org's
    const plat = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const top = `node-v${nodeVersion}-${plat}-${arch}`
    const stage = join(base, 'stage', top)
    mkdirSync(join(stage, 'bin'), { recursive: true })
    writeFileSync(join(stage, 'bin', 'node'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${nodeVersion}; exit 0; fi\nexec '${process.execPath}' "$@"\n`)
    chmodSync(join(stage, 'bin', 'node'), 0o755)
    writeFileSync(join(stage, 'LICENSE'), 'stand-in license\n')
    const tarball = join(mirror, `${top}.tar.gz`)
    const t = spawnSync('tar', ['-czf', tarball, '-C', join(base, 'stage'), top], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' } })
    if (t.status !== 0) throw new Error(`tar failed: ${t.stderr}`)

    // the copy's lock pins the stand-in for this platform
    const lockPath = join(plugin, 'scripts', 'runtime.lock')
    const key = `NODE_SHA256_${plat}_${arch}`.toUpperCase()
    const lock = readFileSync(lockPath, 'utf8')
    expect(lock).toMatch(new RegExp(`^${key}=[0-9a-f]{64}$`, 'm'))
    writeFileSync(lockPath, lock.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${sha256(tarball)}`))
  })

  afterAll(() => {
    // stop any review server a test left behind (by its root: `stop --all` scans the real port window and would stop
    // the person's own reviews on this machine), then remove everything
    const docs = join(base, 'docs')
    for (const d of readdirSync(base).filter((n) => n.endsWith(' data'))) {
      const mdr = join(base, d, 'bin', 'mdr')
      if (existsSync(mdr) && existsSync(docs)) spawnSync(mdr, ['stop', docs], { env: env(), cwd: base, timeout: 30_000 })
    }
    rmSync(base, { recursive: true, force: true })
  })

  it('--check on a machine that was never set up: exit 10, {"ready":false}, nothing installed', () => {
    const data = freshData('check')
    const r = run(['--check', data])
    expect(r.code).toBe(10)
    expect(r.stdout).toBe('{"ready":false}\n')
    expect(existsSync(join(data, 'node'))).toBe(false)
    expect(existsSync(join(data, 'bin', 'mdr'))).toBe(false)
  })

  describe('first run, second run, the wrapper', () => {
    const data = (): string => freshData('main')
    let appDir = ''
    let first: Record<string, unknown>

    it('first run: downloads (here: copies) the pinned Node after the checksum gate, installs the app and the wrapper, prints one JSON line', () => {
      const r = run([data()])
      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout.trim().split('\n')).toHaveLength(1)
      first = lastJson(r.stdout)
      expect(Object.keys(first).sort()).toEqual(['app', 'firstRun', 'mdr', 'node'])
      expect(first.firstRun).toBe(true)
      expect(first.node).toBe(nodeVersion)
      expect(String(first.app)).toMatch(new RegExp(`^${pluginVersion.replace(/\./g, '\\.')}-[0-9a-f]{12}$`))
      expect(first.mdr).toBe(join(data(), 'bin', 'mdr'))
      expect(r.stderr).toMatch(/downloading Node\.js/)
      expect(r.stderr).toMatch(/Checksum verified/)

      appDir = join(data(), 'app', String(first.app))
      for (const f of [join(data(), 'node', 'bin', 'node'), join(data(), 'node', 'VERSION'), join(appDir, 'mdr.mjs'), join(appDir, 'web', 'index.html'), join(appDir, '.complete'), join(appDir, 'BUILD.txt')]) {
        expect(existsSync(f), f).toBe(true)
      }
      expect(sha256(join(appDir, 'mdr.mjs'))).toBe(sha256(join(plugin, 'runtime', 'mdr.mjs')))
      // only the data folder was written: no profile, no PATH edit, nothing in HOME
      expect(readdirSync(home)).toEqual([])
      // no leftovers
      expect(readdirSync(data()).sort()).toEqual(['app', 'bin', 'node'])
    })

    it('second run: idempotent, silent, firstRun false; --check agrees', () => {
      const r = run([data()])
      expect(r.code).toBe(0)
      expect(r.stderr).toBe('')
      expect(lastJson(r.stdout)).toEqual({ ...first, firstRun: false })
      const c = run(['--check', data()])
      expect(c.code).toBe(0)
      expect(lastJson(c.stdout)).toEqual({ ...first, firstRun: false })
    })

    it('the wrapper runs the installed node on the installed app, from a data path with a space in it', () => {
      expect(String(first.mdr)).toContain(' data/')
      const r = spawnSync(String(first.mdr), ['--version'], { env: env(), cwd: base, encoding: 'utf8', timeout: 60_000 })
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ ok: true, version: mdrVersion })
      const w = readFileSync(String(first.mdr), 'utf8')
      expect(w.startsWith('#!/bin/sh\n')).toBe(true)
      expect(w).toContain('MDR_CMD')
      expect(w).toContain(join(data(), 'node', 'bin', 'node'))
      expect(w).toContain(join(appDir, 'mdr.mjs'))
    })

    it('the installed layout serves a review page: open, HTTP 200, snapshot, stop (no node_modules anywhere)', async () => {
      const docs = join(base, 'docs')
      mkdirSync(docs, { recursive: true })
      const doc = join(docs, 'plan.md')
      writeFileSync(doc, '# Plan\n\nFirst paragraph.\n\nSecond one.\n')
      const mdr = (args: string[]): { code: number | null; json: Record<string, unknown> } => {
        const r = spawnSync(String(first.mdr), args, { env: env(), cwd: base, encoding: 'utf8', timeout: 60_000 })
        return { code: r.status, json: lastJson(r.stdout) }
      }
      try {
        const o = mdr(['open', doc])
        expect(o.code).toBe(0)
        expect(o.json.ok).toBe(true)
        const url = String(o.json.url)
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?file=plan\.md$/)
        const waiter = o.json.waiter as { command: string } | null
        expect(waiter?.command, 'a waiter loop line for Bash run_in_background').toContain(join(appDir, 'mdr.mjs'))
        const page = await fetch(url)
        expect(page.status).toBe(200)
        expect(await page.text()).toContain('name="mdr-token"')
        const s = mdr(['snapshot', doc, '--md'])
        expect(s.code).toBe(0)
        expect((s.json.blocks as unknown[]).length).toBe(3)
      } finally {
        mdr(['stop', docs])
      }
    })

    it('repair: a half-copied app (no .complete marker) is copied again; Node is not downloaded again', () => {
      rmSync(join(appDir, '.complete'))
      const r = run([data()])
      expect(r.code, r.stderr).toBe(0)
      expect(lastJson(r.stdout)).toEqual({ ...first, firstRun: false })
      expect(r.stderr).not.toMatch(/downloading/)
      expect(existsSync(join(appDir, '.complete'))).toBe(true)
    })

    it('--check repairs the same way, offline: the half-copied app is copied again and it reports ready (T2 cli, Trial: ready:false although bin/mdr worked)', () => {
      rmSync(join(appDir, '.complete'))
      const c = run(['--check', data()], { DOC_REVIEW_NODE_BASE_URL: `file://${join(base, 'no-such-mirror')}` })
      expect(c.code, c.stderr).toBe(0)
      expect(lastJson(c.stdout)).toEqual({ ...first, firstRun: false })
      expect(c.stderr).not.toMatch(/download/i)
      expect(existsSync(join(appDir, '.complete'))).toBe(true)
    })

    it('update: a changed runtime gets a new app folder and a wrapper that points at it; the previous app folder is kept', () => {
      writeFileSync(join(plugin, 'runtime', 'mdr.mjs'), readFileSync(join(plugin, 'runtime', 'mdr.mjs'), 'utf8') + '\n// a new build\n')
      const r = run([data()])
      expect(r.code, r.stderr).toBe(0)
      const next = lastJson(r.stdout)
      expect(next.firstRun, 'Node is already installed').toBe(false)
      expect(next.app).not.toBe(first.app)
      expect(next.mdr).toBe(first.mdr)
      expect(readFileSync(String(next.mdr), 'utf8')).toContain(`/app/${String(next.app)}/mdr.mjs`)
      expect(readdirSync(join(data(), 'app')).sort()).toEqual([String(first.app), String(next.app)].sort())
    })

    it('--check after the plugin was updated again: no download, the app and wrapper are refreshed, and it reports ready (T2 cli, Trial: exit 10 although bin/mdr --version worked)', () => {
      const before = lastJson(run(['--check', data()]).stdout)
      // until the update the old wrapper runs fine, which is what made the old exit 10 look wrong
      const old = spawnSync(String(before.mdr), ['--version'], { env: env(), cwd: base, encoding: 'utf8', timeout: 60_000 })
      expect(old.status, old.stderr).toBe(0)
      const nodeBin = join(data(), 'node', 'bin', 'node')
      const nodeStat = statSync(nodeBin)

      writeFileSync(join(plugin, 'runtime', 'mdr.mjs'), readFileSync(join(plugin, 'runtime', 'mdr.mjs'), 'utf8') + '\n// the next build\n')
      // the mirror does not exist: any attempt to download would exit 3
      const c = run(['--check', data()], { DOC_REVIEW_NODE_BASE_URL: `file://${join(base, 'no-such-mirror')}` })
      expect(c.code, c.stderr).toBe(0)
      const now = lastJson(c.stdout)
      expect(now).toMatchObject({ firstRun: false, mdr: before.mdr, node: nodeVersion })
      expect(now.app, 'the new build').not.toBe(before.app)
      expect(c.stderr).not.toMatch(/download/i)
      expect(readFileSync(String(now.mdr), 'utf8')).toContain(`/app/${String(now.app)}/mdr.mjs`)
      expect(existsSync(join(data(), 'app', String(now.app), '.complete'))).toBe(true)
      // Node itself was not touched, and a plain run agrees with what --check printed
      const after = statSync(nodeBin)
      expect([after.ino, after.mtimeMs]).toEqual([nodeStat.ino, nodeStat.mtimeMs])
      expect(lastJson(run([data()]).stdout)).toEqual(now)
      const v = spawnSync(String(now.mdr), ['--version'], { env: env(), cwd: base, encoding: 'utf8', timeout: 60_000 })
      expect(v.status, v.stderr).toBe(0)
      expect(JSON.parse(v.stdout)).toEqual({ ok: true, version: mdrVersion })
    })
  })

  it('--check still answers {"ready":false} (exit 10) when Node.js is missing or the wrong version, and changes nothing', () => {
    const data = freshData('check-node')
    expect(run([data]).code).toBe(0)
    const listing = (): string[] => readdirSync(data, { recursive: true }).map(String).sort()
    const installed = listing()
    // the wrong version: the pinned one is what the plugin needs
    const versionFile = join(data, 'node', 'VERSION')
    const pinned = readFileSync(versionFile, 'utf8')
    writeFileSync(versionFile, '0.0.1\n')
    const wrong = run(['--check', data])
    expect([wrong.code, wrong.stdout, wrong.stderr]).toEqual([10, '{"ready":false}\n', ''])
    expect(listing()).toEqual(installed)
    writeFileSync(versionFile, pinned)
    expect(run(['--check', data]).code).toBe(0)
    // missing altogether
    rmSync(join(data, 'node'), { recursive: true })
    const missing = run(['--check', data])
    expect([missing.code, missing.stdout, missing.stderr]).toEqual([10, '{"ready":false}\n', ''])
    expect(existsSync(join(data, 'node'))).toBe(false)
    // the real run is what downloads it again, and says so
    const fix = run([data])
    expect(fix.code, fix.stderr).toBe(0)
    expect(lastJson(fix.stdout).firstRun).toBe(true)
    expect(fix.stderr).toMatch(/downloading Node\.js/)
    expect(run(['--check', data]).code).toBe(0)
  })

  it('a download that does not match the pinned SHA-256 installs nothing and exits 4', () => {
    const wrongPlugin = join(base, 'plugin-wrong-hash')
    cpSync(join(plugin, 'scripts'), join(wrongPlugin, 'scripts'), { recursive: true })
    cpSync(join(plugin, 'runtime', 'mdr.mjs'), join(wrongPlugin, 'runtime', 'mdr.mjs'))
    cpSync(join(plugin, 'runtime', 'web'), join(wrongPlugin, 'runtime', 'web'), { recursive: true })
    cpSync(join(plugin, '.claude-plugin'), join(wrongPlugin, '.claude-plugin'), { recursive: true })
    const lockPath = join(wrongPlugin, 'scripts', 'runtime.lock')
    writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace(/=[0-9a-f]{64}$/gm, `=${'0'.repeat(64)}`))
    const data = freshData('wrong')
    const r = sh([join(wrongPlugin, 'scripts', 'ensure-runtime.sh'), data], { env: env(), cwd: base })
    expect(r.code).toBe(4)
    expect(r.stderr).toMatch(/does not match the checksum pinned in runtime\.lock/)
    expect(r.stderr).toMatch(/Nothing was installed/)
    expect(r.stdout).toBe('')
    expect(existsSync(join(data, 'node'))).toBe(false)
    expect(existsSync(join(data, 'bin', 'mdr'))).toBe(false)
  })

  it('a download that cannot be fetched exits 3 with a plain sentence', () => {
    const r = run([freshData('offline')], { DOC_REVIEW_NODE_BASE_URL: `file://${join(base, 'no-such-mirror')}` })
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/could not download/)
  })

  it('an unsubstituted ${CLAUDE_PLUGIN_DATA} falls back to the env var, then to ~/.claude/plugins/data, and never makes a folder named after the placeholder', () => {
    const viaEnv = freshData('via env')
    const a = run(['${CLAUDE_PLUGIN_DATA}'], { CLAUDE_PLUGIN_DATA: viaEnv })
    expect(a.code, a.stderr).toBe(0)
    expect(lastJson(a.stdout).mdr).toBe(join(viaEnv, 'bin', 'mdr'))

    const b = run(['${CLAUDE_PLUGIN_DATA}'])
    expect(b.code, b.stderr).toBe(0)
    expect(lastJson(b.stdout).mdr).toBe(join(home, '.claude', 'plugins', 'data', 'doc-review-doc-review', 'bin', 'mdr'))
    expect(readdirSync(base).filter((n) => n.includes('$') || n.includes('{'))).toEqual([])
  })

  it('refuses a relative data folder and an unknown option with a plain sentence', () => {
    const rel = run(['relative/dir'])
    expect(rel.code).toBe(6)
    expect(rel.stderr).toMatch(/absolute path/)
    const opt = run(['--frobnicate'])
    expect(opt.code).toBe(2)
    expect(opt.stderr).toMatch(/unknown option/)
  })
})
