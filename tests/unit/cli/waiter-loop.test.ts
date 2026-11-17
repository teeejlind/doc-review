// tests/unit/cli/waiter-loop.test.ts (P4; CONTRACTS §9.8.1, §9.8.3, D1, D49).
//
// The generated loop line, run for real through `bash -c` and (when present) `zsh -c`:
// - quoting: paths with spaces, $, backticks and double quotes reach a stub CLI byte-exact;
// - exit handling with a stub `wait`: 2, 2, 0 → prints only the final line, exits 0; 11 then 0 → exactly one
//   `sleep 5`, then exits 0; 8 → prints the CliErr and exits 8 at once (no sleep, no re-run); 10 → exits 10; 1 and 9
//   → exit with that code. `sleep` is a PATH stub that logs its argument, so the 5 s costs nothing.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONSTANTS } from '../../../shared/constants'
import { q } from '../../../shared/handoff-prompt'
import { buildLoopLine, mintWaiterId, waiterSpec, waitTimeoutS, waiterEnabled, CLIPBOARD_PRIMARY } from '../../../cli/waiter-loop'
import { buildWakePrompt } from '../../../shared/handoff-prompt'
import { mdrCmd } from '../../../node/config'

const base = mkdtempSync(join(tmpdir(), 'mdr-loop-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const SHELLS = ['/bin/bash', '/bin/zsh'].filter((s) => existsSync(s))

const STUB = `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
const state = process.env.STUB_STATE
let code = 0
if (state) {
  const codes = JSON.parse(readFileSync(state, 'utf8'))
  code = codes.length ? codes.shift() : 0
  writeFileSync(state, JSON.stringify(codes))
}
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
const doc = process.env.STUB_ECHO ? process.argv.slice(2)
  : code === 0 ? { ok: true, status: 'handoff', code } : code === 2 ? { ok: true, status: 'timeout', code } : { ok: false, error: { code: 'E' + code, message: 'x' }, code }
process.stdout.write(JSON.stringify(doc) + '\\n')
process.exit(code)
`

function setup(dirName: string): { dir: string; stub: string; bin: string; sleepLog: string } {
  const dir = join(base, dirName)
  mkdirSync(dir, { recursive: true })
  const stub = join(dir, 'stub cli.mjs')
  writeFileSync(stub, STUB)
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const sleepLog = join(dir, 'sleep.log')
  writeFileSync(join(bin, 'sleep'), `#!/bin/sh\necho "$@" >> ${q(sleepLog)}\nexit 0\n`)
  chmodSync(join(bin, 'sleep'), 0o755)
  return { dir, stub, bin, sleepLog }
}

function runLoop(shell: string, line: string, env: Record<string, string>): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(shell, ['-c', line], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('the loop line (§9.8.1)', () => {
  it('has the normative shape', () => {
    const waiter = 'w_0123456789abcdef'
    const line = buildLoopLine({ node: '/usr/local/bin/node', cli: '/opt/mdr/dist/cli.js', abs: '/r/a.md', root: '/r', waiter, timeoutS: 3300 })
    expect(line).toBe(
      `while :; do out=$("/usr/local/bin/node" "/opt/mdr/dist/cli.js" wait "/r/a.md" --root "/r" --waiter ${waiter} --timeout 3300); rc=$?; `
      + `case $rc in 2) continue ;; 11) sleep 5; continue ;; esac; printf '%s\\n' "$out"; exit $rc; done`,
    )
  })

  it('a spec mints a fresh w_ id per call and bakes it in; the timeout is 3300 unless MDR_TEST_WAIT_TIMEOUT_S under test hooks', () => {
    const a = waiterSpec({ node: 'n', cli: 'c', abs: '/r/a.md', root: '/r', file: 'a.md', port: 8301, timeoutS: 3300 })
    const b = waiterSpec({ node: 'n', cli: 'c', abs: '/r/a.md', root: '/r', file: 'a.md', port: 8301, timeoutS: 3300 })
    expect(a.waiter).toMatch(/^w_[0-9a-f]{16}$/)
    expect(a.waiter).not.toBe(b.waiter)
    expect(a.command).toContain(`--waiter ${a.waiter} --timeout 3300)`)
    expect(a).toMatchObject({ v: 2, root: '/r', file: 'a.md', abs: '/r/a.md', port: 8301 })
    expect(mintWaiterId()).toMatch(/^w_[0-9a-f]{16}$/)
    expect(waitTimeoutS({})).toBe(CONSTANTS.WAIT_DEFAULT_TIMEOUT_S)
    expect(waitTimeoutS({ MDR_TEST_WAIT_TIMEOUT_S: '3' })).toBe(3300)
    expect(waitTimeoutS({ MDR_TEST_HOOKS: '1', MDR_TEST_WAIT_TIMEOUT_S: '3' })).toBe(3)
    expect(CLIPBOARD_PRIMARY).toBe(false)
    expect(waiterEnabled({})).toBe(true)
    expect(waiterEnabled({ MDR_TEST_HOOKS: '1', MDR_TEST_CLIPBOARD_PRIMARY: '1' })).toBe(false)
  })

  for (const shell of SHELLS) {
    it(`${shell}: paths with spaces, $, backticks and double quotes reach the CLI byte-exact`, () => {
      const { dir, stub } = setup(`we "ird" $HOME \`x\` dir`)
      const abs = join(dir, 'my $doc "v2" `final`.md')
      const waiter = mintWaiterId()
      const line = buildLoopLine({ node: process.execPath, cli: stub, abs, root: dir, waiter, timeoutS: 3300 })
      const r = runLoop(shell, line, { STUB_ECHO: '1' })
      expect(r.stderr).toBe('')
      expect(r.code).toBe(0)
      expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1)
      expect(JSON.parse(r.stdout)).toEqual(['wait', abs, '--root', dir, '--waiter', waiter, '--timeout', '3300'])
    })

    it(`${shell}: node flags (a from-source run) are kept and quoted between node and the CLI`, () => {
      const { dir, stub } = setup('flags')
      const line = buildLoopLine({ node: process.execPath, execArgv: ['--no-warnings'], cli: stub, abs: join(dir, 'a.md'), root: dir, waiter: 'w_0000000000000001', timeoutS: 5 })
      const r = runLoop(shell, line, { STUB_ECHO: '1' })
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual(['wait', join(dir, 'a.md'), '--root', dir, '--waiter', 'w_0000000000000001', '--timeout', '5'])
    })

    const cases: Array<{ codes: number[]; exit: number; runs: number; sleeps: string[]; status?: string }> = [
      { codes: [2, 2, 0], exit: 0, runs: 3, sleeps: [], status: 'handoff' },
      { codes: [11, 0], exit: 0, runs: 2, sleeps: ['5'], status: 'handoff' },
      { codes: [2, 11, 2, 0], exit: 0, runs: 4, sleeps: ['5'], status: 'handoff' },
      { codes: [8, 0], exit: 8, runs: 1, sleeps: [] },
      { codes: [10, 0], exit: 10, runs: 1, sleeps: [] },
      { codes: [1, 0], exit: 1, runs: 1, sleeps: [] },
      { codes: [9, 0], exit: 9, runs: 1, sleeps: [] },
      { codes: [130], exit: 130, runs: 1, sleeps: [] },
    ]
    for (const c of cases) {
      it(`${shell}: wait exits ${c.codes.join(', ')} → the loop exits ${c.exit} after ${c.runs} run(s), ${c.sleeps.length} sleep(s), one output line`, () => {
        const { dir, stub, bin, sleepLog } = setup(`codes-${c.codes.join('-')}-${shell.split('/').pop()}`)
        const state = join(dir, 'state.json')
        const log = join(dir, 'runs.log')
        writeFileSync(state, JSON.stringify(c.codes))
        writeFileSync(log, '')
        writeFileSync(sleepLog, '')
        const line = buildLoopLine({ node: process.execPath, cli: stub, abs: join(dir, 'a.md'), root: dir, waiter: 'w_0000000000000001', timeoutS: 3300 })
        const r = runLoop(shell, line, { STUB_STATE: state, STUB_LOG: log, PATH: `${bin}:${process.env.PATH ?? ''}` })
        expect(r.code).toBe(c.exit)
        const out = r.stdout.split('\n').filter(Boolean)
        expect(out).toHaveLength(1)
        const doc = JSON.parse(out[0]!) as { ok: boolean; status?: string; code: number }
        expect(doc.code).toBe(c.exit)
        if (c.status) expect(doc.status).toBe(c.status)
        else expect(doc.ok).toBe(false)
        expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(c.runs)
        expect(readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean)).toEqual(c.sleeps)
      })
    }
  }
})

describe('Windows paths in the commands Claude runs (final pass 2026-11-16)', () => {
  const win = {
    node: 'C:\\Users\\Ana Díaz\\AppData\\Roaming\\mdr\\node\\node.exe', cli: 'C:\\Users\\Ana Díaz\\.claude\\plugins\\mdr\\runtime\\mdr.mjs',
    abs: 'C:\\Users\\Ana Díaz\\Docs\\Q4 plan.md', root: 'C:\\Users\\Ana Díaz\\Docs',
  }
  it('the waiter loop names node, the CLI, the doc and the root with forward slashes, quoted', () => {
    const line = buildLoopLine({ ...win, waiter: 'w_0123456789abcdef' as never, timeoutS: 3300 })
    expect(line).not.toContain('\\\\')
    expect(line).toContain('"C:/Users/Ana Díaz/AppData/Roaming/mdr/node/node.exe" "C:/Users/Ana Díaz/.claude/plugins/mdr/runtime/mdr.mjs" wait "C:/Users/Ana Díaz/Docs/Q4 plan.md" --root "C:/Users/Ana Díaz/Docs"')
  })
  it('the wake / clipboard prompt and MDR_CMD hints do the same; POSIX paths and plain `mdr` are unchanged', () => {
    const p = buildWakePrompt({ file: 'Q4 plan.md', abs: win.abs, root: win.root, round: null, cmd: 'C:\\Users\\Ana Díaz\\AppData\\Roaming\\mdr\\bin\\mdr.cmd' })
    expect(p).toContain('Run: "C:/Users/Ana Díaz/AppData/Roaming/mdr/bin/mdr.cmd" pending "C:/Users/Ana Díaz/Docs/Q4 plan.md" --root "C:/Users/Ana Díaz/Docs"')
    expect(mdrCmd({ MDR_CMD: 'C:\\Users\\Ana\\mdr.cmd' })).toBe('"C:/Users/Ana/mdr.cmd"')
    expect(mdrCmd({ MDR_CMD: '"/Users/ana/Library/x/mdr"' })).toBe('"/Users/ana/Library/x/mdr"')
    expect(mdrCmd({})).toBe('mdr')
    expect(buildWakePrompt({ file: 'a.md', abs: '/Users/ana/a b/a.md', root: '/Users/ana/a b', round: null })).toContain('Run: mdr pending "/Users/ana/a b/a.md" --root "/Users/ana/a b"')
  })
})
