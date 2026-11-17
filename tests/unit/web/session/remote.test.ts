// tests/unit/web/session/remote.test.ts (P2). Remote changes: reload preserving cursor and scroll (CONTRACTS §12.6,
// §13 #8, #10): the minimal replace keeps node identity, marks and the selection of untouched blocks, restores a
// selection inside a replaced block by offset, never replaces preserved (held) blocks, skips insertion-marked top-level
// nodes; the parity guard turns a block-map mismatch into CONTRACT_MISMATCH; a dirty editor flushes before reloading
// and Claude's adjacent-block edit merges without a conflict.
import { history, undo } from '@milkdown/kit/prose/history'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Md } from '../../../../core/md/index'
import { load } from '../../../../core/splice/load'
import type { DocSnapshot, SaveRequest } from '../../../../shared/types'
import { buildMinimalReplaceTr, checkParity, planMinimalReplace } from '../../../../web/src/session/remote'
import { sharedMd } from '../../../fakes/FakeDocStore'
import { bodiesTo, fixture, TestPort, tick, until, type Fixture } from './helpers'

const A = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'
const B = '# Title\n\nFirst paragraph here.\n\nSecond paragraph, changed remotely.\n\nThird paragraph here.\n'

let md: Md
beforeAll(async () => {
  md = await sharedMd()
})

const posOf = (doc: PMNode, index: number): number => {
  let p = 0
  for (let i = 0; i < index; i++) p += doc.child(i).nodeSize
  return p
}

