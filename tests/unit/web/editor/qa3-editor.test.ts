// tests/unit/web/editor/qa3-editor.test.ts (QA round 3, editor fixer). Each describe names the finding it pins.
import { afterEach, describe, expect, it } from 'vitest'
import { setSpliceFaultForTests } from '../../../../core/splice/apply'
import { AllSelection, TextSelection } from '@milkdown/kit/prose/state'
import { ulid } from 'ulid'
import type { ClientId, SuggestionId } from '../../../../shared/types'
import { TESTID } from '../../../../shared/constants'
import { caret, find, marksOf, mount, press, saved, select, tick, typeKeys, until, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  setSpliceFaultForTests(null)
  await m?.close()
  m = null
})

const PARA = '# Plan\n\nSecond paragraph talks about the waitlist and the explainer page. It is short but has two sentences.\n\nFinal paragraph.\n'

describe('F1: Enter right after a space, autosave, then more typing', () => {
  it('saves the typed text into the new paragraph with no splice mismatch', async () => {
    m = await mount({ markdown: PARA })
    caret(m.view, 'explainer', { at: 'start' })
    press(m, 'Enter')
    expect(await saved(m)).toContain('and the \n\nexplainer page.')
    typeKeys(m.view, 'MY TYPED TEXT ')
    const out = await saved(m)
    expect(m.session.getSaveState().state).toBe('saved')
    expect(m.session.getRecoveredDraft()).toBeNull()
    expect(out).toContain('and the \n\nMY TYPED TEXT explainer page.')
    expect(m.view.state.doc.textContent).toContain('MY TYPED TEXT explainer')
  })

  it('Enter between two sentences after the space, then typing, saves too', async () => {
    m = await mount({ markdown: PARA })
    caret(m.view, 'It is short', { at: 'start' })
    press(m, 'Enter')
    await saved(m)
    typeKeys(m.view, 'ZZ ')
    expect(await saved(m)).toContain('\n\nZZ It is short')
  })

  it('the recovered copy (Keep mine, Copy) keeps text whose op failed verification', async () => {
    m = await mount({ markdown: PARA })
    caret(m.view, 'Final', { at: 'start' })
    typeKeys(m.view, 'KEEP ME ')
    setSpliceFaultForTests((op) => op.blocks.some((b) => b.includes('KEEP ME')))
    expect(m.ed.liveMarkdown()).toContain('KEEP ME Final paragraph.')
  })
})

const BASIC = '# Launch plan\n\nThe notes carry a member rate of 12% paid monthly. We launch in Q3.\n\nThe member rate is reviewed every quarter.\n'

/** The struck and inserted runs, in document order (adjacent text nodes of one kind joined). */
function runs(m: Mounted): string[] {
  const out: string[] = []
  m.view.state.doc.descendants((n) => {
    if (!n.isText) return true
    const k = n.marks.find((x) => x.type.name === 'deletion') ? 'DEL' : n.marks.find((x) => x.type.name === 'insertion') ? 'INS' : null
    if (!k) return true
    const last = out[out.length - 1]
    if (last?.startsWith(k + '[')) out[out.length - 1] = `${last.slice(0, -1)}${n.text}]`
    else out.push(`${k}[${n.text}]`)
    return true
  })
  return out
}

describe('Suggesting mode: forward Delete strikes the next character each time', () => {
  it('four presses before "member" strike "memb"; typing then lands after the struck text', async () => {
    m = await mount({ markdown: BASIC })
    m.bridge.setMode('suggesting')
    caret(m.view, 'member rate of', { at: 'start' })
    for (let i = 0; i < 4; i++) expect(press(m, 'Delete')).toBe(true)
    expect(runs(m)).toEqual(['DEL[memb]'])
    typeKeys(m.view, 'X')
    expect(runs(m)).toEqual(['DEL[memb]', 'INS[X]'])
    expect(m.view.state.doc.textContent).toContain('a membXer rate')
  })

  it('seven presses before "quarter" strike the whole word as one suggestion', async () => {
    m = await mount({ markdown: BASIC })
    m.bridge.setMode('suggesting')
    caret(m.view, 'quarter', { at: 'start' })
    for (let i = 0; i < 7; i++) press(m, 'Delete')
    expect(runs(m)).toEqual(['DEL[quarter]'])
    expect(new Set(marksOf(m.view).map((x) => x.id)).size).toBe(1)
  })
})

