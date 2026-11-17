// tests/unit/core/suggest/hydrate-extract.test.ts (P2; CONTRACTS §6.3, §6.4, §6.5).
// hydrate (record → marks), extract / tjSuggestionDiff (marks → record), the id-scoped apply/revert, unplaced reasons.
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { Transform } from '@milkdown/kit/prose/transform'
import { load } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import { applyToSource } from '../../../../core/suggest/record'
import { extract, sameProposal, tjSuggestionDiff } from '../../../../core/suggest/extract'
import { alignLive, hydrate } from '../../../../core/suggest/hydrate'
import { decideSuggestions, onlyApplied, revertAll, suggestionIdsIn } from '../../../../core/suggest/guards'
import type { ReviewState, SuggestionId } from '../../../../shared/types'
import { claudeBlock, claudeQuote, docOf, find, marks, record, replaceText, sameContent, savedDoc, typeAt, userDispatch } from './helpers'

const TEXT = '# Title\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph with **bold** text.\n\n- one\n- two\n'

function review(sugs: ReviewState['suggestions']): ReviewState {
  return {
    ok: true, file: 'x.md', rev: 1, seq: 1, threads: [], suggestions: sugs,
    cursors: { claudeAck: 0, tjRead: 0, tjReadByThread: {} },
    presence: { waiter: 'none' }, activity: { file: 'x.md', state: 'idle', since: '', unreadFromClaude: 0 },
    undeliveredHandoffs: [], policy: { suggestOnly: false }, warnings: [], readOnly: false,
  }
}

