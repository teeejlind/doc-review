// tests/unit/web/session/tabs.test.ts (P2). Tab election over a BroadcastChannel (CONTRACTS §12.8, D19, §13 #61): the
// first tab leads and heartbeats; later tabs follow; simultaneous opens settle on the older tab; Take over swaps roles;
// a silent leader (5 s) or one that closes is replaced by the OLDEST live follower only.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabElection, type ChannelLike, type TabRole } from '../../../../web/src/session/tabs'
import { channelBus } from './helpers'

afterEach(() => {
  vi.useRealTimers()
})

function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
}

/** A channel whose posts can be muted (a frozen or crashed tab). */
function mutable(ch: ChannelLike): ChannelLike & { muted: boolean } {
  const m = {
    muted: false,
    get onmessage() {
      return ch.onmessage
    },
    set onmessage(v) {
      ch.onmessage = (e) => {
        if (!m.muted) v?.(e)
      }
    },
    postMessage: (x: unknown) => {
      if (!m.muted) ch.postMessage(x)
    },
    close: () => ch.close(),
  }
  return m
}

function tab(bus: ReturnType<typeof channelBus>, id: string, since: number, wrap?: (c: ChannelLike) => ChannelLike) {
  const roles: TabRole[] = []
  const ch = bus.channel('mdr:root:doc.md')
  const e = new TabElection({ channel: wrap ? wrap(ch) : ch, id, since, now: () => Date.now(), onChange: (r) => roles.push(r) })
  return { e, roles }
}

describe('TabElection (§12.8)', () => {
  it('without BroadcastChannel the tab is the leader at once', async () => {
    const e = new TabElection({ channel: null, id: 'a', since: 1, now: () => 1, onChange: () => undefined })
    e.start()
    await e.ready
    expect(e.role).toBe('leader')
  })

  it('the first tab leads after the election window; a later tab follows on the leader\'s answer', async () => {
    fakeTimers()
    const bus = channelBus()
    const a = tab(bus, 'a', 1_000)
    a.e.start()
    expect(a.e.role).toBe('pending')
    await vi.advanceTimersByTimeAsync(200)
    expect(a.e.role).toBe('leader')
    const b = tab(bus, 'b', 2_000)
    b.e.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(b.e.role).toBe('follower')
    await vi.advanceTimersByTimeAsync(10_000)
    expect([a.e.role, b.e.role]).toEqual(['leader', 'follower'])
    a.e.close()
    b.e.close()
  })

  it('two tabs that both declared themselves leader settle on the older one', async () => {
    fakeTimers()
    const bus = channelBus()
    // neither hears the other until both have elected themselves (simultaneous opens)
    const young = tab(bus, 'y', 5_000, mutable)
    const old = tab(bus, 'o', 4_000, mutable)
    const chan = (t: { e: TabElection }): ReturnType<typeof mutable> => (t.e as unknown as { o: { channel: ReturnType<typeof mutable> } }).o.channel
    chan(young).muted = true
    chan(old).muted = true
    young.e.start()
    old.e.start()
    await vi.advanceTimersByTimeAsync(200)
    expect([young.e.role, old.e.role]).toEqual(['leader', 'leader'])
    chan(young).muted = false
    chan(old).muted = false
    await vi.advanceTimersByTimeAsync(2_500)
    expect(old.e.role).toBe('leader')
    expect(young.e.role).toBe('follower')
    expect(young.roles).toEqual(['leader', 'follower'])
    old.e.close()
    young.e.close()
  })

  it('takeOver(): the follower claims with a higher term; the old leader steps down', async () => {
    fakeTimers()
    const bus = channelBus()
    const a = tab(bus, 'a', 1_000)
    a.e.start()
    await vi.advanceTimersByTimeAsync(200)
    const b = tab(bus, 'b', 2_000)
    b.e.start()
    await vi.advanceTimersByTimeAsync(10)
    b.e.takeOver()
    await vi.advanceTimersByTimeAsync(10)
    expect(b.e.role).toBe('leader')
    expect(a.e.role).toBe('follower')
    expect(a.roles).toEqual(['leader', 'follower'])
    // and it sticks across heartbeats (the older tab does not win back)
    await vi.advanceTimersByTimeAsync(10_000)
    expect([a.e.role, b.e.role]).toEqual(['follower', 'leader'])
    a.e.close()
    b.e.close()
  })

  it('a leader silent for 5 s is replaced by the oldest live follower only', async () => {
    fakeTimers()
    const bus = channelBus()
    const a = tab(bus, 'a', 1_000, mutable)
    a.e.start()
    await vi.advanceTimersByTimeAsync(200)
    const b = tab(bus, 'b', 2_000)
    const c = tab(bus, 'c', 3_000)
    b.e.start()
    c.e.start()
    await vi.advanceTimersByTimeAsync(4_100) // followers have announced themselves
    ;((a.e as unknown as { o: { channel: ReturnType<typeof mutable> } }).o.channel).muted = true
    await vi.advanceTimersByTimeAsync(4_000)
    expect([b.e.role, c.e.role]).toEqual(['follower', 'follower'])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(b.e.role).toBe('leader')
    expect(c.e.role).toBe('follower')
    a.e.close()
    b.e.close()
    c.e.close()
  })

  it('a leader that closes says goodbye: the oldest follower claims at once', async () => {
    fakeTimers()
    const bus = channelBus()
    const a = tab(bus, 'a', 1_000)
    a.e.start()
    await vi.advanceTimersByTimeAsync(200)
    const b = tab(bus, 'b', 2_000)
    const c = tab(bus, 'c', 3_000)
    b.e.start()
    c.e.start()
    await vi.advanceTimersByTimeAsync(2_100)
    a.e.close()
    await vi.advanceTimersByTimeAsync(20)
    expect(b.e.role).toBe('leader')
    expect(c.e.role).toBe('follower')
    b.e.close()
    c.e.close()
  })
})
