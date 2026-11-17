// tests/unit/core/suggest/guards.test.ts (P2; CONTRACTS §6.5). I-SKIP, the I-ID cases, the foreign-content filter
// predicate and one rejected transaction per D14 Suggesting-mode block (plus the allowed neighbours).
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { suggestChangesKey, withSuggestChanges } from '@handlewithcare/prosemirror-suggest-changes'
import { load } from '../../../../core/splice/load'
import { foreignViolation, reassignIds, revertAll, suggestModeViolation } from '../../../../core/suggest/guards'
import { hydrate } from '../../../../core/suggest/hydrate'
import { buildMinimalReplaceTr } from '../../../../web/src/session/remote'
import type { SuggestionId } from '../../../../shared/types'
import { Transform } from '@milkdown/kit/prose/transform'
import { claudeQuote, docOf, find, marks, replaceText, sameContent, typeAt, userDispatch, type Doc } from './helpers'

const TEXT = 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph here.\n'

function placed(d: Doc, quote: string, replace: string, id: string): Doc {
  const r = claudeQuote(d, quote, replace, id as SuggestionId)
  const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
  if (!('tr' in h)) throw new Error(`unplaced ${JSON.stringify(h)}`)
  return { ...d, state: d.state.apply(h.tr) }
}

const idsOf = (doc: PMNode, text: string): string[] => [...new Set(marks(doc).filter((m) => m.text.includes(text)).map((m) => m.id))]

describe('I-SKIP (§6.5)', () => {
  it('in Suggesting mode, a reload transaction and a hydrate dispatched through withSuggestChanges add no tracked change', async () => {
    const d = await docOf(TEXT, { suggesting: true })
    const view = { state: d.state as EditorState }
    const dispatch = withSuggestChanges(function (this: { state: EditorState }, tr: Transaction) {
      this.state = this.state.apply(tr)
    })
    // a remote write: paragraph 2 changed on disk
    const next = load(d.md, 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph changed.\n')
    const reload = buildMinimalReplaceTr(view.state, d.L, next)!
    dispatch.call(view as never, reload)
    expect(marks(view.state.doc)).toEqual([])
    expect(view.state.doc.child(1).textContent).toBe('Second paragraph changed.')
    // a hydrate adds exactly its own marks, never a second transform
    const r = claudeQuote({ ...d, L: next }, 'lazy', 'sleepy', 's_H' as SuggestionId)
    const h = hydrate(view.state, r, { md: d.md, loaded: next })
    if (!('tr' in h)) throw new Error('unplaced')
    dispatch.call(view as never, h.tr)
    expect(new Set(marks(view.state.doc).map((m) => m.id))).toEqual(new Set(['s_H']))
    expect(sameContent(revertAll(view.state.doc).doc, next.doc)).toBe(true)
  })
})

describe('I-ID (§6.5 idGuard)', () => {
  it('TJ typing immediately before, at the del/ins boundary of, and after a Claude insertion gets TJ ids; Claude keeps its own', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    d = placed(d, 'quick', 'slow', 's_C1')
    const ins = find(d.state.doc, 'slow')
    d = typeAt(d, ins.to, 'X') // right after Claude's insertion
    expect(idsOf(d.state.doc, 'slow')).toEqual(['s_C1'])
    const afterId = idsOf(d.state.doc, 'X')
    expect(afterId).toHaveLength(1)
    expect(afterId[0]).not.toBe('s_C1')
    const del = find(d.state.doc, 'quick')
    d = typeAt(d, del.from, 'Y') // right before Claude's deletion
    expect(idsOf(d.state.doc, 'Y')[0]).not.toBe('s_C1')
    const boundary = find(d.state.doc, 'slow').from // between Claude's deletion and insertion
    d = typeAt(d, boundary, 'Z')
    expect(idsOf(d.state.doc, 'Z')[0]).not.toBe('s_C1')
    expect(idsOf(d.state.doc, 'slow')).toEqual(['s_C1'])
    expect(idsOf(d.state.doc, 'quick')).toEqual(['s_C1'])
  })

  it('TJ typing between his own insertion and a Claude insertion keeps both ids', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    d = placed(d, 'fox', 'fox cub', 's_C2') // Claude inserts "cub " right after "fox "
    const claudeIns = find(d.state.doc, 'cub')
    d = typeAt(d, claudeIns.from, 'AB', () => 's_T1' as SuggestionId) // TJ's insertion, abutting Claude's on its right
    const tjEnd = find(d.state.doc, 'AB').to
    d = typeAt(d, tjEnd, 'CD', () => 's_T2' as SuggestionId) // between his own and Claude's
    expect(idsOf(d.state.doc, 'cub')).toEqual(['s_C2'])
    const tj = new Set([...idsOf(d.state.doc, 'AB'), ...idsOf(d.state.doc, 'CD')])
    expect(tj.has('s_C2' as never)).toBe(false)
  })

  it('two suggestions abutting by one character: deleting the character between them keeps the Claude id', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    d = placed(d, 'brown', 'red', 's_C3')
    const red = find(d.state.doc, 'red')
    d = typeAt(d, red.from - 'brown '.length - 1, 'Q', () => 's_T3' as SuggestionId) // TJ inserts before "quick"'s last space region
    // delete the space between "quick" and Claude's deletion "brown" (one character, abutting the Claude mark)
    const space = find(d.state.doc, 'brown').from - 1
    d = { ...d, state: d.state.apply(d.state.tr) }
    const tr = d.state.tr.delete(space, space + 1)
    const { userDispatch } = await import('./helpers')
    d = userDispatch(d, tr, () => 's_T4' as SuggestionId)
    expect(idsOf(d.state.doc, 'brown')).toEqual(['s_C3'])
    expect(idsOf(d.state.doc, 'red')).toEqual(['s_C3'])
  })
})

