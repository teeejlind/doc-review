// tests/e2e/p1-faults.spec.ts (P1; CONTRACTS §14 P1 E2E, §1.3 "fault" row, §3.6, §3.8, §4.6, Appendix A, §13 rows 3-7).
//
// Each MDR_FAULT crash point, then recovery, end to end: the built CLI writes in direct mode (the server is down) and
// dies with exit 137 at the fault point (node/fault.ts); the next writer, or the next server, recovers:
// - after-object: an orphan object and nothing else; the server's maintenance (2 s after it opens the doc) GCs it, and
//   the retried write lands with no abort;
// - after-wal: the batch is logged but the bytes never landed; the next writer aborts it (doc.abort not-landed +
//   server.recovered wal), the retry lands at a fresh rev (aborted revs are never reused);
// - after-tmp: the dead writer's tmp file is removed by the next writer, the batch is aborted, the retry lands;
// - after-rename: committed; the retry in the same round is a duplicate with the original result;
// - mid-append:<n>: a torn tail that readers ignore and the next writer truncates (server.recovered torn-tail).
// Plus a crash of the server process itself (after-wal during a TJ save): the marker survives the crash, so the same
// tab, token unchanged, retries after the restart and the save lands after the recovery.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BatchRequest, BatchResult, ReviewState, SaveResponse } from '../../shared/types'
import { FAULT_EXIT, faultEnv } from '../helpers/faults'
import { opsForText, testCore, webClient as makeWebClient, type WebClient } from '../helpers/webClient'
import type { ServerUnderTest } from './fixtures'
import { expect, sha256, shutdownServer, sidecarEvents, sidecarTypes, test, tmpFiles, P1_PORT_OFFSET } from './fixtures/p1'

const FILE = 'basic.md'
const OLD = 'The member rate is reviewed every quarter.'
const NEW = 'The member rate is reviewed every month.'
const EDIT: BatchRequest = { ops: [{ op: 'replace_block', target: { quote: OLD }, markdown: NEW }] }

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P1_PORT_OFFSET })

/** A materialized sidecar (TJ's doc comment), then the server stopped so the CLI goes direct. Returns the doc bytes. */
async function reviewedThenDown(webClient: WebClient, server: ServerUnderTest, tmpRoot: { readBytes(f: string): Buffer }): Promise<Buffer> {
  await webClient.createThread({ kind: 'doc' }, 'Starting the review.')
  await server.stop()
  return tmpRoot.readBytes(FILE)
}

/** A client for the restarted server (a SIGTERM stop removed the marker, so the token is new). */
const clientFor = (server: ServerUnderTest): Promise<WebClient> => makeWebClient({ port: server.port, root: server.root, file: FILE, token: server.token })

const objectsDir = (root: string): string => join(root, '.review', 'history', FILE, 'objects')
const objects = (root: string): string[] => (existsSync(objectsDir(root)) ? readdirSync(objectsDir(root)).filter((n) => n.endsWith('.md.gz')) : [])

test('after-object: an orphan object and nothing else; maintenance GCs it; the retry lands', async ({ webClient, server, cli, tmpRoot }) => {
  const before = await reviewedThenDown(webClient, server, tmpRoot)
  const sidecarBefore = readFileSync(tmpRoot.sidecarPath(FILE))
  const objsBefore = objects(tmpRoot.root)
  const r = await cli.batch(FILE, EDIT, { env: faultEnv('after-object') })
  expect(r.code, r.stdout + r.stderr).toBe(FAULT_EXIT)
  expect(tmpRoot.readBytes(FILE).equals(before)).toBe(true)
  expect(readFileSync(tmpRoot.sidecarPath(FILE)).equals(sidecarBefore), 'nothing appended').toBe(true)
  const orphans = objects(tmpRoot.root).filter((o) => !objsBefore.includes(o))
  expect(orphans).toEqual([`${sha256(Buffer.from(before.toString('utf8').replace(OLD, NEW)))}.md.gz`])

  // the server opens the doc; its first maintenance pass (2 s later) removes the orphan
  await server.restart()
  const c = await clientFor(server)
  try {
    await c.doc()
    await expect.poll(() => objects(tmpRoot.root).filter((o) => orphans.includes(o)), { timeout: 6_000 }).toEqual([])
    const again = await cli.batch(FILE, EDIT)
    expect(again.code, again.stdout + again.stderr).toBe(0)
    expect(again.json).toMatchObject({ via: 'server', noop: false })
    expect(tmpRoot.read(FILE)).toContain(NEW)
    expect(sidecarTypes(tmpRoot, FILE)).not.toContain('doc.abort')
  } finally {
    await c.close()
  }
})

