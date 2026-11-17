// tests/contract/editor-bridge.contract.ts (integrator, day 0; CONTRACTS §12.0.3 "One contract for both bridges", D28).
//
// ONE assertion set for every EditorBridge: run against createFakeEditor in vitest (tests/contract/editor-bridge.test.ts)
// and against P2's real bridge in the browser (P2's p2-rects e2e). The assertions (§12.0.3):
//   1. rects are unchanged after scrolling the container by 500 px (content coordinates, not viewport);
//   2. top ≤ bottom for every rect;
//   3. anchors in doc order have non-decreasing top;
//   4. a highlight's getAnchorRects([id]).top equals its element's content-space top within 1 px
//      (top = r.top − C.top + scrollTop − clientTop, C = scrollContainer.getBoundingClientRect());
//   5. inserting a 200 px block above an anchor fires onLayoutInvalidated('doc') and moves its rect by 200 ± 1 px.
//
// `editorBridgeContract` is deliberately SELF-CONTAINED: it references nothing from module scope at run time (type
// imports only), so Playwright can serialize it. P2's spec, after the doc is open and settled:
//
//   import { editorBridgeContract } from '../contract/editor-bridge.contract'
//   await page.evaluate(() => { window.__mdrBridgeContract = { insertBlockAbove: async (id, px) => { ...P2's way... } } })
//   const results = await page.evaluate(editorBridgeContract)
//   expect(results.filter((r) => !r.ok)).toEqual([])
//
// With no argument the function builds its environment from the live page: window.__mdrDebug.bridge() (§12.0.4),
// #mdr-scroll, #mdr-editor-host, the [data-testid="mdr-highlight"][data-thread] elements (§12.15) and
// window.__mdrBridgeContract.insertBlockAbove (the one step only the editor can do: a real 200 px block, inserted
// through a transaction). In vitest every member can be passed instead.
//
// Day 0 it was run this way in Chromium against the MDR_FAKE_EDITOR build of the harness page served by fakeApp
// (all seven results ok). Playwright's own TS transform injects no helpers into the serialized function; a build step
// that compiles the spec with esbuild `keepNames` (tsx does) wraps inner functions in `__name(...)`, so define
// `window.__name = (f) => f` in the page first in that case.
import type { EditorBridge } from '../../shared/types'

export interface BridgeContractEnv {
  bridge: EditorBridge
  /** The single scroll container (#mdr-scroll): the AnchorRect origin. */
  scrollContainer: HTMLElement
  /** Ids of at least two placed anchors, in doc order, each with a highlight element. */
  anchorIds: string[]
  /** The first highlight element of an anchor. */
  highlightOf(id: string): HTMLElement | null
  /** Insert a block exactly `px` tall directly above the block holding anchor `id` (through the editor, not raw DOM). */
  insertBlockAbove(id: string, px: number): void | Promise<void>
  /** Resolves once the editor and layout are settled (P2: __mdrDebug.settled(); default: two animation frames). */
  settled(): Promise<void>
}

export interface BridgeContractResult {
  name: string
  ok: boolean
  detail: string
}

/** The page hook P2's spec installs for assertion 5. */
export interface BridgeContractPageHooks {
  insertBlockAbove(id: string, px: number): void | Promise<void>
}

/** Same value as TESTID.highlight (asserted in editor-bridge.test.ts); a literal so this function stays self-contained. */
export const HIGHLIGHT_TESTID = 'mdr-highlight'

