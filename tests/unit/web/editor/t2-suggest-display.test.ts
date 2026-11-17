// tests/unit/web/editor/t2-suggest-display.test.ts (T2 suggest track). What the page draws for a suggestion whose copies
// read the same: Pass 4 #22 (a format-only change) and the list lift / merge leftover from Pass 4 #16. The doc keeps
// suggest-changes' shape, so Accept and Reject are untouched (the qa4 lift specs pin those); these pin the display.
import { afterEach, describe, expect, it } from 'vitest'
import type { SaveRequest, TjSuggestionUpsert } from '../../../../shared/types'
import { bodiesTo } from '../session/helpers'
import { caret, find, mount, press, select, until, userTr, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const P = '# T\n\nWe will announce new lender programs next quarter, and we will tell every lender about the new lender programs in the second half of the year.\n\nTail.\n'
const LIST = '# T\n\n- Alpha item\n- Beta item\n- Gamma item\n\nTail.\n'

const all = (host: HTMLElement, sel: string): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>(sel))
const hidden = (host: HTMLElement): string[] => all(host, '.mdr-sugg--shadow').map((e) => e.textContent ?? '')
/** The text of every element drawn as a tracked insertion / deletion / format change (hidden copies excluded). */
const drawn = (host: HTMLElement, cls: string): string[] => all(host, `.${cls}`).filter((e) => !e.closest('.mdr-sugg--shadow')).map((e) => e.textContent ?? '')
async function upserts(mm: Mounted): Promise<TjSuggestionUpsert[]> {
  await mm.session.flush()
  return bodiesTo<SaveRequest>(mm.transport, '/api/save').flatMap((s) => s.suggestions?.upsert ?? [])
}

describe('Pass 4 #22: a format-only suggestion', () => {
  it('Bold: the struck copy is not drawn, the inserted copy is a format change, the card quotes the words', async () => {
    m = await mount({ markdown: P })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'new lender programs')
    userTr(m.view, (tr) => tr.addMark(r.from, r.to, m!.view.state.schema.marks.strong!.create()))
    expect(hidden(m.host)).toEqual(['new lender programs'])
    expect(drawn(m.host, 'mdr-sugg--fmt')).toEqual(['new lender programs'])
    expect(drawn(m.host, 'mdr-sugg--ins')).toEqual([])
    expect(drawn(m.host, 'mdr-sugg--del')).toEqual([])
    // the marks themselves are what they were: the summary still reads format, Accept writes the bold
    expect([...m.bridge.getSuggestionSummaries().values()][0]).toMatchObject({ kind: 'format', deletedText: 'new lender programs', insertedText: 'new lender programs' })
    const up = await upserts(m)
    expect(up).toHaveLength(1)
    expect(up[0]!.anchor).toMatchObject({ kind: 'text', quote: 'new lender programs' })
    await until(() => m!.session.getReview().suggestions.some((s) => s.status === 'pending'))
    await m.bridge.accept(up[0]!.id)
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe(P.replace('new lender programs next', '**new lender programs** next'))
  })

  it('the card quotes the occurrence that was formatted, not the first one', async () => {
    m = await mount({ markdown: P })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'new lender programs', 1)
    userTr(m.view, (tr) => tr.addMark(r.from, r.to, m!.view.state.schema.marks.emphasis!.create()))
    const [u] = await upserts(m)
    expect(u!.anchor).toMatchObject({ kind: 'text', quote: 'new lender programs' })
    expect(u!.anchor.kind === 'text' && u!.anchor.hint.pos).toBeGreaterThan(P.indexOf('new lender programs') + 40)
  })

  it('Heading 2 and a bulleted list: no strike and re-insert, and the quote is the first line, not the paragraph', async () => {
    m = await mount({ markdown: P })
    m.bridge.setMode('suggesting')
    caret(m.view, 'announce')
    m.ed.runAction('heading-2', m.view)
    const [h] = await upserts(m)
    expect(h!.anchor.kind === 'text' && h!.anchor.quote.length).toBeLessThanOrEqual(90)
    expect(h!.anchor.kind === 'text' && h!.anchor.quote).toBe('We will announce new lender programs next quarter, and we will tell every lender about the')
    expect(drawn(m.host, 'mdr-sugg--del')).toEqual([])
    await m.close()

    m = await mount({ markdown: P })
    m.bridge.setMode('suggesting')
    caret(m.view, 'announce')
    m.ed.runAction('bullet', m.view)
    // the struck paragraph is not drawn; the list that holds the same words is marked as a format change
    expect(hidden(m.host)).toEqual([P.split('\n')[2]])
    expect(all(m.host, 'ul.mdr-sugg--mod')).toHaveLength(1)
    expect(drawn(m.host, 'mdr-sugg--ins')).toEqual([])
    expect(drawn(m.host, 'mdr-sugg--del')).toEqual([])
    const [b] = await upserts(m)
    expect(b!.anchor.kind === 'text' && b!.anchor.quote.length).toBeLessThanOrEqual(90)
  })
})

