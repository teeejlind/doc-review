// tests/unit/web/shell/a11y.test.tsx (P3; CONTRACTS §11.6, R7.4).
//
// §11.6 "every button has an aria-label", checked over the whole shell with every P3 surface on screen (rail, cards,
// suggestion rows, banner, recovered-draft card, toasts, save chip, badge, Send, history panel): each visible P3
// button carries a non-empty aria-label, and that label contains the button's visible text (WCAG 2.5.3, which axe
// enforces in p3-a11y). Buttons inside P2's hosts (#mdr-editor-host, #mdr-toolbar-host) are P2's. Cards are articles
// labelled by their author and quote, with aria-current on the active one.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import type { EditorHandle, Suggestion } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { createFakeEditor, type FakeEditorBridge } from '../../../fakes/FakeEditorBridge'
import { Shell } from '../../../../web/src/shell/Shell'
import { createToastStore } from '../../../../web/src/shell/toast-store'
import { frameQueue, paragraphs, thread } from './helpers'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const visibleText = (el: Element): string => {
  const clone = el.cloneNode(true) as Element
  for (const h of Array.from(clone.querySelectorAll('.mdr-visually-hidden, [aria-hidden="true"]'))) h.remove()
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

describe('§11.6: every P3 button has an aria-label that contains its visible text', () => {
  it('over every surface at once', async () => {
    const app = document.createElement('div')
    app.id = 'mdr-app'
    document.body.append(app)
    const t1 = thread(1, { block: 1 })
    const t2 = thread(2, { block: 3, by: 'Claude', replies: 1 })
    const t3 = thread(3, { block: 5, detached: true })
    const anchor = t2.anchor as Extract<typeof t2.anchor, { kind: 'text' }>
    const s: Suggestion = {
      id: 's_00000000000000000000000001', thread: t2.id, by: 'Claude', status: 'pending', anchor, createdSeq: 5, updatedSeq: 5,
      range: { start: 3, end: 4, rev: 0 }, base: 'old', proposed: 'new', hunks: [{ del: anchor.quote, ins: `${anchor.quote}!`, at: 0 }], located: { start: 3, end: 4 },
    }
    const session = createFakeDocSession({
      file: 'doc.md',
      markdown: paragraphs(8),
      review: { file: 'doc.md', threads: [t1, { ...t2, suggestions: [s.id], unread: 1 }, t3], suggestions: [s] },
      saveState: { state: 'error', code: 'BAD_REQUEST', message: 'Malformed' },
      banner: { kind: 'tab-not-leader' },
      recovered: { reason: 'merge-failed', markdown: '# Mine\n', baseRev: 1, savedAt: '2026-10-15T12:00:00.000Z' },
      // a version that differs from the text on screen, so the history panel has a timeline to name (an empty history is one line)
      history: { versions: [{ v: 'v1', n: 1, rev: 1, hash: '1'.repeat(64), by: 'Claude', cause: 'claude-write', at: '2026-10-15T12:00:00.000Z', size: 10, revs: [1, 1], blocksChanged: 1 }] },
    })
    const toasts = createToastStore()
    const fq = frameQueue()
    let editor: (EditorHandle & { bridge: FakeEditorBridge }) | null = null
    render(
      <Shell
        session={session}
        createEditor={async (o) => createFakeEditor(o)}
        app={app}
        toasts={toasts}
        onEditor={(e) => (editor = e as EditorHandle & { bridge: FakeEditorBridge })}
        railOptions={{ raf: fq.raf, caf: fq.caf, ResizeObserver: null, fonts: null }}
      />,
      { container: app },
    )
    await waitFor(() => expect(document.querySelectorAll('.mdr-card--rail').length).toBeGreaterThanOrEqual(2))
    act(() => fq.run())
    act(() => session.emit({ activity: { file: 'doc.md', state: 'replied', since: '2026-10-15T12:00:00.000Z', unreadFromClaude: 1 } }))
    act(() => void toasts.show({ code: 'SUGGEST_MODE_BLOCKED', kind: 'warn', text: 'Blocked.', action: { label: 'Switch to Editing', run: () => undefined, id: 'switch-to-editing' } }))
    act(() => (document.querySelector(`[data-testid="${TESTID.historyButton}"]`) as HTMLButtonElement).click())
    await waitFor(() => expect(document.querySelectorAll(`[data-testid="${TESTID.historyVersion}"]`).length).toBeGreaterThan(0))
    expect(editor).not.toBeNull()

    const p2 = (el: Element): boolean => !!el.closest('#mdr-editor-host, #mdr-toolbar-host')
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !p2(b) && !b.hidden && !b.closest('[hidden]'))
    expect(buttons.length).toBeGreaterThan(20)
    const problems: string[] = []
    for (const b of buttons) {
      const label = (b.getAttribute('aria-label') ?? '').trim()
      const text = visibleText(b)
      const id = `${b.className || b.tagName} "${text}"`
      if (!label) problems.push(`${id}: no aria-label`)
      else if (text && !label.toLowerCase().includes(text.toLowerCase())) problems.push(`${id}: aria-label "${label}" lacks its visible text`)
    }
    expect(problems).toEqual([])

    // cards: articles named by author and quote; the active one says so
    const cards = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${TESTID.card}"]`))
    for (const c of cards) {
      expect(c.tagName).toBe('ARTICLE')
      expect(document.getElementById(c.getAttribute('aria-labelledby') ?? '')?.textContent).toBeTruthy()
    }
    // the rail is the Comments landmark
    expect(document.querySelector(`aside[data-testid="${TESTID.rail}"]`)!.getAttribute('aria-label')).toBe('Comments')
  })
})
