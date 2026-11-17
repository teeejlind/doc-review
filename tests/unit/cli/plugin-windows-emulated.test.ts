// tests/unit/cli/plugin-windows-emulated.test.ts (onboarding, 2026-11-16). ensure-runtime.sh's Windows and network
// paths, emulated on a POSIX host (there is no Windows machine in the loop):
//
// - Windows: fake `uname` (MINGW64), `cygpath` (maps C:\Users\Lucas Q\... to a temp folder) and `powershell.exe`
//   (records its arguments, prints the JSON line ensure-runtime.ps1 -Posix would) on PATH, and the script started with
//   $0 = 'C:\Users\Lucas Q\...\ensure-runtime.sh', the way Claude Code may substitute ${CLAUDE_PLUGIN_ROOT}. Before the
//   fix, dirname of that path was "." and the script looked for runtime.lock in the current folder.
// - A blocked network: a local HTTP server answers the Node.js download with 403, or with a proxy's block page, or the
//   download host refuses connections while a probe host answers: exit 7 and the plain "ask IT" sentence. Offline
//   (the probe fails too) stays exit 3.
// What this can't prove: real Git Bash, real cygpath, real PowerShell (see the .ps1 static tests).
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../helpers/tmpRoot'

const PLUGIN_SRC = join(REPO_ROOT, 'plugins', 'doc-review')
const posix = process.platform !== 'win32'
const WIN = 'C:\\Users\\Lucas Q'
const BLOCKED = 'your company network blocked the download; ask IT to allow nodejs.org'

let base = ''
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mdr-win-emul-')))
})
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const exe = (p: string, body: string): void => {
  writeFileSync(p, body)
  chmodSync(p, 0o755)
}

describe.skipIf(!posix)('ensure-runtime.sh under an emulated Git Bash (MINGW64)', () => {
  let root = ''
  let bin = ''
  let log = ''
  beforeAll(() => {
    root = join(base, 'win') // stands for C:\Users\Lucas Q
    bin = join(base, 'fakebin')
    log = join(base, 'ps-args.txt')
    mkdirSync(bin, { recursive: true })
    cpSync(PLUGIN_SRC, join(root, 'plugin'), { recursive: true })
    mkdirSync(join(root, 'data', 'bin'), { recursive: true })
    // the installed sh launcher: prints its arguments as JSON so the test can see what it was given
    exe(join(root, 'data', 'bin', 'mdr'), `#!/bin/sh\nnode -e 'console.log(JSON.stringify({ok:true,argv:process.argv.slice(1)}))' -- "$@"\n`)
    exe(join(bin, 'uname'), `#!/bin/sh\nif [ "$1" = "-s" ]; then echo MINGW64_NT-10.0-26100; else /usr/bin/uname "$@"; fi\n`)
    // cygpath -u / -w between the fake drive and the temp folder
    exe(join(bin, 'cygpath'), `#!/bin/sh
mode=$1; p=$2
W='${WIN}'
R='${root}'
case $mode in
  -u) p=$(printf '%s' "$p" | tr '\\\\' '/'); Wf=$(printf '%s' "$W" | tr '\\\\' '/'); case $p in "$Wf"*) printf '%s\\n' "$R\${p#"$Wf"}" ;; *) printf '%s\\n' "$p" ;; esac ;;
  -w) case $p in "$R"*) printf '%s%s\\n' "$W" "$(printf '%s' "\${p#"$R"}" | tr '/' '\\\\')" ;; [A-Za-z]:/*) printf '%s\\n' "$(printf '%s' "$p" | tr '/' '\\\\')" ;; *) printf '%s\\n' "$p" ;; esac ;;
esac
`)
    // powershell.exe: record the arguments (one per line), answer like ensure-runtime.ps1 -Posix; exit code from FAKE_PS_EXIT
    exe(join(bin, 'powershell.exe'), `#!/bin/sh
: >"${log}"
for a in "$@"; do printf '%s\\n' "$a" >>"${log}"; done
printf 'Setting up doc-review (one time)...\\n' >&2
if [ "\${FAKE_PS_EXIT:-0}" = 10 ]; then printf '{"ready":false}\\r\\n'; exit 10; fi
printf '{"mdr":"${root}/data/bin/mdr","mdrCmd":"C:\\\\\\\\Users\\\\\\\\Lucas Q\\\\\\\\data\\\\\\\\bin\\\\\\\\mdr.cmd","node":"26.5.0","app":"0.1.5-abc","firstRun":true}\\r\\n'
`)
  })

  const script = (): string => readFileSync(join(PLUGIN_SRC, 'scripts', 'ensure-runtime.sh'), 'utf8')
  /** sh -c '<the script>' '<$0 as Windows spells it>' args... : the script sees exactly that $0 */
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('sh', ['-c', script(), `${WIN}\\plugin\\scripts\\ensure-runtime.sh`, ...args], {
      cwd: base, encoding: 'utf8', timeout: 60_000,
      env: { PATH: `${bin}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, '')}`, HOME: join(root, 'home'), ...env },
    })
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  const psArgs = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean)

  it('a C:\\ path in $0 finds the plugin: PowerShell gets the .ps1 as a Windows path, -Posix, and the data folder', () => {
    const r = run([`${WIN}\\data`])
    expect(r.code, r.stderr).toBe(0)
    expect(psArgs()).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${WIN}\\plugin\\scripts\\ensure-runtime.ps1`, '-Posix', '-DataDir', `${WIN}\\data`])
    const lines = r.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ mdr: `${root}/data/bin/mdr`, firstRun: true })
    expect(r.stderr).toContain('Setting up doc-review')
  })

  it('a C:/ forward-slash $0 and data folder work the same', () => {
    const r = spawnSync('sh', ['-c', script(), `${WIN.replace(/\\/g, '/')}/plugin/scripts/ensure-runtime.sh`, `${WIN.replace(/\\/g, '/')}/data`], {
      cwd: base, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(psArgs()).toContain(`${WIN}\\plugin\\scripts\\ensure-runtime.ps1`)
    expect(psArgs()).toContain(`${WIN}\\data`)
  })

  it('-- <mdr command> runs the installed launcher after setup: setup JSON first, then the command\'s own JSON', () => {
    const r = run([`${WIN}\\data`, '--', 'open', 'C:/Users/Lucas Q/Documents/plan & 50% notes.md', '--offer-tour'])
    expect(r.code, r.stderr).toBe(0)
    const [setup, opened, ...rest] = r.stdout.trim().split('\n')
    expect(rest).toEqual([])
    expect(JSON.parse(setup!)).toMatchObject({ firstRun: true })
    // every argument arrives intact: no cmd.exe in the path to eat % or &
    expect(JSON.parse(opened!).argv).toEqual(['open', 'C:/Users/Lucas Q/Documents/plan & 50% notes.md', '--offer-tour'])
  })

  it('--check passes -Check, and a not-ready answer (exit 10) runs no mdr command', () => {
    const r = run(['--check', `${WIN}\\data`, '--', 'open', 'x.md'], { FAKE_PS_EXIT: '10' })
    expect(r.code).toBe(10)
    expect(psArgs()).toContain('-Check')
    expect(r.stdout.trim()).toBe('{"ready":false}')
  })

  it('an unsubstituted ${CLAUDE_PLUGIN_DATA} is not passed on: the .ps1 picks its default', () => {
    const r = run(['${CLAUDE_PLUGIN_DATA}'])
    expect(r.code, r.stderr).toBe(0)
    expect(psArgs()).not.toContain('-DataDir')
  })
})

// ---- a blocked network ----------------------------------------------------------------------------------------------
interface Srv {
  url: string
  close(): Promise<void>
}
const serve = (status: number, body: string): Promise<Srv> =>
  new Promise((res) => {
    const s: Server = createServer((_req, r) => {
      r.writeHead(status, { 'content-type': 'text/html' })
      r.end(body)
    })
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      res({ url: `http://127.0.0.1:${port}`, close: () => new Promise((d) => s.close(() => d())) })
    })
  })
