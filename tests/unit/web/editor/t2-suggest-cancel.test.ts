// tests/unit/web/editor/t2-suggest-cancel.test.ts (T2 suggest track). Pass 4 #34: deleting a word and typing the same
// word back in Suggesting mode is no change, so it leaves no marks (they had no card and no record, and nobody could
// accept or reject them).
import { afterEach, describe, expect, it } from 'vitest'
import type { SaveRequest } from '../../../../shared/types'
import { bodiesTo } from '../session/helpers'
import { caret, find, marksOf, mount, select, typeKeys, userTr, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const MD = '# Title\n\nIntro paragraph with some words in it.\n\nTail.\n'
const upserts = (mm: Mounted) => bodiesTo<SaveRequest>(mm.transport, '/api/save').flatMap((s) => s.suggestions?.upsert ?? [])

describe('Pass 4 #34: delete a word, type it back', () => {
  it('Backspace over the selected word, then the word typed: no marks, the text is as it was', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'some')
    select(m.view, r.from, r.to)
    m.ed.runAction('backspace', m.view)
    expect(marksOf(m.view).map((x) => x.kind)).toEqual(['deletion'])
    typeKeys(m.view, 'some')
    expect(marksOf(m.view)).toEqual([])
    expect(m.view.state.doc.textContent).toContain('Intro paragraph with some words in it.')
    // the caret is right after the word, where typing it back left it
    expect(m.view.state.selection.from).toBe(find(m.view, 'some').to)
    await m.session.flush()
    expect(upserts(m)).toEqual([])
    expect(m.session.getReview().suggestions).toEqual([])
    expect(m.fx.root.read('doc.md')).toBe(MD)
  })

  it('typing the same word over the selection in one go cancels too', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'some')
    userTr(m.view, (tr) => tr.insertText('some', r.from, r.to))
    expect(marksOf(m.view)).toEqual([])
  })

  it('only the whole word cancels: a different word, or a longer one, is still a change', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'some')
    select(m.view, r.from, r.to)
    m.ed.runAction('backspace', m.view)
    typeKeys(m.view, 'so')
    expect(marksOf(m.view).map((x) => x.kind).sort()).toEqual(['deletion', 'insertion'])
    typeKeys(m.view, 'meone')
    // "some" was whole at one point and cancelled, "one" went on after it: the change that is left is the addition
    expect(marksOf(m.view).map((x) => `${x.kind}:${x.text}`)).toEqual(['insertion:one'])
    expect(m.view.state.doc.textContent).toContain('Intro paragraph with someone words in it.')
  })

  it('a different word stays a replace', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'some')
    userTr(m.view, (tr) => tr.insertText('few', r.from, r.to))
    expect(marksOf(m.view).map((x) => `${x.kind}:${x.text}`).sort()).toEqual(['deletion:some', 'insertion:few'])
  })

  it('the same words in other formatting stay a change (a bold toggle)', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'some')
    userTr(m.view, (tr) => tr.addMark(r.from, r.to, m!.view.state.schema.marks.strong!.create()))
    expect(marksOf(m.view).map((x) => x.kind).sort()).toEqual(['deletion', 'insertion'])
  })

  it('one undo takes the whole retype back, struck word and all', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'some')
    select(m.view, r.from, r.to)
    m.ed.runAction('backspace', m.view)
    typeKeys(m.view, 'some')
    expect(marksOf(m.view)).toEqual([])
    m.ed.runAction('undo', m.view)
    // back to the strike alone (the typed letters went in one undo event, or the cancel went with the last one)
    expect(marksOf(m.view).filter((x) => x.kind === 'insertion').map((x) => x.text).join('')).not.toBe('some')
    expect(m.view.state.doc.textContent).toContain('some')
  })

  it("Claude's suggestion is never cancelled by a retype next to it", async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'some', replace: 'a few' }] })
    m.bridge.setMode('suggesting')
    const before = marksOf(m.view).map((x) => `${x.kind}:${x.text}`).sort()
    caret(m.view, 'Tail.')
    typeKeys(m.view, 'x')
    expect(marksOf(m.view).map((x) => `${x.kind}:${x.text}`).filter((x) => !x.endsWith(':x')).sort()).toEqual(before)
  })
})
