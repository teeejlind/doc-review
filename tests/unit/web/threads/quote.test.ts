// tests/unit/web/threads/quote.test.ts (P3; CONTRACTS §5.2 long-anchor display, §13 row 90).
import { describe, expect, it } from 'vitest'
import { CONSTANTS } from '../../../../shared/constants'
import type { BlockAnchor, TextAnchor } from '../../../../shared/types'
import { quoteDisplay } from '../../../../web/src/threads/quote'

const text = (quote: string, extra: Partial<TextAnchor> = {}): TextAnchor => ({
  kind: 'text', quote, prefix: '', suffix: '', hint: { rev: 1, pos: 0, block: 0, blockHash: '0'.repeat(16), offsetInBlock: 0 }, ...extra,
})

describe('quoteDisplay', () => {
  it('shows a short quote as-is, whitespace collapsed', () => {
    expect(quoteDisplay(text('one  word\nacross\n\nblocks'))).toBe('one word across blocks')
  })

  it('a long anchor always shows head … tail, never just the head (row 90)', () => {
    const e = CONSTANTS.LONG_QUOTE_EDGE_CHARS
    const headText = 'Alpha ' + 'lorem ipsum '.repeat(Math.ceil(e / 12))
    const tailText = 'dolor sit amet '.repeat(Math.ceil(e / 15)) + 'Omega.'
    const a = text(headText.slice(0, e), { tail: tailText.slice(tailText.length - e), span: 12_345 })
    const shown = quoteDisplay(a)
    expect(shown.startsWith('Alpha')).toBe(true)
    expect(shown.endsWith('Omega.')).toBe(true)
    expect(shown).toContain(' … ')
    expect(shown.length).toBeLessThanOrEqual(170)
  })

  it('squeezes an over-long ordinary quote around a middle ellipsis', () => {
    const q = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    const shown = quoteDisplay(text(q), 60)
    expect(shown.startsWith('w0 w1')).toBe(true)
    expect(shown.endsWith('w79')).toBe(true)
    expect(shown).toContain(' … ')
    expect(shown.length).toBeLessThanOrEqual(64)
  })

  it('block anchors show their preview; doc anchors show nothing', () => {
    const b: BlockAnchor = { kind: 'block', preview: '---\ntitle: x\n---', hint: { rev: 1, block: 0, blockHash: '0'.repeat(16), kind: 'frontmatter', mdType: 'yaml' } }
    expect(quoteDisplay(b)).toBe('--- title: x ---')
    expect(quoteDisplay({ kind: 'doc' })).toBe('')
  })
})
