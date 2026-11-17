// tests/unit/web/threads/qa3-errors.test.tsx (QA round 3, cli-handoff). A comment that can't be posted because the review
// server is gone used to say "Couldn't post: Failed to fetch" (Chrome's wording; Safari says "Load failed"). It now
// says what happened and what to do, and keeps the text in the box. A refusal that has a reason keeps its reason.
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionError } from '../../../../web/src/session/errors'
import { actionFailure, isUnreachableError, opFailure, postFailure, saveFailure } from '../../../../web/src/threads/errors'
import { flushAsync, mountRail, textTarget } from './mount'
import { thread } from '../shell/helpers'

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

const OFFLINE = new SessionError({ code: 'SERVER_UNREACHABLE', status: 0, message: 'Failed to fetch', network: true })

describe('failure copy (pure)', () => {
  it('knows an unreachable server: the session\'s network error, or the browser\'s own TypeError (Chrome, Safari, Firefox)', () => {
    expect(isUnreachableError(OFFLINE)).toBe(true)
    for (const m of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) expect(isUnreachableError(new TypeError(m))).toBe(true)
    expect(isUnreachableError(new SessionError({ code: 'READ_ONLY', status: 422, message: 'This file is read-only right now.' }))).toBe(false)
    expect(isUnreachableError('boom')).toBe(false)
  })

  it('post: says what happened, that the text is still there, and what to do', () => {
    expect(postFailure(OFFLINE, 'comment')).toBe('Can’t reach the review server, so this comment wasn’t posted. Your text is still here. Ask Claude to reopen the review, then try again.')
    expect(postFailure(new TypeError('Load failed'), 'reply')).toBe('Can’t reach the review server, so this reply wasn’t posted. Your text is still here. Ask Claude to reopen the review, then try again.')
    expect(postFailure(new Error('This file is read-only right now.'), 'comment')).toBe('Couldn’t post: This file is read-only right now.')
  })

  it('save and other actions follow the same pattern', () => {
    expect(saveFailure(OFFLINE)).toBe('Can’t reach the review server, so this change wasn’t saved. Your text is still here. Ask Claude to reopen the review, then try again.')
    expect(saveFailure(new Error('nope'))).toBe('Couldn’t save: nope')
    expect(actionFailure(OFFLINE, 'accept')).toBe('Can’t reach the review server, so that didn’t go through. Ask Claude to reopen the review, then try again.')
    expect(actionFailure(new Error('nope'), 'accept')).toBe('Couldn’t accept: nope')
    expect(opFailure(OFFLINE)).toBe('Can’t reach the review server, so that didn’t go through. Ask Claude to reopen the review, then try again.')
    expect(opFailure(new Error('nope'))).toBe('nope')
  })

  it('no browser wording leaks through', () => {
    for (const m of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
      for (const text of [postFailure(new TypeError(m), 'comment'), saveFailure(new TypeError(m)), actionFailure(new TypeError(m), 'resolve')]) {
        expect(text).not.toContain(m)
        expect(text).not.toMatch(/fetch|load failed/i)
      }
    }
  })
})

describe('the composer and the reply box show it', () => {
  it('a new comment that can\'t be posted: the sentence, the text kept, the button back to Post', async () => {
    const m = await mountRail()
    vi.spyOn(m.session, 'createThread').mockRejectedValue(new TypeError('Failed to fetch'))
    m.scriptSelection(textTarget(2, 'topic 2', 120, 144))
    await click(m.byTestId('commentButton'))
    m.frame()
    const draft = m.$<HTMLElement>('[data-draft="true"]')
    const area = m.byTestId('cardReply', {}, draft) as HTMLTextAreaElement
    type(area, 'Which quarter exactly?')
    await click(m.byTestId('cardSubmit', {}, draft))
    await flushAsync()
    const err = m.$<HTMLElement>('[data-draft="true"] .mdr-composer-error')
    expect(err.textContent).toBe('Can’t reach the review server, so this comment wasn’t posted. Your text is still here. Ask Claude to reopen the review, then try again.')
    expect((m.byTestId('cardReply', {}, m.$('[data-draft="true"]')) as HTMLTextAreaElement).value).toBe('Which quarter exactly?')
    expect((m.byTestId('cardSubmit', {}, m.$('[data-draft="true"]')) as HTMLButtonElement).disabled).toBe(false)
  })

  it('a refusal with a reason keeps the reason', async () => {
    const m = await mountRail()
    vi.spyOn(m.session, 'createThread').mockRejectedValue(new SessionError({ code: 'READ_ONLY', status: 422, message: 'This file is read-only right now.' }))
    m.scriptSelection(textTarget(2, 'topic 2', 120, 144))
    await click(m.byTestId('commentButton'))
    m.frame()
    const draft = m.$<HTMLElement>('[data-draft="true"]')
    type(m.byTestId('cardReply', {}, draft) as HTMLTextAreaElement, 'x')
    await click(m.byTestId('cardSubmit', {}, draft))
    await flushAsync()
    expect(m.$<HTMLElement>('[data-draft="true"] .mdr-composer-error').textContent).toBe('Couldn’t post: This file is read-only right now.')
  })

  it('a reply that can\'t be posted says so in the card', async () => {
    const t = thread(1, { block: 2, by: 'TJ', replies: 1 })
    const m = await mountRail({ threads: [t] })
    vi.spyOn(m.session, 'reply').mockRejectedValue(OFFLINE)
    const c = m.card(t.id)
    type(m.byTestId('cardReply', {}, c) as HTMLTextAreaElement, 'Agreed, fixing.')
    await click(m.byTestId('cardSubmit', {}, c))
    await flushAsync()
    expect(m.card(t.id).querySelector('.mdr-composer-error')!.textContent).toBe(
      'Can’t reach the review server, so this reply wasn’t posted. Your text is still here. Ask Claude to reopen the review, then try again.',
    )
  })
})

describe('a refused token says to reload, never the raw reason (QA pass 4 #3)', () => {
  const e = Object.assign(new Error('wrong token'), { code: 'UNAUTHORIZED' })
  it('post, edit, op and decision failures read the same sentence', () => {
    for (const t of [postFailure(e, 'comment'), saveFailure(e), opFailure(e), actionFailure(e, 'accept')]) {
      expect(t).toContain('lost its connection to the review. Reload to keep going.')
      expect(t).not.toMatch(/wrong token|UNAUTHORIZED/)
    }
  })
})
