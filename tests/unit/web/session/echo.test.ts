// tests/unit/web/session/echo.test.ts (P2). Echo suppression (CONTRACTS §8.6, D32): rule 1 skips events carrying this
// tab's clientId; rule 2 skips a doc-changed whose hash equals the current Loaded's and a sidecar-changed whose seq
// is at or below the held review's. Neither rule skips a foreign change.
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserSseEvent, ClientId } from '../../../../shared/types'
import { docChangedEcho, sidecarChangedEcho } from '../../../../web/src/session/echo'
import { fixture, TestPort, tick, until, type Fixture } from './helpers'

const ME = 'k_01JAB3K9Q2T7V5X8Y0Z1W2E3R4' as ClientId
const OTHER = 'k_01JAB3K9Q2T7V5X8Y0Z1W2E3R5' as ClientId
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

describe('echo rules (pure)', () => {
  it('doc-changed: own clientId → own-client; same hash → same-hash; otherwise applied', () => {
    expect(docChangedEcho({ clientId: ME, hash: H2 }, { clientId: ME, loadedHash: H1 })).toBe('own-client')
    expect(docChangedEcho({ hash: H1 }, { clientId: ME, loadedHash: H1 })).toBe('same-hash')
    expect(docChangedEcho({ clientId: OTHER, hash: H1 }, { clientId: ME, loadedHash: H1 })).toBe('same-hash')
    expect(docChangedEcho({ clientId: OTHER, hash: H2 }, { clientId: ME, loadedHash: H1 })).toBeNull()
    expect(docChangedEcho({ hash: H2 }, { clientId: ME, loadedHash: H1 })).toBeNull()
  })
  it('sidecar-changed: own clientId → own-client; seq ≤ review.seq → seen-seq; otherwise applied', () => {
    expect(sidecarChangedEcho({ clientId: ME, seq: 9 }, { clientId: ME, reviewSeq: 3 })).toBe('own-client')
    expect(sidecarChangedEcho({ seq: 3 }, { clientId: ME, reviewSeq: 3 })).toBe('seen-seq')
    expect(sidecarChangedEcho({ seq: 2 }, { clientId: ME, reviewSeq: 3 })).toBe('seen-seq')
    expect(sidecarChangedEcho({ seq: 4 }, { clientId: ME, reviewSeq: 3 })).toBeNull()
    expect(sidecarChangedEcho({ clientId: OTHER, seq: 4 }, { clientId: ME, reviewSeq: 3 })).toBeNull()
  })
})

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'

let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

describe('echo suppression in the session', () => {
  it('own save: its doc-changed and sidecar-changed (same clientId) cause no refetch and no reload', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1)
    await tick(30)
    const docGets = transport.requestsTo('/api/doc', 'GET').length
    const reviewGets = transport.requestsTo('/api/review', 'GET').length
    port.setText(1, 'Saved by TJ.')
    await session.flush()
    await tick(150)
    expect(transport.requestsTo('/api/doc', 'GET')).toHaveLength(docGets)
    expect(transport.requestsTo('/api/review', 'GET')).toHaveLength(reviewGets)
    expect(port.reloads).toHaveLength(0)
  })

  it('rule 2: a doc-changed carrying the current hash and a sidecar-changed at the held seq are skipped', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1)
    await tick(30)
    const docGets = transport.requestsTo('/api/doc', 'GET').length
    const reviewGets = transport.requestsTo('/api/review', 'GET').length
    const snap = session.getSnapshot()
    const dc: BrowserSseEvent = {
      event: 'doc-changed',
      data: { file: DOC, rev: snap.rev + 1, prevRev: snap.rev, hash: snap.hash, by: 'external', cause: 'external', changes: [] },
    }
    transport.emit(dc)
    transport.emit({ event: 'sidecar-changed', data: { file: DOC, fromSeq: 0, seq: session.getReview().seq, types: ['comment.add'] } })
    await tick(150)
    expect(transport.requestsTo('/api/doc', 'GET')).toHaveLength(docGets)
    expect(transport.requestsTo('/api/review', 'GET')).toHaveLength(reviewGets)
    expect(port.reloads).toHaveLength(0)
  })

  it('a foreign comment (no clientId, higher seq) refreshes the review; a foreign edit reloads it', async () => {
    fx = await fixture({ file: DOC, markdown: MD })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1)
    await tick(30)
    const seen: string[] = []
    session.subscribe((w) => seen.push(w))
    await fx.agent([{ op: 'comment', doc: true, body: 'From Claude.' }])
    await until(() => session.getReview().threads.some((t) => t.messages.some((m) => m.body === 'From Claude.')), 3_000, 'review refresh')
    expect(seen).toContain('review')
    await fx.agent([{ op: 'replace_block', target: { quote: 'Third paragraph here.' }, markdown: 'Third paragraph, by Claude.' }])
    await until(() => port.reloads.length === 1, 3_000, 'reload')
    expect(port.reloads[0]!.reason).toBe('remote')
    expect(port.text(3)).toBe('Third paragraph, by Claude.')
    expect(session.getSnapshot().markdown).toBe(fx.root.read(DOC))
  })
})
