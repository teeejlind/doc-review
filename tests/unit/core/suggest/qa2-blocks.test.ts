// tests/unit/core/suggest/qa2-blocks.test.ts (QA fix pass 2, findings 16 and 17).
// Two block-level Claude suggestions in one doc both place; a list or blockquote edit marks only the changed child.
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import { load } from '../../../../core/splice/load'
import { applyToSource } from '../../../../core/suggest/record'
import { extract, sameProposal } from '../../../../core/suggest/extract'
import { hydrate } from '../../../../core/suggest/hydrate'
import { kindOf, onlyApplied, revertAll, suggestionIdsIn } from '../../../../core/suggest/guards'
import { claudeBlock, claudeQuote, docOf, find, marks, record, sameContent, userDispatch, type Doc } from './helpers'
import type { SuggestionId } from '../../../../shared/types'
import type { Suggestion } from '../../../../shared/types'

const DOC = '# T\n\nSecond paragraph stays as is.\n\n- Alpha item\n- Beta item\n- Gamma item\n\nClosing paragraph.\n'
const S = {
  paraAdd: { quote: 'Second paragraph stays as is.', replace: 'Second paragraph stays as is.\n\nA brand new paragraph follows.' },
  paraDel: { quote: 'Closing paragraph.', replace: '' },
  listAdd: { quote: 'Gamma item', replace: 'Gamma item\n- Delta item' },
  wordEdit: { quote: 'stays as is', replace: 'remains unchanged' },
}
type K = keyof typeof S

function place(d: Doc, keys: K[]): { d: Doc; recs: Suggestion[] } {
  const recs = keys.map((k) => claudeQuote(d, S[k].quote, S[k].replace))
  let state = d.state
  for (const r of recs) {
    const h = hydrate(state, r, { md: d.md, loaded: d.L })
    if (!('tr' in h)) throw new Error(`${r.proposed.slice(0, 20)} unplaced: ${JSON.stringify(h)}`)
    state = state.apply(h.tr)
  }
  return { d: { ...d, state }, recs }
}

describe('two block-level suggestions in one doc (QA2 #17)', () => {
  const pairs: Array<[K, K]> = [['listAdd', 'paraAdd'], ['listAdd', 'paraDel'], ['paraAdd', 'listAdd'], ['paraDel', 'listAdd'], ['paraAdd', 'paraDel'], ['wordEdit', 'paraAdd'], ['paraAdd', 'wordEdit'], ['wordEdit', 'paraDel'], ['paraDel', 'wordEdit'], ['listAdd', 'wordEdit']]
  for (const [a, b] of pairs) {
    it(`${a} then ${b} both place, revert to the base, and accept exactly`, async () => {
      const d0 = await docOf(DOC)
      const { d, recs } = place(d0, [a, b])
      expect(new Set(marks(d.state.doc).map((m) => m.id))).toEqual(new Set(recs.map((r) => r.id)))
      expect(sameContent(revertAll(d.state.doc).doc, d0.L.doc)).toBe(true)
      for (const r of recs) {
        const server = load(d0.md, applyToSource(d0.md, d0.L, r).text)
        expect(sameContent(onlyApplied(d.state.doc, new Set([r.id])).doc, server.doc)).toBe(true)
      }
    })
  }
})

// ------------------------------------------------------------------------------------------------------------
// QA2 #16: adding or removing a child of a list / blockquote marks only that child
// ------------------------------------------------------------------------------------------------------------

/** The text under each node (or text run) that carries a mark of `kind`, nested ones counted once. */
function markedText(doc: PMNode, kind: 'ins' | 'del'): string[] {
  const out: string[] = []
  doc.descendants((n) => {
    if (n.marks.some((m) => kindOf(m) === kind)) {
      out.push(n.textContent)
      return false
    }
    return true
  })
  return out.filter((t) => t.replace(/​/g, '') !== '')
}

