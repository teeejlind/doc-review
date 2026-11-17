// tests/helpers/int.ts (integrator, M4; CONTRACTS §2.5 "Full-UI flows are integrator specs").
//
// Small page-side helpers shared by the int-* specs, which drive the full UI (P3's shell over P2's editor and
// session) against the real built server and the real CLI. Everything is located by §12.15 test ids or read through
// window.__mdrDebug (§12.0.4); nothing here knows a CSS class or a visible string.
import type { Locator, Page } from '@playwright/test'
import { TESTID } from '../../shared/constants'

/**
 * Port offset inside the worker's window of ten for every int-* spec. MDR_E2E_PORT_OFFSET (0..9) moves it, for running
 * the int specs beside another e2e run on the same machine (the same knob p1 and p4 read). Unset, it is 0.
 */
export const INT_PORT_OFFSET: number = (() => {
  const n = Number.parseInt(process.env.MDR_E2E_PORT_OFFSET ?? '0', 10)
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : 0
})()

/** `[data-testid=…]` plus attribute filters, from TESTID keys only. */
export const tid = (key: keyof typeof TESTID, attrs: Record<string, string> = {}): string =>
  `[data-testid="${TESTID[key]}"]` + Object.entries(attrs).map(([k, v]) => `[${k}="${v.replace(/"/g, '\\"')}"]`).join('')

export const toastOf = (page: Page, code: string): Locator => page.locator(tid('toast', { 'data-code': code }))
export const badgeOf = (page: Page): Locator => page.locator(tid('claudeBadge'))
export const cardOf = (page: Page, thread: string): Locator => page.locator(tid('card', { 'data-thread': thread }))

/** The waiter presence the page's session holds (what its clientDecision is computed from, §12.10 step 1). */
export function pageWaiter(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const d = (window as unknown as { __mdrDebug?: { session(): { getReview(): { presence?: { waiter: string } } } } }).__mdrDebug
    return d?.session().getReview().presence?.waiter ?? null
  })
}

/** The page's save state (SaveState.state) through the live session. */
export function pageSaveState(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const d = (window as unknown as { __mdrDebug?: { session(): { getSaveState(): { state: string } } } }).__mdrDebug
    return d?.session().getSaveState().state ?? null
  })
}

/** The editor's live markdown (window.__mdrDebug.liveMarkdown). */
export function liveMarkdown(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __mdrDebug: { liveMarkdown(): string } }).__mdrDebug.liveMarkdown())
}

/** px from #mdr-scroll's top edge to the top of the top-level editor block whose text contains `text`. */
export function blockOffset(page: Page, text: string): Promise<number> {
  return page.evaluate((t) => {
    const scroll = document.getElementById('mdr-scroll')!
    const pm = document.querySelector('#mdr-editor-host .ProseMirror')!
    const el = [...pm.children].find((c) => c.textContent?.includes(t))
    if (!el) throw new Error(`no editor block contains ${t}`)
    return el.getBoundingClientRect().top - scroll.getBoundingClientRect().top
  }, text)
}

/** Scroll #mdr-scroll so the block containing `text` sits `px` below the container's top edge. */
export async function scrollBlockTo(page: Page, text: string, px: number): Promise<void> {
  await page.evaluate(([t, y]) => {
    const scroll = document.getElementById('mdr-scroll')!
    const pm = document.querySelector('#mdr-editor-host .ProseMirror')!
    const el = [...pm.children].find((c) => c.textContent?.includes(t as string))
    if (!el) throw new Error(`no editor block contains ${t as string}`)
    scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - (y as number)
  }, [text, px] as const)
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

/** Stop / continue a detached child's whole process group (a waiter loop: its shell and any `wait` child). */
export function signalGroup(pid: number, sig: 'SIGSTOP' | 'SIGCONT'): void {
  try {
    process.kill(-pid, sig)
  } catch {
    // already gone
  }
}
