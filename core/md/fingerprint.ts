// core/md/fingerprint.ts (P1; written by the integrator on day 0, CONTRACTS §3.2).
//
// schemaFingerprint = sha256(canonical JSON of schema.spec.nodes / marks + CORE_VERSION).slice(0, 16).
// Canonical: node and mark entries keep the schema's own order (ProseMirror gives order meaning: the first node
// of a group is its default, mark order is rank), and every object inside a spec is written with its keys
// sorted. Functions (parseDOM getAttrs, toDOM, ...) have no JSON form and drop out, exactly as JSON.stringify
// drops them; that is deliberate: only the declarative shape of the schema is the contract.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Schema } from '@milkdown/kit/prose/model'
import { CORE_VERSION } from '../../shared/version'
import { createMd } from './index'

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    if (v instanceof RegExp) return { $re: v.source, flags: v.flags }
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) {
      const x = o[k]
      if (typeof x === 'function' || x === undefined) continue
      out[k] = canon(x)
    }
    return out
  }
  return v
}

type SpecMap = { forEach(f: (key: string, value: unknown) => void): void }
function entries(m: SpecMap): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  m.forEach((k, v) => out.push([k, canon(v)]))
  return out
}

export function fingerprintOf(schema: Schema): string {
  const shape = { nodes: entries(schema.spec.nodes), marks: entries(schema.spec.marks) }
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(shape) + CORE_VERSION))).slice(0, 16)
}

let headless: Promise<string> | null = null

/** The fingerprint of createMd() with no `extend`, headless. Boots once per process and caches; node and tests only. */
export function headlessFingerprint(): Promise<string> {
  headless ??= (async () => {
    const md = await createMd()
    try {
      return md.schemaFingerprint
    } finally {
      await md.destroy()
    }
  })()
  headless.catch(() => {
    headless = null
  })
  return headless
}
