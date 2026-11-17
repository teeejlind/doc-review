// tests/unit/web/shell/ready.test.tsx (P3; CONTRACTS §11.7 "Cold open": the mdr:ready mark).
//
// mdr:ready is set in the first animation frame after both P2's mdr:editor-ready mark and P3's first complete rail
// layout (every card laid out or known unplaced); in narrow mode only the editor mark is needed. Exercised on the
// controller with a fake timeline and frame queue, then through the shell with the fake editor.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { createFakeEditor } from '../../../fakes/FakeEditorBridge'
import { createReadyMark, EDITOR_READY_MARK, READY_MARK } from '../../../../web/src/shell/ready'
import { Shell } from '../../../../web/src/shell/Shell'
import { frameQueue, paragraphs, reviewWith, thread } from './helpers'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function fakePerf() {
  const entries: Array<{ name: string; startTime: number }> = []
  let now = 0
  return {
    entries,
    tick(ms: number) {
      now += ms
    },
    perf: {
      mark(name: string) {
        const e = { name, startTime: now }
        entries.push(e)
        return e as unknown as PerformanceMark
      },
      getEntriesByName(name: string) {
        return entries.filter((e) => e.name === name) as unknown as PerformanceEntryList
      },
    },
    marks: (name: string) => entries.filter((e) => e.name === name),
  }
}

describe('createReadyMark', () => {
  it('waits for both the editor mark and a complete rail layout, then marks in the next frame', () => {
    const p = fakePerf()
    const fq = frameQueue()
    const ready: number[] = []
    const r = createReadyMark({ perf: p.perf, raf: fq.raf, caf: fq.caf, PerformanceObserver: null, needsRail: () => true, onReady: (t) => ready.push(t) })
    r.editorCreated()
    r.railFrame(true)
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(0)
    // P2 marks editor-ready; the per-frame poll sees it
    p.tick(400)
    p.perf.mark(EDITOR_READY_MARK)
    fq.run() // poll → sees the mark → schedules the ready frame
    expect(p.marks(READY_MARK)).toHaveLength(0)
    p.tick(16)
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(1)
    expect(ready).toEqual([416])
    expect(r.done).toBe(true)
    // never twice
    r.railFrame(true)
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(1)
  })

  it('an incomplete layout (a card not yet laid out) holds it until a complete frame', () => {
    const p = fakePerf()
    const fq = frameQueue()
    p.perf.mark(EDITOR_READY_MARK)
    const r = createReadyMark({ perf: p.perf, raf: fq.raf, caf: fq.caf, PerformanceObserver: null, needsRail: () => true })
    r.editorCreated()
    r.railFrame(false)
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(0)
    r.railFrame(true)
    // a relayout that lands before the ready frame and isn't complete cancels it (re-checked inside the frame)
    r.railFrame(false)
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(0)
    r.railFrame(true)
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(1)
  })

  it('narrow mode needs only the editor mark', () => {
    const p = fakePerf()
    const fq = frameQueue()
    p.perf.mark(EDITOR_READY_MARK)
    const r = createReadyMark({ perf: p.perf, raf: fq.raf, caf: fq.caf, PerformanceObserver: null, needsRail: () => false })
    r.editorCreated()
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(1)
  })

  it('uses a buffered PerformanceObserver for the editor mark when there is one', () => {
    const p = fakePerf()
    const fq = frameQueue()
    let cb: ((l: { getEntries(): Array<{ name: string }> }) => void) | null = null
    const observed: Array<{ type: string; buffered?: boolean }> = []
    class PO {
      constructor(c: typeof cb) {
        cb = c
      }
      observe(o: { type: string; buffered?: boolean }) {
        observed.push(o)
      }
      disconnect() {
        cb = null
      }
    }
    const r = createReadyMark({ perf: p.perf, raf: fq.raf, caf: fq.caf, PerformanceObserver: PO, needsRail: () => true })
    r.editorCreated()
    expect(observed).toEqual([{ type: 'mark', buffered: true }])
    r.railFrame(true)
    cb!({ getEntries: () => [{ name: 'something-else' }] })
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(0)
    cb!({ getEntries: () => [{ name: EDITOR_READY_MARK }] })
    expect(cb).toBeNull() // disconnected once seen
    fq.run()
    expect(p.marks(READY_MARK)).toHaveLength(1)
  })
})

describe('mdr:ready through the shell', () => {
  it('is marked after the editor mark and the first complete rail layout', async () => {
    const app = document.createElement('div')
    app.id = 'mdr-app'
    document.body.append(app)
    const p = fakePerf()
    const fq = frameQueue()
    const session = createFakeDocSession({ file: 'doc.md', markdown: paragraphs(6), review: reviewWith([thread(1, { block: 1 }), thread(2, { block: 4 })]) })
    let created = false
    render(
      <Shell
        session={session}
        createEditor={async (o) => {
          const e = await createFakeEditor(o)
          // what P2 does once the doc, suggestions and highlights are in place
          p.perf.mark(EDITOR_READY_MARK)
          created = true
          return e
        }}
        app={app}
        railOptions={{ raf: fq.raf, caf: fq.caf, ResizeObserver: null, fonts: null }}
        readyOptions={{ perf: p.perf, raf: fq.raf, caf: fq.caf, PerformanceObserver: null }}
      />,
      { container: app },
    )
    await waitFor(() => expect(created).toBe(true))
    await waitFor(() => expect(document.querySelectorAll('.mdr-card--rail')).toHaveLength(2))
    expect(p.marks(READY_MARK)).toHaveLength(0)
    act(() => fq.run()) // rail layout (both cards) + the ready check
    act(() => fq.run()) // the ready frame
    expect(p.marks(READY_MARK)).toHaveLength(1)
    const editorAt = p.marks(EDITOR_READY_MARK)[0]!.startTime
    expect(p.marks(READY_MARK)[0]!.startTime).toBeGreaterThanOrEqual(editorAt)
  })
})
