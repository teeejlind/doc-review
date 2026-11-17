// tests/unit/web/editor/suggestions.test.ts (P2; CONTRACTS §6.3–§6.5, §12.1, §12.15). The live editor's suggestion
// pipeline over a real session: Suggesting-mode typing → upsert / withdraw on save, Claude records → hydrated marks
// with our own decorations, I-SKIP on reload and hydrate, the foreign filter and D14 notices, summaries.
import { afterEach, describe, expect, it } from 'vitest'
import type { SaveRequest, SuggestionId } from '../../../../shared/types'
import { revertAll } from '../../../../core/suggest/guards'
import { contentNodes, nodeEq } from '../../../../core/splice/eq'
import { planSave } from '../../../../core/splice/plan'
import { bodiesTo } from '../session/helpers'
import { caret, find, marksOf, mount, press, replace, typeAt, typeKeys, until, userTr, type Mounted } from './helpers'

const MD = '# Title\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph here.\n\n```js\nconst a = 1\n```\n'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

describe("TJ's Suggesting mode (§6.4)", () => {
  it('typing makes TJ-owned marks, the save upserts a record and the .md keeps the base bytes', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    expect(m.bridge.getMode()).toBe('suggesting')
    replace(m.view, 'brown', 'grey')
    const ms = marksOf(m.view)
    expect(ms.map((x) => x.kind).sort()).toEqual(['deletion', 'insertion'])
    const id = ms[0]!.id
    expect(id).toMatch(/^s_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ms.every((x) => x.id === id)).toBe(true)
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe(MD)
    const saves = bodiesTo<SaveRequest>(m.transport, '/api/save')
    const up = saves.flatMap((s) => s.suggestions?.upsert ?? [])
    expect(up.map((u) => u.id)).toEqual([id])
    expect(up[0]!.base).toBe('The quick brown fox jumps over the lazy dog.')
    expect(up[0]!.proposed).toBe('The quick grey fox jumps over the lazy dog.')
    expect(saves.every((s) => s.ops.length === 0)).toBe(true)
    await until(() => m!.session.getReview().suggestions.some((s) => s.id === id))
    // the decoration: data-testid, data-suggestion, data-kind, data-by
    const spans = Array.from(m.host.querySelectorAll<HTMLElement>('[data-testid="mdr-suggestion"]'))
    expect(spans.map((s) => s.dataset.kind).sort()).toEqual(['del', 'ins'])
    expect(spans.every((s) => s.dataset.suggestion === id && s.dataset.by === 'TJ')).toBe(true)
    // no further upsert once stored (semantic comparison)
    replace(m.view, 'Second', 'Second')
    await m.session.flush()
    expect(bodiesTo<SaveRequest>(m.transport, '/api/save').flatMap((s) => s.suggestions?.upsert ?? []).length).toBe(1)
  })

  it('deleting his own insertion withdraws the record on the next save', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const at = find(m.view, 'lazy').from
    typeAt(m.view, at, 'very ')
    await m.session.flush()
    const id = marksOf(m.view)[0]!.id
    await until(() => m!.session.getReview().suggestions.some((s) => s.id === id && s.status === 'pending'))
    const ins = find(m.view, 'very ')
    userTr(m.view, (tr) => tr.delete(ins.from, ins.to))
    expect(marksOf(m.view)).toEqual([])
    await m.session.flush()
    expect(bodiesTo<SaveRequest>(m.transport, '/api/save').flatMap((s) => s.suggestions?.withdraw ?? [])).toEqual([id])
    await until(() => m!.session.getReview().suggestions.find((s) => s.id === id)?.status === 'withdrawn')
  })

  it('D14: a code-block edit is refused with SUGGEST_MODE_BLOCKED and a Switch to Editing action', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const before = m.view.state.doc
    const code = find(m.view, 'const a')
    typeAt(m.view, code.from, 'x')
    expect(m.view.state.doc.eq(before)).toBe(true)
    const n = m.notices.at(-1)!
    expect(n.code).toBe('SUGGEST_MODE_BLOCKED')
    expect(n.action?.label).toBe('Switch to Editing')
    n.action!.run()
    expect(m.bridge.getMode()).toBe('editing')
    typeAt(m.view, code.from, 'x')
    expect(m.view.state.doc.eq(before)).toBe(false)
  })

  it('a bold toggle in Suggesting mode is a format summary', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'lazy')
    userTr(m.view, (tr) => tr.addMark(r.from, r.to, m!.view.state.schema.marks.strong!.create()))
    const sums = [...m.bridge.getSuggestionSummaries().values()]
    expect(sums).toHaveLength(1)
    expect(sums[0]).toMatchObject({ by: 'TJ', kind: 'format', deletedText: 'lazy', insertedText: 'lazy', placed: true })
  })

  it('live ptext equals base ptext while suggestions are pending (§5.1 property)', async () => {
    m = await mount({ markdown: MD })
    const L = m.internals.getLoaded()!
    m.bridge.setMode('suggesting')
    const edits: Array<[string, string]> = [['quick', 'slow'], ['Second', 'Third'], ['lazy', '']]
    for (const [a, b] of edits) replace(m.view, a, b)
    const base = revertAll(m.view.state.doc).doc
    const x = contentNodes(base)
    const y = contentNodes(L.doc)
    expect(x.length === y.length && x.every((n, i) => nodeEq(n, y[i]!))).toBe(true)
  })

  describe('list-item add (S2-b) and the base guard', () => {
    const LIST = '## Goals\n\n- Grow the waitlist\n- Ship the page\n\nThe rate is reviewed.\n'
    const baseEqualsLoaded = (mm: Mounted): boolean => {
      const x = contentNodes(revertAll(mm.view.state.doc).doc)
      const y = contentNodes(mm.internals.getLoaded()!.doc)
      return x.length === y.length && x.every((n, i) => nodeEq(n, y[i]!))
    }

    it('Enter at the end of an item adds a tracked item; the save upserts it and writes no bytes', async () => {
      m = await mount({ markdown: LIST })
      m.bridge.setMode('suggesting')
      caret(m.view, 'Grow the waitlist')
      press(m, 'Enter')
      typeKeys(m.view, 'Hire a writer')
      expect(m.notices).toEqual([])
      expect(baseEqualsLoaded(m)).toBe(true)
      expect([...m.bridge.getSuggestionSummaries().values()].map((s) => [s.by, s.kind])).toEqual([['TJ', 'insert']])
      await m.session.flush()
      expect(m.fx.root.read('doc.md')).toBe(LIST)
      await until(() => m!.session.getReview().suggestions.length === 1)
      expect(m.session.getReview().suggestions[0]!.proposed).toContain('- Hire a writer')
    })

    it('a join into that list (Backspace at the next paragraph start) is refused whole: the base and the .md stay as they were', async () => {
      // suggest-changes wraps the list in a deletion, but keeps the pending split's item boundary in the deleted copy:
      // reverting it gave an empty item, which the planner wrote to disk ("- <br />")
      m = await mount({ markdown: LIST })
      m.bridge.setMode('suggesting')
      caret(m.view, 'Grow the waitlist')
      press(m, 'Enter')
      typeKeys(m.view, 'Hire')
      const before = m.view.state.doc
      caret(m.view, 'The rate', { at: 'start' })
      press(m, 'Backspace')
      expect(m.notices.at(-1)?.code).toBe('SUGGEST_MODE_BLOCKED')
      expect(m.notices.at(-1)?.text).toContain('pending suggestion')
      expect(m.view.state.doc.eq(before)).toBe(true)
      expect(baseEqualsLoaded(m)).toBe(true)
      expect(planSave(m.ed.md, m.internals.getLoaded()!, m.ed.baseDoc())).toEqual([])
      await m.session.flush()
      expect(m.fx.root.read('doc.md')).toBe(LIST)
    })

    it('the same join with no pending split is tracked as a block replace (the guard only refuses a changed base)', async () => {
      m = await mount({ markdown: LIST })
      m.bridge.setMode('suggesting')
      caret(m.view, 'The rate', { at: 'start' })
      press(m, 'Backspace')
      expect(m.notices).toEqual([])
      expect(marksOf(m.view).length).toBeGreaterThan(0)
      expect(baseEqualsLoaded(m)).toBe(true)
      await m.session.flush()
      expect(m.fx.root.read('doc.md')).toBe(LIST)
    })
  })
})

