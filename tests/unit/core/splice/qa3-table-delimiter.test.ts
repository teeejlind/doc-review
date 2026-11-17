// tests/unit/core/splice/qa3-table-delimiter.test.ts (QA round 3). Editing a table's header cell and a body cell in one
// save batch must change only those two rows: the delimiter row between them keeps its bytes (CONTRACTS §12.13).
import { EditorState } from '@milkdown/kit/prose/state'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { applyBlockOps } from '../../../../core/splice/apply'
import { load } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import { regionSplice } from '../../../../core/splice/render'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

/** Append `add` to the end of the text of each cell whose text is in `cells`. */
function editCells(src: string, cells: Record<string, string>): string {
  const L = load(md, src)
  let state = EditorState.create({ schema: md.schema, doc: L.doc })
  const at: Array<[number, string]> = []
  state.doc.descendants((n, pos) => {
    if (n.isText && cells[n.text!] !== undefined) at.push([pos + n.nodeSize, cells[n.text!]!])
    return true
  })
  for (const [pos, add] of at.reverse()) state = state.apply(state.tr.insertText(add, pos))
  return applyBlockOps(md, L, planSave(md, L, state.doc)).text
}

describe('table delimiter rows survive a two-row edit (QA3)', () => {
  it('header cell + body cell in one batch: only those two lines change', () => {
    const src = '# T\n\n| Use case | Tool |\n|---|---|\n| Personal meetings | Granola |\n| Team | Fellow |\n'
    const out = editCells(src, { 'Use case': ' ZQX1', 'Personal meetings': ' ZQX2' })
    expect(out).toBe('# T\n\n| Use case ZQX1 | Tool |\n|---|---|\n| Personal meetings ZQX2 | Granola |\n| Team | Fellow |\n')
  })

  it('alignment delimiters too', () => {
    const src = '| Deal | Member | Term |\n|:-----|-------:|:----:|\n| Alpha | 12.0% | 9 mo |\n| Beta | 10.5% | 12 mo |\n'
    const out = editCells(src, { Deal: 'X', Beta: 'Y' })
    expect(out).toBe('| DealX | Member | Term |\n|:-----|-------:|:----:|\n| Alpha | 12.0% | 9 mo |\n| BetaY | 10.5% | 12 mo |\n')
  })

  it('regionSplice: changes on separate lines are spliced one by one; one change is spliced as before', () => {
    const A = 'a b\n= =\nc d'
    const S = 'a   b\n=====\nc   d'
    expect(regionSplice(A, 'aX b\n= =\nc dY', S)).toBe('aX   b\n=====\nc   dY')
    expect(regionSplice(A, 'aX b\n= =\nc d', S)).toBe('aX   b\n=====\nc   d')
  })
})
