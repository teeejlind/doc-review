// tests/unit/core/md/s2b-suggest.test.ts (P1; CONTRACTS §3.2 S2-b additions, §0.2 [pending S2-b], D14, §6.5).
//
// The S2-b schema marks (insertion / modification / deletion allowed inside bullet_list, ordered_list, list_item and
// blockquote; none on table nodes) and the S2 suggest-changes suite rerun on the split pipeline: the headless flow over
// every fixture, the live view wired with withSuggestChanges, plus the two cases S2-b exists for: inserting a list
// item, and toggling a task checkbox (an AttrStep tracked as a `modification` mark on the list_item).
import { editorViewOptionsCtx } from '@milkdown/kit/core'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { $prose } from '@milkdown/kit/utils'
import {
  applySuggestion, applySuggestions, enableSuggestChanges, isSuggestChangesEnabled, revertSuggestion, revertSuggestions,
  suggestChanges, suggestChangesKey, transformToSuggestionTransaction, withSuggestChanges,
} from '@handlewithcare/prosemirror-suggest-changes'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMd, SuggestionResidueError, type Md } from '../../../../core/md/index'
import { applyBlockOps } from '../../../../core/splice/apply'
import { load, type Loaded } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import { baseDoc, suggestFlow } from '../../../corpus/harness'
import { FIXTURE_DOCS } from '../splice/fixtures'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const save = (m: Md, L: Loaded, doc: PMNode): string => applyBlockOps(m, L, planSave(m, L, doc)).text
const suggesting = (doc: PMNode): EditorState => {
  let state = EditorState.create({ schema: md.schema, doc, plugins: [suggestChanges()] })
  enableSuggestChanges(state, (tr) => {
    state = state.apply(tr)
  })
  return state
}
const marksOn = (doc: PMNode): string[] => {
  const out: string[] = []
  doc.descendants((n) => {
    for (const m of n.marks) if (['insertion', 'deletion', 'modification'].includes(m.type.name)) out.push(`${n.type.name}:${m.type.name}`)
    return true
  })
  return out
}
const applyAll = (s: EditorState): EditorState => {
  let out = s
  applySuggestions(out, (tr) => {
    out = out.apply(tr)
  })
  return out
}
const revertAll = (s: EditorState): EditorState => {
  let out = s
  revertSuggestions(out, (tr) => {
    out = out.apply(tr)
  })
  return out
}

describe('S2-b schema additions (§3.2)', () => {
  it('the suggestion marks are allowed inside lists and blockquotes, never inside tables (D14)', () => {
    for (const n of ['bullet_list', 'ordered_list', 'list_item', 'blockquote']) {
      expect(md.schema.nodes[n]!.spec.marks, n).toBe('insertion modification deletion')
      for (const m of ['insertion', 'modification', 'deletion']) expect(md.schema.nodes[n]!.allowsMarkType(md.schema.marks[m]!), `${n} ${m}`).toBe(true)
    }
    for (const n of ['table', 'table_header_row', 'table_row']) {
      expect(md.schema.nodes[n]!.allowsMarkType(md.schema.marks.insertion!), n).toBe(false)
    }
  })

  it('task list items keep gfm\'s `checked` attr and round-trip', () => {
    expect(Object.keys(md.schema.nodes.list_item!.spec.attrs ?? {})).toContain('checked')
    const src = '- [ ] open\n- [x] done\n'
    const L = load(md, src)
    expect(planSave(md, L, L.doc)).toEqual([])
    expect(L.entries[0]!.fidelity).toBe('exact')
  })
})

describe('the S2 suggest suite on the split pipeline (68/68 in S2; every applicable fixture here)', () => {
  it('marks, base save, residue guard, accept, reject, split round trip', () => {
    let n = 0
    for (const [name, src] of Object.entries(FIXTURE_DOCS)) {
      const r = suggestFlow(md, load(md, src))
      if (!r.applicable) continue
      n++
      for (const [k, v] of Object.entries(r)) if (typeof v === 'boolean') expect(v, `${name}: ${k} ${r.detail ?? ''}`).toBe(true)
    }
    expect(n).toBeGreaterThan(25)
  })
})