describe('Suggesting mode: Backspace through the previous word', () => {
  it('dbl-click a word, Backspace, Backspace: one suggestion, the space struck, nothing inserted', async () => {
    m = await mount({ markdown: BASIC })
    m.bridge.setMode('suggesting')
    const w = find(m.view, 'paid')
    select(m.view, w.from, w.to)
    press(m, 'Backspace')
    press(m, 'Backspace')
    expect(runs(m)).toEqual(['DEL[ paid]'])
    expect(new Set(marksOf(m.view).map((x) => x.id)).size).toBe(1)
  })

  it('from just after the space, each press strikes one more character to the left', async () => {
    m = await mount({ markdown: BASIC })
    m.bridge.setMode('suggesting')
    caret(m.view, 'monthly', { at: 'start' })
    for (let i = 0; i < 7; i++) press(m, 'Backspace')
    expect(runs(m)).toEqual(['DEL[% paid ]'])
    for (let i = 0; i < 2; i++) press(m, 'Backspace')
    expect(runs(m)).toEqual(['DEL[12% paid ]'])
  })
})

const TWO = 'First para.\n\nSecond para.\n'
const blockedNotices = (m: Mounted): string[] => m.notices.filter((n) => n.code === 'SUGGEST_MODE_BLOCKED').map((n) => n.text)

describe('Suggesting mode: structural edits inside text TJ just added are never refused', () => {
  it('Enter then Backspace removes the paragraph break cleanly', async () => {
    m = await mount({ markdown: TWO })
    m.bridge.setMode('suggesting')
    caret(m.view, 'First para.')
    press(m, 'Enter')
    press(m, 'Backspace')
    expect(blockedNotices(m)).toEqual([])
    expect(marksOf(m.view)).toEqual([])
    expect(m.view.state.doc.childCount).toBe(2)
    typeKeys(m.view, ' more')
    expect(m.ed.liveMarkdown()).toBe('First para. more\n\nSecond para.\n')
  })

  it('Enter, type, Backspace everything typed, Backspace once more: back to the original', async () => {
    m = await mount({ markdown: TWO })
    m.bridge.setMode('suggesting')
    caret(m.view, 'First para.')
    press(m, 'Enter')
    typeKeys(m.view, 'Hi')
    for (let i = 0; i < 3; i++) press(m, 'Backspace')
    expect(blockedNotices(m)).toEqual([])
    expect(marksOf(m.view)).toEqual([])
    expect(m.ed.liveMarkdown()).toBe(TWO)
  })

  it('a list started in typed text: Enter makes new items (bullets and numbers)', async () => {
    m = await mount({ markdown: TWO })
    m.bridge.setMode('suggesting')
    caret(m.view, 'First para.')
    press(m, 'Enter')
    typeKeys(m.view, '- a')
    press(m, 'Enter')
    typeKeys(m.view, 'b')
    press(m, 'Enter')
    typeKeys(m.view, 'c')
    expect(blockedNotices(m)).toEqual([])
    expect(m.ed.liveMarkdown()).toBe('First para.\n\n- a\n- b\n- c\n\nSecond para.\n')
    expect(await saved(m)).toBe(TWO)
    expect(new Set(marksOf(m.view).map((x) => x.id)).size).toBe(1)
  })

  it('numbered: "1. alpha", Enter, "beta"', async () => {
    m = await mount({ markdown: TWO })
    m.bridge.setMode('suggesting')
    caret(m.view, 'First para.')
    press(m, 'Enter')
    typeKeys(m.view, '1. alpha')
    press(m, 'Enter')
    typeKeys(m.view, 'beta')
    expect(blockedNotices(m)).toEqual([])
    expect(m.ed.liveMarkdown()).toBe('First para.\n\n1. alpha\n2. beta\n\nSecond para.\n')
  })

  it('Enter twice leaves the typed list; the next text is a paragraph', async () => {
    m = await mount({ markdown: TWO })
    m.bridge.setMode('suggesting')
    caret(m.view, 'First para.')
    press(m, 'Enter')
    typeKeys(m.view, '- a')
    press(m, 'Enter')
    press(m, 'Enter')
    typeKeys(m.view, 'after')
    expect(blockedNotices(m)).toEqual([])
    expect(m.ed.liveMarkdown()).toBe('First para.\n\n- a\n\nafter\n\nSecond para.\n')
  })

  it('Enter, type, bullet button: the new line becomes a bullet', async () => {
    m = await mount({ markdown: TWO })
    m.bridge.setMode('suggesting')
    caret(m.view, 'First para.')
    press(m, 'Enter')
    typeKeys(m.view, 'item')
    m.ed.runAction('bullet', m.view)
    expect(blockedNotices(m)).toEqual([])
    expect(m.ed.liveMarkdown()).toBe('First para.\n\n- item\n\nSecond para.\n')
  })

  it('Enter, then paste a markdown heading or list: inserted as part of the suggestion', async () => {
    for (const [text, want] of [['## New heading', '## New heading'], ['- a\n- b', '- a\n- b']] as const) {
      m = await mount({ markdown: TWO })
      m.bridge.setMode('suggesting')
      caret(m.view, 'First para.')
      press(m, 'Enter')
      m.view.pasteText(text, clip({ 'text/plain': text }))
      expect(blockedNotices(m)).toEqual([])
      expect(m.ed.liveMarkdown()).toBe(`First para.\n\n${want}\n\nSecond para.\n`)
      expect(await saved(m)).toBe(TWO)
      await m.close()
      m = null
    }
  })
})

