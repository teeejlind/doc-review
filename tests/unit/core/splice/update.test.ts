// tests/unit/core/splice/update.test.ts (P1; CONTRACTS §3.4 updateLoaded, gates G2 and G3).
//
// updateLoaded re-classifies only the changed region and equals load(text) exactly (entries, gaps, defs, block map)
// on every path: incremental edits anywhere in the doc, and the fallbacks (a changed definition set, an edit that
// reaches a margin block, an EOL flip, an empty doc). With liveNodes, rewritten entries adopt the editor's own nodes
// so an immediate re-plan of the same doc is [] even where markdown normalizes (a split's trailing space).
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { ptextOf } from '../../../../core/ptext'
import { applyBlockOps } from '../../../../core/splice/apply'
import { contentNodes } from '../../../../core/splice/eq'
import { load, type Loaded } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import { updateLoaded } from '../../../../core/splice/update'
import type { BlockOp } from '../../../../shared/types'
import { sameLoaded, structuralEdit, sweepEdits } from '../../../corpus/harness'
import { FIXTURE_DOCS } from './fixtures'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

/** updateLoaded(L, text) must equal load(text). */
function expectEqualsLoad(L: Loaded, text: string, ops: BlockOp[] = []): Loaded {
  const U = updateLoaded(md, L, text, ops)
  expect(sameLoaded(U, load(md, text))).toBeNull()
  return U
}

describe('updateLoaded equals load(text) (G2)', () => {
  const DOC = '---\ntitle: x\n---\n\n# Title\n\nFirst paragraph.\n\n- one\n- two\n\nMiddle paragraph.\n\n> quote\n\nLast paragraph.\n'

  it('returns L itself when nothing changed', () => {
    const L = load(md, DOC)
    expect(updateLoaded(md, L, DOC, [])).toBe(L)
  })

  it('edits in the first, a middle and the last block, and in the frontmatter', () => {
    const L = load(md, DOC)
    for (const [a, b] of [['title: x', 'title: y'], ['# Title', '# Heading'], ['Middle paragraph.', 'Middle, longer paragraph.'], ['Last paragraph.', 'Last.']] as const) {
      expectEqualsLoad(L, DOC.replace(a, b))
    }
  })

  it('insertions and deletions at the start, middle and end, and gap-only changes', () => {
    const L = load(md, DOC)
    expectEqualsLoad(L, 'Intro.\n\n' + DOC)
    expectEqualsLoad(L, DOC + '\nAppended.\n')
    expectEqualsLoad(L, DOC.replace('Middle paragraph.\n\n', ''))
    expectEqualsLoad(L, DOC.replace('\n\n> quote', '\n\n\n\n> quote'))
    expectEqualsLoad(L, DOC.replace('Last paragraph.\n', 'Last paragraph.'))
    expectEqualsLoad(L, DOC.replace('---\ntitle: x\n---\n\n', ''))
  })

  it('shifts lines, indexes, refs and ptext ranges of every block after the edit', () => {
    const L = load(md, DOC)
    const U = expectEqualsLoad(L, DOC.replace('First paragraph.', 'First paragraph.\n\nA new second paragraph.'))
    expect(U.blocks.length).toBe(L.blocks.length + 1)
    expect(U.blocks.at(-1)!.ref).toBe(`b${U.blocks.length}`)
    expect(U.blocks.at(-1)!.line).toBe(L.blocks.at(-1)!.line + 2)
    const p = ptextOf(U.doc, U)
    for (const b of U.blocks) expect(p.text.slice(b.pStart, b.pEnd).slice(0, 80)).toBe(b.kind === 'md' ? b.preview : p.text.slice(b.pStart, b.pEnd).slice(0, 80))
  })

  it('reuses the objects of untouched blocks before the edit', () => {
    const L = load(md, DOC)
    const U = updateLoaded(md, L, DOC.replace('Last paragraph.', 'Last.'), [])
    expect(U.entries[0]).toBe(L.entries[0])
    expect(U.blocks[1]).toBe(L.blocks[1])
  })

  it('CRLF, BOM and no-final-EOL docs', () => {
    for (const name of ['syn__crlf.md', 'syn__crlf-mixed.md', 'syn__bom.md', 'syn__no-trailing-newline.md', 'syn__emoji-crlf-no-eol.md']) {
      const src = FIXTURE_DOCS[name]!
      const L = load(md, src)
      for (const e of sweepEdits(md, L, 4, 'replace-word')) {
        const ops = planSave(md, L, e.doc)
        expectEqualsLoad(L, applyBlockOps(md, L, ops).text, ops)
      }
    }
    const bom = '﻿# T\n\nBody.\n'
    expectEqualsLoad(load(md, bom), bom.replace('Body', 'Text'))
  })

  it('every fixture: sweep and structural edits through the real pipeline', () => {
    let n = 0
    for (const src of Object.values(FIXTURE_DOCS)) {
      const L = load(md, src)
      const edits = [...sweepEdits(md, L, 4, 'replace-word'), ...sweepEdits(md, L, 2, 'delete-word')]
      for (const k of ['insert-paragraph', 'delete-block', 'split-paragraph'] as const) {
        const e = structuralEdit(md, L, k)
        if (e) edits.push(e)
      }
      for (const e of edits) {
        const ops = planSave(md, L, e.doc)
        expectEqualsLoad(L, applyBlockOps(md, L, ops).text, ops)
        n++
      }
    }
    expect(n).toBeGreaterThan(150)
  })
})

