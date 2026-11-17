// tests/unit/web/editor/frontmatter/edit.test.ts (P2; CONTRACTS §12.12 A "Field editing"). Every edit changes
// exactly one line (add / remove: inserts / deletes one); quote style is preserved; the quoting rule table; trailing
// comments stay; CRLF; over syn__frontmatter-complex.md and every YAML header in the corpus.
import { describe, expect, it } from 'vitest'
import {
  addFrontmatterField, editFrontmatterField, FrontmatterEditError, needsQuoting, removeFrontmatterField,
} from '../../../../../web/src/editor/frontmatter/edit'
import { scanFrontmatter } from '../../../../../web/src/editor/frontmatter/scan'
import { corpusFiles, fixtureText } from '../../../core/status-header/corpus'

/** Lines with their EOL bytes, so a changed EOL counts as a changed line. */
const linesOf = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Line diff as the file sees it: the YAML is always followed by an EOL and the closing fence. */
function diff(a: string, b: string): { changed: number; inserted: number; deleted: number } {
  const x = linesOf(a + '\n---\n')
  const y = linesOf(b + '\n---\n')
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  let s = 0
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++
  const xa = x.length - p - s
  const ya = y.length - p - s
  return { changed: Math.min(xa, ya), inserted: Math.max(0, ya - xa), deleted: Math.max(0, xa - ya) }
}

const oneLineChanged = (a: string, b: string): void => expect(diff(a, b)).toEqual({ changed: 1, inserted: 0, deleted: 0 })

function yamlOf(md: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md)
  return m ? m[1]! : null
}

const Y = ['# note', 'title: Plain title', "owner: 'TJ'", 'quote: "say \\"hi\\""', 'empty:', 'tag: x # keep me', 'list:', '  - a', 'last: z'].join('\n')

describe('editFrontmatterField (§12.12 A)', () => {
  it('plain stays plain; single re-emits single (doubling quotes); double re-emits double (escaping \\ and ")', () => {
    const a = editFrontmatterField(Y, 'title', 'New title')
    oneLineChanged(Y, a)
    expect(a).toContain('\ntitle: New title\n')
    const b = editFrontmatterField(Y, 'owner', "TJ's")
    oneLineChanged(Y, b)
    expect(b).toContain("\nowner: 'TJ''s'\n")
    const c = editFrontmatterField(Y, 'quote', 'a "b" \\ c')
    oneLineChanged(Y, c)
    expect(c).toContain('\nquote: "a \\"b\\" \\\\ c"\n')
    expect(scanFrontmatter(c).fields.find((f) => f.key === 'quote')!.value).toBe('a "b" \\ c')
  })

  it('empty gets a plain value (or a quoted one under the same rule); a trailing comment stays after the new value', () => {
    const a = editFrontmatterField(Y, 'empty', 'filled')
    oneLineChanged(Y, a)
    expect(a).toContain('\nempty: filled\n')
    expect(editFrontmatterField(Y, 'empty', 'true')).toContain('\nempty: "true"\n')
    const b = editFrontmatterField(Y, 'tag', 'y')
    oneLineChanged(Y, b)
    expect(b).toContain('\ntag: y # keep me\n')
    expect(scanFrontmatter(b).fields.find((f) => f.key === 'tag')).toMatchObject({ value: 'y', comment: ' # keep me' })
  })

  it('the quoting rule table: plain becomes double only when it must', () => {
    const cases: Array<[string, string, boolean]> = [
      ['', 'x', true], [' lead', 'x', true], ['trail ', 'x', true],
      ...'-?:,[]{}#&*!|>\'"%@`'.split('').map((ch): [string, string, boolean] => [`${ch}start`, 'x', true]),
      ['a: b', 'x', true], ['a #b', 'x', true], ['ends:', 'x', true],
      ['true', 'x', true], ['False', 'x', true], ['null', 'x', true], ['~', 'x', true], ['yes', 'x', true], ['no', 'x', true],
      ['42', 'x', true], ['-1.5', 'x', true], ['1e3', 'x', true],
      ['true', 'false', false], ['43', '42', false], ['no', '7', false],
      ['draft only · needs legal review', 'x', false], ['http://x.com/a:b', 'x', false], ["it's", 'x', false],
      ['a#b', 'x', false], ['2026-10-15', 'x', false],
    ]
    for (const [v, old, q] of cases) expect([v, old, needsQuoting(v, old)]).toEqual([v, old, q])
    expect(editFrontmatterField('n: 42', 'n', '43')).toBe('n: 43')
    expect(editFrontmatterField('n: text', 'n', '43')).toBe('n: "43"')
    expect(editFrontmatterField('n: text', 'n', '')).toBe('n: ""')
  })

  it('keeps the spacing after the colon and every other byte (CRLF included)', () => {
    const crlf = 'a:   spaced\r\nb: two # c\r\nc: 3'
    const x = editFrontmatterField(crlf, 'a', 'v')
    expect(x).toBe('a:   v\r\nb: two # c\r\nc: 3')
    const y = editFrontmatterField(crlf, 'c', '4')
    expect(y).toBe('a:   spaced\r\nb: two # c\r\nc: 4')
  })

  it('refuses multiline fields, duplicates beyond the first and unknown keys', () => {
    expect(() => editFrontmatterField(Y, 'list', 'x')).toThrow(FrontmatterEditError)
    expect(() => editFrontmatterField(Y, 'nope', 'x')).toThrow(/no field/)
    const dup = 'k: 1\nk: 2'
    expect(editFrontmatterField(dup, 'k', '9')).toBe('k: 9\nk: 2')
  })
})