export async function editorBridgeContract(override?: Partial<BridgeContractEnv>): Promise<BridgeContractResult[]> {
  const results: BridgeContractResult[] = []
  const record = (name: string, ok: boolean, detail = ''): void => {
    results.push({ name, ok, detail })
  }
  const TOL = 1
  const w = globalThis as unknown as {
    __mdrDebug?: { bridge(): EditorBridge; settled(): Promise<void> }
    __mdrBridgeContract?: BridgeContractPageHooks
    requestAnimationFrame?: (cb: () => void) => number
    document: Document
  }
  const o = override ?? {}
  const highlightSel = '[data-testid="mdr-highlight"]'

  const frame = (): Promise<void> =>
    new Promise((res) => (w.requestAnimationFrame ? w.requestAnimationFrame(() => res()) : setTimeout(res, 16)))
  const settled = o.settled ?? (async () => {
    if (w.__mdrDebug) await w.__mdrDebug.settled()
    await frame()
    await frame()
  })
  const bridge = o.bridge ?? w.__mdrDebug?.bridge()
  const scrollContainer = o.scrollContainer ?? w.document.getElementById('mdr-scroll')
  const host = w.document.getElementById('mdr-editor-host')
  const highlightOf =
    o.highlightOf ??
    ((id: string): HTMLElement | null => {
      const root = host ?? w.document
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(highlightSel))) if (el.dataset.thread === id) return el
      return null
    })
  const anchorIds =
    o.anchorIds ??
    (() => {
      const seen: string[] = []
      for (const el of Array.from((host ?? w.document).querySelectorAll<HTMLElement>(highlightSel))) {
        const id = el.dataset.thread
        if (id && !seen.includes(id)) seen.push(id)
      }
      return seen
    })()
  const insertBlockAbove = o.insertBlockAbove ?? w.__mdrBridgeContract?.insertBlockAbove

  if (!bridge || !scrollContainer) {
    record('environment', false, `missing ${!bridge ? 'bridge (window.__mdrDebug.bridge())' : ''} ${!scrollContainer ? 'scroll container (#mdr-scroll)' : ''}`.trim())
    return results
  }
  if (anchorIds.length < 2) {
    record('environment', false, `need at least 2 placed anchors with highlights, found ${anchorIds.length}`)
    return results
  }
  record('environment', true, `${anchorIds.length} anchors`)

  const sc = scrollContainer
  const rectsOf = (): Map<string, { top: number; bottom: number; left: number } | null> => bridge.getAnchorRects(anchorIds)
  const contentTop = (el: HTMLElement): number => {
    const c = sc.getBoundingClientRect()
    return el.getBoundingClientRect().top - c.top + sc.scrollTop - sc.clientTop
  }
  const fmt = (n: number): string => (Math.round(n * 100) / 100).toString()
  const startScroll = sc.scrollTop

  try {
    sc.scrollTop = 0
    await settled()
    const before = rectsOf()

    // placed: every listed anchor has a rect
    const unplaced = anchorIds.filter((id) => !before.get(id))
    record('every listed anchor has a rect', unplaced.length === 0, unplaced.length ? `null rects: ${unplaced.join(', ')}` : '')

    // 2. top ≤ bottom
    const inverted = anchorIds.filter((id) => {
      const r = before.get(id)
      return r ? !(r.top <= r.bottom) : false
    })
    record('top ≤ bottom', inverted.length === 0, inverted.join(', '))

    // 3. doc order → non-decreasing top
    let orderOk = true
    let orderDetail = ''
    for (let i = 1; i < anchorIds.length; i++) {
      const a = before.get(anchorIds[i - 1]!)
      const b = before.get(anchorIds[i]!)
      if (a && b && b.top < a.top - TOL) {
        orderOk = false
        orderDetail = `${anchorIds[i]} top ${fmt(b.top)} < ${anchorIds[i - 1]} top ${fmt(a.top)}`
        break
      }
    }
    record('anchors in doc order have non-decreasing top', orderOk, orderDetail)

    // 1. scrolling by 500 px changes no rect
    const maxScroll = sc.scrollHeight - sc.clientHeight
    if (maxScroll < 500) {
      record('rects unchanged after scrolling 500 px', false, `the container can scroll only ${fmt(maxScroll)} px; the fixture must be taller`)
    } else {
      sc.scrollTop = 500
      await settled()
      if (Math.abs(sc.scrollTop - 500) > TOL) {
        record('rects unchanged after scrolling 500 px', false, `scrollTop is ${fmt(sc.scrollTop)} after setting 500`)
      } else {
        const after = rectsOf()
        const moved: string[] = []
        for (const id of anchorIds) {
          const a = before.get(id)
          const b = after.get(id)
          if (!a || !b) continue
          if (Math.abs(a.top - b.top) > TOL || Math.abs(a.bottom - b.bottom) > TOL || Math.abs(a.left - b.left) > TOL) {
            moved.push(`${id}: ${fmt(a.top)}/${fmt(a.bottom)}/${fmt(a.left)} → ${fmt(b.top)}/${fmt(b.bottom)}/${fmt(b.left)}`)
          }
        }
        record('rects unchanged after scrolling 500 px', moved.length === 0, moved.join('; '))
      }
    }

    // 4. rect top == highlight element's content-space top, at two scroll positions
    const off: string[] = []
    for (const pos of [0, Math.min(250, Math.max(0, maxScroll))]) {
      sc.scrollTop = pos
      await settled()
      const rects = rectsOf()
      for (const id of anchorIds) {
        const el = highlightOf(id)
        const r = rects.get(id)
        if (!el) {
          off.push(`${id}: no highlight element`)
          continue
        }
        if (!r) continue
        const t = contentTop(el)
        if (Math.abs(t - r.top) > TOL) off.push(`${id} @scroll ${pos}: rect ${fmt(r.top)} vs element ${fmt(t)}`)
      }
    }
    record("a highlight's rect top equals its element's content-space top (±1 px)", off.length === 0, off.join('; '))

    // 5. a 200 px block above an anchor: onLayoutInvalidated('doc') and the rect moves 200 ± 1 px
    const target = anchorIds[anchorIds.length - 1]!
    if (!insertBlockAbove) {
      record("inserting 200 px above moves the rect 200 ± 1 px and fires onLayoutInvalidated('doc')", false,
        'no insertBlockAbove: pass it, or define window.__mdrBridgeContract.insertBlockAbove(id, px) in the page')
    } else {
      sc.scrollTop = 0
      await settled()
      const t0 = bridge.getAnchorRects([target]).get(target)
      const reasons: string[] = []
      const off5 = bridge.onLayoutInvalidated((r) => {
        reasons.push(r)
      })
      try {
        await insertBlockAbove(target, 200)
        await settled()
      } finally {
        off5()
      }
      const t1 = bridge.getAnchorRects([target]).get(target)
      const delta = t0 && t1 ? t1.top - t0.top : NaN
      const ok = reasons.includes('doc') && Math.abs(delta - 200) <= TOL
      record("inserting 200 px above moves the rect 200 ± 1 px and fires onLayoutInvalidated('doc')", ok,
        `delta ${fmt(delta)} px; reasons [${reasons.join(', ')}]`)
    }
  } catch (e) {
    record('no exception', false, e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  } finally {
    sc.scrollTop = startScroll
  }
  return results
}
