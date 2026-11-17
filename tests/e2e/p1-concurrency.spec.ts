// tests/e2e/p1-concurrency.spec.ts (P1; CONTRACTS §14 P1 E2E, §3.6 row "in sync", §7.1, §7.3, §9.3, §13 rows 10, 15, 16).
//
// TJ's tab has the doc loaded with an autosave planned; the server goes down (its close flushes his open session);
// Claude writes through the CLI in direct mode while it is down (an edit, a comment and a suggestion, then a second,
// positional batch); the server starts again; the tab's autosave, still planned against the pre-shutdown base, arrives
// after the restart. Nothing is lost:
// - the CLI write is adopted by hash on restart (in sync, never an external write, never an abort), and the
//   reconnecting tab is told it is behind (hello at the new rev/seq, then resync);
// - the stale autosave merges block-wise (row 10): TJ's change, Claude's edits and the earlier TJ save all reach disk;
// - the sidecar is one contiguous seq run with every event of every writer, attributed TJ / Claude / system only;
// - the review shows Claude's thread and pending suggestion; history has a version per writer.
// Two ways down: a restart (POST /api/agent/shutdown { reason: 'restart' }) keeps the marker, so the same tab, token
// unchanged (D16, §13 #2), reconnects and saves; a kill (SIGTERM) removes it, so the tab reloads (a new client with the
// new token) and sends the draft it kept, still planned against the old base (§12.5).
import type { BatchResult, HistoryList, SaveResponse } from '../../shared/types'
import { opsForText, testCore } from '../helpers/webClient'
import { webClient as makeWebClient } from '../helpers/webClient'
import { expect, openEvents, q, shutdownServer, sidecarEvents, test, tjCall, P1_PORT_OFFSET } from './fixtures/p1'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P1_PORT_OFFSET })

test('CLI direct write while the server is down, then an autosave after restart: no lost event', async ({ webClient, server, cli, tmpRoot }) => {
  // TJ saves once (an open editor session), then his tab plans the next autosave against that base
  const s1 = await webClient.saveText((await webClient.doc()).markdown.replace('paid monthly', 'paid quarterly'))
  expect(s1.applied).toBe('direct')
  const base = await webClient.doc()
  const planned = await opsForText(base.markdown, base.markdown.replace('Final paragraph', 'Closing paragraph'))
  expect(planned.ops).toHaveLength(1)
  const live = await openEvents(webClient)

  // the server goes down for a restart: the tab hears server-shutdown, the open TJ session is flushed, the marker stays
  const token = server.token
  await shutdownServer(server, 'restart')
  expect((await live.next('server-shutdown')).data).toEqual({ reason: 'restart' })
  await live.close()
  expect(tmpRoot.exists('.review/server.json')).toBe(true)

  // Claude, server down: direct mode, under the doc lock
  const b1 = await cli.batch(FILE, {
    ops: [
      { op: 'replace_block', target: { quote: 'The member rate is reviewed every quarter.' }, markdown: 'The member rate is reviewed every month.' },
      { op: 'comment', quote: 'Grow the waitlist', body: 'Is this still the first goal?' },
      { op: 'suggest', quote: 'Ship the explainer page', replace: 'Ship the explainer video', reason: 'video tested better' },
    ],
  })
  expect(b1.code, b1.stdout + b1.stderr).toBe(0)
  const r1 = b1.json as BatchResult
  expect(r1).toMatchObject({ ok: true, via: 'direct', noop: false })
  const b2 = await cli.batch(FILE, { ops: [{ op: 'insert_after', target: { ref: 'b1', rev: r1.rev }, markdown: '_Draft for review._' }] })
  expect(b2.code, b2.stdout + b2.stderr).toBe(0)
  const r2 = b2.json as BatchResult
  expect(r2).toMatchObject({ via: 'direct', rev: r1.rev + 1 })
  const thread = r1.results[1]!.thread!
  const suggestion = r1.results[2]!.suggestion!

  // the server comes back with the same token; the tab reconnects from where it was and is told it is behind
  await server.restart()
  expect(server.token).toBe(token)
  const log = await openEvents(webClient, { afterSeq: base.seq, knownRev: base.rev })
  const hello = log.events[0]!
  expect(hello.event).toBe('hello')
  expect(hello.data).toMatchObject({ rev: r2.rev, seq: r2.seq, hash: r2.hash })
  await log.next('resync')

  // the autosave planned before the shutdown arrives now, against the old base: merged, nothing conflicts
  const c = await testCore()
  const from = log.mark()
  const save: SaveResponse = await webClient.save({
    base: { rev: base.rev, hash: base.hash, blockHashes: planned.blockHashes },
    ops: planned.ops,
    expectHash: c.docHash(planned.text, base.bom),
    cause: 'edit',
    allowPartial: true,
  })
  expect(save).toMatchObject({ applied: 'merged', conflicts: [], unsaveable: [], rev: r2.rev + 1 })
  expect(save.rebased?.markdown).toBe(tmpRoot.read(FILE))
  const dc = await log.next('doc-changed', { from })
  // a block-merged autosave is still a browser save (cause 'edit' → 'save'; 'merge' is only the Keep-mine save, §3.9)
  expect(dc.data).toMatchObject({ by: 'TJ', cause: 'save', rev: save.rev, clientId: webClient.clientId })

  // every change is on disk
  const text = tmpRoot.read(FILE)
  for (const s of ['paid quarterly', 'reviewed every month', '_Draft for review._', 'Closing paragraph']) expect(text).toContain(s)
  expect(text).not.toContain('Ship the explainer video') // a suggestion is not an edit

  // the log: one contiguous seq run, every writer's events, nothing external or aborted
  await tjCall(server, webClient, 'POST', `/api/flush?${q(FILE)}`, { clientId: webClient.clientId, reason: 'beacon' })
  const evs = sidecarEvents(tmpRoot, FILE)
  expect(evs.every((e) => e.__raw === undefined)).toBe(true)
  expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1))
  expect(evs.filter((e) => ['doc.external', 'doc.abort', 'doc.missing'].includes(e.type))).toEqual([])
  expect(new Set(evs.map((e) => e.by))).toEqual(new Set(['system', 'TJ', 'Claude']))
  const revs = evs.filter((e) => e.type === 'doc.rev') as Array<{ rev: number; by: string; cause: string }>
  expect(revs.map((r) => [r.rev, r.by, r.cause])).toEqual([
    [1, 'system', 'baseline'],
    [s1.rev, 'TJ', 'save'],
    [r1.rev, 'Claude', 'cli'],
    [r2.rev, 'Claude', 'cli'],
    [save.rev, 'TJ', 'save'],
  ])
  const edits = evs.filter((e) => e.type === 'doc.edit') as Array<{ by: string; source: string; fromRev: number; toRev: number }>
  expect(edits.map((e) => [e.by, e.source, e.fromRev, e.toRev])).toEqual([
    ['TJ', 'editor', 1, s1.rev], // the shutdown flush of session 1
    ['Claude', 'cli', s1.rev, r1.rev],
    ['Claude', 'cli', r1.rev, r2.rev],
    ['TJ', 'editor', r2.rev, save.rev], // the merged autosave's session, flushed above
  ])
  expect(evs.filter((e) => e.type === 'comment.add' && e.by === 'Claude')).toHaveLength(1)
  expect(evs.filter((e) => e.type === 'suggestion.add' && e.by === 'Claude')).toHaveLength(1)

  // the review: Claude's thread and pending suggestion, both still anchored
  const rv = await webClient.review()
  expect(rv.threads.find((t) => t.id === thread)).toMatchObject({ detached: false, status: 'open' })
  expect(rv.suggestions.find((s) => s.id === suggestion)).toMatchObject({ status: 'pending', by: 'Claude' })

  // history: the shutdown flush, both Claude writes, and the merged session
  const h = await tjCall<HistoryList>(server, webClient, 'GET', `/api/history?${q(FILE)}`)
  expect([...h.json.versions].reverse().map((v) => [v.cause, v.by])).toEqual([
    ['baseline', 'external'],
    ['shutdown', 'TJ'],
    ['claude-write', 'Claude'],
    ['claude-write', 'Claude'],
    ['tj-session', 'TJ'],
  ])
})

