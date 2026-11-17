// tests/unit/web/editor/ptext-property.test.ts (P2; CONTRACTS §5.1 "Live doc", §6.5, §14 P2 unit "live-ptext equals
// base-ptext property"). fast-check: any sequence of Suggesting-mode user transactions (insert, delete, replace, format
// toggle, paragraph split) at random places, next to a hydrated Claude record, leaves the live doc's ptext, which is
// ptextOf(baseDoc(live)), byte-identical to the loaded base's, with the same blockRanges, and leaves nothing to save.
// P2 has no incremental live ptext; if one is added, it must equal ptextOf(baseDoc(live)) here too.
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import type { Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ptextOf } from '../../../../core/ptext'
import { contentNodes } from '../../../../core/splice/eq'
import { planSave } from '../../../../core/splice/plan'
import { revertAll, SUGGEST_BLOCK_TEXT } from '../../../../core/suggest/guards'
import { marksOf, mount, userTr, type Mounted } from './helpers'

const MD = [
  '# Launch plan',
  '',
  'The notes carry a **member rate** of 12% paid monthly, per the [primer](https://example.com/primer).',
  '',
  '- Grow the waitlist',
  '- Ship the explainer page',
  '',
  '> A short quote for context.',
  '',
  '| Name | Rate |',
  '| --- | --- |',
  '| Alpha | 1 |',
  '',
  'Final paragraph with *emphasis* and `code`.',
  '',
].join('\n')

type Op =
  | { kind: 'insert'; block: number; at: number; text: string }
  | { kind: 'delete'; block: number; at: number; len: number }
  | { kind: 'replace'; block: number; at: number; len: number; text: string }
  | { kind: 'bold'; block: number; at: number; len: number }
  | { kind: 'split'; block: number; at: number }

const word = fc.constantFrom('x', 'new', ' words ', 'Q4', '12%', 'é', '🙂')
const frac = fc.double({ min: 0, max: 1, noNaN: true })
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('insert' as const), block: fc.nat(), at: frac, text: word }),
  fc.record({ kind: fc.constant('delete' as const), block: fc.nat(), at: frac, len: fc.integer({ min: 1, max: 12 }) }),
  fc.record({ kind: fc.constant('replace' as const), block: fc.nat(), at: frac, len: fc.integer({ min: 1, max: 8 }), text: word }),
  fc.record({ kind: fc.constant('bold' as const), block: fc.nat(), at: frac, len: fc.integer({ min: 1, max: 8 }) }),
  fc.record({ kind: fc.constant('split' as const), block: fc.nat(), at: frac }),
)

/** Content ranges [from, to) of every non-code textblock in the live doc. */
function textblocks(view: EditorView): Array<{ from: number; to: number; paragraph: boolean }> {
  const out: Array<{ from: number; to: number; paragraph: boolean }> = []
  view.state.doc.descendants((n, pos) => {
    if (n.isTextblock) {
      if (!n.type.spec.code) out.push({ from: pos + 1, to: pos + 1 + n.content.size, paragraph: n.type.name === 'paragraph' })
      return false
    }
    return true
  })
  return out
}

function applyOp(view: EditorView, o: Op): void {
  const tbs = textblocks(view)
  if (tbs.length === 0) return
  const tb = tbs[o.block % tbs.length]!
  const pos = tb.from + Math.floor(o.at * (tb.to - tb.from))
  const end = (len: number): number => Math.min(tb.to, pos + len)
  const build = (tr: Transaction): Transaction => {
    switch (o.kind) {
      case 'insert':
        return tr.insertText(o.text, pos)
      case 'delete':
        return end(o.len) > pos ? tr.delete(pos, end(o.len)) : tr
      case 'replace':
        return tr.insertText(o.text, pos, end(o.len))
      case 'bold':
        return end(o.len) > pos ? tr.addMark(pos, end(o.len), view.state.schema.marks.strong!.create()) : tr
      case 'split':
        return tb.paragraph && pos > tb.from && pos < tb.to ? tr.split(pos) : tr
    }
  }
  try {
    userTr(view, build)
  } catch {
    // a transform the schema can't take (an out-of-range split) is no user input at all
  }
}

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

describe('§5.1 live ptext (property)', () => {
  it('Suggesting-mode edits never change ptext(baseDoc(live)) or the base block map', async () => {
    let tracked = 0
    let runs = 0
    let refusals = 0
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'Ship the explainer page', replace: 'Ship the explainer video' }] })
        try {
          const L = m.internals.getLoaded()!
          const want = ptextOf(L.doc, L)
          m.bridge.setMode('suggesting')
          for (const o of ops) {
            const refusedBefore = m.ed.lastBaseRefusal
            applyOp(m.view, o)
            const r = m.ed.lastBaseRefusal
            if (r && r !== refusedBefore) {
              // every base-guard refusal must be genuine: the base as the edit would have left it saves different
              // markdown (an oracle independent of the guard's nodeEq); a false positive would refuse TJ quietly
              refusals++
              const md = (d: typeof r.before): string => m!.ed.md.serializeNodes(contentNodes(revertAll(d).doc))
              expect(md(r.after)).not.toBe(md(r.before))
            }
          }
          runs++
          const claudeId = m.session.getReview().suggestions[0]!.id
          if (marksOf(m.view).some((x) => x.id !== claudeId)) tracked++
          const base = revertAll(m.view.state.doc).doc
          const got = ptextOf(base, L)
          expect(got.text).toBe(want.text)
          expect(got.blockRanges).toEqual(want.blockRanges)
          // the editor's own baseDoc (what the debug hook and the save planner use) agrees
          const own = ptextOf(m.ed.baseDoc(), L)
          expect(own.text).toBe(want.text)
          expect(planSave(m.ed.md, L, m.ed.baseDoc())).toEqual([])
          expect(m.notices.filter((n) => n.text === SUGGEST_BLOCK_TEXT['base-changed'] || n.text === SUGGEST_BLOCK_TEXT.untrackable).length).toBeLessThanOrEqual(refusals)
        } finally {
          await m.close()
          m = null
        }
      }),
      {
        numRuns: 20,
        // found by this property (2026-10-16): a split inside the list item that holds Claude's suggestion, then a
        // replace across the split's zero-width marker; without the base guard the planner wrote "- S\n\n  hip…"
        examples: [[[
          { kind: 'split', block: 859399033, at: 0.03571428571428571 },
          { kind: 'replace', block: 14, at: 0, len: 2, text: 'x' },
          { kind: 'delete', block: 0, at: 0, len: 1 },
        ]], [[
          // the same at top level ("T|he notes…"): the replace removes one marker of the pair and the untouched
          // paragraph beside it no longer rejoins on revert (the guard compares one neighbour on each side for this)
          { kind: 'split', block: 1399179761, at: 0.015151515151515152 },
          { kind: 'replace', block: 21458911, at: 0, len: 2, text: 'x' },
          { kind: 'delete', block: 0, at: 0, len: 1 },
        ]]],
      },
    )
    // not vacuous: most runs left TJ suggestion marks in the live doc, and refusals stay rare
    expect(tracked).toBeGreaterThan(runs / 2)
    expect(refusals).toBeLessThan(runs)
  }, 120_000)
})