describe('minimal replace (§12.6 step 5)', () => {
  it('replaces only the changed run; untouched top-level nodes keep their identity', () => {
    const prev = load(md, A)
    const next = load(md, B)
    const state = EditorState.create({ doc: prev.doc })
    const tr = buildMinimalReplaceTr(state, prev, next)!
    expect(tr.getMeta('addToHistory')).toBe(false)
    expect(tr.getMeta('mdr')).toEqual({ origin: 'reload' })
    const after = state.apply(tr).doc
    expect(after.childCount).toBe(4)
    for (const i of [0, 1, 3]) expect(after.child(i)).toBe(state.doc.child(i))
    expect(after.child(2)).not.toBe(state.doc.child(2))
    expect(after.child(2).textContent).toBe('Second paragraph, changed remotely.')
  })

  it('a caret in an untouched block maps through; a caret inside a replaced block is restored by offset', () => {
    const prev = load(md, A)
    const next = load(md, B)
    let state = EditorState.create({ doc: prev.doc })
    // caret 5 characters into "Third paragraph here."
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, 3) + 1 + 5)))
    const after = state.apply(buildMinimalReplaceTr(state, prev, next)!)
    const $h = after.selection.$head
    expect($h.parent.textContent).toBe('Third paragraph here.')
    expect($h.parentOffset).toBe(5)

    // caret 7 characters into the block that changes
    let s2 = EditorState.create({ doc: prev.doc })
    s2 = s2.apply(s2.tr.setSelection(TextSelection.create(s2.doc, posOf(s2.doc, 2) + 1 + 7)))
    const a2 = s2.apply(buildMinimalReplaceTr(s2, prev, next)!)
    expect(a2.selection.$head.parent.textContent).toBe('Second paragraph, changed remotely.')
    expect(a2.selection.$head.parentOffset).toBe(7)
  })

  it('a preserved (held) block keeps TJ\'s text while the rest of the run is replaced', () => {
    const prev = load(md, A)
    const next = load(md, '# Title\n\nFirst, theirs.\n\nSecond paragraph here.\n\nThird, theirs.\n')
    const state = EditorState.create({ doc: prev.doc })
    const tr = buildMinimalReplaceTr(state, prev, next, { preserve: new Set([prev.blocks[1]!.hash]) })!
    const after = state.apply(tr).doc
    expect(after.child(1)).toBe(state.doc.child(1))
    expect(after.child(3).textContent).toBe('Third, theirs.')
  })

  it('insertion-marked top-level nodes are skipped when mapping entries to live nodes', () => {
    const prev = load(md, A)
    const next = load(md, B)
    const ins = md.schema.marks.insertion!.create({ id: 's_01JAB3K9Q2T7V5X8Y0Z1W2E3R4' })
    const kids: PMNode[] = []
    prev.doc.forEach((n, _o, i) => {
      kids.push(n)
      if (i === 1) kids.push(md.schema.nodes.paragraph!.create(null, md.schema.text('TJ inserted (suggested).'), [ins]))
    })
    const live = prev.doc.type.create(null, kids)
    const runs = planMinimalReplace(live, prev, next)!
    expect(runs).toHaveLength(1)
    expect(live.nodeAt(runs[0]!.from)!.textContent).toBe('Second paragraph here.')
    const after = EditorState.create({ doc: live }).apply(buildMinimalReplaceTr(EditorState.create({ doc: live }), prev, next)!).doc
    expect(after.child(2).textContent).toBe('TJ inserted (suggested).')
    expect(after.child(3).textContent).toBe('Second paragraph, changed remotely.')
  })

  it('TJ\'s undo is mapped through the reload: it reverts his typing and never undoes Claude\'s change', () => {
    const prev = load(md, A)
    let state = EditorState.create({ doc: prev.doc, plugins: [history()] })
    // TJ types into the first paragraph (a history entry)
    const p1 = posOf(state.doc, 1) + 1
    state = state.apply(state.tr.insertText('TJ: ', p1))
    // Claude changes the second paragraph; TJ's edit was saved, so the new base holds both
    const base2 = load(md, A.replace('First paragraph here.', 'TJ: First paragraph here.'))
    const next = load(md, A.replace('First paragraph here.', 'TJ: First paragraph here.').replace('Second paragraph here.', 'Second, by Claude.'))
    state = state.apply(buildMinimalReplaceTr(state, base2, next)!)
    expect(state.doc.child(2).textContent).toBe('Second, by Claude.')
    let undone: EditorState | null = null
    undo(state, (tr) => {
      undone = state.apply(tr)
    })
    expect(undone).not.toBeNull()
    expect(undone!.doc.child(1).textContent).toBe('First paragraph here.')
    expect(undone!.doc.child(2).textContent).toBe('Second, by Claude.')
  })

  it('returns null when the live doc no longer lines up with the base and the change has nowhere to land (the caller replaces everything)', () => {
    const prev = load(md, A)
    // TJ deleted the block Claude changed
    const kids = Array.from({ length: prev.doc.childCount }, (_, i) => prev.doc.child(i)).filter((_, i) => i !== 2)
    expect(planMinimalReplace(prev.doc.type.create(null, kids), prev, load(md, B))).toBeNull()
    // TJ's new block sits inside the run Claude changed
    const inside = prev.doc.type.create(null, [prev.doc.child(0), prev.doc.child(1), md.schema.nodes.paragraph!.create(null, md.schema.text('x')), prev.doc.child(2), prev.doc.child(3)])
    const wide = load(md, '# Title\n\nFirst, theirs.\n\nSecond, theirs.\n\nThird paragraph here.\n')
    expect(planMinimalReplace(inside, prev, wide)).toBeNull()
  })

  it('a block TJ added since the base (Enter typed while a save was on the wire) stays; the change elsewhere is replayed around it', () => {
    const prev = load(md, A)
    const kids = Array.from({ length: prev.doc.childCount }, (_, i) => prev.doc.child(i))
    const mine = md.schema.nodes.paragraph!.create(null, md.schema.text('TJ typed this since.'))
    for (const at of [1, 3, 4]) {
      const live = prev.doc.type.create(null, [...kids.slice(0, at), mine, ...kids.slice(at)])
      const state = EditorState.create({ doc: live })
      const runs = planMinimalReplace(live, prev, load(md, B))!
      expect(runs).toHaveLength(1)
      expect(live.nodeAt(runs[0]!.from)!.textContent).toBe('Second paragraph here.')
      const after = state.apply(buildMinimalReplaceTr(state, prev, load(md, B))!).doc
      expect(after.childCount).toBe(5)
      expect(after.child(at)).toBe(mine)
      expect(after.textContent).toContain('Second paragraph, changed remotely.')
    }
  })

  it('a block TJ removed since the base: a change to the others is replayed', () => {
    const prev = load(md, A)
    const live = prev.doc.type.create(null, [prev.doc.child(0), prev.doc.child(2), prev.doc.child(3)])
    const next = load(md, A.replace('Third paragraph here.', 'Third, changed remotely.'))
    const state = EditorState.create({ doc: live })
    const after = state.apply(buildMinimalReplaceTr(state, prev, next)!).doc
    expect(after.childCount).toBe(3)
    expect(after.child(2).textContent).toBe('Third, changed remotely.')
  })

  it('an identical next yields no transaction', () => {
    const prev = load(md, A)
    expect(buildMinimalReplaceTr(EditorState.create({ doc: prev.doc }), prev, load(md, A))).toBeNull()
  })
})

