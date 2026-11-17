// tests/unit/web/session/save-flow.test.ts (P2). The autosave round trip over MockTransport + fakeApp (CONTRACTS §12.4):
// a typed edit saves block-scoped, `expectHash` is the doc hash WITH the BOM (D40), the save state machine walks
// unsaved -> saving -> saved, and IME composition defers the flush to compositionend (§13 #63).
import { afterEach, describe, expect, it } from 'vitest'
import { docHash } from '../../../../core/hash'
import type { SaveRequest, SaveState } from '../../../../shared/types'
import { bodiesTo, fixture, TestPort, tick, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'

let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

describe('autosave round trip (§12.4)', () => {
  it('saves one edited block with expectHash = docHash(text) and walks unsaved → saving → saved', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    const states: SaveState['state'][] = []
    session.subscribe((w) => {
      if (w === 'save') states.push(session.getSaveState().state)
    })
    expect(session.getSaveState().state).toBe('saved')
    port.setText(2, 'Second paragraph, edited.')
    expect(session.getSaveState().state).toBe('unsaved')
    await session.flush()
    expect(session.getSaveState().state).toBe('saved')
    expect(states).toEqual(['unsaved', 'saving', 'saved'])
    const saves = bodiesTo<SaveRequest>(transport, '/api/save')
    expect(saves).toHaveLength(1)
    const req = saves[0]!
    expect(req.ops).toHaveLength(1)
    expect(req.ops[0]!.blocks).toEqual(['Second paragraph, edited.'])
    expect(req.cause).toBe('edit')
    expect(req.allowPartial).toBe(true)
    const disk = fx.root.read(DOC)
    expect(disk).toBe('# Title\n\nFirst paragraph here.\n\nSecond paragraph, edited.\n\nThird paragraph here.\n')
    expect(req.expectHash).toBe(docHash(disk, false))
    expect(session.getSnapshot().markdown).toBe(disk)
    expect(session.getSnapshot().hash).toBe(req.expectHash)
    // the next plan is empty: nothing more is sent
    await session.flush()
    expect(bodiesTo(transport, '/api/save')).toHaveLength(1)
  })

  it('expectHash includes the BOM (doc-hash domain, D40) and the server accepts it as a direct save', async () => {
    fx = await fixture({ file: DOC, markdown: Buffer.from('﻿' + MD, 'utf8') })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    expect(session.getSnapshot().bom).toBe(true)
    port.setText(3, 'Third paragraph, BOM edit.')
    await session.flush()
    const req = bodiesTo<SaveRequest>(transport, '/api/save')[0]!
    const text = MD.replace('Third paragraph here.', 'Third paragraph, BOM edit.')
    expect(req.expectHash).toBe(docHash(text, true))
    expect(req.expectHash).not.toBe(docHash(text, false))
    const res = transport.requestsTo('/api/save', 'POST')[0]!
    expect(res.status).toBe(200)
    expect(fx.root.readBytes(DOC).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(session.getSaveState().state).toBe('saved')
  })

  it('the debounce fires one save after AUTOSAVE_DEBOUNCE_MS of quiet', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    port.setText(2, 'a')
    await tick(200)
    port.setText(2, 'ab')
    await tick(200)
    port.setText(2, 'abc')
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
    await until(() => session.getSaveState().state === 'saved' && bodiesTo(transport, '/api/save').length === 1, 3_000, 'debounced save')
    expect(bodiesTo<SaveRequest>(transport, '/api/save')[0]!.ops[0]!.blocks).toEqual(['abc'])
  })

  it('never flushes while composing (IME); the pending flush runs at compositionend', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, internals, transport } = await fx.open({ port })
    port.composing = true
    port.setText(2, 'かな')
    await tick(800)
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
    expect(session.getSaveState().state).toBe('unsaved')
    // a blur while composing is deferred too
    internals.blurred()
    await tick(50)
    expect(bodiesTo(transport, '/api/save')).toHaveLength(0)
    port.composing = false
    internals.compositionEnded()
    await until(() => bodiesTo(transport, '/api/save').length === 1, 3_000, 'save at compositionend')
    await until(() => session.getSaveState().state === 'saved', 3_000, 'saved')
    expect(fx.root.read(DOC)).toContain('かな')
  })
})