describe('list-item insert in Suggesting mode (S2-b)', () => {
  const SRC = '- one\n- two\n'

  it('the inserted list item is marked; accept writes it, reject and the base save restore the bytes', () => {
    const L = load(md, SRC)
    let state = suggesting(L.doc)
    // the end of the first item's paragraph
    let end = -1
    state.doc.descendants((n, pos) => {
      if (end < 0 && n.isText && n.text === 'one') end = pos + 3
      return true
    })
    const plain = state.tr.setSelection(TextSelection.create(state.doc, end)).split(end, 2).insertText('three')
    state = state.apply(transformToSuggestionTransaction(plain, state))
    expect(marksOn(state.doc).some((m) => m.endsWith(':insertion'))).toBe(true)
    // the .md keeps the base text while the suggestion is pending; a marked doc is refused
    expect(save(md, L, baseDoc(state))).toBe(SRC)
    expect(() => planSave(md, L, state.doc)).toThrow(SuggestionResidueError)
    // accept: exactly the direct edit
    const accepted = applyAll(state)
    expect(marksOn(accepted.doc)).toEqual([])
    expect(save(md, L, accepted.doc)).toBe('- one\n- three\n- two\n')
    // reject: byte-identical
    const rejected = revertAll(state)
    expect(marksOn(rejected.doc)).toEqual([])
    expect(save(md, L, rejected.doc)).toBe(SRC)
  })

  it('in an ordered list and inside a blockquote too', () => {
    for (const [src, word, want] of [
      ['1. one\n2. two\n', 'one', '1. one\n2. three\n3. two\n'],
      ['> - one\n> - two\n', 'one', '> - one\n> - three\n> - two\n'],
    ] as const) {
      const L = load(md, src)
      let state = suggesting(L.doc)
      let end = -1
      state.doc.descendants((n, pos) => {
        if (end < 0 && n.isText && n.text === word) end = pos + word.length
        return true
      })
      const plain = state.tr.setSelection(TextSelection.create(state.doc, end)).split(end, 2).insertText('three')
      state = state.apply(transformToSuggestionTransaction(plain, state))
      expect(marksOn(state.doc).length, src).toBeGreaterThan(0)
      expect(save(md, L, baseDoc(state)), src).toBe(src)
      expect(save(md, L, applyAll(state).doc), src).toBe(want)
      expect(save(md, L, revertAll(state).doc), src).toBe(src)
    }
  })
})

describe('task-checkbox toggle in Suggesting mode is an AttrStep (S2-b, §6.5)', () => {
  const SRC = '- [ ] write the memo\n- [x] send the draft\n'

  it('tracked as a modification mark on the list_item; accept checks it, reject leaves the bytes', () => {
    const L = load(md, SRC)
    let state = suggesting(L.doc)
    let itemPos = -1
    state.doc.descendants((n, pos) => {
      if (itemPos < 0 && n.type.name === 'list_item') itemPos = pos
      return true
    })
    expect(state.doc.nodeAt(itemPos)!.attrs.checked).toBe(false)
    const plain = state.tr.setNodeAttribute(itemPos, 'checked', true)
    expect(plain.steps[0]!.constructor.name).toBe('AttrStep')
    state = state.apply(transformToSuggestionTransaction(plain, state))
    const item = state.doc.nodeAt(itemPos)!
    const mod = item.marks.find((m) => m.type.name === 'modification')
    expect(mod?.attrs).toMatchObject({ type: 'attr', attrName: 'checked', previousValue: false, newValue: true })
    // pending: the .md keeps the unchecked box
    expect(save(md, L, baseDoc(state))).toBe(SRC)
    expect(save(md, L, applyAll(state).doc)).toBe('- [x] write the memo\n- [x] send the draft\n')
    expect(save(md, L, revertAll(state).doc)).toBe(SRC)
  })
})

