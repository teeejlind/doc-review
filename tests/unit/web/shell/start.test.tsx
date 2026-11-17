// tests/unit/web/shell/start.test.tsx (P3; CONTRACTS §12.0.1, §12.0.2, §12.0.3).
//
// The page boot: the empty state without ?file= (and its root channel), the error/empty state from mdr-file-error,
// the "must be opened from mdr open" state when readBootstrap throws, openDocSession rejections, and navigation
// that flushes before the full page load.
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import type { ConnectRootChannel, DocSession, OpenDocSession, RootChannel, SessionBootstrap } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { readBootstrap } from '../../../fakes/web-session'
import { startPage, type PageResult } from '../../../../web/src/shell/start'

type Loc = { assign: Mock<(url: string | URL) => void>; reload: Mock<() => void>; search: string }

function page(meta: Record<string, string>, search = ''): { loc: Loc } {
  document.head.innerHTML = Object.entries(meta).map(([k, v]) => `<meta name="${k}" content="${v}">`).join('')
  document.body.innerHTML = '<div id="mdr-app" class="mdr-app"><div id="mdr-scroll"></div></div>'
  return { loc: { assign: vi.fn<(url: string | URL) => void>(), reload: vi.fn<() => void>(), search } }
}

const BASE = { 'mdr-token': 'tok', 'mdr-root': '/root', 'mdr-root-hash': 'h', 'mdr-port': '8301', 'mdr-version': '2', 'mdr-protocol': '2', 'mdr-fingerprint': 'f' }

function rootChannel() {
  const subs = new Set<(f: string) => void>()
  const channel: RootChannel = { onNavigate: (cb) => (subs.add(cb), () => subs.delete(cb)), close: vi.fn() }
  const connect = vi.fn<ConnectRootChannel>(() => channel)
  return { connect, navigate: (f: string) => subs.forEach((cb) => cb(f)) }
}

let result: PageResult | null = null
afterEach(() => {
  act(() => result?.root.unmount())
  result = null
  document.head.innerHTML = ''
})

const emptyState = (): HTMLElement => document.querySelector(`[data-testid="${TESTID.emptyState}"]`) as HTMLElement

/** Empty and error states render inside the §12.0.1 frame: every host id and test id is still there. */
function expectFrame(): void {
  for (const id of ['mdr-toolbar-host', 'mdr-scroll', 'mdr-editor-host']) expect(document.querySelectorAll(`#${id}`)).toHaveLength(1)
  for (const t of [TESTID.topbar, TESTID.scroll, TESTID.rail]) expect(document.querySelectorAll(`[data-testid="${t}"]`)).toHaveLength(1)
  expect(document.querySelector('.mdr-doc-col')!.contains(emptyState())).toBe(true)
}

