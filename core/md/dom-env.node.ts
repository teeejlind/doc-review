// core/md/dom-env.node.ts (P1; lifted verbatim from spike/s2/src/dom-env.ts on day 0).
// Imported ONLY from node/ (and tests): core/ never imports it (CONTRACTS §2.3). Call installDom() before the
// first createMd() in a node process; jsdom globals should exist before Milkdown/ProseMirror modules evaluate,
// so node entry points import the module that calls it first (S2 FINDINGS, Gotchas: Headless Milkdown).
// Install a jsdom window as globals so Milkdown/ProseMirror can boot headless in Node.
import { JSDOM } from 'jsdom'

let installed = false
export function installDom(): void {
  if (installed) return
  installed = true
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  })
  const w = dom.window as unknown as Record<string, unknown>
  const g = globalThis as unknown as Record<string, unknown>
  const keys = [
    'window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'DocumentFragment',
    'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'DOMParser', 'Range', 'Selection', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent',
    'InputEvent', 'ClipboardEvent', 'FocusEvent', 'HTMLDivElement', 'HTMLParagraphElement',
  ]
  for (const k of keys) {
    if (w[k] !== undefined && g[k] === undefined) g[k] = w[k]
  }
  // Milkdown's ctx timers use global addEventListener/dispatchEvent (gotcha #1 for headless use)
  // They construct Node's native CustomEvent, which jsdom's EventTarget rejects, so bind a native one.
  const bus = new EventTarget()
  for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) {
    if (g[k] === undefined) g[k] = bus[k].bind(bus)
  }
  if (g.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true })
  }
  // ProseMirror view probes these in jsdom
  const doc = w.document as Document
  ;(doc as unknown as { getSelection: () => unknown }).getSelection ??= () => null
  const range = doc.createRange() as unknown as Record<string, unknown>
  const proto = Object.getPrototypeOf(range) as Record<string, unknown>
  proto.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} })
  proto.getBoundingClientRect ??= () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
}
