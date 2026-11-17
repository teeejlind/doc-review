// tests/unit/node/rename.test.ts (final pass 2026-11-16): the durable writers' rename retries a transient Windows lock.
import { describe, expect, it } from 'vitest'
import { renameWithRetry } from '../../../node/rename'

const flaky = (fails: number, code: string) => {
  let n = 0
  return {
    calls: () => n,
    rename: () => {
      n++
      if (n <= fails) throw Object.assign(new Error(code), { code })
    },
  }
}

describe('renameWithRetry', () => {
  it('on win32 a rename held by a scanner or sync client (EPERM / EBUSY / EACCES) succeeds once the hold ends', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const f = flaky(3, code)
      const slept: number[] = []
      renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename, sleep: (ms) => slept.push(ms) })
      expect(f.calls()).toBe(4)
      expect(slept.length).toBe(3)
    }
  })
  it('gives up after about 1.5 s and throws the last error', () => {
    const f = flaky(100, 'EPERM')
    const slept: number[] = []
    expect(() => renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename, sleep: (ms) => slept.push(ms) })).toThrow('EPERM')
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_500)
  })
  it('never retries on macOS / Linux, or a code that is not a transient lock', () => {
    const f = flaky(1, 'EPERM')
    expect(() => renameWithRetry('a', 'b', { platform: 'darwin', rename: f.rename, sleep: () => {} })).toThrow('EPERM')
    expect(f.calls()).toBe(1)
    const g = flaky(1, 'ENOENT')
    expect(() => renameWithRetry('a', 'b', { platform: 'win32', rename: g.rename, sleep: () => {} })).toThrow('ENOENT')
    expect(g.calls()).toBe(1)
  })
})
