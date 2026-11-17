// tests/e2e/p1-external.spec.ts (P1; CONTRACTS §14 P1 E2E, §3.6, §8.6, D18, D32, §13 rows 8, 11, 28).
//
// An external write (another tool, an editor, git) reaches TJ's tab through the built server's scoped watcher:
// `doc-changed` on webClient.events() in < 1 s, `by: 'external'`, never TJ, never stamped with a clientId, carrying the
// new markdown and the block changes; then `sidecar-changed` with the recorded `doc.external`. Covered here: an in-place
// write while TJ's editor session is open (the external change never lands in TJ's session), an atomic tmp + rename
// write, and a never-written doc (the ledger starts from the bytes the server saw).
import { renameSync } from 'node:fs'
import type { BlockChange, HistoryList } from '../../shared/types'
import { webClient } from '../helpers/webClient'
import { expect, openEvents, q, sha256, sidecarEvents, sleep, test, tjCall, P1_PORT_OFFSET } from './fixtures/p1'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE, 'syn__bom-crlf.md'], docFile: FILE, portOffset: P1_PORT_OFFSET })

/** Time the watcher needs to be listening after the doc is first opened (chokidar add is asynchronous). */
const WATCH_SETTLE_MS = 300

const mdOf = (c: BlockChange): string => [c.before?.md ?? '', c.after?.md ?? ''].join('\n')

test('an in-place write during an open TJ session: doc-changed by external in < 1 s, never TJ', async ({ webClient, tmpRoot, server }) => {
  const orig = (await webClient.doc()).markdown
  // TJ has an unflushed editor session open on another block
  const tj = await webClient.saveText(orig.replace('monthly', 'quarterly'))
  expect(tj.applied).toBe('direct')
  const log = await openEvents(webClient)
  expect(log.events[0]!.event).toBe('hello')
  await sleep(WATCH_SETTLE_MS)

  const from = log.mark()
  const next = tmpRoot.read(FILE).replace('Publish the FAQ', 'Publish the FAQ and the glossary')
  const t0 = Date.now()
  tmpRoot.write(FILE, next)
  const dc = await log.next('doc-changed', { from, timeoutMs: 3_000 })
  expect(dc.at - t0, 'external write → doc-changed latency').toBeLessThan(1_000)
  expect(dc.data).toMatchObject({ file: FILE, by: 'external', cause: 'external', markdown: next, prevRev: tj.rev })
  expect(dc.data).not.toHaveProperty('clientId')
  expect(dc.data).not.toHaveProperty('saveId')
  expect(dc.data.changes.length).toBe(1)
  expect(mdOf(dc.data.changes[0]!)).toContain('glossary')

  // TJ's open session is flushed first (its own doc.edit), then the external batch is recorded
  const sc = await log.next('sidecar-changed', { from, where: (e) => e.data.types.includes('doc.external') })
  expect(sc.data.types).toEqual(['doc.rev', 'doc.external'])
  expect(sc.data).not.toHaveProperty('clientId')
  const flushed = log.all('sidecar-changed', from).filter((e) => e.data.types.includes('doc.edit'))
  expect(flushed).toHaveLength(1)
  expect(flushed[0]!.data.seq).toBeLessThan(sc.data.fromSeq + 1)
  const tail = await log.settle(from)
  expect(tail.filter((e) => e.event === 'doc-changed').map((e) => (e.data as { by: string }).by)).toEqual(['external'])

  // the server serves the new bytes at the announced rev
  const snap = await webClient.doc()
  expect({ markdown: snap.markdown, rev: snap.rev }).toEqual({ markdown: next, rev: dc.data.rev })

  // the ledger: the external rev and doc.external are external's; TJ's session never absorbs the external change
  await tjCall(server, webClient, 'POST', `/api/flush?${q(FILE)}`, { clientId: webClient.clientId, reason: 'beacon' })
  const evs = sidecarEvents(tmpRoot, FILE)
  const revs = evs.filter((e) => e.type === 'doc.rev') as Array<{ rev: number; by: string; cause: string }>
  expect(revs.find((r) => r.rev === dc.data.rev)).toMatchObject({ by: 'external', cause: 'external' })
  expect(revs.filter((r) => r.by === 'TJ').map((r) => r.rev)).toEqual([tj.rev])
  const ext = evs.filter((e) => e.type === 'doc.external') as Array<{ by: string; changes: BlockChange[] | null }>
  expect(ext).toHaveLength(1)
  expect(ext[0]!.by).toBe('external')
  expect(ext[0]!.changes!.map(mdOf).join('\n')).toContain('glossary')
  const tjEdits = evs.filter((e) => e.type === 'doc.edit' && e.by === 'TJ') as Array<{ changes: BlockChange[] }>
  expect(tjEdits.length).toBeGreaterThan(0)
  for (const e of tjEdits) {
    const text = e.changes.map(mdOf).join('\n')
    expect(text).toContain('quarterly')
    expect(text).not.toContain('glossary')
  }
  // and history snapshots the external change as an external version
  const hist = await tjCall<HistoryList>(server, webClient, 'GET', `/api/history?${q(FILE)}`)
  expect(hist.status).toBe(200)
  expect(hist.json.versions.find((v) => v.rev === dc.data.rev)).toMatchObject({ by: 'external', cause: 'external' })
})

