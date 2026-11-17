// tests/unit/web/session/qa4-auth-lost.test.ts (QA pass 4 #3). A server restart mints a new session token; the open
// page keeps the old one and every call answers 401 UNAUTHORIZED. The page must stop retrying, say in plain words that
// it lost its connection (banner "connection-lost" with Reload), show no raw error code, and keep unsaved text in the
// local draft store so Reload brings it back.
import { afterEach, describe, expect, it } from 'vitest'
import { draftKey, memoryDraftStore } from '../../../../web/src/session/drafts'
import { fixture, TestPort, tick, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n'
let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

const unauthorized = { status: 401, json: { ok: false, error: { code: 'UNAUTHORIZED', message: 'wrong token' } } }

describe('the server came back with a new token (QA pass 4 #3)', () => {
  it('a save answered 401 raises the connection-lost banner, stops retrying, shows no error code, keeps the text in the draft store', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const drafts = memoryDraftStore()
    let reloaded = 0
    const { session, transport } = await fx.open({ port, env: { drafts, reloadPage: () => void reloaded++ } })
    transport.intercept((req) => (req.path.startsWith('/api/') ? unauthorized : undefined))
    port.setText(1, 'Typed after the restart.')
    await session.flush().catch(() => undefined)
    await until(() => session.getBanner()?.kind === 'connection-lost', 3_000, 'banner')
    const st = session.getSaveState()
    expect(st.state).toBe('readonly')
    expect(JSON.stringify(st)).not.toMatch(/UNAUTHORIZED|wrong token/)
    expect(port.editable).toBe(false)
    const saves = transport.requestsTo('/api/save', 'POST').length
    session.retrySave()
    await tick(1_500)
    expect(transport.requestsTo('/api/save', 'POST').length).toBe(saves)
    await session.reload()
    expect(reloaded).toBe(1)
    const rec = drafts.map.get(draftKey(fx.boot.rootHash, DOC))!
    expect(port.md.schema.nodeFromJSON(rec.liveDoc).child(1).textContent).toBe('Typed after the restart.')
  })

  it('a comment post answered 401 raises the same banner', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    transport.intercept((req) => (req.path.startsWith('/api/') ? unauthorized : undefined))
    await session.handoff('hello').catch(() => undefined)
    await until(() => session.getBanner()?.kind === 'connection-lost', 3_000, 'banner')
  })

  it('a dropped event stream whose reconnect probe is refused with 401 raises the banner and closes the stream', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1, 3_000, 'stream open')
    transport.intercept((req) => (req.path.startsWith('/api/review') ? unauthorized : undefined))
    transport.dropStreams()
    await until(() => session.getBanner()?.kind === 'connection-lost', 3_000, 'banner')
    await tick(1_500)
    expect(transport.openStreamCount()).toBe(0)
  })
})
