// tests/unit/web/threads/qa3-rail-ui.test.tsx (QA round 3, fixer "rail-ui", round 1).
//
// One regression per finding, over the fake session and editor (jsdom has no layout, so the geometry findings live in
// tests/e2e/qa3-r1-rail-ui.spec.ts). Names carry the finding's short title.
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import { flushAsync, mountRail, suggestionFor, textTarget } from './mount'
import type { ToastInput } from '../../../../web/src/shell/toast-store'
import { buildRailModel } from '../../../../web/src/threads/model'
import type { BlockConflict, Thread } from '../../../../shared/types'
import { thread, tid } from '../shell/helpers'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click()
  })
}
const type = (el: HTMLElement, value: string): void => {
  fireEvent.change(el, { target: { value } })
}
void click
void type
void flushAsync

describe('a folded card shows the latest message and a reply count (rail-ui 1)', () => {
  it('previews Claude’s reply, not TJ’s first message, says who, and counts the replies', async () => {
    // TJ comments, Claude replies: messages = [TJ "Comment 1", Claude "Reply 1"]
    const t = thread(1, { block: 3, body: 'Should this say net returns instead?', replies: 1 })
    t.messages[1]!.body = 'Yes, switching to net returns everywhere except the footnote.'
    const m = await mountRail({ threads: [t] })
    const card = m.card(t.id)
    const head = card.querySelector('.mdr-card-head')!
    expect(head.querySelector('.mdr-card-preview')!.textContent).toBe('Claude: Yes, switching to net returns everywhere except the footnote.')
    // the head still names who started the thread
    expect(head.querySelector('.mdr-card-author')!.getAttribute('data-by')).toBe('TJ')
    expect(head.querySelector('.mdr-card-replies')!.textContent).toBe('1 reply')
    // the accessible name carries it too
    const label = document.getElementById(card.getAttribute('aria-labelledby')!)!
    expect(label.textContent).toContain('1 reply')
    expect(label.textContent).toContain('Claude: Yes, switching')
  })

  it('says "N replies" for several, and shows no count for a lone comment', async () => {
    const t = thread(1, { block: 3, replies: 3 })
    const lone = thread(2, { block: 7 })
    const m = await mountRail({ threads: [t, lone] })
    expect(m.card(t.id).querySelector('.mdr-card-replies')!.textContent).toBe('3 replies')
    // replies alternate Claude, TJ, Claude: the latest is Claude's, on a thread TJ started
    expect(m.card(t.id).querySelector('.mdr-card-preview')!.textContent).toBe('Claude: Reply 3')
    expect(m.card(lone.id).querySelector('.mdr-card-replies')).toBeNull()
    expect(m.card(lone.id).querySelector('.mdr-card-preview')!.textContent).toBe('Comment 2')
  })

  it('skips a deleted latest message when it previews', async () => {
    const t = thread(1, { block: 3, replies: 2 })
    t.messages[2]!.deleted = true
    const m = await mountRail({ threads: [t] })
    expect(m.card(t.id).querySelector('.mdr-card-preview')!.textContent).toBe('Claude: Reply 1')
    expect(m.card(t.id).querySelector('.mdr-card-replies')!.textContent).toBe('1 reply')
  })
})

describe('cards are in document order, not creation order (rail-ui 4)', () => {
  // Claude commented on paragraph 5 first and paragraph 1 last: review.threads is in creation order
  const created = [5, 4, 3, 2, 1].map((n) => thread(n, { block: n * 2 }))

  it('the rail model lists positioned threads top to bottom', () => {
    const model = buildRailModel({ threads: created, suggestions: [] }, new Map(), false)
    expect(model.positioned.map((t) => t.id)).toEqual([1, 2, 3, 4, 5].map(tid))
  })

  it('a block-anchored thread sits among the text-anchored ones by where its block starts', () => {
    const text = thread(1, { block: 6, pos: 600 })
    const blk: Thread = {
      ...thread(2, { block: 3 }),
      anchor: { kind: 'block', hint: { rev: 0, block: 3, blockHash: '0'.repeat(16), kind: 'raw', mdType: 'html' }, preview: '<div>' },
      resolution: { state: 'exact', block: 3 },
    }
    const model = buildRailModel({ threads: [text, blk], suggestions: [] }, new Map(), false, { blockStart: (i) => i * 100 })
    expect(model.positioned.map((t) => t.id)).toEqual([tid(2), tid(1)])
  })

  it('the rail’s DOM (and so Tab) order follows the document', async () => {
    const m = await mountRail({ threads: created })
    expect(m.all('card').map((c) => c.dataset.thread)).toEqual([1, 2, 3, 4, 5].map(tid))
  })
})