/** A port nothing listens on. */
const deadUrl = async (): Promise<string> => {
  const s = await serve(200, '')
  const u = s.url
  await s.close()
  return u
}
const runAsync = (args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((res) => {
    const p = spawn('sh', args, { cwd: base, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(base, 'home'), LANG: 'C', ...env } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    p.on('close', (code) => res({ code, stdout, stderr }))
  })

describe.skipIf(!posix)('ensure-runtime.sh when the network blocks nodejs.org', () => {
  let plugin = ''
  let n = 0
  beforeAll(() => {
    plugin = join(base, 'net-plugin')
    cpSync(PLUGIN_SRC, plugin, { recursive: true })
  })
  const go = (env: Record<string, string>) => runAsync([join(plugin, 'scripts', 'ensure-runtime.sh'), join(base, `net-data-${++n}`)], env)

  it('HTTP 403 from the download host: exit 7, the plain "ask IT to allow nodejs.org" sentence, nothing installed', async () => {
    const s = await serve(403, '<html>Blocked by policy</html>')
    try {
      const r = await go({ DOC_REVIEW_NODE_BASE_URL: s.url, DOC_REVIEW_PROBE_URL: s.url })
      expect(r.code).toBe(7)
      expect(r.stderr).toContain(BLOCKED)
      expect(r.stdout).toBe('')
    } finally {
      await s.close()
    }
  })

  it('a proxy block page served as 200 (the checksum fails on a web page): exit 7, not "checksum mismatch"', async () => {
    const s = await serve(200, '<!DOCTYPE html><html><body>This site is blocked by your organization</body></html>')
    try {
      const r = await go({ DOC_REVIEW_NODE_BASE_URL: s.url })
      expect(r.code).toBe(7)
      expect(r.stderr).toContain(BLOCKED)
    } finally {
      await s.close()
    }
  })

  it('nodejs.org refuses the connection while the internet works (the probe answers): exit 7', async () => {
    const probe = await serve(404, 'ok')
    try {
      const r = await go({ DOC_REVIEW_NODE_BASE_URL: await deadUrl(), DOC_REVIEW_PROBE_URL: probe.url })
      expect(r.code).toBe(7)
      expect(r.stderr).toContain(BLOCKED)
    } finally {
      await probe.close()
    }
  })

  it('no internet at all (the probe fails too): still exit 3, "check the internet connection"', async () => {
    const dead = await deadUrl()
    const r = await go({ DOC_REVIEW_NODE_BASE_URL: dead, DOC_REVIEW_PROBE_URL: dead })
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/check the internet connection/)
    expect(r.stderr).not.toContain(BLOCKED)
  })
})
