// tests/unit/node/store-kit.ts (P1). Shared setup for the M2 store suites: a realpath'd tmp root, one subdirectory per
// doc, openDocStore in either mode, sidecar readers, anchors and save requests built with the store's own core.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { createAnchor, createBlockAnchor } from '../../../core/anchors'
import { docHash } from '../../../core/hash'
import { ptextOf } from '../../../core/ptext'
import { load } from '../../../core/splice/load'
import { applyBlockOps } from '../../../core/splice/apply'
import { diffBlocks } from '../../../core/blocks'
import { openDocStore } from '../../../node/docstore'
import { sharedMd } from '../../../node/md'
import { realId } from '../../../node/root'
import type {
  BlockAnchor, BlockOp, ClientId, DocSnapshot, DocStore, OpKey, SaveRequest, SidecarEvent, SidecarHeader, StoreChange, TextAnchor,
} from '../../../shared/types'
import { CONSTANTS } from '../../../shared/types'

export const opKey = (): OpKey => `op_${ulid()}`
export const clientId = (): ClientId => `k_${ulid()}`

export interface Kit {
  root: string
  /** A fresh subdirectory holding `name` with `text`; returns the root-relative path. */
  docIn(text: string | Buffer, name?: string): string
  open(file: string, o?: { readOnly?: boolean; mode?: 'server' | 'direct'; lockTimeoutMs?: number }): Promise<DocStore>
  abs(file: string): string
  read(file: string): string
  write(file: string, text: string | Buffer): void
  /** Sidecar lines (header first). */
  sidecar(file: string): Array<SidecarHeader | SidecarEvent>
  events(file: string): SidecarEvent[]
  /** Collect a store's StoreChanges. */
  watch(s: DocStore): StoreChange[]
  cleanup(): Promise<void>
}

export function makeKit(prefix = 'mdr-m2-'): Kit {
  const root = realId(mkdtempSync(join(tmpdir(), prefix)))
  const opened: DocStore[] = []
  let n = 0
  const kit: Kit = {
    root,
    docIn(text, name = 'doc.md') {
      const dir = `d${++n}`
      mkdirSync(join(root, dir))
      writeFileSync(join(root, dir, name), text)
      return `${dir}/${name}`
    },
    async open(file, o = {}) {
      const s = await openDocStore(root, file, {
        mode: o.mode ?? 'direct', lockTimeoutMs: o.lockTimeoutMs ?? CONSTANTS.LOCK_TIMEOUT_CLI_MS, ...(o.readOnly ? { readOnly: true } : {}),
      })
      opened.push(s)
      return s
    },
    abs: (file) => join(root, file),
    read: (file) => readFileSync(join(root, file), 'utf8'),
    write: (file, text) => writeFileSync(join(root, file), text),
    sidecar(file) {
      let t: string
      try {
        t = readFileSync(join(root, file) + '.review.jsonl', 'utf8')
      } catch {
        return []
      }
      return t.split('\n').filter(Boolean).map((l) => JSON.parse(l) as SidecarHeader | SidecarEvent)
    },
    events(file) {
      return kit.sidecar(file).slice(1) as SidecarEvent[]
    },
    watch(s) {
      const out: StoreChange[] = []
      s.onChange((c) => out.push(c))
      return out
    },
    async cleanup() {
      for (const s of opened) await s.close().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    },
  }
  return kit
}

/** A text anchor over the first occurrence of `quote` in `text`'s ptext. */
export async function anchorOn(text: string, quote: string, rev: number, occurrence = 1): Promise<TextAnchor> {
  const md = await sharedMd()
  const L = load(md, text)
  const p = ptextOf(L.doc, L)
  let from = -1
  for (let k = 0; k < occurrence; k++) from = p.text.indexOf(quote, from + 1)
  if (from < 0) throw new Error(`anchorOn: ${quote} not in ptext`)
  return createAnchor(p, L.blocks, from, from + quote.length, rev)
}

export async function blockAnchorOn(text: string, index: number, rev: number): Promise<BlockAnchor> {
  const md = await sharedMd()
  return createBlockAnchor(load(md, text).blocks, index, rev)
}

/** The ops turning `current` into `next` (diffBlocks runs, blocks sliced from `next`) and the client's expectHash. */
export async function opsFor(current: string, next: string, bom = false): Promise<{ ops: BlockOp[]; blockHashes: string[]; expectHash: string; text: string }> {
  const md = await sharedMd()
  const L = load(md, current)
  const N = load(md, next)
  const ops: BlockOp[] = []
  for (const d of diffBlocks(L.blocks, N.blocks)) {
    if (d.op === 'equal') continue
    ops.push({
      after: d.a - 1, before: d.a + d.an, covers: L.blocks.slice(d.a, d.a + d.an).map((b) => b.hash),
      blocks: N.blocks.slice(d.b, d.b + d.bn).map((b) => next.slice(b.start, b.end)),
    })
  }
  const r = applyBlockOps(md, L, ops)
  return { ops, blockHashes: L.blocks.map((b) => b.hash), expectHash: docHash(r.text, bom), text: r.text }
}

/** A SaveRequest from snapshot `base` to `next`. */
export async function saveReq(base: Pick<DocSnapshot, 'rev' | 'hash' | 'markdown' | 'bom'>, next: string, o: Partial<SaveRequest> & { clientId?: ClientId; saveId?: number } = {}): Promise<SaveRequest> {
  const p = await opsFor(base.markdown, next, base.bom)
  return {
    clientId: o.clientId ?? clientId(), saveId: o.saveId ?? 1,
    base: { rev: base.rev, hash: base.hash, blockHashes: p.blockHashes },
    ops: p.ops, ...(p.ops.length ? { expectHash: p.expectHash } : {}),
    cause: o.cause ?? 'edit', allowPartial: o.allowPartial ?? true,
    ...(o.anchors ? { anchors: o.anchors } : {}), ...(o.suggestions ? { suggestions: o.suggestions } : {}),
  }
}