/** A paste event carrying the given clipboard flavours (jsdom has no DataTransfer constructor). */
function clip(data: Record<string, string>): ClipboardEvent {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => data[t] ?? '', types: Object.keys(data) } })
  return e
}

/** Type like Chrome in Suggesting mode: one beforeinput per character (the editor's typeText path). */
function beforeInput(m: Mounted, text: string): void {
  for (const ch of text) {
    const e = new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true })
    m.view.dom.dispatchEvent(e)
  }
}

describe('Suggesting mode: one Cmd+Z undoes typing over a selected word', () => {
  it('the struck word and the typed text go together, leaving no stray Delete suggestion', async () => {
    m = await mount({ markdown: BASIC })
    m.bridge.setMode('suggesting')
    const w = find(m.view, 'monthly')
    select(m.view, w.from, w.to)
    beforeInput(m, 'weekly')
    expect(runs(m)).toEqual(['DEL[monthly]', 'INS[weekly]'])
    press(m, 'z', { mod: true })
    expect(runs(m)).toEqual([])
    expect(m.view.state.doc.textContent).toContain('12% paid monthly.')
  })
})

const TABLES = '# Tables\n\n| Deal | Member |\n|:-----|-------:|\n| Alpha | 12.0% |\n\nText between.\n'

describe('Suggesting mode: select all and Delete in a doc with a table (CONTRACTS 13.47)', () => {
  it('is blocked in the editor with the Switch to Editing notice; nothing is struck or sent', async () => {
    m = await mount({ markdown: TABLES })
    m.bridge.setMode('suggesting')
    m.view.dispatch(m.view.state.tr.setSelection(new AllSelection(m.view.state.doc)))
    press(m, 'Backspace')
    expect(blockedNotices(m)).toEqual(["Tables can't be added or removed in Suggesting mode."])
    expect(marksOf(m.view)).toEqual([])
    beforeInput(m, 'x')
    expect(marksOf(m.view)).toEqual([])
    expect(await saved(m)).toBe(TABLES)
    expect(m.session.getSaveState().state).toBe('saved')
  })

  it('striking text inside one cell, or the text around a table, is still fine', async () => {
    m = await mount({ markdown: TABLES })
    m.bridge.setMode('suggesting')
    const w = find(m.view, 'Alpha')
    select(m.view, w.from, w.to)
    press(m, 'Backspace')
    expect(blockedNotices(m)).toEqual([])
    expect(runs(m)).toEqual(['DEL[Alpha]'])
  })

  it('a suggestion the server refuses (422 UNANCHORABLE_TARGET) is taken back with a notice, and saving recovers', async () => {
    m = await mount({ markdown: BASIC })
    m.bridge.setMode('suggesting')
    let refused = 0
    m.transport.intercept((req) => {
      const body = req.body as { suggestions?: { upsert?: Array<{ id: string }> } } | undefined
      const id = body?.suggestions?.upsert?.[0]?.id
      if (req.path.startsWith('/api/save') && id && refused === 0) {
        refused++
        return { status: 422, json: { ok: false, error: { code: 'UNANCHORABLE_TARGET', message: 'a suggestion cannot change a table', suggestion: id } } }
      }
      return undefined
    })
    caret(m.view, 'We launch in Q3.')
    typeKeys(m.view, ' Soon.')
    await m.session.flush().catch(() => undefined)
    await until(() => marksOf(m!.view).length === 0, 5_000, 'refused suggestion taken back')
    expect(m.notices.some((n) => n.code === 'SUGGEST_MODE_BLOCKED' && n.action?.label === 'Switch to Editing')).toBe(true)
    await m.session.flush()
    expect(m.session.getSaveState().state).toBe('saved')
    expect(m.view.state.doc.textContent).not.toContain('Soon.')
  })
})

