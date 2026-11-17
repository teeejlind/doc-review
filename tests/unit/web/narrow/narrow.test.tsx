// tests/unit/web/narrow/narrow.test.tsx (P3; CONTRACTS §11.4 "Narrow mode", §12.15 sheet, §14 P3 unit test
// "narrow-mode switch at NARROW_BREAKPOINT_PX").
//
// The switch at 640 px (639 is narrow, 640 is not; QA round 1 lowered it from 900 so the Claude pane keeps its rail), and the shell on each side of it: wide = the rail with laid-out
// cards; narrow = no rail layout at all and a bottom sheet that a highlight tap opens on its thread, with the rail
// header's items at its top.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CONSTANTS, TESTID } from '../../../../shared/constants'
import type { EditorHandle, SelectionTarget, TextAnchor } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { createFakeEditor, type FakeEditorBridge } from '../../../fakes/FakeEditorBridge'
import { createNarrowWatch, isNarrowWidth, NARROW_QUERY } from '../../../../web/src/narrow/narrow'
import type { RailFrame } from '../../../../web/src/rail/scheduler'
import { Shell } from '../../../../web/src/shell/Shell'
import { frameQueue, paragraphs, reviewWith, thread } from '../shell/helpers'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function fakeWindow(width: number) {
  const t = new EventTarget()
  const win = {
    innerWidth: width,
    addEventListener: t.addEventListener.bind(t),
    removeEventListener: t.removeEventListener.bind(t),
  }
  return {
    win: win as unknown as Window,
    resize(w: number) {
      win.innerWidth = w
      t.dispatchEvent(new Event('resize'))
    },
  }
}

describe('narrow-mode switch (§11.4)', () => {
  it(`switches at NARROW_BREAKPOINT_PX (${CONSTANTS.NARROW_BREAKPOINT_PX}): 639 narrow, 640 wide`, () => {
    expect(CONSTANTS.NARROW_BREAKPOINT_PX).toBe(640)
    expect(isNarrowWidth(639)).toBe(true)
    expect(isNarrowWidth(639.5)).toBe(true)
    expect(isNarrowWidth(640)).toBe(false)
    expect(isNarrowWidth(800)).toBe(false)
    expect(isNarrowWidth(1440)).toBe(false)
    expect(NARROW_QUERY).toBe('(max-width: 639.98px)')
  })

  it('createNarrowWatch follows window resizes across the breakpoint and reports each change once', () => {
    const w = fakeWindow(1200)
    const watch = createNarrowWatch(w.win)
    const seen: boolean[] = []
    watch.subscribe((n) => seen.push(n))
    expect(watch.get()).toBe(false)
    w.resize(640)
    w.resize(639)
    w.resize(500)
    w.resize(640)
    expect(seen).toEqual([true, false])
    watch.destroy()
    w.resize(500)
    expect(seen).toEqual([true, false])
  })

  it('uses matchMedia when the window has it', () => {
    const listeners = new Set<() => void>()
    const mql = { matches: true, addEventListener: (_: string, cb: () => void) => listeners.add(cb), removeEventListener: (_: string, cb: () => void) => listeners.delete(cb) }
    const queries: string[] = []
    const win = { innerWidth: 2000, addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: (q: string) => (queries.push(q), mql) } as unknown as Window
    const watch = createNarrowWatch(win)
    expect(queries).toEqual([NARROW_QUERY])
    expect(watch.get()).toBe(true)
    mql.matches = false
    for (const cb of listeners) cb()
    expect(watch.get()).toBe(false)
  })
})

