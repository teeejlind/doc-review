// tests/unit/node/batch.test.ts (P1). DocStore.agent.batch (CONTRACTS §9.5, §4.4, §4.7, §5.5, §6.2, §7.5, D3, D27, D39):
// base-map selector resolution (the §9.5 example), every BATCH_SELF_CONFLICT case, positional strictness with remap,
// the quote ladder errors, the suggestion target check, SUGGEST_ONLY against every AgentOp variant, idempotency keys
// computed inside the store (same round, later round, across a restart), ack semantics, merge hazards, dryRun and
// all-or-nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import type { AgentOp, DocStore, SidecarEvent, SuggestionId } from '../../../shared/types'
import { CONSTANTS } from '../../../shared/types'
import { makeKit, opKey, saveReq, type Kit } from './store-kit'

const NINE = '# Plan\n\nIntro para.\n\nWe launch in Q3.\n\n## Section\n\nPara five.\n\nPara six.\n\nPara seven.\n\nPara eight.\n\nPara nine.\n'

let kit: Kit
beforeAll(() => {
  kit = makeKit('mdr-batch-')
})
afterAll(async () => {
  await kit.cleanup()
})

const ofType = <T extends SidecarEvent['type']>(evs: readonly SidecarEvent[], t: T): Array<Extract<SidecarEvent, { type: T }>> =>
  evs.filter((e) => e.type === t) as Array<Extract<SidecarEvent, { type: T }>>

async function fresh(text = NINE): Promise<{ file: string; s: DocStore; rev: number }> {
  const file = kit.docIn(text)
  const s = await kit.open(file)
  await s.tj.createThread({ opKey: opKey(), anchor: { kind: 'doc' }, anchorRev: 0, body: 'start' })
  return { file, s, rev: (await s.snapshot()).rev }
}

describe('selector resolution against the base map (D27, the §9.5 example)', () => {
  it('b9 and b4 still mean the base blocks after op 0 inserted a block before them; a second op on b9 → BATCH_SELF_CONFLICT', async () => {
    const { file, s, rev } = await fresh()
    const r = await s.agent.batch({
      ops: [
        { op: 'insert_after', target: { ref: 'b3', rev }, markdown: 'A new paragraph after b3.' },
        { op: 'replace_block', target: { ref: 'b9', rev }, markdown: 'Rewritten b9.' },
        { op: 'delete_block', target: { ref: 'b4', rev } },
      ],
    })
    expect(S.BatchResultSchema.safeParse(r).success).toBe(true)
    expect(kit.read(file)).toBe('# Plan\n\nIntro para.\n\nWe launch in Q3.\n\nA new paragraph after b3.\n\nPara five.\n\nPara six.\n\nPara seven.\n\nPara eight.\n\nRewritten b9.\n')
    // one .md write, one doc.rev, one doc.edit
    expect(ofType(kit.events(file), 'doc.rev').map((e) => e.cause)).toEqual(['baseline', 'cli'])
    expect(ofType(kit.events(file), 'doc.edit')).toHaveLength(1)
    const rev2 = r.rev
    await expect(s.agent.batch({
      ops: [
        { op: 'insert_after', target: { ref: 'b3', rev: rev2 }, markdown: 'x' },
        { op: 'replace_block', target: { ref: 'b8', rev: rev2 }, markdown: 'y' },
        { op: 'replace_block', target: { ref: 'b8', rev: rev2 }, markdown: 'z' },
      ],
    })).rejects.toMatchObject({ code: 'BATCH_SELF_CONFLICT', body: { op: 2 } })
  })

  it('line selectors name the base block containing that base line; quote selectors see earlier ops\' output', async () => {
    const { file, s, rev } = await fresh()
    await s.agent.batch({
      ops: [
        { op: 'replace_block', target: { line: 5, rev }, markdown: 'We launch in Q4.' },
        { op: 'insert_after', target: { quote: 'Para five.' }, markdown: 'After five.' },
      ],
    })
    expect(kit.read(file)).toContain('We launch in Q4.\n\n## Section\n\nPara five.\n\nAfter five.\n\nPara six.')
  })

  it('several insertions at one base anchor appear in op order; an insertion next to a replaced block attaches to its replacement run', async () => {
    const { file, s, rev } = await fresh()
    await s.agent.batch({
      ops: [
        { op: 'replace_block', target: { ref: 'b2', rev }, markdown: 'Intro rewritten.' },
        { op: 'insert_after', target: { ref: 'b2', rev }, markdown: 'First.' },
        { op: 'insert_after', target: { ref: 'b2', rev }, markdown: 'Second.' },
        { op: 'insert_before', target: { ref: 'b2', rev }, markdown: 'Before.' },
      ],
    })
    expect(kit.read(file).startsWith('# Plan\n\nBefore.\n\nIntro rewritten.\n\nFirst.\n\nSecond.\n\nWe launch in Q3.')).toBe(true)
  })
})

