// server/watcher.ts (P1). The scoped watcher (CONTRACTS §3.6, D18, §13 rows 8, 11, 28, 67).
//
// Watches only the docs the server has opened and their sidecars, never the root: one chokidar instance, two paths per
// doc (the .md and its .review.jsonl, which may not exist yet), at most `max` docs (WATCH_MAX_FILES), least recently
// used evicted first, except docs that `pinned` says are in use (a doc with a live SSE stream). Every event for a doc
// (add, change, unlink, on either path) schedules `onChange(file)` after a short trailing debounce; an event during a
// run schedules one more run after it. The server's onChange is reconcileDoc (node/docstore.ts), which adopts direct-
// mode CLI writes, records external writes and deletions, and does its own two-read stability check (§3.6 step 1), so
// the watcher needs no awaitWriteFinish. chokidar stops watching a path once it is unlinked, so the path is re-added at
// once: a doc deleted and then recreated (git checkout, a delete-and-write tool) is still seen.
import { watch, type FSWatcher } from 'chokidar'

export interface ScopedWatcher {
  /** Watch `file` (the doc at `abs` and its sidecar), or mark it most recently used. Evicts beyond the cap. */
  watch(file: string, abs: string): void
  /** Watched files, least recently used first. */
  watching(): string[]
  close(): Promise<void>
}

interface Entry {
  abs: string
  sidecar: string
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  again: boolean
}

export function createScopedWatcher(o: {
  max: number
  debounceMs: number
  onChange: (file: string) => Promise<void> | void
  /** Never evicted while this says true (a doc with live SSE clients). */
  pinned?: (file: string) => boolean
}): ScopedWatcher {
  const entries = new Map<string, Entry>()
  const fileOfPath = new Map<string, string>()
  let w: FSWatcher | null = null
  let closed = false

  const run = (file: string): void => {
    const e = entries.get(file)
    if (!e || closed) return
    e.timer = null
    if (e.running) {
      e.again = true
      return
    }
    e.running = true
    void Promise.resolve()
      .then(() => o.onChange(file))
      .catch(() => undefined)
      .finally(() => {
        e.running = false
        if (e.again && !closed && entries.get(file) === e) {
          e.again = false
          schedule(file)
        }
      })
  }

  const schedule = (file: string): void => {
    const e = entries.get(file)
    if (!e || closed) return
    if (e.timer) clearTimeout(e.timer)
    e.timer = setTimeout(() => run(file), o.debounceMs)
    e.timer.unref?.()
  }

  const ensure = (): FSWatcher => {
    if (w) return w
    w = watch([], { ignoreInitial: true, persistent: true })
    w.on('all', (event, path) => {
      const file = fileOfPath.get(path)
      if (file === undefined) return
      if (event === 'unlink') {
        // chokidar drops an unlinked path; watch it again so a recreate is seen
        w?.unwatch(path)
        w?.add(path)
      }
      schedule(file)
    })
    w.on('error', () => undefined)
    return w
  }

  const evict = (): void => {
    if (entries.size <= o.max) return
    for (const [file, e] of entries) {
      if (entries.size <= o.max) break
      if (o.pinned?.(file)) continue
      if (e.timer) clearTimeout(e.timer)
      entries.delete(file)
      fileOfPath.delete(e.abs)
      fileOfPath.delete(e.sidecar)
      w?.unwatch([e.abs, e.sidecar])
    }
  }

  return {
    watch(file, abs) {
      if (closed) return
      const known = entries.get(file)
      if (known) {
        // most recently used goes last
        entries.delete(file)
        entries.set(file, known)
        return
      }
      const e: Entry = { abs, sidecar: `${abs}.review.jsonl`, timer: null, running: false, again: false }
      entries.set(file, e)
      fileOfPath.set(e.abs, file)
      fileOfPath.set(e.sidecar, file)
      ensure().add([e.abs, e.sidecar])
      evict()
    },
    watching: () => [...entries.keys()],
    async close() {
      closed = true
      for (const e of entries.values()) if (e.timer) clearTimeout(e.timer)
      entries.clear()
      fileOfPath.clear()
      const cur = w
      w = null
      await cur?.close().catch(() => undefined)
    },
  }
}