describe('fallbacks to load() still equal it', () => {
  it('a changed definition set (a reference definition deleted or added)', () => {
    const src = 'See [a][r].\n\nMiddle.\n\n[r]: https://example.com\n\nEnd.\n'
    const L = load(md, src)
    expectEqualsLoad(L, src.replace('[r]: https://example.com\n\n', ''))
    expectEqualsLoad(L, src.replace('End.', '[s]: https://other.example\n\nEnd.'))
    expectEqualsLoad(L, src.replace('https://example.com', 'https://changed.example'))
  })

  it('an edit that reaches a margin block (an indented paragraph joining the list above)', () => {
    const src = 'A.\n\n- item\n\nB.\n\nC.\n'
    const L = load(md, src)
    const U = expectEqualsLoad(L, src.replace('B.', '  continued'))
    expect(U.entries.length).toBe(L.entries.length - 1)
  })

  it('an EOL flip, an empty doc, and a doc emptied', () => {
    const lf = 'A.\n\nB.\n'
    expectEqualsLoad(load(md, lf), 'A.\r\n\r\nB.\r\n\r\nC.\r\n')
    expectEqualsLoad(load(md, ''), 'Hello.\n')
    expectEqualsLoad(load(md, lf), '')
  })
})

describe('liveNodes (G3)', () => {
  it('a split paragraph keeps the editor node with its trailing space, so a re-plan is []', () => {
    const src = '# T\n\nThe quick brown fox jumps over the lazy dog.\n\nEnd.\n'
    const L = load(md, src)
    let at = -1
    L.doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text!.includes('jumps')) at = pos + n.text!.indexOf('jumps')
      return true
    })
    const state = EditorState.create({ schema: md.schema, doc: L.doc })
    const doc = state.tr.setSelection(TextSelection.create(state.doc, at)).split(at).doc
    const ops = planSave(md, L, doc)
    const r = applyBlockOps(md, L, ops)
    expect(r.text).toBe(src.replace('fox jumps', 'fox \n\njumps'))
    // without liveNodes the parsed paragraph drops the trailing space and the re-plan sees a change
    expect(planSave(md, updateLoaded(md, L, r.text, ops), doc).length).toBeGreaterThan(0)
    // with the editor's nodes it is [] (whole-doc positions, or just the rewritten region's)
    const U = updateLoaded(md, L, r.text, ops, contentNodes(doc))
    expect(planSave(md, U, doc)).toEqual([])
    expect(U.blocks).toHaveLength(load(md, r.text).blocks.length)
    const region = contentNodes(doc).slice(1, 3)
    expect(planSave(md, updateLoaded(md, L, r.text, ops, region), doc)).toEqual([])
  })

  it('QA3 F1: after a split after a space, the next edit in the following block splices the same on both sides', () => {
    // Enter between "the " and "explainer", autosave, then type at the start of the new paragraph. The client's L
    // adopts the editor node with its trailing space; the server's L is load(text). Both must apply the second op the
    // same way (it used to fail verification on the client only: 500 SPLICE_MISMATCH and the typed text dropped).
    const src = '# Plan\n\nSecond paragraph talks about the waitlist and the explainer page. It is short.\n\nFinal paragraph.\n'
    const L = load(md, src)
    let at = -1
    L.doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text!.includes('explainer')) at = pos + n.text!.indexOf('explainer')
      return true
    })
    let state = EditorState.create({ schema: md.schema, doc: L.doc })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)).split(at))
    const ops1 = planSave(md, L, state.doc)
    const r1 = applyBlockOps(md, L, ops1)
    expect(r1.text).toContain('and the \n\nexplainer')
    const client = updateLoaded(md, L, r1.text, ops1, contentNodes(state.doc))
    const server = load(md, r1.text)
    state = state.apply(state.tr.insertText('MY TYPED TEXT ', state.selection.from))
    const ops2 = planSave(md, client, state.doc)
    const onClient = applyBlockOps(md, client, ops2)
    const onServer = applyBlockOps(md, server, ops2)
    expect(onClient.failed).toEqual([])
    expect(onClient.text).toBe(onServer.text)
    expect(onClient.text).toContain('and the \n\nMY TYPED TEXT explainer page.')
  })

  it('ignores liveNodes whose count does not line up', () => {
    const src = 'A.\n\nB.\n'
    const L = load(md, src)
    const U = updateLoaded(md, L, 'A.\n\nC.\n', [], contentNodes(md.parseDoc('X.\n\nY.\n\nZ.')))
    expect(sameLoaded(U, load(md, 'A.\n\nC.\n'))).toBeNull()
  })
})
