// tests/unit/web/session/queue.test.ts (P2). The write queue (CONTRACTS §12.3): one FIFO, one request in flight,
// flush-first for thread ops / decisions / bulk / handoff / restore, coalescing (saves, per-thread read markers),
// front insertion, idle(), close().
import { describe, expect, it } from 'vitest'
import { FLUSH_FIRST_KINDS, WriteQueue } from '../../../../web/src/session/queue'

const deferred = <T = void>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const flushMicro = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('WriteQueue (§12.3)', () => {
  it('runs items in FIFO order, one in flight at a time', async () => {
    const log: string[] = []
    const q = new WriteQueue({ flushFirst: async () => undefined })
    const gate = deferred()
    const a = q.enqueue('save', async () => {
      log.push('a:start')
      await gate.promise
      log.push('a:end')
      return 'A'
    })
    const b = q.enqueue('policy', async () => {
      log.push('b')
      return 'B'
    })
    await flushMicro()
    expect(log).toEqual(['a:start'])
    expect(q.inFlight).toBe('save')
    gate.resolve()
    expect(await a).toBe('A')
    expect(await b).toBe('B')
    expect(log).toEqual(['a:start', 'a:end', 'b'])
    await q.idle()
    expect(q.busy).toBe(false)
  })

  it('flush-first kinds flush a dirty editor before they run; other kinds do not', async () => {
    const log: string[] = []
    const q = new WriteQueue({ flushFirst: async () => void log.push('flush') })
    expect([...FLUSH_FIRST_KINDS].sort()).toEqual(['bulk', 'decision', 'handoff', 'restore', 'threadOp'])
    await q.enqueue('policy', async () => void log.push('policy'))
    await q.enqueue('readMarker', async () => void log.push('marker'))
    await q.enqueue('threadOp', async () => void log.push('thread'))
    await q.enqueue('decision', async () => void log.push('decision'))
    await q.enqueue('handoff', async () => void log.push('handoff'))
    await q.enqueue('restore', async () => void log.push('restore'))
    expect(log).toEqual(['policy', 'marker', 'flush', 'thread', 'flush', 'decision', 'flush', 'handoff', 'flush', 'restore'])
  })

  it('a failing flush does not stop the item', async () => {
    const q = new WriteQueue({ flushFirst: async () => { throw new Error('offline') } })
    expect(await q.enqueue('threadOp', async () => 'ran')).toBe('ran')
  })

  it('coalesces with a WAITING item of the same key (shared promise, merge hook); never with the one in flight', async () => {
    const q = new WriteQueue({ flushFirst: async () => undefined })
    const gate = deferred()
    const runs: string[] = []
    const merged: string[] = []
    const first = q.enqueue('save', async () => {
      runs.push('first')
      await gate.promise
    }, { coalesce: 'save' })
    await flushMicro()
    const second = q.enqueue('save', async () => void runs.push('second'), { coalesce: 'save', merge: () => merged.push('into-second') })
    const third = q.enqueue('save', async () => void runs.push('third'), { coalesce: 'save' })
    expect(third).toBe(second)
    expect(merged).toEqual(['into-second'])
    gate.resolve()
    await Promise.all([first, second, third])
    expect(runs).toEqual(['first', 'second'])
  })

  it('front items run before everything that waits', async () => {
    const q = new WriteQueue({ flushFirst: async () => undefined })
    const gate = deferred()
    const order: string[] = []
    const a = q.enqueue('save', async () => {
      await gate.promise
      order.push('a')
    })
    const b = q.enqueue('policy', async () => void order.push('b'))
    const c = q.enqueue('reopen', async () => void order.push('c'), { front: true })
    gate.resolve()
    await Promise.all([a, b, c])
    expect(order).toEqual(['a', 'c', 'b'])
  })

  it('close() rejects what still waits; the queue refuses new items', async () => {
    const q = new WriteQueue({ flushFirst: async () => undefined })
    const gate = deferred()
    const a = q.enqueue('save', async () => gate.promise)
    const b = q.enqueue('policy', async () => 'never')
    q.close()
    await expect(b).rejects.toThrow(/closed/)
    await expect(q.enqueue('policy', async () => 1)).rejects.toThrow(/closed/)
    gate.resolve()
    await a
  })
})
