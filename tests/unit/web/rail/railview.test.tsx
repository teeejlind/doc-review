// tests/unit/web/rail/railview.test.tsx (P3; CONTRACTS §11.3, §11.4, §6.8).
//
// RailView wiring over the fake editor: which threads get cards, the order tiebreak, and activation: a pointer-down
// on a card's body compensates (the card stays put on screen, the doc scrolls), on a control it doesn't (the doc
// never scrolls), keyboard focus activates in place.
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import type { ReviewState, Suggestion } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { createFakeEditor } from '../../../fakes/FakeEditorBridge'
import { createCommandHub, type CommandHub } from '../../../../web/src/rail/commands'
import { orderOf, RailView, railThreads } from '../../../../web/src/rail/RailView'
import { frameQueue, paragraphs, reviewWith, thread } from '../shell/helpers'

const CARD_BODY_HEIGHT = 300
const VIEWPORT = 800
const original = HTMLElement.prototype.getBoundingClientRect

beforeEach(() => {
  // jsdom has no layout: card bodies measure CARD_BODY_HEIGHT, and a card's client rect follows its transform.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    const scrollTop = document.getElementById('scroll')?.scrollTop ?? 0
    // the rail and its (empty) header sit at content y 0, so their client top moves with the scroll
    if (this.id === 'rail' || this.classList.contains('mdr-rail-header')) return rect(-scrollTop, 0)
    // the scroll container: an 800 px viewport at client y 0
    if (this.id === 'scroll') return rect(0, VIEWPORT)
    if (this.classList.contains('mdr-card-body')) return rect(0, CARD_BODY_HEIGHT)
    if (this.classList.contains('mdr-card')) {
      const ty = Number(/translateY\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1] ?? 0)
      return rect(ty - scrollTop, CARD_BODY_HEIGHT)
    }
    return original.call(this)
  }
})
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = original
  cleanup()
  document.body.innerHTML = ''
})

async function mount(threads = [thread(1, { block: 1 }), thread(2, { block: 2 })], o: { paragraphs?: number; commands?: CommandHub; content?: boolean } = {}) {
  document.body.innerHTML = '<div id="scroll"><main><div id="host"></div></main><aside id="rail"></aside></div><div id="toolbar"></div>'
  const container = document.getElementById('scroll')!
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: VIEWPORT })
  const rail = document.getElementById('rail')!
  const session = createFakeDocSession({ file: 'doc.md', markdown: paragraphs(o.paragraphs ?? 8), review: reviewWith(threads) })
  const editor = await createFakeEditor({ host: document.getElementById('host')!, toolbarHost: document.getElementById('toolbar')!, scrollContainer: container, session })
  const fq = frameQueue()
  const r = render(<RailView bridge={editor.bridge} session={session} container={container} rail={rail} {...(o.commands ? { commands: o.commands } : {})} {...(o.content ? { content: document.getElementById('host') } : {})} schedulerOptions={{ raf: fq.raf, caf: fq.caf, ResizeObserver: null, fonts: null }} />, { container: rail })
  await waitFor(() => expect(rail.querySelectorAll(`[data-testid="${TESTID.card}"]`)).toHaveLength(threads.length))
  act(() => fq.run())
  const card = (id: string) => rail.querySelector(`[data-testid="${TESTID.card}"][data-thread="${id}"]`) as HTMLElement
  const reply = (id: string) => card(id).querySelector(`[data-testid="${TESTID.cardReply}"]`) as HTMLTextAreaElement
  const testid = (key: keyof typeof TESTID) => rail.querySelector(`[data-testid="${TESTID[key]}"]`) as HTMLElement
  return { container, rail, session, editor, fq, r, card, reply, testid }
}

/** The fake editor's model layout: single-line paragraph i starts at content y 16 + 36 i (§12.0.3 coordinates). */
const anchorOf = (block: number): number => 16 + 36 * block
const tyOf = (el: HTMLElement): number => Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? NaN)

