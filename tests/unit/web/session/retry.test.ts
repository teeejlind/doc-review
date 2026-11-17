// tests/unit/web/session/retry.test.ts (P2). Duplicate and offline retry (CONTRACTS §12.4, §13 #1, #4): a network
// error or 5xx makes the save state `offline`; the retry re-sends the IDENTICAL request (same saveId: it may have
// landed); a landed-but-unanswered save comes back `duplicate` and is adopted without a second write; after that a
// fresh plan covers anything typed since. Retries fire on the backoff, on retrySave(), and on a hello from a new server.
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserSseEvent, SaveRequest, SaveResponse } from '../../../../shared/types'
import { isSessionError } from '../../../../web/src/session/errors'
import { bodiesTo, fixture, TestPort, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n'

let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

describe('offline retry (§12.4, §13 #1)', () => {
  it('a network error → offline with a 1 s retryAt; retrySave re-sends the identical request', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    port.setText(1, 'Typed while the server was down.')
    transport.failNext('network-error')
    const err = await session.flush().catch((e: unknown) => e)
    expect(isSessionError(err) && err.network).toBe(true)
    const st = session.getSaveState()
    expect(st.state).toBe('offline')
    if (st.state === 'offline') expect(Date.parse(st.retryAt) - Date.parse(st.since)).toBeGreaterThanOrEqual(900)
    expect(fx.root.read(DOC)).toBe(MD)

    session.retrySave()
    await until(() => session.getSaveState().state === 'saved', 3_000, 'saved after retry')
    const saves = bodiesTo<SaveRequest>(transport, '/api/save')
    expect(saves).toHaveLength(2)
    expect(saves[1]).toEqual(saves[0])
    expect(fx.root.read(DOC)).toContain('Typed while the server was down.')
  })

  it('a 5xx is offline too, and the backoff timer retries on its own', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    port.setText(1, 'Retry on the timer.')
    transport.failNext(503)
    await session.flush().catch(() => undefined)
    expect(session.getSaveState().state).toBe('offline')
    await until(() => session.getSaveState().state === 'saved', 4_000, 'backoff retry')
    const saves = bodiesTo<SaveRequest>(transport, '/api/save')
    expect(saves).toHaveLength(2)
    expect(saves[1]!.saveId).toBe(saves[0]!.saveId)
  })

  it('a hello from a new serverId retries at once (server restart)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1, 3_000, 'stream')
    await new Promise((r) => setTimeout(r, 50))
    port.setText(1, 'Saved after the restart.')
    transport.failNext('network-error')
    await session.flush().catch(() => undefined)
    expect(session.getSaveState().state).toBe('offline')
    const snap = session.getSnapshot()
    const hello: BrowserSseEvent = {
      event: 'hello',
      data: {
        serverId: 'restarted-server', protocol: 2, version: fx.boot.version, schemaFingerprint: fx.boot.schemaFingerprint, file: DOC,
        docId: snap.docId, rev: snap.rev, hash: snap.hash, seq: session.getReview().seq, presence: { waiter: 'none' },
        activity: session.getReview().activity,
      },
    }
    transport.emit(hello)
    await until(() => session.getSaveState().state === 'saved', 900, 'immediate retry on new serverId')
    expect(bodiesTo(transport, '/api/save')).toHaveLength(2)
  })
})

describe('duplicate retry (§12.4, §13 #4)', () => {
  it('a save that landed but whose answer was lost comes back duplicate: adopted, written once; then a fresh plan', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    let dropNext = true
    transport.intercept(async (req) => {
      if (req.path.startsWith('/api/save') && dropNext) {
        dropNext = false
        // let it land on the server, then lose the answer
        await fx!.fa.fetch(new Request(`http://127.0.0.1:${fx!.fa.port}${req.path}`, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) }))
        return 'network-error'
      }
      return undefined
    })
    port.setText(1, 'Landed once.')
    await session.flush().catch(() => undefined)
    expect(session.getSaveState().state).toBe('offline')
    expect(fx.root.read(DOC)).toContain('Landed once.')
    const revAfterLanding = (await (await fx.fa.store(DOC)).snapshot()).rev

    session.retrySave()
    await until(() => session.getSaveState().state === 'saved', 3_000, 'saved')
    const res = transport.requestsTo('/api/save', 'POST')
    expect(res).toHaveLength(2) // the intercepted one and the identical retry
    expect(res[1]!.body).toEqual(res[0]!.body)
    expect(res[1]!.status).toBe(200)
    // adopted from the response: no reload fetch was needed
    expect(transport.requestsTo('/api/doc', 'GET')).toHaveLength(1)
    expect((await (await fx.fa.store(DOC)).snapshot()).rev).toBe(revAfterLanding)
    expect(session.getSnapshot().rev).toBe(revAfterLanding)

    // anything typed since goes out as a fresh plan with a new saveId
    port.setText(2, 'Typed after the retry.')
    await session.flush()
    const saves = bodiesTo<SaveRequest>(transport, '/api/save')
    expect(saves).toHaveLength(3)
    expect(saves[2]!.saveId).toBeGreaterThan(saves[0]!.saveId)
    expect(saves[2]!.base.rev).toBe(revAfterLanding)
    expect(fx.root.read(DOC)).toBe('# Title\n\nLanded once.\n\nTyped after the retry.\n')
  })

  it('a duplicate answer whose hash we cannot reproduce falls back to GET /api/doc and the reload path', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    port.setText(1, 'Mine.')
    transport.intercept((req) => {
      if (!req.path.startsWith('/api/save')) return undefined
      const r = req.body as SaveRequest
      const out: SaveResponse = {
        ok: true, applied: 'duplicate', rev: r.base.rev + 5, hash: 'f'.repeat(64), seq: 99, conflicts: [], unsaveable: [], warnings: [],
        staled: [], rebasedSuggestions: [],
      }
      return { status: 200, json: out }
    })
    await session.flush()
    expect(transport.requestsTo('/api/doc', 'GET').length).toBeGreaterThanOrEqual(2)
    expect(port.reloads.at(-1)?.reason).toBe('remote')
  })
})
