// tests/unit/web/editor/t2-editor-ux-format.test.ts (T2 editor-ux): Pass 4 #32 and #33, Bold / Italic the Google Docs way.
//   #32 a caret inside a word formats the whole word (at the edge of a word it still arms the next typed text).
//   #33 on a selection that is partly bold, the first press bolds all of it; only text that is all bold turns off. The
//       button is pressed only for all-bold text, so what a press does is what the button said.
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it } from 'vitest'
import { caret, find, mount, press, saved, typeKeys, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const bold = (mm: Mounted): boolean => press(mm, 'b', { mod: true })
const italic = (mm: Mounted): boolean => press(mm, 'i', { mod: true })
/** aria-pressed of a toolbar button once the toolbar's next frame has run. */
async function pressed(mm: Mounted, action: string): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 50))
  return mm.toolbarHost.querySelector(`[data-action="${action}"]`)!.getAttribute('aria-pressed')
}

function select(mm: Mounted, from: string, to = from): void {
  const a = find(mm.view, from)
  const b = find(mm.view, to)
  mm.view.dispatch(mm.view.state.tr.setSelection(TextSelection.create(mm.view.state.doc, a.from, b.to)))
}

const INTRO = 'Intro paragraph with some words in it.\n'

describe('#32: the caret inside a word', () => {
  it('Cmd+B bolds the whole word and a second press takes it off; the caret stays where it was', async () => {
    m = await mount({ markdown: INTRO })
    caret(m.view, 'Intro par')
    const at = m.view.state.selection.from
    expect(bold(m)).toBe(true)
    expect(await saved(m)).toBe('Intro **paragraph** with some words in it.\n')
    expect(m.view.state.selection.from).toBe(at)
    expect(m.view.state.selection.empty).toBe(true)
    expect(await pressed(m, 'bold')).toBe('true')
    bold(m)
    expect(await saved(m)).toBe(INTRO)
  })

  it('Cmd+I and the toolbar buttons do the same', async () => {
    m = await mount({ markdown: INTRO })
    caret(m.view, 'Intro par')
    italic(m)
    expect(await saved(m)).toBe('Intro *paragraph* with some words in it.\n')
    m.toolbarHost.querySelector<HTMLElement>('[data-action="bold"]')!.click()
    expect(await saved(m)).toBe('Intro ***paragraph*** with some words in it.\n')
    m.toolbarHost.querySelector<HTMLElement>('[data-action="italic"]')!.click()
    expect(await saved(m)).toBe('Intro **paragraph** with some words in it.\n')
  })

  it('strikethrough and inline code format the word too', async () => {
    m = await mount({ markdown: INTRO })
    caret(m.view, 'with so')
    m.ed.runAction('strike', m.view)
    expect(await saved(m)).toBe('Intro paragraph with ~~some~~ words in it.\n')
    caret(m.view, 'wor')
    m.ed.runAction('code', m.view)
    expect(await saved(m)).toBe('Intro paragraph with ~~some~~ `words` in it.\n')
  })

  it('a word that is only partly bold gets bold all over, then off', async () => {
    m = await mount({ markdown: 'Intro para**graph** with some words.\n' })
    caret(m.view, 'Intro pa')
    expect(await pressed(m, 'bold')).toBe('false')
    bold(m)
    expect(await saved(m)).toBe('Intro **paragraph** with some words.\n')
    bold(m)
    expect(await saved(m)).toBe('Intro paragraph with some words.\n')
  })

  it("an apostrophe stays inside its word; a hyphen or punctuation does not", async () => {
    m = await mount({ markdown: "Don't stop well-known words.\n" })
    caret(m.view, 'Do')
    bold(m)
    expect(await saved(m)).toBe("**Don't** stop well-known words.\n")
    caret(m.view, 'well-kn')
    bold(m)
    expect(await saved(m)).toBe("**Don't** stop well-**known** words.\n")
  })

  it('at the edge of a word nothing is formatted: the mark waits for the next typed text', async () => {
    m = await mount({ markdown: INTRO })
    for (const [text, at] of [['Intro', 'end'], ['paragraph', 'start']] as const) {
      caret(m.view, text, { at })
      const doc = m.view.state.doc
      bold(m)
      expect(m.view.state.doc.eq(doc), `${text} ${at}`).toBe(true)
      expect(m.view.state.storedMarks?.map((x) => x.type.name)).toEqual(['strong'])
      expect(await pressed(m, 'bold')).toBe('true')
      bold(m)
      expect(m.view.state.storedMarks ?? []).toEqual([])
    }
    caret(m.view, 'Intro')
    bold(m)
    typeKeys(m.view, 'ZZ')
    expect(await saved(m)).toBe('Intro**ZZ** paragraph with some words in it.\n')
  })

  it('between two spaces, or in an empty paragraph, there is no word, so the mark is stored as before', async () => {
    m = await mount({ markdown: 'One  two.\n\n' })
    caret(m.view, 'One ')
    const doc = m.view.state.doc
    bold(m)
    expect(m.view.state.doc.eq(doc)).toBe(true)
    expect(m.view.state.storedMarks?.length).toBe(1)
  })

  it('does nothing where the mark is not allowed: inside a code block', async () => {
    m = await mount({ markdown: '```\nconst word = 1\n```\n' })
    caret(m.view, 'const wo')
    const doc = m.view.state.doc
    expect(bold(m)).toBe(true)
    expect(m.view.state.doc.eq(doc)).toBe(true)
  })
})