const LINKED = 'See [the primer](https://example.com/primer) today.\n'
const popoverOpen = (m: Mounted): boolean => !!m.host.querySelector(`[data-testid="${TESTID.linkPopover}"]`)

describe('links: clicking into one, retyping one', () => {
  it('a click inside a link shows its popover but keeps the caret in the document', async () => {
    m = await mount({ markdown: LINKED })
    m.view.focus()
    const pos = find(m.view, 'primer').from + 2
    select(m.view, pos, pos)
    m.view.someProp('handleClick', (f) => f(m!.view, pos, new MouseEvent('click', { bubbles: true })))
    await tick(10)
    expect(popoverOpen(m)).toBe(true)
    expect(m.host.ownerDocument.activeElement).toBe(m.view.dom)
    typeKeys(m.view, 'x')
    expect(m.view.state.doc.textContent).toContain('the prximer')
  })

  it('retyping the whole link text keeps it all in the link', async () => {
    m = await mount({ markdown: LINKED })
    const r = find(m.view, 'the primer')
    select(m.view, r.from, r.to)
    typeKeys(m.view, 'the guide')
    expect(await saved(m)).toBe('See [the guide](https://example.com/primer) today.\n')
  })

  it('retyping still holds when the browser reports the first key as a deletion (typed "t" over "the primer")', async () => {
    m = await mount({ markdown: LINKED })
    const r = find(m.view, 'the primer')
    select(m.view, r.from, r.to)
    // what Chrome's DOM diff can produce: the common first letter kept, the rest deleted, the caret after it
    const tr = m.view.state.tr.delete(r.from + 1, r.to)
    m.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, r.from + 1)))
    typeKeys(m.view, 'he guide')
    expect(await saved(m)).toBe('See [the guide](https://example.com/primer) today.\n')
  })

  it('typing at the end of a link after placing the caret there still does not extend it', async () => {
    m = await mount({ markdown: LINKED })
    caret(m.view, 'the primer')
    typeKeys(m.view, 's')
    expect(await saved(m)).toBe('See [the primer](https://example.com/primer)s today.\n')
  })
})

