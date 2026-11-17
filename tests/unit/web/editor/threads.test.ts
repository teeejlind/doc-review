// tests/unit/web/editor/threads.test.ts (P2; CONTRACTS §5.4, §12.1, §12.15, §13 #37, #38, #74, #90). Comment
// highlights: placed from the review state, mapped through edits, detached on genuine deletion (and reattached after
// undo), re-anchored when TJ types inside, duplicate-quote context refreshed, active / visible / click.
import { afterEach, describe, expect, it } from 'vitest'
import type { SaveRequest, TextAnchor, ThreadId } from '../../../../shared/types'
import { bodiesTo } from '../session/helpers'
import { find, mount, replace, select, typeAt, until, userTr, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const MD = '# Title\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph here.\n'

async function commentOn(mm: Mounted, text: string, body = 'A comment', nth = 0): Promise<ThreadId> {
  const r = find(mm.view, text, nth)
  select(mm.view, r.from, r.to)
  const t = mm.bridge.getSelectionTarget()
  if (t?.kind !== 'anchor' && t?.kind !== 'block') throw new Error(`no anchor target: ${JSON.stringify(t)}`)
  const res = await mm.session.createThread(t.anchor, body)
  await until(() => !!mm.host.querySelector(`[data-thread="${res.thread.id}"]`), 5_000, 'highlight')
  return res.thread.id
}

const highlight = (mm: Mounted, id: string): HTMLElement | null => mm.host.querySelector<HTMLElement>(`[data-testid="mdr-highlight"][data-thread="${id}"]`)
const anchorsSent = (mm: Mounted): Array<{ thread: string; anchor: unknown }> =>
  bodiesTo<SaveRequest>(mm.transport, '/api/save').flatMap((s) => s.anchors ?? [])

describe('comment highlights (§12.1)', () => {
  it('a new thread is highlighted over its quote with data-thread / data-active and a content-space rect', async () => {
    m = await mount({ markdown: MD })
    const id = await commentOn(m, 'brown fox')
    const el = highlight(m, id)!
    expect(el.textContent).toBe('brown fox')
    expect(el.dataset.active).toBe('false')
    expect(el.className).toContain('hl')
    m.bridge.setActiveThread(id)
    expect(highlight(m, id)!.dataset.active).toBe('true')
    expect(highlight(m, id)!.className).toContain('is-active')
    expect(m.bridge.getAnchorRects([id]).get(id)).not.toBeNull()
    m.bridge.setVisibleThreads([])
    expect(highlight(m, id)).toBeNull()
    m.bridge.setVisibleThreads([id])
    expect(highlight(m, id)).not.toBeNull()
  })

  it('a click inside a highlight reports the thread', async () => {
    m = await mount({ markdown: MD })
    const id = await commentOn(m, 'lazy dog')
    const clicked: string[] = []
    m.bridge.onHighlightClick((t) => clicked.push(t))
    const pos = find(m.view, 'lazy').from + 1
    m.view.someProp('handleClick', (f) => f(m!.view, pos, new MouseEvent('click')))
    expect(clicked).toEqual([id])
  })

  it('typing elsewhere maps the highlight; typing inside sends the re-created anchor (anchor.update)', async () => {
    m = await mount({ markdown: MD })
    const id = await commentOn(m, 'brown fox')
    typeAt(m.view, find(m.view, 'The quick').from, 'Look: ')
    expect(highlight(m, id)!.textContent).toBe('brown fox')
    await m.session.flush()
    expect(anchorsSent(m)).toEqual([])
    replace(m.view, 'brown', 'red')
    expect(highlight(m, id)!.textContent).toBe('red fox')
    await m.session.flush()
    const sent = anchorsSent(m)
    expect(sent).toHaveLength(1)
    expect((sent[0]!.anchor as TextAnchor).quote).toBe('red fox')
    await until(() => (m!.session.getReview().threads.find((t) => t.id === id)?.anchor as TextAnchor).quote === 'red fox')
  })

  it('deleting the whole span detaches the thread; undo restores it and the next save reattaches (§13 #37, #38)', async () => {
    m = await mount({ markdown: MD })
    const id = await commentOn(m, 'brown fox')
    const r = find(m.view, 'brown fox')
    userTr(m.view, (tr) => tr.delete(r.from, r.to))
    expect(highlight(m, id)).toBeNull()
    await m.session.flush()
    expect(anchorsSent(m)).toEqual([{ thread: id, anchor: null }])
    await until(() => m!.session.getReview().threads.find((t) => t.id === id)?.detached === true)
    m.ed.runAction('undo', m.view)
    expect(m.view.state.doc.textContent).toContain('brown fox')
    await m.session.flush()
    await until(() => m!.session.getReview().threads.find((t) => t.id === id)?.detached === false, 5_000, 'reattach')
    await until(() => !!highlight(m!, id), 5_000, 'rebuilt highlight')
    expect(highlight(m, id)!.textContent).toBe('brown fox')
  })

  it('a duplicate quote whose context TJ edits gets its context refreshed at save; a unique one never does (§5.4)', async () => {
    m = await mount({ markdown: '# T\n\nAlpha shared words here.\n\nBeta shared words here.\n' })
    const id = await commentOn(m, 'shared words', 'second', 1)
    await m.session.flush()
    const before = anchorsSent(m).length
    replace(m.view, 'Beta', 'Gamma')
    await m.session.flush()
    const sent = anchorsSent(m).slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.thread).toBe(id)
    expect((sent[0]!.anchor as TextAnchor).prefix.endsWith('Gamma ')).toBe(true)
    // a unique quote: plain typing next to it adds no anchor line
    const u = await commentOn(m, 'Alpha')
    const n = anchorsSent(m).length
    typeAt(m.view, find(m.view, 'Alpha').to, ',')
    await m.session.flush()
    expect(anchorsSent(m).slice(n).filter((a) => a.thread === u)).toEqual([])
  })
})
