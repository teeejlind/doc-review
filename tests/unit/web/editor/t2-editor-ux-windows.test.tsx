// tests/unit/web/editor/t2-editor-ux-windows.test.tsx (T2 editor-ux): Pass 4 #21 and #35 on an emulated Windows.
//
// The platform is set before any module loads (vi.hoisted), because prosemirror-keymap reads navigator.platform once,
// at import, and the toolbar's titles are built at import too. Windows can't run here, so it is emulated.
//   #35 Ctrl+Alt+Shift+X / E switch modes (prosemirror-keymap skips its keyCode fallback for Ctrl+Alt on Windows, and
//       Shift makes event.key the capital, so the lowercase binding never matched).
//   #21 every shortcut hint reads Ctrl / Alt / Shift, none a ⌘: the formatting toolbar and the mode pill, the top bar's
//       Comment and Previous / Next, Send to Claude, and the copy-failed dialog's "press Ctrl+C".
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', configurable: true })
})

import { TESTID } from '../../../../shared/constants'
import type { EditorBridge, SelectionTarget, ShortcutBinding } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { createHandoffController } from '../../../../web/src/handoff/controller'
import { PromptModal, SendButton } from '../../../../web/src/handoff/HandoffControls'
import { createToastStore } from '../../../../web/src/shell/toast-store'
import { TopbarThreads } from '../../../../web/src/threads/TopbarThreads'
import { mount, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  cleanup()
  document.body.innerHTML = ''
  await m?.close()
  m = null
})

/** A keydown as Windows Chrome sends Ctrl+Alt+Shift+<letter>: the capital in `key`, the letter's code in `keyCode`. */
function chord(mm: Mounted, key: string, keyCode: number): boolean {
  const e = new KeyboardEvent('keydown', { key, keyCode, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true })
  return mm.view.someProp('handleKeyDown', (f) => f(mm.view, e)) ?? false
}

describe('Pass 4 #35: the mode chords on Windows', () => {
  it('Ctrl+Alt+Shift+X switches to Suggesting and Ctrl+Alt+Shift+E back to Editing', async () => {
    m = await mount({ markdown: 'Hello.\n' })
    expect(m.bridge.getMode()).toBe('editing')
    expect(chord(m, 'X', 88)).toBe(true)
    expect(m.bridge.getMode()).toBe('suggesting')
    expect(chord(m, 'E', 69)).toBe(true)
    expect(m.bridge.getMode()).toBe('editing')
  })

  it('with nothing focused the same chords still reach the editor (the page-level handler)', async () => {
    m = await mount({ markdown: 'Hello.\n' })
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', keyCode: 88, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    expect(m.bridge.getMode()).toBe('suggesting')
  })

  it('a plain Ctrl+Alt+X (no Shift) is not a mode chord', async () => {
    m = await mount({ markdown: 'Hello.\n' })
    const e = new KeyboardEvent('keydown', { key: 'x', keyCode: 88, ctrlKey: true, altKey: true, bubbles: true, cancelable: true })
    expect(m.view.someProp('handleKeyDown', (f) => f(m!.view, e)) ?? false).toBe(false)
    expect(m.bridge.getMode()).toBe('editing')
  })
})

describe('Pass 4 #21: shortcut hints on Windows', () => {
  it('the formatting toolbar and the mode pill name Ctrl / Alt / Shift', async () => {
    m = await mount({ markdown: 'Hello.\n' })
    const title = (action: string): string => m!.toolbarHost.querySelector<HTMLElement>(`[data-action="${action}"]`)!.title
    expect(title('bold')).toBe('Bold (Ctrl+B)')
    expect(title('redo')).toBe('Redo (Ctrl+Shift+Z)')
    expect(title('heading-2')).toBe('Heading 2 (Ctrl+Alt+2)')
    expect(title('code-block')).toBe('Code block (Ctrl+Alt+C)')
    const pill = m.toolbarHost.querySelector<HTMLElement>(`[data-testid="${TESTID.modePill}"]`)!
    expect(pill.title).toContain('(Ctrl+Alt+Shift+X)')
    m.bridge.setMode('suggesting')
    expect(pill.title).toContain('(Ctrl+Alt+Shift+E)')
    expect(pill.getAttribute('aria-label')).toContain('(Ctrl+Alt+Shift+E)')
    for (const el of m.toolbarHost.querySelectorAll<HTMLElement>('[title]')) expect(el.title).not.toMatch(/[⌘⌥⇧]/)
  })

  const selection = (t: SelectionTarget = null) => ({ get: () => t, refresh: () => t, subscribe: () => () => undefined, destroy: () => undefined })
  const commands = { comment: () => undefined, nav: () => undefined, firstUnread: () => undefined, firstConflict: () => undefined, hasUnsent: () => false, postUnsent: () => Promise.resolve(true) }

  it('the top bar: Comment, Previous and Next comment', () => {
    render(<TopbarThreads commands={commands} selection={selection()} navCount={{ get: () => 3, subscribe: () => () => undefined }} />)
    const title = (id: string): string => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.title
    expect(title(TESTID.commentButton)).toBe('Select text to comment on it (Ctrl+Alt+M)')
    expect(title(TESTID.navPrev)).toBe('Previous comment (Ctrl+Alt+[)')
    expect(title(TESTID.navNext)).toBe('Next comment (Ctrl+Alt+])')
  })

  function handoff(o: { refuse?: boolean } = {}) {
    const clipboard = { writeText: vi.fn(() => (o.refuse ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : Promise.resolve())) }
    const session = createFakeDocSession({ file: 'notes/plan.md', root: '/work', review: { presence: { waiter: 'none' } }, clipboard })
    const controller = createHandoffController({ session, toasts: createToastStore(), clipboard })
    const bridge = { registerShortcut: (_b: ShortcutBinding) => () => undefined } as unknown as EditorBridge
    render(<><SendButton controller={controller} bridge={bridge} /><PromptModal controller={controller} /></>)
    return controller
  }

  it('Send to Claude names both chords with Ctrl', () => {
    handoff()
    expect(document.querySelector<HTMLElement>(`[data-testid="${TESTID.send}"]`)!.title).toBe(
      'Send to Claude (Ctrl+Enter in the document, Ctrl+Shift+Enter anywhere)',
    )
  })

  it('the copy-failed dialog says press Ctrl+C', async () => {
    handoff({ refuse: true })
    act(() => document.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.send}"]`)!.click())
    await waitFor(() => expect(document.querySelector(`[data-testid="${TESTID.promptModal}"]`)).not.toBeNull())
    // Pass 4 #29 (T2 cli): a refused copy opens the dialog in its manual form, with the message selected and no Copy button
    const modal = document.querySelector<HTMLElement>(`[data-testid="${TESTID.promptModal}"]`)!
    expect(modal.dataset.copy).toBe('manual')
    expect(modal.querySelector(`[data-testid="${TESTID.toastAction}"]`)).toBeNull()
    expect(modal.textContent).toContain('press Ctrl+C')
    expect(modal.textContent).not.toMatch(/⌘|Cmd/)
  })
})
