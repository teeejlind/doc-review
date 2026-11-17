// web/src/session/drafts.ts (P2). Drafts: nothing is lost on reload, tab close or server restart (CONTRACTS §12.5).
//
// A DraftRecord goes to IndexedDB (idb-keyval) DRAFT_DEBOUNCE_MS after every dirty transaction, in an idle callback,
// and is cleared when the session is saved and clean. On open the session classifies a found draft:
//   - same base (draft.baseHash === snapshot.hash): restore the live doc and selection, mark dirty, flush;
//   - other base: load(md, draft.baseMarkdown) as the save's base and let the server merge against current;
//   - docId changed (the sidecar was recreated, §13 #29): the draft becomes a recovered draft ('merge-failed').
// IndexedDB can be missing or refuse (private windows, blocked site data, jsdom): every access is wrapped, and the
// store falls back to memory for the life of the page.
import { createStore, del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval'
import { CONSTANTS } from '../../../shared/types'
import type { DocSnapshot, DraftRecord } from '../../../shared/types'

export interface DraftStore {
  get(key: string): Promise<DraftRecord | undefined>
  set(key: string, rec: DraftRecord): Promise<void>
  del(key: string): Promise<void>
}

/** IndexedDB key (types.ts DraftRecord): `mdr:draft:<rootHash>:<file>`. */
export function draftKey(rootHash: string, file: string): string {
  return `mdr:draft:${rootHash}:${file}`
}

export function memoryDraftStore(): DraftStore & { readonly map: Map<string, DraftRecord> } {
  const map = new Map<string, DraftRecord>()
  return {
    map,
    get: async (k) => {
      const v = map.get(k)
      return v === undefined ? undefined : structuredClone(v)
    },
    set: async (k, v) => {
      map.set(k, structuredClone(v))
    },
    del: async (k) => {
      map.delete(k)
    },
  }
}

/** idb-keyval in its own database; falls back to memory (once, for good) when IndexedDB is missing or throws. */
export function idbDraftStore(): DraftStore {
  const memory = memoryDraftStore()
  let idb: ReturnType<typeof createStore> | null = null
  let failed = typeof indexedDB === 'undefined'
  const store = (): ReturnType<typeof createStore> | null => {
    if (failed) return null
    try {
      idb ??= createStore('mdr-drafts', 'drafts')
      return idb
    } catch {
      failed = true
      return null
    }
  }
  const guard = async <T>(viaIdb: (s: ReturnType<typeof createStore>) => Promise<T>, viaMemory: () => Promise<T>): Promise<T> => {
    const s = store()
    if (!s) return viaMemory()
    try {
      return await viaIdb(s)
    } catch {
      failed = true
      return viaMemory()
    }
  }
  return {
    get: (k) => guard((s) => idbGet<DraftRecord>(k, s), () => memory.get(k)),
    set: (k, v) => guard((s) => idbSet(k, v, s), () => memory.set(k, v)),
    del: (k) => guard((s) => idbDel(k, s), () => memory.del(k)),
  }
}

export function isDraftRecord(x: unknown): x is DraftRecord {
  if (typeof x !== 'object' || x === null) return false
  const d = x as Partial<DraftRecord>
  return d.v === 1 && typeof d.baseRev === 'number' && typeof d.baseHash === 'string' && typeof d.baseMarkdown === 'string'
    && Array.isArray(d.heldConflicts) && typeof d.savedAt === 'string'
}

export type DraftBranch = 'same-base' | 'other-base' | 'doc-reset'

/** §12.5 "On open with a draft". */
export function classifyDraft(d: DraftRecord, snap: Pick<DocSnapshot, 'hash' | 'docId'>): DraftBranch {
  if (d.docId !== null && snap.docId !== null && d.docId !== snap.docId) return 'doc-reset'
  return d.baseHash === snap.hash ? 'same-base' : 'other-base'
}

/**
 * Debounced, idle-time draft writes. `schedule()` after every dirty transaction; `flush()` writes now (Reload and
 * pagehide await it); `clear()` cancels and deletes. The record is built at write time, never captured early.
 */
export class DraftWriter {
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly o: {
      store: DraftStore
      key: string
      /** null = nothing worth keeping right now (the write is skipped). */
      build: () => DraftRecord | null
      idle: (fn: () => void) => void
      debounceMs?: number
    },
  ) {}

  schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.o.idle(() => void this.write())
    }, this.o.debounceMs ?? CONSTANTS.DRAFT_DEBOUNCE_MS)
  }

  get pending(): boolean {
    return this.timer !== null
  }

  /** Write the current state now (cancelling a scheduled write). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.write()
  }

  async clear(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.writing
    this.writing = this.o.store.del(this.o.key).catch(() => undefined)
    await this.writing
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private write(): Promise<void> {
    this.writing = this.writing.then(async () => {
      let rec: DraftRecord | null = null
      try {
        rec = this.o.build()
      } catch {
        rec = null
      }
      if (rec) await this.o.store.set(this.o.key, rec).catch(() => undefined)
    })
    return this.writing
  }
}
