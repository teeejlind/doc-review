// tests/unit/core/suggest/helpers.ts (P2). Headless fixtures for the core/suggest tests: a loaded doc in an
// EditorState with the suggest-changes plugin and the I-ID guard, plus helpers that type the way the live editor
// dispatches (a plain user transaction, transformed by suggest-changes in Suggesting mode).
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { suggestChanges, suggestChangesKey, transformToSuggestionTransaction } from '@handlewithcare/prosemirror-suggest-changes'
import { ulid } from 'ulid'
import { createMd, type Md } from '../../../../core/md/index'
import { applyBlockOps } from '../../../../core/splice/apply'
import { contentNodes, nodeEq } from '../../../../core/splice/eq'
import { planSave } from '../../../../core/splice/plan'
import { load, type Loaded } from '../../../../core/splice/load'
import { fromBlock, fromQuote } from '../../../../core/suggest/record'
import { idGuard, isProgrammaticTr, markIdOf, kindOf } from '../../../../core/suggest/guards'
import type { Author, Suggestion, SuggestionBody, SuggestionId, ThreadId } from '../../../../shared/types'

let mdP: Promise<Md> | null = null
export function md(): Promise<Md> {
  mdP ??= createMd()
  return mdP
}

export interface Doc {
  md: Md
  L: Loaded
  state: EditorState
  claude: Set<SuggestionId>
}

export async function docOf(text: string, o: { suggesting?: boolean } = {}): Promise<Doc> {
  const m = await md()
  const L = load(m, text)
  const claude = new Set<SuggestionId>()
  let state = EditorState.create({
    doc: L.doc,
    plugins: [
      suggestChanges(),
      idGuard({ isTjOwned: (id) => !claude.has(id), mintId: () => `s_${ulid()}` as SuggestionId, isProgrammatic: isProgrammaticTr }),
    ],
  })
  if (o.suggesting) state = state.apply(state.tr.setMeta(suggestChangesKey, { skip: true, enabled: true }))
  return { md: m, L, state, claude }
}

let n = 0
/** A canonical record as the server would hold it. */
export function record(body: SuggestionBody, o: { id?: SuggestionId; by?: Author } = {}): Suggestion {
  n++
  return {
    ...body,
    id: o.id ?? (`s_C${n}` as SuggestionId),
    thread: `t_${n}` as ThreadId,
    by: o.by ?? 'Claude',
    status: 'pending',
    anchor: { kind: 'text', quote: '', prefix: '', suffix: '', hint: { rev: 0, pos: 0, block: 0, blockHash: '', offsetInBlock: 0 } },
    createdSeq: n,
    updatedSeq: n,
    located: null,
  }
}

export const claudeQuote = (d: Doc, quote: string, replace: string, id?: SuggestionId): Suggestion => {
  const r = record(fromQuote(d.md, d.L, { quote, replace }), id ? { id } : {})
  d.claude.add(r.id)
  return r
}
export const claudeBlock = (d: Doc, block: number, markdown: string): Suggestion => {
  const r = record(fromBlock(d.md, d.L, block, markdown))
  d.claude.add(r.id)
  return r
}

/** Position of the first occurrence of `text` in the doc's text (ProseMirror positions). */
export function find(doc: PMNode, text: string, nth = 0): { from: number; to: number } {
  let hit: { from: number; to: number } | null = null
  let k = 0
  doc.descendants((node, pos) => {
    if (hit) return false
    if (!node.isText) return true
    let i = node.text!.indexOf(text)
    while (i >= 0) {
      if (k === nth) {
        hit = { from: pos + i, to: pos + i + text.length }
        return false
      }
      k++
      i = node.text!.indexOf(text, i + 1)
    }
    return true
  })
  if (!hit) throw new Error(`text not found: ${text}`)
  return hit
}

/** Dispatch the way the editor does: a user transaction, transformed by suggest-changes when Suggesting is on. */
export function userDispatch(d: Doc, tr: Transaction, genId: () => SuggestionId = () => `s_${ulid()}` as SuggestionId): Doc {
  const enabled = !!suggestChangesKey.getState(d.state)?.enabled
  const t = enabled && !tr.getMeta(suggestChangesKey) ? transformToSuggestionTransaction(tr, d.state, genId) : tr
  return { ...d, state: d.state.apply(t) }
}

export function typeAt(d: Doc, pos: number, text: string, genId?: () => SuggestionId): Doc {
  const tr = d.state.tr.setSelection(TextSelection.create(d.state.doc, pos)).insertText(text, pos)
  return userDispatch(d, tr, genId)
}

export function replaceText(d: Doc, from: number, to: number, text: string, genId?: () => SuggestionId): Doc {
  return userDispatch(d, d.state.tr.insertText(text, from, to), genId)
}

/** Every (kind, id, text) suggestion segment, in order. */
export function marks(doc: PMNode): Array<{ kind: string; id: string; text: string }> {
  const out: Array<{ kind: string; id: string; text: string }> = []
  doc.descendants((node) => {
    for (const m of node.marks) {
      const k = kindOf(m)
      if (k) out.push({ kind: k, id: markIdOf(m), text: node.isText ? node.text! : `<${node.type.name}>` })
    }
    return true
  })
  return out
}

export function sameContent(a: PMNode, b: PMNode | PMNode[]): boolean {
  const x = contentNodes(a)
  const y = Array.isArray(b) ? b : contentNodes(b)
  return x.length === y.length && x.every((nd, i) => nodeEq(nd, y[i]!))
}

/** What an Editing-mode save of `doc` (no suggestion marks) writes, re-loaded: markdown's own normal form. */
export function savedDoc(d: Pick<Doc, 'md' | 'L'>, doc: PMNode): PMNode {
  return load(d.md, applyBlockOps(d.md, d.L, planSave(d.md, d.L, doc)).text).doc
}
