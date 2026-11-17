// tests/unit/web/shell/shell.test.tsx (P3; CONTRACTS §12.0.1, §12.0.3, §12.2.4, §11.3, §11.4).
//
// The shell against the fake session + fake editor (model layout under jsdom, real content coordinates): the §12.0.1
// hosts handed to createEditor, data-mode on #mdr-app, quiet chrome, the rail laying cards out from anchor rects
// (never on a React render), activation from a highlight, editor failure, and destroy-then-close on unmount.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSTANTS, TESTID } from '../../../../shared/constants'
import type { CreateEditor, EditorHandle } from '../../../../shared/types'
import { createFakeDocSession, type FakeDocSession } from '../../../fakes/FakeDocSession'
import { createFakeEditor, type FakeEditorBridge } from '../../../fakes/FakeEditorBridge'
import type { RailFrame } from '../../../../web/src/rail/scheduler'
import { Shell } from '../../../../web/src/shell/Shell'
import { frameQueue, paragraphs, reviewWith, thread } from './helpers'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function mount(o: { session?: FakeDocSession; createEditor?: CreateEditor } = {}) {
  const app = document.createElement('div')
  app.id = 'mdr-app'
  app.className = 'mdr-app'
  document.body.append(app)
  const session = o.session ?? createFakeDocSession({ file: 'doc.md', markdown: paragraphs(6), review: reviewWith([thread(1, { block: 1 }), thread(2, { block: 4, by: 'Claude' })]) })
  const fq = frameQueue()
  const frames: RailFrame[] = []
  let editor: (EditorHandle & { bridge: FakeEditorBridge }) | null = null
  const create: CreateEditor = o.createEditor ?? (async (opts) => createFakeEditor(opts))
  const createSpy = vi.fn(create)
  const ui = (
    <Shell
      session={session}
      createEditor={createSpy}
      app={app}
      onEditor={(e) => (editor = e as EditorHandle & { bridge: FakeEditorBridge })}
      railOptions={{ raf: fq.raf, caf: fq.caf, ResizeObserver: null, fonts: null }}
      onRailFrame={(f) => frames.push(f)}
    />
  )
  const r = render(ui, { container: app })
  return { app, session, fq, frames, createSpy, r, ui, get editor() { return editor! } }
}

const q = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement
const tyOf = (el: HTMLElement): number => Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? NaN)

describe('Shell: hosts and the editor (§12.0.1, §12.0.3)', () => {
  it('renders the §12.0.1 shell and hands its hosts to createEditor', async () => {
    const m = mount()
    await waitFor(() => expect(m.createSpy).toHaveBeenCalledTimes(1))
    const opts = m.createSpy.mock.calls[0]![0]
    expect(opts.host).toBe(document.getElementById('mdr-editor-host'))
    expect(opts.toolbarHost).toBe(document.getElementById('mdr-toolbar-host'))
    expect(opts.scrollContainer).toBe(document.getElementById('mdr-scroll'))
    expect(opts.session).toBe(m.session)
    expect(q(`[data-testid="${TESTID.scroll}"]`)).toBe(opts.scrollContainer)
    expect(q(`[data-testid="${TESTID.topbar}"]`).contains(opts.toolbarHost)).toBe(true)
    const rail = q(`aside.mdr-rail[data-testid="${TESTID.rail}"]`)
    expect(rail.getAttribute('aria-label')).toBe('Comments')
    // both the doc column and the rail live inside the one scroll container
    expect(opts.scrollContainer.contains(opts.host)).toBe(true)
    expect(opts.scrollContainer.contains(rail)).toBe(true)
    await waitFor(() => expect(q(`[data-testid="${TESTID.editor}"]`)).not.toBeNull())
  })

  it('unmount destroys the editor, then closes the session', async () => {
    const m = mount()
    await waitFor(() => expect(m.editor).toBeTruthy())
    const destroy = vi.spyOn(m.editor, 'destroy')
    const close = vi.spyOn(m.session, 'close')
    m.r.unmount()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroy.mock.invocationCallOrder[0]!).toBeLessThan(close.mock.invocationCallOrder[0]!)
  })

  it('a createEditor failure shows the editor error state and keeps the host ids', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mount({ createEditor: async () => { throw new TypeError('session was not made by openDocSession') } })
    await waitFor(() => expect(q(`[data-testid="${TESTID.emptyState}"]`)).not.toBeNull())
    err.mockRestore()
    expect(q(`[data-testid="${TESTID.emptyState}"]`).dataset.reason).toBe('editor-failed')
    expect(q('.mdr-empty-state-detail').textContent).toBe('session was not made by openDocSession')
    expect(document.getElementById('mdr-editor-host')).not.toBeNull()
  })
})

