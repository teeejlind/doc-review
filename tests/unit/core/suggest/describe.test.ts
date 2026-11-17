// tests/unit/core/suggest/describe.test.ts (QA round 1: confirmed 20, 28). describeChange / hunkPlaces over record source.
import { describe, expect, it } from 'vitest'
import { describeChange, hunkPlaces, hunksAreTextless } from '../../../../core/suggest/describe'

describe('hunksAreTextless', () => {
  it('no hunks, or only whitespace changes, carry no text', () => {
    expect(hunksAreTextless([])).toBe(true)
    expect(hunksAreTextless([{ del: ' ', ins: '\n' }])).toBe(true)
    expect(hunksAreTextless([{ del: '', ins: 'x' }])).toBe(false)
  })
})

describe('describeChange: what a textless suggestion does', () => {
  const P = 'A paragraph. We launch in Q3 with the member rate set.'
  it('bold, italic, strikethrough and code added or removed name their words', () => {
    expect(describeChange(P, P.replace('member', '**member**'))).toEqual({ kind: 'format', detail: 'Bold: member' })
    expect(describeChange(P, P.replace('member rate', '*member rate*'))).toEqual({ kind: 'format', detail: 'Italic: member rate' })
    expect(describeChange(P, P.replace('Q3', '~~Q3~~'))).toEqual({ kind: 'format', detail: 'Strikethrough: Q3' })
    expect(describeChange(P, P.replace('Q3', '`Q3`'))).toEqual({ kind: 'format', detail: 'Code: Q3' })
    expect(describeChange(P.replace('member', '**member**'), P)).toEqual({ kind: 'format', detail: 'Remove bold: member' })
  })

  it('a link retarget shows both addresses, shortened to the path on the same site', () => {
    const a = 'See the [fee schedule](https://example.com/fees) for details.'
    const b = 'See the [fee schedule](https://example.com/pricing) for details.'
    expect(describeChange(a, b)).toEqual({ kind: 'format', detail: 'Link: /fees → /pricing' })
    expect(describeChange(a, a.replace('https://example.com/fees', 'https://other.org/x'))).toEqual({ kind: 'format', detail: 'Link: example.com/fees → other.org/x' })
    expect(describeChange('See fees.', 'See [fees](https://example.com/fees).')).toEqual({ kind: 'format', detail: 'Link added: example.com/fees' })
    expect(describeChange('See [fees](https://example.com/fees).', 'See fees.')).toEqual({ kind: 'format', detail: 'Link removed: example.com/fees' })
  })

  it('headings: added, removed, re-levelled', () => {
    expect(describeChange('Second paragraph.', '## Second paragraph.')).toEqual({ kind: 'structure', detail: 'Heading 2' })
    expect(describeChange('## Second paragraph.', 'Second paragraph.')).toEqual({ kind: 'structure', detail: 'Heading 2 → paragraph' })
    expect(describeChange('# Title', '### Title')).toEqual({ kind: 'structure', detail: 'Heading 1 → Heading 3' })
  })

  it('task checkboxes: checked, unchecked, added, removed', () => {
    const list = '- [ ] Todo one\n- [x] Todo two'
    expect(describeChange(list, '- [x] Todo one\n- [x] Todo two')).toEqual({ kind: 'structure', detail: 'Checked: Todo one' })
    expect(describeChange(list, '- [ ] Todo one\n- [ ] Todo two')).toEqual({ kind: 'structure', detail: 'Unchecked: Todo two' })
    expect(describeChange('- Todo one\n- Todo two', '- [ ] Todo one\n- Todo two')).toEqual({ kind: 'structure', detail: 'Checkbox: Todo one' })
    expect(describeChange(list, '- Todo one\n- [x] Todo two')).toEqual({ kind: 'structure', detail: 'Remove checkbox: Todo one' })
  })

  it('lists, quotes, code blocks and indentation', () => {
    expect(describeChange('Grow the waitlist', '- Grow the waitlist')).toEqual({ kind: 'structure', detail: 'Bulleted list' })
    expect(describeChange('Grow the waitlist', '1. Grow the waitlist')).toEqual({ kind: 'structure', detail: 'Numbered list' })
    expect(describeChange('- a\n- b', '1. a\n- b')).toEqual({ kind: 'structure', detail: 'Numbered list' })
    expect(describeChange('- a\n- b', '- a\n  - b')).toEqual({ kind: 'structure', detail: 'Indent: b' })
    expect(describeChange('- a\n- b', '- a\n- b\n- ')).toEqual({ kind: 'structure', detail: 'New list item' })
    expect(describeChange('A short quote.', '> A short quote.')).toEqual({ kind: 'structure', detail: 'Quote' })
    expect(describeChange('const a = 1', '```\nconst a = 1\n```')).toEqual({ kind: 'structure', detail: 'Code block' })
  })

  it('splitting and merging blocks', () => {
    expect(describeChange('Final paragraph with bold.', 'Final paragraph\n\nwith bold.')).toEqual({ kind: 'structure', detail: 'Split paragraph' })
    expect(describeChange('Final paragraph\n\nwith bold.', 'Final paragraph with bold.')).toEqual({ kind: 'structure', detail: 'Merge paragraphs' })
  })

  it('nothing to report when the source is the same; a generic note when it cannot say', () => {
    expect(describeChange('same', 'same')).toBeNull()
    expect(describeChange('a\\*b', 'a*b')).toEqual({ kind: 'format', detail: 'Formatting changed' })
  })
})

