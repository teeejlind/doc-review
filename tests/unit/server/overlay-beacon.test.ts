// tests/unit/server/overlay-beacon.test.ts (P1; CONTRACTS §3.9, §8.6, §7.1). Two server behaviours driven in-process:
// - the presence/activity overlay: every wire ReviewState (GET /api/review, the `review` of a 409), the SSE `hello` and
//   StatusResult carry the handoff module's own values, never the store's, through routes/review.ts#withHandoff;
// - the beacon grace timer: the last SSE stream for a file closing flushes the TJ session with 'beacon' after
//   BEACON_GRACE_MS, and a reconnect inside the grace cancels it.
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docHash } from '../../../core/hash'
import * as S from '../../../shared/schemas'
import type { ClaudeActivity, DocSnapshot, Presence, SaveResponse, SidecarEvent } from '../../../shared/types'
import { opsForText } from '../../helpers/webClient'
import { readSse } from '../../helpers/sse'
import { clientId, inProcessApp, sleep, type InProc } from './server-kit'

const DOC = '# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n'
const PRESENCE: Presence = { waiter: 'connected', waiterId: 'w_00000000000000aa', since: '2026-10-15T12:00:00.000Z' }
const activity = (file: string): ClaudeActivity => ({ file, state: 'working', since: '2026-10-15T12:01:00.000Z', lastSeenAt: '2026-10-15T12:02:00.000Z', unreadFromClaude: 3 })

async function save(ip: InProc, file: string, edit: (s: string) => string, o: { allowPartial?: boolean; base?: DocSnapshot } = {}): Promise<{ status: number; json: SaveResponse & { error?: { code: string }; review?: unknown; current?: unknown } }> {
  const snap = o.base ?? (await ip.json<DocSnapshot>('GET', `/api/doc?file=${file}`)).json
  const next = edit(snap.markdown)
  const { ops, blockHashes } = await opsForText(snap.markdown, next)
  return ip.json('POST', `/api/save?file=${file}`, {
    clientId: clientId(), saveId: Date.now(), base: { rev: snap.rev, hash: snap.hash, blockHashes }, ops,
    expectHash: docHash(next, snap.bom), cause: 'edit', allowPartial: o.allowPartial ?? true,
  })
}

describe('presence/activity overlay (§3.9)', () => {
  let ip: InProc
  beforeAll(async () => {
    ip = await inProcessApp({
      files: { 'doc.md': DOC },
      appOptions: {
        createHandoff: () => ({ routes: new Hono(), presence: () => ({ ...PRESENCE }), activity, close: async () => undefined }),
      },
    })
  })
  afterAll(async () => {
    await ip?.close()
  })

  it('GET /api/review and GET /api/agent/status carry the module\'s values', async () => {
    const r = await ip.json<{ presence: Presence; activity: ClaudeActivity }>('GET', '/api/review?file=doc.md')
    expect(r.status).toBe(200)
    expect(S.ReviewStateSchema.safeParse(r.json).success).toBe(true)
    expect(r.json.presence).toEqual(PRESENCE)
    expect(r.json.activity).toEqual(activity('doc.md'))
    const st = await ip.json<{ presence: Presence; activity: ClaudeActivity }>('GET', '/api/agent/status?file=doc.md')
    expect(st.json.presence).toEqual(PRESENCE)
    expect(st.json.activity).toEqual(activity('doc.md'))
  })

  it('the SSE hello carries them', async () => {
    const r = await ip.req('GET', `/api/events?file=doc.md&clientId=${clientId()}&t=${ip.token}`)
    const ac = new AbortController()
    for await (const f of readSse(r.body!, ac.signal)) {
      if (f.kind !== 'message') continue
      const hello = JSON.parse(f.message.data) as { presence: Presence; activity: ClaudeActivity }
      expect(f.message.event).toBe('hello')
      expect(hello.presence).toEqual(PRESENCE)
      expect(hello.activity).toEqual(activity('doc.md'))
      break
    }
    ac.abort()
  })

  it('a 409 carries current and the overlaid review', async () => {
    const before = (await ip.json<DocSnapshot>('GET', '/api/doc?file=doc.md')).json
    expect((await save(ip, 'doc.md', (s) => s.replace('First', 'Opening'))).status).toBe(200)
    // the same block edited against the old base, strict
    const stale = await save(ip, 'doc.md', (s) => s.replace('First', 'Initial'), { base: before, allowPartial: false })
    expect(stale.status).toBe(409)
    expect(S.ApiErrorSchema.safeParse(stale.json).success).toBe(true)
    const review = stale.json.review as { presence: Presence; activity: ClaudeActivity }
    expect(review.presence).toEqual(PRESENCE)
    expect(review.activity).toEqual(activity('doc.md'))
    expect(S.DocSnapshotSchema.safeParse(stale.json.current).success).toBe(true)
  })
})

describe('beacon grace timer (§7.1, §8.6)', () => {
  let ip: InProc
  const GRACE = 120
  beforeAll(async () => {
    ip = await inProcessApp({ files: { 'doc.md': DOC }, appOptions: { beaconGraceMs: GRACE } })
  })
  afterAll(async () => {
    await ip?.close()
  })

  const editorEdits = (): SidecarEvent[] =>
    ip.sidecar('doc.md').filter((l): l is SidecarEvent => (l as SidecarEvent).type === 'doc.edit' && (l as Extract<SidecarEvent, { type: 'doc.edit' }>).source === 'editor')
  async function openStream(): Promise<{ close(): Promise<void> }> {
    const r = await ip.req('GET', `/api/events?file=doc.md&clientId=${clientId()}&t=${ip.token}`)
    expect(r.status).toBe(200)
    const reader = r.body!.getReader()
    await reader.read() // hello
    return { close: () => reader.cancel() }
  }

  it('the last stream closing flushes the TJ session after the grace; a reconnect inside it cancels the flush', async () => {
    expect((await save(ip, 'doc.md', (s) => s.replace('First', 'Opening'))).status).toBe(200)
    const a = await openStream()
    const b = await openStream()
    await a.close()
    await sleep(GRACE * 3)
    expect(editorEdits()).toHaveLength(0) // b is still open
    await b.close()
    await sleep(GRACE / 3)
    const c = await openStream() // reconnect inside the grace
    await sleep(GRACE * 3)
    expect(editorEdits()).toHaveLength(0)
    await c.close()
    await sleep(GRACE * 4)
    const edits = editorEdits()
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({ by: 'TJ', source: 'editor' })
  })
})