describe('"Claude may edit directly" says what it does (rail-ui 14)', () => {
  it('has a tooltip and a description naming both states, wired with aria-describedby', async () => {
    const m = await mountRail({ threads: [] })
    const sw = m.byTestId('policyToggle')
    const help = 'On: Claude can change the text itself. Off: Claude can only suggest changes for you to accept.'
    expect(sw.getAttribute('title')).toBe(help)
    const desc = document.getElementById(sw.getAttribute('aria-describedby') ?? '')
    expect(desc?.textContent).toBe(help)
  })
})

describe('an empty document explains itself, and Previous/Next only live when there is something to reach (rail-ui 15)', () => {
  it('shows the three moves in the rail until the first comment exists', async () => {
    const m = await mountRail({ threads: [] })
    const hint = m.rail.querySelector('.mdr-rail-hint')!
    expect(hint.textContent).toBe('Select text to comment. Switch to Suggesting to propose edits. Click Send to Claude when you’re done.')
    act(() => m.session.emit({ review: { ...m.session.getReview(), threads: [thread(1, { block: 2 })] } }))
    m.frame()
    expect(m.rail.querySelector('.mdr-rail-hint')).toBeNull()
  })

  it('follows the mode: in Suggesting it says his edits are tracked as suggestions, and no longer offers to switch (Pass 4 rail-ui 18)', async () => {
    const m = await mountRail({ threads: [] })
    const text = (): string => m.rail.querySelector('.mdr-rail-hint')!.textContent!
    expect(text()).toContain('Switch to Suggesting to propose edits.')
    act(() => m.bridge.setMode('suggesting'))
    expect(text()).toBe('Select text to comment. Your edits are tracked as suggestions. Click Send to Claude when you’re done.')
    act(() => m.bridge.setMode('editing'))
    expect(text()).toContain('Switch to Suggesting to propose edits.')
  })

  it('does not show it on a document that has comments', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 2 })] })
    expect(m.rail.querySelector('.mdr-rail-hint')).toBeNull()
  })

  it('disables Previous and Next while no comment is reachable, and says why', async () => {
    const m = await mountRail({ threads: [] })
    const prev = m.byTestId('navPrev') as HTMLButtonElement
    const next = m.byTestId('navNext') as HTMLButtonElement
    expect(prev.disabled).toBe(true)
    expect(next.disabled).toBe(true)
    expect(next.title).toContain('No comments yet')
    act(() => m.session.emit({ review: { ...m.session.getReview(), threads: [thread(1, { block: 2 })] } }))
    m.frame()
    expect(prev.disabled).toBe(false)
    expect(next.disabled).toBe(false)
    expect(next.title).toContain('Next comment')
  })

  it('a resolved comment that is hidden is not reachable either', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 2, status: 'resolved' })] })
    expect((m.byTestId('navNext') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('"Claude replied" with the unread thread resolved and hidden (rail-ui 12)', () => {
  it('clicking the badge reveals the resolved thread and opens it, which reads it', async () => {
    // Claude replied and resolved its own thread in one batch: unread 2, status resolved, "Show resolved" off
    const t = { ...thread(1, { block: 2, replies: 1, status: 'resolved' }), unread: 2, lastSeq: 11 }
    const m = await mountRail({ threads: [t], review: { seq: 30 } })
    expect(document.querySelector(`[data-thread="${t.id}"]`)).toBeNull()
    expect(m.byTestId('showResolved').getAttribute('aria-checked')).toBe('false')
    act(() => m.hub.commands.firstUnread())
    await flushAsync()
    m.frame()
    await flushAsync()
    m.frame()
    expect(m.byTestId('showResolved').getAttribute('aria-checked')).toBe('true')
    expect(m.card(t.id).dataset.active).toBe('true')
  })

  it('does not turn Show resolved on when a visible card has the unread', async () => {
    const hidden = { ...thread(1, { block: 2, replies: 1, status: 'resolved' }), unread: 1, lastSeq: 11 }
    const open = { ...thread(2, { block: 6, replies: 1 }), unread: 1, lastSeq: 21 }
    const m = await mountRail({ threads: [hidden, open], review: { seq: 30 } })
    act(() => m.hub.commands.firstUnread())
    await flushAsync()
    m.frame()
    expect(m.byTestId('showResolved').getAttribute('aria-checked')).toBe('false')
    expect(m.card(open.id).dataset.active).toBe('true')
  })
})

describe('focus after posting, cancelling or pressing Esc in a composer (rail-ui 9)', () => {
  const openDraft = async (m: Awaited<ReturnType<typeof mountRail>>): Promise<HTMLElement> => {
    act(() => m.editorRoot().focus())
    m.scriptSelection(textTarget(2, 'topic 2', 120, 144))
    await click(m.byTestId('floatingComment'))
    m.frame()
    const d = m.$('[data-draft="true"]')
    type(m.byTestId('cardReply', {}, d), 'A comment.')
    return d
  }
  const area = (d: HTMLElement): HTMLElement => d.querySelector('textarea')!
  it('Cmd+Enter posts and hands the focus back to the document, caret after the commented text', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 8 })] })
    const d = await openDraft(m)
    fireEvent.keyDown(area(d), { key: 'Enter', metaKey: true })
    await flushAsync()
    m.frame()
    expect(m.session.calls.some((c) => c.method === 'createThread')).toBe(true)
    expect(document.activeElement).toBe(m.editorRoot())
    // typing next must not replace the text that was just commented on: the editor is told to drop the selection to its end
    expect(m.bridge.calls.filter((c) => c.method === 'focusEditor').at(-1)!.args).toEqual([{ collapse: 'end' }])
  })

  it('the Comment button does the same', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 8 })] })
    const d = await openDraft(m)
    await click(m.byTestId('cardSubmit', {}, d))
    await flushAsync()
    m.frame()
    expect(document.activeElement).toBe(m.editorRoot())
  })

  it('Cancel hands the focus back to the document and keeps what was selected', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 8 })] })
    const d = await openDraft(m)
    await click(d.querySelector('button[aria-label="Cancel"]') as HTMLElement)
    m.frame()
    expect(document.querySelector('[data-draft="true"]')).toBeNull()
    expect(document.activeElement).toBe(m.editorRoot())
    expect(m.bridge.calls.filter((c) => c.method === 'focusEditor').at(-1)!.args).toEqual([])
  })

  it('Esc does the same', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 8 })] })
    const d = await openDraft(m)
    fireEvent.keyDown(area(d), { key: 'Escape' })
    m.frame()
    expect(document.querySelector('[data-draft="true"]')).toBeNull()
    expect(document.activeElement).toBe(m.editorRoot())
  })

  it('Esc in a reply box clears it and returns to the document', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    act(() => reply.focus())
    type(reply, 'half a thought')
    fireEvent.keyDown(reply, { key: 'Escape' })
    m.frame()
    expect(reply.value).toBe('')
    expect(document.activeElement).toBe(m.editorRoot())
  })

  it('Esc in an empty reply box returns to the document too', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    act(() => reply.focus())
    fireEvent.keyDown(reply, { key: 'Escape' })
    expect(document.activeElement).toBe(m.editorRoot())
  })

  it('the Reply button leaves the caret in the reply box, as Cmd+Enter does', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    act(() => reply.focus())
    type(reply, 'A follow-up.')
    const send = m.byTestId('cardSubmit', {}, m.card(t.id))
    await act(async () => {
      send.focus() // a click focuses the button first
      send.click()
    })
    await flushAsync()
    expect(m.session.calls.some((c) => c.method === 'reply')).toBe(true)
    expect(document.activeElement).toBe(m.byTestId('cardReply', {}, m.card(t.id)))
  })
})

