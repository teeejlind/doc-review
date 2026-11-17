// tests/e2e/fixtures/p3.ts (P3; CONTRACTS §2.1, §2.5, §11, §12.15).
//
// P3's e2e helpers. P3 specs run against startFakeServer and the MDR_FAKE_EDITOR page until P2 lands
// (`MDR_FAKE_EDITOR=1 npm run e2e -- tests/e2e/p3-*`), then against the real server and the real P2 modules; the
// helpers here only use §12.15 test ids, the §12.0.1 hosts and window.__mdrDebug, so they work on both.
import type { Page } from '@playwright/test'
import { TESTID } from '../../../shared/constants'

/** 'fake' while the page is built with the fake P2 modules, 'real' otherwise. */
export const P3_SERVER_KIND: 'real' | 'fake' = process.env.MDR_FAKE_EDITOR === '1' ? 'fake' : 'real'

/** A long markdown doc: headings and wrapped paragraphs, each carrying a unique `markerNx` token to anchor on. */
export function railDoc(paragraphs = 36): string {
  const words = ['ledger', 'member', 'tranche', 'borrower', 'servicer', 'collateral', 'waterfall', 'covenant']
  const out: string[] = ['# Rail check', 'A short opening paragraph that sets things up for the rest of the document.']
  for (let i = 0; i < paragraphs; i++) {
    if (i % 9 === 0) out.push(`## Section ${i / 9 + 1}`)
    out.push(
      `Paragraph ${i} talks about the ${words[i % words.length]} and why it matters for marker${i}x. ` +
        'It keeps going for a while so the line wraps across the column and the reading measure is visible. '.repeat(1 + (i % 3)),
    )
  }
  return out.join('\n\n') + '\n'
}

export interface RailCardState {
  thread: string
  /** Card top / bottom in #mdr-scroll content coordinates. */
  top: number
  bottom: number
  /** The anchor highlight's top in the same coordinates (null when no highlight is rendered). */
  anchor: number | null
  /** Viewport (client) top. */
  clientTop: number
  placed: string | undefined
  active: boolean
  collapsed: string | undefined
}

export interface RailState {
  scrollTop: number
  clientHeight: number
  /** Bottom of the rail header panel in content coordinates (minTop). */
  minTop: number
  cards: RailCardState[]
}

/** Reads every card's geometry in content coordinates (§12.0.3 formula), in one page.evaluate. */
export function railState(page: Page): Promise<RailState> {
  return page.evaluate(
    ([cardId, hlId, headerId]) => {
      const sc = document.getElementById('mdr-scroll')!
      const c = sc.getBoundingClientRect()
      const content = (y: number): number => y - c.top + sc.scrollTop - sc.clientTop
      const header = document.querySelector(`[data-testid="${headerId}"]`)
      const cards = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${cardId}"]`)).map((el) => {
        const r = el.getBoundingClientRect()
        const hl = document.querySelector(`[data-testid="${hlId}"][data-thread="${el.dataset.thread}"]`)
        return {
          thread: el.dataset.thread ?? '',
          top: content(r.top),
          bottom: content(r.bottom),
          anchor: hl ? content(hl.getBoundingClientRect().top) : null,
          clientTop: r.top,
          placed: el.dataset.placed,
          active: el.dataset.active === 'true',
          collapsed: el.dataset.collapsed,
        }
      })
      return { scrollTop: sc.scrollTop, clientHeight: sc.clientHeight, minTop: header ? content(header.getBoundingClientRect().bottom) : 0, cards }
    },
    [TESTID.card, TESTID.highlight, TESTID.railHeader] as const,
  )
}

/** Two animation frames plus the card-move transition (so measured positions are final). */
export async function railSettled(page: Page, transitionMs = 200): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  await page.waitForTimeout(transitionMs)
}

/**
 * Selects text in the editor the way a drag does: focus the editor, then a DOM selection from the start of `from`
 * to the end of `to` (both quotes searched in the editor's text nodes; `to` defaults to `from`). `backward` puts the
 * anchor at the end (a right-to-left drag). Works on the fake editor and on ProseMirror (it reads DOM selections).
 *
 * A person only drags over text they can see, so when the whole range is outside #mdr-scroll's visible box the
 * helper first scrolls its start to 30% of the viewport (as TJ would scroll there before dragging). ProseMirror never
 * scrolls a selection it reads from the DOM, so without this an off-screen pick leaves the floating Comment button
 * hidden, correctly. `reveal: false` keeps the scroll position (a spec that wants an off-screen selection).
 */