describe('railThreads / orderOf', () => {
  it('open anchored threads get cards; detached, doc-level and resolved ones do not, unless resolved with live suggestions (§6.8)', () => {
    const open = thread(1, { block: 1 })
    const detached = thread(2, { block: 2, detached: true })
    const resolved = thread(3, { block: 3, status: 'resolved' })
    const resolvedLive = { ...thread(4, { block: 4, status: 'resolved' }), suggestions: ['s_00000000000000000000000001' as const] }
    const doc = { ...thread(5, { block: 0 }), anchor: { kind: 'doc' as const } }
    const live: Partial<Suggestion> = { id: 's_00000000000000000000000001', thread: resolvedLive.id, status: 'pending' }
    const review = { threads: [open, detached, resolved, resolvedLive, doc], suggestions: [live as Suggestion] } as unknown as ReviewState
    expect(railThreads(review).map((t) => t.id)).toEqual([open.id, resolvedLive.id])
  })

  it('order is the resolved ptext offset, else the anchor hint', () => {
    expect(orderOf(thread(1, { block: 1, pos: 420 }))).toBe(420)
    const t = thread(2, { block: 1, pos: 77 })
    expect(orderOf({ ...t, resolution: { state: 'detached' } })).toBe(77)
  })
})

describe('RailView activation (§11.4)', () => {
  it('a card-body pointer-down keeps the card under the cursor: the doc scrolls, the card pins to its anchor', async () => {
    const m = await mount()
    const second = m.card(thread(2, { block: 2 }).id)
    m.container.scrollTop = 400
    const before = second.getBoundingClientRect().top
    expect(second.dataset.collapsed).toBe('true') // pushed far below its anchor by the tall first card
    act(() => {
      fireEvent.pointerDown(second.querySelector('.mdr-card-body')!)
    })
    act(() => m.fq.run())
    expect(second.dataset.active).toBe('true')
    const anchorY = m.editor.bridge.getAnchorRects([thread(2, { block: 2 }).id]).get(thread(2, { block: 2 }).id)!.top
    expect(Number(/translateY\((-?[\d.]+)px\)/.exec(second.style.transform)![1])).toBe(anchorY)
    expect(second.getBoundingClientRect().top).toBe(before)
    expect(m.container.scrollTop).not.toBe(400)
  })

  it('a pointer-down on a control inside the card activates it without scrolling the doc', async () => {
    const m = await mount()
    const second = m.card(thread(2, { block: 2 }).id)
    const btn = document.createElement('button')
    btn.textContent = 'Reply'
    second.querySelector('.mdr-card-body')!.append(btn)
    m.container.scrollTop = 400
    act(() => {
      fireEvent.pointerDown(btn)
    })
    act(() => m.fq.run())
    expect(second.dataset.active).toBe('true')
    expect(m.container.scrollTop).toBe(400)
  })

  it('keyboard focus activates in place; re-activating the active card does nothing', async () => {
    const m = await mount()
    const first = m.card(thread(1, { block: 1 }).id)
    act(() => first.focus())
    act(() => m.fq.run())
    expect(first.dataset.active).toBe('true')
    expect(m.container.scrollTop).toBe(0)
    const frames = m.fq.size
    act(() => {
      fireEvent.pointerDown(first.querySelector('.mdr-card-body')!)
    })
    expect(m.fq.size).toBe(frames)
  })

  it('cards are labelled articles; only the active one carries aria-current', async () => {
    const m = await mount()
    const cards = Array.from(m.rail.querySelectorAll<HTMLElement>(`[data-testid="${TESTID.card}"]`))
    for (const c of cards) {
      expect(c.tagName).toBe('ARTICLE')
      expect(document.getElementById(c.getAttribute('aria-labelledby')!)).not.toBeNull()
      expect(c.hasAttribute('aria-current')).toBe(false)
    }
    act(() => m.editor.bridge.emitHighlightClick(thread(1, { block: 1 }).id))
    expect(cards[0]!.getAttribute('aria-current')).toBe('true')
    expect(cards[1]!.hasAttribute('aria-current')).toBe(false)
  })
})