describe('parity guard (§12.6 step 3, G6 in production)', () => {
  it('identical maps pass; a hash or offset difference is reported', () => {
    const L = load(md, A)
    expect(checkParity(L, L.blocks)).toBeNull()
    const bad = L.blocks.map((b, i) => (i === 2 ? { ...b, end: b.end + 1 } : b))
    expect(checkParity(L, bad)).toMatchObject({ expected: expect.stringContaining('b3'), actual: expect.stringContaining('b3') })
    expect(checkParity(L, L.blocks.slice(1))).not.toBeNull()
  })
})

const DOC = 'doc.md'
let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

describe('the reload path in the session', () => {
  it('Claude edits the block next to the one TJ is typing in: flush first, merged, no conflict, cursor kept (§13 #8, #10)', async () => {
    fx = await fixture({ file: DOC, markdown: A })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1)
    await tick(30)
    port.setText(1, 'First paragraph, TJ typing.')
    port.caret(1, 5)
    await fx.agent([{ op: 'replace_block', target: { quote: 'Second paragraph here.' }, markdown: 'Second paragraph, Claude.' }])
    await until(() => port.text(2) === 'Second paragraph, Claude.', 3_000, 'Claude\'s block applied')
    await until(() => session.getSaveState().state === 'saved', 3_000, 'saved')
    expect(session.getConflicts()).toEqual([])
    expect(port.text(1)).toBe('First paragraph, TJ typing.')
    expect(port.state.selection.$head.parent.textContent).toBe('First paragraph, TJ typing.')
    expect(port.state.selection.$head.parentOffset).toBe(5)
    expect(fx.root.read(DOC)).toBe('# Title\n\nFirst paragraph, TJ typing.\n\nSecond paragraph, Claude.\n\nThird paragraph here.\n')
    // the flush went out before the reload adopted Claude's change
    expect(bodiesTo<SaveRequest>(transport, '/api/save').length).toBeGreaterThanOrEqual(1)
  })

  it('a snapshot whose blocks our load() cannot reproduce makes the page read-only CONTRACT_MISMATCH', async () => {
    fx = await fixture({ file: DOC, markdown: A })
    const port = await TestPort.create()
    const { session, transport } = await fx.open({ port })
    await until(() => transport.openStreamCount() === 1)
    await tick(30)
    // the server reports a changed doc whose block map our load() does not reproduce
    const real = (await (await fx.fa.store(DOC)).snapshot()) as DocSnapshot
    const changed = load(md, B)
    const served: DocSnapshot = {
      ...real, rev: real.rev + 1, hash: 'f'.repeat(64), markdown: B,
      blocks: changed.blocks.map((b, i) => (i === 1 ? { ...b, hash: '0'.repeat(16) } : b)),
    }
    transport.intercept((req) => (req.path.startsWith('/api/doc') ? { status: 200, json: served } : undefined))
    transport.emit({
      event: 'doc-changed',
      data: { file: DOC, rev: served.rev, prevRev: real.rev, hash: served.hash, by: 'external', cause: 'external', changes: [] },
    })
    await until(() => session.getBanner()?.kind === 'contract-mismatch', 3_000, 'banner')
    expect(session.getSaveState()).toMatchObject({ state: 'readonly', code: 'CONTRACT_MISMATCH' })
    expect(port.editable).toBe(false)
  })
})
