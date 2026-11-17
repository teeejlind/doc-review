// tests/unit/web/editor/qa3-undo-feedback.test.ts (QA round 3, rail-ui 16).
//
// Big actions say what they did and offer Undo: Accept all / Reject all (one notice with the count), Delete table (a
// notice), and the toolbar has Undo and Redo buttons for people who don't know Cmd+Z.
import { afterEach, describe, expect, it } from 'vitest'
import { TESTID, TEST_ACTIONS } from '../../../../shared/constants'
import type { SuggestionId } from '../../../../shared/types'
import { caret, find, marksOf, mount, saved, select, typeKeys, until, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n'
const TWO = [
  { op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' },
  { op: 'suggest', quote: 'Second paragraph', replace: 'Middle paragraph' },
]
const ids = (mm: Mounted): SuggestionId[] => mm.session.getReview().suggestions.map((s) => s.id)

describe('Accept all / Reject all say what they did and offer Undo', () => {
  it('Accept all raises one notice with the count, and its Undo brings the suggestions back', async () => {
    m = await mount({ markdown: MD, claude: TWO })
    await m.bridge.acceptAll({ by: 'Claude' })
    const notes = m.notices.filter((n) => n.code === 'DECISIONS_APPLIED')
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toBe('Accepted 2 changes.')
    expect(notes[0]!.kind).toBe('info')
    expect(notes[0]!.action?.label).toBe('Undo')
    expect(marksOf(m.view)).toEqual([])
    notes[0]!.action!.run()
    expect(new Set(marksOf(m.view).map((x) => x.id))).toEqual(new Set(ids(m)))
  })

  it('Reject all says "Rejected", and a single change says "1 change"', async () => {
    m = await mount({ markdown: MD, claude: [TWO[0]!] })
    await m.bridge.rejectAll({ by: 'Claude' })
    expect(m.notices.find((n) => n.code === 'DECISIONS_APPLIED')?.text).toBe('Rejected 1 change.')
  })

  it('says nothing when nothing was decided (no pending suggestion, or the bulk matched none)', async () => {
    m = await mount({ markdown: MD })
    await m.bridge.acceptAll({ by: 'Claude' })
    expect(m.notices.filter((n) => n.code === 'DECISIONS_APPLIED')).toEqual([])
  })

  it('a single card’s Accept is not announced (the card going away is the feedback)', async () => {
    m = await mount({ markdown: MD, claude: [TWO[0]!] })
    await m.bridge.accept(ids(m)[0]!)
    expect(m.notices.filter((n) => n.code === 'DECISIONS_APPLIED')).toEqual([])
  })
})

describe('Delete table says so and offers Undo', () => {
  const T = '| A | B |\n| - | - |\n| a1 | b1 |\n'
  const doc = `Intro.\n\n${T}\nOutro.\n`

  it('the notice’s Undo puts the table back', async () => {
    m = await mount({ markdown: doc })
    caret(m.view, 'a1')
    m.ed.tableControls!.update(m.view)
    m.host.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.tableAction}"][data-action="table-delete"]`)!.click()
    expect(await saved(m)).toBe('Intro.\n\nOutro.\n')
    const note = m.notices.find((n) => n.code === 'TABLE_DELETED')
    expect(note?.text).toBe('Table deleted.')
    expect(note?.action?.label).toBe('Undo')
    note!.action!.run()
    expect(await saved(m)).toBe(doc)
  })

  it('deleting a row is not announced', async () => {
    m = await mount({ markdown: doc })
    caret(m.view, 'a1')
    m.ed.tableControls!.update(m.view)
    m.host.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.tableAction}"][data-action="row-delete"]`)!.click()
    expect(m.notices.filter((n) => n.code === 'TABLE_DELETED')).toEqual([])
  })

  it('removing the only column deletes the table, so it is announced too', async () => {
    m = await mount({ markdown: 'Intro.\n\n| X |\n| - |\n| x1 |\n\nOutro.\n' })
    caret(m.view, 'x1')
    m.ed.tableControls!.update(m.view)
    m.host.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.tableAction}"][data-action="col-delete"]`)!.click()
    expect(m.notices.find((n) => n.code === 'TABLE_DELETED')).toBeTruthy()
  })
})

