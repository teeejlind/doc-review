// tests/unit/web/editor/links.test.ts (P2; CONTRACTS §12.13 "Links", §12.15). Cmd+K add on a selection, insert with
// text on an empty selection, edit and remove an existing link, the view popover (Edit / Remove / Open) for a caret
// inside a link, refused schemes, Cmd+click, Esc, and the Suggesting-mode format suggestion.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { TESTID } from '../../../../shared/constants'
import { linkAllowed, normalizeLinkInput } from '../../../../web/src/editor/linkPopover'
import { caret, find, mount, press, saved, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
  vi.restoreAllMocks()
})

const pop = (mm: Mounted): HTMLElement | null => mm.host.querySelector<HTMLElement>(`[data-testid="${TESTID.linkPopover}"]`)
const field = (mm: Mounted, f: string): HTMLInputElement | null => pop(mm)!.querySelector<HTMLInputElement>(`[data-testid="${TESTID.popoverField}"][data-field="${f}"]`)
const action = (mm: Mounted, a: string): HTMLButtonElement | null => pop(mm)!.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.popoverAction}"][data-action="${a}"]`)

function select(mm: Mounted, text: string): void {
  const r = find(mm.view, text)
  mm.view.dispatch(mm.view.state.tr.setSelection(TextSelection.create(mm.view.state.doc, r.from, r.to)))
}

