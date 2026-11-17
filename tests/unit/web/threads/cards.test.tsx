// tests/unit/web/threads/cards.test.tsx (P3; CONTRACTS §6.3, §6.6–§6.8, §7.4, §9.9.1, §11.4, §11.5, §12.9, §12.15,
// §13 rows 37, 41, 72, 84, 90).
//
// The threads UI over the fake session and editor: creating a comment from the floating button, the top bar button
// and Cmd+Opt+M (selection, word at the caret, whole doc, inside a suggestion); reply, edit and delete own, resolve,
// reopen, show-resolved; suggestion rows (accept/reject, in flight, stale, "Shown as a diff", "Can't place this
// inline"), Accept all in thread; conflict and unsaveable cards; the rail header (bulk, policy toggle, unread,
// Detached, doc comments); and that every control carries its §12.15 test id.
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSTANTS, TESTID, TEST_ACTIONS } from '../../../../shared/constants'
import type { BlockConflict, SuggestionSummary, Thread } from '../../../../shared/types'
import { flushAsync, mountRail, suggestionFor, textTarget } from './mount'
import { cid, thread } from '../shell/helpers'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const type = (el: HTMLElement, value: string): void => {
  fireEvent.change(el, { target: { value } })
}
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click()
  })
}
const keyCmdOpt = (target: EventTarget, code: string): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { code, key: code, metaKey: true, altKey: true, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

describe('creating comments (§11.4, R2.1)', () => {
  it('the floating button shows for a selection while the editor has focus, opens the new-comment card level with it, and posts', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 8 })] })
    const btn = m.byTestId('floatingComment') as HTMLButtonElement
    expect(btn.hidden).toBe(true)
    act(() => m.editorRoot().focus())
    m.scriptSelection(textTarget(2, 'topic 2', 120, 144))
    expect(btn.hidden).toBe(false)
    expect(btn.getAttribute('aria-label')).toBe('Comment on the selection')
    // y = clamp(rect.top, viewTop + 8, min(extent.bottom, viewBottom) − 8 − height) = 144 − 38, written from the rail's top
    expect(btn.style.transform).toBe(`translateY(${144 - 8 - 30 - m.frames.at(-1)!.railTop}px)`)
    await click(btn)
    m.frame()
    const draft = m.$<HTMLElement>('[data-draft="true"]')
    expect(draft.dataset.testid).toBe(TESTID.card)
    expect(draft.dataset.active).toBe('true')
    const area = m.byTestId('cardReply', {}, draft) as HTMLTextAreaElement
    expect(document.activeElement).toBe(area)
    expect(m.frames.at(-1)!.anchors.get('t_draft')).toBe(120)
    type(area, 'Tighten this.')
    await click(m.byTestId('cardSubmit', {}, draft))
    await flushAsync()
    const call = m.session.calls.find((c) => c.method === 'createThread')!
    expect(call.args[1]).toBe('Tighten this.')
    expect((call.args[0] as { quote: string }).quote).toBe('topic 2')
    const created = m.session.getReview().threads.at(-1)!
    expect(m.card(created.id).dataset.active).toBe('true')
    expect(document.querySelector('[data-draft="true"]')).toBeNull()
  })

  it('the floating button hides when the editor loses focus, and reads "Reply" / "Comment on block" by target kind', async () => {
    const m = await mountRail()
    const btn = m.byTestId('floatingComment') as HTMLButtonElement
    act(() => m.editorRoot().focus())
    m.scriptSelection({ kind: 'inside-suggestion', suggestion: 's_1', thread: 't_1', rect: { top: 50, bottom: 70, left: 0 }, extent: { top: 50, bottom: 70 } })
    expect(btn.getAttribute('aria-label')).toBe('Reply to this suggestion')
    m.scriptSelection({ kind: 'block', anchor: { kind: 'block', hint: { rev: 0, block: 1, blockHash: '0'.repeat(16), kind: 'raw', mdType: 'html' }, preview: '<div>' }, rect: { top: 50, bottom: 70, left: 0 }, extent: { top: 50, bottom: 70 } })
    expect(btn.getAttribute('aria-label')).toBe('Comment on this block')
    act(() => (document.activeElement as HTMLElement).blur())
    m.scriptSelection(textTarget(1, 'topic 1', 50))
    expect(btn.hidden).toBe(true)
  })

  it('the top bar Comment button is enabled exactly while there is a target, and works without editor focus (selection off screen)', async () => {
    const m = await mountRail()
    const top = m.byTestId('commentButton') as HTMLButtonElement
    expect(top.disabled).toBe(true)
    m.scriptSelection(textTarget(3, 'topic 3', 5000))
    expect(top.disabled).toBe(false)
    expect((m.byTestId('floatingComment') as HTMLButtonElement).hidden).toBe(true)
    await click(top)
    m.frame()
    expect(m.$('[data-draft="true"]').dataset.active).toBe('true')
    expect(m.frames.at(-1)!.anchors.get('t_draft')).toBe(5000)
  })

  it('a long anchor (select-all over MAX_QUOTE_CHARS) is never refused: the card shows head … tail (row 90)', async () => {
    const m = await mountRail()
    const E = CONSTANTS.LONG_QUOTE_EDGE_CHARS
    const t = textTarget(0, 'H'.repeat(E), 20, 9000)
    if (t.kind !== 'anchor') throw new Error('unreachable')
    t.anchor = { ...t.anchor, tail: 'Z'.repeat(E), span: CONSTANTS.MAX_QUOTE_CHARS + 5000 }
    m.scriptSelection(t)
    await click(m.byTestId('commentButton'))
    m.frame()
    const quote = m.$('[data-draft="true"] .mdr-card-quote').textContent!
    expect(quote).toMatch(/^H+ … Z+$/)
  })

  it('Cmd+Opt+M: a selection opens its composer; a collapsed caret in a word targets the word; elsewhere the whole-doc composer', async () => {
    const m = await mountRail()
    const binding = m.bridge.shortcuts.find((b) => b.key === 'Mod-Alt-m')!
    expect(binding).toBeTruthy()
    const word = textTarget(4, 'topic', 300)
    const spy = vi.spyOn(m.bridge, 'getSelectionTarget').mockImplementation((o) => (o?.collapsed === 'word' ? word : null))
    act(() => {
      expect(binding.run()).toBe(true)
    })
    m.frame()
    expect(spy).toHaveBeenCalledWith({ collapsed: 'word' })
    expect(m.frames.at(-1)!.anchors.get('t_draft')).toBe(300)
    // cancel, then a caret outside any word: the whole-doc dock
    await click(m.$('[data-draft="true"] .mdr-composer-actions button[aria-label="Cancel"]'))
    spy.mockImplementation(() => null)
    act(() => {
      binding.run()
    })
    m.frame()
    const doc = m.byTestId('docComposerInput')
    expect(document.activeElement).toBe(doc)
    expect(m.byTestId('railHeader').contains(doc)).toBe(false)
    expect(m.rail.contains(doc)).toBe(true)
  })

  it('Cmd+Opt+M outside the editor (no editor focus) focuses the whole-doc dock; posting creates a doc thread, listed in the header', async () => {
    const m = await mountRail()
    const e = keyCmdOpt(document.body, 'KeyM')
    expect(e.defaultPrevented).toBe(true)
    const area = m.byTestId('docComposerInput') as HTMLTextAreaElement
    expect(document.activeElement).toBe(area)
    type(area, 'Overall: good.')
    await click(m.byTestId('docComposerPost'))
    await flushAsync()
    const call = m.session.calls.find((c) => c.method === 'createThread')!
    expect(call.args).toEqual([{ kind: 'doc' }, 'Overall: good.'])
    expect(area.value).toBe('')
    expect(m.byTestId('railHeader').querySelector('button[aria-label="On the document (1)"]')).not.toBeNull()
  })

  it('the rail header’s Comment on document button focuses the same dock', async () => {
    const m = await mountRail()
    await click(m.byTestId('docComment'))
    expect(document.activeElement).toBe(m.byTestId('docComposerInput'))
  })

  it('an inside-suggestion target opens the reply box of that suggestion’s thread', async () => {
    const t = { ...thread(1, { block: 2 }), kind: 'suggestion' as const }
    const s = suggestionFor(t, 1)
    t.suggestions = [s.id]
    const m = await mountRail({ threads: [t], suggestions: [s] })
    m.scriptSelection({ kind: 'inside-suggestion', suggestion: s.id, thread: t.id, rect: { top: 50, bottom: 70, left: 0 }, extent: { top: 50, bottom: 70 } })
    await click(m.byTestId('commentButton'))
    m.frame()
    expect(m.card(t.id).dataset.active).toBe('true')
    expect(document.activeElement).toBe(m.byTestId('cardReply', {}, m.card(t.id)))
    expect(document.querySelector('[data-draft="true"]')).toBeNull()
  })

  it('an empty new-comment card goes away when TJ clicks back into the text; a typed one stays', async () => {
    const m = await mountRail()
    m.scriptSelection(textTarget(2, 'topic 2', 120))
    await click(m.byTestId('commentButton'))
    m.frame()
    expect(document.querySelector('[data-draft="true"]')).not.toBeNull()
    act(() => {
      m.editorRoot().dispatchEvent(new Event('pointerdown', { bubbles: true }))
      m.editorRoot().click()
    })
    expect(document.querySelector('[data-draft="true"]')).toBeNull()
    await click(m.byTestId('commentButton'))
    m.frame()
    type(m.byTestId('cardReply', {}, m.$('[data-draft="true"]')), 'half a thought')
    act(() => m.editorRoot().click())
    const d = m.$('[data-draft="true"]')
    expect(d.dataset.active).toBe('false')
    expect((m.byTestId('cardReply', {}, d) as HTMLTextAreaElement).value).toBe('half a thought')
  })
})