describe('the toolbar has Undo and Redo', () => {
  const btn = (mm: Mounted, a: string): HTMLButtonElement => mm.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.toolbarButton}"][data-action="${a}"]`)!

  it('the test-action list names them, and they sit first in the toolbar with their shortcut in the tooltip', async () => {
    expect(TEST_ACTIONS.toolbarButton).toEqual(expect.arrayContaining(['undo', 'redo']))
    m = await mount({ markdown: MD })
    const first = Array.from(m.toolbarHost.querySelectorAll<HTMLElement>(`[data-testid="${TESTID.toolbarButton}"]`)).map((b) => b.dataset.action)
    expect(first.slice(0, 2)).toEqual(['undo', 'redo'])
    expect(btn(m, 'undo').getAttribute('aria-label')).toMatch(/^Undo \(/)
    expect(btn(m, 'redo').getAttribute('aria-label')).toMatch(/^Redo \(/)
  })

  it('Undo takes back the last edit and Redo does it again', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'First paragraph here.')
    typeKeys(m.view, ' Added.')
    expect(m.view.state.doc.textContent).toContain('First paragraph here. Added.')
    btn(m, 'undo').click()
    expect(m.view.state.doc.textContent).not.toContain('Added.')
    btn(m, 'redo').click()
    await until(() => m!.view.state.doc.textContent.includes('Added.'))
    expect(m.view.state.doc.textContent).toContain('First paragraph here. Added.')
  })
})

describe('clicking a Claude suggestion inside a commented sentence (rail-ui 2)', () => {
  const SENTENCE = 'Distributions are intended monthly after a two-year lock.'
  const MDS = `# Terms\n\n${SENTENCE}\n\nSecond paragraph here.\n`

  it('reports the suggestion’s thread, not the comment thread under it', async () => {
    m = await mount({ markdown: MDS, claude: [{ op: 'suggest', quote: 'two-year lock', replace: '24-month lock', reason: 'fix' }] })
    // TJ comments on the whole sentence (the suggestion sits inside it)
    const r = find(m.view, 'Distributions')
    select(m.view, r.from, r.from + SENTENCE.length)
    const target = m.bridge.getSelectionTarget()
    if (target?.kind !== 'anchor') throw new Error('no anchor')
    const made = await m.session.createThread(target.anchor, 'Is the lock period right?')
    await until(() => !!m!.host.querySelector(`[data-thread="${made.thread.id}"]`), 5_000, 'comment highlight')
    const sugThread = m.session.getReview().threads.find((t) => t.kind === 'suggestion')!
    expect(sugThread.id).not.toBe(made.thread.id)

    const clicked: string[] = []
    m.bridge.onHighlightClick((t) => clicked.push(t))
    const sugEl = m.host.querySelector<HTMLElement>('[data-suggestion]')!
    const pos = m.view.posAtDOM(sugEl, 0) + 1
    const ev = new MouseEvent('click', { bubbles: true })
    Object.defineProperty(ev, 'target', { value: sugEl })
    m.view.someProp('handleClick', (f) => f(m!.view, pos, ev))
    expect(clicked).toEqual([sugThread.id])

    // a click on the commented words around it is still the comment
    clicked.length = 0
    const plain = find(m.view, 'Distributions')
    const hl = m.host.querySelector<HTMLElement>(`[data-thread="${made.thread.id}"]`)!
    const ev2 = new MouseEvent('click', { bubbles: true })
    Object.defineProperty(ev2, 'target', { value: hl })
    m.view.someProp('handleClick', (f) => f(m!.view, plain.from + 3, ev2))
    expect(clicked).toEqual([made.thread.id])
  })
})

describe('giving the focus back to the document (rail-ui 9)', () => {
  it('focusEditor({ collapse: "end" }) drops a selection to its end, in the editor’s own state', async () => {
    m = await mount({ markdown: MD })
    const r = find(m.view, 'First paragraph')
    select(m.view, r.from, r.to)
    m.bridge.focusEditor({ collapse: 'end' })
    expect(m.view.state.selection.empty).toBe(true)
    expect(m.view.state.selection.from).toBe(r.to)
  })

  it('without the option the selection stays', async () => {
    m = await mount({ markdown: MD })
    const r = find(m.view, 'First paragraph')
    select(m.view, r.from, r.to)
    m.bridge.focusEditor()
    expect(m.view.state.selection.from).toBe(r.from)
    expect(m.view.state.selection.to).toBe(r.to)
  })
})