describe('BATCH_SELF_CONFLICT (§9.5)', () => {
  const cases: Array<[string, (rev: number) => AgentOp[], number]> = [
    ['a positional target an earlier op replaced', (rev) => [
      { op: 'replace_block', target: { ref: 'b5', rev }, markdown: 'one' },
      { op: 'delete_block', target: { ref: 'b5', rev } }], 1],
    ['a replace_range covering a block an earlier op deleted', (rev) => [
      { op: 'delete_block', target: { ref: 'b6', rev } },
      { op: 'replace_range', from: { ref: 'b5', rev }, to: { ref: 'b7', rev }, markdown: 'merged' }], 1],
    ['an insertion anchored on a base block an earlier op deleted', (rev) => [
      { op: 'delete_block', target: { ref: 'b6', rev } },
      { op: 'insert_after', target: { ref: 'b6', rev }, markdown: 'orphan' }], 1],
    ['a quote hit inside a block an earlier op edited', () => [
      { op: 'replace_block', target: { quote: 'Para five.' }, markdown: 'Para five, edited.' },
      { op: 'comment', quote: 'five, edited', body: 'x' }], 1],
    ['a quote hit inside a block an earlier op suggested on', () => [
      { op: 'suggest', quote: 'Para six', replace: 'Paragraph six' },
      { op: 'suggest', quote: 'six', replace: 'SIX' }], 1],
    ['a positional target an earlier op suggested on', (rev) => [
      { op: 'suggest', quote: 'Para six', replace: 'Paragraph six' },
      { op: 'replace_block', target: { ref: 'b6', rev }, markdown: 'x' }], 1],
    ['write together with another byte change', (rev) => [
      { op: 'replace_block', target: { ref: 'b5', rev }, markdown: 'x' },
      { op: 'write', markdown: 'whole new doc\n', baseRev: rev }], 1],
  ]
  for (const [name, ops, at] of cases) {
    it(name, async () => {
      const { file, s, rev } = await fresh()
      const n = kit.events(file).length
      await expect(s.agent.batch({ ops: ops(rev) })).rejects.toMatchObject({ code: 'BATCH_SELF_CONFLICT', body: { op: at } })
      expect(kit.events(file).length).toBe(n)
      expect(kit.read(file)).toBe(NINE)
    })
  }
})

