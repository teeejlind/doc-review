// node/md.ts (P1). One headless Md per process (jsdom + Milkdown boot once, about 0.5 s; CONTRACTS §9.3
// "Performance"). The server's stores and CLI direct mode share it. Imports node/dom first so the DOM globals exist
// before core/md evaluates (S2 FINDINGS, "Headless Milkdown").
import './dom'
import { createMd, type Md } from '../core/md/index'

let mdPromise: Promise<Md> | null = null

export function sharedMd(): Promise<Md> {
  if (!mdPromise) {
    const p = createMd()
    mdPromise = p
    p.catch(() => {
      if (mdPromise === p) mdPromise = null
    })
  }
  return mdPromise
}