describe('hunkPlaces: where a hunk sits in the source', () => {
  it('an insertion carries the text on both sides', () => {
    const base = 'A paragraph of text. We launch in Q3 with the member rate set.'
    const proposed = 'A paragraph of text. We launch in Q3 2026 with the member rate set.'
    const [p] = hunkPlaces(base, proposed, [{ del: '', ins: '2026 ' }])
    expect(p).toMatchObject({ before: 'A paragraph of text. We launch in Q3 ', after: 'with the member rate set.' })
    expect(p!.cell).toBeUndefined()
  })

  it('a table cell says its row and column', () => {
    const base = '| Deal | Rate | Term |\n|------|------|------|\n| ARV  | 9.0% | 12   |\n| BAR  |  | 6    |'
    const proposed = base.replace('| BAR  |  |', '| BAR  | 5 |')
    const [ins] = hunkPlaces(base, proposed, [{ del: '', ins: '5' }])
    expect(ins!.cell).toBe('row “BAR”, column “Rate”')
    expect(ins!.before).toContain('| BAR')
    const [rep] = hunkPlaces(base, base.replace('9.0%', '9.05%'), [{ del: '9.0%', ins: '9.05%' }])
    expect(rep!.cell).toBe('row “ARV”, column “Rate”')
    const [first] = hunkPlaces(base, base.replace('| ARV ', '| ARVX'), [{ del: 'ARV', ins: 'ARVX' }])
    expect(first!.cell).toBe('row 1, column “Deal”')
    const [head] = hunkPlaces(base, base.replace('Term', 'Terms'), [{ del: 'Term', ins: 'Terms' }])
    expect(head!.cell).toBe('column “Term” (header)')
  })

  it('hunks pair with source changes in order; a hunk with no source twin gets null', () => {
    const base = 'One two three four five six.'
    const proposed = 'One 2 three four 5 six.'
    const places = hunkPlaces(base, proposed, [{ del: 'two', ins: '2' }, { del: 'nothing', ins: 'here' }, { del: 'five', ins: '5' }])
    expect(places.map((p) => p !== null)).toEqual([true, false, true])
  })

  it('long context is cut to a word at each end', () => {
    const base = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'
    const proposed = base.replace('lambda ', 'lambda NEW ')
    const [p] = hunkPlaces(base, proposed, [{ del: '', ins: 'NEW ' }])
    expect(p!.before.length).toBeLessThanOrEqual(40)
    expect(base).toContain(p!.before)
    expect(p!.before.startsWith(' ') || /^\w+ /.test(p!.before)).toBe(true)
    expect(p!.before.endsWith('lambda ')).toBe(true)
    expect(p!.after.startsWith('mu nu')).toBe(true)
  })
})