describe('positional strictness (D3, §7.5)', () => {
  it('a stale { ref, rev } → STALE_REVISION with current and a remap of the unchanged block; quotes need no rev', async () => {
    const { s, rev } = await fresh()
    await s.save(await saveReq(await s.snapshot(), NINE.replace('Intro para.', 'Intro para.\n\nTJ added this.')))
    const err = await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b7', rev }, markdown: 'x' }] }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'STALE_REVISION', status: 409, exit: 7, body: { op: 0, remap: { b7: 'b8' } } })
    expect((err as { current?: { rev: number } }).current?.rev).toBe(rev + 1)
    await expect(s.agent.batch({ ops: [{ op: 'comment', quote: 'Para seven', near: { ref: 'b7', rev }, body: 'x' }] })).rejects.toMatchObject({ code: 'STALE_REVISION' })
    const ok = await s.agent.batch({ ops: [{ op: 'replace_block', target: { quote: 'Para seven.' }, markdown: 'Para 7.' }] })
    expect(ok.results[0]!.changes).toEqual([{ op: 'replace', block: 'b8', line: 15 }])
    await expect(s.agent.batch({ ops: [{ op: 'write', markdown: 'x\n', baseRev: rev }] })).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('a retried edit whose block already holds the markdown is noop', async () => {
    const { s, rev } = await fresh()
    const r = await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b5', rev }, markdown: 'Para five.' }] })
    expect(r.results[0]).toMatchObject({ noop: true })
    expect(r.noop).toBe(true)
  })
})

describe('the quote ladder (§5.5, row 34)', () => {
  const MD = 'The notes carry a **12%** member.\n\nA member rate here.\n\nAnother member rate there.\n\n---\n\nLast.\n'

  it('QUOTE_NOT_IN_SOURCE with the exact source span; QUOTE_AMBIGUOUS with candidates; occurrence and near pick one', async () => {
    const { s, rev } = await fresh(MD)
    await expect(s.agent.batch({ ops: [{ op: 'suggest', quote: '12% member', replace: '11% member' }] }))
      .rejects.toMatchObject({ code: 'QUOTE_NOT_IN_SOURCE', body: { sourceQuote: '**12%** member', op: 0 } })
    const amb = await s.agent.batch({ ops: [{ op: 'comment', quote: 'member rate', body: 'x' }] }).catch((e: unknown) => e)
    expect(amb).toMatchObject({ code: 'QUOTE_AMBIGUOUS', exit: 6 })
    expect((amb as { body: { candidates: unknown[] } }).body.candidates).toMatchObject([{ occurrence: 1, block: 'b2' }, { occurrence: 2, block: 'b3' }])
    const two = await s.agent.batch({ ops: [{ op: 'comment', quote: 'member rate', occurrence: 2, body: 'second' }] })
    expect(two.results[0]!.anchor).toMatchObject({ block: 'b3', quote: 'member rate' })
    const near = await s.agent.batch({ ops: [{ op: 'suggest', quote: 'member rate', replace: 'rate', near: { ref: 'b2', rev: (await s.snapshot()).rev } }] })
    expect(near.results[0]!.anchor).toMatchObject({ block: 'b2' })
    void rev
  })

  it('QUOTE_NOT_FOUND carries up to 3 near-misses; QUOTE_IN_PENDING_SUGGESTION names the suggestion; a CLI quote over the cap → BAD_REQUEST', async () => {
    const { s } = await fresh(MD)
    const nf = await s.agent.batch({ ops: [{ op: 'comment', quote: 'Anotther member rate', body: 'x' }] }).catch((e: unknown) => e)
    expect(nf).toMatchObject({ code: 'QUOTE_NOT_FOUND' })
    const c = (nf as { body: { candidates: Array<{ block: string; similarity: number }> } }).body.candidates
    expect(c.length).toBeGreaterThan(0)
    expect(c[0]).toMatchObject({ block: 'b3' })
    expect(c[0]!.similarity).toBeGreaterThanOrEqual(0.6)
    const sug = await s.agent.batch({ ops: [{ op: 'suggest', quote: 'Last.', replace: 'Finally done.' }] })
    await expect(s.agent.batch({ ops: [{ op: 'comment', quote: 'Finally done', body: 'x' }] }))
      .rejects.toMatchObject({ code: 'QUOTE_IN_PENDING_SUGGESTION', body: { suggestion: sug.results[0]!.suggestion } })
    await expect(s.agent.batch({ ops: [{ op: 'comment', quote: 'x'.repeat(CONSTANTS.MAX_QUOTE_CHARS + 1), body: 'x' }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('atoms (row 35): comment --quote and suggest on an hr or frontmatter → UNANCHORABLE_TARGET; comment --block gives a block anchor', async () => {
    const text = '---\ntitle: T\n---\n\nPara.\n\n---\n\nEnd.\n'
    const { s, rev } = await fresh(text)
    await expect(s.agent.batch({ ops: [{ op: 'suggest', quote: 'title: T', replace: 'title: U' }] })).rejects.toMatchObject({ code: 'UNANCHORABLE_TARGET' })
    await expect(s.agent.batch({ ops: [{ op: 'suggest_block', target: { ref: 'b3', rev }, markdown: '***' }] })).rejects.toMatchObject({ code: 'UNANCHORABLE_TARGET' })
    const b = await s.agent.batch({ ops: [{ op: 'comment', block: { ref: 'b1', rev }, body: 'frontmatter?' }] })
    expect(b.results[0]!.anchor).toMatchObject({ state: 'ok', block: 'b1' })
    const t = (await s.review()).threads.find((x) => x.id === b.results[0]!.thread)!
    expect(t.anchor).toMatchObject({ kind: 'block', hint: { kind: 'frontmatter' } })
  })
})

describe('suggestions from the CLI (§6.2)', () => {
  it('table structure is allowed for Claude (suggest_block adding a row); overlap with a pending suggestion → SUGGESTION_OVERLAP', async () => {
    const text = '| a | b |\n|---|---|\n| 1 | 2 |\n\nPara with words.\n'
    const { s, rev } = await fresh(text)
    const r = await s.agent.batch({ ops: [{ op: 'suggest_block', target: { ref: 'b1', rev }, markdown: '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |', reason: 'add a row' }] })
    expect(r.results[0]).toMatchObject({ suggestion: expect.stringMatching(/^s_/) })
    await s.agent.batch({ ops: [{ op: 'suggest', quote: 'with words', replace: 'with more words' }] })
    await expect(s.agent.batch({ ops: [{ op: 'suggest', quote: 'words', replace: 'terms' }] })).rejects.toMatchObject({ code: 'SUGGESTION_OVERLAP' })
  })

  it('a new list item that would merge into the adjacent list → BLOCK_MERGE_HAZARD, nothing written (row 58)', async () => {
    const text = '- a\n- b\n\nPara.\n'
    const { file, s, rev } = await fresh(text)
    await expect(s.agent.batch({ ops: [{ op: 'insert_after', target: { ref: 'b1', rev }, markdown: '- c' }] })).rejects.toMatchObject({ code: 'BLOCK_MERGE_HAZARD' })
    expect(kit.read(file)).toBe(text)
  })

  it('Claude decides TJ\'s suggestions only (D10) and withdraws its own', async () => {
    const { s } = await fresh('Alpha beta.\n\nGamma delta.\n')
    const mine = await s.agent.batch({ ops: [{ op: 'suggest', quote: 'beta', replace: 'BETA' }] })
    await expect(s.agent.batch({ ops: [{ op: 'decide', suggestion: mine.results[0]!.suggestion!, decision: 'accept' }] })).rejects.toMatchObject({ code: 'NOT_AUTHOR' })
    const snap = await s.snapshot()
    const tj = `s_01JAB3K9Q2T7V5X8Y0Z1W2E3T1` as SuggestionId
    const { anchorOn } = await import('./store-kit')
    await s.save(await saveReq(snap, snap.markdown, { suggestions: { upsert: [{ id: tj, range: { start: 1, end: 2 }, base: 'Gamma delta.', proposed: 'Gamma DELTA.', anchor: await anchorOn(snap.markdown, 'delta', snap.rev) }] } }))
    await expect(s.agent.batch({ ops: [{ op: 'withdraw', suggestion: tj }] })).rejects.toMatchObject({ code: 'NOT_AUTHOR' })
    const acc = await s.agent.batch({ ops: [{ op: 'decide', suggestion: tj, decision: 'accept' }] })
    expect(acc.results[0]!.changes).toEqual([{ op: 'replace', block: 'b2', line: 3 }])
    const w = await s.agent.batch({ ops: [{ op: 'withdraw', suggestion: mine.results[0]!.suggestion! }] })
    expect(w.results[0]).toMatchObject({ suggestion: mine.results[0]!.suggestion })
    const rv = await s.review()
    expect(rv.suggestions.map((x) => x.status).sort()).toEqual(['accepted', 'withdrawn'])
  })
})

describe('SUGGEST_ONLY (§4.4, D39, row 81)', () => {
  it('every AgentOp variant against the policy: direct edits refuse the whole batch, the rest pass', async () => {
    const { file, s, rev } = await fresh('Alpha beta.\n\nGamma delta.\n\nEpsilon.\n')
    const setup = await s.agent.batch({ ops: [{ op: 'comment', quote: 'Alpha', body: 'c' }, { op: 'suggest', quote: 'Epsilon', replace: 'EPSILON' }] })
    const thread = setup.results[0]!.thread!
    const comment = setup.results[0]!.comment!
    const snap = await s.snapshot()
    const { anchorOn } = await import('./store-kit')
    const tj = `s_01JAB3K9Q2T7V5X8Y0Z1W2E3T2` as SuggestionId
    await s.save(await saveReq(snap, snap.markdown, { suggestions: { upsert: [{ id: tj, range: { start: 1, end: 2 }, base: 'Gamma delta.', proposed: 'Gamma DELTA.', anchor: await anchorOn(snap.markdown, 'delta', snap.rev) }] } }))
    await s.agent.setPolicy({ suggestOnly: true })
    const r = (await s.snapshot()).rev
    void rev
    const refused: AgentOp[] = [
      { op: 'replace_block', target: { ref: 'b1', rev: r }, markdown: 'x' },
      { op: 'replace_range', from: { ref: 'b1', rev: r }, to: { ref: 'b2', rev: r }, markdown: 'x' },
      { op: 'insert_after', target: { ref: 'b1', rev: r }, markdown: 'x' },
      { op: 'insert_before', target: { ref: 'b1', rev: r }, markdown: 'x' },
      { op: 'delete_block', target: { ref: 'b1', rev: r } },
      { op: 'write', markdown: 'x\n', baseRev: r },
      { op: 'decide', suggestion: tj, decision: 'accept' },
    ]
    for (const op of refused) {
      // even after an allowed op, the whole batch refuses, at the offending op
      await expect(s.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'fine' }, op] })).rejects.toMatchObject({ code: 'SUGGEST_ONLY', status: 403, exit: 4, body: { op: 1 } })
    }
    const n = kit.events(file).length
    const allowed: AgentOp[] = [
      { op: 'comment', quote: 'Gamma', body: 'q' },
      { op: 'comment', doc: true, body: 'd' },
      { op: 'comment', block: { ref: 'b3', rev: r }, body: 'b' },
      { op: 'reply', thread, body: 'r' },
      { op: 'suggest', quote: 'Alpha beta', replace: 'Alpha BETA' },
      { op: 'resolve', thread },
      { op: 'reopen', thread },
      { op: 'edit_comment', comment: (await s.agent.batch({ ops: [{ op: 'reply', thread, body: 'mine' }] })).results[0]!.comment!, body: 'edited' },
      { op: 'decide', suggestion: tj, decision: 'reject' },
      { op: 'withdraw', suggestion: setup.results[1]!.suggestion! },
    ]
    const ok = await s.agent.batch({ ops: allowed, ack: 1 })
    expect(ok.results).toHaveLength(allowed.length)
    expect(kit.events(file).length).toBeGreaterThan(n)
    void comment
    const sb = await s.agent.batch({ ops: [{ op: 'suggest_block', target: { ref: 'b3', rev: (await s.snapshot()).rev }, markdown: 'Epsilon!' }] })
    expect(sb.results[0]!.suggestion).toBeDefined()
  })
})

describe('idempotency keys computed inside the store (§4.7, row 56)', () => {
  it('same round → duplicate with the original ids (also after a restart); a later round → a new key; op.key is forwarded', async () => {
    const { file, s } = await fresh()
    const ops: AgentOp[] = [{ op: 'comment', quote: 'Para six', body: 'same text' }, { op: 'suggest', quote: 'Para seven', replace: 'Para 7', reason: 'r' }]
    const a = await s.agent.batch({ ops })
    expect(a.results.map((r) => r.key)).toEqual([expect.stringMatching(/^cli:[0-9a-f]{32}$/), expect.stringMatching(/^cli:[0-9a-f]{32}$/)])
    const b = await s.agent.batch({ ops })
    expect(b.results).toMatchObject([
      { duplicate: true, key: a.results[0]!.key, thread: a.results[0]!.thread, comment: a.results[0]!.comment },
      { duplicate: true, key: a.results[1]!.key, suggestion: a.results[1]!.suggestion, thread: a.results[1]!.thread },
    ])
    expect(b.noop).toBe(true)
    const s2 = await kit.open(file)
    const c = await s2.agent.batch({ ops })
    expect(c.results[0]).toMatchObject({ duplicate: true, thread: a.results[0]!.thread })
    expect(c.results[1]).toMatchObject({ duplicate: true, suggestion: a.results[1]!.suggestion, hunks: [{ del: 'six', ins: '6' }].length ? expect.any(Array) : [] })
    // a later round: TJ sent a handoff, so the same text is new
    await s2.appendEvents([{ type: 'handoff.sent', message: null, delivery: 'clipboard' }])
    const d = await s2.agent.batch({ ops: [ops[0]!] })
    expect(d.results[0]!.duplicate).toBeUndefined()
    expect(d.results[0]!.key).not.toBe(a.results[0]!.key)
    const e = await s2.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'k', key: 'my-key' }] })
    expect(e.results[0]!.key).toBe('my-key')
    expect(ofType(kit.events(file), 'comment.add').filter((x) => x.body === 'same text')).toHaveLength(2)
  })

  it('a single byte op retried in the same round is a duplicate (its key rides the doc.rev / doc.edit lines)', async () => {
    const { file, s, rev } = await fresh()
    const op: AgentOp = { op: 'insert_after', target: { ref: 'b2', rev }, markdown: 'Inserted once.' }
    const a = await s.agent.batch({ ops: [op] })
    const b = await kit.open(file).then((s2) => s2.agent.batch({ ops: [op] }))
    expect(b.results[0]).toMatchObject({ duplicate: true, key: a.results[0]!.key })
    expect(kit.read(file).split('Inserted once.').length).toBe(2)
  })
})

