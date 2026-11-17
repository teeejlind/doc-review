// tests/unit/core/md/qa3-serialize.test.ts (QA round 3, editor fixer). What the serializer writes for text people type:
// addresses unescaped (and links whose text is their own address written bare), no `&#x20;` / `&#x9;` for leading
// whitespace, no `<br />` for an empty quote line. Every case also reads back as the same document.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { autolinkRuns } from '../../../../core/md/autolink'
import { nodeEq } from '../../../../core/splice/eq'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const out = (nodes: readonly PMNode[]): string => md.serializeNodes(nodes)
const para = (...inline: PMNode[]): PMNode => md.schema.nodes.paragraph!.create(null, inline)
const text = (s: string): PMNode => md.schema.text(s)
const link = (s: string, href: string): PMNode => md.schema.text(s, [md.schema.marks.link!.create({ href, title: null })])
const roundTrips = (src: string): void => {
  const doc = md.parseDoc(src)
  const again = md.parseDoc(out([...doc.content.content]))
  expect(again.childCount).toBe(doc.childCount)
  doc.forEach((n, _o, i) => expect(nodeEq(n, again.child(i))).toBe(true))
}

describe('addresses typed or pasted as text are written as they are (QA3)', () => {
  it('URLs, emails and www. addresses lose their backslashes', () => {
    expect(out([para(text('typed https://example.com/path_with_under?x=1&y=2 here and more.'))])).toBe('typed https://example.com/path_with_under?x=1&y=2 here and more.\n')
    expect(out([para(text('mail me at someone@example.com now'))])).toBe('mail me at someone@example.com now\n')
    expect(out([para(text('see www.example.com/deals today'))])).toBe('see www.example.com/deals today\n')
    expect(out([para(text('https://example.com/only-url'))])).toBe('https://example.com/only-url\n')
    expect(out([para(text('Visit https://example.com.'))])).toBe('Visit https://example.com.\n')
    expect(out([para(text('(see https://example.com/x)'))])).toBe('(see https://example.com/x)\n')
  })

  it('they read back as links (like Google Docs autolinks them)', () => {
    const doc = md.parseDoc(out([para(text('mail someone@example.com or see https://example.com/a_b.'))]))
    const hrefs: string[] = []
    doc.descendants((n) => {
      for (const m of n.marks) if (m.type.name === 'link') hrefs.push(String(m.attrs.href))
      return true
    })
    expect(hrefs).toEqual(['mailto:someone@example.com', 'https://example.com/a_b'])
  })

  it('an address GFM would not read as that link keeps its escapes', () => {
    expect(out([para(text('foohttps://example.com'))])).toContain('\\:')
    expect(out([para(text('x@y'))])).toBe('x\\@y\n')
  })

  it('a link whose text is its own address is written bare; elsewhere as <...>', () => {
    expect(out([para(text('see '), link('https://example.com/a_b?x=1&y=2', 'https://example.com/a_b?x=1&y=2'), text(' now'))])).toBe('see https://example.com/a_b?x=1&y=2 now\n')
    expect(out([para(text('mail '), link('tj@example.com', 'mailto:tj@example.com'), text(' now'))])).toBe('mail tj@example.com now\n')
    expect(out([para(text('see '), link('www.example.com', 'http://www.example.com'), text(' now'))])).toBe('see www.example.com now\n')
    // glued to a letter, a bare form would read as a different link
    expect(out([para(link('https://example.com', 'https://example.com'), text('x'))])).toBe('<https://example.com>x\n')
    expect(out([para(text('see '), link('the primer', 'https://example.com/primer'))])).toBe('see [the primer](https://example.com/primer)\n')
  })

  it('round trips: every sample reads back as the document it came from', () => {
    for (const src of [
      'see https://example.com/a_b?x=1&y=2 and tj@example.com and www.example.com/deals now\n',
      'Visit https://example.com. Or (https://example.com/x) or https://a.com/x), then.\n',
      '**https://example.com** and _www.example.com_\n',
      '# Head https://example.com\n',
      '- item https://example.com/a\n- b@c.com\n',
      '| a | b |\n| - | - |\n| https://example.com | x@y.com |\n',
      '[see https://example.com](https://b.com) and <https://example.com>x\n',
      'Line one https://example.com\\\nhttps://example.com/two\n',
      'a https://example.com/q?a=1&amp; b\n',
    ]) roundTrips(src)
  })

  it('autolinkRuns finds exactly the runs GFM links', () => {
    expect(autolinkRuns('see https://a.com/x, then', '', '').map((r) => [r.start, r.end, r.kind])).toEqual([[4, 19, 'url']])
    expect(autolinkRuns('https://a.com', '', 'b')).toEqual([])
    expect(autolinkRuns('x https://a.com', '', ' ').length).toBe(1)
    expect(autolinkRuns('a_b@c.com', '', '').length).toBe(1)
    expect(autolinkRuns('x_a@c.com', 'y', '')).toEqual([])
  })
})

describe('leading whitespace and empty quote lines (QA3)', () => {
  it('spaces or a tab typed at the start of a block are dropped, never written as entities', () => {
    expect(out([para(text('  The notes carry a member.'))])).toBe('The notes carry a member.\n')
    expect(out([para(text('\ttab leading'))])).toBe('tab leading\n')
    expect(out([para(text('    four leading spaces'))])).toBe('four leading spaces\n')
    expect(out([md.schema.nodes.heading!.create({ level: 2 }, text('  Title'))])).not.toContain('&#x')
  })

  it('spaces inside a line are kept', () => {
    expect(out([para(text('a  b'))])).toBe('a  b\n')
  })

  it('an empty line inside a quote is a bare ">" line, not "<br />"', () => {
    const bq = md.schema.nodes.blockquote!.create(null, [para(), para(text('A short quote for context here.'))])
    expect(out([bq])).toBe('>\n>\n> A short quote for context here.\n')
    const mid = md.schema.nodes.blockquote!.create(null, [para(text('a')), para(), para(text('b'))])
    expect(out([mid])).not.toContain('<br')
  })
})
