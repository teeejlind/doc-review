// @vitest-environment jsdom
// tests/contract/editor-bridge.test.ts (integrator, day 0; CONTRACTS §12.0.3, D28).
//
// Runs the shared assertion set (editor-bridge.contract.ts) against createFakeEditor. P2 runs the very same function
// against the real bridge in its p2-rects e2e. jsdom has no layout: the fake editor's 'model' layout gives its own
// elements consistent rects (§12.0.3 formula), and this file only supplies what a scroll container would report in a
// browser (clientHeight = its 600 px viewport, scrollHeight = the content-space bottom of what it holds), so the
// contract's "scroll by 500 px" step is real rather than vacuous. A negative control proves the contract has teeth:
// a bridge that leaks viewport coordinates must fail it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TESTID } from '../../shared/constants'
import type { AnchorRect, EditorBridge } from '../../shared/types'
import { editorBridgeContract, HIGHLIGHT_TESTID } from './editor-bridge.contract'
import { mountFakeEditor, type MountedFakeEditor } from './targets'

const VIEWPORT_PX = 600

/** clientHeight / scrollHeight for a scroll container under jsdom, derived from its descendants' content-space rects. */
function installScrollMetrics(sc: HTMLElement, viewportPx: number): () => void {
  const contentBottom = (): number => {
    const c = sc.getBoundingClientRect()
    let max = 0
    for (const el of Array.from(sc.querySelectorAll<HTMLElement>('*'))) {
      const r = el.getBoundingClientRect()
      max = Math.max(max, r.bottom - c.top + sc.scrollTop - sc.clientTop)
    }
    return max
  }
  Object.defineProperty(sc, 'clientHeight', { configurable: true, get: () => viewportPx })
  Object.defineProperty(sc, 'scrollHeight', { configurable: true, get: () => Math.max(viewportPx, contentBottom()) })
  return () => {
    delete (sc as unknown as Record<string, unknown>).clientHeight
    delete (sc as unknown as Record<string, unknown>).scrollHeight
  }
}

describe('editor-bridge contract module', () => {
  it('the self-contained contract uses the frozen highlight test id', () => {
    expect(HIGHLIGHT_TESTID).toBe(TESTID.highlight)
  })

  it('references nothing from module scope at run time, so Playwright can serialize it', () => {
    const src = editorBridgeContract.toString()
    for (const name of ['HIGHLIGHT_TESTID', 'TESTID', 'installScrollMetrics', 'mountFakeEditor', 'import(']) expect(src).not.toContain(name)
  })
})

describe('editor-bridge contract (§12.0.3) against createFakeEditor', () => {
  let fake: MountedFakeEditor
  let restore: () => void

  beforeEach(async () => {
    fake = await mountFakeEditor({ document })
    restore = installScrollMetrics(fake.scrollContainer, VIEWPORT_PX)
    await fake.settled()
  })
  afterEach(() => {
    restore?.()
    fake?.destroy()
  })

  it('the fixture is real: several highlights, and a container that can scroll well past 500 px', () => {
    expect(document.querySelectorAll(`[data-testid="${TESTID.highlight}"]`).length).toBe(fake.threadIds.length)
    expect(fake.scrollContainer.scrollHeight - fake.scrollContainer.clientHeight).toBeGreaterThan(500)
  })

  it('the fake bridge passes every assertion (page-default environment: highlights found in the DOM)', async () => {
    const results = await editorBridgeContract({
      bridge: fake.bridge,
      scrollContainer: fake.scrollContainer,
      insertBlockAbove: fake.insertBlockAbove,
      settled: fake.settled,
    })
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.map((r) => r.name)).toEqual([
      'environment',
      'every listed anchor has a rect',
      'top ≤ bottom',
      'anchors in doc order have non-decreasing top',
      'rects unchanged after scrolling 500 px',
      "a highlight's rect top equals its element's content-space top (±1 px)",
      "inserting 200 px above moves the rect 200 ± 1 px and fires onLayoutInvalidated('doc')",
    ])
    expect(results[0]!.detail).toBe(`${fake.threadIds.length} anchors`)
  })

  it('negative control: a bridge that leaks viewport coordinates fails the scroll and content-space assertions', async () => {
    const sc = fake.scrollContainer
    const viewportRects = (ids: readonly string[]): Map<string, AnchorRect | null> => {
      const out = new Map<string, AnchorRect | null>()
      for (const [k, v] of fake.bridge.getAnchorRects(ids)) {
        out.set(k, v ? { top: v.top - sc.scrollTop, bottom: v.bottom - sc.scrollTop, left: v.left } : null)
      }
      return out
    }
    // forwards every member to the real fake (bound, so its private state keeps working) except getAnchorRects
    const leaky = new Proxy(fake.bridge, {
      get(target, prop) {
        if (prop === 'getAnchorRects') return viewportRects
        const v: unknown = Reflect.get(target, prop, target)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as EditorBridge
    const results = await editorBridgeContract({ bridge: leaky, scrollContainer: sc, insertBlockAbove: fake.insertBlockAbove, settled: fake.settled })
    const failed = results.filter((r) => !r.ok).map((r) => r.name)
    expect(failed).toContain('rects unchanged after scrolling 500 px')
    expect(failed).toContain("a highlight's rect top equals its element's content-space top (±1 px)")
  })

  it('negative control: a bridge that never reports layout changes fails the insertion assertion', async () => {
    const silent = new Proxy(fake.bridge, {
      get(target, prop) {
        if (prop === 'onLayoutInvalidated') return () => () => undefined
        const v: unknown = Reflect.get(target, prop, target)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as EditorBridge
    const results = await editorBridgeContract({ bridge: silent, scrollContainer: fake.scrollContainer, insertBlockAbove: fake.insertBlockAbove, settled: fake.settled })
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual(["inserting 200 px above moves the rect 200 ± 1 px and fires onLayoutInvalidated('doc')"])
  })
})
