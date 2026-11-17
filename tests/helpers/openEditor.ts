// tests/helpers/openEditor.ts (integrator, day 0; CONTRACTS §1.3, §12.0.3, §12.0.4, §12.15, D51).
//
// Playwright helper: open `/?file=<rel>` on a server (real or fake), wait until the editor is up, and hand back typed
// accessors. Elements are located by `data-testid` from TESTID only (§12.15). `debug` proxies window.__mdrDebug
// (§12.0.4) through page.evaluate; `bridge(fn)` / `session(fn)` run a function in the page against the live
// EditorBridge / DocSession, which is how p2-* specs drive what a P3 control would (D51).
import type { Locator, Page } from '@playwright/test'
import type { BlockHash, BlockInfo, BlockOp, DocSession, EditorBridge } from '../../shared/types'
import { TESTID } from '../../shared/constants'

export type TestIdKey = keyof typeof TESTID

export interface DebugProxy {
  blocks(): Promise<BlockInfo[]>
  ptext(): Promise<{ text: string; blockRanges: Array<{ index: number; pStart: number; pEnd: number }> }>
  planSave(): Promise<BlockOp[]>
  liveMarkdown(): Promise<string>
  settled(): Promise<void>
  failSplice(blockHashes: readonly BlockHash[]): Promise<void>
}

export interface EditorPage {
  readonly page: Page
  readonly url: string
  /** Locator for a TESTID key, optionally narrowed by attributes, e.g. testid('highlight', { 'data-thread': id }). */
  testid(key: TestIdKey, attrs?: Record<string, string>): Locator
  editor(): Locator
  readonly debug: DebugProxy
  settled(): Promise<void>
  /** Run `fn(bridge, arg)` in the page (window.__mdrDebug.bridge()). `fn` must be self-contained (it is serialized). */
  bridge<R, A = undefined>(fn: (bridge: EditorBridge, arg: A) => R | Promise<R>, arg?: A): Promise<R>
  /** Run `fn(session, arg)` in the page (window.__mdrDebug.session()). */
  session<R, A = undefined>(fn: (session: DocSession, arg: A) => R | Promise<R>, arg?: A): Promise<R>
}

export interface OpenEditorOptions {
  port: number
  /** Root-relative POSIX path. */
  file: string
  /** '127.0.0.1' (canonical, D13) or 'localhost' (an old-style link). */
  host?: '127.0.0.1' | 'localhost'
  /**
   * What to wait for: 'debug' (window.__mdrDebug defined: P2's editor with test hooks; the default), 'editor'
   * ([data-testid="mdr-editor"] visible), 'load' (the page load event only, e.g. for empty-state specs).
   */
  wait?: 'debug' | 'editor' | 'load'
  timeoutMs?: number
  /**
   * The mode to leave the page in. The app opens every doc in Suggesting (TJ, 2026-11-16); most specs were written
   * against Editing, so the helper switches to Editing explicitly unless told otherwise. 'as-loaded' leaves the page as
   * it opened (the default-mode spec). Only with wait 'debug' (it goes through the bridge).
   */
  mode?: 'editing' | 'suggesting' | 'as-loaded'
}

const selector = (key: TestIdKey, attrs: Record<string, string> = {}): string =>
  `[data-testid="${TESTID[key]}"]` + Object.entries(attrs).map(([k, v]) => `[${k}="${v.replace(/"/g, '\\"')}"]`).join('')

export async function openEditor(page: Page, o: OpenEditorOptions): Promise<EditorPage> {
  const url = `http://${o.host ?? '127.0.0.1'}:${o.port}/?file=${encodeURIComponent(o.file)}`
  const timeout = o.timeoutMs ?? 15_000
  await page.goto(url, { waitUntil: 'load', timeout })
  const wait = o.wait ?? 'debug'
  if (wait === 'debug') {
    await page.waitForFunction(() => typeof (window as unknown as { __mdrDebug?: unknown }).__mdrDebug === 'object', undefined, { timeout })
    await page.evaluate(() => (window as unknown as { __mdrDebug: { settled(): Promise<void> } }).__mdrDebug.settled())
    const mode = o.mode ?? 'editing'
    if (mode !== 'as-loaded') {
      await page.evaluate((m) => (window as unknown as { __mdrDebug: { bridge(): { setMode(x: string): void } } }).__mdrDebug.bridge().setMode(m), mode)
    }
  } else if (wait === 'editor') {
    await page.locator(selector('editor')).first().waitFor({ state: 'visible', timeout })
  }

  const dbg = <K extends keyof DebugProxy>(name: K, ...args: unknown[]): Promise<Awaited<ReturnType<DebugProxy[K]>>> =>
    page.evaluate(
      ([n, a]) => {
        const d = (window as unknown as { __mdrDebug?: Record<string, (...x: unknown[]) => unknown> }).__mdrDebug
        if (!d) throw new Error('window.__mdrDebug is not defined (is the server running with MDR_TEST_HOOKS=1?)')
        return d[n as string]!(...(a as unknown[]))
      },
      [name, args] as const,
    ) as Promise<Awaited<ReturnType<DebugProxy[K]>>>

  const debug: DebugProxy = {
    blocks: () => dbg('blocks'),
    ptext: () => dbg('ptext'),
    planSave: () => dbg('planSave'),
    liveMarkdown: () => dbg('liveMarkdown'),
    settled: () => dbg('settled'),
    failSplice: (h) => dbg('failSplice', [...h]),
  }

  const run = <R>(which: 'bridge' | 'session', fn: (x: never, arg: never) => unknown, arg: unknown): Promise<R> =>
    page.evaluate(
      async ([w, src, a]) => {
        const d = (window as unknown as { __mdrDebug?: Record<string, () => unknown> }).__mdrDebug
        if (!d) throw new Error('window.__mdrDebug is not defined')
        // revive the serialized function inside the page
        const f = new Function(`return (${src as string})`)() as (x: unknown, y: unknown) => unknown
        return await f(d[w as string]!(), a)
      },
      [which, fn.toString(), arg] as const,
    ) as Promise<R>

  return {
    page,
    url,
    testid: (key, attrs) => page.locator(selector(key, attrs)),
    editor: () => page.locator(selector('editor')).first(),
    debug,
    settled: () => debug.settled(),
    bridge: (fn, arg) => run('bridge', fn as never, arg),
    session: (fn, arg) => run('session', fn as never, arg),
  }
}