describe('the shell on both sides of the breakpoint', () => {
  function mount(width: number) {
    const app = document.createElement('div')
    app.id = 'mdr-app'
    app.className = 'mdr-app'
    document.body.append(app)
    const session = createFakeDocSession({ file: 'doc.md', markdown: paragraphs(6), review: reviewWith([thread(1, { block: 1 }), thread(2, { block: 4, by: 'Claude' })]) })
    const fq = frameQueue()
    const frames: RailFrame[] = []
    const w = fakeWindow(width)
    let editor: (EditorHandle & { bridge: FakeEditorBridge }) | null = null
    render(
      <Shell
        session={session}
        createEditor={async (o) => createFakeEditor(o)}
        app={app}
        onEditor={(e) => (editor = e as EditorHandle & { bridge: FakeEditorBridge })}
        railOptions={{ raf: fq.raf, caf: fq.caf, ResizeObserver: null, fonts: null }}
        onRailFrame={(f) => frames.push(f)}
        narrowWindow={w.win}
      />,
      { container: app },
    )
    return { app, session, fq, frames, w, get editor() { return editor! } }
  }
  const sheet = (): HTMLElement | null => document.querySelector(`[data-testid="${TESTID.sheet}"]`)
  const railCards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${TESTID.rail}"] [data-testid="${TESTID.card}"]`))

  it('wide (1440): cards in the rail, laid out by the scheduler; no sheet', async () => {
    const m = mount(1440)
    await waitFor(() => expect(railCards()).toHaveLength(2))
    act(() => m.fq.run())
    expect(m.frames.length).toBeGreaterThan(0)
    expect(sheet()).toBeNull()
    expect(m.app.dataset.narrow).toBe('false')
  })

  it('narrow (600): no rail layout ever runs; the sheet is closed until a highlight tap opens it on that thread', async () => {
    const m = mount(600)
    await waitFor(() => expect(sheet()).not.toBeNull())
    act(() => m.fq.run())
    expect(m.frames).toHaveLength(0)
    expect(railCards()).toHaveLength(0)
    expect(m.app.dataset.narrow).toBe('true')
    expect(sheet()!.dataset.open).toBe('false')
    // the rail header's items sit at the top of the sheet
    expect(sheet()!.querySelector(`[data-testid="${TESTID.railHeader}"]`)).not.toBeNull()
    expect(sheet()!.querySelector(`[data-testid="${TESTID.policyToggle}"]`)).not.toBeNull()
    act(() => m.editor.bridge.emitHighlightClick(thread(2, { block: 4 }).id))
    expect(sheet()!.dataset.open).toBe('true')
    const card = sheet()!.querySelector(`[data-testid="${TESTID.card}"][data-thread="${thread(2, { block: 4 }).id}"]`) as HTMLElement
    expect(card.dataset.active).toBe('true')
    expect(card.dataset.collapsed).toBe('false')
    // the other card stays folded
    expect((sheet()!.querySelector(`[data-testid="${TESTID.card}"][data-thread="${thread(1, { block: 1 }).id}"]`) as HTMLElement).dataset.collapsed).toBe('true')
    // Esc closes it
    act(() => void sheet()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(sheet()!.dataset.open).toBe('false')
  })

  it('crossing the breakpoint moves the cards between the rail and the sheet', async () => {
    const m = mount(1200)
    await waitFor(() => expect(railCards()).toHaveLength(2))
    act(() => m.w.resize(639))
    await waitFor(() => expect(sheet()).not.toBeNull())
    expect(railCards()).toHaveLength(0)
    act(() => m.w.resize(640))
    await waitFor(() => expect(sheet()).toBeNull())
    await waitFor(() => expect(railCards()).toHaveLength(2))
  })

  it('the top-bar Comment button opens the sheet with the new-comment card', async () => {
    const m = mount(600)
    await waitFor(() => expect(sheet()).not.toBeNull())
    const target: SelectionTarget = { kind: 'anchor', anchor: thread(9, { block: 2 }).anchor as TextAnchor, quote: 'topic 2', rect: { top: 100, bottom: 120, left: 0 }, extent: { top: 100, bottom: 120 } }
    act(() => m.editor.bridge.setSelectionTarget(target))
    const btn = await waitFor(() => {
      const b = document.querySelector(`[data-testid="${TESTID.commentButton}"]`) as HTMLButtonElement
      expect(b.disabled).toBe(false)
      return b
    })
    act(() => btn.click())
    expect(sheet()!.dataset.open).toBe('true')
    expect(sheet()!.querySelector(`[data-testid="${TESTID.card}"][data-draft="true"]`)).not.toBeNull()
  })
})