describe('addresses typed or pasted in the editor become links (QA3)', () => {
  it('Space or Enter after a typed URL or email links it (Editing mode); the file has no backslashes', async () => {
    m = await mount({ markdown: 'First para.\n' })
    caret(m.view, 'First para.')
    press(m, 'Enter')
    typeKeys(m.view, 'typed https://example.com/path_with_under?x=1&y=2 here.')
    press(m, 'Enter')
    typeKeys(m.view, 'mail me at someone@example.com')
    press(m, 'Enter')
    const links: string[] = []
    m.view.state.doc.descendants((n) => {
      for (const mk of n.marks) if (mk.type.name === 'link') links.push(`${n.text}|${String(mk.attrs.href)}`)
      return true
    })
    expect(links).toEqual(['https://example.com/path_with_under?x=1&y=2|https://example.com/path_with_under?x=1&y=2', 'someone@example.com|mailto:someone@example.com'])
    const out = await saved(m)
    expect(out).toContain('typed https://example.com/path_with_under?x=1&y=2 here.')
    expect(out).toContain('mail me at someone@example.com\n')
    expect(out).not.toContain('\\')
  })

  it('pasting plain text with a URL links it', async () => {
    m = await mount({ markdown: 'First para.\n' })
    caret(m.view, 'First para.')
    const t = ' pasted https://example.com/a_b?x=1&y=2 text'
    m.view.pasteText(t, clip({ 'text/plain': t }))
    expect(m.host.querySelectorAll('a').length).toBe(1)
    expect(await saved(m)).toBe('First para. pasted https://example.com/a_b?x=1&y=2 text\n')
  })

  it('typed [text](url) becomes a link', async () => {
    m = await mount({ markdown: 'First para.\n' })
    caret(m.view, 'First para.')
    typeKeys(m.view, ' [more info](https://example.com/info)')
    expect(await saved(m)).toBe('First para. [more info](https://example.com/info)\n')
    expect(m.host.querySelectorAll('a').length).toBe(1)
  })
})

describe('an Editing-mode edit after a reload stays a direct edit, never a hunk of TJ\'s pending suggestion', () => {
  it('the suggestion keeps one hunk, the file gets the edit, and Accept inserts only the suggestion', async () => {
    const BASIC_FULL = '# Launch plan\n\nThe notes carry a member rate of 12% paid monthly.\n\nThe member rate is reviewed every quarter.\n\n> A short quote for context.\n\nFinal paragraph with **bold**.\n'
    m = await mount({ markdown: BASIC_FULL })
    m.bridge.setMode('suggesting')
    caret(m.view, 'every quarter')
    typeKeys(m.view, ' by finance')
    await m.session.flush()
    await until(() => m!.session.getReview().suggestions.length === 1, 5_000, 'suggestion saved')
    // a fresh page on the same file (the pill is back on Editing)
    const fx = m.fx
    m.handle.destroy()
    await m.session.close()
    document.getElementById('mdr-app')?.remove()
    // a new page load has its own client id (the fixture's default is shared by every transport)
    const second = `k_${ulid()}` as ClientId
    m = await mount({ markdown: BASIC_FULL, fx: { ...fx, open: (oo = {}) => fx.open({ ...oo, transport: fx.transport(second) }) } })
    m.bridge.setMode('editing')
    await until(() => marksOf(m!.view).length > 0, 5_000, 'suggestion hydrated')
    caret(m.view, 'Final paragraph', { at: 'start' })
    typeKeys(m.view, 'Intro: ')
    await m.session.flush()
    await until(() => m!.session.getSaveState().state === 'saved', 5_000, 'saved')
    await m.session.flush()
    expect(fx.root.read('doc.md')).toContain('Intro: Final paragraph')
    // the server's record, not the page's cached review state
    const res = await fx.fa.fetch(new Request(`http://127.0.0.1:${fx.fa.port}/api/review?file=doc.md`, { headers: { Authorization: `Bearer ${fx.fa.token}`, 'X-MDR-Client': 'web' } }))
    const review = (await res.json()) as { suggestions: Array<{ id: SuggestionId; status: string; proposed: string; hunks: Array<{ ins: string }> }> }
    const recs = review.suggestions.filter((s) => s.status === 'pending')
    expect(recs[0]!.hunks.map((h) => h.ins)).toEqual([' by finance'])
    expect(recs).toHaveLength(1)
    expect(recs[0]!.proposed).not.toContain('Intro')
    expect(recs[0]!.proposed).toContain('quarter by finance.')
    expect(await m.bridge.accept(recs[0]!.id)).toEqual({ ok: true })
    const out = fx.root.read('doc.md')
    expect(out).toContain('every quarter by finance.')
    expect(out).toContain('\n\nIntro: Final paragraph')
    expect(out).not.toContain('Intro: Intro:')
  })
})

