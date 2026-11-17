// tests/unit/web/editor/decisions.test.ts (P2; CONTRACTS §6.3, §6.6, D26, §13 #40, #48, #72, #79). Decisions from the
// bridge through the session queue into the editor: accept / reject applied with skip meta and journaled; undo sends a
// reopen (a bulk undo is ONE atomic bulk reopen) before any save; redo replays; a refused undo re-applies with
// UNDO_CANCELLED; an unplaced (SCHEMA) accept adopts the server text through the reload path and still undoes.
import { afterEach, describe, expect, it } from 'vitest'
import type { BulkDecisionRequest, SaveRequest, SuggestionId } from '../../../../shared/types'
import { bodiesTo } from '../session/helpers'
import { find, marksOf, mount, until, userTr, type Mounted } from './helpers'

const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\n```js\nconst a = 1\n```\n'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const writes = (mm: Mounted): string[] => mm.transport.requests.filter((r) => r.method !== 'GET').map((r) => r.path.split('?')[0]!)
const ids = (mm: Mounted): SuggestionId[] => mm.session.getReview().suggestions.map((s) => s.id)
const status = (mm: Mounted, id: SuggestionId): string | undefined => mm.session.getReview().suggestions.find((s) => s.id === id)?.status

describe('accept and reject (§6.6)', () => {
  it('accept writes the suggester bytes, removes the marks, and leaves nothing to save', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' }] })
    const [id] = ids(m)
    expect(marksOf(m.view).length).toBeGreaterThan(0)
    expect(await m.bridge.accept(id!)).toEqual({ ok: true })
    expect(m.fx.root.read('doc.md')).toContain('Opening paragraph here.')
    expect(marksOf(m.view)).toEqual([])
    expect(m.view.state.doc.textContent).toContain('Opening paragraph here.')
    await m.session.flush()
    expect(bodiesTo<SaveRequest>(m.transport, '/api/save').filter((s) => s.ops.length > 0)).toEqual([])
    await until(() => status(m!, id!) === 'accepted')
  })

  it('two rapid accepts apply once (§13 #40)', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'Second paragraph', replace: 'Middle paragraph' }] })
    const [id] = ids(m)
    const [a, b] = await Promise.all([m.bridge.accept(id!), m.bridge.accept(id!)])
    expect(a.ok && b.ok).toBe(true)
    expect(writes(m).filter((p) => p.endsWith('/accept'))).toHaveLength(1)
    expect(m.fx.root.read('doc.md').match(/Middle paragraph/g)).toHaveLength(1)
  })

  it('reject reverts the marks and writes nothing', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' }] })
    const [id] = ids(m)
    expect(await m.bridge.reject(id!)).toEqual({ ok: true })
    expect(marksOf(m.view)).toEqual([])
    expect(m.view.state.doc.textContent).toContain('First paragraph here.')
    expect(m.fx.root.read('doc.md')).toBe(MD)
  })
})