describe('ack (§4.4, §9.5)', () => {
  it('applied last; ACK_OUT_OF_RANGE past the latest seq; below the cursor a no-op; ackSince CAS → ACK_CONFLICT; consumed handoffs', async () => {
    const { s } = await fresh()
    const h = await s.appendEvents([{ type: 'handoff.sent', message: 'hi', delivery: 'waiter' }])
    const seq = h.seq
    await expect(s.agent.batch({ ops: [], ack: seq + 5 })).rejects.toMatchObject({ code: 'ACK_OUT_OF_RANGE', exit: 3 })
    const a = await s.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'done' }], ack: seq, ackSince: 0 })
    expect(a).toMatchObject({ acked: seq, consumed: [seq] })
    expect((await s.handoffs())[0]!.consumed).toBe(true)
    const low = await s.agent.batch({ ops: [], ack: 1 })
    expect(low).toMatchObject({ acked: seq, noop: true })
    await expect(s.agent.batch({ ops: [], ack: seq + 1, ackSince: 0 })).rejects.toMatchObject({ code: 'ACK_CONFLICT', body: { details: { cursor: seq } } })
  })
})

describe('all-or-nothing and dryRun (§9.5)', () => {
  it('a failure at op i rejects the whole batch with error.op = i and writes nothing; dryRun writes nothing', async () => {
    const { file, s, rev } = await fresh()
    const n = kit.events(file).length
    await expect(s.agent.batch({ ops: [
      { op: 'comment', doc: true, body: 'would land' },
      { op: 'replace_block', target: { ref: 'b2', rev }, markdown: 'x' },
      { op: 'reply', thread: 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R7', body: 'x' },
    ] })).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND', body: { op: 2 } })
    expect(kit.events(file).length).toBe(n)
    expect(kit.read(file)).toBe(NINE)
    const d = await s.agent.batch({ ops: [{ op: 'replace_block', target: { ref: 'b2', rev }, markdown: 'Dry.' }], dryRun: true })
    expect(d).toMatchObject({ dryRun: true, noop: true, rev })
    expect(d.results[0]!.changes).toEqual([{ op: 'replace', block: 'b2', line: 3 }])
    expect(kit.events(file).length).toBe(n)
    expect(kit.read(file)).toBe(NINE)
  })

  it('an op carrying `by` → IDENTITY_IN_BODY', async () => {
    const { s } = await fresh()
    await expect(s.agent.batch({ ops: [{ op: 'comment', doc: true, body: 'x', by: 'TJ' } as never] })).rejects.toMatchObject({ code: 'IDENTITY_IN_BODY' })
  })
})