describe('#33: a selection that is partly bold', () => {
  const MIXED = 'Some plain text then **bold part** and more plain text here.\n'

  it('the first Cmd+B bolds all of it, the second takes it all off', async () => {
    m = await mount({ markdown: MIXED })
    select(m, 'plain text then ', 'and more')
    expect(await pressed(m, 'bold')).toBe('false')
    bold(m)
    expect(await saved(m)).toBe('Some **plain text then bold part and more** plain text here.\n')
    expect(await pressed(m, 'bold')).toBe('true')
    bold(m)
    expect(await saved(m)).toBe('Some plain text then bold part and more plain text here.\n')
    expect(await pressed(m, 'bold')).toBe('false')
  })

  it('the whole paragraph, mixed: bold all, then off', async () => {
    m = await mount({ markdown: MIXED })
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, m.view.state.doc.content.size - 1)))
    bold(m)
    expect(await saved(m)).toBe('**Some plain text then bold part and more plain text here.**\n')
    bold(m)
    expect(await saved(m)).toBe('Some plain text then bold part and more plain text here.\n')
  })

  it('a selection that is all bold still turns it off; plain text still turns it on', async () => {
    m = await mount({ markdown: MIXED })
    select(m, 'bold part')
    expect(await pressed(m, 'bold')).toBe('true')
    bold(m)
    expect(await saved(m)).toBe('Some plain text then bold part and more plain text here.\n')
    select(m, 'plain text then')
    expect(await pressed(m, 'bold')).toBe('false')
    bold(m)
    expect(await saved(m)).toBe('Some **plain text then** bold part and more plain text here.\n')
  })

  it('a space between two bold runs does not make the selection mixed', async () => {
    m = await mount({ markdown: '**one** **two** three.\n' })
    select(m, 'one', 'two')
    expect(await pressed(m, 'bold')).toBe('true')
    bold(m)
    expect(await saved(m)).toBe('one two three.\n')
  })

  it('italic follows the same rule on its own mark', async () => {
    m = await mount({ markdown: 'Some *slanted* and plain text.\n' })
    select(m, 'slanted', ' and')
    expect(await pressed(m, 'italic')).toBe('false')
    italic(m)
    expect(await saved(m)).toBe('Some *slanted and* plain text.\n')
  })
})

describe('in Suggesting mode', () => {
  const summaries = (mm: Mounted) => [...mm.bridge.getSuggestionSummaries().values()].map((x) => ({ kind: x.kind, deleted: x.deletedText, inserted: x.insertedText }))

  it('a caret inside a word suggests the same format change selecting the word does', async () => {
    m = await mount({ markdown: INTRO })
    m.bridge.setMode('suggesting')
    caret(m.view, 'Intro par')
    bold(m)
    const viaCaret = summaries(m)
    expect(viaCaret).toEqual([{ kind: 'format', deleted: 'paragraph', inserted: 'paragraph' }])
    await m.close()

    m = await mount({ markdown: INTRO })
    m.bridge.setMode('suggesting')
    select(m, 'paragraph')
    bold(m)
    expect(summaries(m)).toEqual(viaCaret)
  })

  it('a mixed selection is one format suggestion, and accepting it bolds all of it', async () => {
    m = await mount({ markdown: 'Some plain text then **bold part** and more plain text.\n' })
    m.bridge.setMode('suggesting')
    select(m, 'plain text then ', 'and more')
    bold(m)
    const [only, ...rest] = [...m.bridge.getSuggestionSummaries().values()]
    expect(rest).toEqual([])
    expect(only).toMatchObject({ kind: 'format' })
    expect(await m.bridge.accept(only!.id)).toMatchObject({ ok: true })
    expect(await saved(m)).toBe('Some **plain text then bold part and more** plain text.\n')
  })
})
