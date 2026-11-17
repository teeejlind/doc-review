// tests/e2e/fixtures/p2.ts (P2). Helpers shared by the p2-* specs: open a doc the spec writes into the tmp root,
// capture editor notices, put the caret at a text, read the file and compare line diffs, act as Claude through the
// agent route, hold the page's saves, count the page's writes, and force a splice fault on the server. P2-owned ids
// and window.__mdrDebug only (§2.5, §12.0.4). Everything here works against startFakeServer and the real server.
import type { Page, Route } from '@playwright/test'
import { expect } from '@playwright/test'
import type { AgentOp, BatchResult, BlockHash, DocSnapshot, SaveState, SuggestionSummary } from '../../../shared/types'
import { openEditor, type EditorPage } from '../../helpers/openEditor'
import { agentHeaders, browserHeaders } from '../../helpers/startServer'
import type { TmpRoot } from '../../helpers/tmpRoot'

export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/**
 * Moves the caret to the end of its line. On macOS, Playwright maps `End` to `scrollToEndOfDocument:` (as Chrome on a
 * Mac does), so it never moves the caret; `Meta+ArrowRight` is `moveToEndOfLine:`. (Integrator, P3 merge: on the
 * day-0 harness the click alone left the caret at the line end, because the unstyled paragraph was wider than twice
 * its text; P3's reading column puts a locator click mid-sentence.)
 */
export const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'

/** What the helpers need from the `server` fixture (real or fake). */
export interface ServerLike {
  readonly port: number
  readonly origin: string
  readonly token: string
}

/** Act as Claude: POST /api/agent/batch?file= with the agent headers (what `mdr batch` sends, §8.4). Throws on non-2xx. */
export async function claude(server: ServerLike, file: string, ops: AgentOp[]): Promise<BatchResult> {
  const r = await fetch(`${server.origin}/api/agent/batch?file=${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { ...agentHeaders({ token: server.token }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops }),
  })
  const json = (await r.json()) as BatchResult
  if (!r.ok) throw new Error(`agent batch: HTTP ${r.status} ${JSON.stringify(json)}`)
  return json
}

/** GET /api/doc?file= as a browser client (no page involved). */
export async function serverDoc(server: ServerLike, file: string): Promise<DocSnapshot> {
  const r = await fetch(`${server.origin}/api/doc?file=${encodeURIComponent(file)}`, { headers: browserHeaders({ token: server.token, port: server.port }) })
  if (!r.ok) throw new Error(`GET /api/doc: HTTP ${r.status} ${await r.text()}`)
  return (await r.json()) as DocSnapshot
}

/** Write `text` to the file (an external write, e.g. Claude's Edit tool) and wait until the server has recorded it. */
export async function externalWrite(server: ServerLike, tmpRoot: TmpRoot, file: string, text: string): Promise<DocSnapshot> {
  tmpRoot.write(file, text)
  let snap: DocSnapshot | null = null
  await expect
    .poll(async () => {
      snap = await serverDoc(server, file)
      return snap.markdown
    }, { timeout: 10_000, message: 'the server never recorded the external write' })
    .toBe(text)
  return snap!
}

/** POST /__test/splice-fault on the server (fake or real under MDR_TEST_HOOKS=1, §2.5, §12.0.4). [] clears. */
export async function serverSpliceFault(server: ServerLike, file: string, blockHashes: readonly BlockHash[]): Promise<void> {
  const r = await fetch(`${server.origin}/__test/splice-fault?file=${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { ...browserHeaders({ token: server.token, port: server.port, clientId: `k_${'0'.repeat(26)}` }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, blockHashes }),
  })
  if (!r.ok) throw new Error(`/__test/splice-fault: HTTP ${r.status} ${await r.text()}`)
}

/**
 * Hold every POST /api/save the page sends until `release()`; what is held then goes on to the server unchanged.
 * Lets a spec order "TJ typed" before "the disk changed" before "TJ's save lands" deterministically.
 */
export async function holdSaves(page: Page): Promise<{ held(): number; release(): Promise<void> }> {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let n = 0
  const pending: Array<Promise<void>> = []
  const pattern = /\/api\/save(\?|$)/
  const handler = (route: Route): Promise<void> => {
    n++
    const p = gate.then(() => route.continue()).catch(() => undefined) // a request the page aborted meanwhile is gone
    pending.push(p)
    return p
  }
  await page.route(pattern, handler)
  return {
    held: () => n,
    release: async () => {
      open()
      // let every held request go on before the handler is removed (unroute would otherwise fall them through twice)
      await Promise.all(pending)
      await page.unroute(pattern, handler)
    },
  }
}

/** Record the pathname of every non-GET request the page makes (writes), in order. */
export function trackWrites(page: Page): { all(): string[]; count(path: string | RegExp): number; clear(): void } {
  const list: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET') list.push(new URL(r.url()).pathname)
  })
  return {
    all: () => [...list],
    count: (p) => list.filter((x) => (typeof p === 'string' ? x === p : p.test(x))).length,
    clear: () => void list.splice(0),
  }
}

/** The bridge's suggestion summaries as a plain array (Maps don't cross page.evaluate). */
export async function summaries(ed: EditorPage): Promise<SuggestionSummary[]> {
  return ed.bridge((b) => [...b.getSuggestionSummaries().values()])
}