describe('startPage: no document (§12.0.1)', () => {
  it('without ?file=: the empty state, no session, and the root channel navigates with a full page load', async () => {
    const { loc } = page({ ...BASE, 'mdr-file': '' })
    const ch = rootChannel()
    const open = vi.fn<OpenDocSession>()
    const renderApp = vi.fn()
    result = await act(() => startPage({ readBootstrap, openDocSession: open, connectRootChannel: ch.connect, renderApp, location: loc }))
    expect(result.kind).toBe('empty')
    expect(emptyState().dataset.reason).toBe('no-file')
    expect(emptyState().querySelector('.mdr-empty-state-text')!.textContent).toBe('No document is open. Ask Claude to open one for review.')
    expect(open).not.toHaveBeenCalled()
    expect(renderApp).not.toHaveBeenCalled()
    expect(ch.connect).toHaveBeenCalledTimes(1)
    expect(ch.connect.mock.calls[0]![0].token).toBe('tok')
    ch.navigate('notes/next file.md')
    expect(loc.assign).toHaveBeenCalledWith('/?file=notes%2Fnext%20file.md')
    expect(document.getElementById('mdr-app')!.dataset.theme).toMatch(/^(light|dark)$/)
    expectFrame()
  })

  it.each([
    ['FILE_NOT_FOUND', 'nope.md', "We couldn't find nope.md. Ask Claude to reopen it."],
    ['PROTECTED_ROOT', 'approvals/x.md', "approvals/x.md is in a protected folder, so it can't be reviewed here."],
    ['PATH_OUTSIDE_ROOT', '../x.md', '../x.md is outside the folder being reviewed. Ask Claude to open it from there.'],
    ['BAD_REQUEST', 'x.txt', 'Only Markdown files (.md or .markdown) can be reviewed here.'],
  ])('mdr-file-error %s renders the empty state with that reason and copy', async (code, file, copy) => {
    const { loc } = page({ ...BASE, 'mdr-file': '', 'mdr-file-error': code }, `?file=${encodeURIComponent(file)}`)
    const ch = rootChannel()
    result = await act(() => startPage({ readBootstrap, openDocSession: vi.fn(), connectRootChannel: ch.connect, renderApp: vi.fn(), location: loc }))
    expect(result).toMatchObject({ kind: 'empty', reason: code })
    expect(emptyState().dataset.reason).toBe(code)
    expect(emptyState().querySelector('.mdr-empty-state-text')!.textContent).toBe(copy)
    // a missing file offers the command to reopen it; the other reasons have nothing to copy
    expect(emptyState().querySelector('button')?.textContent ?? null).toBe(code === 'FILE_NOT_FOUND' ? 'Copy command' : null)
    // no brand eyebrow, and the empty top bar is hidden (still in the frame)
    expect(emptyState().querySelector('.mdr-empty-state-mark')).toBeNull()
    expect(emptyState().textContent).not.toMatch(/\bmdr\b/i)
    expect(document.querySelector<HTMLElement>(`[data-testid="${TESTID.topbar}"]`)!.hidden).toBe(true)
    expect(ch.connect).toHaveBeenCalledTimes(1)
    expectFrame()
  })

  it('QA3: a missing file’s Copy command puts the command that reopens it on the clipboard, and says so', async () => {
    const writeText = vi.fn(async (_: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { loc } = page({ ...BASE, 'mdr-file': '', 'mdr-file-error': 'FILE_NOT_FOUND' }, '?file=my%20notes%2Fnope.md')
    result = await act(() => startPage({ readBootstrap, openDocSession: vi.fn(), connectRootChannel: rootChannel().connect, renderApp: vi.fn(), location: loc }))
    const button = emptyState().querySelector('button')!
    expect(button.textContent).toBe('Copy command')
    await act(async () => button.click())
    expect(writeText).toHaveBeenCalledWith('mdr open "my notes/nope.md"')
    expect(button.textContent).toBe('Copied')
    expect(button.getAttribute('aria-label')).toBe('Copied')
  })

  it('readBootstrap throwing: "This page has to be opened by Claude" with a Reload button, no root channel', async () => {
    const { loc } = page({}, '?file=a.md')
    const ch = rootChannel()
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    result = await act(() => startPage({ readBootstrap, openDocSession: vi.fn(), connectRootChannel: ch.connect, renderApp: vi.fn(), location: loc }))
    err.mockRestore()
    expect(result.kind).toBe('error')
    expect(emptyState().dataset.reason).toBe('no-bootstrap')
    expect(emptyState().querySelector('.mdr-empty-state-text')!.textContent).toBe('This page has to be opened by Claude. Ask it to open a document for review.')
    const reload = emptyState().querySelector('button')!
    expect(reload.textContent).toBe('Reload')
    act(() => reload.click())
    expect(loc.reload).toHaveBeenCalledTimes(1)
    expect(ch.connect).not.toHaveBeenCalled()
    expectFrame()
  })
})

describe('startPage: openDocSession (§12.0.3)', () => {
  it.each(['FILE_NOT_FOUND', 'DOC_GONE', 'PROTECTED_ROOT', 'PATH_OUTSIDE_ROOT'])('a %s rejection renders the empty state with that reason', async (code) => {
    const { loc } = page({ ...BASE, 'mdr-file': 'a.md' }, '?file=a.md')
    const ch = rootChannel()
    const open = vi.fn<OpenDocSession>(async () => {
      throw Object.assign(new Error('nope'), { code })
    })
    result = await act(() => startPage({ readBootstrap, openDocSession: open, connectRootChannel: ch.connect, renderApp: vi.fn(), location: loc }))
    expect(result).toMatchObject({ kind: 'empty', reason: code })
    expect(emptyState().dataset.reason).toBe(code)
    expect(ch.connect).toHaveBeenCalledTimes(1)
  })

  it('reads the code from an ApiError envelope too', async () => {
    const { loc } = page({ ...BASE, 'mdr-file': 'a.md' }, '?file=a.md')
    const open = vi.fn<OpenDocSession>(async () => {
      throw { ok: false, error: { code: 'DOC_GONE', message: 'gone' } }
    })
    result = await act(() => startPage({ readBootstrap, openDocSession: open, connectRootChannel: rootChannel().connect, renderApp: vi.fn(), location: loc }))
    expect(result).toMatchObject({ kind: 'empty', reason: 'DOC_GONE' })
    expect(emptyState().querySelector('.mdr-empty-state-text')!.textContent).toBe("We couldn't find a.md. Ask Claude to reopen it.")
  })

  it('any other rejection: an error state with the message and Reload', async () => {
    const { loc } = page({ ...BASE, 'mdr-file': 'a.md' }, '?file=a.md')
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const open = vi.fn<OpenDocSession>(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'INTERNAL' })
    })
    result = await act(() => startPage({ readBootstrap, openDocSession: open, connectRootChannel: rootChannel().connect, renderApp: vi.fn(), location: loc }))
    err.mockRestore()
    expect(result).toMatchObject({ kind: 'error', reason: 'open-failed' })
    expect(emptyState().querySelector('.mdr-empty-state-detail')!.textContent).toBe('socket hang up')
    expect(emptyState().querySelector('button')!.textContent).toBe('Reload')
  })

  it('opens the session with the validated file, renders the app, titles the tab', async () => {
    const { loc } = page({ ...BASE, 'mdr-file': 'notes/plan.md', 'mdr-test-hooks': '1' }, '?file=notes%2Fplan.md')
    const session = createFakeDocSession({ file: 'notes/plan.md' })
    const open = vi.fn<OpenDocSession>(async () => session)
    const renderApp = vi.fn((s: DocSession) => <div data-testid="app-under-test">{s.file}</div>)
    result = await act(() => startPage({ readBootstrap, openDocSession: open, connectRootChannel: rootChannel().connect, renderApp, location: loc }))
    expect(result.kind).toBe('app')
    const boot = open.mock.calls[0]![0].boot as SessionBootstrap
    expect(open.mock.calls[0]![0].file).toBe('notes/plan.md')
    expect(boot.testHooks).toBe(true)
    expect(renderApp).toHaveBeenCalledWith(session, document.getElementById('mdr-app'))
    expect(document.querySelector('[data-testid="app-under-test"]')!.textContent).toBe('notes/plan.md')
    expect(document.title).toBe('plan.md · mdr')
  })
})

