// tests/e2e/p4-suggest-only.spec.ts (P4; CONTRACTS §9.9.1, D39, §4.4, §9.5 all-or-nothing, §13 #81).
//
// Third-party review against the real built server: `mdr open --suggest-only` sets the policy; every direct-edit op
// (replace_block, replace_range, insert_after / insert_before, delete_block, write, decide accept) fails SUGGEST_ONLY
// (exit 4) for the whole batch and writes nothing, exactly as cli/policy.ts classifies it; the markup ops (comment in
// all three forms, reply, suggest, suggest_block, resolve / reopen, withdraw, edit / delete own comment, decide reject,
// ack) succeed without touching the bytes; the policy persists across a server restart; TJ's toggle
// (`POST /api/policy`, webClient.setPolicy) lifts it; `mdr arm --suggest-only` / `--allow-edits` set it again.
import type { AgentOp, AgentSnapshot, ArmResult, BatchResult, OpenResult, PendingResult, StatusResult } from '../../shared/types'
import { blockedBySuggestOnly } from '../../cli/policy'
import { expect, json, ok, P4_PORT_OFFSET, test, tjSuggest } from './fixtures/p4'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P4_PORT_OFFSET })

const policyLines = (lines: unknown[]): Array<{ by: string; suggestOnly: boolean }> =>
  (lines as Array<{ type?: string; by: string; suggestOnly: boolean }>).filter((l) => l.type === 'policy.set').map(({ by, suggestOnly }) => ({ by, suggestOnly }))

