// tests/unit/web/session/qa3-offline.test.ts (QA round 3, editor fixer). The save chip tells the truth fast: Offline as
// soon as the event stream drops (not ~4 s later, after the max-wait save fails), and a server that answers but can't
// write the file is "couldn't save", never "Offline".
import { afterEach, describe, expect, it } from 'vitest'
import { fixture, TestPort, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n'
let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

describe('offline and write failures (QA3)', () => {
  it('a dropped event stream shows Offline at once; the reconnect clears it when nothing failed', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1, 3_000, 'stream open')
    transport.dropStreams()
    expect(session.getSaveState().state).toBe('offline')
    await until(() => transport.openStreamCount() === 1 && session.getSaveState().state === 'saved', 5_000, 'reconnected')
  })

  it('a drop while there are unsaved edits tries the save right away (a dead server shows Offline, edits kept)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1, 3_000, 'stream open')
    port.setText(1, 'First paragraph, typed.')
    transport.failNext('network-error', 10)
    transport.dropStreams()
    await until(() => transport.requestsTo('/api/save', 'POST').length >= 1, 300, 'immediate save attempt')
    expect(session.getSaveState().state).toBe('offline')
  })

  it('a server that answers 500 IO_ERROR on save shows "couldn\'t save" with the reason, keeps retrying, not Offline', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    let fail = true
    transport.intercept((req) => (fail && req.path.startsWith('/api/save') ? { status: 500, json: { ok: false, error: { code: 'IO_ERROR', message: "EACCES: permission denied, open 'doc.md'" } } } : undefined))
    port.setText(1, 'First paragraph, typed.')
    await session.flush().catch(() => undefined)
    await until(() => session.getSaveState().state === 'error', 3_000, 'error state')
    const s = session.getSaveState()
    expect(s.state === 'error' && s.code).toBe('IO_ERROR')
    expect(s.state === 'error' && s.message).toMatch(/can.t write this file/)
    fail = false
    session.retrySave()
    await until(() => session.getSaveState().state === 'saved', 5_000, 'saved after the fix')
    expect(fx.root.read(DOC)).toContain('First paragraph, typed.')
  })
})
