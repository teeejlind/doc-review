// tests/e2e/p1-history.spec.ts (P1; CONTRACTS §14 P1 E2E, §10, §7.1, D11, D47).
//
// History on the built server, driven as TJ through webClient and as Claude through the CLI (`batch`, routed through
// the server):
// - one `tj-session` version per TJ editor session (several autosaves are one version; a Claude write or a flush ends
//   the session) and one `claude-write` version per Claude write, after the `baseline` of the first write ever;
// - the §10 invariant: a version's `by` is the sole author of every change since the previous version (the diff
//   between neighbours attributes every changed block to that version's author alone);
// - restore (TJ only) is strict on baseRev, writes the target's bytes, adds a `restore` version with `restoredFrom`, and
//   keeps every comment: no thread or message is deleted; a thread whose text is gone is detached and listed.
import type { BatchResult, HistoryDiff, HistoryList, ReviewState, RestoreResponse, VersionShow } from '../../shared/types'
import { newOpKey } from '../helpers/webClient'
import { expect, q, sidecarEvents, test, tjCall, P1_PORT_OFFSET } from './fixtures/p1'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P1_PORT_OFFSET })

test('a version per TJ session and per Claude write; restore keeps every comment', async ({ webClient, server, cli, tmpRoot }) => {
  const original = (await webClient.doc()).markdown
  const flush = () => tjCall(server, webClient, 'POST', `/api/flush?${q(FILE)}`, { clientId: webClient.clientId, reason: 'beacon' })
  const history = async () => {
    const h = await tjCall<HistoryList>(server, webClient, 'GET', `/api/history?${q(FILE)}`)
    expect(h.status, JSON.stringify(h.json)).toBe(200)
    return [...h.json.versions].reverse() // oldest first
  }
  const claude = async (ops: unknown[]) => {
    const r = await cli.batch(FILE, { ops } as never)
    expect(r.code, r.stdout + r.stderr).toBe(0)
    const b = r.json as BatchResult
    expect(b.via).toBe('server')
    return b
  }

  // TJ session 1: two autosaves
  const s1a = await webClient.saveText(original.replace('paid monthly', 'paid quarterly'))
  const s1b = await webClient.saveText((await webClient.doc()).markdown.replace('in Q3', 'in Q4'))
  expect([s1a.applied, s1b.applied]).toEqual(['direct', 'direct'])
  // Claude write 1 (ends the session: its tj-session version comes first)
  const c1 = await claude([{ op: 'replace_block', target: { quote: 'The member rate is reviewed every quarter.' }, markdown: 'The member rate is reviewed every month.' }])
  // TJ session 2: one autosave, then the beacon flush ends it
  const s2 = await webClient.saveText((await webClient.doc()).markdown.replace('Final paragraph', 'Closing paragraph'))
  expect((await flush()).status).toBe(200)
  // Claude write 2
  const c2 = await claude([{ op: 'insert_after', target: { quote: 'Publish the FAQ' }, markdown: 'A note on scope, added by Claude.' }])

  let vs = await history()
  expect(vs.map((v) => [v.cause, v.by])).toEqual([
    ['baseline', 'external'],
    ['tj-session', 'TJ'],
    ['claude-write', 'Claude'],
    ['tj-session', 'TJ'],
    ['claude-write', 'Claude'],
  ])
  expect(vs[1]!.revs).toEqual([s1a.rev, s1b.rev])
  expect(vs[2]!.rev).toBe(c1.rev)
  expect(vs[3]!.revs).toEqual([s2.rev, s2.rev])
  expect(vs[4]!.rev).toBe(c2.rev)
  // the invariant: each version's author is the sole author of everything since the previous one
  for (let i = 1; i < vs.length; i++) {
    const d = await tjCall<HistoryDiff>(server, webClient, 'GET', `/api/history/diff?${q(FILE)}&from=${vs[i - 1]!.v}&to=${vs[i]!.v}`)
    expect(d.status, JSON.stringify(d.json)).toBe(200)
    const changed = d.json.blocks.filter((b) => b.op !== 'equal')
    expect(changed.length, `${vs[i]!.v} changes something`).toBeGreaterThan(0)
    for (const b of changed) expect(b.by, `${vs[i]!.v}: ${JSON.stringify(b)}`).toEqual([vs[i]!.by])
  }
  // and the current text is the last version
  const latest = await tjCall<VersionShow>(server, webClient, 'GET', `/api/history/version?${q(FILE)}&v=${vs[4]!.v}`)
  expect(latest.json.markdown).toBe((await webClient.doc()).markdown)

  // comments from both sides: a doc comment and a reply by TJ, a quote comment by Claude on a paragraph Claude added
  const tjThread = await webClient.createThread({ kind: 'doc' }, 'Overall this reads well.')
  await webClient.reply(tjThread.thread.id, 'One more pass on the goals.')
  const cc = await claude([
    // text the restore removes outright (a partly changed quote now stays attached, QA round 1)
    { op: 'comment', quote: 'A note on scope, added by Claude.', body: 'Is this scope note needed?' },
    { op: 'comment', quote: 'Grow the waitlist', body: 'Still the first goal?' },
  ])
  const monthly = cc.results[0]!.thread!
  const before = await webClient.review()
  expect(before.threads).toHaveLength(3)

  // restore is strict: a stale baseRev is refused, nothing written
  const cur = await webClient.doc()
  const stale = await tjCall<{ error: { code: string } }>(server, webClient, 'POST', `/api/history/restore?${q(FILE)}`, { opKey: newOpKey(), v: vs[0]!.v, baseRev: cur.rev - 1 })
  expect(stale.status).toBe(409)
  expect(stale.json.error.code).toBe('STALE_REVISION')
  expect((await webClient.doc()).rev).toBe(cur.rev)

  // restore the baseline
  const r = await tjCall<RestoreResponse>(server, webClient, 'POST', `/api/history/restore?${q(FILE)}`, { opKey: newOpKey(), v: vs[0]!.v, baseRev: cur.rev })
  expect(r.status, JSON.stringify(r.json)).toBe(200)
  expect(r.json.snapshot.markdown).toBe(original)
  expect(tmpRoot.read(FILE)).toBe(original)
  expect(r.json.detached).toEqual([monthly])
  expect(r.json.version).toMatchObject({ cause: 'restore', by: 'TJ', restoredFrom: vs[0]!.v, rev: r.json.rev })

  // every comment kept: same threads, same messages; only the thread whose text is gone is detached
  const after: ReviewState = await webClient.review()
  expect(after.threads.map((t) => t.id).sort()).toEqual(before.threads.map((t) => t.id).sort())
  for (const t of before.threads) {
    const a = after.threads.find((x) => x.id === t.id)!
    expect(a.messages.map((m) => [m.id, m.body])).toEqual(t.messages.map((m) => [m.id, m.body]))
    expect(a.detached).toBe(t.id === monthly)
  }
  expect(after.threads.find((t) => t.id === tjThread.thread.id)!.messages).toHaveLength(2)
  // the log: the restore commit and a system detach, and no comment.delete anywhere
  const evs = sidecarEvents(tmpRoot, FILE)
  expect(evs.some((e) => e.type === 'comment.delete')).toBe(false)
  expect(evs.find((e) => e.type === 'doc.rev' && e.rev === r.json.rev)).toMatchObject({ by: 'TJ', cause: 'restore' })
  expect(evs.find((e) => e.type === 'doc.edit' && e.rev === r.json.rev)).toMatchObject({ by: 'TJ', source: 'restore', cause: { type: 'restore', id: vs[0]!.v } })
  expect(evs.find((e) => e.type === 'thread.detach')).toMatchObject({ by: 'system', thread: monthly })

  // the restore is a version of its own, newest, by TJ
  vs = await history()
  expect(vs.at(-1)).toMatchObject({ cause: 'restore', by: 'TJ', restoredFrom: vs[0]!.v })
  expect(vs).toHaveLength(6)
})