test('after-wal: the next writer aborts the batch that never landed; the retry lands at a fresh rev', async ({ webClient, server, cli, tmpRoot }) => {
  const before = await reviewedThenDown(webClient, server, tmpRoot)
  const n0 = sidecarEvents(tmpRoot, FILE).length
  const r = await cli.batch(FILE, EDIT, { env: faultEnv('after-wal') })
  expect(r.code, r.stdout + r.stderr).toBe(FAULT_EXIT)
  expect(tmpRoot.readBytes(FILE).equals(before), 'the rename never happened').toBe(true)
  const logged = sidecarEvents(tmpRoot, FILE).slice(n0)
  expect(logged.map((e) => e.type)).toEqual(['doc.rev', 'doc.edit'])
  const abortedRev = (logged[0] as { rev: number }).rev
  for (const e of logged) expect(e.wal).toMatchObject({ rev: abortedRev })

  // the server comes back; the retried write recovers the dead batch first
  await server.restart()
  const again = await cli.batch(FILE, EDIT)
  expect(again.code, again.stdout + again.stderr).toBe(0)
  const res = again.json as BatchResult
  expect(res).toMatchObject({ via: 'server', noop: false, rev: abortedRev + 1 })
  expect(res.results[0]!.duplicate).toBeUndefined() // the aborted batch's keys were freed
  const tail = sidecarEvents(tmpRoot, FILE).slice(n0 + 2)
  expect(tail.map((e) => e.type).slice(0, 2)).toEqual(['doc.abort', 'server.recovered'])
  expect(tail[0]).toMatchObject({ abortedRev, reason: 'not-landed', by: 'system' })
  expect(tail[1]).toMatchObject({ what: 'wal' })
  expect(tail.find((e) => e.type === 'doc.rev')).toMatchObject({ by: 'Claude', rev: abortedRev + 1 })
  expect(tmpRoot.read(FILE)).toBe(before.toString('utf8').replace(OLD, NEW))
  const c = await clientFor(server)
  try {
    expect(await c.doc()).toMatchObject({ rev: abortedRev + 1, hash: sha256(tmpRoot.readBytes(FILE)), readOnly: false })
  } finally {
    await c.close()
  }
})

test('after-tmp: the next writer removes the dead tmp file and aborts the batch; the retry lands', async ({ webClient, server, cli, tmpRoot }) => {
  const before = await reviewedThenDown(webClient, server, tmpRoot)
  const r = await cli.batch(FILE, EDIT, { env: faultEnv('after-tmp') })
  expect(r.code, r.stdout + r.stderr).toBe(FAULT_EXIT)
  expect(tmpRoot.readBytes(FILE).equals(before)).toBe(true)
  expect(tmpFiles(tmpRoot)).toHaveLength(1)

  // the next writer is another direct-mode CLI run (the server is still down)
  const again = await cli.batch(FILE, EDIT)
  expect(again.code, again.stdout + again.stderr).toBe(0)
  expect(again.json).toMatchObject({ via: 'direct', noop: false })
  expect(tmpFiles(tmpRoot)).toEqual([])
  const evs = sidecarEvents(tmpRoot, FILE)
  expect(evs.find((e) => e.type === 'doc.abort')).toMatchObject({ reason: 'not-landed' })
  expect(tmpRoot.read(FILE)).toBe(before.toString('utf8').replace(OLD, NEW))
  expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1))
})

test('after-rename: committed; the retry in the same round is a duplicate with the original result', async ({ webClient, server, cli, tmpRoot }) => {
  const before = await reviewedThenDown(webClient, server, tmpRoot)
  const r = await cli.batch(FILE, EDIT, { env: faultEnv('after-rename') })
  expect(r.code, r.stdout + r.stderr).toBe(FAULT_EXIT)
  const committed = before.toString('utf8').replace(OLD, NEW)
  expect(tmpRoot.read(FILE)).toBe(committed)
  const rev = (sidecarEvents(tmpRoot, FILE).filter((e) => e.type === 'doc.rev').at(-1) as { rev: number; by: string })
  expect(rev.by).toBe('Claude')

  const again = await cli.batch(FILE, EDIT)
  expect(again.code, again.stdout + again.stderr).toBe(0)
  const res = again.json as BatchResult
  expect(res).toMatchObject({ via: 'direct', rev: rev.rev })
  expect(res.results[0]).toMatchObject({ duplicate: true })
  expect(tmpRoot.read(FILE)).toBe(committed)
  expect(sidecarTypes(tmpRoot, FILE)).not.toContain('doc.abort')

  // the server reads it as an ordinary committed rev
  await server.restart()
  const c = await clientFor(server)
  try {
    expect(await c.doc()).toMatchObject({ rev: rev.rev, markdown: committed, readOnly: false })
    const rv = await c.review()
    expect(rv.readOnly).toBe(false)
    expect(rv.warnings.filter((w) => w.code === 'NEEDS_RECOVERY')).toEqual([])
  } finally {
    await c.close()
  }
})