test('an atomic tmp + rename write (an editor or tool save) is seen the same way', async ({ webClient, tmpRoot }) => {
  await webClient.saveText((await webClient.doc()).markdown.replace('Q3', 'Q4'))
  const log = await openEvents(webClient)
  await sleep(WATCH_SETTLE_MS)
  const from = log.mark()
  const next = tmpRoot.read(FILE).replace('A short quote', 'A shorter quote')
  const t0 = Date.now()
  tmpRoot.write('.basic.md.swp.tmp', next)
  renameSync(tmpRoot.path('.basic.md.swp.tmp'), tmpRoot.path(FILE))
  const dc = await log.next('doc-changed', { from, timeoutMs: 3_000 })
  expect(dc.at - t0).toBeLessThan(1_000)
  expect(dc.data).toMatchObject({ by: 'external', cause: 'external', markdown: next })
  expect(dc.data).not.toHaveProperty('clientId')
  await log.next('sidecar-changed', { from, where: (e) => e.data.types.includes('doc.external') })
  expect((await webClient.doc()).markdown).toBe(next)
})

test('a never-written doc: the ledger starts from the bytes the server saw, then the external rev', async ({ server, tmpRoot }) => {
  const FRESH = 'syn__bom-crlf.md'
  const c = await webClient({ port: server.port, root: server.root, file: FRESH, token: server.token })
  try {
    const raw = tmpRoot.readBytes(FRESH)
    const snap = await c.doc()
    expect(snap).toMatchObject({ rev: 0, docId: null, bom: true, eol: '\r\n' })
    const log = await openEvents(c)
    await sleep(WATCH_SETTLE_MS)
    expect(tmpRoot.exists(`${FRESH}.review.jsonl`)).toBe(false)

    const from = log.mark()
    const next = raw.toString('utf8').replace('BOM file', 'BOM-marked file')
    const t0 = Date.now()
    tmpRoot.write(FRESH, next)
    const dc = await log.next('doc-changed', { from, timeoutMs: 3_000 })
    expect(dc.at - t0).toBeLessThan(1_000)
    expect(dc.data).toMatchObject({ by: 'external', cause: 'external', markdown: next.slice(1), prevRev: 1, rev: 2 })
    expect(dc.data).not.toHaveProperty('clientId')

    // header, the baseline of the bytes the server saw, then the external rev and its doc.external
    const evs = sidecarEvents(tmpRoot, FRESH)
    const revs = evs.filter((e) => e.type === 'doc.rev') as Array<{ rev: number; by: string; cause: string; hash: string }>
    expect(revs.map((r) => [r.rev, r.cause])).toEqual([[1, 'baseline'], [2, 'external']])
    expect(revs[0]!.hash).toBe(sha256(raw))
    expect(revs[1]).toMatchObject({ by: 'external', hash: sha256(Buffer.from(next, 'utf8')) })
    expect(evs.filter((e) => e.type === 'doc.external')).toHaveLength(1)
    expect(evs.some((e) => e.by === 'TJ')).toBe(false)
    // the BOM and the CRLFs are the external writer's, kept byte for byte
    expect(tmpRoot.readBytes(FRESH).toString('utf8')).toBe(next)
  } finally {
    await c.close()
  }
})
