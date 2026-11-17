// tests/unit/web/editor/frontmatter/scan.test.ts (P2; CONTRACTS §12.12 A). The YAML line scanner: field kinds,
// comments, multiline fields, duplicates, unrecognized text, CRLF, and the frontmatter status chip value.
import { describe, expect, it } from 'vitest'
import { frontmatterStatus, parseValue, scanFrontmatter } from '../../../../../web/src/editor/frontmatter/scan'
import { fixtureText } from '../../../core/status-header/corpus'

function yamlOf(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md)
  if (!m) throw new Error('no YAML frontmatter')
  return m[1]!
}

describe('scanFrontmatter (§12.12 A)', () => {
  it('field kinds: plain, single, double, empty; comments and blank lines are never fields', () => {
    const s = scanFrontmatter([
      '# leading comment',
      'title: Plain title',
      "owner: 'TJ''s copy'",
      'quote: "a \\"b\\" \\\\ c"',
      'empty:',
      '',
      'tag: x # trailing note',
      "single: 'q' # after quote",
    ].join('\n'))
    expect(s.recognized).toBe(true)
    expect(s.fields.map((f) => [f.key, f.kind, f.value, f.comment, f.editable])).toEqual([
      ['title', 'plain', 'Plain title', null, true],
      ['owner', 'single', "TJ's copy", null, true],
      ['quote', 'double', 'a "b" \\ c', null, true],
      ['empty', 'empty', '', null, true],
      ['tag', 'plain', 'x', ' # trailing note', true],
      ['single', 'single', 'q', ' # after quote', true],
    ])
    expect(s.fields.map((f) => f.line)).toEqual([1, 2, 3, 4, 6, 7])
  })

  it('multiline: block scalars, lists, flow collections, nested maps, anchors, unclosed quotes', () => {
    const s = scanFrontmatter([
      'summary: >',
      '  Folded',
      '  text.',
      'tags:',
      '  - a',
      '  - b',
      'items:',
      '- top-level item',
      'flow: [a, b]',
      'map: {a: 1}',
      'nested:',
      '  child: 1',
      'anchor: &x value',
      'alias: *x',
      'open: "not closed',
      'literal: |',
      '  line one',
      '',
      '  line three',
      'after: plain',
    ].join('\n'))
    expect(s.recognized).toBe(true)
    const kinds = Object.fromEntries(s.fields.map((f) => [f.key, f.kind]))
    expect(kinds).toEqual({
      summary: 'multiline', tags: 'multiline', items: 'multiline', flow: 'multiline', map: 'multiline', nested: 'multiline',
      anchor: 'multiline', alias: 'multiline', open: 'multiline', literal: 'multiline', after: 'plain',
    })
    const literal = s.fields.find((f) => f.key === 'literal')!
    expect([literal.line, literal.endLine]).toEqual([15, 19])
    expect(literal.value).toBe('|\n  line one\n\n  line three')
    expect(s.fields.every((f) => f.kind === 'plain' || !f.editable)).toBe(true)
  })

  it('duplicate keys: both rows flagged, only the first occurrence editable', () => {
    const s = scanFrontmatter('status: a\nother: b\nstatus: c')
    expect(s.fields.map((f) => [f.key, f.duplicate, f.editable])).toEqual([
      ['status', true, true], ['other', false, true], ['status', true, false],
    ])
  })

  it('unrecognized: any other line (an indented line with no field, key:value with no blank, TOML)', () => {
    expect(scanFrontmatter('  stray indent').recognized).toBe(false)
    expect(scanFrontmatter('a: 1\nkey:value').unrecognizedLine).toBe(1)
    expect(scanFrontmatter('title = "TOML"').recognized).toBe(false)
    expect(scanFrontmatter('').recognized).toBe(true)
    expect(scanFrontmatter('').fields).toEqual([])
  })

  it('CRLF: the EOL is detected and values never carry the CR', () => {
    const s = scanFrontmatter('title: A\r\nstatus: draft # c\r\nlist:\r\n  - x')
    expect(s.eol).toBe('\r\n')
    expect(s.fields.map((f) => [f.key, f.kind, f.value])).toEqual([['title', 'plain', 'A'], ['status', 'plain', 'draft'], ['list', 'multiline', '\n  - x']])
  })

  it('syn__frontmatter-complex.md: every field classified as written', () => {
    const s = scanFrontmatter(yamlOf(fixtureText('syn__frontmatter-complex.md')))
    expect(s.recognized).toBe(true)
    expect(s.fields.map((f) => [f.key, f.kind])).toEqual([
      ['title', 'double'], ['owner', 'plain'], ['tags', 'multiline'], ['summary', 'multiline'], ['status', 'plain'], ['empty', 'empty'],
    ])
    expect(frontmatterStatus(s)).toBe('draft only · needs legal review')
  })

  it('the status chip value: /^status$/i, unquoted, a multi-line value shows its first line', () => {
    expect(frontmatterStatus(scanFrontmatter("Status: 'draft only'"))).toBe('draft only')
    expect(frontmatterStatus(scanFrontmatter('status: >\n  first line\n  second'))).toBe('first line')
    expect(frontmatterStatus(scanFrontmatter('status:\n  - blocked: x\n  - y'))).toBe('blocked: x')
    expect(frontmatterStatus(scanFrontmatter('title: x'))).toBeNull()
  })

  it('parseValue edge cases', () => {
    expect(parseValue(' # only a comment')).toEqual({ kind: 'empty', value: '', comment: ' # only a comment' })
    expect(parseValue(' a#b')).toEqual({ kind: 'plain', value: 'a#b', comment: null })
    expect(parseValue(" 'a' junk")).toBeNull()
    expect(parseValue(' "\\u00e9"')).toEqual({ kind: 'double', value: 'é', comment: null })
    expect(parseValue(' "bad \\q"')).toBeNull()
  })
})