test('suggest-only: direct edits refused whole-batch with nothing written; markup allowed; persists across a restart; TJ lifts it', async ({ cli, server, webClient, tmpRoot }) => {
  test.setTimeout(90_000)
  const abs = cli.abs(FILE)
  const open = ok<OpenResult>(await cli.run(['open', abs, '--suggest-only']))
  expect(open.policy).toEqual({ suggestOnly: true })
  expect(policyLines(tmpRoot.readSidecar(FILE))).toEqual([{ by: 'Claude', suggestOnly: true }])

  // TJ proposes something in Suggesting mode (Claude may reject it, never accept it, on a third-party doc)
  const tjA = await tjSuggest(webClient, 'Publish the FAQ', '- Grow the waitlist\n- Ship the explainer page\n- Publish the FAQ and the glossary')
  const tjB = await tjSuggest(webClient, 'reviewed every quarter', 'The member rate is reviewed every month.')
  const tjPending = (await webClient.review()).suggestions.filter((s) => s.by === 'TJ' && s.status === 'pending').map((s) => s.id)
  expect(tjPending.sort()).toEqual([tjA.id, tjB.id].sort())
  const snap = ok<AgentSnapshot>(await cli.run(['snapshot', abs, '--md']))
  const rev = snap.rev
  const bytes = tmpRoot.read(FILE)

  // every direct-edit op, alone or after an allowed op, refuses the whole batch and writes nothing
  const blocked: AgentOp[] = [
    { op: 'replace_block', target: { ref: 'b2', rev }, markdown: 'Rewritten.' },
    { op: 'replace_range', from: { ref: 'b2', rev }, to: { ref: 'b3', rev }, markdown: 'Merged.' },
    { op: 'insert_after', target: { ref: 'b2', rev }, markdown: 'A new paragraph.' },
    { op: 'insert_before', target: { quote: 'We launch in Q3.' }, markdown: 'A new paragraph.' },
    { op: 'delete_block', target: { ref: 'b6', rev } },
    { op: 'write', markdown: `${bytes}\nOne more line.\n`, baseRev: rev },
    { op: 'decide', suggestion: tjA.id, decision: 'accept' },
  ]
  for (const op of blocked) {
    expect(blockedBySuggestOnly(op), `classifier: ${op.op}`).toBe(true)
    const before = tmpRoot.readSidecar(FILE).length
    const r = await cli.batch(FILE, { ops: [{ op: 'comment', doc: true, body: 'An allowed op first.' }, op] })
    expect(r.code, `${op.op}: ${r.stdout}`).toBe(4)
    expect(json(r)).toMatchObject({ ok: false, error: { code: 'SUGGEST_ONLY', op: 1 } })
    expect((r.json as { error: { hint: string } }).error.hint).toContain('use suggest')
    expect(tmpRoot.read(FILE), `${op.op} must not touch the bytes`).toBe(bytes)
    expect(tmpRoot.readSidecar(FILE).length, `${op.op}: all-or-nothing, the comment before it is not written either`).toBe(before)
  }
  // the single-op sugar too
  const sugar = await cli.run(['edit-block', abs, '--quote', 'We launch in Q3.', '--md', 'We launch in Q4.'])
  expect(sugar.code).toBe(4)
  expect(json(sugar)).toMatchObject({ error: { code: 'SUGGEST_ONLY' } })

  // markup is allowed and never changes the bytes
  const markup: AgentOp[] = [
    { op: 'comment', quote: 'member rate of 12%', body: 'Source for 12%?' },
    { op: 'comment', block: { ref: 'b4', rev }, body: 'Order these by impact?' },
    { op: 'comment', doc: true, body: 'Overall: clear, a little long.' },
    { op: 'suggest', quote: 'We launch in Q3.', replace: 'We launch in Q3 2026.', reason: 'Name the year.' },
    { op: 'suggest_block', target: { ref: 'b6', rev }, markdown: '> A short quote that sets the context.', reason: 'Tighter.' },
  ]
  for (const op of markup) expect(blockedBySuggestOnly(op), `classifier: ${op.op}`).toBe(false)
  const m = ok<BatchResult>(await cli.batch(FILE, { ops: markup }))
  expect(m.results.map((x) => x.op)).toEqual(['comment', 'comment', 'comment', 'suggest', 'suggest_block'])
  const [qThread, , dThread] = m.results.map((x) => x.thread!)
  const mine = m.results[3]!.suggestion!
  const follow: AgentOp[] = [
    { op: 'reply', thread: qThread!, body: 'Found it: the 10/1 deal brief.' },
    { op: 'edit_comment', comment: m.results[2]!.comment!, body: 'Overall: clear; trim section 2.' },
    { op: 'resolve', thread: dThread!, body: 'Noted.' },
    { op: 'reopen', thread: dThread! },
    { op: 'withdraw', suggestion: mine },
    { op: 'decide', suggestion: tjB.id, decision: 'reject' },
  ]
  for (const op of follow) expect(blockedBySuggestOnly(op), `classifier: ${op.op}`).toBe(false)
  ok<BatchResult>(await cli.batch(FILE, { ops: follow }))
  ok<BatchResult>(await cli.batch(FILE, { ops: [{ op: 'delete_comment', comment: m.results[1]!.comment! }] }))
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  const acked = ok<BatchResult>(await cli.batch(FILE, { ops: [], ack: p.cursor, ackSince: p.since }))
  expect(acked.acked).toBe(p.cursor)
  expect(tmpRoot.read(FILE), 'markup never touches the bytes').toBe(bytes)

  // the policy lives in the sidecar: it survives a server restart, and status / arm report it
  await server.restart()
  const st = ok<StatusResult>(await cli.run(['status', abs]))
  expect(st).toMatchObject({ via: 'server', policy: { suggestOnly: true } })
  const after = await cli.batch(FILE, { ops: [{ op: 'replace_block', target: { ref: 'b2', rev: st.rev }, markdown: 'Rewritten.' }] })
  expect(after.code).toBe(4)

  // TJ's toggle ("Claude may edit directly") lifts it; a direct edit then lands
  await webClient.setPolicy({ suggestOnly: false })
  const st2 = ok<StatusResult>(await cli.run(['status', abs]))
  expect(st2.policy).toEqual({ suggestOnly: false })
  const edit = ok<BatchResult>(await cli.batch(FILE, { ops: [{ op: 'replace_block', target: { ref: 'b2', rev: st2.rev }, markdown: 'The notes carry a member rate of 12% paid monthly. We launch in Q3 2026.' }] }))
  expect(edit.noop).toBe(false)
  expect(tmpRoot.read(FILE)).toContain('We launch in Q3 2026.')

  // arm sets it again on Claude's side (only after TJ says so in chat, per the skill), and lifts it with --allow-edits
  expect(ok<ArmResult>(await cli.run(['arm', abs, '--suggest-only'])).policy).toEqual({ suggestOnly: true })
  expect(ok<ArmResult>(await cli.run(['arm', abs, '--allow-edits'])).policy).toEqual({ suggestOnly: false })
  expect(policyLines(tmpRoot.readSidecar(FILE))).toEqual([
    { by: 'Claude', suggestOnly: true }, { by: 'TJ', suggestOnly: false }, { by: 'Claude', suggestOnly: true }, { by: 'Claude', suggestOnly: false },
  ])
  // a repeat of the current state appends nothing
  ok<ArmResult>(await cli.run(['arm', abs, '--allow-edits']))
  expect(policyLines(tmpRoot.readSidecar(FILE))).toHaveLength(4)
})