describe('hydrate (§6.3)', () => {
  it('places a Claude replace as deletion + insertion marks carrying only s.id, and reverts to the base exactly', async () => {
    const d = await docOf(TEXT)
    const r = claudeQuote(d, 'quick brown', 'slow red')
    const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
    expect('tr' in h).toBe(true)
    if (!('tr' in h)) return
    expect(h.tr.getMeta('addToHistory')).toBe(false)
    expect(h.tr.getMeta('mdr')).toEqual({ origin: 'hydrate', id: r.id })
    const s = d.state.apply(h.tr)
    const ms = marks(s.doc)
    expect(new Set(ms.map((m) => m.id))).toEqual(new Set([r.id]))
    expect(ms.filter((m) => m.kind === 'del').map((m) => m.text).join('')).toContain('quick')
    expect(ms.filter((m) => m.kind === 'ins').map((m) => m.text).join('')).toContain('slow')
    expect(sameContent(revertAll(s.doc).doc, d.L.doc)).toBe(true)
    // accepting the marks equals the server's byte splice, parsed
    const applied = onlyApplied(s.doc, new Set([r.id])).doc
    const server = load(d.md, applyToSource(d.md, d.L, r).text)
    expect(sameContent(applied, server.doc)).toBe(true)
  })

  it('a mark-only change (bold) hydrates as a replace of that run', async () => {
    const d = await docOf(TEXT)
    const r = claudeQuote(d, 'lazy', '**lazy**')
    const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
    if (!('tr' in h)) throw new Error(`unplaced ${JSON.stringify(h)}`)
    const s = d.state.apply(h.tr)
    const ms = marks(s.doc)
    expect(ms.filter((m) => m.kind === 'del').map((m) => m.text).join('')).toBe('lazy')
    expect(ms.filter((m) => m.kind === 'ins').map((m) => m.text).join('')).toBe('lazy')
    expect(sameContent(onlyApplied(s.doc, new Set([r.id])).doc, load(d.md, applyToSource(d.md, d.L, r).text).doc)).toBe(true)
  })

  it('a structural suggest_block (paragraph → two paragraphs) is one replace of the run', async () => {
    const d = await docOf(TEXT)
    const r = claudeBlock(d, 1, 'First half.\n\nSecond half.')
    const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
    if (!('tr' in h)) throw new Error(`unplaced ${JSON.stringify(h)}`)
    const s = d.state.apply(h.tr)
    expect(sameContent(revertAll(s.doc).doc, d.L.doc)).toBe(true)
    expect(sameContent(onlyApplied(s.doc, new Set([r.id])).doc, load(d.md, applyToSource(d.md, d.L, r).text).doc)).toBe(true)
  })

  it('unplaced: BASE_NOT_FOUND when the base is gone, SCHEMA inside a code block and for table structure', async () => {
    const d = await docOf('Para.\n\n```js\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| c | d |\n')
    const gone = record({ range: { start: 0, end: 1, rev: 0 }, base: 'Nope.', proposed: 'Yes.', hunks: [] })
    expect(hydrate(d.state, gone, { md: d.md, loaded: d.L })).toEqual({ unplaced: 'BASE_NOT_FOUND' })
    const code = claudeBlock(d, 1, '```js\nconst a = 2\n```')
    expect(hydrate(d.state, code, { md: d.md, loaded: d.L })).toEqual({ unplaced: 'SCHEMA' })
    const row = claudeBlock(d, 2, '| a | b |\n|---|---|\n| c | d |\n| e | f |')
    expect(hydrate(d.state, row, { md: d.md, loaded: d.L })).toEqual({ unplaced: 'SCHEMA' })
    // a cell text edit is ordinary inline content
    const cell = claudeBlock(d, 2, '| a | b |\n|---|---|\n| c | dd |')
    expect('tr' in hydrate(d.state, cell, { md: d.md, loaded: d.L })).toBe(true)
  })

  it('unplaced: ID_COLLISION when the run holds another suggestion that the replace would remove', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    // TJ's own pending insertion inside paragraph 1
    const at = find(d.state.doc, 'quick').from
    d = typeAt(d, at, 'very ', () => 's_TJ1' as SuggestionId)
    const r = claudeBlock(d, 1, 'Completely different.\n\nTwo blocks.')
    expect(hydrate(d.state, r, { md: d.md, loaded: d.L })).toEqual({ unplaced: 'ID_COLLISION' })
  })

  it('BASE_NOT_FOUND while TJ has unsaved edits in the run, placed elsewhere in the same doc', async () => {
    let d = await docOf(TEXT)
    const r1 = claudeQuote(d, 'quick brown', 'slow red')
    const r2 = claudeQuote(d, 'bold', 'strong')
    d = replaceText(d, find(d.state.doc, 'lazy').from, find(d.state.doc, 'lazy').to, 'sleepy')
    expect(hydrate(d.state, r1, { md: d.md, loaded: d.L })).toEqual({ unplaced: 'BASE_NOT_FOUND' })
    expect('tr' in hydrate(d.state, r2, { md: d.md, loaded: d.L })).toBe(true)
  })

  it('hydrates next to another pending suggestion in the same paragraph, keeping both ids', async () => {
    const d = await docOf(TEXT)
    const a = claudeQuote(d, 'quick', 'slow')
    const b = claudeQuote(d, 'lazy', 'sleepy')
    const h1 = hydrate(d.state, a, { md: d.md, loaded: d.L })
    if (!('tr' in h1)) throw new Error('a unplaced')
    const s1 = d.state.apply(h1.tr)
    const h2 = hydrate(s1, b, { md: d.md, loaded: d.L })
    if (!('tr' in h2)) throw new Error(`b unplaced ${JSON.stringify(h2)}`)
    const s2 = s1.apply(h2.tr)
    expect(suggestionIdsIn(s2.doc)).toEqual(new Set([a.id, b.id]))
    expect(sameContent(revertAll(s2.doc).doc, d.L.doc)).toBe(true)
    // apply one, revert the other: exactly b's text change remains
    const onlyB = onlyApplied(s2.doc, new Set([b.id])).doc
    expect(sameContent(onlyB, load(d.md, applyToSource(d.md, d.L, b).text).doc)).toBe(true)
  })

  it('hydration never moves the selection', async () => {
    const d = await docOf(TEXT)
    const caret = find(d.state.doc, 'Second').from + 3
    const st = d.state.apply(d.state.tr.setSelection(TextSelection.create(d.state.doc, caret)))
    const r = claudeQuote(d, 'quick brown', '')
    const h = hydrate(st, r, { md: d.md, loaded: d.L })
    if (!('tr' in h)) throw new Error('unplaced')
    const s = st.apply(h.tr)
    expect(s.doc.textBetween(s.selection.from, s.selection.from + 5)).toBe(st.doc.textBetween(caret, caret + 5))
  })
})

