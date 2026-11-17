// tests/unit/web/editor/tables.test.ts (P2; CONTRACTS §12.13 Tables, D14, D51). Every structure command at the first,
// middle and last positions against the saved markdown; the header-row and last-column rules; each alignment; the
// delimiter row kept on a cell text edit; Tab / Shift+Tab / Enter; the control bar's test ids and aria; the
// Suggesting-mode blocks next to a tracked cell edit; and the header-only table guard.
import { afterEach, describe, expect, it } from 'vitest'
import { TESTID, TEST_ACTIONS } from '../../../../shared/constants'
import { cellAt } from '../../../../web/src/editor/tables'
import { caret, mount, press, saved, typeKeys, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const T = '| A | B | C |\n| - | - | - |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n'
const MD = `Intro.\n\n${T}\nOutro.\n`

const bar = (mm: Mounted): HTMLElement => mm.host.querySelector<HTMLElement>(`[data-testid="${TESTID.tableControls}"]`)!
const btn = (mm: Mounted, a: string): HTMLButtonElement => bar(mm).querySelector<HTMLButtonElement>(`[data-testid="${TESTID.tableAction}"][data-action="${a}"]`)!

async function act(cell: string, action: string, md = MD): Promise<string> {
  m = await mount({ markdown: md })
  caret(m.view, cell)
  m.ed.tableControls!.update(m.view)
  btn(m, action).click()
  return saved(m)
}

const wrap = (t: string): string => `Intro.\n\n${t}\nOutro.\n`

describe('row commands', () => {
  it('row-above at a body row (first and last), disabled on the header', async () => {
    expect(await act('a1', 'row-above')).toBe(wrap('| A | B | C |\n| - | - | - |\n| | | |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('c2', 'row-above')).toBe(wrap('| A | B | C |\n| - | - | - |\n| a1 | b1 | c1 |\n| | | |\n| a2 | b2 | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('B', 'row-above')).toBe(MD)
    expect(btn(m!, 'row-above').getAttribute('aria-disabled')).toBe('true')
    expect(btn(m!, 'row-above').title).toMatch(/header row/)
  })

  it('row-below at the header, a middle row and the last row', async () => {
    expect(await act('A', 'row-below')).toBe(wrap('| A | B | C |\n| - | - | - |\n| | | |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('b1', 'row-below')).toBe(wrap('| A | B | C |\n| - | - | - |\n| a1 | b1 | c1 |\n| | | |\n| a2 | b2 | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('c2', 'row-below')).toBe(wrap('| A | B | C |\n| - | - | - |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n| | | |\n'))
  })

  it('row-delete on a body row; disabled on the header while body rows exist; the last body row leaves a header-only table', async () => {
    expect(await act('b1', 'row-delete')).toBe(wrap('| A | B | C |\n| - | - | - |\n| a2 | b2 | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('A', 'row-delete')).toBe(MD)
    expect(btn(m!, 'row-delete').getAttribute('aria-disabled')).toBe('true')
    await m!.close()
    m = null
    const one = wrap('| A | B |\n| - | - |\n| a1 | b1 |\n')
    expect(await act('b1', 'row-delete', one)).toBe(wrap('| A | B |\n| - | - |\n'))
  })

  it('on a header-only table: row-below adds the first body row, row-delete deletes the table', async () => {
    const headerOnly = wrap('| A | B |\n| - | - |\n')
    expect(await act('A', 'row-below', headerOnly)).toBe(wrap('| A | B |\n| - | - |\n| | |\n'))
    await m!.close()
    m = null
    m = await mount({ markdown: headerOnly })
    caret(m.view, 'A')
    m.ed.tableControls!.update(m.view)
    expect(btn(m, 'row-delete').getAttribute('aria-disabled')).toBeNull()
    expect(btn(m, 'row-delete').getAttribute('aria-label')).toMatch(/deletes the table/)
    btn(m, 'row-delete').click()
    expect(await saved(m)).toBe('Intro.\n\nOutro.\n')
  })
})

describe('column commands', () => {
  it('col-left / col-right at the first, middle and last column', async () => {
    expect(await act('a1', 'col-left')).toBe(wrap('| | A | B | C |\n| - | - | - | - |\n| | a1 | b1 | c1 |\n| | a2 | b2 | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('B', 'col-right')).toBe(wrap('| A | B | | C |\n| - | - | - | - |\n| a1 | b1 | | c1 |\n| a2 | b2 | | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('c2', 'col-right')).toBe(wrap('| A | B | C | |\n| - | - | - | - |\n| a1 | b1 | c1 | |\n| a2 | b2 | c2 | |\n'))
  })

  it('col-delete at the first, middle and last column; on the only column it deletes the table', async () => {
    expect(await act('a1', 'col-delete')).toBe(wrap('| B | C |\n| - | - |\n| b1 | c1 |\n| b2 | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('B', 'col-delete')).toBe(wrap('| A | C |\n| - | - |\n| a1 | c1 |\n| a2 | c2 |\n'))
    await m!.close()
    m = null
    expect(await act('c2', 'col-delete')).toBe(wrap('| A | B |\n| - | - |\n| a1 | b1 |\n| a2 | b2 |\n'))
    await m!.close()
    m = null
    expect(await act('x1', 'col-delete', wrap('| X |\n| - |\n| x1 |\n'))).toBe('Intro.\n\nOutro.\n')
  })

  it('each alignment sets that column only and keeps the others', async () => {
    const aligned = wrap('| A | B | C |\n| :- | -: | - |\n| a1 | b1 | c1 |\n')
    expect(await act('c1', 'align-center', aligned)).toBe(wrap('| A | B | C |\n| :- | -: | :-: |\n| a1 | b1 | c1 |\n'))
    await m!.close()
    m = null
    expect(await act('a1', 'align-right', aligned)).toBe(wrap('| A | B | C |\n| -: | -: | - |\n| a1 | b1 | c1 |\n'))
    await m!.close()
    m = null
    expect(await act('b1', 'align-left', aligned)).toBe(wrap('| A | B | C |\n| :- | :- | - |\n| a1 | b1 | c1 |\n'))
    await m!.close()
    m = null
    expect(await act('b1', 'align-none', aligned)).toBe(wrap('| A | B | C |\n| :- | - | - |\n| a1 | b1 | c1 |\n'))
    // the current alignment is pressed and disabled
    expect(btn(m!, 'align-none').getAttribute('aria-pressed')).toBe('true')
    expect(btn(m!, 'align-none').getAttribute('aria-disabled')).toBe('true')
  })

  it('table-delete removes the table and only the table', async () => {
    expect(await act('b2', 'table-delete')).toBe('Intro.\n\nOutro.\n')
  })
})

describe('cell text edits', () => {
  it('a cell edit changes only that row and keeps the delimiter row bytes', async () => {
    const src = 'Intro.\n\n| Deal | Member |\n|:-----|-------:|\n| Alpha | 12% |\n| Beta | 10% |\n\nOutro.\n'
    m = await mount({ markdown: src })
    caret(m.view, 'Beta')
    typeKeys(m.view, 'x')
    const out = await saved(m)
    const a = src.split('\n')
    const b = out.split('\n')
    expect(b.length).toBe(a.length)
    const changed = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null)
    expect(changed).toEqual([5])
    expect(b[5]).toBe('| Betax | 10% |')
  })
})

describe('keys', () => {
  it('Tab / Shift+Tab move between cells, wrapping rows (the target cell selected)', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'C')
    press(m, 'Tab')
    expect(cellAt(m.view.state)).toMatchObject({ row: 1, col: 0 })
    expect(m.view.state.doc.textBetween(m.view.state.selection.from, m.view.state.selection.to)).toBe('a1')
    press(m, 'Tab', { shift: true })
    expect(cellAt(m.view.state)).toMatchObject({ row: 0, col: 2 })
  })

  it('Tab in the last cell adds a body row (Editing); Suggesting stops there with the notice', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'c2')
    press(m, 'Tab')
    expect(cellAt(m.view.state)).toMatchObject({ row: 3, col: 0 })
    typeKeys(m.view, 'a3')
    expect(await saved(m)).toBe(wrap(`${T}| a3 | | |\n`))
    caret(m.view, 'a3')
    press(m, 'Tab')
    press(m, 'Tab')
    m.bridge.setMode('suggesting')
    const before = m.view.state.doc
    press(m, 'Tab')
    expect(m.view.state.doc.eq(before)).toBe(true)
    expect(m.notices.map((n) => n.code)).toContain('SUGGEST_MODE_BLOCKED')
  })

  it('Enter moves to the cell below, and from the last row into the paragraph after the table', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'B')
    press(m, 'Enter')
    expect(cellAt(m.view.state)).toMatchObject({ row: 1, col: 1 })
    press(m, 'Enter')
    press(m, 'Enter')
    expect(cellAt(m.view.state)).toBeNull()
    expect(m.view.state.selection.$from.parent.textContent).toBe('Outro.')
  })

  it('Enter from the last row of a table at the end of the doc creates a paragraph', async () => {
    m = await mount({ markdown: T })
    caret(m.view, 'c2')
    press(m, 'Enter')
    typeKeys(m.view, 'Below.')
    expect(await saved(m)).toBe(`${T}\nBelow.\n`)
  })

  it('Shift+Enter in a cell does nothing', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'b1')
    const before = m.view.state.doc
    press(m, 'Enter', { shift: true })
    expect(m.view.state.doc.eq(before)).toBe(true)
  })
})

