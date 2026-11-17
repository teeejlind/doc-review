// tests/unit/core/splice/ladder.test.ts (P1; CONTRACTS §3.4 widening ladder and gate G7, D37, D51, FINDINGS caveat 1).
//
// applyBlockOps never returns wrong text and never refuses before the ladder: an op that fails verification is
// re-rendered in full (level 1), then widened by one (2) and two (3) untouched neighbours re-rendered from their nodes.
// Covered here: a natural failure at each level, each level forced by a patched renderer, an op that fails every level
// landing in `failed` alone, the fault hook, and the invariant that `verified: true` never comes with wrong text.
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { applyBlockOps, setSpliceFaultForTests, setSpliceRenderHookForTests } from '../../../../core/splice/apply'
import { contentNodes, nodeEq } from '../../../../core/splice/eq'
import { load, loadRun } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import type { BlockOp } from '../../../../shared/types'
import { CONSTANTS } from '../../../../shared/types'
import { sweepEdits } from '../../../corpus/harness'
import { FIXTURE_DOCS } from './fixtures'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})
afterEach(() => {
  setSpliceFaultForTests(null)
  setSpliceRenderHookForTests(null)
})

const content = (text: string) => contentNodes(load(md, text).doc)
const sameNodes = (a: ReturnType<typeof content>, b: ReturnType<typeof content>): boolean => a.length === b.length && a.every((n, i) => nodeEq(n, b[i]!))

describe('natural failures climb the ladder (D37)', () => {
  it('level 1: an inserted block with an unclosed fence would swallow its neighbour; a full re-render closes it', () => {
    const L = load(md, 'Before.\n\nAfter.\n')
    const r = applyBlockOps(md, L, [{ after: 0, before: 1, covers: [], blocks: ['```js\ncode'] }])
    expect(r.widened).toEqual([{ op: 0, level: 1 }])
    expect(r.failed).toEqual([])
    expect(r.verified).toBe(true)
    expect(r.text).toBe('Before.\n\n```js\ncode\n```\n\nAfter.\n')
    expect(content(r.text).map((n) => n.type.name)).toEqual(['paragraph', 'code_block', 'paragraph'])
  })

  it('level 2: deleting a link definition re-renders the paragraph that used it (±1)', () => {
    const src = 'See [the site][site].\n\n[site]: https://example.com\n\nEnd.\n'
    const L = load(md, src)
    expect(L.entries[1]!.mdType).toBe('gap')
    const r = applyBlockOps(md, L, [{ after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: [] }])
    expect(r.widened).toEqual([{ op: 0, level: 2 }])
    expect(r.verified).toBe(true)
    expect(r.text).toBe('See [the site](https://example.com).\n\nEnd.\n')
    // the link survived: content equals the original paragraph plus End.
    expect(sameNodes(content(r.text), [L.entries[0]!.nodes[0]!, L.entries[2]!.nodes[0]!])).toBe(true)
  })

  it('level 3: the paragraph using the definition is two blocks away (±2)', () => {
    const src = 'See [x][r].\n\nMiddle.\n\n[r]: http://u.example\n\nEnd.\n'
    const L = load(md, src)
    expect(L.entries[2]!.mdType).toBe('gap')
    const r = applyBlockOps(md, L, [{ after: 1, before: 3, covers: [L.blocks[2]!.hash], blocks: [] }])
    expect(r.widened).toEqual([{ op: 0, level: 3 }])
    expect(r.verified).toBe(true)
    expect(r.text).toBe('See [x](http://u.example).\n\nMiddle.\n\nEnd.\n')
  })

  it('beyond ±2 the op fails, the text stays valid without it, and an innocent op elsewhere still lands', () => {
    const src = 'See [x][r].\n\nOne.\n\nTwo.\n\nThree.\n\n[r]: http://u.example\n\nEnd.\n\nTail.\n'
    const L = load(md, src)
    const gap = L.blocks.findIndex((b) => b.mdType === 'gap')
    expect(gap).toBe(4)
    const alone = applyBlockOps(md, L, [{ after: 3, before: 5, covers: [L.blocks[4]!.hash], blocks: [] }])
    expect(alone).toEqual({ text: src, verified: false, widened: [], failed: [0], flips: [] })
    // the definition delete has no owner for the paragraph it breaks; the edit to "Tail." must not be blamed with it
    const ops: BlockOp[] = [
      { after: 3, before: 5, covers: [L.blocks[4]!.hash], blocks: [] },
      { after: 5, before: 7, covers: [L.blocks[6]!.hash], blocks: ['Tail, edited.'] },
    ]
    const r = applyBlockOps(md, L, ops)
    expect(r.failed).toEqual([0])
    expect(r.widened).toEqual([])
    expect(r.verified).toBe(false)
    expect(r.text).toBe(src.replace('Tail.', 'Tail, edited.'))
  })

  it('an adjacent op may legitimately absorb the fix by widening over the broken neighbour', () => {
    const src = 'See [x][r].\n\nOne.\n\nTwo.\n\n[r]: http://u.example\n\nEnd.\n'
    const L = load(md, src)
    const r = applyBlockOps(md, L, [
      { after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: ['One, edited.'] },
      { after: 2, before: 4, covers: [L.blocks[3]!.hash], blocks: [] },
    ])
    expect(r.failed).toEqual([])
    expect(r.verified).toBe(true)
    expect(r.text).toBe('See [x](http://u.example).\n\nOne, edited.\n\nTwo.\n\nEnd.\n')
    expect(r.widened.map((w) => w.op)).toEqual([0])
  })
})

