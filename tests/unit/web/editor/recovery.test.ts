// tests/unit/web/editor/recovery.test.ts (P2; CONTRACTS §7.4, §12.5, §12.6, §13 #9, #62). The editor side of
// conflicts (decoration on the held block, take theirs), draft restore on open, and Suggesting-mode deletions that
// cross a block boundary (struck per block, never a join).
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { EditorState } from '@milkdown/kit/prose/state'
import { draftKey, memoryDraftStore } from '../../../../web/src/session/drafts'
import { load } from '../../../../core/splice/load'
import { TESTID } from '../../../../shared/constants'
import type { DraftRecord } from '../../../../shared/types'
import type { SaveRequest } from '../../../../shared/types'
import { bodiesTo, fixture } from '../session/helpers'
import { find, marksOf, mount, replace, tick, until, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'

describe('conflicts (§7.4)', () => {
  it('a same-block conflict keeps TJ text with a conflict decoration; take theirs restores the disk text', async () => {
    m = await mount({ markdown: MD })
    replace(m.view, 'Second paragraph', 'Second paragraph, mine,')
    // Claude rewrites the same block on disk before the autosave lands
    await m.fx.agent([{ op: 'replace_block', target: { quote: 'Second paragraph here.' }, markdown: 'Second paragraph, theirs.' } as never])
    await m.session.flush().catch(() => undefined)
    await until(() => m!.session.getConflicts().length === 1, 5_000, 'conflict')
    const c = m.session.getConflicts()[0]!
    expect(c.kind).toBe('conflict')
    expect(m.view.state.doc.textContent).toContain('Second paragraph, mine, here.')
    await until(() => !!m!.host.querySelector(`[data-testid="${TESTID.conflictBlock}"]`))
    expect(m.host.querySelector<HTMLElement>(`[data-testid="${TESTID.conflictBlock}"]`)!.dataset.conflict).toBe(c.id)
    expect(m.fx.root.read('doc.md')).toContain('Second paragraph, theirs.')
    await m.bridge.resolveConflict(c.id, 'theirs')
    expect(m.view.state.doc.textContent).toContain('Second paragraph, theirs.')
    expect(m.view.state.doc.textContent).not.toContain('mine')
    expect(m.session.getConflicts()).toEqual([])
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toContain('Second paragraph, theirs.')
  })
})

describe('drafts (§12.5)', () => {
  it('a draft on the same base is restored into the live doc and saved', async () => {
    const fx = await fixture({ file: 'doc.md', markdown: MD })
    const drafts = memoryDraftStore()
    const snapRes = await fx.fa.fetch(new Request(`http://127.0.0.1:${fx.fa.port}/api/doc?file=doc.md`, { headers: { Authorization: `Bearer ${fx.fa.token}`, 'X-MDR-Client': 'web' } }))
    const snap = (await snapRes.json()) as { hash: string; rev: number; docId: string | null }
    // the draft: the loaded doc with an unsaved edit in paragraph 3
    const { sharedMd } = await import('../../../fakes/FakeDocStore')
    const md = await sharedMd()
    const L = load(md, MD)
    const st = EditorState.create({ doc: L.doc })
    let pos = -1
    st.doc.descendants((n, p) => {
      if (pos < 0 && n.isText && n.text!.startsWith('Third')) pos = p
      return pos < 0
    })
    const edited = st.apply(st.tr.insertText('Restored ', pos)).doc
    const rec: DraftRecord = {
      v: 1, docId: snap.docId as never, baseRev: snap.rev, baseHash: snap.hash, baseMarkdown: MD, liveDoc: edited.toJSON(), mode: 'editing',
      selection: null, heldConflicts: [], savedAt: new Date().toISOString(),
    }
    await drafts.set(draftKey(fx.boot.rootHash, 'doc.md'), rec)
    m = await mount({ markdown: MD, fx, env: { drafts } })
    await until(() => m!.view.state.doc.textContent.includes('Restored Third'))
    await m.session.flush()
    await until(() => m!.fx.root.read('doc.md').includes('Restored Third paragraph here.'))
  })

  // QA3 R1 (server-store): typing then reloading within the autosave window restored the draft by swapping the whole
  // doc, which collapsed every comment highlight; the draft save then reported all of them as deleted and the server
  // detached every thread, permanently, even in paragraphs nobody touched.
  async function mountWithDraftAndComments(edit: (draftDoc: EditorState) => EditorState): Promise<Mounted> {
    const fx = await fixture({ file: 'doc.md', markdown: MD })
    await fx.agent([
      { op: 'comment', quote: 'First paragraph here.', body: 'Note on first' },
      { op: 'comment', quote: 'Third paragraph here.', body: 'Note on third' },
    ] as never)
    const drafts = memoryDraftStore()
    const snapRes = await fx.fa.fetch(new Request(`http://127.0.0.1:${fx.fa.port}/api/doc?file=doc.md`, { headers: { Authorization: `Bearer ${fx.fa.token}`, 'X-MDR-Client': 'web' } }))
    const snap = (await snapRes.json()) as { hash: string; rev: number; docId: string | null }
    const { sharedMd } = await import('../../../fakes/FakeDocStore')
    const md = await sharedMd()
    const L = load(md, MD)
    const edited = edit(EditorState.create({ doc: L.doc })).doc
    const rec: DraftRecord = {
      v: 1, docId: snap.docId as never, baseRev: snap.rev, baseHash: snap.hash, baseMarkdown: MD, liveDoc: edited.toJSON(), mode: 'editing',
      selection: null, heldConflicts: [], savedAt: new Date().toISOString(),
    }
    await drafts.set(draftKey(fx.boot.rootHash, 'doc.md'), rec)
    return mount({ markdown: MD, fx, env: { drafts } })
  }
  const typedIn = (text: string, insert: string) => (st: EditorState): EditorState => {
    let pos = -1
    st.doc.descendants((n, p) => {
      if (pos < 0 && n.isText && n.text!.startsWith(text)) pos = p
      return pos < 0
    })
    return st.apply(st.tr.insertText(insert, pos))
  }
  const threadStates = (mm: Mounted): Array<{ q: string; detached: boolean }> =>
    mm.session.getReview().threads.map((t) => ({ q: t.anchor.kind === 'text' ? t.anchor.quote : '', detached: t.detached }))

  it('restoring a draft keeps every comment highlight and never reports an anchor as deleted (QA3 R1)', async () => {
    m = await mountWithDraftAndComments(typedIn('Second', 'ZZ '))
    await until(() => m!.view.state.doc.textContent.includes('ZZ Second'))
    // both highlights are back on the restored doc, over the right text
    await until(() => m!.host.querySelectorAll('[data-testid="mdr-highlight"]').length >= 2, 3_000, 'highlights after restore')
    const hl = [...m.host.querySelectorAll('[data-testid="mdr-highlight"]')].map((e) => e.textContent)
    expect(hl.join('|')).toContain('First paragraph here.')
    expect(hl.join('|')).toContain('Third paragraph here.')
    await m.session.flush()
    await until(() => m!.fx.root.read('doc.md').includes('ZZ Second paragraph here.'))
    const sent = bodiesTo<SaveRequest>(m.transport, '/api/save').flatMap((s) => s.anchors ?? [])
    expect(sent.filter((a) => a.anchor === null)).toEqual([])
    await tick(300) // the review refresh that follows a save carrying anchors
    expect(threadStates(m).every((t) => !t.detached)).toBe(true)
  })

  const at = (st: EditorState, text: string, plus = 0): number => {
    let pos = -1
    st.doc.descendants((n, p) => {
      if (pos < 0 && n.isText && n.text!.startsWith(text)) pos = p
      return pos < 0
    })
    return pos + plus
  }
  it.each([
    ['typing inside the commented text', (st: EditorState) => st.apply(st.tr.insertText('big ', at(st, 'First paragraph', 6)))],
    ['a paragraph split (Enter) in an untouched block', (st: EditorState) => st.apply(st.tr.split(at(st, 'Second paragraph', 7)))],
    ['deleting part of the commented text', (st: EditorState) => st.apply(st.tr.delete(at(st, 'Third paragraph', 5), at(st, 'Third paragraph', 15)))],
  ])('a draft with %s keeps both threads attached and highlighted (QA3 R1)', async (_name, edit) => {
    m = await mountWithDraftAndComments(edit)
    await tick(300)
    await m.session.flush()
    await tick(500)
    const sent = bodiesTo<SaveRequest>(m.transport, '/api/save').flatMap((x) => x.anchors ?? [])
    expect(sent.filter((a) => a.anchor === null)).toEqual([])
    expect(threadStates(m).every((t) => !t.detached)).toBe(true)
    expect(m.host.querySelectorAll('[data-testid="mdr-highlight"]').length).toBeGreaterThanOrEqual(2)
  })

  it('a draft that really deleted the commented text still detaches just that thread', async () => {
    m = await mountWithDraftAndComments((st) => {
      let from = -1
      st.doc.descendants((n, p) => {
        if (from < 0 && n.isText && n.text!.startsWith('Third paragraph here.')) from = p
        return from < 0
      })
      return st.apply(st.tr.delete(from, from + 'Third paragraph here.'.length))
    })
    await until(() => !m!.view.state.doc.textContent.includes('Third paragraph'))
    await m.session.flush()
    await until(() => m!.session.getReview().threads.some((t) => t.detached), 5_000, 'third thread detached')
    const ts = m.session.getReview().threads
    expect(ts.filter((t) => t.detached).map((t) => (t.anchor.kind === 'text' ? t.anchor.quote : ''))).toEqual(['Third paragraph here.'])
    expect(ts.filter((t) => !t.detached)).toHaveLength(1)
  })
})

describe('Suggesting-mode deletion across blocks', () => {
  it('Backspace over a selection spanning two paragraphs strikes each part; the blocks stay two, the base stays put', async () => {
    m = await mount({ markdown: MD })
    m.bridge.setMode('suggesting')
    const a = find(m.view, 'paragraph here', 0).from
    const b = find(m.view, 'Second').to
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, a, b)))
    const blocks = m.view.state.doc.childCount
    m.ed.runAction('backspace', m.view)
    expect(m.view.state.doc.childCount).toBe(blocks)
    const del = marksOf(m.view).filter((x) => x.kind === 'deletion')
    expect(del.map((x) => x.text).join('')).toBe('paragraph here.Second')
    expect(new Set(del.map((x) => x.id)).size).toBe(1)
    expect(marksOf(m.view).filter((x) => x.kind === 'insertion')).toEqual([])
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe(MD)
  })
})
