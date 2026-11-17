// tests/unit/core/pending/interleave.test.ts (P4; CONTRACTS §9.6 "nothing missing, nothing repeated", D33, §13 #86).
//
// buildPending driven through P1's real doc store (server mode on a tmp root; it calls this digest): TJ's sessions
// flushed by `pending`, an
// accepted suggestion reported exactly once, an edit past CHANGE_MD_CAP inside a long block reported (never dropped),
// and a fast-check property over random interleavings of TJ events, `pending` and `ack`: every TJ item made since the
// last ack is in the next pending, and nothing an ack covered ever comes back as new.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import type { CommentId, DocStore, PendingResult, ThreadId } from '../../../../shared/types'
import { CONSTANTS } from '../../../../shared/constants'
import * as S from '../../../../shared/schemas'
import { docHash } from '../../../../core/hash'
import '../../../../node/dom'
import { openDocStore } from '../../../../node/docstore'
import { realId } from '../../../../node/root'
import { newClientId, newOpKey, opsForText } from '../../../helpers/webClient'

const LONG = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ') // > CHANGE_MD_CAP chars, one paragraph
const DOC = ['# Title', 'First paragraph.', 'Second paragraph.', LONG, 'Last paragraph.'].join('\n\n') + '\n'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** P1's real store over a fresh tmp root holding doc.md (server mode: TJ saves, agent reads). */
async function newStore(markdown = DOC): Promise<DocStore> {
  const root = realId(mkdtempSync(join(tmpdir(), 'mdr-p4-pending-')))
  roots.push(root)
  writeFileSync(join(root, 'doc.md'), markdown)
  return openDocStore(root, 'doc.md', { mode: 'server', lockTimeoutMs: CONSTANTS.LOCK_TIMEOUT_SERVER_MS })
}

function tj(store: DocStore) {
  const clientId = newClientId()
  let saveId = 0
  return {
    async edit(change: (md: string) => string): Promise<void> {
      const snap = await store.snapshot()
      const next = change(snap.markdown)
      const { ops, blockHashes, text } = await opsForText(snap.markdown, next)
      const r = await store.save({
        clientId, saveId: ++saveId, base: { rev: snap.rev, hash: snap.hash, blockHashes }, ops,
        ...(ops.length ? { expectHash: docHash(text, snap.bom) } : {}), cause: 'edit', allowPartial: true,
      }, { clientId })
      expect(r.conflicts).toEqual([])
      expect(r.unsaveable).toEqual([])
    },
    async comment(body: string): Promise<ThreadId> {
      const snap = await store.snapshot()
      return (await store.tj.createThread({ opKey: newOpKey(), anchor: { kind: 'doc' }, anchorRev: snap.rev, body }, { clientId })).thread.id
    },
    async reply(thread: ThreadId, body: string): Promise<CommentId> {
      return (await store.tj.reply(thread, { opKey: newOpKey(), body }, { clientId })).message.id
    },
  }
}

const TOKEN = /tok\d+z/g
const tokens = (s: string | null | undefined): Set<string> => new Set((s ?? '').match(TOKEN) ?? [])

/** Tokens each reported edit introduces: after minus before ('full'), '+' lines minus '-' lines ('diff'). */
function introduced(p: PendingResult): string[] {
  const out: string[] = []
  for (const e of [...p.edits, ...p.external]) {
    for (const b of e.blocks) {
      let before: Set<string>
      let after: Set<string>
      if (b.change.format === 'full') {
        before = tokens(b.change.before)
        after = tokens(b.change.after)
      } else {
        const lines = b.change.diff.split('\n')
        before = tokens(lines.filter((l) => l.startsWith('-')).join('\n'))
        after = tokens(lines.filter((l) => l.startsWith('+')).join('\n'))
      }
      for (const t of after) if (!before.has(t)) out.push(t)
    }
  }
  return out
}
const newBodies = (p: PendingResult): string[] => p.threads.flatMap((t) => t.messages.filter((m) => m.new).map((m) => m.body))

function valid(p: PendingResult): void {
  const r = S.PendingResultSchema.safeParse(p)
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true)
}