test('mid-append:<n>: readers ignore the torn tail; the next writer truncates it and its retry lands', async ({ webClient, server, cli, tmpRoot }) => {
  await reviewedThenDown(webClient, server, tmpRoot)
  const sidecarBefore = readFileSync(tmpRoot.sidecarPath(FILE))
  const two: BatchRequest = { ops: [
    { op: 'comment', quote: 'Grow the waitlist', body: 'Is the waitlist still the first goal?' },
    { op: 'comment', doc: true, body: 'A second note in the same batch.' },
  ] }
  const r = await cli.batch(FILE, two, { env: faultEnv('mid-append:300') })
  expect(r.code, r.stdout + r.stderr).toBe(FAULT_EXIT)
  const torn = readFileSync(tmpRoot.sidecarPath(FILE))
  expect(torn.length).toBe(sidecarBefore.length + 300)
  expect(torn.subarray(0, sidecarBefore.length).equals(sidecarBefore)).toBe(true)
  expect(torn.at(-1)).not.toBe(0x0a) // the last line has no newline: a torn tail

  // readers: the server answers with the log before the partial batch, writable, not corrupt
  await server.restart()
  const c = await clientFor(server)
  try {
    const rv: ReviewState = await c.review()
    expect(rv.readOnly).toBe(false)
    expect(rv.threads.map((t) => t.messages[0]!.body)).toEqual(['Starting the review.'])
    expect(rv.warnings.filter((w) => w.code === 'SIDECAR_INVALID_EVENT')).toEqual([])

    // the next writer (the retry, through the server) truncates the whole partial batch first
    const again = await cli.batch(FILE, two)
    expect(again.code, again.stdout + again.stderr).toBe(0)
    const res = again.json as BatchResult
    expect(res.results.every((x) => x.duplicate === undefined)).toBe(true)
    const evs = sidecarEvents(tmpRoot, FILE)
    expect(evs.every((e) => e.__raw === undefined)).toBe(true)
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1))
    const fromRecovered = evs.slice(evs.findIndex((e) => e.type === 'server.recovered'))
    expect(fromRecovered.map((e) => e.type)).toEqual(['server.recovered', 'comment.add', 'comment.add'])
    expect(fromRecovered[0]).toMatchObject({ what: 'torn-tail' })
    expect((await c.review()).threads).toHaveLength(3)
  } finally {
    await c.close()
  }
})

test('the server process itself crashes after-wal during a TJ save; the same tab retries after the restart', async ({ webClient, server, tmpRoot }) => {
  const orig = (await webClient.doc()).markdown
  await webClient.createThread({ kind: 'doc' }, 'Starting the review.')
  const token = server.token
  // restart it with the fault armed (a restart keeps the marker, so the token, and this tab, stay valid)
  await shutdownServer(server, 'restart')
  await server.restart({ env: faultEnv('after-wal') })
  expect(server.token).toBe(token)
  const snap = await webClient.doc()
  const next = orig.replace('in Q3', 'in Q4')
  const { ops, blockHashes, text } = await opsForText(snap.markdown, next)
  const c = await testCore()
  const req = { base: { rev: snap.rev, hash: snap.hash, blockHashes }, ops, expectHash: c.docHash(text, snap.bom), cause: 'edit' as const, allowPartial: true }
  await expect(webClient.save(req)).rejects.toThrow()
  const exited = await server.real!.proc.exited
  expect(exited.code).toBe(FAULT_EXIT)
  expect(tmpRoot.read(FILE)).toBe(orig)
  // a crash leaves the marker: the restarted server keeps the token, so this tab still talks to it
  expect(tmpRoot.exists('.review/server.json')).toBe(true)
  await server.restart()
  expect(server.token).toBe(token)
  const r: SaveResponse = await webClient.save(req)
  expect(r).toMatchObject({ applied: 'direct', conflicts: [] })
  expect(tmpRoot.read(FILE)).toBe(next)
  const evs = sidecarEvents(tmpRoot, FILE)
  const abort = evs.findIndex((e) => e.type === 'doc.abort')
  expect(abort).toBeGreaterThan(0)
  expect(evs.slice(abort).map((e) => e.type).slice(0, 3)).toEqual(['doc.abort', 'server.recovered', 'doc.rev'])
  expect(evs[abort]).toMatchObject({ reason: 'not-landed' })
  expect(evs.at(-1)).toMatchObject({ type: 'doc.rev', by: 'TJ', rev: r.rev })
})