describe('foreign-content filter predicate (§6.5)', () => {
  it('rejects edits inside or over Claude marks and allows abutment, in both modes', async () => {
    let d = await docOf(TEXT)
    d = placed(d, 'quick', 'slow', 's_C4')
    const isForeign = (id: SuggestionId): boolean => id === 's_C4'
    const slow = find(d.state.doc, 'slow')
    expect(foreignViolation(d.state.tr.insertText('x', slow.from + 2), isForeign)).toBe(true) // inside the insertion
    expect(foreignViolation(d.state.tr.delete(slow.from, slow.from + 1), isForeign)).toBe(true) // deleting part of it
    const quick = find(d.state.doc, 'quick')
    expect(foreignViolation(d.state.tr.delete(quick.from - 2, quick.from + 2), isForeign)).toBe(true) // over the deletion
    const strong = d.md.schema.marks.strong!
    expect(foreignViolation(d.state.tr.addMark(slow.from, slow.to, strong.create()), isForeign)).toBe(true) // a format toggle
    expect(foreignViolation(d.state.tr.insertText('x', slow.to), isForeign)).toBe(false) // abutting after
    expect(foreignViolation(d.state.tr.insertText('x', quick.from), isForeign)).toBe(false) // abutting before
    const lazy = find(d.state.doc, 'lazy')
    expect(foreignViolation(d.state.tr.insertText('sleepy', lazy.from, lazy.to), isForeign)).toBe(false) // elsewhere
    // TJ's own marks are not foreign
    expect(foreignViolation(d.state.tr.insertText('x', slow.from + 2), () => false)).toBe(false)
  })
})

