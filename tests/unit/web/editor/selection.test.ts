// tests/unit/web/editor/selection.test.ts (P2; CONTRACTS §12.1 getSelectionTarget, §5.2, §13 #80, #90). Selection
// mapping around insertions and atoms. jsdom has no layout, so rects are zeros here (p2-rects covers them).
import { afterEach, describe, expect, it } from 'vitest'
import { NodeSelection } from '@milkdown/kit/prose/state'
import { createAnchor } from '../../../../core/anchors'
import { ptextOf } from '../../../../core/ptext'
import { CONSTANTS } from '../../../../shared/constants'
import { find, marksOf, mount, select, typeAt, until, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const MD = 'The quick brown fox jumps over the lazy dog.\n\n---\n\nSee the [docs][r] for more.\n\n[r]: http://example.com\n'

describe('getSelectionTarget (§12.1)', () => {
  it('a collapsed caret is null, unless collapsed: word', async () => {
    m = await mount({ markdown: MD })
    const r = find(m.view, 'quick')
    select(m.view, r.from + 2, r.from + 2)
    expect(m.bridge.getSelectionTarget()).toBeNull()
    const t = m.bridge.getSelectionTarget({ collapsed: 'word' })
    expect(t?.kind).toBe('anchor')
    if (t?.kind === 'anchor') expect(t.quote).toBe('quick')
  })

  it('from base text into a Claude insertion: the anchor covers base text only (§13 #80)', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'brown fox', replace: 'brown red fox' }] })
    const ins = marksOf(m.view).find((x) => x.kind === 'insertion')!
    expect(ins.text).toContain('red')
    const from = find(m.view, 'quick').from
    const mid = find(m.view, 'red').from + 1
    select(m.view, from, mid)
    const t = m.bridge.getSelectionTarget()
    expect(t?.kind).toBe('anchor')
    if (t?.kind === 'anchor') {
      expect(t.quote).toBe('quick brown')
      expect(t.anchor.quote).toBe('quick brown')
    }
  })

  it('starting inside a TJ insertion: the start maps forward to the next base offset', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    typeAt(m.view, find(m.view, 'quick').from, 'very ')
    const inside = find(m.view, 'very').from + 2
    select(m.view, inside, find(m.view, 'brown').to)
    const t = m.bridge.getSelectionTarget()
    expect(t?.kind === 'anchor' && t.quote).toBe('quick brown')
  })

  it('entirely inside an insertion: inside-suggestion with its thread', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'brown fox', replace: 'brown reddish fox' }] })
    const s = m.session.getReview().suggestions[0]!
    const r = find(m.view, 'reddish')
    select(m.view, r.from + 1, r.from + 4)
    expect(m.bridge.getSelectionTarget()).toMatchObject({ kind: 'inside-suggestion', suggestion: s.id, thread: s.thread })
  })

  it('two insertions with base text between: inserted text excluded, deleted text included', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    typeAt(m.view, find(m.view, 'quick').from, 'AAA ')
    typeAt(m.view, find(m.view, 'fox').from, 'BBB ')
    const del = find(m.view, 'brown')
    m.view.dispatch(m.view.state.tr.delete(del.from, del.to)) // a tracked deletion (base text stays)
    select(m.view, find(m.view, 'AAA').from, find(m.view, 'BBB').to)
    const t = m.bridge.getSelectionTarget()
    expect(t?.kind === 'anchor' && t.quote).toBe('quick brown')
  })

  it('only an hr, or only a raw block: kind block for the first atom', async () => {
    m = await mount({ markdown: MD })
    let hr = -1
    let raw = -1
    m.view.state.doc.forEach((n, pos) => {
      if (n.type.name === 'hr') hr = pos
      if (n.type.name === 'raw_block') raw = pos
    })
    m.view.dispatch(m.view.state.tr.setSelection(NodeSelection.create(m.view.state.doc, hr)))
    const t = m.bridge.getSelectionTarget()
    expect(t?.kind).toBe('block')
    if (t?.kind === 'block') expect(t.anchor.hint.mdType).toBe('thematicBreak')
    m.view.dispatch(m.view.state.tr.setSelection(NodeSelection.create(m.view.state.doc, raw)))
    const r = m.bridge.getSelectionTarget()
    expect(r?.kind).toBe('block')
    if (r?.kind === 'block') expect(r.anchor.hint.kind).toBe('raw')
  })

  it(`a select-all over ${CONSTANTS.MAX_QUOTE_CHARS} ptext characters returns the long form, deepEqual to createAnchor (§13 #90)`, async () => {
    const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. '
    const body = Array.from({ length: 140 }, (_, i) => `${para}${i}.`).join('\n\n') + '\n'
    m = await mount({ markdown: body })
    select(m.view, 0, m.view.state.doc.content.size)
    const t = m.bridge.getSelectionTarget()
    expect(t?.kind).toBe('anchor')
    if (t?.kind !== 'anchor') return
    const L = m.internals.getLoaded()!
    const p = ptextOf(L.doc, L)
    expect(p.text.length).toBeGreaterThan(CONSTANTS.MAX_QUOTE_CHARS)
    const want = createAnchor(p, L.blocks, 0, p.text.length, m.session.getSnapshot().rev)
    expect(t.anchor).toEqual(want)
    expect(t.anchor.span).toBe(p.text.length)
    expect(t.anchor.quote).toHaveLength(CONSTANTS.LONG_QUOTE_EDGE_CHARS)
    expect(t.quote).toBe(t.anchor.quote)
    await until(() => true)
  })
})
