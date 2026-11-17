// tests/e2e/p1-echo.spec.ts (P1; CONTRACTS §14 P1 E2E, §8.6, D32, D47, Appendix A "after unlock").
//
// Echo stamping on the built server: every commit is announced in seq order as `doc-changed` then `sidecar-changed`,
// and a browser write stamps BOTH with the writing tab's clientId (a save adds its saveId), so that tab can drop its own
// echo and every other tab sees someone else's id and reloads. Covered: a webClient accept, a restore made through the
// same tab, a plain autosave; and the CLI (the day-0 shell's `batch`, routed through the running server): a suggestion
// (sidecar only) and a block edit (doc and sidecar), neither of which carries a clientId or a saveId.
import type { BatchResult, DocSnapshot, HistoryList, RestoreResponse } from '../../shared/types'
import { newOpKey, webClient as makeWebClient } from '../helpers/webClient'
import { expect, openEvents, q, test, tjCall, type EventLog, P1_PORT_OFFSET } from './fixtures/p1'

const FILE = 'basic.md'

test.use({ fixtureFiles: [FILE], docFile: FILE, portOffset: P1_PORT_OFFSET })

/** The doc-changed + sidecar-changed pair of the next byte commit after `from` whose sidecar batch has `type`. */
async function commitPair(log: EventLog, from: number, type: string) {
  const sc = await log.next('sidecar-changed', { from, where: (e) => e.data.types.includes(type as never) })
  const dc = await log.next('doc-changed', { from })
  expect(log.events.indexOf(dc), 'doc-changed precedes its sidecar-changed').toBeLessThan(log.events.indexOf(sc))
  return { dc, sc }
}

test('a webClient accept and a restore carry its clientId on both SSE events; a CLI write carries none', async ({ webClient, server, cli }) => {
  const other = await makeWebClient({ port: server.port, root: server.root, file: FILE, token: server.token })
  try {
    const mine = await openEvents(webClient)
    const theirs = await openEvents(other)
    const original = (await webClient.doc()).markdown

    // 1. Claude suggests through the CLI (server up): a sidecar-only commit, never stamped
    let m = mine.mark()
    const sug = await cli.batch(FILE, { ops: [{ op: 'suggest', quote: 'paid monthly', replace: 'paid quarterly', reason: 'cadence changed' }] })
    expect(sug.code, sug.stdout + sug.stderr).toBe(0)
    const sugRes = sug.json as BatchResult
    expect(sugRes.via).toBe('server')
    const sid = sugRes.results[0]!.suggestion!
    const s0 = await mine.next('sidecar-changed', { from: m, where: (e) => e.data.types.includes('suggestion.add') })
    expect(s0.data).not.toHaveProperty('clientId')
    expect(mine.all('doc-changed', m)).toEqual([])

    // 2. TJ accepts in this tab: both events carry this tab's clientId; the other tab sees the same stamp
    m = mine.mark()
    let t = theirs.mark()
    const d = await webClient.decide(sid, 'accept')
    expect(d.status).toBe('accepted')
    const acc = await commitPair(mine, m, 'suggestion.accept')
    expect(acc.dc.data).toMatchObject({ by: 'TJ', cause: 'accept', rev: d.rev, hash: d.hash, clientId: webClient.clientId })
    expect(acc.dc.data).not.toHaveProperty('saveId')
    expect(acc.sc.data.clientId).toBe(webClient.clientId)
    const accOther = await commitPair(theirs, t, 'suggestion.accept')
    expect(accOther.dc.data.clientId).toBe(webClient.clientId)
    expect(accOther.sc.data.clientId).toBe(webClient.clientId)
    expect(accOther.dc.data.clientId).not.toBe(other.clientId)

    // 3. an autosave from this tab: stamped with clientId and saveId
    m = mine.mark()
    const save = await webClient.saveText((await webClient.doc()).markdown.replace('Q3', 'Q4'))
    expect(save.applied).toBe('direct')
    const sv = await commitPair(mine, m, 'doc.rev')
    expect(sv.dc.data).toMatchObject({ by: 'TJ', cause: 'save', rev: save.rev, clientId: webClient.clientId })
    expect(typeof sv.dc.data.saveId).toBe('number')
    expect(sv.sc.data.clientId).toBe(webClient.clientId)

    // 4. a restore through this tab (the baseline version): both events stamped; the response carries the snapshot
    const hist = await tjCall<HistoryList>(server, webClient, 'GET', `/api/history?${q(FILE)}`)
    expect(hist.status).toBe(200)
    const baseline = hist.json.versions.find((v) => v.cause === 'baseline')!
    expect(baseline).toBeDefined()
    m = mine.mark()
    t = theirs.mark()
    const cur = await webClient.doc()
    const rs = await tjCall<RestoreResponse>(server, webClient, 'POST', `/api/history/restore?${q(FILE)}`, { opKey: newOpKey(), v: baseline.v, baseRev: cur.rev })
    expect(rs.status, JSON.stringify(rs.json)).toBe(200)
    const fresh: DocSnapshot = await webClient.doc()
    expect(rs.json.snapshot).toEqual(fresh)
    expect(fresh.markdown).toBe(original)
    const res = await commitPair(mine, m, 'doc.rev')
    expect(res.dc.data).toMatchObject({ by: 'TJ', cause: 'restore', rev: rs.json.rev, clientId: webClient.clientId })
    expect(res.sc.data.clientId).toBe(webClient.clientId)
    expect(res.sc.data.types).toContain('doc.edit')
    const resOther = await commitPair(theirs, t, 'doc.rev')
    expect(resOther.dc.data.clientId).toBe(webClient.clientId)

    // 5. a CLI block edit through the server: by Claude, neither event stamped
    m = mine.mark()
    t = theirs.mark()
    const ed = await cli.batch(FILE, { ops: [{ op: 'replace_block', target: { quote: 'A short quote for context.' }, markdown: '> A longer quote, for context.' }] })
    expect(ed.code, ed.stdout + ed.stderr).toBe(0)
    const edRes = ed.json as BatchResult
    expect(edRes.via).toBe('server')
    for (const log of [mine, theirs]) {
      const p = await commitPair(log, log === mine ? m : t, 'doc.rev')
      expect(p.dc.data).toMatchObject({ by: 'Claude', rev: edRes.rev, hash: edRes.hash })
      expect(p.dc.data).not.toHaveProperty('clientId')
      expect(p.dc.data).not.toHaveProperty('saveId')
      expect(p.sc.data).not.toHaveProperty('clientId')
    }
    // nothing after the CLI commit claims to be this tab's
    const tail = await mine.settle(m)
    for (const e of tail) expect(e.data as object).not.toHaveProperty('clientId')
  } finally {
    await other.close()
  }
})
