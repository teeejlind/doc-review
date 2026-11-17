// tests/unit/web/identity/t2-cli-refresh.test.tsx (fix pass T2 cli; QA_FINDINGS Pass 4 #13).
//
// `mdr config set name` applies on the server at once (GET /api/me resolves per request), but the page read the name
// from <meta> tags written when it loaded, so its cards and its copied prompt kept the old name until a reload while
// Claude and the wake prompt already used the new one. The page now re-reads /api/me when the person returns to it and
// when the session hears something new, swaps the tags, and re-renders what shows a name.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import {
  IDENTITY_GAP_MS, identityVersion, personName, promptIdentity, refreshIdentity, subscribeIdentity, userName, watchIdentity, type IdentityFetch,
} from '../../../../web/src/identity'
import { useIdentityWatch } from '../../../../web/src/useIdentity'
import { authorLabel } from '../../../../web/src/threads/model'

function setMeta(tags: Record<string, string>): void {
  for (const [name, content] of Object.entries(tags)) {
    const el = document.createElement('meta')
    el.name = name
    el.content = content
    el.dataset.test = 'identity'
    document.head.appendChild(el)
  }
}

const TAGS = { 'mdr-token': 'f'.repeat(64), 'mdr-user-name': 'TJ Lind', 'mdr-user-source': 'os-full-name' }

/** A /api/me that answers with whatever `me.current` is. */
function server(initial: { displayName: string; source: string }) {
  const me = { current: initial }
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch: IdentityFetch = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, ...me.current }) })
  })
  return { me, calls, fetch }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  for (const el of Array.from(document.head.querySelectorAll('meta[data-test="identity"]'))) el.remove()
})

describe('refreshIdentity', () => {
  it('asks GET /api/me with the page token and swaps the name and source tags; subscribers hear it once', async () => {
    setMeta(TAGS)
    const s = server({ displayName: 'Marisol Vega', source: 'config' })
    const heard = vi.fn()
    const off = subscribeIdentity(heard)
    const v0 = identityVersion()
    expect(userName()).toBe('TJ Lind')

    expect(await refreshIdentity(s.fetch)).toBe(true)

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.url).toBe('/api/me')
    expect(s.calls[0]!.init).toMatchObject({ method: 'GET', headers: { 'X-MDR-Client': 'web', Authorization: `Bearer ${'f'.repeat(64)}` }, credentials: 'same-origin', cache: 'no-store' })
    expect(userName()).toBe('Marisol Vega')
    expect(personName('TJ')).toBe('Marisol Vega')
    expect(authorLabel('TJ')).toBe('Marisol Vega')
    expect(document.querySelector('meta[name="mdr-user-source"]')!.getAttribute('content')).toBe('config')
    // the copied prompt names the new person for Claude
    expect(promptIdentity().who).toBe('Marisol Vega')
    expect(identityVersion()).toBe(v0 + 1)
    expect(heard).toHaveBeenCalledTimes(1)

    // nothing changed: no new version, nobody told
    expect(await refreshIdentity(s.fetch)).toBe(false)
    expect(identityVersion()).toBe(v0 + 1)
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  it('a source change alone (config → default) is a change too: the prompt says "the user" for the default name', async () => {
    setMeta({ ...TAGS, 'mdr-user-name': 'You', 'mdr-user-source': 'config' })
    expect(promptIdentity().who).toBe('You')
    const s = server({ displayName: 'You', source: 'default' })
    expect(await refreshIdentity(s.fetch)).toBe(true)
    expect(userName()).toBe('You')
    expect(promptIdentity().who).toBe('the user')
  })

  it('leaves the page alone when the server is offline, refuses, or answers nonsense', async () => {
    setMeta(TAGS)
    const heard = vi.fn()
    const off = subscribeIdentity(heard)
    const reject: IdentityFetch = () => Promise.reject(new TypeError('Failed to fetch'))
    const refused: IdentityFetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
    const empty: IdentityFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, displayName: '', source: 'config' }) })
    const html: IdentityFetch = () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('Unexpected token <')) })
    for (const f of [reject, refused, empty, html]) expect(await refreshIdentity(f)).toBe(false)
    expect(userName()).toBe('TJ Lind')
    expect(heard).not.toHaveBeenCalled()
    off()
  })

  it('a page without the tags (a fake build, a unit test) or without a token asks nobody', async () => {
    const s = server({ displayName: 'Ana', source: 'config' })
    expect(await refreshIdentity(s.fetch)).toBe(false)
    setMeta({ 'mdr-user-name': 'TJ Lind', 'mdr-user-source': 'git' }) // no token
    expect(await refreshIdentity(s.fetch)).toBe(false)
    expect(s.calls).toHaveLength(0)
    expect(userName()).toBe('TJ Lind')
  })
})