describe('addFrontmatterField / removeFrontmatterField', () => {
  it('add inserts one line before the closing fence in the frontmatter EOL; keys must be new and valid', () => {
    const a = addFrontmatterField(Y, 'added', 'value here')
    expect(diff(Y, a)).toEqual({ changed: 0, inserted: 1, deleted: 0 })
    expect(a.endsWith('\nlast: z\nadded: value here')).toBe(true)
    expect(addFrontmatterField('a: 1\r\nb: 2', 'c', 'x')).toBe('a: 1\r\nb: 2\r\nc: x')
    expect(addFrontmatterField('a: 1', 'c', 'x', { eol: '\r\n' })).toBe('a: 1\r\nc: x')
    expect(addFrontmatterField('', 'c', 'true')).toBe('c: "true"')
    expect(addFrontmatterField('a: 1', 'c', '')).toBe('a: 1\nc:')
    expect(() => addFrontmatterField(Y, 'title', 'x')).toThrow(/already exists/)
    expect(() => addFrontmatterField(Y, 'bad:key', 'x')).toThrow(/valid key/)
    expect(() => addFrontmatterField(Y, ' lead', 'x')).toThrow(/valid key/)
  })

  it('remove deletes exactly that line (the last line takes the line break before it)', () => {
    const a = removeFrontmatterField(Y, 'owner')
    expect(diff(Y, a)).toEqual({ changed: 0, inserted: 0, deleted: 1 })
    expect(a).not.toContain('owner')
    expect(removeFrontmatterField(Y, 'last').endsWith('  - a')).toBe(true)
    expect(removeFrontmatterField('a: 1\r\nb: 2', 'b')).toBe('a: 1')
    expect(removeFrontmatterField('only: 1', 'only')).toBe('')
    expect(() => removeFrontmatterField(Y, 'list')).toThrow(/multi-line/)
  })
})

describe('over the fixtures and the corpus YAML headers', () => {
  it('syn__frontmatter-complex.md: a plain and a quoted field edit each change one line; add and remove one line', () => {
    const y = yamlOf(fixtureText('syn__frontmatter-complex.md'))!
    oneLineChanged(y, editFrontmatterField(y, 'owner', 'Jordan'))
    const t = editFrontmatterField(y, 'title', 'New: title')
    oneLineChanged(y, t)
    expect(t).toContain('title: "New: title"')
    oneLineChanged(y, editFrontmatterField(y, 'status', 'draft only'))
    expect(diff(y, addFrontmatterField(y, 'lane', 'PS'))).toEqual({ changed: 0, inserted: 1, deleted: 0 })
    expect(diff(y, removeFrontmatterField(y, 'empty'))).toEqual({ changed: 0, inserted: 0, deleted: 1 })
  })

  it('every editable field of every corpus YAML header: same value round-trips byte-identical, a new value is a one-line diff', () => {
    let headers = 0
    let edited = 0
    for (const f of corpusFiles().files) {
      const y = yamlOf(f.text)
      if (y === null) continue
      headers++
      const s = scanFrontmatter(y)
      for (const fld of s.fields.filter((x) => x.editable)) {
        const src = s.lines[fld.line]!
        if (fld.kind !== 'double' || !src.includes('\\')) {
          expect(editFrontmatterField(y, fld.key, fld.value), `${f.name} ${fld.key}`).toBe(y)
        }
        const next = editFrontmatterField(y, fld.key, `${fld.value} edited`)
        oneLineChanged(y, next)
        expect(scanFrontmatter(next).fields.find((x) => x.key === fld.key)!.value, `${f.name} ${fld.key}`).toBe(`${fld.value} edited`)
        edited++
      }
    }
    expect(headers).toBeGreaterThan(0)
    expect(edited).toBeGreaterThan(0)
  })
})