describe('extract and tjSuggestionDiff (§6.4)', () => {
  it('extract(hydrate(r)) round-trips the record (G5 a)', async () => {
    const d = await docOf(TEXT)
    for (const r of [claudeQuote(d, 'quick brown', 'slow red'), claudeQuote(d, 'bold', 'strong'), claudeBlock(d, 1, 'Split.\n\nIn two.')]) {
      const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
      if (!('tr' in h)) throw new Error('unplaced')
      const u = extract(d.state.apply(h.tr), r.id, { md: d.md, loaded: d.L })
      expect(u).not.toBeNull()
      expect(u!.base).toBe(r.base)
      expect(sameProposal(d.md, u!.proposed, r.proposed)).toBe(true)
    }
  })

  it("TJ's Suggesting-mode replace extracts to a record whose byte splice equals live-with-only-id (G5 b)", async () => {
    let d = await docOf(TEXT, { suggesting: true })
    const w = find(d.state.doc, 'brown')
    d = replaceText(d, w.from, w.to, 'grey', () => 's_T1' as SuggestionId)
    const u = extract(d.state, 's_T1' as SuggestionId, { md: d.md, loaded: d.L })!
    expect(u.range).toEqual({ start: 1, end: 2 })
    expect(u.base).toBe('The quick brown fox jumps over the lazy dog.')
    expect(u.proposed).toBe('The quick grey fox jumps over the lazy dog.')
    expect(u.anchor.quote).toBe('brown')
    const spliced = load(d.md, applyToSource(d.md, d.L, { ...u, range: { ...u.range, rev: 0 }, hunks: [] }).text)
    expect(sameContent(spliced.doc, savedDoc(d, onlyApplied(d.state.doc, new Set(['s_T1'])).doc))).toBe(true)
  })

  it('a split (Enter) in Suggesting mode extracts as one block run → two blocks, and reverts cleanly', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    const at = find(d.state.doc, 'jumps').from
    const split = d.state.tr.setSelection(TextSelection.create(d.state.doc, at)).split(at)
    d = userDispatch(d, split, () => 's_T2' as SuggestionId)
    expect(sameContent(revertAll(d.state.doc).doc, d.L.doc)).toBe(true)
    expect(planSave(d.md, d.L, revertAll(d.state.doc).doc)).toEqual([])
    const u = extract(d.state, 's_T2' as SuggestionId, { md: d.md, loaded: d.L })!
    const spliced = load(d.md, applyToSource(d.md, d.L, { ...u, range: { ...u.range, rev: 0 }, hunks: [] }).text)
    expect(sameContent(spliced.doc, savedDoc(d, onlyApplied(d.state.doc, new Set(['s_T2'])).doc))).toBe(true)
  })

  it('a pure insertion of a new paragraph widens the run to its neighbour (§6.1)', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    const end = find(d.state.doc, 'lazy dog.').to
    const tr = d.state.tr.setSelection(TextSelection.create(d.state.doc, end)).split(end).insertText('A new paragraph.')
    d = userDispatch(d, tr, () => 's_T3' as SuggestionId)
    const u = extract(d.state, 's_T3' as SuggestionId, { md: d.md, loaded: d.L })!
    expect(u.base).toBe('The quick brown fox jumps over the lazy dog.')
    expect(u.proposed).toBe('The quick brown fox jumps over the lazy dog.\n\nA new paragraph.')
  })

  it('tjSuggestionDiff: new ids upsert, unchanged records do not, absent pending TJ ids withdraw, decided ids with marks reopen', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    const w = find(d.state.doc, 'brown')
    d = replaceText(d, w.from, w.to, 'grey', () => 's_T1' as SuggestionId)
    const ctx = { md: d.md, loaded: d.L }
    const first = tjSuggestionDiff(d.state, review([]), ctx)
    expect(first.upsert.map((u) => u.id)).toEqual(['s_T1'])
    const u = first.upsert[0]!
    const stored = record({ range: { ...u.range, rev: 1 }, base: u.base, proposed: u.proposed, hunks: [] }, { id: 's_T1' as SuggestionId, by: 'TJ' })
    expect(tjSuggestionDiff(d.state, review([stored]), ctx)).toEqual({ upsert: [], withdraw: [], reopen: [] })
    // a stored TJ record whose marks are gone → withdraw
    const ghost = record({ range: { start: 3, end: 4, rev: 1 }, base: 'x', proposed: 'y', hunks: [] }, { id: 's_T9' as SuggestionId, by: 'TJ' })
    expect(tjSuggestionDiff(d.state, review([stored, ghost]), ctx).withdraw).toEqual(['s_T9'])
    // decided by TJ with marks present again (an undo) → reopen
    expect(tjSuggestionDiff(d.state, review([{ ...stored, status: 'accepted', decidedBy: 'TJ' }]), ctx).reopen).toEqual(['s_T1'])
    // Claude's ids are never upserted
    const r = claudeQuote(d, 'lazy', 'sleepy')
    const h = hydrate(d.state, r, ctx)
    if (!('tr' in h)) throw new Error('unplaced')
    const s = d.state.apply(h.tr)
    expect(tjSuggestionDiff(s, review([stored, r]), ctx)).toEqual({ upsert: [], withdraw: [], reopen: [] })
  })
})

