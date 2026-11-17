// tests/unit/cli/loop-integration.test.ts (P4; CONTRACTS §9.8, §0.1, D1, D49).
//
// The real generated loop line, run as a child shell exactly as the skill runs it (Bash, in the background), with the
// real CLI from source, against the real handoff module served by the harness in this process:
// - several 1-second `wait` runs re-arm without presence ever reaching `none`, then a click wakes the loop: exit 0
//   with one JSON line (the handoff and its wake prompt);
// - a server speaking another protocol ends the loop at once with exit 8 and one CliErr line (no respin, D49).
// The e2e twin with the built CLI and the real server is p4-waiter-loop (§9.8.3).
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLoopLine, mintWaiterId } from '../../../cli/waiter-loop'
import { REPO_ROOT } from '../../helpers/tmpRoot'
import { createHarness, presenceEvents, until, type Harness } from '../handoff/harness'

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

function startLoop(h: Harness, timeoutS: number): { done: Promise<{ code: number | null; stdout: string; stderr: string }>; waiter: string } {
  const waiter = mintWaiterId()
  const line = buildLoopLine({
    node: process.execPath, execArgv: ['--import', 'tsx'], cli: join(REPO_ROOT, 'cli', 'main.ts'), abs: join(h.root, 'doc.md'), root: h.root, waiter, timeoutS,
  })
  const child = spawn('/bin/bash', ['-c', line], { cwd: REPO_ROOT, env: { ...process.env, MDR_TEST_HOOKS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
  const kill = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code, stdout, stderr })
    })
  })
  return { done, waiter }
}

describe('the waiter loop, end to end over a real socket', () => {
  it('re-arms on each 1 s timeout without presence reaching none, then a click wakes it with one JSON line', async () => {
    h = await createHarness({ options: { graceMs: 20_000 } })
    await h.serve()
    let connects = 0
    const orig = h.module.core.openWaiter.bind(h.module.core)
    h.module.core.openWaiter = (f, id, gen) => {
      connects++
      return orig(f, id, gen)
    }
    const loop = startLoop(h, 1)
    await until(() => connects >= 3, 45_000)
    expect(presenceEvents(h).includes('none')).toBe(false)
    await until(() => h!.module.presence('doc.md').waiter === 'connected', 10_000)
    const sent = await h.handoff({ message: 'Section 2, please' })
    const r = await loop.done
    expect(r.code).toBe(0)
    const lines = r.stdout.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const doc = JSON.parse(lines[0]!) as { ok: boolean; status: string; payload: { handoffs: Array<{ seq: number }>; waiter: string }; prompt: string }
    expect(doc).toMatchObject({ ok: true, status: 'handoff', payload: { waiter: loop.waiter } })
    expect(doc.payload.handoffs.map((x) => x.seq)).toEqual([sent.seq])
    expect(doc.prompt).toMatch(/^\[doc-review\] TJ sent `doc.md` back to you \(round #1: /)
  }, 90_000)

  it('a server speaking another protocol ends the loop at once: exit 8, one CliErr line, no re-run', async () => {
    h = await createHarness()
    await h.serve({ protocol: 3 })
    const t0 = Date.now()
    const r = await startLoop(h, 30).done
    expect(r.code).toBe(8)
    const lines = r.stdout.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error: { code: 'PROTOCOL_MISMATCH' } })
    expect(Date.now() - t0).toBeLessThan(20_000)
  }, 60_000)
})
