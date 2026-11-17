// tests/unit/core/merge/merge.test.ts (P1). Block-level 3-way merge (CONTRACTS §7.3, R4.4): the fast path, the
// adjacent-block no-conflict case (row 10), a same-block conflict, an identical change dropped, insertion placement,
// and runs whose untouched separator the other side deleted (folded into one op so applyBlockOps accepts them).
import { beforeAll, describe, expect, it } from 'vitest'
import { merge3way } from '../../../../core/merge'
import { applyBlockOps } from '../../../../core/splice/apply'
import { load } from '../../../../core/splice/load'
import { diffBlocks } from '../../../../core/blocks'
import { createMd, type Md } from '../../../../core/md/index'
import type { BlockOp } from '../../../../shared/types'

let md: Md
beforeAll(async () => {
  md = await createMd()
})

const BASE = 'A one.\n\nB two.\n\nC three.\n\nD four.\n'

function opsFor(current: string, next: string): BlockOp[] {
  const L = load(md, current)
  const N = load(md, next)
  const ops: BlockOp[] = []
  for (const d of diffBlocks(L.blocks, N.blocks)) {
    if (d.op === 'equal') continue
    ops.push({ after: d.a - 1, before: d.a + d.an, covers: L.blocks.slice(d.a, d.a + d.an).map((b) => b.hash), blocks: N.blocks.slice(d.b, d.b + d.bn).map((b) => next.slice(b.start, b.end)) })
  }
  return ops
}

/** TJ planned `mine` against BASE; disk now holds `theirs`. */
function merge(mine: string, theirs: string) {
  const base = load(md, BASE)
  const current = load(md, theirs)
  const ops = opsFor(BASE, mine)
  const out = merge3way(
    { baseHashes: base.blocks.map((b) => b.hash), current, ops, theirsBy: () => ({ by: 'Claude', rev: 7 }) },
    (i) => (base.blocks[i] ? BASE.slice(base.blocks[i]!.start, base.blocks[i]!.end) : null),
  )
  const r = applyBlockOps(md, current, out.mapped)
  return { ...out, text: r.text, verified: r.verified }
}

describe('merge3way (§7.3)', () => {
  it('fast path: base hashes equal the current map → the ops as given', () => {
    const r = merge(BASE.replace('two', 'TWO'), BASE)
    expect(r.conflicts).toEqual([])
    expect(r.text).toBe(BASE.replace('two', 'TWO'))
  })

  it('row 10: Claude edited the block next to TJ\'s → retarget, no conflict', () => {
    const r = merge(BASE.replace('B two.', 'B TWO.'), BASE.replace('C three.', 'C THREE.'))
    expect(r.conflicts).toEqual([])
    expect(r.dropped).toEqual([])
    expect(r.text).toBe(BASE.replace('B two.', 'B TWO.').replace('C three.', 'C THREE.'))
    expect(r.verified).toBe(true)
  })

  it('retargets past blocks inserted and deleted elsewhere', () => {
    const r = merge(BASE.replace('D four.', 'D FOUR.'), 'New first.\n\n' + BASE.replace('B two.\n\n', ''))
    expect(r.conflicts).toEqual([])
    expect(r.text).toBe('New first.\n\nA one.\n\nC three.\n\nD FOUR.\n')
  })

  it('the same block changed on both sides → one conflict with base, mine, theirs and who wrote theirs; disk keeps theirs', () => {
    const r = merge(BASE.replace('B two.', 'B mine.'), BASE.replace('B two.', 'B theirs.'))
    expect(r.conflicts).toEqual([{
      kind: 'conflict', id: `conflict:${load(md, BASE).blocks[1]!.hash}`, baseIndex: 1, currentIndex: 1,
      base: 'B two.', mine: 'B mine.', theirs: 'B theirs.', theirsBy: 'Claude', theirsRev: 7,
    }])
    expect(r.text).toBe(BASE.replace('B two.', 'B theirs.'))
  })

  it('theirs deleted the block TJ edited → a conflict with theirs null; both deleted it → dropped', () => {
    const del = BASE.replace('B two.\n\n', '')
    const r = merge(BASE.replace('B two.', 'B mine.'), del)
    expect(r.conflicts[0]).toMatchObject({ mine: 'B mine.', theirs: null, currentIndex: null })
    const both = merge(del, del)
    expect(both.conflicts).toEqual([])
    expect(both.dropped).toEqual([0])
    expect(both.text).toBe(del)
  })

  it('both sides made the identical change → dropped (no conflict, no double apply)', () => {
    const same = BASE.replace('C three.', 'C 3.')
    const r = merge(same, same)
    expect(r.conflicts).toEqual([])
    expect(r.dropped).toEqual([0])
    expect(r.text).toBe(same)
  })

  it('insertions never conflict: after map(after); before map(before); else after the nearest preceding mapped block; else BOF', () => {
    // TJ inserts after B; Claude rewrote B → anchor unmapped; before (C) maps → inserted before C
    const r1 = merge(BASE.replace('B two.\n\n', 'B two.\n\nInserted.\n\n'), BASE.replace('B two.', 'B rewritten.'))
    expect(r1.conflicts).toEqual([])
    expect(r1.text).toBe('A one.\n\nB rewritten.\n\nInserted.\n\nC three.\n\nD four.\n')
    // both neighbours rewritten → after the nearest preceding mapped block (A)
    const r2 = merge(BASE.replace('B two.\n\n', 'B two.\n\nInserted.\n\n'), BASE.replace('B two.', 'B x.').replace('C three.', 'C y.'))
    expect(r2.text).toBe('A one.\n\nInserted.\n\nB x.\n\nC y.\n\nD four.\n')
    // at BOF
    const r3 = merge('Top.\n\n' + BASE, BASE.replace('A one.', 'A changed.'))
    expect(r3.text).toBe('Top.\n\nA changed.\n\nB two.\n\nC three.\n\nD four.\n')
  })

  it('two TJ runs whose untouched separator theirs deleted are folded into one valid op', () => {
    const mine = BASE.replace('A one.', 'A mine.').replace('C three.', 'C mine.')
    const theirs = BASE.replace('B two.\n\n', '')
    const r = merge(mine, theirs)
    expect(r.conflicts).toEqual([])
    expect(r.mapped).toHaveLength(1)
    expect(r.text).toBe('A mine.\n\nC mine.\n\nD four.\n')
  })
})