describe('control bar and Suggesting mode (D14)', () => {
  it('appears only with the selection in a table, with one button per tableAction, each labelled', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'Intro.')
    expect(bar(m).hidden).toBe(true)
    caret(m.view, 'b1')
    expect(bar(m).hidden).toBe(false)
    const actions = [...bar(m).querySelectorAll<HTMLElement>(`[data-testid="${TESTID.tableAction}"]`)].map((b) => b.dataset.action)
    expect(actions).toEqual([...TEST_ACTIONS.tableAction])
    for (const b of bar(m).querySelectorAll('button')) expect(b.getAttribute('aria-label')).toBeTruthy()
  })

  it('every action is disabled and raises SUGGEST_MODE_BLOCKED in Suggesting mode; a cell text edit is tracked', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'b1')
    m.bridge.setMode('suggesting')
    for (const a of TEST_ACTIONS.tableAction) {
      expect(btn(m, a).getAttribute('aria-disabled')).toBe('true')
      const before = m.view.state.doc
      btn(m, a).click()
      expect(m.view.state.doc.eq(before)).toBe(true)
    }
    expect(m.notices.filter((n) => n.code === 'SUGGEST_MODE_BLOCKED').length).toBe(TEST_ACTIONS.tableAction.length)
    caret(m.view, 'b1')
    typeKeys(m.view, 'z')
    expect([...m.bridge.getSuggestionSummaries().values()].some((s) => s.kind === 'insert')).toBe(true)
    expect(await saved(m)).toBe(MD)
  })
})

describe('header-only tables stay header-only (fixTables guard)', () => {
  it('editing the header of a header-only table adds no body row', async () => {
    m = await mount({ markdown: '| A | B |\n| - | - |\n' })
    caret(m.view, 'A')
    typeKeys(m.view, 'x')
    expect(await saved(m)).toBe('| Ax | B |\n| - | - |\n')
  })
})