describe('each ladder level forced by a patched renderer (G7)', () => {
  const SRC = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.\n\nFifth.\n'
  const corrupt = (text: string): string => `${text}\n\n\`\`\`\nswallow`
  const op = (L: ReturnType<typeof load>): BlockOp[] => [{ after: 1, before: 3, covers: [L.blocks[2]!.hash], blocks: ['Third, edited.'] }]

  for (const pass of [1, 2, 3] as const) {
    it(`corrupting every level below ${pass} passes at level ${pass}`, () => {
      const L = load(md, SRC)
      const seen: number[] = []
      setSpliceRenderHookForTests(({ level, text }) => {
        seen.push(level)
        return level < pass ? corrupt(text) : text
      })
      const r = applyBlockOps(md, L, op(L))
      expect(r.widened).toEqual([{ op: 0, level: pass }])
      expect(r.failed).toEqual([])
      expect(r.verified).toBe(true)
      expect(sameNodes(content(r.text), content(SRC.replace('Third paragraph.', 'Third, edited.')))).toBe(true)
      expect(new Set(seen)).toEqual(new Set(Array.from({ length: pass + 1 }, (_, i) => i)))
      // levels 2 and 3 really widened: the neighbours became part of the op (they passed through the renderer)
      if (pass >= 2) expect(seen.filter((l) => l === pass).length).toBe(1 + 2 * (pass - 1))
    })
  }

  it('an op that fails every level goes to failed; a second op still lands', () => {
    const L = load(md, SRC)
    const ops: BlockOp[] = [
      { after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: ['Second, edited.'] },
      { after: 3, before: 5, covers: [L.blocks[4]!.hash], blocks: ['Fifth, edited.'] },
    ]
    const levels: number[] = []
    setSpliceRenderHookForTests(({ op: i, level, text }) => {
      if (i === 0) levels.push(level)
      return i === 0 ? corrupt(text) : text
    })
    const r = applyBlockOps(md, L, ops)
    expect(r.failed).toEqual([0])
    expect(r.widened).toEqual([])
    expect(r.verified).toBe(false)
    expect(r.text).toBe(SRC.replace('Fifth.', 'Fifth, edited.'))
    expect(Math.max(...levels)).toBe(CONSTANTS.SPLICE_WIDEN_LEVELS)
  })

  it('every op failing returns the original text, still valid', () => {
    const L = load(md, SRC)
    setSpliceRenderHookForTests(({ text }) => corrupt(text))
    const r = applyBlockOps(md, L, op(L))
    expect(r).toEqual({ text: SRC, verified: false, widened: [], failed: [0], flips: [] })
  })
})

describe('setSpliceFaultForTests (G7, D51)', () => {
  it('sends exactly the matched ops to failed, at every level, and leaves them out of the text', () => {
    const src = 'A one.\n\nB two.\n\nC three.\n\nD four.\n\nE five.\n'
    const L = load(md, src)
    // in-place ops on blocks 0, 2 and 4 (ops may share a boundary block, never a covered one)
    const ops: BlockOp[] = [0, 2, 4].map((i) => ({ after: i - 1, before: i + 1, covers: [L.blocks[i]!.hash], blocks: [`X${i}.`] }))
    setSpliceFaultForTests((o) => o.blocks[0] === 'X2.')
    const r = applyBlockOps(md, L, ops)
    expect(r.failed).toEqual([1])
    expect(r.widened).toEqual([])
    expect(r.text).toBe('X0.\n\nB two.\n\nC three.\n\nD four.\n\nX4.\n')
    setSpliceFaultForTests(null)
    expect(applyBlockOps(md, L, ops)).toMatchObject({ failed: [], verified: true, text: 'X0.\n\nB two.\n\nX2.\n\nD four.\n\nX4.\n' })
  })
})

describe('verified never comes with wrong text (G7)', () => {
  it('under pseudo-random corruption, every applied op means what it asked for and failed ops are absent', () => {
    let seed = 7
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    let checked = 0
    for (const [name, src] of Object.entries(FIXTURE_DOCS)) {
      const L = load(md, src)
      const edits = sweepEdits(md, L, 3, 'replace-word')
      for (const e of edits) {
        const ops = planSave(md, L, e.doc)
        if (!ops.length) continue
        const clean = applyBlockOps(md, L, ops)
        setSpliceRenderHookForTests(({ text, level }) => (rand() < 0.5 - level * 0.12 ? `${text}\n\n\`\`\`\nX` : text))
        const r = applyBlockOps(md, L, ops)
        setSpliceRenderHookForTests(null)
        // the reloaded result equals the clean result restricted to the ops that did not fail
        const want = r.failed.length === 0 ? clean.text : applyBlockOps(md, L, ops.filter((_, i) => !r.failed.includes(i))).text
        expect(sameNodes(content(r.text), content(want)), `${name}`).toBe(true)
        expect(r.verified).toBe(r.failed.length === 0)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(30)
  })

  it('loadRun is the verification parse: a raw run verifies as raw', () => {
    const L = load(md, 'Intro.\n\n[d]: https://a.example\n\nOutro.\n')
    const gap = L.blocks.findIndex((b) => b.mdType === 'gap')
    const r = applyBlockOps(md, L, [{ after: gap - 1, before: gap + 1, covers: [L.blocks[gap]!.hash], blocks: ['[d]: https://b.example'] }])
    expect(r.verified).toBe(true)
    expect(r.widened).toEqual([])
    expect(loadRun(md, '[d]: https://b.example', L.defs, L.eol).map((n) => n.type.name)).toEqual(['raw_block'])
  })
})