describe('the live view wired with withSuggestChanges', () => {
  const SRC = '# Title\n\nThe quick brown fox jumps over the lazy dog.\n\n- item one\n- item two\n'
  let live: Md
  beforeAll(async () => {
    live = await createMd({
      extend: (e) => e.config((ctx) => ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, dispatchTransaction: withSuggestChanges() }))).use($prose(() => suggestChanges())),
    })
  })
  afterAll(async () => {
    await live.destroy()
  })

  const reset = (): Loaded => {
    const L = load(live, SRC)
    const v = live.view
    v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, L.doc.content).setMeta(suggestChangesKey, { skip: true }))
    if (!isSuggestChangesEnabled(v.state)) enableSuggestChanges(v.state, v.dispatch)
    return L
  }
  const posOf = (word: string): number => {
    let at = -1
    live.view.state.doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text!.includes(word)) at = pos + n.text!.indexOf(word)
      return true
    })
    return at
  }
  const type = (word: string, replacement: string): void => {
    const v = live.view
    const from = posOf(word)
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, from + word.length)))
    v.dispatch(v.state.tr.insertText(replacement))
  }
  const ids = (): Array<string | number> => {
    const out = new Set<string | number>()
    live.view.state.doc.descendants((n) => {
      for (const m of n.marks) if (m.type.name === 'insertion' || m.type.name === 'deletion') out.add(m.attrs.id as string | number)
      return true
    })
    return [...out]
  }

  it('the fingerprint is unchanged by a view-only extend', () => {
    expect(live.schemaFingerprint).toBe(md.schemaFingerprint)
  })

  it('typing makes deletion + insertion marks; the base save is byte-identical', () => {
    const L = reset()
    type('quick', 'slow')
    expect(marksOn(live.view.state.doc)).toEqual(['text:deletion', 'text:insertion'])
    expect(() => planSave(live, L, live.view.state.doc)).toThrow(SuggestionResidueError)
    expect(save(live, L, baseDoc(live.view.state))).toBe(SRC)
  })

  it('accept one by id and reject the other: only the accepted text reaches the .md', () => {
    const L = reset()
    type('quick', 'slow')
    type('lazy', 'sleepy')
    const [a, b] = ids()
    const v = live.view
    applySuggestion(a!)(v.state, v.dispatch)
    revertSuggestion(b!)(v.state, v.dispatch)
    expect(ids()).toEqual([])
    expect(save(live, L, v.state.doc)).toBe(SRC.replace('quick', 'slow'))
  })

  it('pressing Enter at the end of a list item in Suggesting mode tracks the new item (S2-b)', () => {
    const L = reset()
    const v = live.view
    const at = posOf('one') + 3
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at)))
    v.dispatch(v.state.tr.split(at, 2))
    // the new, empty list item carries the insertion: S2-b is what lets the mark sit inside bullet_list / list_item
    expect(marksOn(v.state.doc).some((m) => m.endsWith(':insertion'))).toBe(true)
    v.dispatch(v.state.tr.insertText('new'))
    expect(save(live, L, baseDoc(v.state))).toBe(SRC)
    const rejected = revertAll(v.state)
    expect(save(live, L, rejected.doc)).toBe(SRC)
    applySuggestions(v.state, v.dispatch)
    const accepted = save(live, L, v.state.doc)
    // suggest-changes 0.1.8 holds an empty inserted textblock open with a U+200B, and accepting keeps it: that is
    // residue P2's accept path must strip (contract-changes/P1.md, 2026-10-15). Modulo it, the accept is exact.
    expect(accepted).toContain('\u200b')
    expect(accepted.replace(/\u200b/g, '')).toBe(SRC.replace('- item one\n', '- item one\n- new\n'))
  })
})