describe('RailView: composer exemption, off-screen pill, chip, ticks (§11.4)', () => {
  it('a pointer-down in an inactive, displaced card’s reply box never scrolls the doc; the card pins to its anchor and the composer is focused after the frame', async () => {
    const m = await mount()
    const second = m.card(thread(2, { block: 2 }).id)
    expect(second.dataset.collapsed).toBe('true')
    m.container.scrollTop = 400
    const box = m.reply(thread(2, { block: 2 }).id)
    act(() => {
      fireEvent.pointerDown(box)
    })
    expect(document.activeElement).not.toBe(box)
    act(() => m.fq.run())
    expect(m.container.scrollTop).toBe(400)
    expect(second.dataset.active).toBe('true')
    expect(tyOf(second)).toBe(anchorOf(2))
    expect(document.activeElement).toBe(box)
  })

  it('the off-screen pill appears at the edge the active card left by; a click scrolls its anchor to 30%', async () => {
    const t = thread(2, { block: 30 })
    const m = await mount([thread(1, { block: 1 }), t], { paragraphs: 40 })
    const pill = m.testid('offscreenPill') as HTMLButtonElement
    expect(pill.hidden).toBe(true)
    act(() => m.card(t.id).focus())
    act(() => m.fq.run())
    expect(pill.hidden).toBe(false)
    expect(pill.dataset.direction).toBe('down')
    expect(pill.textContent).toBe('↓ Comment')
    act(() => pill.click())
    expect(m.container.scrollTop).toBe(Math.round(anchorOf(30) - VIEWPORT * 0.3))
    // scrolled into view: the pill hides on the next overlay update
    act(() => m.fq.run())
    await act(async () => {
      m.container.dispatchEvent(new Event('scroll'))
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(pill.hidden).toBe(true)
    // scrolled far below it: the pill points up
    m.container.scrollTop = 5000
    await act(async () => {
      m.container.dispatchEvent(new Event('scroll'))
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(pill.hidden).toBe(false)
    expect(pill.dataset.direction).toBe('up')
  })

  it('cards that can’t fit between minTop and the active card are not folded behind a chip: the active one opens in the stack (QA3 rail-ui 3 / 11)', async () => {
    const ts = [thread(1, { block: 0 }), thread(2, { block: 1 }), thread(3, { block: 2 })]
    const m = await mount(ts)
    const chip = m.testid('overflowChip') as HTMLButtonElement
    expect(chip.hidden).toBe(true)
    act(() => m.editor.bridge.emitHighlightClick(ts[2]!.id))
    act(() => m.fq.run())
    expect(chip.hidden).toBe(true)
    for (const t of ts) expect(m.card(t.id).dataset.placed).toBe('true')
    expect(m.card(ts[2]!.id).dataset.active).toBe('true')
    expect(m.card(ts[2]!.id).dataset.collapsed).toBe('false')
  })

  it('a card displaced more than 24 px gets a gutter tick at its anchor; the connector shows while it is active or hovered', async () => {
    const m = await mount()
    const id = thread(2, { block: 2 }).id
    const tick = m.rail.querySelector<HTMLElement>(`.mdr-ticks [data-card="${id}"]`)!
    expect(tick).not.toBeNull()
    expect(tyOf(tick)).toBe(anchorOf(2))
    expect(m.rail.querySelector(`.mdr-ticks [data-card="${thread(1, { block: 1 }).id}"]`)).toBeNull()
    expect(tick.dataset.hover).toBe('false')
    act(() => {
      fireEvent.pointerEnter(m.card(id))
    })
    expect(tick.dataset.hover).toBe('true')
    act(() => m.editor.bridge.emitHighlightClick(id))
    act(() => m.fq.run())
    // active: pinned to its anchor, no longer displaced, and it keeps its tick, level with its line and marked active
    // (TJ, 2026-11-16: without it, the only tick beside a tall active card was a neighbour's)
    const active = m.rail.querySelector<HTMLElement>(`.mdr-ticks [data-card="${id}"]`)!
    expect(active).not.toBeNull()
    expect(tyOf(active)).toBe(anchorOf(2))
    expect(active.dataset.active).toBe('true')
    // activating another card gives that one the active tick
    act(() => m.editor.bridge.emitHighlightClick(thread(1, { block: 1 }).id))
    act(() => m.fq.run())
    expect(m.rail.querySelector<HTMLElement>(`.mdr-ticks [data-card="${thread(1, { block: 1 }).id}"]`)?.dataset.active).toBe('true')
  })

  it('typing a reply pins the card expanded (pinExpanded), so a collapsed neighbour opens while it holds a draft', async () => {
    const m = await mount()
    const id = thread(2, { block: 2 }).id
    expect(m.card(id).dataset.collapsed).toBe('true')
    act(() => {
      fireEvent.change(m.reply(id), { target: { value: 'draft reply' } })
    })
    act(() => m.fq.run())
    expect(m.card(id).dataset.collapsed).toBe('false')
    expect(m.card(id).dataset.active).toBe('false')
  })
})

describe('RailView: typing in an off-screen composer never scrolls (§11.4)', () => {
  function place(el: HTMLElement, top: number): void {
    Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ top, bottom: top + 30, height: 30, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) })
  }

  it('an edit undoes the browser’s caret reveal when the composer is outside the visible band', async () => {
    const m = await mount()
    const box = m.reply(thread(2, { block: 2 }).id)
    place(box, -500)
    m.container.scrollTop = 900
    act(() => {
      box.dispatchEvent(new Event('beforeinput', { bubbles: true }))
      m.container.scrollTop = 120 // what Chromium's reveal does
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(m.container.scrollTop).toBe(900)
  })

  it('a reveal that runs after the input event (Chromium) is undone on that keystroke’s keyup', async () => {
    const m = await mount()
    const box = m.reply(thread(2, { block: 2 }).id)
    place(box, -500)
    m.container.scrollTop = 675
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      box.dispatchEvent(new Event('input', { bubbles: true }))
      m.container.scrollTop = 482 // the post-input reveal
      box.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }))
    })
    expect(m.container.scrollTop).toBe(675)
  })

  it('fast typing: a reveal that lands between two keys never becomes the new baseline', async () => {
    const m = await mount()
    const box = m.reply(thread(2, { block: 2 }).id)
    place(box, -500)
    m.container.scrollTop = 900
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      m.container.scrollTop = 400 // a reveal not undone yet
      // the next key arrives while the composer is (momentarily) on screen
      place(box, 100)
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(m.container.scrollTop).toBe(900)
  })

  it('a caret move (no input event) is undone right after the key’s default action', async () => {
    const m = await mount()
    const box = m.reply(thread(2, { block: 2 }).id)
    place(box, 2000)
    m.container.scrollTop = 300
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    m.container.scrollTop = 1500
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(m.container.scrollTop).toBe(300)
  })

  it('a composer on screen keeps the browser’s normal behaviour', async () => {
    const m = await mount()
    const box = m.reply(thread(2, { block: 2 }).id)
    place(box, 200)
    m.container.scrollTop = 100
    act(() => {
      box.dispatchEvent(new Event('beforeinput', { bubbles: true }))
      m.container.scrollTop = 160
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(m.container.scrollTop).toBe(160)
  })
})

