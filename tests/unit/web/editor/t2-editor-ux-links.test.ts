// tests/unit/web/editor/t2-editor-ux-links.test.ts (T2 editor-ux): Pass 4 #20 and #19, the link popover.
//   #20 the address is checked: http(s), mailto:, relative paths and #sections go in; a bare domain gets https://;
//       anything else ("example", "hello world") shows an inline error in plain words and is not applied.
//   #19 under a selection near the bottom of the window the popover opens above it (or scrolls into view), so the
//       field and its Apply / Cancel buttons are on screen. jsdom has no layout, so the boxes are stubbed here and the
//       real thing is in the t2-editor-ux-link e2e.
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import { linkProblem, normalizeLinkInput } from '../../../../web/src/editor/linkPopover'
import { Popover } from '../../../../web/src/editor/popover'
import { find, mount, press, saved, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
  vi.restoreAllMocks()
})

describe('linkProblem (#20)', () => {
  const fine = (typed: string): string | null => linkProblem(normalizeLinkInput(typed))

  it('takes what a link can be', () => {
    for (const ok of [
      'https://example.com', 'http://example.com/a?b=1#c', 'example.com', 'www.example.com/page', 'mailto:ana@example.com', 'ana@example.com',
      '#goals', './notes.md', '../up/notes.md', '/decks/q3.pdf', 'notes.md', 'docs/plan', '?tab=2', '', '  ',
    ]) expect(fine(ok), ok).toBeNull()
  })

  it('turns a bare domain into a web link', () => {
    expect(normalizeLinkInput('example.com')).toBe('https://example.com')
  })

  it('refuses a word, a phrase and a half-written address, in plain words', () => {
    for (const bad of ['example', 'hello world', 'my notes.md', 'https://', 'http:foo', 'mailto:', 'x y']) {
      expect(fine(bad), bad).toBe('Enter a web address, like example.com.')
    }
  })

  it('keeps the scheme message for javascript: and data:', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'localhost:3000']) expect(fine(bad), bad).toMatch(/allowed/)
  })
})

describe('the popover applies only a good address (#20)', () => {
  const pop = (mm: Mounted): HTMLElement | null => mm.host.querySelector<HTMLElement>(`[data-testid="${TESTID.linkPopover}"]`)
  const url = (mm: Mounted): HTMLInputElement => pop(mm)!.querySelector<HTMLInputElement>(`[data-field="url"]`)!
  const type = (input: HTMLInputElement, value: string): void => {
    input.value = value
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  async function open(): Promise<Mounted> {
    const mm = await mount({ markdown: 'Read the portfolio page today.\n' })
    const r = find(mm.view, 'portfolio page')
    mm.view.dispatch(mm.view.state.tr.setSelection(TextSelection.create(mm.view.state.doc, r.from, r.to)))
    press(mm, 'k', { mod: true })
    return mm
  }

  it('"example" and "hello world" stay in the popover with an error, and the file is untouched', async () => {
    m = await open()
    for (const bad of ['example', 'hello world']) {
      type(url(m), bad)
      expect(pop(m), bad).not.toBeNull()
      expect(pop(m)!.querySelector('[role="alert"]')!.textContent).toBe('Enter a web address, like example.com.')
    }
    expect(await saved(m)).toBe('Read the portfolio page today.\n')
  })

  it('a fixed address then applies, from the same popover', async () => {
    m = await open()
    type(url(m), 'example')
    type(url(m), 'example.com')
    expect(pop(m)).toBeNull()
    expect(await saved(m)).toBe('Read the [portfolio page](https://example.com) today.\n')
  })

  it('mailto:, a #section and a relative file all apply', async () => {
    for (const [typed, saved_] of [
      ['mailto:ana@example.com', '[portfolio page](mailto:ana@example.com)'],
      ['#goals', '[portfolio page](#goals)'],
      ['./notes.md', '[portfolio page](./notes.md)'],
    ] as const) {
      m = await open()
      type(url(m), typed)
      expect(await saved(m), typed).toBe(`Read the ${saved_} today.\n`)
      await m.close()
      m = null
    }
  })
})

describe('where the popover opens (#19)', () => {
  /** A popover in a scroller whose boxes are stubbed: the scroller is y 100..700, the host starts at y 100, the popover is 85 tall. */
  function setup(): { open(anchor: { left: number; bottom: number; top?: number }): { top: number; scrolled: boolean } } {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const host = document.createElement('div')
    scroller.appendChild(host)
    document.body.appendChild(scroller)
    const box = (top: number, height: number): DOMRect => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 300, width: 300, height, toJSON: () => ({}) }) as DOMRect
    scroller.getBoundingClientRect = () => box(100, 600)
    host.getBoundingClientRect = () => box(100, 2000)
    const scrollIntoView = vi.fn()
    return {
      open(anchor) {
        const p = new Popover({ host, className: 'x', testid: 'x', label: 'x' })
        p.el.getBoundingClientRect = () => box(100 + parseFloat(p.el.style.top || '0'), 85)
        p.el.scrollIntoView = scrollIntoView
        p.open(anchor)
        return { top: parseFloat(p.el.style.top), scrolled: scrollIntoView.mock.calls.length > 0 }
      },
    }
  }

  it('under the anchor when it fits', () => {
    expect(setup().open({ left: 40, bottom: 300, top: 280 })).toEqual({ top: 300 - 100 + 4, scrolled: false })
  })

  it('above the anchor when below would run off the bottom and there is room above', () => {
    // anchor line y 670..690: below would end at 694 + 85 = 779 > 700
    expect(setup().open({ left: 40, bottom: 690, top: 670 })).toEqual({ top: 670 - 85 - 4 - 100, scrolled: false })
  })

  it('scrolled into view when there is no room above either', () => {
    expect(setup().open({ left: 40, bottom: 690, top: 120 })).toEqual({ top: 690 - 100 + 4, scrolled: true })
    expect(setup().open({ left: 40, bottom: 690 })).toEqual({ top: 690 - 100 + 4, scrolled: true })
  })
})