describe('Claude records in the editor (§6.3)', () => {
  it('hydrates with Claude decorations; typing inside is refused (FOREIGN_SUGGESTION), abutting is allowed with a TJ id', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'lazy dog', replace: 'sleepy cat' }] })
    const claudeId = m.session.getReview().suggestions[0]!.id
    const spans = Array.from(m.host.querySelectorAll<HTMLElement>(`[data-suggestion="${claudeId}"]`))
    expect(spans.length).toBeGreaterThan(0)
    expect(spans.every((s) => s.dataset.by === 'Claude' && s.dataset.testid === 'mdr-suggestion')).toBe(true)
    expect(m.bridge.getSuggestionSummaries().get(claudeId)).toMatchObject({ by: 'Claude', placed: true, kind: 'replace' })
    const ins = find(m.view, 'sleepy')
    typeAt(m.view, ins.from + 2, 'x')
    expect(m.notices.at(-1)?.code).toBe('FOREIGN_SUGGESTION')
    m.bridge.setMode('suggesting')
    const end = find(m.view, 'cat').to
    typeAt(m.view, end, '!')
    const mine = marksOf(m.view).filter((x) => x.text.includes('!'))
    expect(mine).toHaveLength(1)
    expect(mine[0]!.id).not.toBe(claudeId)
    expect(marksOf(m.view).filter((x) => x.text.includes('sleepy')).every((x) => x.id === claudeId)).toBe(true)
  })

  it('I-SKIP: in Suggesting mode, a Claude disk edit reloads without any tracked change', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    await m.fx.agent([{ op: 'replace_block', target: { quote: 'Second paragraph here.' }, markdown: 'Second paragraph, edited by Claude.' } as never])
    await until(() => m!.view.state.doc.textContent.includes('edited by Claude'))
    expect(marksOf(m.view)).toEqual([])
    expect(m.session.getSaveState().state).not.toBe('unsaved')
  })

  it('unplaced: a Claude suggestion in a code block is SCHEMA, a missing base is BASE_NOT_FOUND', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest_block', target: { quote: 'const a = 1' }, markdown: '```js\nconst a = 2\n```' }] })
    const sug = m.session.getReview().suggestions
    expect(sug).toHaveLength(1)
    const sum = m.bridge.getSuggestionSummaries().get(sug[0]!.id as SuggestionId)
    expect(sum).toMatchObject({ placed: false, unplaced: 'SCHEMA' })
  })
})
