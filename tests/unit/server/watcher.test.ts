// tests/unit/server/watcher.test.ts (P1; CONTRACTS §3.6, D18, row 67). The scoped watcher on its own: only the docs it
// is given and their sidecars; least recently used evicted beyond the cap, except pinned docs; a burst of events is one
// onChange; a sidecar created after the watch starts is seen; a doc deleted and recreated is seen both times.
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { realId } from '../../../node/root'
import { createScopedWatcher, type ScopedWatcher } from '../../../server/watcher'
import { sleep } from './server-kit'

let dir: string
let w: ScopedWatcher | null = null
beforeEach(() => {
  dir = realId(mkdtempSync(join(tmpdir(), 'mdr-watch-')))
})
afterEach(async () => {
  await w?.close()
  w = null
  rmSync(dir, { recursive: true, force: true })
})

async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}

describe('createScopedWatcher', () => {
  it('evicts the least recently used doc beyond the cap, never a pinned one', async () => {
    const pinned = new Set<string>()
    w = createScopedWatcher({ max: 2, debounceMs: 10, onChange: () => undefined, pinned: (f) => pinned.has(f) })
    for (const f of ['a.md', 'b.md', 'c.md', 'd.md']) writeFileSync(join(dir, f), 'x\n')
    w.watch('a.md', join(dir, 'a.md'))
    w.watch('b.md', join(dir, 'b.md'))
    w.watch('a.md', join(dir, 'a.md')) // a is now the most recent
    w.watch('c.md', join(dir, 'c.md'))
    expect(w.watching()).toEqual(['a.md', 'c.md'])
    pinned.add('a.md')
    w.watch('d.md', join(dir, 'd.md'))
    expect(w.watching()).toEqual(['a.md', 'd.md'])
  })

  it('a burst of writes is one onChange; other files in the directory are ignored', async () => {
    const calls: string[] = []
    w = createScopedWatcher({ max: 10, debounceMs: 80, onChange: (f) => void calls.push(f) })
    writeFileSync(join(dir, 'a.md'), 'one\n')
    writeFileSync(join(dir, 'other.md'), 'x\n')
    w.watch('a.md', join(dir, 'a.md'))
    await sleep(300)
    calls.length = 0
    for (let k = 0; k < 5; k++) writeFileSync(join(dir, 'a.md'), `v${k}\n`)
    writeFileSync(join(dir, 'other.md'), 'y\n')
    await until(() => calls.length >= 1)
    await sleep(300)
    expect(calls).toEqual(['a.md'])
  })

  it('sees a sidecar created after the watch began, and a doc deleted then recreated', async () => {
    const calls: string[] = []
    w = createScopedWatcher({ max: 10, debounceMs: 20, onChange: (f) => void calls.push(f) })
    writeFileSync(join(dir, 'a.md'), 'one\n')
    w.watch('a.md', join(dir, 'a.md'))
    await sleep(300)
    calls.length = 0
    writeFileSync(join(dir, 'a.md.review.jsonl'), '{}\n')
    await until(() => calls.length >= 1)
    await sleep(150)
    calls.length = 0
    unlinkSync(join(dir, 'a.md'))
    await until(() => calls.length >= 1)
    await sleep(150)
    calls.length = 0
    writeFileSync(join(dir, 'a.md'), 'back\n')
    await until(() => calls.length >= 1)
    expect(calls[0]).toBe('a.md')
  })
})
