// tests/e2e/p4-claude-loop.spec.ts (P4; CONTRACTS §14 P4 E2E, §9.4, §9.6, §9.7, §9.8, §9.9, §4.7, §8.5, D21, D46, D48).
//
// One full review round against the real built server, exactly as the skill runs it: `mdr open` → the waiter loop
// (WaiterSpec.command under bash) → Claude comments and suggests through one `batch` → TJ (webClient) replies and saves
// an edit → TJ clicks Send (`webClient.handoff()`) → the loop exits 0 with the payload and the wake prompt → `mdr
// pending` is exact → one batch with the ack → a retried batch in the same round is a duplicate → `mdr arm` and a new
// loop attach, and the delivered handoff never arrives again → `mdr disarm` ends the loop (exit 10).
import type { AgentSnapshot, ArmResult, BatchResult, OpenResult, PendingResult, StatusResult, WaitResult } from '../../shared/types'
import { buildWakePrompt } from '../../shared/handoff-prompt'
import { expect, json, killLoops, ok, P4_PORT_OFFSET, sleep, startLoop, test, waitPresence } from './fixtures/p4'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P4_PORT_OFFSET })
test.afterEach(killLoops)

test('open → loop → markup → TJ reply and edit → Send wakes the loop → pending exact → ack → new loop, no redelivery', async ({ cli, server, webClient, tmpRoot }) => {
  test.setTimeout(90_000)
  const abs = cli.abs(FILE)
  const url = `http://127.0.0.1:${server.port}/?file=${FILE}`

  // 1. open: serves (already up), arms, prints a fresh spec
  const open = ok<OpenResult>(await cli.run(['open', abs]))
  expect(open).toMatchObject({ via: 'server', file: FILE, abs, root: tmpRoot.root, port: server.port, url, presence: { waiter: 'grace' }, policy: { suggestOnly: false } })
  const spec = open.waiter!
  expect(spec).toMatchObject({ v: 2, root: tmpRoot.root, file: FILE, abs, port: server.port })
  expect(spec.command).toContain(` --waiter ${spec.waiter} `)

  // 2. the loop attaches
  const loop = startLoop(spec, { home: tmpRoot.home })
  const st = ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15']))
  expect(st.presence).toMatchObject({ waiter: 'connected', waiterId: spec.waiter })

  // 3. Claude marks up in one batch (refs and quotes from one snapshot)
  const snap = ok<AgentSnapshot>(await cli.run(['snapshot', abs, '--md']))
  expect(snap.blocks.find((b) => b.md === 'We launch in Q3.' || b.md?.includes('We launch in Q3.'))).toBeDefined()
  const mark = ok<BatchResult>(await cli.batch(FILE, { ops: [
    { op: 'comment', quote: 'member rate of 12%', body: 'Is 12% still current?' },
    { op: 'suggest', quote: 'We launch in Q3.', replace: 'We launch in Q3 2026.', reason: 'Name the year.' },
  ] }))
  expect(mark).toMatchObject({ via: 'server', file: FILE, noop: false, acked: null, consumed: [] })
  expect(mark.results).toMatchObject([
    { i: 0, op: 'comment', anchor: { state: 'ok', quote: 'member rate of 12%' } },
    { i: 1, op: 'suggest', anchor: { state: 'ok' }, hunks: [{ del: '', ins: ' 2026' }] },
  ])
  const thread = mark.results[0]!.thread!
  expect(mark.results[1]!.suggestion).toMatch(/^s_/)
  await sleep(300)
  expect(loop.done(), 'Claude\'s own writes never wake the loop').toBe(false)

  // 4. TJ replies and saves an edit
  await webClient.reply(thread, 'Yes, as of the 10/1 brief.')
  const doc = await webClient.doc()
  const saved = await webClient.saveText(doc.markdown.replace('- Grow the waitlist', '- Grow the waitlist to 5,000'))
  expect(saved.applied).toBe('direct')

  // 5. Send to Claude: the connected waiter gets it
  const sent = await webClient.handoff('Goals section next, please.')
  expect(sent).toMatchObject({ ok: true, coalesced: false, delivery: 'waiter' })

  // 6. the loop exits 0 with one line: the payload and its wake prompt
  const out = await loop.exit(20_000)
  expect(out.code, out.stdout + out.stderr).toBe(0)
  expect(out.lines).toHaveLength(1)
  const woke = out.json as Extract<WaitResult, { status: 'handoff' }>
  expect(woke.status).toBe('handoff')
  expect(woke.prompt).toBe(buildWakePrompt(woke.payload))
  expect(woke.payload).toMatchObject({
    file: FILE, abs, root: tmpRoot.root, port: server.port, url, waiter: spec.waiter, round: 1,
    handoffs: [{ seq: sent.seq, message: 'Goals section next, please.' }],
  })
  expect(woke.prompt).toContain(`[doc-review] TJ sent \`${FILE}\` back to you (round #1: `)
  await waitPresence(webClient, (p) => p.waiter === 'turn', { what: 'turn' })

  // 7. pending is exact: TJ's reply (new) on Claude's thread, TJ's edit netted to one block, the handoff, the counts
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  const lastSeq = (tmpRoot.readSidecar(FILE).at(-1) as { seq: number }).seq
  const counts = { threads: 1, messages: 1, suggestions: 0, decisions: 0, resolves: 0, edits: 1, external: 0, notices: 0, handoffs: 1 }
  expect(p).toEqual({
    ok: true, via: 'server', file: FILE, abs, rev: saved.rev, hash: saved.hash, since: 0, cursor: lastSeq, empty: false,
    user: { displayName: 'TJ', source: 'env' }, // the server's display name (generalization pass; the tests pin MDR_USER_NAME=TJ)
    handoffs: [{ seq: sent.seq, at: expect.any(String), message: 'Goals section next, please.' }],
    // Claude's own suggestion thread carries nothing from TJ, so it is not news; the comment thread has TJ's reply
    threads: [{
      id: thread, kind: 'comment', status: 'open', anchor: { state: 'ok', block: 'b2', line: 3, quote: 'member rate of 12%' },
      activity: ['replied'],
      messages: [
        { id: mark.results[0]!.comment, by: 'Claude', at: expect.any(String), body: 'Is 12% still current?' },
        { id: expect.stringMatching(/^c_/), by: 'TJ', at: expect.any(String), body: 'Yes, as of the 10/1 brief.', new: true },
      ],
      suggestions: [],
    }],
    edits: [{
      by: 'TJ', sources: ['editor'], fromRev: doc.rev, toRev: saved.rev,
      blocks: [{
        op: 'replace', block: 'b4', line: 7,
        change: { format: 'full', before: '- Grow the waitlist\n- Ship the explainer page\n- Publish the FAQ', after: '- Grow the waitlist to 5,000\n- Ship the explainer page\n- Publish the FAQ' },
      }],
    }],
    external: [], notices: [], counts, warnings: [],
  })
  expect(woke.payload.counts).toEqual(counts)
  expect(p.handoffs).toEqual(woke.payload.handoffs)
  expect(woke.payload.rev).toBe(saved.rev)

  // 8. one batch acts and acks; the handoff was already consumed by the waiter, so the ack consumes nothing new
  const reply = { op: 'reply' as const, thread, body: 'Thanks. Leaving 12% as is.' }
  const acked = ok<BatchResult>(await cli.batch(FILE, { ops: [reply], ack: p.cursor, ackSince: p.since }))
  expect(acked).toMatchObject({ via: 'server', acked: p.cursor, consumed: [] })
  // a retried batch in the same round is a duplicate: same key, same comment, nothing appended (§4.7)
  const seqBefore = acked.seq
  const retry = ok<BatchResult>(await cli.batch(FILE, { ops: [reply] }))
  expect(retry.results[0]).toMatchObject({ duplicate: true, key: acked.results[0]!.key, comment: acked.results[0]!.comment })
  expect(retry.seq).toBe(seqBefore)
  expect(ok<PendingResult>(await cli.run(['pending', abs])).empty).toBe(true)

  // 9. end of turn: arm (turn → grace, attached false), start a new loop; it attaches
  const arm = ok<ArmResult>(await cli.run(['arm', abs]))
  expect(arm).toMatchObject({ attached: false, presence: { waiter: 'grace' }, server: { state: 'up', port: server.port } })
  expect(arm.waiter!.waiter).not.toBe(spec.waiter)
  const loop2 = startLoop(arm.waiter!, { home: tmpRoot.home })
  const st2 = ok<StatusResult>(await cli.run(['status', abs, '--wait-waiter', '15']))
  expect(st2.presence).toMatchObject({ waiter: 'connected', waiterId: arm.waiter!.waiter })
  expect(st2.handoff.undelivered).toEqual([])

  // 10. the delivered handoff never arrives again
  await sleep(2_500)
  expect(loop2.done(), 'a consumed handoff must not wake the new loop').toBe(false)

  // 11. end of review
  expect(json(await cli.run(['disarm', abs]))).toEqual({ ok: true, file: FILE, disarmed: true })
  const end = await loop2.exit(10_000)
  expect(end.code).toBe(10)
  expect(end.json).toMatchObject({ ok: false, error: { code: 'DISARMED' } })
})
