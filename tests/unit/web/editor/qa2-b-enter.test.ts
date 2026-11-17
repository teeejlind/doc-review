// tests/unit/web/editor/qa2-b-enter.test.ts (QA fix pass 2, agent B: CONFIRMED 27, 30, 32). Enter must not put anything
// in the file the user didn't write: no `&#x20;` from a split before a space, no `<br />` for an empty list item or
// quote line, and what the editor shows after Enter on an empty paragraph is what is saved.
import { afterEach, describe, expect, it } from 'vitest'
import { caret, find, mount, press, saved, select, typeKeys, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

describe('27: Enter right before a space', () => {
  it('splits cleanly: the space the caret was in front of is dropped, nothing like &#x20; is saved', async () => {
    m = await mount({ markdown: 'One two three.\n' })
    caret(m.view, 'One')
    press(m, 'Enter')
    expect(await saved(m)).toBe('One\n\ntwo three.\n')
  })

  it('a run of spaces goes too, and one undo puts the text back whole', async () => {
    m = await mount({ markdown: 'One   two.\n' })
    caret(m.view, 'One')
    press(m, 'Enter')
    expect(await saved(m)).toBe('One\n\ntwo.\n')
    press(m, 'z', { mod: true })
    expect(await saved(m)).toBe('One   two.\n')
  })

  it('works in a list item, a heading and a quote', async () => {
    m = await mount({ markdown: '- one two\n\n## Head line\n\n> quoted words\n' })
    caret(m.view, 'one')
    press(m, 'Enter')
    caret(m.view, 'Head')
    press(m, 'Enter')
    caret(m.view, 'quoted')
    press(m, 'Enter')
    const out = await saved(m)
    expect(out).not.toContain('&#x20;')
    expect(out).toContain('- one\n- two')
    expect(out).toContain('## Head\n\n## line')
    expect(out).toContain('> quoted\n>\n> words')
  })

  it('Enter after the space, or at the end of a word, is unchanged', async () => {
    m = await mount({ markdown: 'One two.\n' })
    caret(m.view, 'two')
    press(m, 'Enter')
    typeKeys(m.view, 'Next')
    expect(await saved(m)).toBe('One two\n\nNext.\n')
  })
})

describe('30: an empty list item or quote line', () => {
  it('Enter at the end of a bullet saves a bare "-", no <br />, and the typed text then fills it', async () => {
    m = await mount({ markdown: '- one\n- two\n\nAfter.\n' })
    caret(m.view, 'two')
    press(m, 'Enter')
    expect(await saved(m)).toBe('- one\n- two\n-\n\nAfter.\n')
    typeKeys(m.view, 'three')
    expect(await saved(m)).toBe('- one\n- two\n- three\n\nAfter.\n')
  })

  it('an empty numbered item saves as a bare "3."', async () => {
    m = await mount({ markdown: '1. one\n2. two\n' })
    caret(m.view, 'two')
    press(m, 'Enter')
    expect(await saved(m)).toBe('1. one\n2. two\n3.\n')
  })

  it('an empty task item saves as a bare bullet (a lone "- [ ]" is not a task in markdown); the text makes it a task again', async () => {
    m = await mount({ markdown: '- [ ] one\n' })
    caret(m.view, 'one')
    press(m, 'Enter')
    expect(await saved(m)).toBe('- [ ] one\n-\n')
    typeKeys(m.view, 'two')
    expect(await saved(m)).toBe('- [ ] one\n- [ ] two\n')
  })

  it('an empty item in the middle of a list keeps its place', async () => {
    m = await mount({ markdown: '- one\n- two\n' })
    caret(m.view, 'one')
    press(m, 'Enter')
    expect(await saved(m)).toBe('- one\n-\n- two\n')
  })

  it('Enter at the end of a quote line writes nothing until the new line has text', async () => {
    m = await mount({ markdown: '> one\n\nAfter.\n' })
    caret(m.view, 'one')
    press(m, 'Enter')
    expect(await saved(m)).toBe('> one\n\nAfter.\n')
    typeKeys(m.view, 'two')
    expect(await saved(m)).toBe('> one\n>\n> two\n\nAfter.\n')
  })
})

describe('32: Enter on an empty line', () => {
  const blocks = (mm: Mounted): string[] => {
    const out: string[] = []
    mm.view.state.doc.forEach((n) => out.push(n.textContent))
    return out
  }

  it('tapping Enter again on the empty line adds no second blank line: the screen shows what the file keeps', async () => {
    m = await mount({ markdown: 'One.\n\nTwo.\n' })
    caret(m.view, 'Two.')
    press(m, 'Enter')
    press(m, 'Enter')
    press(m, 'Enter')
    typeKeys(m.view, 'After')
    expect(blocks(m)).toEqual(['One.', 'Two.', 'After'])
    expect(await saved(m)).toBe('One.\n\nTwo.\n\nAfter\n')
  })

  it('Enter at the start of a paragraph opens one blank line above it, not a stack of them', async () => {
    m = await mount({ markdown: 'One.\n\nTwo.\n' })
    caret(m.view, 'Two.', { at: 'start' })
    press(m, 'Enter')
    press(m, 'Enter')
    expect(blocks(m)).toEqual(['One.', '', 'Two.'])
    const inside = find(m.view, 'One.').to + 2 // the empty paragraph
    select(m.view, inside, inside)
    typeKeys(m.view, 'Mid')
    expect(await saved(m)).toBe('One.\n\nMid\n\nTwo.\n')
  })

  it('Enter at the end of a paragraph that already has an empty line below it adds none', async () => {
    m = await mount({ markdown: 'One.\n\nTwo.\n' })
    caret(m.view, 'Two.')
    press(m, 'Enter')
    caret(m.view, 'Two.')
    press(m, 'Enter')
    expect(blocks(m)).toEqual(['One.', 'Two.', ''])
  })

  it('an empty line inside a quote or a list item still behaves as before (leaves the quote / the list)', async () => {
    m = await mount({ markdown: '> One.\n\n- a\n' })
    caret(m.view, 'One.')
    press(m, 'Enter')
    press(m, 'Enter')
    typeKeys(m.view, 'Out')
    caret(m.view, 'a')
    press(m, 'Enter')
    press(m, 'Enter')
    typeKeys(m.view, 'Out2')
    expect(await saved(m)).toBe('> One.\n\nOut\n\n- a\n\nOut2\n')
  })
})