describe('startPage: navigation flushes, then reloads (§12.0.3)', () => {
  it('session.onNavigate → await flush() → location.assign, never before the flush resolves; a second navigate is ignored', async () => {
    const { loc } = page({ ...BASE, 'mdr-file': 'a.md' }, '?file=a.md')
    const session = createFakeDocSession({ file: 'a.md' })
    let release: () => void = () => undefined
    const flush = vi.spyOn(session, 'flush').mockImplementation(() => new Promise((r) => (release = () => r({ rev: 3 }))))
    result = await act(() => startPage({ readBootstrap, openDocSession: async () => session, connectRootChannel: rootChannel().connect, renderApp: () => null, location: loc }))
    session.emit({ navigate: 'b.md' })
    session.emit({ navigate: 'c.md' })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(loc.assign).not.toHaveBeenCalled()
    await act(async () => release())
    expect(loc.assign).toHaveBeenCalledTimes(1)
    expect(loc.assign).toHaveBeenCalledWith('/?file=b.md')
  })

  it('a failed flush still navigates', async () => {
    const { loc } = page({ ...BASE, 'mdr-file': 'a.md' }, '?file=a.md')
    const session = createFakeDocSession({ file: 'a.md' })
    vi.spyOn(session, 'flush').mockRejectedValue(new Error('offline'))
    result = await act(() => startPage({ readBootstrap, openDocSession: async () => session, connectRootChannel: rootChannel().connect, renderApp: () => null, location: loc }))
    await act(async () => session.emit({ navigate: 'b.md' }))
    expect(loc.assign).toHaveBeenCalledWith('/?file=b.md')
  })
})
