// tests/unit/core/blocks/blocks.test.ts (P1; CONTRACTS §3.3 block map, the atom definition, diffBlocks).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blockMap, diffBlocks, isAtomBlock } from '../../../../core/blocks'
import { lineAt, lineStarts } from '../../../../core/eol'
import { blockHash } from '../../../../core/hash'
import { createMd, type Md } from '../../../../core/md/index'
import { ptextOf } from '../../../../core/ptext'
import { load } from '../../../../core/splice/load'
import { BlockInfoSchema } from '../../../../shared/schemas'
import { FIXTURE_DOCS } from '../splice/fixtures'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

describe('blockMap is 1:1 with entries (§3.3)', () => {
  it('every fixture: index, ref, offsets, lines, hash, ptext range, preview and schema', () => {
    for (const [name, src] of Object.entries(FIXTURE_DOCS)) {
      const L = load(md, src)
      const blocks = blockMap(md, L)
      expect(blocks, name).toEqual(L.blocks)
      expect(blocks.length, name).toBe(L.entries.length)
      const starts = lineStarts(src)
      const p = ptextOf(L.doc, L)
      blocks.forEach((b, i) => {
        const e = L.entries[i]!
        const slice = src.slice(e.start, e.end)
        expect(b).toMatchObject({ index: i, ref: `b${i + 1}`, kind: e.kind, mdType: e.mdType, start: e.start, end: e.end, fidelity: e.fidelity })
        expect(b.hash).toBe(blockHash(slice))
        expect(b.line).toBe(lineAt(starts, e.start))
        expect(b.endLine).toBe(lineAt(starts, Math.max(e.start, e.end - 1)))
        expect(b.preview).toBe((isAtomBlock(b) ? slice : p.text.slice(b.pStart, b.pEnd)).slice(0, 80))
        expect(BlockInfoSchema.safeParse(b).success, `${name} ${i}`).toBe(true)
      })
    }
  })

  it('the atom definition (D44): raw, frontmatter and thematicBreak entries, nothing else', () => {
    const L = load(md, '---\nk: v\n---\n\nPara with <span>inline</span>.\n\n***\n\n<div>\nblock\n</div>\n\n[d]: https://x.example\n')
    expect(L.blocks.map((b) => [b.kind, b.mdType, isAtomBlock(b)])).toEqual([
      ['frontmatter', 'yaml', true],
      ['md', 'paragraph', false],
      ['md', 'thematicBreak', true],
      ['raw', 'html', true],
      ['raw', 'gap', true],
    ])
  })

  it('previews are capped at 80 characters', () => {
    const long = 'word '.repeat(40).trim()
    const L = load(md, `${long}\n`)
    expect(L.blocks[0]!.preview).toBe(long.slice(0, 80))
  })
})

describe('diffBlocks (§3.3)', () => {
  const h = (s: string) => s.split('').filter(Boolean).map((hash) => ({ hash }))

  it('prefix, suffix and LCS; unmatched runs pair up as replace, the remainder insert / delete', () => {
    expect(diffBlocks(h('abcde'), h('abXde'))).toEqual([
      { op: 'equal', a: 0, b: 0, n: 2 }, { op: 'replace', a: 2, an: 1, b: 2, bn: 1 }, { op: 'equal', a: 3, b: 3, n: 2 },
    ])
    expect(diffBlocks(h('abc'), h(''))).toEqual([{ op: 'delete', a: 0, an: 3, b: 0, bn: 0 }])
    expect(diffBlocks(h(''), h(''))).toEqual([])
    // a move is a delete plus an insert around the LCS
    expect(diffBlocks(h('abcd'), h('acdb'))).toEqual([
      { op: 'equal', a: 0, b: 0, n: 1 }, { op: 'delete', a: 1, an: 1, b: 1, bn: 0 }, { op: 'equal', a: 2, b: 1, n: 2 }, { op: 'insert', a: 4, an: 0, b: 3, bn: 1 },
    ])
  })

  it('cross-revision identity is by hash: duplicate blocks align in order', () => {
    expect(diffBlocks(h('aXa'), h('aXaa'))).toEqual([{ op: 'equal', a: 0, b: 0, n: 3 }, { op: 'insert', a: 3, an: 0, b: 3, bn: 1 }])
  })

  it('real block maps: an edit in one block is one replace of that block', () => {
    const src = '# T\n\nOne.\n\nTwo.\n\nThree.\n'
    const a = load(md, src).blocks
    const b = load(md, src.replace('Two.', 'Two, edited.')).blocks
    expect(diffBlocks(a, b)).toEqual([{ op: 'equal', a: 0, b: 0, n: 2 }, { op: 'replace', a: 2, an: 1, b: 2, bn: 1 }, { op: 'equal', a: 3, b: 3, n: 1 }])
  })
})