describe('pending through the real doc store', () => {
  it('flushes the TJ session and reports the block once; an ack makes the next pending empty', async () => {
    const store = await newStore()
    const t = tj(store)
    await t.edit((md) => md.replace('First paragraph.', 'First paragraph, tok1z.'))
    await t.edit((md) => md.replace('First paragraph, tok1z.', 'First paragraph, tok1z tok2z.'))
    const p = await store.agent.pending()
    valid(p)
    expect(p.edits).toHaveLength(1)
    expect(p.edits[0]).toMatchObject({ by: 'TJ', sources: ['editor'] })
    expect(p.edits[0]!.blocks).toEqual([{ op: 'replace', block: 'b2', line: 3, change: { format: 'full', before: 'First paragraph.', after: 'First paragraph, tok1z tok2z.' } }])
    expect(p.counts.edits).toBe(1)
    const again = await store.agent.pending()
    expect(again.edits).toEqual(p.edits) // not acked: repeated, by design
    await store.agent.batch({ ops: [], ack: p.cursor, ackSince: p.since })
    const after = await store.agent.pending()
    expect(after.empty).toBe(true)
  })

  it('an accepted suggestion appears once: as the decision on its thread, not again as an edit', async () => {
    const store = await newStore()
    const r = await store.agent.batch({ ops: [{ op: 'suggest', quote: 'Second paragraph.', replace: 'Second paragraph, revised.', reason: 'clearer' }] })
    const sid = r.results[0]!.suggestion!
    const p0 = await store.agent.pending()
    await store.agent.batch({ ops: [], ack: p0.cursor, ackSince: p0.since })
    await store.tj.decide(sid, 'accept', { opKey: newOpKey() })
    const p = await store.agent.pending()
    valid(p)
    expect(p.edits).toEqual([])
    expect(p.threads).toHaveLength(1)
    expect(p.threads[0]!.activity).toEqual(['accepted'])
    expect(p.threads[0]!.suggestions).toMatchObject([{ id: sid, by: 'Claude', status: 'accepted', decidedBy: 'TJ' }])
    expect(p.counts).toMatchObject({ decisions: 1, edits: 0 })
  })

  it('an edit past CHANGE_MD_CAP inside a long block is reported with its full text (D33, §13 #86)', async () => {
    expect(LONG.length).toBeGreaterThan(CONSTANTS.CHANGE_MD_CAP)
    const store = await newStore()
    const t = tj(store)
    await t.edit((md) => md.replace('w800 ', 'w800 tok7z '))
    const p = await store.agent.pending()
    valid(p)
    const b = p.edits[0]!.blocks[0]!
    expect(b.op).toBe('replace')
    expect(b.change.format).toBe('diff')
    if (b.change.format === 'diff') {
      expect(b.change.partial).toBeUndefined()
      expect(b.change.diff).toContain('tok7z')
    }
    expect(introduced(p)).toEqual(['tok7z'])
  })

  it('TJ replies and threads: new messages flagged once, gone after the ack', async () => {
    const store = await newStore()
    const t = tj(store)
    const th = await t.comment('msg1')
    await t.reply(th, 'msg2')
    const p = await store.agent.pending()
    expect(newBodies(p).sort()).toEqual(['msg1', 'msg2'])
    expect(p.counts).toMatchObject({ threads: 1, messages: 2 })
    await store.agent.batch({ ops: [{ op: 'reply', thread: th, body: 'Done.' }], ack: p.cursor, ackSince: p.since })
    const q = await store.agent.pending()
    expect(q.empty).toBe(true) // Claude's own reply is not news
  })
})

// ------------------------------------------------------------------ property: nothing missing, nothing repeated

type Action =
  | { k: 'edit'; block: 1 | 2 | 4 }
  | { k: 'editLong' }
  | { k: 'comment' }
  | { k: 'reply' }
  | { k: 'pending'; ack: boolean }

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom<1 | 2 | 4>(1, 2, 4).map((block): Action => ({ k: 'edit', block })) },
  { weight: 2, arbitrary: fc.constant<Action>({ k: 'editLong' }) },
  { weight: 2, arbitrary: fc.constant<Action>({ k: 'comment' }) },
  { weight: 2, arbitrary: fc.constant<Action>({ k: 'reply' }) },
  { weight: 3, arbitrary: fc.boolean().map((ack): Action => ({ k: 'pending', ack })) },
)

describe('pending: nothing missing, nothing repeated (random interleavings)', () => {
  it('holds over TJ edits (including past CHANGE_MD_CAP), comments, replies, pending and ack', async () => {
    await fc.assert(fc.asyncProperty(fc.array(actionArb, { minLength: 4, maxLength: 18 }), async (actions) => {
      const store = await newStore()
      const t = tj(store)
      let n = 0
      const threads: ThreadId[] = []
      const unacked = { msgs: new Set<string>(), edits: new Set<string>() }
      const acked = { msgs: new Set<string>(), edits: new Set<string>() }
      const check = async (ack: boolean): Promise<void> => {
        const p = await store.agent.pending()
        valid(p)
        const msgs = newBodies(p)
        const edits = introduced(p)
        for (const m of unacked.msgs) expect(msgs, `missing message ${m}`).toContain(m)
        for (const e of unacked.edits) expect(edits, `missing edit ${e}`).toContain(e)
        for (const m of msgs) expect(acked.msgs.has(m), `repeated message ${m}`).toBe(false)
        for (const e of edits) expect(acked.edits.has(e), `repeated edit ${e}`).toBe(false)
        expect(new Set(msgs).size).toBe(msgs.length)
        if (ack) {
          await store.agent.batch({ ops: [], ack: p.cursor, ackSince: p.since })
          for (const m of unacked.msgs) acked.msgs.add(m)
          for (const e of unacked.edits) acked.edits.add(e)
          unacked.msgs.clear()
          unacked.edits.clear()
        }
      }
      for (const a of actions) {
        if (a.k === 'edit') {
          const tok = `tok${++n}z`
          const target = ['', 'First paragraph', 'Second paragraph', '', '', 'Last paragraph'][a.block === 4 ? 5 : a.block]!
          await t.edit((md) => md.replace(target, `${target} ${tok}`))
          unacked.edits.add(tok)
        } else if (a.k === 'editLong') {
          const tok = `tok${++n}z`
          const at = 600 + ((n * 37) % 250)
          await t.edit((md) => md.replace(`w${at} `, `w${at} ${tok} `))
          unacked.edits.add(tok)
        } else if (a.k === 'comment') {
          const body = `msg${++n}`
          threads.push(await t.comment(body))
          unacked.msgs.add(body)
        } else if (a.k === 'reply') {
          const th = threads[threads.length - 1]
          if (!th) continue
          const body = `msg${++n}`
          await t.reply(th, body)
          unacked.msgs.add(body)
        } else await check(a.ack)
      }
      await check(true)
      const last = await store.agent.pending()
      expect(last.empty).toBe(true)
      await store.close()
    }), { numRuns: 12 })
  }, 120_000)
})