describe('a read-only tab says so (second tab on the same doc)', () => {
  it('the mode pill is disabled with the formatting buttons, and a click in the document explains why typing does nothing', async () => {
    m = await mount({ markdown: BASIC })
    m.ed.setEditable(false)
    const pill = m.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.modePill}"]`)!
    expect(pill.getAttribute('aria-disabled')).toBe('true')
    pill.click()
    expect(m.bridge.getMode()).toBe('editing')
    const down = new MouseEvent('mousedown', { bubbles: true })
    m.view.someProp('handleDOMEvents', (h) => (h as { mousedown?: (v: unknown, e: Event) => boolean }).mousedown?.(m!.view, down))
    expect(m.notices.some((n) => n.code === 'READ_ONLY' && /read-only/.test(n.text))).toBe(true)
    m.ed.setEditable(true)
    expect(pill.getAttribute('aria-disabled')).toBeNull()
  })
})

describe('opening a doc', () => {
  it('the editor has the focus with a caret at the start of the first text (typing works at once)', async () => {
    m = await mount({ markdown: BASIC })
    await until(() => m!.host.ownerDocument.activeElement === m!.view.dom, 2_000, 'focus on open')
    const sel = m.view.state.selection
    expect(sel.empty).toBe(true)
    expect(sel.$from.parent.textContent).toBe('Launch plan')
  })

  it('a doc that starts with YAML frontmatter opens with nothing selected: no ring on the panel, no comment target', async () => {
    m = await mount({ markdown: '---\ntitle: Simple frontmatter\nstatus: draft only\n---\n\n# Heading\n\nBody text.\n' })
    const sel = m.view.state.selection
    expect(sel.empty).toBe(true)
    expect(sel.$from.parent.type.name).toBe('heading')
    expect(m.host.querySelector('.is-selected, .ProseMirror-selectednode')).toBeNull()
  })
})

describe('code block language field', () => {
  it('Enter or Escape returns the caret to the start of that code block, not the top of the document', async () => {
    for (const key of ['Enter', 'Escape']) {
      m = await mount({ markdown: '# Title\n\nIntro.\n\n```\nx = 1\n```\n\nAfter.\n' })
      caret(m.view, 'Title', { at: 'start' })
      const input = m.host.querySelector<HTMLInputElement>(`[data-testid="${TESTID.codeLanguage}"]`)!
      input.focus()
      input.value = 'python'
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      expect(m.host.ownerDocument.activeElement).toBe(m.view.dom)
      expect(m.view.state.selection.$from.parent.type.name).toBe('code_block')
      expect(m.view.state.selection.$from.parentOffset).toBe(0)
      typeKeys(m.view, 'print(1)\n')
      const out = await saved(m)
      expect(out.startsWith('# Title')).toBe(true)
      expect(out).toContain('print(1)\nx = 1')
      await m.close()
      m = null
    }
  })
})