describe('watchIdentity: when the page asks', () => {
  const setup = (o: { gapMs?: number } = {}) => {
    setMeta(TAGS)
    const s = server({ displayName: 'TJ Lind', source: 'os-full-name' })
    const session = createFakeDocSession({ file: 'plan.md', root: '/work' })
    const stop = watchIdentity(session, { fetch: s.fetch, ...(o.gapMs !== undefined ? { gapMs: o.gapMs } : {}) })
    return { s, session, stop }
  }

  it('the person coming back to the page (window focus) asks, and the page shows the answer', async () => {
    const { s, stop } = setup()
    s.me.current = { displayName: 'Marisol Vega', source: 'config' }
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls).toHaveLength(1)
    expect(userName()).toBe('Marisol Vega')
    stop()
  })

  it('a tab shown again asks; a tab hidden does not', async () => {
    const { s, stop } = setup({ gapMs: 0 })
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls).toHaveLength(0)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls).toHaveLength(1)
    visibility.mockRestore()
    stop()
  })

  it('Claude doing something (review, presence, activity, handoff) asks; a doc or save change does not', async () => {
    const { s, session, stop } = setup({ gapMs: 0 })
    const asked = async (fn: () => void): Promise<number> => {
      const before = s.calls.length
      act(fn)
      await vi.advanceTimersByTimeAsync(0)
      return s.calls.length - before
    }
    expect(await asked(() => session.emit({ snapshot: session.getSnapshot() }))).toBe(0)
    expect(await asked(() => session.emit({ save: session.getSaveState() }))).toBe(0)
    expect(await asked(() => session.emit({ review: session.getReview() }))).toBeGreaterThan(0)
    expect(await asked(() => session.emit({ presence: { waiter: 'connected' } }))).toBe(1)
    expect(await asked(() => session.emit({ activity: { file: 'plan.md', state: 'working', since: '2026-10-24T12:00:00.000Z', unreadFromClaude: 0 } }))).toBe(1)
    expect(await asked(() => session.emit({ handoff: { file: 'plan.md', seq: 1, state: 'sent', delivery: 'waiter' } }))).toBe(1)
    stop()
  })

  it('at most one ask per gap: a burst is held and sent once when the gap is over, with the freshest answer', async () => {
    const { s, session, stop } = setup()
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls).toHaveLength(1)
    // the name changes during the gap, and three more things happen
    s.me.current = { displayName: 'Marisol Vega', source: 'config' }
    window.dispatchEvent(new Event('focus'))
    act(() => session.emit({ presence: { waiter: 'grace' } }))
    act(() => session.emit({ presence: { waiter: 'none' } }))
    await vi.advanceTimersByTimeAsync(IDENTITY_GAP_MS - 100)
    expect(s.calls).toHaveLength(1)
    expect(userName()).toBe('TJ Lind')
    await vi.advanceTimersByTimeAsync(200)
    expect(s.calls).toHaveLength(2)
    expect(userName()).toBe('Marisol Vega')
    stop()
  })

  it('stopping removes every listener and the held ask', async () => {
    const { s, session, stop } = setup()
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('focus')) // held
    stop()
    await vi.advanceTimersByTimeAsync(IDENTITY_GAP_MS * 2)
    window.dispatchEvent(new Event('focus'))
    act(() => session.emit({ presence: { waiter: 'connected' } }))
    await vi.advanceTimersByTimeAsync(IDENTITY_GAP_MS * 2)
    expect(s.calls).toHaveLength(1)
  })
})

describe('useIdentityWatch: what shows the name re-renders when it changes', () => {
  function Who({ session }: { session: ReturnType<typeof createFakeDocSession> }) {
    useIdentityWatch(session)
    return <p data-testid="who">{authorLabel('TJ')}</p>
  }

  it('the card author reads the new name after the page is refocused, with no reload', async () => {
    vi.useRealTimers()
    setMeta(TAGS)
    const s = server({ displayName: 'TJ Lind', source: 'os-full-name' })
    const session = createFakeDocSession({ file: 'plan.md', root: '/work' })
    const realFetch = globalThis.fetch
    globalThis.fetch = ((url: string, init: RequestInit) => s.fetch(url, init)) as unknown as typeof fetch
    try {
      const ui = render(<Who session={session} />)
      expect(ui.getByTestId('who').textContent).toBe('TJ Lind')
      s.me.current = { displayName: 'Marisol Vega', source: 'config' }
      act(() => void window.dispatchEvent(new Event('focus')))
      await waitFor(() => expect(ui.getByTestId('who').textContent).toBe('Marisol Vega'))
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
