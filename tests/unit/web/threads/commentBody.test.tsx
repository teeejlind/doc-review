// tests/unit/web/threads/commentBody.test.tsx (QA round 1: confirmed 34). Comment text renders lightly: `code`, **bold**,
// [text](url), bare links and "- " bullet lines; anything else stays as typed.
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommentBody, parseInline } from '../../../../web/src/threads/commentBody'

describe('parseInline', () => {
  it('splits code, bold, markdown links and bare links; the rest is text', () => {
    expect(parseInline('a **b** `c` [d](https://x.com/y) https://z.com/q. end')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'd', href: 'https://x.com/y' },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'https://z.com/q', href: 'https://z.com/q' },
      { kind: 'text', text: '. end' },
    ])
  })

  it('refuses links that are not http(s) or mailto', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ kind: 'text', text: '[x](javascript:alert(1))' }])
  })

  it('unclosed syntax stays as typed', () => {
    expect(parseInline('2 ** 3 and `open')).toEqual([{ kind: 'text', text: '2 ** 3 and `open' }])
  })
})

describe('CommentBody', () => {
  it('renders links as safe anchors, code as <code>, bold as <strong>, bullets as lines', () => {
    const { container } = render(<CommentBody text={'**Check this**: the `member rate` matters.\n\n- one\n- two\n\nSee [the doc](https://example.com/very/long/url)'} />)
    expect(container.querySelector('strong')!.textContent).toBe('Check this')
    expect(container.querySelector('code')!.textContent).toBe('member rate')
    const a = container.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://example.com/very/long/url')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(Array.from(container.querySelectorAll('.mdr-body-line--bullet')).map((e) => e.textContent)).toEqual(['one', 'two'])
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toContain('](')
  })

  it('plain text is unchanged', () => {
    const { container } = render(<CommentBody text="Is 12% still current?" />)
    expect(container.textContent).toBe('Is 12% still current?')
    expect(container.querySelector('a, strong, code')).toBeNull()
  })
})