describe('Send to Claude posts what is typed but not posted (rail-ui 5)', () => {
  it('reports an unposted reply, a new-comment draft and a whole-doc draft', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    expect(m.hub.commands.hasUnsent()).toBe(false)
    type(m.byTestId('cardReply', {}, m.card(t.id)), 'Unposted reply draft')
    expect(m.hub.commands.hasUnsent()).toBe(true)
  })

  it('postUnsent posts the reply, clears the box and says it went through', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    type(reply, 'Unposted reply draft')
    let ok = false
    await act(async () => {
      ok = await m.hub.commands.postUnsent()
    })
    expect(ok).toBe(true)
    expect(m.session.calls.find((c) => c.method === 'reply')!.args).toEqual([t.id, 'Unposted reply draft'])
    expect(reply.value).toBe('')
    expect(m.hub.commands.hasUnsent()).toBe(false)
  })

  it('postUnsent posts a new-comment draft and a whole-doc draft too', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 8 })] })
    act(() => m.editorRoot().focus())
    m.scriptSelection(textTarget(2, 'topic 2', 120, 144))
    await click(m.byTestId('floatingComment'))
    m.frame()
    type(m.byTestId('cardReply', {}, m.$('[data-draft="true"]')), 'New comment draft')
    type(m.byTestId('docComposerInput'), 'Doc draft')
    expect(m.hub.commands.hasUnsent()).toBe(true)
    let ok = false
    await act(async () => {
      ok = await m.hub.commands.postUnsent()
    })
    expect(ok).toBe(true)
    const made = m.session.calls.filter((c) => c.method === 'createThread').map((c) => c.args[1])
    expect(made).toEqual(['New comment draft', 'Doc draft'])
    expect(m.hub.commands.hasUnsent()).toBe(false)
  })

  it('postUnsent answers false when a post fails, and keeps the text', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    type(reply, 'Will not go')
    m.session.reply = () => Promise.reject(new Error('server said no'))
    let ok = true
    await act(async () => {
      ok = await m.hub.commands.postUnsent()
    })
    expect(ok).toBe(false)
    expect(reply.value).toBe('Will not go')
    expect(m.hub.commands.hasUnsent()).toBe(true)
  })

  it('an empty or blank box is not unsent', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    type(m.byTestId('cardReply', {}, m.card(t.id)), '   ')
    expect(m.hub.commands.hasUnsent()).toBe(false)
  })
})
void TESTID