describe('QA3: every message says when it was written', () => {
  it('the first message’s time sits in the card head, a reply’s next to its author; both are <time> with the full date as the tooltip', async () => {
    const t = thread(1, { block: 2, by: 'Claude', replies: 1 })
    const m = await mountRail({ threads: [t] })
    const c = m.card(t.id)
    const times = Array.from(c.querySelectorAll<HTMLTimeElement>('time'))
    expect(times.map((x) => x.dateTime)).toEqual(['2026-10-15T12:00:00.000Z', '2026-10-15T12:01:00.000Z'])
    for (const x of times) {
      expect(x.textContent).toMatch(/\d{1,2}:\d{2}/)
      expect(x.title).toMatch(/2026/)
    }
    // the card's accessible name is the author and the text, not the time
    expect(document.getElementById(c.getAttribute('aria-labelledby')!)!.querySelector('time')).toBeNull()
    // beside the author, not inside the author's own element (that is just the name)
    const head = m.all('message', c)[1]!.querySelector('.mdr-message-head')!
    expect(head.querySelector('time')).not.toBeNull()
    expect(head.querySelector('.mdr-message-author')!.textContent).toBe('Claude')
  })
})

describe('thread actions (R2.3)', () => {
  it('reply, edit own, delete own; Claude’s messages have no edit/delete', async () => {
    const t = thread(1, { block: 2, by: 'TJ', replies: 1 })
    const m = await mountRail({ threads: [t] })
    const c = m.card(t.id)
    const msgs = m.all('message', c)
    expect(msgs.map((x) => x.dataset.by)).toEqual(['TJ', 'Claude'])
    expect(m.all('cardEdit', msgs[1]!)).toHaveLength(0)
    expect(m.all('cardDelete', msgs[1]!)).toHaveLength(0)
    // reply
    const reply = m.byTestId('cardReply', {}, c) as HTMLTextAreaElement
    type(reply, 'Agreed, fixing.')
    await click(m.byTestId('cardSubmit', {}, c))
    expect(m.session.calls.some((x) => x.method === 'reply' && x.args[1] === 'Agreed, fixing.')).toBe(true)
    expect((m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement).value).toBe('')
    // edit the first (TJ's) message
    await click(m.byTestId('cardEdit', {}, m.byTestId('message', { 'data-comment': cid(10) })))
    const editBox = m.byTestId('cardReply', {}, m.byTestId('message', { 'data-comment': cid(10) })) as HTMLTextAreaElement
    expect(editBox.value).toBe('Comment 1')
    // Edit puts the caret in the box (QA1: unverified 28), at the end of the text
    expect(document.activeElement).toBe(editBox)
    expect(editBox.selectionStart).toBe(editBox.value.length)
    type(editBox, 'Comment 1, edited')
    await click(m.byTestId('cardSubmit', {}, m.byTestId('message', { 'data-comment': cid(10) })))
    expect(m.session.calls.find((x) => x.method === 'editComment')!.args).toEqual([cid(10), 'Comment 1, edited'])
    expect(m.byTestId('message', { 'data-comment': cid(10) }).textContent).toContain('Comment 1, edited')
    // delete it
    await click(m.byTestId('cardDelete', {}, m.byTestId('message', { 'data-comment': cid(10) })))
    expect(m.session.calls.find((x) => x.method === 'deleteComment')!.args).toEqual([cid(10)])
    expect(m.byTestId('message', { 'data-comment': cid(10) }).textContent).toContain('Comment deleted')
  })

  it('resolve hides the thread; show-resolved brings it back with Reopen; reopen restores it', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    await click(m.byTestId('cardResolve', {}, m.card(t.id)))
    expect(m.session.calls.some((x) => x.method === 'resolve')).toBe(true)
    await waitFor(() => expect(document.querySelector(`[data-thread="${t.id}"]`)).toBeNull())
    const toggle = m.byTestId('showResolved')
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    const c = m.card(t.id)
    expect(c.textContent).toContain('Resolved')
    expect(m.all('cardResolve', c)).toHaveLength(0)
    await click(m.byTestId('cardReopen', {}, c))
    expect(m.session.calls.some((x) => x.method === 'reopen')).toBe(true)
    await click(toggle)
    expect(m.card(t.id).textContent).not.toContain('Resolved')
  })

  it('a resolved thread with a pending suggestion stays visible with show-resolved off, tagged Resolved, still actionable (§6.8, row 84)', async () => {
    const t = { ...thread(1, { block: 2, status: 'resolved' }), kind: 'suggestion' as const }
    const s = suggestionFor(t, 1)
    t.suggestions = [s.id]
    const m = await mountRail({ threads: [t], suggestions: [s] })
    const c = m.card(t.id)
    expect(m.byTestId('showResolved').getAttribute('aria-checked')).toBe('false')
    expect(c.querySelector('.mdr-card-tag')!.textContent).toBe('Resolved')
    const row = m.byTestId('suggestionItem', { 'data-suggestion': s.id }, c)
    expect((m.byTestId('accept', {}, row) as HTMLButtonElement).disabled).toBe(false)
  })

  it('unread: a dot with the count on the card, the total on the rail header; the header count marks everything read', async () => {
    const t1 = { ...thread(1, { block: 2, replies: 1 }), unread: 2, lastSeq: 11 }
    const t2 = { ...thread(2, { block: 6 }), unread: 1 }
    const m = await mountRail({ threads: [t1, t2], review: { seq: 30 } })
    const dot = m.byTestId('unread', {}, m.card(t1.id))
    expect(dot.dataset.count).toBe('2')
    const total = m.byTestId('unread', {}, m.byTestId('railHeader'))
    expect(total.dataset.count).toBe('3')
    await click(total)
    expect(m.session.calls.find((x) => x.method === 'markRead')!.args).toEqual([null, 30])
    await waitFor(() => expect(m.all('unread')).toHaveLength(0))
  })

  it('activating a thread with unread Claude activity marks it read up to its latest seq (§12.9)', async () => {
    const t = { ...thread(1, { block: 2, replies: 1 }), unread: 1, lastSeq: 11 }
    const m = await mountRail({ threads: [t] })
    act(() => m.bridge.emitHighlightClick(t.id))
    expect(m.session.calls.find((x) => x.method === 'markRead')!.args).toEqual([t.id, 11])
  })

  it('Detached threads list in the rail header with their original quote, folded until opened (§5.4, row 37)', async () => {
    const t = { ...thread(1, { block: 2, detached: true }), lastAnchor: thread(9, { block: 2, quote: 'the original words' }).anchor }
    const m = await mountRail({ threads: [t] })
    const section = m.byTestId('detachedSection')
    expect(section.textContent).toContain('Detached (1)')
    expect(section.querySelector(`[data-thread="${t.id}"]`)).toBeNull()
    await click(m.$('.mdr-fold-button', section))
    const c = m.card(t.id)
    expect(section.contains(c)).toBe(true)
    expect(c.dataset.collapsed).toBe('true')
    expect(c.querySelector('.mdr-card-quote')!.textContent).toBe('the original words')
    act(() => {
      c.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(m.card(t.id).dataset.active).toBe('true')
    expect(m.card(t.id).dataset.collapsed).toBe('false')
  })
})

describe('suggestion rows (§6.6–§6.8)', () => {
  function suggestionThread(n: number, block: number, k = 1) {
    const t: Thread = { ...thread(n, { block, by: 'Claude' }), kind: 'suggestion' }
    const ss = Array.from({ length: k }, (_, i) => suggestionFor(t, n * 10 + i))
    t.suggestions = ss.map((s) => s.id)
    return { t, ss }
  }

  it('Accept and Reject go through the bridge; both buttons disable from the first click until the answer', async () => {
    const { t, ss } = suggestionThread(1, 2)
    const m = await mountRail({ threads: [t], suggestions: ss })
    let release: (v: { ok: boolean }) => void = () => undefined
    const accept = vi.spyOn(m.bridge, 'accept').mockImplementation(() => new Promise((r) => (release = r)))
    const row = m.byTestId('suggestionItem', { 'data-suggestion': ss[0]!.id })
    expect(row.dataset.status).toBe('pending')
    await click(m.byTestId('accept', {}, row))
    await click(m.byTestId('accept', {}, row))
    expect(accept).toHaveBeenCalledTimes(1)
    expect((m.byTestId('accept', {}, row) as HTMLButtonElement).disabled).toBe(true)
    expect((m.byTestId('reject', {}, row) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => release({ ok: true }))
    expect((m.byTestId('accept', {}, row) as HTMLButtonElement).disabled).toBe(false)
    const reject = vi.spyOn(m.bridge, 'reject').mockResolvedValue({ ok: false, code: 'SUGGESTION_CLOSED' })
    await click(m.byTestId('reject', {}, row))
    await flushAsync()
    expect(reject).toHaveBeenCalledWith(ss[0]!.id)
    expect(row.textContent).toContain('already decided')
  })

  it('a format or structure suggestion says what it does in its head and in the collapsed preview (QA confirmed 28)', async () => {
    const { t, ss } = suggestionThread(1, 2)
    // no hunk text for the fake editor to place it by: the card sits in the rail header's static section
    t.createdBy = 'TJ'
    t.messages = []
    t.status = 'resolved'
    ss[0] = { ...ss[0]!, by: 'TJ', base: 'We set the member rate.', proposed: 'We set the **member** rate.', hunks: [] }
    const m = await mountRail({ threads: [t], suggestions: ss })
    const row = m.byTestId('suggestionItem', { 'data-suggestion': ss[0]!.id })
    expect(row.querySelector('.mdr-suggestion-kind')!.textContent).toBe('Bold: member')
    expect(row.getAttribute('aria-label')).toBe('Bold: member suggested by You') // no mdr-user-name tag: the default
    expect(row.querySelector('.mdr-hunks')).toBeNull()
    expect(m.byTestId('card').querySelector('.mdr-card-preview')!.textContent).toBe('Bold: member')
  })

  it('an insert-only suggestion previews the insertion', async () => {
    const { t, ss } = suggestionThread(1, 2)
    t.createdBy = 'TJ'
    t.messages = []
    ss[0] = { ...ss[0]!, by: 'TJ', hunks: [{ del: '', ins: ' (see below)', at: 3 }] }
    const m = await mountRail({ threads: [t], suggestions: ss })
    expect(m.byTestId('card').querySelector('.mdr-card-preview')!.textContent).toBe('Add: (see below)')
  })

  it('a stale record keeps a greyed Accept and offers Dismiss (a reject) and Copy replacement (§6.7, row 41)', async () => {
    const { t, ss } = suggestionThread(1, 2)
    ss[0] = { ...ss[0]!, status: 'stale', staleReason: 'BASE_GONE', located: null, proposed: 'the replacement' }
    const writes: string[] = []
    const m = await mountRail({ threads: [t], suggestions: ss })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void writes.push(s) } })
    const row = m.byTestId('suggestionItem', { 'data-suggestion': ss[0]!.id })
    expect(row.dataset.status).toBe('stale')
    expect(row.textContent).toContain('Out of date')
    expect((m.byTestId('accept', {}, row) as HTMLButtonElement).disabled).toBe(true)
    expect(m.all('reject', row)).toHaveLength(0)
    const actions = m.all('cardAction', row).map((b) => b.dataset.action)
    expect(actions).toEqual(['dismiss', 'copy-replacement'])
    for (const a of actions) expect(TEST_ACTIONS.cardAction).toContain(a)
    await click(m.byTestId('cardAction', { 'data-action': 'copy-replacement' }, row))
    await flushAsync()
    expect(writes).toEqual(['the replacement'])
    const reject = vi.spyOn(m.bridge, 'reject')
    await click(m.byTestId('cardAction', { 'data-action': 'dismiss' }, row))
    expect(reject).toHaveBeenCalledWith(ss[0]!.id)
  })

  it('a multi-hunk record reads "N changes, accepted together"; deletions are struck and insertions underlined', async () => {
    const { t, ss } = suggestionThread(1, 2)
    ss[0] = { ...ss[0]!, hunks: [{ del: 'topic 2', ins: 'beta', at: 0 }, { del: '', ins: 'gamma', at: 10 }] }
    const m = await mountRail({ threads: [t], suggestions: ss })
    const row = m.byTestId('suggestionItem', { 'data-suggestion': ss[0]!.id })
    expect(row.textContent).toContain('2 changes, accepted together')
    expect(row.querySelector('del')!.textContent).toBe('topic 2')
    expect(Array.from(row.querySelectorAll('ins')).map((x) => x.textContent)).toEqual(['beta', 'gamma'])
  })

  it('Accept all in thread sends one bulk request for the thread’s pending ids (§6.8)', async () => {
    const { t, ss } = suggestionThread(1, 2, 3)
    ss[2] = { ...ss[2]!, status: 'stale' }
    const m = await mountRail({ threads: [t], suggestions: ss })
    const spy = vi.spyOn(m.bridge, 'acceptAll')
    const btn = m.byTestId('acceptAllThread', {}, m.card(t.id))
    expect(btn.textContent).toContain('(2)')
    await click(btn)
    expect(spy).toHaveBeenCalledWith({ ids: [ss[0]!.id, ss[1]!.id] })
  })

  it('SCHEMA renders "Shown as a diff" in its anchored card; BASE_NOT_FOUND goes to the header’s unplaced section (§6.3, row 72)', async () => {
    const a = suggestionThread(1, 2)
    const b = suggestionThread(2, 6)
    const m = await mountRail({ threads: [a.t, b.t], suggestions: [...a.ss, ...b.ss] })
    const sums = new Map<string, SuggestionSummary>([
      [a.ss[0]!.id, { id: a.ss[0]!.id, by: 'Claude', kind: 'replace', deletedText: 'x', insertedText: 'y', hunkCount: 1, placed: false, unplaced: 'SCHEMA' }],
      [b.ss[0]!.id, { id: b.ss[0]!.id, by: 'Claude', kind: 'replace', deletedText: 'x', insertedText: 'y', hunkCount: 1, placed: false, unplaced: 'BASE_NOT_FOUND' }],
    ]) as Map<never, SuggestionSummary>
    m.bridge.setSuggestionSummaries(sums)
    act(() => m.bridge.emitLayout('decorations'))
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    const schemaRow = m.byTestId('suggestionItem', { 'data-suggestion': a.ss[0]!.id })
    expect(schemaRow.textContent).toContain('Shown as a diff')
    expect(schemaRow.closest('.mdr-card--rail')).not.toBeNull()
    expect((m.byTestId('accept', {}, schemaRow) as HTMLButtonElement).disabled).toBe(false)
    const unplaced = m.byTestId('unplacedSection')
    expect(unplaced.contains(m.card(b.t.id))).toBe(true)
    expect(m.card(b.t.id).dataset.collapsed).toBe('true')
    act(() => {
      m.card(b.t.id).dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    const row = m.byTestId('suggestionItem', { 'data-suggestion': b.ss[0]!.id })
    expect(row.textContent).toContain('Can’t place this inline')
    expect(m.all('accept', row)).toHaveLength(1)
  })

  it('Cmd+Opt+A / R decide the focused suggestion, else the active thread’s first pending one', async () => {
    const { t, ss } = suggestionThread(1, 2, 2)
    const m = await mountRail({ threads: [t], suggestions: ss })
    const accept = vi.spyOn(m.bridge, 'accept')
    const reject = vi.spyOn(m.bridge, 'reject')
    act(() => m.bridge.emitHighlightClick(t.id))
    act(() => {
      expect(m.bridge.shortcuts.find((b) => b.key === 'Mod-Alt-a')!.run()).toBe(true)
    })
    expect(accept).toHaveBeenCalledWith(ss[0]!.id)
    await flushAsync()
    act(() => m.byTestId('reject', {}, m.byTestId('suggestionItem', { 'data-suggestion': ss[1]!.id })).focus())
    keyCmdOpt(document.activeElement!, 'KeyR')
    expect(reject).toHaveBeenCalledWith(ss[1]!.id)
  })
})

describe('rail header (§11.4)', () => {
  it('Accept all / Reject all from Claude: one bulk request by Claude; the row goes away when nothing is pending', async () => {
    const t: Thread = { ...thread(1, { block: 2 }), kind: 'suggestion' }
    const s = suggestionFor(t, 1)
    t.suggestions = [s.id]
    const m = await mountRail({ threads: [t], suggestions: [s] })
    const acc = m.byTestId('acceptAllClaude')
    const rej = m.byTestId('rejectAllClaude')
    expect(acc.getAttribute('aria-disabled')).toBe('false')
    const acceptAll = vi.spyOn(m.bridge, 'acceptAll')
    const rejectAll = vi.spyOn(m.bridge, 'rejectAll')
    await click(rej)
    expect(rejectAll).toHaveBeenCalledWith({ by: 'Claude' })
    await flushAsync()
    await waitFor(() => expect(m.all('acceptAllClaude')).toHaveLength(0))
    expect(m.all('rejectAllClaude')).toHaveLength(0)
    expect(acceptAll).not.toHaveBeenCalled()
  })

  it('QA3: a quiet header: with nothing pending there is the one Comment button and a settings button, and no bulk actions', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 2 })] })
    const header = m.byTestId('railHeader')
    expect(m.all('acceptAllClaude')).toHaveLength(0)
    expect(m.all('rejectAllClaude')).toHaveLength(0)
    // the two switches are behind the settings button, which says so
    const gear = m.byTestId('railSettings')
    expect(gear.getAttribute('aria-expanded')).toBe('false')
    expect(gear.getAttribute('aria-label')).toBe('Review settings')
    const panel = header.querySelector<HTMLElement>('.mdr-rail-settings')!
    expect(panel.hidden).toBe(true)
    expect(gear.getAttribute('aria-controls')).toBe(panel.id)
    await click(gear)
    expect(gear.getAttribute('aria-expanded')).toBe('true')
    expect(panel.hidden).toBe(false)
    // each switch comes with its one-line explanation
    expect(panel.textContent).toContain('Also list resolved comments')
    expect(panel.textContent).toContain('Off: Claude can only suggest changes')
    expect(m.byTestId('showResolved', {}, panel).getAttribute('aria-describedby')).toBeTruthy()
    expect(m.byTestId('policyToggle', {}, panel).getAttribute('aria-describedby')).toBeTruthy()
    await click(gear)
    expect(panel.hidden).toBe(true)
    // the header's own buttons: Comment on document + settings
    expect(Array.from(header.querySelectorAll('button')).filter((b) => !b.closest('.mdr-rail-settings') && !b.hidden).map((b) => b.getAttribute('aria-label'))).toEqual(['Comment on document', 'Review settings'])
  })

  it('QA3: the bulk row is there while Claude has pending suggestions, labelled in one piece', async () => {
    const t: Thread = { ...thread(1, { block: 2 }), kind: 'suggestion' }
    const s = suggestionFor(t, 1)
    t.suggestions = [s.id]
    const m = await mountRail({ threads: [t], suggestions: [s] })
    expect(m.byTestId('acceptAllClaude').textContent).toBe('Accept all from Claude (1)')
    expect(m.byTestId('rejectAllClaude').textContent).toBe('Reject all')
  })

  it('"Claude may edit directly" is checked when the policy is not suggest-only, and toggling it sets the policy (§9.9.1)', async () => {
    const m = await mountRail({ review: { policy: { suggestOnly: true } } })
    const sw = m.byTestId('policyToggle')
    expect(sw.getAttribute('role')).toBe('switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await click(sw)
    await flushAsync()
    expect(m.session.calls.find((c) => c.method === 'setPolicy')!.args).toEqual([{ suggestOnly: false }])
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('a read-only review disables composers and actions', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t], review: { readOnly: { code: 'SIDECAR_CORRUPT', message: 'damaged' } } })
    expect(m.all('cardReply', m.card(t.id))).toHaveLength(0)
    expect(m.all('cardResolve', m.card(t.id))).toHaveLength(0)
    expect((m.byTestId('docComment') as HTMLButtonElement).disabled).toBe(true)
    expect(m.all('docComposer')).toHaveLength(0)
    expect((m.byTestId('policyToggle') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('conflict and unsaveable cards (§7.4)', () => {
  const conflict: BlockConflict = { kind: 'conflict', id: 'conflict:aaaa', baseIndex: 2, currentIndex: 2, base: 'base text', mine: 'my text', theirs: 'their text', theirsBy: 'Claude', theirsRev: 4 }
  const unsaveable: BlockConflict = { kind: 'unsaveable', id: 'unsaveable:bbbb', baseIndex: 5, currentIndex: 5, base: 'disk text', mine: 'my odd text', theirs: 'disk text', theirsBy: 'TJ', theirsRev: 4 }

  it('conflict: shows mine, theirs (and who wrote it) and the original; Keep mine / Take theirs resolve through the bridge', async () => {
    const m = await mountRail({ conflicts: [conflict] })
    const c = m.byTestId('conflictCard', { 'data-conflict': conflict.id })
    expect(c.dataset.kind).toBe('conflict')
    expect(c.textContent).toContain('my text')
    expect(c.textContent).toContain('their text')
    expect(c.textContent).toContain('Claude changed it')
    const spy = vi.spyOn(m.bridge, 'resolveConflict')
    expect(m.all('cardAction', c).map((b) => b.dataset.action)).toEqual(['keep-mine', 'take-theirs'])
    await click(m.byTestId('cardAction', { 'data-action': 'keep-mine' }, c))
    expect(spy).toHaveBeenCalledWith(conflict.id, 'mine')
  })

  it('unsaveable: "Couldn’t save this block", Copy markdown copies mine, Discard my change takes the disk text', async () => {
    const writes: string[] = []
    const m = await mountRail({ conflicts: [unsaveable] })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void writes.push(s) } })
    const c = m.byTestId('conflictCard', { 'data-conflict': unsaveable.id })
    expect(c.textContent).toContain('Couldn’t save this block')
    expect(m.all('cardAction', c).map((b) => b.dataset.action)).toEqual(['copy-markdown', 'discard'])
    await click(m.byTestId('cardAction', { 'data-action': 'copy-markdown' }, c))
    await flushAsync()
    expect(writes).toEqual(['my odd text'])
    const spy = vi.spyOn(m.bridge, 'resolveConflict')
    await click(m.byTestId('cardAction', { 'data-action': 'discard' }, c))
    expect(spy).toHaveBeenCalledWith(unsaveable.id, 'theirs')
  })

  it('conflict cards are laid out at their block like thread cards', async () => {
    // the fake marks the block holding mine/theirs as the conflict block; its rect is the card's anchor
    const m = await mountRail({ conflicts: [conflict], markdown: 'Paragraph 0.\n\nParagraph 1.\n\nthird: their text here\n\nParagraph 3.\n' })
    const f = m.frames.at(-1)!
    expect(f.anchors.has(conflict.id)).toBe(true)
    expect(m.byTestId('conflictCard', { 'data-conflict': conflict.id }).dataset.placed).toBe('true')
  })
})
