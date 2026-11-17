// tests/e2e/p4-direct.spec.ts (P4; CONTRACTS §14 P4 E2E, §9.3 direct mode, §3.6 reconcile, Appendix A, D18).
//
// With no server, the built CLI writes through P1's openDocStore in direct mode (doc lock, WAL, one doc.rev per byte
// write): a comment, an edit and a suggestion, each `via: 'direct'`, and no server is ever started. Then the server
// starts and adopts those writes as Claude's own: the bytes match the ledger, so there is no `doc.external`, the
// history versions are Claude's, TJ's tab sees Claude's markup, and pending (via the server now) has nothing from TJ.
import type { BatchResult, HistoryList, PendingResult, StatusResult } from '../../shared/types'
import { startServer, workerPort } from '../helpers/startServer'
import { webClient as makeWebClient } from '../helpers/webClient'
import { expect, ok, P4_PORT_OFFSET, test } from './fixtures/p4'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P4_PORT_OFFSET })

test('server down: CLI writes go direct; the server then adopts them as Claude, never as external', async ({ cli, tmpRoot }) => {
  test.setTimeout(60_000)
  const abs = cli.abs(FILE)
  const st0 = ok<StatusResult>(await cli.run(['status', abs]))
  expect(st0).toMatchObject({ via: 'direct', server: { state: 'down', port: null }, presence: { waiter: 'none' }, activity: null })

  const c = ok<BatchResult>(await cli.run(['comment', abs, '--quote', 'member rate of 12%', '--body', 'Still current?']))
  expect(c).toMatchObject({ via: 'direct', noop: false, results: [{ op: 'comment', anchor: { state: 'ok', block: 'b2' } }] })
  const e = ok<BatchResult>(await cli.run(['edit-block', abs, '--quote', 'Publish the FAQ', '--md', '- Grow the waitlist\n- Ship the explainer page\n- Publish the FAQ and the glossary']))
  expect(e).toMatchObject({ via: 'direct', noop: false, results: [{ op: 'replace_block' }] })
  expect(e.rev).toBeGreaterThan(c.rev)
  const s = ok<BatchResult>(await cli.run(['suggest', abs, '--quote', 'We launch in Q3.', '--replace', 'We launch in Q3 2026.', '--reason', 'Name the year.']))
  expect(s).toMatchObject({ via: 'direct', results: [{ op: 'suggest', anchor: { state: 'ok' } }] })
  expect(tmpRoot.read(FILE)).toContain('Publish the FAQ and the glossary')
  expect(tmpRoot.exists('.review/server.json'), 'direct mode never starts a server').toBe(false)
  const bytes = tmpRoot.read(FILE)

  // the server starts and reconciles: in sync, so nothing external
  const srv = await startServer({ root: tmpRoot.root, port: workerPort(P4_PORT_OFFSET), home: tmpRoot.home })
  try {
    const tj = await makeWebClient({ port: srv.port, root: tmpRoot.root, file: FILE, token: srv.token })
    try {
      const snap = await tj.doc()
      expect(snap.markdown).toBe(bytes)
      expect(snap.rev).toBe(e.rev)
      const review = await tj.review()
      expect(review.threads.map((t) => [t.kind, t.messages[0]?.by])).toEqual(expect.arrayContaining([['comment', 'Claude'], ['suggestion', 'Claude']]))
      expect(review.suggestions).toMatchObject([{ id: s.results[0]!.suggestion, by: 'Claude', status: 'pending' }])

      const events = tmpRoot.readSidecar(FILE) as Array<{ type?: string; by?: string; rev?: number; cause?: string }>
      expect(events.some((x) => x.type === 'doc.external'), 'adopted, not external').toBe(false)
      const revs = events.filter((x) => x.type === 'doc.rev')
      expect(revs.find((x) => x.rev === e.rev)).toMatchObject({ by: 'Claude' })
      expect(revs.filter((x) => x.by === 'external')).toEqual([])

      const st = ok<StatusResult>(await cli.run(['status', abs]))
      expect(st).toMatchObject({ via: 'server', rev: e.rev, server: { state: 'up', port: srv.port }, needsRecovery: false })
      const hist = ok<HistoryList>(await cli.run(['history', abs]))
      expect(hist.versions.find((v) => v.rev === e.rev)).toMatchObject({ by: 'Claude' })
      // only the baseline (the bytes as they were before mdr first saw the doc) is external; every write after it is Claude's
      expect(hist.versions.filter((v) => v.by === 'external').map((v) => v.cause)).toEqual(['baseline'])
      const p = ok<PendingResult>(await cli.run(['pending', abs]))
      expect(p).toMatchObject({ via: 'server', empty: true, edits: [], external: [] })

      // and the next write goes over HTTP to the adopting server
      const next = ok<BatchResult>(await cli.run(['reply', abs, c.results[0]!.thread!, '--body', 'Following up after the server came back.']))
      expect(next.via).toBe('server')
    } finally {
      await tj.close()
    }
  } finally {
    await srv.stop()
  }
})
