// tests/unit/web/session/autosave.test.ts (P2). The autosave planner and its trigger scheduler (CONTRACTS §12.4, §6.4,
// §7.4, D22, D26, D37, D40): held conflicts and unsaveable ops are excluded, reopen candidates come back before any
// plan, upserts of known ids are throttled until their marks are still (unless the save is a flush-reason save), and
// expectHash is the doc hash including the BOM.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { docHash } from '../../../../core/hash'
import type { Md } from '../../../../core/md/index'
import { load, type Loaded } from '../../../../core/splice/load'
import { CONSTANTS } from '../../../../shared/types'
import type { ReviewState, Suggestion, SuggestionId, TjSuggestionUpsert } from '../../../../shared/types'
import {
  AutosaveScheduler, backoffDelay, insertionKey, isHeld, planSaveRequest, unsaveableIdOf, type PlanInput,
} from '../../../../web/src/session/autosave'
import { sharedMd } from '../../../fakes/FakeDocStore'

const MD = '# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n'

let md: Md
beforeAll(async () => {
  md = await sharedMd()
})

function review(suggestions: Partial<Suggestion>[] = []): ReviewState {
  return {
    ok: true, file: 'doc.md', rev: 1, seq: 1, threads: [], suggestions: suggestions as Suggestion[],
    cursors: { claudeAck: 0, tjRead: 0, tjReadByThread: {} }, presence: { waiter: 'none' },
    activity: { file: 'doc.md', state: 'idle', since: '2026-10-15T00:00:00.000Z', unreadFromClaude: 0 },
    undeliveredHandoffs: [], policy: { suggestOnly: false }, warnings: [], readOnly: false,
  }
}

/** A copy of L.doc with top-level textblock `index` set to `text`. */
function withText(L: Loaded, index: number, text: string): PMNode {
  const kids: PMNode[] = []
  L.doc.forEach((n, _o, i) => kids.push(i === index ? n.type.create(n.attrs, text ? md.schema.text(text) : null) : n))
  return L.doc.type.create(L.doc.attrs, kids)
}

function input(L: Loaded, baseDoc: PMNode, over: Partial<PlanInput> = {}): PlanInput {
  return {
    md, L, base: { rev: 1, hash: docHash(L.src, false) }, bom: false, baseDoc, review: review(),
    holds: { hashes: new Set(), insertions: new Set() }, suggestions: { upsert: [], withdraw: [], reopen: [] }, anchors: [],
    stableSince: () => undefined, now: 10_000, flushReason: false, cause: 'edit', allowPartial: true,
    clientId: 'k_01JAB3K9Q2T7V5X8Y0Z1W2E3R4', saveId: 7, ...over,
  }
}

const upsert = (id: string): TjSuggestionUpsert => ({
  id: id as SuggestionId, range: { start: 1, end: 2 }, base: 'Alpha paragraph.', proposed: 'Alpha, suggested.',
  anchor: { kind: 'text', quote: 'Alpha', prefix: '', suffix: ' paragraph.', hint: { rev: 1, pos: 6, block: 1, blockHash: '0'.repeat(16), offsetInBlock: 0 } },
})
const S1 = 's_01JAB3K9Q2T7V5X8Y0Z1W2E3R1' as SuggestionId
const S2 = 's_01JAB3K9Q2T7V5X8Y0Z1W2E3R2' as SuggestionId

