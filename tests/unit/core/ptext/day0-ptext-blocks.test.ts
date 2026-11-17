// tests/unit/core/ptext/day0-ptext-blocks.test.ts (integrator, day 0; P1 owns it from M0).
//
// The day-0 ptext (§5.1), block map and block diff (§3.3), and the anchor stubs (§5.2, §5.3 exact steps).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAnchor, createBlockAnchor, resolveAnchor } from '../../../../core/anchors'
import { blockMap, diffBlocks, isAtomBlock } from '../../../../core/blocks'
import { blockHash, docHash } from '../../../../core/hash'
import { createMd, type Md } from '../../../../core/md/index'
import { OBJ, ptextOf } from '../../../../core/ptext'
import { load } from '../../../../core/splice/load'
import { CONSTANTS } from '../../../../shared/constants'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const DOC = '---\ntitle: T\n---\n\n# Head\n\nLine one  \nline two with ![img](a.png).\n\n- item **bold**\n- second\n\n---\n\n| a | b |\n|---|---|\n| c | d |\n'

describe('ptextOf (day 0, §5.1)', () => {
  it('joins textblocks and atom blocks with \\n, hardbreak → \\n, inline leaves → U+FFFC', () => {
    const L = load(md, DOC)
    const p = ptextOf(L.doc, L)
    expect(p.text).toBe([OBJ, 'Head', `Line one\nline two with ${OBJ}.`, 'item bold', 'second', OBJ, 'a', 'b', 'c', 'd'].join('\n'))
    expect(p.blockRanges.map((r) => r.index)).toEqual(L.entries.map((_, i) => i))
  })

  it('maps offsets to positions and back inside text', () => {
    const L = load(md, DOC)
    const p = ptextOf(L.doc, L)
    const off = p.text.indexOf('Head') + 2
    const pos = p.toPos(off, 1)
    expect(L.doc.textBetween(pos, pos + 2)).toBe('ad')
    expect(p.toOffset(pos)).toBe(off)
    const b = p.blockAt(off)
    expect(b.index).toBe(1)
    expect(b.offsetInBlock).toBe(2)
  })

  it('skips an empty doc entirely', () => {
    const L = load(md, '')
    expect(ptextOf(L.doc, L).text).toBe('')
  })
})

describe('blockMap / diffBlocks / hashes (day 0)', () => {
  it('builds 1:1 BlockInfo with hashes over the source slice and inclusive lines', () => {
    const L = load(md, DOC)
    const blocks = blockMap(md, L)
    expect(blocks).toHaveLength(L.entries.length)
    expect(blocks[0]!.kind).toBe('frontmatter')
    expect(isAtomBlock(blocks[0]!)).toBe(true)
    expect(blocks[0]!.line).toBe(1)
    expect(blocks[0]!.endLine).toBe(3)
    expect(blocks[1]!.ref).toBe('b2')
    expect(blocks[1]!.hash).toBe(blockHash('# Head'))
    expect(blocks[1]!.preview).toBe('Head')
    expect(blocks.find((b) => b.mdType === 'thematicBreak')!.preview).toBe('---')
  })

  it('docHash includes the BOM bytes', () => {
    expect(docHash('a', true)).not.toBe(docHash('a', false))
    expect(docHash('', false)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('diffBlocks: prefix, suffix, LCS; unmatched runs pair up as replace', () => {
    const h = (s: string) => s.split('').map((hash) => ({ hash }))
    expect(diffBlocks(h('abc'), h('abc'))).toEqual([{ op: 'equal', a: 0, b: 0, n: 3 }])
    expect(diffBlocks(h('abc'), h('aXc'))).toEqual([
      { op: 'equal', a: 0, b: 0, n: 1 }, { op: 'replace', a: 1, an: 1, b: 1, bn: 1 }, { op: 'equal', a: 2, b: 2, n: 1 },
    ])
    expect(diffBlocks(h('abc'), h('aXYc'))[1]).toEqual({ op: 'replace', a: 1, an: 1, b: 1, bn: 2 })
    expect(diffBlocks(h('ac'), h('abc'))[1]).toEqual({ op: 'insert', a: 1, an: 0, b: 1, bn: 1 })
    expect(diffBlocks(h('abc'), h('ac'))[1]).toEqual({ op: 'delete', a: 1, an: 1, b: 1, bn: 0 })
    expect(diffBlocks(h(''), h('ab'))).toEqual([{ op: 'insert', a: 0, an: 0, b: 0, bn: 2 }])
  })
})

describe('anchors (day 0)', () => {
  const SRC = 'Intro paragraph.\n\nThe member rate is high. The member rate is fixed.\n\nOutro.\n'

  it('createAnchor gives the §5.2 shape and resolves exact at its hint', () => {
    const L = load(md, SRC)
    const p = ptextOf(L.doc, L)
    const from = p.text.indexOf('member rate')
    const a = createAnchor(p, L.blocks, from, from + 'member rate'.length, 3)
    expect(Object.keys(a)).toEqual(['kind', 'quote', 'prefix', 'suffix', 'hint'])
    expect(a.quote).toBe('member rate')
    expect(a.hint).toEqual({ rev: 3, pos: from, block: 1, blockHash: L.blocks[1]!.hash, offsetInBlock: 4 })
    expect(resolveAnchor(p, L.blocks, a)).toEqual({ state: 'exact', from, to: from + 11, block: 1 })
  })

  it('a duplicate quote follows its block when the block moves (§5.3 step 1 is relative to the hinted block)', () => {
    const L = load(md, SRC)
    const p = ptextOf(L.doc, L)
    const second = p.text.lastIndexOf('member rate')
    const a = createAnchor(p, L.blocks, second, second + 11, 1)
    const L2 = load(md, 'New first paragraph.\n\n' + SRC)
    const p2 = ptextOf(L2.doc, L2)
    const r = resolveAnchor(p2, L2.blocks, a)
    expect(r.state).toBe('exact')
    expect(r.block).toBe(2)
    expect(r.from).toBe(p2.text.lastIndexOf('member rate'))
    expect(r.ambiguous).toBeUndefined()
  })

  it('detaches a deleted quote; doc anchors are doc; block anchors follow their hash', () => {
    const L = load(md, SRC)
    const p = ptextOf(L.doc, L)
    const a = createAnchor(p, L.blocks, 0, 5, 1)
    const L2 = load(md, 'Something else.\n')
    expect(resolveAnchor(ptextOf(L2.doc, L2), L2.blocks, a)).toEqual({ state: 'detached' })
    expect(resolveAnchor(p, L.blocks, { kind: 'doc' })).toEqual({ state: 'doc' })
    const ba = createBlockAnchor(L.blocks, 2, 1)
    const L3 = load(md, 'Inserted.\n\n' + SRC)
    expect(resolveAnchor(ptextOf(L3.doc, L3), L3.blocks, ba)).toEqual({ state: 'moved', block: 3 })
  })

  it('long spans get the head / tail / span form and resolve whole', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ')
    const L = load(md, `Start.\n\n${body}\n`)
    const p = ptextOf(L.doc, L)
    const from = p.text.indexOf('word0')
    const to = from + body.length
    const a = createAnchor(p, L.blocks, from, to, 1)
    expect(a.span).toBe(body.length)
    expect(a.quote).toHaveLength(CONSTANTS.LONG_QUOTE_EDGE_CHARS)
    expect(a.tail).toHaveLength(CONSTANTS.LONG_QUOTE_EDGE_CHARS)
    expect(resolveAnchor(p, L.blocks, a)).toMatchObject({ state: 'exact', from, to })
  })
})