function enter(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

describe('Cmd+K (§12.13)', () => {
  it('adds a link on the selection (URL field only); Enter applies', async () => {
    m = await mount({ markdown: 'Read the primer today.\n' })
    select(m, 'primer')
    press(m, 'k', { mod: true })
    expect(pop(m)).not.toBeNull()
    expect(field(m, 'text')).toBeNull()
    enter(field(m, 'url')!, 'https://example.com/primer')
    expect(pop(m)).toBeNull()
    expect(await saved(m)).toBe('Read the [primer](https://example.com/primer) today.\n')
  })

  it('with an empty selection, inserts the text field as a link', async () => {
    m = await mount({ markdown: 'See: \n' })
    caret(m.view, 'See:')
    press(m, 'k', { mod: true })
    field(m, 'text')!.value = 'the deck'
    enter(field(m, 'url')!, '/decks/q3.pdf')
    expect(await saved(m)).toBe('See:[the deck](/decks/q3.pdf)\n')
  })

  it('refuses javascript: and data: with an inline error', async () => {
    m = await mount({ markdown: 'Click here.\n' })
    select(m, 'here')
    press(m, 'k', { mod: true })
    enter(field(m, 'url')!, 'javascript:alert(1)')
    expect(pop(m)).not.toBeNull()
    expect(pop(m)!.querySelector('[role="alert"]')!.textContent).toMatch(/allowed/)
    enter(field(m, 'url')!, 'data:text/html,x')
    expect(pop(m)).not.toBeNull()
    expect(await saved(m)).toBe('Click here.\n')
  })

  it('caret inside a link: the view popover shows the URL with Edit, Remove and Open', async () => {
    m = await mount({ markdown: 'Go to [the site](https://example.com) now.\n' })
    caret(m.view, 'the s')
    press(m, 'k', { mod: true })
    expect(pop(m)!.querySelector('.mdr-popover__url')!.textContent).toBe('https://example.com')
    expect(['edit', 'remove', 'open'].map((a) => !!action(m!, a))).toEqual([true, true, true])
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    action(m, 'open')!.click()
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
  })

  it('Edit changes the URL across the whole link; an empty URL removes it', async () => {
    m = await mount({ markdown: 'Go to [the site](https://example.com) now.\n' })
    caret(m.view, 'the s')
    press(m, 'k', { mod: true })
    action(m, 'edit')!.click()
    expect(field(m, 'url')!.value).toBe('https://example.com')
    enter(field(m, 'url')!, 'https://example.org')
    expect(await saved(m)).toBe('Go to [the site](https://example.org) now.\n')
    caret(m.view, 'the s')
    press(m, 'k', { mod: true })
    action(m, 'edit')!.click()
    enter(field(m, 'url')!, '')
    expect(await saved(m)).toBe('Go to the site now.\n')
  })

  it('Remove in the view popover unlinks; Esc cancels', async () => {
    m = await mount({ markdown: 'Go to [the site](https://example.com) now.\n' })
    caret(m.view, 'the s')
    press(m, 'k', { mod: true })
    pop(m)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(pop(m)).toBeNull()
    caret(m.view, 'the s')
    press(m, 'k', { mod: true })
    action(m, 'remove')!.click()
    expect(await saved(m)).toBe('Go to the site now.\n')
  })

  it('Cmd+click opens a link directly', async () => {
    m = await mount({ markdown: 'Go to [the site](https://example.com) now.\n' })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const r = find(m.view, 'the site')
    const handled = m.view.someProp('handleClick', (f) => f(m!.view, r.from + 2, new MouseEvent('click', { metaKey: true })))
    expect(handled).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
  })

  it('Suggesting mode: adding a link is a tracked format suggestion; the .md is untouched', async () => {
    m = await mount({ markdown: 'Read the primer today.\n' })
    m.bridge.setMode('suggesting')
    select(m, 'primer')
    press(m, 'k', { mod: true })
    enter(field(m, 'url')!, 'https://example.com/primer')
    const kinds = [...m.bridge.getSuggestionSummaries().values()].map((s) => s.kind)
    expect(kinds).toContain('format')
    expect(await saved(m)).toBe('Read the primer today.\n')
  })
})

describe('normalizeLinkInput (QA round 1: unverified 5)', () => {
  it.each([
    ['example.com/page', 'https://example.com/page'],
    ['www.example.com', 'https://www.example.com'],
    ['example.com', 'https://example.com'],
    ['  example.com  ', 'https://example.com'],
    ['sub.example.co.uk/a?b=1#c', 'https://sub.example.co.uk/a?b=1#c'],
    ['a@b.com', 'mailto:a@b.com'],
    ['https://example.com/x', 'https://example.com/x'],
    ['http://example.com', 'http://example.com'],
    ['mailto:a@b.com', 'mailto:a@b.com'],
    ['#section', '#section'],
    ['/pricing', '/pricing'],
    ['./notes.md', './notes.md'],
    ['notes.md', 'notes.md'],
    ['docs/plan.pdf', 'docs/plan.pdf'],
    ['//cdn.example.com/x', '//cdn.example.com/x'],
    ['', ''],
  ])('%s -> %s', (input, out) => {
    expect(normalizeLinkInput(input)).toBe(out)
  })

  it('javascript: still goes through unchanged for linkAllowed to refuse', () => {
    expect(normalizeLinkInput('javascript:alert(1)')).toBe('javascript:alert(1)')
    expect(linkAllowed(normalizeLinkInput('javascript:alert(1)'))).toBe(false)
  })
})

/** One typed character at a time, through ProseMirror's own text-input path (handleTextInput, then the default insert). */
function typeText(mm: Mounted, text: string): void {
  for (const ch of text) {
    const { from, to } = mm.view.state.selection
    if (!mm.view.someProp('handleTextInput', (f) => f(mm.view, from, to, ch, () => mm.view.state.tr))) mm.view.dispatch(mm.view.state.tr.insertText(ch, from, to))
  }
}

describe('typing at a link boundary (QA round 1: unverified 23, 35)', () => {
  it('text typed right after the link text is not part of the link; at its start too', async () => {
    m = await mount({ markdown: 'See [the doc](https://x.com) now.\n' })
    const r = find(m.view, 'the doc')
    m.view.focus()
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.to)))
    typeText(m, 'XY')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.from)))
    typeText(m, 'AB')
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe('See AB[the doc](https://x.com)XY now.\n')
  })

  it('typing inside a link keeps the link', async () => {
    m = await mount({ markdown: 'See [the doc](https://x.com) now.\n' })
    const r = find(m.view, 'the doc')
    m.view.focus()
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.from + 3)))
    typeText(m, 'Z')
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe('See [theZ doc](https://x.com) now.\n')
  })
})