describe('planSaveRequest (§12.4 steps 1-6)', () => {
  it('an unchanged doc plans nothing', () => {
    const L = load(md, MD)
    expect(planSaveRequest(input(L, L.doc))).toMatchObject({ kind: 'empty', deferredUntil: null, withheld: 0 })
  })

  it('one edited block → one op, base = { rev, hash, blockHashes }, expectHash = docHash(applyBlockOps text)', () => {
    const L = load(md, MD)
    const p = planSaveRequest(input(L, withText(L, 2, 'Beta, edited.')))
    expect(p.kind).toBe('save')
    if (p.kind !== 'save') return
    expect(p.req.ops).toEqual([{ after: 1, before: 3, covers: [L.blocks[2]!.hash], blocks: ['Beta, edited.'] }])
    expect(p.req.base).toEqual({ rev: 1, hash: docHash(MD, false), blockHashes: L.blocks.map((b) => b.hash) })
    expect(p.apply.text).toBe(MD.replace('Beta paragraph.', 'Beta, edited.'))
    expect(p.req.expectHash).toBe(docHash(p.apply.text, false))
    expect(p.req).toMatchObject({ clientId: 'k_01JAB3K9Q2T7V5X8Y0Z1W2E3R4', saveId: 7, cause: 'edit', allowPartial: true })
    expect(p.req.suggestions).toBeUndefined()
    expect(p.req.anchors).toBeUndefined()
  })

  it('expectHash is in the doc-hash domain: with a BOM it hashes EF BB BF + text (D40)', () => {
    const L = load(md, MD)
    const p = planSaveRequest(input(L, withText(L, 3, 'Gamma, edited.'), { bom: true }))
    if (p.kind !== 'save') throw new Error('expected a save')
    expect(p.req.expectHash).toBe(docHash(p.apply.text, true))
    expect(p.req.expectHash).not.toBe(docHash(p.apply.text, false))
  })

  it('ops covering a held conflict hash are withheld; the rest still save (§7.4)', () => {
    const L = load(md, MD)
    let doc = withText(L, 1, 'Alpha, mine (held).')
    doc = withText({ ...L, doc }, 3, 'Gamma, free.')
    const p = planSaveRequest(input(L, doc, { holds: { hashes: new Set([L.blocks[1]!.hash]), insertions: new Set() } }))
    if (p.kind !== 'save') throw new Error('expected a save')
    expect(p.withheld).toBe(1)
    expect(p.req.ops).toHaveLength(1)
    expect(p.req.ops[0]!.covers).toEqual([L.blocks[3]!.hash])
    expect(p.apply.text).toContain('Alpha paragraph.')
    expect(p.apply.text).toContain('Gamma, free.')
  })

  it('a held block adjacent to a free edit: the joined in-place run is split, and no op covers the held hash', () => {
    const L = load(md, MD)
    let doc = withText(L, 2, 'Beta, mine (held).')
    doc = withText({ ...L, doc }, 3, 'Gamma, free and adjacent.')
    const free = planSaveRequest(input(L, doc))
    if (free.kind !== 'save') throw new Error('expected a save')
    expect(free.req.ops).toHaveLength(1)
    expect(free.req.ops[0]!.covers).toEqual([L.blocks[2]!.hash, L.blocks[3]!.hash])
    const p = planSaveRequest(input(L, doc, { holds: { hashes: new Set([L.blocks[2]!.hash]), insertions: new Set() } }))
    if (p.kind !== 'save') throw new Error('expected a save')
    expect(p.withheld).toBe(1)
    expect(p.req.ops).toEqual([{ after: 2, before: 4, covers: [L.blocks[3]!.hash], blocks: ['Gamma, free and adjacent.'] }])
    expect(p.apply.text).toBe(MD.replace('Gamma paragraph.', 'Gamma, free and adjacent.'))
    expect(p.req.expectHash).toBe(docHash(p.apply.text, false))
  })

  it('a held block between two free edits: two sub-ops sharing the held block as their boundary (§3.4 allows it)', () => {
    const L = load(md, MD)
    let doc = withText(L, 1, 'Alpha, free.')
    doc = withText({ ...L, doc }, 2, 'Beta, mine (held).')
    doc = withText({ ...L, doc }, 3, 'Gamma, free.')
    const p = planSaveRequest(input(L, doc, { holds: { hashes: new Set([L.blocks[2]!.hash]), insertions: new Set() } }))
    if (p.kind !== 'save') throw new Error('expected a save')
    expect(p.req.ops).toEqual([
      { after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: ['Alpha, free.'] },
      { after: 2, before: 4, covers: [L.blocks[3]!.hash], blocks: ['Gamma, free.'] },
    ])
    expect(p.req.ops.some((o) => o.covers.includes(L.blocks[2]!.hash))).toBe(false)
    expect(p.apply.text).toBe(MD.replace('Alpha paragraph.', 'Alpha, free.').replace('Gamma paragraph.', 'Gamma, free.'))
    expect(p.apply.failed).toEqual([])
  })

  it('a held unsaveable op is excluded even when it is the only change → empty plan', () => {
    const L = load(md, MD)
    const p = planSaveRequest(input(L, withText(L, 2, 'Beta, unsaveable.'), { holds: { hashes: new Set([L.blocks[2]!.hash]), insertions: new Set() } }))
    expect(p).toMatchObject({ kind: 'empty', withheld: 1 })
  })

  it('a held pure-insertion unsaveable op is keyed by the block before it', () => {
    const L = load(md, MD)
    const kids: PMNode[] = []
    L.doc.forEach((n, _o, i) => {
      kids.push(n)
      if (i === 2) kids.push(md.schema.nodes.paragraph!.create(null, md.schema.text('Inserted.')))
    })
    const doc = L.doc.type.create(null, kids)
    const free = planSaveRequest(input(L, doc))
    if (free.kind !== 'save') throw new Error('expected a save')
    const op = free.req.ops[0]!
    expect(op.covers).toEqual([])
    expect(insertionKey(L, op)).toBe(L.blocks[2]!.hash)
    expect(unsaveableIdOf(L, op)).toBe(`unsaveable:${L.blocks[2]!.hash}`)
    expect(isHeld(L, op, { hashes: new Set(), insertions: new Set([L.blocks[2]!.hash]) })).toBe(true)
    const heldPlan = planSaveRequest(input(L, doc, { holds: { hashes: new Set(), insertions: new Set([L.blocks[2]!.hash]) } }))
    expect(heldPlan).toMatchObject({ kind: 'empty', withheld: 1 })
  })

  it('reopen candidates come back first, before any op or suggestion is planned (D26)', () => {
    const L = load(md, MD)
    const p = planSaveRequest(input(L, withText(L, 2, 'Edited too.'), {
      suggestions: { upsert: [upsert(S2)], withdraw: [], reopen: [{ ids: [S1] }, { ids: [S2, S1], bulk: 'op_01JAB3K9Q2T7V5X8Y0Z1W2E3R4' }] },
    }))
    expect(p).toEqual({ kind: 'reopen', groups: [{ ids: [S1] }, { ids: [S2, S1], bulk: 'op_01JAB3K9Q2T7V5X8Y0Z1W2E3R4' }] })
  })

  it('a new TJ suggestion id is sent on its first save; a known id waits until its marks are still (D22)', () => {
    const L = load(md, MD)
    const now = 100_000
    const known = review([{ id: S1, by: 'TJ', status: 'pending' }])
    const recent = planSaveRequest(input(L, L.doc, {
      review: known, now, stableSince: () => now - 500, suggestions: { upsert: [upsert(S1), upsert(S2)], withdraw: [], reopen: [] },
    }))
    if (recent.kind !== 'save') throw new Error('expected a save')
    expect(recent.upserted).toEqual([S2])
    expect(recent.req.suggestions?.upsert?.map((u) => u.id)).toEqual([S2])
    expect(recent.deferredUntil).toBe(now - 500 + CONSTANTS.SUGGESTION_UPSERT_STABLE_MS)

    const still = planSaveRequest(input(L, L.doc, {
      review: known, now, stableSince: () => now - CONSTANTS.SUGGESTION_UPSERT_STABLE_MS, suggestions: { upsert: [upsert(S1)], withdraw: [], reopen: [] },
    }))
    expect(still.kind === 'save' && still.upserted).toEqual([S1])

    const flush = planSaveRequest(input(L, L.doc, {
      review: known, now, flushReason: true, stableSince: () => now - 10, suggestions: { upsert: [upsert(S1)], withdraw: [], reopen: [] },
    }))
    expect(flush.kind === 'save' && flush.upserted).toEqual([S1])

    const onlyThrottled = planSaveRequest(input(L, L.doc, {
      review: known, now, stableSince: () => now - 10, suggestions: { upsert: [upsert(S1)], withdraw: [], reopen: [] },
    }))
    expect(onlyThrottled).toEqual({ kind: 'empty', deferredUntil: now - 10 + CONSTANTS.SUGGESTION_UPSERT_STABLE_MS, withheld: 0 })
  })

  it('withdrawals and anchors ride the save; reopen never does', () => {
    const L = load(md, MD)
    const anchors = [{ thread: 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R4' as const, anchor: null }]
    const p = planSaveRequest(input(L, L.doc, { anchors, suggestions: { upsert: [], withdraw: [S1], reopen: [] } }))
    if (p.kind !== 'save') throw new Error('expected a save')
    expect(p.req.ops).toEqual([])
    expect(p.req.expectHash).toBeUndefined()
    expect(p.req.anchors).toEqual(anchors)
    expect(p.req.suggestions).toEqual({ withdraw: [S1] })
    expect(Object.keys(p.req.suggestions ?? {})).not.toContain('reopen')
  })

  it('a recreate save is sent even with no ops', () => {
    const L = load(md, MD)
    const p = planSaveRequest(input(L, L.doc, { cause: 'recreate', allowPartial: false }))
    expect(p.kind).toBe('save')
    if (p.kind === 'save') expect(p.req).toMatchObject({ cause: 'recreate', allowPartial: false, ops: [] })
  })

  it('suggestion marks reaching the base doc throw (never sent, §13 #60)', () => {
    const L = load(md, MD)
    const ins = md.schema.marks.insertion!.create({ id: S1 })
    const kids: PMNode[] = []
    L.doc.forEach((n, _o, i) => kids.push(i === 1 ? n.type.create(n.attrs, md.schema.text('Marked.', [ins])) : n))
    expect(() => planSaveRequest(input(L, L.doc.type.create(null, kids)))).toThrow()
  })
})

describe('backoff (§12.4)', () => {
  it('1, 2, 4, 8, 15, 30 s, capped', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000])
  })
})