describe('RailView: next / previous (§11.4, §11.5)', () => {
  it('Cmd+Opt+] scrolls the next anchor to 30% from the top, activates its card and focuses it; Cmd+Opt+[ goes back', async () => {
    const ts = [thread(1, { block: 2 }), thread(2, { block: 20 }), thread(3, { block: 35 })]
    const m = await mount(ts, { paragraphs: 40 })
    const next = m.editor.bridge.shortcuts.find((b) => b.key === 'Mod-Alt-]')!
    const prev = m.editor.bridge.shortcuts.find((b) => b.key === 'Mod-Alt-[')!
    m.container.scrollTop = 300
    act(() => {
      expect(next.run()).toBe(true)
    })
    act(() => m.fq.run())
    // nothing active: the first anchor at or below the viewport top
    expect(m.card(ts[1]!.id).dataset.active).toBe('true')
    expect(m.container.scrollTop).toBe(Math.round(anchorOf(20) - VIEWPORT * 0.3))
    expect(document.activeElement).toBe(m.card(ts[1]!.id))
    act(() => {
      next.run()
    })
    act(() => m.fq.run())
    expect(m.card(ts[2]!.id).dataset.active).toBe('true')
    act(() => {
      prev.run()
      prev.run()
    })
    act(() => m.fq.run())
    expect(m.card(ts[0]!.id).dataset.active).toBe('true')
    expect(m.container.scrollTop).toBe(0)
  })
})