describe('Claude resolves the thread TJ is mid-reply in (rail-ui 10)', () => {
  const resolveBehindTJsBack = (m: Awaited<ReturnType<typeof mountRail>>, t: Thread): void => {
    act(() => m.session.emit({ review: { ...m.session.getReview(), threads: [{ ...t, status: 'resolved' }] } }))
    m.frame()
  }

  it('the card stays, tagged Resolved, with the draft and the focus, while it holds unposted text', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    act(() => reply.focus())
    type(reply, 'Half a sentence about')
    resolveBehindTJsBack(m, t)
    const card = m.card(t.id)
    expect(card.querySelector('.mdr-card-tag')!.textContent).toBe('Resolved')
    expect(m.byTestId('cardReply', {}, card)).toBe(reply)
    expect(reply.value).toBe('Half a sentence about')
    expect(document.activeElement).toBe(reply)
    expect(reply.placeholder).toBe('Reply to reopen…')
  })

  it('goes away once the draft is cleared (the thread is resolved and Show resolved is off)', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    type(reply, 'Half a sentence')
    resolveBehindTJsBack(m, t)
    expect(document.querySelector(`[data-thread="${t.id}"]`)).not.toBeNull()
    type(reply, '')
    m.frame()
    expect(document.querySelector(`[data-thread="${t.id}"]`)).toBeNull()
  })

  it('a resolved thread with no draft still hides, as before', async () => {
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    resolveBehindTJsBack(m, t)
    expect(document.querySelector(`[data-thread="${t.id}"]`)).toBeNull()
  })
})