describe('undo and redo across decisions (§6.6, D26)', () => {
  it('undo of an accept sends a reopen before any save; the base comes back and the marks are live again; redo replays', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' }] })
    const [id] = ids(m)
    await m.bridge.accept(id!)
    await until(() => status(m!, id!) === 'accepted')
    m.ed.runAction('undo', m.view)
    expect(marksOf(m.view).every((x) => x.id === id)).toBe(true)
    expect(marksOf(m.view).length).toBeGreaterThan(0)
    await m.session.flush()
    const w = writes(m)
    expect(w).toContain(`/api/suggestions/${id}/reopen`)
    expect(bodiesTo<SaveRequest>(m.transport, '/api/save').filter((s) => s.ops.length > 0)).toEqual([])
    expect(bodiesTo<SaveRequest>(m.transport, '/api/save').every((s) => !('reopen' in (s.suggestions ?? {})))).toBe(true)
    expect(m.fx.root.read('doc.md')).toBe(MD)
    await until(() => status(m!, id!) === 'pending')
    // redo: the decision is replayed through the server with a fresh opKey
    m.ed.runAction('redo', m.view)
    await until(() => status(m!, id!) === 'accepted')
    expect(m.fx.root.read('doc.md')).toContain('Opening paragraph here.')
    expect(writes(m).filter((p) => p.endsWith('/accept'))).toHaveLength(2)
  })

  it('an undo right after the accept resolves, before any review refresh, still sends the reopen and saves nothing', async () => {
    // the real server's timing: Cmd+Z can land inside REVIEW_DEBOUNCE_MS of the accept, while the held review state
    // still says 'pending'; the planner must read the decision the server already confirmed
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' }] })
    const [id] = ids(m)
    const reviewGets = (): number => m!.transport.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/api/review')).length
    const before = reviewGets()
    await m.bridge.accept(id!)
    expect(reviewGets()).toBe(before)
    expect(status(m, id!)).toBe('accepted')
    m.ed.runAction('undo', m.view)
    await m.session.flush()
    expect(writes(m)).toContain(`/api/suggestions/${id}/reopen`)
    expect(bodiesTo<SaveRequest>(m.transport, '/api/save').filter((s) => s.ops.length > 0)).toEqual([])
    expect(m.fx.root.read('doc.md')).toBe(MD)
    await until(() => status(m!, id!) === 'pending')
  })

  it('a decided record leaves the summaries at once (never a passing unplaced card); its undo brings the card back before the reopen', async () => {
    m = await mount({
      markdown: MD,
      claude: [
        { op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' },
        { op: 'suggest', quote: 'Second paragraph', replace: 'Middle paragraph' },
      ],
    })
    const [a, b] = ids(m)
    await m.bridge.accept(a!)
    await m.bridge.reject(b!)
    // before any review refresh: neither record is summarized (no 'BASE_NOT_FOUND' card for what TJ just decided)
    expect([...m.bridge.getSuggestionSummaries().keys()]).toEqual([])
    m.ed.runAction('undo', m.view) // undoes the reject
    m.ed.runAction('undo', m.view) // undoes the accept
    const back = m.bridge.getSuggestionSummaries()
    expect(new Set(back.keys())).toEqual(new Set([a, b]))
    expect([...back.values()].every((s) => s.placed)).toBe(true)
    await m.session.flush()
    await until(() => status(m!, a!) === 'pending' && status(m!, b!) === 'pending')
    expect([...m.bridge.getSuggestionSummaries().values()].every((s) => s.placed)).toBe(true)
  })

  it('accept → undo → redo before the reopen is sent redoes locally: the server keeps one accept, nothing is replayed', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' }] })
    const [id] = ids(m)
    await m.bridge.accept(id!)
    m.ed.runAction('undo', m.view)
    m.ed.runAction('redo', m.view)
    await m.session.flush()
    expect(writes(m).filter((p) => p.startsWith('/api/suggestions'))).toEqual([`/api/suggestions/${id}/accept`])
    expect(bodiesTo<SaveRequest>(m.transport, '/api/save').filter((s) => s.ops.length > 0)).toEqual([])
    expect(marksOf(m.view)).toEqual([])
    expect(m.fx.root.read('doc.md')).toContain('Opening paragraph here.')
    await until(() => status(m!, id!) === 'accepted')
  })

  it('the same for a bulk accept: an immediate undo is ONE atomic bulk reopen, never a save', async () => {
    m = await mount({
      markdown: MD,
      claude: [
        { op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' },
        { op: 'suggest', quote: 'Second paragraph', replace: 'Middle paragraph' },
      ],
    })
    await m.bridge.acceptAll({ by: 'Claude' })
    expect(ids(m).map((id) => status(m!, id))).toEqual(['accepted', 'accepted'])
    m.ed.runAction('undo', m.view)
    await m.session.flush()
    expect(bodiesTo<BulkDecisionRequest>(m.transport, '/api/suggestions/bulk').map((b) => b.decision)).toEqual(['accept', 'reopen'])
    expect(bodiesTo<SaveRequest>(m.transport, '/api/save').filter((s) => s.ops.length > 0)).toEqual([])
    expect(m.fx.root.read('doc.md')).toBe(MD)
  })

  it('accept all from Claude is one request and one undo entry; its undo is ONE atomic bulk reopen', async () => {
    m = await mount({
      markdown: MD,
      claude: [
        { op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' },
        { op: 'suggest', quote: 'Second paragraph', replace: 'Middle paragraph' },
      ],
    })
    const r = await m.bridge.acceptAll({ by: 'Claude' })
    expect(r?.results.every((x) => x.ok)).toBe(true)
    expect(writes(m).filter((p) => p.endsWith('/bulk'))).toHaveLength(1)
    expect(m.ed.journal.done).toHaveLength(1)
    expect(marksOf(m.view)).toEqual([])
    await until(() => ids(m!).every((id) => status(m!, id) === 'accepted'))
    m.ed.runAction('undo', m.view)
    expect(new Set(marksOf(m.view).map((x) => x.id))).toEqual(new Set(ids(m)))
    await m.session.flush()
    const bulks = bodiesTo<BulkDecisionRequest>(m.transport, '/api/suggestions/bulk')
    expect(bulks.map((b) => b.decision)).toEqual(['accept', 'reopen'])
    expect(new Set(bulks[1]!.ids)).toEqual(new Set(ids(m)))
    expect(m.fx.root.read('doc.md')).toBe(MD)
  })

  it('a refused bulk undo (a text changed since) re-applies the decision and raises UNDO_CANCELLED (§13 #79)', async () => {
    m = await mount({
      markdown: MD,
      claude: [
        { op: 'suggest', quote: 'First paragraph', replace: 'Opening paragraph' },
        { op: 'suggest', quote: 'Second paragraph', replace: 'Middle paragraph' },
      ],
    })
    await m.bridge.acceptAll({ by: 'Claude' })
    await until(() => ids(m!).every((id) => status(m!, id) === 'accepted'))
    // Claude edits one of the accepted texts on disk; the page reloads it
    await m.fx.agent([{ op: 'replace_block', target: { quote: 'Middle paragraph here.' }, markdown: 'Middle paragraph, edited by Claude.' } as never])
    await until(() => m!.view.state.doc.textContent.includes('edited by Claude'))
    m.ed.runAction('undo', m.view)
    await m.session.flush().catch(() => undefined)
    await until(() => m!.notices.some((n) => n.code === 'UNDO_CANCELLED'))
    expect(marksOf(m.view)).toEqual([])
    expect(m.fx.root.read('doc.md')).toContain('Opening paragraph here.')
    expect(m.fx.root.read('doc.md')).toContain('edited by Claude')
  })

  it('an unplaced (SCHEMA) accept adopts the server text through the reload path and its undo reopens (§13 #72)', async () => {
    m = await mount({ markdown: MD, claude: [{ op: 'suggest_block', target: { quote: 'const a = 1' }, markdown: '```js\nconst a = 2\n```' }] })
    const [id] = ids(m)
    expect(m.bridge.getSuggestionSummaries().get(id!)).toMatchObject({ placed: false, unplaced: 'SCHEMA' })
    expect(await m.bridge.accept(id!)).toEqual({ ok: true })
    expect(m.fx.root.read('doc.md')).toContain('const a = 2')
    await until(() => m!.view.state.doc.textContent.includes('const a = 2'))
    expect(m.ed.journal.done).toHaveLength(1)
    await until(() => status(m!, id!) === 'accepted')
    m.ed.runAction('undo', m.view)
    expect(m.view.state.doc.textContent).toContain('const a = 1')
    await m.session.flush()
    expect(writes(m)).toContain(`/api/suggestions/${id}/reopen`)
    expect(m.fx.root.read('doc.md')).toBe(MD)
  })
})

describe('task toggle in Suggesting mode (§6.5)', () => {
  it('is tracked as one structure record (S2-b: list_item carries the modification mark)', async () => {
    m = await mount({ markdown: '- [ ] task one\n- [x] task two\n' })
    m.bridge.setMode('suggesting')
    const pos = find(m.view, 'task one').from
    const $p = m.view.state.doc.resolve(pos)
    let itemPos = -1
    for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'list_item') itemPos = $p.before(d)
    expect(itemPos).toBeGreaterThanOrEqual(0)
    expect(m.view.state.doc.child(0).type.allowsMarkType(m.view.state.schema.marks.modification!)).toBe(true)
    userTr(m.view, (tr) => tr.setNodeAttribute(itemPos, 'checked', true))
    expect(m.notices).toEqual([])
    const sums = [...m.bridge.getSuggestionSummaries().values()]
    expect(sums).toHaveLength(1)
    expect(sums[0]!.kind).toBe('structure')
    await m.session.flush()
    const up = bodiesTo<SaveRequest>(m.transport, '/api/save').flatMap((s) => s.suggestions?.upsert ?? [])
    expect(up).toHaveLength(1)
    expect(up[0]!.proposed).toContain('- [x] task one')
  })
})
