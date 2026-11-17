// tests/unit/core/splice/day0-plan-apply.test.ts (integrator, day 0; P1 owns it from M0).
//
// The day-0 planSave / applyBlockOps / updateLoaded stubs: a no-op plans [], every edit plans one op per changed run,
// and applyBlockOps(L, planSave(L, doc)).text equals the oracle's text (G1's shape) on the S2 edit classes, including
// the list-merge flip (D36). The fault hook fails exactly the ops it matches (G7's hook, D51).
import { Fragment, Slice, type Node as PMNode } from '@milkdown/kit/prose/model'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { applyBlockOps, setSpliceFaultForTests, validateBlockOps } from '../../../../core/splice/apply'
import { load } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import { updateLoaded } from '../../../../core/splice/update'
import { oracleSave } from '../../../corpus/oracle-save'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})
afterEach(() => setSpliceFaultForTests(null))

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')
const DOCS: Record<string, string> = {
  plain: '# Title\n\nFirst paragraph here.\n\n- one\n- two\n\nLast paragraph.\n',
  crlf: crlf('---\ntitle: x\n---\n\n# Head\n\nBody text that wraps\nonto a second line.\n\n> quote\n'),
  'no-final-eol': 'Para one.\n\nPara two, no final newline.',
  table: '| A | B |\n|---|:-:|\n| 1 | 2 |\n\nAfter the table.\n',
  empty: '',
}

function editText(doc: PMNode, from: string, to: string): PMNode {
  let pos = -1
  doc.descendants((n, p) => {
    if (pos >= 0) return false
    if (n.isText && n.text!.includes(from)) pos = p + n.text!.indexOf(from)
    return true
  })
  if (pos < 0) throw new Error(`"${from}" not in doc`)
  const marks = doc.resolve(pos + 1).marks()
  return doc.replace(pos, pos + from.length, new Slice(Fragment.from(md.schema.text(to, marks)), 0, 0))
}

function topLevel(doc: PMNode): PMNode[] {
  const out: PMNode[] = []
  doc.forEach((n) => out.push(n))
  return out
}
const withTop = (nodes: PMNode[]) => md.schema.topNodeType.create(null, nodes.length ? nodes : [md.schema.nodes.paragraph!.create()])

function expectOracleParity(src: string, next: PMNode): void {
  const L = load(md, src)
  const ops = planSave(md, L, next)
  const r = applyBlockOps(md, L, ops)
  const oracle = oracleSave(md, L, next)
  expect(r.failed).toEqual([])
  expect(r.verified).toBe(true)
  expect(r.text).toBe(oracle.text)
}

describe('planSave (day 0)', () => {
  for (const [name, src] of Object.entries(DOCS)) {
    it(`plans [] for a no-op: ${name}`, () => {
      const L = load(md, src)
      expect(planSave(md, L, L.doc)).toEqual([])
    })
  }

  it('plans one in-place op for a one-word edit', () => {
    const L = load(md, DOCS.plain!)
    const ops = planSave(md, L, editText(L.doc, 'First', 'Opening'))
    expect(ops).toHaveLength(1)
    expect(ops[0]).toEqual({ after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: ['Opening paragraph here.'] })
  })

  it('plans a pure insertion and a pure deletion', () => {
    const L = load(md, DOCS.plain!)
    const kids = topLevel(L.doc)
    const para = md.parseDoc('Inserted.').firstChild!
    const ins = planSave(md, L, withTop([...kids.slice(0, 2), para, ...kids.slice(2)]))
    expect(ins).toEqual([{ after: 1, before: 2, covers: [], blocks: ['Inserted.'] }])
    const del = planSave(md, L, withTop([kids[0]!, ...kids.slice(2)]))
    expect(del).toEqual([{ after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: [] }])
  })
})

