// tests/unit/web/session/restore.test.ts (P2). Restore adoption (CONTRACTS §10, D47, §13 #64): history.restore is a
// queue item (a dirty editor is flushed first); on 200 the session runs the reload path with
// RestoreResponse.snapshot BEFORE the promise resolves, drops the SSE echo of that commit, and the next edit saves
// against the restored text; on 409 STALE_REVISION it adopts `current` and rejects.
import { afterEach, describe, expect, it } from 'vitest'
import type { DocSnapshot, RestoreRequest, SaveRequest, VersionId } from '../../../../shared/types'
import { isSessionError } from '../../../../web/src/session/errors'
import { bodiesTo, fixture, TestPort, tick, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n'

let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

/** Claude rewrites the second paragraph, so history holds the original as an older version. */
async function withHistory(f: Fixture): Promise<VersionId> {
  await f.agent([{ op: 'replace_block', target: { quote: 'Second paragraph here.' }, markdown: 'Second paragraph, rewritten by Claude.' }])
  const list = await (await f.fa.store(DOC)).history.list()
  const original = list.versions.find((v) => v.hash !== list.currentHash)
  if (!original) throw new Error(`no older version in ${JSON.stringify(list.versions)}`)
  return original.v
}

describe('history.restore (§10, D47)', () => {
  it('adopts RestoreResponse.snapshot through the reload path before resolving, and drops the echo', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const v = await withHistory(fx)
    const port = await TestPort.create()
    const { session, internals, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1)
    await tick(30)
    expect(port.text(2)).toBe('Second paragraph, rewritten by Claude.')

    const r = await session.history.restore(v)
    // already adopted when the promise resolved
    expect(port.reloads.map((x) => x.reason)).toEqual(['restore'])
    expect(port.text(2)).toBe('Second paragraph here.')
    expect(internals.getLoaded()!.src).toBe(r.snapshot.markdown)
    expect(session.getSnapshot()).toEqual(r.snapshot)
    expect(fx.root.read(DOC)).toBe(MD)
    const docGets = transport.requestsTo('/api/doc', 'GET').length

    // the commit's doc-changed carries our clientId and the adopted hash: dropped
    await tick(200)
    expect(port.reloads).toHaveLength(1)
    expect(transport.requestsTo('/api/doc', 'GET')).toHaveLength(docGets)

    // the next edit saves against the restored text (row 64)
    port.setText(1, 'First paragraph, after the restore.')
    await session.flush()
    const save = bodiesTo<SaveRequest>(transport, '/api/save').at(-1)!
    expect(save.base.rev).toBe(r.rev)
    expect(save.base.hash).toBe(r.hash)
    expect(fx.root.read(DOC)).toBe('# Title\n\nFirst paragraph, after the restore.\n\nSecond paragraph here.\n')
  })

  it('a dirty editor is flushed before the restore is sent (queue rule, §12.3)', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const v = await withHistory(fx)
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    port.setText(1, 'Typed just before restoring.')
    const r = await session.history.restore(v)
    const writes = transport.requests.filter((x) => x.method === 'POST').map((x) => x.path.split('?')[0])
    expect(writes.indexOf('/api/save')).toBeGreaterThan(-1)
    expect(writes.indexOf('/api/save')).toBeLessThan(writes.indexOf('/api/history/restore'))
    const req = bodiesTo<RestoreRequest>(transport, '/api/history/restore')[0]!
    // the restore is strict against the rev the flush produced (restore commits the next rev)
    expect(req.baseRev).toBe(r.rev - 1)
    expect(fx.root.read(DOC)).toBe(MD)
    expect(req.opKey).toMatch(/^op_/)
  })

  it('409 STALE_REVISION: adopts `current` through the reload path, then rejects so P3 can re-offer', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const v = await withHistory(fx)
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    const real = (await (await fx.fa.store(DOC)).snapshot()) as DocSnapshot
    // someone wrote since the panel loaded: the server answers with a newer `current`
    await fx.agent([{ op: 'replace_block', target: { quote: 'First paragraph here.' }, markdown: 'First paragraph, newer.' }])
    const current = (await (await fx.fa.store(DOC)).snapshot()) as DocSnapshot
    expect(current.rev).toBeGreaterThan(real.rev)
    transport.intercept((req) => req.path.startsWith('/api/history/restore')
      ? { status: 409, json: { ok: false, error: { code: 'STALE_REVISION', message: 'stale' }, current } }
      : undefined)
    const err = await session.history.restore(v).catch((e: unknown) => e)
    expect(isSessionError(err) && err.code).toBe('STALE_REVISION')
    expect(port.reloads.some((x) => x.reason === 'restore')).toBe(true)
    expect(port.text(1)).toBe('First paragraph, newer.')
    expect(session.getSnapshot().rev).toBe(current.rev)
  })
})
