// Integrator (day 0): tests/helpers/trace.ts against a trace sample (CONTRACTS §11.7). The sample
// (tests/fixtures/trace/typing-sample.json) is in Chromium's trace-event format: thread_name metadata, RunTask and
// keydown EventDispatch complete events on CrRendererMain, DrawFrame instants on the viz compositor, browser-main
// tasks that must never count. 30 keydowns 30 ms apart; one 25 ms task inside the 10-keystroke warm-up (excluded),
// one 20 ms task after it (counted), one 20 ms keydown→frame (under the 33 ms max, above p95's rank).
// A real recording replaces this sample in Phase 2 when Playwright's Chromium is installed (`p3-perf` writes one to
// test-results/); the assertions below must hold for any trace that has these shapes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeTyping, mainThreads, parseTrace, percentile, slices, typingViolations } from '../../helpers/trace'
import { REPO_ROOT } from '../../helpers/tmpRoot'

const SAMPLE = join(REPO_ROOT, 'tests', 'fixtures', 'trace', 'typing-sample.json')

describe('trace.ts', () => {
  const events = parseTrace(readFileSync(SAMPLE, 'utf8'))

  it('parses { traceEvents } and bare arrays alike', () => {
    expect(events.length).toBeGreaterThan(100)
    expect(parseTrace(JSON.stringify(events)).length).toBe(events.length)
    expect(() => parseTrace('{"nope": 1}')).toThrow()
  })

  it('finds the renderer main thread by thread_name metadata only', () => {
    expect(mainThreads(events)).toEqual([{ pid: 2, tid: 3 }])
  })

  it('pairs B/E events into slices', () => {
    const be = parseTrace([
      { name: 'RunTask', ph: 'B', ts: 10, pid: 1, tid: 2 },
      { name: 'RunTask', ph: 'E', ts: 30, pid: 1, tid: 2 },
    ])
    expect(slices(be, 'RunTask')).toEqual([{ ts: 10, dur: 20, pid: 1, tid: 2 }])
  })

  it('nearest-rank percentile', () => {
    expect(percentile([], 95)).toBe(0)
    expect(percentile([5], 95)).toBe(5)
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19)
  })

  it('measures the §11.7 budget: warm-up excluded, browser-main tasks ignored', () => {
    const a = analyzeTyping(events)
    expect(a.keydowns).toBe(30)
    expect(a.measured).toBe(20)
    expect(a.frames).toBe(30)
    expect(a.unmatchedKeydowns).toBe(0)
    expect(a.longTasks.map((t) => t.ms)).toEqual([20])
    expect(a.maxTaskMs).toBe(20)
    expect(a.p95KeyToFrameMs).toBe(8)
    expect(a.maxKeyToFrameMs).toBe(20)
    const v = typingViolations(a)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/main-thread task 20\.0 ms > 16 ms/)
  })

  it('a trace without keydowns is a violation, not a pass', () => {
    const v = typingViolations(analyzeTyping(events.filter((e) => e.name !== 'EventDispatch')))
    expect(v.some((x) => x.includes('no keydown'))).toBe(true)
  })
})
