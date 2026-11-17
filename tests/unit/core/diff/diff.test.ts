// tests/unit/core/diff/diff.test.ts (P1; CONTRACTS §7.1 BlockSide text, D33; §10 DiffBlock.inline; §9.6 'diff').
import { describe, expect, it } from 'vitest'
import { blockChanges, blockSide, sideText, unifiedDiff, wordDiff, type DocSide } from '../../../../core/diff'
import { blockHash } from '../../../../core/hash'
import { CONSTANTS } from '../../../../shared/types'

const { CHANGE_MD_CAP, CHANGE_MD_CONTEXT } = CONSTANTS

/** A DocSide from block texts joined by blank lines. */
function side(blocks: string[]): DocSide {
  let src = ''
  const out: DocSide['blocks'][number][] = []
  blocks.forEach((b, i) => {
    if (i) src += '\n\n'
    out.push({ hash: blockHash(b), start: src.length, end: src.length + b.length })
    src += b
  })
  return { src: src + '\n', blocks: out }
}

describe('BlockSide windowing (D33)', () => {
  it('a run within the cap is stored whole, without a window', () => {
    expect(sideText('short block', 'other')).toEqual({ md: 'short block' })
  })

  it('an edit at char 5,000 of a 6,000-char block lands inside md (never a bare prefix)', () => {
    const before = 'a'.repeat(5_000) + 'OLD' + 'b'.repeat(997)
    const after = 'a'.repeat(5_000) + 'NEW' + 'b'.repeat(997)
    const [c] = blockChanges(side(['Intro.', before, 'Outro.']), side(['Intro.', after, 'Outro.']))
    expect(c!.op).toBe('replace')
    for (const [s, word] of [[c!.before!, 'OLD'], [c!.after!, 'NEW']] as const) {
      expect(s.md).toContain(word)
      expect(s.window).toEqual({ offset: 5_000 - CHANGE_MD_CONTEXT, total: 6_000 })
      expect(s.md.length).toBe(3 + 2 * CHANGE_MD_CONTEXT)
      expect(s.truncated).toBeUndefined()
      expect(s.hashes).toEqual([blockHash(word === 'OLD' ? before : after)])
    }
  })

  it('a changed middle over the cap is cut to its first CHANGE_MD_CAP chars and marked truncated', () => {
    const a = 'x'.repeat(10) + 'A'.repeat(5_000) + 'y'.repeat(10)
    const b = 'x'.repeat(10) + 'B'.repeat(5_000) + 'y'.repeat(10)
    expect(sideText(a, b)).toEqual({ md: 'A'.repeat(CHANGE_MD_CAP), window: { offset: 10, total: a.length }, truncated: true })
  })

  it('inserts and deletes over the cap store the first CHANGE_MD_CAP chars from offset 0', () => {
    const big = 'z'.repeat(CHANGE_MD_CAP + 10)
    const [ins] = blockChanges(side(['A.']), side(['A.', big]))
    expect(ins).toMatchObject({ op: 'insert', before: null })
    expect(ins!.after).toMatchObject({ md: big.slice(0, CHANGE_MD_CAP), window: { offset: 0, total: big.length }, truncated: true, index: 1, count: 1 })
    const [del] = blockChanges(side(['A.', big]), side(['A.']))
    expect(del).toMatchObject({ op: 'delete', after: null })
    expect(del!.before!.truncated).toBe(true)
  })

  it('blockSide carries source offsets of the run at its own rev', () => {
    const s = side(['One.', 'Two.', 'Three.'])
    expect(blockSide(s, 1, 2, null)).toMatchObject({ index: 1, count: 2, start: 6, end: 18, md: 'Two.\n\nThree.' })
    expect(blockSide(s, 3, 0, null)).toMatchObject({ start: s.src.length, end: s.src.length, md: '' })
  })
})

describe('text diffs', () => {
  it('wordDiff splits on whitespace runs and round-trips both sides', () => {
    const d = wordDiff('the quick brown fox', 'the slow brown fox')
    expect(d.filter(([op]) => op !== 1).map(([, t]) => t).join('')).toBe('the quick brown fox')
    expect(d.filter(([op]) => op !== -1).map(([, t]) => t).join('')).toBe('the slow brown fox')
    expect(d).toContainEqual([-1, 'quick'])
    expect(d).toContainEqual([1, 'slow'])
  })

  it('unifiedDiff: hunks with context, empty when equal, the no-final-newline marker', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('')
    const u = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 1)
    expect(u).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')
    expect(unifiedDiff('x', 'y')).toContain('\\ No newline at end of file')
  })
})