describe('Shell: mode and quiet chrome (§12.2.4)', () => {
  it('#mdr-app[data-mode] follows the bridge', async () => {
    const m = mount()
    await waitFor(() => expect(m.app.dataset.mode).toBe('editing'))
    act(() => m.editor.bridge.setMode('suggesting'))
    expect(m.app.dataset.mode).toBe('suggesting')
    act(() => m.editor.bridge.setMode('editing'))
    expect(m.app.dataset.mode).toBe('editing')
  })

  it('continuous typing fades the chrome token on #mdr-app; typing false brings it back', async () => {
    const m = mount()
    await waitFor(() => expect(m.editor).toBeTruthy())
    const bar = q(`[data-testid="${TESTID.topbar}"]`)
    vi.useFakeTimers()
    try {
      act(() => m.editor.bridge.emitTyping(true))
      expect(bar.dataset.quiet).toBe('false')
      act(() => vi.advanceTimersByTime(CONSTANTS.QUIET_CHROME_AFTER_MS))
      expect(m.app.style.getPropertyValue('--mdr-chrome-opacity')).toBe(String(CONSTANTS.QUIET_CHROME_OPACITY))
      expect(bar.dataset.quiet).toBe('true')
      act(() => m.editor.bridge.emitTyping(false))
      expect(m.app.style.getPropertyValue('--mdr-chrome-opacity')).toBe('1')
      expect(bar.dataset.quiet).toBe('false')
      // nobody sets opacity on the bar or the toolbar host themselves
      expect(bar.style.opacity).toBe('')
      expect(document.getElementById('mdr-toolbar-host')!.style.opacity).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Shell: the rail (§11.3, §11.4)', () => {
  it('lays cards out level with their anchors, in content coordinates, through transforms', async () => {
    const m = mount()
    await waitFor(() => expect(document.querySelectorAll(`[data-testid="${TESTID.card}"]`)).toHaveLength(2))
    act(() => m.fq.run())
    const f = m.frames.at(-1)!
    const rects = m.editor.bridge.getAnchorRects([thread(1, { block: 1 }).id, thread(2, { block: 4 }).id])
    const [c1, c2] = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${TESTID.card}"]`))
    expect(c1!.dataset.thread).toBe(thread(1, { block: 1 }).id)
    expect(f.anchors.get(c1!.dataset.thread!)).toBe(rects.get(c1!.dataset.thread!)!.top)
    expect(tyOf(c1!) + f.railTop).toBe(Math.max(rects.get(c1!.dataset.thread!)!.top, f.minTop))
    expect(tyOf(c2!) + f.railTop).toBe(Math.max(rects.get(c2!.dataset.thread!)!.top, f.minTop))
    expect(c1!.dataset.placed).toBe('true')
    expect(m.editor.bridge.calls.some((c) => c.method === 'setVisibleThreads')).toBe(true)
  })

  it('never lays out on a React render or on scroll', async () => {
    const m = mount()
    await waitFor(() => expect(document.querySelectorAll(`[data-testid="${TESTID.card}"]`)).toHaveLength(2))
    act(() => m.fq.run())
    const n = m.frames.length
    m.r.rerender(m.ui)
    m.r.rerender(m.ui)
    const scroll = document.getElementById('mdr-scroll')!
    scroll.scrollTop = 500
    act(() => {
      scroll.dispatchEvent(new Event('scroll'))
    })
    expect(m.fq.size).toBe(0)
    act(() => m.fq.run())
    expect(m.frames.length).toBe(n)
  })

  it('a highlight click activates its card in place (no scroll) and tells the bridge once the editor has the click’s caret', async () => {
    const m = mount()
    await waitFor(() => expect(document.querySelectorAll(`[data-testid="${TESTID.card}"]`)).toHaveLength(2))
    act(() => m.fq.run())
    const id = thread(2, { block: 4 }).id
    act(() => m.editor.bridge.emitHighlightClick(id))
    act(() => m.fq.run())
    const card = q(`[data-testid="${TESTID.card}"][data-thread="${id}"]`)
    expect(card.dataset.active).toBe('true')
    expect(card.getAttribute('aria-current')).toBe('true')
    // the editor reports the click's selection; the bridge hears about the active thread on the next task
    act(() => m.editor.bridge.setSelectionTarget(undefined))
    await waitFor(() => expect(m.editor.bridge.calls.filter((c) => c.method === 'setActiveThread').at(-1)!.args).toEqual([id]))
    expect(document.getElementById('mdr-scroll')!.scrollTop).toBe(0)
    expect(m.frames.at(-1)!.reasons).toContain('activate')
  })

  it('a thread added to the review gets a card and a relayout; a resolved one leaves', async () => {
    const m = mount()
    await waitFor(() => expect(document.querySelectorAll(`[data-testid="${TESTID.card}"]`)).toHaveLength(2))
    act(() => m.session.emit({ review: { ...m.session.getReview(), threads: [...m.session.getReview().threads, thread(3, { block: 5 })] } }))
    await waitFor(() => expect(document.querySelectorAll(`[data-testid="${TESTID.card}"]`)).toHaveLength(3))
    act(() => m.fq.run())
    expect(m.frames.at(-1)!.output.placements.map((p) => p.id)).toEqual([thread(1, { block: 1 }).id, thread(2, { block: 4 }).id, thread(3, { block: 5 }).id])
    const resolved = m.session.getReview().threads.map((t) => (t.id === thread(1, { block: 1 }).id ? { ...t, status: 'resolved' as const } : t))
    act(() => m.session.emit({ review: { ...m.session.getReview(), threads: resolved } }))
    await waitFor(() => expect(document.querySelectorAll(`[data-testid="${TESTID.card}"]`)).toHaveLength(2))
  })
})

describe('Shell: banners (§12.14)', () => {
  it('renders the session banner and runs its action', async () => {
    const m = mount()
    await waitFor(() => expect(m.editor).toBeTruthy())
    act(() => m.session.emit({ banner: { kind: 'contract-mismatch', expected: 'a', actual: 'b' } }))
    const banner = q(`[data-testid="${TESTID.banner}"]`)
    expect(banner.dataset.kind).toBe('contract-mismatch')
    expect(banner.textContent).toContain('This page is out of date.')
    act(() => (banner.querySelector(`[data-testid="${TESTID.bannerAction}"]`) as HTMLButtonElement).click())
    expect(m.session.calls.some((c) => c.method === 'reload')).toBe(true)
    act(() => m.session.emit({ banner: null }))
    expect(q(`[data-testid="${TESTID.banner}"]`)).toBeNull()
  })
})

describe('Shell: the threads UI (§11.4, §12.14)', () => {
  it('the recovered-draft card renders in the banner slot, outside the scroll container, next to any banner', async () => {
    const m = mount()
    await waitFor(() => expect(m.editor).toBeTruthy())
    act(() => m.session.emit({ banner: { kind: 'tab-not-leader' } }))
    act(() => m.session.emit({ recovered: { reason: 'merge-failed', markdown: 'x', baseRev: 1, savedAt: '2026-10-15T00:00:00.000Z' } }))
    const slot = q('.mdr-banner-slot')
    expect(slot.querySelector(`[data-testid="${TESTID.banner}"]`)).not.toBeNull()
    const card = slot.querySelector(`[data-testid="${TESTID.recoveredCard}"]`) as HTMLElement
    expect(card.dataset.kind).toBe('merge-failed')
    expect(q('#mdr-scroll').contains(card)).toBe(false)
  })

  it('QA3: the top bar names the document: its file name, in the file strip, with the whole path as the tooltip', async () => {
    const session = createFakeDocSession({ file: 'campaigns/q3/memo.md', markdown: paragraphs(3), review: reviewWith([], 'campaigns/q3/memo.md') })
    const m = mount({ session })
    await waitFor(() => expect(m.editor).toBeTruthy())
    // onboarding: the name moved from the actions row to the file strip (inside the top bar, its last row)
    expect(q('.mdr-topbar-actions').querySelector(`[data-testid="${TESTID.docName}"]`)).toBeNull()
    const name = q(`.mdr-topbar [data-testid="${TESTID.fileStrip}"] [data-testid="${TESTID.docName}"]`)
    expect(name.textContent).toBe('memo.md')
    expect(name.getAttribute('title')).toMatch(/campaigns\/q3\/memo\.md$/)
  })

  it('the top bar carries the Comment button and previous / next; the top bar’s Comment opens the rail’s composer', async () => {
    const m = mount()
    await waitFor(() => expect(m.editor).toBeTruthy())
    const actions = q('.mdr-topbar-actions')
    const comment = actions.querySelector(`[data-testid="${TESTID.commentButton}"]`) as HTMLButtonElement
    expect(comment.disabled).toBe(true)
    expect(actions.querySelector(`[data-testid="${TESTID.navPrev}"]`)).not.toBeNull()
    expect(actions.querySelector(`[data-testid="${TESTID.navNext}"]`)).not.toBeNull()
    act(() =>
      m.editor.bridge.setSelectionTarget({
        kind: 'anchor', quote: 'topic 3',
        anchor: { kind: 'text', quote: 'topic 3', prefix: '', suffix: '', hint: { rev: 0, pos: 300, block: 3, blockHash: '0'.repeat(16), offsetInBlock: 0 } },
        rect: { top: 130, bottom: 154, left: 0 }, extent: { top: 130, bottom: 154 },
      }),
    )
    await waitFor(() => expect(comment.disabled).toBe(false))
    act(() => comment.click())
    act(() => m.fq.run())
    expect(q('[data-draft="true"]').dataset.active).toBe('true')
  })
})
