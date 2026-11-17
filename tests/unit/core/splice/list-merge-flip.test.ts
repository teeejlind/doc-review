// tests/unit/core/splice/list-merge-flip.test.ts (P1; CONTRACTS §3.4 gate G0-flip, D36).
//
// The list-merge flip fires only on a real merge hazard. Positive cases each yield exactly one flip, change only
// marker bytes and give content-equal output; negative cases yield zero flips. The flip is intended behaviour (S2-d):
// without it CommonMark merges the two lists, so "fixing" it would change content.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { applyBlockOps, assembleOps } from '../../../../core/splice/apply'
import { contentNodes, nodeEq } from '../../../../core/splice/eq'
import { load } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import type { BlockOp } from '../../../../shared/types'
import { checkFlip, markerOffsets, sweepEdits } from '../../../corpus/harness'
import { oracleSave } from '../../../corpus/oracle-save'
import { FIXTURE_DOCS } from './fixtures'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const top = (doc: PMNode): PMNode[] => contentNodes(doc)
const docOf = (nodes: PMNode[]): PMNode => md.schema.topNodeType.create(null, nodes)
const sameContent = (a: PMNode[], b: PMNode[]): boolean => a.length === b.length && a.every((n, i) => nodeEq(n, b[i]!))

/** Delete the top-level block at `i`, plan, apply, and check the result against the intended doc. */
function deleteAt(src: string, i: number) {
  const L = load(md, src)
  const kids = top(L.doc)
  const next = docOf(kids.filter((_, k) => k !== i))
  const ops = planSave(md, L, next)
  const r = applyBlockOps(md, L, ops)
  return { L, ops, r, next, content: sameContent(top(load(md, r.text).doc), top(next)) }
}

describe('G0-flip positive cases: exactly one flip, marker bytes only, content-equal', () => {
  it('deleting the paragraph between two `-` lists flips the second list', () => {
    const { L, ops, r, next, content } = deleteAt('- a\n\nPara\n\n- b\n', 1)
    expect(r.text).toBe('- a\n\n* b\n')
    expect(r.flips).toEqual([{ op: 0, entry: 2 }])
    expect(r.verified).toBe(true)
    expect(content).toBe(true)
    expect(checkFlip(md, L, ops, { op: 0, entry: 2 }, r.text, top(next)).ok).toBe(true)
    expect(r.text).toBe(oracleSave(md, L, next).text)
  })

  it('deleting the paragraph between two `1.` lists flips the second to `1)`', () => {
    const { L, ops, r, next, content } = deleteAt('1. a\n2. b\n\nPara\n\n1. c\n2. d\n', 1)
    expect(r.text).toBe('1. a\n2. b\n\n1) c\n2) d\n')
    expect(r.flips).toEqual([{ op: 0, entry: 2 }])
    expect(content).toBe(true)
    expect(checkFlip(md, L, ops, { op: 0, entry: 2 }, r.text, top(next)).ok).toBe(true)
  })

  it('inserting a `-` list directly after a `-` list flips the inserted one (entry: null)', () => {
    const L = load(md, '- a\n\nPara\n')
    const ops: BlockOp[] = [{ after: 0, before: 1, covers: [], blocks: ['- n'] }]
    const r = applyBlockOps(md, L, ops)
    expect(r.text).toBe('- a\n\n* n\n\nPara\n')
    expect(r.flips).toEqual([{ op: 0, entry: null }])
    expect(r.verified).toBe(true)
    const lists = top(load(md, r.text).doc).filter((n) => n.type.name === 'bullet_list')
    expect(lists).toHaveLength(2)
    // the same insertion planned from a PM doc (two adjacent bullet_list nodes) gives the same bytes
    const kids = top(L.doc)
    const next = docOf([kids[0]!, md.parseDoc('- n').firstChild!, kids[1]!])
    expect(applyBlockOps(md, L, planSave(md, L, next)).text).toBe(r.text)
  })

  it('a flip changes nothing but the marker offsets mdast reports', () => {
    const src = '- one\n  - nested stays\n- two `- not a marker`\n'
    const flipped = assembleOps(md, load(md, `- a\n\nX\n\n${src}`), [], {}).text // no-op assembly keeps bytes
    expect(flipped).toBe(`- a\n\nX\n\n${src}`)
    const { r } = deleteAt(`- a\n\nX\n\n${src}`, 1)
    const after = r.text.slice('- a\n\n'.length)
    const markers = markerOffsets(md, src)
    expect(markers.size).toBe(2)
    for (let i = 0; i < src.length; i++) if (src[i] !== after[i]) expect(markers.has(i)).toBe(true)
    expect(after).toBe('* one\n  - nested stays\n* two `- not a marker`\n')
  })

  it('the flip was necessary: without it the same ops parse to one merged list', () => {
    const { L, ops } = deleteAt('- a\n\nPara\n\n- b\n', 1)
    const noFlip = assembleOps(md, L, ops, { flips: false }).text
    expect(noFlip).toBe('- a\n\n- b\n')
    expect(top(load(md, noFlip).doc).filter((n) => n.type.name === 'bullet_list')).toHaveLength(1)
  })
})

describe('G0-flip negative cases: zero flips', () => {
  it('deleting between lists with different markers', () => {
    const { r, content } = deleteAt('- a\n\nPara\n\n* b\n', 1)
    expect(r.flips).toEqual([])
    expect(r.text).toBe('- a\n\n* b\n')
    expect(content).toBe(true)
  })

  it('deleting between a bullet list and an ordered list', () => {
    expect(deleteAt('- a\n\nPara\n\n1. b\n', 1).r.flips).toEqual([])
  })

  it('deleting between a list and a non-list block', () => {
    const { r } = deleteAt('- a\n\nPara\n\n# H\n', 1)
    expect(r.flips).toEqual([])
    expect(r.text).toBe('- a\n\n# H\n')
  })

  it('deleting between two lists that stay separated by a heading', () => {
    const { r } = deleteAt('- a\n\n# H\n\nPara\n\n- b\n', 2)
    expect(r.flips).toEqual([])
    expect(r.text).toBe('- a\n\n# H\n\n- b\n')
  })

  it('every in-place edit in the sweep, over every fixture', () => {
    let n = 0
    for (const [name, src] of Object.entries(FIXTURE_DOCS)) {
      const L = load(md, src)
      for (const kind of ['replace-word', 'delete-word', 'bold-word'] as const) {
        for (const e of sweepEdits(md, L, 6, kind)) {
          const r = applyBlockOps(md, L, planSave(md, L, e.doc))
          n++
          expect(r.flips, `${name} ${kind}`).toEqual([])
        }
      }
    }
    expect(n).toBeGreaterThan(100)
  })
})