export async function selectText(page: Page, o: { from: string; to?: string; backward?: boolean; collapseAt?: 'start' | 'end'; reveal?: boolean }): Promise<void> {
  await page.evaluate(
    ({ from, to, backward, collapseAt, reveal, editorId }) => {
      const root = document.querySelector<HTMLElement>(`[data-testid="${editorId}"]`)!
      root.focus({ preventScroll: true })
      const find = (needle: string): { node: Text; offset: number } => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          const i = n.data.indexOf(needle)
          if (i >= 0) return { node: n, offset: i }
        }
        throw new Error(`text not found in the editor: ${needle}`)
      }
      const a = find(from)
      const b = find(to ?? from)
      const end = { node: b.node, offset: b.offset + (to ?? from).length }
      if (reveal) {
        const sc = document.getElementById('mdr-scroll')!
        const range = document.createRange()
        if (collapseAt) {
          // a caret has no box: measure the character next to it
          const p = collapseAt === 'start' ? a : end
          const s0 = Math.min(p.offset, Math.max(0, p.node.data.length - 1))
          range.setStart(p.node, s0)
          range.setEnd(p.node, Math.min(s0 + 1, p.node.data.length))
        } else {
          range.setStart(a.node, a.offset)
          range.setEnd(end.node, end.offset)
        }
        const r = range.getBoundingClientRect()
        const c = sc.getBoundingClientRect()
        if (r.bottom <= c.top || r.top >= c.bottom) sc.scrollTop = Math.max(0, Math.round(r.top - c.top + sc.scrollTop - sc.clientHeight * 0.3))
      }
      const sel = document.getSelection()!
      if (collapseAt) {
        const p = collapseAt === 'start' ? a : end
        sel.setBaseAndExtent(p.node, p.offset, p.node, p.offset)
      } else if (backward) sel.setBaseAndExtent(end.node, end.offset, a.node, a.offset)
      else sel.setBaseAndExtent(a.node, a.offset, end.node, end.offset)
    },
    { from: o.from, to: o.to ?? null, backward: o.backward ?? false, collapseAt: o.collapseAt ?? null, reveal: o.reveal ?? true, editorId: TESTID.editor },
  )
  // the selection watch reads once per frame
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

/** Is the element's box inside #mdr-scroll's visible box? */
export function inViewport(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el || (el as HTMLElement).hidden) return false
    const r = el.getBoundingClientRect()
    const c = document.getElementById('mdr-scroll')!.getBoundingClientRect()
    return r.height > 0 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5
  }, selector)
}

/** `[data-testid=…]` plus attribute filters, from TESTID keys only (§12.15). */
export const sel = (key: keyof typeof TESTID, attrs: Record<string, string> = {}): string =>
  `[data-testid="${TESTID[key]}"]` + Object.entries(attrs).map(([k, v]) => `[${k}="${v}"]`).join('')

/**
 * A recording clipboard installed before the page loads: every writeText lands in window.__clipWrites, and
 * window.__clipRefuse = true makes writes reject (the browser refusing the clipboard). Headless permission prompts
 * never get in the way, and the specs can assert exactly what was copied, and when.
 */
export async function installClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __clipWrites: string[]; __clipRefuse: boolean }
    w.__clipWrites = []
    w.__clipRefuse = false
    const clip = {
      writeText: (s: string): Promise<void> => {
        if (w.__clipRefuse) return Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'))
        w.__clipWrites.push(s)
        return Promise.resolve()
      },
      readText: (): Promise<string> => Promise.resolve(w.__clipWrites.at(-1) ?? ''),
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clip })
  })
}

export const clipWrites = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __clipWrites: string[] }).__clipWrites)
export const setClipRefuse = (page: Page, on: boolean): Promise<void> =>
  page.evaluate((v) => void ((window as unknown as { __clipRefuse: boolean }).__clipRefuse = v), on)

/** FakeDocSession.emit in the page (MDR_FAKE_EDITOR builds expose it on window.__mdrFake.session). */
export async function fakeEmit(page: Page, e: Record<string, unknown>): Promise<boolean> {
  return page.evaluate((x) => {
    const s = (window as unknown as { __mdrFake?: { session?: { emit?(e: unknown): void } } }).__mdrFake?.session
    if (!s?.emit) return false
    s.emit(x)
    return true
  }, e)
}

/**
 * The rail header keeps Show resolved and "Claude may edit directly" behind its settings button (QA3): open that panel
 * if it is closed, so the switches can be clicked. The panel stays open for the rest of the page's life.
 */
export async function openRailSettings(page: Page): Promise<void> {
  const gear = page.locator(sel('railSettings')).first()
  if ((await gear.getAttribute('aria-expanded')) !== 'true') await gear.click()
}
