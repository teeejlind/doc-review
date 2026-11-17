// tests/unit/cli/commands.test.ts (P4; CONTRACTS §9.2–§9.4, §9.9.1, D12, D39; §13 rows 21, 81).
//
// The real CLI run in-process: server up = P1's real server (server/index.ts#startServer in this process, with the real
// handoff module; its marker makes discovery find it), server down = direct mode over P1's real openDocStore. Every
// result is checked against the frozen schemas, with `via` server vs direct.
import { afterEach, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import { ERROR_TABLE } from '../../../shared/constants'
import { portFor } from '../../../node/root'
import { tmpRoot, type TmpRoot } from '../../helpers/tmpRoot'
import { SAMPLE_PROTECTED_SEGMENTS, withProcessEnv } from '../../helpers/userEnv'
import { createHarness, type Harness } from '../handoff/harness'
import { cli, realServer, type RealServer } from './runner'

let root: TmpRoot | null = null
let fake: RealServer | null = null
let harness: Harness | null = null
afterEach(async () => {
  await fake?.stop()
  fake = null
  await harness?.close()
  harness = null
  root?.cleanup()
  root = null
})

const DOC = 'basic.md'
const valid = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } }, v: unknown): void => {
  const r = schema.safeParse(v)
  expect(r.success, JSON.stringify(r.error?.issues?.slice(0, 3))).toBe(true)
}

async function up(o: { protocol?: number } = {}): Promise<{ r: TmpRoot; f: RealServer; file: string }> {
  root = tmpRoot({ name: 'p4-cli', fixtures: [DOC] })
  fake = await realServer(root.root, o.protocol ? { env: { MDR_TEST_PROTOCOL: String(o.protocol) } } : {})
  return { r: root, f: fake, file: root.path(DOC) }
}

describe('server down: direct mode', () => {
  it('port: formula port and a free port in the window', async () => {
    root = tmpRoot({ name: 'p4-cli-down', fixtures: [DOC] })
    const res = await cli(['port', root.root])
    expect(res.code).toBe(0)
    valid(S.PortResultSchema, res.json)
    expect(res.json).toMatchObject({ root: root.root, formulaPort: portFor(root.root), state: 'free' })
    const viaFile = await cli(['port', root.path(DOC)])
    expect(viaFile.json.root).toBe(root.root)
  })

  it('status: via direct, server down, presence none, activity null', async () => {
    root = tmpRoot({ name: 'p4-cli-down', fixtures: [DOC] })
    const res = await cli(['status', root.path(DOC)])
    expect(res.code).toBe(0)
    valid(S.StatusResultSchema, res.json)
    expect(res.json).toMatchObject({ via: 'direct', file: DOC, server: { state: 'down', port: null, url: null }, presence: { waiter: 'none' }, activity: null })
  })

  it('snapshot / batch / pending / disarm / stop in direct mode', async () => {
    root = tmpRoot({ name: 'p4-cli-down', fixtures: [DOC] })
    const file = root.path(DOC)
    const snap = await cli(['snapshot', file, '--md'])
    valid(S.AgentSnapshotSchema, snap.json)
    expect(snap.json.via).toBe('direct')
    expect(snap.json.blocks[0]).toMatchObject({ ref: 'b1', md: '# Launch plan' })
    const c = await cli(['comment', file, '--quote', 'member rate of 12%', '--body', 'Still current?'])
    expect(c.code).toBe(0)
    valid(S.BatchResultSchema, c.json)
    expect(c.json).toMatchObject({ via: 'direct', results: [{ op: 'comment', anchor: { state: 'ok', block: 'b2' } }] })
    expect(root.readSidecar(DOC).length).toBeGreaterThan(1) // persisted through the direct store
    const p = await cli(['pending', file])
    valid(S.PendingResultSchema, p.json)
    expect(p.json).toMatchObject({ via: 'direct', empty: true })
    expect((await cli(['disarm', file])).json).toEqual({ ok: true, file: DOC, disarmed: false })
    expect((await cli(['stop', root.root])).json).toEqual({ ok: true, root: root.root, stopped: false, port: null })
  })

  it('a quote that matches twice → QUOTE_AMBIGUOUS (exit 6) with candidates; --occurrence resolves it', async () => {
    root = tmpRoot({ name: 'p4-cli-down', fixtures: [DOC] })
    const file = root.path(DOC)
    const amb = await cli(['comment', file, '--quote', 'member rate', '--body', 'x'])
    expect(amb.code).toBe(ERROR_TABLE.QUOTE_AMBIGUOUS.exit)
    expect(amb.json).toMatchObject({ ok: false, error: { code: 'QUOTE_AMBIGUOUS', op: 0 } })
    expect(amb.json.error.candidates).toHaveLength(2)
    expect((await cli(['comment', file, '--quote', 'member rate', '--occurrence', '2', '--body', 'x'])).code).toBe(0)
  })

  it('a missing file is FILE_NOT_FOUND (exit 5); a file outside --root is PATH_OUTSIDE_ROOT (exit 4)', async () => {
    root = tmpRoot({ name: 'p4-cli-down', fixtures: [DOC] })
    expect((await cli(['status', root.path('nope.md')])).json).toMatchObject({ error: { code: 'FILE_NOT_FOUND' } })
    const other = tmpRoot({ name: 'p4-cli-other', fixtures: [DOC] })
    try {
      const r = await cli(['status', other.path(DOC), '--root', root.root])
      expect(r.code).toBe(4)
      expect(r.json).toMatchObject({ error: { code: 'PATH_OUTSIDE_ROOT' } })
    } finally {
      other.cleanup()
    }
  })

  it('a doc under a protected path is refused before anything opens it (PROTECTED_ROOT, exit 4)', async () => {
    root = tmpRoot({ name: 'p4-cli-prot', fixtures: 'none', files: { 'approvals/x.md': '# x\n' } })
    const r = await withProcessEnv({ MDR_PROTECTED_SEGMENTS: SAMPLE_PROTECTED_SEGMENTS }, () => cli(['batch', root!.path('approvals/x.md'), '--root', root!.root], { stdin: { ops: [] } }))
    expect(r.code).toBe(4)
    expect(r.json).toMatchObject({ error: { code: 'PROTECTED_ROOT' } })
  })

  it('with the default (nothing protected) the same doc is reviewable', async () => {
    root = tmpRoot({ name: 'p4-cli-noprot', fixtures: 'none', files: { 'approvals/x.md': '# x\n' } })
    const r = await cli(['status', root.path('approvals/x.md'), '--root', root.root])
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, via: 'direct', file: 'approvals/x.md' })
  })
})