describe('applyBlockOps(planSave) equals the oracle (day 0)', () => {
  it('one-word edits in every doc', () => {
    expectOracleParity(DOCS.plain!, editText(load(md, DOCS.plain!).doc, 'Last', 'Final'))
    expectOracleParity(DOCS.crlf!, editText(load(md, DOCS.crlf!).doc, 'Body', 'Main'))
    expectOracleParity(DOCS['no-final-eol']!, editText(load(md, DOCS['no-final-eol']!).doc, 'two', 'TWO'))
    expectOracleParity(DOCS.table!, editText(load(md, DOCS.table!).doc, 'After', 'Below'))
  })

  it('insertion, deletion, split and move', () => {
    const L = load(md, DOCS.plain!)
    const kids = topLevel(L.doc)
    const para = md.parseDoc('New block.').firstChild!
    expectOracleParity(DOCS.plain!, withTop([...kids, para]))
    expectOracleParity(DOCS.plain!, withTop([para, ...kids]))
    expectOracleParity(DOCS.plain!, withTop(kids.slice(1)))
    expectOracleParity(DOCS.plain!, withTop([kids[0]!, kids[2]!, kids[1]!, kids[3]!]))
    const split = md.parseDoc('First paragraph.\n\nhere.')
    expectOracleParity(DOCS.plain!, withTop([kids[0]!, ...topLevel(split), ...kids.slice(2)]))
  })

  it('an empty file gains a final EOL', () => {
    const para = md.parseDoc('Hello.').firstChild!
    const L = load(md, '')
    const r = applyBlockOps(md, L, planSave(md, L, withTop([para])))
    expect(r.text).toBe('Hello.\n')
    expectOracleParity('', withTop([para]))
  })

  it('flips the following list on a fresh same-marker seam (D36)', () => {
    const src = '- a\n\nPara\n\n- b\n'
    const L = load(md, src)
    const kids = topLevel(L.doc)
    const next = withTop([kids[0]!, kids[2]!])
    const r = applyBlockOps(md, L, planSave(md, L, next))
    expect(r.text).toBe('- a\n\n* b\n')
    expect(r.flips).toEqual([{ op: 0, entry: 2 }])
    expect(r.text).toBe(oracleSave(md, L, next).text)
  })

  it('no flip between lists with different markers', () => {
    const src = '- a\n\nPara\n\n* b\n'
    const L = load(md, src)
    const kids = topLevel(L.doc)
    const r = applyBlockOps(md, L, planSave(md, L, withTop([kids[0]!, kids[2]!])))
    expect(r.flips).toEqual([])
    expect(r.text).toBe('- a\n\n* b\n')
  })
})

describe('applyBlockOps validation and the fault hook (day 0)', () => {
  it('rejects malformed ops with BAD_REQUEST', () => {
    const L = load(md, DOCS.plain!)
    expect(() => validateBlockOps(L.blocks, [{ after: 0, before: 2, covers: ['0000000000000000'], blocks: [] }])).toThrow(/covers/)
    expect(() => validateBlockOps(L.blocks, [{ after: 1, before: 1, covers: [], blocks: [] }])).toThrow(/after < before/)
    expect(() => validateBlockOps(L.blocks, [
      { after: 1, before: 3, covers: [L.blocks[2]!.hash], blocks: [] },
      { after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: [] },
    ])).toThrow(/sorted/)
    try {
      applyBlockOps(md, L, [{ after: 5, before: 9, covers: [], blocks: [] }])
      expect.unreachable()
    } catch (e) {
      expect((e as { code: string }).code).toBe('BAD_REQUEST')
    }
  })

  it('fails exactly the faulted ops and leaves them out of the text', () => {
    const L = load(md, DOCS.plain!)
    const edited = editText(editText(L.doc, 'First', 'Opening'), 'Last', 'Final')
    const ops = planSave(md, L, edited)
    expect(ops).toHaveLength(2)
    const target = ops[1]!.covers[0]!
    setSpliceFaultForTests((op) => op.covers.includes(target))
    const r = applyBlockOps(md, L, ops)
    expect(r.failed).toEqual([1])
    expect(r.verified).toBe(false)
    expect(r.text).toBe(DOCS.plain!.replace('First', 'Opening'))
  })
})

describe('updateLoaded (day 0)', () => {
  it('equals load() of the new text, so a re-plan of the same doc is []', () => {
    const L = load(md, DOCS.plain!)
    const next = editText(L.doc, 'First', 'Opening')
    const ops = planSave(md, L, next)
    const { text } = applyBlockOps(md, L, ops)
    const L2 = updateLoaded(md, L, text, ops)
    expect(L2.src).toBe(text)
    expect(L2.blocks.map((b) => b.hash)).toEqual(load(md, text).blocks.map((b) => b.hash))
    expect(planSave(md, L2, next)).toEqual([])
  })
})