describe('AutosaveScheduler (§12.4 triggers)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires once AUTOSAVE_DEBOUNCE_MS after the last change', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const s = new AutosaveScheduler({ isComposing: () => false, fire: (r) => fired.push(r) })
    s.changed()
    vi.advanceTimersByTime(500)
    s.changed()
    vi.advanceTimersByTime(500)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(CONSTANTS.AUTOSAVE_DEBOUNCE_MS)
    expect(fired).toEqual(['debounce'])
  })

  it('fires at AUTOSAVE_MAX_WAIT_MS while typing never pauses', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const s = new AutosaveScheduler({ isComposing: () => false, fire: (r) => fired.push(r) })
    for (let t = 0; t < CONSTANTS.AUTOSAVE_MAX_WAIT_MS + 200; t += 200) {
      s.changed()
      vi.advanceTimersByTime(200)
    }
    expect(fired).toEqual(['max-wait'])
  })

  it('defers every trigger while composing and fires the strongest reason at compositionend (§13 #63)', () => {
    vi.useFakeTimers()
    let composing = true
    const fired: string[] = []
    const s = new AutosaveScheduler({ isComposing: () => composing, fire: (r) => fired.push(r) })
    s.changed()
    vi.advanceTimersByTime(CONSTANTS.AUTOSAVE_MAX_WAIT_MS + 100)
    s.now('blur')
    expect(fired).toEqual([])
    expect(s.pending).toBe(true)
    s.compositionEnd() // still composing: nothing
    expect(fired).toEqual([])
    composing = false
    s.compositionEnd()
    expect(fired).toEqual(['blur'])
    expect(s.pending).toBe(false)
  })

  it('at() schedules a save for a throttled upsert becoming sendable', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const s = new AutosaveScheduler({ isComposing: () => false, fire: (r) => fired.push(r) })
    s.at(5_000, 3_500)
    vi.advanceTimersByTime(1_499)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual(['stable'])
  })
})