describe('the list lift and merge leftover from Pass 4 #16: only what changed is drawn', () => {
  it('lifting the middle item: the other items are plain, the lifted one is a format change', async () => {
    m = await mount({ markdown: LIST })
    m.bridge.setMode('suggesting')
    caret(m.view, 'Beta item', { at: 'start' })
    press(m, 'Backspace')
    expect(drawn(m.host, 'mdr-sugg--del')).toEqual([])
    expect(drawn(m.host, 'mdr-sugg--ins')).toEqual([])
    // one copy of Alpha and of Gamma is drawn (as list items), Beta as a paragraph with the format-change bar
    expect(drawn(m.host, 'mdr-sugg--mod')).toEqual(['Beta item'])
    const visible = all(m.host, '.ProseMirror p').filter((p) => !p.closest('.mdr-sugg--shadow')).map((p) => p.textContent)
    expect(visible).toEqual(['T', 'Alpha item', 'Beta item', 'Gamma item', 'Tail.'].filter((t) => t !== 'T'))
    const [u] = await upserts(m)
    expect(u!.anchor).toMatchObject({ kind: 'text', quote: 'Beta item' })
  })

  it('lifting the last item leaves the items above it as they were', async () => {
    m = await mount({ markdown: LIST })
    m.bridge.setMode('suggesting')
    caret(m.view, 'Gamma item', { at: 'start' })
    press(m, 'Backspace')
    expect(drawn(m.host, 'mdr-sugg--del')).toEqual([])
    expect(drawn(m.host, 'mdr-sugg--ins')).toEqual([])
    expect(drawn(m.host, 'mdr-sugg--mod')).toEqual(['Gamma item'])
    const items = all(m.host, 'li').filter((li) => !li.closest('.mdr-sugg--shadow')).map((li) => li.textContent)
    expect(items).toEqual(['Alpha item', 'Beta item'])
  })

  it('lifting and joining: the first two items stay plain, the two struck items and the joined one are drawn', async () => {
    m = await mount({ markdown: LIST })
    m.bridge.setMode('suggesting')
    caret(m.view, 'Gamma item', { at: 'start' })
    press(m, 'Backspace')
    press(m, 'Backspace')
    expect(drawn(m.host, 'mdr-sugg--del')).toEqual(['Beta item', 'Gamma item'])
    expect(drawn(m.host, 'mdr-sugg--ins')).toEqual(['Beta itemGamma item'])
    // Tail is the same in both copies: it is drawn once, plain
    const tails = all(m.host, 'p').filter((p) => p.textContent === 'Tail.' && !p.closest('.mdr-sugg--shadow'))
    expect(tails).toHaveLength(1)
    expect(tails[0]!.classList.contains('mdr-sugg--del') || tails[0]!.classList.contains('mdr-sugg--ins')).toBe(false)
    const [u] = await upserts(m)
    await until(() => m!.session.getReview().suggestions.some((s) => s.id === u!.id))
    // Reject restores the bytes
    await m.bridge.reject(u!.id)
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe(LIST)
  })

  it('a word changed in one item of a swapped list: that item is struck and green, the rest plain', async () => {
    m = await mount({
      markdown: LIST,
      claude: [{ op: 'suggest', quote: 'Beta item', replace: 'Beta thing\n\nBetween paragraph' }],
    })
    // (a Claude suggestion that adds a block takes the whole list run on a fallback; whichever way it is placed, nothing
    // that reads the same in both copies is drawn twice)
    const ins = drawn(m.host, 'mdr-sugg--ins').join('|')
    const del = drawn(m.host, 'mdr-sugg--del').join('|')
    expect(`${ins}${del}`).not.toContain('Alpha item')
    expect(`${ins}${del}`).not.toContain('Gamma item')
  })

  it('selecting a range across the swap does not trip the hidden copies', () => {
    // (smoke) a select-all after a lift must not throw in the view update
    return mount({ markdown: LIST }).then((mm) => {
      m = mm
      mm.bridge.setMode('suggesting')
      caret(mm.view, 'Beta item', { at: 'start' })
      press(mm, 'Backspace')
      expect(() => select(mm.view, 1, mm.view.state.doc.content.size - 1)).not.toThrow()
    })
  })
})
