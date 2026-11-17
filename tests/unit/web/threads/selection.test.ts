// tests/unit/web/threads/selection.test.ts (P3; CONTRACTS §11.4, §12.1).
//
// One getSelectionTarget read per animation frame however many selection changes fire, shared by the floating
// button and the top bar's Comment button; and the rail's command hub, a no-op until RailView binds it.
import { describe, expect, it, vi } from 'vitest'
import type { SelectionTarget } from '../../../../shared/types'
import { createCommandHub } from '../../../../web/src/rail/commands'
import { createSelectionWatch } from '../../../../web/src/threads/selection'
import { frameQueue } from '../shell/helpers'

const T = { kind: 'anchor', anchor: {} as never, quote: 'x', rect: { top: 1, bottom: 2, left: 0 }, extent: { top: 1, bottom: 2 } } as SelectionTarget

describe('selection watch', () => {
  it('coalesces a burst of selection changes into one read per frame and notifies subscribers', () => {
    let fire: () => void = () => undefined
    const getSelectionTarget = vi.fn((): SelectionTarget => T)
    const fq = frameQueue()
    const w = createSelectionWatch({ bridge: { getSelectionTarget, onSelectionChange: (cb) => ((fire = cb), () => undefined) }, raf: fq.raf, caf: fq.caf })
    const seen: SelectionTarget[] = []
    w.subscribe((t) => seen.push(t))
    for (let i = 0; i < 5; i++) fire()
    expect(getSelectionTarget).not.toHaveBeenCalled()
    fq.run()
    expect(getSelectionTarget).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([T])
    expect(w.get()).toBe(T)
    expect(getSelectionTarget).toHaveBeenCalledTimes(1)
  })

  it('get() reads lazily the first time; refresh() always reads; destroy() stops listening', () => {
    let fire: () => void = () => undefined
    const getSelectionTarget = vi.fn((): SelectionTarget => null)
    const fq = frameQueue()
    const w = createSelectionWatch({ bridge: { getSelectionTarget, onSelectionChange: (cb) => ((fire = cb), () => (fire = () => undefined)) }, raf: fq.raf, caf: fq.caf })
    expect(w.get()).toBeNull()
    expect(w.refresh()).toBeNull()
    expect(getSelectionTarget).toHaveBeenCalledTimes(2)
    w.destroy()
    fire()
    fq.run()
    expect(getSelectionTarget).toHaveBeenCalledTimes(2)
  })
})

describe('command hub', () => {
  it('no-ops until bound, forwards while bound, and unbinding only removes its own implementation', () => {
    const hub = createCommandHub()
    expect(() => hub.commands.nav(1)).not.toThrow()
    const a = { comment: vi.fn(), nav: vi.fn(), firstUnread: vi.fn(), firstConflict: vi.fn(), hasUnsent: vi.fn(() => false), postUnsent: vi.fn(async () => true) }
    const b = { comment: vi.fn(), nav: vi.fn(), firstUnread: vi.fn(), firstConflict: vi.fn(), hasUnsent: vi.fn(() => false), postUnsent: vi.fn(async () => true) }
    const offA = hub.bind(a)
    hub.commands.comment('doc')
    hub.commands.nav(-1)
    hub.commands.firstUnread()
    hub.commands.firstConflict()
    expect(a.firstUnread).toHaveBeenCalledTimes(1)
    expect(a.firstConflict).toHaveBeenCalledTimes(1)
    expect(a.comment).toHaveBeenCalledWith('doc')
    expect(a.nav).toHaveBeenCalledWith(-1)
    const offB = hub.bind(b)
    offA()
    hub.commands.nav(1)
    expect(b.nav).toHaveBeenCalledWith(1)
    offB()
    hub.commands.nav(1)
    expect(b.nav).toHaveBeenCalledTimes(1)
  })
})