describe('server up: HTTP to the same-root server', () => {
  it('port and status find it through the marker; status is via server', async () => {
    const { r, f, file } = await up()
    expect((await cli(['port', r.root])).json).toMatchObject({ state: 'up', port: f.port })
    const st = await cli(['status', file])
    valid(S.StatusResultSchema, st.json)
    expect(st.json).toMatchObject({ via: 'server', file: DOC })
  })

  it('open --suggest-only: policy set, a fresh WaiterSpec after arm, the 127.0.0.1 URL', async () => {
    const { r, f, file } = await up()
    const res = await cli(['open', file, '--suggest-only'])
    expect(res.code).toBe(0)
    valid(S.OpenResultSchema, res.json)
    expect(res.json).toMatchObject({
      ok: true, via: 'server', file: DOC, root: r.root, port: f.port, url: `http://127.0.0.1:${f.port}/?file=basic.md`,
      policy: { suggestOnly: true }, presence: { waiter: 'grace' },
    })
    const w = res.json.waiter
    expect(w).toMatchObject({ v: 2, root: r.root, file: DOC, abs: file, port: f.port })
    expect(w.waiter).toMatch(/^w_[0-9a-f]{16}$/)
    expect(w.command).toContain(` wait "${file}" --root "${r.root}" --waiter ${w.waiter} --timeout 3300)`)
    // suggest-only is enforced for the whole batch (D39, §13 #81)
    const edit = await cli(['edit-block', file, '--quote', 'We launch in Q3.', '--md', 'We launch in Q4.'])
    expect(edit.code).toBe(4)
    expect(edit.json).toMatchObject({ error: { code: 'SUGGEST_ONLY' } })
    const sug = await cli(['suggest', file, '--quote', 'We launch in Q3.', '--replace', 'We launch in Q4.'])
    expect(sug.code).toBe(0)
    // --allow-edits lifts it
    const again = await cli(['arm', file, '--allow-edits'])
    expect(again.json.policy).toEqual({ suggestOnly: false })
  })

  it('arm: a fresh spec each time, attached false until a waiter connects, server info', async () => {
    const { f, file } = await up()
    const a = await cli(['arm', file])
    valid(S.ArmResultSchema, a.json)
    expect(a.json).toMatchObject({ attached: false, presence: { waiter: 'grace' }, server: { state: 'up', port: f.port }, policy: { suggestOnly: false } })
    const b = await cli(['arm', file])
    expect(b.json.waiter.waiter).not.toBe(a.json.waiter.waiter)
  })

  it('MDR_TEST_CLIPBOARD_PRIMARY: open and arm print waiter null and send no arm (§0.1, §13 #70)', async () => {
    const { file } = await up()
    const res = await cli(['open', file], { env: { MDR_TEST_CLIPBOARD_PRIMARY: '1' } })
    valid(S.OpenResultSchema, res.json)
    expect(res.json.waiter).toBeNull()
    expect(res.json.presence).toEqual({ waiter: 'none' })
  })

  it('writes go through POST /api/agent/batch (via server); a retried op in the same round is duplicate (§4.7)', async () => {
    const { file } = await up()
    const first = await cli(['comment', file, '--doc', '--body', 'Overall: tighten the intro.'])
    expect(first.json).toMatchObject({ via: 'server', results: [{ op: 'comment' }] })
    const again = await cli(['comment', file, '--doc', '--body', 'Overall: tighten the intro.'])
    expect(again.json.results[0]).toMatchObject({ duplicate: true, key: first.json.results[0].key, thread: first.json.results[0].thread })
    const dry = await cli(['batch', file, '--dry-run'], { stdin: { ops: [{ op: 'comment', doc: true, body: 'x' }] } })
    expect(dry.json).toMatchObject({ dryRun: true, noop: true })
  })

  it('thread, history and disarm via the server', async () => {
    const { file } = await up()
    const c = await cli(['comment', file, '--doc', '--body', 'A question'])
    const t = await cli(['thread', file, c.json.results[0].thread])
    valid(S.ThreadDetailSchema, t.json)
    expect(t.json.thread.messages[0]).toMatchObject({ by: 'Claude', body: 'A question' })
    const h = await cli(['history', file, '--limit', '5'])
    valid(S.HistoryListSchema, h.json)
    const d = await cli(['disarm', file])
    valid(S.DisarmResultSchema, d.json)
  })

  it('stop: same-root shutdown → stopped; then down → stopped false', async () => {
    const { r, f } = await up()
    const s = await cli(['stop', r.root])
    expect(s.json).toEqual({ ok: true, root: r.root, stopped: true, port: f.port })
    fake = null
    expect((await cli(['stop', r.root])).json).toMatchObject({ stopped: false })
  })

  it('an incompatible server (another protocol) → PROTOCOL_MISMATCH exit 8 with the --restart hint (§13 #21)', async () => {
    const { r, file } = await up({ protocol: 3 })
    const res = await cli(['status', file])
    expect(res.code).toBe(8)
    expect(res.json).toMatchObject({ ok: false, error: { code: 'PROTOCOL_MISMATCH', hint: `mdr serve ${r.root} --restart` } })
    const arm = await cli(['arm', file])
    expect(arm.code).toBe(8)
  })

  it('a response without this root\'s X-MDR-Root-Hash → ROOT_MISMATCH exit 8, never proceeds', async () => {
    harness = await createHarness()
    await harness.serve({ rootHash: '0'.repeat(64) })
    const res = await cli(['disarm', `${harness.root}/doc.md`])
    expect(res.code).toBe(8)
    expect(res.json).toMatchObject({ error: { code: 'ROOT_MISMATCH' } })
  })

  it('stop and serve --restart against a ROOT_MISMATCH answer never signal the pid health reported (§9.2)', async () => {
    harness = await createHarness()
    await harness.serve({ rootHash: '0'.repeat(64) }) // health names this process's pid
    let signalled = false
    const onTerm = (): void => {
      signalled = true
    }
    process.on('SIGTERM', onTerm) // without this listener a stray SIGTERM would end the test run itself
    try {
      const stop = await cli(['stop', harness.root])
      expect(stop.code).toBe(8)
      expect(stop.json).toMatchObject({ error: { code: 'ROOT_MISMATCH' } })
      const restart = await cli(['serve', harness.root, '--restart'])
      expect(restart.code).toBe(8)
      await new Promise((r) => setTimeout(r, 50))
      expect(signalled).toBe(false)
    } finally {
      process.off('SIGTERM', onTerm)
    }
  })
})