describe('decideSuggestions (vendored, id-scoped)', () => {
  it('apply and revert touch only the named ids, modifications included', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    d = replaceText(d, find(d.state.doc, 'quick').from, find(d.state.doc, 'quick').to, 'slow', () => 's_A' as SuggestionId)
    // a heading level change tracked as a modification under another id
    const h = d.state.doc.child(0)
    expect(h.type.name).toBe('heading')
    d = userDispatch(d, d.state.tr.setNodeMarkup(0, undefined, { ...h.attrs, level: 2 }), () => 's_B' as SuggestionId)
    expect(suggestionIdsIn(d.state.doc)).toEqual(new Set(['s_A', 's_B']))
    const onlyA = decideSuggestions(d.state.tr, new Set(['s_A']), 'apply')
    expect(suggestionIdsIn(onlyA.doc)).toEqual(new Set(['s_B']))
    expect(onlyA.doc.child(0).attrs.level).toBe(2)
    const revB = decideSuggestions(d.state.tr, new Set(['s_B']), 'revert')
    expect(suggestionIdsIn(revB.doc)).toEqual(new Set(['s_A']))
    expect(revB.doc.child(0).attrs.level).toBe(1)
    expect(sameContent(revertAll(d.state.doc).doc, d.L.doc)).toBe(true)
  })

  it('alignLive maps entries through other suggestions and splits', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    const at = find(d.state.doc, 'jumps').from
    d = userDispatch(d, d.state.tr.split(at), () => 's_S' as SuggestionId)
    const al = alignLive(d.state.doc, d.L)
    expect(al.entries).not.toBeNull()
    expect(al.entries!.length).toBe(d.L.entries.length)
  })
})

describe('a Claude suggestion across neighbouring table cells (final pass 2026-11-16, 11/13 trial bug)', () => {
  const TABLE = 'Intro.\n\n| Deal | Member | Term |\n|:-----|-------:|:----:|\n| Alpha | 12.0% | 9 mo |\n| Beta | 10.5% | 12 mo |\n\nOutro.\n'
  const cells = (doc: import('@milkdown/kit/prose/model').Node): string[][] => {
    const rows: string[][] = []
    doc.descendants((n) => {
      if (n.type.name === 'table_row' || n.type.name === 'table_header_row') {
        const r: string[] = []
        n.forEach((c) => r.push(c.textContent))
        rows.push(r)
        return false
      }
      return true
    })
    return rows
  }
  for (const [name, replace, want] of [
    ['replace in two cells', '| Alpha | 13.0% | 10 mo |', ['Alpha', '13.0%', '10 mo']],
    ['empty one cell, trim the next', '| Alpha |  | mo |', ['Alpha', '', 'mo']],
  ] as const) {
    it(`${name}: each cell keeps its own text on accept, and reject restores the base`, async () => {
      const d = await docOf(TABLE)
      const r = claudeQuote(d, '| Alpha | 12.0% | 9 mo |', replace)
      const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
      if (!('tr' in h)) throw new Error(`unplaced ${JSON.stringify(h)}`)
      const s = d.state.apply(h.tr)
      const applied = onlyApplied(s.doc, new Set([r.id])).doc
      expect(cells(applied)[1]).toEqual(want)
      expect(sameContent(applied, load(d.md, applyToSource(d.md, d.L, r).text).doc)).toBe(true)
      // the editor's own accept / reject (id-scoped decide) give the same
      expect(cells(decideSuggestions(new Transform(s.doc), new Set([r.id]), 'apply').doc)[1]).toEqual(want)
      expect(sameContent(decideSuggestions(new Transform(s.doc), new Set([r.id]), 'revert').doc, d.L.doc)).toBe(true)
    })
  }
})