test('the server killed instead: the reloaded tab sends its kept draft against the old base, and it merges', async ({ webClient, server, cli, tmpRoot }) => {
  const s1 = await webClient.saveText((await webClient.doc()).markdown.replace('in Q3', 'in Q4'))
  const base = await webClient.doc()
  const planned = await opsForText(base.markdown, base.markdown.replace('A short quote', 'A brief quote'))
  await server.stop() // SIGTERM: close('signal') flushes the session and removes the marker
  const b = await cli.batch(FILE, { ops: [{ op: 'replace_block', target: { ref: 'b1', rev: base.rev }, markdown: '# Launch plan (v2)' }] })
  expect(b.code, b.stdout + b.stderr).toBe(0)
  expect(b.json).toMatchObject({ via: 'direct', rev: base.rev + 1 })
  await server.restart()
  const tab = await makeWebClient({ port: server.port, root: server.root, file: FILE, token: server.token })
  try {
    const c = await testCore()
    const save = await tab.save({
      base: { rev: base.rev, hash: base.hash, blockHashes: planned.blockHashes },
      ops: planned.ops,
      expectHash: c.docHash(planned.text, base.bom),
      cause: 'edit',
      allowPartial: true,
    })
    expect(save).toMatchObject({ applied: 'merged', conflicts: [], rev: base.rev + 2 })
    const text = tmpRoot.read(FILE)
    for (const s of ['in Q4', '# Launch plan (v2)', 'A brief quote']) expect(text).toContain(s)
    const evs = sidecarEvents(tmpRoot, FILE)
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1))
    expect(evs.filter((e) => e.type === 'doc.rev').map((e) => [e.rev, e.by])).toEqual([[1, 'system'], [s1.rev, 'TJ'], [base.rev + 1, 'Claude'], [save.rev, 'TJ']])
    expect(evs.filter((e) => ['doc.external', 'doc.abort'].includes(e.type))).toEqual([])
  } finally {
    await tab.close()
  }
})