describe('a conflict with no block in the page still shows its card (rail-ui 13)', () => {
  // Claude deleted the block TJ was typing in: theirs is null, there is no block on disk to sit beside
  const gone: BlockConflict = {
    kind: 'conflict', id: 'conflict:dddd', baseIndex: 4, currentIndex: null,
    base: 'Paragraph 05 base text.', mine: 'Typed words that match no paragraph', theirs: null, theirsBy: 'Claude', theirsRev: 2,
  }

  it('lists it in the rail header, visible, with both choices', async () => {
    const m = await mountRail({ conflicts: [gone] })
    const c = m.byTestId('conflictCard', { 'data-conflict': gone.id })
    expect(m.byTestId('railHeader').contains(c)).toBe(true)
    expect(c.classList.contains('mdr-card--static')).toBe(true)
    // the scheduler never hides it: it is not one of the positioned cards
    expect(c.dataset.placed).toBeUndefined()
    expect(c.textContent).toContain('(deleted on disk)')
    expect(c.textContent).toContain('Typed words that match no paragraph')
    expect(m.all('cardAction', c).map((b) => b.dataset.action)).toEqual(['keep-mine', 'take-theirs'])
    const spy = vi.spyOn(m.bridge, 'resolveConflict')
    await click(m.byTestId('cardAction', { 'data-action': 'keep-mine' }, c))
    expect(spy).toHaveBeenCalledWith(gone.id, 'mine')
  })

  it('the save chip’s Conflict command takes the focus to it', async () => {
    const m = await mountRail({ conflicts: [gone] })
    act(() => m.hub.commands.firstConflict())
    m.frame()
    await flushAsync()
    m.frame()
    const c = m.byTestId('conflictCard', { 'data-conflict': gone.id })
    expect(c.dataset.active).toBe('true')
    expect(c.contains(document.activeElement)).toBe(true)
  })
})

describe('Resolve says so and offers Undo; Show resolved counts what it hides (rail-ui 16)', () => {
  it('resolving a thread raises a toast with an Undo that reopens it', async () => {
    const toasts: ToastInput[] = []
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t], onToast: (x) => toasts.push(x) })
    await click(m.byTestId('cardResolve', {}, m.card(t.id)))
    await flushAsync()
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.code).toBe('THREAD_RESOLVED')
    expect(toasts[0]!.kind).toBe('info')
    expect(toasts[0]!.text).toBe('Comment resolved.')
    expect(toasts[0]!.action?.label).toBe('Undo')
    await act(async () => {
      await toasts[0]!.action!.run()
    })
    expect(m.session.calls.filter((c) => c.method === 'reopen').map((c) => c.args[0])).toEqual([t.id])
  })

  it('no toast when the resolve itself failed', async () => {
    const toasts: ToastInput[] = []
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t], onToast: (x) => toasts.push(x) })
    m.session.resolve = () => Promise.reject(new Error('nope'))
    await click(m.byTestId('cardResolve', {}, m.card(t.id)))
    await flushAsync()
    expect(toasts).toEqual([])
  })

  it('"Show resolved" carries the number of resolved threads it would bring back', async () => {
    const a = thread(1, { block: 2, status: 'resolved' })
    const b = thread(2, { block: 6, status: 'resolved' })
    const open = thread(3, { block: 8 })
    const m = await mountRail({ threads: [a, b, open] })
    const toggle = m.byTestId('showResolved')
    expect(toggle.textContent).toContain('Show resolved (2)')
    expect(toggle.getAttribute('aria-label')).toBe('Show resolved (2)')
    await click(toggle)
    expect(toggle.textContent).toContain('Show resolved (2)')
  })

  it('has no count while nothing is resolved', async () => {
    const m = await mountRail({ threads: [thread(1, { block: 2 })] })
    const toggle = m.byTestId('showResolved')
    expect(toggle.textContent?.trim()).toBe('Show resolved')
    expect(toggle.getAttribute('aria-label')).toBe('Show resolved')
  })

  it('a resolved thread with a suggestion still waiting is already showing, so it is not counted as hidden', async () => {
    const t = { ...thread(1, { block: 2, status: 'resolved' }), kind: 'suggestion' as const }
    const sug = suggestionFor(t, 1)
    t.suggestions = [sug.id]
    const m = await mountRail({ threads: [t], suggestions: [sug] })
    expect(m.byTestId('showResolved').getAttribute('aria-label')).toBe('Show resolved')
  })
})