describe('D14 Suggesting-mode blocks (§6.5)', () => {
  const DOC = [
    '---', 'title: Plan', '---', '',
    'Text with <span>inline</span> html.', '',
    '```js', 'const a = 1', '```', '',
    '| a | b |', '|---|---|', '| c | d |', '',
    '---', '',
    'See [x][r].', '',
    '[r]: http://example.com', '',
  ].join('\n')

  async function setup(): Promise<{ d: Doc; at: (name: string) => number }> {
    const d = await docOf(DOC, { suggesting: true })
    const at = (name: string): number => {
      let pos = -1
      d.state.doc.descendants((n, p) => {
        if (pos < 0 && n.type.name === name) pos = p
        return pos < 0
      })
      if (pos < 0) throw new Error(`no ${name}`)
      return pos
    }
    return { d, at }
  }

  it('one rejected transaction per D14 item', async () => {
    const { d, at } = await setup()
    const s = d.state
    const sch = d.md.schema
    expect(suggestModeViolation(s.tr.insertText('x', at('code_block') + 2))).toBe('code-block')
    const table = at('table')
    const tableNode = s.doc.nodeAt(table)!
    const row = tableNode.child(1)
    expect(suggestModeViolation(s.tr.insert(table + tableNode.nodeSize - 1, row.copy(row.content)))).toBe('table-structure')
    expect(suggestModeViolation(s.tr.setNodeAttribute(at('table_cell'), 'alignment', 'center'))).toBe('table-structure')
    expect(suggestModeViolation(s.tr.delete(table, table + tableNode.nodeSize))).toBe('table')
    expect(suggestModeViolation(s.tr.insert(0, tableNode.copy(tableNode.content)))).toBe('table')
    expect(suggestModeViolation(s.tr.setNodeAttribute(at('frontmatter'), 'value', 'title: Other'))).toBe('frontmatter')
    expect(suggestModeViolation(s.tr.setNodeAttribute(at('raw_block'), 'value', '[r]: http://other.example'))).toBe('raw-block')
    expect(suggestModeViolation(s.tr.setNodeAttribute(at('html'), 'value', '<em>'))).toBe('inline-html')
    const hr = at('hr')
    expect(suggestModeViolation(s.tr.delete(hr, hr + 1))).toBe('atom-block')
    expect(suggestModeViolation(s.tr.insert(hr, sch.nodes.hr!.create()))).toBe('atom-block')
    const fm = at('frontmatter')
    expect(suggestModeViolation(s.tr.delete(fm, fm + s.doc.nodeAt(fm)!.nodeSize))).toBe('frontmatter')
  })

  it('a table cell text edit, a paragraph edit and deleting text around an inline html atom are allowed', async () => {
    const { d, at } = await setup()
    const s = d.state
    const cell = at('table_cell')
    expect(suggestModeViolation(s.tr.insertText('z', cell + 2))).toBeNull()
    const html = at('html')
    expect(suggestModeViolation(s.tr.delete(html - 2, html + 3))).toBeNull()
    const text = find(s.doc, 'See')
    expect(suggestModeViolation(s.tr.insertText('Look', text.from, text.to))).toBeNull()
    // splitting a paragraph is a tracked structure change, not a block
    expect(suggestModeViolation(s.tr.split(text.to))).toBeNull()
  })

  it('a task-checkbox toggle is blocked only while list_item cannot carry the modification mark ([pending S2-b])', async () => {
    const d = await docOf('- [ ] task\n- [x] done\n', { suggesting: true })
    let item = -1
    d.state.doc.descendants((n, p) => {
      if (item < 0 && n.type.name === 'list_item') item = p
      return item < 0
    })
    const allows = d.state.doc.child(0).type.allowsMarkType(d.md.schema.marks.modification!)
    expect(suggestModeViolation(d.state.tr.setNodeAttribute(item, 'checked', true))).toBe(allows ? null : 'task-toggle')
  })

  it('every transaction in Editing mode is free of D14 (the predicate is only consulted in Suggesting mode)', async () => {
    const { d } = await setup()
    expect(d.state.plugins.some((p) => (p as unknown as { key: string }).key === (suggestChangesKey as unknown as { key: string }).key)).toBe(true)
  })
})

describe('reassignIds (QA2 14: a redo gives the returned marks a fresh id)', () => {
  it('re-ids every mark of the named suggestion (struck and inserted text) and leaves the others and the content alone', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    const q = find(d.state.doc, 'quick')
    d = replaceText(d, q.from, q.to, 'slow', () => 's_A' as SuggestionId)
    d = typeAt(d, find(d.state.doc, 'Second').to, ' one', () => 's_B' as SuggestionId)
    const before = marks(d.state.doc)
    expect(new Set(before.map((m) => m.id))).toEqual(new Set(['s_A', 's_B']))
    const tr = reassignIds(new Transform(d.state.doc), new Map([['s_A' as SuggestionId, 's_Z' as SuggestionId]]))
    expect(tr.doc.textContent).toBe(d.state.doc.textContent)
    expect(marks(tr.doc)).toEqual(before.map((m) => (m.id === 's_A' ? { ...m, id: 's_Z' } : m)))
    // reverting still gives the original document
    expect(sameContent(revertAll(tr.doc).doc, d.L.doc)).toBe(true)
  })

  it('re-ids a node mark (a split paragraph) too', async () => {
    let d = await docOf(TEXT, { suggesting: true })
    d = userDispatch(d, d.state.tr.split(find(d.state.doc, 'brown').from), () => 's_S' as SuggestionId)
    const before = marks(d.state.doc)
    expect(before.length).toBeGreaterThan(0)
    expect(new Set(before.map((m) => m.id))).toEqual(new Set(['s_S']))
    const tr = reassignIds(new Transform(d.state.doc), new Map([['s_S' as SuggestionId, 's_Z' as SuggestionId]]))
    expect(new Set(marks(tr.doc).map((m) => m.id))).toEqual(new Set(['s_Z']))
    expect(marks(tr.doc)).toHaveLength(before.length)
    expect(sameContent(revertAll(tr.doc).doc, d.L.doc)).toBe(true)
  })
})