export async function saveState(ed: EditorPage): Promise<SaveState['state']> {
  return ed.session((s) => s.getSaveState().state)
}

/** Press a key chord with the editor focused (bridge.focusEditor keeps the selection). */
export async function pressInEditor(ed: EditorPage, keys: string): Promise<void> {
  await ed.bridge((b) => b.focusEditor())
  await ed.page.keyboard.press(keys)
  await ed.page.waitForTimeout(40)
}

/** Write `content` to `file` in the root, then open the editor on it (instead of the editorPage fixture). */
export async function openDoc(page: Page, o: { port: number; tmpRoot: TmpRoot; file: string; content: string }): Promise<EditorPage> {
  o.tmpRoot.write(o.file, o.content)
  return openEditor(page, { port: o.port, file: o.file })
}

/**
 * Switch an already-open page to Editing (the app opens every doc in Suggesting since 2026-11-16). For specs that load
 * through page.goto / page.reload and then type expecting a plain edit; openEditor / openDoc do this themselves.
 */
export async function toEditing(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as { __mdrDebug?: unknown }).__mdrDebug === 'object')
  await page.evaluate(() => (window as unknown as { __mdrDebug: { bridge(): { setMode(m: string): void } } }).__mdrDebug.bridge().setMode('editing'))
}

/** Start collecting EditorNotice codes in the page (window.__notices). */
export async function captureNotices(ed: EditorPage): Promise<void> {
  await ed.bridge((b) => {
    const w = window as unknown as { __notices: string[] }
    w.__notices = []
    b.onNotice((n) => w.__notices.push(n.code))
  })
}

export async function notices(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __notices?: string[] }).__notices ?? [])
}

/**
 * Put the caret (or a selection) on `text` inside the editor through the DOM, which ProseMirror picks up.
 * `at`: 'start' | 'end' places a caret; 'select' selects the text.
 *
 * The editor is focused first, and the selection is set only after ProseMirror's focus handler has run: 20 ms after a
 * focus it writes its own selection back to the DOM when it hasn't processed a selectionchange yet, which would undo a
 * selection set in the same tick (seen under load with the real server, when the mode pill or a popover held focus).
 * The selection is then checked after a beat and set again if something moved it.
 */
export async function placeCaret(page: Page, text: string, at: 'start' | 'end' | 'select' = 'end', nth = 0): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const refocused = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
      if (document.activeElement === root) return false
      root.focus()
      return true
    })
    if (refocused) await page.waitForTimeout(50)
    const ok = await page.evaluate(([t, a, n]) => {
      const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let k = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const s = node.textContent ?? ''
        let i = s.indexOf(t as string)
        while (i >= 0) {
          if (k === n) {
            const len = (t as string).length
            const [from, to] = a === 'select' ? [i, i + len] : a === 'start' ? [i, i] : [i + len, i + len]
            window.getSelection()!.setBaseAndExtent(node, from, node, to)
            ;(window as unknown as { __caret: unknown }).__caret = { node, from, to }
            return true
          }
          k++
          i = s.indexOf(t as string, i + 1)
        }
      }
      return false
    }, [text, at, nth] as const)
    expect(ok, `text not found in the editor: ${text}`).toBe(true)
    await page.waitForTimeout(60)
    const held = await page.evaluate(() => {
      const c = (window as unknown as { __caret: { node: Node; from: number; to: number } }).__caret
      const sel = window.getSelection()!
      const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
      return document.activeElement === root && sel.anchorNode === c.node && sel.anchorOffset === c.from && sel.focusNode === c.node && sel.focusOffset === c.to
    })
    if (held) return
  }
  throw new Error(`placeCaret: the selection on "${text}" did not hold`)
}

/** Flush the session's queue and read the file. */
export async function savedText(ed: EditorPage, tmpRoot: TmpRoot, file: string): Promise<string> {
  await ed.session((s) => s.flush())
  return tmpRoot.read(file)
}

/** Lines that differ between two texts of the same line count (0-based), or null when the counts differ. */
export function changedLines(a: string, b: string): number[] | null {
  const x = a.split('\n')
  const y = b.split('\n')
  if (x.length !== y.length) return null
  return x.map((l, i) => (l === y[i] ? -1 : i)).filter((i) => i >= 0)
}

/** The 0-based line range [first, last] of `needle`'s block in `text` (lines of the first line containing it, to the next blank line). */
export function blockLines(text: string, needle: string): [number, number] {
  const lines = text.split('\n')
  const first = lines.findIndex((l) => l.includes(needle))
  let s = first
  while (s > 0 && lines[s - 1]!.trim() !== '') s--
  let e = first
  while (e + 1 < lines.length && lines[e + 1]!.trim() !== '') e++
  return [s, e]
}

/** Every changed line between `a` and `b` lies inside [lo, hi] of `a` (line counts may differ inside the range). */
export function diffConfinedTo(a: string, b: string, lo: number, hi: number): boolean {
  const x = a.split('\n')
  const y = b.split('\n')
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  let s = 0
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++
  const firstChanged = p
  const lastChangedInA = x.length - 1 - s
  if (firstChanged > lastChangedInA && x.length === y.length) return true
  return firstChanged >= lo && lastChangedInA <= hi
}
