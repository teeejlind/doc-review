// tests/unit/web/editor/inputRules.test.ts (P2; CONTRACTS §12.13 "Input rules"). Every row of the input-rule table,
// typed character by character through handleTextInput (what the browser does), checked against the saved file;
// no rule inside code; Backspace right after a rule undoes it; the Enter-triggered code fence and rule; and the
// Suggesting-mode behaviour (tracked structure / format suggestions; the fence and the rule blocked).
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { caret, caretAtDocEnd, mount, press, saved, typeKeys, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

/** A doc ending in an empty paragraph to type into (the last block of `md` stays untouched). */
async function typeInto(text: string, o: { md?: string; then?: (m: Mounted) => void } = {}): Promise<string> {
  m = await mount({ markdown: o.md ?? 'Intro.\n' })
  caretAtDocEnd(m.view)
  press(m, 'Enter')
  typeKeys(m.view, text)
  o.then?.(m)
  return saved(m)
}

describe('mark rules (§12.13)', () => {
  const cases: Array<[string, string]> = [
    ['say **bold** now', 'say **bold** now'],
    ['say __bold__ now', 'say **bold** now'],
    ['say *it* now', 'say *it* now'],
    ['say _it_ now', 'say *it* now'],
    ['run `npm test` now', 'run `npm test` now'],
    ['an ~~old~~ word', 'an ~~old~~ word'],
  ]
  for (const [typed, want] of cases) {
    it(`${typed} → ${want}`, async () => {
      expect(await typeInto(typed)).toBe(`Intro.\n\n${want}\n`)
    })
  }

  it('snake_case words and lone delimiters stay plain text', async () => {
    const out = await typeInto('a snake_case_name and 2 * 3 * 4')
    expect(out).toBe('Intro.\n\na snake_case_name and 2 \\* 3 \\* 4\n')
    expect(m!.view.state.doc.rangeHasMark(0, m!.view.state.doc.content.size, m!.view.state.schema.marks.emphasis!)).toBe(false)
  })

  it('no mark rule fires inside inline code', async () => {
    m = await mount({ markdown: 'Intro.\n' })
    caretAtDocEnd(m.view)
    typeKeys(m.view, ' `ab`')
    caret(m.view, 'a', { nth: 0 })
    // the caret between a and b sits inside the code mark
    const r = m.view.state.doc.textContent.indexOf('ab')
    expect(r).toBeGreaterThan(0)
    typeKeys(m.view, '**x**')
    expect(await saved(m)).toBe('Intro. `a**x**b`\n')
  })
})

describe('block rules (§12.13)', () => {
  it('# … ###### at line start → headings 1-6', async () => {
    for (let n = 1; n <= 6; n++) {
      const hashes = '#'.repeat(n)
      expect(await typeInto(`${hashes} Title ${n}`)).toBe(`Intro.\n\n${hashes} Title ${n}\n`)
      await m!.close()
      m = null
    }
  })

  it('- / * / + at line start → a bullet list saved with -', async () => {
    for (const marker of ['-', '*', '+']) {
      expect(await typeInto(`${marker} item`)).toBe('Intro.\n\n- item\n')
      await m!.close()
      m = null
    }
  })

  it('1. / 1) at line start → an ordered list from that number', async () => {
    expect(await typeInto('1. first')).toBe('Intro.\n\n1. first\n')
    await m!.close()
    m = null
    expect(await typeInto('3) third')).toBe('Intro.\n\n3. third\n')
  })

  it('[ ] / [x] at the start of a list item, and - [ ] at line start → task items', async () => {
    expect(await typeInto('- [ ] todo')).toBe('Intro.\n\n- [ ] todo\n')
    await m!.close()
    m = null
    expect(await typeInto('- [x] done')).toBe('Intro.\n\n- [x] done\n')
    await m!.close()
    m = null
    // in an existing list item
    expect(await typeInto('[ ] later', { md: '- first\n' })).toBe('- first\n- [ ] later\n')
  })

  it('> at line start → blockquote', async () => {
    expect(await typeInto('> quoted')).toBe('Intro.\n\n> quoted\n')
  })

  it('``` or ```lang then Enter → a code block with the fence language', async () => {
    const out = await typeInto('```ts', { then: (mm) => {
      press(mm, 'Enter')
      typeKeys(mm.view, 'const a = 1')
    } })
    expect(out).toBe('Intro.\n\n```ts\nconst a = 1\n```\n')
    await m!.close()
    m = null
    expect(await typeInto('```', { then: (mm) => {
      press(mm, 'Enter')
      typeKeys(mm.view, 'plain')
    } })).toBe('Intro.\n\n```\nplain\n```\n')
  })

  it('--- / *** / ___ alone then Enter → a horizontal rule saved as ---', async () => {
    for (const r of ['---', '***', '___']) {
      const out = await typeInto(r, { then: (mm) => {
        press(mm, 'Enter')
        typeKeys(mm.view, 'after')
      } })
      expect(out).toBe('Intro.\n\n---\n\nafter\n')
      await m!.close()
      m = null
    }
  })

  it('no block rule fires inside a code block', async () => {
    m = await mount({ markdown: '```\ncode\n```\n' })
    caretAtDocEnd(m.view)
    press(m, 'Enter')
    typeKeys(m.view, '# not a heading')
    expect(await saved(m)).toBe('```\ncode\n# not a heading\n```\n')
  })
})

describe('Backspace right after a rule undoes it', () => {
  it('heading, list and bold rules each come back as the typed text', async () => {
    const undoThen = (mm: Mounted): void => {
      press(mm, 'Backspace')
      typeKeys(mm.view, 'x')
    }
    expect(await typeInto('# ', { then: undoThen })).toBe('Intro.\n\n\\# x\n')
    await m!.close()
    m = null
    expect(await typeInto('- ', { then: undoThen })).toBe('Intro.\n\n\\- x\n')
    await m!.close()
    m = null
    expect(await typeInto('**b**', { then: (mm) => press(mm, 'Backspace') })).toBe('Intro.\n\n\\*\\*b\\*\\*\n')
  })
})

describe('Suggesting mode', () => {
  it('# becomes a structure suggestion and **x** a format suggestion; the .md is untouched', async () => {
    m = await mount({ markdown: 'Make this a title.\n\nMake bold here.\n' })
    m.bridge.setMode('suggesting')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1)))
    typeKeys(m.view, '# ')
    expect(m.view.state.doc.firstChild!.type.name).toBe('heading')
    const kinds = [...m.bridge.getSuggestionSummaries().values()].map((s) => s.kind)
    expect(kinds).toContain('structure')
    expect(await saved(m)).toBe('Make this a title.\n\nMake bold here.\n')
  })

  it('a format input rule on typed text is tracked as a TJ suggestion', async () => {
    m = await mount({ markdown: 'Intro.\n' })
    m.bridge.setMode('suggesting')
    caretAtDocEnd(m.view)
    typeKeys(m.view, ' **x**')
    const sums = [...m.bridge.getSuggestionSummaries().values()]
    expect(sums.length).toBeGreaterThan(0)
    expect(sums.every((s) => s.by === 'TJ')).toBe(true)
    expect(m.view.state.doc.rangeHasMark(0, m.view.state.doc.content.size, m.view.state.schema.marks.strong!)).toBe(true)
    expect(await saved(m)).toBe('Intro.\n')
  })

  it.each([
    ['# Big title', 'heading', 1],
    ['## Smaller', 'heading', 2],
    ['- one', 'bullet_list', null],
    ['1. first', 'ordered_list', null],
  ] as const)('%s typed on a NEW line (after Enter) in Suggesting mode still auto-formats (TJ hands-on, 2026-10-16)', async (typed, node, level) => {
    m = await mount({ markdown: 'Intro.\n' })
    m.bridge.setMode('suggesting')
    caretAtDocEnd(m.view)
    press(m, 'Enter')
    typeKeys(m.view, typed)
    const types: string[] = []
    m.view.state.doc.descendants((n) => {
      types.push(n.type.name + (n.type.name === 'heading' ? String(n.attrs.level) : ''))
      if (n.isText) types.push(JSON.stringify(n.text) + '/' + n.marks.map((k) => k.type.name).join('+'))
    })
    expect(types, JSON.stringify(types) + ' notices=' + m.notices.map((n) => n.code)).toContain(node === 'heading' ? `heading${level}` : node)
    expect(m.notices.map((n) => n.code)).not.toContain('SUGGEST_MODE_BLOCKED')
    expect(await saved(m)).toBe('Intro.\n')
  })

  it('the code fence and the rule are blocked with SUGGEST_MODE_BLOCKED', async () => {
    m = await mount({ markdown: 'Intro.\n' })
    caretAtDocEnd(m.view)
    press(m, 'Enter')
    m.bridge.setMode('suggesting')
    typeKeys(m.view, '```')
    press(m, 'Enter')
    expect(m.view.state.doc.descendants((n) => n.type.name !== 'code_block')).toBeUndefined()
    let hasCode = false
    m.view.state.doc.descendants((n) => {
      if (n.type.name === 'code_block') hasCode = true
    })
    expect(hasCode).toBe(false)
    expect(m.notices.map((n) => n.code)).toContain('SUGGEST_MODE_BLOCKED')
  })
})