async function hydrateBlock(text: string, block: number, markdown: string) {
  const d = await docOf(text)
  const r = claudeBlock(d, block, markdown)
  const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
  if (!('tr' in h)) throw new Error(`unplaced ${JSON.stringify(h)}`)
  const s = d.state.apply(h.tr)
  // reverts to the base and accepts to the server's splice, byte for byte
  expect(sameContent(revertAll(s.doc).doc, d.L.doc)).toBe(true)
  expect(sameContent(onlyApplied(s.doc, new Set([r.id])).doc, load(d.md, applyToSource(d.md, d.L, r).text).doc)).toBe(true)
  // and the marks read back as the same record (G5 a)
  const u = extract(s, r.id, { md: d.md, loaded: d.L })!
  expect(u.base).toBe(r.base)
  expect(sameProposal(d.md, u.proposed, r.proposed)).toBe(true)
  return { d, s, r }
}

const LIST = '# T\n\nIntro paragraph.\n\n- Alpha item\n- Beta item\n- Gamma item\n\nClosing paragraph.\n'

describe('adding or removing a list item or blockquote line marks only that child (QA2 #16)', () => {
  it('Claude adds a bullet: only the new item is inserted, nothing is struck', async () => {
    const d = await docOf(LIST)
    const r = claudeQuote(d, 'Gamma item', 'Gamma item\n- Delta item')
    const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
    if (!('tr' in h)) throw new Error(`unplaced ${JSON.stringify(h)}`)
    const s = d.state.apply(h.tr)
    expect(markedText(s.doc, 'del')).toEqual([])
    expect(markedText(s.doc, 'ins')).toEqual(['Delta item'])
    expect(sameContent(revertAll(s.doc).doc, d.L.doc)).toBe(true)
    expect(sameContent(onlyApplied(s.doc, new Set([r.id])).doc, load(d.md, applyToSource(d.md, d.L, r).text).doc)).toBe(true)
  })

  it('a bullet in the middle, and one at the top', async () => {
    const mid = await hydrateBlock(LIST, 2, '- Alpha item\n- New item\n- Beta item\n- Gamma item')
    expect(markedText(mid.s.doc, 'del')).toEqual([])
    expect(markedText(mid.s.doc, 'ins')).toEqual(['New item'])
    const top = await hydrateBlock(LIST, 2, '- First item\n- Alpha item\n- Beta item\n- Gamma item')
    expect(markedText(top.s.doc, 'del')).toEqual([])
    expect(markedText(top.s.doc, 'ins')).toEqual(['First item'])
  })

  it('Claude removes a bullet: only that item is struck', async () => {
    const { s } = await hydrateBlock(LIST, 2, '- Alpha item\n- Gamma item')
    expect(markedText(s.doc, 'ins')).toEqual([])
    expect(markedText(s.doc, 'del')).toEqual(['Beta item'])
  })

  it('a numbered list keeps working when an item is added (labels renumber on their own)', async () => {
    const { s } = await hydrateBlock('1. One\n2. Two\n3. Three\n', 0, '1. One\n2. Two\n3. Two and a half\n4. Three')
    expect(markedText(s.doc, 'del')).toEqual([])
    expect(markedText(s.doc, 'ins')).toEqual(['Two and a half'])
  })

  it('a new nested bullet', async () => {
    const { s } = await hydrateBlock('- Parent\n  - Child one\n- Sibling\n', 0, '- Parent\n  - Child one\n  - Child two\n- Sibling')
    expect(markedText(s.doc, 'del')).toEqual([])
    expect(markedText(s.doc, 'ins')).toEqual(['Child two'])
  })

  it('a new line in a blockquote, and one removed', async () => {
    const add = await hydrateBlock('Before.\n\n> Quote line one.\n\nAfter.\n', 1, '> Quote line one.\n>\n> Quote line two.')
    expect(markedText(add.s.doc, 'del')).toEqual([])
    expect(markedText(add.s.doc, 'ins')).toEqual(['Quote line two.'])
    const del = await hydrateBlock('Before.\n\n> Quote line one.\n>\n> Quote line two.\n\nAfter.\n', 1, '> Quote line one.')
    expect(markedText(del.s.doc, 'ins')).toEqual([])
    expect(markedText(del.s.doc, 'del')).toEqual(['Quote line two.'])
  })

  it('an added item and a reworded item in one suggestion: the reword is a word diff, the item is inserted', async () => {
    const { s } = await hydrateBlock(LIST, 2, '- Alpha item\n- Beta entry\n- Gamma item\n- Delta item')
    expect(markedText(s.doc, 'del')).toEqual(['item'])
    expect(markedText(s.doc, 'ins')).toEqual(['entry', 'Delta item'])
  })

  it('a new paragraph after a paragraph inserts only the paragraph', async () => {
    const { s } = await hydrateBlock(LIST, 1, 'Intro paragraph.\n\nA new paragraph.')
    expect(markedText(s.doc, 'del')).toEqual([])
    expect(markedText(s.doc, 'ins')).toEqual(['A new paragraph.'])
  })

  it('still places next to another suggestion in the same list, both ids kept', async () => {
    const d = await docOf(LIST)
    const a = claudeQuote(d, 'Alpha', 'Apex')
    const b = claudeQuote(d, 'Gamma item', 'Gamma item\n- Delta item')
    let state = d.state
    for (const r of [a, b]) {
      const h = hydrate(state, r, { md: d.md, loaded: d.L })
      if (!('tr' in h)) throw new Error(`${r.id} unplaced ${JSON.stringify(h)}`)
      state = state.apply(h.tr)
    }
    expect(suggestionIdsIn(state.doc)).toEqual(new Set([a.id, b.id]))
    expect(sameContent(revertAll(state.doc).doc, d.L.doc)).toBe(true)
    for (const r of [a, b]) expect(sameContent(onlyApplied(state.doc, new Set([r.id])).doc, load(d.md, applyToSource(d.md, d.L, r).text).doc)).toBe(true)
  })

  it('a list that becomes a different list type is still one replace', async () => {
    const { s } = await hydrateBlock(LIST, 2, '1. Alpha item\n2. Beta item\n3. Gamma item')
    expect(markedText(s.doc, 'del').length).toBeGreaterThan(0)
  })

  it("TJ's Enter + typing at the end of a bullet, extracted and hydrated on a fresh load, marks only the new bullet", async () => {
    let d = await docOf(LIST, { suggesting: true })
    const end = find(d.state.doc, 'Gamma item').to
    const tr = d.state.tr.setSelection(TextSelection.create(d.state.doc, end)).split(end, 2).insertText('Delta item')
    d = userDispatch(d, tr, () => 's_TJ' as SuggestionId)
    const u = extract(d.state, 's_TJ' as SuggestionId, { md: d.md, loaded: d.L })!
    expect(u.base).toBe('- Alpha item\n- Beta item\n- Gamma item')
    expect(u.proposed).toBe('- Alpha item\n- Beta item\n- Gamma item\n- Delta item')
    const fresh = await docOf(LIST)
    const r = record({ range: { ...u.range, rev: 0 }, base: u.base, proposed: u.proposed, hunks: [] }, { id: 's_TJ' as SuggestionId, by: 'TJ' })
    const h = hydrate(fresh.state, r, { md: fresh.md, loaded: fresh.L })
    if (!('tr' in h)) throw new Error(`unplaced ${JSON.stringify(h)}`)
    const s = fresh.state.apply(h.tr)
    expect(markedText(s.doc, 'del')).toEqual([])
    expect(markedText(s.doc, 'ins')).toEqual(['Delta item'])
    expect(sameContent(revertAll(s.doc).doc, fresh.L.doc)).toBe(true)
  })
})