describe('RailView: "Claude replied" (§8.5)', () => {
  const claudeReply = (n: number, block: number) => ({ ...thread(n, { block, replies: 1 }), unread: 1, lastSeq: n * 10 + 1 })

  it('goes to the first card with unread messages', async () => {
    const hub = createCommandHub()
    const ts = [thread(1, { block: 1 }), claudeReply(2, 4)]
    const m = await mount(ts, { commands: hub })
    act(() => hub.commands.firstUnread())
    act(() => m.fq.run())
    expect(m.card(ts[1]!.id).dataset.active).toBe('true')
  })

  it('a click that lands before Claude’s message reaches the rail goes to it when the review catches up', async () => {
    const hub = createCommandHub()
    const ts = [thread(1, { block: 1 }), thread(2, { block: 4 })]
    const m = await mount(ts, { commands: hub })
    act(() => hub.commands.firstUnread())
    act(() => m.fq.run())
    expect(m.rail.querySelector('[data-active="true"]')).toBeNull()
    act(() => m.session.emit({ review: { ...m.session.getReview(), seq: 99, threads: [ts[0]!, claudeReply(2, 4)] } }))
    await waitFor(() => expect(m.card(ts[1]!.id).querySelector(`[data-testid="${TESTID.unread}"]`)).not.toBeNull())
    act(() => m.fq.run())
    act(() => m.fq.run())
    expect(m.card(ts[1]!.id).dataset.active).toBe('true')
  })

  it('the retry lapses: a review arriving after the window activates nothing', async () => {
    const hub = createCommandHub()
    const ts = [thread(1, { block: 1 }), thread(2, { block: 4 })]
    const m = await mount(ts, { commands: hub })
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000_000)
      act(() => hub.commands.firstUnread())
      act(() => m.fq.run())
      now.mockReturnValue(1_000_000 + 60_000)
      act(() => m.session.emit({ review: { ...m.session.getReview(), seq: 99, threads: [ts[0]!, claudeReply(2, 4)] } }))
      await waitFor(() => expect(m.card(ts[1]!.id).querySelector(`[data-testid="${TESTID.unread}"]`)).not.toBeNull())
      act(() => m.fq.run())
      act(() => m.fq.run())
      expect(m.rail.querySelector('[data-active="true"]')).toBeNull()
    } finally {
      now.mockRestore()
    }
  })
})

describe('RailView: a click in the editor never overwrites its caret (setActiveThread after the selection lands)', () => {
  const activeCalls = (m: Awaited<ReturnType<typeof mount>>) => m.editor.bridge.calls.filter((c) => c.method === 'setActiveThread').map((c) => c.args[0])

  it('a highlight click activates the card at once; the editor highlight follows once the editor reports the click’s selection, on the next task', async () => {
    const ts = [thread(1, { block: 1 }), thread(2, { block: 4 })]
    const m = await mount(ts)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const before = activeCalls(m).length
      act(() => m.editor.bridge.emitHighlightClick(ts[1]!.id))
      expect(m.card(ts[1]!.id).dataset.active).toBe('true')
      expect(activeCalls(m).length).toBe(before)
      // the editor read the click's caret (a selection event); the dispatch waits for the next task, not inside it
      act(() => m.editor.bridge.setSelectionTarget(undefined))
      expect(activeCalls(m).length).toBe(before)
      act(() => vi.advanceTimersByTime(0))
      expect(activeCalls(m).slice(before)).toEqual([ts[1]!.id])
      // and only once: the fallback timer was cleared
      act(() => vi.advanceTimersByTime(1_000))
      expect(activeCalls(m).slice(before)).toEqual([ts[1]!.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a click in the text that deactivates waits the same way; with no selection event the fallback ends the wait', async () => {
    const ts = [thread(1, { block: 1 }), thread(2, { block: 4 })]
    const m = await mount(ts, { content: true })
    act(() => m.card(ts[0]!.id).focus())
    act(() => m.fq.run())
    expect(m.card(ts[0]!.id).dataset.active).toBe('true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const before = activeCalls(m).length
      const root = document.querySelector(`[data-testid="${TESTID.editor}"]`)!
      act(() => {
        fireEvent.pointerDown(root)
        fireEvent.click(root)
      })
      expect(m.card(ts[0]!.id).dataset.active).toBe('false')
      expect(activeCalls(m).length).toBe(before)
      act(() => vi.advanceTimersByTime(149))
      expect(activeCalls(m).length).toBe(before)
      act(() => vi.advanceTimersByTime(1))
      expect(activeCalls(m).slice(before)).toEqual([null])
    } finally {
      vi.useRealTimers()
    }
  })

  it('activation from the rail (focus, next/prev) updates the editor highlight in the same frame', async () => {
    const ts = [thread(1, { block: 1 }), thread(2, { block: 4 })]
    const m = await mount(ts)
    const before = activeCalls(m).length
    act(() => m.card(ts[1]!.id).focus())
    expect(activeCalls(m).slice(before)).toEqual([ts[1]!.id])
  })
})
